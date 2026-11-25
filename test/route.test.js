// Unit tests (no DB, no network): channel routing, card status vs title, share line, auto label.
// Run: node test/route.test.js
const assert = require('assert');
const tp = require('../src/thirdparty');
const fmt = require('../src/format');

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log('ok  -', name); };

// ---- 1. routing with real titles ----
const ROUTES = [
  ['IWST Recruitment 2026 – Apply Offline for 10 MTS, LDC, Technical Assistant Posts', null], // generic institute: not SSC
  ['HBCH&RC Muzaffarpur Recruitment 2026 – Walkin for 18 MTS, Technician and More Posts', 'bihar'], // Bihar-located
  ['SSB Odisha Junior Assistant and Clerk Admit Card 2026 Out - Download CBT Hall Ticket', null], // Odisha state board: not Army
  ['UPSC NDA/ NA-I Recruitment 2027', 'army'],
  ['GMC Akola Group D Recruitment 2026 – Apply Online for 101 Peon, Watchman and More Posts', null], // municipal Group D: not Railway
  ['SHS Bihar Recruitment 2025 - Apply Online for 1075 Laboratory Technician Posts', 'bihar'],
  // controls (must keep working)
  ['SSC GD Constable Recruitment 2026 – Apply Online for 25487 Posts', 'ssc'],
  ['SSC MTS Admit Card 2026', 'ssc'],
  ['SSC CPO SI CAPF Admit Card 2026', 'ssc'], // recruiter is SSC even for CAPF posts
  ['Goa SSC 722 Various Vacancies Online Form 2026', null], // state SSC
  ['RRB NTPC Graduate Level Result 2026', 'railway'],
  ['RRC Central Railway Act Apprentice Recruitment 2026', 'railway'],
  ['Indian Army Agniveer Rally Odisha 2026', 'army'],
  ['SSB Constable Tradesman Recruitment 2026', 'army'],
  ['BSF Head Constable Recruitment 2026', 'army'],
  ['Bihar SSC Inter Level Admit Card 2026', 'bihar'],
  ['BPSC TRE 4.0 Result 2026', 'bihar'],
  ['Odisha SSC CGL Recruitment 2026', null],
  ['UP Police Constable Recruitment 2026', null],
];
for (const [title, want] of ROUTES) t(`route "${title.slice(0, 50)}" -> ${want}`, () => assert.strictEqual(tp.routeChannel(title), want));
// classifyItem (channel + type) for the real titles
t('classify HBCH walk-in = bihar vacancy', () => assert.deepStrictEqual(tp.classifyItem(ROUTES[1][0]), { channel: 'bihar', type: 'vacancy' }));
t('classify SHS Bihar = bihar vacancy', () => assert.deepStrictEqual(tp.classifyItem(ROUTES[5][0]), { channel: 'bihar', type: 'vacancy' }));
t('classify UPSC NDA = army vacancy', () => assert.deepStrictEqual(tp.classifyItem(ROUTES[3][0]), { channel: 'army', type: 'vacancy' }));
for (const i of [0, 2, 4]) t(`classify skips "${ROUTES[i][0].slice(0, 30)}"`, () => assert.strictEqual(tp.classifyItem(ROUTES[i][0]), null));
t('bihar listing hint still works, but not for other states', () => {
  assert.strictEqual(tp.routeChannel('ICDS Supervisor Recruitment 2026', 'bihar'), 'bihar');
  assert.strictEqual(tp.routeChannel('Jharkhand ICDS Supervisor Recruitment 2026', 'bihar'), null);
});

// ---- 2. status line matches the title ----
const card = (title, status, extra = {}) => fmt.renderCard({ type: 'vacancy', title, facts: { last: '04 Dec 2026', status }, links: [{ url: 'https://example.gov.in/apply/form', label: 'Apply' }], ...extra }, 'bihar');
t('offline title -> "Offline aavedan", never "Online aavedan chalu hai"', () => {
  const c = card('IWST Recruitment 2026 – Apply Offline for 10 MTS, LDC, Technical Assistant Posts', '🟢 Online aavedan chalu hai');
  assert(!/Online aavedan/i.test(c)); assert(c.includes('📮 Offline aavedan')); assert(!c.includes('Apply Online:')); assert(c.includes('📝 Application Form'));
});
t('walk-in title -> "Walk-in interview"', () => {
  const c = card('HBCH&RC Muzaffarpur Recruitment 2026 – Walkin for 18 MTS, Technician and More Posts', '🟢 Online aavedan chalu hai');
  assert(!/Online aavedan/i.test(c)); assert(c.includes('🚶 Walk-in interview'));
});
t('walk-in via data.mode (title already shortened)', () => assert(card('HBCH&RC Muzaffarpur Recruitment 2026 (18 Posts)', null, { mode: 'walkin' }).includes('🚶 Walk-in interview')));
t('online title keeps online status', () => {
  const c = card('SHS Bihar Recruitment 2025 - Apply Online for 1075 Laboratory Technician Posts', '🟢 Online aavedan chalu hai');
  assert(c.includes('Online aavedan chalu hai')); assert(c.includes('✍️ Apply Online'));
});
t('non-vacancy status untouched', () => assert.strictEqual(fmt.fixStatus('Result out', 'walkin', 'result'), 'Result out'));

// ---- 3 + 5. share line once, auto label in footer, no aggregator names ----
t('share line exactly once + auto label + no channel links in post', () => {
  const c = card('SSC GD Constable Recruitment 2026', null);
  assert.strictEqual(c.split('📲 Forward karein, kisi ka form na chhoote').length - 1, 1);
  assert(c.includes('🤖 _Auto update_')); assert(!c.includes('whatsapp.com/channel')); assert(!c.includes('t.me/'));
});
t('footer has auto label once', () => assert.strictEqual(fmt.footer('ssc').split('Auto update').length - 1, 1));
t('aggregator links never on card', () => {
  const c = fmt.renderCard({ type: 'vacancy', title: 'BPSC TRE Recruitment 2026', facts: {}, links: [{ url: 'https://www.sarkariresult.com/x', label: 'x' }, { url: 'https://www.freejobalert.com/y', label: 'y' }, { url: 'https://bpsc.bihar.gov.in/a.pdf', label: 'Notification' }] }, 'bihar');
  assert(!/sarkari|freejobalert/i.test(c));
});
t('ORG lookup: municipal Group D is not RRB', () => assert(!/RRB/.test(JSON.stringify(require('../src/config').ORG_SITES.find((s) => s.re.test('GMC Akola Group D Recruitment 2026')) || {}))));
console.log(`\n${pass} tests passed`);
process.exit(0);
