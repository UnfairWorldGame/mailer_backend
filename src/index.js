// MUST be first: ESM hoists imports, so anything below this line has already
// had its module body evaluated by the time a dotenv.config() call in *this*
// file's body would run. See config/loadEnv.js.
import './config/loadEnv.js';

import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { connectDB } from './db/connect.js';
import { resumeInterruptedCampaigns, awaitActiveCampaigns } from './services/sendEngine.js';
import { applySecurity } from './middleware/security.js';
import { assertJwtSecret } from './middleware/auth.js';
import { verifyTransport, isMailConfigured } from './services/mailer/transport.js';
import { startOutboxSweeper, stopOutboxSweeper } from './services/mailer/sweeper.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { getAllowedOrigins, normalizeOrigin } from './config/origins.js';
import accountsRouter from './routes/accounts.js';
import uploadsRouter from './routes/uploads.js';
import campaignsRouter from './routes/campaigns.js';
import analyticsRouter from './routes/analytics.js';
import aiRouter from './routes/ai.js';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import inquiriesRouter from './routes/inquiries.js';
import billingRouter from './routes/billing.js';
import certificatesRouter from './routes/certificates.js';
import notificationsRouter from './routes/notifications.js';
import {
  resumeInterruptedCertificateJobs,
  awaitActiveCertificateJobs,
} from './services/certificateSendEngine.js';
import { startCertificateSweeper, stopCertificateSweeper } from './services/certificateSweeper.js';
import { startQuotaReconciler, stopQuotaReconciler } from './services/quotaReconciler.js';
import { beginShutdown, isShuttingDown } from './services/shutdown.js';
import { reportCredentialEncryptionStatus } from './utils/credentialCrypto.js';

const app = express();
const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const allowedOrigins = getAllowedOrigins();

app.set('trust proxy', 1);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(normalizeOrigin(origin))) {
      callback(null, true);
      return;
    }
    callback(new Error('Not allowed by CORS'));
  },
  // Auth is Bearer-token only — there are no cookies to send, and advertising
  // credential support on a permissive allowlist is needless surface.
  credentials: false,
}));

applySecurity(app);

