import AdminAuditLog from '../models/AdminAuditLog.js';

export async function recordAuditLog({
  adminId,
  adminName = '',
  adminEmail = '',
  action,
  targetUserId = null,
  targetUserName = '',
  targetUserEmail = '',
  amount = null,
  reason = null,
  metadata = {},
}) {
  return AdminAuditLog.create({
    admin_id: adminId,
    admin_name: adminName,
    admin_email: adminEmail,
    action,
    target_user_id: targetUserId,
    target_user_name: targetUserName,
    target_user_email: targetUserEmail,
    amount,
    reason,
    metadata,
  });
}

export async function listAuditLogs({ page = 1, limit = 30, action = '' } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const safePage = Math.max(parseInt(page, 10) || 1, 1);
  const filter = {};
  if (action && action !== 'all') filter.action = action;

  const [rows, total] = await Promise.all([
    AdminAuditLog.find(filter)
      .sort({ created_at: -1 })
      .skip((safePage - 1) * safeLimit)
      .limit(safeLimit)
      .lean(),
    AdminAuditLog.countDocuments(filter),
  ]);

  return {
    data: rows.map((row) => ({
      id: row._id.toString(),
      admin: { id: row.admin_id?.toString(), name: row.admin_name, email: row.admin_email },
      action: row.action,
      target_user: row.target_user_id
        ? { id: row.target_user_id.toString(), name: row.target_user_name, email: row.target_user_email }
        : null,
      amount: row.amount,
      reason: row.reason,
      metadata: row.metadata,
      created_at: row.created_at,
    })),
    total,
    page: safePage,
    limit: safeLimit,
    pages: Math.ceil(total / safeLimit) || 1,
  };
}
