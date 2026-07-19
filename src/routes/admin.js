import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  getAdminOverview,
  getUserDetail,
  listUsers,
  updateUser,
  listCampaigns,
  listActivity,
  getSystemHealth,
  getPlatformEmailChart,
} from '../services/adminService.js';
import {
  grantCredits,
  grantFreeCredits,
  revokeCredits,
  resolvePackCredits,
  listCreditTransactions,
} from '../services/quotaService.js';
import { listAuditLogs } from '../services/auditLogService.js';
import mongoose from 'mongoose';
import { getBillingAnalytics, reconcileUserCredits } from '../services/billingAnalyticsService.js';
import { listOutbox, getOutboxStats, retryEmail } from '../services/mailer/outbox.js';
import { MAX_GRANT_CREDITS } from '../config/billingConfig.js';
const router = Router();

router.use(requireAuth, requireAdmin);

router.get('/overview', async (_req, res, next) => {
  try {
    const overview = await getAdminOverview();
    res.json(overview);
  } catch (err) {
    next(err);
  }
});

router.get('/health', async (_req, res, next) => {
  try {
    const health = await getSystemHealth();
    res.json(health);
  } catch (err) {
    next(err);
  }
});

router.get('/emails-chart', async (req, res, next) => {
  try {
    const chart = await getPlatformEmailChart(req.query.days);
    res.json(chart);
  } catch (err) {
    next(err);
  }
});

