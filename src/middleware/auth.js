import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import { resolveUserRole } from '../utils/adminAccess.js';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET?.trim();
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  return secret;
}

export function signToken(userId) {
  return jwt.sign({ userId }, getJwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    let token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token && req.query?.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const payload = jwt.verify(token, getJwtSecret());
    const user = await User.findById(payload.userId).select('name email role is_active');

    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account disabled' });
    }

    req.user = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: resolveUserRole(user),
    };

    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    next(err);
  }
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}
