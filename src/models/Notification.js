import mongoose from 'mongoose';

// Persisted in-app notifications (bell dropdown). Distinct from the ephemeral
// toast system on the frontend — these survive refresh/relogin and are polled.
const notificationSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: {
      type: String,
      enum: ['credit_grant', 'credit_revoke', 'system'],
      default: 'system',
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false, index: true },
    read_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

notificationSchema.index({ user_id: 1, created_at: -1 });
notificationSchema.index({ user_id: 1, read: 1 });
// Age out after 180 days so the collection doesn't grow unbounded.
notificationSchema.index({ created_at: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export default mongoose.model('Notification', notificationSchema);
