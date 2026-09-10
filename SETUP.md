# SecurityAI — Setup

Follow these in order. Don't skip ahead — each part needs the one before it.

After each step there's a **Check** telling you exactly what you should be
looking at. If what you see doesn't match, stop and fix that before moving
on. Nearly every problem people hit is from carrying on past a failed check.

Total time: about 45 minutes, most of it waiting.

---

# PART 1 — Put the website online (once, ~20 min)

### 1.1 Create a GitHub account
Go to **github.com** → Sign up. Free.

### 1.2 Make a repository
1. Click the **+** at the top right → **New repository**
2. Name it `securityai`
3. Leave everything else alone. Do **not** tick "Add a README".
4. Click **Create repository**

### 1.3 Upload the files
1. On the new page click **uploading an existing file**
2. Unzip the SecurityAI folder on your computer
3. Select **all the files inside that folder** — not the folder itself
4. Drag them in, then click **Commit changes**

**Check:** the repo page lists `server.js`, `package.json`, `monitor.html`
and others *directly*. If instead you see one folder you have to click
into, delete the repo and redo this step selecting the files inside.

### 1.4 Create a Render account
Go to **render.com** → Sign up → choose **Sign up with GitHub**.

### 1.5 Create the web service
1. Click **New +** → **Web Service**
2. Pick your `securityai` repository → **Connect**
3. Set these exactly:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Root Directory:** leave **empty**
4. Click **Create Web Service** and wait for the log to say **Live**

**Check:** at the top of the page there's a URL like
`https://securityai-xxxx.onrender.com`. Open it. You should see the
SecurityAI website. If you get an error, read PART 5.

---

# PART 2 — Keys and alerts (~15 min)

Everything here goes in the same place: your service → **Environment** →
**Add Environment Variable**. Each one has a **Key** box (left) and a
**Value** box (right).

> Put the *name* in the left box and the *secret* in the right box. Getting
> these the wrong way round is the single most common mistake.

### 2.1 Anthropic key — required, nothing works without it
1. Go to **console.anthropic.com** → Sign up
2. **Settings → Billing** → add a payment method (this is separate from any
   Claude subscription, and pay-as-you-go)
3. **API Keys** → **Create Key** → press the **copy button** next to it.
   Don't select the text by hand, you will miss characters.
4. In Render add:
   - Key: `ANTHROPIC_API_KEY`
   - Value: paste the key (starts `sk-ant-api03-`)

### 2.2 Email sending — required, or you get no alerts at all
1. Go to **sendgrid.com** → Sign up (free)
2. **Settings → Sender Authentication → Single Sender Verification** →
   create a sender using your own email → **click the confirmation link
   they email you**. Skipping this means nothing ever sends.
3. **Settings → API Keys → Create API Key** → Restricted Access → turn on
   **Mail Send** → copy the key
4. In Render add these five:

   | Key | Value |
   |---|---|
   | `SMTP_HOST` | `smtp.sendgrid.net` |
   | `SMTP_PORT` | `587` |
   | `SMTP_USER` | `apikey` |
   | `SMTP_PASS` | the key you copied (starts `SG.`) |
   | `SMTP_FROM` | the email you verified in 2.2 step 2 |

> `SMTP_USER` really is the word **apikey**. Not your email address.

### 2.3 Save
Click **Save Changes**. Render redeploys — wait for **Live** again.

**Check:** open `your-url/monitor.html`, open **Server setup check**
near the bottom. "Anthropic API key" and "Email alerts" should both say
**Ready**. If not, the variable didn't save — check spelling and try again.

---

# PART 3 — Connect your cameras

Pick the one that matches your gym. If unsure, walk to the camera machine
and try to move the mouse off the camera screen. If it won't leave, it's a
locked-down NVR box and you need **3B** or **3C**.

## 3A — There's a normal computer showing the cameras
Nothing to buy.
1. On that computer open your camera view
2. Open a second window: `your-url/monitor.html`
3. Put the two **side by side** (Windows key + ← and →). Don't put the
   monitor page on top of the cameras.
4. Skip to PART 4.

## 3B — The cameras are on a locked NVR box
Buy a **USB HDMI capture stick** (~$20, search "USB HDMI capture").
1. Plug a spare HDMI output on the NVR into the capture stick
2. Plug the stick into any laptop
3. On that laptop open `your-url/monitor.html`
4. Skip to PART 4 and use **"Use a camera or capture device"**

