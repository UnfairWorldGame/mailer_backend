import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import Contact from '../models/Contact.js';
import GmailAccount from '../models/GmailAccount.js';
import SendLog from '../models/SendLog.js';
import { pdfUpload } from '../middleware/pdfUpload.js';
import { startCampaignSend, isCampaignRunning } from '../services/sendEngine.js';
import { getCampaignLogs, getCampaignLogCount, getRecipientLogs } from '../services/logService.js';
import { getCampaignProgress, resetFailedRecipients, syncCampaignCounters } from '../services/campaignTracker.js';
import { requireAuth } from '../middleware/auth.js';
import { toApiDoc, toApiDocs } from '../utils/apiTransform.js';
import { ownerFilter } from '../utils/userScope.js';
import { sendConfig, resolvePerAccountDelayMs } from '../config/sendConfig.js';
import {
  reserveCampaignQuota,
  releaseCampaignQuota,
  countOutstandingRecipients,
  QuotaError,
} from '../services/quotaService.js';

const router = Router();
router.use(requireAuth);

async function findOwnedCampaign(userId, id) {
  if (!mongoose.isValidObjectId(id)) return null;
  return Campaign.findOne(ownerFilter(userId, { _id: id }));
}

function formatAttachment(att, campaignId) {
  return {
    id: att._id.toString(),
    campaign_id: campaignId,
    original_name: att.original_name,
    file_size: att.file_size,
    mime_type: att.mime_type,
    created_at: att.created_at,
  };
}

async function enrichCampaign(campaign, userId) {
  const owner = ownerFilter(userId);
  let account = campaign.gmail_account_id
    ? await GmailAccount.findOne({ ...owner, _id: campaign.gmail_account_id }).select('label email')
    : null;

  if (!account && campaign.rotate_accounts !== false) {
    account = await GmailAccount.findOne({ ...owner, is_active: true }).sort({ created_at: 1 }).select('label email');
  }

  return toApiDoc(campaign, {
    gmail_account_id: campaign.gmail_account_id?.toString() ?? null,
    account_label: account?.label ?? null,
    account_email: account?.email ?? null,
    attachments: (campaign.attachments || []).map((a) => formatAttachment(a, campaign._id.toString())),
  });
}

router.get('/', async (req, res, next) => {
  try {
    const { search, status, page = '1', limit = '50' } = req.query;
    const filter = ownerFilter(req.user.id);

    if (status && status !== 'all') {
      filter.status = status;
    }

    if (search?.trim()) {
      const q = search.trim();
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { subject: { $regex: q, $options: 'i' } },
      ];
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10)));
    const skip = (pageNum - 1) * limitNum;

    const [campaigns, total] = await Promise.all([
      Campaign.find(filter).sort({ created_at: -1 }).skip(skip).limit(limitNum),
      Campaign.countDocuments(filter),
    ]);

    const enriched = await Promise.all(campaigns.map((c) => enrichCampaign(c, req.user.id)));
    res.json({ data: enriched, total, page: pageNum, limit: limitNum });
  } catch (err) {
    next(err);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const owner = ownerFilter(req.user.id);
    const [total, draft, sending, completed, failed, paused, stopped, totalContacts, totalAccounts] = await Promise.all([
      Campaign.countDocuments(owner),
      Campaign.countDocuments({ ...owner, status: 'draft' }),
      Campaign.countDocuments({ ...owner, status: 'sending' }),
      Campaign.countDocuments({ ...owner, status: 'completed' }),
      Campaign.countDocuments({ ...owner, status: 'failed' }),
      Campaign.countDocuments({ ...owner, status: 'paused' }),
      Campaign.countDocuments({ ...owner, status: 'stopped' }),
      Contact.countDocuments(owner),
      GmailAccount.countDocuments(owner),
    ]);

    res.json({ total, draft, sending, completed, failed, paused, stopped, totalContacts, totalAccounts });
  } catch (err) {
    next(err);
  }
});

