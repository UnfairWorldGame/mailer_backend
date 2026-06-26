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
  revokeCredits,
  resolvePackCredits,
  listCreditTransactions,
} from '../services/quotaService.js';
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

    const user = await updateUser(req.params.id, updates, req.user.id);
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

    const result = await grantCredits(req.params.id, credits, req.user.id, {
      payment_ref: paymentRef?.trim() || null,
      pack_label: packLabel,
      note: note?.trim() || null,
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

router.post('/users/:id/revoke-credits', async (req, res, next) => {
  try {
    const { amount, note } = req.body || {};
    const credits = parseInt(amount, 10);

    if (!Number.isFinite(credits) || credits <= 0) {
      return res.status(400).json({ error: 'Provide a positive credit amount to revoke' });
    }

    const result = await revokeCredits(req.params.id, credits, req.user.id, {
      note: note?.trim() || null,
    });

    if (!result) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      message: `Revoked ${result.credits_revoked} email credits`,
      ...result,
    });
  } catch (err) {
    if (err.message?.includes('must be') || err.message?.includes('No revocable')) {
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

export default router;
