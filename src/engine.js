// The brain: polls Telegram (fast) + official sites (backup), dedups, queues posts, sends with anti-spam rules,
// digests, reminders, health tracking, owner commands.
const cfg = require('./config');
const db = require('./db');
const { col, getKV, setKV } = db;
const { fetchPosts } = require('./telegram');
const { readSource, classifyOfficial, resetCache } = require('./official');
const { buildCard, buildOfficialCard, footer, fmtDate, normTitle } = require('./format');
const health = require('./health');
const wa = require('./whatsapp');

// ---- time helpers (IST) ----
const ist = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3); // shifted clock, read with getUTC*
const istHour = () => ist().getUTCHours();
const istDayKey = (d = new Date()) => ist(d).toISOString().slice(0, 10);
const isQuiet = () => {
  const h = istHour();
  return cfg.QUIET_START > cfg.QUIET_END ? h >= cfg.QUIET_START || h < cfg.QUIET_END : h >= cfg.QUIET_START && h < cfg.QUIET_END;
};

const stats = { lastPoll: null, lastOfficialPoll: null, nextOfficialAt: 0, lastSend: null, errors: [] };
const logErr = (where, e) => {
  const msg = health.clean(e && e.message ? e.message : e);
  console.error(where, msg);
  stats.errors.unshift(`${new Date().toISOString()} ${where}: ${msg}`);
  if (stats.errors.length > cfg.MAX_ERRORS) stats.errors.length = cfg.MAX_ERRORS;
};

// ---- owner alert: self-chat ONLY, once per incident ----
async function alertSelf(key, text) {
  if (!wa.state.ready || !wa.state.selfJid) return false;
  try { await wa.sendSelf(`⚠️ *Bot alert*\n${text}`); return true; } catch (e) { logErr(`alert ${key}`, e); return false; }
}
async function sourceFailed(name, e) {
  logErr(name, e);
  if (await health.fail(name, e)) {
    const sent = await alertSelf(name, `Source *${name}* ${cfg.ALERT_AFTER_FAILS}+ baar lagatar fail.\nError: ${health.clean(e.message)}\nBaaki sources chal rahe hain. /status dekhein.`);
    if (sent) await health.markAlerted(name);
  }
}

// ---- dedup across Telegram + official (same job never posted twice; first one wins) ----
const STOP = new Set('the and for of in to on a an by with from regarding notice important candidates post posts exam examination 2024 2025 2026 2027 ke ki ka se'.split(' '));
const tokens = (t) => new Set(String(t).toLowerCase().replace(/[^a-z0-9\u0900-\u097f ]/g, ' ').split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
function similar(a, b) {
  const A = tokens(a), B = tokens(b);
  if (A.size < 3 || B.size < 3) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter) >= 0.6 || inter / Math.min(A.size, B.size) >= 0.85;
}
async function isDuplicate(card, channel) {
  const or = [{ _id: card.hash }];
  if (card.links.length) or.push({ links: { $in: card.links } });
  if (await col('dedup').findOne({ $or: or }, { projection: { _id: 1 } })) return true;
  const recent = await col('posts').find({ channel, type: card.type, createdAt: { $gte: new Date(Date.now() - 5 * 86400e3) } }).project({ title: 1 }).toArray();
  return recent.some((p) => similar(p.title, card.title));
}
async function record(card, channel, extra) {
  await col('posts').insertOne({ hash: card.hash, channel, type: card.type, title: card.title, lastDate: card.lastDate, links: card.links, createdAt: new Date(), reminded: [], ...extra });
  await col('dedup').updateOne({ _id: card.hash }, { $set: { links: card.links, at: new Date() } }, { upsert: true });
}
async function accept(card, channel, extra) {
  if (await isDuplicate(card, channel)) return false;
  try {
    await record(card, channel, extra);
  } catch (e) {
    if (e.code === 11000) return false;
    throw e;
  }
  await col('queue').insertOne({ channel, text: card.text, kind: 'post', status: 'pending', createdAt: new Date() });
  kick();
  return true;
}