router.get('/config/send', async (req, res, next) => {
  try {
    const activeAccounts = await GmailAccount.countDocuments(
      ownerFilter(req.user.id, { is_active: true })
    );
    res.json({
      per_account_delay_ms: sendConfig.perAccountDelayMs,
      default_delay_ms: resolvePerAccountDelayMs(),
      active_account_count: activeAccounts,
      min_delay_ms: sendConfig.minDelayMs,
      max_delay_ms: sendConfig.maxDelayMs,
      daily_limit_per_account: sendConfig.dailyLimitPerAccount,
      hourly_limit_per_account: sendConfig.hourlyLimitPerAccount,
      max_retries_per_recipient: sendConfig.maxRetriesPerRecipient,
      retry_base_delay_ms: sendConfig.retryBaseDelayMs,
      claim_stale_ms: sendConfig.claimStaleMs,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/progress', async (req, res, next) => {
  try {
    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const progress = await getCampaignProgress(req.params.id);
    if (!progress) return res.status(404).json({ error: 'Campaign not found' });

    res.json({
      ...progress,
      running: isCampaignRunning(req.params.id),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const recipients = await CampaignRecipient.find({ campaign_id: campaign._id }).sort({ created_at: 1 });
    const enriched = await enrichCampaign(campaign, req.user.id);

    res.json({
      ...enriched,
      recipients: toApiDocs(recipients).map((r) => ({
        ...r,
        campaign_id: r.campaign_id?.toString(),
        contact_id: r.contact_id?.toString(),
        gmail_account_id: r.gmail_account_id?.toString() ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/logs', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
    const skip = parseInt(req.query.skip || '0', 10);
    const filters = {
      action: req.query.action || undefined,
      level: req.query.level || undefined,
      recipientEmail: req.query.recipient_email || undefined,
    };
    const [logs, total] = await Promise.all([
      getCampaignLogs(req.params.id, { limit, skip, ...filters }),
      getCampaignLogCount(req.params.id, filters),
    ]);

    res.json({ logs, total, limit, skip });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const {
      name,
      subject,
      body,
      gmail_account_id,
      contact_ids,
      send_delay_ms,
      rotate_accounts,
    } = req.body;

    if (!name?.trim() || !subject?.trim() || !body?.trim()) {
      return res.status(400).json({ error: 'Name, subject, and body are required' });
    }

    if (gmail_account_id) {
      if (!mongoose.isValidObjectId(gmail_account_id)) {
        return res.status(400).json({ error: 'Invalid Gmail account' });
      }
      const account = await GmailAccount.findOne(ownerFilter(req.user.id, { _id: gmail_account_id, is_active: true }));
      if (!account) {
        return res.status(400).json({ error: 'Invalid or inactive Gmail account' });
      }
    }

    const contactFilter = ownerFilter(req.user.id);
    let contacts;
    if (contact_ids?.length > 0) {
      contacts = await Contact.find({ ...contactFilter, _id: { $in: contact_ids } });
    } else {
      contacts = await Contact.find(contactFilter);
    }

    if (contacts.length === 0) {
      return res.status(400).json({ error: 'No contacts available for this campaign' });
    }

    const campaign = await Campaign.create({
      user_id: req.user.id,
      name: name.trim(),
      subject: subject.trim(),
      body: body.trim(),
      gmail_account_id: gmail_account_id || null,
      send_delay_ms: send_delay_ms ?? null,
      rotate_accounts: rotate_accounts !== false,
      total_recipients: contacts.length,
      status: 'draft',
    });

    await CampaignRecipient.insertMany(
      contacts.map((c) => ({
        campaign_id: campaign._id,
        contact_id: c._id,
        name: c.name || '',
        email: c.email,
        status: 'pending',
      }))
    );

    await syncCampaignCounters(campaign._id);

    const enriched = await enrichCampaign(campaign, req.user.id);
    res.status(201).json(enriched);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (!['draft', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Only draft or paused campaigns can be edited' });
    }

    const { name, subject, body, gmail_account_id, send_delay_ms, rotate_accounts } = req.body;

    if (name !== undefined) campaign.name = name.trim();
    if (subject !== undefined) campaign.subject = subject.trim();
    if (body !== undefined) campaign.body = body.trim();
    if (send_delay_ms !== undefined) campaign.send_delay_ms = send_delay_ms;
    if (rotate_accounts !== undefined) campaign.rotate_accounts = Boolean(rotate_accounts);

    if (gmail_account_id !== undefined) {
      if (gmail_account_id) {
        if (!mongoose.isValidObjectId(gmail_account_id)) {
          return res.status(400).json({ error: 'Invalid Gmail account' });
        }
        const account = await GmailAccount.findOne(ownerFilter(req.user.id, { _id: gmail_account_id }));
        if (!account) return res.status(400).json({ error: 'Invalid Gmail account' });
        campaign.gmail_account_id = gmail_account_id;
      } else {
        campaign.gmail_account_id = null;
      }
    }

    await campaign.save();
    res.json(await enrichCampaign(campaign, req.user.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    for (const att of campaign.attachments || []) {
      fs.unlink(att.file_path, () => {});
    }

    await CampaignRecipient.deleteMany({ campaign_id: campaign._id });
    await SendLog.deleteMany({ campaign_id: campaign._id });
    await Campaign.findByIdAndDelete(campaign._id);

    res.json({ message: 'Campaign deleted' });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/attachments', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    res.json((campaign.attachments || []).map((a) => formatAttachment(a, campaign._id.toString())));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/attachments', pdfUpload.array('files', 10), async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      for (const f of req.files || []) fs.unlink(f.path, () => {});
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) {
      for (const f of req.files || []) fs.unlink(f.path, () => {});
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (!['draft', 'paused'].includes(campaign.status)) {
      for (const f of req.files || []) fs.unlink(f.path, () => {});
      return res.status(400).json({ error: 'Cannot add attachments to a campaign that is already sending or completed' });
    }

    if (!req.files?.length) {
      return res.status(400).json({ error: 'No PDF files uploaded' });
    }

    const newAttachments = req.files.map((file) => ({
      original_name: file.originalname,
      stored_name: file.filename,
      file_path: file.path,
      file_size: file.size,
      mime_type: file.mimetype || 'application/pdf',
    }));

    campaign.attachments.push(...newAttachments);
    await campaign.save();

    const created = newAttachments.map((a, i) => {
      const saved = campaign.attachments[campaign.attachments.length - newAttachments.length + i];
      return formatAttachment(saved, campaign._id.toString());
    });

    res.status(201).json(created);
  } catch (err) {
    for (const f of req.files || []) fs.unlink(f.path, () => {});
    next(err);
  }
});

router.get('/:id/attachments/:attachmentId/download', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.attachmentId)) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const attachment = campaign.attachments.id(req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    if (!fs.existsSync(attachment.file_path)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    res.setHeader('Content-Type', attachment.mime_type || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${attachment.original_name}"`);
    res.sendFile(path.resolve(attachment.file_path));
  } catch (err) {
    next(err);
  }
});

router.delete('/:id/attachments/:attachmentId', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.attachmentId)) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (!['draft', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Cannot remove attachments from this campaign' });
    }

    const attachment = campaign.attachments.id(req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    fs.unlink(attachment.file_path, () => {});
    campaign.attachments.pull(req.params.attachmentId);
    await campaign.save();

    res.json({ message: 'Attachment deleted' });
  } catch (err) {
    next(err);
  }
});

router.get('/:id/recipients/:recipientId/logs', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.recipientId)) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const recipient = await CampaignRecipient.findOne({
      _id: req.params.recipientId,
      campaign_id: req.params.id,
    });
    if (!recipient) return res.status(404).json({ error: 'Recipient not found' });

    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const logs = await getRecipientLogs(req.params.id, req.params.recipientId, { limit });
    res.json({ logs, recipient: toApiDoc(recipient) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/retry-failed', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (!['completed', 'failed', 'paused', 'stopped', 'sending'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Cannot retry failed emails for a draft campaign' });
    }

    const { reset_attempts: resetAttempts } = req.body || {};
    if (resetAttempts) {
      await CampaignRecipient.updateMany(
        { campaign_id: campaign._id, status: 'failed' },
        { $set: { attempt_count: 0 } }
      );
    }

    const retried = await resetFailedRecipients(campaign._id);

    if (retried === 0) {
      return res.status(400).json({ error: 'No failed recipients to retry' });
    }

    try {
      const outstanding = await countOutstandingRecipients(campaign._id);
      await reserveCampaignQuota(req.user.id, campaign._id, outstanding);
    } catch (err) {
      if (err instanceof QuotaError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    if (campaign.status !== 'sending') {
      campaign.status = 'sending';
      campaign.completed_at = null;
      await campaign.save();
      await startCampaignSend(campaign._id);
    }

    res.json({
      message: `Queued ${retried} failed recipient(s) for retry`,
      retried_count: retried,
      id: campaign._id.toString(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/send', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (!['draft'].includes(campaign.status)) {
      return res.status(400).json({ error: `Cannot start campaign with status: ${campaign.status}. Use resume for paused/stopped campaigns.` });
    }

    const activeAccounts = await GmailAccount.countDocuments(ownerFilter(req.user.id, { is_active: true }));
    if (activeAccounts === 0) {
      return res.status(400).json({ error: 'No active Gmail accounts available. Add at least one account.' });
    }

    if (!campaign.gmail_account_id && campaign.rotate_accounts === false) {
      return res.status(400).json({ error: 'Please assign a Gmail account or enable account rotation' });
    }

    const outstanding = await countOutstandingRecipients(campaign._id);
    if (outstanding === 0) {
      return res.status(400).json({ error: 'No pending recipients to send' });
    }

    try {
      await reserveCampaignQuota(req.user.id, campaign._id, outstanding);
    } catch (err) {
      if (err instanceof QuotaError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    campaign.status = 'sending';
    campaign.started_at = campaign.started_at || new Date();
    await campaign.save();

    const result = await startCampaignSend(campaign._id);

    res.json({
      message: result.alreadyRunning ? 'Campaign is already sending' : 'Campaign sending started',
      id: campaign._id.toString(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/pause', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (campaign.status !== 'sending') {
      return res.status(400).json({ error: 'Only sending campaigns can be paused' });
    }

    campaign.status = 'paused';
    await campaign.save();

    res.json({ message: 'Campaign paused', running: isCampaignRunning(campaign._id) });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/resume', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (!['paused', 'stopped'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Only paused or stopped campaigns can be resumed' });
    }

    const outstanding = await countOutstandingRecipients(campaign._id);
    if (outstanding === 0) {
      return res.status(400).json({ error: 'No pending recipients to send' });
    }

    const activeAccounts = await GmailAccount.countDocuments(ownerFilter(req.user.id, { is_active: true }));
    if (activeAccounts === 0) {
      return res.status(400).json({ error: 'No active Gmail accounts available' });
    }

    try {
      await reserveCampaignQuota(req.user.id, campaign._id, outstanding);
    } catch (err) {
      if (err instanceof QuotaError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    campaign.status = 'sending';
    await campaign.save();

    const result = await startCampaignSend(campaign._id);
    res.json({
      message: result.alreadyRunning ? 'Campaign is already sending' : 'Campaign resumed',
      id: campaign._id.toString(),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/stop', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    if (!['sending', 'paused'].includes(campaign.status)) {
      return res.status(400).json({ error: 'Only sending or paused campaigns can be stopped' });
    }

    campaign.status = 'stopped';
    await campaign.save();
    await releaseCampaignQuota(req.user.id, campaign._id);

    res.json({ message: 'Campaign stopped', id: campaign._id.toString() });
  } catch (err) {
    next(err);
  }
});

export default router;
