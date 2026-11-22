// Render has no IPv6 egress: Node may try AAAA first and fail with "fetch failed". Prefer IPv4.
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const cfg = require('./config');
const db = require('./db');
const wa = require('./whatsapp');
const engine = require('./engine');

async function main() {
  await db.connect();
  wa.state.onCommand = engine.command;
  await wa.start();
  setInterval(engine.tick, 60 * 1000);
  setTimeout(engine.tick, 15 * 1000);

  const app = express();
  const guard = (req, res, next) =>
    cfg.ADMIN_KEY && req.query.key === cfg.ADMIN_KEY ? next() : res.status(403).send('forbidden');

  // keep-alive / uptime ping target
  app.get('/', (req, res) => res.send('ok'));
  // public, for keep-alive + automated health checks: no secrets, no personal data. Always HTTP 200.
  app.get('/health', async (req, res) => {
    try {
      res.json(await engine.healthReport());
    } catch (e) {
      res.json({ ok: false, waConnected: !!wa.state.ready, error: 'health check failed' });
    }
  });
  // JSON backup of posts/kv/dedup/health (never the WhatsApp login). Download: /backup?key=ADMIN_KEY
  app.get('/backup', guard, async (req, res) => {
    res.setHeader('Content-Disposition', `attachment; filename="wa-job-bot-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json(await db.backup());
  });

  // first-time setup: shows the WhatsApp pairing code
  app.get('/pair', guard, (req, res) => {
    if (wa.state.ready) return res.send('<h2>✅ WhatsApp already connected</h2>');
    res.send(`<meta http-equiv="refresh" content="10"><h2>WhatsApp pairing code</h2>
      <h1 style="font-size:48px;letter-spacing:6px">${wa.state.pairingCode || 'generating… (refreshes)'}</h1>
      <p>Phone par WhatsApp → Linked devices → Link a device → Link with phone number instead → ye code daalein.</p>`);
  });
  // quiz admin over HTTP (same as self-chat): /quiz?key=ADMIN_KEY&cmd=now%20ssc | verify%20ssc | on | off
  app.get('/quiz', guard, async (req, res) => {
    try { res.type('text/plain').send(await engine.quizCommand(String(req.query.cmd || '').toLowerCase())); } catch (e) { res.status(500).type('text/plain').send('quiz error: ' + require('./health').clean(e.message)); }
  });
  app.get('/status', guard, async (req, res) => res.send(`<pre>${await engine.command('/status')}\n\n${await engine.command('/errors')}</pre>`));

  app.listen(cfg.PORT, () => console.log('HTTP on', cfg.PORT));
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => console.error('unhandled', e && e.message));
