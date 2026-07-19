import crypto from 'crypto';
import EmailOutbox from '../../models/EmailOutbox.js';
import { getTransport, getFromAddress, isMailConfigured, isTransientMailError } from './transport.js';

/**
 * Queue-and-send with durable retry.
 *
 * Every transactional email is persisted BEFORE the send is attempted, so a
 * crash, an SMTP outage, or a deploy mid-flight leaves a queued row the sweeper
 * retries instead of an email that silently never existed.
 *
 * Sends are attempted inline (so the common case is immediate) but a failure is
 * never propagated to the caller — a credit grant that landed must not report
 * failure because its receipt bounced.
 */

const WORKER_ID = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;

// Exponential backoff between attempts: ~1m, 5m, 25m, 2h, 10h.
const BASE_RETRY_MS = 60 * 1000;
const RETRY_FACTOR = 5;
const MAX_RETRY_MS = 12 * 60 * 60 * 1000;

// A row claimed but never finalised (process died mid-send) is retryable again
// after this long.
const CLAIM_STALE_MS = 5 * 60 * 1000;

function backoffFor(attempts) {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * RETRY_FACTOR ** Math.max(0, attempts - 1));
}

/**
 * Queue an email and try to send it immediately.
 *
 * @returns {Promise<{queued:boolean, sent:boolean, id?:string, deduped?:boolean, error?:string}>}
 */
export async function enqueueEmail({
  type,
  to,
  subject,
  html,
  text = null,
  replyTo = null,
  userId = null,
  triggeredByAdminId = null,
  idempotencyKey = null,
  metadata = {},
  maxAttempts = 5,
  sendNow = true,
}) {
  if (!to || !subject || !html) {
    return { queued: false, sent: false, error: 'Missing recipient, subject, or body' };
  }

  let row;
  try {
    row = await EmailOutbox.create({
      type,
      to: String(to).trim().toLowerCase(),
      subject,
      html,
      text,
      reply_to: replyTo,
      user_id: userId,
      triggered_by_admin_id: triggeredByAdminId,
      idempotency_key: idempotencyKey,
      metadata,
      max_attempts: maxAttempts,
      status: 'queued',
    });
  } catch (err) {
    // Duplicate idempotency key — this email was already queued by an earlier
    // (possibly retried) request. Not an error.
    if (err?.code === 11000) {
      return { queued: false, sent: false, deduped: true };
    }
    console.error(`[outbox] failed to queue ${type}:`, err?.message);
    return { queued: false, sent: false, error: err?.message };
  }

  if (!sendNow) return { queued: true, sent: false, id: row._id.toString() };

  const result = await attemptSend(row);
  return { queued: true, sent: result.sent, id: row._id.toString(), error: result.error };
}

/**
 * Try one delivery of a claimed row. Never throws — the outcome is recorded on
 * the row and returned.
 */
async function attemptSend(row) {
  if (!isMailConfigured()) {
    await EmailOutbox.updateOne(
      { _id: row._id },
      {
        $set: {
          status: 'queued',
          last_error: 'SMTP not configured',
          next_attempt_at: new Date(Date.now() + backoffFor(1)),
        },
      }
    );
    return { sent: false, error: 'SMTP not configured' };
  }

  // Claim so a peer instance's sweeper cannot send the same row concurrently.
  const claimed = await EmailOutbox.findOneAndUpdate(
    { _id: row._id, status: { $in: ['queued', 'failed'] } },
    { $set: { status: 'sending', claimed_by: WORKER_ID, claimed_at: new Date() }, $inc: { attempts: 1 } },
    { new: true }
  );
  if (!claimed) return { sent: false, error: 'Already claimed' };

  try {
    const info = await getTransport().sendMail({
      from: getFromAddress(),
      to: claimed.to,
      subject: claimed.subject,
      html: claimed.html,
      text: claimed.text || undefined,
      replyTo: claimed.reply_to || undefined,
    });

    await EmailOutbox.updateOne(
      { _id: claimed._id },
      {
        $set: {
          status: 'sent',
          sent_at: new Date(),
          message_id: info.messageId || null,
          last_error: null,
          claimed_by: null,
          claimed_at: null,
        },
      }
    );
    return { sent: true };
  } catch (err) {
    const message = err?.message || 'Send failed';
    const transient = isTransientMailError(err);
    const exhausted = claimed.attempts >= claimed.max_attempts;

    // A permanent failure (bad credentials, rejected recipient) will fail
    // identically forever — park it as dead rather than burning retries.
    const status = !transient || exhausted ? 'dead' : 'failed';

    await EmailOutbox.updateOne(
      { _id: claimed._id },
      {
        $set: {
          status,
          last_error: message.slice(0, 500),
          next_attempt_at: new Date(Date.now() + backoffFor(claimed.attempts)),
          claimed_by: null,
          claimed_at: null,
        },
      }
    );

    // Recipient is deliberately not logged — that is PII in stdout.
    console.error(
      `[outbox] ${claimed.type} attempt ${claimed.attempts}/${claimed.max_attempts} -> ${status}: ${message}`
    );
    return { sent: false, error: message };
  }
}

