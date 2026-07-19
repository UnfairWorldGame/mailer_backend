import mongoose from 'mongoose';
import User from '../models/User.js';
import Campaign from '../models/Campaign.js';
import CertificateJob from '../models/CertificateJob.js';
import CreditTransaction from '../models/CreditTransaction.js';
import {
  FREE_DAILY_CREDITS,
  CREDIT_PACKS,
  BASE_RATE,
  creditCost,
} from '../config/billingConfig.js';
import { isAdminUser } from '../utils/adminAccess.js';
import { fulfillCreditPurchaseRequests } from './creditPurchaseService.js';
import {
  sendCreditGrantEmail,
  sendCreditRefundEmail,
  notifyAdminsOfCreditChange,
} from './mailer/emails.js';
import { createNotification } from './notificationService.js';
import { recordAuditLog } from './auditLogService.js';

// ─────────────────────────────────────────────────────────────────────────────
// Unified credit system. All balances are in CREDITS. Free daily credits reset
// at IST midnight; purchased credits (email_credits) never expire; reserved_credits
// holds credits committed to in-flight jobs. Every mutation of a monetary field
// uses an atomic $inc / $expr conditional update — never read-modify-write — so
// concurrent sends and duplicate requests cannot double-spend or oversell.
//
//   Fields on User:
//     email_credits    – purchased credits (persistent)
//     free_sent_today  – FREE credits already used today (0..FREE_DAILY_CREDITS)
//     free_quota_date  – IST day key the free counter belongs to
//     reserved_credits – credits reserved by queued jobs (subset not yet spent)
// ─────────────────────────────────────────────────────────────────────────────

export class QuotaError extends Error {
  constructor(message, code = 'QUOTA_EXCEEDED') {
    super(message);
    this.name = 'QuotaError';
    this.code = code;
    this.status = 402;
  }
}

export function getQuotaDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(date);
}

function billingFields() {
  return 'email_credits free_sent_today free_quota_date reserved_credits has_paid_access role email lifetime_credits_used lifetime_credits_received';
}

export function isBillingExempt(user) {
  return isAdminUser(user);
}

/**
 * Give back `credits` of reservation without letting the counter dip negative.
 *
 * The previous shape was an unguarded `$inc: -N` followed by a *separate*
 * clamp-to-zero statement. Between those two writes a concurrent reserveCredits
 * could read a negative reserved_credits, compute an inflated `available`, and
 * oversell. Guarding the decrement means it either applies in full or not at
 * all, and the clamp only handles drift that predates this call.
 */
async function decrementReserved(userId, credits) {
  if (credits <= 0) return;

  const applied = await User.updateOne(
    { _id: userId, reserved_credits: { $gte: credits } },
    { $inc: { reserved_credits: -credits } }
  );
  if (applied.modifiedCount > 0) return;

  // Less reserved than we are releasing — the reconciler's job. Zero it rather
  // than going negative, and say so, because this means reservations drifted.
  await User.updateOne(
    { _id: userId, reserved_credits: { $gt: 0 } },
    { $set: { reserved_credits: 0 } }
  );
}

// Same guard for the per-job reservation counter on a campaign / certificate job.
async function decrementRefReserved(model, refId, field, credits) {
  if (!refId || credits <= 0) return;

  const applied = await model.updateOne(
    { _id: refId, [field]: { $gte: credits } },
    { $inc: { [field]: -credits } }
  );
  if (applied.modifiedCount > 0) return;

  await model.updateOne({ _id: refId, [field]: { $gt: 0 } }, { $set: { [field]: 0 } });
}

// Atomic daily reset — only the first writer for a new day zeroes the counter.
async function ensureDailyResetAtomic(userId) {
  const today = getQuotaDateKey();
  await User.updateOne(
    { _id: userId, free_quota_date: { $ne: today } },
    { $set: { free_quota_date: today, free_sent_today: 0 } }
  );
  return today;
}

// Non-atomic reset for read paths that already hold the document.
export async function ensureDailyReset(user) {
  const today = getQuotaDateKey();
  if (user.free_quota_date !== today) {
    user.free_quota_date = today;
    user.free_sent_today = 0;
    await user.save();
  }
}

// ── Snapshot ────────────────────────────────────────────────────────────────