// ---- 1a. poll Telegram (every POLL_MINUTES) ----
async function poll() {
  for (const ch of cfg.CHANNELS) {
    const name = `telegram:${ch.key}`;
    try {
      const posts = await fetchPosts(ch.telegram);
      await health.ok(name);
      if (!posts.length) continue;
      const maxId = posts[posts.length - 1].id;
      const last = await getKV(`tg:${ch.key}`);
      if (last === null) {
        await setKV(`tg:${ch.key}`, maxId); // first run: don't flood old posts
        continue;
      }
      for (const p of posts.filter((p) => p.id > last)) {
        const card = buildCard(p, ch);
        if (!card) continue; // quiz / poll / non-job post
        await accept(card, ch.key, { src: 'telegram', tgId: p.id });
      }
      await setKV(`tg:${ch.key}`, maxId);
    } catch (e) {
      await sourceFailed(name, e); // official sources keep the channel alive meanwhile
    }
  }
  stats.lastPoll = new Date();
}

// ---- 1b. poll official websites (every OFFICIAL_POLL_MINUTES + jitter) ----
async function pollOfficial() {
  for (const src of cfg.OFFICIAL_SOURCES) {
    const name = `official:${src.id}`;
    try {
      const seeded = await getKV(`seeded:${src.id}`);
      if (!seeded && src.url) await resetCache(src.url);
      const res = await readSource(src);
      await health.ok(name);
      if (res.notModified || !res.items) continue;
      const fresh = [];
      for (const it of res.items) {
        const r1 = await col('seen').updateOne({ _id: it.uid }, { $setOnInsert: { at: new Date() } }, { upsert: true });
        const r2 = await col('seen').updateOne({ _id: `link:${it.link}` }, { $setOnInsert: { at: new Date() } }, { upsert: true });
        if (r1.upsertedCount && (r2.upsertedCount || /\/$/.test(it.link))) fresh.push(it); // new title AND new link
      }
      if (!seeded) { await setKV(`seeded:${src.id}`, true); continue; } // first run: mark all existing as seen, post nothing
      const maxAge = Date.now() - cfg.OFFICIAL_MAX_AGE_DAYS * 86400e3;
      for (const it of fresh.reverse()) {
        if (it.date && it.date.getTime() < maxAge) continue; // old notice resurfacing
        const type = classifyOfficial(it.title, it.forceType);
        if (!type) continue; // tender / RTI / unclassified
        await accept(buildOfficialCard(it, type), src.channel, { src: name });
      }
    } catch (e) {
      await sourceFailed(name, e);
    }
    await new Promise((r) => setTimeout(r, 1500)); // polite gap between sites
  }
  stats.lastOfficialPoll = new Date();
  stats.nextOfficialAt = Date.now() + cfg.OFFICIAL_POLL_MINUTES * 60e3 + Math.floor(Math.random() * 90e3);
}

// ---- 2. send queue with anti-spam (sends immediately when possible, never closer than MIN_GAP) ----
let sending = false;
let kickTimer = null;
function kick(delay = 0) {
  if (kickTimer) return;
  kickTimer = setTimeout(async () => { kickTimer = null; await sendNext().catch((e) => logErr('send', e)); }, delay);
}
async function sendNext() {
  if (sending) return;
  if (!wa.state.ready || isQuiet() || (await getKV('paused', false))) return;
  const gapLeft = stats.lastSend ? cfg.MIN_GAP_SECONDS * 1000 - (Date.now() - stats.lastSend) : 0;
  if (gapLeft > 0) return kick(gapLeft + 50);
  sending = true;
  try {
    const hourAgo = new Date(Date.now() - 3600e3);
    const pending = await col('queue').find({ status: 'pending' }).sort({ createdAt: 1 }).limit(20).toArray();
    for (const item of pending) {
      const sentLastHour = await col('queue').countDocuments({ channel: item.channel, status: 'sent', sentAt: { $gte: hourAgo } });
      if (sentLastHour >= cfg.MAX_POSTS_PER_HOUR) continue;
      try {
        await wa.sendToChannel(item.channel, item.text);
        await col('queue').updateOne({ _id: item._id }, { $set: { status: 'sent', sentAt: new Date() } });
        stats.lastSend = Date.now();
        await setKV('lastPostAt', new Date());
      } catch (e) {
        const tries = (item.tries || 0) + 1;
        await col('queue').updateOne({ _id: item._id }, { $set: { tries, status: tries >= 5 ? 'failed' : 'pending' } });
        logErr(`send ${item.channel}`, e);
        stats.lastSend = Date.now(); // back off one gap
      }
      if (pending.length > 1) kick(cfg.MIN_GAP_SECONDS * 1000 + 50); // next one right after the gap
      return; // one message per gap
    }
  } finally {
    sending = false;
  }
}

