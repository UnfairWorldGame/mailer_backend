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
    // Clamped both ways: Math.min alone let ?days=abc through as NaN (which
    // becomes an Invalid Date in the $gte of an aggregate stage — mongoose does
    // not cast pipelines) and ?days=-3650 through as a window 10 years in the
    // future, returning an empty 200.
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 7, 1), 90);
    res.json(await getEmailTimeSeries(req.user.id, days));
  } catch (err) {
    next(err);
  }
});

export default router;
