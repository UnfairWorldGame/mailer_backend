import CertificateJob from '../models/CertificateJob.js';
import CertificateRecipient from '../models/CertificateRecipient.js';
import CertSendEvent from '../models/CertSendEvent.js';
import { certConfig } from '../config/certConfig.js';
import { removeJobDir } from './certificateFiles.js';

let timer = null;

// One sweep pass:
//  1. Abandoned "ready" jobs (uploaded but never sent) past their TTL are
//     canceled and their temp files deleted — reclaiming disk with zero storage cost.
//  2. Terminal jobs (completed/canceled/failed) past the retention window have
//     their DB rows + files fully purged.
export async function sweepCertificateJobs() {
  const now = Date.now();

  // 1) Expire abandoned ready jobs.
  const readyCutoff = new Date(now - certConfig.readyTtlHours * 60 * 60 * 1000);
  const abandoned = await CertificateJob.find({
    status: 'ready',
    files_deleted: false,
    $or: [{ expires_at: { $lte: new Date() } }, { expires_at: null, created_at: { $lt: readyCutoff } }],
  }).select('_id job_dir');

  for (const job of abandoned) {
    await removeJobDir(job.job_dir);
    await CertificateJob.updateOne(
      { _id: job._id },
      { $set: { status: 'canceled', files_deleted: true, cleaned_at: new Date() } }
    );
  }

  // 2) Purge old terminal jobs entirely.
  const purgeCutoff = new Date(now - certConfig.completedRetentionHours * 60 * 60 * 1000);
  const old = await CertificateJob.find({
    status: { $in: ['completed', 'canceled', 'failed'] },
    updated_at: { $lt: purgeCutoff },
  }).select('_id job_dir');

  for (const job of old) {
    await removeJobDir(job.job_dir);
    await CertificateRecipient.deleteMany({ job_id: job._id });
    await CertSendEvent.deleteMany({ job_id: job._id });
    await CertificateJob.deleteOne({ _id: job._id });
  }

  return { expired: abandoned.length, purged: old.length };
}

export function startCertificateSweeper() {
  if (timer) return;
  // Run once shortly after boot, then on an interval.
  sweepCertificateJobs().catch((err) => console.error('[cert-sweep]', err.message));
  timer = setInterval(() => {
    sweepCertificateJobs().catch((err) => console.error('[cert-sweep]', err.message));
  }, certConfig.sweepIntervalMs);
  timer.unref?.();
}

export function stopCertificateSweeper() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
