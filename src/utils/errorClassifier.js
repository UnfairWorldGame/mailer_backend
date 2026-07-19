import { isRateLimitError } from '../services/accountRotator.js';

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ESOCKET',
  'EPIPE',
  'ETIMEOUT',
]);

const PERMANENT_CODES = new Set([
  'EAUTH',
  'EENVELOPE',
  'EMESSAGE',
]);

const PERMANENT_MESSAGE_PATTERNS = [
  /invalid.*email/i,
  /recipient.*rejected/i,
  /mailbox.*not found/i,
  /user unknown/i,
  /address rejected/i,
  /550[\s-]/i,
  /553[\s-]/i,
  /554[\s-]/i,
];

export function isTransientError(err) {
  if (!err) return false;
  if (isRateLimitError(err)) return true;

  const code = err.code || err.errno;
  if (code && TRANSIENT_CODES.has(String(code))) return true;

  const responseCode = err.responseCode;
  if (responseCode === 421 || responseCode === 450 || responseCode === 451 || responseCode === 452) {
    return true;
  }

  const msg = (err.message || '').toLowerCase();
  if (
    msg.includes('timeout') ||
    msg.includes('network') ||
    msg.includes('connection') ||
    msg.includes('socket') ||
    msg.includes('temporar') ||
    msg.includes('try again')
  ) {
    return true;
  }

  return false;
}

export function isPermanentError(err) {
  if (!err) return false;

  const code = err.code || err.errno;
  if (code && PERMANENT_CODES.has(String(code))) return true;

  const responseCode = err.responseCode;
  if (responseCode === 550 || responseCode === 553 || responseCode === 554) {
    return true;
  }

  const msg = err.message || '';
  return PERMANENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(msg));
}

export function classifySendError(err) {
  if (isPermanentError(err)) return 'permanent';
  if (isTransientError(err)) return 'transient';
  return 'unknown';
}

// Gmail rejects a bad/revoked App Password with 535-5.7.8 BadCredentials. This
// is a property of the *account*, not the recipient — retrying or moving to the
// next contact fails identically, so the caller should stop using the account
// rather than burn the whole recipient list.
export function isAuthError(err) {
  if (!err) return false;
  if (String(err.code || '') === 'EAUTH') return true;
  if (err.responseCode === 535) return true;
  return /535[\s-]|badcredentials|username and password not accepted|application-specific password/i.test(
    err.message || ''
  );
}

const ATTACHMENT_MISSING = /ENOENT|no such file or directory/i;

// Raw SMTP/nodemailer strings are unreadable in the campaign UI. Map the cases
// a user can actually act on to plain instructions; pass anything else through.
export function describeSendError(err, { accountEmail } = {}) {
  const raw = err?.message || 'Unknown error';
  const account = accountEmail ? ` for ${accountEmail}` : '';

  if (isAuthError(err)) {
    return `Gmail rejected the App Password${account}. Generate a new 16-character App Password at myaccount.google.com/apppasswords and update the account in Settings.`;
  }
  if (ATTACHMENT_MISSING.test(raw)) {
    return 'Attachment file is missing on the server. Re-upload the PDF to this campaign and send again.';
  }
  return raw;
}
