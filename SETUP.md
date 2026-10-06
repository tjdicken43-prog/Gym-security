# Put the website online and run it

This is the operator's guide: getting the website onto Render, the settings it
needs, adding a gym, and keeping an eye on it. For the camera computer at the
gym, see **AT-THE-GYM.md**.

After each step there's a **Check**. If what you see doesn't match, fix that
before moving on.

---

# PART 1 — Put the website online (once, ~20 min)

### 1.1 GitHub
Make a free account at **github.com**, then **+** (top right) > **New
repository**, name it `securityai`, and don't tick "Add a README". Click
**uploading an existing file**, select **all the files inside** the SecurityAI
folder (not the folder itself), drag them in, and **Commit changes**.

**Check:** the repo page lists `server.js`, `package.json` and others
*directly*, not inside a folder you have to click into.

### 1.2 Render
Sign up at **render.com** with GitHub. **New +** > **Web Service** > pick the
`securityai` repo, then set:

- **Build Command:** `npm install`
- **Start Command:** `node server.js` (never change this)
- **Root Directory:** leave empty
- **Instance type:** a paid one (Starter). The free tier can't keep data (see 2.3).

**Check:** the log says **Live**, and the URL at the top
(`https://securityai-xxxx.onrender.com`) opens the SecurityAI website.

---

# PART 2 — Settings (Render > your service > Environment)

Each setting has a **Key** (left box, the name) and a **Value** (right box,
the secret). Getting them the wrong way round is the most common mistake.

### 2.1 Must have

| Key | Value |
|---|---|
| `ANTHROPIC_API_KEY` | From **console.anthropic.com** > API Keys > Create Key. Press the copy button; don't select it by hand. Starts `sk-ant-api03-`. Needs a payment method under Settings > Billing (separate from any Claude subscription). |
| `ADMIN_TOKEN` | Press **Generate**. This opens `your-site/admin.html` and lets camera computers pair with a 6-digit code. To see it later: the eye icon next to it. Changing it disconnects every camera computer (pair them again). |

`RUNNER_TOKEN` is **not needed**: camera computers pair with a code instead.
If an old one is still set, delete it once every camera computer has been
paired.

### 2.2 Email (required, or nobody gets alerts)

Alerts, the "camera computer stopped" warning, the monthly report and the
"forgot your code" email all go out by email. Use a Gmail account with an
**app password**. (SendGrid no longer has a free plan.)

1. Make a Gmail for SecurityAI (e.g. `securityai.alerts@gmail.com`).
2. **myaccount.google.com** > Security > turn on **2-Step Verification**.
3. **myaccount.google.com/apppasswords** > name it `SecurityAI` > **Create**.
   It shows 16 letters in 4 groups. Copy them now: you can't see them again.
4. Add in Render:

| Key | Value |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | the Gmail address |
| `SMTP_PASS` | the 16-letter app password (not the Gmail password) |
| `SMTP_FROM` | the Gmail address |
| `SUPPORT_EMAIL` | your own email: support-form messages and "camera computer stopped" warnings come here |

The app password only ever goes into Render. Never put it in a file in the repo.

### 2.3 Keep data across deploys (strongly recommended)

Render > your service > **Disks** > add a **1 GB** disk mounted at
`/var/data`. Then add Key `DATA_DIR`, Value `/var/data`.

Both are needed: a disk on its own changes nothing until `DATA_DIR` points at
it. Without them, every deploy wipes the activity log, the photos **and the
gym accounts**.

### 2.4 Optional

| Key | What for |
|---|---|
| `TWILIO_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Text-message alerts. Without Twilio, alerts still go by email. |
| `DOMAIN` | Your site's address, e.g. `https://securityai-xxxx.onrender.com`. Used in links in emails and after checkout. |
| `STRIPE_SECRET_KEY` | Only when you start taking card payments on the website. |
| `LOG_RETENTION_HOURS` | How long photos and the activity log are kept. Default 48. |
| `REPORT_SEND_DAY`, `REPORT_SEND_HOUR` | When the monthly report goes out (default: the 1st of the month, morning). |

Click **Save Changes** and wait for **Live** again.

**Check:** open `your-site/admin.html` on your phone, paste the admin token,
tick *Remember on this phone*. The **Render settings** box shows each setting
as ✓ or ✗ (never the values). Every *must have* line should be ✓.

---

# PART 3 — Add a gym and connect its camera

