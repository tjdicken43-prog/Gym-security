# RTSP setup — laptop first, Pi after

Watched hours are set for each gym on the admin page (usually **9 PM to
5 AM**; a new gym is watched all day until you set them). Nothing on this page involves typing a camera address: the
wizard finds it.

Two routes to the same thing. **Do the laptop first** — it costs nothing
and tells you within an hour whether RTSP actually fixes the accuracy at
your turnstile. Only buy hardware once you know.

The device has to be **on the gym's network** — at J Street, plugged into
the NVR's LAN port (the NVR is `192.168.2.54`). Nothing outside the
building can reach the cameras. That's the whole reason a device is needed.

---

# PART A — Borrowed laptop (free, ~1 hour)

A Mac laptop (the borrowed MacBook Air runs macOS Catalina) plugged into the
recorder's network with a cable, and on Wi-Fi for the internet. A Linux
laptop works the same way as the Pi in Part B. Windows isn't supported for
the background monitor.

### A1. Install Node.js 18
The newest Node.js installer doesn't run on Catalina; **Node 18** does.
Go to **nodejs.org/dist/latest-v18.x/**, download the file ending in
**`.pkg`** (e.g. `node-v18.20.8.pkg`), double-click it and accept the defaults.

Don't use Homebrew: it no longer supports Catalina.

### A2. Get ffmpeg
Download ffmpeg from **evermeet.cx/ffmpeg** (the `.zip` of the latest
release). Double-click the zip in Downloads so a file called `ffmpeg`
appears there. That's all: the camera setup (A5) finds it in Downloads and
copies it where the background monitor can use it. No password needed.

(Don't run `~/Downloads/ffmpeg` by hand: the Mac may say it "cannot be opened
because the developer cannot be verified". The setup avoids that message.)

### A3. Check Node worked

    node --version

It should say `v18` or higher. If it says "command not found", open a new
Terminal window (Cmd+N) and try again.

### A4. Get the program onto it
On your phone: admin page > *Connect a camera computer* > **Get a pairing
code**. Then in Terminal type the line shown there, e.g.:

    curl -O https://YOUR-SITE.onrender.com/update.js && node update.js

It asks for your website address and the pairing code, then puts the program
in **`~/securityai`**, the one place every command is typed from from now on.
No `npm install` is needed on the camera computer. (Friday's old folder still
on this computer? See AT-THE-GYM.md: the old settings move across, and it
offers to delete the old folder with its API key.)

### A5. Run the camera wizard
`update.js` offers to start it (press Enter). Or type:

    cd ~/securityai
    node setup-camera.js

It connects to your website first (already done if `update.js` paired it:
no Anthropic key and no token on this computer). Then it asks for the
recorder's IP, username and password (hidden; `!` and friends are fine), and:

- finds which address format the recorder speaks, and **stops at the first
  wrong password** (the recorder locks the account after a few);
- rejects addresses that ignore the channel number (the bare
  `rtsp://ip:554/` always shows camera 1);
- saves a picture of every channel to `camera-check/` plus one combined
  picture, `camera-check/all-channels.jpg` (opens by itself on a Mac);
- asks which channel is the entrance, tests whether this laptop keeps up with
  the big camera picture (and picks the small one if not), then lets you pick
  the doorway on a lettered grid (`camera-check/grid.jpg`). Type e.g. `B2 C4`;
- saves everything in `~/.securityai/rtsp-zones.json` (outside the program
  folder, so updates never lose it; the previous one is kept as `.bak`);
- offers to **keep the monitor running**: it starts by itself with the
  computer and restarts itself after any crash. Say yes.

More than 16 channels: `node setup-camera.js --channels 32`.
**Never type the camera address by hand.** Re-run the wizard instead.

### A6. Watch it

    node rtsp-run.js

If the monitor is already running in the background this just **shows** its
live output; Ctrl-C stops watching, not the monitor. You should see your door
with its picture size and crop, and a motion number that jumps when you walk
past. (Only one monitor ever runs at a time, so nothing gets counted twice.)

### A7. Keeping it up to date
After you deploy a new version to Render:

    cd ~/securityai
    node update.js

It downloads the program **from your own website** (what you just
deployed), checks every file arrived intact, keeps your settings, and the
background monitor restarts on the new version by itself.
`node update.js --undo` goes back one version.

### A8. Test it properly
Crossings outside the gym's watched hours aren't counted. To test in the
daytime, on the admin page set the gym's hours to cover now (or switch them
off), then:

1. Walk through normally
2. Walk through fast
3. Walk through slowly, pausing as if scanning
4. Have someone follow you through on one rotation

**The fourth is the one that matters.** Check the gym's activity page and see
whether it caught two people.

Put the hours back to **9 PM – 5 AM** (or whatever the gym wants) on the
admin page when you're done.

---

# PART B — Raspberry Pi (permanent, ~$100)

Only once the laptop test has proved it works.

### B1. Flash the card
Download **Raspberry Pi Imager** from raspberrypi.com/software on your own
computer.

- **Device:** Raspberry Pi 5
- **OS:** Raspberry Pi OS **Lite (64-bit)** — under "Raspberry Pi OS (other)"
- **Storage:** your microSD card

Click the **gear icon** before writing and set:
- Hostname: `securityai`
- Enable SSH, with a username and password you'll remember
- Wifi only as a backup — use the ethernet cable

Write it, put the card in the Pi, plug in ethernet, then power.

### B2. Connect to it
From any computer on the same network:

    ssh yourusername@securityai.local

### B3. Install what it needs

    sudo apt update
    sudo apt install -y nodejs npm ffmpeg git

### B4. Get the program (nothing to copy by hand)

    curl -O https://YOUR-SITE.onrender.com/update.js
    node update.js

It asks for your website address and a pairing code (phone: admin page >
*Connect a camera computer*), then downloads the program into `~/securityai`.

### B5. Retire the laptop, then set up the camera
Only one computer should watch each gym's door, or crossings get counted
twice. **On the laptop first**:

    cd ~/securityai
    node install-service.js --remove

That stops it starting by itself (settings stay, so it can be a spare).
When you give the laptop back, wipe it instead:
`node install-service.js --wipe` (see AT-THE-GYM.md). Then, on the Pi:

    cd ~/securityai
    node setup-camera.js

Same wizard as the laptop. At the end answer **yes** to *keep it running*.
It asks for the Pi's password once (to install the background service). The
monitor now starts on every boot and restarts after any crash. No pm2 needed.

### B6. Check on it

    node rtsp-run.js                  (live output; Ctrl-C stops watching only)
    node update.js                    (after each deploy)
    node install-service.js --remove  (stop it starting by itself)
    node install-service.js --wipe    (remove everything SecurityAI put on it)

### B7. Leave it
Velcro it behind the NVR. It needs power and ethernet, nothing else. No
screen, no keyboard.

---

# Shopping list

Buy direct from an **approved reseller** — search "Raspberry Pi approved
reseller" plus your country. In the US that's usually PiShop.us, CanaKit,
Adafruit, or Micro Center if you have one nearby. Amazon works but check
the seller; counterfeit power supplies are common and cause crashes that
look like software faults.

| Item | What to get | Roughly |
|---|---|---|
| Raspberry Pi 5 | **4GB** — 8GB is wasted here. (4GB is its memory, not its storage: the files go on the 32GB card below, plenty for the ~8GB download) | $60 |
| Power supply | **Official 27W USB-C**. Do not substitute | $12 |
| Active cooler | Official heatsink + fan — it throttles without one | $5 |
| microSD card | 32GB, A2-rated (SanDisk Extreme, Samsung Evo Select) | $10 |
| Case | Official case, the version that fits the cooler | $10 |
| Ethernet cable | Any length that reaches | $5 |

**Around $100.** A "Pi 5 starter kit" from CanaKit or Vilros bundles most
of this and is often cheaper than buying separately — just check it
includes the **official 27W supply** and **active cooling**.

Also fine instead of a Pi: any used mini PC with an Intel N100. Around
$120–150, more headroom, and x86 makes ffmpeg simpler. Bigger and noisier.

---

# Why RTSP is better, in one line

The NVR emails **one photo** taken 1–3 seconds after a trigger. RTSP gives
**four frames a second, continuously**, so a three-second crossing produces
about twelve frames instead of one — and the moment can't fall between them.

**Your API cost does not go up.** Still three frames sent per event; the
extra frames are buffered locally and thrown away. Buffering is free.
