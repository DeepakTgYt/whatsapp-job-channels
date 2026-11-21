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
  ],
  // Official site per organisation, used as "Official Website" link on Telegram-derived cards when the title names it
  ORG_SITES: [
    { re: /\bSSC\b|Staff Selection/i, url: 'https://ssc.gov.in/' },
    { re: /\bRRB\b|Railway Recruitment|\bNTPC\b|Group D|\bALP\b/i, url: 'https://www.rrbapply.gov.in/' },
    { re: /\bRPF\b/i, url: 'https://www.rrbapply.gov.in/' },
    { re: /\bBPSC\b/i, url: 'https://bpsc.bihar.gov.in/' },
    { re: /\bBSSC\b/i, url: 'https://bssc.bihar.gov.in/' },
    { re: /\bCSBC\b|Bihar Police Constable/i, url: 'https://csbc.bihar.gov.in/' },
    { re: /\bBPSSC\b|Bihar Police SI|Daroga/i, url: 'https://bpssc.bihar.gov.in/' },
    { re: /\bBTSC\b/i, url: 'https://btsc.bihar.gov.in/' },
    { re: /Agniveer Vayu|Air ?Force/i, url: 'https://agnipathvayu.cdac.in/' },
    { re: /Navy/i, url: 'https://www.joinindiannavy.gov.in/' },
    { re: /Army|Agniveer/i, url: 'https://joinindianarmy.nic.in/' },
  ],
  // Domains treated as official (government or the boards' own application portals)
  OFFICIAL_DOMAIN: /(\.gov\.in|\.nic\.in|\.gov|cdac\.in|apply-csbc\.com|apply-bpssc\.com|onlinebssc\.com|digialm\.com|ibps\.in)$/i,
  // Third-party aggregators: never linked, never copied
  AGGREGATOR: /sarkari|freejobalert|jagranjosh|adda247|testbook|rojgar|naukri|jobriya|sarkarinaukri|indgovtjobs|resultbharat/i,
};