// Auth endpoints accept nothing large. A tight cap here means a login attempt
// cannot make the server parse a 2 MB body before rejecting a 10-character
// password, which is otherwise a cheap amplification lever.
app.use('/api/auth', express.json({ limit: '32kb' }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (_req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = dbState === 1 ? 'connected' : dbState === 2 ? 'connecting' : 'disconnected';
  res.status(dbState === 1 ? 200 : 503).json({
    status: dbState === 1 ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    database: dbStatus,
    version: process.env.npm_package_version || '2.0.0',
  });
});

app.use('/api/auth', authRouter);
app.use('/api/inquiries', inquiriesRouter);
app.use('/api/billing', billingRouter);
app.use('/api/admin', adminRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/certificates', certificatesRouter);
app.use('/api/notifications', notificationsRouter);

app.use(notFoundHandler);
app.use(errorHandler);

// FRONTEND_URL is what populates the CORS allowlist. If it is missing in
// production the allowlist is empty, and because the CORS callback above admits
// requests with no Origin header, /api/health, curl and every uptime monitor
// still report a healthy service while 100% of browser traffic is rejected.
// That combination — green dashboard, totally broken app, no signal anywhere —
// is worth refusing to boot over.
function assertCorsConfigured() {
  if (process.env.NODE_ENV !== 'production') return;
  if (allowedOrigins.length) return;
  throw new Error(
    'FRONTEND_URL is not set, so the CORS allowlist is empty and every browser request would be ' +
    'rejected while health checks kept passing. Set FRONTEND_URL to your frontend origin ' +
    '(comma-separated for more than one) and redeploy.'
  );
}

// Recovery sweeps scan every interrupted campaign and job, which is unbounded
// work — a large interrupted campaign can take minutes. Running it before
// listen() delays the port long enough for a platform health check to fail the
// deploy, and an un-caught rejection here (a transient Atlas blip during a
// restart) exits the process into a crash loop. Both are avoided by starting it
// after the port is bound and never letting it reject.
function startRecoveryInBackground() {
  resumeInterruptedCampaigns().catch((err) =>
    console.error('Campaign recovery failed (service is still up):', err)
  );
  resumeInterruptedCertificateJobs().catch((err) =>
    console.error('Certificate job recovery failed (service is still up):', err)
  );
}

/**
 * Certificates and quota already have periodic sweepers; campaigns only ran
 * recovery at boot and on Mongo reconnect. A campaign left in `sending` with no
 * live worker — because a peer instance died, or a loop yielded to a lock that
 * was never released — sat there until this process happened to restart, showing
 * the user an active campaign stuck at 0%. Sweep on an interval instead.
 * resumeInterruptedCampaigns is safe to re-run: startCampaignSend dedupes
 * against activeJobs and the campaign lock keeps peers off each other's work.
 */
const CAMPAIGN_RECOVERY_INTERVAL_MS = Number.parseInt(
  process.env.CAMPAIGN_RECOVERY_INTERVAL_MS || '',
  10
) || 300000;

function startCampaignRecoverySweeper() {
  const timer = setInterval(() => {
    if (isShuttingDown()) return;
    resumeInterruptedCampaigns().catch((err) =>
      console.error('Periodic campaign recovery failed:', err.message)
    );
    // Certificate jobs need the same sweep. startCertificateSweeper only
    // expires abandoned `ready` jobs and purges terminal ones — nothing scans
    // `sending`, so a job whose workers died (peer instance lost, lock taken
    // over, resume race) sat at "sending, 0%" until this process restarted.
    resumeInterruptedCertificateJobs().catch((err) =>
      console.error('Periodic certificate job recovery failed:', err.message)
    );
  }, CAMPAIGN_RECOVERY_INTERVAL_MS);
  timer.unref?.();
  return timer;
}

// A wrong or revoked App Password on the auth mailbox silently breaks password
// reset and email verification for everyone, and nothing surfaces it until a
// user reports they never got the mail. Probe SMTP once at boot instead.
async function reportAuthMailerHealth() {
  if (!isMailConfigured()) {
    console.warn(
      '[auth-mail] PASSWORD_RESET_SMTP_EMAIL / PASSWORD_RESET_SMTP_APP_PASSWORD are unset — ' +
      'no transactional email will send. Queued mail will retry once configured.'
    );
    return;
  }
  const result = await verifyTransport();
  if (result.ok) {
    console.log(`[auth-mail] SMTP ready (sending as ${result.from})`);
  } else {
    console.error(`[auth-mail] SMTP check FAILED: ${result.error}`);
    console.error('[auth-mail] Password reset and verification emails will not be delivered.');
  }
}

async function start() {
  assertJwtSecret();
  assertCorsConfigured();
  await connectDB();

  mongoose.connection.on('reconnected', () => {
    if (isShuttingDown()) return;
    console.log('MongoDB reconnected — checking for interrupted campaigns');
    startRecoveryInBackground();
  });

  const server = app.listen(PORT, HOST, () => {
    console.log(`MAILIQ API running on http://${HOST}:${PORT}`);
    console.log(
      allowedOrigins.length
        ? `CORS origins: ${allowedOrigins.join(', ')}`
        : 'CORS origins: NONE — FRONTEND_URL is unset, browser requests will be rejected'
    );
    startCertificateSweeper();
    startQuotaReconciler();
    startOutboxSweeper();
    startRecoveryInBackground();
    startCampaignRecoverySweeper();
    reportAuthMailerHealth().catch(() => {});
    reportCredentialEncryptionStatus();
  });

  // `node --watch` restarts by spawning the replacement before the outgoing
  // process has released the socket, so a save can produce a transient
  // EADDRINUSE. Exiting on that killed the whole watch session — the dev server
  // stayed down, and the only signal was one buried log line while the browser
  // sat in a reconnect loop polling /api/health every 2.5s.
  //
  // Retry briefly in development. Production still fails fast and loudly: a
  // deploy landing on an occupied port is a real problem that must not be
  // papered over by a process that quietly waits.
  const isProduction = process.env.NODE_ENV === 'production';
  const MAX_BIND_RETRIES = isProduction ? 0 : 5;
  const BIND_RETRY_DELAY_MS = 400;
  let bindRetries = 0;

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && bindRetries < MAX_BIND_RETRIES) {
      bindRetries += 1;
      console.warn(
        `Port ${PORT} busy (likely the previous watch process still closing) — ` +
        `retry ${bindRetries}/${MAX_BIND_RETRIES} in ${BIND_RETRY_DELAY_MS}ms`
      );
      setTimeout(() => {
        server.close();
        server.listen(PORT, HOST);
      }, BIND_RETRY_DELAY_MS);
      return;
    }

    if (err.code === 'EADDRINUSE') {
      // Exhausting the retries means the port is held by a real, long-lived
      // process — not a watch restart mid-close. That is usually an orphaned
      // dev server from an earlier run, and finding it is fiddly enough that
      // the command is worth printing rather than described.
      const findCmd = process.platform === 'win32'
        ? `netstat -ano | findstr :${PORT}    then    taskkill /PID <pid> /F`
        : `lsof -ti :${PORT} | xargs kill -9`;
      console.error(
        `Port ${PORT} is still in use after ${MAX_BIND_RETRIES} retries.\n` +
        `  Another server is already running on it — most likely an orphaned dev process.\n` +
        `  Find and stop it:  ${findCmd}\n` +
        '  Or set a different PORT in backend/.env'
      );
    } else {
      console.error('Server error:', err);
    }
    process.exit(1);
  });

  return server;
}

// Platforms recycle instances constantly (deploys, restarts, scale-down) and
// signal it with SIGTERM. Without a handler the process dies mid-iteration,
// stranding claimed recipients and a held campaign lock for minutes. Draining
// lets the engines finish the send in flight, release their locks, and leave
// every campaign cleanly resumable by the next instance.
const SHUTDOWN_GRACE_MS = parseInt(process.env.SHUTDOWN_GRACE_MS || '20000', 10);

function installLifecycleHandlers(server) {
  let closing = false;

  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`${signal} received — draining in-flight sends (up to ${SHUTDOWN_GRACE_MS}ms)`);

    beginShutdown();
    stopCertificateSweeper();
    stopOutboxSweeper();
    stopQuotaReconciler();
    server.close(() => console.log('HTTP server closed'));

    const [campaigns, certificates] = await Promise.all([
      awaitActiveCampaigns(SHUTDOWN_GRACE_MS),
      awaitActiveCertificateJobs(SHUTDOWN_GRACE_MS),
    ]);
    if (!campaigns || !certificates) {
      console.warn('Grace period elapsed with work still in flight — it will be recovered on next boot');
    }

    await mongoose.disconnect().catch(() => {});
    console.log('Shutdown complete');
    process.exit(0);
  };

  process.on('SIGTERM', () => { shutdown('SIGTERM'); });
  process.on('SIGINT', () => { shutdown('SIGINT'); });

  // The send engines are fire-and-forget: their promises live in a Map that
  // nothing awaits. Each engine now catches its own errors, but these are the
  // backstop — without them a rejection anywhere in background work terminates
  // the process by default on Node >= 15, taking down every unrelated request.
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection (service continues):', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception — shutting down:', err);
    shutdown('uncaughtException');
  });
}

start()
  .then(installLifecycleHandlers)
  .catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
