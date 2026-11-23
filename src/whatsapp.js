// WhatsApp connection (Baileys). PRIVACY RULES, enforced in code:
//  - no chat history sync, no contacts/chats stored, incoming messages from others are ignored
//  - the bot can send ONLY to the 4 channel JIDs (+ its own self-chat for command replies)
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
  generateMessageIDV2,
  getBinaryNodeChild,
  getBinaryNodeChildren,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const cfg = require('./config');
const { useMongoAuthState } = require('./auth');
const { getKV, setKV } = require('./db');

const logger = pino({ level: 'warn' });
const state = { sock: null, ready: false, pairingCode: null, channelJids: {}, selfJid: null, onCommand: null };
const allowed = new Set(); // whitelist of JIDs we are allowed to send to

async function resolveChannels() {
  for (const ch of cfg.CHANNELS) {
    let jid = await getKV(`jid:${ch.key}`);
    if (!jid) {
      const meta = await state.sock.newsletterMetadata('invite', ch.waInvite);
      jid = meta && meta.id;
      if (jid) await setKV(`jid:${ch.key}`, jid);
    }
    if (jid) {
      state.channelJids[ch.key] = jid;
      allowed.add(jid);
    } else console.error('Could not resolve channel', ch.key);
  }
}

async function start() {
  const auth = await useMongoAuthState();
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    auth: auth.state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false, // never download personal chat history
    generateHighQualityLinkPreview: false,
    getMessage: async () => undefined,
    // low RAM (Render free 512 MB) + privacy: no app-state/contacts/chats kept in memory or DB
    fireInitQueries: false,
    emitOwnEvents: false,
    linkPreviewImageThumbnailWidth: 0,
  });
  state.sock = sock;
  sock.ev.on('creds.update', auth.saveCreds);

  // first-time link with an 8-letter pairing code (WhatsApp > Linked devices > Link with phone number)
  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        state.pairingCode = await sock.requestPairingCode(cfg.WA_PHONE);
        console.log('PAIRING CODE:', state.pairingCode);
      } catch (e) {
        console.error('pairing code error', e.message);
      }
    }, 4000);
  }

  sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      state.pairingCode = null;
      state.selfJid = jidNormalizedUser(sock.user.id);
      allowed.add(state.selfJid);
      await resolveChannels();
      state.ready = true;
      console.log('WhatsApp connected as', state.selfJid, 'channels:', Object.keys(state.channelJids).join(','));
    }
    if (connection === 'close') {
      state.ready = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('Logged out from phone. Clearing session; a new pairing code will be generated.');
        await auth.clear();
      }
      setTimeout(start, code === DisconnectReason.loggedOut ? 5000 : 3000);
    }
  });

  // Only look at messages the owner writes in the bot number's OWN self-chat. Everything else is dropped unread.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !state.selfJid || !state.onCommand) return;
    for (const m of messages) {
      const jid = m.key.remoteJid && jidNormalizedUser(m.key.remoteJid);
      if (!m.key.fromMe || jid !== state.selfJid) continue;
      const text = m.message?.conversation || m.message?.extendedTextMessage?.text || '';
      if (text.startsWith('/')) {
        const reply = await state.onCommand(text.trim());
        if (reply) await send(state.selfJid, reply);
      }
    }
  });
}

async function send(jid, text) {
  if (!allowed.has(jid)) throw new Error('BLOCKED: sending allowed only to own channels'); // hard privacy lock
  if (!state.ready) throw new Error('WhatsApp not connected');
  return state.sock.sendMessage(jid, { text });
}

const sendToChannel = (key, text) => send(state.channelJids[key], text);

// wait for WhatsApp's server ack of one stanza id: resolves ack attrs ({ server_id } or { error }) or null on timeout
function waitAck(id, ms) {
  return new Promise((resolve) => {
    const ws = state.sock.ws;
    const h = (node) => {
      if (node && node.attrs && node.attrs.id === id) { clearTimeout(t); ws.off('CB:ack,class:message', h); resolve(node.attrs); }
    };
    const t = setTimeout(() => { ws.off('CB:ack,class:message', h); resolve(null); }, ms);
    ws.on('CB:ack,class:message', h);
  });
}

// Native channel QUIZ poll. Hard lock: only the 4 resolved channel JIDs (@newsletter), never a person or the self-chat.
async function sendQuiz(key, bytes) {
  const jid = state.channelJids[key];
  if (!jid || !allowed.has(jid) || !/@newsletter$/.test(jid)) throw new Error('BLOCKED: quiz allowed only to own channels');
  if (!state.ready) throw new Error('WhatsApp not connected');
  const id = generateMessageIDV2(state.sock.user && state.sock.user.id);
  const ackP = waitAck(id, 20000);
  await state.sock.sendNode({
    tag: 'message',
    attrs: { to: jid, id, type: 'poll' },
    content: [
      { tag: 'meta', attrs: { polltype: 'quiz_creation', contenttype: 'text' } },
      { tag: 'plaintext', attrs: {}, content: bytes },
    ],
  });
  const ack = await ackP;
  if (ack && ack.error) throw new Error(`quiz rejected by WhatsApp (ack error ${ack.error})`);
  return { id, acked: !!ack, serverId: (ack && ack.server_id) || null };
}

