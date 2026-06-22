import Campaign from '../models/Campaign.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import GmailAccount from '../models/GmailAccount.js';
import mongoose from 'mongoose';
import { sendCampaignEmail } from './emailService.js';
import { writeLog } from './logService.js';
import {
  AccountRotator,
  isRateLimitError,
  markAccountLimitReached,
  recordAccountSend,
} from './accountRotator.js';
import { resolveDelayMs, sendConfig } from '../config/sendConfig.js';
import { classifySendError } from '../utils/errorClassifier.js';
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
} from './campaignTracker.js';

const activeJobs = new Map();
const workerId = getWorkerId();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isCampaignRunning(campaignId) {
  return activeJobs.has(campaignId.toString());
}

export async function startCampaignSend(campaignId) {
  const id = campaignId.toString();
  if (activeJobs.has(id)) {
    return { alreadyRunning: true };
  }

  const promise = processCampaign(id).finally(() => {
    activeJobs.delete(id);
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

    const accounts = await GmailAccount.find({ is_active: true });
    if (!accounts.length) {
      campaign.status = 'failed';
      await campaign.save();
      await writeLog({
        campaignId,
        level: 'error',
        action: 'no_accounts',
        message: 'No active Gmail accounts available for sending',
      });
      return;
    }

    const rotator = new AccountRotator(accounts, {
      preferredAccountId: campaign.gmail_account_id,
      rotate: campaign.rotate_accounts !== false,
    });

    const delayMs = resolveDelayMs(campaign.send_delay_ms);
    const attachments = campaign.attachments || [];
    let emailsSinceSync = 0;

    await writeLog({
      campaignId,
      level: 'info',
      action: 'campaign_start',
      message: `Campaign "${campaign.name}" started`,
      details: {
        worker_id: workerId,
        delay_ms: delayMs,
        rotate_accounts: campaign.rotate_accounts,
        attachment_count: attachments.length,
        max_retries: sendConfig.maxRetriesPerRecipient,
        available_accounts: rotator.orderedAccounts.map((a) => a.email),
      },
    });

    let consecutiveNoAccount = 0;

    while (true) {
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
        return;
      }

      if (current.worker_id && current.worker_id !== workerId) {
        await sleep(delayMs);
        continue;
      }

      const recipient = await claimNextRecipient(campaignId, workerId);
      if (!recipient) {
        const pendingRetry = await CampaignRecipient.countDocuments({
          campaign_id: campaignId,
          status: 'pending',
          next_retry_at: { $gt: new Date() },
        });
        if (pendingRetry > 0) {
          await sleep(Math.min(delayMs, 5000));
          continue;
        }
        break;
      }

      const claimToken = recipient.claim_token;
      let account = await rotator.nextAvailable();

      if (!account) {
        await scheduleRecipientRetry(recipient._id, claimToken, {
          nextRetryAt: new Date(Date.now() + delayMs * 5),
          errorMessage: 'All accounts exhausted — waiting for limits to reset',
        });

        consecutiveNoAccount += 1;
        await writeLog({
          campaignId,
          level: 'warning',
          action: 'account_limit_reached',
          message: 'All Gmail accounts have reached their send limits. Waiting before retry...',
          details: { wait_ms: delayMs * 5 },
        });

        if (consecutiveNoAccount >= 10) {
          const c = await Campaign.findById(campaignId);
          if (c) {
            c.status = 'paused';
            await c.save();
          }
          await writeLog({
            campaignId,
            level: 'error',
            action: 'campaign_pause',
            message: 'Campaign paused — all accounts exhausted. Resume after limits reset.',
          });
          return;
        }

        await sleep(delayMs * 5);
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

        await writeLog({
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
        });

        await recordAccountSend(account);

        const updated = await finalizeRecipient(recipient._id, claimToken, {
          status: 'sent',
          sent_at: new Date(),
          gmail_account_id: account._id,
          message_id: info.messageId || null,
          error_message: null,
          claim_token: null,
          claimed_at: null,
          claimed_by: null,
        });

        if (!updated) {
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

          const nextAccount = await rotator.nextAvailable();
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
          await finalizeRecipient(recipient._id, claimToken, {
            status: 'failed',
            error_message: err.message,
            gmail_account_id: account._id,
            claim_token: null,
            claimed_at: null,
            claimed_by: null,
          });

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

      await sleep(delayMs);
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
  } finally {
    try {
      await releaseCampaignLock(campaignId, workerId);
    } catch (err) {
      if (mongoose.connection.readyState === 1) {
        console.error('Failed to release campaign lock:', err.message);
      }
    }
  }
}
