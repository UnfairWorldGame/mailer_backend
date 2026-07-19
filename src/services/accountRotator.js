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

/**
 * The rotator holds one account document for the whole campaign, and
 * `recordAccountSend` copies DB-authoritative counters onto it after each
 * atomic $inc — which marks those paths dirty in Mongoose. A full `account.save()`
 * here would therefore write this run's snapshot back over increments made by
 * *other* concurrent campaigns using the same account, undercounting sends and
 * letting the account blow past Gmail's real cap. Every write below is a
 * targeted, guarded update for that reason; nothing in this module calls save().
 */
export async function resetAccountCountersIfNeeded(account) {
  const now = new Date();
  const dayStart = startOfDay(now);
  const hourStart = startOfHour(now);

  const needsDaily = !account.last_daily_reset || account.last_daily_reset < dayStart;
  const needsHourly = !account.last_hourly_reset || account.last_hourly_reset < hourStart;
  if (!needsDaily && !needsHourly) return account;

  if (needsDaily) {
    // Guarded so that if a parallel worker already rolled the day over, we do
    // not zero the sends it has recorded since.
    const fresh = await account.constructor.findOneAndUpdate(
      {
        _id: account._id,
        $or: [{ last_daily_reset: null }, { last_daily_reset: { $lt: dayStart } }],
      },
      {
        $set: {
          sends_today: 0,
          last_daily_reset: now,
          limit_reached: false,
          limit_reached_at: null,
        },
      },
      { new: true }
    );
    applyCounters(account, fresh);
  }

  if (needsHourly) {
    const clearLimit = (account.sends_today ?? 0) < getAccountLimits(account).daily;
    const fresh = await account.constructor.findOneAndUpdate(
      {
        _id: account._id,
        $or: [{ last_hourly_reset: null }, { last_hourly_reset: { $lt: hourStart } }],
      },
      {
        $set: {
          sends_this_hour: 0,
          last_hourly_reset: now,
          ...(clearLimit ? { limit_reached: false, limit_reached_at: null } : {}),
        },
      },
      { new: true }
    );
    applyCounters(account, fresh);
  }

  return account;
}

/** Mirror authoritative DB counters onto the in-memory doc used for availability checks. */
function applyCounters(account, fresh) {
  if (!fresh) return;
  account.sends_today = fresh.sends_today;
  account.sends_this_hour = fresh.sends_this_hour;
  account.last_daily_reset = fresh.last_daily_reset;
  account.last_hourly_reset = fresh.last_hourly_reset;
  account.limit_reached = fresh.limit_reached;
  account.limit_reached_at = fresh.limit_reached_at;
}

/**
 * Milliseconds until this account's counters next roll over, so callers can wait
 * for real capacity instead of guessing. Returns null when the account is not
 * actually capped.
 */
export function msUntilAccountReset(account, now = new Date()) {
  const limits = getAccountLimits(account);
  const hourlyCapped = (account.sends_this_hour ?? 0) >= limits.hourly;
  const dailyCapped = (account.sends_today ?? 0) >= limits.daily;

  if (dailyCapped) {
    const nextDay = startOfDay(now);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    return nextDay.getTime() - now.getTime();
  }
  if (hourlyCapped || account.limit_reached) {
    const nextHour = startOfHour(now);
    nextHour.setUTCHours(nextHour.getUTCHours() + 1);
    return nextHour.getTime() - now.getTime();
  }
  return null;
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
  const now = new Date();
  // Targeted update, not account.save(): recordAccountSend copies DB counters
  // onto this document, so saving it whole writes this run's snapshot over
  // increments made by other campaigns and — in the certificate engine, where
  // sendConcurrency workers share one account doc — by sibling workers. That
  // silently lowers sends_today and lets the account exceed Gmail's real cap.
  await account.constructor.updateOne(
    { _id: account._id },
    { $set: { limit_reached: true, limit_reached_at: now } }
  );
  account.limit_reached = true;
  account.limit_reached_at = now;
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

  /**
   * Drop an account from this run's rotation without touching the DB — used when
   * Gmail rejects its credentials, so the remaining recipients go to accounts
   * that can actually authenticate.
   */
  disableForRun(account) {
    const id = account._id.toString();
    this._ordered = this._ordered.filter((a) => a._id.toString() !== id);
    if (this._ordered.length) {
      this.cursor %= this._ordered.length;
    } else {
      this.cursor = 0;
    }
    return this._ordered.length;
  }

  get orderedAccounts() {
    return this._ordered;
  }

  get usesRotation() {
    return this.rotate && this._ordered.length > 1;
  }
}

/**
 * Does this error mean *our sending account* was throttled?
 *
 * The previous version matched bare substrings ('quota', 'limit', 'exceeded')
 * against any error message. Gmail answers a recipient with a full mailbox with
 * "552-5.2.2 The email account that you tried to reach is over quota" — a
 * permanent, recipient-side 5xx — which that matched, so one bad address marked
 * the sender's own account limit_reached and pulled it from rotation. With
 * rotation on, the next account hit the same address and was disabled too,
 * until every account was burned and the campaign auto-paused.
 *
 * So: a 4xx response code is required before any message sniffing, and the
 * phrases must be sender-side ones.
 */
const SENDER_THROTTLE_PATTERNS = [
  'daily user sending quota exceeded',
  'daily sending quota',
  'user-rate limit',
  'rate limit exceeded',
  'too many messages',
  'too many login attempts',
  'try again later',
  '4.7.0',
  '4.7.28',
];

export function isRateLimitError(err) {
  const msg = (err?.message || '').toLowerCase();
  const responseCode = Number(err?.responseCode);

  // Permanent (5xx) failures are never our throttle, whatever the wording.
  if (Number.isFinite(responseCode) && responseCode >= 500) return false;

  if ([421, 450, 451, 452, 454].includes(responseCode)) return true;

  // No response code (socket-level failure): fall back to sender-side phrases only.
  if (!Number.isFinite(responseCode)) {
    return SENDER_THROTTLE_PATTERNS.some((p) => msg.includes(p));
  }

  return false;
}
