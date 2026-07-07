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
  const { signToken } = await import('../src/middleware/auth.js');

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
  authToken = signToken(user._id);
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
    // Pretend a send loop is already active (status 'sending') so the route's
    // `if (campaign.status !== 'sending') startCampaignSend(...)` branch is
    // skipped — otherwise this kicks off a real async send against the fake
    // test Gmail account and the resulting race makes this assertion flaky.
    await Campaign.findByIdAndUpdate(campaignId, { status: 'sending', failed_count: 2 });

    const { res, data } = await request(`/campaigns/${campaignId}/retry-failed`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(data.error);

    const exhaustedAfter = await CampaignRecipient.findById(exhausted._id);
    if (exhaustedAfter.status !== 'failed') {
      throw new Error(`recipient at max retries was requeued (status=${exhaustedAfter.status})`);
    }
    const retryableAfter = await CampaignRecipient.findById(retryable._id);
    if (retryableAfter.status !== 'pending') {
      throw new Error(`recipient under retry cap was not requeued (status=${retryableAfter.status})`);
    }
    pass('POST /campaigns/:id/retry-failed respects max_retries_per_recipient');
  } catch (err) {
    fail('POST /campaigns/:id/retry-failed respects max_retries_per_recipient', err);
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
