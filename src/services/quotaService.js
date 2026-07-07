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
import { sendCreditGrantConfirmationEmail, sendFreeCreditGrantEmail } from './officeEmailService.js';
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
    plan: hasPaidAccess ? 'paid' : 'free',
    plan_label: hasPaidAccess ? 'Paid plan' : 'Free plan',
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
              { $subtract: [FREE_DAILY_CREDITS, { $ifNull: ['$free_sent_today', 0] }] },
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

  await reserveCredits(userId, additional); // throws QuotaError if insufficient
  await model.updateOne({ _id: refId }, { $inc: { [field]: additional } });
  return { reserved: alreadyReserved + additional };
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

  // Spend one credit at a time so each move is a single atomic update. The
  // up-front reservation guarantees the credits exist; this only attributes them.
  for (let i = 0; i < cost; i++) {
    const free = await User.findOneAndUpdate(
      { _id: userId, free_quota_date: today, free_sent_today: { $lt: FREE_DAILY_CREDITS } },
      { $inc: { free_sent_today: 1, reserved_credits: -1, lifetime_credits_used: 1 } }
    );
    if (free) { fromFree++; continue; }

    const paid = await User.findOneAndUpdate(
      { _id: userId, email_credits: { $gte: 1 } },
      { $inc: { email_credits: -1, reserved_credits: -1, lifetime_credits_used: 1 } }
    );
    if (paid) { fromPaid++; continue; }

    // Overflow (should be prevented by reservation) — release the reserved slot.
    await User.updateOne({ _id: userId }, { $inc: { reserved_credits: -1 } });
  }

  // Defensive clamp + release the ref reservation for the whole cost.
  await User.updateOne({ _id: userId, reserved_credits: { $lt: 0 } }, { $set: { reserved_credits: 0 } });
  if (campaignId) await Campaign.updateOne({ _id: campaignId }, { $inc: { quota_reserved: -cost } });
  if (jobId) await CertificateJob.updateOne({ _id: jobId }, { $inc: { credits_reserved: -cost } });

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

  return { source: fromPaid > 0 ? 'paid' : 'free', from_free: fromFree, from_paid: fromPaid, spent };
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

  await User.updateOne({ _id: userId }, { $inc: { reserved_credits: -credits } });
  await User.updateOne({ _id: userId, reserved_credits: { $lt: 0 } }, { $set: { reserved_credits: 0 } });
  if (refId) {
    await model.updateOne({ _id: refId }, { $inc: { [field]: -credits } });
    await model.updateOne({ _id: refId, [field]: { $lt: 0 } }, { $set: { [field]: 0 } });
  }
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
  const ref = await model.findById(refId);
  if (!ref) return;
  const release = ref[field] || 0;
  if (release <= 0) return;

  await User.updateOne({ _id: userId }, { $inc: { reserved_credits: -release } });
  await User.updateOne({ _id: userId, reserved_credits: { $lt: 0 } }, { $set: { reserved_credits: 0 } });
  await model.updateOne({ _id: refId }, { $set: { [field]: 0 } });

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