## 3C — You want it running without any browser open
Hardest to set up, but nothing to leave open and it survives reboots.
Needs a small always-on computer at the gym.
1. Install **Node.js** (nodejs.org) and **ffmpeg** on it
2. Copy the SecurityAI files onto it
3. Get your NVR's RTSP addresses (search "<your NVR brand> RTSP URL")
4. `cp rtsp-zones.example.json rtsp-zones.json`, open it, fill in your
   camera addresses and the box coordinates for each doorway
5. Create a `.env` file containing `ANTHROPIC_API_KEY=sk-ant-...` and your
   SMTP settings
6. Run `node rtsp-run.js`

---

# PART 4 — Set it running (~10 min)

Open `your-url/monitor.html`. Work down the numbered steps on the page.

### Step 1 — Connect your cameras
- **3A:** click **Share a screen or window** → choose **Entire Screen** →
  Share
- **3B:** click **Use a camera or capture device** → allow camera access →
  pick the capture stick from the dropdown

**Check:** the dot turns green and the step number turns green.

### Step 2 — Draw your entrances
1. Click **Take a picture of my screen** — a still appears
2. **Drag a box around one doorway.** Snug: the door plus a step of floor
   either side. Don't box the whole camera tile — people look too small.
3. Type a name ("Front door"), then how many people normally come in at
   once (usually **1**), then answer the accessible-gate question
4. Repeat for each doorway

**Check:** green boxes on the picture, and each one listed underneath.

### Step 3 — Where alerts go
1. In the email box type your email
2. **Want texts?** Add your carrier address after a comma:
   `you@gmail.com, 4795551234@vtext.com`
   (Verizon `@vtext.com` · AT&T `@txt.att.net` · T-Mobile `@tmomail.net`)
3. Click **Send me a test alert now**

**Check: the alert actually arrives.** Do not continue until it does. If
it doesn't, alerts are broken and you'd never know the system stopped.

