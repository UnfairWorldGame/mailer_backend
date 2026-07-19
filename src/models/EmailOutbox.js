import mongoose from 'mongoose';

/**
 * Durable record of every transactional email.
 *
 * Before this, a send that failed was gone: the only trace was a console.error,
 * there was no retry after a process restart, and nobody could answer "did the
 * customer get their receipt?" after the fact. A row is written *before* the
 * send is attempted, so a crash mid-send leaves a queued row the sweeper picks
 * up rather than a silently dropped email.
 *
 * Bulk campaign mail deliberately does NOT go through here — it already has its
 * own durable retry state on CampaignRecipient and would swamp this collection.
 */
const emailOutboxSchema = new mongoose.Schema(
  {
    // Stable identifier for the kind of email, e.g. 'email_verification'.
    type: { type: String, required: true, index: true },

    to: { type: String, required: true, lowercase: true, trim: true },
    subject: { type: String, required: true },
    html: { type: String, required: true },
    text: { type: String, default: null },
    reply_to: { type: String, default: null },

    status: {
      type: String,
      enum: ['queued', 'sending', 'sent', 'failed', 'dead'],
      default: 'queued',
      index: true,
    },

    attempts: { type: Number, default: 0 },
    max_attempts: { type: Number, default: 5 },
    next_attempt_at: { type: Date, default: () => new Date(), index: true },
    last_error: { type: String, default: null },
    sent_at: { type: Date, default: null },
    message_id: { type: String, default: null },

    // Claim token so two instances cannot send the same row concurrently.
    claimed_by: { type: String, default: null },
    claimed_at: { type: Date, default: null },

    // Optional links for support ("show me everything we sent this user").
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    triggered_by_admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * Caller-supplied dedupe key. Prevents the same logical email going out
     * twice when a request is retried — e.g. a double-submitted credit grant
     * must not send two receipts.
     */
    idempotency_key: { type: String, default: null },

    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// The sweeper's hot query: due work, oldest first.
emailOutboxSchema.index({ status: 1, next_attempt_at: 1 });
emailOutboxSchema.index({ created_at: -1 });

emailOutboxSchema.index(
  { idempotency_key: 1 },
  { unique: true, partialFilterExpression: { idempotency_key: { $type: 'string' } } }
);

export default mongoose.model('EmailOutbox', emailOutboxSchema);
