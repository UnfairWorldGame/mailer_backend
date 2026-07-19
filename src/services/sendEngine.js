import Campaign from '../models/Campaign.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import GmailAccount from '../models/GmailAccount.js';
import mongoose from 'mongoose';
import { sendCampaignEmail, closeAllTransports } from './emailService.js';
import { writeLog } from './logService.js';
import {
  AccountRotator,
  isRateLimitError,
  markAccountLimitReached,
  msUntilAccountReset,
  recordAccountSend,
} from './accountRotator.js';
import { resolvePerAccountDelayMs, sendConfig } from '../config/sendConfig.js';
import { classifySendError, isAuthError, describeSendError } from '../utils/errorClassifier.js';
import {
  getWorkerId,
  tryAcquireCampaignLock,
  releaseCampaignLock,
  recoverStaleCampaignLocks,
  recoverStaleRecipients,
  reconcileOrphanedSends,
  claimNextRecipient,
  finalizeRecipient,
  scheduleRecipientRetry,
  computeRetryDelay,
  syncCampaignCounters,
  renewCampaignLock,
} from './campaignTracker.js';

/** How often the active worker re-stamps its campaign lock. */
const LOCK_RENEW_INTERVAL_MS = 60000;
import {
  consumeSendQuota,
  releaseUnsentQuotaSlot,
  releaseCampaignQuota,
} from './quotaService.js';
import { isShuttingDown, drain } from './shutdown.js';

const activeJobs = new Map();
const workerId = getWorkerId();

// In-flight campaign loops, for graceful shutdown. Returns true if they all
// finished within the budget.
export function awaitActiveCampaigns(timeoutMs) {
  return drain([...activeJobs.values()], timeoutMs);
}

/**
 * Sleep in short slices so a shutdown signal is noticed promptly. A single
 * long timer (account cooldowns run up to 60s, limit backoff longer) outlived
 * SHUTDOWN_GRACE_MS, so the drain timed out and the process was killed mid-loop
 * — leaving the campaign lock to go stale for the next 10 minutes.
 */
async function sleep(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (isShuttingDown()) return;
    const slice = Math.min(1000, deadline - Date.now());
    if (slice <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, slice));
  }
}

export function isCampaignRunning(campaignId) {
  return activeJobs.has(campaignId.toString());
}

export async function startCampaignSend(campaignId) {
  const id = campaignId.toString();

  const existing = activeJobs.get(id);
  if (existing) {
    // The existing loop may already be on its way out — it stays in activeJobs
    // until its promise settles. A resume arriving in that window used to get
    // `alreadyRunning`, so the campaign was left in `sending` with no worker
    // and nothing to pick it up. Chain a fresh attempt onto the old loop
    // instead, and only start one if the campaign still needs sending.
    const chained = existing
      .catch(() => {})
      .then(async () => {
        const campaign = await Campaign.findById(id).select('status');
        if (campaign && campaign.status === 'sending') {
          return processCampaign(id);
        }
      })
      .finally(() => {
        if (activeJobs.get(id) === chained) activeJobs.delete(id);
      });
    activeJobs.set(id, chained);
    return { started: true, chained: true };
  }

  const promise = processCampaign(id).finally(() => {
    if (activeJobs.get(id) === promise) activeJobs.delete(id);
  });
  activeJobs.set(id, promise);
  return { started: true };
}

export async function resumeInterruptedCampaigns() {
  const locksCleared = await recoverStaleCampaignLocks();
  if (locksCleared > 0) {
    console.log(`Cleared ${locksCleared} stale campaign worker lock(s)`);
  }

  const sending = await Campaign.find({ status: 'sending' });
  for (const campaign of sending) {
    const recovered = await recoverStaleRecipients(campaign._id, { writeLog });
    const reconciled = await reconcileOrphanedSends(campaign._id, { writeLog });
    await syncCampaignCounters(campaign._id);

    console.log(
      `Resuming campaign ${campaign._id} (recovered ${recovered} stale, reconciled ${reconciled} orphaned)`
    );

    await writeLog({
      campaignId: campaign._id,
      level: 'info',
      action: 'campaign_resume',
      message: `Auto-resuming campaign "${campaign.name}" after server restart`,
      details: {
        worker_id: workerId,
        recovered_stale: recovered,
        reconciled_orphaned: reconciled,
      },
    });

    startCampaignSend(campaign._id).catch(console.error);
  }
}

