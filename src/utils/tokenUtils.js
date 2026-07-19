import crypto from 'crypto';

export const RESET_EXPIRY_MS = 60 * 60 * 1000; // 1 hour
export const VERIFY_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

/** 256 bits of entropy, URL-safe as hex. */
export function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Single-use tokens are stored only as a digest, so a database leak does not
 * hand an attacker working reset links. SHA-256 (not bcrypt) is correct here:
 * the input is already high-entropy, so there is nothing to brute force.
 */
export function hashToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken)).digest('hex');
}

/** Constant-time digest comparison — avoids leaking a prefix match via timing. */
export function tokensMatch(rawToken, storedHash) {
  if (!rawToken || !storedHash) return false;
  const a = Buffer.from(hashToken(rawToken), 'hex');
  const b = Buffer.from(String(storedHash), 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function getResetExpiry() {
  return new Date(Date.now() + RESET_EXPIRY_MS);
}

export function getVerifyExpiry() {
  return new Date(Date.now() + VERIFY_EXPIRY_MS);
}
