import crypto from 'crypto';
import { createTransporter } from './emailService.js';

const RESET_EXPIRY_MS = 60 * 60 * 1000;

export function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export function generateResetToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function getResetExpiry() {
  return new Date(Date.now() + RESET_EXPIRY_MS);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function getSmtpConfig() {
  const email = process.env.PASSWORD_RESET_SMTP_EMAIL?.trim().toLowerCase();
  const appPassword = process.env.PASSWORD_RESET_SMTP_APP_PASSWORD?.trim().replace(/\s+/g, '');
  if (!email || !appPassword) return null;
  return { email, appPassword };
}

export function buildResetUrl(rawToken) {
  const frontendUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/+$/, '');
  return `${frontendUrl}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

export function isPasswordResetConfigured() {
  return Boolean(getSmtpConfig());
}

export async function sendPasswordResetEmail(user, rawToken) {
  const resetUrl = buildResetUrl(rawToken);
  const fromName = process.env.PASSWORD_RESET_FROM_NAME?.trim() || 'MAILIQ';
  const safeName = escapeHtml(user.name);
  const smtp = getSmtpConfig();

  if (!smtp) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[password-reset] SMTP not configured. Reset link for ${user.email}:\n${resetUrl}`);
      return { sent: false, devLink: resetUrl, error: 'SMTP not configured' };
    }
    return { sent: false, error: 'Password reset email is not configured' };
  }

  try {
    const transporter = createTransporter(smtp.email, smtp.appPassword);
    await transporter.verify();

    await transporter.sendMail({
      from: `"${fromName}" <${smtp.email}>`,
      to: user.email,
      subject: 'Reset your MAILIQ password',
      text: [
        `Hi ${user.name},`,
        '',
        'We received a request to reset your password. Open this link to choose a new one:',
        resetUrl,
        '',
        'This link expires in 1 hour. If you did not request this, you can ignore this email.',
      ].join('\n'),
      html: `
      <div style="font-family:Inter,system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px">
        <h2 style="color:#312e81;margin:0 0 16px">Reset your password</h2>
        <p style="color:#475569;line-height:1.6">Hi ${safeName},</p>
        <p style="color:#475569;line-height:1.6">We received a request to reset your MAILIQ password. Click the button below — the link expires in <strong>1 hour</strong>.</p>
        <p style="margin:28px 0">
          <a href="${resetUrl}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:600;display:inline-block">Reset password</a>
        </p>
        <p style="color:#94a3b8;font-size:13px;line-height:1.5">If the button doesn't work, copy this URL into your browser:<br><a href="${resetUrl}" style="color:#6366f1;word-break:break-all">${resetUrl}</a></p>
        <p style="color:#94a3b8;font-size:13px;margin-top:24px">If you didn't request this, you can safely ignore this email.</p>
      </div>
    `,
    });

    return { sent: true };
  } catch (err) {
    const message = err?.message || 'Failed to send reset email';
    console.error(`[password-reset] Send failed for ${user.email} via ${smtp.email}:`, message);
    return { sent: false, error: message };
  }
}

export async function applyPasswordReset(user, rawToken, newPassword) {
  const hash = hashResetToken(rawToken);
  if (user.reset_token_hash !== hash) {
    return { ok: false, error: 'Invalid or expired reset link' };
  }
  if (!user.reset_token_expires || user.reset_token_expires <= new Date()) {
    return { ok: false, error: 'Reset link has expired. Please request a new one.' };
  }

  user.password = newPassword;
  user.reset_token_hash = null;
  user.reset_token_expires = null;
  await user.save();
  return { ok: true };
}
