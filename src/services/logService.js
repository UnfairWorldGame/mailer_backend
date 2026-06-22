import SendLog from '../models/SendLog.js';
import { toApiDoc } from '../utils/apiTransform.js';

export async function writeLog({
  campaignId,
  recipientId = null,
  gmailAccountId = null,
  level = 'info',
  action,
  message,
  recipientEmail = null,
  details = {},
}) {
  const log = await SendLog.create({
    campaign_id: campaignId,
    recipient_id: recipientId,
    gmail_account_id: gmailAccountId,
    level,
    action,
    message,
    recipient_email: recipientEmail,
    details,
  });
  return log;
}

export async function getCampaignLogs(campaignId, { limit = 100, skip = 0, action, level, recipientEmail } = {}) {
  const filter = { campaign_id: campaignId };
  if (action) filter.action = action;
  if (level) filter.level = level;
  if (recipientEmail) filter.recipient_email = recipientEmail.toLowerCase();

  const logs = await SendLog.find(filter)
    .sort({ created_at: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
  return logs.map((l) => toApiDoc(l));
}

export async function getCampaignLogCount(campaignId, filters = {}) {
  const filter = { campaign_id: campaignId };
  if (filters.action) filter.action = filters.action;
  if (filters.level) filter.level = filters.level;
  if (filters.recipientEmail) filter.recipient_email = filters.recipientEmail.toLowerCase();
  return SendLog.countDocuments(filter);
}

export async function getRecipientLogs(campaignId, recipientId, { limit = 50 } = {}) {
  const logs = await SendLog.find({
    campaign_id: campaignId,
    recipient_id: recipientId,
  })
    .sort({ created_at: -1 })
    .limit(limit)
    .lean();
  return logs.map((l) => toApiDoc(l));
}
