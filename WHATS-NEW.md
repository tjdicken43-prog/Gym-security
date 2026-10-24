# What's new (October 20, design polish)

Checked in a real browser on phone and desktop, and against two published design checklists (Impeccable's audit, Emil Kowalski's motion review). Design-checker findings went from 235 to 141; what's left is the look itself (status stripes, cards, the drawn camera scenes) plus a few false alarms.

- **Gym page:** the gym's whole name shows (it was cut to "Maple Street Fitn..."), the step instructions read in plain sentences instead of small capitals, the small print on the answer buttons is easier to read, and keyboard shortcuts no longer show on phones.
- **Sign-in:** the email box and button stack on a phone, so the address isn't cut off.
- **Checkout:** text and boxes match the rest of the site (they were smaller), with proper headings for screen readers.
- **Phones:** typing in any box never zooms the page on an iPhone; footer links are finger-sized.
- **Everywhere:** paragraphs don't end on one lonely word, headlines break evenly, and long text stays a comfortable width on big screens.
- **Browser monitor page:** its top bar and start bar match the site (they were dark, with links you could hardly read).
- **Small fixes:** the sample report's camera label isn't hidden behind the photo count; a shared-photo link opened without its code says so instead of making a failed lookup; the few UI animations use a firmer ease-out.

# What's new (October 19, nothing-to-drive-for pass)

Everything here is about the gym running on its own, so you don't have to drive there.

