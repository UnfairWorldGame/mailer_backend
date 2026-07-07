import User from '../models/User.js';
import Campaign from '../models/Campaign.js';
import Contact from '../models/Contact.js';
import GmailAccount from '../models/GmailAccount.js';
import UploadHistory from '../models/UploadHistory.js';
import CampaignRecipient from '../models/CampaignRecipient.js';
import SendLog from '../models/SendLog.js';
import mongoose from 'mongoose';
import { resolveUserRole } from '../utils/adminAccess.js';
import { toApiDoc } from '../utils/apiTransform.js';
import { computeQuotaSnapshot, listCreditTransactions } from './quotaService.js';
import { CREDIT_PACKS } from '../config/billingConfig.js';
import { recordAuditLog } from './auditLogService.js';

function publicUser(user) {
  const api = toApiDoc(user);
  delete api.password;
  delete api.reset_token_hash;
  delete api.reset_token_expires;
  api.role = resolveUserRole(user);
  return api;
}

function mapCampaign(campaign) {
  return {
    id: campaign._id.toString(),
    name: campaign.name,
    subject: campaign.subject,
    status: campaign.status,
    sent_count: campaign.sent_count,
    failed_count: campaign.failed_count,
    total_recipients: campaign.total_recipients,
    created_at: campaign.created_at,
    started_at: campaign.started_at,
    completed_at: campaign.completed_at,
    user: campaign.user_id
      ? {
          id: campaign.user_id._id?.toString() || campaign.user_id.toString(),
          name: campaign.user_id.name,
          email: campaign.user_id.email,
        }
      : null,
  };
}

function buildDateLabels(days) {
  const labels = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    labels.push(d.toISOString().slice(0, 10));
  }
  return labels;
}