export function computeQuotaSnapshot(user) {
  const costs = { simple: creditCost('simple'), certificate: creditCost('certificate') };

  if (isBillingExempt(user)) {
    return {
      exempt: true,
      free_daily_limit: FREE_DAILY_CREDITS,
      free_daily_credits: FREE_DAILY_CREDITS,
      free_sent_today: 0,
      free_remaining: FREE_DAILY_CREDITS,
      free_credits_remaining: FREE_DAILY_CREDITS,
      email_credits: null,
      credits: null,
      reserved_credits: 0,
      available_to_send: null,
      available_credits: null,
      has_paid_access: true,
      quota_date: getQuotaDateKey(),
      costs,
      base_rate: BASE_RATE,
      lifetime_credits_used: user.lifetime_credits_used || 0,
      lifetime_credits_received: user.lifetime_credits_received || 0,
      can_use_paid_features: true,
      plan: 'admin',
      plan_label: 'Admin — Unlimited',
    };
  }

  const freeUsed = user.free_sent_today || 0;
  const freeRemaining = Math.max(0, FREE_DAILY_CREDITS - freeUsed);
  const credits = user.email_credits || 0;
  const reserved = user.reserved_credits || 0;
  const available = Math.max(0, freeRemaining + credits - reserved);
  const hasPaidAccess = Boolean(user.has_paid_access);

  return {
    exempt: false,
    free_daily_limit: FREE_DAILY_CREDITS,
    free_daily_credits: FREE_DAILY_CREDITS,
    free_sent_today: freeUsed,
    free_remaining: freeRemaining,
    free_credits_remaining: freeRemaining,
    email_credits: credits,
    credits,
    reserved_credits: reserved,
    available_to_send: available,
    available_credits: available,
    has_paid_access: hasPaidAccess,
    quota_date: user.free_quota_date || getQuotaDateKey(),
    costs,
    base_rate: BASE_RATE,
    lifetime_credits_used: user.lifetime_credits_used || 0,
    lifetime_credits_received: user.lifetime_credits_received || 0,
    // Authoritative answer to "can this user use AI / insights right now".
    // Balance-based, so it tracks reality instead of the historical flag —
    // see middleware/requirePaidFeatures.js for why.
    can_use_paid_features: available > 0,
    // has_paid_access now means only "has purchased at some point". It is kept
    // for reporting and is deliberately NOT what gates features.
    plan: credits > 0 ? 'paid' : 'free',
    plan_label: credits > 0 ? 'Paid plan' : 'Free plan',
  };
}

export async function getQuotaForUser(userId) {
  const user = await User.findById(userId).select(billingFields());
  if (!user) throw new QuotaError('User not found', 'USER_NOT_FOUND');
  await ensureDailyReset(user);
  return computeQuotaSnapshot(user);
}

export async function getAvailableCredits(userId) {
  const snapshot = await getQuotaForUser(userId);
  if (snapshot.exempt) return Infinity;
  return snapshot.available_to_send;
}

export const getAvailableSendUnits = getAvailableCredits;

export async function assertCanSend(userId, creditsNeeded) {
  if (!Number.isFinite(creditsNeeded) || creditsNeeded <= 0) {
    throw new QuotaError('Invalid credit amount', 'INVALID_COUNT');
  }
  const snapshot = await getQuotaForUser(userId);
  if (snapshot.exempt) return snapshot;
  if (creditsNeeded > snapshot.available_to_send) {
    throw new QuotaError(
      `Not enough credits. Need ${creditsNeeded}, have ${snapshot.available_to_send} available. Buy credits or wait for your free daily reset.`,
      'QUOTA_EXCEEDED'
    );
  }
  return snapshot;
}

// ── Reservation (atomic) ─────────────────────────────────────────────────────