**Front desk**
- **An account (or another page) left open:** the reader no longer mistakes a member's account for a new scan, on Ashbourne or any taught system. A screen that goes back to something it already showed, or shows an older entry time than the newest one it has seen, is not a scan. One member's own visit history is never taken for the check-in list. If the list stays hidden for 10 minutes, the admin page and the morning report say so ("an account or another page left open?"): pop-ups are still read.
- **A locked, asleep or unplugged front-desk PC never turns into "no scan":** while the reader can't see the screen, entries are checked by the camera only and the gym page says so; the morning report lists the times the screen couldn't be read.
- **Turned-down scans on Ashbourne:** the "Admission Message" box (where Ashbourne writes "Membership Expired") is read too.
- **Old and updated Ashbourne:** tested on the current look (with "Update Available" in the top bar, like J Street today) and on the updated look. Times written "8:21PM" (no space) and long values that run past their label are read correctly; a time whose AM/PM wasn't read is never trusted to throw a scan out.
- **The newer Ashbourne look reads its pop-up too** (values beside their labels instead of under them). Before, only its Visit Log was read there.
- **The first scan after the reader starts** is no longer taken for "what was already on screen" when the pop-up shows a later time than the Visit Log.
- **The pop-up spot is remembered** across restarts, so after a power cut the reader finds it again straight away. The list's spot is watched the same way: when staff come back to the check-in page, new rows are read straight away, not up to 20 seconds later.
- **Other systems:** taught panels only count the panel where it was taught (not a matching label somewhere else on the screen), and only scans for the gym's own zone count.
- **A list that reloads or empties for a moment** never counts its old rows again (a list with times only counts rows newer than anything it showed before, and never a row it already showed). A list whose rows are there but can't be read is looked for again instead of being taken as empty; if it can't be found, the admin page says to teach it again.
- **Teaching:** a big "Welcome, Taylor" name reads cleanly (the comma isn't run into the name), and a list on a dark screen is recognized as a list even when a row or two misread.
- **Tested on every system type so far, old and updated looks:** Ashbourne (current and updated look: normal, pop-up closing, account left open, PC locked, turned-down scan), scan logs (newest at the top or bottom), plain lists, name-only lists and welcome cards, pop-up plus list, dark screens, codes with letters, and a member profile left open. Each was taught on its old look, run on it, then "updated overnight" to a new look without re-teaching. An update that renames things either keeps reading correctly or says "teach it again"; it never makes up scans.

**Camera**
- **The recorder got a new address** (power cut, new router): the camera computer finds it again by its network card (MAC) and updates its own settings. The camera password is only ever sent to that one device.

**Pi and internet**
- **Backup Wi-Fi** (optional, during setup) and a reminder to turn off Tailscale's 6-month key expiry.
- **Spare memory card:** `bash make-spare-card.sh` copies the Pi's card onto a second card in a USB reader. If the card ever dies, swap them.
- **PI-SETUP.md** has a new table: "Fixing things without driving to the gym".

**Daylight saving (Nov 1)**
- The repeated hour is labelled on the gym page: "1:30 AM (first time: clocks went back)" and "(second time)".

# What's new (October 18, polish and speed pass)

- **Turned-down scans don't count:** a check-in the desk refused (denied, expired, frozen, past due...) is no longer counted as a scan, on any system, Ashbourne included. Before, a refused member following someone in could look like "2 people, 2 scans" and hide the tailgate. The admin page shows how many were turned down.
- **Lists without a pop-up keep a member's real second entry** (the "same member within 5 minutes counts once" rule is for re-reading a pop-up, not for a list where each row is its own scan).
- **A screen that keeps changing with nothing new** (a clock ticking inside the watched area) is read at most every 2 seconds after a while, so the Pi isn't busy all night. Scans are still timed to the moment they appeared.
- **Faster website:** pages, scripts and styles go out compressed (the home page is 16 KB instead of 70 KB; the gym page 48 KB instead of 193 KB), and a repeat visit is a tiny "not changed". Fonts are cached for a year, icons for a week.
- **Home page "Try it" rebuilt** as the same overhead camera as the top of the page: people walk through the turnstile, the desk reader blinks on a scan, the counts go up, and the right side shows the actual card your phone gets (with Tailgate / Shared code / It was fine), plus the quiet list of normal entries.
- **Live demo photos** are now the same overhead camera drawing (four photos of the walk-through), and the demo gym and the sample report are the same gym (Maple Street Fitness).
- **Gym page:** the "last 24 hours" strip reads "24 h ago · 12 h ago · Now"; alerts only mention text messages once texting is switched on.
- **Admin page on a phone:** the All gyms overview is a card per gym instead of a table you scroll sideways.
- **Checkout:** cleaner headings, no empty "payment details" box. Setup wording everywhere now matches the real install (a Pi plus a splitter at the front desk).

# What's new (October 18, any front-desk screen)

- **Check-in lists (scan logs):** systems that show scans as a list of check-ins instead of a pop-up are read too, with the newest row at the top or at the bottom (a list that scrolls by itself). Each new row is a scan. The teach step finds it from the one test scan and remembers the column (and its header), never a number or a name.
- **Hand scrolling, other pages, a new day:** staff can scroll the list, scroll back, open other pages and come back, or reload: none of that counts as scans. Another table under the same header (a member directory) is told apart by its column names, and by its missing times. A list that empties at midnight starts fresh.
- **Lists that show times:** the time on each row tells new scans from old rows, and scans that came in while another page was open are still counted when the list comes back. A list that refreshes late is timed by its rows; if it's late most of the time, the admin page says so (turn on the system's live view or auto-refresh).
- **Names instead of numbers:** systems that only show "Welcome, Alex Rivera" (no member number) work. The name is read twice and scrambled on the Pi exactly like a member number: never sent or saved as text.
- **Pop-up and list together:** both are read, and a scan both show is marked confirmed (like Ashbourne's pop-up and Visit Log).
- **A row whose number can't be read is still a scan:** it counts, marked "uncertain", so a misread never turns into a false tailgate alert.
- **Dark screens and member codes with letters** ("GX48210") work too. A code read in the wrong shape gets a close-up second look before it's marked unreadable.
- **iPad front desks:** an HDMI adapter on the iPad goes straight into the capture stick (no splitter). The "Will it work?" page asks iPad or Android, and what the screen shows when a member scans.

# What's new (October 18, ready for gym #2)

- **Any check-in system:** the front-desk screen reader learns a new system from one test scan (`node screen-reader.js --teach` on the Pi). It shows the last 2 digits of the number it spotted and the label next to it; you confirm. Ashbourne reads exactly as before. Each number is read twice, at a size worked out from how big it is on screen; both reads must agree.
- **"Will it work at your gym?"** (`/check`): gym owners tap their recorder brand, camera angle, check-in system and front desk, and see the answer straight away (ready / a quick check / a small change). You get an email, and it's on the admin page under **Gyms that checked**. Linked from the home page and checkout.
- **Close a gym that cancelled** (admin page > the gym > Close this gym): switches off its sign-in code, staff logins, camera computer and reader; deletes photos, entries, alert list, logins and member data; archives the numbers only. **Open it again** gives it a new code. The Stripe "canceled" email links straight to it.
- **Pi setup for new gyms:** no laptop needed (pairs and finds the camera), asks whether the desk is on Ashbourne and runs the teach step if not, protects against power cuts (logs in memory, card repaired at start, restarts itself if frozen), and offers **Tailscale** so you can fix any Pi from your phone.
- **Practice a restore** (admin page > Backup): open a backup file with its password and see what's inside, without changing anything.
- **EMAIL-AND-TEXT.md:** moving alerts to your own domain (Postmark or Resend) and registering for text messages (Twilio). Texts now say "Reply STOP to stop". The home page no longer promises texts until that's done.

# What's new (October 18, admin page per gym)

- **Gym switcher on the admin page:** a bar at the top with **All gyms** and one button per gym (colored dot = its status, red number = things to do). It stays at the top as you scroll.
- **All gyms** shows a table: each gym's health score, camera computer, front-desk reader, last entry, AI checks today and billing, plus the website-wide cards (backup, self-repair, Render settings, add a gym).
- **Tap a gym** and the page shows only that gym: its self-check, its card (settings, test alert, sign-in code, start fresh), connecting its camera computer, its member-number approvals and its technical details.
- The page remembers which gym you were looking at, and the address (…/admin.html#gym=…) can be bookmarked.
- After adding a gym, a button opens it straight away to connect its camera computer.

# What's new (October 17, new look)

- **The whole website has a new look:** concrete grey with weight-plate colors (red = likely got in without paying, yellow = worth a look, green = fine, blue = what you tap), tall gym-sign headlines and a new logo (three turnstile bars, the last one red). Fonts are stored on the website itself, so nothing loads from Google.
- **Home page rebuilt:** "Two people. One scan." with a drawn camera still that plays once, a night strip you can tap, a phone shot of the owner's morning, and a bar on phones with the demo and price once you scroll.
- **Gym page:** last night as a strip at the top; tap a red or yellow bar to jump to that entry. The big line is now "3 to look at". New icons in the phone tab bar.
- **Admin page, checkout, sample report, monthly report, door sign, member notice, terms and the small confirm pages** all match. The front-desk screen and lobby TV stay dark (they're screens on display).
- App icons redone with the new logo.

# What's new (October 17)

- **Start the pilot fresh** (admin page, under each gym): clears test walk-throughs so results start at zero: entries and their photos, staff answers, results, nightly counts, camera problems, this week's spot-check. A copy of the numbers (no photos) is kept on the website's disk. Settings, the alert list, staff logins and camera pairing stay. You type the gym's name to confirm.

# What's new (October 16, cost saving)

- **Skip people leaving (saves AI checks):** the camera computer already sees which way someone walks. Every crossing it sees going clearly OUT is now measured against the AI. After **200 in a row** where the AI agreed (nobody came in), the admin page lets you turn on **Skip clear exits** for that gym.
  - Even when on, 1 in 20 exits still goes to the AI, and anything with a front-desk scan nearby always does.
  - Any disagreement (from the AI, or staff finding someone in the weekly spot-check, which now includes a couple of skipped exits) switches skipping off by itself and emails you. The clean run starts again.
  - Skipped exits are still listed with their photos; they cost nothing and don't count toward the daily limits.
- Self-repair's AI calls are capped at 10 a day (was 40).

# What's new (October 16, later morning)

## Staff answers can't quietly hide a tailgate
- If the camera AND the front-desk scans both show an extra person, answering **It was fine** needs a written reason.
- Those answers go to **Second look** (owner only, on the gym page): photos, what the camera and scans saw, the reason, who answered, and every change to the answer. The owner taps **Agree** or **Change to Tailgate**.
- Owners see a count per person for the last 30 days. Staff never see that count.
- Every answer and change is kept for 35 days (who, what, when): nothing changes silently.
- Accuracy numbers leave these answers out until the owner checks them, so they can't make the camera look wrong. The admin self-check warns at 3 or more.
- The morning email and the monthly report say how many are waiting (no names).
- An owner's own "It was fine" doesn't need a second look.

## Connecting other check-in systems (ABC, Mindbody, ClubReady, ...)
- `checkin-feed.js` takes check-ins straight from the check-in system's web API (or a log file it writes) instead of reading the screen. It runs on the gym's computer and scrambles each member number there, so the website still never sees one.
- Set it up after the normal reader setup: put `checkin-feed.json` in `~/.securityai` (example at the top of `checkin-feed.js`), then `node checkin-feed.js --check`. The camera computer runs it instead of the screen reader from then on.
- What it needs from you: API access from the check-in company (usually through the gym's account or a partner sign-up) and where the member number and time are in their answer.

# What's new (October 16, morning)

- **Spanish for the gym page:** automatic on Spanish phones, or tap **Español** at the bottom (remembered on that phone). Times stay as the check-in system shows them so they still match the front-desk log.
- **Repeat check** (approved phones): "who let someone in more than once" over the kept period. When staff confirm a tailgate and the photos and scans line up exactly, the website notes which scan let them in (an id only). The approved phone opens those scans and counts by member; the website never sees member numbers. "Find a member" also shows a member's confirmed count. Each repeat check is in the owner's access log.
- **Day-pass message:** names the member when this phone is sure who it was; otherwise it reminds staff to send it only when the photos and scan agree.
- **Night mode** (gym settings): during the hours you set (e.g. 22:00-05:00), less certain flags and "maybe a second person" entries also alert, marked "worth a look (night mode)". It only adds alerts; detection never gets looser.
- **All your gyms:** totals across every gym you own (to check, people today, caught this month, $ charged, camera problems) plus each gym's line.

# What's new (October 16, later)

## Settings to add on Render (Environment)

| Setting | What it does | Needed? |
| --- | --- | --- |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Self-serve signup: a paid checkout creates the gym and emails the owner. In Stripe, point the webhook at `https://gym-security.onrender.com/webhook` and send `checkout.session.completed`, `invoice.payment_failed`, `invoice.paid`, `customer.subscription.deleted` | Only when you open online signup |

## For the gym (the gym page)
- **Trends:** confirmed tailgates week by week, entries by hour (busiest hours, most flags), and "per 100 entries, first two weeks vs the last two" once there's enough data.
- **Review one by one:** a full-screen button that steps through every waiting entry. Answer one and the next comes up.
- **Getting started:** a short first-week checklist (alerts, notifications, the sign, first answer, spot-check, staff logins). It ticks itself off and can be hidden.
- **Camera problems:** an inbox of camera computer offline / no picture, shown as Open until it fixes itself, then Fixed.
- **Team chat alerts:** paste a Slack, Teams, Google Chat or Discord incoming-webhook link into the alert list. Chat messages say what happened and link to the gym page; photos stay behind the sign-in. Only those services' own webhook addresses are accepted.
- **Works without signal:** the last list is kept on the phone (times, counts and answers only; no photos, nothing about member numbers) for 48 hours and wiped on sign-out.
- **Monthly report:** "Print or save as PDF" button and a flagged-entries-by-hour chart.
- **Owner settings** (need the owner's own email login, not the shared gym code):
  - Gym logo (PNG or JPEG under 200 KB) on the gym page, front-desk screen and lobby TV.
  - Shorter photo keep times: photos 24 or 48 hours; flagged and marked entries 14 or 35 days. Never longer than the defaults.
  - Who has read member numbers: each approved phone, who was signed in, and when (90 days).
- **Find a member** (approved phones only): type a member number to see their scans in the last 48 hours and the entry each matched. Searched on the phone; the number never leaves it.
- **Spanish:** the members' page (`/members?lang=es`, or automatic for Spanish phones) and a Spanish entrance sign on the sign page.

## For TJ
- **Self-serve signup:** a paid Stripe checkout creates the gym once (repeats ignored), emails the owner a welcome with how to sign in and the gym code, and emails you. Failed payments and cancellations email you and show on the admin page under Billing. Nothing is switched off automatically.
- All gym data files are now blocked from being served as web pages by one rule (`gym-*-*.json`), plus the `logos` folder.

# What's new (October 16)

## Settings to add on Render (Environment)

| Setting | What it does | Needed? |
| --- | --- | --- |
| `SUPPORT_EMAIL` + `SMTP_*` | All emails: alerts, morning summary, weekly self-check, sign-in links, self-repair, backups | **Yes** |
| `GITHUB_TOKEN`, `GITHUB_REPO` | Lets self-repair ship tested changes as pull requests (see SELF-REPAIR.md) | Recommended |
| `BACKUP_PASSWORD` | A locked backup emailed every night at 3 AM | Recommended |
| `SELF_FIX_AUTO=on` | Small, low-risk error fixes ship without waiting for you | Optional (off) |
| `DEMO_DAILY_CAP` | Leave at `0`. The old webcam demo is gone; `/demo` costs nothing | Leave as is |

## For the gym (the gym page)
- **Sign in:** with the gym code as before, or with your own email (a one-time link, no password).
- **People:**
  - Roles: **staff** check entries; **managers** also run the alert list and the price; **owners** also add and remove people.
  - Owners of more than one gym get **Your gyms** to switch between them.
- **Checking entries:** "▶ Play" shows an entry's photos in order, like a 2-second video.
  - Each entry has a suggested answer, but only when the camera and the scans agree. Staff still decide, and every answer has Undo.
  - Each answer shows who gave it.
  - The help folds away after 5 checks. There's a colour key, "Jump to a time", and keyboard keys T/S/F/N/U on a computer.
- **What happened next** (charged / talked / warned / couldn't reach / disputed):
  - Feeds "$ charged" and "this month" at the top.
  - There's a friendly message to copy and send the member, and a printable incident sheet.
- **Weekly spot-check:** 5 random normal entries to glance at. This is how misses get found and counted.
- **Alerts:** each person picks what they get (tailgates, camera problems, morning summary). Phones can turn on **notifications** (on iPhone: add to Home Screen first).
- **Ask about your numbers** (owners and managers): type a question like "How many tailgates last week?" The answer comes only from the gym's own results. Up to 20 questions a day, less than a cent each.
- **No signal?** Answers are saved on the phone and sent automatically when signal returns.
- **Front-desk screen:** open `/desk` on a tablet at the desk. New flags show there with the photo and a sound.
- **Door sign, member notice and staff script:** `signage.html`, printable.

## For you (the admin page)
- **Self-check:** a score per gym with what to do, also emailed every Monday. It includes the nightly AI self-test and the spot-check results.
- **Self-repair and changes:**
  - Failures are fixed when that's safe. Code changes are written, reviewed, tested on a copy, and sent to you to approve.
  - "Ask for a change" takes a request in plain words.
- **Backup:** download a locked backup any time.
- **Backup approver** (member numbers):
  - On a second phone you trust, open the admin page and tap "Make this a backup approver", then approve it from your owner phone (the codes must match).
  - If your phone is ever lost, that phone can still approve staff, and the front-desk readers keep working with nothing to set up again.
  - The readers update themselves (Windows reader 1.2.0).
- **Fleet:** every camera computer in one place, with its program version.
- **Camera computers update themselves** when the door has been quiet for 20 minutes, and go back to the old version by themselves if the new one fails.

## For sales
- `/demo` is a live sample gym. Tap around; nothing is real and nothing is saved.
- The home page has the $200 + $100 pricing and a "Sign in" button on every screen.

## 2026-10-24: new price
- $149 a month for the first entrance, $79 for each extra entrance or location (was $200 and $100). Home page, checkout and the server's Stripe price table all match. Founding gyms keep the new price. (Tj's choice: undercuts Kisi's tailgating setup and keeps about $104 a gym after taxes.)
