/**
 * One-off repair for data written before the App Password / attachment-path fixes.
 *
 *  1. Gmail App Passwords stored with the spaces Google displays them with
 *     ("abcd efgh ijkl mnop"). Gmail SMTP rejects those with 535-5.7.8, which
 *     failed every recipient of a campaign.
 *  2. Campaign attachments stored as absolute paths from another host
 *     (/opt/render/project/src/attachments/...), which resolve to nothing
 *     locally. New rows store the bare filename.
 *
 * Usage:  node scripts/fix-send-data.mjs [--dry]
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const dryRun = process.argv.includes('--dry');

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

let pwFixed = 0;
for (const acct of await db.collection('gmailaccounts').find({}).toArray()) {
  const current = acct.app_password || '';
  const cleaned = current.replace(/\s+/g, '');
  if (cleaned === current) continue;

  console.log(
    `app_password  ${acct.email}: ${current.length} -> ${cleaned.length} chars (stripped whitespace)`
  );
  if (!dryRun) {
    await db
      .collection('gmailaccounts')
      .updateOne({ _id: acct._id }, { $set: { app_password: cleaned } });
  }
  pwFixed += 1;
}

let attFixed = 0;
for (const campaign of await db.collection('campaigns').find({ 'attachments.0': { $exists: true } }).toArray()) {
  const attachments = campaign.attachments.map((a) => {
    const filename = String(a.file_path || '').split(/[\\/]/).pop();
    return filename === a.file_path ? a : { ...a, file_path: filename };
  });

  if (attachments.every((a, i) => a.file_path === campaign.attachments[i].file_path)) continue;

  campaign.attachments.forEach((a, i) => {
    if (a.file_path !== attachments[i].file_path) {
      console.log(`attachment    "${campaign.name}": ${a.file_path} -> ${attachments[i].file_path}`);
    }
  });
  if (!dryRun) {
    await db.collection('campaigns').updateOne({ _id: campaign._id }, { $set: { attachments } });
  }
  attFixed += 1;
}

console.log(
  `\n${dryRun ? '[dry run] would fix' : 'Fixed'} ${pwFixed} app password(s), ${attFixed} campaign attachment set(s).`
);

await mongoose.disconnect();
