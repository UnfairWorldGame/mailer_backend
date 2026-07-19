import { sweepOutbox } from './outbox.js';
import { isShuttingDown } from '../shutdown.js';

/**
 * Periodically retries transactional email that failed to send.
 *
 * This is what makes the outbox durable across a process restart: an SMTP
 * outage during a deploy leaves rows in `failed`, and the next instance picks
 * them up on its first sweep rather than the email being lost forever.
 */
const INTERVAL_MS = parseInt(process.env.EMAIL_SWEEP_INTERVAL_MS || '', 10) || 120000;

let timer = null;

export function startOutboxSweeper() {
  if (timer) return timer;

  timer = setInterval(() => {
    if (isShuttingDown()) return;
    sweepOutbox()
      .then((result) => {
        if (result.attempted > 0) {
          console.log(`[outbox] retried ${result.attempted} email(s), ${result.sent} sent`);
        }
      })
      .catch((err) => console.error('[outbox] sweep failed:', err?.message));
  }, INTERVAL_MS);

  // Never hold the event loop open on shutdown.
  timer.unref?.();
  return timer;
}

export function stopOutboxSweeper() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

export { INTERVAL_MS as OUTBOX_SWEEP_INTERVAL_MS };
