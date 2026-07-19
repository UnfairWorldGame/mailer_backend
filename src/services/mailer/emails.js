import { getPrimaryFrontendUrl } from '../../config/origins.js';
import { renderEmail, renderText, escapeHtml } from './layout.js';
import { enqueueEmail } from './outbox.js';
import { getAdminRecipients } from './transport.js';

/**
 * Every transactional email the platform sends, in one place.
 *
 * All of them go through the outbox, so each is durable and retried. Senders
 * return the outbox result rather than throwing: an email failure must never
 * fail the operation that triggered it.
 */

const nf = new Intl.NumberFormat('en-IN');
const appUrl = () => getPrimaryFrontendUrl();

function build(opts) {
  return { html: renderEmail(opts), text: renderText(opts) };
}

/** Fan out one admin-facing notification to every configured admin address. */
async function notifyAdmins({ type, subject, body, idempotencyKey, metadata = {}, triggeredByAdminId = null }) {
  const recipients = getAdminRecipients();
  if (!recipients.length) return { queued: false, sent: false, error: 'No admin recipients configured' };

  const results = await Promise.all(
    recipients.map((to) =>
      enqueueEmail({
        type,
        to,
        subject,
        html: body.html,
        text: body.text,
        triggeredByAdminId,
        // Namespaced per recipient so one address failing does not block another.
        idempotencyKey: idempotencyKey ? `${idempotencyKey}:${to}` : null,
        metadata,
      })
    )
  );

  return { queued: true, sent: results.some((r) => r.sent), recipients: recipients.length };
}

// ─────────────────────────────────────────────────────────── account lifecycle

export function sendWelcomeEmail(user) {
  const body = build({
    heading: `Welcome to MAILIQ, ${escapeHtml(user.name)}`,
    greeting: 'Your account is ready.',
    paragraphs: [
      'MAILIQ lets you upload a contact list, personalise every message, and send through your own Gmail account — with delivery tracking on every recipient.',
      'Confirm your email address to unlock sending. Until then you can explore the workspace, import contacts, and draft campaigns.',
    ],
    facts: [
      { label: 'Account', value: user.email },
      { label: 'Free allowance', value: '100 credits every day' },
      { label: 'Cost', value: '1 credit per email, 3 per certificate' },
    ],
    action: { label: 'Open your workspace', url: `${appUrl()}/dashboard` },
    footnote: 'Need a hand getting started? Just reply to this email.',
    tone: 'success',
  });

  return enqueueEmail({
    type: 'welcome',
    to: user.email,
    subject: 'Welcome to MAILIQ',
    ...body,
    userId: user._id,
    idempotencyKey: `welcome:${user._id}`,
    metadata: { user_email: user.email },
  });
}

export function sendVerificationEmail(user, rawToken) {
  const url = `${appUrl()}/verify-email?token=${encodeURIComponent(rawToken)}`;
  const body = build({
    heading: 'Confirm your email address',
    greeting: `Hi ${escapeHtml(user.name)},`,
    paragraphs: [
      'Confirm your email to unlock campaign and certificate sending on your MAILIQ account.',
      'This link expires in <strong>24 hours</strong>.',
    ],
    action: { label: 'Confirm email', url },
    footnote: "If you didn't create a MAILIQ account, you can safely ignore this email.",
  });

  return enqueueEmail({
    type: 'email_verification',
    to: user.email,
    subject: 'Confirm your MAILIQ email address',
    ...body,
    userId: user._id,
    // Deliberately no idempotency key: a resend must actually send again.
    metadata: { user_email: user.email },
  });
}

export function sendEmailConfirmedEmail(user) {
  const body = build({
    heading: 'Email confirmed',
    greeting: `Hi ${escapeHtml(user.name)},`,
    paragraphs: [
      'Your email address is confirmed and sending is now unlocked on your account.',
      'You can create a campaign, upload contacts, and send through your connected Gmail accounts.',
    ],
    action: { label: 'Create a campaign', url: `${appUrl()}/campaigns/new` },
    tone: 'success',
  });

  return enqueueEmail({
    type: 'email_confirmed',
    to: user.email,
    subject: 'Your MAILIQ email is confirmed',
    ...body,
    userId: user._id,
    idempotencyKey: `email_confirmed:${user._id}`,
  });
}

export function sendPasswordResetEmail(user, rawToken) {
  const url = `${appUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`;
  const body = build({
    heading: 'Reset your password',
    greeting: `Hi ${escapeHtml(user.name)},`,
    paragraphs: [
      'We received a request to reset your MAILIQ password.',
      'This link expires in <strong>1 hour</strong> and can only be used once.',
    ],
    action: { label: 'Reset password', url },
    footnote:
      "If you didn't request this, you can safely ignore this email — your password will not change. Resetting also signs you out everywhere.",
  });

  return enqueueEmail({
    type: 'password_reset',
    to: user.email,
    subject: 'Reset your MAILIQ password',
    ...body,
    userId: user._id,
    metadata: { user_email: user.email },
  });
}

