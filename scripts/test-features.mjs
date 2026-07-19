/**
 * Integration tests for campaign tracking, recovery, retry, and progress APIs.
 * Uses mongodb-memory-server when MONGODB_URI is not set.
 *
 * Run: npm test
 */
import './load-env.mjs';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';

let memoryServer;
let baseUrl;
let server;
let campaignId;
let accountId;
let authToken;
let testUserId;

const results = [];

function pass(name) {
  results.push({ name, ok: true });
  console.log(`  ✓ ${name}`);
}

function fail(name, err) {
  results.push({ name, ok: false, error: err?.message || String(err) });
  console.error(`  ✗ ${name}: ${err?.message || err}`);
}

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...options.headers,
    },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

async function authenticate() {
  // All routes now require a logged-in user (routes filter by req.user.id).
  // Create a throwaway user directly and sign a token the same way login does,
  // rather than going through the HTTP register/verify flow.
  const { default: User } = await import('../src/models/User.js');
  const { signAccessToken } = await import('../src/middleware/auth.js');

  // Against a real (non-memory-server) MONGODB_URI, a leftover user from a
  // previous run would collide on the unique email index — clear it first so
  // the suite is safely re-runnable.
  await User.deleteOne({ email: 'test-runner@mailer.test' });
  const user = await User.create({
    name: 'Test Runner',
    email: 'test-runner@mailer.test',
    password: 'Test-Password-123!',
  });
  testUserId = user._id;
  // signAccessToken takes the user document, not an id: the payload pins
  // token_version so a password change invalidates tokens already issued.
  authToken = signAccessToken(user);
}

async function setupDb() {
  const envUri = (process.env.MONGODB_URI || '').trim();
  if (envUri) {
    return;
  }
  memoryServer = await MongoMemoryServer.create();
  process.env.MONGODB_URI = memoryServer.getUri('mailer_test');
  process.env.NODE_ENV = 'test';
}

