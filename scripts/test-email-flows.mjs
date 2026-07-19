/**
 * Exercises the transactional email system: queueing, durability, retry,
 * dedupe, dead-lettering, and the lifecycle senders.
 *
 * Emails are addressed to @example.com (RFC 2606 — guaranteed undeliverable, no
 * real inbox is ever touched). SMTP is deliberately NOT required: the point is
 * that a send failure still leaves a durable, retryable row rather than
 * vanishing, which is exactly what the old code got wrong.
 *
 * Usage:  node scripts/test-email-flows.mjs [--keep]
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const keep = process.argv.includes('--keep');
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

await mongoose.connect(process.env.MONGODB_URI);

const EmailOutbox = (await import('../src/models/EmailOutbox.js')).default;
const User = (await import('../src/models/User.js')).default;
const outbox = await import('../src/services/mailer/outbox.js');
const emails = await import('../src/services/mailer/emails.js');
const layout = await import('../src/services/mailer/layout.js');
const transport = await import('../src/services/mailer/transport.js');

const created = [];
const tag = `${Date.now()}${Math.floor(Math.random() * 1000)}`;

async function makeUser(name) {
  const email = `mailtest-${name}-${tag}@example.com`;
  created.push(email);
  return User.create({
    name: `Mail ${name}`,
    email,
    password: 'Str0ngPassphrase!2026',
    email_verified: true,
  });
}

const rowsFor = (to) => EmailOutbox.find({ to }).sort({ created_at: 1 }).lean();

console.log('\ntransactional email\n');

// ────────────────────────────────────────────────────────────── durability
console.log('outbox durability');
{
  const to = `durable-${tag}@example.com`;
  created.push(to);

  const result = await outbox.enqueueEmail({
    type: 'test_durable',
    to,
    subject: 'Durability check',
    html: '<p>hello</p>',
    text: 'hello',
  });

  check('enqueue persists a row', result.queued === true, JSON.stringify(result));

  const rows = await rowsFor(to);
  check('exactly one row written', rows.length === 1, `${rows.length} rows`);
  check('row records the recipient and type',
    rows[0]?.to === to && rows[0]?.type === 'test_durable');
  check('row reaches a terminal-or-retryable state',
    ['sent', 'failed', 'dead', 'queued'].includes(rows[0]?.status), rows[0]?.status);
  check('an attempt was recorded', rows[0]?.attempts >= 1, `${rows[0]?.attempts}`);

  // The critical property: a failed send is still on disk, with an error and a
  // scheduled retry, rather than gone.
  if (rows[0]?.status !== 'sent') {
    check('failed send retains the error', Boolean(rows[0]?.last_error), 'no last_error');
    check('failed send has a next attempt scheduled', Boolean(rows[0]?.next_attempt_at));
  } else {
    check('sent row records a message id', Boolean(rows[0]?.message_id));
    check('sent row records sent_at', Boolean(rows[0]?.sent_at));
  }
}

// ────────────────────────────────────────────────────────────────── dedupe
console.log('\nidempotency');
{
  const to = `dedupe-${tag}@example.com`;
  created.push(to);
  const key = `test-key-${tag}`;

  const first = await outbox.enqueueEmail({
    type: 'test_dedupe', to, subject: 'S', html: '<p>x</p>', idempotencyKey: key,
  });
  const second = await outbox.enqueueEmail({
    type: 'test_dedupe', to, subject: 'S', html: '<p>x</p>', idempotencyKey: key,
  });

  check('first enqueue is accepted', first.queued === true);
  check('duplicate key is deduped, not queued twice', second.deduped === true, JSON.stringify(second));
  check('only one row exists for the key',
    (await EmailOutbox.countDocuments({ idempotency_key: key })) === 1);
}

// ───────────────────────────────────────────────────────────── permanent vs transient
console.log('\nfailure classification');
{
  check('EAUTH is permanent', transport.isTransientMailError({ code: 'EAUTH' }) === false);
  check('535 bad credentials is permanent',
    transport.isTransientMailError({ responseCode: 535 }) === false);
  check('ETIMEDOUT is transient', transport.isTransientMailError({ code: 'ETIMEDOUT' }) === true);
  check('421 is transient', transport.isTransientMailError({ responseCode: 421 }) === true);
  check('550 rejected recipient is permanent',
    transport.isTransientMailError({ responseCode: 550 }) === false);
}

// ───────────────────────────────────────────────────────────────────── retry
console.log('\nretry + sweep');
{
  const to = `retry-${tag}@example.com`;
  created.push(to);

  // A row parked as failed and already due — exactly what a crashed send or an
  // SMTP outage during a deploy leaves behind.
  const row = await EmailOutbox.create({
    type: 'test_retry',
    to,
    subject: 'Retry me',
    html: '<p>retry</p>',
    status: 'failed',
    attempts: 1,
    next_attempt_at: new Date(Date.now() - 1000),
    last_error: 'simulated outage',
  });

  const sweep = await outbox.sweepOutbox({ limit: 10 });
  check('sweep picks up due failed rows', sweep.attempted >= 1, JSON.stringify(sweep));

  const after = await EmailOutbox.findById(row._id).lean();
  check('retried row advanced its attempt count', after.attempts > 1, `${after.attempts}`);
  check('retried row is no longer stuck in "sending"', after.status !== 'sending', after.status);

  // Manual retry from the admin UI.
  await EmailOutbox.updateOne({ _id: row._id }, { $set: { status: 'dead' } });
  const manual = await outbox.retryEmail(row._id.toString());
  check('a dead email can be retried by an admin', manual !== null, 'returned null');
}

// ──────────────────────────────────────────────────────── stale claim recovery
console.log('\ncrash recovery');
{
  const to = `stale-${tag}@example.com`;
  created.push(to);

  // A row left claimed by an instance that died mid-send.
  const row = await EmailOutbox.create({
    type: 'test_stale',
    to,
    subject: 'Stale claim',
    html: '<p>x</p>',
    status: 'sending',
    attempts: 1,
    claimed_by: 'dead-worker',
    claimed_at: new Date(Date.now() - 10 * 60 * 1000),
  });

  await outbox.sweepOutbox({ limit: 10 });
  const after = await EmailOutbox.findById(row._id).lean();
  check('a claim orphaned by a dead worker is reclaimed', after.status !== 'sending', after.status);
  check('the orphaned claim is released', after.claimed_by !== 'dead-worker', after.claimed_by);
}

// ──────────────────────────────────────────────────────── dead-letter behaviour
console.log('\ndead-lettering');
{
  const to = `dead-${tag}@example.com`;
  created.push(to);

  const row = await EmailOutbox.create({
    type: 'test_dead',
    to,
    subject: 'Exhausted',
    html: '<p>x</p>',
    status: 'failed',
    attempts: 5,
    max_attempts: 5,
    next_attempt_at: new Date(Date.now() - 1000),
  });

  await outbox.sweepOutbox({ limit: 10 });
  const after = await EmailOutbox.findById(row._id).lean();
  check('an exhausted row is parked as dead, not retried forever',
    after.status === 'dead', after.status);
  check('an exhausted row is not given another attempt',
    after.attempts === 5, `attempts=${after.attempts}`);
}

// ───────────────────────────────────────────────────────── lifecycle senders
console.log('\nlifecycle emails');
{
  const user = await makeUser('lifecycle');

  await emails.sendWelcomeEmail(user);
  await emails.sendVerificationEmail(user, 'a'.repeat(64));
  await emails.sendEmailConfirmedEmail(user);
  await emails.sendPasswordResetEmail(user, 'b'.repeat(64));
  await emails.sendPasswordChangedEmail(user, { reason: 'reset' });
  await emails.sendCreditGrantEmail(user, {
    credits: 1000, balanceAfter: 1000, packLabel: 'Starter', paymentRef: `pay-${tag}`,
  });
  await emails.sendCreditRefundEmail(user, {
    credits: 400, balanceAfter: 600, isRefund: true, reversalRef: `rev-${tag}`,
  });
  await emails.sendAccountStatusEmail(user, { active: false, reason: 'Policy review' });
  await emails.sendAccountStatusEmail(user, { active: true });
  await emails.sendRoleChangedEmail(user, { role: 'admin' });

  const rows = await rowsFor(user.email);
  const types = rows.map((r) => r.type);

  for (const expected of [
    'welcome',
    'email_verification',
    'email_confirmed',
    'password_reset',
    'password_changed',
    'credit_grant',
    'credit_refund',
    'account_suspended',
    'account_reactivated',
    'role_changed',
  ]) {
    check(`queues ${expected}`, types.includes(expected), `got [${types.join(', ')}]`);
  }

  check('every lifecycle email has a subject and body',
    rows.every((r) => r.subject && r.html && r.html.length > 100));
  check('no email leaks a raw password field',
    !rows.some((r) => /Str0ngPassphrase/.test(r.html)));
}

// ────────────────────────────────────────────────────────── admin notifications
console.log('\nadmin notifications');
{
  const user = await makeUser('adminnotify');
  const before = await EmailOutbox.countDocuments({ type: 'admin_new_signup' });

  await emails.notifyAdminsOfSignup(user);
  const after = await EmailOutbox.countDocuments({ type: 'admin_new_signup' });
  const recipients = transport.getAdminRecipients();

  check('admin recipients are configured', recipients.length > 0, `${recipients.length} configured`);
  check('signup notifies every admin address', after - before === recipients.length,
    `queued ${after - before} for ${recipients.length} admins`);

  await emails.notifyAdminsOfCreditChange({
    user,
    admin: { name: 'Root', email: 'root@example.com' },
    credits: 500, balanceAfter: 500, action: 'granted', reference: `ref-${tag}`,
  });
  check('credit changes notify admins',
    (await EmailOutbox.countDocuments({ type: 'admin_credit_change' })) > 0);

  await emails.notifyAdminsOfAccountChange({
    user, admin: { name: 'Root', email: 'root@example.com' }, change: 'suspended',
  });
  check('account changes notify admins',
    (await EmailOutbox.countDocuments({ type: 'admin_account_change' })) > 0);
}

// ──────────────────────────────────────────────────────────────── templating
console.log('\ntemplate safety');
{
  const html = layout.renderEmail({
    heading: 'Test <script>alert(1)</script>',
    greeting: 'Hi &lt;there&gt;',
    paragraphs: ['<strong>bold is allowed here</strong>'],
    facts: [{ label: 'Injected', value: '<img src=x onerror=alert(1)>' }],
    action: { label: 'Go', url: 'https://example.com' },
  });

  check('heading is escaped', !html.includes('<script>'), 'raw script tag present');
  check('fact values are escaped', !html.includes('<img src=x'), 'raw img tag present');
  check('intentional paragraph markup survives', html.includes('<strong>bold is allowed here</strong>'));
  check('plain-text alternative is produced',
    layout.renderText({ heading: 'H', paragraphs: ['<b>x</b>'] }).includes('x'));
}

// ──────────────────────────────────────────────────────────────── admin views
console.log('\nadmin visibility');
{
  const list = await outbox.listOutbox({ limit: 5 });
  check('outbox list paginates', Array.isArray(list.data) && list.data.length <= 5);
  check('list omits the rendered HTML body', !('html' in (list.data[0] || {})));
  check('list exposes status and error for triage',
    list.data.length === 0 || ('status' in list.data[0] && 'last_error' in list.data[0]));

  const stats = await outbox.getOutboxStats({ hours: 24 });
  check('stats report counts by status', typeof stats.by_status === 'object');
  check('stats report outstanding failures', typeof stats.outstanding_failures === 'number');
}

// ───────────────────────────────────────────────────────────────────── cleanup
if (!keep) {
  await EmailOutbox.deleteMany({ to: { $in: created } });
  await EmailOutbox.deleteMany({ type: { $regex: '^test_' } });
  await EmailOutbox.deleteMany({ metadata: { $exists: true }, 'metadata.user_email': { $in: created } });
  const users = await User.find({ email: { $in: created } }).select('_id').lean();
  await User.deleteMany({ _id: { $in: users.map((u) => u._id) } });
  console.log(`\ncleaned up ${created.length} test address(es)`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
await mongoose.disconnect();
process.exit(failed ? 1 : 0);
