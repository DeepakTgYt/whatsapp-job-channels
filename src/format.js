// Turns a Telegram job post into a clean, short WhatsApp Channel card.
const crypto = require('crypto');
const cfg = require('./config');

const MONTHS = {
  jan: 0, january: 0, जनवरी: 0, feb: 1, february: 1, फरवरी: 1, mar: 2, march: 2, मार्च: 2,
  apr: 3, april: 3, अप्रैल: 3, may: 4, मई: 4, jun: 5, june: 5, जून: 5, jul: 6, july: 6, जुलाई: 6,
  aug: 7, august: 7, अगस्त: 7, sep: 8, sept: 8, september: 8, सितंबर: 8, सितम्बर: 8,
  oct: 9, october: 9, अक्टूबर: 9, nov: 10, november: 10, नवंबर: 10, नवम्बर: 10,
  dec: 11, december: 11, दिसंबर: 11, दिसम्बर: 11,
};

function parseDate(str) {
  const m = str.match(/(\d{1,2})[\s\-\/.]*([A-Za-z\u0900-\u097F]+)[\s,\-\/.]*(\d{4})/);
  if (m && MONTHS[m[2].toLowerCase()] !== undefined) {
    return new Date(Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], 12) - 5.5 * 3600e3);
  }
  const n = str.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (n) return new Date(Date.UTC(+n[3], +n[2] - 1, +n[1], 12) - 5.5 * 3600e3);
  return null;
}

function classify(text) {
  const firstLines = text.split('\n').slice(0, 2).join(' ');
  if (cfg.QUIZ_BLOCK.test(firstLines)) return null; // never quiz
  for (const mk of cfg.JOB_MARKERS) if (mk.re.test(firstLines)) return mk;
  return null;
}

function extract(text) {
  const lines = text.split('\n');
  const titleLine = lines.find((l) => l.includes('📌')) || lines[2] || '';
  const title = titleLine.replace('📌', '').replace(/\*/g, '').replace(/https?:\/\/(www\.)?([^\/\s]+)\S*/g, '$2').trim();
  // last date: line that mentions Last Date / अंतिम तिथि
  let lastDate = null;
  for (const l of lines) {
    if (/last date|अंतिम तिथि|आखिरी तारीख/i.test(l)) {
      const d = parseDate(l.replace(/\*/g, ''));
      if (d && (!lastDate || d > lastDate)) lastDate = d;
    }
  }
  const links = [...text.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0]).filter((u) => !/t\.me\//.test(u));
  return { title, lastDate, links };
}

// cuts the Telegram footer (join links / bot / hashtags) and rebuilds the body for WhatsApp
function body(text) {
  let lines = text.split('\n');
  // drop the first header line + divider, we write our own header
  if (/━/.test(lines[1] || '')) lines = lines.slice(2);
  else lines = lines.slice(1);
  const out = [];
  for (const l of lines) {
    if (/━━━/.test(l)) break; // start of Telegram footer
    if (/^#\w/.test(l.trim())) continue; // hashtags
    if (/Source:/i.test(l)) continue; // no third-party promo
    if (/t\.me\/|@JobNotificationQuiz_bot|Sawal-Jawab|Ask about this/i.test(l)) continue;
    out.push(l);
  }
  let s = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > 1800) s = s.slice(0, 1800).replace(/\n[^\n]*$/, '') + '\n…';
  return s;
}

function footer(channelKey) {
  const me = cfg.CHANNELS.find((c) => c.key === channelKey);
  const others = cfg.CHANNELS.filter((c) => c.key !== channelKey)
    .map((c) => `▫️ ${c.name}: https://whatsapp.com/channel/${c.waInvite}`)
    .join('\n');
  return `━━━━━━━━━━━━━━\n📲 *Aur channels follow karein:*\n${others}\n✈️ Telegram: https://t.me/${me.telegram}\n🔔 Bell 🔔 dabayein taaki koi update miss na ho.`;
}

function buildCard(post, channel) {
  const mk = classify(post.text);
  if (!mk) return null;
  const info = extract(post.text);
  if (!info.title) return null;
  const text = `${mk.head}\n━━━━━━━━━━━━━━\n${body(post.text)}\n\n${channel.tags}\n${footer(channel.key)}`;
  const hash = crypto.createHash('sha1').update(info.title.toLowerCase().replace(/[^a-z0-9\u0900-\u097f]/g, '')).digest('hex');
  return { type: mk.type, title: info.title, lastDate: info.lastDate, links: info.links, text, hash };
}

const fmtDate = (d) =>
  d.toLocaleDateString('hi-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: cfg.TZ });

module.exports = { buildCard, classify, extract, parseDate, footer, fmtDate };
