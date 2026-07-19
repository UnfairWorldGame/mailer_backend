import crypto from 'crypto';
import mongoose from 'mongoose';
import CertificateJob from '../models/CertificateJob.js';
import CertificateRecipient from '../models/CertificateRecipient.js';
import CertSendEvent from '../models/CertSendEvent.js';
import GmailAccount from '../models/GmailAccount.js';
import { sendCampaignEmail } from './emailService.js';
import {
  AccountRotator,
  isRateLimitError,
  markAccountLimitReached,
  msUntilAccountReset,
  recordAccountSend,
} from './accountRotator.js';
import { getWorkerId } from './campaignTracker.js';
import { resolvePerAccountDelayMs, sendConfig } from '../config/sendConfig.js';
import { certConfig } from '../config/certConfig.js';
import { classifySendError, isAuthError, describeSendError } from '../utils/errorClassifier.js';
import { pdfPath, removeJobDir } from './certificateFiles.js';
import {
  consumeCertificateCredits,
  releaseCertificateCredits,
  releaseCertificateJobReservation,
} from './quotaService.js';
import { isShuttingDown, drain } from './shutdown.js';

const activeJobs = new Map();
const workerId = getWorkerId();

// In-flight certificate jobs, for graceful shutdown.
export function awaitActiveCertificateJobs(timeoutMs) {
  return drain([...activeJobs.values()], timeoutMs);
}

/**
 * Sliced sleep so a shutdown signal is seen promptly. A single long timer (the
 * limit backoff waits tens of seconds) outlived SHUTDOWN_GRACE_MS, so the drain
 * timed out, the process was killed mid-job, and the job lock then sat stale for
 * campaignLockStaleMs before anything could pick the job back up.
 */
async function sleep(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (isShuttingDown()) return;
    const slice = Math.min(1000, deadline - Date.now());
    if (slice <= 0) return;
    await new Promise((r) => setTimeout(r, slice));
  }
}

/** How often the owning process re-stamps a running job's lock. */
const LOCK_RENEW_INTERVAL_MS = 60000;

const EXT_BY_MIME = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' };

// The email attachment's displayed filename should always carry an extension
// matching its real content type — some export tools produce zip entries
// with no extension at all (e.g. "1", "2"), and without this an image
// certificate would otherwise arrive in the recipient's inbox as a
// nameless/extensionless file.
function attachmentFileName(originalName, mimeType) {
  const name = originalName || 'certificate';
  const ext = EXT_BY_MIME[mimeType] || '.pdf';
  return new RegExp(`\\${ext}$`, 'i').test(name) ? name : `${name}${ext}`;
}

export function isJobRunning(jobId) {
  return activeJobs.has(jobId.toString());
}

async function writeEvent(jobId, event) {
  try {
    await CertSendEvent.create({ job_id: jobId, ...event });
  } catch {
    /* logging must never break sending */
  }
}

// ---- counters ---------------------------------------------------------------

