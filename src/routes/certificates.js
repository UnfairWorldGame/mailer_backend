import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { certUpload } from '../middleware/certUpload.js';
import { ownerFilter } from '../utils/userScope.js';
import { toApiDoc, toApiDocs } from '../utils/apiTransform.js';
import { sanitizeEmailHtml } from '../utils/sanitizeHtml.js';
import { certConfig } from '../config/certConfig.js';
import { hasPdfMagicBytes, hasZipMagicBytes } from '../utils/fileSignature.js';
import CertificateJob from '../models/CertificateJob.js';
import CertificateRecipient from '../models/CertificateRecipient.js';
import CertSendEvent from '../models/CertSendEvent.js';
import GmailAccount from '../models/GmailAccount.js';
import { createJobDir, extractPdfsFromZip, removeJobDir, pdfPath } from '../services/certificateFiles.js';
import { splitCertificatePdf } from '../services/certificatePdfSplitter.js';
import { readSheetRows, matchCertificates, matchCertificatesFromPdfPages } from '../utils/certMatch.js';
import {
  startJobSend,
  retryFailedRecipients,
  cleanupJobFiles,
  syncJobCounters,
} from '../services/certificateSendEngine.js';
import {
  reserveCertificateCredits,
  releaseCertificateJobReservation,
  QuotaError,
} from '../services/quotaService.js';

async function countPending(jobId) {
  return CertificateRecipient.countDocuments({ job_id: jobId, send_status: 'pending' });
}

const router = Router();
router.use(requireAuth);

const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.CERT_UPLOAD_RATE_LIMIT_MAX || '20', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Upload limit reached. Please try again later.' },
});

const DEFAULT_SUBJECT = 'Your Certificate';
const DEFAULT_BODY =
  '<p>Hi {{name}},</p><p>Congratulations! Please find your certificate attached to this email.</p><p>Best regards,<br/>The Team</p>';

const MAX_SUBJECT = 300;
const MAX_BODY = 50000;

function jobView(job) {
  return toApiDoc(job, { is_sendable: job.total_recipients > 0 });
}

// Turns a zero-extracted-files outcome into a specific, actionable message
// instead of a generic "no PDFs found" — the exact reason (oversized files,
// wrong file type, unsupported ZIP compression, etc.) is what the user
// actually needs to fix their upload.
function describeEmptyZipResult(stats) {
  if (!stats.total_entries) {
    return 'The ZIP file is empty — it has no files inside it.';
  }

  const reasons = [];
  if (stats.rejected_unsupported_compression > 0) {
    reasons.push(
      `${stats.rejected_unsupported_compression} file(s) used a ZIP compression method that isn't supported — ` +
      're-create the ZIP with Windows\' built-in "Compress to ZIP" or macOS Finder\'s "Compress", not 7-Zip\'s advanced/Ultra settings'
    );
  }
  if (stats.rejected_oversized > 0) {
    const limitMb = Math.round(certConfig.maxPdfBytes / (1024 * 1024));
    reasons.push(`${stats.rejected_oversized} file(s) exceeded the ${limitMb}MB per-certificate size limit`);
  }
  if (stats.rejected_unsupported_type > 0) {
    reasons.push(`${stats.rejected_unsupported_type} file(s) were not a valid PDF, PNG, or JPEG`);
  }
  if (stats.rejected_stream_error > 0) {
    reasons.push(`${stats.rejected_stream_error} file(s) could not be read from the ZIP (it may be partially corrupted)`);
  }
  if (stats.skipped_junk > 0 && stats.skipped_junk === stats.total_entries) {
    reasons.push('every entry was a folder or hidden/system file, not a certificate');
  }

  const entryWord = stats.total_entries === 1 ? 'entry' : 'entries';
  const sample = stats.sample_entry_names?.length
    ? ` Files found: ${stats.sample_entry_names.map((n) => `"${n}"`).join(', ')}${stats.sample_entry_names.length < stats.total_entries - stats.skipped_junk ? ', ...' : ''}.`
    : '';

  if (!reasons.length) {
    return `No valid PDF, PNG, or JPEG certificates were found inside the ZIP (scanned ${stats.total_entries} ${entryWord}).${sample}`;
  }

  return `No certificates could be extracted from the ZIP (scanned ${stats.total_entries} ${entryWord}): ${reasons.join('; ')}.${sample}`;
}

