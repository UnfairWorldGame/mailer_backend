import Campaign from '../models/Campaign.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import Contact from '../models/Contact.js';
import GmailAccount from '../models/GmailAccount.js';
import UploadHistory from '../models/UploadHistory.js';
import SendLog from '../models/SendLog.js';
import CertificateJob from '../models/CertificateJob.js';
import CertificateRecipient from '../models/CertificateRecipient.js';
import CertSendEvent from '../models/CertSendEvent.js';
import { ownerFilter } from '../utils/userScope.js';

export async function getAnalyticsOverview(userId) {
  const owner = ownerFilter(userId);

  const [
    campaigns,
    contacts,
    accounts,
    uploads,
    recipientStats,
    accountUsage,
    recentActivity,
    certificateJobCount,
    certificateStats,
  ] = await Promise.all([
    Campaign.aggregate([
      { $match: owner },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          sent: { $sum: '$sent_count' },
          failed: { $sum: '$failed_count' },
        },
      },
    ]),
    Contact.countDocuments(owner),
    GmailAccount.countDocuments({ ...owner, is_active: true }),
    UploadHistory.countDocuments(owner),
    CampaignRecipient.aggregate([
      {
        $lookup: {
          from: 'campaigns',
          localField: 'campaign_id',
          foreignField: '_id',
          as: 'campaign',
        },
      },
      { $unwind: '$campaign' },
      { $match: { 'campaign.user_id': userId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    GmailAccount.find(owner).select('label email sends_today total_sent limit_reached is_active').lean(),
    SendLog.aggregate([
      {
        $lookup: {
          from: 'campaigns',
          localField: 'campaign_id',
          foreignField: '_id',
          as: 'campaign',
        },
      },
      { $unwind: '$campaign' },
      { $match: { 'campaign.user_id': userId } },
      { $sort: { created_at: -1 } },
      { $limit: 10 },
    ]),
    CertificateJob.countDocuments(owner),
    // CertificateRecipient denormalizes user_id directly, so this needs no
    // $lookup (unlike the campaign aggregations above) — cheap even at scale.
    CertificateRecipient.aggregate([
      { $match: { user_id: userId } },
      { $group: { _id: '$send_status', count: { $sum: 1 } } },
    ]),
  ]);

  const byStatus = Object.fromEntries(campaigns.map((c) => [c._id, c]));
  const emailsByRecipient = Object.fromEntries(recipientStats.map((r) => [r._id, r.count]));
  const certByStatus = Object.fromEntries(certificateStats.map((r) => [r._id, r.count]));

  const campaignSent = campaigns.reduce((s, c) => s + (c.sent || 0), 0);
  const campaignFailed = campaigns.reduce((s, c) => s + (c.failed || 0), 0);
  const totalCampaigns = campaigns.reduce((s, c) => s + c.count, 0);

  const certSent = certByStatus.sent ?? 0;
  const certFailed = certByStatus.failed ?? 0;
  const certPending = (certByStatus.pending ?? 0) + (certByStatus.sending ?? 0);

  // "Emails sent" and delivery stats are a holistic total across both the
  // simple campaign engine and the certificate sender.
  const totalSent = campaignSent + certSent;
  const totalFailed = campaignFailed + certFailed;

  // Merge campaign send-logs with certificate job events into one activity feed.
  let certActivity = [];
  if (certificateJobCount > 0) {
    const jobs = await CertificateJob.find(owner).select('_id').lean();
    if (jobs.length) {
      certActivity = await CertSendEvent.find({ job_id: { $in: jobs.map((j) => j._id) } })
        .sort({ created_at: -1 })
        .limit(10)
        .lean();
    }
  }

  const mergedActivity = [
    ...recentActivity.map((l) => ({
      id: l._id.toString(),
      action: l.action,
      level: l.level,
      message: l.message,
      created_at: l.created_at,
    })),
    ...certActivity.map((e) => ({
      id: e._id.toString(),
      action: e.action,
      level: e.level,
      message: e.message,
      created_at: e.created_at,
    })),
  ]
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    .slice(0, 10);

  return {
    campaigns: {
      total: totalCampaigns,
      draft: byStatus.draft?.count ?? 0,
      sending: byStatus.sending?.count ?? 0,
      completed: byStatus.completed?.count ?? 0,
      failed: byStatus.failed?.count ?? 0,
      paused: byStatus.paused?.count ?? 0,
      stopped: byStatus.stopped?.count ?? 0,
    },
    emails: {
      total_sent: totalSent,
      total_failed: totalFailed,
      pending: (emailsByRecipient.pending ?? 0) + certPending,
      delivered: (emailsByRecipient.sent ?? 0) + certSent,
      failed: (emailsByRecipient.failed ?? 0) + certFailed,
      success_rate: totalSent + totalFailed > 0
        ? Math.round((totalSent / (totalSent + totalFailed)) * 100)
        : 0,
    },
    certificates: {
      total_jobs: certificateJobCount,
      sent: certSent,
      failed: certFailed,
      pending: certPending,
    },
    reports_generated: certificateJobCount,
    contacts,
    active_accounts: accounts,
    upload_count: uploads,
    account_usage: accountUsage.map((a) => ({
      id: a._id.toString(),
      label: a.label,
      email: a.email,
      sends_today: a.sends_today,
      total_sent: a.total_sent,
      limit_reached: a.limit_reached,
      is_active: a.is_active,
    })),
    recent_activity: mergedActivity,
  };
}

export async function getEmailTimeSeries(userId, days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const campaignMatch = { 'campaign.user_id': userId };

  const sent = await CampaignRecipient.aggregate([
    {
      $lookup: {
        from: 'campaigns',
        localField: 'campaign_id',
        foreignField: '_id',
        as: 'campaign',
      },
    },
    { $unwind: '$campaign' },
    { $match: { ...campaignMatch, status: 'sent', sent_at: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$sent_at' } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const failed = await CampaignRecipient.aggregate([
    {
      $lookup: {
        from: 'campaigns',
        localField: 'campaign_id',
        foreignField: '_id',
        as: 'campaign',
      },
    },
    { $unwind: '$campaign' },
    { $match: { ...campaignMatch, status: 'failed', updated_at: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$updated_at' } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const labels = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    labels.push(d.toISOString().slice(0, 10));
  }

  const sentMap = Object.fromEntries(sent.map((s) => [s._id, s.count]));
  const failedMap = Object.fromEntries(failed.map((f) => [f._id, f.count]));

  return {
    labels,
    sent: labels.map((l) => sentMap[l] ?? 0),
    failed: labels.map((l) => failedMap[l] ?? 0),
  };
}