// Atomically reserve `credits` iff the user currently has that many available.
// available = (FREE_DAILY − free_used) + email_credits − reserved. The whole
// check-and-reserve happens in one conditional update, so two concurrent requests
// cannot both pass the check and over-reserve.
async function reserveCredits(userId, credits) {
  if (credits <= 0) return true;
  const today = await ensureDailyResetAtomic(userId);

  const res = await User.findOneAndUpdate(
    {
      _id: userId,
      free_quota_date: today,
      $expr: {
        $gte: [
          {
            $add: [
              // $max with 0 to match computeQuotaSnapshot, which clamps the same
              // term. Unclamped, a free_sent_today above FREE_DAILY_CREDITS —
              // which happens the moment the free daily limit is lowered in
              // config, since existing counters are not rescaled — made this
              // term negative and silently ate the user's *paid* credits. The
              // resulting error contradicted itself: "Need 1, have 5 available".
              { $max: [0, { $subtract: [FREE_DAILY_CREDITS, { $ifNull: ['$free_sent_today', 0] }] }] },
              { $ifNull: ['$email_credits', 0] },
              { $multiply: [-1, { $ifNull: ['$reserved_credits', 0] }] },
            ],
          },
          credits,
        ],
      },
    },
    { $inc: { reserved_credits: credits } },
    { new: true }
  );

  if (!res) {
    const snap = await getQuotaForUser(userId);
    throw new QuotaError(
      `Not enough credits to queue this send. Need ${credits}, have ${snap.available_to_send} available. Buy credits or wait for your free daily reset.`,
      'QUOTA_EXCEEDED'
    );
  }
  return true;
}

// Reserve credits for a ref doc (campaign/certificate job), idempotently: only
// the delta beyond what is already reserved on the ref is newly reserved.
async function reserveForRef(userId, { model, refId, field, creditsPerUnit, units, notFoundCode }) {
  const user = await User.findById(userId).select(billingFields());
  if (!user) throw new QuotaError('User not found', 'USER_NOT_FOUND');

  if (isBillingExempt(user)) {
    await model.findByIdAndUpdate(refId, { $set: { [field]: 0 } });
    return { reserved: 0, exempt: true };
  }

  const ref = await model.findOne({ _id: refId, user_id: userId });
  if (!ref) throw new QuotaError('Resource not found', notFoundCode);

  const alreadyReserved = ref[field] || 0;
  const needed = Math.max(0, Math.floor(units)) * creditsPerUnit;
  const additional = Math.max(0, needed - alreadyReserved);
  if (additional === 0) return { reserved: alreadyReserved };

  // Claim the slot on the ref FIRST, conditional on the exact value we read.
  //
  // Reading `alreadyReserved` and then reserving + incrementing as two separate
  // statements is a lost-update race. Two concurrent POST /:id/resume both read
  // 0, both reserve N, and both $inc the ref to 2N — the status flip to
  // 'sending' happens after this call, so it does not serialise them. The
  // reconciler then treats the ref value as authoritative and preserves the
  // inflated 2N, stranding the user's credits until the job goes terminal.
  //
  // With the expected-value filter only one caller can win; the loser sees null
  // and reports the reservation the winner made.
  const claimed = await model.findOneAndUpdate(
    { _id: refId, user_id: userId, [field]: alreadyReserved },
    { $inc: { [field]: additional } },
    { new: true }
  );

  if (!claimed) {
    const fresh = await model.findOne({ _id: refId, user_id: userId }).select(field).lean();
    return { reserved: fresh?.[field] || 0, concurrent: true };
  }

  try {
    await reserveCredits(userId, additional); // throws QuotaError if insufficient
  } catch (err) {
    // The slot is claimed but unfunded — hand it back so the ref does not carry
    // a reservation the user never paid for.
    await model.updateOne({ _id: refId }, { $inc: { [field]: -additional } }).catch(() => {});
    throw err;
  }

  return { reserved: claimed[field] };
}

export function reserveCampaignQuota(userId, campaignId, recipientCount) {
  return reserveForRef(userId, {
    model: Campaign, refId: campaignId, field: 'quota_reserved',
    creditsPerUnit: creditCost('simple'), units: recipientCount, notFoundCode: 'CAMPAIGN_NOT_FOUND',
  });
}

export function reserveCertificateCredits(userId, jobId, recipientCount) {
  return reserveForRef(userId, {
    model: CertificateJob, refId: jobId, field: 'credits_reserved',
    creditsPerUnit: creditCost('certificate'), units: recipientCount, notFoundCode: 'JOB_NOT_FOUND',
  });
}

// ── Consumption (atomic, free-first then paid) ───────────────────────────────

