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

  // Atomic increment so two concurrent campaigns/instances using the same account
  // cannot both write back a stale counter and undercount sends (which would blow
  // past Gmail's real daily/hourly caps and risk suspension).
  const now = new Date();
  const fresh = await account.constructor.findOneAndUpdate(
    { _id: account._id },
    {
      $inc: { sends_today: 1, sends_this_hour: 1, total_sent: 1 },
      $set: { last_sent_at: now },
    },
    { new: true }
  );

  if (!fresh) return account;

  // Reflect the authoritative DB counts back onto the in-memory doc the rotator
  // keeps using for availability checks.
  account.sends_today = fresh.sends_today;
  account.sends_this_hour = fresh.sends_this_hour;
  account.total_sent = fresh.total_sent;
  account.last_sent_at = fresh.last_sent_at;

  const limits = getAccountLimits(account);
  if (fresh.sends_today >= limits.daily || fresh.sends_this_hour >= limits.hourly) {
    await account.constructor.updateOne(
      { _id: account._id },
      { $set: { limit_reached: true, limit_reached_at: now } }
    );
    account.limit_reached = true;
    account.limit_reached_at = now;
  }

  return account;
}

export class AccountRotator {
  constructor(
    accounts,
    { preferredAccountId = null, rotate = true, perAccountDelayMs = sendConfig.perAccountDelayMs } = {}
  ) {
    this.accounts = accounts;
    this.rotate = rotate;
    this.preferredAccountId = preferredAccountId?.toString() ?? null;
    this.perAccountDelayMs = perAccountDelayMs;
    this.cursor = 0;
    this.lastSendAt = new Map();
    this._ordered = this._buildOrder();
  }

  _buildOrder() {
    const active = this.accounts.filter((a) => a.is_active);
    if (!this.rotate && this.preferredAccountId) {
      const preferred = active.find((a) => a._id.toString() === this.preferredAccountId);
      return preferred ? [preferred] : active;
    }

    if (this.rotate && active.length > 1) {
      return active;
    }

    if (this.preferredAccountId) {
      const preferredIdx = active.findIndex((a) => a._id.toString() === this.preferredAccountId);
      if (preferredIdx > 0) {
        return [...active.slice(preferredIdx), ...active.slice(0, preferredIdx)];
      }
    }
    return active;
  }

  _lastSendMs(account) {
    const id = account._id.toString();
    const session = this.lastSendAt.get(id) ?? 0;
    const persisted = account.last_sent_at ? new Date(account.last_sent_at).getTime() : 0;
    return Math.max(session, persisted);
  }

  cooldownRemainingMs(account) {
    const elapsed = Date.now() - this._lastSendMs(account);
    return Math.max(0, this.perAccountDelayMs - elapsed);
  }

  markSent(account) {
    this.lastSendAt.set(account._id.toString(), Date.now());
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

  /**
   * Pick the next account for sending, alternating when multiple accounts exist.
   * Waits until the chosen account has cooled down (per-account delay).
   */
  async nextReadyAccount(sleepFn) {
    if (!this._ordered.length) return null;

    const total = this._ordered.length;
    const useRotation = this.rotate && total > 1;

    if (!useRotation) {
      const account = this._ordered[0];
      await resetAccountCountersIfNeeded(account);
      if (!isAccountAvailable(account)) return null;
      const wait = this.cooldownRemainingMs(account);
      if (wait > 0) await sleepFn(wait);
      return account;
    }

    for (let attempt = 0; attempt < total + 1; attempt++) {
      let readyAccount = null;
      let readyIdx = -1;
      let soonestWait = Infinity;
      let soonestAccount = null;
      let soonestIdx = -1;

      for (let i = 0; i < total; i++) {
        const idx = (this.cursor + i) % total;
        const account = this._ordered[idx];
        await resetAccountCountersIfNeeded(account);
        if (!isAccountAvailable(account)) continue;

        const wait = this.cooldownRemainingMs(account);
        if (wait === 0) {
          readyAccount = account;
          readyIdx = idx;
          break;
        }
        if (wait < soonestWait) {
          soonestWait = wait;
          soonestAccount = account;
          soonestIdx = idx;
        }
      }

      if (readyAccount) {
        this.cursor = (readyIdx + 1) % total;
        return readyAccount;
      }

      if (!soonestAccount || !Number.isFinite(soonestWait)) {
        return null;
      }

      await sleepFn(soonestWait);
      await resetAccountCountersIfNeeded(soonestAccount);
      if (isAccountAvailable(soonestAccount) && this.cooldownRemainingMs(soonestAccount) === 0) {
        this.cursor = (soonestIdx + 1) % total;
        return soonestAccount;
      }
    }

    return null;
  }

  get orderedAccounts() {
    return this._ordered;
  }

  get usesRotation() {
    return this.rotate && this._ordered.length > 1;
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
