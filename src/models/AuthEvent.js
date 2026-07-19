import mongoose from 'mongoose';

/**
 * Append-only record of authentication activity. Without this there is no way
 * to detect a credential-stuffing run or reconstruct what an attacker touched
 * after a compromise.
 *
 * Never store the password, the token, or any digest of them here.
 */
const authEventSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    // Kept even when user_id is null (login attempt for an address with no
    // account), so failed-attempt patterns are still visible.
    email: { type: String, default: null, lowercase: true, trim: true, index: true },

    type: {
      type: String,
      required: true,
      enum: [
        'register',
        'login_success',
        'login_failed',
        'login_locked',
        'logout',
        'logout_all',
        'token_refresh',
        'token_reuse_detected',
        'password_reset_requested',
        'password_reset_completed',
        'password_changed',
        'email_verify_sent',
        'email_verify_completed',
        // Someone tried to sign up using an address on the ADMIN_EMAILS
        // break-glass list. Always worth a record: it is either a
        // misconfiguration or a targeted attempt at the admin surface.
        'register_blocked_admin_email',
        // Fallback so a type not yet listed here degrades to a recorded row
        // instead of a dropped audit entry.
        'other',
      ],
      index: true,
    },

    ip: { type: String, default: null },
    user_agent: { type: String, default: null },
    detail: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: false } }
);

authEventSchema.index({ created_at: -1 });
authEventSchema.index({ email: 1, type: 1, created_at: -1 });

export default mongoose.model('AuthEvent', authEventSchema);
