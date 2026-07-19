export function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminUser(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return isEnvAdmin(user);
}

/**
 * True only for accounts named in ADMIN_EMAILS — the break-glass list that
 * cannot be locked out from the database.
 *
 * Distinct from isAdminUser on purpose: the is_active exemption in requireAuth
 * must apply to *these* accounts only. Using isAdminUser there let any
 * suspended DB admin keep working on their existing token.
 */
export function isEnvAdmin(user) {
  const email = user?.email?.toLowerCase();
  return email ? getAdminEmails().includes(email) : false;
}

export function resolveUserRole(user) {
  return isAdminUser(user) ? 'admin' : 'user';
}
