import { Router } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import User from '../models/User.js';
import RefreshToken from '../models/RefreshToken.js';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter, loginLimiter, forgotPasswordLimiter, resendVerifyLimiter } from '../middleware/security.js';
import { resolveUserRole, getAdminEmails } from '../utils/adminAccess.js';
import { getQuotaForUser } from '../services/quotaService.js';
import { validatePassword } from '../utils/passwordValidation.js';
import { isValidEmail } from '../utils/contactParser.js';
import { tokensMatch } from '../utils/tokenUtils.js';
import {
  sendPasswordResetEmail,
  sendVerificationEmail,
  sendWelcomeEmail,
  sendEmailConfirmedEmail,
  sendPasswordChangedEmail,
  notifyAdminsOfSignup,
} from '../services/mailer/emails.js';
import { isMailConfigured } from '../services/mailer/transport.js';
import {
  issueSession,
  rotateSession,
  revokeSession,
  revokeAllSessions,
  listSessions,
  SessionError,
} from '../services/sessionService.js';
import { logAuthEvent } from '../services/authEventService.js';

const router = Router();

const RESET_SENT_MESSAGE =
  'If an account exists for that email, password reset instructions have been sent.';

// A real bcrypt digest of a value nobody holds. Compared against on the
// user-not-found path so a miss costs the same ~250ms as a hit — otherwise the
// response time tells an attacker which addresses are registered.
const DUMMY_HASH = '$2a$12$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

// Minimum gap between password-reset emails for one account. The IP limiter
// alone lets a rotating-IP attacker mail-bomb a single victim.
const RESET_COOLDOWN_MS = 2 * 60 * 1000;
const VERIFY_COOLDOWN_MS = 60 * 1000;

/**
 * Allowlist, not denylist. The previous implementation spread the whole Mongoose
 * doc and deleted three fields, so any new sensitive column would have been
 * exposed by default — including the bcrypt hash on the register response.
 */
