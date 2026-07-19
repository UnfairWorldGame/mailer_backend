import User from '../models/User.js';
import Campaign from '../models/Campaign.js';
import CertificateJob from '../models/CertificateJob.js';
import { releaseCampaignQuota, releaseCertificateJobReservation } from './quotaService.js';

// ─────────────────────────────────────────────────────────────────────────────
// Credit reservation reconciler.
//
// `User.reserved_credits` is a denormalised roll-up of the per-job reservations
// (`Campaign.quota_reserved` + `CertificateJob.credits_reserved`). Those live in
// separate documents updated by separate statements, with no transaction, so any
// crash between the two — or any bug in a release path — leaves them disagreeing
// permanently. The consequences are asymmetric but both bad:
//
//   roll-up too HIGH  → credits the user paid for are invisible and unusable
//   roll-up too LOW   → available_to_send is overstated, letting a send be
//                       queued that the balance cannot cover; the shortfall
//                       then surfaces mid-campaign, after emails have gone out
//
// This pass recomputes the roll-up from the per-job values, which are the
// authoritative record, and corrects the user document. It runs periodically so
// drift is bounded in time rather than accumulating for the life of the account.
//
// It also releases reservations held by jobs that have sat paused or stopped for
// longer than the TTL. Those hold credits hostage with no way for the user to
// discover why their balance is short. Releasing is safe: the resume paths call
// reserveForRef, which reserves only the delta and so re-reserves correctly.
// ─────────────────────────────────────────────────────────────────────────────

const RECONCILE_INTERVAL_MS = parseInt(process.env.QUOTA_RECONCILE_INTERVAL_MS || String(30 * 60 * 1000), 10);
const STALE_RESERVATION_HOURS = parseInt(process.env.QUOTA_STALE_RESERVATION_HOURS || '72', 10);

let timer = null;

async function sumReservedByUser() {
  const [campaigns, jobs] = await Promise.all([
    Campaign.aggregate([
      { $match: { quota_reserved: { $gt: 0 } } },
      { $group: { _id: '$user_id', total: { $sum: '$quota_reserved' } } },
    ]),
    CertificateJob.aggregate([
      { $match: { credits_reserved: { $gt: 0 } } },
      { $group: { _id: '$user_id', total: { $sum: '$credits_reserved' } } },
    ]),
  ]);

  const expected = new Map();
  for (const row of [...campaigns, ...jobs]) {
    const key = row._id.toString();
    expected.set(key, (expected.get(key) || 0) + row.total);
  }
  return expected;
}

// Hand back credits held by work that has been parked well beyond any plausible
// active use. Terminal states already release on transition; this covers jobs
// abandoned in a resumable state, including the engine's own auto-pauses.
async function releaseStaleReservations() {
  const cutoff = new Date(Date.now() - STALE_RESERVATION_HOURS * 60 * 60 * 1000);
  let released = 0;

  // Everything except `sending` — an inclusion list missed the two states where
  // a reservation is most likely to be stranded, and because reconcileReservations
  // treats per-ref values as authoritative it then *re-asserted* the leak on
  // every pass rather than clearing it:
  //   draft     — POST /:id/send reserved, then the campaign.save() right after
  //               it failed, so the status never advanced.
  //   completed — the loop finished but the process died before
  //               releaseCampaignQuota; boot recovery only looks at `sending`.
  // Either way the user's credits were held permanently and refunds refused them.
  const campaigns = await Campaign.find({
    quota_reserved: { $gt: 0 },
    status: { $ne: 'sending' },
    updated_at: { $lt: cutoff },
  }).select('_id user_id quota_reserved').limit(500);

  for (const campaign of campaigns) {
    await releaseCampaignQuota(campaign.user_id, campaign._id).catch((err) =>
      console.error(`[quota-reconcile] campaign ${campaign._id} release failed:`, err.message)
    );
    released++;
  }

  const jobs = await CertificateJob.find({
    credits_reserved: { $gt: 0 },
    status: { $ne: 'sending' },
    updated_at: { $lt: cutoff },
  }).select('_id user_id credits_reserved').limit(500);

  for (const job of jobs) {
    await releaseCertificateJobReservation(job.user_id, job._id).catch((err) =>
      console.error(`[quota-reconcile] job ${job._id} release failed:`, err.message)
    );
    released++;
  }

  return released;
}

export async function reconcileReservations() {
  const staleReleased = await releaseStaleReservations();

  // Recompute AFTER releasing, so the corrections below reflect the releases.
  const expected = await sumReservedByUser();

  // Every user who either holds a roll-up or is owed one. Users with neither are
  // already consistent at zero and need no work.
  const users = await User.find({
    $or: [
      { reserved_credits: { $gt: 0 } },
      { _id: { $in: [...expected.keys()] } },
    ],
  }).select('_id email reserved_credits');

  let corrected = 0;
  for (const user of users) {
    const want = expected.get(user._id.toString()) || 0;
    const have = user.reserved_credits || 0;
    if (want === have) continue;

    // Conditional on the value we compared against, so a send that consumes a
    // credit between the read and this write is not clobbered — it will simply
    // be picked up by the next pass.
    const res = await User.updateOne(
      { _id: user._id, reserved_credits: have },
      { $set: { reserved_credits: want } }
    );
    if (res.modifiedCount > 0) {
      corrected++;
      console.warn(
        `[quota-reconcile] ${user.email}: reserved_credits ${have} -> ${want} ` +
        `(drift of ${want - have}; jobs are authoritative)`
      );
    }
  }

  if (staleReleased > 0 || corrected > 0) {
    console.log(`[quota-reconcile] released ${staleReleased} stale reservation(s), corrected ${corrected} balance(s)`);
  }
  return { staleReleased, corrected };
}

export function startQuotaReconciler() {
  if (timer) return;
  reconcileReservations().catch((err) => console.error('[quota-reconcile]', err.message));
  timer = setInterval(() => {
    reconcileReservations().catch((err) => console.error('[quota-reconcile]', err.message));
  }, RECONCILE_INTERVAL_MS);
  timer.unref?.();
}

export function stopQuotaReconciler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