function cleanSubject(value) {
  return String(value ?? '').trim().slice(0, MAX_SUBJECT);
}
function cleanBody(value) {
  return sanitizeEmailHtml(String(value ?? '').slice(0, MAX_BODY));
}

async function loadOwnedJob(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  const job = await CertificateJob.findOne(ownerFilter(req.user.id, { _id: req.params.id }));
  if (!job) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  return job;
}

async function unlinkQuietly(filePath) {
  if (filePath) await fs.unlink(filePath).catch(() => {});
}

// POST /upload — extract certificates (ZIP or single multi-page PDF), parse
// sheet, match, persist job + recipients, return preview.
router.post('/upload', uploadLimiter, (req, res, next) => {
  certUpload(req, res, async (uploadErr) => {
    if (uploadErr) {
      const msg = uploadErr.code === 'LIMIT_FILE_SIZE'
        ? `File too large. Limit is ${Math.round(certConfig.maxZipBytes / (1024 * 1024))}MB.`
        : uploadErr.message || 'Upload failed';
      return res.status(400).json({ error: msg });
    }

    const zipFile = req.files?.zip?.[0];
    const sheetFile = req.files?.sheet?.[0];

    if (!zipFile || !sheetFile) {
      await unlinkQuietly(zipFile?.path);
      await unlinkQuietly(sheetFile?.path);
      return res.status(400).json({ error: 'Both a certificates ZIP and a recipient sheet are required.' });
    }

    let jobDir = null;
    try {
      // 1) Detect the real file type by signature — extensions are spoofable,
      // and we branch the entire pipeline on this, so it must be trustworthy.
      const claimedExt = path.extname(zipFile.originalname).toLowerCase();
      let sourceType;
      if (claimedExt === '.pdf') {
        sourceType = (await hasPdfMagicBytes(zipFile.path)) ? 'pdf' : null;
      } else {
        sourceType = (await hasZipMagicBytes(zipFile.path)) ? 'zip' : null;
      }
      if (!sourceType) {
        return res.status(400).json({ error: 'The certificates file content does not match a valid ZIP or PDF file.' });
      }

      jobDir = createJobDir();

      let files;
      let extractStats;
      let pageTexts = null;

      if (sourceType === 'pdf') {
        // 1a) A single multi-page PDF (e.g. a Canva export) — split into one
        // PDF per page and extract each page's text for name matching.
        const split = await splitCertificatePdf(zipFile.path, jobDir.pdfDir);
        files = split.files;
        pageTexts = split.pageTexts;
        extractStats = split.stats;

        if (!files.length) {
          await removeJobDir(jobDir.dirName);
          return res.status(400).json({ error: 'No certificate pages could be extracted from the PDF.' });
        }
      } else {
        // 1b) A ZIP of individually named PDFs.
        const extracted = await extractPdfsFromZip(zipFile.path, jobDir.pdfDir);
        files = extracted.files;
        extractStats = extracted.stats;

        if (!files.length) {
          await removeJobDir(jobDir.dirName);
          return res.status(400).json({ error: describeEmptyZipResult(extractStats) });
        }
      }

      // 2) Parse the recipient sheet (keeps every row for reporting).
      const rows = readSheetRows(sheetFile.path);
      if (!rows.length) {
        await removeJobDir(jobDir.dirName);
        return res.status(400).json({ error: 'The recipient sheet has no usable rows.' });
      }

      // 3) Match certificates to recipients — by filename (ZIP) or by the
      // name printed on each page (split PDF).
      const { recipients, unmatchedPdfs, stats } = sourceType === 'pdf'
        ? matchCertificatesFromPdfPages(rows, files.map((f) => ({ ...f, text: pageTexts[f.page_number] || '' })))
        : matchCertificates(rows, files);

      // 4) Persist job + recipients.
      const expiresAt = new Date(Date.now() + certConfig.readyTtlHours * 60 * 60 * 1000);
      const job = await CertificateJob.create({
        user_id: req.user.id,
        status: 'ready',
        subject: cleanSubject(req.body?.subject) || DEFAULT_SUBJECT,
        body: req.body?.body ? cleanBody(req.body.body) : DEFAULT_BODY,
        job_dir: jobDir.dirName,
        zip_name: zipFile.originalname,
        sheet_name: sheetFile.originalname,
        source_type: sourceType,
        total_pdfs: files.length,
        total_rows: rows.length,
        matched_count: stats.matched,
        missing_certificate_count: stats.missing_certificate,
        unmatched_pdf_count: unmatchedPdfs.length,
        invalid_email_count: stats.invalid_email,
        duplicate_count: stats.duplicate,
        ambiguous_name_count: stats.ambiguous_name,
        unmatched_pdfs: unmatchedPdfs.slice(0, 500),
        total_recipients: stats.matched,
        pending_count: stats.matched,
        skipped_count: recipients.length - stats.matched,
        expires_at: expiresAt,
      });

      const docs = recipients.map((r) => ({ ...r, job_id: job._id, user_id: req.user.id }));
      // Insert in chunks to avoid a single oversized op.
      for (let i = 0; i < docs.length; i += 1000) {
        await CertificateRecipient.insertMany(docs.slice(i, i + 1000), { ordered: false });
      }

      return res.status(201).json({
        job: jobView(job),
        extract_stats: extractStats,
        message: sourceType === 'pdf'
          ? `Split ${extractStats.total_pages} page(s) and matched ${stats.matched} of ${rows.length} recipients.`
          : `Matched ${stats.matched} of ${rows.length} recipients.`,
      });
    } catch (err) {
      if (jobDir) await removeJobDir(jobDir.dirName);
      return res.status(400).json({ error: err.message || 'Failed to process upload' });
    } finally {
      // Uploaded originals are never needed after extraction/parse.
      await unlinkQuietly(zipFile?.path);
      await unlinkQuietly(sheetFile?.path);
    }
  });
});

