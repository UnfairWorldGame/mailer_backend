function parseIntEnv(key, fallback) {
  const val = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(val) && val > 0 ? val : fallback;
}

export const sendConfig = {
  defaultDelayMs: parseIntEnv('EMAIL_SEND_DELAY_MS', 4000),
  minDelayMs: parseIntEnv('EMAIL_SEND_MIN_DELAY_MS', 1000),
  maxDelayMs: parseIntEnv('EMAIL_SEND_MAX_DELAY_MS', 60000),
  dailyLimitPerAccount: parseIntEnv('GMAIL_DAILY_LIMIT_PER_ACCOUNT', 500),
  hourlyLimitPerAccount: parseIntEnv('GMAIL_HOURLY_LIMIT_PER_ACCOUNT', 100),
  maxRetriesPerRecipient: parseIntEnv('EMAIL_MAX_RETRIES_PER_RECIPIENT', 3),
  retryBaseDelayMs: parseIntEnv('EMAIL_RETRY_BASE_DELAY_MS', 5000),
  retryMaxDelayMs: parseIntEnv('EMAIL_RETRY_MAX_DELAY_MS', 300000),
  claimStaleMs: parseIntEnv('EMAIL_CLAIM_STALE_MS', 300000),
  campaignLockStaleMs: parseIntEnv('EMAIL_CAMPAIGN_LOCK_STALE_MS', 600000),
  progressSyncEvery: parseIntEnv('EMAIL_PROGRESS_SYNC_EVERY', 10),
};

export function resolveDelayMs(campaignDelay) {
  const delay = campaignDelay ?? sendConfig.defaultDelayMs;
  return Math.min(sendConfig.maxDelayMs, Math.max(sendConfig.minDelayMs, delay));
}
