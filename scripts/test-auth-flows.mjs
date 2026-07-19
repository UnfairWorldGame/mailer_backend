/**
 * End-to-end exercise of every authentication flow against a running server.
 *
 * Uses @example.com addresses (RFC 2606 — guaranteed undeliverable, so no real
 * inbox is ever touched) and reads single-use tokens straight from Mongo rather
 * than from email. Cleans up every account it creates.
 *
 * Usage:  node scripts/test-auth-flows.mjs [--keep]
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3001/api';
const keep = process.argv.includes('--keep');

let passed = 0;
let failed = 0;
const created = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

async function call(path, { method = 'GET', body, token, raw = false } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = raw ? null : await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function uniqueEmail(tag) {
  return `authtest-${tag}-${Date.now()}${Math.floor(Math.random() * 1000)}@example.com`;
}

await mongoose.connect(process.env.MONGODB_URI);
const users = mongoose.connection.db.collection('users');
const refreshTokens = mongoose.connection.db.collection('refreshtokens');
const authEvents = mongoose.connection.db.collection('authevents');

const STRONG = 'Str0ngPassphrase!2026';
const STRONGER = 'An0therGoodOne!2026';

console.log(`\nTesting against ${BASE}\n`);

// ---------------------------------------------------------------- registration
console.log('registration + validation');
{
  const email = uniqueEmail('reg');
  created.push(email);

  const weak = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Weak', email: uniqueEmail('weak'), password: 'password123' },
  });
  check('rejects a common password', weak.status === 400, `got ${weak.status}`);

  const short = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Short', email: uniqueEmail('short'), password: 'Ab1!x' },
  });
  check('rejects a short password', short.status === 400, `got ${short.status}`);

  const identity = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Ident', email: 'brandnewuser@example.com', password: 'brandnewuser99' },
  });
  check('rejects a password containing the email', identity.status === 400, `got ${identity.status}`);

  const ok = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Reg Test', email, password: STRONG },
  });
  check('registers with a strong password', ok.status === 201, `got ${ok.status}`);
  check('returns an access token', Boolean(ok.data.access_token));
  check('returns a refresh token', Boolean(ok.data.refresh_token));
  check('access token expires in 15 min', ok.data.expires_in === 900, `got ${ok.data.expires_in}`);
  check('new account starts unverified', ok.data.user?.email_verified === false);
  check('never returns the password hash', !JSON.stringify(ok.data).includes('$2a$') && !JSON.stringify(ok.data).includes('$2b$'));

  const dupe = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Dupe', email, password: STRONG },
  });
  check('duplicate signup does not confirm the account exists',
    dupe.status === 409 && !/already exists/i.test(dupe.data.error || ''),
    dupe.data.error);
}

// ------------------------------------------------------- verification gating
console.log('\nemail verification');
let verifiedToken = null;
{
  const email = uniqueEmail('verify');
  created.push(email);
  const reg = await call('/auth/register', {
    method: 'POST',
    body: { name: 'Verify Test', email, password: STRONG },
  });
  const token = reg.data.access_token;

  const me = await call('/auth/me', { token });
  check('/me reports unverified', me.data.user?.email_verified === false);

  const blocked = await call('/campaigns/000000000000000000000000/send', { method: 'POST', token });
  check('unverified user is blocked from sending',
    blocked.status === 403 && blocked.data.code === 'EMAIL_NOT_VERIFIED',
    `got ${blocked.status} ${blocked.data.code}`);

  const doc = await users.findOne({ email });
  check('verification token was stored hashed', Boolean(doc?.verify_token_hash) && doc.verify_token_hash.length === 64);

  const bad = await call('/auth/verify-email', { method: 'POST', body: { token: 'deadbeef'.repeat(8) } });
  check('rejects a bogus verification token', bad.status === 400, `got ${bad.status}`);

  // Mint a known token by rewriting the stored hash, mirroring what the emailed link carries.
  const crypto = await import('crypto');
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await users.updateOne({ email }, { $set: { verify_token_hash: hash, verify_token_expires: new Date(Date.now() + 60000) } });

  const good = await call('/auth/verify-email', { method: 'POST', body: { token: raw } });
  check('accepts a valid verification token', good.status === 200 && good.data.verified === true, JSON.stringify(good.data));

  const replay = await call('/auth/verify-email', { method: 'POST', body: { token: raw } });
  check('replaying a used token is not an error', replay.status === 200, `got ${replay.status}`);

  const after = await call('/auth/me', { token });
  check('/me now reports verified', after.data.user?.email_verified === true);
  verifiedToken = token;

  const unblocked = await call('/campaigns/000000000000000000000000/send', { method: 'POST', token });
  check('verified user passes the send gate (404, not 403)', unblocked.status === 404, `got ${unblocked.status}`);
}

// ------------------------------------------------------------------- login
console.log('\nlogin + lockout');
{
  const email = uniqueEmail('login');
  created.push(email);
  await call('/auth/register', { method: 'POST', body: { name: 'Login Test', email, password: STRONG } });

  const wrong = await call('/auth/login', { method: 'POST', body: { email, password: 'WrongPassword!99' } });
  check('wrong password is rejected', wrong.status === 401, `got ${wrong.status}`);
  check('wrong-password error is generic', /invalid email or password/i.test(wrong.data.error || ''), wrong.data.error);

  const noSuch = await call('/auth/login', { method: 'POST', body: { email: 'nobody-here@example.com', password: STRONG } });
  check('unknown account gives the identical error', noSuch.data.error === wrong.data.error, noSuch.data.error);

  const good = await call('/auth/login', { method: 'POST', body: { email, password: STRONG } });
  check('correct password signs in', good.status === 200, `got ${good.status}`);
  check('login issues a refresh token', Boolean(good.data.refresh_token));

  // Lockout: the model allows 8 failures before locking.
  //
  // A locked account deliberately answers with the SAME generic 401 as a wrong
  // password. A distinct status would answer "does this account exist?" for
  // free — only a real account can ever reach a lockout, so the eighth response
  // would confirm registration. The lockout is therefore asserted by its
  // effect (a correct password stops working) and by the stored state, not by
  // a status code the API intentionally does not expose.
  const lockEmail = uniqueEmail('lock');
  created.push(lockEmail);
  await call('/auth/register', { method: 'POST', body: { name: 'Lock', email: lockEmail, password: STRONG } });

  for (let i = 0; i < 8; i++) {
    await call('/auth/login', { method: 'POST', body: { email: lockEmail, password: `Nope!${i}aaaa` } });
  }

  const lockedDoc = await users.findOne({ email: lockEmail });
  check('repeated failures set a lockout window',
    Boolean(lockedDoc?.lockout_until) && lockedDoc.lockout_until > new Date(),
    `lockout_until=${lockedDoc?.lockout_until}`);

  const lockedOut = await call('/auth/login', { method: 'POST', body: { email: lockEmail, password: STRONG } });
  check('lockout blocks even the correct password', lockedOut.status === 401, `got ${lockedOut.status}`);
  check('lockout is not distinguishable from a wrong password',
    lockedOut.data.error === wrong.data.error, lockedOut.data.error);
  check('a locked attempt is recorded for operators',
    (await authEvents.countDocuments({ email: lockEmail, type: 'login_locked' })) > 0);
}

// ------------------------------------------------------- refresh + rotation
console.log('\ntoken refresh + reuse detection');
{
  const email = uniqueEmail('refresh');
  created.push(email);
  const reg = await call('/auth/register', { method: 'POST', body: { name: 'Refresh', email, password: STRONG } });
  const firstRefresh = reg.data.refresh_token;

  const rotated = await call('/auth/refresh', { method: 'POST', body: { refresh_token: firstRefresh } });
  check('refresh returns a new pair', rotated.status === 200 && Boolean(rotated.data.access_token));
  check('refresh token is rotated', rotated.data.refresh_token !== firstRefresh);

  const newAccess = rotated.data.access_token;
  const meOk = await call('/auth/me', { token: newAccess });
  check('rotated access token works', meOk.status === 200, `got ${meOk.status}`);

  const reused = await call('/auth/refresh', { method: 'POST', body: { refresh_token: firstRefresh } });
  check('replaying the old refresh token is rejected', reused.status === 401, `got ${reused.status}`);
  check('reuse is reported as REFRESH_REUSED', reused.data.code === 'REFRESH_REUSED', reused.data.code);

  const afterReuse = await call('/auth/refresh', { method: 'POST', body: { refresh_token: rotated.data.refresh_token } });
  check('reuse revokes the whole family', afterReuse.status === 401, `got ${afterReuse.status}`);

  const event = await authEvents.findOne({ type: 'token_reuse_detected' });
  check('reuse is recorded in the audit log', Boolean(event));

  const garbage = await call('/auth/refresh', { method: 'POST', body: { refresh_token: 'not-a-real-token' } });
  check('garbage refresh token is rejected', garbage.status === 401, `got ${garbage.status}`);
}

// ----------------------------------------------------------------- logout
console.log('\nlogout');
{
  const email = uniqueEmail('logout');
  created.push(email);
  const reg = await call('/auth/register', { method: 'POST', body: { name: 'Logout', email, password: STRONG } });

  const out = await call('/auth/logout', { method: 'POST', body: { refresh_token: reg.data.refresh_token } });
  check('logout succeeds', out.status === 200, `got ${out.status}`);

  const afterOut = await call('/auth/refresh', { method: 'POST', body: { refresh_token: reg.data.refresh_token } });
  check('refresh token is dead after logout', afterOut.status === 401, `got ${afterOut.status}`);

  const idempotent = await call('/auth/logout', { method: 'POST', body: { refresh_token: 'already-gone' } });
  check('logout is idempotent', idempotent.status === 200, `got ${idempotent.status}`);

  // logout-all must kill in-flight access tokens, not just refresh tokens.
  const email2 = uniqueEmail('logoutall');
  created.push(email2);
  const reg2 = await call('/auth/register', { method: 'POST', body: { name: 'LogoutAll', email: email2, password: STRONG } });
  const access2 = reg2.data.access_token;

  check('access token valid before logout-all', (await call('/auth/me', { token: access2 })).status === 200);
  await call('/auth/logout-all', { method: 'POST', token: access2 });
  const afterAll = await call('/auth/me', { token: access2 });
  check('logout-all invalidates the access token immediately',
    afterAll.status === 401 && afterAll.data.code === 'TOKEN_REVOKED',
    `got ${afterAll.status} ${afterAll.data.code}`);
}

// --------------------------------------------------------- password reset
console.log('\npassword reset');
{
  const email = uniqueEmail('reset');
  created.push(email);
  const reg = await call('/auth/register', { method: 'POST', body: { name: 'Reset', email, password: STRONG } });
  const oldAccess = reg.data.access_token;
  const oldRefresh = reg.data.refresh_token;

  const hit = await call('/auth/forgot-password', { method: 'POST', body: { email } });
  const miss = await call('/auth/forgot-password', { method: 'POST', body: { email: 'ghost@example.com' } });
  check('forgot-password responds 200 for a real account', hit.status === 200);
  check('forgot-password responds identically for an unknown account',
    miss.status === hit.status && miss.data.message === hit.data.message);

  const crypto = await import('crypto');
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await users.updateOne({ email }, { $set: { reset_token_hash: hash, reset_token_expires: new Date(Date.now() + 60000) } });

  const verify = await call(`/auth/reset-password/verify?token=${raw}`);
  check('valid reset token verifies', verify.status === 200 && verify.data.valid === true);
  check('verify does not leak the account email', !verify.data.email);

  const weak = await call('/auth/reset-password', { method: 'POST', body: { token: raw, password: 'password123' } });
  check('reset enforces the password policy', weak.status === 400, `got ${weak.status}`);

  const done = await call('/auth/reset-password', { method: 'POST', body: { token: raw, password: STRONGER } });
  check('reset succeeds with a strong password', done.status === 200, JSON.stringify(done.data));

  const replay = await call('/auth/reset-password', { method: 'POST', body: { token: raw, password: STRONGER } });
  check('reset token is single-use', replay.status === 400, `got ${replay.status}`);

  const staleAccess = await call('/auth/me', { token: oldAccess });
  check('reset kills existing access tokens', staleAccess.status === 401, `got ${staleAccess.status}`);

  const staleRefresh = await call('/auth/refresh', { method: 'POST', body: { refresh_token: oldRefresh } });
  check('reset kills existing refresh tokens', staleRefresh.status === 401, `got ${staleRefresh.status}`);

  const oldPw = await call('/auth/login', { method: 'POST', body: { email, password: STRONG } });
  check('old password no longer works', oldPw.status === 401, `got ${oldPw.status}`);

  const newPw = await call('/auth/login', { method: 'POST', body: { email, password: STRONGER } });
  check('new password works', newPw.status === 200, `got ${newPw.status}`);
}

// -------------------------------------------------------- change password
console.log('\nchange password');
{
  const email = uniqueEmail('change');
  created.push(email);
  const reg = await call('/auth/register', { method: 'POST', body: { name: 'Change', email, password: STRONG } });
  const access = reg.data.access_token;

  const wrongCurrent = await call('/auth/change-password', {
    method: 'POST', token: access, body: { currentPassword: 'WrongOne!123', password: STRONGER },
  });
  check('requires the correct current password', wrongCurrent.status === 401, `got ${wrongCurrent.status}`);

  const same = await call('/auth/change-password', {
    method: 'POST', token: access, body: { currentPassword: STRONG, password: STRONG },
  });
  check('rejects reusing the current password', same.status === 400, `got ${same.status}`);

  const changed = await call('/auth/change-password', {
    method: 'POST', token: access, body: { currentPassword: STRONG, password: STRONGER },
  });
  check('changes the password', changed.status === 200, JSON.stringify(changed.data));
  check('returns a fresh session so the user stays signed in', Boolean(changed.data.access_token));

  const staleAfterChange = await call('/auth/me', { token: access });
  check('old access token dies on password change', staleAfterChange.status === 401, `got ${staleAfterChange.status}`);

  const freshOk = await call('/auth/me', { token: changed.data.access_token });
  check('the returned session works', freshOk.status === 200, `got ${freshOk.status}`);
}

// -------------------------------------------------------------- sessions
console.log('\nsession management');
{
  const email = uniqueEmail('sessions');
  created.push(email);
  await call('/auth/register', { method: 'POST', body: { name: 'Sessions', email, password: STRONG } });

  const a = await call('/auth/login', { method: 'POST', body: { email, password: STRONG } });
  const b = await call('/auth/login', { method: 'POST', body: { email, password: STRONG } });

  const list = await call('/auth/sessions', { token: b.data.access_token });
  check('lists active sessions', list.status === 200 && list.data.sessions.length >= 2, `count ${list.data.sessions?.length}`);
  check('session list contains no token material',
    !JSON.stringify(list.data).includes(a.data.refresh_token));

  const target = list.data.sessions[list.data.sessions.length - 1];
  const revoked = await call(`/auth/sessions/${target.id}`, { method: 'DELETE', token: b.data.access_token });
  check('revokes an individual session', revoked.status === 200, `got ${revoked.status}`);

  const stored = await refreshTokens.countDocuments({ token_hash: { $exists: true } });
  check('refresh tokens are stored only as digests', stored > 0);
  const plaintext = await refreshTokens.findOne({ token_hash: a.data.refresh_token });
  check('raw refresh token is never stored', plaintext === null);
}

// ------------------------------------------------------------- audit trail
console.log('\naudit trail');
{
  for (const type of ['register', 'login_success', 'login_failed', 'password_reset_completed', 'password_changed']) {
    check(`records ${type}`, (await authEvents.countDocuments({ type })) > 0);
  }
  const leak = await authEvents.findOne({ detail: { $regex: STRONG } });
  check('audit log never stores passwords', leak === null);
}

// ---------------------------------------------------------------- cleanup
if (!keep && created.length) {
  const docs = await users.find({ email: { $in: created } }).project({ _id: 1 }).toArray();
  const ids = docs.map((d) => d._id);
  await refreshTokens.deleteMany({ user_id: { $in: ids } });
  await authEvents.deleteMany({ email: { $in: created } });
  await users.deleteMany({ email: { $in: created } });
  console.log(`\ncleaned up ${ids.length} test account(s)`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
await mongoose.disconnect();
process.exit(failed ? 1 : 0);
