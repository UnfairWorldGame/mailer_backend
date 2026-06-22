export const DEFAULT_RECIPIENT_NAME = 'Champ';

export function resolveRecipientName(name) {
  const trimmed = String(name ?? '').trim();
  return trimmed || DEFAULT_RECIPIENT_NAME;
}

export function personalize(text, recipient = {}) {
  if (!text) return '';
  const name = resolveRecipientName(recipient.name);
  const email = recipient.email ?? '';
  return text
    .replace(/\{\{name\}\}/gi, name)
    .replace(/\{\{email\}\}/gi, email);
}
