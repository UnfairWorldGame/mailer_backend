import SendLog from '../models/SendLog.js';
import { toApiDoc } from '../utils/apiTransform.js';

const VALID_ACTIONS = new Set(SendLog.schema.path('action').enumValues);
const VALID_LEVELS = new Set(SendLog.schema.path('level').enumValues);

/**
 * Some log rows are load-bearing — reconcileOrphanedSends decides whether a
 * recipient was already emailed by looking for its `send_success` row — so a
 * write failure must still surface rather than being swallowed. What must NOT
 * happen is a *shape* problem (an action missing from the enum) throwing out of
 * the send loop and taking a live campaign down with it. Coerce anything
 * unrecognised onto valid values, keeping the original in `details`.
 */
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
  let safeAction = action;
  let safeLevel = level;
  let safeDetails = details;

  if (!VALID_ACTIONS.has(action)) {
    console.warn(`writeLog: unknown action "${action}" — recording as "other"`);
    safeAction = 'other';
    safeDetails = { ...details, original_action: action };
  }
  if (!VALID_LEVELS.has(level)) {
    safeLevel = 'info';
  }

  const log = await SendLog.create({
    campaign_id: campaignId,
    recipient_id: recipientId,
    gmail_account_id: gmailAccountId,
    level: safeLevel,
    action: safeAction,
    message,
    recipient_email: recipientEmail,
    details: safeDetails,
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
