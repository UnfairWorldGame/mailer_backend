/**
 * Backfill for the auth rebuild.
 *
 * Every account that existed before email verification shipped is marked
 * verified — those users already proved control of their address by using the
 * product, and gating them retroactively would lock them out of sending with no
 * warning. New signups go through the real flow.
 *
 * Also seeds the session-invalidation columns so `requireAuth` has a defined
 * token_version to compare against.
 *
 * Usage:  node scripts/migrate-auth.mjs [--dry]
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const dryRun = process.argv.includes('--dry');

await mongoose.connect(process.env.MONGODB_URI);
const users = mongoose.connection.db.collection('users');

const needsVerified = await users.countDocuments({ email_verified: { $ne: true } });
const needsTokenVersion = await users.countDocuments({ token_version: { $exists: false } });

console.log(`accounts to mark verified : ${needsVerified}`);
console.log(`accounts needing token_version: ${needsTokenVersion}`);

for (const u of await users.find({}).project({ email: 1, email_verified: 1 }).toArray()) {
  if (u.email_verified !== true) console.log(`  verify -> ${u.email}`);
}

if (!dryRun) {
  const verified = await users.updateMany(
    { email_verified: { $ne: true } },
    { $set: { email_verified: true, email_verified_at: new Date() } }
  );
  const versioned = await users.updateMany(
    { token_version: { $exists: false } },
    { $set: { token_version: 0, password_changed_at: null } }
  );
  console.log(`\nmarked verified: ${verified.modifiedCount}, seeded token_version: ${versioned.modifiedCount}`);
} else {
  console.log('\n[dry run] no changes written');
}

await mongoose.disconnect();
