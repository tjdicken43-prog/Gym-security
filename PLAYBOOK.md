# Installation playbook

What was learned installing at J Street. Written down so gym number two
takes an evening instead of a week.

---

## Work out what you're dealing with first

Walk to the camera machine and try to move the mouse off the screen.

- **Mouse leaves the screen / there's a taskbar** → a normal PC. Screen
  share works.
- **Mouse trapped in the camera view** → an NVR appliance. It will still
  have RTSP and usually email. Go that route.

Then find the IP: **System → Network → TCP/IP**. Write down the IP, mask,
gateway, and whether it's DHCP or Static.

**Check which NVR you're actually on.** J Street had two, on two monitors,
and everything configured on the first one would have been watching the
wrong building. If the cameras are named differently between screens
(`Camera1…` vs `D1…`), they are different recorders. Open Network settings
from *each* monitor and compare the IP.

---

## Route decision

| What you found | Route |
|---|---|
| Nothing can be left on site | **Email** — the NVR pushes snapshots out |
| A machine can live there | **RTSP** — most reliable, nothing to leave open |
| A PC already shows the cameras | Screen share |
| Locked NVR, laptop available | USB HDMI capture stick, ~$20 |

Email was right for J Street. It needs nothing on site and survives
everything.

---

## Email route, in order

1. **New Gmail** for alerts, 2-Step Verification on, then an **app
   password** (16 characters). Not the account password — that will be
   used in two places and it's the app password both times.
2. **NVR → Network → Email**: `smtp.gmail.com`, port 587, TLS, username
   and password = the Gmail and the app password, receiver = **the same
   Gmail**. Press **Test** and confirm an email arrives before anything
   else.
3. **NVR → Alarm → Video Detection → Motion Detection**:
   - Channel = the entrance
   - **Region**: see tuning below
   - **Schedule**: the unstaffed hours
   - **Send Email** ticked, **Picture Storage** ticked
   - **Buzzer, Alarm Tone, Alarm Output, Remote Voice, IP Speaker, Warning
     Light all OFF** — nothing should make noise in a gym at 2am
   - Leave **Record Channel** and **Log** as you found them
4. **Render**: `ANTHROPIC_API_KEY`, SMTP variables, and **`DATA_DIR`
   pointing at a mounted disk**. Commit `ingest-zones.json`.
5. Start Command stays **`node server.js`**.

---

## Region tuning — the part that actually takes time

**There is a 1–3 second delay between detection and the snapshot firing.**
This drives almost every problem.

- **Empty photos, no person in them** → the region is too tight. They trip
  it and are gone before the shutter. **Widen it back toward the
  approach** so the trigger fires earlier.
- **Triggering way too early** → region extends too far up the approach.
  Pull it back, and raise **Anti-Dither** to ~15s so one person walking up,
  pausing and crossing is a single event rather than three.
- **Constant false alerts** → something in the region moves on its own.
  Glass doors reflecting headlights, a clock overlay, a TV, a fan.
- **Nothing detected at all** → region drawn where nobody walks, or the
  arming schedule doesn't cover the time you tested.

**Set snapshot count to 3 with a 1-second interval** if the NVR offers it.
Three shots across three seconds is what lets the analysis tell "one person
paused to scan then entered" from "two people entered together". Single
snapshots can't show that.

**Change one setting at a time and test between.** Otherwise you won't know
which one did it.

---

## Turnstiles specifically

Better than an open doorway — a physical barrier makes tailgating a
distinct event. But the bars themselves move, so keep the region on the
**approach and the gap people pass through**, not the rotating section, or
the turnstile triggers itself.

---

## Traps that cost time at J Street

- **`DATA_DIR` must be set separately from mounting the disk.** Mounting a
  disk on Render changes nothing on its own. Until the variable points at
  the mount path, every deploy wipes the log. The startup line now reports
  this.
- **The Start Command stays `node server.js`.** A command that only polls
  never opens a port, and the host kills it — "no open ports detected".
- **`SMTP_USER` is literally the word `apikey`** for SendGrid. For Gmail
  it's the address.
- **Opening alarm emails in Gmail used to hide them** from the poller.
  Fixed — progress is tracked by message UID now — but worth knowing.
- **The schedule blocks manual reprocessing too**, or it did. Now manual
  runs bypass it.
- Check the **NVR clock**. J Street's two recorders were two hours apart.
  Alert timestamps have to line up with the check-in system or nobody can
  reconcile them.

---

## What to record for the next gym

- Region shape that worked, and roughly how far up the approach
- Sensitivity and threshold values
- Measured snapshot delay
- Snapshot count and interval
- Events per night, and the cost that came to
- How many alerts were real on night one
