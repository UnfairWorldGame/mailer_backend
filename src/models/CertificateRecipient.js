import mongoose from 'mongoose';

// One row of the uploaded sheet, joined to its matched certificate PDF (if any).
// Non-sendable rows (missing PDF, invalid email, duplicate) are retained with a
// match_status so the review screen and report can explain every outcome.
const certificateRecipientSchema = new mongoose.Schema(
  {
    job_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CertificateJob', required: true, index: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    name: { type: String, default: '', trim: true },
    email: { type: String, default: '', trim: true, lowercase: true },
    normalized_name: { type: String, default: '' },

    // Matched certificate on disk (basename within the job folder). Certificates
    // may be PDF, PNG, or JPEG — detected by content, not by file name.
    matched_file: { type: String, default: null },
    original_pdf_name: { type: String, default: null },
    file_size: { type: Number, default: 0 },
    mime_type: { type: String, default: null },

    // Why this row is / isn't sendable.
    //  matched             — has a PDF + valid email + unique  => sendable
    //  missing_certificate — no PDF found for this name
    //  invalid_email       — email failed validation
    //  duplicate           — duplicate email in the sheet (first kept)
    //  ambiguous_name      — shares a name with another row; couldn't safely
    //                        auto-match by name (see certMatch.js)
    match_status: {
      type: String,
      enum: ['matched', 'missing_certificate', 'invalid_email', 'duplicate', 'ambiguous_name'],
      default: 'matched',
      index: true,
    },
    match_note: { type: String, default: '' },

    // Delivery state. Only sendable rows start as 'pending'; others are 'skipped'.
    send_status: {
      type: String,
      enum: ['pending', 'sending', 'sent', 'failed', 'skipped'],
      default: 'pending',
      index: true,
    },

    gmail_account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'GmailAccount', default: null },
    message_id: { type: String, default: null },
    error_message: { type: String, default: null },

    attempt_count: { type: Number, default: 0 },
    next_retry_at: { type: Date, default: null },
    last_attempt_at: { type: Date, default: null },
    sent_at: { type: Date, default: null },

    // Atomic-claim fields (prevents double-send across concurrent workers).
    claim_token: { type: String, default: null },
    claimed_at: { type: Date, default: null },
    claimed_by: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Claim query: pending rows for a job whose retry time has arrived.
certificateRecipientSchema.index({ job_id: 1, send_status: 1, next_retry_at: 1 });
certificateRecipientSchema.index({ job_id: 1, send_status: 1, claimed_at: 1 });

export default mongoose.model('CertificateRecipient', certificateRecipientSchema);
