import { Router } from 'express';
import { getAnalyticsOverview, getEmailTimeSeries } from '../services/analyticsService.js';

const router = Router();

router.get('/overview', async (_req, res, next) => {
  try {
    res.json(await getAnalyticsOverview());
  } catch (err) {
    next(err);
  }
});

router.get('/emails', async (req, res, next) => {
  try {
    const days = Math.min(parseInt(req.query.days || '7', 10), 90);
    res.json(await getEmailTimeSeries(days));
  } catch (err) {
    next(err);
  }
});

export default router;
