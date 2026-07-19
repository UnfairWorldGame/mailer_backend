import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getQuotaForUser, listCreditTransactions } from '../services/quotaService.js';
import { CREDIT_PACKS, BILLING_CONTACT, BASE_RATE } from '../config/billingConfig.js';
import CreditPurchaseRequest from '../models/CreditPurchaseRequest.js';

const router = Router();

router.use(requireAuth);

router.get('/quota', async (req, res, next) => {
  try {
    const quota = await getQuotaForUser(req.user.id);
    res.json({
      ...quota,
      packs: Object.values(CREDIT_PACKS),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Everything the upgrade dialog needs in one call: current balance, the packs,
 * how to reach an admin (payment is arranged off-platform), and whether this
 * user already has a request in flight — so the dialog can say "we've got your
 * request" instead of inviting a duplicate.
 */
router.get('/upgrade-context', async (req, res, next) => {
  try {
    const quota = await getQuotaForUser(req.user.id);
    const pending = await CreditPurchaseRequest.findOne({
      email: req.user.email,
      status: 'pending',
    })
      .sort({ created_at: -1 })
      .lean();

    res.json({
      quota,
      packs: Object.values(CREDIT_PACKS),
      base_rate: BASE_RATE,
      contact: BILLING_CONTACT,
      pending_request: pending
        ? {
            id: pending._id.toString(),
            pack_label: pending.pack_label || null,
            credits: pending.credits || null,
            created_at: pending.created_at,
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * A user's own credit history. Money here moves by manual bank transfer, so
 * without this they have no way to check what they were charged — the ledger
 * was admin-only.
 */
router.get('/transactions', async (req, res, next) => {
  try {
    const transactions = await listCreditTransactions(req.user.id, { limit: req.query.limit });
    res.json({ data: transactions });
  } catch (err) {
    next(err);
  }
});

export default router;
