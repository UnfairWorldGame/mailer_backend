import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getQuotaForUser } from '../services/quotaService.js';
import { CREDIT_PACKS } from '../config/billingConfig.js';

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

export default router;