const enqueue = (channel, text, kind) => col('queue').insertOne({ channel, text, kind, status: 'pending', createdAt: new Date() });
const LABEL = { vacancy: '🆕', admit: '🎫', result: '🏆', answerkey: '🔑', examdate: '🗓️', syllabus: '📚' };

// ---- 3. morning digest (yesterday's updates, per channel) ----
async function digest() {
  const since = new Date(Date.now() - 24 * 3600e3);
  for (const ch of cfg.CHANNELS) {
    const items = await col('posts').find({ channel: ch.key, createdAt: { $gte: since } }).sort({ createdAt: 1 }).toArray();
    const open = await col('posts').find({ channel: ch.key, type: 'vacancy', lastDate: { $gte: new Date() } }).sort({ lastDate: 1 }).limit(5).toArray();
    if (!items.length && !open.length) continue;
    let t = `☀️ *सुप्रभात! आज का Job Digest*\n📅 ${fmtDate(new Date())}\n━━━━━━━━━━━━━━\n`;
    if (items.length) t += `*पिछले 24 घंटे के अपडेट (${items.length}):*\n` + items.map((p, i) => `${i + 1}. ${LABEL[p.type] || '▫️'} ${p.title}`).join('\n') + '\n\n';
    if (open.length) t += `*⏳ जल्द बंद होने वाले फॉर्म:*\n` + open.map((p) => `▫️ ${p.title} – *${fmtDate(p.lastDate)}*`).join('\n') + '\n\n';
    t += `👆 पूरी जानकारी ऊपर के पोस्ट में।\n${footer(ch.key)}`;
    await enqueue(ch.key, t, 'digest');
  }
}

// ---- 4. last-date reminders (3 days and 1 day before) ----
async function reminders() {
  const now = new Date();
  for (const ch of cfg.CHANNELS) {
    const lines = [];
    for (const days of cfg.REMINDER_DAYS) {
      const from = new Date(now.getTime() + (days - 1) * 86400e3 + 1);
      const to = new Date(now.getTime() + days * 86400e3);
      const due = await col('posts').find({ channel: ch.key, lastDate: { $gt: from, $lte: to }, reminded: { $ne: days } }).toArray();
      for (const p of due) {
        lines.push(`${days === 1 ? '🔴' : '🟠'} ${p.title}\n    अंतिम तिथि: *${fmtDate(p.lastDate)}* (${days === 1 ? 'कल!' : `${days} दिन बाकी`})`);
        await col('posts').updateOne({ _id: p._id }, { $push: { reminded: days } });
      }
    }
    if (lines.length) {
      await enqueue(ch.key, `⏰ *LAST DATE REMINDER | अंतिम तिथि नज़दीक*\n━━━━━━━━━━━━━━\n${lines.join('\n\n')}\n\n✍️ अभी आवेदन करें, आखिरी दिन साइट धीमी चलती है।\n${footer(ch.key)}`, 'reminder');
    }
  }
}