/** Security notice after a password actually changes. */
export function sendPasswordChangedEmail(user, { reason = 'changed' } = {}) {
  const body = build({
    heading: 'Your password was changed',
    greeting: `Hi ${escapeHtml(user.name)},`,
    paragraphs: [
      reason === 'reset'
        ? 'Your MAILIQ password was just reset and every existing session was signed out.'
        : 'Your MAILIQ password was just changed and every other session was signed out.',
      '<strong>If this was not you</strong>, reset your password immediately and contact us.',
    ],
    action: { label: 'Reset password', url: `${appUrl()}/forgot-password` },
    tone: 'warning',
  });

  return enqueueEmail({
    type: 'password_changed',
    to: user.email,
    subject: 'Your MAILIQ password was changed',
    ...body,
    userId: user._id,
  });
}

// ───────────────────────────────────────────────────────────────────── billing

export function sendCreditGrantEmail(user, { credits, balanceAfter, packLabel, paymentRef, note, free = false }) {
  const body = build({
    heading: free ? 'Free credits added to your account' : 'Credits added to your account',
    greeting: `Hi ${escapeHtml(user.name)},`,
    paragraphs: [
      free
        ? `We've added ${nf.format(credits)} complimentary credits to your MAILIQ account.`
        : `Thank you — your payment is confirmed and ${nf.format(credits)} credits have been added to your MAILIQ account.`,
      ...(note ? [`Note: ${escapeHtml(note)}`] : []),
    ],
    facts: [
      { label: 'Credits added', value: nf.format(credits) },
      { label: 'New balance', value: `${nf.format(balanceAfter)} credits` },
      ...(packLabel ? [{ label: 'Pack', value: packLabel }] : []),
      ...(paymentRef && !free ? [{ label: 'Payment reference', value: paymentRef }] : []),
    ],
    action: { label: 'Go to your dashboard', url: `${appUrl()}/dashboard` },
    footnote: 'Credits never expire. Keep this email as your receipt.',
    tone: 'success',
  });

  return enqueueEmail({
    type: free ? 'credit_grant_free' : 'credit_grant',
    to: user.email,
    subject: free ? 'Free credits added to your MAILIQ account' : 'Payment confirmed — credits added',
    ...body,
    userId: user._id,
    // One receipt per grant, keyed to the same reference that dedupes the grant.
    idempotencyKey: paymentRef ? `grant_receipt:${paymentRef}` : null,
    metadata: { credits, balance_after: balanceAfter, pack_label: packLabel || null },
  });
}

export function sendCreditRefundEmail(user, { credits, balanceAfter, note, isRefund, reversalRef }) {
  const body = build({
    heading: isRefund ? 'Refund processed' : 'Credit balance adjusted',
    greeting: `Hi ${escapeHtml(user.name)},`,
    paragraphs: [
      isRefund
        ? `A refund has been processed and ${nf.format(credits)} credits were removed from your MAILIQ account.`
        : `An administrator adjusted your MAILIQ credit balance by ${nf.format(credits)} credits.`,
      ...(note ? [`Reason: ${escapeHtml(note)}`] : []),
      'If this looks wrong, reply to this email and we will review it.',
    ],
    facts: [
      { label: isRefund ? 'Credits refunded' : 'Credits removed', value: nf.format(credits) },
      { label: 'New balance', value: `${nf.format(balanceAfter)} credits` },
      ...(reversalRef ? [{ label: 'Reference', value: reversalRef }] : []),
    ],
    tone: 'warning',
  });

  return enqueueEmail({
    type: isRefund ? 'credit_refund' : 'credit_revoke',
    to: user.email,
    subject: isRefund ? 'Your MAILIQ refund has been processed' : 'Your MAILIQ credit balance was adjusted',
    ...body,
    userId: user._id,
    idempotencyKey: reversalRef ? `refund_receipt:${reversalRef}` : null,
    metadata: { credits, balance_after: balanceAfter, is_refund: Boolean(isRefund) },
  });
}

// ────────────────────────────────────────────────────────── account moderation

