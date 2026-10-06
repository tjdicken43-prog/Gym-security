# Installation playbook

What was learned installing at J Street, written down so gym number two
takes an evening instead of a week. The step-by-step is in START-HERE.md;
this is the background.

---

## Work out what you're dealing with first

Walk to the camera machine and try to move the mouse off the screen.

- **Mouse trapped in the camera view** → an NVR (recorder) appliance. Normal:
  the camera computer reads it over the network.
- **Mouse leaves the screen / there's a taskbar** → a normal PC running camera
  software. Find the recorder or cameras it's reading from; that's what the
  camera computer connects to.

Then find the recorder's IP: **System → Network** (on the LTS PRO-X:
System > Network > Basic). Write down the IP.

**Check which recorder you're actually on.** J Street had two, on two
monitors, and everything configured on the first one would have been
watching the wrong building. If the cameras are named differently between
screens (`Camera1…` vs `D1…`), they are different recorders. Open Network
settings from *each* monitor and compare the IP.

## The route

One route: a laptop (to prove it works) and then a Raspberry Pi, plugged into
the recorder's network, running `node setup-camera.js`. It pairs with the
website, finds the camera address itself and watches the live stream.
Earlier routes (recorder emails, browser screen share, hand-typed addresses)
are in OLD-ROUTES.md and shouldn't be used.

---

## Picking the doorway

The wizard shows the entrance camera on a lettered grid; you type the
top-left and bottom-right squares, e.g. `B2 C4`.

- Include the doorway **and a step of floor in front of it**, so the burst
  starts as someone arrives, not after they're through.
- **Turnstiles:** keep the box on the approach and the gap people pass
  through, not the rotating arms, or the turnstile triggers itself.
- **Too many false crossings** → something in the box moves on its own:
  glass reflecting headlights, a clock overlay, a TV, a fan. Pick a tighter box.
- **Your own walk-through not detected** → the box is where nobody walks, or
  it's outside the gym's watched hours.
- At full 4K a person barely moves a cell of the detection grid. If the
  wizard offers the small sub-stream (**S**), it's usually the better choice.

**Change one thing at a time and test between.** Otherwise you won't know
which one did it.

---

## Traps that cost time at J Street

- **Hand-typed camera addresses.** Typos, `!` in the password breaking bash,
  the bare `rtsp://ip:554/` address that always shows channel 1. Never type
  one; re-run the wizard.
- **The recorder locks the account** after a few wrong passwords. The wizard
  stops after one retry. If it's locked, wait 30 minutes.
- **`DATA_DIR` must be set separately from mounting the disk.** Mounting a
  disk on Render changes nothing on its own. Until `DATA_DIR` points at the
  mount path, every deploy wipes the log and the gym accounts. The admin
  page's **Render settings** box shows whether it's set.
- **The Start Command stays `node server.js`.** Anything else never opens a
  port, and Render kills it: "no open ports detected".
- **The Mac must not sleep.** The monitor keeps it awake while it runs
  (`caffeinate`), but the lid must stay open and it must be plugged in.
- **Check the recorder's clock.** J Street's camera clock is about an hour
  fast, and its two recorders were two hours apart. The time burned into the
  photo is the camera's; the time on the activity page is the real one.

---

## What to record for the next gym

- Which channel is the door, and the grid squares that worked
- Main stream or sub-stream, and the picture size
- Crossings per night, and the cost that came to (admin page > Running cost)
- How many flags were real in the first week

---

## Camera computer at a new gym: the whole checklist

1. Phone, `your-site/admin.html` > **Gyms** > *Add a gym* (name + manager
   email). Set its watched hours (usually 9 PM – 5 AM; until you do, it watches all day) and your alert email.
2. Phone: *Connect a camera computer* > pick the gym > **Get a pairing code**
   (lasts 15 minutes).
3. On the laptop or Pi (Node 18+, ffmpeg in Downloads or installed, cable to
   the recorder, internet on): `curl -O https://your-site/update.js` then
   `node update.js`. It asks for the website address and that code.
4. *Start the camera setup now?* Enter (or later: `cd ~/securityai` then
   `node setup-camera.js`): recorder login, channel, doorway squares,
   *keep it running* = yes.
5. Wait for `Connected to the website ✓`, then walk through. Admin page
   **Right now** goes green.
6. Now tap **Send to gym** > **Text it** / **Email it**. The manager taps the
   link and is signed in; they never type the code.
7. Add the gym's line to UptimeRobot (admin page > *Get a text or email at
   2 AM…* gives the address to copy).

Each gym gets its own camera computer. One website serves all of them.
