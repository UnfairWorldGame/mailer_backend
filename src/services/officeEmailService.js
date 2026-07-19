import { renderEmail, renderText, escapeHtml } from './mailer/layout.js';
import { enqueueEmail } from './mailer/outbox.js';
import { getAdminRecipients, isMailConfigured } from './mailer/transport.js';

/**
 * Support / sales mail (contact form, credit purchase requests).
 *
 * Rewritten onto the shared outbox + layout. Previously every sender here built
 * its own unpooled transport with no timeouts and no retry, and inlined its own
 * full HTML body — so POST /inquiries/contact awaited two sequential Gmail
 * handshakes inline, and a confirmation that failed was lost with only a
 * console line. It also had a dev fallback that returned `devLog: true`, which
 * callers treated as success: a non-production NODE_ENV reported "message sent"
 * to users while sending nothing.
 *
 * Credit-grant emails used to live here too; they now sit in mailer/emails.js
 * with the rest of the billing lifecycle.
 */

export function getContactInboxEmail() {
  return (
    process.env.CONTACT_INBOX_EMAIL?.trim().toLowerCase()
    || process.env.PASSWORD_RESET_SMTP_EMAIL?.trim().toLowerCase()
    || null
  );
}

export function isOfficeEmailConfigured() {
  return isMailConfigured();
}

export function getTeamNotificationRecipients() {
  return getAdminRecipients();
}

function build(opts) {
  return { html: renderEmail(opts), text: renderText(opts) };
}

/** Fan a team-facing message out to every configured admin address. */
async function sendToTeam({ type, subject, body, replyTo, metadata }) {
  const recipients = getTeamNotificationRecipients();
  if (!recipients.length) {
    return { sent: false, error: 'No team recipients configured' };
  }

  const results = await Promise.all(
    recipients.map((to) =>
      enqueueEmail({ type, to, subject, html: body.html, text: body.text, replyTo, metadata })
    )
  );

  return {
    // Queued counts as success for the caller: the outbox owns delivery from
    // here and will retry. Only a hard queue failure is reported as unsent.
    sent: results.some((r) => r.sent || r.queued),
    delivered: results.some((r) => r.sent),
    recipients: recipients.length,
  };
}

export async function sendCreditPurchaseRequestConfirmationEmail({ name, email, phone, packLabel, price, mails }) {
  const body = build({
    heading: 'We received your credit request',
    greeting: `Hi ${escapeHtml(name)},`,
    paragraphs: [
      'Thanks for your interest in MAILIQ credits. Our team will contact you shortly with payment details.',
      'Once your payment is confirmed the credits are added to your account immediately, and you will receive a receipt by email.',
    ],
    facts: [
      { label: 'Pack', value: packLabel || '—' },
      ...(price ? [{ label: 'Price', value: price }] : []),
      ...(mails ? [{ label: 'Credits', value: mails }] : []),
      { label: 'Contact number', value: phone || '—' },
    ],
    footnote: 'Replying to this email reaches our team directly.',
    tone: 'success',
  });

  return enqueueEmail({
    type: 'purchase_request_confirmation',
    to: email,
    subject: 'We received your MAILIQ credit request',
    ...body,
    metadata: { pack_label: packLabel || null },
  });
}

export async function sendCreditPurchaseTeamNotification({ name, email, phone, packLabel, price, mails }) {
  const body = build({
    heading: 'New credit purchase request',
    paragraphs: ['A customer has requested credits and is waiting on payment details.'],
    facts: [
      { label: 'Name', value: name },
      { label: 'Email', value: email },
      { label: 'Phone', value: phone },
      { label: 'Pack', value: packLabel || '—' },
      ...(price ? [{ label: 'Price', value: price }] : []),
      ...(mails ? [{ label: 'Credits', value: mails }] : []),
    ],
    footnote: 'Reply directly to this email to reach the customer.',
  });

  return sendToTeam({
    type: 'purchase_request_team',
    subject: `[MAILIQ] Credit request: ${packLabel || 'custom'} — ${email}`,
    body,
    replyTo: email,
    metadata: { customer_email: email, pack_label: packLabel || null },
  });
}

export async function sendContactFormConfirmationEmail({ name, email, message }) {
  const body = build({
    heading: 'We got your message',
    greeting: `Hi ${escapeHtml(name)},`,
    paragraphs: [
      'Thanks for reaching out to MAILIQ. Our team will get back to you shortly.',
      'For reference, here is what you sent us:',
    ],
    facts: [{ label: 'Your message', value: String(message || '').slice(0, 500) }],
    footnote: 'Replying to this email reaches our team directly.',
  });

  return enqueueEmail({
    type: 'contact_confirmation',
    to: email,
    subject: 'We received your message — MAILIQ',
    ...body,
  });
}

export async function sendOfficeInquiry({ subject, textLines = [], htmlSections = [], replyTo }) {
  const body = build({
    heading: subject || 'New inquiry',
    // htmlSections are pre-formatted by the caller; textLines are raw and must
    // be escaped before being emitted as HTML.
    paragraphs: htmlSections.length ? htmlSections : textLines.map((line) => escapeHtml(line)),
    footnote: replyTo ? `Reply directly to this email to reach ${escapeHtml(replyTo)}.` : undefined,
  });

  return sendToTeam({
    type: 'office_inquiry',
    subject: subject || '[MAILIQ] New inquiry',
    body,
    replyTo,
    metadata: { reply_to: replyTo || null },
  });
}
