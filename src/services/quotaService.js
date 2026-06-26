import mongoose from 'mongoose';
import User from '../models/User.js';
import Campaign from '../models/Campaign.js';
import CreditTransaction from '../models/CreditTransaction.js';
import { FREE_DAILY_EMAIL_LIMIT, CREDIT_PACKS } from '../config/billingConfig.js';
import { isAdminUser } from '../utils/adminAccess.js';
import { fulfillCreditPurchaseRequests } from './creditPurchaseService.js';
import { sendCreditGrantConfirmationEmail } from './officeEmailService.js';

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
  return 'email_credits free_sent_today free_quota_date reserved_credits has_paid_access role email';
}

export function isBillingExempt(user) {
  return isAdminUser(user);
}

export async function ensureDailyReset(user) {
  const today = getQuotaDateKey();
  if (user.free_quota_date !== today) {
    user.free_quota_date = today;
    user.free_sent_today = 0;
    await user.save();
  }
}

export function computeQuotaSnapshot(user) {
  if (isBillingExempt(user)) {
    return {
      exempt: true,
      free_daily_limit: FREE_DAILY_EMAIL_LIMIT,
      free_sent_today: 0,
      free_remaining: FREE_DAILY_EMAIL_LIMIT,
      email_credits: null,
      reserved_credits: 0,
      available_to_send: null,
      has_paid_access: true,
      quota_date: getQuotaDateKey(),
    };
  }

  const freeSent = user.free_sent_today || 0;
  const freeRemaining = Math.max(0, FREE_DAILY_EMAIL_LIMIT - freeSent);
  const credits = user.email_credits || 0;
  const reserved = user.reserved_credits || 0;
  const available = Math.max(0, freeRemaining + credits - reserved);

  return {
    exempt: false,
    free_daily_limit: FREE_DAILY_EMAIL_LIMIT,
    free_sent_today: freeSent,
    free_remaining: freeRemaining,
    email_credits: credits,
    reserved_credits: reserved,
    available_to_send: available,
    has_paid_access: Boolean(user.has_paid_access),
    quota_date: user.free_quota_date || getQuotaDateKey(),
  };
}

export async function getQuotaForUser(userId) {
  const user = await User.findById(userId).select(billingFields());
  if (!user) throw new QuotaError('User not found', 'USER_NOT_FOUND');
  await ensureDailyReset(user);
  return computeQuotaSnapshot(user);
}

export async function getAvailableSendUnits(userId) {
  const snapshot = await getQuotaForUser(userId);
  if (snapshot.exempt) return Infinity;
  return snapshot.available_to_send;
}

export async function assertCanSend(userId, count) {
  if (!Number.isFinite(count) || count <= 0) {
    throw new QuotaError('Invalid send count', 'INVALID_COUNT');
  }

  const snapshot = await getQuotaForUser(userId);
  if (snapshot.exempt) return snapshot;

  if (count > snapshot.available_to_send) {
    if (snapshot.free_remaining <= 0 && snapshot.email_credits <= snapshot.reserved_credits) {
      throw new QuotaError(
        `Daily free limit of ${FREE_DAILY_EMAIL_LIMIT} emails reached and no paid credits available. Buy credits or try again tomorrow.`,
        'QUOTA_EXCEEDED'
      );
    }
    if (snapshot.free_remaining < count && snapshot.email_credits === 0) {
      throw new QuotaError(
        `Not enough quota. You have ${snapshot.free_remaining} free email(s) left today. Buy credits to send more.`,
        'QUOTA_EXCEEDED'
      );
    }
    throw new QuotaError(
      `Not enough email quota. Available: ${snapshot.available_to_send}, needed: ${count}. Buy credits or wait for your daily free limit to reset.`,
      'QUOTA_EXCEEDED'
    );
  }

  return snapshot;
}

export async function reserveCampaignQuota(userId, campaignId, count) {
  if (!Number.isFinite(count) || count <= 0) return { reserved: 0 };

  const user = await User.findById(userId).select(billingFields());
  if (!user) throw new QuotaError('User not found', 'USER_NOT_FOUND');
  if (isBillingExempt(user)) {
    await Campaign.findByIdAndUpdate(campaignId, { $set: { quota_reserved: 0 } });
    return { reserved: 0, exempt: true };
  }

  await ensureDailyReset(user);

  const campaign = await Campaign.findOne({ _id: campaignId, user_id: userId });
  if (!campaign) throw new QuotaError('Campaign not found', 'CAMPAIGN_NOT_FOUND');

  const alreadyReserved = campaign.quota_reserved || 0;
  const additional = Math.max(0, count - alreadyReserved);
  if (additional === 0) return { reserved: alreadyReserved };

  await assertCanSend(userId, additional);

  const freeRemaining = Math.max(0, FREE_DAILY_EMAIL_LIMIT - (user.free_sent_today || 0));
  const credits = user.email_credits || 0;
  const reserved = user.reserved_credits || 0;
  const available = freeRemaining + credits - reserved;

  if (additional > available) {
    throw new QuotaError(
      `Not enough email quota to send to ${count} recipient(s). Available: ${available + alreadyReserved}.`,
      'QUOTA_EXCEEDED'
    );
  }

  user.reserved_credits = reserved + additional;
  await user.save();

  campaign.quota_reserved = alreadyReserved + additional;
  await campaign.save();

  return { reserved: campaign.quota_reserved };
}

