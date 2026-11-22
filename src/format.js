// One professional card template for ALL posts (Telegram-derived and official).
// WhatsApp formatting: *bold*  _italic_  ```mono```  `inline`  > quote  - list. No buttons in channels -> clean text links.
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

const HEAD = {
  vacancy: '🆕 *NEW VACANCY | नई भर्ती*',
  admit: '🎫 *ADMIT CARD | एडमिट कार्ड*',
  result: '🏆 *RESULT | रिजल्ट*',
  answerkey: '🔑 *ANSWER KEY | आंसर की*',
  examdate: '🗓️ *EXAM DATE / SCHEDULE | परीक्षा तिथि*',
  syllabus: '📚 *SYLLABUS | सिलेबस*',
};

// ---- Telegram post -> type ----
function classify(text) {
  const firstLines = text.split('\n').slice(0, 2).join(' ');
  if (cfg.QUIZ_BLOCK.test(firstLines)) return null; // never quiz / PYQ / poll
  for (const mk of cfg.JOB_MARKERS) if (mk.re.test(firstLines)) return mk;
  return null;
}

const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const isOfficial = (u) => cfg.OFFICIAL_DOMAIN.test(host(u));
const stripMd = (s) => String(s || '').replace(/[*_~`]/g, '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const valueOf = (line) => stripMd(line.slice(line.indexOf(':') + 1)).replace(/^[\s:│|-]+/, '');

// ---- Telegram post -> structured data (title, facts, links) ----
function extract(text) {
  const lines = text.split('\n');
  const titleLine = lines.find((l) => l.includes('📌')) || lines[2] || '';
  const title = stripMd(titleLine.replace('📌', '').replace(/https?:\/\/(www\.)?([^\/\s]+)\S*/g, '$2'));
  const facts = {};
  let lastDate = null;
  const grab = (re, key, i) => {
    if (facts[key] || !re.test(lines[i])) return;
    const v = lines[i].includes(':') ? valueOf(lines[i]) : '';
    if (v) facts[key] = v;
    else if (lines[i + 1] && lines[i + 1].includes(':')) facts[key] = valueOf(lines[i + 1]);
  };
  for (let i = 2; i < lines.length; i++) { // lines 0-1 are the Telegram header
    const l = lines[i];
    if (/━━━/.test(l) && i > 3) break; // Telegram footer starts
    if (/Source:|t\.me\//i.test(l)) continue;
    grab(/Total Vacanc|कुल पद|Total Posts?|No\.? of Posts/i, 'posts', i);
    grab(/Start Date|आवेदन शुरू|Application Begin|Apply Start|Starting Date/i, 'start', i);
    grab(/Application Fee|आवेदन शुल्क|^\s*▫️?\s*Fee\b/i, 'fee', i);
    grab(/Age Limit|आयु सीमा/i, 'age', i);
    grab(/Notice Date|सूचना तिथि|🕒 Update/i, 'notice', i);
    if (/Exam Date|परीक्षा तिथि/i.test(l) && l.includes(':')) { // keep the latest exam-date line, with its paper/tier label
      const q = stripMd(l.slice(0, l.indexOf(':'))).replace(/^.*Exam Date/i, '').trim();
      facts.exam = valueOf(l).replace('🆕', '').trim() + (q ? ` (${q})` : '');
    }
    if (/last date|अंतिम तिथि|आखिरी तारीख/i.test(l)) {
      const d = parseDate(stripMd(l));
      if (d && (!lastDate || d > lastDate)) { lastDate = d; facts.last = valueOf(l).replace(/^.*Last Date:\s*/i, ''); }
    }
    if (/^🟢|^⏳/.test(l.trim()) && !facts.status) facts.status = stripMd(l).split('│')[0].trim();
  }
  if (facts.notice) facts.notice = facts.notice.replace(/^Notice Date:\s*/i, '');
  // links with their labels ("🌐 *Official Website:* https://...")
  const links = [];
  for (const l of lines) {
    if (/Source:/i.test(l)) continue;
    for (const m of l.matchAll(/https?:\/\/[^\s)]+/g)) {
      const url = m[0].replace(/[.,]+$/, '');
      if (/t\.me\//.test(url) || cfg.AGGREGATOR.test(url)) continue;
      const label = stripMd(l.slice(0, m.index)).replace(/[:\-–|→\s]+$/, '').replace(/^[^\p{L}\p{N}]+/u, '');
      links.push({ url, label });
    }
  }
  return { title, lastDate, links, facts };
}

// label every link; official ones first, then by usefulness
function labelLinks(links, type) {
  const out = [];
  const seen = new Set();
  for (const { url, label = '' } of links) {
    const k = url.replace(/\/$/, '');
    if (seen.has(k) || cfg.AGGREGATOR.test(url)) continue;
    seen.add(k);
    let lab, rank;
    const L = `${label} ${url}`;
    if (/login|candidate portal/i.test(url) && (type === 'result' || type === 'answerkey')) { lab = type === 'result' ? '🏆 Check Result (Login)' : '🔑 Check Answer Key (Login)'; rank = 1; }
    else if (/apply|registration|applicationIndex|login|form/i.test(L) && type !== 'admit') { lab = '✍️ Apply Online'; rank = 1; }
    else if (/admit|hall ?ticket|call letter/i.test(L) || (type === 'admit' && /applicationIndex|login/i.test(url))) { lab = '🎫 Download Admit Card'; rank = 1; }
    else if (/\.pdf($|\?|\/)/i.test(url) || /notification|advt|pdf/i.test(label)) {
      lab = { result: '🏆 Result PDF', answerkey: '🔑 Answer Key / Notice PDF', admit: '📄 Admit Card Notice PDF', examdate: '📄 Schedule Notice PDF', syllabus: '📚 Syllabus PDF' }[type] || '📄 Notification PDF';
      rank = 2;
    } else if (/official|website|home/i.test(label) || /^https?:\/\/[^/]+\/?$/.test(url)) { lab = '🌐 Official Website'; rank = 4; }
    else { lab = `🔗 ${cut(label || 'Notice Page', 30)}`; rank = 3; }
    out.push({ url, label: lab, rank: rank + (isOfficial(url) ? 0 : 10) });
  }
  return out.sort((a, b) => a.rank - b.rank).slice(0, 4);
}

function footer(channelKey) {
  const me = cfg.CHANNELS.find((c) => c.key === channelKey);
  const others = cfg.CHANNELS.filter((c) => c.key !== channelKey)
    .map((c) => `- ${c.name}: https://whatsapp.com/channel/${c.waInvite}`)
    .join('\n');
  return `━━━━━━━━━━━━━━\n📲 *Aur WhatsApp channels:*\n${others}\n✈️ Telegram: https://t.me/${me.telegram}\n🔔 _Bell icon dabayein, koi update miss na ho._`;
}

const fmtDate = (d) =>
  d.toLocaleDateString('hi-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: cfg.TZ });
const fmtShort = (d) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: cfg.TZ });

