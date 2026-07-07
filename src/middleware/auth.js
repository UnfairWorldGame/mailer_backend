import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { resolveUserRole, isAdminUser } from '../utils/adminAccess.js';

// Known-insecure values that must never be used as a signing secret.
// The first is the famous jwt.io sample token that was shipped in .env.
const KNOWN_WEAK_SECRETS = new Set([
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJzdXBlcl9hZG1pbiJ9.21_faTCVLa8bq_sqNAfDK7oYe1rW1M3xyIRqHX8_Fys',
  'change_this_to_a_long_random_secret',
  'secret',
  'changeme',
]);

const MIN_SECRET_LENGTH = 32;

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

export function signToken(userId) {
  return jwt.sign({ userId }, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    let token = header.startsWith('Bearer ') ? header.slice(7) : null;
    // Query-string tokens leak into logs/history/Referer. Only accept them for
    // safe GET requests (e.g. attachment <img>/download previews that cannot set
    // an Authorization header), never for state-changing methods.
    if (!token && req.method === 'GET' && typeof req.query?.token === 'string') {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const payload = jwt.verify(token, getJwtSecret());
    const user = await User.findById(payload.userId).select('name email role is_active');

    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Env-listed admins (ADMIN_EMAILS) are a break-glass account and must never
    // be lockable via the DB is_active flag, or another admin could disable them.
    if (user.is_active === false && !isAdminUser(user)) {
      return res.status(403).json({ error: 'Account disabled' });
    }

    req.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: resolveUserRole(user),
    };

    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
