export function toApiId(doc) {
  if (!doc) return doc;
  if (typeof doc === 'string') return doc;
  if (doc._id) return doc._id.toString();
  return doc.id?.toString?.() ?? doc.id;
}

export function toApiDoc(doc, extra = {}) {
  if (!doc) return null;
  const obj = doc.toObject ? doc.toObject({ virtuals: true }) : { ...doc };
  const { _id, __v, ...rest } = obj;
  return {
    id: _id?.toString() ?? obj.id,
    ...rest,
    ...extra,
  };
}

export function toApiDocs(docs, extraFn) {
  return docs.map((d) => toApiDoc(d, extraFn?.(d) ?? {}));
}
