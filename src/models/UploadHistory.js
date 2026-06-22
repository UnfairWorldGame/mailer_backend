import mongoose from 'mongoose';

const uploadHistorySchema = new mongoose.Schema(
  {
    filename: { type: String, required: true },
    total_rows: { type: Number, default: 0 },
    inserted: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    status: { type: String, enum: ['success', 'failed'], default: 'success' },
    error_message: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

uploadHistorySchema.index({ created_at: -1 });

export default mongoose.model('UploadHistory', uploadHistorySchema);