export async function getAdminOverview() {
  const [
    totalUsers,
    activeUsers,
    campaignAgg,
    contactCount,
    accountCount,
    uploadCount,
    sendingCampaigns,
    recentUsers,
    recentCampaigns,
    signupsByDay,
    topUsers,
    recentActivity,
    emailChart,
    creditAgg,
    usersNeedingCredits,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({ is_active: true }),
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
    GmailAccount.countDocuments(),
    UploadHistory.countDocuments(),
    Campaign.countDocuments({ status: 'sending' }),
    User.find()
      .sort({ created_at: -1 })
      .limit(5)
      .select('name email role is_active created_at')
      .lean(),
    Campaign.find()
      .sort({ created_at: -1 })
      .limit(8)
      .populate('user_id', 'name email')
      .select('name subject status sent_count total_recipients created_at user_id')
      .lean(),
    User.aggregate([
      {
        $match: {
          created_at: {
            $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$created_at' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Campaign.aggregate([
      {
        $group: {
          _id: '$user_id',
          sent: { $sum: '$sent_count' },
          campaigns: { $sum: 1 },
        },
      },
      { $sort: { sent: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: 'users',
          localField: '_id',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
    ]),
    SendLog.find()
      .sort({ created_at: -1 })
      .limit(12)
      .populate({
        path: 'campaign_id',
        select: 'name user_id',
        populate: { path: 'user_id', select: 'name email' },
      })
      .lean(),
    getPlatformEmailChart(7),
    User.aggregate([
      {
        $group: {
          _id: null,
          total_credits: { $sum: '$email_credits' },
          paid_users: { $sum: { $cond: [{ $gt: ['$email_credits', 0] }, 1, 0] } },
          users_without_credits: {
            $sum: {
              $cond: [
                { $and: [{ $lte: ['$email_credits', 0] }, { $eq: ['$has_paid_access', false] }] },
                1,
                0,
              ],
            },
          },
        },
      },
    ]),
    User.find({ email_credits: { $lte: 0 }, has_paid_access: false, role: { $ne: 'admin' } })
      .sort({ created_at: -1 })
      .limit(6)
      .select('name email role is_active email_credits has_paid_access free_sent_today reserved_credits')
      .lean(),
  ]);

  const byStatus = Object.fromEntries(campaignAgg.map((row) => [row._id, row]));
  const totalSent = campaignAgg.reduce((sum, row) => sum + (row.sent || 0), 0);
  const totalFailed = campaignAgg.reduce((sum, row) => sum + (row.failed || 0), 0);
  const totalCampaigns = campaignAgg.reduce((sum, row) => sum + row.count, 0);

  const signupLabels = [];
  for (let i = 29; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    signupLabels.push(d.toISOString().slice(0, 10));
  }
  const signupMap = Object.fromEntries(signupsByDay.map((row) => [row._id, row.count]));
  const creditStats = creditAgg?.[0] || {};

  return {
    users: {
      total: totalUsers,
      active: activeUsers,
      inactive: totalUsers - activeUsers,
    },
    credits: {
      total_balance: creditStats.total_credits ?? 0,
      users_with_credits: creditStats.paid_users ?? 0,
      users_without_credits: creditStats.users_without_credits ?? 0,
    },
    campaigns: {
      total: totalCampaigns,
      sending: byStatus.sending?.count ?? 0,
      completed: byStatus.completed?.count ?? 0,
      draft: byStatus.draft?.count ?? 0,
      failed: byStatus.failed?.count ?? 0,
      paused: (byStatus.paused?.count ?? 0) + (byStatus.stopped?.count ?? 0),
      active_sending: sendingCampaigns,
    },
    emails: {
      total_sent: totalSent,
      total_failed: totalFailed,
      success_rate: totalSent + totalFailed > 0
        ? Math.round((totalSent / (totalSent + totalFailed)) * 100)
        : 0,
    },
    contacts: contactCount,
    accounts: accountCount,
    uploads: uploadCount,
    signups_chart: {
      labels: signupLabels,
      counts: signupLabels.map((label) => signupMap[label] ?? 0),
    },
    recent_users: recentUsers.map(publicUser),
    recent_campaigns: recentCampaigns.map(mapCampaign),
    top_users: topUsers.map((row) => ({
      id: row.user._id.toString(),
      name: row.user.name,
      email: row.user.email,
      emails_sent: row.sent,
      campaigns: row.campaigns,
    })),
    recent_activity: recentActivity.map((log) => ({
      id: log._id.toString(),
      level: log.level,
      action: log.action,
      message: log.message,
      recipient_email: log.recipient_email,
      created_at: log.created_at,
      campaign: log.campaign_id
        ? {
            id: log.campaign_id._id.toString(),
            name: log.campaign_id.name,
            user: log.campaign_id.user_id
              ? {
                  name: log.campaign_id.user_id.name,
                  email: log.campaign_id.user_id.email,
                }
              : null,
          }
        : null,
    })),
    email_chart: emailChart,
    credit_watchlist: usersNeedingCredits.map((user) => ({
      ...publicUser(user),
      billing: computeQuotaSnapshot(user),
    })),
  };
}

export async function getPlatformEmailChart(days = 7) {
  const safeDays = Math.min(Math.max(parseInt(days, 10) || 7, 1), 90);
  const since = new Date();
  since.setDate(since.getDate() - safeDays);
  since.setHours(0, 0, 0, 0);

  const [sent, failed] = await Promise.all([
    CampaignRecipient.aggregate([
      { $match: { status: 'sent', sent_at: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$sent_at' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    CampaignRecipient.aggregate([
      { $match: { status: 'failed', updated_at: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$updated_at' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
  ]);

  const labels = buildDateLabels(safeDays);
  const sentMap = Object.fromEntries(sent.map((row) => [row._id, row.count]));
  const failedMap = Object.fromEntries(failed.map((row) => [row._id, row.count]));

  return {
    labels,
    sent: labels.map((label) => sentMap[label] ?? 0),
    failed: labels.map((label) => failedMap[label] ?? 0),
  };
}

export async function getSystemHealth() {
  const dbState = mongoose.connection.readyState;
  const dbStatus = dbState === 1 ? 'connected' : dbState === 2 ? 'connecting' : 'disconnected';

  const [sendingCampaigns, activeAccounts, failedLast24h] = await Promise.all([
    Campaign.find({ status: 'sending' })
      .select('name sent_count total_recipients started_at user_id')
      .populate('user_id', 'name email')
      .limit(10)
      .lean(),
    GmailAccount.countDocuments({ is_active: true }),
    CampaignRecipient.countDocuments({
      status: 'failed',
      updated_at: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    }),
  ]);

  return {
    status: dbState === 1 ? 'healthy' : 'degraded',
    database: dbStatus,
    version: process.env.npm_package_version || '2.0.0',
    node_env: process.env.NODE_ENV || 'development',
    sending_campaigns: sendingCampaigns.map(mapCampaign),
    active_accounts: activeAccounts,
    failed_last_24h: failedLast24h,
    config: {
      daily_limit_per_account: parseInt(process.env.GMAIL_DAILY_LIMIT_PER_ACCOUNT || '500', 10),
      send_delay_ms: parseInt(process.env.EMAIL_SEND_DELAY_MS || '4000', 10),
      gemini_configured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    },
  };
}

export async function listCampaigns({ page = 1, limit = 20, search = '', status = '' } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const filter = {};

  if (status && status !== 'all') {
    filter.status = status;
  }

  if (search?.trim()) {
    const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { name: { $regex: term, $options: 'i' } },
      { subject: { $regex: term, $options: 'i' } },
    ];
  }

  const skip = (safePage - 1) * safeLimit;
  const [campaigns, total] = await Promise.all([
    Campaign.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(safeLimit)
      .populate('user_id', 'name email')
      .select('name subject status sent_count failed_count total_recipients created_at user_id')
      .lean(),
    Campaign.countDocuments(filter),
  ]);

  return {
    data: campaigns.map(mapCampaign),
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.ceil(total / safeLimit) || 1,
  };
}

export async function listActivity({ page = 1, limit = 30, level = '' } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const filter = {};

  if (level && level !== 'all') {
    filter.level = level;
  }

  const skip = (safePage - 1) * safeLimit;
  const [logs, total] = await Promise.all([
    SendLog.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(safeLimit)
      .populate({
        path: 'campaign_id',
        select: 'name user_id',
        populate: { path: 'user_id', select: 'name email' },
      })
      .lean(),
    SendLog.countDocuments(filter),
  ]);

  return {
    data: logs.map((log) => ({
      id: log._id.toString(),
      level: log.level,
      action: log.action,
      message: log.message,
      recipient_email: log.recipient_email,
      created_at: log.created_at,
      campaign: log.campaign_id
        ? {
            id: log.campaign_id._id.toString(),
            name: log.campaign_id.name,
            user: log.campaign_id.user_id
              ? {
                  name: log.campaign_id.user_id.name,
                  email: log.campaign_id.user_id.email,
                }
              : null,
          }
        : null,
    })),
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.ceil(total / safeLimit) || 1,
  };
}

export async function listUsers({ page = 1, limit = 20, search = '', role = '', status = '', credits = '' } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const filter = {};
  const and = [];

  if (search?.trim()) {
    const term = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    and.push({
      $or: [
        { name: { $regex: term, $options: 'i' } },
        { email: { $regex: term, $options: 'i' } },
      ],
    });
  }

  if (role === 'admin') {
    filter.role = 'admin';
  } else if (role === 'user') {
    filter.role = { $ne: 'admin' };
  }

  if (status === 'active') {
    filter.is_active = true;
  } else if (status === 'disabled') {
    filter.is_active = false;
  }

  if (credits === 'none') {
    filter.email_credits = { $lte: 0 };
    filter.has_paid_access = false;
  } else if (credits === 'paid') {
    and.push({
      $or: [{ email_credits: { $gt: 0 } }, { has_paid_access: true }],
    });
  }

  if (and.length) {
    filter.$and = and;
  }

  const skip = (safePage - 1) * safeLimit;
  const [users, total] = await Promise.all([
    User.find(filter)
      .sort({ created_at: -1 })
      .skip(skip)
      .limit(safeLimit)
      .select('name email role is_active created_at updated_at email_credits has_paid_access reserved_credits free_sent_today free_quota_date')
      .lean(),
    User.countDocuments(filter),
  ]);

  const userIds = users.map((user) => user._id);
  const stats = userIds.length
    ? await Campaign.aggregate([
        { $match: { user_id: { $in: userIds } } },
        {
          $group: {
            _id: '$user_id',
            campaigns: { $sum: 1 },
            sent: { $sum: '$sent_count' },
            failed: { $sum: '$failed_count' },
          },
        },
      ])
    : [];

  const statsMap = Object.fromEntries(
    stats.map((row) => [row._id.toString(), row])
  );

  const contactCounts = userIds.length
    ? await Contact.aggregate([
        { $match: { user_id: { $in: userIds } } },
        { $group: { _id: '$user_id', count: { $sum: 1 } } },
      ])
    : [];

  const contactMap = Object.fromEntries(
    contactCounts.map((row) => [row._id.toString(), row.count])
  );

  return {
    data: users.map((user) => {
      const api = publicUser(user);
      const userStats = statsMap[user._id.toString()] || {};
      return {
        ...api,
        billing: computeQuotaSnapshot(user),
        stats: {
          campaigns: userStats.campaigns ?? 0,
          emails_sent: userStats.sent ?? 0,
          emails_failed: userStats.failed ?? 0,
          contacts: contactMap[user._id.toString()] ?? 0,
        },
      };
    }),
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.ceil(total / safeLimit) || 1,
  };
}

export async function getUserDetail(userId) {
  const user = await User.findById(userId)
    .select('name email role is_active created_at updated_at email_credits free_sent_today free_quota_date reserved_credits has_paid_access')
    .lean();

  if (!user) return null;

  const [campaignStats, contactCount, accountCount, recentCampaigns, creditTransactions] = await Promise.all([
    Campaign.aggregate([
      { $match: { user_id: user._id } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          sent: { $sum: '$sent_count' },
          failed: { $sum: '$failed_count' },
        },
      },
    ]),
    Contact.countDocuments({ user_id: user._id }),
    GmailAccount.countDocuments({ user_id: user._id }),
    Campaign.find({ user_id: user._id })
      .sort({ created_at: -1 })
      .limit(5)
      .select('name subject status sent_count total_recipients created_at')
      .lean(),
    listCreditTransactions(userId, { limit: 10 }),
  ]);

  const byStatus = Object.fromEntries(campaignStats.map((row) => [row._id, row]));
  const totalSent = campaignStats.reduce((sum, row) => sum + (row.sent || 0), 0);
  const totalFailed = campaignStats.reduce((sum, row) => sum + (row.failed || 0), 0);

  return {
    ...publicUser(user),
    billing: computeQuotaSnapshot(user),
    credit_packs: Object.values(CREDIT_PACKS),
    credit_transactions: creditTransactions,
    stats: {
      campaigns: campaignStats.reduce((sum, row) => sum + row.count, 0),
      contacts: contactCount,
      accounts: accountCount,
      emails_sent: totalSent,
      emails_failed: totalFailed,
      by_status: {
        draft: byStatus.draft?.count ?? 0,
        sending: byStatus.sending?.count ?? 0,
        completed: byStatus.completed?.count ?? 0,
        failed: byStatus.failed?.count ?? 0,
        paused: (byStatus.paused?.count ?? 0) + (byStatus.stopped?.count ?? 0),
      },
    },
    recent_campaigns: recentCampaigns.map((campaign) => ({
      id: campaign._id.toString(),
      name: campaign.name,
      subject: campaign.subject,
      status: campaign.status,
      sent_count: campaign.sent_count,
      total_recipients: campaign.total_recipients,
      created_at: campaign.created_at,
    })),
  };
}

export async function updateUser(userId, updates, actingAdmin) {
  const actingAdminId = typeof actingAdmin === 'object' ? actingAdmin?.id : actingAdmin;
  const user = await User.findById(userId);
  if (!user) return null;

  if (actingAdminId && user._id.toString() === actingAdminId.toString()) {
    if (updates.is_active === false) {
      throw new Error('You cannot deactivate your own account');
    }
    if (updates.role === 'user') {
      throw new Error('You cannot remove your own admin access');
    }
  }

  const demotingAdmin = user.role === 'admin' && updates.role === 'user';
  const disablingAdmin = user.role === 'admin' && user.is_active !== false && updates.is_active === false;
  if (demotingAdmin || disablingAdmin) {
    const remainingAdmins = await User.countDocuments({
      _id: { $ne: user._id },
      role: 'admin',
      is_active: { $ne: false },
    });
    if (remainingAdmins === 0) {
      throw new Error('You cannot remove the last remaining admin account');
    }
  }

  const prevRole = user.role;
  const prevActive = user.is_active;

  if (updates.role !== undefined) {
    user.role = updates.role === 'admin' ? 'admin' : 'user';
  }

  if (updates.is_active !== undefined) {
    user.is_active = Boolean(updates.is_active);
  }

  await user.save();

  if (actingAdminId && typeof actingAdmin === 'object') {
    if (updates.role !== undefined && user.role !== prevRole) {
      await recordAuditLog({
        adminId: actingAdminId,
        adminName: actingAdmin.name || '',
        adminEmail: actingAdmin.email || '',
        action: 'user_role_change',
        targetUserId: user._id,
        targetUserName: user.name,
        targetUserEmail: user.email,
        metadata: { from: prevRole, to: user.role },
      });
    }
    if (updates.is_active !== undefined && user.is_active !== prevActive) {
      await recordAuditLog({
        adminId: actingAdminId,
        adminName: actingAdmin.name || '',
        adminEmail: actingAdmin.email || '',
        action: 'user_status_change',
        targetUserId: user._id,
        targetUserName: user.name,
        targetUserEmail: user.email,
        metadata: { from: prevActive, to: user.is_active },
      });
    }
  }

  return publicUser(user);
}
