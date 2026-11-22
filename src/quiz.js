// Daily quiz for the 4 WhatsApp channels: native WhatsApp channel QUIZ polls (one correct answer;
// a follower sees right/wrong only after tapping an option, like Telegram quiz mode). No answer post.
//
// Wire format (Baileys 6.7.24 cannot build it itself: its proto still has pollCreationMessageV5 at the old
// field 94; WhatsApp now uses field 111 = PollCreationMessage with pollType QUIZ + correctAnswer):
//   <message to="<channel>@newsletter" id type="poll">
//     <meta polltype="quiz_creation" contenttype="text"/>
//     <plaintext>Message{ messageContextInfo{messageSecret}, pollCreationMessageV5(111){...} }</plaintext>
//   </message>
// Same stanza the maintained Baileys v7 fork @itsliaaa/baileys sends for channel quizzes.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { proto } = require('@whiskeysockets/baileys');
const cfg = require('./config');
const { col, getKV, setKV } = require('./db');

const BANK_DIR = path.join(__dirname, '..', 'data', 'quiz');
const HEAD = { ssc: 'SSC', railway: 'Railway', bihar: 'Bihar', army: 'Army/Agniveer' };
const MAX_OPTION = 100;

const banks = {};
function bank(key) {
  if (!banks[key]) banks[key] = JSON.parse(fs.readFileSync(path.join(BANK_DIR, `${key}.json`), 'utf8')).questions;
  return banks[key];
}

// ---- question choice: random, never repeats in a channel until its whole bank is used ----
async function pickQuestion(channel) {
  const qs = bank(channel);
  const used = new Set((await col('quiz_used').find({ channel }).project({ qid: 1 }).toArray()).map((d) => d.qid));
  let pool = qs.filter((q) => !used.has(q.id));
  if (!pool.length) { // bank exhausted -> start a new cycle
    await col('quiz_used').deleteMany({ channel });
    pool = qs;
  }
  const q = pool[crypto.randomInt(pool.length)];
  await col('quiz_used').updateOne({ _id: `${channel}:${q.id}` }, { $set: { channel, qid: q.id, at: new Date() } }, { upsert: true });
  return q;
}

function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}

// poll payload: { name, values[4], correct } (correct is one of values, options shuffled every time)
function buildPoll(q, channel) {
  const ch = cfg.CHANNELS.find((c) => c.key === channel);
  const tags = [ch ? ch.tags : '', q.tag ? `#${q.tag}` : ''].filter(Boolean).join(' ');
  const name = `🧠 Daily Quiz | ${HEAD[channel] || channel}   ${tags}\n\n${q.hi}\n${q.en}`;
  const values = shuffle(q.options);
  return validate({ name, values, correct: q.options[q.answer] });
}

function validate(p) {
  if (!p.name || p.name.length > 5000) throw new Error('quiz: bad question length');
  if (p.values.length < 2 || p.values.length > 12) throw new Error('quiz: 2-12 options');
  if (new Set(p.values.map((v) => v.trim())).size !== p.values.length) throw new Error('quiz: duplicate options');
  if (p.values.some((v) => !v || v.length > MAX_OPTION)) throw new Error('quiz: option empty or too long');
  if (!p.values.includes(p.correct)) throw new Error('quiz: correct answer not among options');
  return p;
}

