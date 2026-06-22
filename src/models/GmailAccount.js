import mongoose from 'mongoose';

const gmailAccountSchema = new mongoose.Schema(
  {
    label: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    app_password: { type: String, required: true },
    is_active: { type: Boolean, default: true },
    daily_send_limit: { type: Number, default: null },
    sends_today: { type: Number, default: 0 },
    sends_this_hour: { type: Number, default: 0 },
    last_daily_reset: { type: Date, default: Date.now },
    last_hourly_reset: { type: Date, default: Date.now },
    limit_reached: { type: Boolean, default: false },
    limit_reached_at: { type: Date, default: null },
    total_sent: { type: Number, default: 0 },
    last_sent_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

export default mongoose.model('GmailAccount', gmailAccountSchema);
