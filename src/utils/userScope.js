export function ownerFilter(userId, extra = {}) {
  return { user_id: userId, ...extra };
}