async function processCampaign(campaignId) {
  const locked = await tryAcquireCampaignLock(campaignId, workerId);
  if (!locked) {
    return;
  }

  try {
    await recoverStaleRecipients(campaignId, { writeLog });
    await reconcileOrphanedSends(campaignId, { writeLog });
    await syncCampaignCounters(campaignId);

    const campaign = await Campaign.findById(campaignId);
    if (!campaign) return;

    const accounts = await GmailAccount.find({ user_id: campaign.user_id, is_active: true });
    if (!accounts.length) {
      campaign.status = 'failed';
      await campaign.save();
      await releaseCampaignQuota(campaign.user_id, campaignId);
      await writeLog({
        campaignId,
        level: 'error',
        action: 'no_accounts',
        message: 'No active Gmail accounts available for sending',
      });
      return;
    }

    const useRotation = campaign.rotate_accounts !== false && accounts.length > 1;
    const perAccountDelayMs = resolvePerAccountDelayMs(campaign.send_delay_ms);

    const rotator = new AccountRotator(accounts, {
      preferredAccountId: useRotation ? null : campaign.gmail_account_id,
      rotate: useRotation,
      perAccountDelayMs,
    });
    const attachments = campaign.attachments || [];
    let emailsSinceSync = 0;

    await writeLog({
      campaignId,
      level: 'info',
      action: 'campaign_start',
      message: `Campaign "${campaign.name}" started`,
      details: {
        worker_id: workerId,
        per_account_delay_ms: perAccountDelayMs,
        rotate_accounts: rotator.usesRotation,
        attachment_count: attachments.length,
        max_retries: sendConfig.maxRetriesPerRecipient,
        available_accounts: rotator.orderedAccounts.map((a) => a.email),
      },
    });

    let consecutiveNoAccount = 0;
    let foreignWorkerSpins = 0;
    let lastLockRenewAt = Date.now();

    while (true) {
      // Cooperative shutdown: stop claiming new recipients and fall out through
      // `finally`, which releases the campaign lock right away instead of
      // leaving it to go stale over the next 10 minutes. The campaign stays in
      // `sending`, so the next boot's resume picks it straight back up.
      if (isShuttingDown()) {
        await writeLog({
          campaignId,
          level: 'info',
          action: 'campaign_pause',
          message: 'Server is shutting down — releasing campaign for another worker to resume',
          details: { worker_id: workerId },
        }).catch(() => {});
        return;
      }

      const current = await Campaign.findById(campaignId).select('status worker_id');
      if (!current || current.status === 'paused') {
        await writeLog({
          campaignId,
          level: 'warning',
          action: 'campaign_pause',
          message: 'Campaign sending paused',
        });
        return;
      }
      if (current.status === 'stopped') {
        await writeLog({
          campaignId,
          level: 'warning',
          action: 'campaign_stop',
          message: 'Campaign sending stopped by user',
        });
        await releaseCampaignQuota(campaign.user_id, campaignId);
        return;
      }

      if (current.worker_id && current.worker_id !== workerId) {
        // Another worker owns this campaign. Previously this branch looped
        // forever with no counter: if that worker died without releasing, this
        // loop spun for the life of the process, kept its entry in activeJobs
        // (making startCampaignSend a permanent no-op for this campaign) and
        // burned the full shutdown grace period on every deploy. Yield instead —
        // the stale-lock sweep will hand it back if the other worker is gone.
        foreignWorkerSpins += 1;
        if (foreignWorkerSpins > 5) {
          await writeLog({
            campaignId,
            level: 'info',
            action: 'campaign_pause',
            message: 'Another worker is already sending this campaign — yielding',
            details: { worker_id: workerId, holder: current.worker_id },
          }).catch(() => {});
          return;
        }
        await sleep(perAccountDelayMs);
        continue;
      }
      foreignWorkerSpins = 0;

      // Heartbeat the lock so a long-running campaign is never mistaken for an
      // abandoned one. A false return means we lost it — stop immediately.
      if (Date.now() - lastLockRenewAt > LOCK_RENEW_INTERVAL_MS) {
        const stillOurs = await renewCampaignLock(campaignId, workerId);
        if (!stillOurs) {
          await writeLog({
            campaignId,
            level: 'warning',
            action: 'campaign_pause',
            message: 'Campaign lock was taken over by another worker — stopping this loop',
            details: { worker_id: workerId },
          }).catch(() => {});
          return;
        }
        lastLockRenewAt = Date.now();
      }

      const recipient = await claimNextRecipient(campaignId, workerId);
      if (!recipient) {
        const pendingRetry = await CampaignRecipient.countDocuments({
          campaign_id: campaignId,
          status: 'pending',
          next_retry_at: { $gt: new Date() },
        });
        if (pendingRetry > 0) {
          await sleep(Math.min(perAccountDelayMs, 5000));
          continue;
        }
        break;
      }

      const claimToken = recipient.claim_token;
      let account = await rotator.nextReadyAccount(sleep);

      if (!account) {
        // Wait for the actual reset, not a fixed guess. The old code slept
        // 25s ten times and then paused the campaign — about 4 minutes — while
        // the hourly cap it was waiting on can be up to 60 minutes away. Any
        // campaign larger than the hourly limit per account therefore stalled
        // minutes in and sat paused until a human clicked resume.
        const resets = rotator.orderedAccounts
          .map((a) => msUntilAccountReset(a))
          .filter((ms) => ms != null && Number.isFinite(ms));

        // Nothing left that will ever come back (every account disabled or
        // inactive) — pausing is correct here, waiting is not.
        if (!resets.length) {
          consecutiveNoAccount += 1;
          if (consecutiveNoAccount >= 3) {
            await Campaign.updateOne(
              { _id: campaignId, status: 'sending' },
              { $set: { status: 'paused' } }
            );
            await writeLog({
              campaignId,
              level: 'error',
              action: 'campaign_pause',
              message: 'Campaign paused — no usable Gmail accounts remain. Check your accounts and resume.',
            });
            return;
          }
          await sleep(perAccountDelayMs);
          continue;
        }

        const waitMs = Math.max(perAccountDelayMs, Math.min(...resets) + 1000);
        consecutiveNoAccount = 0;

        await scheduleRecipientRetry(recipient._id, claimToken, {
          nextRetryAt: new Date(Date.now() + waitMs),
          errorMessage: 'All accounts at their send limit — waiting for the limit to reset',
        });

        await writeLog({
          campaignId,
          level: 'warning',
          action: 'account_limit_reached',
          message: `All Gmail accounts are at their send limit. Waiting ${Math.round(waitMs / 60000)} min for the next reset — the campaign will continue on its own.`,
          details: { wait_ms: waitMs },
        });

        // Sleep in chunks so pause/stop/shutdown are still observed while waiting.
        const until = Date.now() + waitMs;
        while (Date.now() < until && !isShuttingDown()) {
          await sleep(Math.min(30000, until - Date.now()));
          const check = await Campaign.findById(campaignId).select('status');
          if (!check || check.status !== 'sending') break;
        }
        continue;
      }

      consecutiveNoAccount = 0;
      const attemptStarted = Date.now();

      await writeLog({
        campaignId,
        recipientId: recipient._id,
        gmailAccountId: account._id,
        level: 'info',
        action: 'send_attempt',
        message: `Sending to ${recipient.email} (attempt ${recipient.attempt_count})`,
        recipientEmail: recipient.email,
        details: {
          attempt: recipient.attempt_count,
          max_retries: sendConfig.maxRetriesPerRecipient,
          account: account.email,
          worker_id: workerId,
        },
      });

      try {
        const info = await sendCampaignEmail(
          account,
          { name: recipient.name, email: recipient.email },
          campaign.subject,
          campaign.body,
          attachments
        );

        const durationMs = Date.now() - attemptStarted;

        // ---------------------------------------------------------------
        // Gmail has ACCEPTED the message. From here to the end of the success
        // path, nothing may throw into the catch below: that catch treats any
        // exception as a send failure and reschedules the recipient, which
        // would deliver a second copy to someone who already received one.
        //
        // Previously writeLog() ran first and does throw (SendLog.create), so a
        // transient Atlas blip — or an action missing from the SendLog enum —
        // produced exactly that duplicate. Finalize first, then treat all
        // bookkeeping as best-effort.
        // ---------------------------------------------------------------
        const successLog = {
          campaignId,
          recipientId: recipient._id,
          gmailAccountId: account._id,
          level: 'success',
          action: 'send_success',
          message: `Email delivered to ${recipient.email}`,
          recipientEmail: recipient.email,
          details: {
            message_id: info.messageId,
            account: account.email,
            attempt: recipient.attempt_count,
            duration_ms: durationMs,
            response: info.response,
            subject: campaign.subject,
            attachment_count: attachments.length,
          },
        };

        let updated;
        try {
          updated = await finalizeRecipient(recipient._id, claimToken, {
            status: 'sent',
            sent_at: new Date(),
            gmail_account_id: account._id,
            message_id: info.messageId || null,
            error_message: null,
            claim_token: null,
            claimed_at: null,
            claimed_by: null,
          });
        } catch (finalizeErr) {
          // We cannot record the terminal state. Do NOT fall through to the
          // failure branch — retrying would re-send. Write the success marker
          // that reconcileOrphanedSends keys off so recovery can settle this
          // recipient, and leave it claimed for that sweep.
          console.error(
            `[campaign ${campaignId}] sent to ${recipient.email} but could not finalize:`,
            finalizeErr.message
          );
          await writeLog(successLog).catch(() => {});
          continue;
        }

        rotator.markSent(account);
        await recordAccountSend(account).catch((e) =>
          console.error('recordAccountSend failed:', e.message)
        );
        await writeLog(successLog).catch((e) =>
          console.error('send_success log failed:', e.message)
        );

        if (updated) {
          // Charge exactly once — only the worker that wins the finalize consumes
          // the credit. A lost claim means another worker already accounted for it.
          const charge = await consumeSendQuota(campaign.user_id, campaignId);

          // The reservation promised these credits and the balance did not have
          // them. This recipient has already been emailed; continuing would send
          // the rest of the list free of charge, silently. Stop here so the
          // damage is one email instead of the whole campaign.
          if (charge && charge.charged === false) {
            const c = await Campaign.findById(campaignId);
            if (c && c.status === 'sending') {
              c.status = 'paused';
              await c.save();
            }
            await writeLog({
              campaignId,
              level: 'error',
              action: 'campaign_pause',
              message: 'Campaign paused — your credit balance ran out mid-send. Top up and resume to continue.',
              details: { shortfall: charge.shortfall, worker_id: workerId },
            });
            return;
          }
        } else {
          await writeLog({
            campaignId,
            recipientId: recipient._id,
            level: 'warning',
            action: 'duplicate_prevented',
            message: `Send to ${recipient.email} completed but claim was lost — duplicate prevented`,
            recipientEmail: recipient.email,
            details: { message_id: info.messageId },
          });
        }

        emailsSinceSync += 1;
        if (emailsSinceSync >= sendConfig.progressSyncEvery) {
          await syncCampaignCounters(campaignId);
          emailsSinceSync = 0;
        }
      } catch (err) {
        const durationMs = Date.now() - attemptStarted;
        const rateLimited = isRateLimitError(err);
        const errorClass = classifySendError(err);
        const canRetry =
          recipient.attempt_count < sendConfig.maxRetriesPerRecipient &&
          (rateLimited || errorClass === 'transient' || errorClass === 'unknown');

        // A rejected App Password is an account problem, not a recipient problem.
        // Retrying or advancing through the list would fail identically on every
        // contact, so pull the account out of rotation and give the recipient back
        // to the queue untouched. If that was the last usable account, pause rather
        // than marking the whole list failed — the user can fix the password and
        // resume without re-sending to anyone.
        if (isAuthError(err)) {
          const remaining = rotator.disableForRun(account);

          await writeLog({
            campaignId,
            recipientId: recipient._id,
            gmailAccountId: account._id,
            level: 'error',
            action: 'account_auth_failed',
            message: describeSendError(err, { accountEmail: account.email }),
            recipientEmail: recipient.email,
            details: {
              error: err.message,
              code: err.code,
              responseCode: err.responseCode,
              account: account.email,
              accounts_remaining: remaining,
              duration_ms: durationMs,
            },
          });

          await CampaignRecipient.findOneAndUpdate(
            { _id: recipient._id, claim_token: claimToken },
            {
              $set: {
                status: 'pending',
                claim_token: null,
                claimed_at: null,
                claimed_by: null,
                next_retry_at: null,
              },
              $inc: { attempt_count: -1 },
            }
          );

          if (remaining > 0) continue;

          const stalled = await Campaign.findById(campaignId);
          if (stalled) {
            stalled.status = 'paused';
            await stalled.save();
          }
          await writeLog({
            campaignId,
            level: 'error',
            action: 'campaign_pause',
            message: `Campaign paused — ${describeSendError(err, { accountEmail: account.email })}`,
          });
          return;
        }

        if (rateLimited) {
          const prevAccountId = account._id.toString();
          await markAccountLimitReached(account, err.message);

          await writeLog({
            campaignId,
            recipientId: recipient._id,
            gmailAccountId: account._id,
            level: 'warning',
            action: 'account_limit_reached',
            message: `Account ${account.email} hit rate limit: ${err.message}`,
            recipientEmail: recipient.email,
            details: { error: err.message, duration_ms: durationMs },
          });

          const nextAccount = await rotator.nextReadyAccount(sleep);
          if (nextAccount && nextAccount._id.toString() !== prevAccountId) {
            await writeLog({
              campaignId,
              level: 'info',
              action: 'account_rotated',
              message: `Rotated from ${account.email} to ${nextAccount.email}`,
              details: { from: account.email, to: nextAccount.email },
            });

            await CampaignRecipient.findOneAndUpdate(
              { _id: recipient._id, claim_token: claimToken },
              {
                $set: {
                  status: 'pending',
                  claim_token: null,
                  claimed_at: null,
                  claimed_by: null,
                  next_retry_at: null,
                },
                $inc: { attempt_count: -1 },
              }
            );
            continue;
          }
        }

        if (canRetry) {
          const retryDelay = computeRetryDelay(recipient.attempt_count);
          const nextRetryAt = new Date(Date.now() + retryDelay);

          await scheduleRecipientRetry(recipient._id, claimToken, {
            nextRetryAt,
            errorMessage: err.message,
          });

          await writeLog({
            campaignId,
            recipientId: recipient._id,
            gmailAccountId: account._id,
            level: 'warning',
            action: 'send_retry',
            message: `Retry scheduled for ${recipient.email} in ${retryDelay}ms (attempt ${recipient.attempt_count}/${sendConfig.maxRetriesPerRecipient})`,
            recipientEmail: recipient.email,
            details: {
              error: err.message,
              code: err.code,
              responseCode: err.responseCode,
              error_class: errorClass,
              rate_limited: rateLimited,
              retry_delay_ms: retryDelay,
              next_retry_at: nextRetryAt,
              duration_ms: durationMs,
            },
          });
        } else {
          const finalized = await finalizeRecipient(recipient._id, claimToken, {
            status: 'failed',
            error_message: describeSendError(err, { accountEmail: account.email }),
            gmail_account_id: account._id,
            claim_token: null,
            claimed_at: null,
            claimed_by: null,
          });

          // Only refund if this worker actually owned the outcome. A lost claim
          // means recovery already handed the recipient to another worker, which
          // released (or spent) the reservation itself — refunding again here
          // credits the user for a slot that no longer exists, and the resulting
          // drift is exactly what makes consumeSendQuota come up short later.
          // The success path above and the certificate engine both already gate
          // on this; this was the one place that did not.
          if (finalized) {
            await releaseUnsentQuotaSlot(campaign.user_id, campaignId);
          }

          await writeLog({
            campaignId,
            recipientId: recipient._id,
            gmailAccountId: account._id,
            level: 'error',
            action: 'send_failed',
            message: `Failed to send to ${recipient.email}: ${err.message}`,
            recipientEmail: recipient.email,
            details: {
              error: err.message,
              code: err.code,
              responseCode: err.responseCode,
              error_class: errorClass,
              rate_limited: rateLimited,
              attempt: recipient.attempt_count,
              max_retries: sendConfig.maxRetriesPerRecipient,
              duration_ms: durationMs,
            },
          });

          emailsSinceSync += 1;
        }
      }

      // Per-account cooldown is enforced in nextReadyAccount; no extra global delay.
    }

    await syncCampaignCounters(campaignId);

    const counts = await CampaignRecipient.aggregate([
      { $match: { campaign_id: new mongoose.Types.ObjectId(campaignId) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);
    const byStatus = Object.fromEntries(counts.map((c) => [c._id, c.count]));
    const pending = byStatus.pending ?? 0;
    const sending = byStatus.sending ?? 0;
    const failed = byStatus.failed ?? 0;
    const total = Object.values(byStatus).reduce((s, n) => s + n, 0);

    const refreshed = await Campaign.findById(campaignId);
    if (
      pending === 0 &&
      sending === 0 &&
      refreshed &&
      refreshed.status !== 'paused' &&
      refreshed.status !== 'stopped'
    ) {
      refreshed.status = failed === total ? 'failed' : 'completed';
      refreshed.completed_at = new Date();
      await refreshed.save();

      await writeLog({
        campaignId,
        level: failed > 0 ? 'warning' : 'success',
        action: 'campaign_complete',
        message: `Campaign completed. Sent: ${refreshed.sent_count}, Failed: ${refreshed.failed_count}, Skipped: ${refreshed.skipped_count ?? 0}`,
        details: {
          sent: refreshed.sent_count,
          failed: refreshed.failed_count,
          skipped: refreshed.skipped_count ?? 0,
          pending: 0,
          total: refreshed.total_recipients,
        },
      });
    }

    await releaseCampaignQuota(campaign.user_id, campaignId);
  } catch (err) {
    // Nothing awaits this promise (it lives in `activeJobs`), so without this
    // catch any rejection in the loop — a transient Atlas blip inside writeLog,
    // a claim query timing out — becomes an unhandled rejection and Node
    // terminates the whole API process, not just this campaign.
    //
    // Park the campaign in `paused` rather than `failed`: pausing is resumable
    // from the UI, so a blip costs the user one click instead of the campaign.
    console.error(`[campaign ${campaignId}] send loop error:`, err);
    await Campaign.updateOne(
      { _id: campaignId, status: 'sending' },
      { $set: { status: 'paused' } }
    ).catch(() => {});
    await writeLog({
      campaignId,
      level: 'error',
      action: 'campaign_pause',
      message: `Campaign paused after an unexpected error: ${err.message}`,
      details: { error: err.message, worker_id: workerId },
    }).catch(() => {});
  } finally {
    // Every early return above (pause, stop, shutdown, exhausted accounts,
    // credit shortfall, auth failure, unexpected error) used to skip the
    // counter sync, leaving Campaign.sent_count up to progressSyncEvery behind
    // the real recipient rows for as long as the campaign sat paused.
    try {
      await syncCampaignCounters(campaignId);
    } catch (err) {
      if (mongoose.connection.readyState === 1) {
        console.error('Failed to sync campaign counters:', err.message);
      }
    }

    // Release pooled SMTP connections held for this run.
    closeAllTransports();

    try {
      await releaseCampaignLock(campaignId, workerId);
    } catch (err) {
      if (mongoose.connection.readyState === 1) {
        console.error('Failed to release campaign lock:', err.message);
      }
    }
  }
}
