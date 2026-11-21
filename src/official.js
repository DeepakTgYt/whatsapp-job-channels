// Second, independent source: official government websites (no aggregators).
// Each source returns a list of notices: { title, link, date, org, home, source, channel, forceType }.
// HTTP is kept light: small timeouts, conditional requests (ETag / If-Modified-Since), small JSON pages.
const cfg = require('./config');
const { getKV, setKV } = require('./db');

const decode = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&rsquo;|&lsquo;/g, "'").replace(/&nbsp;/g, ' ').replace(/&ndash;|&#8211;/g, '–')
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
const squash = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

// ---- conditional GET: returns { notModified } or { body } ----
async function get(url, { json = false } = {}) {
  const cacheKey = `http:${url}`;
  const cache = (await getKV(cacheKey)) || {};
  const headers = { 'User-Agent': cfg.USER_AGENT, Accept: json ? 'application/json' : 'text/html,*/*', 'Accept-Encoding': 'gzip, deflate, br' };
  if (cache.etag) headers['If-None-Match'] = cache.etag;
  if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(cfg.HTTP_TIMEOUT_MS), redirect: 'follow' });
      if (res.status === 304) return { notModified: true };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = json ? await res.json() : await res.text();
      const etag = res.headers.get('etag');
      const lastModified = res.headers.get('last-modified');
      if (etag || lastModified) await setKV(cacheKey, { etag, lastModified });
      return { body };
    } catch (e) {
      lastErr = e;
      if (i === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}
// forget cached ETag (used before first seeding, so a 304 can't hide the list)
const resetCache = (url) => setKV(`http:${url}`, {});

// ---- dates found in text or file names ----
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const mk = (y, m, d) => (y > 2015 && y < 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? new Date(Date.UTC(y, m - 1, d, 12) - 5.5 * 3600e3) : null);
function findDate(...strs) {
  for (const s0 of strs) {
    const s = String(s0 || '');
    let m;
    if ((m = s.match(/(20\d\d)-(\d\d)-(\d\d)/))) { const d = mk(+m[1], +m[2], +m[3]); if (d) return d; }
    if ((m = s.match(/(\d{1,2})[-./](\d{1,2})[-./](20\d\d)/))) { const d = mk(+m[3], +m[2], +m[1]); if (d) return d; }
    if ((m = s.match(/(\d{1,2})(?:st|nd|rd|th)?[\s-]+([A-Za-z]{3})[a-z]*[\s,-]+(20\d\d)/))) { const d = mk(+m[3], MON[m[2].toLowerCase()], +m[1]); if (d) return d; }
    if ((m = s.match(/(?<!\d)(20\d\d)(\d\d)(\d\d)(?!\d)/))) { const d = mk(+m[1], +m[2], +m[3]); if (d) return d; }
    if ((m = s.match(/(?<!\d)(\d\d)(\d\d)(20\d\d)(?!\d)/))) { const d = mk(+m[3], +m[2], +m[1]); if (d) return d; }
  }
  return null;
}

// ---- classification of official notices ----
const SKIP = /tender|quotation|\bRTI\b|right to information|auction|e-?procurement|empanel|rebuttal|fake news|chargeback|refund|gender in otr|profile tab|debarred|court case|contempt|cancellation of candidature|invalid applications|rejection list|visitor|feedback|grievance|annual report|citizen charter|photo gallery|press release|mock test|quiz/i;
const RULES = [
  { type: 'answerkey', re: /answer key|response sheet|उत्तर कुंजी|आंसर की/i },
  { type: 'admit', re: /admit card|admission certificate|e-admit|call letter|प्रवेश पत्र|एडमिट/i },
  { type: 'result', re: /\bresult|selection list|selected candidates|qualified|shortlisted|merit list|marks of|final selection|परिणाम|रिजल्ट/i },
  { type: 'syllabus', re: /syllabus|exam(ination)? pattern|scheme of exam|पाठ्यक्रम|सिलेबस/i },
  { type: 'examdate', re: /exam(ination)? date|date of (the )?(exam|commencement)|schedule|postpone|reschedul|cancellation of (the )?(mains|prelim|written|exam)|calendar|exam city|city intimation|physical (efficiency|standard) test|\bPET\b|\bPST\b|document verification|परीक्षा तिथि/i },
  { type: 'vacancy', re: /advertisement for|recruitment|apply online|vacanc|notification for|appointment to the posts?|for selection of|विज्ञापन|भर्ती|corrigendum|online application|invites? applications?/i },
];
function classifyOfficial(title, forceType) {
  if (!title || title.length < 20) return null;
  if (cfg.QUIZ_BLOCK.test(title) || SKIP.test(title)) return null;
  if (forceType) return forceType;
  for (const r of RULES) if (r.re.test(title)) return r.type;
  return null; // unclassified / irrelevant -> skipped
}

// ---- source readers ----
async function readSscApi(src) {
  const attrs = 'id,headline,examId,contentType,redirectUrl,startDate,endDate,language,createdAt';
  const q = new URLSearchParams({ page: 1, limit: 15, contentType: src.contentType, key: 'createdAt', order: 'DESC', isAttachment: 'true', language: 'english', attributes: attrs });
  const url = `https://ssc.gov.in/api/general-website/portal/${src.path}?${q}`;
  const r = await get(url, { json: true });
  if (r.notModified) return { notModified: true, url };
  if (!r.body || String(r.body.statusCode) !== '200' || !Array.isArray(r.body.data)) throw new Error(`SSC API bad response ${r.body && r.body.statusCode}`);
  const items = r.body.data.map((d) => {
    const att = (d.attachments || []).find((a) => /pdf/i.test(a.type || a.fileName || '')) || (d.attachments || [])[0];
    const link = att && att.path ? 'https://ssc.gov.in/api/attachment/' + encodeURI(att.path.replace(/\\/g, '/')) : d.redirectUrl || src.home;
    return { uid: `${src.id}:${d.id}`, title: squash(d.headline), link, date: findDate(d.createdAt) };
  });
  return { items, url };
}

async function readHtml(src) {
  const r = await get(src.url);
  if (r.notModified) return { notModified: true, url: src.url };
  const html = r.body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ');
  const seen = new Set();
  const items = [];
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const title = squash(m[2]).replace(/^(important\s+notices?|notice|new)\s*[:\-–]+\s*/i, '').replace(/\s*(new|click here)\s*$/i, '');
    if (title.length < 25 || title.length > 400) continue;
    if (/^(javascript|mailto|tel):/i.test(m[1])) continue;
    let link;
    try { link = new URL(decode(m[1]).trim().replace(/ /g, '%20'), src.url).href; } catch { continue; }
    if (cfg.AGGREGATOR.test(link)) continue;
    const key = title.toLowerCase() + '|' + link;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ uid: `${src.id}:${link}|${title.toLowerCase().slice(0, 120)}`, title, link, date: findDate(title, decodeURIComponent(link)) });
  }
  if (!items.length) throw new Error('no notices found in page (layout changed?)');
  return { items, url: src.url };
}

async function readSource(src) {
  const out = src.kind === 'ssc-api' ? await readSscApi(src) : await readHtml(src);
  if (out.items) {
    for (const it of out.items) Object.assign(it, { org: src.org, home: src.home, source: src.id, channel: src.channel, forceType: src.forceType });
  }
  return out;
}

module.exports = { readSource, classifyOfficial, findDate, resetCache, get };
