// Page 1 of the OFFICIAL notification PDF as a JPEG, for NEW VACANCY image posts.
// Pure npm (mupdf = WebAssembly, no native/apt packages). Small and bounded for Render free (512 MB):
// PDF <= 5 MB, 20 s timeout, one render at a time, page 1 only, ~1080 px wide JPEG.
// Any failure returns null -> the caller sends the normal text card in the same slot (a post is never lost).
const cfg = require('./config');
const { getKV } = require('./db');
const tp = require('./thirdparty');

const MAX_PDF = 5 * 1024 * 1024;
let mupdfP = null;
const mupdf = () => (mupdfP = mupdfP || import('mupdf'));

// effective switch: self-chat/HTTP override (kv 'notifImage') beats env NOTIF_IMAGE
async function enabled() {
  const kv = await getKV('notifImage', null);
  if (kv === true || kv === false) return kv;
  return cfg.NOTIF_IMAGE;
}

// first official notification PDF of a vacancy card (gov.in / nic.in / recruiting body), never an aggregator
function pickPdf(type, links) {
  if (type !== 'vacancy') return null;
  for (const l of links || []) {
    const url = typeof l === 'string' ? l : l.url;
    if (!url || cfg.AGGREGATOR.test(url)) continue;
    let u;
    try { u = new URL(url); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || !/\.pdf$/i.test(u.pathname)) continue;
    if (tp.isOfficialUrl(url)) return url;
  }
  return null;
}

async function download(url) {
  const res = await fetch(url, { headers: { 'User-Agent': cfg.TP_USER_AGENT, Accept: 'application/pdf,*/*;q=0.5' }, signal: AbortSignal.timeout(20000), redirect: 'follow' });
  if (!res.ok) throw new Error(`pdf HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_PDF) { res.body && res.body.cancel && res.body.cancel().catch(() => {}); throw new Error(`pdf too big (${Math.round(len / 1e6)} MB)`); }
  const reader = res.body.getReader();
  const chunks = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_PDF) { await reader.cancel().catch(() => {}); throw new Error('pdf too big (>5 MB)'); }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  if (buf.slice(0, 1024).indexOf('%PDF') < 0) throw new Error('not a PDF');
  return buf;
}

let busy = Promise.resolve();
// -> { jpeg, width, height, thumb } or throws
async function renderFirstPage(buf) {
  const run = busy.then(async () => {
    const m = await mupdf();
    const doc = m.Document.openDocument(buf, 'application/pdf');
    let page, pix, th;
    try {
      if (doc.needsPassword && doc.needsPassword()) throw new Error('pdf is password protected');
      page = doc.loadPage(0);
      const [x0, y0, x1, y1] = page.getBounds();
      const w = x1 - x0, h = y1 - y0;
      if (!(w > 50 && h > 50)) throw new Error('bad page size');
      const sc = Math.min(2, 1080 / w, 2200 / h);
      pix = page.toPixmap(m.Matrix.scale(sc, sc), m.ColorSpace.DeviceRGB, false, true);
      const jpeg = Buffer.from(pix.asJPEG(80));
      const ts = 96 / Math.max(w, h);
      th = page.toPixmap(m.Matrix.scale(ts, ts), m.ColorSpace.DeviceRGB, false, true);
      const thumb = Buffer.from(th.asJPEG(50));
      return { jpeg, width: pix.getWidth(), height: pix.getHeight(), thumb };
    } finally {
      for (const o of [th, pix, page, doc]) { try { o && o.destroy && o.destroy(); } catch { /* ignore */ } }
    }
  });
  busy = run.catch(() => {});
  return run;
}

async function imageForPdf(url) {
  const buf = await download(url);
  const img = await renderFirstPage(buf);
  if (img.jpeg.length < 5000) throw new Error('rendered page looks empty');
  return img;
}

module.exports = { enabled, pickPdf, download, renderFirstPage, imageForPdf };
