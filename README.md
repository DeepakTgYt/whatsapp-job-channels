# WhatsApp Job Channels Bot

Telegram job channels (SSC, Railway, Bihar, Army/Agniveer) se sirf **job notifications** utha kar 4 WhatsApp Channels par khud post karta hai. Quiz kabhi WhatsApp par nahi jata.

## Features
- Har 10 min Telegram check, nayi job post WhatsApp format mein (bold, saaf card, official links)
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

## Commands (bot number ki self-chat mein likhein)
/status /pause /resume /check /digest /remind /post <ssc|railway|bihar|army> <msg> /clearqueue /errors

## Deploy (Render free)
1. Render → New → Blueprint → is repo ko chunein (render.yaml)
2. Env var `MONGODB_URI` daalein
3. Deploy ke baad `https://<app>.onrender.com/pair?key=<ADMIN_KEY>` kholein, pairing code phone par daalein
   (WhatsApp → Linked devices → Link a device → Link with phone number instead)
4. Keep-alive: har 10 min `https://<app>.onrender.com/health` ping (Cloudflare Worker cron)
