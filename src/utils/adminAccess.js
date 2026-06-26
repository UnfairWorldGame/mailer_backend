export function getAdminEmails() {
  return (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdminUser(user) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const email = user.email?.toLowerCase();
  return email ? getAdminEmails().includes(email) : false;
}

export function resolveUserRole(user) {
  return isAdminUser(user) ? 'admin' : 'user';
}
