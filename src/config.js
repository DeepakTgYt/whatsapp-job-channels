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
  POLL_MINUTES: Number(env('POLL_MINUTES', 10)),       // check Telegram every N minutes
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
};
