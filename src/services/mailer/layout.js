/**
 * One HTML shell for every transactional email.
 *
 * Each of the eight senders previously inlined its own full HTML string with
 * its own copy of escapeHtml, so a change to the footer or from-name meant
 * editing eight places and the emails had drifted visually apart.
 */

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BRAND = () => process.env.PASSWORD_RESET_FROM_NAME?.trim() || 'MAILIQ';

const TONE = {
  neutral: { accent: '#2563eb', chip: '#eff6ff' },
  success: { accent: '#059669', chip: '#ecfdf5' },
  warning: { accent: '#d97706', chip: '#fffbeb' },
  danger: { accent: '#dc2626', chip: '#fef2f2' },
};

/**
 * @param {object} opts
 * @param {string} opts.heading    Main title.
 * @param {string} [opts.greeting] e.g. "Hi Krishna,"
 * @param {string[]} [opts.paragraphs] Body copy. Callers must pre-escape any
 *   user-supplied value; these are emitted as HTML so links can be embedded.
 * @param {Array<{label:string,value:string}>} [opts.facts] Key/value summary rows.
 * @param {{label:string,url:string}} [opts.action] Primary button.
 * @param {string} [opts.footnote]
 * @param {'neutral'|'success'|'warning'|'danger'} [opts.tone]
 */
export function renderEmail({
  heading,
  greeting,
  paragraphs = [],
  facts = [],
  action,
  footnote,
  tone = 'neutral',
}) {
  const { accent, chip } = TONE[tone] || TONE.neutral;
  const brand = escapeHtml(BRAND());

  const factRows = facts.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;margin:20px 0;border-collapse:collapse;background:${chip};border-radius:10px">
        ${facts
          .map(
            (f) => `<tr>
              <td style="padding:10px 14px;color:#64748b;font-size:13px;white-space:nowrap">${escapeHtml(f.label)}</td>
              <td style="padding:10px 14px;color:#0f172a;font-size:14px;font-weight:600;text-align:right">${escapeHtml(f.value)}</td>
            </tr>`
          )
          .join('')}
      </table>`
    : '';

  const button = action
    ? `<p style="margin:26px 0">
        <a href="${action.url}" style="background:${accent};color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:8px;font-weight:600;display:inline-block;font-size:15px">${escapeHtml(action.label)}</a>
      </p>
      <p style="color:#94a3b8;font-size:12px;line-height:1.5;margin:0 0 18px">If the button doesn't work, copy this link into your browser:<br><a href="${action.url}" style="color:${accent};word-break:break-all">${action.url}</a></p>`
    : '';

  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#f8fafc">
  <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;background:#f8fafc;padding:24px 12px">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:540px;background:#ffffff;border-radius:14px;border:1px solid #e2e8f0;overflow:hidden">
        <tr><td style="padding:22px 28px 0">
          <p style="margin:0;font-size:15px;font-weight:700;color:${accent};letter-spacing:0.02em">${brand}</p>
        </td></tr>
        <tr><td style="padding:14px 28px 28px;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
          <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:#0f172a;font-weight:700">${escapeHtml(heading)}</h1>
          ${greeting ? `<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:1.6">${greeting}</p>` : ''}
          ${paragraphs.map((p) => `<p style="margin:0 0 12px;color:#475569;font-size:15px;line-height:1.6">${p}</p>`).join('')}
          ${factRows}
          ${button}
          ${footnote ? `<p style="margin:18px 0 0;padding-top:16px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;line-height:1.6">${footnote}</p>` : ''}
        </td></tr>
      </table>
      <p style="margin:16px 0 0;color:#94a3b8;font-size:11px;font-family:Inter,sans-serif">Sent by ${brand}. This is an automated message.</p>
    </td></tr>
  </table>
</body></html>`;
}

/** Plain-text alternative, so the email is not spam-scored as HTML-only. */
export function renderText({ heading, greeting, paragraphs = [], facts = [], action, footnote }) {
  const strip = (s) => String(s).replace(/<[^>]*>/g, '');
  return [
    heading,
    '',
    greeting ? strip(greeting) : null,
    ...paragraphs.map(strip),
    facts.length ? '' : null,
    ...facts.map((f) => `${f.label}: ${f.value}`),
    action ? `\n${action.label}: ${action.url}` : null,
    footnote ? `\n${strip(footnote)}` : null,
  ]
    .filter((line) => line !== null)
    .join('\n');
}
