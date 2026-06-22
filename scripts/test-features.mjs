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
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
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
    { name: 'Alice', email: 'alice@example.com' },
    { name: 'Bob', email: 'bob@example.com' },
    { name: 'Carol', email: 'carol@example.com' },
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
    await seedData();

    await testHealthAndConfig();
    await testCampaignList();
    await testProgressEndpoint();
    await testAtomicClaimAndRecovery();
    await testRetryFailed();
    await testLogsWithFilters();
    await testResumeInterrupted();
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
  } else {
    console.log('\nAll tests passed.\n');
  }
}

main();