// ---- THE card ----
// data: { type, title, org, facts:{posts,start,last,fee,age,exam,notice,status}, links:[{url,label}], home, advt }
function renderCard(data, channelKey) {
  const ch = cfg.CHANNELS.find((c) => c.key === channelKey);
  const f = data.facts || {};
  const parts = [HEAD[data.type] || '📢 *UPDATE*', '━━━━━━━━━━━━━━', `*${cut(stripMd(data.title), 220)}*`];
  if (data.org) parts.push(`🏛️ _${data.org}_`);
  const advt = (data.title.match(/Advt\.?\s*No\.?\s*[-:]?\s*[\w/.-]+\d/i) || [])[0] || (data.advt ? `Advt No. ${cut(stripMd(data.advt), 40)}` : null);
  if (advt) parts.push(`🔖 \`${advt.replace(/\s+/g, ' ')}\``);
  const q = [];
  const add = (icon, k, v) => { if (v) q.push(`> ${icon} *${k}:* ${cut(stripMd(v), 90)}`); };
  add('👥', 'Post / Vacancy', f.posts);
  add('🟢', 'Start Date', f.start);
  add('⏳', 'Last Date', f.last);
  add('📝', 'Exam Date', data.type === 'examdate' || data.type === 'admit' ? f.exam : null);
  add('💳', 'Fee', f.fee);
  add('🎂', 'Age', f.age);
  add('🎓', 'Qualification', f.qual);
  add('🗓️', 'Notice Date', f.notice);
  if (q.length) parts.push('', ...q);
  if (f.status) parts.push('', `_${cut(stripMd(f.status), 80)}_`);
  let links = labelLinks(data.links || [], data.type);
  if (data.home && !links.some((l) => l.url.replace(/\/$/, '') === data.home.replace(/\/$/, ''))) {
    links.push({ url: data.home, label: '🌐 Official Website', rank: isOfficial(data.home) ? 4 : 14 });
    links = links.sort((a, b) => a.rank - b.rank).slice(0, 4);
  }
  if (links.length) parts.push('', '🔗 *Official Links*', ...links.map((l) => `- ${l.label}: ${l.url}`));
  parts.push('', '⚠️ _Apply se pehle official notification zaroor padhein._', `${ch.tags} #${data.type === 'vacancy' ? 'NewVacancy' : { admit: 'AdmitCard', result: 'Result', answerkey: 'AnswerKey', examdate: 'ExamDate', syllabus: 'Syllabus' }[data.type] || 'Update'}`);
  let text = `${parts.join('\n')}\n${footer(channelKey)}`;
  if (text.length > 1500) { // trim the optional bits first
    text = text.replace(/\n> 🎓[^\n]*/, '').replace(/\n> 🎂[^\n]*/, '').replace(/\n> 💳[^\n]*/, '').replace(/\n\n_[^\n]*_\n/, '\n');
  }
  return text;
}

