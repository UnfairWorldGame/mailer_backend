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
  return Number.isFinite(cost) && cost > 0 ? cost : CREDIT_COSTS.simple;
}

// The canonical ₹99 = 1,000 credit rate, plus bulk packs (cheaper per credit).
export const CREDIT_PACKS = {
  starter: { id: 'starter', label: 'Starter', credits: 1000, priceInr: 99 },
  growth: { id: 'growth', label: 'Growth', credits: 6000, priceInr: 499 },
  scale: { id: 'scale', label: 'Scale', credits: 15000, priceInr: 999 },
};

export const BASE_RATE = { credits: 1000, priceInr: 99 };
