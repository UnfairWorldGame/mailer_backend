import { getQuotaForUser, isBillingExempt } from '../services/quotaService.js';

/**
 * Gate for credit-funded features (AI writing, analytics).
 *
 * Eligibility is the user's *live balance*, not the `has_paid_access` flag. The
 * flag only records that a purchase happened at some point: it was set true on
 * every grant and never cleared as credits were spent, so anyone who ever
 * bought a pack kept AI forever on a zero balance — while an admin revoke down
 * to zero *did* clear it. Two routes to the same balance, opposite entitlements.
 *
 * Balance-based means free-tier users can use these features out of their daily
 * allowance, and everyone loses them at zero until the allowance resets or they
 * top up. Admins remain exempt.
 */
export async function requirePaidFeatures(req, res, next) {
  try {
    if (isBillingExempt(req.user)) {
      return next();
    }

    const quota = await getQuotaForUser(req.user.id);
    if (quota.exempt) return next();

    if ((quota.available_to_send || 0) > 0) {
      return next();
    }

    // 403 + a machine-readable code and the numbers the upgrade dialog needs to
    // explain the block without a second round-trip.
    return res.status(403).json({
      error:
        'You have no credits available. Buy a credit pack or wait for your free daily reset to use AI writing and insights.',
      code: 'PAID_FEATURE_REQUIRED',
      quota: {
        available_to_send: quota.available_to_send,
        email_credits: quota.email_credits,
        free_remaining: quota.free_remaining,
        free_daily_limit: quota.free_daily_limit,
        reserved_credits: quota.reserved_credits,
      },
    });
  } catch (err) {
    next(err);
  }
}