// GET / — list this user's jobs.
router.get('/', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const jobs = await CertificateJob.find(ownerFilter(req.user.id))
      .sort({ created_at: -1 })
      .limit(limit);
    res.json({ data: jobs.map(jobView) });
  } catch (err) {
    next(err);
  }
});

// GET /:id — a single job.
router.get('/:id', async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    res.json({ job: jobView(job) });
  } catch (err) {
    next(err);
  }
});

// GET /:id/progress — lightweight polling endpoint.
router.get('/:id/progress', async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    const total = job.total_recipients;
    const processed = job.sent_count + job.failed_count;
    res.json({
      status: job.status,
      counts: {
        total,
        sent: job.sent_count,
        failed: job.failed_count,
        pending: job.pending_count,
        sending: job.sending_count,
        skipped: job.skipped_count,
      },
      progress_percent: total > 0 ? Math.round((processed / total) * 100) : 0,
      files_deleted: job.files_deleted,
      is_running: job.status === 'sending',
    });
  } catch (err) {
    next(err);
  }
});

// GET /:id/recipients — paginated, filterable, searchable review list.
router.get('/:id/recipients', async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;

    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '50', 10), 1), 200);
    const filter = { job_id: job._id };

    if (req.query.match_status) filter.match_status = req.query.match_status;
    if (req.query.send_status) filter.send_status = req.query.send_status;

    const search = String(req.query.search || '').trim();
    if (search) {
      const esc = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { name: { $regex: esc, $options: 'i' } },
        { email: { $regex: esc, $options: 'i' } },
      ];
    }

    const [rows, total] = await Promise.all([
      CertificateRecipient.find(filter).sort({ created_at: 1 }).skip((page - 1) * limit).limit(limit),
      CertificateRecipient.countDocuments(filter),
    ]);

    res.json({ data: toApiDocs(rows), total, page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /:id/recipients/:recipientId/preview — stream the matched certificate
// file (PDF, PNG, or JPEG) so the review screen can show/open it before send.
// Accepts a ?token= query param (see requireAuth) since this is opened as a
// direct link/new tab rather than fetched with an Authorization header.
router.get('/:id/recipients/:recipientId/preview', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.recipientId)) {
      return res.status(404).json({ error: 'Certificate not found' });
    }
    const job = await loadOwnedJob(req, res);
    if (!job) return;

    if (job.files_deleted) {
      return res.status(404).json({ error: 'Certificate files for this job have been cleaned up.' });
    }

    const recipient = await CertificateRecipient.findOne({ _id: req.params.recipientId, job_id: job._id });
    if (!recipient || !recipient.matched_file) {
      return res.status(404).json({ error: 'Certificate not found' });
    }

    const filePath = pdfPath(job.job_dir, recipient.matched_file);
    try {
      await fs.access(filePath);
    } catch {
      return res.status(404).json({ error: 'Certificate file not found on server' });
    }

    const rawName = recipient.original_pdf_name || recipient.matched_file;
    const asciiName = rawName.replace(/["\r\n]/g, '');
    res.setHeader('Content-Type', recipient.mime_type || 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(rawName)}`
    );
    res.sendFile(path.resolve(filePath));
  } catch (err) {
    next(err);
  }
});

// PATCH /:id — edit the email template / sending options (before or between sends).
router.patch('/:id', async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    if (!['ready', 'paused'].includes(job.status)) {
      return res.status(409).json({ error: 'This job can only be edited while it is ready or paused.' });
    }

    if (req.body.subject !== undefined) job.subject = cleanSubject(req.body.subject) || DEFAULT_SUBJECT;
    if (req.body.body !== undefined) job.body = cleanBody(req.body.body) || DEFAULT_BODY;
    if (req.body.rotate_accounts !== undefined) job.rotate_accounts = Boolean(req.body.rotate_accounts);
    if (req.body.gmail_account_id !== undefined) {
      const accId = req.body.gmail_account_id;
      if (accId && mongoose.isValidObjectId(accId)) {
        const acc = await GmailAccount.findOne(ownerFilter(req.user.id, { _id: accId }));
        job.gmail_account_id = acc ? acc._id : null;
      } else {
        job.gmail_account_id = null;
      }
    }
    await job.save();
    res.json({ job: jobView(job) });
  } catch (err) {
    next(err);
  }
});

// POST /:id/send — begin background delivery.
router.post('/:id/send', async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;

    if (job.files_deleted) {
      return res.status(409).json({ error: 'Certificate files for this job have already been cleaned up.' });
    }
    if (!['ready', 'paused'].includes(job.status)) {
      return res.status(409).json({ error: `Job cannot be sent while it is "${job.status}".` });
    }
    if (job.total_recipients <= 0) {
      return res.status(400).json({ error: 'There are no matched, sendable certificates in this job.' });
    }

    const accountCount = await GmailAccount.countDocuments(ownerFilter(req.user.id, { is_active: true }));
    if (accountCount === 0) {
      return res.status(400).json({ error: 'Add and activate a Gmail sending account first.', code: 'NO_ACTIVE_GMAIL_ACCOUNT' });
    }

    // Reserve credits (3 per certificate) atomically BEFORE sending starts.
    const pending = await countPending(job._id);
    try {
      await reserveCertificateCredits(req.user.id, job._id, pending);
    } catch (err) {
      if (err instanceof QuotaError) return res.status(err.status).json({ error: err.message, code: err.code });
      throw err;
    }

    job.status = 'sending';
    if (!job.started_at) job.started_at = new Date();
    job.expires_at = null; // no longer an abandoned candidate
    await job.save();

    await startJobSend(job._id);
    res.json({ job: jobView(job), message: 'Sending started.' });
  } catch (err) {
    next(err);
  }
});

// POST /:id/pause
router.post('/:id/pause', async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    if (job.status !== 'sending') {
      return res.status(409).json({ error: 'Only a sending job can be paused.' });
    }
    await CertificateJob.updateOne({ _id: job._id, status: 'sending' }, { $set: { status: 'paused' } });
    const updated = await CertificateJob.findById(job._id);
    res.json({ job: jobView(updated), message: 'Sending paused.' });
  } catch (err) {
    next(err);
  }
});

// POST /:id/resume
router.post('/:id/resume', async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    if (job.status !== 'paused') {
      return res.status(409).json({ error: 'Only a paused job can be resumed.' });
    }
    if (job.files_deleted) {
      return res.status(409).json({ error: 'Certificate files are no longer available.' });
    }
    const accountCount = await GmailAccount.countDocuments(ownerFilter(req.user.id, { is_active: true }));
    if (accountCount === 0) {
      return res.status(400).json({ error: 'Add and activate a Gmail sending account first.', code: 'NO_ACTIVE_GMAIL_ACCOUNT' });
    }

    // Ensure remaining pending recipients are covered (idempotent — only reserves
    // the shortfall beyond what is already reserved on the job).
    const pending = await countPending(job._id);
    try {
      await reserveCertificateCredits(req.user.id, job._id, pending);
    } catch (err) {
      if (err instanceof QuotaError) return res.status(err.status).json({ error: err.message, code: err.code });
      throw err;
    }

    job.status = 'sending';
    await job.save();
    await startJobSend(job._id);
    res.json({ job: jobView(job), message: 'Sending resumed.' });
  } catch (err) {
    next(err);
  }
});

// POST /:id/retry-failed — requeue failed recipients and (re)start sending.
router.post('/:id/retry-failed', async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    if (['sending'].includes(job.status)) {
      return res.status(409).json({ error: 'Wait for the current run to pause or finish before retrying.' });
    }
    if (job.files_deleted) {
      return res.status(409).json({ error: 'Certificate files have been cleaned up — cannot retry.' });
    }
    const requeued = await retryFailedRecipients(job._id);
    if (requeued === 0) {
      return res.json({ requeued: 0, message: 'No failed certificates to retry.' });
    }

    // Re-reserve credits for the requeued recipients (they were refunded on failure).
    const pending = await countPending(job._id);
    try {
      await reserveCertificateCredits(req.user.id, job._id, pending);
    } catch (err) {
      if (err instanceof QuotaError) {
        // Roll the recipients back to failed so state stays consistent.
        await CertificateRecipient.updateMany(
          { job_id: job._id, send_status: 'pending' },
          { $set: { send_status: 'failed', error_message: 'Insufficient credits to retry' } }
        );
        await syncJobCounters(job._id);
        return res.status(err.status).json({ error: err.message, code: err.code });
      }
      throw err;
    }

    job.status = 'sending';
    if (!job.started_at) job.started_at = new Date();
    job.expires_at = null;
    await job.save();
    await startJobSend(job._id);
    res.json({ job: jobView(job), requeued, message: `Retrying ${requeued} certificate(s).` });
  } catch (err) {
    next(err);
  }
});

// GET /:id/report — final send report with categorized breakdown.
router.get('/:id/report', async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;
    await syncJobCounters(job._id);
    const fresh = await CertificateJob.findById(job._id);

    const [failed, skippedMissing, skippedInvalid, skippedDup, skippedAmbiguous] = await Promise.all([
      CertificateRecipient.find({ job_id: job._id, send_status: 'failed' }).select('name email error_message').limit(1000),
      CertificateRecipient.countDocuments({ job_id: job._id, match_status: 'missing_certificate' }),
      CertificateRecipient.countDocuments({ job_id: job._id, match_status: 'invalid_email' }),
      CertificateRecipient.countDocuments({ job_id: job._id, match_status: 'duplicate' }),
      CertificateRecipient.countDocuments({ job_id: job._id, match_status: 'ambiguous_name' }),
    ]);

    res.json({
      job: jobView(fresh),
      report: {
        total_recipients: fresh.total_recipients,
        sent: fresh.sent_count,
        failed: fresh.failed_count,
        pending: fresh.pending_count,
        skipped: {
          missing_certificate: skippedMissing,
          invalid_email: skippedInvalid,
          duplicate: skippedDup,
          ambiguous_name: skippedAmbiguous,
          unmatched_pdfs: fresh.unmatched_pdf_count,
        },
        failed_recipients: toApiDocs(failed),
      },
    });
  } catch (err) {
    next(err);
  }
});

// DELETE /:id — cancel + delete temp files (keeps the row/report).
router.delete('/:id', async (req, res, next) => {
  try {
    const job = await loadOwnedJob(req, res);
    if (!job) return;

    if (['sending', 'ready', 'paused'].includes(job.status)) {
      await CertificateJob.updateOne({ _id: job._id }, { $set: { status: 'canceled' } });
    }

    // Refund any credits still reserved for this job.
    await releaseCertificateJobReservation(req.user.id, job._id);

    const fresh = await CertificateJob.findById(job._id);
    await cleanupJobFiles(fresh);
    res.json({ message: 'Job canceled and temporary files deleted.', job: jobView(await CertificateJob.findById(job._id)) });
  } catch (err) {
    next(err);
  }
});

export default router;
