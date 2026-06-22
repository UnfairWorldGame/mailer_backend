import mongoose from 'mongoose';
import Contact from '../models/Contact.js';

export async function getContactMeta() {
  const count = await Contact.countDocuments();
  const namedCount = await Contact.countDocuments({ name: { $exists: true, $ne: '' } });
  return { count, has_names: namedCount > 0 };
}

export async function upsertContacts(contacts) {
  let inserted = 0;
  let updated = 0;

  for (const c of contacts) {
    const email = String(c.email || '').trim().toLowerCase();
    if (!email) continue;

    const existing = await Contact.findOne({ email });
    if (existing) {
      if (c.name) existing.name = c.name;
      await existing.save();
      updated++;
    } else {
      await Contact.create({ name: c.name || '', email });
      inserted++;
    }
  }

  return { inserted, updated, total: contacts.length };
}

export async function deleteContactsByIds(ids = []) {
  const validIds = ids.filter((id) => mongoose.isValidObjectId(id));
  if (!validIds.length) {
    return { deleted: 0, ...(await getContactMeta()) };
  }

  const result = await Contact.deleteMany({ _id: { $in: validIds } });
  return { deleted: result.deletedCount ?? 0, ...(await getContactMeta()) };
}

export async function deleteAllContacts() {
  const result = await Contact.deleteMany({});
  return { deleted: result.deletedCount ?? 0, ...(await getContactMeta()) };
}

export function buildContactSearchFilter(search) {
  const term = String(search || '').trim();
  if (!term) return {};

  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    $or: [
      { email: { $regex: escaped, $options: 'i' } },
      { name: { $regex: escaped, $options: 'i' } },
    ],
  };
}
