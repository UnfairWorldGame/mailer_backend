import mongoose from 'mongoose';
import { encryptSecret, decryptSecret } from '../utils/credentialCrypto.js';

const gmailAccountSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    label: { type: String, required: true, trim: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    // Encrypted at rest (AES-256-GCM) via the setter/getter pair below.
    //
    // These are live SMTP credentials that send mail *as the user* from Google's
    // own infrastructure, so a leaked Atlas snapshot, a backup, or one careless
    // aggregation used to hand an attacker the customer's real mailbox. Getters
    // run on property access, so account.app_password still yields cleartext for
    // nodemailer, while what sits in Mongo is ciphertext.
    //
    // Google displays App Passwords grouped as "abcd efgh ijkl mnop". Pasted
    // verbatim, Gmail SMTP rejects the login with 535-5.7.8 BadCredentials, so
    // strip whitespace before encrypting — every write path goes through here.
    app_password: {
      type: String,
      required: true,
      set: (v) => encryptSecret(typeof v === 'string' ? v.replace(/\s+/g, '') : v),
      get: (v) => decryptSecret(v),
    },
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

gmailAccountSchema.index({ user_id: 1, email: 1 }, { unique: true });

// Redaction was previously manual and per-route (`delete api.app_password`),
// while toApiDoc spreads the whole document — so any new route returning a
// GmailAccount leaked the credential by default. Strip it in the serializers
// instead, so forgetting is no longer possible. Code that needs the secret
// reads `account.app_password` off the document, which is unaffected.
function redact(_doc, ret) {
  delete ret.app_password;
  return ret;
}
gmailAccountSchema.set('toJSON', { transform: redact });
gmailAccountSchema.set('toObject', { transform: redact });

export default mongoose.model('GmailAccount', gmailAccountSchema);
