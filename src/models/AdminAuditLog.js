import mongoose from 'mongoose';

// Append-only record of sensitive admin actions. Denormalizes admin/target
// identity at write time so the trail stays readable even if a name/email
// changes later or an account is removed.
const adminAuditLogSchema = new mongoose.Schema(
  {
    admin_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    admin_name: { type: String, default: '' },
    admin_email: { type: String, default: '' },
    action: {
      type: String,
      enum: [
        'grant_credits',
        'grant_free_credits',
        'revoke_credits',
        'refund_credits',
        'reconcile_credits',
        'user_role_change',
        'user_status_change',
      ],
      required: true,
    },
    target_user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    target_user_name: { type: String, default: '' },
    target_user_email: { type: String, default: '' },
    amount: { type: Number, default: null },
    reason: { type: String, default: null, trim: true },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

adminAuditLogSchema.index({ created_at: -1 });
adminAuditLogSchema.index({ admin_id: 1, created_at: -1 });

export default mongoose.model('AdminAuditLog', adminAuditLogSchema);