async function startServer() {
  const { connectDB } = await import('../src/db/connect.js');
  await connectDB();

  const { default: express } = await import('express');
  const campaignsRouter = (await import('../src/routes/campaigns.js')).default;
  const accountsRouter = (await import('../src/routes/accounts.js')).default;
  const uploadsRouter = (await import('../src/routes/uploads.js')).default;

  const app = express();
  app.use(express.json());
  app.use('/api/campaigns', campaignsRouter);
  app.use('/api/accounts', accountsRouter);
  app.use('/api/uploads', uploadsRouter);

  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}/api`;
      resolve();
    });
  });
}

async function seedData() {
  // Clear any leftover account from a previous run under the old (deleted)
  // test user — a stale/legacy index on this collection could otherwise
  // collide on email alone even though the owning user differs.
  const GmailAccount = (await import('../src/models/GmailAccount.js')).default;
  await GmailAccount.deleteMany({ email: 'test@gmail.com' });

  const { res: accRes, data: account } = await request('/accounts', {
    method: 'POST',
    body: JSON.stringify({
      label: 'Test Account',
      email: 'test@gmail.com',
      app_password: 'test-app-password',
      is_active: true,
    }),
  });
  if (!accRes.ok) throw new Error(`Account create failed: ${account.error}`);
  accountId = account.id;

  const Contact = (await import('../src/models/Contact.js')).default;
  await Contact.deleteMany({});
  await Contact.insertMany([
    { user_id: testUserId, name: 'Alice', email: 'alice@example.com' },
    { user_id: testUserId, name: 'Bob', email: 'bob@example.com' },
    { user_id: testUserId, name: 'Carol', email: 'carol@example.com' },
  ]);

  const { res, data } = await request('/campaigns', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Test Campaign',
      subject: 'Hello {{name}}',
      body: '<p>Hi {{name}}, your email is {{email}}</p>',
      gmail_account_id: accountId,
      send_delay_ms: 100,
    }),
  });
  if (!res.ok) throw new Error(`Campaign create failed: ${data.error}`);
  campaignId = data.id;
}

async function testHealthAndConfig() {
  try {
    const { res, data } = await request('/campaigns/config/send');
    if (!res.ok) throw new Error(data.error);
    if (!data.max_retries_per_recipient) throw new Error('missing max_retries_per_recipient');
    pass('GET /campaigns/config/send');
  } catch (err) {
    fail('GET /campaigns/config/send', err);
  }
}

async function testCampaignList() {
  try {
    const { res, data } = await request('/campaigns');
    if (!res.ok) throw new Error(data.error);
    if (!Array.isArray(data.data)) throw new Error('expected data array');
    if (data.data.length < 1) throw new Error('no campaigns returned');
    pass('GET /campaigns returns paginated data');
  } catch (err) {
    fail('GET /campaigns returns paginated data', err);
  }
}

async function testProgressEndpoint() {
  try {
    const { res, data } = await request(`/campaigns/${campaignId}/progress`);
    if (!res.ok) throw new Error(data.error);
    if (!data.counts) throw new Error('missing counts');
    const required = ['total', 'sent', 'pending', 'failed', 'skipped', 'sending'];
    for (const key of required) {
      if (typeof data.counts[key] !== 'number') throw new Error(`missing count: ${key}`);
    }
    if (data.counts.total !== 3) throw new Error(`expected 3 total, got ${data.counts.total}`);
    if (data.counts.pending !== 3) throw new Error(`expected 3 pending, got ${data.counts.pending}`);
    pass('GET /campaigns/:id/progress returns all status counts');
  } catch (err) {
    fail('GET /campaigns/:id/progress returns all status counts', err);
  }
}

async function testAtomicClaimAndRecovery() {
  try {
    const CampaignRecipient = (await import('../src/models/CampaignRecipient.js')).default;
    const {
      claimNextRecipient,
      recoverStaleRecipients,
      reconcileOrphanedSends,
      syncCampaignCounters,
      getWorkerId,
    } = await import('../src/services/campaignTracker.js');
    const { writeLog } = await import('../src/services/logService.js');

    const worker = getWorkerId();
    const claimed = await claimNextRecipient(campaignId, worker);
    if (!claimed || claimed.status !== 'sending') {
      throw new Error('claim did not set sending status');
    }
    if (!claimed.claim_token) throw new Error('missing claim_token');

    const claimed2 = await claimNextRecipient(campaignId, worker);
    if (claimed2 && claimed2._id.toString() === claimed._id.toString()) {
      throw new Error('duplicate claim on same recipient');
    }

    claimed.claimed_at = new Date(Date.now() - 400000);
    await claimed.save();

    const recovered = await recoverStaleRecipients(campaignId, { writeLog });
    if (recovered < 1) throw new Error('stale recipient not recovered');

    const reverted = await CampaignRecipient.findById(claimed._id);
    if (reverted.status !== 'pending') throw new Error('expected pending after recovery');

    await writeLog({
      campaignId,
      recipientId: claimed._id,
      level: 'success',
      action: 'send_success',
      message: 'test success',
      recipientEmail: reverted.email,
      details: { message_id: '<test@mailer>' },
    });
    reverted.status = 'sending';
    reverted.claim_token = 'orphan';
    reverted.claimed_at = new Date();
    await reverted.save();

    const reconciled = await reconcileOrphanedSends(campaignId, { writeLog });
    if (reconciled < 1) throw new Error('orphan not reconciled');

    const after = await CampaignRecipient.findById(claimed._id);
    if (after.status !== 'sent') throw new Error('expected sent after reconciliation');

    await syncCampaignCounters(campaignId);
    pass('Atomic claim, stale recovery, and orphan reconciliation');
  } catch (err) {
    fail('Atomic claim, stale recovery, and orphan reconciliation', err);
  }
}

async function testRetryFailed() {
  try {
    const CampaignRecipient = (await import('../src/models/CampaignRecipient.js')).default;
    await CampaignRecipient.updateMany(
      { campaign_id: campaignId },
      { $set: { status: 'failed', error_message: 'test failure', attempt_count: 3 } }
    );

    const Campaign = (await import('../src/models/Campaign.js')).default;
    await Campaign.findByIdAndUpdate(campaignId, { status: 'completed', failed_count: 3 });

    const { res, data } = await request(`/campaigns/${campaignId}/retry-failed`, {
      method: 'POST',
      body: JSON.stringify({ reset_attempts: true }),
    });
    if (!res.ok) throw new Error(data.error);
    if (data.retried_count < 1) throw new Error('no recipients retried');

    const pending = await CampaignRecipient.countDocuments({ campaign_id: campaignId, status: 'pending' });
    if (pending < 1) throw new Error('failed recipients not reset to pending');
    pass('POST /campaigns/:id/retry-failed resets failed recipients');
  } catch (err) {
    fail('POST /campaigns/:id/retry-failed resets failed recipients', err);
  }
}

async function testRetryFailedRespectsMaxRetries() {
  // Regression test: POST /:id/retry-failed (without reset_attempts) must not
  // requeue recipients that already exhausted max_retries_per_recipient —
  // it previously ignored the cap entirely (see campaigns.js retry-failed route).
  try {
    const CampaignRecipient = (await import('../src/models/CampaignRecipient.js')).default;
    const Campaign = (await import('../src/models/Campaign.js')).default;
    const { sendConfig } = await import('../src/config/sendConfig.js');
    const { isCampaignRunning } = await import('../src/services/sendEngine.js');

    // testRetryFailed (above) started a real background send loop against the
    // fake test Gmail account. Wait for it to fully drain before staging our
    // own recipient states, or it'll race-claim whatever we set to pending.
    for (let i = 0; i < 50 && isCampaignRunning(campaignId); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const recipients = await CampaignRecipient.find({ campaign_id: campaignId }).limit(2);
    if (recipients.length < 2) throw new Error('expected at least 2 seeded recipients');
    const [exhausted, retryable] = recipients;

    await CampaignRecipient.updateMany({ campaign_id: campaignId }, { $set: { status: 'sent' } });
    await CampaignRecipient.findByIdAndUpdate(exhausted._id, {
      $set: { status: 'failed', error_message: 'permanent', attempt_count: sendConfig.maxRetriesPerRecipient },
    });
    await CampaignRecipient.findByIdAndUpdate(retryable._id, {
      $set: { status: 'failed', error_message: 'transient', attempt_count: sendConfig.maxRetriesPerRecipient - 1 },
    });
    // 'paused' is the state the route supports: retrying into a *running*
    // campaign is rejected on purpose, because the live worker could claim the
    // requeued rows before the credit reservation is evaluated.
    await Campaign.findByIdAndUpdate(campaignId, { status: 'paused', failed_count: 2 });

    const { res, data } = await request(`/campaigns/${campaignId}/retry-failed`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(data.error);

    // The route restarts the send loop, which immediately starts claiming the
    // rows it just requeued. So assert on what the cap guarantees rather than
    // on an exact status: the exhausted recipient must never be picked up (the
    // loop only claims 'pending'), and the retryable one must have left 'failed'.
    const exhaustedAfter = await CampaignRecipient.findById(exhausted._id);
    if (exhaustedAfter.status !== 'failed') {
      throw new Error(`recipient at max retries was requeued (status=${exhaustedAfter.status})`);
    }
    const retryableAfter = await CampaignRecipient.findById(retryable._id);
    if (retryableAfter.status === 'failed') {
      throw new Error('recipient under retry cap was not requeued');
    }

    // Drain before the next test so this loop doesn't race its fixtures.
    await Campaign.findByIdAndUpdate(campaignId, { status: 'stopped' });
    for (let i = 0; i < 50 && isCampaignRunning(campaignId); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    pass('POST /campaigns/:id/retry-failed respects max_retries_per_recipient');
  } catch (err) {
    fail('POST /campaigns/:id/retry-failed respects max_retries_per_recipient', err);
  }
}

async function testAppPasswordEncryptedAtRest() {
  // Gmail App Passwords are live SMTP credentials that send as the user, so a
  // database read must not yield usable ones. Verify three things: the raw
  // stored value is ciphertext, the application still reads back cleartext, and
  // serializing the document never exposes the field.
  try {
    const GmailAccount = (await import('../src/models/GmailAccount.js')).default;
    const { isEncrypted, isCredentialEncryptionConfigured, resetCredentialKeyCache } =
      await import('../src/utils/credentialCrypto.js');

    // Deterministic regardless of the developer's environment: encryption
    // downgrades to plaintext when no key is set, so provide one for this test.
    if (!isCredentialEncryptionConfigured()) {
      const crypto = await import('crypto');
      process.env.CREDENTIAL_ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
      resetCredentialKeyCache();
    }

    const secret = 'abcd efgh ijkl mnop';
    const account = await GmailAccount.create({
      user_id: testUserId,
      label: 'Crypto Test',
      email: 'crypto-test@gmail.com',
      app_password: secret,
    });

    // 1. What actually sits in Mongo, read without the schema getter.
    const raw = await mongoose.connection
      .collection('gmailaccounts')
      .findOne({ _id: account._id }, { projection: { app_password: 1 } });

    if (!isEncrypted(raw.app_password)) {
      throw new Error('app_password is stored in plaintext');
    }
    if (raw.app_password.includes('abcdefghijklmnop')) {
      throw new Error('plaintext secret is present in the stored value');
    }

    // 2. The application still gets a usable credential (whitespace stripped).
    const loaded = await GmailAccount.findById(account._id);
    if (loaded.app_password !== 'abcdefghijklmnop') {
      throw new Error(`decrypted value did not round-trip (got ${loaded.app_password})`);
    }

    // 3. Serialization never carries it, whatever a route forgets to strip.
    if ('app_password' in loaded.toJSON()) throw new Error('toJSON exposes app_password');
    if ('app_password' in loaded.toObject()) throw new Error('toObject exposes app_password');

    // 4. Re-saving must not double-encrypt.
    loaded.label = 'Crypto Test 2';
    await loaded.save();
    const reloaded = await GmailAccount.findById(account._id);
    if (reloaded.app_password !== 'abcdefghijklmnop') {
      throw new Error('re-saving the document corrupted the stored credential');
    }

    await GmailAccount.deleteOne({ _id: account._id });
    pass('Gmail App Passwords are encrypted at rest and redacted from output');
  } catch (err) {
    fail('Gmail App Passwords are encrypted at rest and redacted from output', err);
  }
}

async function testSignatoryNameIsNotMatchedAsHolder() {
  // Regression test for the worst outcome this product has: emailing one person
  // another person's certificate. Role words ('coordinator', 'director', ...)
  // are whitelisted as name boundaries, so a signatory's printed name read as a
  // clean holder match. If that signatory is also an attendee in the sheet and
  // no other sheet name is extractable from the page, the page matched them
  // exclusively and was labelled 'exact' — bypassing the needs-review gate.
  try {
    const { matchCertificatesFromPdfPages } = await import('../src/utils/certMatch.js');

    const pages = [
      {
        page_number: 1,
        stored_name: 'p1.pdf',
        size: 1000,
        // Awarded to someone who is NOT in the sheet; signed by someone who is.
        text: 'Certificate of Participation awarded to Priya Sharma for attending the workshop. Ravi Menon Coordinator',
      },
    ];
    const rows = [{ name: 'Ravi Menon', email: 'ravi@example.com' }];

    const result = matchCertificatesFromPdfPages(rows, pages);
    const ravi = result.recipients.find((r) => r.email === 'ravi@example.com');

    if (ravi && ravi.match_status === 'matched') {
      throw new Error(
        `signatory was matched as the certificate holder (confidence=${ravi.match_confidence})`
      );
    }
    pass('a signatory name is not matched as the certificate holder');
  } catch (err) {
    fail('a signatory name is not matched as the certificate holder', err);
  }
}

async function testHolderNameStillMatches() {
  // Guard against overcorrection: the ordinary layout — holder's name as a
  // heading, a signatory elsewhere — must still match cleanly.
  try {
    const { matchCertificatesFromPdfPages } = await import('../src/utils/certMatch.js');

    const pages = [{
      page_number: 1,
      stored_name: 'p1.pdf',
      size: 1000,
      text: 'Certificate of Participation awarded to Priya Sharma for attending the workshop. Ravi Menon Coordinator',
    }];
    const rows = [{ name: 'Priya Sharma', email: 'priya@example.com' }];

    const result = matchCertificatesFromPdfPages(rows, pages);
    const priya = result.recipients.find((r) => r.email === 'priya@example.com');

    if (!priya || priya.match_status !== 'matched') {
      throw new Error(`the real holder was not matched (status=${priya?.match_status})`);
    }
    pass('the certificate holder is still matched normally');
  } catch (err) {
    fail('the certificate holder is still matched normally', err);
  }
}

async function testConsumeNeverDrivesReservedNegative() {
  // Regression test: a stop/cancel releasing the reservation while a send is
  // still in flight used to leave consumeSendQuota decrementing reserved_credits
  // below zero. computeQuotaSnapshot subtracts `reserved` from available, so a
  // negative value *raised* the balance — repeat start/stop to farm free sends.
  try {
    const User = (await import('../src/models/User.js')).default;
    const { consumeSendQuota, reserveCampaignQuota, releaseCampaignQuota, getQuotaDateKey } =
      await import('../src/services/quotaService.js');
    const { FREE_DAILY_CREDITS } = await import('../src/config/billingConfig.js');

    await User.findByIdAndUpdate(testUserId, {
      $set: {
        email_credits: 5,
        reserved_credits: 0,
        // Exactly at the free limit (not above it) so the paid branch is taken
        // without the free term going negative.
        free_sent_today: FREE_DAILY_CREDITS,
        free_quota_date: getQuotaDateKey(),
        role: 'user',
      },
    });

    await reserveCampaignQuota(testUserId, campaignId, 1);
    // The race: reservation released (stop/cancel) before the in-flight send
    // reports back.
    await releaseCampaignQuota(testUserId, campaignId);
    await consumeSendQuota(testUserId, campaignId);

    const after = await User.findById(testUserId).select('reserved_credits email_credits');
    if (after.reserved_credits < 0) {
      throw new Error(`reserved_credits went negative (${after.reserved_credits})`);
    }
    if (after.email_credits !== 4) {
      throw new Error(`expected the credit to still be charged, got ${after.email_credits}`);
    }
    // Restore a clean billing state — later tests reserve against this user.
    await User.findByIdAndUpdate(testUserId, {
      $set: { email_credits: 100, reserved_credits: 0, free_sent_today: 0 },
    });
    pass('consumeSendQuota charges without driving reserved_credits negative');
  } catch (err) {
    fail('consumeSendQuota charges without driving reserved_credits negative', err);
  }
}

async function testStaleReservationSweepCoversTerminalStates() {
  // Regression test: the sweep filtered on an inclusion list of
  // ['paused','stopped','failed'], so credits stranded on a 'completed' campaign
  // (loop finished, process died before releaseCampaignQuota) were never
  // returned — and reconcileReservations re-asserted them on every pass.
  try {
    const User = (await import('../src/models/User.js')).default;
    const Campaign = (await import('../src/models/Campaign.js')).default;
    const { reserveCampaignQuota } = await import('../src/services/quotaService.js');
    const { reconcileReservations } = await import('../src/services/quotaReconciler.js');

    await User.findByIdAndUpdate(testUserId, {
      $set: { email_credits: 10, reserved_credits: 0 },
    });

    const stranded = await Campaign.create({
      user_id: testUserId,
      name: 'Stranded reservation',
      subject: 'x',
      body: '<p>x</p>',
      status: 'completed',
    });
    await reserveCampaignQuota(testUserId, stranded._id, 4);

    // Age it past the staleness cutoff.
    await Campaign.updateOne(
      { _id: stranded._id },
      { $set: { updated_at: new Date(Date.now() - 100 * 60 * 60 * 1000) } },
      { timestamps: false }
    );

    await reconcileReservations();

    const after = await Campaign.findById(stranded._id).select('quota_reserved');
    if ((after?.quota_reserved ?? 0) !== 0) {
      throw new Error(`completed campaign still holds ${after.quota_reserved} reserved credit(s)`);
    }
    await Campaign.deleteOne({ _id: stranded._id });
    pass('stale reservations are swept from terminal-state campaigns');
  } catch (err) {
    fail('stale reservations are swept from terminal-state campaigns', err);
  }
}

async function testCampaignDeleteReleasesReservedCredits() {
  // Regression test: deleting a campaign must release its reserved credits back
  // to the user — it previously deleted the campaign without releasing
  // quota_reserved, permanently stranding those credits (see campaigns.js DELETE).
  try {
    const User = (await import('../src/models/User.js')).default;
    const Campaign = (await import('../src/models/Campaign.js')).default;
    const { reserveCampaignQuota } = await import('../src/services/quotaService.js');

    await reserveCampaignQuota(testUserId, campaignId, 3);
    const reservedUser = await User.findById(testUserId).select('reserved_credits');
    if (reservedUser.reserved_credits < 3) {
      throw new Error(`expected reserved_credits >= 3, got ${reservedUser.reserved_credits}`);
    }

    const { res, data } = await request(`/campaigns/${campaignId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(data.error);

    const afterUser = await User.findById(testUserId).select('reserved_credits');
    if (afterUser.reserved_credits !== 0) {
      throw new Error(`expected reserved_credits to be released to 0, got ${afterUser.reserved_credits}`);
    }
    const deletedCampaign = await Campaign.findById(campaignId);
    if (deletedCampaign) throw new Error('campaign was not deleted');

    pass('DELETE /campaigns/:id releases reserved credits');
  } catch (err) {
    fail('DELETE /campaigns/:id releases reserved credits', err);
  }
}

