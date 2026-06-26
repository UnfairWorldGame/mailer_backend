import { Router } from 'express';
import { getAnalyticsOverview, getEmailTimeSeries } from '../services/analyticsService.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePaidFeatures } from '../middleware/requirePaidFeatures.js';

const router = Router();
router.use(requireAuth);
router.use(requirePaidFeatures);

router.get('/overview', async (req, res, next) => {
  try {
    res.json(await getAnalyticsOverview(req.user.id));
  } catch (err) {
    next(err);
  }
});

router.get('/emails', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days || '7', 10), 90);
    res.json(await getEmailTimeSeries(req.user.id, days));
  } catch (err) {
    next(err);
  }
});

export default router;
