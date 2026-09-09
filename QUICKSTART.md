# SecurityAI — deploy in 10 minutes

## 1. Push to GitHub
Upload every file in this folder to the **root** of a new repo (not inside a
subfolder — that was the cause of an earlier failed deploy).

## 2. Create the Render service
- New → Web Service → connect the repo
- **Build command:** `npm install`
- **Start command:** `node server.js`
- **Root Directory:** leave BLANK

## 3. Environment variables (Render → Environment)

Required for the monitor to analyze anything:

    ANTHROPIC_API_KEY=sk-ant-api03-...

Recommended:

    DOMAIN=https://your-app.onrender.com
    GYM_CODES=yourgym                  # per-gym login codes, comma separated
    DATA_DIR=/var/data                 # only if you mount a disk (see step 4)

Optional — alerts and the monthly report only send if these are set:

    SMTP_HOST=smtp.sendgrid.net
    SMTP_PORT=587
    SMTP_USER=apikey
    SMTP_PASS=...
    SMTP_FROM=alerts@yourdomain.com
    SUPPORT_EMAIL=you@yourdomain.com
    TWILIO_SID=...
    TWILIO_AUTH_TOKEN=...
    TWILIO_FROM_NUMBER=+1...

Stripe is only needed when you actually start charging. Everything else
works without it.

## 4. Make data survive redeploys (optional, paid plan)
Render's free tier wipes the filesystem on every deploy. To keep alert
history and evidence photos across deploys, add a Disk (Render → Disks),
mount it at `/var/data`, and set `DATA_DIR=/var/data`.
Without this: logs survive restarts but reset on each deploy.

## 5. Use it
- Marketing site: `https://your-app.onrender.com/`
- Live Monitor:   `https://your-app.onrender.com/monitor.html`
- Report preview: `https://your-app.onrender.com/monitor/report/preview?code=yourgym&name=Your%20Gym`

On the computer that already has your cameras on screen:
1. Open monitor.html, enter your gym code
2. Share a screen → **choose "Entire Screen"**
3. Capture reference frame → drag a box around each entrance
4. Set your hours (e.g. 23:00 → 05:00), model, sensitivity
5. Add alert email/phone, tick consent, Start
6. Tab over to your cameras. Leave the tab open.

## Night-one checklist
- [ ] Watch the "Local filter" line — if it shows lots of `person` detections
      with nobody there, a zone is picking up something that moves. Redraw it.
- [ ] Check the projection in the status bar. If it says "on pace for" more
      than your cap, tighten sensitivity or raise the cap.
- [ ] Compare a few alerts against what actually happened. The thumbnail on
      each log entry is there so you can check rather than trust.
- [ ] Run night one on Sonnet. Switch to Haiku night two and compare — Haiku
      is 3x cheaper if it holds up on your footage.

---

# Keeping it running all night

The browser tab is the fragile part. Four layers, in order of importance:

## 1. The dead-man's switch (already built, nothing to configure)
The dashboard sends a heartbeat every 30 seconds. If those stop during
your monitored hours, the server emails and texts you within ~3 minutes:

> "SecurityAI ALERT: monitoring at Front door STOPPED 4 minutes ago and is
> not recording. The dashboard tab may have closed, the computer may have
> slept or restarted, or the screen share ended."

This does not prevent failure. It converts a silent failure into one you
find out about at 1am instead of 9am — which is the difference between
restarting it and losing the whole night. Set an alert phone number and
this alone makes night one salvageable.

It auto-detects recovery too, and logs a "reconnected" entry.

## 2. Windows settings (do this before night one)
- **Power:** Settings → System → Power & battery → Screen and sleep →
  set *both* "screen off" and "sleep" to **Never** while plugged in.
- **Updates:** Settings → Windows Update → Advanced options → **Active
  hours** → set these to cover your monitored window so Windows will not
  reboot during it. Also toggle off "Restart as soon as possible".
