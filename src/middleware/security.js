import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { MongoRateLimitStore } from './mongoRateLimitStore.js';

// Rate limiting used to be skipped whenever NODE_ENV !== 'production', which is
// a fail-open default: any deploy that lost the env var silently ran unlimited.
// Now limits are always on, and disabling them takes a deliberate opt-in.
const LIMITS_DISABLED = process.env.RATE_LIMIT_DISABLED === '1';

function num(name, fallback) {
  return parseInt(process.env[name] || String(fallback), 10);
}

function normalizeEmailKey(value) {
  return String(value || '').trim().toLowerCase().slice(0, 200);
}

function makeLimiter({ prefix, windowMs, max, message, keyGenerator, skipSuccessfulRequests }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => LIMITS_DISABLED,
    store: new MongoRateLimitStore({ prefix }),
    keyGenerator,
    skipSuccessfulRequests,
    message: { error: message },
    // The store is shared, so a per-key handler is the right place to log abuse.
    handler: (req, res, _next, options) => {
      res.status(options.statusCode).json({ error: message, code: 'RATE_LIMITED' });
    },
  });
}

/** General auth surface: register, verify, reset. Keyed per IP. */
export const authLimiter = makeLimiter({
  prefix: 'auth',
  windowMs: 15 * 60 * 1000,
  max: num('AUTH_RATE_LIMIT_MAX', 20),
  message: 'Too many attempts. Please try again in a few minutes.',
});

/**
 * Login is keyed on IP *and* submitted email. IP-only lets distributed
 * credential stuffing hammer one account from many addresses; email-only lets
 * one host spray many accounts. Successful logins do not count against it, so a
 * legitimate user is never locked out by their own activity.
 */
export const loginLimiter = makeLimiter({
  prefix: 'login',
  windowMs: 15 * 60 * 1000,
  max: num('LOGIN_RATE_LIMIT_MAX', 10),
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${req.ip}|${normalizeEmailKey(req.body?.email)}`,
  message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
});

/** Password reset requests, keyed per IP and per target address. */
export const forgotPasswordLimiter = makeLimiter({
  prefix: 'forgot',
  windowMs: 60 * 60 * 1000,
  max: num('FORGOT_PASSWORD_RATE_LIMIT_MAX', 5),
  keyGenerator: (req) => `${req.ip}|${normalizeEmailKey(req.body?.email)}`,
  message: 'Too many reset requests. Please try again in an hour.',
});

/** Verification resends, keyed per authenticated user where available. */
export const resendVerifyLimiter = makeLimiter({
  prefix: 'resend',
  windowMs: 60 * 60 * 1000,
  max: num('RESEND_VERIFY_RATE_LIMIT_MAX', 5),
  keyGenerator: (req) => String(req.user?.id || req.ip),
  message: 'Too many confirmation emails requested. Please try again later.',
});

export function applySecurity(app) {
  app.use(
    helmet({
      // Relaxed only for the routes that stream attachments/certificates to the
      // frontend origin; applied per-route below rather than globally.
      crossOriginResourcePolicy: false,
    })
  );

  // File-serving routes are the only ones that need a cross-origin CORP header.
  const crossOriginFiles = helmet.crossOriginResourcePolicy({ policy: 'cross-origin' });
  app.use('/api/campaigns', crossOriginFiles);
  app.use('/api/certificates', crossOriginFiles);

  // Broad backstop. Memory-backed on purpose: it exists to blunt runaway
  // clients, and a Mongo round-trip on every single API call is not worth it.
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: num('RATE_LIMIT_MAX', 2000),
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => LIMITS_DISABLED,
    message: { error: 'Too many requests. Please try again later.' },
  });
  app.use('/api/', limiter);

  // Only the actual uploads are budgeted. This limiter also covered reads such
  // as GET /uploads/contacts/count, which the composer calls on every page load
  // — 30/hour is a handful of normal page views, so browsing could exhaust the
  // upload budget. It went unnoticed because rate limiting was skipped in dev.
  const uploadLimiter = makeLimiter({
    prefix: 'upload',
    windowMs: 60 * 60 * 1000,
    max: num('UPLOAD_RATE_LIMIT_MAX', 30),
    message: 'Upload limit exceeded. Try again later.',
  });
  app.use('/api/uploads/', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    return uploadLimiter(req, res, next);
  });
}

export { LIMITS_DISABLED };
