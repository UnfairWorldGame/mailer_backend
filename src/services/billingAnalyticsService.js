import mongoose from 'mongoose';
import User from '../models/User.js';
import Campaign from '../models/Campaign.js';
import CertificateJob from '../models/CertificateJob.js';
import CreditTransaction from '../models/CreditTransaction.js';
import CreditPurchaseRequest from '../models/CreditPurchaseRequest.js';
import { BASE_RATE } from '../config/billingConfig.js';
import { recordAuditLog } from './auditLogService.js';

/**
 * Admin-facing billing analytics.
 *
 * Payment happens off-platform, so "revenue" here is imputed from credits
 * granted at the published base rate (₹99 / 1,000 credits) rather than read
 * from a gateway. It is an indicator, not an accounting figure — labelled as
 * such in the response so nobody mistakes it for settled cash.
 */
export async function getBillingAnalytics({ days = 30 } = {}) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [byType, dailyGrants, topSpenders, reservationHealth, requestFunnel, balances] =
    await Promise.all([
      CreditTransaction.aggregate([
        { $match: { created_at: { $gte: since } } },
        {
          $group: {
            _id: '$type',
            count: { $sum: 1 },
            credits: { $sum: '$amount' },
          },
        },
        { $sort: { count: -1 } },
      ]),

      CreditTransaction.aggregate([
        {
          $match: {
            created_at: { $gte: since },
            type: { $in: ['admin_grant', 'admin_free_grant', 'refund', 'admin_revoke'] },
          },
        },
        {
          $group: {
            _id: {
              day: { $dateToString: { format: '%Y-%m-%d', date: '$created_at', timezone: 'Asia/Kolkata' } },
              type: '$type',
            },
            credits: { $sum: '$amount' },
          },
        },
        { $sort: { '_id.day': 1 } },
      ]),

      CreditTransaction.aggregate([
        { $match: { created_at: { $gte: since }, type: 'send' } },
        { $group: { _id: '$user_id', credits_spent: { $sum: { $abs: '$amount' } }, sends: { $sum: 1 } } },
        { $sort: { credits_spent: -1 } },
        { $limit: 10 },
        {
          $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' },
        },
        { $unwind: { path: '$user', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 0,
            user_id: '$_id',
            name: '$user.name',
            email: '$user.email',
            credits_spent: 1,
            sends: 1,
            balance: { $ifNull: ['$user.email_credits', 0] },
          },
        },
      ]),

      // Users whose denormalised reserved_credits disagrees with the sum of
      // their live per-job reservations. A non-empty list means the reconciler
      // has drift to repair — the single most useful health signal here.
      (async () => {
        const [campaignAgg, jobAgg, userAgg] = await Promise.all([
          Campaign.aggregate([
            { $match: { quota_reserved: { $gt: 0 } } },
            { $group: { _id: '$user_id', reserved: { $sum: '$quota_reserved' } } },
          ]),
          CertificateJob.aggregate([
            { $match: { credits_reserved: { $gt: 0 } } },
            { $group: { _id: '$user_id', reserved: { $sum: '$credits_reserved' } } },
          ]),
          User.find({ reserved_credits: { $gt: 0 } }).select('reserved_credits').lean(),
        ]);

        const expected = new Map();
        for (const row of [...campaignAgg, ...jobAgg]) {
          const key = row._id?.toString();
          if (key) expected.set(key, (expected.get(key) || 0) + row.reserved);
        }

        const drifted = [];
        const seen = new Set();
        for (const u of userAgg) {
          const key = u._id.toString();
          seen.add(key);
          const want = expected.get(key) || 0;
          if (want !== (u.reserved_credits || 0)) {
            drifted.push({ user_id: key, recorded: u.reserved_credits || 0, expected: want });
          }
        }
        for (const [key, want] of expected) {
          if (!seen.has(key) && want > 0) {
            drifted.push({ user_id: key, recorded: 0, expected: want });
          }
        }

        return {
          drifted_users: drifted.slice(0, 50),
          drifted_count: drifted.length,
          total_reserved: [...expected.values()].reduce((s, n) => s + n, 0),
        };
      })(),

      CreditPurchaseRequest.aggregate([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),

      User.aggregate([
        {
          $group: {
            _id: null,
            users: { $sum: 1 },
            credits_outstanding: { $sum: { $ifNull: ['$email_credits', 0] } },
            reserved: { $sum: { $ifNull: ['$reserved_credits', 0] } },
            lifetime_used: { $sum: { $ifNull: ['$lifetime_credits_used', 0] } },
            lifetime_received: { $sum: { $ifNull: ['$lifetime_credits_received', 0] } },
            paying_users: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$email_credits', 0] }, 0] }, 1, 0] } },
          },
        },
      ]),
    ]);

  const typeMap = Object.fromEntries(byType.map((r) => [r._id, r]));
  const granted = (typeMap.admin_grant?.credits || 0);
  const freeGranted = (typeMap.admin_free_grant?.credits || 0);
  const refunded = Math.abs(typeMap.refund?.credits || 0) + Math.abs(typeMap.admin_revoke?.credits || 0);
  const totals = balances[0] || {};

  const toInr = (credits) => Math.round((credits / BASE_RATE.credits) * BASE_RATE.priceInr);

  return {
    window_days: days,
    since,
    // Imputed from the published rate — payment is settled off-platform, so
    // this is a directional figure, not booked revenue.
    revenue_estimate: {
      basis: `${BASE_RATE.credits} credits = ₹${BASE_RATE.priceInr}`,
      is_estimate: true,
      paid_credits_granted: granted,
      gross_inr: toInr(granted),
      refunded_credits: refunded,
      refunded_inr: toInr(refunded),
      net_inr: toInr(Math.max(0, granted - refunded)),
      free_credits_granted: freeGranted,
    },
    transactions_by_type: byType.map((r) => ({ type: r._id, count: r.count, credits: r.credits })),
    daily: dailyGrants.map((r) => ({ day: r._id.day, type: r._id.type, credits: r.credits })),
    top_spenders: topSpenders,
    reservation_health: reservationHealth,
    purchase_requests: Object.fromEntries(requestFunnel.map((r) => [r._id, r.count])),
    totals: {
      users: totals.users || 0,
      paying_users: totals.paying_users || 0,
      credits_outstanding: totals.credits_outstanding || 0,
      credits_reserved: totals.reserved || 0,
      lifetime_credits_used: totals.lifetime_used || 0,
      lifetime_credits_received: totals.lifetime_received || 0,
      // What we would owe in credits if every user spent their balance.
      outstanding_liability_inr: toInr(totals.credits_outstanding || 0),
    },
  };
}

