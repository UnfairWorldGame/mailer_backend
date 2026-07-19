import nodemailer from 'nodemailer';

/**
 * The single platform SMTP transport for transactional mail.
 *
 * Previously getSmtpConfig() was duplicated verbatim in authMailer.js and
 * officeEmailService.js, and only the former was pooled or had timeouts — so
 * the credit-grant receipt (a receipt for real money) went out over an
 * unpooled connection with nodemailer's multi-minute default timeouts, inline
 * in the request.
 *
 * Per-user Gmail accounts for bulk campaign sending are a separate concern and
 * live in services/emailService.js.
 */

const SEND_TIMEOUT_MS = 20000;

let cachedTransport = null;
let cachedFingerprint = null;

export function getSmtpConfig() {
  const email = process.env.PASSWORD_RESET_SMTP_EMAIL?.trim().toLowerCase();
  // Google displays App Passwords as "abcd efgh ijkl mnop"; pasted verbatim
  // into .env they authenticate as 535-5.7.8 BadCredentials.
  const appPassword = process.env.PASSWORD_RESET_SMTP_APP_PASSWORD?.trim().replace(/\s+/g, '');
  if (!email || !appPassword) return null;
  return { email, appPassword };
}

export function isMailConfigured() {
  return Boolean(getSmtpConfig());
}

export function getFromAddress() {
  const smtp = getSmtpConfig();
  if (!smtp) return null;
  return {
    name: process.env.PASSWORD_RESET_FROM_NAME?.trim() || 'MAILIQ',
    address: smtp.email,
  };
}

export function getTransport() {
  const smtp = getSmtpConfig();
  if (!smtp) return null;

  const fingerprint = `${smtp.email}:${smtp.appPassword.length}`;
  if (cachedTransport && cachedFingerprint === fingerprint) return cachedTransport;
  if (cachedTransport) {
    try {
      cachedTransport.close();
    } catch {
      // A transport that already tore itself down is not an error worth raising.
    }
  }

  cachedTransport = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: smtp.email, pass: smtp.appPassword },
    pool: true,
    maxConnections: 3,
    maxMessages: 100,
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  });
  cachedFingerprint = fingerprint;
  return cachedTransport;
}

/** Startup probe — surfaces a bad App Password at boot, not at first send. */
export async function verifyTransport() {
  const transport = getTransport();
  if (!transport) return { ok: false, error: 'SMTP not configured' };
  try {
    await transport.verify();
    return { ok: true, from: getSmtpConfig().email };
  } catch (err) {
    return { ok: false, error: err?.message || 'SMTP verification failed' };
  }
}

export function closeTransport() {
  if (!cachedTransport) return;
  try {
    cachedTransport.close();
  } catch {
    // ignore
  }
  cachedTransport = null;
  cachedFingerprint = null;
}

/**
 * A rejected App Password or a malformed recipient fails identically on every
 * retry; only transient faults are worth queueing again.
 */
export function isTransientMailError(err) {
  const code = String(err?.code || '');
  if (['ETIMEDOUT', 'ECONNRESET', 'ESOCKET', 'ECONNECTION', 'EAI_AGAIN', 'EPIPE', 'ECONNREFUSED'].includes(code)) {
    return true;
  }
  const status = err?.responseCode;
  if (status === 421 || status === 450 || status === 451 || status === 452) return true;
  // 5xx and EAUTH are permanent.
  return false;
}

/** Who should receive operational/admin-facing notifications. */
export function getAdminRecipients() {
  const raw = [
    process.env.ADMIN_NOTIFY_EMAILS,
    process.env.ADMIN_EMAILS,
    process.env.CONTACT_INBOX_EMAIL,
  ]
    .filter(Boolean)
    .join(',');

  const seen = new Set();
  for (const entry of raw.split(',')) {
    const email = entry.trim().toLowerCase();
    if (email) seen.add(email);
  }
  return [...seen];
}