/**
 * Retry everything due. Also reclaims rows stuck in `sending` from an instance
 * that died mid-send.
 */
export async function sweepOutbox({ limit = 50 } = {}) {
  if (!isMailConfigured()) return { attempted: 0, sent: 0, skipped: 'not_configured' };

  const now = new Date();

  await EmailOutbox.updateMany(
    { status: 'sending', claimed_at: { $lt: new Date(now.getTime() - CLAIM_STALE_MS) } },
    { $set: { status: 'failed', claimed_by: null, claimed_at: null } }
  );

  // Rows that have used their whole budget are retired here rather than being
  // handed one more attempt by the query below — otherwise max_attempts meant
  // "max_attempts + 1", and an address that will never accept mail kept costing
  // an SMTP round-trip on every sweep.
  await EmailOutbox.updateMany(
    {
      status: 'failed',
      next_attempt_at: { $lte: now },
      $expr: { $gte: ['$attempts', '$max_attempts'] },
    },
    { $set: { status: 'dead' } }
  );

  // 'queued' belongs here as much as 'failed'. A row is parked back in `queued`
  // whenever SMTP is unconfigured at send time, and a crash between the outbox
  // write and the send attempt leaves one there too — the exact durability case
  // this module's docstring promises. Sweeping only 'failed' meant those rows
  // were unreachable from the sweeper AND from the admin retry route, so every
  // password reset, verification and receipt queued during an SMTP outage was
  // stranded permanently and silently once SMTP came back.
  const due = await EmailOutbox.find({
    status: { $in: ['queued', 'failed'] },
    next_attempt_at: { $lte: now },
    $expr: { $lt: ['$attempts', '$max_attempts'] },
  })
    .sort({ next_attempt_at: 1 })
    .limit(limit);

  let sent = 0;
  for (const row of due) {
    const result = await attemptSend(row);
    if (result.sent) sent++;
  }

  return { attempted: due.length, sent };
}

/** Manual retry from the admin UI — resets a dead row and tries once now. */
export async function retryEmail(emailId) {
  const row = await EmailOutbox.findOneAndUpdate(
    { _id: emailId, status: { $in: ['queued', 'failed', 'dead'] } },
    { $set: { status: 'failed', next_attempt_at: new Date(), last_error: null } },
    { new: true }
  );
  if (!row) return null;
  const result = await attemptSend(row);
  return { id: row._id.toString(), sent: result.sent, error: result.error || null };
}

export async function getOutboxStats({ hours = 24 } = {}) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const [byStatus, recentFailures] = await Promise.all([
    EmailOutbox.aggregate([
      { $match: { created_at: { $gte: since } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    EmailOutbox.countDocuments({ status: { $in: ['failed', 'dead'] } }),
  ]);

  return {
    window_hours: hours,
    by_status: Object.fromEntries(byStatus.map((r) => [r._id, r.count])),
    outstanding_failures: recentFailures,
  };
}

export async function listOutbox({ status, type, search, page = 1, limit = 25 } = {}) {
  const filter = {};
  if (status && status !== 'all') filter.status = status;
  if (type && type !== 'all') filter.type = type;
  if (search?.trim()) {
    const safe = String(search).trim().slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.to = { $regex: safe, $options: 'i' };
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 25));

  const [rows, total] = await Promise.all([
    EmailOutbox.find(filter)
      // _id tiebreaker keeps pagination stable when timestamps collide.
      .sort({ created_at: -1, _id: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      // The rendered HTML is large and not useful in a list view.
      .select('-html -text')
      .lean(),
    EmailOutbox.countDocuments(filter),
  ]);

  return {
    data: rows.map((r) => ({
      id: r._id.toString(),
      type: r.type,
      to: r.to,
      subject: r.subject,
      status: r.status,
      attempts: r.attempts,
      max_attempts: r.max_attempts,
      last_error: r.last_error,
      next_attempt_at: r.next_attempt_at,
      sent_at: r.sent_at,
      created_at: r.created_at,
    })),
    total,
    page: pageNum,
    limit: limitNum,
    pages: Math.ceil(total / limitNum) || 1,
  };
}

export { WORKER_ID };
