import crypto from 'crypto';
import RefreshToken from '../models/RefreshToken.js';
import User from '../models/User.js';
import { signAccessToken, ACCESS_TOKEN_TTL_SECONDS } from '../middleware/auth.js';
import { generateRawToken, hashToken } from '../utils/tokenUtils.js';
import { logAuthEvent } from './authEventService.js';

const REFRESH_TTL_MS = parseInt(process.env.REFRESH_TOKEN_TTL_DAYS || '30', 10) * 24 * 60 * 60 * 1000;

// Cap concurrent sessions so a long-lived account cannot accumulate hundreds of
// live refresh tokens across devices; the oldest are pruned first.
const MAX_SESSIONS_PER_USER = 10;

export class SessionError extends Error {
  constructor(message, code, status = 401) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

function clientMeta(req) {
  return {
    user_agent: String(req?.get?.('user-agent') || '').slice(0, 300) || null,
    ip: req?.ip || null,
  };
}

async function pruneOldSessions(userId) {
  const live = await RefreshToken.find({
    user_id: userId,
    revoked_at: null,
    used_at: null,
    expires_at: { $gt: new Date() },
  })
    .sort({ created_at: -1 })
    .select('_id')
    .lean();

  if (live.length <= MAX_SESSIONS_PER_USER) return;

  const excess = live.slice(MAX_SESSIONS_PER_USER).map((d) => d._id);
  await RefreshToken.updateMany(
    { _id: { $in: excess } },
    { $set: { revoked_at: new Date(), revoked_reason: 'session_limit' } }
  );
}

/**
 * Mint a fresh access/refresh pair. `familyId` continues an existing rotation
 * chain; omitting it starts a new one (a genuine new sign-in).
 */
export async function issueSession(user, req, { familyId = null } = {}) {
  const rawRefresh = generateRawToken();
  const family = familyId || crypto.randomUUID();

  await RefreshToken.create({
    user_id: user._id,
    token_hash: hashToken(rawRefresh),
    family_id: family,
    expires_at: new Date(Date.now() + REFRESH_TTL_MS),
    ...clientMeta(req),
  });

  if (!familyId) await pruneOldSessions(user._id);

  return {
    accessToken: signAccessToken(user),
    refreshToken: rawRefresh,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    tokenType: 'Bearer',
  };
}

/**
 * Exchange a refresh token for a new pair.
 *
 * Replaying an already-used token is the signature of theft: the legitimate
 * client rotated it, so whoever presents it again holds a stolen copy. We can't
 * tell victim from attacker, so the entire family is revoked and both are forced
 * to sign in again.
 */
export async function rotateSession(rawRefreshToken, req) {
  if (!rawRefreshToken) {
    throw new SessionError('Refresh token is required', 'NO_REFRESH_TOKEN');
  }

  const stored = await RefreshToken.findOne({ token_hash: hashToken(rawRefreshToken) });
  if (!stored) {
    throw new SessionError('Session expired. Please sign in again.', 'REFRESH_INVALID');
  }

  if (stored.used_at || stored.revoked_at) {
    await RefreshToken.updateMany(
      { family_id: stored.family_id, revoked_at: null },
      { $set: { revoked_at: new Date(), revoked_reason: 'reuse_detected' } }
    );
    logAuthEvent({
      type: 'token_reuse_detected',
      req,
      userId: stored.user_id,
      detail: `family ${stored.family_id} revoked`,
    });
    throw new SessionError('Session expired. Please sign in again.', 'REFRESH_REUSED');
  }

  if (stored.expires_at <= new Date()) {
    throw new SessionError('Session expired. Please sign in again.', 'REFRESH_EXPIRED');
  }

  const user = await User.findById(stored.user_id).select(
    'name email role is_active token_version email_verified'
  );
  if (!user) {
    throw new SessionError('Session expired. Please sign in again.', 'REFRESH_INVALID');
  }
  if (user.is_active === false) {
    throw new SessionError('Account disabled', 'ACCOUNT_DISABLED', 403);
  }

  const next = await issueSession(user, req, { familyId: stored.family_id });

  stored.used_at = new Date();
  stored.last_used_at = new Date();
  stored.replaced_by = hashToken(next.refreshToken);
  await stored.save();

  logAuthEvent({ type: 'token_refresh', req, userId: user._id, email: user.email });

  return { ...next, user };
}

/** Sign out this device only. Idempotent — an unknown token is not an error. */
export async function revokeSession(rawRefreshToken, reason = 'logout') {
  if (!rawRefreshToken) return false;
  const result = await RefreshToken.updateOne(
    { token_hash: hashToken(rawRefreshToken), revoked_at: null },
    { $set: { revoked_at: new Date(), revoked_reason: reason } }
  );
  return result.modifiedCount > 0;
}

/**
 * Sign out everywhere. Bumping token_version is what kills already-issued
 * access tokens; revoking the refresh rows stops new ones being minted.
 */
export async function revokeAllSessions(userId, reason = 'logout_all') {
  await RefreshToken.updateMany(
    { user_id: userId, revoked_at: null },
    { $set: { revoked_at: new Date(), revoked_reason: reason } }
  );
  await User.updateOne({ _id: userId }, { $inc: { token_version: 1 } });
}

export async function listSessions(userId) {
  const sessions = await RefreshToken.find({
    user_id: userId,
    revoked_at: null,
    used_at: null,
    expires_at: { $gt: new Date() },
  })
    .sort({ created_at: -1 })
    .lean();

  return sessions.map((s) => ({
    id: s._id.toString(),
    created_at: s.created_at,
    last_used_at: s.last_used_at,
    expires_at: s.expires_at,
    user_agent: s.user_agent,
    ip: s.ip,
  }));
}

export { REFRESH_TTL_MS, MAX_SESSIONS_PER_USER };
