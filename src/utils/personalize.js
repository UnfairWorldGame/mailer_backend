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
// Tolerant of the spacing an LLM (or a human) actually produces. The strict
// /\{\{name\}\}/ form missed "{{ name }}", "{{Name}}" with padding, and
// "{{first_name}}" — and a miss is not cosmetic: the raw token ships to the
// recipient's inbox as "Hello {{ name }},".
const NAME_TOKEN = /\{\{\s*(?:name|first[_\s-]?name|full[_\s-]?name|recipient)\s*\}\}/gi;
const EMAIL_TOKEN = /\{\{\s*(?:email|e[_\s-]?mail|recipient[_\s-]?email)\s*\}\}/gi;

export function personalize(text, recipient = {}, { escapeHtml: shouldEscape = false } = {}) {
  if (!text) return '';
  const name = resolveRecipientName(recipient.name);
  const email = recipient.email ?? '';
  const safeName = shouldEscape ? escapeHtml(name) : name;
  const safeEmail = shouldEscape ? escapeHtml(email) : email;
  return text.replace(NAME_TOKEN, safeName).replace(EMAIL_TOKEN, safeEmail);
}

/**
 * Rewrite any recognised token variant to its canonical form.
 *
 * Applied to AI output so what the user sees in the editor is exactly what the
 * send path will substitute — otherwise the model's "{{ name }}" would look
 * fine, preview fine, and then ship literally.
 */
export function canonicalizePlaceholders(text) {
  if (!text) return text;
  return String(text).replace(NAME_TOKEN, '{{name}}').replace(EMAIL_TOKEN, '{{email}}');
}

// Non-global copies: `.test()` on a /g regex advances lastIndex, so reusing the
// shared instances here would make repeat calls return alternating results.
const NAME_TOKEN_TEST = new RegExp(NAME_TOKEN.source, 'i');
const EMAIL_TOKEN_TEST = new RegExp(EMAIL_TOKEN.source, 'i');

/** Does this content contain at least one substitutable token? */
export function hasPlaceholder(text) {
  if (!text) return false;
  return NAME_TOKEN_TEST.test(text) || EMAIL_TOKEN_TEST.test(text);
}

export { NAME_TOKEN, EMAIL_TOKEN };