export function sendAccountStatusEmail(user, { active, reason }) {
  const body = active
    ? build({
        heading: 'Your account has been reactivated',
        greeting: `Hi ${escapeHtml(user.name)},`,
        paragraphs: [
          'Your MAILIQ account is active again. You can sign in and resume sending.',
          ...(reason ? [`Note: ${escapeHtml(reason)}`] : []),
        ],
        action: { label: 'Sign in', url: `${appUrl()}/login` },
        tone: 'success',
      })
    : build({
        heading: 'Your account has been suspended',
        greeting: `Hi ${escapeHtml(user.name)},`,
        paragraphs: [
          'Your MAILIQ account has been suspended and sending is disabled. Your data and remaining credits are preserved.',
          ...(reason ? [`Reason: ${escapeHtml(reason)}`] : []),
          'If you believe this is a mistake, reply to this email and we will look into it.',
        ],
        tone: 'danger',
      });

  return enqueueEmail({
    type: active ? 'account_reactivated' : 'account_suspended',
    to: user.email,
    subject: active ? 'Your MAILIQ account has been reactivated' : 'Your MAILIQ account has been suspended',
    ...body,
    userId: user._id,
    metadata: { active, reason: reason || null },
  });
}

export function sendRoleChangedEmail(user, { role }) {
  const isAdmin = role === 'admin';
  const body = build({
    heading: isAdmin ? 'You now have administrator access' : 'Your access level changed',
    greeting: `Hi ${escapeHtml(user.name)},`,
    paragraphs: [
      isAdmin
        ? 'Your MAILIQ account has been granted administrator access. You can now manage users, credits, and platform settings.'
        : 'Your MAILIQ administrator access has been removed. Your account and campaigns are unaffected.',
      '<strong>If you did not expect this change</strong>, contact us immediately.',
    ],
    facts: [{ label: 'New role', value: isAdmin ? 'Administrator' : 'Standard user' }],
    tone: isAdmin ? 'success' : 'warning',
  });

  return enqueueEmail({
    type: 'role_changed',
    to: user.email,
    subject: isAdmin ? 'You now have MAILIQ administrator access' : 'Your MAILIQ access level changed',
    ...body,
    userId: user._id,
    metadata: { role },
  });
}

// ──────────────────────────────────────────────────────── admin notifications

export function notifyAdminsOfSignup(user) {
  const body = build({
    heading: 'New user registered',
    paragraphs: ['A new account was created on MAILIQ.'],
    facts: [
      { label: 'Name', value: user.name },
      { label: 'Email', value: user.email },
      { label: 'Registered', value: new Date().toISOString() },
    ],
    action: { label: 'Open admin users', url: `${appUrl()}/admin/users` },
  });

  return notifyAdmins({
    type: 'admin_new_signup',
    subject: `New MAILIQ signup: ${user.email}`,
    body,
    idempotencyKey: `admin_signup:${user._id}`,
    metadata: { user_id: user._id?.toString(), user_email: user.email },
  });
}

export function notifyAdminsOfCreditChange({ user, admin, credits, balanceAfter, action, reference, note }) {
  const isRemoval = action === 'refund' || action === 'revoke';
  const body = build({
    heading: `Credits ${action} — ${user.email}`,
    paragraphs: [
      `${escapeHtml(admin?.name || 'An administrator')} (${escapeHtml(admin?.email || 'unknown')}) ${
        isRemoval ? 'removed' : 'granted'
      } ${nf.format(credits)} credits.`,
      ...(note ? [`Note: ${escapeHtml(note)}`] : []),
    ],
    facts: [
      { label: 'User', value: `${user.name} <${user.email}>` },
      { label: 'Action', value: action },
      { label: 'Credits', value: nf.format(credits) },
      { label: 'New balance', value: `${nf.format(balanceAfter)} credits` },
      ...(reference ? [{ label: 'Reference', value: reference }] : []),
    ],
    tone: isRemoval ? 'warning' : 'neutral',
  });

  return notifyAdmins({
    type: 'admin_credit_change',
    subject: `[MAILIQ] Credits ${action}: ${nf.format(credits)} for ${user.email}`,
    body,
    triggeredByAdminId: admin?.id || null,
    idempotencyKey: reference ? `admin_credit:${action}:${reference}` : null,
    metadata: { action, credits, user_email: user.email },
  });
}

export function notifyAdminsOfAccountChange({ user, admin, change, detail }) {
  const body = build({
    heading: `Account ${change} — ${user.email}`,
    paragraphs: [
      `${escapeHtml(admin?.name || 'An administrator')} (${escapeHtml(admin?.email || 'unknown')}) changed this account.`,
    ],
    facts: [
      { label: 'User', value: `${user.name} <${user.email}>` },
      { label: 'Change', value: change },
      ...(detail ? [{ label: 'Detail', value: detail }] : []),
    ],
    action: { label: 'View user', url: `${appUrl()}/admin/users` },
    tone: 'warning',
  });

  return notifyAdmins({
    type: 'admin_account_change',
    subject: `[MAILIQ] Account ${change}: ${user.email}`,
    body,
    triggeredByAdminId: admin?.id || null,
    metadata: { change, user_email: user.email },
  });
}

export { notifyAdmins };
