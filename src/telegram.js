// Reads new posts from the public Telegram preview page t.me/s/<channel> (no Telegram login needed).
const cfg = require('./config');

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

// Telegram HTML -> WhatsApp formatting (*bold*, _italic_), keeps link URLs
function htmlToWa(html) {
  let s = html;
  s = s.replace(/<i class="emoji"[^>]*>\s*<b>(.*?)<\/b>\s*<\/i>/g, '$1'); // emoji images -> emoji
  s = s.replace(/<br\s*\/?>/g, '\n');
  s = s.replace(/<a [^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g, (m, href, text) => {
    const t = text.replace(/<[^>]+>/g, '');
    if (href.startsWith('?q=')) return t; // hashtag
    const full = href.startsWith('http') ? href : `https://${href.replace(/^\/\//, '')}`;
    const norm = (u) => u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    return norm(t) === norm(full) ? full : `${t}: ${full}`;
  });
  s = s.replace(/<b>(.*?)<\/b>/gs, (m, t) => (t.trim() ? `*${t.trim()}*` : t));
  s = s.replace(/<i>(.*?)<\/i>/gs, (m, t) => (t.trim() ? `_${t.trim()}_` : t));
  s = s.replace(/<[^>]+>/g, '');
  return decode(s).replace(/\n{3,}/g, '\n\n').trim();
}

async function fetchPosts(channel, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`https://t.me/s/${channel}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      const posts = [];
      const parts = html.split('data-post="').slice(1);
      for (const part of parts) {
        const id = Number(part.slice(0, part.indexOf('"')).split('/')[1]);
        const m = part.match(/<div class="tgme_widget_message_text js-message_text"[^>]*>([\s\S]*?)<\/div>\s*<div class="tgme_widget_message_footer/);
        if (!id || !m) continue; // polls, photos without text etc.
        posts.push({ id, html: m[1], text: htmlToWa(m[1]) });
      }
      return posts.sort((a, b) => a.id - b.id);
    } catch (e) {
      if (i === retries) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

module.exports = { fetchPosts, htmlToWa };
