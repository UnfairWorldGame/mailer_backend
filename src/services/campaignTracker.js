import crypto from 'crypto';
import os from 'os';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import SendLog from '../models/SendLog.js';
import { sendConfig } from '../config/sendConfig.js';

let workerId = null;

export function getWorkerId() {
  if (!workerId) {
    workerId = `${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  }
  return workerId;
}

export async function getCampaignProgress(campaignId) {
  const [campaign, statusCounts] = await Promise.all([
    Campaign.findById(campaignId).select(
      'status total_recipients sent_count failed_count started_at completed_at updated_at'
    ),
    CampaignRecipient.aggregate([
      { $match: { campaign_id: new mongoose.Types.ObjectId(campaignId) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
  ]);

  if (!campaign) return null;

  const counts = {
    total: campaign.total_recipients,
    sent: 0,
    pending: 0,
    failed: 0,
    skipped: 0,
    sending: 0,
  };

  for (const row of statusCounts) {
    if (row._id in counts) counts[row._id] = row.count;
  }

  const processed = counts.sent + counts.failed + counts.skipped;
  const remaining = counts.pending + counts.sending;

  return {
    campaign_id: campaignId.toString(),
    status: campaign.status,
    counts,
    progress_percent: counts.total > 0 ? Math.round((processed / counts.total) * 100) : 0,
    remaining,
    started_at: campaign.started_at,
    completed_at: campaign.completed_at,
    updated_at: campaign.updated_at,
    is_running: campaign.status === 'sending',
  };
}

export async function syncCampaignCounters(campaignId) {
  const [sent, failed, pending, skipped, sending] = await Promise.all([
    CampaignRecipient.countDocuments({ campaign_id: campaignId, status: 'sent' }),
    CampaignRecipient.countDocuments({ campaign_id: campaignId, status: 'failed' }),
    CampaignRecipient.countDocuments({ campaign_id: campaignId, status: 'pending' }),
    CampaignRecipient.countDocuments({ campaign_id: campaignId, status: 'skipped' }),
    CampaignRecipient.countDocuments({ campaign_id: campaignId, status: 'sending' }),
  ]);

  await Campaign.findByIdAndUpdate(campaignId, {
    sent_count: sent,
    failed_count: failed,
    pending_count: pending,
    skipped_count: skipped,
    sending_count: sending,
    last_progress_at: new Date(),
  });

  return { sent, failed, pending, skipped, sending };
}

export async function tryAcquireCampaignLock(campaignId, worker) {
  const staleBefore = new Date(Date.now() - sendConfig.campaignLockStaleMs);
  const now = new Date();

  const campaign = await Campaign.findOneAndUpdate(
    {
      _id: campaignId,
      status: 'sending',
      $or: [
        { worker_id: null },
        { worker_id: worker },
        { worker_locked_at: { $lt: staleBefore } },
      ],
    },
    {
      $set: {
        worker_id: worker,
        worker_locked_at: now,
      },
    },
    { new: true }
  );

  return campaign;
}

export async function releaseCampaignLock(campaignId, worker) {
  await Campaign.findOneAndUpdate(
    { _id: campaignId, worker_id: worker },
    { $set: { worker_id: null, worker_locked_at: null } }
  );
}

export async function recoverStaleCampaignLocks() {
  const staleBefore = new Date(Date.now() - sendConfig.campaignLockStaleMs);
  const result = await Campaign.updateMany(
    {
      status: 'sending',
      worker_locked_at: { $lt: staleBefore },
      worker_id: { $ne: null },
    },
    { $set: { worker_id: null, worker_locked_at: null } }
  );
  return result.modifiedCount;
}

export async function recoverStaleRecipients(campaignId, { writeLog } = {}) {
  const staleBefore = new Date(Date.now() - sendConfig.claimStaleMs);

  const stale = await CampaignRecipient.find({
    campaign_id: campaignId,
    status: 'sending',
    claimed_at: { $lt: staleBefore },
  });

  let recovered = 0;
  for (const recipient of stale) {
    const successLog = await SendLog.findOne({
      campaign_id: campaignId,
      recipient_id: recipient._id,
      action: 'send_success',
    }).sort({ created_at: -1 });

    if (successLog?.details?.message_id) {
      recipient.status = 'sent';
      recipient.message_id = successLog.details.message_id;
      recipient.sent_at = successLog.created_at;
      recipient.error_message = null;
      recipient.claim_token = null;
      recipient.claimed_at = null;
      recipient.claimed_by = null;
      await recipient.save();
      recovered += 1;

      if (writeLog) {
        await writeLog({
          campaignId,
          recipientId: recipient._id,
          level: 'info',
          action: 'recipient_recovered',
          message: `Marked ${recipient.email} as sent from prior success log (crash recovery)`,
          recipientEmail: recipient.email,
          details: { message_id: successLog.details.message_id },
        });
      }
      continue;
    }

    recipient.status = 'pending';
    recipient.claim_token = null;
    recipient.claimed_at = null;
    recipient.claimed_by = null;
    await recipient.save();
    recovered += 1;

    if (writeLog) {
      await writeLog({
        campaignId,
        recipientId: recipient._id,
        level: 'warning',
        action: 'recipient_recovered',
        message: `Recovered stale send claim for ${recipient.email} — will retry`,
        recipientEmail: recipient.email,
      });
    }
  }

  if (recovered > 0) {
    await syncCampaignCounters(campaignId);
  }

  return recovered;
}

export async function reconcileOrphanedSends(campaignId, { writeLog } = {}) {
  const candidates = await CampaignRecipient.find({
    campaign_id: campaignId,
    status: { $in: ['pending', 'sending'] },
  }).select('_id email status');

  let reconciled = 0;
  for (const recipient of candidates) {
    const successLog = await SendLog.findOne({
      campaign_id: campaignId,
      recipient_id: recipient._id,
      action: 'send_success',
    }).sort({ created_at: -1 });

    if (!successLog) continue;

    await CampaignRecipient.findOneAndUpdate(
      { _id: recipient._id, status: { $in: ['pending', 'sending'] } },
      {
        $set: {
          status: 'sent',
          message_id: successLog.details?.message_id || null,
          sent_at: successLog.created_at,
          error_message: null,
          claim_token: null,
          claimed_at: null,
          claimed_by: null,
        },
      }
    );

    reconciled += 1;
    if (writeLog) {
      await writeLog({
        campaignId,
        recipientId: recipient._id,
        level: 'info',
        action: 'duplicate_prevented',
        message: `Skipped resend to ${recipient.email} — already delivered (log reconciliation)`,
        recipientEmail: recipient.email,
        details: { message_id: successLog.details?.message_id },
      });
    }
  }

  if (reconciled > 0) {
    await syncCampaignCounters(campaignId);
  }

  return reconciled;
}

export async function claimNextRecipient(campaignId, worker) {
  const now = new Date();

  const recipient = await CampaignRecipient.findOneAndUpdate(
    {
      campaign_id: campaignId,
      status: 'pending',
      $or: [{ next_retry_at: null }, { next_retry_at: { $lte: now } }],
    },
    {
      $set: {
        status: 'sending',
        claim_token: crypto.randomBytes(16).toString('hex'),
        claimed_at: now,
        claimed_by: worker,
      },
      $inc: { attempt_count: 1 },
      $unset: { next_retry_at: '' },
    },
    { sort: { created_at: 1 }, new: true }
  );

  if (recipient) {
    recipient.last_attempt_at = now;
    await recipient.save();
  }

  return recipient;
}

export async function finalizeRecipient(recipientId, claimToken, updates) {
  return CampaignRecipient.findOneAndUpdate(
    {
      _id: recipientId,
      status: 'sending',
      claim_token: claimToken,
    },
    { $set: updates },
    { new: true }
  );
}

export async function scheduleRecipientRetry(recipientId, claimToken, { nextRetryAt, errorMessage }) {
  return CampaignRecipient.findOneAndUpdate(
    {
      _id: recipientId,
      status: 'sending',
      claim_token: claimToken,
    },
    {
      $set: {
        status: 'pending',
        next_retry_at: nextRetryAt,
        error_message: errorMessage,
        claim_token: null,
        claimed_at: null,
        claimed_by: null,
      },
    },
    { new: true }
  );
}

export function computeRetryDelay(attemptCount) {
  const base = sendConfig.retryBaseDelayMs;
  const max = sendConfig.retryMaxDelayMs;
  const delay = base * Math.pow(2, Math.max(0, attemptCount - 1));
  return Math.min(delay, max);
}

export async function resetFailedRecipients(campaignId, { maxRetries = null } = {}) {
  const filter = { campaign_id: campaignId, status: 'failed' };
  if (maxRetries !== null) {
    filter.attempt_count = { $lt: maxRetries };
  }

  const result = await CampaignRecipient.updateMany(filter, {
    $set: {
      status: 'pending',
      error_message: null,
      claim_token: null,
      claimed_at: null,
      claimed_by: null,
      next_retry_at: null,
    },
  });

  if (result.modifiedCount > 0) {
    await syncCampaignCounters(campaignId);
  }

  return result.modifiedCount;
}
