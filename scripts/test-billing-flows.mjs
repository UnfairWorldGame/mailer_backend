/**
 * Exercises credit accounting, eligibility gating, refunds, and the concurrency
 * paths that cannot be verified by reading the code.
 *
 * Calls the quota service in-process (so races are real races) and the HTTP API
 * for endpoint behaviour. Uses @example.com accounts and cleans up after itself.
 *
 * Usage:  node scripts/test-billing-flows.mjs [--keep]
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001/api';
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

const User = (await import('../src/models/User.js')).default;
const Campaign = (await import('../src/models/Campaign.js')).default;
const CreditTransaction = (await import('../src/models/CreditTransaction.js')).default;
const quota = await import('../src/services/quotaService.js');
const { FREE_DAILY_CREDITS } = await import('../src/config/billingConfig.js');

const created = [];
const STRONG = 'Str0ngPassphrase!2026';

async function makeUser(tag, { credits = 0 } = {}) {
  const email = `billtest-${tag}-${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
  created.push(email);
  const user = await User.create({ name: `Bill ${tag}`, email, password: STRONG, email_verified: true });
  if (credits > 0) {
    await User.updateOne({ _id: user._id }, { $set: { email_credits: credits, has_paid_access: true } });
  }
  // Free allowance is exhausted by default so tests isolate *paid* credits.
  await User.updateOne(
    { _id: user._id },
    { $set: { free_quota_date: quota.getQuotaDateKey(), free_sent_today: FREE_DAILY_CREDITS } }
  );
  return User.findById(user._id);
}

async function makeCampaign(user, name = 'Billing test') {
  return Campaign.create({
    user_id: user._id, name, subject: 'S', body: '<p>B</p>', status: 'draft',
  });
}

const balanceOf = async (id) => User.findById(id).select('email_credits reserved_credits lifetime_credits_received').lean();

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function tokenFor(user) {
  const jwt = (await import('jsonwebtoken')).default;
  const fresh = await User.findById(user._id).select('token_version');
  return jwt.sign(
    { userId: user._id.toString(), tv: fresh.token_version || 0, typ: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: '10m' }
  );
}

console.log(`\nTesting against ${BASE}\n`);

// ─────────────────────────────────────────────── eligibility (balance-gated)
console.log('eligibility gating');
{
  const broke = await makeUser('broke', { credits: 0 });
  const funded = await makeUser('funded', { credits: 500 });

  const brokeSnap = quota.computeQuotaSnapshot(await User.findById(broke._id));
  const fundedSnap = quota.computeQuotaSnapshot(await User.findById(funded._id));
  check('zero balance => cannot use paid features', brokeSnap.can_use_paid_features === false);
  check('positive balance => can use paid features', fundedSnap.can_use_paid_features === true);

  const blocked = await call('/ai/generate-email', {
    method: 'POST', token: await tokenFor(broke), body: { prompt: 'hi' },
  });
  check('AI endpoint 403s a zero-balance user',
    blocked.status === 403 && blocked.data.code === 'PAID_FEATURE_REQUIRED',
    `got ${blocked.status} ${blocked.data.code}`);
  check('403 carries the numbers the upgrade dialog needs',
    typeof blocked.data.quota?.available_to_send === 'number', JSON.stringify(blocked.data.quota));

  const allowed = await call('/analytics/overview', { token: await tokenFor(funded) });
  check('analytics passes a funded user', allowed.status === 200, `got ${allowed.status}`);

  // A free-tier user with daily allowance left must NOT be blocked.
  const freeUser = await makeUser('freetier', { credits: 0 });
  await User.updateOne({ _id: freeUser._id }, { $set: { free_sent_today: 0 } });
  const freeSnap = quota.computeQuotaSnapshot(await User.findById(freeUser._id));
  check('free-tier user with allowance can use paid features', freeSnap.can_use_paid_features === true,
    `available=${freeSnap.available_to_send}`);

  // has_paid_access must no longer be what gates.
  await User.updateOne({ _id: broke._id }, { $set: { has_paid_access: true } });
  const flagged = quota.computeQuotaSnapshot(await User.findById(broke._id));
  check('has_paid_access alone does not unlock features', flagged.can_use_paid_features === false);
}

// ─────────────────────────────────────────────────────── reservation races
console.log('\nreservation concurrency');
{
  const user = await makeUser('race', { credits: 1000 });
  const campaign = await makeCampaign(user);

  // The P0 bug: concurrent reserves for the SAME ref each read alreadyReserved=0
  // and both incremented, inflating the ref and stranding credits.
  const results = await Promise.allSettled(
    Array.from({ length: 6 }, () => quota.reserveCampaignQuota(user._id, campaign._id, 10))
  );
  const fulfilled = results.filter((r) => r.status === 'fulfilled').length;

  const afterCampaign = await Campaign.findById(campaign._id).select('quota_reserved').lean();
  const afterUser = await balanceOf(user._id);

  check('6 concurrent reserves for one campaign reserve exactly once',
    afterCampaign.quota_reserved === 10, `ref=${afterCampaign.quota_reserved}`);
  check('user reserved_credits matches the campaign', afterUser.reserved_credits === 10,
    `user=${afterUser.reserved_credits}`);
  check('no reserve call errored unexpectedly', fulfilled === 6, `${fulfilled}/6 fulfilled`);

  await quota.releaseCampaignQuota(user._id, campaign._id);
  const released = await balanceOf(user._id);
  check('release returns the reservation', released.reserved_credits === 0, `${released.reserved_credits}`);
}

// ──────────────────────────────────────────────────────────────── oversell
console.log('\noversell protection');
{
  const user = await makeUser('oversell', { credits: 10 });
  const campaigns = await Promise.all([1, 2, 3, 4, 5].map((i) => makeCampaign(user, `c${i}`)));

  // Five separate campaigns each wanting the whole balance. Only one may win.
  const results = await Promise.allSettled(
    campaigns.map((c) => quota.reserveCampaignQuota(user._id, c._id, 10))
  );
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const rejected = results.filter((r) => r.status === 'rejected').length;

  const after = await balanceOf(user._id);
  check('only one of five competing reserves succeeds', ok === 1, `${ok} succeeded, ${rejected} rejected`);
  check('reserved never exceeds the balance', after.reserved_credits <= 10, `${after.reserved_credits}`);
  check('losers got a QuotaError',
    results.filter((r) => r.status === 'rejected').every((r) => r.reason?.code === 'QUOTA_EXCEEDED'));
}

// ─────────────────────────────────────────────────────────────── consumption
console.log('\nconsumption + floors');
{
  const user = await makeUser('spend', { credits: 5 });
  const campaign = await makeCampaign(user);
  await quota.reserveCampaignQuota(user._id, campaign._id, 5);

  for (let i = 0; i < 5; i++) await quota.consumeSendQuota(user._id, campaign._id);

  const after = await balanceOf(user._id);
  check('credits spend down to exactly zero', after.email_credits === 0, `${after.email_credits}`);
  check('reserved returns to zero', after.reserved_credits === 0, `${after.reserved_credits}`);

  // Spending past the reservation must not go negative or silently succeed.
  const overspend = await quota.consumeSendQuota(user._id, campaign._id);
  const afterOver = await balanceOf(user._id);
  check('credits cannot go negative', afterOver.email_credits === 0, `${afterOver.email_credits}`);
  check('reserved_credits cannot go negative', afterOver.reserved_credits >= 0, `${afterOver.reserved_credits}`);
  check('overspend reports charged:false so the engine stops', overspend.charged === false,
    JSON.stringify(overspend));

  const ledger = await CreditTransaction.countDocuments({ user_id: user._id, type: 'send' });
  check('every spend wrote a ledger row', ledger > 0, `${ledger} rows`);
}

// ───────────────────────────────────────────────────────── grants & refunds
console.log('\ngrants, refunds, idempotency');
{
  const user = await makeUser('grant', { credits: 0 });
  const admin = await makeUser('admin-actor', { credits: 0 });

  const g1 = await quota.grantCredits(user._id, 1000, admin._id, { payment_ref: `pay-${Date.now()}` });
  check('grant credits the account', g1.email_credits === 1000, `${g1.email_credits}`);

  let dupeBlocked = false;
  try {
    await quota.grantCredits(user._id, 1000, admin._id, { payment_ref: g1 && (await CreditTransaction.findById(g1.transaction_id)).payment_ref });
  } catch (err) {
    dupeBlocked = /already granted/i.test(err.message);
  }
  check('same payment reference cannot be granted twice', dupeBlocked);

  // Refund requires an idempotency key.
  let needsKey = false;
  try {
    await quota.revokeCredits(user._id, 100, admin._id, {});
  } catch (err) {
    needsKey = /reversal reference/i.test(err.message);
  }
  check('refund requires a reversal reference', needsKey);

  const reversalRef = `rev-${Date.now()}`;
  const r1 = await quota.revokeCredits(user._id, 400, admin._id, { reversal_ref: reversalRef });
  check('refund removes credits', r1.email_credits === 600, `${r1.email_credits}`);

  let refundDupeBlocked = false;
  try {
    await quota.revokeCredits(user._id, 400, admin._id, { reversal_ref: reversalRef });
  } catch (err) {
    refundDupeBlocked = /already granted/i.test(err.message);
  }
  check('same reversal reference cannot be applied twice', refundDupeBlocked);

  const afterRefund = await balanceOf(user._id);
  check('refund decrements lifetime_credits_received',
    afterRefund.lifetime_credits_received === 600, `${afterRefund.lifetime_credits_received}`);

  // Over-refund must refuse loudly rather than silently clamp.
  let refusedOver = false;
  try {
    await quota.revokeCredits(user._id, 99999, admin._id, { reversal_ref: `rev2-${Date.now()}` });
  } catch (err) {
    refusedOver = /can be removed/i.test(err.message);
  }
  check('over-refund refuses instead of silently clamping', refusedOver);

  // Reversing a grant must free its payment_ref so the payment can be re-credited.
  const payRef = `repay-${Date.now()}`;
  const user2 = await makeUser('regrant', { credits: 0 });
  await quota.grantCredits(user2._id, 500, admin._id, { payment_ref: payRef });
  await quota.revokeCredits(user2._id, 500, admin._id, {
    reversal_ref: `revx-${Date.now()}`, reverses_payment_ref: payRef,
  });
  let regranted = null;
  try {
    regranted = await quota.grantCredits(user2._id, 500, admin._id, { payment_ref: payRef });
  } catch { /* recorded below */ }
  check('a refunded payment reference can be granted again', regranted?.email_credits === 500,
    regranted ? `${regranted.email_credits}` : 'blocked');

  const refundRow = await CreditTransaction.findOne({ user_id: user2._id, type: 'refund' });
  check('refund is recorded as type "refund"', Boolean(refundRow));
  check('refund links to the grant it reverses', Boolean(refundRow?.reverses_transaction_id));

  const reversedGrant = await CreditTransaction.findOne({ user_id: user2._id, reversed_at: { $ne: null } });
  check('the reversed grant is marked, not deleted', Boolean(reversedGrant?.reversed_ref));

  // Audit writes are best-effort by design (they must never fail a completed
  // grant), which means a schema mismatch fails silently — exactly how the
  // refund_credits enum gap hid. Assert the rows actually land.
  const AdminAuditLog = (await import('../src/models/AdminAuditLog.js')).default;
  const grantAudit = await AdminAuditLog.countDocuments({ target_user_id: user2._id, action: 'grant_credits' });
  const refundAudit = await AdminAuditLog.countDocuments({ target_user_id: user2._id, action: 'refund_credits' });
  check('grants are written to the admin audit log', grantAudit > 0, `${grantAudit} rows`);
  check('refunds are written to the admin audit log', refundAudit > 0, `${refundAudit} rows`);
}

