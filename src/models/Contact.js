import mongoose from 'mongoose';

const contactSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    name: { type: String, default: '', trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

contactSchema.index({ user_id: 1, email: 1 }, { unique: true });
// Backs the paginated contact list (filter by user_id, sort by created_at desc).
contactSchema.index({ user_id: 1, created_at: -1 });

export default mongoose.model('Contact', contactSchema);