/**
 * Recompute one user's reserved_credits from their live jobs, on demand.
 * Mirrors what quotaReconciler does on its 30-minute sweep.
 */
export async function reconcileUserCredits(userId, { adminId, adminName, adminEmail } = {}) {
  if (!mongoose.isValidObjectId(userId)) return null;

  const user = await User.findById(userId).select('name email reserved_credits email_credits');
  if (!user) return null;

  const [campaignAgg, jobAgg] = await Promise.all([
    Campaign.aggregate([
      { $match: { user_id: user._id, quota_reserved: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$quota_reserved' } } },
    ]),
    CertificateJob.aggregate([
      { $match: { user_id: user._id, credits_reserved: { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$credits_reserved' } } },
    ]),
  ]);

  const expected = (campaignAgg[0]?.total || 0) + (jobAgg[0]?.total || 0);
  const recorded = user.reserved_credits || 0;

  if (expected === recorded) {
    return { user_id: userId, changed: false, reserved_credits: recorded, expected };
  }

  // Conditional on the value we read, so a concurrent send does not get
  // clobbered by a stale recomputation.
  const updated = await User.findOneAndUpdate(
    { _id: user._id, reserved_credits: recorded },
    { $set: { reserved_credits: expected } },
    { new: true }
  );

  if (!updated) {
    return { user_id: userId, changed: false, reserved_credits: recorded, expected, retry: true };
  }

  await recordAuditLog({
    adminId,
    adminName: adminName || '',
    adminEmail: adminEmail || '',
    action: 'reconcile_credits',
    targetUserId: userId,
    targetUserName: user.name,
    targetUserEmail: user.email,
    amount: expected - recorded,
    reason: 'Manual reservation reconciliation',
    metadata: { from: recorded, to: expected },
  }).catch((err) => console.error('[reconcile] audit log failed:', err.message));

  return {
    user_id: userId,
    changed: true,
    previous_reserved_credits: recorded,
    reserved_credits: expected,
    expected,
  };
}
