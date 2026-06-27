import { createTransporter } from './emailService.js';
import { getAdminEmails } from '../utils/adminAccess.js';
import { getPrimaryFrontendUrl } from '../config/origins.js';

function getSmtpConfig() {
  const email = process.env.PASSWORD_RESET_SMTP_EMAIL?.trim().toLowerCase();
  const appPassword = process.env.PASSWORD_RESET_SMTP_APP_PASSWORD?.trim().replace(/\s+/g, '');
  if (!email || !appPassword) return null;
  return { email, appPassword };
}

export function getContactInboxEmail() {
  return (
    process.env.CONTACT_INBOX_EMAIL?.trim().toLowerCase()
    || process.env.PASSWORD_RESET_SMTP_EMAIL?.trim().toLowerCase()
    || 'hello@mailiq.app'
  );
}

export function isOfficeEmailConfigured() {
  return Boolean(getSmtpConfig());
}

export function getTeamNotificationRecipients() {
  const smtpOffice = process.env.PASSWORD_RESET_SMTP_EMAIL?.trim().toLowerCase();
  const contactInbox = process.env.CONTACT_INBOX_EMAIL?.trim().toLowerCase();
  const admins = getAdminEmails();
  return [...new Set([smtpOffice, contactInbox, ...admins].filter(Boolean))];
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-IN').format(value ?? 0);
}

function getFrontendUrl() {
  return getPrimaryFrontendUrl();
}

async function sendUserEmail({ to, subject, textLines, htmlBody, replyTo }) {
  const smtp = getSmtpConfig();
  const fromName = process.env.PASSWORD_RESET_FROM_NAME?.trim() || 'MAILIQ';
  const textBody = textLines.join('\n');

  if (!smtp) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[user-email] To: ${to}\nSubject: ${subject}\n${textBody}`);
      return { sent: false, devLog: true };
    }
    return { sent: false, error: 'Email service is not configured' };
  }

  try {
    const transporter = createTransporter(smtp.email, smtp.appPassword);
    await transporter.sendMail({
      from: `"${fromName}" <${smtp.email}>`,
      to,
      replyTo: replyTo || undefined,
      subject,
      text: textBody,
      html: htmlBody,
    });
    return { sent: true };
  } catch (err) {
    const message = err?.message || 'Failed to send email';
    console.error(`[user-email] Send failed to ${to}:`, message);
    return { sent: false, error: message };
  }
}

export async function sendCreditGrantConfirmationEmail(user, grant) {
  const fromName = process.env.PASSWORD_RESET_FROM_NAME?.trim() || 'MAILIQ';
  const supportEmail = getContactInboxEmail();
  const dashboardUrl = `${getFrontendUrl()}/dashboard`;
  const safeName = escapeHtml(user.name);
  const creditsGranted = formatNumber(grant.creditsGranted);
  const balance = formatNumber(grant.balanceAfter);
  const packLine = grant.packLabel ? `Pack: ${grant.packLabel}` : null;
  const paymentLine = grant.paymentRef ? `Payment reference: ${grant.paymentRef}` : null;
  const noteLine = grant.note ? `Note: ${grant.note}` : null;

  const subject = `${fromName} — ${creditsGranted} email credits added to your account`;

  const textLines = [
    `Hi ${user.name},`,
    '',
    `Your ${fromName} account has been credited with ${creditsGranted} email credits.`,
    `New balance: ${balance} credits.`,
    '',
    'You now have access to:',
    '- AI-powered email writing',
    '- Mail insights and analytics',
    '- Paid credit sending beyond the free daily limit',
    '',
    ...(packLine ? [packLine, ''] : []),
    ...(paymentLine ? [paymentLine, ''] : []),
    ...(noteLine ? [noteLine, ''] : []),
    `Open your dashboard: ${dashboardUrl}`,
    '',
    `Questions? Reply to this email or contact us at ${supportEmail}.`,
    '',
    `— The ${fromName} Team`,
  ];

  const htmlBody = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#312e81;margin:0 0 8px">Credits added to your account</h2>
      <p style="color:#64748b;margin:0 0 24px;font-size:14px">Official confirmation from ${escapeHtml(fromName)}</p>
      <p style="color:#475569;line-height:1.6">Hi ${safeName},</p>
      <p style="color:#475569;line-height:1.6">
        Your account has been credited with <strong style="color:#1e293b">${creditsGranted} email credits</strong>.
        Your new balance is <strong style="color:#1e293b">${balance} credits</strong>.
      </p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:24px 0">
        <p style="margin:0 0 8px;color:#1e293b;font-weight:600">What's unlocked</p>
        <ul style="margin:0;padding-left:20px;color:#475569;line-height:1.8">
          <li>AI-powered email writing</li>
          <li>Mail insights and analytics</li>
          <li>Paid credit sending beyond the free daily limit</li>
        </ul>
      </div>
      ${packLine ? `<p style="color:#475569;margin:0 0 8px"><strong>Pack:</strong> ${escapeHtml(grant.packLabel)}</p>` : ''}
      ${paymentLine ? `<p style="color:#475569;margin:0 0 8px"><strong>Payment reference:</strong> ${escapeHtml(grant.paymentRef)}</p>` : ''}
      ${noteLine ? `<p style="color:#475569;margin:0 0 8px"><strong>Note:</strong> ${escapeHtml(grant.note)}</p>` : ''}
      <p style="margin:28px 0">
        <a href="${dashboardUrl}" style="background:#ea580c;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Go to dashboard</a>
      </p>
      <p style="color:#94a3b8;font-size:13px;line-height:1.5">
        Questions? Reply to this email or contact us at
        <a href="mailto:${escapeHtml(supportEmail)}" style="color:#6366f1">${escapeHtml(supportEmail)}</a>.
      </p>
      <p style="color:#94a3b8;font-size:13px;margin-top:24px">— The ${escapeHtml(fromName)} Team</p>
    </div>
  `;

  return sendUserEmail({
    to: user.email,
    subject,
    textLines,
    htmlBody,
  });
}

