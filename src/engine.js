// The brain: polls Telegram (fast) + official sites (backup), dedups, queues posts, sends with anti-spam rules,
// digests, reminders, health tracking, owner commands.
const cfg = require('./config');
const db = require('./db');
const { col, getKV, setKV } = db;
const { fetchPosts } = require('./telegram');
const { readSource, classifyOfficial, resetCache } = require('./official');
const tp = require('./thirdparty');
const { buildCard, buildOfficialCard, renderCard, footer, fmtDate, normTitle, hashTitle, parseDate } = require('./format');
const health = require('./health');
const wa = require('./whatsapp');
const quiz = require('./quiz');

// ---- time helpers (IST) ----
const ist = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3); // shifted clock, read with getUTC*
const istHour = () => ist().getUTCHours();
const istDayKey = (d = new Date()) => ist(d).toISOString().slice(0, 10);
const isQuiet = () => {
  const h = istHour();
  return cfg.QUIET_START > cfg.QUIET_END ? h >= cfg.QUIET_START || h < cfg.QUIET_END : h >= cfg.QUIET_START && h < cfg.QUIET_END;
};

const stats = { lastPoll: null, lastOfficialPoll: null, nextOfficialAt: 0, lastThirdPartyPoll: null, nextThirdPartyAt: 0, tpRound: 0, lastSend: null, errors: [] };
const logErr = (where, e) => {
  const msg = health.clean(health.describe(e));
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
    const sent = await alertSelf(name, `Source *${name}* ${cfg.ALERT_AFTER_FAILS}+ baar lagatar fail.\nError: ${health.clean(health.describe(e))}\nBaaki sources chal rahe hain. /status dekhein.`);
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
// only specific links (PDF / deep page) identify a job; a portal home or login page is shared by many jobs
function specificLinks(links) {
  return (links || []).filter((u) => {
    try {
      const x = new URL(u);
      const path = x.pathname.replace(/\/+$/, '');
      return /\.pdf/i.test(path) || path.split('/').filter(Boolean).length >= 2 || path.length > 25 || /[?&](id|nid|notice|file)=/i.test(x.search);
    } catch { return false; }
  });
}
async function isDuplicate(card, channel) {
  const or = [{ _id: card.hash }];
  const links = specificLinks(card.links);
  if (links.length) or.push({ links: { $in: links } });
  if (await col('dedup').findOne({ $or: or }, { projection: { _id: 1 } })) return true;
  const recent = await col('posts').find({ channel, type: card.type, createdAt: { $gte: new Date(Date.now() - 5 * 86400e3) } }).project({ title: 1 }).toArray();
  return recent.some((p) => similar(p.title, card.title));
}
async function record(card, channel, extra) {
  await col('posts').insertOne({ hash: card.hash, channel, type: card.type, title: card.title, lastDate: card.lastDate, links: card.links, createdAt: new Date(), reminded: [], ...extra });
  await col('dedup').updateOne({ _id: card.hash }, { $set: { links: specificLinks(card.links), at: new Date() } }, { upsert: true });
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
  if (!cfg.TELEGRAM_ENABLED) { stats.lastPoll = new Date(); return; } // optional, secondary source
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

// ---- 1c. third-party listing sites: DETECTION only (every THIRDPARTY_POLL_MINUTES + jitter) ----
// New listing item -> keyword classify (channel + type) -> skip junk / duplicates BEFORE any detail fetch
// -> fetch detail page (capped per round) -> facts + official links -> our own card -> same dedup as others.
const AGG_TEXT = /freejobalert|sarkari ?result|sarkari ?exam|sarkarinaukri|rojgar ?result/i;
async function markSeen(id) {
  await col('seen').updateOne({ _id: id }, { $setOnInsert: { at: new Date() } }, { upsert: true });
}
async function pollThirdParty() {
  if (!cfg.THIRDPARTY_ENABLED) return;
  let budget = cfg.TP_MAX_DETAIL_PER_ROUND;
  const result = {};
  const n = cfg.THIRDPARTY_SOURCES.length;
  const start = n ? stats.tpRound++ % n : 0; // rotate the start so no site starves of the detail-fetch budget
  const order = cfg.THIRDPARTY_SOURCES.slice(start).concat(cfg.THIRDPARTY_SOURCES.slice(0, start));
  for (const src of order) {
    const name = `web:${src.id}`;
    const r = (result[src.id] = { items: 0, fresh: 0, relevant: 0, posted: 0, skipped: 0, why: {} });
    const skip = (why) => { r.skipped++; r.why[why] = (r.why[why] || 0) + 1; };
    try {
      const seeded = await getKV(`seeded:${src.id}`);
      if (!seeded) await tp.resetCache(src.url);
      const page = await tp.get(src.url);
      if (page.notModified) { await health.ok(name); r.notModified = true; continue; }
      const items = src.kind === 'fja' ? tp.readFjaListing(src, page.body) : tp.readHomeListing(src, page.body);
      r.items = items.length;
      if (!items.length) throw new Error('no items found in listing (layout changed?)');
      if (!seeded) { // first run: everything that is already listed counts as seen, nothing is posted
        for (const it of items) await markSeen(`tp:${it.uid}`);
        await setKV(`seeded:${src.id}`, true);
        await health.ok(name);
        r.seeded = true;
        continue;
      }
      let detailsLeft = cfg.TP_MAX_DETAIL_PER_SOURCE;
      const maxAge = Date.now() - cfg.TP_MAX_AGE_DAYS * 86400e3;
      for (const it of items) {
        const sid = `tp:${it.uid}`;
        if (await col('seen').findOne({ _id: sid }, { projection: { _id: 1 } })) continue;
        r.fresh++;
        const cls = tp.classifyItem(it.rawTitle, src.hint, !!it.main);
        if (!cls || (it.date && it.date.getTime() < maxAge)) { await markSeen(sid); skip(cls ? 'old' : 'irrelevant'); continue; } // irrelevant / old
        r.relevant++;
        // cheap duplicate check on the title before spending a detail fetch
        const pre = tp.ownTitle(it.rawTitle, cls.type);
        if (await isDuplicate({ hash: hashTitle(pre), links: [], type: cls.type, title: pre }, cls.channel)) { await markSeen(sid); skip('duplicate'); continue; }
        if (detailsLeft <= 0 || budget <= 0) continue; // left unseen -> handled next round
        detailsLeft--; budget--;
        let detail = null;
        try {
          detail = tp.parseDetail((await tp.get(it.link, { conditional: false })).body);
        } catch (e) {
          logErr(`${name} detail`, e); // listing facts alone are still useful; fall through
        }
        await new Promise((res) => setTimeout(res, 1200)); // polite gap
        const data = tp.buildData(it, cls, detail, src);
        if (cls.type === 'vacancy') {
          const last = data.facts.last ? parseDate(data.facts.last) : null;
          if (last && last.getTime() < Date.now() - 86400e3) { await markSeen(sid); skip('closed'); continue; } // already closed
          const n = Number(String(data.facts.posts || '').replace(/,/g, ''));
          if (n && n < 5 && !tp.CORE.test(`${it.rawTitle} ${data.org || ''}`)) { await markSeen(sid); skip('tiny'); continue; } // tiny local hiring
        }
        if (!data.links.length && !data.home) { await markSeen(sid); skip('no-official-link'); continue; } // no official link and unknown body -> never post
        const text = renderCard(data, cls.channel);
        if (AGG_TEXT.test(text)) { await markSeen(sid); skip('aggregator-text'); logErr(name, new Error('card mentioned a listing site, dropped')); continue; }
        const card = { type: cls.type, title: data.title, lastDate: data.facts.last ? parseDate(data.facts.last) : null, links: data.links.map((l) => l.url), text, hash: hashTitle(data.title) };
        if (await accept(card, cls.channel, { src: name })) r.posted++; else skip('duplicate');
        await markSeen(sid);
      }
      await health.ok(name);
    } catch (e) {
      r.error = health.clean(health.describe(e));
      await sourceFailed(name, e);
    }
    await new Promise((res) => setTimeout(res, 1500)); // polite gap between sites
  }
  stats.lastThirdPartyPoll = new Date();
  stats.nextThirdPartyAt = Date.now() + cfg.THIRDPARTY_POLL_MINUTES * 60e3 + Math.floor(Math.random() * 120e3);
  return result;
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
    // job posts first; our own quizzes only go out when no job post is waiting for that channel
    const jobs = await col('queue').find({ status: 'pending', kind: { $ne: 'quiz' } }).sort({ createdAt: 1 }).limit(20).toArray();
    const quizzes = await col('queue').find({ status: 'pending', kind: 'quiz' }).sort({ createdAt: 1 }).limit(8).toArray();
    const pending = jobs.concat(quizzes);
    for (const item of pending) {
      if (item.kind === 'quiz') {
        if (jobs.some((j) => j.channel === item.channel)) continue; // job waiting in this channel -> it goes first
        if (await quiz.isOff()) { await col('queue').updateOne({ _id: item._id }, { $set: { status: 'skipped' } }); continue; }
        if (Date.now() - new Date(item.createdAt).getTime() > quiz.QUIZ_EXPIRE_MS()) { await col('queue').updateOne({ _id: item._id }, { $set: { status: 'expired' } }); continue; }
      }
      const sentLastHour = await col('queue').countDocuments({ channel: item.channel, status: 'sent', sentAt: { $gte: hourAgo } });
      if (sentLastHour >= cfg.MAX_POSTS_PER_HOUR) continue;
      try {
        if (item.kind === 'quiz') {
          const q = quiz.bank(item.channel).find((x) => x.id === item.qid);
          if (!q) { await col('queue').updateOne({ _id: item._id }, { $set: { status: 'failed' } }); continue; }
          const r = await wa.sendQuiz(item.channel, quiz.encodeQuizMessage(quiz.buildPoll(q, item.channel)));
          await col('queue').updateOne({ _id: item._id }, { $set: { status: 'sent', sentAt: new Date(), serverId: r.serverId, acked: r.acked } });
          await quiz.recordResult(true, { channel: item.channel, ...r });
        } else {
          await wa.sendToChannel(item.channel, item.text);
          await col('queue').updateOne({ _id: item._id }, { $set: { status: 'sent', sentAt: new Date() } });
          await setKV('lastPostAt', new Date());
        }
        stats.lastSend = Date.now();
      } catch (e) {
        logErr(`send ${item.kind === 'quiz' ? 'quiz ' : ''}${item.channel}`, e);
        stats.lastSend = Date.now(); // back off one gap
        if (item.kind === 'quiz') {
          // a rejected quiz is never retried (no spam); connection errors get 2 more tries
          const rejected = /rejected|BLOCKED|quiz:/.test(e.message || '');
          const tries = (item.tries || 0) + 1;
          await col('queue').updateOne({ _id: item._id }, { $set: { tries, status: rejected || tries >= 3 ? 'failed' : 'pending' } });
          if (rejected) {
            const st = await quiz.recordResult(false, { channel: item.channel, error: health.clean(e.message) });
            if (st.fails >= cfg.QUIZ_AUTO_OFF_AFTER && !(await getKV('quizOff', false))) {
              await setKV('quizOff', true); await setKV('quizAutoOff', true);
              await alertSelf('quiz', `WhatsApp ne ${st.fails} quiz lagatar reject kiye, quiz auto-OFF kar diya.\nError: ${health.clean(e.message)}\nJob posting normal chal rahi hai. Dobara try: /quiz on`);
            }
          }
        } else {
          const tries = (item.tries || 0) + 1;
          await col('queue').updateOne({ _id: item._id }, { $set: { tries, status: tries >= 5 ? 'failed' : 'pending' } });
        }
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
    if (Date.now() >= stats.nextThirdPartyAt) await pollThirdParty();
    if (h === cfg.DIGEST_HOUR) await onceFor(`digest:${day}`, digest);
    if (h === cfg.REMINDER_HOUR) await onceFor(`remind:${day}`, reminders);
    if (now.getUTCDay() === cfg.WEEKLY_DAY && h === cfg.WEEKLY_HOUR) await onceFor(`weekly:${day}`, weekly);
    if (h === 3) await onceFor(`housekeeping:${day}`, housekeeping);
    if (cfg.QUIZ_HOURS.includes(h) && !isQuiet() && !(await quiz.isOff())) await onceFor(`quiz:${day}:${h}`, () => quiz.enqueueQuiz());
    if (wa.state.ready) await welcome();
    await sendNext();
  } catch (e) {
    logErr('tick', e);
  } finally {
    ticking = false;
  }
}

async function healthReport() {
  const [paused, queueLength, lastPostAt, dbSizeMB, list, qs] = await Promise.all([
    getKV('paused', false), col('queue').countDocuments({ status: 'pending' }), getKV('lastPostAt'), db.dbSizeMB().catch(() => null), health.list(),
    quiz.status().catch(() => null),
  ]);
  const sources = list.map((s) => ({ name: s._id, lastSuccessAt: s.lastSuccessAt || null, consecutiveFails: s.consecutiveFails || 0, lastError: s.consecutiveFails ? s.lastError || null : null }));
  // Telegram is optional/secondary: a channel is healthy when ANY of its non-Telegram sources works
  const healthy = (s) => s.consecutiveFails < cfg.ALERT_AFTER_FAILS && s.lastSuccessAt;
  const tpOk = sources.filter((s) => s.name.startsWith('web:')).some(healthy);
  const offOk = sources.filter((s) => s.name.startsWith('official:')).some(healthy);
  return {
    ok: !!wa.state.ready && !paused && (tpOk || offOk || !sources.length),
    sourcesOk: sources.filter((s) => !s.name.startsWith('telegram:')).every((s) => s.consecutiveFails < cfg.ALERT_AFTER_FAILS),
    waConnected: !!wa.state.ready, paused, lastPostAt, queueLength, dbSizeMB, sources,
    quiz: qs && { enabled: qs.enabled, hoursIST: qs.hoursIST, sent24h: qs.sent24h, lastSentAt: qs.lastSentAt, consecutiveFails: qs.consecutiveFails, lastError: qs.lastError },
    lastError: stats.errors[0] ? health.clean(stats.errors[0].replace(/^\S+\s/, '')) : null,
  };
}

// ---- quiz: status line + owner commands ----
async function quizLine() {
  const q = await quiz.status().catch(() => null);
  if (!q) return 'Quiz: ?';
  const t = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: cfg.TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
  return `Quiz: ${q.enabled ? 'ON' : q.autoDisabled ? 'OFF (auto, WhatsApp ne reject kiya)' : 'OFF'} | ${q.hoursIST.map((h) => `${h}:00`).join(', ')} IST | 24h: ${q.sent24h} | last: ${t(q.lastSentAt)} ${q.lastChannel || ''}${q.consecutiveFails ? ` | fail x${q.consecutiveFails}: ${q.lastError}` : ''}\nQuiz bank (used/total): ${q.banks.map((b) => `${b.channel} ${b.used}/${b.bank}`).join(', ')}`;
}
async function quizCommand(arg) {
  const [sub, key] = arg.split(/\s+/);
  const keys = cfg.CHANNELS.map((c) => c.key);
  if (sub === 'off') { await setKV('quizOff', true); return '⏸️ Quiz band. Job posts normal chalenge. /quiz on se chalu.'; }
  if (sub === 'on') {
    if (!cfg.QUIZ_ENABLED) return 'Quiz server setting (QUIZ_ENABLED) se band hai.';
    await setKV('quizOff', false); await setKV('quizAutoOff', false);
    const st = (await getKV('quizState')) || {}; st.fails = 0; await setKV('quizState', st);
    return `▶️ Quiz chalu: roz ${cfg.QUIZ_HOURS.map((h) => `${h}:00`).join(' & ')} IST.`;
  }
  if (sub === 'now') {
    if (await quiz.isOff()) return 'Quiz abhi OFF hai. Pehle /quiz on.';
    const list = key === 'all' ? keys : keys.includes(key) ? [key] : null;
    if (!list) return 'Format: /quiz now ssc|railway|bihar|army|all';
    const q = await quiz.enqueueQuiz(list, 'manual');
    kick();
    return `🧠 Quiz queue mein (${q.join(', ')}). Job posts pehle jayenge; quiet hours (${cfg.QUIET_START}:00-${cfg.QUIET_END}:00) mein subah jayega.`;
  }
  if (sub === 'verify') { // read back the newest quiz WhatsApp stored in our channel
    if (!keys.includes(key)) return 'Format: /quiz verify ssc|railway|bihar|army';
    const posts = await wa.fetchChannelPosts(key, 10);
    const found = posts.map((p) => ({ p, q: p.bytes ? quiz.decodeQuizMessage(p.bytes) : null })).filter((x) => x.q).pop();
    if (!found) return `Channel ${key}: pichhle ${posts.length} posts mein koi quiz nahi mila.`;
    const { p, q } = found;
    return `✅ ${key} quiz server_id ${p.serverId}: pollType=${q.pollType === 1 ? 'QUIZ' : q.pollType}, correct answer set: ${q.correct ? 'haan' : 'NAHI'}, options ${q.options.length}\n${q.name.split('\n').slice(0, 3).join(' ')}`;
  }
  return quizLine();
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
      const src = hs.map((x) => `${(x.consecutiveFails || 0) >= cfg.ALERT_AFTER_FAILS ? '🔴' : x.consecutiveFails ? '🟠' : '🟢'} ${x._id} | ok ${t(x.lastSuccessAt)} | fail x${x.consecutiveFails || 0}${x.consecutiveFails && x.lastError ? ` | ${x.lastError}` : ''}`).join('\n');
      return `✅ Bot chal raha hai\nPaused: ${(await getKV('paused', false)) ? 'haan' : 'nahi'}\nQueue: ${pend}\nPichhle 24 ghante mein post: ${today}\nTelegram check: ${t(stats.lastPoll)} (har ${cfg.POLL_MINUTES} min)\nOfficial check: ${t(stats.lastOfficialPoll)} (har ${cfg.OFFICIAL_POLL_MINUTES} min)\nWeb sources check: ${cfg.THIRDPARTY_ENABLED ? `${t(stats.lastThirdPartyPoll)} (har ${cfg.THIRDPARTY_POLL_MINUTES} min)` : 'off'}\nTelegram: ${cfg.TELEGRAM_ENABLED ? 'on (optional)' : 'off'}\nQuiet: ${isQuiet() ? 'haan' : 'nahi'}\n${await quizLine()}\nDB: ${await db.dbSizeMB().catch(() => '?')} MB / 512 MB\n\n*Sources:*\n${src || '-'}`;
    }
    case '/pause': await setKV('paused', true); return '⏸️ Posting ruk gayi. /resume se chalu karein.';
    case '/resume': await setKV('paused', false); return '▶️ Posting chalu.';
    case '/check': await poll(); await pollOfficial(); await pollThirdParty(); return '🔄 Telegram + official + web sources check ho gaye.';
    case '/digest': await digest(); return '☀️ Digest queue mein.';
    case '/remind': await reminders(); return '⏰ Reminders queue mein.';
    case '/clearqueue': { const r = await col('queue').deleteMany({ status: 'pending' }); return `🗑️ ${r.deletedCount} hata diye.`; }
    case '/post': { // /post ssc Your message
      const [key, ...msg] = arg.split(' ');
      if (!cfg.CHANNELS.find((c) => c.key === key) || !msg.length) return 'Format: /post ssc|railway|bihar|army <message>';
      await enqueue(key, msg.join(' '), 'manual');
      return '📝 Queue mein daal diya.';
    }
    case '/quiz': return quizCommand(arg.trim().toLowerCase());
    case '/errors': return stats.errors.length ? stats.errors.slice(0, 15).join('\n') : 'Koi error nahi.';
    default:
      return 'Commands: /status /pause /resume /check /digest /remind /post <channel> <msg> /clearqueue /errors /quiz [on|off|now <channel|all>|verify <channel>]';
  }
}

module.exports = { quizCommand, tick, command, stats, isQuiet, poll, pollOfficial, pollThirdParty, healthReport, sendNext, kick, isDuplicate, similar, specificLinks };
