const MIN_LENGTH = 8;

export function validatePassword(password) {
  const errors = [];
  const value = String(password || '');

  if (value.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters`);
  }
  if (!/[a-zA-Z]/.test(value)) {
    errors.push('Password must contain at least one letter');
  }
  if (!/\d/.test(value)) {
    errors.push('Password must contain at least one number');
  }

  return { valid: errors.length === 0, errors, minLength: MIN_LENGTH };
}

export function getPasswordStrength(password) {
  const value = String(password || '');
  if (!value) return { score: 0, label: '', color: '' };

  let score = 0;
  if (value.length >= 8) score++;
  if (value.length >= 12) score++;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
  if (/\d/.test(value)) score++;
  if (/[^a-zA-Z0-9]/.test(value)) score++;

  if (score <= 1) return { score: 1, label: 'Weak', color: 'red' };
  if (score <= 2) return { score: 2, label: 'Fair', color: 'amber' };
  if (score <= 3) return { score: 3, label: 'Good', color: 'blue' };
  return { score: 4, label: 'Strong', color: 'green' };
}
