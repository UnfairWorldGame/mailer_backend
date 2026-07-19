import nodemailer from 'nodemailer';
import { personalize } from '../utils/personalize.js';
import { resolveAttachmentPath } from '../middleware/pdfUpload.js';
import { sendConfig } from '../config/sendConfig.js';

/**
 * Socket timeouts must stay comfortably under `claimStaleMs` (default 5 min).
 * Without them nodemailer waits on its own much longer defaults, so a half-open
 * connection could hold a recipient's claim past the staleness window — at which
 * point recovery hands the recipient to another worker while the original send
 * is still in flight, and the contact receives the email twice.
 */
const SOCKET_TIMEOUT_MS = Math.min(60000, Math.floor(sendConfig.claimStaleMs / 4));

const TRANSPORT_OPTIONS = {
  service: 'gmail',
  // One connection per account, reused across the campaign: a fresh TCP+TLS+AUTH
  // handshake per recipient was both slow and a socket leak (transports were
  // never closed).
  pool: true,
  maxConnections: 1,
  maxMessages: 100,
  connectionTimeout: 20000,
  greetingTimeout: 15000,
  socketTimeout: SOCKET_TIMEOUT_MS,
};

/** accountId -> { transporter, secret } */
const transports = new Map();

export function createTransporter(email, appPassword) {
  return nodemailer.createTransport({
    ...TRANSPORT_OPTIONS,
    auth: { user: email, pass: appPassword },
  });
}

function getTransporter(account) {
  const key = account._id ? account._id.toString() : account.email;
  const secret = `${account.email}:${account.app_password}`;
  const cached = transports.get(key);

  // Rebuild when the credentials changed underneath us, so an updated App
  // Password takes effect without a restart.
  if (cached && cached.secret === secret) return cached.transporter;
  if (cached) closeTransport(key);

  const transporter = createTransporter(account.email, account.app_password);
  transports.set(key, { transporter, secret });
  return transporter;
}

export function closeTransport(accountId) {
  const key = accountId?.toString();
  const entry = transports.get(key);
  if (!entry) return;
  try {
    entry.transporter.close();
  } catch {
    // A transport that already tore itself down is not an error worth raising.
  }
  transports.delete(key);
}

/** Release every pooled connection — called when a campaign loop exits. */
export function closeAllTransports() {
  for (const key of [...transports.keys()]) closeTransport(key);
}

export async function sendCampaignEmail(account, recipient, subject, body, attachments = []) {
  const transporter = getTransporter(account);
  const personalizedSubject = personalize(subject, recipient);
  const personalizedBody = personalize(body, recipient, { escapeHtml: true });

  const mailAttachments = attachments.map((a) => ({
    filename: a.original_name,
    path: resolveAttachmentPath(a.file_path),
    contentType: a.mime_type || 'application/pdf',
  }));

  const info = await transporter.sendMail({
    from: `"${account.label}" <${account.email}>`,
    to: recipient.email,
    subject: personalizedSubject,
    html: personalizedBody,
    text: personalizedBody.replace(/<[^>]*>/g, ''),
    attachments: mailAttachments,
  });

  return info;
}

export async function verifyAccountConnection(account) {
  // Deliberately not pooled: a verify is a one-shot check and must not leave a
  // connection behind or reuse a cached transport built from stale credentials.
  const transporter = createTransporter(account.email, account.app_password);
  try {
    await transporter.verify();
  } finally {
    try {
      transporter.close();
    } catch {
      // ignore
    }
  }
}
