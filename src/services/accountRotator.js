import { sendConfig } from '../config/sendConfig.js';

function startOfDay(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function startOfHour(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

export function getAccountLimits(account) {
  return {
    daily: account.daily_send_limit ?? sendConfig.dailyLimitPerAccount,
    hourly: sendConfig.hourlyLimitPerAccount,
  };
}

export async function resetAccountCountersIfNeeded(account) {
  const now = new Date();
  let changed = false;

  if (!account.last_daily_reset || account.last_daily_reset < startOfDay(now)) {
    account.sends_today = 0;
    account.last_daily_reset = now;
    account.limit_reached = false;
    account.limit_reached_at = null;
    changed = true;
  }

  if (!account.last_hourly_reset || account.last_hourly_reset < startOfHour(now)) {
    account.sends_this_hour = 0;
    account.last_hourly_reset = now;
    if (account.sends_today < getAccountLimits(account).daily) {
      account.limit_reached = false;
      account.limit_reached_at = null;
    }
    changed = true;
  }

  if (changed) await account.save();
  return account;
}

export function isAccountAvailable(account) {
  const limits = getAccountLimits(account);
  if (!account.is_active) return false;
  if (account.limit_reached) return false;
  if (account.sends_today >= limits.daily) return false;
  if (account.sends_this_hour >= limits.hourly) return false;
  return true;
}

export async function markAccountLimitReached(account, reason) {
  account.limit_reached = true;
  account.limit_reached_at = new Date();
  await account.save();
  return { account, reason };
}

export async function recordAccountSend(account) {
  await resetAccountCountersIfNeeded(account);
  account.sends_today += 1;
  account.sends_this_hour += 1;
  account.total_sent += 1;
  account.last_sent_at = new Date();

  const limits = getAccountLimits(account);
  if (account.sends_today >= limits.daily || account.sends_this_hour >= limits.hourly) {
    account.limit_reached = true;
    account.limit_reached_at = new Date();
  }

  await account.save();
  return account;
}

export class AccountRotator {
  constructor(accounts, { preferredAccountId = null, rotate = true } = {}) {
    this.accounts = accounts;
    this.rotate = rotate;
    this.preferredAccountId = preferredAccountId?.toString() ?? null;
    this.cursor = 0;
    this._ordered = this._buildOrder();
  }

  _buildOrder() {
    const active = this.accounts.filter((a) => a.is_active);
    if (!this.rotate && this.preferredAccountId) {
      const preferred = active.find((a) => a._id.toString() === this.preferredAccountId);
      return preferred ? [preferred] : active;
    }

    if (this.preferredAccountId) {
      const preferredIdx = active.findIndex((a) => a._id.toString() === this.preferredAccountId);
      if (preferredIdx > 0) {
        return [...active.slice(preferredIdx), ...active.slice(0, preferredIdx)];
      }
    }
    return active;
  }

  async nextAvailable() {
    if (!this._ordered.length) return null;

    const total = this._ordered.length;
    for (let i = 0; i < total; i++) {
      const idx = (this.cursor + i) % total;
      const account = this._ordered[idx];
      await resetAccountCountersIfNeeded(account);
      if (isAccountAvailable(account)) {
        this.cursor = (idx + 1) % total;
        return account;
      }
    }
    return null;
  }

  get orderedAccounts() {
    return this._ordered;
  }
}

export function isRateLimitError(err) {
  const msg = (err?.message || '').toLowerCase();
  const code = err?.responseCode || err?.code;
  return (
    code === 421 ||
    code === 450 ||
    code === 452 ||
    code === 454 ||
    msg.includes('rate') ||
    msg.includes('limit') ||
    msg.includes('too many') ||
    msg.includes('daily') ||
    msg.includes('quota') ||
    msg.includes('exceeded')
  );
}
