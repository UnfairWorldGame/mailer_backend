import mongoose from 'mongoose';

/**
 * Server-side half of the session. Access tokens are short-lived and stateless;
 * the refresh token is the revocable credential, stored only as a SHA-256
 * digest so a database leak cannot be replayed.
 *
 * Rotation: every refresh mints a new token and marks the old one used, linking
 * it via `replaced_by`. Presenting an already-used token means it leaked, so the
 * whole family is revoked (reuse detection).
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    token_hash: { type: String, required: true, unique: true },
    family_id: { type: String, required: true, index: true },

    expires_at: { type: Date, required: true },
    used_at: { type: Date, default: null },
    revoked_at: { type: Date, default: null },
    revoked_reason: { type: String, default: null },
    replaced_by: { type: String, default: null },

    // Coarse client fingerprint for the "active sessions" list. Deliberately not
    // used for validation — user agents and mobile IPs change legitimately, and
    // binding to them logs people out when they roam networks.
    user_agent: { type: String, default: null },
    ip: { type: String, default: null },
    last_used_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// Mongo reaps expired sessions on its own; no cleanup job needed.
refreshTokenSchema.index({ expires_at: 1 }, { expireAfterSeconds: 0 });

refreshTokenSchema.methods.isUsable = function isUsable() {
  return !this.revoked_at && !this.used_at && this.expires_at > new Date();
};

export default mongoose.model('RefreshToken', refreshTokenSchema);