function publicUser(user, { quota = undefined } = {}) {
  const out = {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: resolveUserRole(user),
    is_active: user.is_active !== false,
    email_verified: Boolean(user.email_verified),
    has_paid_access: Boolean(user.has_paid_access),
    created_at: user.created_at,
  };
  if (quota !== undefined) out.quota = quota;
  return out;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function sessionPayload(session, user) {
  return {
    token: session.accessToken, // legacy field name kept so older clients keep working
    access_token: session.accessToken,
    refresh_token: session.refreshToken,
    expires_in: session.expiresIn,
    token_type: session.tokenType,
    user: publicUser(user),
  };
}

/**
 * Dispatch verification mail without blocking the response.
 *
 * The audit event is now recorded from the send result rather than fired
 * optimistically before it resolves — it previously logged "sent" for emails
 * that never left the process. Delivery itself is durable: the outbox persists
 * the row before attempting SMTP, so a failure here is retried rather than lost.
 */
function dispatchVerification(user, req) {
  user
    .issueEmailVerifyToken()
    .then((rawToken) => sendVerificationEmail(user, rawToken))
    .then((result) => {
      logAuthEvent({
        type: 'email_verify_sent',
        req,
        userId: user._id,
        email: user.email,
        detail: result.sent ? 'delivered' : `queued for retry: ${result.error || 'unknown'}`,
      });
    })
    .catch((err) => console.error('[auth] verification dispatch failed:', err?.message));
}

router.post('/register', authLimiter, async (req, res, next) => {
  try {
    const { name, email, password, confirmPassword } = req.body || {};
    const cleanEmail = normalizeEmail(email);

    if (!name?.trim() || !cleanEmail || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (name.trim().length > 100) {
      return res.status(400).json({ error: 'Name must be 100 characters or fewer' });
    }
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ error: 'Enter a valid email address' });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    const passwordCheck = validatePassword(password, { email: cleanEmail, name });
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.errors[0], errors: passwordCheck.errors });
    }

    // ADMIN_EMAILS is a break-glass list resolved live on every request, so an
    // address on it is an admin the moment an account exists for it — and
    // nothing stopped a stranger from registering one that had not been claimed
    // yet. That is full /api/admin access (user list, credit grants, role
    // changes) for anyone who guesses or reads a leaked env value; .env.example
    // ships admin@example.com, so any deploy that copied it and never created
    // that account was directly exploitable. Admin accounts must be created
    // deliberately and then listed, never claimed through public signup.
    if (getAdminEmails().includes(cleanEmail)) {
      logAuthEvent({ type: 'register_blocked_admin_email', req, email: cleanEmail });
      // Same response shape as the duplicate-address path — do not confirm that
      // this address is special.
      return res.status(409).json({
        error: 'That email cannot be used to register. If you already have an account, sign in or reset your password.',
        code: 'REGISTRATION_REJECTED',
      });
    }

    const user = await User.create({
      name: name.trim(),
      email: cleanEmail,
      password,
    });

    dispatchVerification(user, req);
    // Welcome + admin alert are queued through the outbox, so neither blocks the
    // 201 nor can fail registration.
    sendWelcomeEmail(user).catch((err) => console.error('[auth] welcome email failed:', err?.message));
    notifyAdminsOfSignup(user).catch((err) => console.error('[auth] admin signup alert failed:', err?.message));
    logAuthEvent({ type: 'register', req, userId: user._id, email: user.email });

    const session = await issueSession(user, req);
    res.status(201).json(sessionPayload(session, user));
  } catch (err) {
    if (err.code === 11000) {
      // Deliberately the same shape as a validation failure. Confirming that an
      // address is taken is a free user-enumeration oracle, so point the caller
      // at sign-in / reset instead of admitting the account exists.
      return res.status(409).json({
        error: 'That email cannot be used to register. If you already have an account, sign in or reset your password.',
        code: 'REGISTRATION_REJECTED',
      });
    }
    next(err);
  }
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    const cleanEmail = normalizeEmail(email);

    if (!cleanEmail || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await User.findOne({ email: cleanEmail }).select(
      '+password +failed_login_count +lockout_until'
    );

    if (!user) {
      // Burn equivalent CPU so the miss path is indistinguishable from a wrong
      // password. Without this, response latency enumerates the user table.
      await bcrypt.compare(String(password), DUMMY_HASH);
      logAuthEvent({ type: 'login_failed', req, email: cleanEmail, detail: 'no such account' });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.isLockedOut()) {
      // Deliberately identical to the wrong-password response below.
      //
      // A nonexistent address can never lock out (that path returns earlier), so
      // a distinct 429 ACCOUNT_LOCKED answered "does this account exist?" for
      // free: eight junk attempts, and the ninth response told you. The lockout
      // is still enforced — it is just no longer observable from outside. The
      // event log is where an operator sees it.
      logAuthEvent({ type: 'login_locked', req, userId: user._id, email: user.email });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!(await user.comparePassword(password))) {
      const lockedUntil = await user.registerFailedLogin();
      logAuthEvent({
        type: lockedUntil ? 'login_locked' : 'login_failed',
        req,
        userId: user._id,
        email: user.email,
        detail: lockedUntil ? 'lockout triggered' : 'bad password',
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.is_active === false) {
      return res.status(403).json({ error: 'Account disabled. Contact support.', code: 'ACCOUNT_DISABLED' });
    }

    await user.registerSuccessfulLogin();
    logAuthEvent({ type: 'login_success', req, userId: user._id, email: user.email });

    const session = await issueSession(user, req);
    res.json(sessionPayload(session, user));
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', async (req, res, next) => {
  try {
    const rawToken = req.body?.refresh_token;
    const { user, ...session } = await rotateSession(rawToken, req);
    res.json(sessionPayload(session, user));
  } catch (err) {
    if (err instanceof SessionError) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    await revokeSession(req.body?.refresh_token);
    logAuthEvent({ type: 'logout', req });
    // Always 200 — a client signing out must never be left believing it is
    // still signed in because its token had already expired.
    res.json({ message: 'Signed out' });
  } catch (err) {
    next(err);
  }
});

router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await revokeAllSessions(req.user.id, 'logout_all');
    logAuthEvent({ type: 'logout_all', req, userId: req.user.id, email: req.user.email });
    res.json({ message: 'Signed out on all devices' });
  } catch (err) {
    next(err);
  }
});

