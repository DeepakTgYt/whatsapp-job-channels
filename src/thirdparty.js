// Third source: public job-listing websites used ONLY to DETECT that something new happened.
// Rules (enforced here + in engine):
//  - we read facts only (organisation, post, vacancies, dates, fee, age, qualification) and the
//    OFFICIAL links (gov.in / nic.in / recruiting body's own domain) found on the detail page
//  - no sentence is copied; the card is written by our own template (format.renderCard)
//  - the listing site is never linked and never named in a post
//  - first run seeds everything as seen (no flood); later only new items, capped per round
const crypto = require('crypto');
const cfg = require('./config');
const { getKV, setKV, col } = require('./db');
const { parseDate, applyMode } = require('./format');

const sha = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 24);
const decode = (s) =>
  String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;|&rsquo;|&lsquo;|&#8217;|&#8216;/g, "'").replace(/&nbsp;/g, ' ').replace(/&ndash;|&#8211;|&#8212;|&mdash;/g, '–')
    .replace(/&#038;/g, '&').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
const squash = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const stripNoise = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->|<noscript[\s\S]*?<\/noscript>|<svg[\s\S]*?<\/svg>/gi, ' ');

// ---- HTTP: polite UA, conditional GET (ETag / If-Modified-Since), size cap ----
const MAX_BYTES = 1.5 * 1024 * 1024;
async function readCapped(res) {
  if (!res.body || !res.body.getReader) return (await res.text()).slice(0, MAX_BYTES);
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    chunks.push(value);
    if (n >= MAX_BYTES) { await reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function get(url, { conditional = true } = {}) {
  const cacheKey = `http:${url}`;
  const cache = conditional ? (await getKV(cacheKey)) || {} : {};
  const headers = { 'User-Agent': cfg.TP_USER_AGENT, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-IN,en;q=0.9,hi;q=0.8' };
  if (cache.etag) headers['If-None-Match'] = cache.etag;
  if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;
  let lastErr;
  for (let i = 0; i < 2; i++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(cfg.HTTP_TIMEOUT_MS), redirect: 'follow' });
      if (res.status === 304) return { notModified: true };
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}${res.status === 403 ? ' (blocked)' : ''}`);
        if (res.status === 404 || res.status === 410) { err.final = true; throw err; } // retry won't help (403 can be a transient bot check)
        throw err;
      }
      const body = await readCapped(res);
      if (conditional) {
        const etag = res.headers.get('etag');
        const lastModified = res.headers.get('last-modified');
        if (etag || lastModified) await setKV(cacheKey, { etag, lastModified });
      }
      return { body };
    } catch (e) {
      lastErr = e;
      if (e.final) break;
      if (i === 0) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}
const resetCache = (url) => setKV(`http:${url}`, {});

// ---- classification: which channel, which type, skip junk ----
const SKIP = /quiz|\bPYQ\b|mock test|previous (year )?paper|question paper|practice set|tender|quotation|auction|e-?procurement|scholarship|admission(?! certificate)|counselling|certificate download|e certificate|migration certificate|\bdegree\b.*\bresult\b|board (time table|result|exam)|class 1[02]|10th result|12th result|\bCBSE\b|\bICSE\b|time ?table 20\d\d.*board|voter|aadhaar|pan card|ration card|yojana|tools|resizer|calculator|study material|book|\bnews\b|exam analysis|cut ?off|salary|\bpay scale\b|how to/i;
const SENIOR = /general manager|\bAGM\b|\bJGM\b|\bDGM\b|\bCGM\b|chairman|managing director|\bdirector\b|chief (engineer|controller|general)|retired|re-?engage|consultant|advisor|\bintern\b|research associate|\bJRF\b|young professional|deputation|principal\b|\bPGT\b|\bTGT\b|\bPRT\b|kendriya vidyalaya|\bKVS?\b|sainik (school|shiksha)|army public school|\bAWES\b|medical officer|specialist|professor|faculty|\bresident\b|tutor|para ?legal|volunteer|\bdealer\b|project (assistant|associate|scientist)/i;
// ---- channel routing (shared by web sources and Telegram posts). When unsure -> null (skip, never misroute) ----
// Army channel = Army/Navy/Airforce/Agniveer/NDA/CDS/defence/paramilitary only (plain "SSB" is ambiguous: Staff Selection Board of a state).
const RAILWAY_RE = /\bRRB\b|\bRRC\b|\bRPF\b|railway|indian rail|\bRCF\b|\bICF\b|\bDLW\b|\bCLW\b|\bBLW\b|\bDMW\b|\bRWF\b|\bIRCTC\b|\bRITES\b|\bIRCON\b|\bRVNL\b|\bDFCCIL\b|konkan rail|metro rail/i;
const ARMY_RE = /agniveer|agnipath|\bindian army\b|\barmy\b|\bnavy\b|naval|air ?force|\bIAF\b|airmen|\bAFCAT\b|territorial army|coast guard|\bICG\b|\bNDA\b|\bCDS\b|\bTES\b|\bTGC\b|bharti rally|rally bharti|army rally|\bMNS\b|military|\bNCC\b special entry|\bdefen[cs]e\b|\bBSF\b|\bCRPF\b|\bCISF\b|\bITBP\b|assam rifles|sashastra seema bal|\bSSB\b\s+(constable|head constable|\bHC\b|\bSI\b|\bASI\b|tradesman|\bGD\b)|\bCAPF\b|\bNSG\b|paramilitary/i;
const SSC_RE = /\bSSC\b|staff selection commission/i;
const BIHAR_RE = /bihar|\bBPSC\b|\bBSSC\b|\bCSBC\b|\bBPSSC\b|\bBTSC\b|\bBCECE|\bBSPHCL\b|\bBELTRON\b|\bSHSB\b|\bBSEB\b|patna|\bOFSS\b|muzaffarpur|darbhanga|bhagalpur|\bgaya\b|purnea|purnia|begusarai|samastipur|madhubani|motihari|bettiah|sitamarhi|siwan|chapra|\bsaran\b|hajipur|vaishali|nalanda|nawada|jehanabad|\barwal\b|rohtas|sasaram|buxar|bhojpur|\barrah\b|kaimur|munger|jamui|lakhisarai|sheikhpura|khagaria|katihar|kishanganj|araria|supaul|saharsa|madhepura|\bbanka\b|gopalganj|sheohar/i;
// other states / their bodies: a job there is a state job -> never SSC/Army(unless a real force)/Railway by accident
const OTHER_STATE = /odisha|orissa|\bOSSC\b|\bOSSSC\b|rajasthan|\bRSMSSB\b|uttar pradesh|\bUPSSSC\b|madhya pradesh|\bMPESB\b|haryana|\bHSSC\b|punjab|\bPSSSB\b|gujarat|\bGSSSB\b|maharashtra|karnataka|\bKEA\b|tamil ?nadu|\bTNPSC\b|kerala|telangana|andhra|west bengal|\bWBSSC\b|jharkhand|\bJSSC\b|chhattisgarh|\bCGVYAPAM\b|uttarakhand|\bUKSSSC\b|himachal|\bHPSSC\b|jammu|kashmir|\bJKSSB\b|\bgoa\b|manipur|meghalaya|mizoram|nagaland|tripura|sikkim|arunachal|\bDSSSB\b|akola|\bGMC\b|municipal|nagar (nigam|palika)|zilla parishad|\bZP\b/i;
function routeChannel(title, hintChannel = null) {
  const t = String(title || '');
  if (RAILWAY_RE.test(t)) return 'railway';
  const bihar = BIHAR_RE.test(t);
  const other = OTHER_STATE.test(t) || /\b(UP|MP)\b/.test(t); // case-sensitive: UP / MP state jobs
  if (SSC_RE.test(t) && !bihar && !other) return 'ssc'; // recruiter is the central SSC (incl. SSC CPO / GD for CAPF)
  if (ARMY_RE.test(t)) return 'army';
  if (bihar) return 'bihar'; // Bihar bodies and Bihar-located jobs (incl. Bihar SSC)
  if (hintChannel === 'bihar' && !other) return 'bihar'; // source only lists Bihar jobs
  return null;
}
// organisations whose posts are always relevant even when the vacancy count is small
const CORE = /\bIAF\b|\bRRB\b|\bRRC\b|\bRPF\b|railway recruitment|agniveer|agnipath|indian army|\bnavy\b|air ?force|\bAFCAT\b|coast guard|territorial army|\bNDA\b|\bCDS\b|\bSSC\b|staff selection|\bBPSC\b|\bBSSC\b|\bCSBC\b|\bBPSSC\b|\bBTSC\b|bihar police/i;
const TYPE_RULES = [
  { type: 'answerkey', re: /answer key|response sheet|objection/i },
  { type: 'admit', re: /admit card|hall ticket|call letter|exam city|city (intimation|slip|details)|intimation slip|admission certificate|e-?admit|interview letter/i },
  { type: 'result', re: /\bresult|merit list|selection list|score ?card|\bmarks\b|final select|qualified|shortlist/i },
  { type: 'syllabus', re: /syllabus|exam pattern/i },
  { type: 'examdate', re: /exam (date|schedule|calendar)|new exam date|exam(ination)? schedule|\bschedule\b|\bPET\b|\bPST\b|\bDV\b schedule|document verification|physical (test|efficiency)|rally (schedule|date)/i },
  { type: 'vacancy', re: /online form|offline form|apply online|recruitment|notification|vacanc|bharti|walk-?in|\bposts?\b|rally|application form|apply offline|entry scheme|\bcourse\b|re-?open|extended|last date/i },
];
function classifyItem(title, hintChannel, isMain = true) {
  if (!title || title.length < 12 || SKIP.test(title) || cfg.QUIZ_BLOCK.test(title)) return null;
  const channel = routeChannel(title, isMain ? hintChannel : null);
  if (!channel) return null;
  let type = null;
  for (const r of TYPE_RULES) if (r.re.test(title)) { type = r.type; break; }
  if (!type) return null;
  if (type === 'vacancy' && SENIOR.test(title) && !CORE.test(title)) return null;
  return { channel, type };
}

// ---- our own short title (facts only, no marketing words from the listing) ----
const TYPE_WORD = { vacancy: 'Recruitment', admit: 'Admit Card', result: 'Result', answerkey: 'Answer Key', examdate: 'Exam Date', syllabus: 'Syllabus' };
function ownTitle(raw, type, posts) {
  let t = squash(raw)
    .replace(/\s*[–-]\s*(apply here|start(ed)?|out|live|active|available)\s*$/i, '').replace(/^\d{1,2}\s+[A-Z]{3}\s+/, '').replace(/\b(closing soon|last date today|new|updated?)\s*$/i, '')
    .replace(/\(\s*[\d,]+\s*(vacancy|vacancies|posts?)\s*\)/gi, ' ')
    .replace(/\b(online|offline|walk-?in)\s+form\b|\bapply\s+(online|offline)\b|\bout\s+(today|now)\b|\blink\s+activ\w*|\bactivated\b|\breleased\b|\bdownload\b|\bget details\b|\bcheck\b|\bnow\b|\bnotification\s+out\b|[–|-]\s*out\b|\bout\b(?=\s*$)/gi, ' ')
    .replace(/\|\s*(date\s+)?extended/gi, ' ').replace(/\bdate extended\b|\bextended\b|\bre-?open(ed)?\b/gi, ' ')
    .replace(/\s*[|–-]\s*$/g, '').replace(/\s{2,}/g, ' ').trim();
  const word = TYPE_WORD[type];
  if (word && !new RegExp(word.replace(' ', '\\s*'), 'i').test(t) && !(type === 'vacancy' && /recruitment|notification|bharti|rally|entry|course/i.test(t)) && !(type === 'admit' && /exam city|city (intimation|slip|details)|intimation slip|call letter|hall ticket/i.test(t)) && !(type === 'result' && /marks|score ?card|merit|select/i.test(t)) && !(type === 'examdate' && /schedule|calendar|\bPET\b|\bPST\b|document verification/i.test(t))) {
    const y = t.match(/\s(20\d\d)\s*$/);
    t = y ? `${t.slice(0, y.index)} ${word} ${y[1]}` : `${t} ${word}`;
  }
  if (posts && type === 'vacancy') {
    const n = String(posts).replace(/,/g, '');
    const numRe = new RegExp(`\\b${n.replace(/\B(?=(\d{3})+(?!\d))/g, ',?')}\\b\\s*(posts?\\b|vacanc\\w*)?`, 'gi');
    t = t.replace(numRe, ' ').replace(/(?<!various\s)\bposts?\b(?=\s+(recruitment|20\d\d))/i, ' ').replace(/\s{2,}/g, ' ').trim();
    t += ` (${posts} ${n === '1' ? 'Post' : 'Posts'})`;
  }
  return t.replace(/\s{2,}/g, ' ').trim();
}

// ---- organisation lookup (name + official website), from config ----
function orgFor(text) {
  const o = cfg.ORG_SITES.find((s) => s.re.test(text));
  return o ? { name: o.name || null, url: o.url } : null;
}

// ---- listing readers: return [{ uid, rawTitle, link, date, row:{board,post,qual,last,advt}, hint }] ----
function readFjaListing(src, html) {
  const out = new Map();
  const ART = 'https:\\/\\/www\\.freejobalert\\.com\\/articles\\/[^"]+-(\\d+)';
  // 1) structured ItemList (clean names) that some listing pages carry
  const names = new Map();
  for (const m of html.matchAll(/"url":"(https:\/\/www\.freejobalert\.com\/articles\/[^"]+-(\d+))","name":"((?:[^"\\]|\\.)*)"/g)) names.set(m[2], { link: m[1], name: squash(m[3].replace(/\\\//g, '/').replace(/\\u0026/g, '&')) });
  const h = stripNoise(html);
  // 2) main job tables. Two layouts seen: "lattrbord" rows (plain cells) and "kar-ref-row" rows (classed cells)
  for (const r of h.matchAll(/<tr class="(?:lattrbord|kar-ref-row)[^"]*">([\s\S]*?)<\/tr>/gi)) {
    const a = r[1].match(new RegExp(`href="(${ART})"`, 'i'));
    if (!a) continue;
    const aria = squash((r[1].match(/aria-label="([^"]*)"/i) || [])[1] || '').replace(/^view\s+/i, '');
    const desk = (html1) => squash(((html1 || '').match(/<span class="kar-t-desk">([\s\S]*?)<\/span>/i) || [])[1] || html1);
    let row;
    if (/kar-c-/.test(r[1])) {
      const cell = (k) => (r[1].match(new RegExp(`<td class="kar-c-${k}"[^>]*>([\\s\\S]*?)<\\/td>`, 'i')) || [])[1];
      row = { date: desk(cell('date')), board: squash(cell('board')), post: desk(cell('title')) || squash(cell('post')), qual: squash(cell('qual')), advt: squash(cell('advt')), last: squash(cell('last')), vac: squash(cell('vac')) };
    } else {
      const tds = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => squash(m[1]));
      if (tds.length < 6) continue;
      row = { date: tds[0], board: tds[1], post: tds[2], qual: tds[3], advt: tds[4], last: tds[5] };
    }
    if (!row.advt || row.advt === '–' || row.advt === '-') row.advt = null;
    out.set(a[2], { uid: `${src.id}:${a[2]}`, rawTitle: aria || (names.get(a[2]) || {}).name || `${row.board} ${row.post}`, link: a[1], date: parseDate(String(row.date || '').replace(/^(\d{1,2}\/\d{1,2}\/)(\d\d)$/, '$120$2')), row, main: true });
  }
  for (const [id, v] of names) if (!out.has(id)) out.set(id, { uid: `${src.id}:${id}`, rawTitle: v.name, link: v.link, date: null, row: null, main: true });
  // 3) other rows ("new updates" tables): date cell + title cell + "Get Details" link
  for (const r of h.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const a = r[1].match(new RegExp(`href="(${ART})"`, 'i'));
    if (!a || out.has(a[2])) continue;
    const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => squash(m[1]));
    const at = squash((r[1].match(new RegExp(`href="${ART}"[^>]*>([\\s\\S]*?)<\\/a>`, 'i')) || [])[2] || '');
    const title = (at.length >= 12 && !/get details|click here|view details/i.test(at) ? at : null) || cells.find((c) => c.length >= 12 && !/^[\d\/\s.-]+$/.test(c) && !/get details|click here|view details/i.test(c));
    if (!title) continue;
    const d = cells.find((c) => /^\d{1,2}\/\d{1,2}\/20\d\d$/.test(c));
    out.set(a[2], { uid: `${src.id}:${a[2]}`, rawTitle: title, link: a[1], date: d ? parseDate(d) : null, row: null });
  }
  // 4) any other article link with a meaningful text (quick links, update widgets)
  for (const a of h.matchAll(new RegExp(`<a[^>]+href="(${ART})"[^>]*>([\\s\\S]*?)<\\/a>`, 'gi'))) {
    if (out.has(a[2])) continue;
    const title = (names.get(a[2]) || {}).name || squash(a[3]);
    if (title.length < 12 || /get details|click here|read more/i.test(title)) continue;
    out.set(a[2], { uid: `${src.id}:${a[2]}`, rawTitle: title, link: a[1], date: null, row: null });
  }
  return [...out.values()];
}
function readHomeListing(src, html) {
  const out = new Map();
  const h = stripNoise(html);
  const host = new URL(src.url).hostname.replace(/^www\./, '');
  for (const a of h.matchAll(/<a\b[^>]*href="(https?:\/\/(?:www\.)?([^/"]+)\/[^"#]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (a[2].toLowerCase() !== host) continue; // tinyurl, pdf mirrors, apps: ignore
    const link = a[1].replace(/^http:/, 'https:');
    const path = new URL(link).pathname;
    if (path.split('/').filter(Boolean).length < (src.minDepth || 1) || /\/(category|tag|page|author)\//.test(path)) continue;
    const title = squash(a[3]);
    if (title.length < 15 || /view (more|all)|click here|read more/i.test(title)) continue;
    const key = sha(`${link}|${title.toLowerCase()}`); // same page, new title = a new update (admit card, result...)
    if (!out.has(key)) out.set(key, { uid: `${src.id}:${key}`, rawTitle: title, link, date: null, row: null });
  }
  return [...out.values()];
}

// ---- detail page: facts + official links only ----
// recruiting bodies whose own sites are not on gov.in/nic.in (railway RRCs, forces' portals)
const OFFICIAL_EXTRA = /(^|\.)(rrccr\.com|rrcnr\.org|rrcrecruit\.co\.in|rrc-wr\.com|rrcjaipur\.in|rrcmas\.in|rrcer\.org|rrcser\.co\.in|rrcecr\.gov\.in|rrcpryj\.org|rrcb\.gov\.in|rrcnfr\.co\.in|wcr\.indianrailways\.gov\.in|joinindianarmy\.nic\.in|joinindiannavy\.gov\.in|agnipathvayu\.cdac\.in|careerindianairforce\.cdac\.in|joinindiancoastguard\.cdac\.in|territorialarmy\.in|rrbapply\.gov\.in|ibps\.in|onlinebssc\.com|apply-csbc\.com|apply-bpssc\.com)$/i;
const BAD_LINK = /youtube|youtu\.be|t\.me|telegram|whatsapp|facebook|instagram|twitter|x\.com|play\.google|apple\.com|tinyurl|bit\.ly|linkedin|threads\.net|google\.com/i;
function isOfficialUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '');
    if (cfg.AGGREGATOR.test(h) || BAD_LINK.test(h)) return false;
    return cfg.OFFICIAL_DOMAIN.test(h) || OFFICIAL_EXTRA.test(h);
  } catch { return false; }
}
function toLines(html) {
  return decode(html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|td|th|h\d|span|strong|b|ul|table)>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
const QUALS = [
  [/\b10th\b|matric|high school|class 10/i, '10th'], [/\b12th\b|10\s*\+\s*2|intermediate|class 12/i, '12th'], [/\bITI\b/, 'ITI'],
  [/diploma/i, 'Diploma'], [/\bB\.?\s?Tech\b|\bB\.E\b|\bBE\b|engineering degree/, 'B.E/B.Tech'], [/MBBS/i, 'MBBS'], [/nursing|GNM|B\.?Sc\.? nursing/i, 'Nursing'],
  [/\bLLB\b|law degree|bachelor.{0,20}law/i, 'LLB'], [/graduat|bachelor|degree in any/i, 'Graduate'], [/post ?graduat|[Mm]aster'?s? [Dd]egree|\bM\.A\b|\bM\.Sc\b|\bPG\b/, 'Post Graduate'],
];
function qualFrom(text) {
  const found = [];
  for (const [re, label] of QUALS) if (re.test(text) && !found.includes(label)) found.push(label);
  return found.slice(0, 4).join(', ') || null;
}
function valueAfter(lines, i) {
  const l = lines[i];
  const c = l.indexOf(':');
  const v = c >= 0 ? l.slice(c + 1).trim() : '';
  if (v) return v;
  return lines[i + 1] && lines[i + 1].length < 80 ? lines[i + 1].replace(/^[:\s-]+/, '') : '';
}
const dateOnly = (v) => { const m = String(v).match(/\d{1,2}[-/.]\d{1,2}[-/.]20\d\d|\d{1,2}(st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+20\d\d|[A-Za-z]{3,9}\s+\d{1,2},?\s+20\d\d|to be (announced|notified)|as per schedule|soon|available now/i); return m ? m[0] : null; };

function parseDetail(html) {
  const raw = stripNoise(html);
  const start = raw.search(/class="entry-content|<article\b|<main\b/i);
  let end = raw.length;
  if (start >= 0) { const f = raw.slice(start).search(/<footer\b|id="comments"|class="comments-area|class="related/i); if (f > 0) end = start + f; }
  const main = start >= 0 ? raw.slice(start, end) : raw;
  const lines = toLines(main);
  const facts = {};
  const fees = [];
  let ageMin = null, ageMax = null, ageAs = null, qualText = '', feeUntil = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^(application|exam(ination)?) fee/i.test(l)) feeUntil = i + 14;
    if (l.length > 160) continue; // paragraphs are never copied
    if (!facts.start && /^(application begin|starting date|start date|apply online start|online application start|opening date)/i.test(l)) facts.start = dateOnly(valueAfter(lines, i));
    if (!facts.last && /^last date\b(?!.*(fee|pay|correction|edit|reach|hard copy|offline))/i.test(l)) facts.last = dateOnly(valueAfter(lines, i));
    if (!facts.exam && /^(cbt |written |online )?exam(ination)? date|^date of exam|^cbt (examination )?date/i.test(l)) facts.exam = dateOnly(valueAfter(lines, i));
    if (!facts.posts) {
      const m = l.match(/^total\s*(vacanc(y|ies)|posts?)?\s*:?\s*([\d,]{1,7})\s*(posts?|vacanc\w*)?\s*$/i) || l.match(/^total\s*(vacanc(y|ies)|posts?)\s*:?\s*$/i);
      if (m && m[3]) facts.posts = m[3];
      else if (m) { const n = (lines[i + 1] || '').match(/^([\d,]{1,7})\b/); if (n) facts.posts = n[1]; }
    }
    if (i <= feeUntil && fees.length < 2 && !/age|relaxation|years?\b|refund/i.test(l) && /^(general|gen|ur|obc|ews|sc|st|female|all (other )?(category|candidates)|unreserved|others?)\b[^:]{0,50}:?\s*$|^(general|gen|ur|obc|ews|sc|st|female|all (other )?(category|candidates)|unreserved)\b[^:]{0,50}:\s*(rs\.?|₹)?\s*\d/i.test(l)) {
      const v = valueAfter(lines, i).match(/(\d[\d,]*)\s*\/?-?/);
      const who = l.split(':')[0].replace(/\s*\/\s*/g, '/').replace(/\b(candidates?|category|fee|refund)\b/gi, '').replace(/\s+/g, ' ').trim();
      if (v && !/refund/i.test(l) && who.length <= 40) fees.push(`${who} ₹${v[1]}`);
    }
    if (/nil|no fee|free of cost/i.test(l) && /^application fee/i.test(lines[i - 1] || '') && !fees.length) fees.push('No fee');
    if (ageMin === null && /^min(imum)? age/i.test(l)) { const m = valueAfter(lines, i).match(/\d{2}/); if (m) ageMin = m[0]; }
    if (ageMax === null && /^max(imum)? age/i.test(l)) { const m = valueAfter(lines, i).match(/\d{2}(\s*-\s*\d{2})?/); if (m) ageMax = m[0].replace(/\s+/g, ''); }
    if (!ageAs && /^age (limit )?(calculated )?as on/i.test(l)) ageAs = dateOnly(valueAfter(lines, i) || l);
    if (/qualification|eligibility/i.test(l) && qualText.length < 1500) qualText += ' ' + lines.slice(i, i + 6).join(' ');
  }
  if (fees.length) facts.fee = fees.join(' | ');
  if (ageMin || ageMax) facts.age = `${ageMin || '?'}–${ageMax || '?'} yrs${ageAs ? ` (as on ${ageAs})` : ''}`;
  const q = qualFrom(qualText);
  if (q) facts.qual = q;
  // official links with a short label taken from the nearby text (label words only, used for our own labels)
  const links = [];
  for (const m of main.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(decode(m[1]).trim()).href; } catch { continue; }
    if (!/^https?:/.test(url) || !isOfficialUrl(url)) continue;
    if (links.some((l) => l.url === url)) continue;
    const anchor = squash(m[2]);
    const pieces = main.slice(Math.max(0, m.index - 600), m.index).split(/<[^>]+>/).map(squash).filter((x) => x && !/^[|:,\-–]+$/.test(x));
    const near = (pieces[pieces.length - 1] || '').slice(-60);
    links.push({ url, label: (/click here|^here$|^link$|^(english|hindi|download|visit)$|^\W*$/i.test(anchor) || anchor.length < 4 ? `${near} ${anchor}` : anchor).trim().slice(0, 90) });
    if (links.length >= 8) break;
  }
  return { facts, links, head: lines.slice(0, 40).join(' ').slice(0, 2500) };
}

// ---- turn one listing item (+ detail page) into data for format.renderCard ----
function buildData(item, cls, detail, src) {
  const row = item.row || {};
  const facts = { ...(detail ? detail.facts : {}) };
  if (!facts.last && row.last && /\d/.test(row.last)) facts.last = row.last;
  if (row.qual && row.qual.length < 60 && !/^other$/i.test(row.qual)) facts.qual = row.qual.replace(/\b(10|12)TH\b/g, '$1th'); // listing column is the cleaner summary
  if (!facts.posts) { const m = `${row.post || ''} ${item.rawTitle}`.match(/([\d,]{1,7})\s*(posts?|vacanc)/i); if (m && m[1] !== '0') facts.posts = m[1]; }
  if (item.date) facts.notice = item.date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: cfg.TZ });
  if (cls.type !== 'vacancy') { for (const k of ['fee', 'age', 'qual', 'posts', 'start', 'last']) delete facts[k]; } // those are application facts
  const mode = cls.type === 'vacancy' ? applyMode(`${item.rawTitle} ${row.post || ''} ${detail && detail.head ? (detail.head.match(/mode of (apply|application)[^.]{0,40}/i) || [''])[0] : ''}`) : null;
  if (/extended/i.test(item.rawTitle)) facts.status = 'Last date extended';
  if (/re-?open/i.test(item.rawTitle)) facts.status = 'Application re-opened';
  const ctx = `${row.board || ''} ${item.rawTitle} ${row.post || ''}`;
  const org = orgFor(ctx) || (detail && detail.head ? orgFor(detail.head) : null);
  for (const k of ['start', 'last', 'exam']) { // one date style on every card
    const d = facts[k] && /\d{4}/.test(facts[k]) ? parseDate(facts[k]) : null;
    if (d && !isNaN(d)) facts[k] = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: cfg.TZ });
  }
  const title = ownTitle(item.rawTitle, cls.type, cls.type === 'vacancy' ? facts.posts : null);
  const links = pickLinks((detail ? detail.links : []).filter((l) => isOfficialUrl(l.url)), cls.type, item.rawTitle);
  const isRoot = (u) => { try { return new URL(u).pathname.replace(/\/+$/, '') === ''; } catch { return false; } };
  const home = links.some((l) => isRoot(l.url)) ? null : org ? org.url : null;
  return { type: cls.type, title, org: org && org.name ? org.name : (row.board && row.board.length < 60 ? row.board : null), facts, links, home, advt: cls.type === 'vacancy' ? row.advt : null, mode };
}

// keep the links that fit this update: an answer-key post gets the answer-key link first, never "apply online"
const TYPE_LINK = { vacancy: /apply|registration|notification|advt|advertisement|corrigendum/i, admit: /admit|hall ticket|call letter|exam city|city slip|intimation|e-?admit/i, result: /result|marks|merit|score|select|qualified/i, answerkey: /answer key|response sheet|objection/i, examdate: /schedule|exam date|time ?table|calendar|notice/i, syllabus: /syllabus|pattern/i };
function pickLinks(links, type, rawTitle) {
  const words = new Set(String(rawTitle).toLowerCase().split(/\W+/).filter((w) => w.length > 3));
  const isRoot = (u) => { try { return new URL(u).pathname.replace(/\/+$/, '') === ''; } catch { return false; } };
  const scored = links.map((l, i) => {
    let sc = 0;
    if (TYPE_LINK[type] && TYPE_LINK[type].test(l.label)) sc += 4;
    if (String(l.label).toLowerCase().split(/\W+/).some((w) => words.has(w))) sc += 1;
    if (type !== 'vacancy' && /apply|registration/i.test(l.label) && !/admit|result|answer/i.test(l.label)) sc -= 10;
    if (type !== 'vacancy' && /notification|advt/i.test(l.label)) sc -= 2;
    if (isRoot(l.url)) sc = Math.min(sc, 0.5); // one official website line at most
    return { ...l, sc, i };
  }).filter((l) => {
    if (l.sc <= -5) return false;
    if (type === 'vacancy' || isRoot(l.url)) return true;
    // on an update post keep only links about THIS update (or a plain PDF with no other meaning)
    const other = Object.entries(TYPE_LINK).some(([t, re]) => t !== type && t !== 'vacancy' && re.test(l.label)) || /notification|corrigendum|advt|advertisement|apply|schedule|exam date|syllabus|how to/i.test(l.label);
    return l.sc >= 4 || (!other && /\.pdf/i.test(l.url) && !/login|apply/i.test(l.url));
  });
  scored.sort((a, b) => b.sc - a.sc || a.i - b.i);
  const out = [];
  let roots = 0;
  for (const l of scored) {
    if (isRoot(l.url)) { if (roots++) continue; }
    out.push({ url: l.url, label: isRoot(l.url) ? 'Official Website' : type === 'vacancy' ? l.label : { admit: 'Admit Card', result: 'Result PDF', answerkey: 'Answer Key PDF', examdate: 'Notice PDF', syllabus: 'Syllabus PDF' }[type] });
    if (out.length >= 4) break;
  }
  return out;
}

module.exports = { routeChannel, applyMode, CORE, get, resetCache, readFjaListing, readHomeListing, parseDetail, buildData, classifyItem, ownTitle, isOfficialUrl, sha };
