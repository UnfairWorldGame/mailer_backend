import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {
  generateResetToken,
  getResetExpiry,
  hashResetToken,
} from '../services/passwordResetService.js';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    is_active: { type: Boolean, default: true },
    reset_token_hash: { type: String, default: null, select: false },
    reset_token_expires: { type: Date, default: null, select: false },
    email_credits: { type: Number, default: 0, min: 0 },
    free_sent_today: { type: Number, default: 0, min: 0 },
    free_quota_date: { type: String, default: null },
    reserved_credits: { type: Number, default: 0, min: 0 },
    has_paid_access: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.issuePasswordResetToken = async function issuePasswordResetToken() {
  const rawToken = generateResetToken();
  this.reset_token_hash = hashResetToken(rawToken);
  this.reset_token_expires = getResetExpiry();
  await this.save();
  return rawToken;
};

userSchema.methods.clearPasswordResetToken = async function clearPasswordResetToken() {
  this.reset_token_hash = null;
  this.reset_token_expires = null;
  await this.save();
};

userSchema.statics.findByResetToken = function findByResetToken(rawToken) {
  if (!rawToken) return null;
  return this.findOne({
    reset_token_hash: hashResetToken(rawToken),
    reset_token_expires: { $gt: new Date() },
  }).select('+password +reset_token_hash +reset_token_expires');
};

export default mongoose.model('User', userSchema);
