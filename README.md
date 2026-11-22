# WhatsApp Job Channels Bot

Telegram job channels (SSC, Railway, Bihar, Army/Agniveer) se sirf **job notifications** utha kar 4 WhatsApp Channels par khud post karta hai. Quiz kabhi WhatsApp par nahi jata.

## Features
- **Teen source, Telegram optional:** (1) official sarkari sites, (2) job-listing websites sirf *detection* ke liye (naya job pata chalte hi uske detail page se sirf facts: org, post, vacancy, dates, fee, age, qualification + **official links** (gov.in / nic.in / board ki apni site) lekar apna card banata hai; un sites ka link ya naam kabhi post mein nahi jata, unka text copy nahi hota), (3) Telegram (optional, `TELEGRAM_ENABLED=false` se band). Posting kisi ek source par depend nahi.
- Web sources (har 10 min + jitter, `THIRDPARTY_POLL_MINUTES`): freejobalert (railway / police-defence / ssc / bihar / new-updates pages) + sarkariresult homepage (primary), sarkariexam homepage (extra fallback). Pehli baar sab "seen" (flood nahi), har round max 3 detail page per site / 8 total, ETag / If-Modified-Since, 1.5 MB size cap. Quiz / PYQ / mock test / tender / cut-off / senior PSU posts / chhoti local bharti (<5 post, badi body nahi) skip. Official link na mile to recognised body ki official website; wo bhi na ho to post nahi.
- Channel keyword se: RRB/RRC/RPF/Railway → Railway; Agniveer/Army/Navy/Air Force/Coast Guard/NDA/CDS → Army; Bihar/BPSC/BSSC/CSBC/BPSSC/BTSC → Bihar; SSC → SSC.
- `/health` mein har source (`web:*`, `official:*`, `telegram:*`) ka lastSuccessAt, consecutiveFails, lastError (asli wajah jaise `fetch failed [UND_ERR_CONNECT_TIMEOUT]`). `ok` = WhatsApp connected + koi official/web source chal raha ho (Telegram fail hone se `ok:false` nahi hota).
- Render par IPv4 pehle (`dns.setDefaultResultOrder('ipv4first')`), kyunki "fetch failed" aksar IPv6 route na hone se aata hai.
- **Do source (backup):** Telegram har 3 min (`POLL_MINUTES`) + official sarkari sites har 10 min (`OFFICIAL_POLL_MINUTES`, thoda random jitter). Telegram band ho jaye to bhi official sites se post chalte rahenge.
- Official sources (plain HTTP se test kiye, 2026-11-21):
  - SSC: ssc.gov.in ka apna JSON API (Notice Board, Results, Answer Key, Admit Card) — 4 alag endpoints
  - Bihar: bpsc.bihar.gov.in, csbc.bihar.gov.in, bpssc.bihar.gov.in, btsc.bihar.gov.in
  - Railway + Army/Agniveer: abhi koi official site server se nahi khulti (RRB/Army/Navy/Agniveer sites timeout / India ke bahar block / sirf JS). Ye do channels Telegram se chalte hain. Dropped list `config.js > DROPPED_SOURCES` mein.
  - Aggregator sites (sarkariresult, freejobalert waghera) se kuch copy nahi hota, unke link bhi hata diye jaate hain.
- Pehli baar official site padhne par purane notices "seen" maan liye jaate hain (channel flood nahi hota)
- Type: vacancy / admit / result / answerkey / examdate / syllabus. Tender, RTI, fake-news, refund jaise notices skip.
- Same job do baar nahi: title hash + official link + milta-julta title (5 din) se dedup, jo source pehle aaye wahi post
- Naya stylish card (sab posts ke liye): emoji header, bold title, quote-box mein Post/Start/Last date/Fee/Age, phir *🔗 Official Links* (official link sabse upar), chhota footer. ~1500 char se kam.
- Nayi post turant bhejta hai (quiet hours ke bahar), `MIN_GAP_SECONDS` ka gap rakhta hai
- Sirf job posts: New Vacancy, Admit Card, Result, Answer Key, Exam Date, Syllabus
- Duplicate block (same title dobara nahi)
- Raat 10 baje se subah 6 tak koi post nahi (queue, subah bhejta hai)
- Anti-spam: har channel max 6 post/ghanta, har post ke beech gap
- Subah 8 baje digest + jaldi band hone wale forms
- Last date se 3 din aur 1 din pehle reminder (shaam 6 baje)
- Sunday shaam 7 baje weekly roundup
- Har post ke neeche baaki channels + Telegram ke links
- WhatsApp login MongoDB mein save, restart par logout nahi

## Privacy lock (code mein)
- Purani chats sync nahi, contacts save nahi, kisi ki chat nahi padhta
- Sirf apne 4 channels par bhej sakta hai; kisi insaan/group ko message block
- Commands sirf bot number ki apni "Message yourself" chat mein

## Health & backup
- `GET /health` (public, koi secret/personal data nahi, hamesha HTTP 200): `{ok, waConnected, paused, lastPostAt, queueLength, dbSizeMB, sources:[{name,lastSuccessAt,consecutiveFails}], lastError}`. WhatsApp disconnect ho to `ok:false`.
- Har source ki health (last success, lagatar fail) `/status` mein. Koi source 6+ baar lagatar fail ho to bot **sirf apni self-chat** mein ek alert bhejta hai.
- `GET /backup?key=ADMIN_KEY` → posts/kv/dedup/health ka JSON download (WhatsApp login data `wa_auth` kabhi nahi).

## Free-tier budget (sab free accounts)
- **MongoDB Atlas M0 (512 MB):** posts 60 din baad auto-delete (TTL), dedup ke liye sirf chhota hash/link record 180 din, queue 7 din, pending queue max 300, roz 03:00 safai. DB size `/status` aur `/health` mein; 350 MB se upar jaye to ek self-chat alert.
- **Render free web service:** 750 instance-hours/month milte hain. Ek always-on service = ~720-744 ghante, isliye ye tabhi kaafi hai jab **is account par ye akela free service ho**. Dusra free service mat banayein.
- **RAM 512 MB:** `--max-old-space-size=380`, Baileys mein history sync off, chats/contacts store nahi, online status off.
- **Bandwidth:** official sites par ETag / If-Modified-Since (badla nahi to 304, kuch download nahi), 15s timeout, SSC API se sirf 15 items. Telegram preview ~100 KB x 4 channels har 3 min ≈ 6 GB/month (Render free 100 GB ke andar).

## Commands (bot number ki self-chat mein likhein)
/status /pause /resume /check /digest /remind /post <ssc|railway|bihar|army> <msg> /clearqueue /errors

## Deploy (Render free)
1. Render → New → Blueprint → is repo ko chunein (render.yaml)
2. Env var `MONGODB_URI` daalein
3. Deploy ke baad `https://<app>.onrender.com/pair?key=<ADMIN_KEY>` kholein, pairing code phone par daalein
   (WhatsApp → Linked devices → Link a device → Link with phone number instead)
4. Keep-alive: har 10 min `https://<app>.onrender.com/health` ping (Cloudflare Worker cron)
