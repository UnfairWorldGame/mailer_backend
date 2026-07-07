import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import User from '../models/User.js';
import { requireAuth, signToken } from '../middleware/auth.js';
import { toApiDoc } from '../utils/apiTransform.js';
import { resolveUserRole } from '../utils/adminAccess.js';
import { getQuotaForUser } from '../services/quotaService.js';
import { validatePassword } from '../utils/passwordValidation.js';
import { isValidEmail } from '../utils/contactParser.js';
import {
  applyPasswordReset,
  hashResetToken,
  sendPasswordResetEmail,
} from '../services/passwordResetService.js';

const router = Router();

const RESET_SENT_MESSAGE =
  'If an account exists for that email, password reset instructions have been sent.';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AUTH_RATE_LIMIT_MAX || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.FORGOT_PASSWORD_RATE_LIMIT_MAX || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many reset requests. Please try again in an hour.' },
});

router.use(authLimiter);

function publicUser(user) {
  const api = toApiDoc(user);
  delete api.password;
  delete api.reset_token_hash;
  delete api.reset_token_expires;
  api.role = resolveUserRole(user);
  return api;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, confirmPassword } = req.body || {};

    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }

    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.errors[0] });
    }

    const user = await User.create({
      name: name.trim(),
      email: normalizeEmail(email),
      password,
    });

    const token = signToken(user._id);

    res.status(201).json({
      token,
      user: publicUser(user),
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    next(err);
  }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body || {};

    if (!email?.trim() || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email: normalizeEmail(email) }).select('+password');
    if (!user || !(await user.comparePassword(password))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account disabled. Contact support.' });
    }

    const token = signToken(user._id);
    user.password = undefined;

    res.json({
      token,
      user: publicUser(user),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/forgot-password', forgotPasswordLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await User.findOne({ email });

    // Always return the same generic response regardless of whether the account
    // exists or is active — otherwise the endpoint leaks which emails are
    // registered (account enumeration). Do the real work only when eligible.
    if (!user || user.is_active === false) {
      return res.json({ message: RESET_SENT_MESSAGE });
    }

    const rawToken = await user.issuePasswordResetToken();
    const result = await sendPasswordResetEmail(user, rawToken);

    if (result.sent) {
      return res.json({ message: RESET_SENT_MESSAGE });
    }

    // Delivery failed — surface the dev link locally to keep DX, but never
    // reveal account existence or SMTP internals in production.
    if (process.env.NODE_ENV !== 'production' && result.devLink) {
      return res.json({
        message: RESET_SENT_MESSAGE,
        dev_reset_url: result.devLink,
      });
    }

    await user.clearPasswordResetToken();

    if (process.env.NODE_ENV !== 'production') {
      return res.status(503).json({
        error:
          result.error ||
          'Could not send reset email. Set PASSWORD_RESET_SMTP_EMAIL and PASSWORD_RESET_SMTP_APP_PASSWORD in backend/.env.',
      });
    }

    console.error(`[password-reset] Email delivery failed for ${user.email}:`, result.error);
    return res.json({ message: RESET_SENT_MESSAGE });
  } catch (err) {
    next(err);
  }
});

router.get('/reset-password/verify', async (req, res, next) => {
  try {
    const rawToken = String(req.query.token || '').trim();
    if (!rawToken) {
      return res.status(400).json({ valid: false, error: 'Reset token is required' });
    }

    const user = await User.findOne({
      reset_token_hash: hashResetToken(rawToken),
      reset_token_expires: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ valid: false, error: 'Invalid or expired reset link' });
    }

    res.json({ valid: true, email: user.email });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', async (req, res, next) => {
  try {
    const { token, password, confirmPassword } = req.body || {};
    const rawToken = String(token || '').trim();

    if (!rawToken || !password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.errors[0] });
    }

    const user = await User.findByResetToken(rawToken);
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset link. Please request a new one.' });
    }

    const result = await applyPasswordReset(user, rawToken, password);
    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    res.json({ message: 'Password updated successfully. You can sign in now.' });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('name email role is_active created_at has_paid_access');
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const quota = await getQuotaForUser(req.user.id);

    res.json({
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: resolveUserRole(user),
        is_active: user.is_active !== false,
        created_at: user.created_at,
        has_paid_access: Boolean(user.has_paid_access),
      },
      quota,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
