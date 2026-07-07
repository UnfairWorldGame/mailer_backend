import mongoose from 'mongoose';

// Append-only event log per job: powers the send report and crash-recovery
// reconciliation (a `send_success` event with a message_id lets us mark a
// recipient delivered even if the process died before the recipient row was
// updated — preventing duplicate resends). TTL-aged to avoid unbounded growth.
const certSendEventSchema = new mongoose.Schema(
  {
    job_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CertificateJob', required: true, index: true },
    recipient_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CertificateRecipient', default: null },
    level: { type: String, enum: ['info', 'success', 'warning', 'error'], default: 'info' },
    action: {
      type: String,
      enum: [
        'job_start', 'job_complete', 'job_pause', 'job_resume', 'job_cancel',
        'send_attempt', 'send_success', 'send_failed', 'send_retry',
        'account_rotated', 'account_limit_reached', 'no_accounts',
        'recipient_recovered', 'duplicate_prevented', 'cleanup',
      ],
      required: true,
    },
    message: { type: String, default: '' },
    recipient_email: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

certSendEventSchema.index({ job_id: 1, created_at: -1 });
certSendEventSchema.index({ job_id: 1, recipient_id: 1, action: 1 });
// Age events out after 30 days.
certSendEventSchema.index({ created_at: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export default mongoose.model('CertSendEvent', certSendEventSchema);