### Step 4 — Hours
Set **From 23:00** and **Until 05:00** (or whenever nobody's at the desk).
Outside these hours it watches nothing and costs nothing.

### Step 5 — Start
Tick the agreement box at the bottom, click **Start monitoring**.

**Check:** the bar at the top says **Watching**, with a pulsing green dot.

---

# PART 5 — First night

Before you walk away:
- **Computer must not sleep.** Settings → System → Power → set screen and
  sleep to **Never** while plugged in.
- **Windows must not reboot.** Settings → Windows Update → Advanced →
  **Active hours** covering your monitoring window.
- **Screensaver off** — it can end screen sharing.
- **Leave the tab open.** Put a note on the machine.

Walk through the door yourself a few times and check the alert log shows
it, with a picture.

### The next morning
Open the monitor page and look at the log.
- **Alerts for things that weren't people?** A box is picking up something
  that moves. Redraw it tighter.
- **Your own walk-throughs missing?** Advanced settings → sensitivity →
  **All motion**.
- **Nothing at all, no alerts either?** The tab or computer probably died.
  You should have received a "monitoring STOPPED" message — if you didn't,
  email isn't set up properly, go back to 2.2.

---

# Troubleshooting

**Site won't load / deploy failed**
Render → Logs. `Cannot find package.json` means the files went into a
folder — redo 1.3. Anything else, read the last red line.

**"Failed to fetch" when analyzing**
`ANTHROPIC_API_KEY` isn't set, or has a stray space. Delete the variable
entirely and re-add it, pasting fresh.

**"invalid x-api-key"**
The key is wrong or billing isn't set up on console.anthropic.com. Make a
brand new key rather than debugging the old one.

**Camera/share buttons do nothing**
The page must be on `https://`. Your Render URL already is. Opening the
file from your downloads folder will never work.

**No test alert arrives**
Did you click SendGrid's confirmation email? Is `SMTP_USER` literally the
word `apikey`? Is `SMTP_FROM` the exact address you verified?

**Nothing detected all night**
Sensitivity → All motion. Redraw boxes tighter around the doorway. If the
page warns about grain on a zone, put more light on that doorway — that
helps more than any setting.

**Too many false alerts**
Redraw the box to exclude anything that moves by itself — a TV, a clock
overlay, a fan, a treadmill.

---

# Anpviz cameras (and most IP cameras)

If your gym uses Anpviz, Hikvision, Dahua, Reolink or similar network
cameras, you can skip the browser entirely and use **PART 3C** — the
server pulls frames straight from the camera. Nothing to leave open,
survives reboots, and it's the most reliable of the three options.

You need one thing from each camera: its RTSP address. These vary by
model and the printed manual is often wrong, so there's a tool that finds
it for you.

### 1. Find a camera's IP address
Any of these:
- Your router's admin page → list of connected devices → look for `IPC`,
  `ANPVIZ`, or an unfamiliar device
- The NVR's own menu → Network, or Camera / Channel Management
- Anpviz ships at `192.168.0.123` if it was never configured
- On Windows, run `arp -a` in Command Prompt

### 2. Find the working address
On a computer on the same network, with Node.js and ffmpeg installed:

    node find-camera.js 192.168.1.64 admin yourpassword

It tries ten known formats and prints the one that works, with the
resolution so you know you got the main stream. Takes about a minute.

Default Anpviz login is `admin` / `123456`, but if the system was set up
properly that was changed — check the NVR or ask whoever installed it.

### 3. Other cameras
Usually the same address with a different channel number:

    .../Streaming/Channels/101   camera 1
    .../Streaming/Channels/201   camera 2
    .../Streaming/Channels/301   camera 3

Or re-run the tool with a channel number on the end:

    node find-camera.js 192.168.1.64 admin yourpassword 2

### 4. Put them in the config
Copy `rtsp-zones.example.json` to `rtsp-zones.json`, paste each address
in as `cameraUrl`, then set the crop box for each doorway — `cropX`,
`cropY`, `cropW`, `cropH` in pixels, measured from the top-left of that
camera's picture. Take a screenshot of the camera view and use any image
editor to read off the coordinates of the doorway.

Then: `node rtsp-run.js`

`rtsp-zones.json` holds your camera passwords and is already excluded
from git, so it will never be uploaded to GitHub.

---

# Route D — let the cameras push to you (nothing at the gym)

The other three routes all need something running at the gym. This one
doesn't. Your cameras already have their own person detection — Anpviz
calls it Human Detection and IVS tripwire — and they can push a snapshot
out when it fires. We receive those and answer what the camera can't:
**how many people crossed, versus how many were expected.**

That division is worth understanding. The camera is better than us at
"is that a person." We're the only one that can say "that was two people
on one check-in."

### 1. Work out what your cameras actually are

    node scan-cameras.js 192.168.1.0/24                 sweep the network
    node scan-cameras.js 192.168.1.64 admin yourpass    one camera in detail

It reports brand, model, firmware, open ports, whether ONVIF is present,
which RTSP address works — and then tells you which route to use. It only
reads; it changes nothing on the camera.

### 2. Start the ingest server

    cp ingest-zones.example.json ingest-zones.json

Edit it: your gym code, hours, alert email, an FTP password of your
choosing, and a `cameras` list mapping each camera to a doorway. The
`match` value is matched loosely against the folder the camera uploads
into, so `"match": "IPC-D3083"` catches `/IPC-D3083/2026-09-09/`.

    node ingest-run.js

This can run on Render — the cameras reach out to it, so nothing needs to
be opened up on the gym's network.

### 3. Point the camera at it

In the camera's web interface, under **Event**, **Alarm** or **Storage**:

1. Turn on **Human Detection** (not plain motion — the whole point is
   letting the camera filter out shadows and reflections for free)
2. Draw a **tripwire or intrusion area** across the doorway
3. Under **Linkage / Action**, enable **Upload to FTP**
4. FTP settings: your server's address, port `2121`, and the username and
   password from your config
5. If it offers a **snapshot count**, set it to 3. Several frames of one
   event is far more useful than one still — it's how someone pausing to
   scan gets told apart from two people walking through.

### 4. Check it

Walk through the door. Within a few seconds the ingest console should
print the upload and then the analysis, and the alert log on
monitor.html should show it with a photo.

Snapshots arriving within four seconds of each other are grouped into one
event, so a camera pushing three frames produces one alert, not three.

### Also supported
- **Folder watching** — if the camera writes to a NAS or shared folder,
  set `watchFolder` in the config and skip FTP entirely.
- **HTTP push** — for cameras with webhook support.
