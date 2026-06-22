import mongoose from 'mongoose';

const campaignRecipientSchema = new mongoose.Schema(
  {
    campaign_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', required: true, index: true },
    contact_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Contact', required: true },
    name: { type: String, default: '' },
    email: { type: String, required: true, lowercase: true },
    status: {
      type: String,
      enum: ['pending', 'sending', 'sent', 'failed', 'skipped'],
      default: 'pending',
    },
    error_message: { type: String, default: null },
    sent_at: { type: Date, default: null },
    gmail_account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'GmailAccount', default: null },
    message_id: { type: String, default: null },
    attempt_count: { type: Number, default: 0 },
    last_attempt_at: { type: Date, default: null },
    next_retry_at: { type: Date, default: null },
    claim_token: { type: String, default: null },
    claimed_at: { type: Date, default: null },
    claimed_by: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

campaignRecipientSchema.index({ campaign_id: 1, email: 1 }, { unique: true });
campaignRecipientSchema.index({ campaign_id: 1, status: 1, created_at: 1 });
campaignRecipientSchema.index({ campaign_id: 1, status: 1, next_retry_at: 1 });

export default mongoose.model('CampaignRecipient', campaignRecipientSchema);
