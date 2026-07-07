import mongoose from 'mongoose';

// A single bulk-certificate send job. Files live only on local disk in a
// per-job folder and are deleted once the job reaches a terminal state — no
// cloud storage. The DB row is the durable source of truth for resume/reporting.
const certificateJobSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    // Lifecycle:
    //  ready     — extracted + matched, awaiting user review/send
    //  sending   — background delivery in progress
    //  paused    — user paused (or auto-paused; resumable)
    //  completed — all sendable recipients processed
    //  canceled  — user canceled; files cleaned
    //  failed    — unrecoverable setup error
    status: {
      type: String,
      enum: ['ready', 'sending', 'paused', 'completed', 'canceled', 'failed'],
      default: 'ready',
      index: true,
    },

    // Email template. {{name}} / {{email}} placeholders are personalized per recipient.
    subject: { type: String, required: true, trim: true },
    body: { type: String, required: true },

    // Sending account preference (null => rotate across all active accounts).
    gmail_account_id: { type: mongoose.Schema.Types.ObjectId, ref: 'GmailAccount', default: null },
    rotate_accounts: { type: Boolean, default: true },

    // On-disk temp storage (relative folder name under uploads/jobs/).
    job_dir: { type: String, required: true },
    zip_name: { type: String, default: '' },
    sheet_name: { type: String, default: '' },

    // How the certificates were provided: a ZIP of individually named PDFs,
    // or a single multi-page PDF (e.g. a Canva export) auto-split into pages.
    source_type: { type: String, enum: ['zip', 'pdf'], default: 'zip' },

    // Preview / diagnostics counts.
    total_pdfs: { type: Number, default: 0 },
    total_rows: { type: Number, default: 0 },
    matched_count: { type: Number, default: 0 },
    missing_certificate_count: { type: Number, default: 0 }, // rows with no PDF
    unmatched_pdf_count: { type: Number, default: 0 },       // PDFs with no row
    invalid_email_count: { type: Number, default: 0 },
    duplicate_count: { type: Number, default: 0 },
    ambiguous_name_count: { type: Number, default: 0 }, // rows sharing a name we couldn't safely auto-match

    // PDFs that matched no CSV row (kept for the review screen only).
    unmatched_pdfs: { type: [String], default: [] },

    // Send progress counters (kept in sync from CertificateRecipient).
    total_recipients: { type: Number, default: 0 }, // sendable (matched + valid + unique)
    sent_count: { type: Number, default: 0 },
    failed_count: { type: Number, default: 0 },
    pending_count: { type: Number, default: 0 },
    sending_count: { type: Number, default: 0 },
    skipped_count: { type: Number, default: 0 },

    // Credits reserved for this job's outstanding sends (3 per certificate).
    credits_reserved: { type: Number, default: 0, min: 0 },

    // Worker lock for single-writer background processing.
    worker_id: { type: String, default: null },
    worker_locked_at: { type: Date, default: null },

    started_at: { type: Date, default: null },
    completed_at: { type: Date, default: null },
    last_progress_at: { type: Date, default: null },

    // Auto-cleanup bookkeeping. expires_at drives the abandoned-job sweeper.
    files_deleted: { type: Boolean, default: false },
    cleaned_at: { type: Date, default: null },
    expires_at: { type: Date, default: null, index: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

certificateJobSchema.index({ user_id: 1, created_at: -1 });
certificateJobSchema.index({ status: 1, worker_locked_at: 1 });

export default mongoose.model('CertificateJob', certificateJobSchema);
