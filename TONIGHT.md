# Setting up at J Street — LTS PRO-X

Your system, your numbers. Work top to bottom. After each step there's a
**Check** — if it doesn't match, fix that before going on.

Your NVR: **LTS PRO-X at 192.168.2.54**

---

# PART 1 — A Gmail address for the alerts (10 min)

The NVR will email snapshots to this address, and our server reads them.
Use a **new** Gmail, not your personal one — it will receive a lot of mail.

### 1.1 Make the account
Go to gmail.com → Create account. Something like `jstreetgym.alerts@gmail.com`.
Write the password down.

### 1.2 Turn on 2-Step Verification
myaccount.google.com → **Security** → **2-Step Verification** → turn it on.
You must do this before the next step exists.

### 1.3 Make an App Password
Go to **myaccount.google.com/apppasswords**
- Name it `SecurityAI`
- Click Create
- It shows **16 letters in 4 groups**. Copy it. You cannot see it again.

**Check:** you have an email address, its normal password, and a separate
16-character app password. Three things.

---

# PART 2 — Tell the NVR to send email (10 min)

At the NVR, with the mouse.

### 2.1 Open the email settings
**System** (top right) → **Network** (left) → **Basic** → **Email** tab
along the top. You saw this screen already.

### 2.2 Fill it in

| Field | What to type |
|---|---|
| SMTP Server | `smtp.gmail.com` |
| SMTP Port | `587` |
| Enable SSL/TLS | **On** (may be called STARTTLS) |
| User Name | your new Gmail address |
| Password | the **16-character app password**, not the Gmail password |
| Sender | the same Gmail address |
| Sender Address | the same Gmail address |
| Receiver 1 | **the same Gmail address again** |
| Attached Picture | **On** |
| Interval | `2` seconds if offered |

Sending to itself is deliberate — the mail lands in the same inbox we read.

### 2.3 Test it
Press **Test**. Then open that Gmail inbox.

**Check: a test email actually arrived.** Do not go on until it does.
- "Authentication failed" → you used the Gmail password instead of the app password
- Nothing at all → check the address for typos, try port `465` with SSL on

---

# PART 3 — Tell the NVR when to send (10 min)

### 3.1 Pick the entrance camera
On the live view, find the front door. Note its channel number — `D3`,
`CH03`, whatever it shows. You need that number.

### 3.2 Set up detection
**Alarm** (left menu) → **Motion Detection** (or **Smart Event** →
**Intrusion**, if your firmware has it — that one is better)

1. Choose the entrance channel from the dropdown
2. **Enable** it
3. **Draw the area** over the doorway only. Not the whole picture — just
   the door and a step of floor either side.
4. Sensitivity: middle
5. **Arming Schedule** → set it to **20:00 to 08:00**, all days.
   That's when nobody's at the desk.

### 3.3 Make it email you
Still on that screen, find **Linkage Action** / **Linkage Method** (may be
a tab or a button):
- Tick **Send Email**
- Tick **Snapshot** or **Capture Picture** if present
- Leave Buzzer and Full Screen Monitoring **off** — you don't want an
  alarm sounding in the gym at 2am

Press **Apply**.

**Check:** walk in front of that camera. Within about a minute an email
with a photo should land in the Gmail inbox. If it doesn't, go back to 3.2
— the detection area is probably drawn somewhere you didn't walk.

---

# PART 4 — Point our server at that inbox (10 min)

On your phone or any computer.

### 4.1 Add the API key on Render
dashboard.render.com → your **SecurityAI** service → **Environment** →
**Add Environment Variable**

- Left box: `ANTHROPIC_API_KEY`
- Right box: your key from console.anthropic.com (starts `sk-ant-api03-`)

Also add, so the alerts reach you:

| Left box | Right box |
|---|---|
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | your new Gmail address |
| `SMTP_PASS` | the 16-character app password |
| `SMTP_FROM` | your new Gmail address |

**Save Changes** and wait for it to redeploy.

### 4.2 Make the config file
In your GitHub repo, create a file called **`ingest-zones.json`** with this
in it, changing the marked lines:

```json
{
  "gymCode": "jstreet",
  "label": "J Street Gym",
  "scheduleStart": "20:00",
  "scheduleEnd": "08:00",
  "model": "claude-sonnet-4-6",
  "dailyBurstCap": 400,
  "alertEmail": "tjdicken43@gmail.com, 4797212719@vtext.com",
  "verbose": true,
  "ftp": false,
  "email": {
    "host": "imap.gmail.com",
    "port": 993,
    "user": "PUT YOUR NEW GMAIL HERE",
    "pass": "PUT THE 16 CHARACTER APP PASSWORD HERE",
    "mailbox": "INBOX",
    "pollSeconds": 30
  },
  "cameras": [
    { "match": "channel3", "label": "Front door", "expectedCount": 1 }
  ]
}
```

Two things to change for your setup:
- `"match": "channel3"` — use your real channel number from step 3.1
- Your carrier for texts: Verizon `@vtext.com` · AT&T `@txt.att.net` ·
  T-Mobile `@tmomail.net`

### 4.3 Run it

**Leave the Start Command as `node server.js`.** Don't change it.

Render runs a *web service*, which has to answer on a web port. A command
that only reads a mailbox never opens one, so Render reports **"no open
ports detected"** and shuts it down. The ingest now runs inside the web
server instead — one service doing both, and your site stays up.

It switches itself on as soon as `ingest-zones.json` exists in the repo.
So committing that file in step 4.2 is all that's needed.

**Check:** Render → **Logs**. You should see all three lines:

    SecurityAI payment server running on port 10000
    Ingest: watching mailbox yourgym.alerts@gmail.com every 30s
    Monthly report scheduler active

If the middle line is missing, `ingest-zones.json` isn't in the repo root
or has a typo in it — Render's log will say which.

---

# PART 5 — Prove it works before you leave

1. Walk through the front door.
2. Watch Render's Logs. Within a minute or so:
   `Front door: 3 frame(s) analyzed`
3. If the count didn't match what was expected, an alert email and text go
   to you.
4. Open `your-url/monitor.html` — the entry should be in the log **with a
   photo**.

**If all four happen, you're running tonight.**

---

# In the morning

Open the monitor page and read the log.
- Alerts for things that weren't people → the NVR's detection area is too
  big. Redraw it tighter on the doorway.
- Your own walk-throughs missing → widen the detection area slightly, or
  raise NVR sensitivity one notch.
- **Nothing at all** → check the Gmail inbox. Emails there but no log
  entries means our side; no emails means the NVR side.

---

# If something breaks

**No test email from the NVR** — app password, not Gmail password. Try
port 465 with SSL if 587 fails.

**Emails arrive but nothing in the log** — check `user` and `pass` in
`ingest-zones.json`. The password there is the app password too.

**"ANTHROPIC_API_KEY is not set"** — the variable didn't save on Render.
Delete it and re-add, pasting fresh.

**Alerts flooding you** — the detection area covers too much. Tighten it,
or set the NVR's arming schedule to a shorter window tonight.

**"No open ports detected"** — the Start Command was changed. Put it back
to `node server.js`; the ingest runs inside it.

**To stop everything** — delete `ingest-zones.json` from the repo (the
website keeps running), and on the NVR untick Send Email under Linkage
Action.
