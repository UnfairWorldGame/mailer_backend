import mongoose from 'mongoose';

const creditTransactionSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['purchase', 'send', 'refund', 'admin_grant', 'admin_revoke', 'reservation_release'],
      required: true,
    },
    amount: { type: Number, required: true },
    balance_after: { type: Number, required: true },
    campaign_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    payment_ref: { type: String, default: null, trim: true },
    pack_label: { type: String, default: null, trim: true },
    note: { type: String, default: null, trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

creditTransactionSchema.index({ user_id: 1, created_at: -1 });

export default mongoose.model('CreditTransaction', creditTransactionSchema);
