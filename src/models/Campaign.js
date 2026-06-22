import mongoose from 'mongoose';

const attachmentSchema = new mongoose.Schema(
  {
    original_name: { type: String, required: true },
    stored_name: { type: String, required: true },
    file_path: { type: String, required: true },
    file_size: { type: Number, required: true },
    mime_type: { type: String, default: 'application/pdf' },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

const campaignSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    body: { type: String, required: true },
    gmail_account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'GmailAccount', default: null },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'sending', 'completed', 'failed', 'paused', 'stopped'],
      default: 'draft',
    },
    send_delay_ms: { type: Number, default: null },
    rotate_accounts: { type: Boolean, default: true },
    total_recipients: { type: Number, default: 0 },
    sent_count: { type: Number, default: 0 },
    failed_count: { type: Number, default: 0 },
    pending_count: { type: Number, default: 0 },
    skipped_count: { type: Number, default: 0 },
    sending_count: { type: Number, default: 0 },
    worker_id: { type: String, default: null },
    worker_locked_at: { type: Date, default: null },
    last_progress_at: { type: Date, default: null },
    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
    attachments: [attachmentSchema],
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

export default mongoose.model('Campaign', campaignSchema);
