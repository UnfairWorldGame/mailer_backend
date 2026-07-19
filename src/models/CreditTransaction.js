import mongoose from 'mongoose';

const creditTransactionSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['purchase', 'send', 'refund', 'admin_grant', 'admin_free_grant', 'admin_revoke', 'reservation_release'],
      required: true,
    },
    amount: { type: Number, required: true },
    balance_after: { type: Number, required: true },
    campaign_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
    certificate_job_id: { type: mongoose.Schema.Types.ObjectId, ref: 'CertificateJob', default: null },
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Idempotency key for credit grants: the payment reference for a paid
    // grant, or a client-generated request id for a discretionary free grant.
    payment_ref: { type: String, default: null, trim: true },
    pack_label: { type: String, default: null, trim: true },
    note: { type: String, default: null, trim: true },
    // Set on a grant row when a later refund reverses it. Reversed rows keep
    // their history but surrender the payment_ref (moved to reversed_ref) so a
    // corrected re-grant of the same payment is not blocked forever by the
    // unique index.
    reversed_at: { type: Date, default: null },
    reversed_ref: { type: String, default: null, trim: true },
    reverses_transaction_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CreditTransaction',
      default: null,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

creditTransactionSchema.index({ user_id: 1, created_at: -1 });
// Admin analytics aggregate by type over a date range.
creditTransactionSchema.index({ type: 1, created_at: -1 });

// Grants are the one place double-writing costs real money: an admin
// double-click or a retried POST would otherwise credit the same payment twice.
// A findOne-then-$inc check cannot prevent that (both requests read before
// either writes), so uniqueness is enforced by the database and the ledger row
// is written BEFORE the balance moves — see grantCredits in quotaService.js.
// Partial so the many rows with payment_ref: null are unaffected.
creditTransactionSchema.index(
  { payment_ref: 1 },
  { unique: true, partialFilterExpression: { payment_ref: { $type: 'string' } } }
);

export default mongoose.model('CreditTransaction', creditTransactionSchema);
