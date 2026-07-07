import Notification from '../models/Notification.js';
import { ownerFilter } from '../utils/userScope.js';

export async function createNotification({ userId, type = 'system', title, message, data = {} }) {
  return Notification.create({ user_id: userId, type, title, message, data });
}

export async function listNotifications(userId, { page = 1, limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);

  const [rows, total, unread] = await Promise.all([
    Notification.find(ownerFilter(userId))
      .sort({ created_at: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    Notification.countDocuments(ownerFilter(userId)),
    Notification.countDocuments(ownerFilter(userId, { read: false })),
  ]);

  return {
    data: rows.map((n) => ({
      id: n._id.toString(),
      type: n.type,
      title: n.title,
      message: n.message,
      data: n.data,
      read: n.read,
      created_at: n.created_at,
    })),
    total,
    unread_count: unread,
    page: safePage,
    limit: safeLimit,
  };
}

export async function getUnreadCount(userId) {
  return Notification.countDocuments(ownerFilter(userId, { read: false }));
}

export async function markNotificationRead(userId, notificationId) {
  return Notification.findOneAndUpdate(
    ownerFilter(userId, { _id: notificationId }),
    { $set: { read: true, read_at: new Date() } },
    { new: true }
  );
}

export async function markAllNotificationsRead(userId) {
  const result = await Notification.updateMany(
    ownerFilter(userId, { read: false }),
    { $set: { read: true, read_at: new Date() } }
  );
  return result.modifiedCount;
}
