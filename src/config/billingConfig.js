function parseIntEnv(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

// ── Credit model ────────────────────────────────────────────────────────────
// One unified currency: "credits". Every user gets a free daily allowance of
// credits that resets each day; purchased credits never expire.
//
//   ₹99            = 1,000 credits
//   1 simple email = 1 credit
//   1 certificate  = 3 credits
//   Free tier      = 100 credits / day (≈100 simple emails or ≈33 certificates)

export const FREE_DAILY_CREDITS = parseIntEnv('FREE_DAILY_CREDITS', 100);

// Backwards-compatible alias (older code/imports referenced this name).
export const FREE_DAILY_EMAIL_LIMIT = FREE_DAILY_CREDITS;

// Credit cost per send, keyed by email kind. Enforced entirely server-side.
export const CREDIT_COSTS = {
  simple: parseIntEnv('CREDIT_COST_SIMPLE', 1),
  certificate: parseIntEnv('CREDIT_COST_CERTIFICATE', 3),
};

export function creditCost(kind) {
  const cost = CREDIT_COSTS[kind];
  if (Number.isFinite(cost) && cost > 0) return cost;
  // Falling back to CREDIT_COSTS.simple is useless when *that* is the value that
  // failed validation (CREDIT_COST_SIMPLE=0 made every send free). Fall back to
  // the documented default instead, so a bad env var cannot zero out billing.
  const fallback = CREDIT_COSTS.simple;
  return Number.isFinite(fallback) && fallback > 0 ? fallback : 1;
}

// The canonical ₹99 = 1,000 credit rate, plus bulk packs (cheaper per credit).
export const CREDIT_PACKS = {
  starter: { id: 'starter', label: 'Starter', credits: 1000, priceInr: 99 },
  growth: { id: 'growth', label: 'Growth', credits: 6000, priceInr: 499 },
  scale: { id: 'scale', label: 'Scale', credits: 15000, priceInr: 999 },
};

export const BASE_RATE = { credits: 1000, priceInr: 99 };

// Ceiling on a single admin grant. The only way to reverse an over-grant is the
// revoke path, so an unbounded amount plus a fat-fingered zero is a real
// operational risk. Free grants are separately capped in routes/admin.js.
export const MAX_GRANT_CREDITS = parseIntEnv('MAX_GRANT_CREDITS', 1_000_000);

/**
 * Payment is arranged off-platform: the user requests credits, an admin shares
 * payment details, and the admin credits the account manually. The upgrade
 * dialog surfaces these so a blocked user knows exactly who to contact instead
 * of hitting a dead end.
 */
export const BILLING_CONTACT = {
  email: process.env.BILLING_CONTACT_EMAIL?.trim() || process.env.CONTACT_INBOX_EMAIL?.trim() || null,
  phone: process.env.BILLING_CONTACT_PHONE?.trim() || null,
  whatsapp: process.env.BILLING_CONTACT_WHATSAPP?.trim() || null,
  hours: process.env.BILLING_CONTACT_HOURS?.trim() || 'Mon–Sat, 10am–7pm IST',
  response_time: process.env.BILLING_RESPONSE_TIME?.trim() || 'Usually within a few hours',
};
