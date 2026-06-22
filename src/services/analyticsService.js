import Campaign from '../models/Campaign.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import Contact from '../models/Contact.js';
import GmailAccount from '../models/GmailAccount.js';
import UploadHistory from '../models/UploadHistory.js';
import SendLog from '../models/SendLog.js';

export async function getAnalyticsOverview() {
  const [
    campaigns,
    contacts,
    accounts,
    uploads,
    recipientStats,
    accountUsage,
    recentActivity,
  ] = await Promise.all([
    Campaign.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          sent: { $sum: '$sent_count' },
          failed: { $sum: '$failed_count' },
        },
      },
    ]),
    Contact.countDocuments(),
    GmailAccount.countDocuments({ is_active: true }),
    UploadHistory.countDocuments(),
    CampaignRecipient.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    GmailAccount.find().select('label email sends_today total_sent limit_reached is_active').lean(),
    SendLog.find().sort({ created_at: -1 }).limit(10).lean(),
  ]);

  const byStatus = Object.fromEntries(campaigns.map((c) => [c._id, c]));
  const emailsByRecipient = Object.fromEntries(recipientStats.map((r) => [r._id, r.count]));

  const totalSent = campaigns.reduce((s, c) => s + (c.sent || 0), 0);
  const totalFailed = campaigns.reduce((s, c) => s + (c.failed || 0), 0);
  const totalCampaigns = campaigns.reduce((s, c) => s + c.count, 0);

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
      pending: emailsByRecipient.pending ?? 0,
      delivered: emailsByRecipient.sent ?? 0,
      failed: emailsByRecipient.failed ?? 0,
      success_rate: totalSent + totalFailed > 0
        ? Math.round((totalSent / (totalSent + totalFailed)) * 100)
        : 0,
    },
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
    recent_activity: recentActivity.map((l) => ({
      id: l._id.toString(),
      action: l.action,
      level: l.level,
      message: l.message,
      created_at: l.created_at,
    })),
  };
}

export async function getEmailTimeSeries(days = 7) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const sent = await CampaignRecipient.aggregate([
    { $match: { status: 'sent', sent_at: { $gte: since } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$sent_at' } },
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);

  const failed = await CampaignRecipient.aggregate([
    { $match: { status: 'failed', updated_at: { $gte: since } } },
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