router.get('/sessions', requireAuth, async (req, res, next) => {
  try {
    res.json({ sessions: await listSessions(req.user.id) });
  } catch (err) {
    next(err);
  }
});

router.delete('/sessions/:id', requireAuth, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Session not found' });
    }
    const result = await RefreshToken.updateOne(
      { _id: req.params.id, user_id: req.user.id, revoked_at: null },
      { $set: { revoked_at: new Date(), revoked_reason: 'revoked_by_user' } }
    );
    if (!result.matchedCount) return res.status(404).json({ error: 'Session not found' });
    res.json({ message: 'Session revoked' });
  } catch (err) {
    next(err);
  }
});

router.post('/verify-email', authLimiter, async (req, res, next) => {
  try {
    const rawToken = String(req.body?.token || '').trim();
    if (!rawToken) {
      return res.status(400).json({ error: 'Verification token is required' });
    }

    const user = await User.findByVerifyToken(rawToken);
    if (!user) {
      return res.status(400).json({
        error: 'Invalid or expired verification link. Request a new one.',
        code: 'VERIFY_TOKEN_INVALID',
      });
    }

    // Re-clicking the link from an email after it already worked should read as
    // success, not an error.
    if (user.email_verified) {
      return res.json({ message: 'Email already confirmed', already_verified: true });
    }

    const result = await user.confirmEmailVerification(rawToken);
    if (!result.ok) {
      return res.status(400).json({ error: result.error, code: 'VERIFY_TOKEN_INVALID' });
    }

    logAuthEvent({ type: 'email_verify_completed', req, userId: user._id, email: user.email });
    sendEmailConfirmedEmail(user).catch((err) =>
      console.error('[auth] confirmation email failed:', err?.message)
    );
    res.json({ message: 'Email confirmed. Sending is now unlocked.', verified: true });
  } catch (err) {
    next(err);
  }
});

router.post('/resend-verification', requireAuth, resendVerifyLimiter, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id).select('+verify_sent_at');
    if (!user) return res.status(401).json({ error: 'Invalid or expired token' });

    if (user.email_verified) {
      return res.json({ message: 'Email already confirmed', already_verified: true });
    }
    if (!isMailConfigured()) {
      return res.status(503).json({ error: 'Email delivery is not configured. Contact support.' });
    }
    if (user.verify_sent_at && Date.now() - user.verify_sent_at.getTime() < VERIFY_COOLDOWN_MS) {
      return res.status(429).json({
        error: 'A confirmation email was just sent. Check your inbox, then try again in a minute.',
        code: 'VERIFY_COOLDOWN',
      });
    }

    dispatchVerification(user, req);
    res.json({ message: 'Confirmation email sent. Check your inbox.' });
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

    const user = await User.findOne({ email }).select('+reset_sent_at');

    // Respond identically and immediately in every case. The previous version
    // did the SMTP round-trip inline, so a hit took seconds and a miss returned
    // instantly — a louder enumeration signal than the 404 it was avoiding.
    res.json({ message: RESET_SENT_MESSAGE });

    if (!user || user.is_active === false) return;
    if (user.reset_sent_at && Date.now() - user.reset_sent_at.getTime() < RESET_COOLDOWN_MS) return;

    logAuthEvent({ type: 'password_reset_requested', req, userId: user._id, email: user.email });

    try {
      const rawToken = await user.issuePasswordResetToken();
      const result = await sendPasswordResetEmail(user, rawToken);
      if (!result.sent) {
        console.error('[auth] password reset email not sent:', result.error);
        await user.clearPasswordResetToken();
      }
    } catch (err) {
      console.error('[auth] password reset dispatch failed:', err?.message);
    }
  } catch (err) {
    next(err);
  }
});

