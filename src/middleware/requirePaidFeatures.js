import User from '../models/User.js';
import { isAdminUser } from '../utils/adminAccess.js';

export async function requirePaidFeatures(req, res, next) {
  try {
    if (isAdminUser(req.user)) {
      return next();
    }

    const user = await User.findById(req.user.id).select('has_paid_access');
    if (!user?.has_paid_access) {
      return res.status(403).json({
        error: 'This feature requires paid credits. Buy a credit pack to unlock AI writing and insights.',
        code: 'PAID_FEATURE_REQUIRED',
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}