// ---- protobuf: Message bytes with field 111 (pollCreationMessageV5) ----
function varint(n) {
  const b = [];
  while (n > 127) { b.push((n & 127) | 128); n >>>= 7; }
  b.push(n);
  return Buffer.from(b);
}
function encodeQuizMessage(p) {
  const pcm = proto.Message.PollCreationMessage.encode({
    name: p.name,
    options: p.values.map((optionName) => ({ optionName })),
    selectableOptionsCount: 1,
    pollType: 1, // QUIZ
    correctAnswer: { optionName: p.correct },
  }).finish();
  const ctx = proto.Message.encode({ messageContextInfo: { messageSecret: crypto.randomBytes(32) } }).finish();
  return Buffer.concat([Buffer.from(ctx), varint((111 << 3) | 2), varint(pcm.length), Buffer.from(pcm)]);
}
// read one top-level field from Message bytes (used to verify what WhatsApp stored)
function readField(buf, want) {
  let i = 0;
  const rv = () => { let r = 0, s = 0, x; do { x = buf[i++]; r += (x & 127) * 2 ** s; s += 7; } while (x & 128); return r; };
  while (i < buf.length) {
    const tag = rv(), f = Math.floor(tag / 8), wt = tag & 7;
    if (wt === 0) rv();
    else if (wt === 1) i += 8;
    else if (wt === 5) i += 4;
    else if (wt === 2) { const len = rv(); if (f === want) return buf.subarray(i, i + len); i += len; }
    else return null;
  }
  return null;
}
function decodeQuizMessage(buf) {
  const inner = readField(Buffer.from(buf), 111);
  if (!inner) return null;
  const m = proto.Message.PollCreationMessage.decode(inner);
  return { name: m.name, options: (m.options || []).map((o) => o.optionName), pollType: m.pollType, correct: m.correctAnswer && m.correctAnswer.optionName, selectable: m.selectableOptionsCount };
}

// ---- schedule / state ----
const isOff = async () => !cfg.QUIZ_ENABLED || (await getKV('quizOff', false));
const QUIZ_EXPIRE_MS = () => cfg.QUIZ_MAX_DELAY_HOURS * 3600e3;

// queue one quiz per channel (jobs keep priority in the send queue)
async function enqueueQuiz(channels = cfg.CHANNELS.map((c) => c.key), why = 'schedule') {
  const out = [];
  for (const channel of channels) {
    const q = await pickQuestion(channel);
    await col('queue').insertOne({ channel, kind: 'quiz', qid: q.id, why, status: 'pending', createdAt: new Date() });
    out.push(`${channel}:${q.id}`);
  }
  return out;
}

async function recordResult(ok, info) {
  const st = (await getKV('quizState')) || { fails: 0 };
  if (ok) Object.assign(st, { fails: 0, lastSentAt: new Date(), lastChannel: info.channel, lastServerId: info.serverId || null, lastAcked: !!info.acked, lastError: null });
  else Object.assign(st, { fails: (st.fails || 0) + 1, lastFailAt: new Date(), lastError: String(info.error || '').slice(0, 160) });
  await setKV('quizState', st);
  return st;
}

async function status() {
  const st = (await getKV('quizState')) || {};
  const off = await isOff();
  const since = new Date(Date.now() - 86400e3);
  const sent24 = await col('queue').countDocuments({ kind: 'quiz', status: 'sent', sentAt: { $gte: since } });
  const usedAgg = await col('quiz_used').aggregate([{ $group: { _id: '$channel', n: { $sum: 1 } } }]).toArray();
  const used = Object.fromEntries(usedAgg.map((d) => [d._id, d.n]));
  const banksInfo = cfg.CHANNELS.map((c) => { let n = 0; try { n = bank(c.key).length; } catch { n = 0; } return { channel: c.key, bank: n, used: used[c.key] || 0 }; });
  return {
    enabled: !off,
    autoDisabled: !!(await getKV('quizAutoOff', false)),
    hoursIST: cfg.QUIZ_HOURS,
    sent24h: sent24,
    lastSentAt: st.lastSentAt || null,
    lastChannel: st.lastChannel || null,
    lastServerId: st.lastServerId || null,
    consecutiveFails: st.fails || 0,
    lastError: st.lastError || null,
    banks: banksInfo,
  };
}

module.exports = { bank, pickQuestion, buildPoll, validate, encodeQuizMessage, decodeQuizMessage, readField, enqueueQuiz, recordResult, status, isOff, QUIZ_EXPIRE_MS };