async function consumeCredits(userId, { cost, kind, campaignId = null, jobId = null }) {
  const user = await User.findById(userId).select('role email');
  if (!user || isBillingExempt(user)) return { source: 'exempt' };

  const today = await ensureDailyResetAtomic(userId);

  let fromFree = 0;
  let fromPaid = 0;
  let shortfall = 0;

  // Spend one credit at a time so each move is a single atomic update. The
  // up-front reservation guarantees the credits exist; this only attributes them.
  for (let i = 0; i < cost; i++) {
    // The reserved_credits release is deliberately NOT part of these $inc
    // updates. Neither branch could guard on reserved_credits >= 1 without also
    // refusing the charge, so a raw -1 drove the field negative whenever the
    // reservation had already been released underneath us — the classic case
    // being a stop/cancel landing while a send was in flight. computeQuotaSnapshot
    // does `available = freeRemaining + credits - reserved`, so a negative
    // reserved *adds* to the balance: repeat start/stop and you farm free sends.
    // decrementReserved already clamps at zero, so release through it instead.
    const free = await User.findOneAndUpdate(
      { _id: userId, free_quota_date: today, free_sent_today: { $lt: FREE_DAILY_CREDITS } },
      { $inc: { free_sent_today: 1, lifetime_credits_used: 1 } }
    );
    if (free) {
      fromFree++;
      await decrementReserved(userId, 1);
      continue;
    }

    const paid = await User.findOneAndUpdate(
      { _id: userId, email_credits: { $gte: 1 } },
      { $inc: { email_credits: -1, lifetime_credits_used: 1 } }
    );
    if (paid) {
      fromPaid++;
      await decrementReserved(userId, 1);
      continue;
    }

    // Overflow — the reservation said these credits existed and they do not.
    // Release the reserved slot and record the shortfall so the caller can stop
    // sending. Silently returning success here is what turns any reservation
    // drift into an unbounded run of delivered-but-unbilled email, with no
    // ledger row (the write below is gated on spent > 0) to notice it by.
    await decrementReserved(userId, 1);
    shortfall++;
  }

  // Release the ref reservation for the whole cost.
  await decrementRefReserved(Campaign, campaignId, 'quota_reserved', cost);
  await decrementRefReserved(CertificateJob, jobId, 'credits_reserved', cost);

  const spent = fromFree + fromPaid;
  if (spent > 0) {
    const fresh = await User.findById(userId).select('email_credits');
    await CreditTransaction.create({
      user_id: userId,
      type: 'send',
      amount: -spent,
      balance_after: fresh?.email_credits ?? 0,
      campaign_id: campaignId,
      certificate_job_id: jobId,
      note: `${kind}: ${fromFree} free + ${fromPaid} paid credit(s)`,
    });
  }

  if (shortfall > 0) {
    console.error(
      `[quota] user ${userId} was short ${shortfall}/${cost} credit(s) on ${kind} — ` +
      'the send already went out. Halting the job; reservations are drifting.'
    );
  }

  return {
    source: fromPaid > 0 ? 'paid' : 'free',
    from_free: fromFree,
    from_paid: fromPaid,
    spent,
    shortfall,
    // false => the recipient was emailed but could not be fully paid for. The
    // send engines treat this as a stop condition rather than continuing.
    charged: shortfall === 0,
  };
}

export function consumeSendQuota(userId, campaignId) {
  return consumeCredits(userId, { cost: creditCost('simple'), kind: 'simple_email', campaignId });
}

export function consumeCertificateCredits(userId, jobId) {
  return consumeCredits(userId, { cost: creditCost('certificate'), kind: 'certificate_email', jobId });
}

// ── Refund / release (atomic) ────────────────────────────────────────────────

// Release `credits` back from reservation without spending them (e.g. a
// permanently-failed send). The credits return to the available pool.
async function releaseReserved(userId, { model, refId, field, credits }) {
  if (credits <= 0) return;
  const user = await User.findById(userId).select('role email');
  if (!user || isBillingExempt(user)) return;

  await decrementReserved(userId, credits);
  await decrementRefReserved(model, refId, field, credits);
}

export function releaseUnsentQuotaSlot(userId, campaignId) {
  return releaseReserved(userId, { model: Campaign, refId: campaignId, field: 'quota_reserved', credits: creditCost('simple') });
}

export function releaseCertificateCredits(userId, jobId, credits = creditCost('certificate')) {
  return releaseReserved(userId, { model: CertificateJob, refId: jobId, field: 'credits_reserved', credits });
}