export async function sendCreditPurchaseRequestConfirmationEmail({ name, email, phone, packLabel, price, mails }) {
  const fromName = process.env.PASSWORD_RESET_FROM_NAME?.trim() || 'MAILIQ';
  const supportEmail = getContactInboxEmail();
  const pricingUrl = `${getFrontendUrl()}/pricing`;
  const safeName = escapeHtml(name);
  const packDetails = [packLabel, price && `Price: ${price}`, mails && `Emails: ${mails}`].filter(Boolean).join(' · ');

  const subject = `${fromName} — we received your credit purchase request`;

  const textLines = [
    `Hi ${name},`,
    '',
    `Thank you for your interest in ${fromName} credits.`,
    '',
    'We have received your purchase request with the following details:',
    `Pack: ${packDetails}`,
    `Phone: ${phone}`,
    '',
    'Our team will contact you shortly with payment details and next steps.',
    'Once payment is confirmed, credits will be added to your account and you will receive another email confirmation.',
    '',
    `View pricing: ${pricingUrl}`,
    '',
    `Questions? Reply to this email or contact us at ${supportEmail}.`,
    '',
    `— The ${fromName} Team`,
  ];

  const htmlBody = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#312e81;margin:0 0 8px">Request received</h2>
      <p style="color:#64748b;margin:0 0 24px;font-size:14px">Official confirmation from ${escapeHtml(fromName)}</p>
      <p style="color:#475569;line-height:1.6">Hi ${safeName},</p>
      <p style="color:#475569;line-height:1.6">
        Thank you for your interest in ${escapeHtml(fromName)} credits. We have received your purchase request.
      </p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:24px 0">
        <p style="margin:0 0 8px;color:#1e293b;font-weight:600">Your request</p>
        <p style="margin:0 0 6px;color:#475569"><strong>Pack:</strong> ${escapeHtml(packDetails)}</p>
        <p style="margin:0;color:#475569"><strong>Phone:</strong> ${escapeHtml(phone)}</p>
      </div>
      <p style="color:#475569;line-height:1.6">
        <strong>Our team will contact you shortly</strong> with payment details and next steps.
        After payment is confirmed, credits will be added to your account and you will receive a separate confirmation email.
      </p>
      <p style="margin:28px 0">
        <a href="${pricingUrl}" style="background:#ea580c;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">View pricing</a>
      </p>
      <p style="color:#94a3b8;font-size:13px;line-height:1.5">
        Questions? Reply to this email or contact us at
        <a href="mailto:${escapeHtml(supportEmail)}" style="color:#6366f1">${escapeHtml(supportEmail)}</a>.
      </p>
      <p style="color:#94a3b8;font-size:13px;margin-top:24px">— The ${escapeHtml(fromName)} Team</p>
    </div>
  `;

  return sendUserEmail({
    to: email,
    subject,
    textLines,
    htmlBody,
  });
}

export async function sendCreditPurchaseTeamNotification({ name, email, phone, packLabel, price, mails }) {
  const fromName = process.env.PASSWORD_RESET_FROM_NAME?.trim() || 'MAILIQ';
  const recipients = getTeamNotificationRecipients();
  const adminUrl = `${getFrontendUrl()}/admin/credits`;
  const submittedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
  const packDetails = [packLabel, price && `Price: ${price}`, mails && `Emails: ${mails}`].filter(Boolean).join(' · ');

  const subject = `[Action required] Credit purchase request — ${packLabel} (${name})`;

  const textLines = [
    'New credit purchase request',
    '',
    `Submitted: ${submittedAt} (IST)`,
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    `Credit pack: ${packDetails}`,
    '',
    'Follow up with the customer for payment, then grant credits from the admin panel.',
    `Admin credits: ${adminUrl}`,
    '',
    `Reply directly to this email to reach the customer (${email}).`,
  ];

  const htmlBody = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#312e81;margin:0 0 8px">New credit purchase request</h2>
      <p style="color:#64748b;margin:0 0 24px;font-size:14px">${escapeHtml(fromName)} · ${escapeHtml(submittedAt)} IST</p>
      <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:16px;margin:0 0 20px">
        <p style="margin:0 0 12px;color:#9a3412;font-weight:600">Action required — contact customer with payment details</p>
        <p style="margin:0;color:#475569;font-size:14px">After payment, grant credits in Admin → Credits.</p>
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:14px;color:#475569">
        <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-weight:600;color:#1e293b;width:120px">Name</td><td style="padding:8px 0;border-bottom:1px solid #e2e8f0">${escapeHtml(name)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-weight:600;color:#1e293b">Email</td><td style="padding:8px 0;border-bottom:1px solid #e2e8f0"><a href="mailto:${escapeHtml(email)}" style="color:#6366f1">${escapeHtml(email)}</a></td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #e2e8f0;font-weight:600;color:#1e293b">Phone</td><td style="padding:8px 0;border-bottom:1px solid #e2e8f0"><a href="tel:${escapeHtml(phone)}" style="color:#6366f1">${escapeHtml(phone)}</a></td></tr>
        <tr><td style="padding:8px 0;font-weight:600;color:#1e293b">Credit pack</td><td style="padding:8px 0">${escapeHtml(packDetails)}</td></tr>
      </table>
      <p style="margin:28px 0">
        <a href="${adminUrl}" style="background:#ea580c;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Open admin credits</a>
      </p>
      <p style="color:#94a3b8;font-size:13px">Reply to this email to contact ${escapeHtml(name)} directly.</p>
    </div>
  `;

  if (!recipients.length) {
    return { sent: false, error: 'No team notification recipients configured' };
  }

  return sendUserEmail({
    to: recipients.join(', '),
    replyTo: email,
    subject,
    textLines,
    htmlBody,
  });
}