export async function consumeSendQuota(userId, campaignId) {
  const user = await User.findById(userId).select(billingFields());
  if (!user || isBillingExempt(user)) return { source: 'exempt' };

  await ensureDailyReset(user);

  const freeRemaining = FREE_DAILY_EMAIL_LIMIT - (user.free_sent_today || 0);
  let source = 'free';
  let balanceAfter = user.email_credits || 0;

  if (freeRemaining > 0) {
    user.free_sent_today = (user.free_sent_today || 0) + 1;
  } else {
    user.email_credits = Math.max(0, (user.email_credits || 0) - 1);
    balanceAfter = user.email_credits;
    source = 'paid';
  }

  user.reserved_credits = Math.max(0, (user.reserved_credits || 0) - 1);
  await user.save();

  await Campaign.findByIdAndUpdate(campaignId, { $inc: { quota_reserved: -1 } });

  if (source === 'paid') {
    await CreditTransaction.create({
      user_id: userId,
      type: 'send',
      amount: -1,
      balance_after: balanceAfter,
      campaign_id: campaignId,
    });
  }

  return { source, balance_after: balanceAfter };
}

export async function releaseUnsentQuotaSlot(userId, campaignId) {
  const user = await User.findById(userId).select(billingFields());
  if (!user || isBillingExempt(user)) return;

  user.reserved_credits = Math.max(0, (user.reserved_credits || 0) - 1);
  await user.save();

  const campaign = await Campaign.findOne({ _id: campaignId, user_id: userId });
  if (!campaign) return;

  const release = Math.min(1, campaign.quota_reserved || 0);
  if (release > 0) {
    campaign.quota_reserved = Math.max(0, campaign.quota_reserved - release);
    await campaign.save();
  }
}

export async function releaseCampaignQuota(userId, campaignId) {
  const user = await User.findById(userId).select(billingFields());
  if (!user || isBillingExempt(user)) {
    await Campaign.findByIdAndUpdate(campaignId, { $set: { quota_reserved: 0 } });
    return;
  }

  const campaign = await Campaign.findOne({ _id: campaignId, user_id: userId });
  if (!campaign) return;

  const release = campaign.quota_reserved || 0;
  if (release <= 0) return;

  user.reserved_credits = Math.max(0, (user.reserved_credits || 0) - release);
  await user.save();

  campaign.quota_reserved = 0;
  await campaign.save();

  await CreditTransaction.create({
    user_id: userId,
    type: 'reservation_release',
    amount: 0,
    balance_after: user.email_credits || 0,
    campaign_id: campaignId,
    note: `Released ${release} reserved send slot(s)`,
  });
}

export async function grantCredits(userId, amount, adminId, meta = {}) {
  const credits = parseInt(amount, 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error('Credit amount must be a positive number');
  }

  if (meta.payment_ref) {
    const duplicate = await CreditTransaction.findOne({
      type: 'admin_grant',
      payment_ref: meta.payment_ref,
    });
    if (duplicate) {
      throw new Error('Credits were already granted for this payment reference');
    }
  }

  const user = await User.findById(userId);
  if (!user) return null;

  user.email_credits = (user.email_credits || 0) + credits;
  user.has_paid_access = true;
  await user.save();

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

export async function revokeCredits(userId, amount, adminId, meta = {}) {
  const credits = parseInt(amount, 10);
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error('Credit amount must be a positive number');
  }

  const user = await User.findById(userId);
  if (!user) return null;

  const balance = user.email_credits || 0;
  const reserved = user.reserved_credits || 0;
  const revocable = Math.max(0, balance - reserved);

  if (revocable <= 0) {
    throw new Error('No revocable credits — balance may be fully reserved by active campaigns');
  }

  const toRevoke = Math.min(credits, revocable);

  user.email_credits = balance - toRevoke;
  if (user.email_credits <= 0) {
    user.email_credits = 0;
    user.has_paid_access = false;
  }
  await user.save();

  const transaction = await CreditTransaction.create({
    user_id: userId,
    type: 'admin_revoke',
    amount: -toRevoke,
    balance_after: user.email_credits,
    admin_id: adminId,
    note: meta.note || null,
  });

  return {
    user_id: userId,
    credits_revoked: toRevoke,
    email_credits: user.email_credits,
    has_paid_access: user.has_paid_access,
    transaction_id: transaction._id.toString(),
  };
}

export function resolvePackCredits(packId) {
  const pack = CREDIT_PACKS[packId];
  if (!pack) return null;
  return pack;
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