// ---- 5. Sunday weekly roundup ----
async function weekly() {
  const since = new Date(Date.now() - 7 * 86400e3);
  for (const ch of cfg.CHANNELS) {
    const items = await col('posts').find({ channel: ch.key, createdAt: { $gte: since } }).toArray();
    if (!items.length) continue;
    const by = (t) => items.filter((p) => p.type === t);
    const sec = (title, arr) => (arr.length ? `*${title} (${arr.length})*\n` + arr.slice(0, 8).map((p) => `▫️ ${p.title}`).join('\n') + '\n\n' : '');
    const t = `📊 *इस हफ्ते का Roundup*\n━━━━━━━━━━━━━━\n` +
      sec('🆕 नई भर्ती', by('vacancy')) + sec('🎫 एडमिट कार्ड', by('admit')) + sec('🏆 रिजल्ट', by('result')) +
      sec('🔑 आंसर की', by('answerkey')) + sec('🗓️ परीक्षा तिथि', by('examdate')) +
      `📢 दोस्तों से शेयर करें, जिससे किसी का फॉर्म न छूटे।\n${footer(ch.key)}`;
    await enqueue(ch.key, t, 'weekly');
  }
}

// ---- 6. one-time welcome post per channel (sent once, first time the bot is live) ----
const EXAMS = {
  ssc: 'SSC GD, CGL, CHSL, MTS, CPO',
  railway: 'RRB NTPC, Group D, ALP, JE, RPF',
  bihar: 'BPSC, BSSC, Bihar Police, Daroga, Teacher',
  army: 'Agniveer Army, Navy, Airforce, TA Rally',
};
async function welcome() {
  for (const ch of cfg.CHANNELS) {
    if (await getKV(`welcome:${ch.key}`)) continue;
    const t = `🙏 *स्वागत है | Welcome!*\n━━━━━━━━━━━━━━\n📢 *${ch.name} Job Notification* channel में आपका स्वागत है।\n\n` +
      `यहाँ आपको मिलेगा, सबसे पहले:\n🆕 नई भर्ती (${EXAMS[ch.key]})\n🎫 एडमिट कार्ड\n🏆 रिजल्ट\n🔑 आंसर की\n🗓️ परीक्षा तिथि\n\n` +
      `☀️ हर सुबह 8 बजे दिन का Job Digest\n⏰ फॉर्म की Last Date से पहले Reminder\n📊 हर रविवार Weekly Roundup\n\n` +
      `✅ सिर्फ ऑफिशियल जानकारी, कोई फालतू मैसेज नहीं।\n📲 दोस्तों के साथ शेयर करें, किसी का फॉर्म न छूटे।\n${footer(ch.key)}`;
    await enqueue(ch.key, t, 'welcome');
    kick();
    await setKV(`welcome:${ch.key}`, true);
  }
}

// ---- free-tier housekeeping + DB size guard ----
async function housekeeping() {
  await db.prune();
  const mb = await db.dbSizeMB(true);
  if (mb > cfg.DB_ALERT_MB && !(await getKV('dbAlerted'))) {
    if (await alertSelf('db', `MongoDB data ${mb} MB (free limit 512 MB). Purana data TTL se khud hat raha hai; zarurat ho to /backup lekar /clearqueue karein.`)) await setKV('dbAlerted', true);
  } else if (mb < cfg.DB_ALERT_MB * 0.8) await setKV('dbAlerted', false);
}

// ---- scheduler: runs every minute, fires each job once per slot ----
async function onceFor(slot, fn) {
  if ((await getKV(`ran:${slot}`)) ) return;
  await setKV(`ran:${slot}`, true);
  await fn();
}
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = ist();
    const h = now.getUTCHours(), day = istDayKey();
    if (!stats.lastPoll || Date.now() - stats.lastPoll >= cfg.POLL_MINUTES * 60e3 - 5e3) await poll();
    if (Date.now() >= stats.nextOfficialAt) await pollOfficial();
    if (h === cfg.DIGEST_HOUR) await onceFor(`digest:${day}`, digest);
    if (h === cfg.REMINDER_HOUR) await onceFor(`remind:${day}`, reminders);
    if (now.getUTCDay() === cfg.WEEKLY_DAY && h === cfg.WEEKLY_HOUR) await onceFor(`weekly:${day}`, weekly);
    if (h === 3) await onceFor(`housekeeping:${day}`, housekeeping);
    if (wa.state.ready) await welcome();
    await sendNext();
  } catch (e) {
    logErr('tick', e);
  } finally {
    ticking = false;
  }
}