const normTitle = (t) => stripMd(t).toLowerCase().replace(/[^a-z0-9\u0900-\u097f]/g, '');
const hashTitle = (t) => crypto.createHash('sha1').update(normTitle(t)).digest('hex');

function orgSite(title) {
  const o = cfg.ORG_SITES.find((s) => s.re.test(title));
  return o ? o.url : null;
}

// Telegram post -> card object
function buildCard(post, channel) {
  const mk = classify(post.text);
  if (!mk) return null;
  const info = extract(post.text);
  if (!info.title || cfg.QUIZ_BLOCK.test(info.title)) return null;
  const home = info.links.find((l) => isOfficial(l.url) && /^https?:\/\/[^/]+\/?$/.test(l.url))?.url || orgSite(info.title);
  const orgLine = (post.text.split('\n').find((l) => l.startsWith('🏛')) || '').replace('🏛', '').trim();
  const text = renderCard({ type: mk.type, title: info.title, org: stripMd(orgLine) || null, facts: info.facts, links: info.links, home }, channel.key);
  return { type: mk.type, title: info.title, lastDate: info.lastDate, links: info.links.map((l) => l.url).filter(isOfficial), text, hash: hashTitle(info.title) };
}

// official notice -> card object
function buildOfficialCard(item, type) {
  const facts = { notice: item.date ? fmtShort(item.date) : null };
  const lastM = item.title.match(/last date[^0-9]{0,20}(\d{1,2}[-./]\d{1,2}[-./]20\d\d)/i);
  if (lastM) facts.last = lastM[1];
  const postsM = item.title.match(/(\d[\d,]*)\s+(?:posts?|vacanc)/i);
  if (postsM) facts.posts = postsM[1];
  const text = renderCard({ type, title: item.title, org: item.org, facts, links: [{ url: item.link, label: /\.pdf/i.test(item.link) ? 'Notification PDF' : 'Notice Page' }], home: item.home }, item.channel);
  return { type, title: item.title, lastDate: lastM ? parseDate(lastM[1]) : null, links: [item.link], text, hash: hashTitle(item.title) };
}

module.exports = { buildCard, buildOfficialCard, renderCard, classify, extract, parseDate, footer, fmtDate, hashTitle, normTitle, isOfficial };
