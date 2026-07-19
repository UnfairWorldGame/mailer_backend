import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import Contact from '../models/Contact.js';
import GmailAccount from '../models/GmailAccount.js';
import SendLog from '../models/SendLog.js';
import { pdfUpload, resolveAttachmentPath } from '../middleware/pdfUpload.js';
import { hasPdfMagicBytes } from '../utils/fileSignature.js';
import { startCampaignSend, isCampaignRunning } from '../services/sendEngine.js';
import { getCampaignLogs, getCampaignLogCount, getRecipientLogs } from '../services/logService.js';
import { getCampaignProgress, resetFailedRecipients, syncCampaignCounters } from '../services/campaignTracker.js';
import {
  requireAuth,
  requireVerifiedEmail,
  requireAuthOrResourceToken,
  signResourceToken,
} from '../middleware/auth.js';
import { toApiDoc, toApiDocs } from '../utils/apiTransform.js';
import { sanitizeEmailHtml } from '../utils/sanitizeHtml.js';
import { ownerFilter } from '../utils/userScope.js';
import { sendConfig, resolvePerAccountDelayMs } from '../config/sendConfig.js';
import {
  reserveCampaignQuota,
  releaseCampaignQuota,
  countOutstandingRecipients,
  QuotaError,
} from '../services/quotaService.js';

