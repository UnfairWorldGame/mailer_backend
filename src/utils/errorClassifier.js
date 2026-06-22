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
