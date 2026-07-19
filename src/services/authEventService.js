import AuthEvent from '../models/AuthEvent.js';

/** Truncated so a hostile client cannot write megabytes into the audit trail. */
function clientInfo(req) {
  if (!req) return { ip: null, user_agent: null };
  return {
    ip: req.ip || null,
    user_agent: String(req.get?.('user-agent') || '').slice(0, 300) || null,
  };
}

/**
 * Fire-and-forget. Audit logging must never break or slow an auth request, so
 * failures are swallowed after being surfaced to stderr.
 */
const VALID_TYPES = new Set(AuthEvent.schema.path('type').enumValues);

export function logAuthEvent({ type, req, userId = null, email = null, detail = null }) {
  const { ip, user_agent } = clientInfo(req);

  // An unrecognised type fails schema validation, and because this writer is
  // fire-and-forget the row is simply lost — the audit trail quietly develops a
  // hole exactly where someone added a new event. Record it under 'other' with
  // the original preserved instead.
  const safeType = VALID_TYPES.has(type) ? type : 'other';
  const safeDetail = VALID_TYPES.has(type)
    ? detail
    : [`original_type=${type}`, detail].filter(Boolean).join(' ');

  AuthEvent.create({
    type: safeType,
    detail: safeDetail,
    user_id: userId,
    email: email ? String(email).toLowerCase().trim() : null,
    ip,
    user_agent,
  }).catch((err) => {
    console.error(`[auth-event] failed to record ${type}:`, err?.message);
  });
}

/** Recent failed logins for an address — used to decide when to slow a caller down. */
export async function countRecentFailures(email, windowMs) {
  if (!email) return 0;
  return AuthEvent.countDocuments({
    email: String(email).toLowerCase().trim(),
    type: 'login_failed',
    created_at: { $gt: new Date(Date.now() - windowMs) },
  });
}