async function healthReport() {
  const [paused, queueLength, lastPostAt, dbSizeMB, list] = await Promise.all([
    getKV('paused', false), col('queue').countDocuments({ status: 'pending' }), getKV('lastPostAt'), db.dbSizeMB().catch(() => null), health.list(),
  ]);
  const sources = list.map((s) => ({ name: s._id, lastSuccessAt: s.lastSuccessAt || null, consecutiveFails: s.consecutiveFails || 0 }));
  return {
    ok: !!wa.state.ready && !paused && sources.every((s) => s.consecutiveFails < cfg.ALERT_AFTER_FAILS),
    waConnected: !!wa.state.ready, paused, lastPostAt, queueLength, dbSizeMB, sources,
    lastError: stats.errors[0] ? health.clean(stats.errors[0].replace(/^\S+\s/, '')) : null,
  };
}

// ---- owner commands (typed in the bot number's own "Message yourself" chat) ----
async function command(text) {
  const [cmd, ...rest] = text.split(' ');
  const arg = rest.join(' ');
  switch (cmd.toLowerCase()) {
    case '/status': {
      const pend = await col('queue').countDocuments({ status: 'pending' });
      const today = await col('queue').countDocuments({ status: 'sent', sentAt: { $gte: new Date(Date.now() - 86400e3) } });
      const hs = await health.list();
      const t = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: cfg.TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
      const src = hs.map((x) => `${(x.consecutiveFails || 0) >= cfg.ALERT_AFTER_FAILS ? '🔴' : x.consecutiveFails ? '🟠' : '🟢'} ${x._id} | ok ${t(x.lastSuccessAt)} | fail x${x.consecutiveFails || 0}`).join('\n');
      return `✅ Bot chal raha hai\nPaused: ${(await getKV('paused', false)) ? 'haan' : 'nahi'}\nQueue: ${pend}\nPichhle 24 ghante mein post: ${today}\nTelegram check: ${t(stats.lastPoll)} (har ${cfg.POLL_MINUTES} min)\nOfficial check: ${t(stats.lastOfficialPoll)} (har ${cfg.OFFICIAL_POLL_MINUTES} min)\nQuiet: ${isQuiet() ? 'haan' : 'nahi'}\nDB: ${await db.dbSizeMB().catch(() => '?')} MB / 512 MB\n\n*Sources:*\n${src || '-'}`;
    }
    case '/pause': await setKV('paused', true); return '⏸️ Posting ruk gayi. /resume se chalu karein.';
    case '/resume': await setKV('paused', false); return '▶️ Posting chalu.';
    case '/check': await poll(); await pollOfficial(); return '🔄 Telegram + official sites check ho gaye.';
    case '/digest': await digest(); return '☀️ Digest queue mein.';
    case '/remind': await reminders(); return '⏰ Reminders queue mein.';
    case '/clearqueue': { const r = await col('queue').deleteMany({ status: 'pending' }); return `🗑️ ${r.deletedCount} hata diye.`; }
    case '/post': { // /post ssc Your message
      const [key, ...msg] = arg.split(' ');
      if (!cfg.CHANNELS.find((c) => c.key === key) || !msg.length) return 'Format: /post ssc|railway|bihar|army <message>';
      await enqueue(key, msg.join(' '), 'manual');
      return '📝 Queue mein daal diya.';
    }
    case '/errors': return stats.errors.length ? stats.errors.slice(0, 15).join('\n') : 'Koi error nahi.';
    default:
      return 'Commands: /status /pause /resume /check /digest /remind /post <channel> <msg> /clearqueue /errors';
  }
}

module.exports = { tick, command, stats, isQuiet, poll, pollOfficial, healthReport, sendNext, kick, isDuplicate, similar };