export async function sendContactFormConfirmationEmail({ name, email, message }) {
  const fromName = process.env.PASSWORD_RESET_FROM_NAME?.trim() || 'MAILIQ';
  const supportEmail = getContactInboxEmail();
  const safeName = escapeHtml(name);

  const subject = `${fromName} — we received your message`;

  const textLines = [
    `Hi ${name},`,
    '',
    `Thank you for contacting ${fromName}. We have received your message and will get back to you soon.`,
    '',
    'Your message:',
    message,
    '',
    `If you need to follow up sooner, reply to this email or write to ${supportEmail}.`,
    '',
    `— The ${fromName} Team`,
  ];

  const htmlBody = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#312e81;margin:0 0 8px">Message received</h2>
      <p style="color:#64748b;margin:0 0 24px;font-size:14px">Official confirmation from ${escapeHtml(fromName)}</p>
      <p style="color:#475569;line-height:1.6">Hi ${safeName},</p>
      <p style="color:#475569;line-height:1.6">
        Thank you for reaching out. We have received your message and our team will get back to you soon.
      </p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:24px 0">
        <p style="margin:0 0 8px;color:#1e293b;font-weight:600">Your message</p>
        <p style="margin:0;color:#475569;line-height:1.6;white-space:pre-wrap">${escapeHtml(message)}</p>
      </div>
      <p style="color:#94a3b8;font-size:13px;line-height:1.5">
        Need to follow up sooner? Reply to this email or contact us at
        <a href="mailto:${escapeHtml(supportEmail)}" style="color:#6366f1">${escapeHtml(supportEmail)}</a>.
      </p>
      <p style="color:#94a3b8;font-size:13px;margin-top:24px">— The ${escapeHtml(fromName)} Team</p>
    </div>
  `;

  return sendUserEmail({
    to: email,
    subject,
    textLines,
    htmlBody,
  });
}

export async function sendOfficeInquiry({ subject, textLines, htmlSections, replyTo }) {
  const recipients = getTeamNotificationRecipients();
  const fromName = process.env.PASSWORD_RESET_FROM_NAME?.trim() || 'MAILIQ';

  const htmlBody = `
    <div style="font-family:Inter,system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="color:#312e81;margin:0 0 16px">${escapeHtml(subject)}</h2>
      <p style="color:#64748b;margin:0 0 24px;font-size:14px">${escapeHtml(fromName)} · ${escapeHtml(new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))} IST</p>
      ${htmlSections.map(({ label, value }) => `
        <p style="margin:0 0 12px;color:#475569;line-height:1.6">
          <strong style="color:#1e293b">${escapeHtml(label)}:</strong><br>
          ${escapeHtml(value).replace(/\n/g, '<br>')}
        </p>
      `).join('')}
      ${replyTo ? `<p style="color:#94a3b8;font-size:13px;margin-top:24px">Reply to this email to contact the sender directly.</p>` : ''}
    </div>
  `;

  if (!recipients.length) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[inquiry] No recipients configured. Subject: ${subject}\n${textLines.join('\n')}`);
      return { sent: false, devLog: true };
    }
    return { sent: false, error: 'No team notification recipients configured' };
  }

  const smtp = getSmtpConfig();
  if (!smtp) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[inquiry] To: ${recipients.join(', ')}\nSubject: ${subject}\n${textLines.join('\n')}`);
      return { sent: false, devLog: true };
    }
    return { sent: false, error: 'Email service is not configured' };
  }

  return sendUserEmail({
    to: recipients.join(', '),
    replyTo,
    subject,
    textLines,
    htmlBody,
  });
}
