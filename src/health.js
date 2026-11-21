// Per-source health: last success, consecutive failures, short last error. Stored in Mongo 'health'.
const cfg = require('./config');
const { col } = require('./db');

// strip anything that could be a secret or personal data before it is shown/stored
const clean = (msg) =>
  String(msg || '')
    .replace(/mongodb(\+srv)?:\/\/\S+/gi, '[db-uri]')
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b\d{10,}\b/g, '[num]')
    .replace(/[A-Za-z0-9_\-]{32,}/g, '[token]')
    .slice(0, 160);

async function ok(name) {
  await col('health').updateOne({ _id: name }, { $set: { lastSuccessAt: new Date(), consecutiveFails: 0, alerted: false } }, { upsert: true });
}
// returns true when this failure crosses the alert threshold for the first time
async function fail(name, err) {
  const d = await col('health').findOneAndUpdate(
    { _id: name },
    { $inc: { consecutiveFails: 1 }, $set: { lastFailAt: new Date(), lastError: clean(err && err.message ? err.message : err) } },
    { upsert: true, returnDocument: 'after' },
  );
  const doc = d && d.value !== undefined ? d.value : d;
  return !!doc && doc.consecutiveFails >= cfg.ALERT_AFTER_FAILS && !doc.alerted;
}
const markAlerted = (name) => col('health').updateOne({ _id: name }, { $set: { alerted: true } });
const list = () => col('health').find({}).sort({ _id: 1 }).toArray();

module.exports = { ok, fail, markAlerted, list, clean };
