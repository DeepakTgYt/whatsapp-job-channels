const { MongoClient } = require('mongodb');
const cfg = require('./config');

let db;
const DAY = 86400;
async function connect() {
  if (db) return db;
  if (!cfg.MONGODB_URI) throw new Error('MONGODB_URI missing');
  const client = new MongoClient(cfg.MONGODB_URI, { maxPoolSize: 5 });
  await client.connect();
  db = client.db(cfg.DB_NAME);
  const ttl = async (name, field, days) => {
    try {
      await db.collection(name).createIndex({ [field]: 1 }, { expireAfterSeconds: days * DAY, name: `ttl_${field}` });
    } catch (e) {
      // TTL changed in config -> update it in place
      await db.command({ collMod: name, index: { name: `ttl_${field}`, expireAfterSeconds: days * DAY } }).catch(() => {});
    }
  };
  await Promise.all([
    db.collection('posts').createIndex({ hash: 1 }, { unique: true }),
    db.collection('posts').createIndex({ channel: 1, createdAt: -1 }),
    db.collection('posts').createIndex({ lastDate: 1 }),
    db.collection('queue').createIndex({ status: 1, createdAt: 1 }),
    db.collection('dedup').createIndex({ links: 1 }),
    // free-tier guards: old data deletes itself (MongoDB TTL)
    ttl('posts', 'createdAt', cfg.POSTS_TTL_DAYS),
    ttl('queue', 'createdAt', cfg.QUEUE_TTL_DAYS),
    ttl('dedup', 'at', cfg.DEDUP_TTL_DAYS),
    ttl('seen', 'at', cfg.DEDUP_TTL_DAYS),
  ]);
  return db;
}
const col = (name) => db.collection(name);

// small key/value store (last seen Telegram ids, channel jids, pause flag ...)
async function getKV(key, def = null) {
  const d = await col('kv').findOne({ _id: key });
  return d ? d.value : def;
}
async function setKV(key, value) {
  await col('kv').updateOne({ _id: key }, { $set: { value, at: new Date() } }, { upsert: true });
}

// data + index size in MB (cached 10 min, cheap)
let sizeCache = { at: 0, mb: null };
async function dbSizeMB(force = false) {
  if (!force && Date.now() - sizeCache.at < 600e3 && sizeCache.mb !== null) return sizeCache.mb;
  const s = await db.stats();
  sizeCache = { at: Date.now(), mb: Math.round(((s.dataSize || 0) + (s.indexSize || 0)) / 1048576 * 10) / 10 };
  return sizeCache.mb;
}

// daily housekeeping (TTL does most of it)
async function prune() {
  const weekAgo = new Date(Date.now() - 7 * DAY * 1000);
  await col('kv').deleteMany({ _id: /^ran:/, at: { $lt: weekAgo } });
  const pending = await col('queue').countDocuments({ status: 'pending' });
  if (pending > cfg.QUEUE_MAX_PENDING) {
    const old = await col('queue').find({ status: 'pending' }).sort({ createdAt: 1 }).limit(pending - cfg.QUEUE_MAX_PENDING).project({ _id: 1 }).toArray();
    await col('queue').deleteMany({ _id: { $in: old.map((d) => d._id) } });
  }
  await col('queue').deleteMany({ status: { $in: ['sent', 'failed'] }, createdAt: { $lt: new Date(Date.now() - 2 * DAY * 1000) } });
}

// JSON dump for /backup (never includes WhatsApp login data: wa_auth is excluded)
async function backup() {
  const out = { createdAt: new Date().toISOString(), db: cfg.DB_NAME };
  for (const name of ['posts', 'kv', 'dedup', 'health']) out[name] = await col(name).find({ _id: { $not: /^http:/ } }).toArray();
  return out;
}

module.exports = { connect, col, getKV, setKV, dbSizeMB, prune, backup };
