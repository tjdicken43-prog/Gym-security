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
