import crypto from 'crypto';

/**
 * Envelope encryption for credentials we must be able to *use* (not just
 * verify), so hashing is not an option — Gmail App Passwords have to be handed
 * to nodemailer in cleartext at send time.
 *
 * Format: enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * The prefix is what makes this migration-safe: `decryptSecret` returns
 * anything without it unchanged, so rows written before this existed keep
 * working, and `scripts/encrypt-credentials.mjs` re-writes them in place.
 */

const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

let cachedKey;
let warnedMissing = false;

/**
 * Accepts 64 hex chars or 32 raw bytes base64-encoded. Returns null when unset,
 * which downgrades to storing plaintext — deliberately, so that a missing key
 * cannot lock every user out of sending. The boot warning below is the signal.
 */
function loadKey() {
  if (cachedKey !== undefined) return cachedKey;

  const raw = (process.env.CREDENTIAL_ENCRYPTION_KEY || '').trim();
  if (!raw) {
    cachedKey = null;
    return cachedKey;
  }

  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, 'hex');
  } else {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) key = decoded;
  }

  if (!key) {
    throw new Error(
      'CREDENTIAL_ENCRYPTION_KEY must be 64 hex characters or 32 bytes base64-encoded. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }

  cachedKey = key;
  return cachedKey;
}

/** Test seam — clears the memoized key after changing the env var. */
export function resetCredentialKeyCache() {
  cachedKey = undefined;
}

export function isCredentialEncryptionConfigured() {
  return loadKey() !== null;
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

export function encryptSecret(plain) {
  const value = typeof plain === 'string' ? plain : String(plain ?? '');
  if (!value) return value;
  // Never double-wrap: Mongoose runs setters on every assignment, including
  // when a document is re-saved with an already-encrypted value loaded from DB.
  if (isEncrypted(value)) return value;

  const key = loadKey();
  if (!key) {
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        '[security] CREDENTIAL_ENCRYPTION_KEY is not set — Gmail App Passwords are being ' +
        'stored in PLAINTEXT. Set it and run: node scripts/encrypt-credentials.mjs'
      );
    }
    return value;
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

export function decryptSecret(stored) {
  if (typeof stored !== 'string' || !stored) return stored;
  if (!isEncrypted(stored)) return stored; // legacy plaintext row

  const key = loadKey();
  if (!key) {
    throw new Error(
      'This account\'s App Password is encrypted but CREDENTIAL_ENCRYPTION_KEY is not set. ' +
      'Restore the key to the environment — without it these credentials cannot be recovered.'
    );
  }

  const [ivB64, tagB64, dataB64] = stored.slice(PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Stored credential is malformed and cannot be decrypted.');
  }

  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Authentication failure means the key does not match the one used to
    // encrypt. Say so plainly — the alternative is an opaque SMTP auth error
    // that sends the operator hunting Gmail settings instead of their config.
    throw new Error(
      'Could not decrypt this account\'s App Password — CREDENTIAL_ENCRYPTION_KEY does not ' +
      'match the key it was encrypted with. Restore the original key, or re-enter the App Password.'
    );
  }
}

/** Boot-time diagnostic. */
export function reportCredentialEncryptionStatus() {
  if (isCredentialEncryptionConfigured()) {
    console.log('[security] Credential encryption enabled (AES-256-GCM)');
  } else {
    console.warn(
      '[security] CREDENTIAL_ENCRYPTION_KEY is not set — Gmail App Passwords will be stored ' +
      'in PLAINTEXT. Anyone with database read access gets working SMTP credentials for every ' +
      'connected account. Generate a key, set it, and run scripts/encrypt-credentials.mjs'
    );
  }
}
