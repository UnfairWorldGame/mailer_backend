import mongoose from 'mongoose';

const sendLogSchema = new mongoose.Schema(
  {
    campaign_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    recipient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CampaignRecipient', default: null },
    gmail_account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'GmailAccount', default: null },
    level: {
      type: String,
      enum: ['info', 'success', 'warning', 'error'],
      default: 'info',
    },
    action: {
      type: String,
      enum: [
        'campaign_start',
        'campaign_complete',
        'campaign_pause',
        'campaign_fail',
        'campaign_stop',
        'send_attempt',
        'send_success',
        'send_failed',
        'account_rotated',
        'account_limit_reached',
        'delay',
        'no_accounts',
        'recipient_recovered',
        'send_retry',
        'duplicate_prevented',
        'campaign_resume',
        // Written by sendEngine when an App Password is rejected. Its absence
        // here threw a ValidationError out of the send loop, which the outer
        // handler turned into "paused after an unexpected error" — the exact
        // case the auth branch exists to report clearly.
        'account_auth_failed',
        // Fallback for an action not yet in this list, so a future typo
        // degrades to a recorded log line instead of aborting a campaign.
        'other',
      ],
      required: true,
    },
    message: { type: String, required: true },
    recipient_email: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

sendLogSchema.index({ campaign_id: 1, created_at: -1 });
// Backs the recovery/reconcile lookups (findOne by recipient_id + action).
sendLogSchema.index({ campaign_id: 1, recipient_id: 1, action: 1 });
// Age out send logs after 90 days so the collection doesn't grow unbounded.
sendLogSchema.index({ created_at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export default mongoose.model('SendLog', sendLogSchema);
