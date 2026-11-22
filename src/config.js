// All settings in one place. Secrets come from environment variables (set on Render).
const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);

module.exports = {
  PORT: Number(env('PORT', 10000)),
  MONGODB_URI: env('MONGODB_URI', ''),
  DB_NAME: env('DB_NAME', 'wa_job_bot'),
  // WhatsApp number that runs the channels (secondary SIM), digits only with country code
  WA_PHONE: env('WA_PHONE', '918651052069'),
  // Protects /pair and /status pages:  /pair?key=ADMIN_KEY
  ADMIN_KEY: env('ADMIN_KEY', ''),
  TZ: 'Asia/Kolkata',

  // Telegram source  ->  WhatsApp channel (one-to-one)
  CHANNELS: [
    {
      key: 'ssc',
      name: 'SSC',
      telegram: 'SSC_Job_Alert',
      waInvite: '0029Vb9VUSy9cDDQpbmHcT15',
      tags: '#SSC',
    },
    {
      key: 'railway',
      name: 'Railway',
      telegram: 'Railway_Job_Notification_Quiz',
      waInvite: '0029Vb919ogC6ZvZ8UUMau12',
      tags: '#Railway',
    },
    {
      key: 'bihar',
      name: 'Bihar',
      telegram: 'Bihar_Job_Notification_Quiz',
      waInvite: '0029VbDvnTRFy724DWDi473m',
      tags: '#Bihar',
    },
    {
      key: 'army',
      name: 'Army/Agniveer',
      telegram: 'Army_Agniveer_Bharti_Alert',
      waInvite: '0029VbEm365GzzKXqXiBYu2f',
      tags: '#Agniveer',
    },
  ],

  // Behaviour (all times IST)
  POLL_MINUTES: Number(env('POLL_MINUTES', 3)),        // check Telegram every N minutes (fastest source)
  OFFICIAL_POLL_MINUTES: Number(env('OFFICIAL_POLL_MINUTES', 10)), // check official sites every N min (+ random jitter)
  OFFICIAL_MAX_AGE_DAYS: Number(env('OFFICIAL_MAX_AGE_DAYS', 30)), // ignore official notices dated older than this
  HTTP_TIMEOUT_MS: Number(env('HTTP_TIMEOUT_MS', 15000)),
  USER_AGENT: 'Mozilla/5.0 (compatible; JobAlertBot/1.0; +https://github.com/DeepakTgYt/whatsapp-job-channels)',
  ALERT_AFTER_FAILS: 6,                                 // self-chat alert after N failures in a row (once)
  // Free-tier guards (MongoDB Atlas M0 = 512 MB)
  POSTS_TTL_DAYS: 60,                                   // full post docs kept 60 days
  DEDUP_TTL_DAYS: 180,                                  // compact hash/link records kept 180 days
  QUEUE_TTL_DAYS: 7,                                    // queue items auto-deleted after 7 days
  QUEUE_MAX_PENDING: 300,                               // hard cap on pending queue
  DB_ALERT_MB: 350,                                     // self-chat alert once if data above this
  MAX_ERRORS: 200,
  QUIET_START: Number(env('QUIET_START', 22)),          // no posts from 22:00 ...
  QUIET_END: Number(env('QUIET_END', 6)),               // ... to 06:00 (queued, sent in the morning)
  MAX_POSTS_PER_HOUR: Number(env('MAX_POSTS_PER_HOUR', 6)), // per channel, anti-spam
  MIN_GAP_SECONDS: Number(env('MIN_GAP_SECONDS', 90)),  // gap between any two sends
  DIGEST_HOUR: Number(env('DIGEST_HOUR', 8)),           // morning digest 08:00
  REMINDER_HOUR: Number(env('REMINDER_HOUR', 18)),      // last-date reminders 18:00
  REMINDER_DAYS: [3, 1],                                // remind 3 days and 1 day before last date
  WEEKLY_DAY: 0,                                        // Sunday
  WEEKLY_HOUR: Number(env('WEEKLY_HOUR', 19)),          // weekly roundup 19:00

  // Only these post types are mirrored. Quiz/polls are NEVER posted to WhatsApp.
  JOB_MARKERS: [
    { re: /NEW VACANCY|नई भर्ती/i, type: 'vacancy', head: '🆕 *नई भर्ती | NEW VACANCY*' },
    { re: /ADMIT CARD|एडमिट कार्ड/i, type: 'admit', head: '🎫 *एडमिट कार्ड | ADMIT CARD*' },
    { re: /RESULT|रिजल्ट|परिणाम/i, type: 'result', head: '🏆 *रिजल्ट | RESULT*' },
    { re: /ANSWER KEY|आंसर की|उत्तर कुंजी/i, type: 'answerkey', head: '🔑 *आंसर की | ANSWER KEY*' },
    { re: /EXAM DATE|परीक्षा तिथि/i, type: 'examdate', head: '🗓️ *परीक्षा तिथि | EXAM DATE*' },
    { re: /SYLLABUS|सिलेबस/i, type: 'syllabus', head: '📚 *सिलेबस | SYLLABUS*' },
  ],
  QUIZ_BLOCK: /quiz|क्विज|PYQ|सवाल|poll/i,

  // ---- Official government sources (2nd, independent source; tested with plain HTTP from a server) ----
  // type 'ssc-api' = JSON API used by ssc.gov.in's own frontend; 'html' = static page with a notice list.
  // Every source is polled each round; if one fails the others (and Telegram) keep the channel alive.
  OFFICIAL_SOURCES: [
    { id: 'ssc-notice', channel: 'ssc', org: 'Staff Selection Commission (SSC)', kind: 'ssc-api', contentType: 'notice-boards', path: 'notice-boards', home: 'https://ssc.gov.in/' },
    { id: 'ssc-result', channel: 'ssc', org: 'Staff Selection Commission (SSC)', kind: 'ssc-api', contentType: 'results', path: 'records', home: 'https://ssc.gov.in/', forceType: 'result' },
    { id: 'ssc-answerkey', channel: 'ssc', org: 'Staff Selection Commission (SSC)', kind: 'ssc-api', contentType: 'answer-key', path: 'records', home: 'https://ssc.gov.in/', forceType: 'answerkey' },
    { id: 'ssc-admit', channel: 'ssc', org: 'Staff Selection Commission (SSC)', kind: 'ssc-api', contentType: 'admit-card', path: 'records', home: 'https://ssc.gov.in/', forceType: 'admit' },
    { id: 'bpsc', channel: 'bihar', org: 'Bihar Public Service Commission (BPSC)', kind: 'html', url: 'https://bpsc.bihar.gov.in/', home: 'https://bpsc.bihar.gov.in/' },
    { id: 'csbc', channel: 'bihar', org: 'Central Selection Board of Constable (CSBC), Bihar', kind: 'html', url: 'https://csbc.bihar.gov.in/', home: 'https://csbc.bihar.gov.in/' },
    { id: 'bpssc', channel: 'bihar', org: 'Bihar Police Subordinate Services Commission (BPSSC)', kind: 'html', url: 'https://bpssc.bihar.gov.in/', home: 'https://bpssc.bihar.gov.in/' },
    { id: 'btsc', channel: 'bihar', org: 'Bihar Technical Service Commission (BTSC)', kind: 'html', url: 'https://btsc.bihar.gov.in/', home: 'https://btsc.bihar.gov.in/' },
  ],
  // Tested 2026-11-21 and NOT used (connection timeout / blocked outside India / JS-only). Railway & Army run on Telegram only.
  DROPPED_SOURCES: [
    'rrbcdg.gov.in, rrbapply.gov.in, indianrailways.gov.in, rrb<zone>.gov.in, rpf.indianrailways.gov.in: timeout/blocked or JS-only (rrbapply returns an Angular shell, assets 404)',
    'joinindianarmy.nic.in, indianarmy.nic.in, agnipathvayu.cdac.in, joinindiannavy.gov.in, indiannavy.nic.in, indianairforce.nic.in, territorialarmy.in: connection timeout',
    'bssc.bihar.gov.in, onlinebssc.com, state.bihar.gov.in: connection timeout',
    'employmentnews.gov.in, mod.gov.in: JS-rendered, no notice list in HTML',
    'third-party (2026-11-22): rojgarresult.com home 301->403 for non-browser UA, feed 290 KB/4 s; sarkariexam.com/feed 900 KB full-text RSS (too heavy; homepage used instead); sarkarinaukriblog.com feed is not in date order (old posts re-surface); freejobalert.com/feed 403',
  ],
  // Official site (+ full name) per organisation. Used as "Official Website" link when a post names the body
  // and as the fallback link on third-party-detected cards when no official link was found on the detail page.
  ORG_SITES: [
    { re: /\bBSSC\b|Bihar Staff Selection/i, url: 'https://bssc.bihar.gov.in/', name: 'Bihar Staff Selection Commission (BSSC)' },
    { re: /\bSSC\b|Staff Selection/i, url: 'https://ssc.gov.in/', name: 'Staff Selection Commission (SSC)' },
    { re: /\bRPF\b|Railway Protection Force/i, url: 'https://www.rrbapply.gov.in/', name: 'Railway Protection Force (RPF)' },
    { re: /\bRRC\b|Railway Recruitment Cell/i, url: 'https://indianrailways.gov.in/', name: 'Railway Recruitment Cell (RRC), Indian Railways' },
    { re: /\bRRB\b|Railway Recruitment Board|Railway NTPC|RRB NTPC|Group D|\bALP\b/i, url: 'https://www.rrbapply.gov.in/', name: 'Railway Recruitment Board (RRB)' },
    { re: /\bBPSC\b|Bihar Public Service/i, url: 'https://bpsc.bihar.gov.in/', name: 'Bihar Public Service Commission (BPSC)' },
    { re: /\bCSBC\b|Bihar Police Constable/i, url: 'https://csbc.bihar.gov.in/', name: 'Central Selection Board of Constable (CSBC), Bihar' },
    { re: /\bBPSSC\b|Bihar Police SI|Daroga/i, url: 'https://bpssc.bihar.gov.in/', name: 'Bihar Police Subordinate Services Commission (BPSSC)' },
    { re: /\bBTSC\b|Bihar Technical Service/i, url: 'https://btsc.bihar.gov.in/', name: 'Bihar Technical Service Commission (BTSC)' },
    { re: /Coast Guard|\bICG\b/i, url: 'https://joinindiancoastguard.cdac.in/', name: 'Indian Coast Guard' },
    { re: /Territorial Army/i, url: 'https://territorialarmy.in/', name: 'Territorial Army' },
    { re: /Agniveer Vayu|Air ?Force|\bIAF\b|AFCAT|Airmen/i, url: 'https://agnipathvayu.cdac.in/', name: 'Indian Air Force' },
    { re: /Navy|Naval/i, url: 'https://www.joinindiannavy.gov.in/', name: 'Indian Navy' },
    { re: /Army|Agniveer|\bTGC\b|\bTES\b/i, url: 'https://joinindianarmy.nic.in/', name: 'Indian Army' },
    { re: /\bUPSC\b.*\b(NDA|CDS)\b|\b(NDA|CDS)\b/i, url: 'https://upsc.gov.in/', name: 'Union Public Service Commission (UPSC)' },
  ],

  // ---- Third-party job-listing sites: DETECTION ONLY (3rd, independent source) ----
  // Facts + official links are read from the detail page; our own card is written; the site is never linked
  // or named in a post. Tested with plain HTTP 2026-11-22. Note: the UA must not contain a URL (Cloudflare
  // on one site blocks UAs with "+http..." / "bot" words), so it is a short honest product token.
  THIRDPARTY_ENABLED: env('THIRDPARTY_ENABLED', 'true') !== 'false',
  THIRDPARTY_POLL_MINUTES: Number(env('THIRDPARTY_POLL_MINUTES', 10)), // + up to 2 min random jitter
  TP_USER_AGENT: 'Mozilla/5.0 (compatible; JobAlertsWA/1.1)',
  TP_MAX_DETAIL_PER_SOURCE: Number(env('TP_MAX_DETAIL_PER_SOURCE', 3)), // detail pages per source per round
  TP_MAX_DETAIL_PER_ROUND: Number(env('TP_MAX_DETAIL_PER_ROUND', 8)),   // all sources together
  TP_MAX_AGE_DAYS: 20,                                                  // listing rows dated older than this are ignored
  // kind 'fja' = listing with article ids + tables; 'home' = homepage section lists (same page re-titled = new update)
  // channel = hint for listings that only carry one state's jobs; every item is still classified by keywords.
  THIRDPARTY_SOURCES: [
    { id: 'fja-railway', kind: 'fja', url: 'https://www.freejobalert.com/railway-jobs/', primary: true },
    { id: 'fja-defence', kind: 'fja', url: 'https://www.freejobalert.com/police-defence-jobs/', primary: true },
    { id: 'fja-ssc', kind: 'fja', url: 'https://www.freejobalert.com/exams/ssc-jobs/', primary: true },
    { id: 'fja-bihar', kind: 'fja', url: 'https://www.freejobalert.com/bihar-government-jobs/', hint: 'bihar', primary: true },
    { id: 'fja-updates', kind: 'fja', url: 'https://www.freejobalert.com/new-updates/', primary: true },
    { id: 'sr-home', kind: 'home', url: 'https://www.sarkariresult.com/', minDepth: 2, primary: true },
    { id: 'se-home', kind: 'home', url: 'https://www.sarkariexam.com/', minDepth: 1 }, // extra fallback
  ],
  TELEGRAM_ENABLED: env('TELEGRAM_ENABLED', 'true') !== 'false', // optional, secondary; posting never depends on it
  // Domains treated as official (government or the boards' own application portals)
  OFFICIAL_DOMAIN: /(\.gov\.in|\.nic\.in|\.gov|cdac\.in|apply-csbc\.com|apply-bpssc\.com|onlinebssc\.com|digialm\.com|ibps\.in)$/i,
  // Third-party aggregators: never linked, never copied
  AGGREGATOR: /sarkari|freejobalert|jagranjosh|adda247|testbook|rojgar|naukri|jobriya|sarkarinaukri|indgovtjobs|resultbharat/i,
};