- **Screensaver:** turn it off (it can end screen sharing).

## 3. Browser protections (automatic)
- **Wake Lock** is requested when monitoring starts, which keeps the
  display from sleeping. It re-acquires whenever you return to the tab.
- **Close warning** fires if someone tries to close the tab mid-run.
- Put a sticky note on the machine. Seriously — the most common cause of
  this failing is a person, not software.

## 4. Auto-resume
If the tab does die, reopening monitor.html restores your gym code,
schedule, model, alert contacts and all your drawn zones, and shows an
"INTERRUPTED" banner. You re-share the screen and press Start — about
fifteen seconds. Browsers require a fresh click to start screen sharing,
so this part cannot be fully automatic.

## Tip for night one
Put the monitor.html window **side by side** with your camera view rather
than in a background tab. Wake Lock only holds while the tab is visible,
and you avoid background-tab throttling entirely. Screen share set to
"Entire Screen" still captures the cameras next to it.

---

# Gym access codes

## Issuing a code to a gym
Set an admin token in Render's environment first:

    ADMIN_TOKEN=pick-something-long-and-random

Then create the gym (from your own machine, replacing the URL and token):

    curl -X POST https://your-app.onrender.com/admin/gyms \
      -H "Content-Type: application/json" \
      -H "X-Admin-Token: your-admin-token" \
      -d '{"gymName":"Iron Oak Fitness","email":"owner@ironoak.com"}'

Response contains the code, e.g. `ironoakfitne-b4c7`. Give that to the gym.

Codes are readable enough to say over the phone but carry a random suffix,
so they can't be guessed from the gym's name.

If `ADMIN_TOKEN` is not set, these admin endpoints return 404 rather than
sitting there unprotected.

## How a gym keeps their code
The Live Monitor page has a **"Remember on this computer"** checkbox, on by
default. The code is stored in that browser so the front desk doesn't
retype it nightly. Untick it on a shared machine.

## Forgot the code
"Forgot your code?" on the dashboard asks for the email the account was set
up with and emails the code there. Requires SMTP to be configured.

Two deliberate properties, so this can't be abused:
- The response is **identical** whether or not the email is on file. It
  cannot be used to discover which gyms are customers.
- It's rate limited to 3 attempts per 15 minutes per email and per caller,
  so it can't be turned into an email bomb.

## A caveat worth being honest about
An access code is not a password. It separates each gym's alert log and
settings so customers never see each other's data — that's its whole job.
It is not protecting member records or payment data, and nothing sensitive
sits behind it. If this ever needs to guard something that matters, replace
it with a real auth provider rather than hardening this.

---

# Before tonight — do these in order

## 1. Set up SMTP (10 minutes, and skipping it breaks the whole night)
Without email configured you get **no alerts and no warning if monitoring
stops**. Free options: SendGrid, Mailgun, Brevo.

    SMTP_HOST=smtp.sendgrid.net
    SMTP_PORT=587
    SMTP_USER=apikey
    SMTP_PASS=<your provider key>
    SMTP_FROM=alerts@yourdomain.com

## 2. Optional but recommended: Twilio for SMS
A 1am text beats an email you read at 9am.

    TWILIO_SID=...
    TWILIO_AUTH_TOKEN=...
    TWILIO_FROM_NUMBER=+1...

## 3. Open the Live Monitor and read the "BEFORE YOU START" panel
It checks the server for you and marks each item Ready / Required /
Optional. If anything says **Required**, fix it before running.

## 4. Press "Send me a test alert"
Fill in your alert email and phone first. This sends a real alert through
the real channels. **Do not skip this** — it's the difference between
finding out alerts work now and finding out they don't tomorrow morning.

## 5. Test the API key
Open the marketing site's demo and press "Capture & analyze" once. Costs
about a penny and proves the key works.

# The monthly report sends itself
The scheduler runs hourly and emails the report on the 1st at 8am server
time. Override with `REPORT_SEND_DAY` and `REPORT_SEND_HOUR`. A marker
file prevents double-sends across restarts.

