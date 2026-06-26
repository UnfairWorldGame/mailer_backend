function parseIntEnv(name, fallback) {
  const value = parseInt(process.env[name], 10);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export const FREE_DAILY_EMAIL_LIMIT = parseIntEnv('FREE_DAILY_EMAIL_LIMIT', 100);

export const CREDIT_PACKS = {
  starter: { id: 'starter', label: 'Starter', credits: 1000, priceInr: 99 },
  growth: { id: 'growth', label: 'Growth', credits: 6000, priceInr: 499 },
  scale: { id: 'scale', label: 'Scale', credits: 15000, priceInr: 999 },
};