// Release whatever is still reserved for a ref (job finished/canceled/stopped).
async function releaseAllReserved(userId, { model, refId, field, campaignId = null, jobId = null }) {
  const user = await User.findById(userId).select('role email email_credits');
  if (!user || isBillingExempt(user)) {
    await model.findByIdAndUpdate(refId, { $set: { [field]: 0 } });
    return;
  }
  // Claim the amount off the ref atomically FIRST, then apply it to the user.
  //
  // Reading the amount and then decrementing is a lost-update race, and this
  // function has two callers that fire for the same ref: the route handler
  // (stop / delete) and the send loop noticing the status change. Both would
  // read the same N and both would $inc by -N, so a user running two jobs ends
  // up with the second job's live reservation silently erased — inflating
  // available_to_send and letting them queue a send they cannot pay for.
  //
  // With the conditional $gt: 0 filter only one caller can win; the loser gets
  // null and returns without touching the balance.
  const claimed = await model.findOneAndUpdate(
    { _id: refId, [field]: { $gt: 0 } },
    { $set: { [field]: 0 } },
    { new: false } // pre-image: the amount this caller is responsible for
  );
  if (!claimed) return;
  const release = claimed[field] || 0;
  if (release <= 0) return;

  await decrementReserved(userId, release);

  await CreditTransaction.create({
    user_id: userId,
    type: 'reservation_release',
    amount: 0,
    balance_after: user.email_credits || 0,
    campaign_id: campaignId,
    certificate_job_id: jobId,
    note: `Released ${release} reserved credit(s)`,
  });
}

export function releaseCampaignQuota(userId, campaignId) {
  return releaseAllReserved(userId, { model: Campaign, refId: campaignId, field: 'quota_reserved', campaignId });
}

export function releaseCertificateJobReservation(userId, jobId) {
  return releaseAllReserved(userId, { model: CertificateJob, refId: jobId, field: 'credits_reserved', jobId });
}

// ── Admin grants / revokes (atomic) ──────────────────────────────────────────

// Claim an idempotency key by writing the ledger row BEFORE moving the balance.
// The unique partial index on payment_ref means a concurrent duplicate loses
// here — where nothing has been credited yet — instead of after a second $inc
// has already handed out free credits. Returns the claimed row; the caller must
// delete it if the grant then fails, so the key can be retried.
async function claimGrantLedgerRow(doc) {
  try {
    return await CreditTransaction.create(doc);
  } catch (err) {
    if (err?.code === 11000) {
      throw new Error('Credits were already granted for this payment reference');
    }
    throw err;
  }
}

export async function grantCredits(userId, amount, adminId, meta = {}) {
  const credits = parseInt(amount, 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error('Credit amount must be a positive number');
  }
  if (!meta.payment_ref) {
    throw new Error('A payment reference is required so the same payment cannot be credited twice');
  }

  const transaction = await claimGrantLedgerRow({
    user_id: userId,
    type: 'admin_grant',
    amount: credits,
    balance_after: 0, // filled in below once the balance actually moves
    admin_id: adminId,
    payment_ref: meta.payment_ref,
    pack_label: meta.pack_label || null,
    note: meta.note || null,
  });

  let user;
  try {
    user = await User.findOneAndUpdate(
      { _id: userId },
      { $inc: { email_credits: credits, lifetime_credits_received: credits }, $set: { has_paid_access: true } },
      { new: true }
    );
  } catch (err) {
    await CreditTransaction.deleteOne({ _id: transaction._id }).catch(() => {});
    throw err;
  }

  if (!user) {
    // No such user — release the key so a corrected retry can reuse it.
    await CreditTransaction.deleteOne({ _id: transaction._id }).catch(() => {});
    return null;
  }

  transaction.balance_after = user.email_credits;
  await CreditTransaction.updateOne(
    { _id: transaction._id },
    { $set: { balance_after: user.email_credits } }
  ).catch(() => {});

  // Everything below is a side effect of a grant that has already landed. If
  // one of them throws, the credits are still in the account — but the caller
  // sees a failure and will reasonably retry, which is exactly the sequence
  // that used to double-credit. The unique key now blocks the retry, so the
  // worst case is a confusing error on a successful grant. Make them
  // best-effort so the admin gets the truth: the money moved.
  const emailResult = await sendCreditGrantEmail(user, {
    credits,
    balanceAfter: user.email_credits,
    packLabel: meta.pack_label || null,
    paymentRef: meta.payment_ref || null,
    note: meta.note || null,
  }).catch((err) => ({ sent: false, error: err.message }));

  await notifyAdminsOfCreditChange({
    user,
    admin: { id: adminId, name: meta.adminName, email: meta.adminEmail },
    credits,
    balanceAfter: user.email_credits,
    action: 'granted',
    reference: meta.payment_ref || null,
    note: meta.note || null,
  }).catch((err) => console.error('[grant] admin alert failed:', err.message));

  await createNotification({
    userId,
    type: 'credit_grant',
    title: '🎉 Credits added to your account',
    message: `The MailIQ Team has added ${credits.toLocaleString('en-IN')} credits to your account. Your new balance is ${user.email_credits.toLocaleString('en-IN')} credits.`,
    data: { amount: credits, balance_after: user.email_credits, pack_label: meta.pack_label || null },
  }).catch((err) => console.error('[grant] notification failed:', err.message));

  await recordAuditLog({
    adminId,
    adminName: meta.adminName || '',
    adminEmail: meta.adminEmail || '',
    action: 'grant_credits',
    targetUserId: userId,
    targetUserName: user.name,
    targetUserEmail: user.email,
    amount: credits,
    reason: meta.note || null,
    metadata: { pack_label: meta.pack_label || null, payment_ref: meta.payment_ref || null },
  }).catch((err) => console.error('[grant] audit log failed:', err.message));

  await fulfillCreditPurchaseRequests(user.email)
    .catch((err) => console.error('[grant] purchase-request fulfilment failed:', err.message));

  return {
    user_id: userId,
    credits_granted: credits,
    email_credits: user.email_credits,
    has_paid_access: user.has_paid_access,
    transaction_id: transaction._id.toString(),
    confirmation_email_sent: Boolean(emailResult.sent),
    confirmation_email_error: emailResult.error || null,
  };
}

