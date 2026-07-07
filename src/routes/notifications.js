import { Router } from 'express';
import mongoose from 'mongoose';
import { requireAuth } from '../middleware/auth.js';
import {
  listNotifications,
  getUnreadCount,
  markNotificationRead,
  markAllNotificationsRead,
} from '../services/notificationService.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const result = await listNotifications(req.user.id, {
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/unread-count', async (req, res, next) => {
  try {
    const count = await getUnreadCount(req.user.id);
    res.json({ unread_count: count });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/read', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    const updated = await markNotificationRead(req.user.id, req.params.id);
    if (!updated) return res.status(404).json({ error: 'Notification not found' });
    res.json({ message: 'Marked as read' });
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', async (req, res, next) => {
  try {
    const count = await markAllNotificationsRead(req.user.id);
    res.json({ message: `Marked ${count} notification(s) as read`, updated: count });
  } catch (err) {
    next(err);
  }
});

export default router;