router.get('/campaigns', async (req, res, next) => {
  try {
    const result = await listCampaigns({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      status: req.query.status,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/activity', async (req, res, next) => {
  try {
    const result = await listActivity({
      page: req.query.page,
      limit: req.query.limit,
      level: req.query.level,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/users', async (req, res, next) => {
  try {
    const result = await listUsers({
      page: req.query.page,
      limit: req.query.limit,
      search: req.query.search,
      role: req.query.role,
      status: req.query.status,
      credits: req.query.credits,
      forExport: req.query.export === '1',
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/users/:id', async (req, res, next) => {
  try {
    const user = await getUserDetail(req.params.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (err) {
    next(err);
  }
});

router.patch('/users/:id', async (req, res, next) => {
  try {
    const { role, is_active: isActive } = req.body || {};
    const updates = {};

    if (role !== undefined) {
      if (!['user', 'admin'].includes(role)) {
        return res.status(400).json({ error: 'Role must be user or admin' });
      }
      updates.role = role;
    }

    if (isActive !== undefined) {
      updates.is_active = Boolean(isActive);
    }

    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const user = await updateUser(req.params.id, updates, req.user);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (err) {
    if (err.message?.includes('cannot')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.post('/users/:id/grant-credits', async (req, res, next) => {
  try {
    const { pack_id: packId, amount, payment_ref: paymentRef, note } = req.body || {};
    let credits = parseInt(amount, 10);
    let packLabel = null;

    if (packId) {
      const pack = resolvePackCredits(packId);
      if (!pack) {
        return res.status(400).json({ error: 'Invalid credit pack' });
      }
      credits = pack.credits;
      packLabel = pack.label;
    }

    if (!Number.isFinite(credits) || credits <= 0) {
      return res.status(400).json({ error: 'Provide a valid pack_id or positive credit amount' });
    }

    // A grant was previously unbounded while the *free* grant was capped at
    // 100k. An extra zero here is only reversible through the refund path, so
    // cap it and make the admin be explicit about very large corrections.
    if (credits > MAX_GRANT_CREDITS) {
      return res.status(400).json({
        error: `A single grant cannot exceed ${MAX_GRANT_CREDITS.toLocaleString('en-IN')} credits. Split it or raise MAX_GRANT_CREDITS.`,
      });
    }

    // Required, not optional: without a reference there is no key to dedupe on,
    // so a double-submitted grant credits the same payment twice.
    if (!paymentRef?.trim()) {
      return res.status(400).json({
        error: 'A payment reference is required (e.g. the UPI / bank transaction id) so the same payment cannot be credited twice.',
      });
    }

    const result = await grantCredits(req.params.id, credits, req.user.id, {
      payment_ref: paymentRef.trim(),
      pack_label: packLabel,
      note: note?.trim() || null,
      adminName: req.user.name,
      adminEmail: req.user.email,
    });

    if (!result) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: result.confirmation_email_sent
        ? `Granted ${credits} email credits — confirmation email sent to the user`
        : `Granted ${credits} email credits`,
      ...result,
    });
  } catch (err) {
    if (err.message?.includes('already granted') || err.message?.includes('must be')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.post('/users/:id/grant-free-credits', async (req, res, next) => {
  try {
    const { amount, reason, request_id: requestId } = req.body || {};
    const credits = parseInt(amount, 10);

    if (!Number.isFinite(credits) || credits <= 0) {
      return res.status(400).json({ error: 'Provide a positive credit amount to grant' });
    }
    if (credits > 100000) {
      return res.status(400).json({ error: 'Free credit grants are capped at 100,000 per request' });
    }
    // Client-generated per-submission id. Replaying the same POST (double click,
    // proxy retry) reuses the id and is rejected by the ledger's unique index
    // rather than granting a second time.
    if (!String(requestId || '').trim()) {
      return res.status(400).json({ error: 'Missing request_id — reload the admin page and try again.' });
    }

    const result = await grantFreeCredits(req.params.id, credits, req.user.id, {
      reason: reason?.trim() || null,
      request_id: String(requestId).trim().slice(0, 100),
      adminName: req.user.name,
      adminEmail: req.user.email,
    });

    if (!result) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: result.confirmation_email_sent
        ? `Granted ${credits} free credits — confirmation email sent to the user`
        : `Granted ${credits} free credits`,
      ...result,
    });
  } catch (err) {
    if (err.message?.includes('must be') || err.message?.includes('already granted') || err.message?.includes('required')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.get('/audit-log', async (req, res, next) => {
  try {
    const result = await listAuditLogs({
      page: req.query.page,
      limit: req.query.limit,
      action: req.query.action,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/users/:id/revoke-credits', async (req, res, next) => {
  try {
    const {
      amount,
      note,
      reversal_ref: reversalRef,
      reverses_payment_ref: reversesPaymentRef,
    } = req.body || {};
    const credits = parseInt(amount, 10);

    if (!Number.isFinite(credits) || credits <= 0) {
      return res.status(400).json({ error: 'Provide a positive credit amount to revoke' });
    }

    // Same reasoning as the grant path: without a key, a double-submitted
    // refund deducts twice and there is no way to tell the two apart.
    if (!reversalRef?.trim()) {
      return res.status(400).json({
        error: 'A reversal reference is required (e.g. the refund transaction id) so the same refund cannot be applied twice.',
      });
    }

    const result = await revokeCredits(req.params.id, credits, req.user.id, {
      note: note?.trim() || null,
      reversal_ref: reversalRef.trim(),
      reverses_payment_ref: reversesPaymentRef?.trim() || null,
      adminName: req.user.name,
      adminEmail: req.user.email,
    });

    if (!result) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: result.is_refund
        ? `Refunded ${result.credits_revoked} credits and released the original payment reference for re-use`
        : `Revoked ${result.credits_revoked} email credits`,
      ...result,
    });
  } catch (err) {
    if (
      err.message?.includes('must be') ||
      err.message?.includes('No revocable') ||
      err.message?.includes('can be removed') ||
      err.message?.includes('already granted') ||
      err.message?.includes('Balance changed') ||
      err.message?.includes('reversal reference')
    ) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.get('/users/:id/credit-transactions', async (req, res, next) => {
  try {
    const transactions = await listCreditTransactions(req.params.id, { limit: req.query.limit });
    res.json({ data: transactions });
  } catch (err) {
    next(err);
  }
});

/**
 * Transactional email delivery log. Until now a failed receipt or verification
 * left only a stderr line, so "did the customer get their email?" was
 * unanswerable after the fact.
 */
router.get('/emails', async (req, res, next) => {
  try {
    res.json(
      await listOutbox({
        status: req.query.status,
        type: req.query.type,
        search: req.query.search,
        page: req.query.page,
        limit: req.query.limit,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.get('/emails/stats', async (req, res, next) => {
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours || '24', 10) || 24, 1), 720);
    res.json(await getOutboxStats({ hours }));
  } catch (err) {
    next(err);
  }
});

// Re-send a failed or dead email immediately, rather than waiting for the sweep.
router.post('/emails/:id/retry', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Email not found' });
    }
    const result = await retryEmail(req.params.id);
    if (!result) {
      return res.status(404).json({ error: 'Email not found, or it is not in a retryable state' });
    }
    res.json({
      message: result.sent ? 'Email sent' : `Retry failed: ${result.error || 'unknown error'}`,
      ...result,
    });
  } catch (err) {
    next(err);
  }
});

// Revenue, consumption, and reservation-health metrics over a window.
router.get('/billing/analytics', async (req, res, next) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days || '30', 10) || 30, 1), 365);
    res.json(await getBillingAnalytics({ days }));
  } catch (err) {
    next(err);
  }
});

/**
 * Force a reservation re-check for one user. The background reconciler only
 * runs every 30 minutes, which is a long time to stare at a balance that looks
 * wrong while a customer waits on support.
 */
router.post('/users/:id/reconcile-credits', async (req, res, next) => {
  try {
    const result = await reconcileUserCredits(req.params.id, {
      adminId: req.user.id,
      adminName: req.user.name,
      adminEmail: req.user.email,
    });
    if (!result) return res.status(404).json({ error: 'User not found' });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