// Discretionary free credit grant (goodwill/promo) — no payment reference or
// pack implied. Same atomic increment path as grantCredits, but tagged
// distinctly in the ledger/audit trail and paired with the congratulatory
// in-app notification + email copy.
export async function grantFreeCredits(userId, amount, adminId, meta = {}) {
  const credits = parseInt(amount, 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error('Credit amount must be a positive number');
  }
  if (!meta.request_id) {
    throw new Error('A request id is required so the same grant cannot be applied twice');
  }

  // Free grants are replayable in exactly the same way paid ones are — a
  // double-clicked button issues two POSTs — so they get the same
  // database-enforced key, namespaced to keep it distinct from payment refs.
  const transaction = await claimGrantLedgerRow({
    user_id: userId,
    type: 'admin_free_grant',
    amount: credits,
    balance_after: 0,
    admin_id: adminId,
    payment_ref: `free:${meta.request_id}`,
    note: meta.reason || null,
  });

  let user;
  try {
    user = await User.findOneAndUpdate(
      { _id: userId },
      { $inc: { email_credits: credits, lifetime_credits_received: credits }, $set: { has_paid_access: true } },
      { new: true }
    );
  } catch (err) {
    await CreditTransaction.deleteOne({ _id: transaction._id }).catch(() => {});
    throw err;
  }

  if (!user) {
    await CreditTransaction.deleteOne({ _id: transaction._id }).catch(() => {});
    return null;
  }

  await CreditTransaction.updateOne(
    { _id: transaction._id },
    { $set: { balance_after: user.email_credits } }
  ).catch(() => {});

  const congratsMessage =
    `The MailIQ Team has added ${credits.toLocaleString('en-IN')} free credits to your account. ` +
    'Your new credit balance has been updated successfully. Thank you for using MailIQ—we hope these ' +
    'credits help you create and send even more successful email campaigns!' +
    (meta.reason ? ` Reason: ${meta.reason}` : '');

  // Best-effort side effects — see the note in grantCredits. The balance has
  // already moved; none of these may turn a successful grant into an error.
  await createNotification({
    userId,
    type: 'credit_grant',
    title: '🎉 Congratulations! Free credits added',
    message: congratsMessage,
    data: { amount: credits, balance_after: user.email_credits, reason: meta.reason || null, free: true },
  }).catch((err) => console.error('[free-grant] notification failed:', err.message));

  const emailResult = await sendCreditGrantEmail(user, {
    credits,
    balanceAfter: user.email_credits,
    note: meta.reason || null,
    paymentRef: `free:${meta.request_id}`,
    free: true,
  }).catch((err) => ({ sent: false, error: err.message }));

  await notifyAdminsOfCreditChange({
    user,
    admin: { id: adminId, name: meta.adminName, email: meta.adminEmail },
    credits,
    balanceAfter: user.email_credits,
    action: 'granted (free)',
    reference: `free:${meta.request_id}`,
    note: meta.reason || null,
  }).catch((err) => console.error('[free-grant] admin alert failed:', err.message));

  await recordAuditLog({
    adminId,
    adminName: meta.adminName || '',
    adminEmail: meta.adminEmail || '',
    action: 'grant_free_credits',
    targetUserId: userId,
    targetUserName: user.name,
    targetUserEmail: user.email,
    amount: credits,
    reason: meta.reason || null,
  }).catch((err) => console.error('[free-grant] audit log failed:', err.message));

  return {
    user_id: userId,
    credits_granted: credits,
    email_credits: user.email_credits,
    has_paid_access: user.has_paid_access,
    transaction_id: transaction._id.toString(),
    congrats_message: congratsMessage,
    confirmation_email_sent: Boolean(emailResult.sent),
    confirmation_email_error: emailResult.error || null,
  };
}