export async function syncJobCounters(jobId) {
  const rows = await CertificateRecipient.aggregate([
    { $match: { job_id: new mongoose.Types.ObjectId(jobId) } },
    { $group: { _id: '$send_status', count: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [r._id, r.count]));
  await CertificateJob.findByIdAndUpdate(jobId, {
    sent_count: by.sent ?? 0,
    failed_count: by.failed ?? 0,
    pending_count: by.pending ?? 0,
    sending_count: by.sending ?? 0,
    skipped_count: by.skipped ?? 0,
    last_progress_at: new Date(),
  });
  return by;
}

// ---- locking ----------------------------------------------------------------

async function tryAcquireJobLock(jobId, worker) {
  const staleBefore = new Date(Date.now() - sendConfig.campaignLockStaleMs);
  return CertificateJob.findOneAndUpdate(
    {
      _id: jobId,
      status: 'sending',
      $or: [{ worker_id: null }, { worker_id: worker }, { worker_locked_at: { $lt: staleBefore } }],
    },
    { $set: { worker_id: worker, worker_locked_at: new Date() } },
    { new: true }
  );
}

async function releaseJobLock(jobId, worker) {
  await CertificateJob.findOneAndUpdate(
    { _id: jobId, worker_id: worker },
    { $set: { worker_id: null, worker_locked_at: null } }
  );
}

/**
 * Heartbeat the job lock while workers are running.
 *
 * The lock was stamped once at acquisition and never refreshed, so any job still
 * sending after campaignLockStaleMs (10 min) looked abandoned: the next instance
 * to boot cleared it and started a second set of `sendConcurrency` workers on
 * the same job, doubling the send rate against Gmail's per-account limits.
 */
async function renewJobLock(jobId, worker) {
  const res = await CertificateJob.updateOne(
    { _id: jobId, worker_id: worker },
    { $set: { worker_locked_at: new Date() } }
  );
  return res.matchedCount > 0;
}

async function recoverStaleJobLocks() {
  const staleBefore = new Date(Date.now() - sendConfig.campaignLockStaleMs);
  const res = await CertificateJob.updateMany(
    { status: 'sending', worker_locked_at: { $lt: staleBefore }, worker_id: { $ne: null } },
    { $set: { worker_id: null, worker_locked_at: null } }
  );
  return res.modifiedCount;
}

// ---- claim / finalize -------------------------------------------------------

async function claimNextRecipient(jobId, worker) {
  const now = new Date();
  return CertificateRecipient.findOneAndUpdate(
    {
      job_id: jobId,
      send_status: 'pending',
      $or: [{ next_retry_at: null }, { next_retry_at: { $lte: now } }],
    },
    {
      $set: { send_status: 'sending', claim_token: crypto.randomBytes(16).toString('hex'), claimed_at: now, claimed_by: worker, last_attempt_at: now },
      $inc: { attempt_count: 1 },
      $unset: { next_retry_at: '' },
    },
    { sort: { created_at: 1 }, new: true }
  );
}

function finalize(recipientId, claimToken, updates) {
  return CertificateRecipient.findOneAndUpdate(
    { _id: recipientId, send_status: 'sending', claim_token: claimToken },
    { $set: updates },
    { new: true }
  );
}

function scheduleRetry(recipientId, claimToken, { nextRetryAt, errorMessage }) {
  return CertificateRecipient.findOneAndUpdate(
    { _id: recipientId, send_status: 'sending', claim_token: claimToken },
    { $set: { send_status: 'pending', next_retry_at: nextRetryAt, error_message: errorMessage, claim_token: null, claimed_at: null, claimed_by: null } },
    { new: true }
  );
}

function computeRetryDelay(attemptCount) {
  const delay = sendConfig.retryBaseDelayMs * Math.pow(2, Math.max(0, attemptCount - 1));
  return Math.min(delay, sendConfig.retryMaxDelayMs);
}

// ---- crash recovery ---------------------------------------------------------

// Rows stuck in 'sending' from a dead worker: recover as sent if a success event
// exists (message really went out), otherwise requeue as pending.
async function recoverStaleRecipients(jobId) {
  const staleBefore = new Date(Date.now() - sendConfig.claimStaleMs);
  const stale = await CertificateRecipient.find({
    job_id: jobId, send_status: 'sending', claimed_at: { $lt: staleBefore },
  }).select('_id email');

  let recovered = 0;
  for (const r of stale) {
    const ok = await CertSendEvent.findOne({ job_id: jobId, recipient_id: r._id, action: 'send_success' }).sort({ created_at: -1 });
    if (ok?.details?.message_id) {
      await CertificateRecipient.updateOne(
        { _id: r._id, send_status: 'sending' },
        { $set: { send_status: 'sent', message_id: ok.details.message_id, sent_at: ok.created_at, error_message: null, claim_token: null, claimed_at: null, claimed_by: null } }
      );
    } else {
      await CertificateRecipient.updateOne(
        { _id: r._id, send_status: 'sending' },
        { $set: { send_status: 'pending', claim_token: null, claimed_at: null, claimed_by: null } }
      );
    }
    recovered += 1;
  }
  return recovered;
}

// Rows still pending/sending but with a prior success event = already delivered.
async function reconcileOrphanedSends(jobId) {
  const candidates = await CertificateRecipient.find({
    job_id: jobId, send_status: { $in: ['pending', 'sending'] },
  }).select('_id');

  let reconciled = 0;
  for (const r of candidates) {
    const ok = await CertSendEvent.findOne({ job_id: jobId, recipient_id: r._id, action: 'send_success' }).sort({ created_at: -1 });
    if (!ok) continue;
    const res = await CertificateRecipient.updateOne(
      { _id: r._id, send_status: { $in: ['pending', 'sending'] } },
      { $set: { send_status: 'sent', message_id: ok.details?.message_id || null, sent_at: ok.created_at, error_message: null, claim_token: null, claimed_at: null, claimed_by: null } }
    );
    if (res.modifiedCount) reconciled += 1;
  }
  return reconciled;
}

// ---- send worker ------------------------------------------------------------

async function jobStatus(jobId) {
  const j = await CertificateJob.findById(jobId).select('status worker_id');
  return j;
}

/** Idle poll interval when nothing is claimable. */
const IDLE_SLEEP_MS = 3000;

async function sendWorker(jobId, job, rotator, perAccountDelayMs) {
  let consecutiveNoAccount = 0;
  let foreignWorkerSpins = 0;
  let idleRounds = 0;
  let sentSinceSync = 0;

  while (true) {
    // Cooperative shutdown — release the job lock now rather than letting it go
    // stale. The job stays `sending` and is resumed on the next boot.
    if (isShuttingDown()) return;

    const current = await jobStatus(jobId);
    if (!current) return;
    if (current.status === 'paused') return;
    if (current.status === 'canceled') return;
    if (current.status !== 'sending') return;
    if (current.worker_id && current.worker_id !== workerId) {
      // Bounded, unlike before: if the holder died without releasing, this
      // looped for the life of the process, kept the job in activeJobs (making
      // startJobSend a permanent no-op for it) and burned the whole shutdown
      // grace period. Yield and let the stale-lock sweep hand it back.
      foreignWorkerSpins += 1;
      if (foreignWorkerSpins > 5) return;
      await sleep(perAccountDelayMs);
      continue;
    }
    foreignWorkerSpins = 0;

    const recipient = await claimNextRecipient(jobId, workerId);
    if (!recipient) {
      // Nothing claimable right now. If work remains (future retries or other
      // workers still in-flight), wait; otherwise this worker is done.
      const remaining = await CertificateRecipient.countDocuments({
        job_id: jobId, send_status: { $in: ['pending', 'sending'] },
      });
      if (remaining === 0) return;

      // A row wedged in `sending` — its worker died mid-catch, say — counts as
      // "remaining" forever, so every worker looped here indefinitely: the job
      // never completed, finalizeJobIfDone never ran, activeJobs never cleared
      // (making startJobSend a permanent no-op for it), credits stayed reserved
      // and files were never cleaned. Recovery only ran at job start, so only a
      // restart healed it. Re-run it here once the idle stretch exceeds the
      // claim staleness window, and give up rather than spin forever.
      idleRounds += 1;
      if (idleRounds * IDLE_SLEEP_MS >= sendConfig.claimStaleMs) {
        const recovered = await recoverStaleRecipients(jobId);
        idleRounds = 0;
        if (recovered === 0) {
          // Nothing claimable and nothing recoverable — the remaining rows are
          // held by live sibling workers. Exit; whoever finishes last completes
          // the job.
          return;
        }
        continue;
      }

      await sleep(IDLE_SLEEP_MS);
      continue;
    }
    idleRounds = 0;

    const claimToken = recipient.claim_token;
    const account = await rotator.nextReadyAccount(sleep);

    if (!account) {
      // Wait for the real reset rather than a fixed guess. This used to sleep
      // 25s ten times and then pause the job — about 4 minutes — while the
      // hourly cap it was waiting on can be up to 60 minutes out. Any job
      // larger than the hourly limit per account stalled minutes in and stayed
      // paused until someone clicked resume.
      const resets = rotator.orderedAccounts
        .map((a) => msUntilAccountReset(a))
        .filter((ms) => ms != null && Number.isFinite(ms));

      if (!resets.length) {
        // Nothing that will ever come back — pausing is right here.
        consecutiveNoAccount += 1;
        if (consecutiveNoAccount >= 3) {
          await CertificateJob.findOneAndUpdate({ _id: jobId, status: 'sending' }, { $set: { status: 'paused' } });
          await writeEvent(jobId, { level: 'error', action: 'job_pause', message: 'Paused — no usable Gmail accounts remain. Check your accounts and resume.' });
          return;
        }
        await sleep(perAccountDelayMs);
        continue;
      }

      const waitMs = Math.max(perAccountDelayMs, Math.min(...resets) + 1000);
      consecutiveNoAccount = 0;

      await scheduleRetry(recipient._id, claimToken, {
        nextRetryAt: new Date(Date.now() + waitMs),
        errorMessage: 'All accounts are at their send limit — waiting for the limit to reset.',
      });

      // claimNextRecipient increments attempt_count at claim time, before an
      // account is chosen. Waiting for capacity is not a delivery attempt, and
      // counting it as one burned the recipient's whole retry budget while
      // idle: capacity returns, the first real attempt hits one transient
      // error, and it is permanently failed having never actually been tried.
      await CertificateRecipient.updateOne(
        { _id: recipient._id },
        { $inc: { attempt_count: -1 } }
      );
      await writeEvent(jobId, {
        recipient_id: recipient._id, level: 'warning', action: 'account_limit_reached',
        message: `All Gmail accounts are at their send limit. Waiting ${Math.round(waitMs / 60000)} min for the next reset — the job continues on its own.`,
        details: { wait_ms: waitMs },
      });

      // Sleep in chunks so pause/cancel/shutdown are still observed while waiting.
      const until = Date.now() + waitMs;
      while (Date.now() < until && !isShuttingDown()) {
        await sleep(Math.min(30000, until - Date.now()));
        const check = await jobStatus(jobId);
        if (!check || check.status !== 'sending') return;
      }
      continue;
    }
    consecutiveNoAccount = 0;

    // Certificates may be PDF, PNG, or JPEG (detected by content at upload
    // time, see certificateFiles.js) — attach with the recipient's real type
    // rather than assuming PDF. Older jobs created before mime_type existed
    // fall back to PDF, matching their actual stored file.
    const mimeType = recipient.mime_type || 'application/pdf';
    const attachments = [{
      original_name: attachmentFileName(recipient.original_pdf_name, mimeType),
      file_path: pdfPath(job.job_dir, recipient.matched_file),
      mime_type: mimeType,
    }];

    await writeEvent(jobId, {
      recipient_id: recipient._id, level: 'info', action: 'send_attempt',
      message: `Sending certificate to ${recipient.email} (attempt ${recipient.attempt_count})`,
      recipient_email: recipient.email,
      details: { account: account.email, attempt: recipient.attempt_count },
    });

    const attemptStarted = Date.now();

    // Only the sendMail call may route into the failure branch. Everything
    // after it runs against a message Gmail has already ACCEPTED, and the
    // failure branch reschedules the recipient — so a throw from the event
    // write or the finalize used to deliver the same certificate twice (a
    // transient Atlas blip during writeEvent was enough). Capture the send
    // error explicitly instead of wrapping the whole block in one try.
    let info = null;
    let sendError = null;
    try {
      info = await sendCampaignEmail(
        account,
        { name: recipient.name, email: recipient.email },
        job.subject,
        job.body,
        attachments
      );
    } catch (err) {
      sendError = err;
    }

    if (!sendError) {
      // Record success BEFORE finalizing so crash-recovery can dedup:
      // reconcileOrphanedSends keys off this event to decide a recipient was
      // already delivered. Best-effort from here on — never throw.
      await writeEvent(jobId, {
        recipient_id: recipient._id, level: 'success', action: 'send_success',
        message: `Certificate delivered to ${recipient.email}`,
        recipient_email: recipient.email,
        details: { message_id: info.messageId, account: account.email, duration_ms: Date.now() - attemptStarted },
      }).catch((e) => console.error('cert send_success event failed:', e.message));

      await recordAccountSend(account).catch((e) =>
        console.error('recordAccountSend failed:', e.message)
      );
      rotator.markSent(account);

      let updated = null;
      try {
        updated = await finalize(recipient._id, claimToken, {
          send_status: 'sent', sent_at: new Date(), gmail_account_id: account._id,
          message_id: info.messageId || null, error_message: null,
          claim_token: null, claimed_at: null, claimed_by: null,
        });
      } catch (finalizeErr) {
        // Delivered but not recorded. Leave the row claimed and move on — the
        // success event above lets recovery settle it. Retrying would re-send.
        console.error(
          `[cert job ${jobId}] delivered to ${recipient.email} but finalize failed:`,
          finalizeErr.message
        );
        continue;
      }

      if (updated) {
        // Charge 3 credits exactly once — only the worker that wins the finalize.
        const charge = await consumeCertificateCredits(job.user_id, jobId);

        // Balance ran out despite the reservation. This certificate is already
        // delivered; pause rather than send the remainder unbilled.
        if (charge && charge.charged === false) {
          await CertificateJob.updateOne(
            { _id: jobId, status: 'sending' },
            { $set: { status: 'paused' } }
          );
          await writeEvent(jobId, {
            level: 'error', action: 'job_pause',
            message: 'Job paused — your credit balance ran out mid-send. Top up and resume to continue.',
            details: { shortfall: charge.shortfall },
          }).catch(() => {});
          return;
        }
      } else {
        await writeEvent(jobId, {
          recipient_id: recipient._id, level: 'warning', action: 'duplicate_prevented',
          message: `Delivered to ${recipient.email} but claim was lost — duplicate prevented`,
          recipient_email: recipient.email,
        }).catch(() => {});
      }

      // Counters were written only at job start and again after every worker
      // exited, so GET /:id/progress read 0% for the entire run — hours, on a
      // large job — and then jumped to 100%. last_progress_at never advanced
      // either, so it was useless as a liveness signal.
      sentSinceSync += 1;
      if (sentSinceSync >= sendConfig.progressSyncEvery) {
        sentSinceSync = 0;
        await syncJobCounters(jobId).catch(() => {});
      }
    } else {
      const err = sendError;
      const rateLimited = isRateLimitError(err);

      // A rejected App Password is an account problem, not a recipient problem.
      // Without this branch, EAUTH/535 classified as `permanent`, so every
      // recipient the bad account happened to be handed was marked failed with
      // a raw "535-5.7.8 BadCredentials" and never retried on a healthy
      // account: with 3 accounts and one bad password, a third of the batch
      // silently never arrived while the job reported "complete".
      if (isAuthError(err)) {
        const remaining = rotator.disableForRun(account);
        await writeEvent(jobId, {
          recipient_id: recipient._id, level: 'error', action: 'send_failed',
          message: describeSendError(err, { accountEmail: account.email }),
          recipient_email: recipient.email,
          details: { error: err.message, account: account.email, accounts_remaining: remaining },
        });

        // Hand the recipient back untouched so a healthy account picks it up.
        await CertificateRecipient.findOneAndUpdate(
          { _id: recipient._id, claim_token: claimToken },
          {
            $set: { send_status: 'pending', claim_token: null, claimed_at: null, claimed_by: null, next_retry_at: null },
            $inc: { attempt_count: -1 },
          }
        );

        if (remaining > 0) continue;

        await CertificateJob.findOneAndUpdate(
          { _id: jobId, status: 'sending' },
          { $set: { status: 'paused' } }
        );
        await writeEvent(jobId, {
          level: 'error', action: 'job_pause',
          message: `Paused — ${describeSendError(err, { accountEmail: account.email })}`,
        });
        return;
      }
      const errorClass = classifySendError(err);
      const canRetry =
        recipient.attempt_count < sendConfig.maxRetriesPerRecipient &&
        (rateLimited || errorClass === 'transient' || errorClass === 'unknown');

      if (rateLimited) {
        await markAccountLimitReached(account, err.message);
        await writeEvent(jobId, {
          recipient_id: recipient._id, level: 'warning', action: 'account_limit_reached',
          message: `Account ${account.email} hit a limit: ${err.message}`,
          recipient_email: recipient.email,
        });
      }

      if (canRetry) {
        const nextRetryAt = new Date(Date.now() + computeRetryDelay(recipient.attempt_count));
        await scheduleRetry(recipient._id, claimToken, { nextRetryAt, errorMessage: err.message });
        await writeEvent(jobId, {
          recipient_id: recipient._id, level: 'warning', action: 'send_retry',
          message: `Retry scheduled for ${recipient.email} (attempt ${recipient.attempt_count}/${sendConfig.maxRetriesPerRecipient})`,
          recipient_email: recipient.email,
          details: { error: err.message, error_class: errorClass, next_retry_at: nextRetryAt },
        });
      } else {
        const failed = await finalize(recipient._id, claimToken, {
          send_status: 'failed', error_message: err.message, gmail_account_id: account._id,
          claim_token: null, claimed_at: null, claimed_by: null,
        });
        // Refund the 3 reserved credits for a permanently failed send.
        if (failed) await releaseCertificateCredits(job.user_id, jobId);
        await writeEvent(jobId, {
          recipient_id: recipient._id, level: 'error', action: 'send_failed',
          message: `Failed to send to ${recipient.email}: ${err.message}`,
          recipient_email: recipient.email,
          details: { error: err.message, error_class: errorClass, attempt: recipient.attempt_count },
        });
      }
    }
  }
}

// ---- job orchestration ------------------------------------------------------

async function finalizeJobIfDone(jobId) {
  await syncJobCounters(jobId);
  const remaining = await CertificateRecipient.countDocuments({
    job_id: jobId, send_status: { $in: ['pending', 'sending'] },
  });
  if (remaining > 0) return;

  // Atomically flip sending -> completed exactly once.
  const job = await CertificateJob.findOneAndUpdate(
    { _id: jobId, status: 'sending' },
    { $set: { status: 'completed', completed_at: new Date() } },
    { new: true }
  );
  if (!job) return;

  // Release any credits still reserved (e.g. recipients recovered without a
  // winning consume). This never overcharges — leftover reservations go back.
  await releaseCertificateJobReservation(job.user_id, jobId);

  await writeEvent(jobId, {
    level: job.failed_count > 0 ? 'warning' : 'success', action: 'job_complete',
    message: `Job complete. Sent ${job.sent_count}, failed ${job.failed_count}.`,
    details: { sent: job.sent_count, failed: job.failed_count, skipped: job.skipped_count },
  });

  await cleanupJobFiles(job);
}

export async function cleanupJobFiles(job) {
  if (!job || job.files_deleted) return;
  await removeJobDir(job.job_dir);
  await CertificateJob.updateOne({ _id: job._id }, { $set: { files_deleted: true, cleaned_at: new Date() } });
  await writeEvent(job._id, { level: 'info', action: 'cleanup', message: 'Temporary certificate files deleted.' });
}

async function processJob(jobId) {
  const locked = await tryAcquireJobLock(jobId, workerId);
  if (!locked) return;

  // All `sendConcurrency` workers share one job-level lock, so the heartbeat
  // lives here rather than in each worker.
  const heartbeat = setInterval(() => {
    renewJobLock(jobId, workerId).catch(() => {});
  }, LOCK_RENEW_INTERVAL_MS);
  heartbeat.unref?.();

  try {
    await recoverStaleRecipients(jobId);
    await reconcileOrphanedSends(jobId);
    await syncJobCounters(jobId);

    const job = await CertificateJob.findById(jobId);
    if (!job || job.status !== 'sending') return;

    if (job.files_deleted) {
      await CertificateJob.updateOne({ _id: jobId, status: 'sending' }, { $set: { status: 'failed' } });
      await releaseCertificateJobReservation(job.user_id, jobId);
      await writeEvent(jobId, { level: 'error', action: 'send_failed', message: 'Certificate files are no longer available.' });
      return;
    }

    const accounts = await GmailAccount.find({ user_id: job.user_id, is_active: true });
    if (!accounts.length) {
      await CertificateJob.updateOne({ _id: jobId, status: 'sending' }, { $set: { status: 'paused' } });
      await writeEvent(jobId, { level: 'error', action: 'no_accounts', message: 'No active Gmail accounts available. Add one, then resume.' });
      return;
    }

    const perAccountDelayMs = resolvePerAccountDelayMs();
    const useRotation = accounts.length > 1;
    const rotator = new AccountRotator(accounts, {
      preferredAccountId: useRotation ? null : job.gmail_account_id,
      rotate: useRotation || job.rotate_accounts !== false,
      perAccountDelayMs,
    });

    await writeEvent(jobId, {
      level: 'info', action: 'job_start',
      message: `Sending ${job.total_recipients} certificate(s)`,
      details: { concurrency: certConfig.sendConcurrency, accounts: rotator.orderedAccounts.map((a) => a.email) },
    });

    const concurrency = Math.max(1, certConfig.sendConcurrency);
    await Promise.all(
      Array.from({ length: concurrency }, () =>
        sendWorker(jobId, job, rotator, perAccountDelayMs).catch((err) => {
          console.error('[cert-worker] fatal:', err.message);
        })
      )
    );

    await finalizeJobIfDone(jobId);
  } catch (err) {
    console.error('[cert-job] error:', err.message);
    await CertificateJob.updateOne({ _id: jobId, status: 'sending' }, { $set: { status: 'paused' } }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
    // Every early return above (pause, cancel, shutdown, no accounts, files
    // gone, credit shortfall) skipped finalizeJobIfDone, so the job's counters
    // stayed as stale as the last periodic sync for as long as it sat paused.
    await syncJobCounters(jobId).catch(() => {});
    try {
      await releaseJobLock(jobId, workerId);
    } catch { /* ignore on shutdown */ }
  }
}

export async function startJobSend(jobId) {
  const id = jobId.toString();

  const existing = activeJobs.get(id);
  if (existing) {
    // A job's promise stays in activeJobs until it settles, so a resume that
    // arrived while the previous run was on its way out got `alreadyRunning`
    // and the job was left in `sending` with no workers. Chain instead, and
    // only start again if it still needs sending.
    const chained = existing
      .catch(() => {})
      .then(async () => {
        const job = await CertificateJob.findById(id).select('status');
        if (job && job.status === 'sending') return processJob(id);
      })
      .finally(() => {
        if (activeJobs.get(id) === chained) activeJobs.delete(id);
      });
    activeJobs.set(id, chained);
    return { started: true, chained: true };
  }

  const promise = processJob(id).finally(() => {
    if (activeJobs.get(id) === promise) activeJobs.delete(id);
  });
  activeJobs.set(id, promise);
  return { started: true };
}

// Reset failed recipients back to pending so they can be retried.
// Filter for recipients a retry may legitimately requeue. The attempt cap
// matters for cost: without it, a recipient that has already exhausted its
// retries is requeued anyway, re-reserving 3 credits and burning one more
// guaranteed-to-fail attempt (the send loop only checks the cap after the
// attempt). The campaign path has always capped this; this one did not.
export function retryableRecipientFilter(jobId) {
  return {
    job_id: jobId,
    send_status: 'failed',
    attempt_count: { $lt: sendConfig.maxRetriesPerRecipient },
  };
}

export async function countRetryableRecipients(jobId) {
  return CertificateRecipient.countDocuments(retryableRecipientFilter(jobId));
}

export async function retryFailedRecipients(jobId) {
  const res = await CertificateRecipient.updateMany(
    retryableRecipientFilter(jobId),
    { $set: { send_status: 'pending', error_message: null, next_retry_at: null, claim_token: null, claimed_at: null, claimed_by: null } }
  );
  if (res.modifiedCount > 0) await syncJobCounters(jobId);
  return res.modifiedCount;
}

// On boot: recover locks and resume any jobs left 'sending' by a crash/restart.
export async function resumeInterruptedCertificateJobs() {
  const cleared = await recoverStaleJobLocks();
  if (cleared > 0) console.log(`Cleared ${cleared} stale certificate job lock(s)`);

  const sending = await CertificateJob.find({ status: 'sending' });
  for (const job of sending) {
    if (job.files_deleted) {
      await CertificateJob.updateOne({ _id: job._id }, { $set: { status: 'failed' } });
      await releaseCertificateJobReservation(job.user_id, job._id);
      continue;
    }
    await recoverStaleRecipients(job._id);
    await reconcileOrphanedSends(job._id);
    await syncJobCounters(job._id);
    await writeEvent(job._id, { level: 'info', action: 'job_resume', message: 'Resuming certificate job after server restart.' });
    startJobSend(job._id).catch(console.error);
  }
}