Single gym without access codes? Set:

    REPORT_TO=you@yourgym.com
    REPORT_GYM_NAME=Your Gym

Test it any time without waiting for the 1st:

    curl -X POST https://your-app.onrender.com/admin/report/run-now \
      -H "X-Admin-Token: your-admin-token"

---

# Getting texts without Twilio

Twilio's console is painful on a phone, and SMS is optional anyway — email
alone covers the dead-man's switch. But if you want texts tonight without
setting up Twilio at all, most US carriers accept email at a special
address and deliver it as an SMS.

Put it in the **alert email** field, comma-separated with your normal
address, and you get both:

    tjdicken43@gmail.com, 4797212719@vtext.com

Gateway addresses (use the bare 10-digit number — no dashes, no +1):

| Carrier   | Address format              |
|-----------|-----------------------------|
| Verizon   | number@vtext.com            |
| AT&T      | number@txt.att.net          |
| T-Mobile  | number@tmomail.net          |
| Sprint    | number@messaging.sprintpcs.com |
| Google Fi | number@msg.fi.google.com    |
| US Cellular | number@email.uscc.net     |

Not sure of your carrier? Look it up at freecarrierlookup.com, or just try
the likely one and press "Send me a test alert."

Honest caveats: gateways are free but not guaranteed — delivery is
best-effort, can lag a minute or two, and carriers occasionally filter
them. Good enough to prove the concept tonight. If SecurityAI becomes
something customers rely on, move to real Twilio SMS then, when you can
set it up on a computer instead of a phone.

---

# If the camera machine isn't a normal computer

Many gyms don't have a PC showing cameras — they have a **dedicated NVR
appliance** (Hikvision, Dahua, Lorex, Swann, Night Owl and similar). It
looks like a computer, has a mouse, often drives two monitors — but it
runs its own locked-down firmware. No desktop, no Start menu, no browser.
The giveaway is that the mouse won't leave the camera interface.

You cannot run SecurityAI on that box. There's nowhere to open a browser.
Three ways around it, cheapest first.

## Option A — a separate computer on the same network (usually best)
Almost every NVR has a **web interface**: type its IP address into a
browser on any machine on the same network and you get the same live view.

1. Find the NVR's IP (its own menu, under Network / TCP-IP)
2. On any laptop or mini PC on that network, open that IP in Chrome
3. Log in, bring up the camera grid you want
4. Run monitor.html in a second window beside it and share the screen

An old laptop works. A $150 mini PC works and can be left running. This is
also better than using the gym's front-desk machine — nobody closes tabs
on a computer whose only job is this.

Note: some older NVR web interfaces need a browser plugin that modern
Chrome dropped. If the live view won't load, use Option B.

## Option B — an HDMI capture stick (~$20, works with anything)
A USB HDMI capture dongle makes the NVR's video output appear as a webcam
on a computer.

1. NVR's spare HDMI out → capture stick → laptop USB
2. That feed now shows up as a camera device
3. In monitor.html use it as your source, then draw your zones

Works no matter how locked down the NVR is, and doesn't touch its network
settings. Most NVRs have a second output already free — that's what your
second screen is plugged into.

## Option C — RTSP straight from the NVR (most reliable, most setup)
Most NVRs expose per-camera RTSP streams like:

    rtsp://user:pass@192.168.1.50:554/Streaming/Channels/101

If you can get those, a small always-on machine at the gym running
`node server.js` with ffmpeg installed can pull frames directly — no
browser, no screen share, nothing to leave open. Genuinely unattended.
The exact URL format is per-brand; search "<your NVR brand> RTSP URL".

## If it IS a normal Windows PC with two monitors
Then nothing is wrong — when you press "Share a screen or window", the
picker lets you choose **which** screen. Pick the one showing the cameras.
Zones are stored as positions on that screen, so don't move windows
around afterwards.