/**
 * Remove credits from an account — the refund / correction path.
 *
 * This is the only way to reverse money that has moved, so it now carries the
 * same protections as the grant path it undoes:
 *
 *  - `reversal_ref` is a required idempotency key, enforced by the same unique
 *    index. A double-clicked revoke previously deducted twice.
 *  - The ledger row is claimed BEFORE the balance moves, so a duplicate loses
 *    while nothing has been taken yet.
 *  - Notification and audit writes are best-effort. They used to be unguarded:
 *    a throw after the $inc landed surfaced a 500, the admin retried, and the
 *    retry deducted again.
 *  - Passing `reverses_payment_ref` releases the original grant's idempotency
 *    key, so a mistaken grant can be corrected and re-issued. Without this a
 *    revoked payment reference was permanently unusable.
 *  - `lifetime_credits_received` is decremented, so the lifetime total does not
 *    permanently overstate what the user actually kept.
 *
 * `has_paid_access` is deliberately NOT cleared: it now records only that a
 * purchase happened, and entitlements are computed from the live balance.
 */
export async function revokeCredits(userId, amount, adminId, meta = {}) {
  const credits = parseInt(amount, 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error('Credit amount must be a positive number');
  }
  if (!meta.reversal_ref) {
    throw new Error('A reversal reference is required so the same refund cannot be applied twice');
  }

  const user = await User.findById(userId).select('name email email_credits reserved_credits has_paid_access');
  if (!user) return null;

  const balance = user.email_credits || 0;
  const reserved = user.reserved_credits || 0;
  const revocable = Math.max(0, balance - reserved);
  if (revocable <= 0) {
    throw new Error('No revocable credits — balance may be fully reserved by active jobs');
  }
  if (credits > revocable) {
    // Previously this silently clamped and reported success for a smaller
    // number, so an admin refunding 1000 could quietly refund 40 and never
    // notice. Refuse and state the real figure instead.
    throw new Error(
      `Only ${revocable} credit(s) can be removed right now (balance ${balance}, ${reserved} reserved by active jobs).`
    );
  }

  const isRefund = Boolean(meta.reverses_payment_ref);

  const transaction = await claimGrantLedgerRow({
    user_id: userId,
    type: isRefund ? 'refund' : 'admin_revoke',
    amount: -credits,
    balance_after: 0, // filled in below once the balance actually moves
    admin_id: adminId,
    payment_ref: `revoke:${meta.reversal_ref}`,
    note: meta.note || null,
  });

  let updated;
  try {
    updated = await User.findOneAndUpdate(
      { _id: userId, email_credits: { $gte: credits } },
      { $inc: { email_credits: -credits, lifetime_credits_received: -credits } },
      { new: true }
    );
  } catch (err) {
    await CreditTransaction.deleteOne({ _id: transaction._id }).catch(() => {});
    throw err;
  }

  if (!updated) {
    await CreditTransaction.deleteOne({ _id: transaction._id }).catch(() => {});
    throw new Error('Balance changed — please retry the refund');
  }

  // lifetime_credits_received must never read negative on a partial history.
  await User.updateOne(
    { _id: userId, lifetime_credits_received: { $lt: 0 } },
    { $set: { lifetime_credits_received: 0 } }
  ).catch(() => {});

  await CreditTransaction.updateOne(
    { _id: transaction._id },
    { $set: { balance_after: updated.email_credits } }
  ).catch(() => {});

  // Release the original grant's idempotency key so the payment can be
  // re-credited after a correction.
  let reversedGrantId = null;
  if (meta.reverses_payment_ref) {
    const original = await CreditTransaction.findOneAndUpdate(
      { user_id: userId, payment_ref: meta.reverses_payment_ref, reversed_at: null },
      {
        $set: {
          reversed_at: new Date(),
          reversed_ref: meta.reverses_payment_ref,
          payment_ref: null,
        },
      },
      { new: true }
    ).catch(() => null);

    if (original) {
      reversedGrantId = original._id;
      await CreditTransaction.updateOne(
        { _id: transaction._id },
        { $set: { reverses_transaction_id: original._id } }
      ).catch(() => {});
    }
  }

  // Best-effort from here — the balance has already moved and none of these may
  // turn a completed refund into an error the admin would retry.
  //
  // The email is new: a balance reduction previously produced only an in-app
  // notification, so a user whose credits were removed found out only if they
  // happened to open the bell menu.
  await sendCreditRefundEmail(user, {
    credits,
    balanceAfter: updated.email_credits,
    note: meta.note || null,
    isRefund,
    reversalRef: meta.reversal_ref,
  }).catch((err) => console.error('[revoke] user email failed:', err.message));

  await notifyAdminsOfCreditChange({
    user,
    admin: { id: adminId, name: meta.adminName, email: meta.adminEmail },
    credits,
    balanceAfter: updated.email_credits,
    action: isRefund ? 'refund' : 'revoke',
    reference: meta.reversal_ref,
    note: meta.note || null,
  }).catch((err) => console.error('[revoke] admin alert failed:', err.message));

  await createNotification({
    userId,
    type: 'credit_revoke',
    title: 'Credit balance adjusted',
    message: `${credits.toLocaleString('en-IN')} credit(s) were removed from your account by an administrator. Your new balance is ${updated.email_credits.toLocaleString('en-IN')} credits.${meta.note ? ` Reason: ${meta.note}` : ''}`,
    data: { amount: -credits, balance_after: updated.email_credits, reason: meta.note || null },
  }).catch((err) => console.error('[revoke] notification failed:', err.message));

  await recordAuditLog({
    adminId,
    adminName: meta.adminName || '',
    adminEmail: meta.adminEmail || '',
    action: isRefund ? 'refund_credits' : 'revoke_credits',
    targetUserId: userId,
    targetUserName: user.name,
    targetUserEmail: user.email,
    amount: credits,
    reason: meta.note || null,
    metadata: {
      reversal_ref: meta.reversal_ref,
      reverses_payment_ref: meta.reverses_payment_ref || null,
      reversed_grant_id: reversedGrantId?.toString() || null,
    },
  }).catch((err) => console.error('[revoke] audit log failed:', err.message));

  return {
    user_id: userId,
    credits_revoked: credits,
    email_credits: updated.email_credits,
    has_paid_access: updated.has_paid_access,
    is_refund: isRefund,
    reversed_grant_id: reversedGrantId?.toString() || null,
    transaction_id: transaction._id.toString(),
  };
}

export function resolvePackCredits(packId) {
  return CREDIT_PACKS[packId] || null;
}

export async function listCreditTransactions(userId, { limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const rows = await CreditTransaction.find({ user_id: userId })
    .sort({ created_at: -1 })
    .limit(safeLimit)
    .lean();

  return rows.map((row) => ({
    id: row._id.toString(),
    type: row.type,
    amount: row.amount,
    balance_after: row.balance_after,
    payment_ref: row.payment_ref,
    pack_label: row.pack_label,
    note: row.note,
    campaign_id: row.campaign_id?.toString() ?? null,
    certificate_job_id: row.certificate_job_id?.toString() ?? null,
    created_at: row.created_at,
  }));
}

export async function countPendingRecipients(campaignId) {
  const CampaignRecipient = mongoose.model('CampaignRecipient');
  return CampaignRecipient.countDocuments({ campaign_id: campaignId, status: 'pending' });
}

export async function countOutstandingRecipients(campaignId) {
  const CampaignRecipient = mongoose.model('CampaignRecipient');
  return CampaignRecipient.countDocuments({
    campaign_id: campaignId,
    status: { $in: ['pending', 'sending'] },
  });
}