async function testPersonalizeEscapesHtml() {
  // Regression test: merge-field substitution must HTML-escape untrusted
  // recipient data before it's injected into the email body — it previously
  // did a raw string replace, letting a contact's name inject markup/scripts
  // into every recipient's inbox (see utils/personalize.js).
  try {
    const { personalize } = await import('../src/utils/personalize.js');
    const recipient = { name: '<img src=x onerror=alert(1)>', email: 'a@b.com' };

    const body = personalize('Hi {{name}}', recipient, { escapeHtml: true });
    if (body.includes('<img')) throw new Error(`expected escaped output, got: ${body}`);
    if (!body.includes('&lt;img')) throw new Error(`expected HTML-entity escaping, got: ${body}`);

    const subject = personalize('Hi {{name}}', recipient);
    if (!subject.includes('<img')) throw new Error('subject (non-HTML context) should not be escaped');

    pass('personalize() escapes untrusted recipient data in HTML context');
  } catch (err) {
    fail('personalize() escapes untrusted recipient data in HTML context', err);
  }
}

async function testPdfMagicByteValidation() {
  // Regression test: attachment upload must verify actual file content, not
  // just client-supplied mimetype/extension (see middleware/pdfUpload.js).
  try {
    const fs = (await import('fs')).default;
    const os = (await import('os')).default;
    const path = (await import('path')).default;
    const { hasPdfMagicBytes } = await import('../src/utils/fileSignature.js');

    const fakePdfPath = path.join(os.tmpdir(), `fake-${Date.now()}.pdf`);
    fs.writeFileSync(fakePdfPath, '<html><script>alert(1)</script></html>');
    const realPdfPath = path.join(os.tmpdir(), `real-${Date.now()}.pdf`);
    fs.writeFileSync(realPdfPath, '%PDF-1.4\n%fake but has the right header');

    const fakeIsValid = await hasPdfMagicBytes(fakePdfPath);
    const realIsValid = await hasPdfMagicBytes(realPdfPath);
    fs.unlinkSync(fakePdfPath);
    fs.unlinkSync(realPdfPath);

    if (fakeIsValid) throw new Error('HTML file disguised with .pdf extension was accepted as a valid PDF');
    if (!realIsValid) throw new Error('file with a real %PDF- header was rejected');

    pass('hasPdfMagicBytes verifies actual file content, not just extension');
  } catch (err) {
    fail('hasPdfMagicBytes verifies actual file content, not just extension', err);
  }
}

