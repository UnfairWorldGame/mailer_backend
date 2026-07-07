export const DEFAULT_RECIPIENT_NAME = 'Champ';

export function resolveRecipientName(name) {
  const trimmed = String(name ?? '').trim();
  return trimmed || DEFAULT_RECIPIENT_NAME;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Recipient name/email come from user-uploaded contact lists — untrusted input.
// When merging into HTML (the email body), they must be escaped or a contact
// named e.g. `<img src=x onerror=...>` injects markup into every recipient's inbox.
export function personalize(text, recipient = {}, { escapeHtml: shouldEscape = false } = {}) {
  if (!text) return '';
  const name = resolveRecipientName(recipient.name);
  const email = recipient.email ?? '';
  const safeName = shouldEscape ? escapeHtml(name) : name;
  const safeEmail = shouldEscape ? escapeHtml(email) : email;
  return text
    .replace(/\{\{name\}\}/gi, safeName)
    .replace(/\{\{email\}\}/gi, safeEmail);
}
