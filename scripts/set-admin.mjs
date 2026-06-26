/**
 * Promote an existing user to admin, or create a new admin account.
 *
 * Usage:
 *   node scripts/set-admin.mjs --email admin@example.com
 *   node scripts/set-admin.mjs --email admin@example.com --password "YourPassword123"
 *   node scripts/set-admin.mjs --email admin@example.com --name "Admin User"
 *   node scripts/set-admin.mjs --list
 */
import './load-env.mjs';
import mongoose from 'mongoose';
import User from '../src/models/User.js';
import { getAdminEmails } from '../src/utils/adminAccess.js';

function parseArgs(argv) {
  const args = { list: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--list') args.list = true;
    else if (arg === '--email') args.email = argv[++i];
    else if (arg === '--password') args.password = argv[++i];
    else if (arg === '--name') args.name = argv[++i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  await mongoose.connect(process.env.MONGODB_URI);

  if (args.list) {
    const users = await User.find().select('name email role is_active has_paid_access').sort({ email: 1 }).lean();
    console.log('Users:');
    for (const user of users) {
      const envAdmin = getAdminEmails().includes(user.email);
      console.log(`  - ${user.email} (${user.name}) role=${user.role}${envAdmin ? ' [ADMIN_EMAILS]' : ''}`);
    }
    await mongoose.disconnect();
    return;
  }

  const email = String(args.email || '').trim().toLowerCase();
  if (!email) {
    console.error('Usage: node scripts/set-admin.mjs --email you@example.com [--password "..."] [--name "Name"]');
    console.error('       node scripts/set-admin.mjs --list');
    process.exit(1);
  }

  let user = await User.findOne({ email }).select('+password');

  if (!user) {
    if (!args.password) {
      console.error(`No user found for ${email}. Register first or pass --password to create an admin account.`);
      process.exit(1);
    }

    user = await User.create({
      name: args.name?.trim() || 'Admin',
      email,
      password: args.password,
      role: 'admin',
      has_paid_access: true,
    });
    console.log(`Created admin account: ${email}`);
  } else {
    user.role = 'admin';
    user.has_paid_access = true;
    user.is_active = true;
    if (args.name?.trim()) user.name = args.name.trim();
    if (args.password) user.password = args.password;
    await user.save();
    console.log(`Updated admin account: ${email}`);
  }

  console.log('Admin access is active. Restart the backend if you changed ADMIN_EMAILS in .env.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
