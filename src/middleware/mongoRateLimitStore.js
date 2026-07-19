import mongoose from 'mongoose';

/**
 * express-rate-limit v7 store backed by MongoDB.
 *
 * The default memory store counts per *process*. With `--max-instances=10` on
 * Cloud Run that turned a 20-per-15-min auth limit into an effective 200, and
 * every counter reset on cold start or deploy. Auth limits are only meaningful
 * if they are shared, so these live in Mongo — which the app already depends on.
 *
 * Deliberately fail-open: if Mongo is unreachable the API cannot serve auth
 * requests anyway, and a limiter outage must not become a total outage.
 */
const COLLECTION = 'rate_limits';

let indexReady = false;

async function ensureIndex(collection) {
  if (indexReady) return;
  try {
    await collection.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0 });
    indexReady = true;
  } catch {
    // A missing TTL index only means rows linger; counting still works.
  }
}

export class MongoRateLimitStore {
  constructor({ prefix = 'rl' } = {}) {
    this.prefix = prefix;
    this.windowMs = 60_000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  _collection() {
    if (mongoose.connection.readyState !== 1) return null;
    return mongoose.connection.db.collection(COLLECTION);
  }

  _key(key) {
    return `${this.prefix}:${key}`;
  }

  async increment(key) {
    const collection = this._collection();
    if (!collection) {
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }

    await ensureIndex(collection);
    const now = new Date();
    const id = this._key(key);

    try {
      // Increment only while the current window is still live. Scoping the
      // filter on expires_at is what makes the window roll over atomically
      // instead of racing between concurrent requests.
      const existing = await collection.findOneAndUpdate(
        { _id: id, expires_at: { $gt: now } },
        { $inc: { hits: 1 } },
        { returnDocument: 'after' }
      );

      const found = existing?.value ?? existing;
      if (found?.hits) {
        return { totalHits: found.hits, resetTime: found.expires_at };
      }

      // Window missing or expired — start a new one.
      const resetTime = new Date(now.getTime() + this.windowMs);
      await collection.updateOne(
        { _id: id },
        { $set: { hits: 1, expires_at: resetTime } },
        { upsert: true }
      );
      return { totalHits: 1, resetTime };
    } catch (err) {
      console.error('[rate-limit] store unavailable, allowing request:', err?.message);
      return { totalHits: 1, resetTime: new Date(now.getTime() + this.windowMs) };
    }
  }

  async decrement(key) {
    const collection = this._collection();
    if (!collection) return;
    try {
      await collection.updateOne(
        { _id: this._key(key), hits: { $gt: 0 } },
        { $inc: { hits: -1 } }
      );
    } catch {
      /* best effort */
    }
  }

  async resetKey(key) {
    const collection = this._collection();
    if (!collection) return;
    try {
      await collection.deleteOne({ _id: this._key(key) });
    } catch {
      /* best effort */
    }
  }
}
