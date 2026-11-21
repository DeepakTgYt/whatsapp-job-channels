const { MongoClient } = require('mongodb');
const cfg = require('./config');

let db;
async function connect() {
  if (db) return db;
  if (!cfg.MONGODB_URI) throw new Error('MONGODB_URI missing');
  const client = new MongoClient(cfg.MONGODB_URI, { maxPoolSize: 5 });
  await client.connect();
  db = client.db(cfg.DB_NAME);
  await Promise.all([
    db.collection('posts').createIndex({ hash: 1 }, { unique: true }),
    db.collection('posts').createIndex({ channel: 1, createdAt: -1 }),
    db.collection('posts').createIndex({ lastDate: 1 }),
    db.collection('queue').createIndex({ status: 1, createdAt: 1 }),
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
  await col('kv').updateOne({ _id: key }, { $set: { value } }, { upsert: true });
}

module.exports = { connect, col, getKV, setKV };
