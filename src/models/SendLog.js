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

export default mongoose.model('SendLog', sendLogSchema);