const router = Router();
// Registered BEFORE the blanket requireAuth below — see the certificate preview
// route for the full explanation. In short: this route carries its own
// resource-token gate for <iframe>/new-tab previews that cannot set an
// Authorization header, and the blanket gate was rejecting them first.
router.get(
  '/:id/attachments/:attachmentId/download',
  requireAuthOrResourceToken((req) => `campaign:${req.params.id}:attachments`),
  async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id) || !mongoose.isValidObjectId(req.params.attachmentId)) {
      return res.status(404).json({ error: 'Attachment not found' });
    }

    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const attachment = campaign.attachments.id(req.params.attachmentId);
    if (!attachment) return res.status(404).json({ error: 'Attachment not found' });

    const attachmentPath = resolveAttachmentPath(attachment.file_path);
    if (!fs.existsSync(attachmentPath)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    // original_name is user-supplied (the uploaded file's name) — strip quotes/CR/LF
    // before embedding it in a header value, and percent-encode the UTF-8 variant.
    const rawName = attachment.original_name || 'attachment';
    const asciiName = rawName.replace(/["\r\n]/g, '');
    // Always application/pdf, never the stored (client-supplied) MIME. Uploads
    // are accepted on extension OR MIME and the magic-byte check only looks for
    // '%PDF-' somewhere in the first 1KB, so a file can carry mime_type
    // 'text/html' — echoing that back with `inline` served attacker HTML from
    // the API origin. nosniff stops the browser second-guessing us.
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`
    );
    res.sendFile(path.resolve(attachmentPath));
  } catch (err) {
    next(err);
  }
  }
);

router.use(requireAuth);

/** Per-campaign attachment ceiling — Gmail rejects oversized mail anyway. */
const MAX_ATTACHMENTS_PER_CAMPAIGN = 10;
const MAX_ATTACHMENT_BYTES_PER_CAMPAIGN = 25 * 1024 * 1024;

function escapeRegex(term) {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAX_NAME_LENGTH = 200;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 512 * 1024;

/**
 * Returns the trimmed, length-capped string, or null when the input is not a
 * usable string. Callers must treat null as a 400 rather than calling .trim()
 * directly: `{"name": 123}` used to throw a TypeError here and surface as a 500.
 */
function normalizeText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

/**
 * Campaign bodies were stored exactly as posted and mailed to third parties
 * unsanitized — sanitizeEmailHtml was only ever applied to AI-generated and
 * certificate bodies. The frontend sanitizes what it *renders*, which does not
 * help what lands in a recipient's inbox.
 */
function normalizeBody(value) {
  const trimmed = normalizeText(value, MAX_BODY_LENGTH);
  if (trimmed === null) return null;
  const clean = sanitizeEmailHtml(trimmed);
  return clean.trim() ? clean : null;
}

/**
 * Math.max(1, parseInt('abc')) is NaN, not 1 — NaN propagates through both
 * Math.max and Math.min, so a non-numeric ?page= reached Mongo as skip: NaN and
 * surfaced as a 500. Clamp explicitly and fall back to the default instead.
 */
function parsePositiveInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

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

    if (typeof search === 'string' && search.trim()) {
      // Escape before it reaches Mongo. Passing the raw query through let a
      // caller submit a catastrophically-backtracking pattern like (a+)+$ and
      // pin a mongod core; contactImport.js already escapes the same way.
      const q = escapeRegex(search.trim().slice(0, 100));
      filter.$or = [
        { name: { $regex: q, $options: 'i' } },
        { subject: { $regex: q, $options: 'i' } },
      ];
    }

    const pageNum = parsePositiveInt(page, 1, 1, Number.MAX_SAFE_INTEGER);
    const limitNum = parsePositiveInt(limit, 50, 1, 100);
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

    const limit = parsePositiveInt(req.query.limit, 100, 1, 500);
    const skip = parsePositiveInt(req.query.skip, 0, 0, Number.MAX_SAFE_INTEGER);
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

    const cleanName = normalizeText(name, MAX_NAME_LENGTH);
    const cleanSubject = normalizeText(subject, MAX_SUBJECT_LENGTH);
    const cleanBody = normalizeBody(body);

    if (!cleanName || !cleanSubject || !cleanBody) {
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
      name: cleanName,
      subject: cleanSubject,
      body: cleanBody,
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

    // Same normalization as POST. This path previously called .trim() straight
    // on the raw value, so a non-string field threw a TypeError (500), and it
    // skipped sanitization entirely.
    if (name !== undefined) {
      const clean = normalizeText(name, MAX_NAME_LENGTH);
      if (!clean) return res.status(400).json({ error: 'Campaign name is required' });
      campaign.name = clean;
    }
    if (subject !== undefined) {
      const clean = normalizeText(subject, MAX_SUBJECT_LENGTH);
      if (!clean) return res.status(400).json({ error: 'Subject is required' });
      campaign.subject = clean;
    }
    if (body !== undefined) {
      const clean = normalizeBody(body);
      if (!clean) return res.status(400).json({ error: 'Email body is required' });
      campaign.body = clean;
    }
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

    // Deleting a live campaign raced its own workers: the reservation was
    // released and the rows hard-deleted while the send loop was mid-flight, so
    // an email that had already gone out either lost its finalize claim (never
    // billed) or billed against a deleted campaign, double-decrementing
    // reserved_credits and leaving a ledger row pointing at nothing.
    // Stop first, then delete — the certificate flow already works this way.
    if (campaign.status === 'sending' || isCampaignRunning(campaign._id.toString())) {
      return res.status(409).json({
        error: 'This campaign is currently sending. Stop it first, then delete.',
        code: 'CAMPAIGN_SENDING',
      });
    }

    for (const att of campaign.attachments || []) {
      fs.unlink(resolveAttachmentPath(att.file_path), () => {});
    }

    await releaseCampaignQuota(req.user.id, campaign._id);
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

/**
 * Multer writes every part to disk before the handler runs, so when *it* fails
 * — a non-PDF in the batch, LIMIT_FILE_SIZE, a client abort — the handler never
 * executes and the bytes already written are orphaned forever (there is no
 * sweeper for the attachments directory). It also rejects with a bare Error, so
 * errorHandler turned routine user mistakes into 500 "Internal server error".
 * Clean up and translate to 400 here.
 */
function handleAttachmentUpload(req, res, next) {
  pdfUpload.array('files', MAX_ATTACHMENTS_PER_CAMPAIGN)(req, res, (err) => {
    if (!err) return next();

    for (const f of req.files || []) fs.unlink(f.path, () => {});

    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'Each PDF must be 25 MB or smaller' });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({
        error: `You can attach at most ${MAX_ATTACHMENTS_PER_CAMPAIGN} PDFs`,
      });
    }
    if (err.message === 'Only PDF files are allowed') {
      return res.status(400).json({ error: err.message });
    }
    return next(err);
  });
}

router.post('/:id/attachments', handleAttachmentUpload, async (req, res, next) => {
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

    const validityChecks = await Promise.all(req.files.map((f) => hasPdfMagicBytes(f.path)));
    if (validityChecks.some((ok) => !ok)) {
      for (const f of req.files) fs.unlink(f.path, () => {});
      return res.status(400).json({ error: 'One or more files are not valid PDFs' });
    }

    // campaign.attachments.push was unbounded, so the only ceiling on disk use
    // was the global rate limiter. Cap both count and total bytes per campaign.
    const existing = campaign.attachments || [];
    const incomingBytes = req.files.reduce((sum, f) => sum + f.size, 0);
    const existingBytes = existing.reduce((sum, a) => sum + (a.file_size || 0), 0);

    if (existing.length + req.files.length > MAX_ATTACHMENTS_PER_CAMPAIGN) {
      for (const f of req.files) fs.unlink(f.path, () => {});
      return res.status(400).json({
        error: `A campaign can have at most ${MAX_ATTACHMENTS_PER_CAMPAIGN} attachments`,
      });
    }
    if (existingBytes + incomingBytes > MAX_ATTACHMENT_BYTES_PER_CAMPAIGN) {
      for (const f of req.files) fs.unlink(f.path, () => {});
      return res.status(400).json({
        error: 'Attachments for one campaign cannot exceed 25 MB in total',
      });
    }

    const newAttachments = req.files.map((file) => ({
      original_name: file.originalname,
      stored_name: file.filename,
      // Store the bare filename, not an absolute path — absolute paths do not
      // survive a move between hosts (or a container redeploy).
      file_path: file.filename,
      file_size: file.size,
      // Fixed, not file.mimetype: the magic-byte gate above already establishes
      // the format, and persisting a client-controlled value is what let an
      // upload dictate the download response's Content-Type.
      mime_type: 'application/pdf',
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

// Short-lived token so the previewer can open attachments in a new tab / iframe
// without putting the session credential in the URL.
router.get('/:id/attachments/preview-token', async (req, res, next) => {
  try {
    const campaign = await findOwnedCampaign(req.user.id, req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({
      token: signResourceToken(req.user.id, `campaign:${campaign._id}:attachments`, 600),
      expires_in: 600,
    });
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

    fs.unlink(resolveAttachmentPath(attachment.file_path), () => {});
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

    // 'sending' is deliberately excluded. A live worker polls for pending
    // recipients continuously, so requeuing into a running campaign lets it
    // start sending them before this handler has reserved anything — and the
    // reservation failing afterwards can no longer call them back. Pause first.
    if (!['completed', 'failed', 'paused', 'stopped'].includes(campaign.status)) {
      return res.status(400).json({
        error: campaign.status === 'sending'
          ? 'Pause the campaign before retrying failed emails.'
          : 'Cannot retry failed emails for a draft campaign',
      });
    }

    const { reset_attempts: resetAttempts } = req.body || {};
    if (resetAttempts) {
      await CampaignRecipient.updateMany(
        { campaign_id: campaign._id, status: 'failed' },
        { $set: { attempt_count: 0 } }
      );
    }

    // Reserve BEFORE requeuing. Doing it the other way round makes the credit
    // check advisory: the rows are already pending (and claimable) by the time
    // the reservation is evaluated, so a 402 response is returned to the user
    // while the emails go out anyway.
    const retryFilter = {
      campaign_id: campaign._id,
      status: 'failed',
      attempt_count: { $lt: sendConfig.maxRetriesPerRecipient },
    };
    const retryable = await CampaignRecipient.countDocuments(retryFilter);
    if (retryable === 0) {
      return res.status(400).json({ error: 'No failed recipients to retry' });
    }

    try {
      const outstanding = await countOutstandingRecipients(campaign._id);
      await reserveCampaignQuota(req.user.id, campaign._id, outstanding + retryable);
    } catch (err) {
      if (err instanceof QuotaError) {
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    const retried = await resetFailedRecipients(campaign._id, {
      maxRetries: sendConfig.maxRetriesPerRecipient,
    });

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

router.post('/:id/send', requireVerifiedEmail, async (req, res, next) => {
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
      return res.status(400).json({ error: 'Add and activate a Gmail sending account first.', code: 'NO_ACTIVE_GMAIL_ACCOUNT' });
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

router.post('/:id/resume', requireVerifiedEmail, async (req, res, next) => {
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
      return res.status(400).json({ error: 'Add and activate a Gmail sending account first.', code: 'NO_ACTIVE_GMAIL_ACCOUNT' });
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