1. Admin page > **Gyms** > *Add a gym*: gym name and the manager's email.
2. Set the gym's **watched hours** (usually 9 PM to 5 AM; a new gym is
   watched all day until you do) and your own alert email on the admin page.
3. Set up the camera computer at the gym: follow **AT-THE-GYM.md**. It pairs
   with a 6-digit code from *Connect a camera computer*.
4. Walk through the door. **Right now** on the admin page goes green and the
   gym's activity page shows the crossing.
5. Only then tap **Send to gym** > **Text it** / **Email it**. The link signs
   the manager in by itself; they never type the code. On their activity page
   they add everyone who should get alerts under **Get alerts** (each one gets
   a test message straight away).

Each gym has its own code, activity page, alert list and camera computer.

**Gym codes** look like `maplestreet-4f2a9c`: readable over the phone, with a
random ending so they can't be guessed. Someone who forgets theirs taps
"Forgot your code?" on the activity page and it's emailed to the address on
file (needs 2.2). A code isn't a password for anything sensitive: it keeps each
gym's photos and alerts separate from other gyms'.

---

# PART 4 — Day to day

- **Admin page > Right now**: website, camera computer, camera picture and
  last crossing for each gym, with one sentence saying what's wrong.
- **Get a text at 2 AM if it breaks**: admin page > *Get a text or email at
  2 AM…*. Put that address into a free **UptimeRobot** monitor. It warns you
  if the camera computer sleeps or loses the internet, the camera has no
  picture, or Render itself is down.
- **Camera computer stopped**: if a camera computer stops checking in during
  watched hours, an email goes out after a few minutes.
- **Updating**: push to GitHub, Render redeploys, then on the camera computer
  run `cd ~/securityai` and `node update.js` (see AT-THE-GYM.md).
- **Monthly report**: emailed to each gym's manager on the 1st. To send it now:

      curl -X POST https://your-site/admin/report/run-now -H "X-Admin-Token: your-admin-token"

  If sending fails (e.g. email is down), it tries again every hour until the
  end of the 1st.
- **What it can cost (Anthropic bill)**: each gym's *daily limit* (60
  checks a day unless you change it on the admin page) is a hard stop, so a
  gym can cost at most about **$6.80 a month on Sonnet** or **$2.30 on
  Haiku**, however busy the door is. The admin page shows this as *Most it
  can cost* on each gym. If a night is busy early on, checks are spread out
  so the limit lasts until the end of the watch hours. The home page's
  webcam demo is separate: at most 50 tries a day (`DEMO_DAILY_CAP`, about
  $20 a month at the very most; set it to `0` to switch the demo off).
- **Stop watching** is remembered: a redeploy or restart does not start it
  again. Only *Start watching again* does.
- **The same warning** (e.g. *camera computer offline*) goes out at most once
  every 30 minutes, so a shaky connection doesn't flood your phone.
- **Red "gym accounts file (gyms.json) is damaged" warning** on the admin page:
  Render > your service > **Shell**, type
  `cp "$DATA_DIR/gyms.json.bak" "$DATA_DIR/gyms.json"` and press Enter, then
  reload the admin page. The warning goes away. The backup is from just before
  the last gym change: if the newest gym is missing, add it again and tick
  *Adopt '…'* for its old history.

### Texts without Twilio
Most US carriers turn an email into a text. Add an address like
`4795551234@vtext.com` as an alert email (bare 10-digit number):
Verizon `@vtext.com`, AT&T `@txt.att.net`, T-Mobile `@tmomail.net`,
Google Fi `@msg.fi.google.com`. Free but best-effort: it can lag or be filtered.

---

# Troubleshooting

**Deploy failed / site won't load.** Render > Logs. `Cannot find package.json`
means the files went into a folder: redo 1.1. Otherwise read the last red line.

**"No open ports detected".** The Start Command was changed. Put it back to
`node server.js`.

**No alert emails.** Admin page > Render settings: are all the SMTP lines ✓?
`SMTP_PASS` must be the 16-letter app password, not the Gmail password, and
2-Step Verification must be on.

**"invalid x-api-key".** Make a brand-new key on console.anthropic.com and
check billing is set up there.

**Everything reset after a deploy.** `DATA_DIR` isn't set, or no disk is
mounted at that path (2.3).

**A camera computer says the website doesn't recognise it.** Pair it again:
admin page > *Connect a camera computer* > Get a code, then on the computer
`cd ~/securityai` and `node pair.js`.
