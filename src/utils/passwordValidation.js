const MIN_LENGTH = 10;

// bcrypt silently truncates at 72 *bytes*. Without an explicit cap, two long
// passwords sharing a 72-byte prefix authenticate interchangeably, so reject
// anything longer rather than pretending to store it.
const MAX_BYTES = 72;

// The passwords that actually show up in credential-stuffing lists. Not a
// substitute for a breach-corpus check, but it removes the free wins.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234',
  'passw0rd', 'p@ssword', 'p@ssw0rd', 'passsword', 'password!',
  '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910',
  'qwerty', 'qwerty123', 'qwertyuiop', 'qwerty1234', 'asdfghjkl',
  'letmein', 'letmein123', 'welcome', 'welcome1', 'welcome123',
  'admin', 'admin123', 'administrator', 'root123', 'toor1234',
  'iloveyou', 'iloveyou1', 'sunshine', 'princess', 'football',
  'monkey123', 'dragon123', 'baseball1', 'superman1', 'batman123',
  'abc12345', 'abcd1234', 'abcdefgh', 'a1b2c3d4', 'test1234',
  'changeme', 'changeme1', 'secret123', 'trustno1', 'whatever1',
  'michael1', 'jennifer1', 'jordan123', 'harley123', 'ranger123',
  'shadow123', 'master123', 'hunter123', 'buster123', 'thomas123',
  'mailiq123', 'mailiq1234', 'gmail123', 'google123', 'india123',
]);

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * Reject passwords built from the user's own identifiers — "krishna2024" for
 * krishna@gmail.com is trivially guessable by anyone who knows the address.
 */
function containsIdentity(password, { email, name } = {}) {
  const lower = password.toLowerCase();
  const candidates = [];

  const localPart = String(email || '').split('@')[0];
  if (localPart.length >= 4) candidates.push(localPart.toLowerCase());

  for (const part of String(name || '').split(/\s+/)) {
    if (part.length >= 4) candidates.push(part.toLowerCase());
  }

  return candidates.some((c) => lower.includes(c));
}

export function validatePassword(password, context = {}) {
  const errors = [];
  const value = String(password || '');

  if (value.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters`);
  }
  if (byteLength(value) > MAX_BYTES) {
    errors.push(`Password must be ${MAX_BYTES} bytes or fewer (about ${MAX_BYTES} characters)`);
  }
  if (!/[a-zA-Z]/.test(value)) {
    errors.push('Password must contain at least one letter');
  }
  if (!/\d/.test(value)) {
    errors.push('Password must contain at least one number');
  }
  if (/^\s|\s$/.test(value)) {
    errors.push('Password cannot start or end with a space');
  }
  if (COMMON_PASSWORDS.has(value.toLowerCase())) {
    errors.push('That password is too common. Choose something harder to guess.');
  }
  if (value && containsIdentity(value, context)) {
    errors.push('Password cannot contain your name or email address');
  }

  return { valid: errors.length === 0, errors, minLength: MIN_LENGTH, maxBytes: MAX_BYTES };
}

export function getPasswordStrength(password) {
  const value = String(password || '');
  if (!value) return { score: 0, label: '', color: '' };

  let score = 0;
  if (value.length >= 10) score++;
  if (value.length >= 14) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/\d/.test(value)) score++;
  if (/[^a-zA-Z0-9]/.test(value)) score++;

  if (COMMON_PASSWORDS.has(value.toLowerCase())) return { score: 1, label: 'Weak', color: 'red' };
  if (score <= 1) return { score: 1, label: 'Weak', color: 'red' };
  if (score <= 2) return { score: 2, label: 'Fair', color: 'amber' };
  if (score <= 3) return { score: 3, label: 'Good', color: 'blue' };
  return { score: 4, label: 'Strong', color: 'green' };
}

export { MIN_LENGTH, MAX_BYTES };
