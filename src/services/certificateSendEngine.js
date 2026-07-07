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
  recordAccountSend,
} from './accountRotator.js';
import { getWorkerId } from './campaignTracker.js';
import { resolvePerAccountDelayMs, sendConfig } from '../config/sendConfig.js';
import { certConfig } from '../config/certConfig.js';
import { classifySendError } from '../utils/errorClassifier.js';
import { pdfPath, removeJobDir } from './certificateFiles.js';
import {
  consumeCertificateCredits,
  releaseCertificateCredits,
  releaseCertificateJobReservation,
} from './quotaService.js';

const activeJobs = new Map();
const workerId = getWorkerId();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function sendWorker(jobId, job, rotator, perAccountDelayMs) {
  let consecutiveNoAccount = 0;

  while (true) {
    const current = await jobStatus(jobId);
    if (!current) return;
    if (current.status === 'paused') return;
    if (current.status === 'canceled') return;
    if (current.status !== 'sending') return;
    if (current.worker_id && current.worker_id !== workerId) {
      await sleep(perAccountDelayMs);
      continue;
    }

    const recipient = await claimNextRecipient(jobId, workerId);
    if (!recipient) {
      // Nothing claimable right now. If work remains (future retries or other
      // workers still in-flight), wait; otherwise this worker is done.
      const remaining = await CertificateRecipient.countDocuments({
        job_id: jobId, send_status: { $in: ['pending', 'sending'] },
      });
      if (remaining === 0) return;
      await sleep(Math.min(perAccountDelayMs, 3000));
      continue;
    }

    const claimToken = recipient.claim_token;
    const account = await rotator.nextReadyAccount(sleep);

    if (!account) {
      await scheduleRetry(recipient._id, claimToken, {
        nextRetryAt: new Date(Date.now() + perAccountDelayMs * 5),
        errorMessage: 'All accounts have reached their send limits — waiting to retry.',
      });
      consecutiveNoAccount += 1;
      await writeEvent(jobId, {
        recipient_id: recipient._id, level: 'warning', action: 'account_limit_reached',
        message: 'All Gmail accounts reached their limits. Waiting before retrying.',
      });
      if (consecutiveNoAccount >= 10) {
        await CertificateJob.findOneAndUpdate({ _id: jobId, status: 'sending' }, { $set: { status: 'paused' } });
        await writeEvent(jobId, { level: 'error', action: 'job_pause', message: 'Paused — all accounts exhausted. Resume after limits reset.' });
        return;
      }
      await sleep(perAccountDelayMs * 5);
      continue;
    }
    consecutiveNoAccount = 0;

    const attachments = [{
      original_name: recipient.original_pdf_name || 'certificate.pdf',
      file_path: pdfPath(job.job_dir, recipient.matched_file),
      mime_type: 'application/pdf',
    }];

    await writeEvent(jobId, {
      recipient_id: recipient._id, level: 'info', action: 'send_attempt',
      message: `Sending certificate to ${recipient.email} (attempt ${recipient.attempt_count})`,
      recipient_email: recipient.email,
      details: { account: account.email, attempt: recipient.attempt_count },
    });

    const attemptStarted = Date.now();
    try {
      const info = await sendCampaignEmail(
        account,
        { name: recipient.name, email: recipient.email },
        job.subject,
        job.body,
        attachments
      );

      // Record success BEFORE finalizing so crash-recovery can dedup.
      await writeEvent(jobId, {
        recipient_id: recipient._id, level: 'success', action: 'send_success',
        message: `Certificate delivered to ${recipient.email}`,
        recipient_email: recipient.email,
        details: { message_id: info.messageId, account: account.email, duration_ms: Date.now() - attemptStarted },
      });

      await recordAccountSend(account);
      rotator.markSent(account);

      const updated = await finalize(recipient._id, claimToken, {
        send_status: 'sent', sent_at: new Date(), gmail_account_id: account._id,
        message_id: info.messageId || null, error_message: null,
        claim_token: null, claimed_at: null, claimed_by: null,
      });

      if (updated) {
        // Charge 3 credits exactly once — only the worker that wins the finalize.
        await consumeCertificateCredits(job.user_id, jobId);
      } else {
        await writeEvent(jobId, {
          recipient_id: recipient._id, level: 'warning', action: 'duplicate_prevented',
          message: `Delivered to ${recipient.email} but claim was lost — duplicate prevented`,
          recipient_email: recipient.email,
        });
      }
    } catch (err) {
      const rateLimited = isRateLimitError(err);
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
    try {
      await releaseJobLock(jobId, workerId);
    } catch { /* ignore on shutdown */ }
  }
}

export async function startJobSend(jobId) {
  const id = jobId.toString();
  if (activeJobs.has(id)) return { alreadyRunning: true };
  const promise = processJob(id).finally(() => activeJobs.delete(id));
  activeJobs.set(id, promise);
  return { started: true };
}

// Reset failed recipients back to pending so they can be retried.
export async function retryFailedRecipients(jobId) {
  const res = await CertificateRecipient.updateMany(
    { job_id: jobId, send_status: 'failed' },
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
