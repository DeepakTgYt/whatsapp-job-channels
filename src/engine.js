// The brain: polls Telegram, queues posts, sends with anti-spam rules, digests, reminders, commands.
const cfg = require('./config');
const { col, getKV, setKV } = require('./db');
const { fetchPosts } = require('./telegram');
const { buildCard, footer, fmtDate } = require('./format');
const wa = require('./whatsapp');

// ---- time helpers (IST) ----
const ist = (d = new Date()) => new Date(d.getTime() + 5.5 * 3600e3); // shifted clock, read with getUTC*
const istHour = () => ist().getUTCHours();
const istDayKey = (d = new Date()) => ist(d).toISOString().slice(0, 10);
const isQuiet = () => {
  const h = istHour();
  return cfg.QUIET_START > cfg.QUIET_END ? h >= cfg.QUIET_START || h < cfg.QUIET_END : h >= cfg.QUIET_START && h < cfg.QUIET_END;
};

const stats = { lastPoll: null, lastSend: null, errors: [] };
const logErr = (where, e) => {
  console.error(where, e.message);
  stats.errors.unshift(`${new Date().toISOString()} ${where}: ${e.message}`);
  stats.errors.length = Math.min(stats.errors.length, 10);
};

// ---- 1. poll Telegram ----
async function poll() {
  for (const ch of cfg.CHANNELS) {
    try {
      const posts = await fetchPosts(ch.telegram);
      if (!posts.length) continue;
      const maxId = posts[posts.length - 1].id;
      const last = await getKV(`tg:${ch.key}`);
      if (last === null) {
        await setKV(`tg:${ch.key}`, maxId); // first run: don't flood old posts
        continue;
      }
      for (const p of posts.filter((p) => p.id > last)) {
        const card = buildCard(p, ch);
        if (!card) continue; // quiz / non-job post
        try {
          await col('posts').insertOne({
            hash: card.hash, channel: ch.key, tgId: p.id, type: card.type, title: card.title,
            lastDate: card.lastDate, createdAt: new Date(), reminded: [],
          });
        } catch (e) {
          if (e.code === 11000) continue; // duplicate title already posted
          throw e;
        }
        await col('queue').insertOne({ channel: ch.key, text: card.text, kind: 'post', status: 'pending', createdAt: new Date() });
      }
      await setKV(`tg:${ch.key}`, maxId);
    } catch (e) {
      logErr(`poll ${ch.key}`, e);
    }
  }
  stats.lastPoll = new Date();
}

// ---- 2. send queue with anti-spam ----
async function sendNext() {
  if (!wa.state.ready || isQuiet() || (await getKV('paused', false))) return;
  if (stats.lastSend && Date.now() - stats.lastSend < cfg.MIN_GAP_SECONDS * 1000) return;
  const hourAgo = new Date(Date.now() - 3600e3);
  const pending = await col('queue').find({ status: 'pending' }).sort({ createdAt: 1 }).limit(20).toArray();
  for (const item of pending) {
    const sentLastHour = await col('queue').countDocuments({ channel: item.channel, status: 'sent', sentAt: { $gte: hourAgo } });
    if (sentLastHour >= cfg.MAX_POSTS_PER_HOUR) continue;
    try {
      await wa.sendToChannel(item.channel, item.text);
      await col('queue').updateOne({ _id: item._id }, { $set: { status: 'sent', sentAt: new Date() } });
      stats.lastSend = Date.now();
    } catch (e) {
      const tries = (item.tries || 0) + 1;
      await col('queue').updateOne({ _id: item._id }, { $set: { tries, status: tries >= 5 ? 'failed' : 'pending' } });
      logErr(`send ${item.channel}`, e);
    }
    return; // one message per tick
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
    await setKV(`welcome:${ch.key}`, true);
  }
}

// ---- scheduler: runs every minute, fires each job once per slot ----
async function onceFor(slot, fn) {
  if ((await getKV(`ran:${slot}`)) ) return;
  await setKV(`ran:${slot}`, true);
  await fn();
}
async function tick() {
  try {
    const now = ist();
    const h = now.getUTCHours(), m = now.getUTCMinutes(), day = istDayKey();
    if (m % cfg.POLL_MINUTES === 0 || !stats.lastPoll) await poll();
    if (h === cfg.DIGEST_HOUR) await onceFor(`digest:${day}`, digest);
    if (h === cfg.REMINDER_HOUR) await onceFor(`remind:${day}`, reminders);
    if (now.getUTCDay() === cfg.WEEKLY_DAY && h === cfg.WEEKLY_HOUR) await onceFor(`weekly:${day}`, weekly);
    if (wa.state.ready) await welcome();
    await sendNext();
  } catch (e) {
    logErr('tick', e);
  }
}

// ---- owner commands (typed in the bot number's own "Message yourself" chat) ----
async function command(text) {
  const [cmd, ...rest] = text.split(' ');
  const arg = rest.join(' ');
  switch (cmd.toLowerCase()) {
    case '/status': {
      const pend = await col('queue').countDocuments({ status: 'pending' });
      const today = await col('queue').countDocuments({ status: 'sent', sentAt: { $gte: new Date(Date.now() - 86400e3) } });
      return `✅ Bot chal raha hai\nPaused: ${(await getKV('paused', false)) ? 'haan' : 'nahi'}\nQueue: ${pend}\nPichhle 24 ghante mein post: ${today}\nLast check: ${stats.lastPoll ? stats.lastPoll.toISOString() : '-'}\nQuiet: ${isQuiet() ? 'haan' : 'nahi'}`;
    }
    case '/pause': await setKV('paused', true); return '⏸️ Posting ruk gayi. /resume se chalu karein.';
    case '/resume': await setKV('paused', false); return '▶️ Posting chalu.';
    case '/check': await poll(); return '🔄 Telegram check ho gaya.';
    case '/digest': await digest(); return '☀️ Digest queue mein.';
    case '/remind': await reminders(); return '⏰ Reminders queue mein.';
    case '/clearqueue': { const r = await col('queue').deleteMany({ status: 'pending' }); return `🗑️ ${r.deletedCount} hata diye.`; }
    case '/post': { // /post ssc Your message
      const [key, ...msg] = arg.split(' ');
      if (!cfg.CHANNELS.find((c) => c.key === key) || !msg.length) return 'Format: /post ssc|railway|bihar|army <message>';
      await enqueue(key, msg.join(' '), 'manual');
      return '📝 Queue mein daal diya.';
    }
    case '/errors': return stats.errors.length ? stats.errors.join('\n') : 'Koi error nahi.';
    default:
      return 'Commands: /status /pause /resume /check /digest /remind /post <channel> <msg> /clearqueue /errors';
  }
}

module.exports = { tick, command, stats, isQuiet };
