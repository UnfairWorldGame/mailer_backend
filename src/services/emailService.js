import nodemailer from 'nodemailer';
import { personalize } from '../utils/personalize.js';

export function createTransporter(email, appPassword) {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: email,
      pass: appPassword,
    },
    pool: false,
  });
}

export async function sendCampaignEmail(account, recipient, subject, body, attachments = []) {
  const transporter = createTransporter(account.email, account.app_password);
  const personalizedSubject = personalize(subject, recipient);
  const personalizedBody = personalize(body, recipient);

  const mailAttachments = attachments.map((a) => ({
    filename: a.original_name,
    path: a.file_path,
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
  const transporter = createTransporter(account.email, account.app_password);
  await transporter.verify();
}