// ---- Native channel IMAGE post (Baileys 6.7.24 uploads channel media to /mms/image and sends type="text" without
// mediatype, which WhatsApp rejects/breaks). Same flow as WhatsApp Web / maintained forks: raw (unencrypted) upload to
// /newsletter/newsletter-image, then <message type="media"><plaintext mediatype="image">Message{imageMessage}</plaintext>.
// Hard lock: only the 4 resolved channel JIDs (@newsletter).
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function uploadNewsletterImage(jpeg) {
  const sha = require('crypto').createHash('sha256').update(jpeg).digest();
  const token = b64url(sha);
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const conn = await state.sock.refreshMediaConn(attempt > 0);
    for (const { hostname } of conn.hosts || []) {
      try {
        const url = `https://${hostname}/newsletter/newsletter-image/${token}?auth=${encodeURIComponent(conn.auth)}&token=${token}&server_thumb_gen=1`;
        const res = await fetch(url, { method: 'POST', body: jpeg, headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://web.whatsapp.com' }, signal: AbortSignal.timeout(30000) });
        const j = await res.json().catch(() => null);
        if (j && (j.url || j.direct_path)) {
          return { url: j.url || j.direct_path, directPath: j.direct_path, sha, thumb: j.thumbnail_info || null };
        }
        lastErr = new Error(`upload ${res.status} ${JSON.stringify(j || {}).slice(0, 80)}`);
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('upload: no media hosts');
}
async function sendChannelImage(key, img, caption) {
  const jid = state.channelJids[key];
  if (!jid || !allowed.has(jid) || !/@newsletter$/.test(jid)) throw new Error('BLOCKED: image allowed only to own channels');
  if (!state.ready) throw new Error('WhatsApp not connected');
  const up = await uploadNewsletterImage(img.jpeg);
  const { proto } = require('@whiskeysockets/baileys');
  const msg = proto.Message.encode({
    imageMessage: {
      url: up.url, directPath: up.directPath, mimetype: 'image/jpeg', fileSha256: up.sha, fileLength: img.jpeg.length,
      width: img.width, height: img.height, caption, jpegThumbnail: img.thumb,
      ...(up.thumb && up.thumb.thumbnail_direct_path ? { thumbnailDirectPath: up.thumb.thumbnail_direct_path, thumbnailSha256: up.thumb.thumbnail_sha256 ? Buffer.from(up.thumb.thumbnail_sha256, 'base64') : undefined } : {}),
    },
  }).finish();
  const id = generateMessageIDV2(state.sock.user && state.sock.user.id);
  const ackP = waitAck(id, 20000);
  await state.sock.sendNode({ tag: 'message', attrs: { to: jid, id, type: 'media' }, content: [{ tag: 'plaintext', attrs: { mediatype: 'image' }, content: Buffer.from(msg) }] });
  const ack = await ackP;
  if (ack && ack.error) throw new Error(`image rejected by WhatsApp (ack error ${ack.error})`);
  if (!ack) throw new Error('image: no server ack in 20 s');
  return { id, serverId: ack.server_id || null };
}

// read back the latest posts of OUR channel (channel content only) -> raw plaintext bytes per post
async function fetchChannelPosts(key, count = 5) {
  const jid = state.channelJids[key];
  if (!jid || !/@newsletter$/.test(jid)) throw new Error('not one of our channels');
  if (!state.ready) throw new Error('WhatsApp not connected');
  const res = await state.sock.newsletterFetchMessages(jid, count);
  const box = getBinaryNodeChild(res, 'message_updates') || getBinaryNodeChild(res, 'messages') || res;
  const msgs = getBinaryNodeChildren(getBinaryNodeChild(box, 'messages') || box, 'message');
  return msgs.map((m) => {
    const pt = getBinaryNodeChild(m, 'plaintext');
    return { serverId: m.attrs.server_id, type: m.attrs.type, t: m.attrs.t, bytes: pt && pt.content ? Buffer.from(pt.content) : null };
  });
}
// owner alerts go ONLY to the bot number's own self-chat
const sendSelf = (text) => send(state.selfJid, text);

module.exports = { start, state, sendToChannel, sendSelf, sendQuiz, sendChannelImage, uploadNewsletterImage, fetchChannelPosts, resolveChannels };