async function testLogsWithFilters() {
  try {
    const { writeLog } = await import('../src/services/logService.js');
    await writeLog({
      campaignId,
      level: 'info',
      action: 'send_attempt',
      message: 'filter test',
      recipientEmail: 'alice@example.com',
    });

    const { res, data } = await request(
      `/campaigns/${campaignId}/logs?action=send_attempt&recipient_email=alice@example.com&limit=10`
    );
    if (!res.ok) throw new Error(data.error);
    if (!Array.isArray(data.logs)) throw new Error('expected logs array');
    pass('GET /campaigns/:id/logs with filters');
  } catch (err) {
    fail('GET /campaigns/:id/logs with filters', err);
  }
}

async function testResumeInterrupted() {
  try {
    const Campaign = (await import('../src/models/Campaign.js')).default;
    await Campaign.findByIdAndUpdate(campaignId, { status: 'sending' });

    const { resumeInterruptedCampaigns, isCampaignRunning } = await import('../src/services/sendEngine.js');
    await resumeInterruptedCampaigns();

    await Campaign.findByIdAndUpdate(campaignId, { status: 'paused' });
    for (let i = 0; i < 30; i++) {
      if (!isCampaignRunning(campaignId)) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    pass('resumeInterruptedCampaigns runs without error');
  } catch (err) {
    fail('resumeInterruptedCampaigns runs without error', err);
  }
}

async function testErrorClassifier() {
  try {
    const { isTransientError, isPermanentError, classifySendError } = await import(
      '../src/utils/errorClassifier.js'
    );
    if (!isTransientError({ code: 'ETIMEDOUT' })) throw new Error('ETIMEDOUT should be transient');
    if (!isPermanentError({ responseCode: 550 })) throw new Error('550 should be permanent');
    if (classifySendError({ code: 'ECONNRESET' }) !== 'transient') {
      throw new Error('ECONNRESET classification wrong');
    }
    pass('Error classifier (transient vs permanent)');
  } catch (err) {
    fail('Error classifier (transient vs permanent)', err);
  }
}

async function cleanup() {
  const Campaign = (await import('../src/models/Campaign.js')).default;
  await Campaign.updateMany({ status: 'sending' }, { $set: { status: 'paused' } });

  const { isCampaignRunning } = await import('../src/services/sendEngine.js');
  for (let i = 0; i < 50; i++) {
    if (!campaignId || !isCampaignRunning(campaignId)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Leave no trace on a real (non-memory-server) database.
  if (testUserId && mongoose.connection.readyState === 1) {
    const { default: User } = await import('../src/models/User.js');
    const { default: Contact } = await import('../src/models/Contact.js');
    const { default: GmailAccount } = await import('../src/models/GmailAccount.js');
    const { default: CampaignRecipient } = await import('../src/models/CampaignRecipient.js');
    if (campaignId) await CampaignRecipient.deleteMany({ campaign_id: campaignId });
    await Campaign.deleteMany({ user_id: testUserId });
    await Contact.deleteMany({ user_id: testUserId });
    await GmailAccount.deleteMany({ user_id: testUserId });
    await User.deleteOne({ _id: testUserId });
  }

  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (mongoose.connection.readyState === 1) {
    await mongoose.disconnect();
  }
  if (memoryServer) await memoryServer.stop();
}

async function main() {
  console.log('\nMailer feature tests\n');

  try {
    await setupDb();
    await startServer();
    await authenticate();
    await seedData();

    await testHealthAndConfig();
    await testCampaignList();
    await testProgressEndpoint();
    await testAtomicClaimAndRecovery();
    await testRetryFailed();
    await testRetryFailedRespectsMaxRetries();
    await testLogsWithFilters();
    await testResumeInterrupted();
    await testAppPasswordEncryptedAtRest();
    await testSignatoryNameIsNotMatchedAsHolder();
    await testHolderNameStillMatches();
    await testConsumeNeverDrivesReservedNegative();
    await testStaleReservationSweepCoversTerminalStates();
    await testCampaignDeleteReleasesReservedCredits();
    await testPersonalizeEscapesHtml();
    await testPdfMagicByteValidation();
    await testErrorClassifier();
  } catch (err) {
    console.error('\nSetup failed:', err.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('\nFailed:');
    failed.forEach((f) => console.log(`  - ${f.name}: ${f.error}`));
    process.exitCode = 1;
  } else if (results.length === 0) {
    console.log('\nNo tests ran (setup failed before any test executed).\n');
    process.exitCode = 1;
  } else {
    console.log('\nAll tests passed.\n');
  }
}

main();
