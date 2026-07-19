import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import {
  generateRawToken,
  getResetExpiry,
  getVerifyExpiry,
  hashToken,
  tokensMatch,
} from '../utils/tokenUtils.js';

const BCRYPT_ROUNDS = 12;

// Throttle for repeated failed logins against a single account. IP rate limiting
// alone does not stop distributed credential stuffing aimed at one user.
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    is_active: { type: Boolean, default: true },

    email_verified: { type: Boolean, default: false },
    email_verified_at: { type: Date, default: null },
    verify_token_hash: { type: String, default: null, select: false },
    verify_token_expires: { type: Date, default: null, select: false },
    verify_sent_at: { type: Date, default: null, select: false },

    reset_token_hash: { type: String, default: null, select: false },
    reset_token_expires: { type: Date, default: null, select: false },
    reset_sent_at: { type: Date, default: null, select: false },

    // Bumped on password change, reset, and "sign out everywhere". Access tokens
    // carry the value they were minted with; requireAuth rejects any mismatch,
    // which is the only way to kill a stateless JWT before it expires.
    token_version: { type: Number, default: 0 },
    password_changed_at: { type: Date, default: null },

    failed_login_count: { type: Number, default: 0, select: false },
    lockout_until: { type: Date, default: null, select: false },
    last_login_at: { type: Date, default: null },

    email_credits: { type: Number, default: 0, min: 0 },
    free_sent_today: { type: Number, default: 0, min: 0 },
    free_quota_date: { type: String, default: null },
    reserved_credits: { type: Number, default: 0, min: 0 },
    has_paid_access: { type: Boolean, default: false },
    // Lifetime running totals — never reset, used for the profile analytics
    // section. Updated atomically alongside the credit they track.
    lifetime_credits_used: { type: Number, default: 0, min: 0 },
    lifetime_credits_received: { type: Number, default: 0, min: 0 },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Both single-use token lookups are unauthenticated entry points; without an
// index each call is a full collection scan and a cheap DoS lever.
userSchema.index({ reset_token_hash: 1 });
userSchema.index({ verify_token_hash: 1 });

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, BCRYPT_ROUNDS);
  // Skip on create — a brand new account has no sessions to invalidate, and
  // stamping it here would make every first access token look stale.
  if (!this.isNew) {
    this.password_changed_at = new Date();
    this.token_version = (this.token_version || 0) + 1;
  }
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  if (!this.password) return Promise.resolve(false);
  return bcrypt.compare(String(candidate ?? ''), this.password);
};

userSchema.methods.isLockedOut = function isLockedOut() {
  return Boolean(this.lockout_until && this.lockout_until > new Date());
};

userSchema.methods.registerFailedLogin = async function registerFailedLogin() {
  const count = (this.failed_login_count || 0) + 1;
  const update = { failed_login_count: count };
  if (count >= MAX_FAILED_LOGINS) {
    update.lockout_until = new Date(Date.now() + LOCKOUT_MS);
    update.failed_login_count = 0;
  }
  await this.constructor.updateOne({ _id: this._id }, { $set: update });
  return update.lockout_until ?? null;
};

userSchema.methods.registerSuccessfulLogin = async function registerSuccessfulLogin() {
  await this.constructor.updateOne(
    { _id: this._id },
    { $set: { failed_login_count: 0, lockout_until: null, last_login_at: new Date() } }
  );
};

userSchema.methods.issuePasswordResetToken = async function issuePasswordResetToken() {
  const rawToken = generateRawToken();
  this.reset_token_hash = hashToken(rawToken);
  this.reset_token_expires = getResetExpiry();
  this.reset_sent_at = new Date();
  await this.save();
  return rawToken;
};

userSchema.methods.clearPasswordResetToken = async function clearPasswordResetToken() {
  this.reset_token_hash = null;
  this.reset_token_expires = null;
  await this.save();
};

userSchema.methods.issueEmailVerifyToken = async function issueEmailVerifyToken() {
  const rawToken = generateRawToken();
  this.verify_token_hash = hashToken(rawToken);
  this.verify_token_expires = getVerifyExpiry();
  this.verify_sent_at = new Date();
  await this.save();
  return rawToken;
};

userSchema.methods.confirmEmailVerification = async function confirmEmailVerification(rawToken) {
  if (!tokensMatch(rawToken, this.verify_token_hash)) {
    return { ok: false, error: 'Invalid or expired verification link' };
  }
  if (!this.verify_token_expires || this.verify_token_expires <= new Date()) {
    return { ok: false, error: 'Verification link has expired. Request a new one.' };
  }

  this.email_verified = true;
  this.email_verified_at = new Date();
  // The hash is deliberately retained until it expires. Mail clients prefetch
  // links and users click them twice; nulling it here made the second visit
  // report "invalid or expired" to someone who had just verified successfully.
  // Replay is harmless — confirming an already-confirmed address is a no-op,
  // and issuing a new token overwrites this one.
  await this.save();
  return { ok: true };
};

userSchema.statics.findByResetToken = function findByResetToken(rawToken) {
  if (!rawToken) return null;
  return this.findOne({
    reset_token_hash: hashToken(rawToken),
    reset_token_expires: { $gt: new Date() },
  }).select('+password +reset_token_hash +reset_token_expires');
};

userSchema.statics.findByVerifyToken = function findByVerifyToken(rawToken) {
  if (!rawToken) return null;
  return this.findOne({
    verify_token_hash: hashToken(rawToken),
  }).select('+verify_token_hash +verify_token_expires');
};

export default mongoose.model('User', userSchema);
export { MAX_FAILED_LOGINS, LOCKOUT_MS, BCRYPT_ROUNDS };
