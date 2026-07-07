// Lightweight server-side sanitizer for HTML that will be embedded into outbound
// campaign emails (and echoed back to the composer UI). AI/model output and any
// user-influenced HTML must pass through this before it is stored or sent, so a
// crafted response cannot inject executable content (stored XSS into the author's
// admin session or into recipients' inboxes).
//
// This is intentionally conservative and regex-based — it strips dangerous
// constructs rather than attempting to parse arbitrary HTML. It is a defense in
// depth layer; the frontend also sanitizes at render time (DOMPurify).

const DANGEROUS_BLOCKS = /<\s*(script|style|iframe|object|embed|link|meta|base|form|noscript)\b[\s\S]*?(<\s*\/\s*\1\s*>|$)/gi;
const SELF_CLOSING_DANGEROUS = /<\s*(script|iframe|object|embed|link|meta|base)\b[^>]*\/?\s*>/gi;
// on* event handler attributes: onclick=, onerror=, onload=, ... (quoted or bare)
const EVENT_HANDLERS = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
// javascript:, vbscript:, and non-image data: URIs inside attribute values
const DANGEROUS_URI = /((?:href|src|xlink:href)\s*=\s*)("|')?\s*(?:javascript|vbscript|data(?!:image\/)):[^"'>\s]*/gi;

export function sanitizeEmailHtml(html) {
  if (typeof html !== 'string' || !html) return '';

  let out = html;
  // Remove dangerous element blocks (and their content) first.
  out = out.replace(DANGEROUS_BLOCKS, '');
  out = out.replace(SELF_CLOSING_DANGEROUS, '');
  // Strip inline event handlers.
  out = out.replace(EVENT_HANDLERS, '');
  // Neutralize dangerous URI schemes in links/images.
  out = out.replace(DANGEROUS_URI, '$1$2#');

  return out;
}

// True if a URL is a safe http(s) link usable in an href. Everything else
// (javascript:, data:, relative, mailto without validation) is rejected.
export function isSafeHttpUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
