// WhatsApp connection (Baileys). PRIVACY RULES, enforced in code:
//  - no chat history sync, no contacts/chats stored, incoming messages from others are ignored
//  - the bot can send ONLY to the 4 channel JIDs (+ its own self-chat for command replies)
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
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

module.exports = { start, state, sendToChannel };
