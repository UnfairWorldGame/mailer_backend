/**
 * Merge-field substitution.
 *
 * The failure this guards against is not subtle: an unmatched token ships to
 * the recipient's inbox as a literal "Hello {{ name }},". The strict
 * /\{\{name\}\}/ pattern matched only the canonical spelling, while the AI
 * prompt asks for {{name}} and the model drifts to "{{ name }}", "{{Name}}" and
 * "{{first_name}}" freely.
 *
 * The frontend copy in frontend/src/utils/personalize.js must stay in lockstep —
 * a preview that substitutes what the send path does not is worse than no
 * preview, because it actively reassures the user.
 *
 * Usage:  node scripts/test-personalization.mjs
 */
import {
  personalize,
  canonicalizePlaceholders,
  hasPlaceholder,
} from '../src/utils/personalize.js';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

const recipient = { name: 'Jane Smith', email: 'jane@example.com' };

console.log('\nname token variants');
for (const token of [
  '{{name}}', '{{ name }}', '{{Name}}', '{{  NAME  }}',
  '{{first_name}}', '{{first name}}', '{{first-name}}',
  '{{full_name}}', '{{recipient}}',
]) {
  const out = personalize(`Hello ${token},`, recipient);
  check(`substitutes ${token}`, out === 'Hello Jane Smith,', out);
}

console.log('\nemail token variants');
for (const token of ['{{email}}', '{{ email }}', '{{EMAIL}}', '{{e_mail}}', '{{recipient_email}}']) {
  const out = personalize(`Reach me at ${token}`, recipient);
  check(`substitutes ${token}`, out === 'Reach me at jane@example.com', out);
}

console.log('\ncanonicalisation of AI output');
check('spaced name token is normalised', canonicalizePlaceholders('Hi {{ name }}') === 'Hi {{name}}');
check('first_name is normalised', canonicalizePlaceholders('Hi {{First_Name}}') === 'Hi {{name}}');
check('email token is normalised', canonicalizePlaceholders('At {{ EMAIL }}') === 'At {{email}}');
check('plain text is untouched', canonicalizePlaceholders('No tokens here') === 'No tokens here');
check('unknown tokens are left alone', canonicalizePlaceholders('{{company}}') === '{{company}}');
check('null input is safe', canonicalizePlaceholders(null) === null);

console.log('\ndetection');
check('detects a spaced token', hasPlaceholder('Hello {{ name }}') === true);
check('no false positive on plain text', hasPlaceholder('Hello there') === false);
// A /g regex advances lastIndex on .test(), so a shared instance would flip
// between true and false on alternating calls.
check(
  'repeat calls are stable',
  hasPlaceholder('{{name}}') === true && hasPlaceholder('{{name}}') === true
);
check('empty input is false', hasPlaceholder('') === false);

console.log('\nsafety and edge cases');
check(
  'escapes HTML in the substituted name',
  personalize('Hi {{name}}', { name: '<img src=x onerror=alert(1)>' }, { escapeHtml: true })
    .includes('&lt;img')
);
check(
  'does not escape when not asked (plain-text subject)',
  personalize('Hi {{name}}', { name: 'A & B' }) === 'Hi A & B'
);
check('blank name falls back to the default', personalize('Hi {{name}}', { name: '   ' }) === 'Hi Champ');
check('missing recipient does not throw', personalize('Hi {{name}}') === 'Hi Champ');
check('empty body returns empty', personalize('', recipient) === '');
check('null body returns empty', personalize(null, recipient) === '');
check(
  'replaces every occurrence',
  personalize('{{name}} <{{email}}> hi {{name}}', recipient)
    === 'Jane Smith <jane@example.com> hi Jane Smith'
);
check(
  'substitutes across HTML markup',
  personalize('<p>Hello {{ name }},</p>', recipient, { escapeHtml: true })
    === '<p>Hello Jane Smith,</p>'
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