export async function grantCredits(userId, amount, adminId, meta = {}) {
  const credits = parseInt(amount, 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error('Credit amount must be a positive number');
  }

  if (meta.payment_ref) {
    const duplicate = await CreditTransaction.findOne({ type: 'admin_grant', payment_ref: meta.payment_ref });
    if (duplicate) throw new Error('Credits were already granted for this payment reference');
  }

  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { email_credits: credits, lifetime_credits_received: credits }, $set: { has_paid_access: true } },
    { new: true }
  );
  if (!user) return null;

  const transaction = await CreditTransaction.create({
    user_id: userId,
    type: 'admin_grant',
    amount: credits,
    balance_after: user.email_credits,
    admin_id: adminId,
    payment_ref: meta.payment_ref || null,
    pack_label: meta.pack_label || null,
    note: meta.note || null,
  });

  const emailResult = await sendCreditGrantConfirmationEmail(user, {
    creditsGranted: credits,
    balanceAfter: user.email_credits,
    packLabel: meta.pack_label || null,
    paymentRef: meta.payment_ref || null,
    note: meta.note || null,
  });

  await createNotification({
    userId,
    type: 'credit_grant',
    title: '🎉 Credits added to your account',
    message: `The MailIQ Team has added ${credits.toLocaleString('en-IN')} credits to your account. Your new balance is ${user.email_credits.toLocaleString('en-IN')} credits.`,
    data: { amount: credits, balance_after: user.email_credits, pack_label: meta.pack_label || null },
  });

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
  });

  await fulfillCreditPurchaseRequests(user.email);

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

  const user = await User.findOneAndUpdate(
    { _id: userId },
    { $inc: { email_credits: credits, lifetime_credits_received: credits }, $set: { has_paid_access: true } },
    { new: true }
  );
  if (!user) return null;

  const transaction = await CreditTransaction.create({
    user_id: userId,
    type: 'admin_free_grant',
    amount: credits,
    balance_after: user.email_credits,
    admin_id: adminId,
    note: meta.reason || null,
  });

  const congratsMessage =
    `The MailIQ Team has added ${credits.toLocaleString('en-IN')} free credits to your account. ` +
    'Your new credit balance has been updated successfully. Thank you for using MailIQ—we hope these ' +
    'credits help you create and send even more successful email campaigns!' +
    (meta.reason ? ` Reason: ${meta.reason}` : '');

  await createNotification({
    userId,
    type: 'credit_grant',
    title: '🎉 Congratulations! Free credits added',
    message: congratsMessage,
    data: { amount: credits, balance_after: user.email_credits, reason: meta.reason || null, free: true },
  });

  const emailResult = await sendFreeCreditGrantEmail(user, {
    creditsGranted: credits,
    balanceAfter: user.email_credits,
    reason: meta.reason || null,
  });

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
  });

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

export async function revokeCredits(userId, amount, adminId, meta = {}) {
  const credits = parseInt(amount, 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error('Credit amount must be a positive number');
  }

  const user = await User.findById(userId).select('name email email_credits reserved_credits has_paid_access');
  if (!user) return null;

  const balance = user.email_credits || 0;
  const reserved = user.reserved_credits || 0;
  const revocable = Math.max(0, balance - reserved);
  if (revocable <= 0) {
    throw new Error('No revocable credits — balance may be fully reserved by active jobs');
  }
  const toRevoke = Math.min(credits, revocable);

  // Atomic conditional decrement so a concurrent send can't drop the balance
  // below what we revoke.
  const updated = await User.findOneAndUpdate(
    { _id: userId, email_credits: { $gte: toRevoke } },
    { $inc: { email_credits: -toRevoke } },
    { new: true }
  );
  if (!updated) throw new Error('Balance changed — please retry the revoke');

  if (updated.email_credits <= 0) {
    await User.updateOne({ _id: userId }, { $set: { has_paid_access: false } });
    updated.has_paid_access = false;
  }

  const transaction = await CreditTransaction.create({
    user_id: userId,
    type: 'admin_revoke',
    amount: -toRevoke,
    balance_after: updated.email_credits,
    admin_id: adminId,
    note: meta.note || null,
  });

  await createNotification({
    userId,
    type: 'credit_revoke',
    title: 'Credit balance adjusted',
    message: `${toRevoke.toLocaleString('en-IN')} credit(s) were removed from your account by an administrator. Your new balance is ${updated.email_credits.toLocaleString('en-IN')} credits.${meta.note ? ` Reason: ${meta.note}` : ''}`,
    data: { amount: -toRevoke, balance_after: updated.email_credits, reason: meta.note || null },
  });

  await recordAuditLog({
    adminId,
    adminName: meta.adminName || '',
    adminEmail: meta.adminEmail || '',
    action: 'revoke_credits',
    targetUserId: userId,
    targetUserName: user.name,
    targetUserEmail: user.email,
    amount: toRevoke,
    reason: meta.note || null,
  });

  return {
    user_id: userId,
    credits_revoked: toRevoke,
    email_credits: updated.email_credits,
    has_paid_access: updated.has_paid_access,
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
