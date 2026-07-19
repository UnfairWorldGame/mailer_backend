import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { resolveUserRole, isEnvAdmin } from '../utils/adminAccess.js';

// Known-insecure values that must never be used as a signing secret.
// The first is the famous jwt.io sample token that was shipped in .env.
const KNOWN_WEAK_SECRETS = new Set([
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJzdXBlcl9hZG1pbiJ9.21_faTCVLa8bq_sqNAfDK7oYe1rW1M3xyIRqHX8_Fys',
  'change_this_to_a_long_random_secret',
  'secret',
  'changeme',
]);

const MIN_SECRET_LENGTH = 32;
const JWT_ALGORITHM = 'HS256';

export const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || '15m';
/**
 * Derived from ACCESS_TOKEN_TTL, never hardcoded alongside it. This value is
 * what the server tells the client (`expires_in`), so when it was a separate
 * literal, setting ACCESS_TOKEN_TTL=5m gave every client a token that died at 5
 * minutes while it scheduled its refresh for 15 — ten minutes of 401s per
 * session, fleet-wide, from one env change with no error anywhere.
 */
function parseTtlSeconds(ttl) {
  const match = /^(\d+)([smhd])$/.exec(String(ttl).trim());
  if (!match) return 15 * 60;
  const value = Number(match[1]);
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[match[2]];
  return value * unit;
}

export const ACCESS_TOKEN_TTL_SECONDS = parseTtlSeconds(ACCESS_TOKEN_TTL);

function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET is too weak (${secret.length} chars). Use at least ${MIN_SECRET_LENGTH} random characters, e.g. \`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"\`.`
    );
  }
  if (KNOWN_WEAK_SECRETS.has(secret)) {
    throw new Error(
      'JWT_SECRET is set to a well-known/default value and is publicly guessable. Generate a fresh random secret and rotate it immediately.'
    );
  }
  return secret;
}

// Fail fast at startup rather than on the first authenticated request.
export function assertJwtSecret() {
  getJwtSecret();
}

/**
 * Short-lived access token. `tv` pins the user's token_version at mint time —
 * bumping that column (password change, reset, sign-out-everywhere) instantly
 * invalidates every token already in the wild.
 */
export function signAccessToken(user) {
  return jwt.sign(
    { userId: user._id.toString(), tv: user.token_version || 0, typ: 'access' },
    getJwtSecret(),
    { expiresIn: ACCESS_TOKEN_TTL, algorithm: JWT_ALGORITHM }
  );
}

/**
 * Narrow, short-lived token for inline file previews (<img>/<iframe> cannot set
 * an Authorization header). Scoped to one resource so a leaked preview URL is
 * not a session credential — the previous implementation put the *full* session
 * token in the query string.
 */
export function signResourceToken(userId, resource, ttlSeconds = 300) {
  return jwt.sign(
    { userId: userId.toString(), res: resource, typ: 'resource' },
    getJwtSecret(),
    { expiresIn: ttlSeconds, algorithm: JWT_ALGORITHM }
  );
}

export function verifyResourceToken(token, resource) {
  try {
    const payload = jwt.verify(token, getJwtSecret(), { algorithms: [JWT_ALGORITHM] });
    if (payload.typ !== 'resource' || payload.res !== resource) return null;
    return payload;
  } catch {
    return null;
  }
}

function extractBearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

export async function requireAuth(req, res, next) {
  try {
    const token = extractBearer(req);
    if (!token) {
      return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
    }

    const payload = jwt.verify(token, getJwtSecret(), { algorithms: [JWT_ALGORITHM] });

    // Resource tokens are deliberately not session credentials. Note the check
    // requires typ === 'access' rather than tolerating its absence: every minting
    // path sets it, and failing open on a missing claim is how a future token
    // type silently becomes a session credential.
    if (payload.typ !== 'access') {
      return res.status(401).json({ error: 'Invalid token', code: 'WRONG_TOKEN_TYPE' });
    }

    const user = await User.findById(payload.userId).select(
      'name email role is_active token_version email_verified'
    );

    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    }

    // Stale token_version means the password changed or the user signed out
    // everywhere after this token was minted.
    if ((payload.tv ?? 0) !== (user.token_version || 0)) {
      return res.status(401).json({
        error: 'Session expired. Please sign in again.',
        code: 'TOKEN_REVOKED',
      });
    }

    // Env-listed admins (ADMIN_EMAILS) are a break-glass account and must never
    // be lockable via the DB is_active flag, or another admin could disable them.
    //
    // Scoped to the env list specifically. `isAdminUser` also returns true for
    // any DB role:'admin', which meant a *suspended* DB admin kept full access
    // on their existing token — the exemption was much wider than the comment
    // claimed, and wider than login/refresh, which reject disabled users
    // outright.
    if (user.is_active === false && !isEnvAdmin(user)) {
      return res.status(403).json({ error: 'Account disabled', code: 'ACCOUNT_DISABLED' });
    }

    req.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: resolveUserRole(user),
      email_verified: Boolean(user.email_verified),
    };

    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Session expired', code: 'TOKEN_EXPIRED' });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ error: 'Invalid or expired token', code: 'TOKEN_INVALID' });
    }
    next(err);
  }
}

/**
 * For inline file previews. `<img>`/`<iframe>`/`target="_blank"` cannot attach
 * an Authorization header, so these routes also accept a token in the query
 * string — but only a *resource* token, scoped to one campaign or job and valid
 * for minutes. Previously the full session token went into the URL, which put a
 * long-lived credential into access logs, browser history, and Referer headers.
 */
export function requireAuthOrResourceToken(buildResource) {
  return async function resourceGate(req, res, next) {
    if (extractBearer(req)) return requireAuth(req, res, next);

    const token = typeof req.query?.t === 'string' ? req.query.t : null;
    if (token) {
      const payload = verifyResourceToken(token, buildResource(req));
      if (payload) {
        req.user = { id: payload.userId, scoped: true };
        return next();
      }
    }

    return res.status(401).json({ error: 'Authentication required', code: 'NO_TOKEN' });
  };
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required', code: 'ADMIN_REQUIRED' });
  }
  next();
}

/**
 * Gate for actions that put mail in front of third parties. Verification proves
 * the account owner controls the address before we let them send from it.
 * Admins bypass so a support account is never locked out of its own tooling.
 */
export function requireVerifiedEmail(req, res, next) {
  if (req.user?.role === 'admin' || req.user?.email_verified) return next();
  return res.status(403).json({
    error: 'Confirm your email address to unlock sending. Check your inbox for the link.',
    code: 'EMAIL_NOT_VERIFIED',
  });
}