router.get('/reset-password/verify', authLimiter, async (req, res, next) => {
  try {
    const rawToken = String(req.query.token || '').trim();
    if (!rawToken) {
      return res.status(400).json({ valid: false, error: 'Reset token is required' });
    }

    const user = await User.findByResetToken(rawToken);
    if (!user) {
      return res.status(400).json({ valid: false, error: 'Invalid or expired reset link' });
    }

    // Deliberately does not echo the email — a leaked reset URL should not also
    // disclose which account it belongs to.
    res.json({ valid: true });
  } catch (err) {
    next(err);
  }
});

router.post('/reset-password', authLimiter, async (req, res, next) => {
  try {
    const { token, password, confirmPassword } = req.body || {};
    const rawToken = String(token || '').trim();

    if (!rawToken || !password) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    const user = await User.findByResetToken(rawToken);
    if (!user || !tokensMatch(rawToken, user.reset_token_hash)) {
      return res.status(400).json({
        error: 'Invalid or expired reset link. Please request a new one.',
        code: 'RESET_TOKEN_INVALID',
      });
    }

    const passwordCheck = validatePassword(password, { email: user.email, name: user.name });
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.errors[0], errors: passwordCheck.errors });
    }

    user.password = password; // pre-save hook bumps token_version + password_changed_at
    user.reset_token_hash = null;
    user.reset_token_expires = null;
    // Clear the lockout too. The lockout message tells the user to "reset your
    // password", and without this that advice was a dead end: they completed the
    // reset and were still refused for the rest of the lockout window. It also
    // let an attacker hold a known account locked indefinitely, 8 bad passwords
    // at a time, with the victim having no way out.
    user.failed_login_count = 0;
    user.lockout_until = null;
    await user.save();

    // Anyone resetting a password may be locking an attacker out, so every
    // existing session dies with it.
    await revokeAllSessions(user._id, 'password_reset');
    logAuthEvent({ type: 'password_reset_completed', req, userId: user._id, email: user.email });
    // Security notice: if the reset was not the account owner, this is how they
    // find out while the attacker still only holds a dead session.
    sendPasswordChangedEmail(user, { reason: 'reset' }).catch((err) =>
      console.error('[auth] password-changed notice failed:', err?.message)
    );

    res.json({ message: 'Password updated. Sign in with your new password.' });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', authLimiter, requireAuth, async (req, res, next) => {
  try {
    const { currentPassword, password, confirmPassword } = req.body || {};

    if (!currentPassword || !password) {
      return res.status(400).json({ error: 'Current and new password are required' });
    }
    if (confirmPassword !== undefined && password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    const user = await User.findById(req.user.id).select('+password');
    if (!user) return res.status(401).json({ error: 'Invalid or expired token' });

    if (!(await user.comparePassword(currentPassword))) {
      logAuthEvent({ type: 'login_failed', req, userId: user._id, email: user.email, detail: 'change-password: wrong current' });
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const passwordCheck = validatePassword(password, { email: user.email, name: user.name });
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.errors[0], errors: passwordCheck.errors });
    }
    if (await user.comparePassword(password)) {
      return res.status(400).json({ error: 'New password must be different from the current one' });
    }

    user.password = password;
    await user.save();

    await revokeAllSessions(user._id, 'password_changed');
    logAuthEvent({ type: 'password_changed', req, userId: user._id, email: user.email });
    sendPasswordChangedEmail(user, { reason: 'changed' }).catch((err) =>
      console.error('[auth] password-changed notice failed:', err?.message)
    );

    // The caller's own token was just invalidated, so hand back a fresh session
    // rather than bouncing them to the login screen mid-flow.
    const refreshed = await User.findById(user._id);
    const session = await issueSession(refreshed, req);
    res.json({ message: 'Password updated on all devices', ...sessionPayload(session, refreshed) });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    const quota = await getQuotaForUser(req.user.id);
    res.json({ user: publicUser(user), quota });
  } catch (err) {
    next(err);
  }
});

export default router;