// ────────────────────────────────────────────────────────────── HTTP surface
console.log('\nuser + admin endpoints');
{
  const user = await makeUser('http', { credits: 250 });
  const token = await tokenFor(user);

  const ctx = await call('/billing/upgrade-context', { token });
  check('upgrade-context returns quota + packs', ctx.status === 200 && Array.isArray(ctx.data.packs),
    `got ${ctx.status}`);
  check('upgrade-context exposes admin contact details', ctx.data.contact !== undefined);
  check('upgrade-context reports pending request state', 'pending_request' in ctx.data);

  const tx = await call('/billing/transactions', { token });
  check('users can read their own credit history', tx.status === 200 && Array.isArray(tx.data.data),
    `got ${tx.status}`);

  const denied = await call('/admin/billing/analytics', { token });
  check('billing analytics is admin-only', denied.status === 403, `got ${denied.status}`);
}

// ────────────────────────────────────────────────── campaign delete guard
console.log('\ndelete-while-sending guard');
{
  const user = await makeUser('delguard', { credits: 100 });
  const campaign = await makeCampaign(user);
  await quota.reserveCampaignQuota(user._id, campaign._id, 10);
  await Campaign.updateOne({ _id: campaign._id }, { $set: { status: 'sending' } });

  const res = await call(`/campaigns/${campaign._id}`, { method: 'DELETE', token: await tokenFor(user) });
  check('a sending campaign cannot be deleted', res.status === 409 && res.data.code === 'CAMPAIGN_SENDING',
    `got ${res.status} ${res.data.code}`);

  const stillReserved = await balanceOf(user._id);
  check('its reservation is left intact', stillReserved.reserved_credits === 10,
    `${stillReserved.reserved_credits}`);
}

// ───────────────────────────────────────────────────────────────── cleanup
if (!keep && created.length) {
  const docs = await User.find({ email: { $in: created } }).select('_id').lean();
  const ids = docs.map((d) => d._id);
  await Promise.all([
    Campaign.deleteMany({ user_id: { $in: ids } }),
    CreditTransaction.deleteMany({ user_id: { $in: ids } }),
    User.deleteMany({ _id: { $in: ids } }),
  ]);
  console.log(`\ncleaned up ${ids.length} test account(s)`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
await mongoose.disconnect();
process.exit(failed ? 1 : 0);
