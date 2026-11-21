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
  app.get('/health', (req, res) => res.json({ ok: true, whatsapp: wa.state.ready, lastPoll: engine.stats.lastPoll }));

  // first-time setup: shows the WhatsApp pairing code
  app.get('/pair', guard, (req, res) => {
    if (wa.state.ready) return res.send('<h2>✅ WhatsApp already connected</h2>');
    res.send(`<meta http-equiv="refresh" content="10"><h2>WhatsApp pairing code</h2>
      <h1 style="font-size:48px;letter-spacing:6px">${wa.state.pairingCode || 'generating… (refreshes)'}</h1>
      <p>Phone par WhatsApp → Linked devices → Link a device → Link with phone number instead → ye code daalein.</p>`);
  });
  app.get('/status', guard, async (req, res) => res.send(`<pre>${await engine.command('/status')}\n\n${await engine.command('/errors')}</pre>`));

  app.listen(cfg.PORT, () => console.log('HTTP on', cfg.PORT));
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
process.on('unhandledRejection', (e) => console.error('unhandled', e && e.message));
