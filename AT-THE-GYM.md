# At the gym — phone card

**Never type a camera address or a long token by hand.** The wizard and a
6-digit pairing code do it for you.

## The night before (at home, 10 min)

Tick every box before you drive over. If one won't tick, fix it at home.

- [ ] The new code is uploaded to GitHub and Render says **Live**.
- [ ] On your phone, **your-site/admin.html** opens with your admin token, and
      *Remember on this phone* is ticked. Also keep the token in Notes
      (Render > Environment > the eye icon next to `ADMIN_TOKEN`).
- [ ] Admin page > **Render settings** says *All must-have settings are there*,
      and the `DATA_DIR` line is ✓ too (without it, every deploy wipes the gyms).
- [ ] Admin page > **Add a gym**: type *J Street Gym*, the manager's email and
      the time zone. Tick **Adopt 'jstreet' (… saved entries)**: that is J Street's
      history already on the website. Then **Create gym**. It says
      *Created J Street Gym. Sign-in code: …*
      (J Street Gym was already there? Its card shows a button
      **Adopt 'jstreet' (… saved entries)**: tap it, it says *Done.* No Adopt box
      or button at all? Nothing was saved on the website: just carry on.)
      The laptop does not need to be on for this.
- [ ] Admin page > J Street Gym > **Send a test alert** > *Send a test to me*:
      the email arrives.
- [ ] Pack: the laptop **and its charger**, a network cable long enough to reach
      the recorder, your phone (charged), the recorder's username and password
      (the login that works on its web page), and the laptop's own login password.

## First time on a computer (at the gym, ~20 min)

Node.js 18 must already be on the laptop (RTSP-SETUP.md, step A1). ffmpeg
(A2) just has to be in **Downloads**: the camera setup finds it there.

1. Plug in the **charger** and the **network cable** (same spot as Friday).
   **Leave Wi-Fi on**: the website needs the internet, the cable is for the recorder.
2. **Phone:** admin page > *Connect a camera computer* > pick J Street Gym >
   **Get a pairing code**. It lasts 15 minutes and works once.
3. **Laptop:** open Terminal and get the program. Pick one:
   - **The old Friday folder is still on this Mac** (type these three lines):

         cd ~/Downloads/Gym-security-main
         curl -O https://gym-security.onrender.com/update.js
         node update.js

     (Use your own website address.) It asks for the **website address**
     (`gym-security.onrender.com` is enough) and the **pairing code** (spaces
     don't matter). Then:
     - *Delete the old folder now? (Y/n)*: press **Enter**. It holds your
       Anthropic API key and old photos; this laptop doesn't need them any more.
     - *Start the camera setup now? (Y/n)*: press **Enter** and go to step 4.
   - **New computer, nothing on it yet:** type the line shown on the admin page
     under *Connect a camera computer*:

         curl -O https://gym-security.onrender.com/update.js && node update.js

     Same two questions, then *Start the camera setup now? (Y/n)*: **Enter**.
4. **The camera setup** asks, in this order:
   - Recorder IP, username, password (shows `*****`: that's normal).
     Press **Enter** to keep a value shown in `[brackets]`.
   - A picture of every channel opens. *Which channel number shows your
     entrance?* Type **4**.
   - *Testing whether this laptop keeps up with the big picture (10 seconds)...*
     Then press **Enter** (it picks the right one for this laptop).
   - Name for the door and people per swipe: **Enter**, **Enter**.
   - A picture with a lettered grid opens. Type the two corner squares round
     the turnstile and the floor in front of it, then **Enter** if the
     preview shows them. On J Street's camera 4 that is about **`B1 D5`**:
     the whole turnstile (top to bottom) and the open floor beside it. Leave
     out the wire-mesh walls at the far left and right and the clock in the
     bottom-right corner: the clock changes every second and the fine mesh
     can shimmer at night, and neither is someone coming in. (Wrong camera in the picture? Ctrl-C and
     start again: `cd ~/securityai` then `node setup-camera.js`.)
   - *Start it now and keep it running? (Y/n)*: **Enter**.
5. It says **=== Done. Walk through the door now. ===** and shows the live
   output. Wait for `Connected to the website ✓` and
   `Front Door  ✓ picture is coming through.`
6. **Walk through the door.** Laptop: `▶ crossing detected`, then
   `✓ 1 person counted, 1 expected — OK`. Phone: the activity page says
   *Watching your entrance* and shows the walk-through; the admin page says
   *All good.* and J Street Gym says *Watching*.
   (Outside the gym's watched hours the laptop says the crossing was
   *not counted*: that's expected.)
7. Press **Ctrl-C**. That only stops *watching*: the monitor keeps running.

## 5-minute accuracy test (right after the first walk)

It checks, at this door, that walks are noticed, people are counted right
and two people on one rotation get flagged. You need a coworker for the
two-person walks. **Only film people who agreed to it** (you, and a coworker
who said yes). Pick a quiet moment: the door isn't watched for real meanwhile.

1. **Laptop**, in Terminal:

       cd ~/securityai
       node rtsp-run.js --test

   It says `Cost: this test counts at most 15 crossings: about 6 cents at most.`
2. For each of the 11 walks it shows (and says out loud) what to do, e.g.
   `Walk 6 of 11: Two people on ONE rotation (one right behind the other)`,
   gives you 20 s to get in place (30 s for the first), then
   `GO — waiting up to 60 s for the walk…`.
   Do the walk. Keys (then Enter): **Enter** = skip it, **r** = redo the last
   one, **q** = stop. Laptop far from the door? Use
   `node rtsp-run.js --test --gap 45 --wait 90` instead.
3. At the end it prints the **SCORECARD**. Good looks like:

       Walks noticed:     10 of 10
       Counted right:     10 of 10
       Tailgates caught:  3 of 3  (two people on one rotation)
       False alarms:      0  (a walk wrongly flagged as tailgating)
       Arm wave:          ignored ✓

       Verdict: Good: it noticed every walk, caught every tailgate and raised no false alarms.

   Not good? Do what its `Do this:` line says: `node setup-camera.js`
   (tighten the box round the turnstile), or send the folder (step 4).
4. **Send the folder.** It says
   `Send this file to Claude (drag it into the chat): ~/securityai/camera-check/test-….zip`
   and Finder shows it. Send it even when the result is good.
5. **Phone:** admin page > J Street Gym > *Accuracy test* shows the same
   scorecard. **Compare with Haiku** re-checks the same photos (about 1-2
   cents). Only press **Switch … to Haiku** if it says *Switch to Haiku*.

## Before you leave (tick all)

- [ ] **Lid OPEN.** Closing the lid puts a Mac to sleep, even when plugged in.
      Nothing is watched while it sleeps (the admin page says so afterwards).
- [ ] **Charger plugged in.** A 2015 laptop won't switch itself back on after
      the battery runs flat.
- [ ] Network cable in, Wi-Fi on.
- [ ] System Preferences > **Users & Groups** > click the padlock (laptop
      password) > Login Options > *Automatic login*: this account. Then after a
      restart the monitor starts by itself.
      (Greyed out? FileVault is on: after any restart someone must log in.)
- [ ] System Preferences > **Energy Saver** > Power Adapter: tick *Prevent
      computer from sleeping automatically when the display is off*.
- [ ] Admin page > J Street Gym > **Settings: watch hours**: set **9 PM to 5 AM**
      (it watches all day until you do, and daytime uses up the daily limit).
- [ ] Admin page > *Get a text or email at 2 AM…*: copy the gym's uptime link
      into a free UptimeRobot monitor.

## Every other visit

Nothing to start. To **look** at it, in Terminal:

    cd ~/securityai
    node rtsp-run.js

That shows the live output. **Ctrl-C stops watching**, not the monitor.
(`~` is Shift and the key left of 1.)

## Updating (after you deploy a new version to Render)

    cd ~/securityai
    node update.js

It downloads the new program **from your own website** and doesn't touch your
settings. The monitor restarts itself on the new version within a minute.
If something is wrong with the new one: `node update.js --undo`.

## Giving the laptop back (or when the Pi has taken over)

    cd ~/securityai
    node install-service.js --wipe

Type `YES`. It stops the monitor and deletes everything SecurityAI put on the
laptop: the camera password, the website pairing, the program, the camera
pictures, old copies in Downloads (with the old API key), and camera addresses
in Terminal's history. Then quit Terminal (Cmd+Q).
Your Anthropic key sat on this laptop on Friday: to be safe, make a new one on
console.anthropic.com, put it in Render, and delete the old one there.

Only stopping it for a while (e.g. moving to the Pi, keeping the laptop as a
spare)? `node install-service.js --remove` instead: settings stay.

## Checking from your phone

- **admin.html > Right now**: website / camera computer / camera picture /
  last crossing, plus one sentence saying what's wrong.
- **Get a text at 2 AM:** see *Before you leave*. It warns you if the laptop
  sleeps, loses the internet, the camera has no picture for 3+ minutes, or
  **Render itself is down**.

## If something goes wrong

| You see | Do this |
|---|---|
| `cd: securityai: No such file or directory` | Type `cd ~/securityai` (with the `~/`). |
| `That code is not right` / `expired` / `already used` | Admin page > **Get a pairing code** again (they last 15 min and work once). |
| `Too many wrong codes` | Make a new code on the admin page and type it carefully. |
| `Cannot find https://gym-security.onrender.com` | Check the spelling, and that Wi-Fi is on. |
| `Pairing is not switched on: ADMIN_TOKEN is not set` | Render > Environment > add `ADMIN_TOKEN` (press Generate) > Save, wait for **Live**, then `node update.js` again. |
| `does not recognise this computer (401)` | Get a pairing code on the phone, then `cd ~/securityai` and `node pair.js`. |
| Admin page: *Not paired* / *Computer is on but not paired* | Same: admin page > *Connect a camera computer* > **Get a pairing code**, then on the laptop `cd ~/securityai` and `node pair.js`. |
| Admin page: *Computer OFFLINE (asleep: lid closed? unplugged? no internet?)* | Lid open? Charger in? Wi-Fi on? It checks in again by itself within a minute of waking. |
| The website doesn't know this gym / *Tell TJ at SecurityAI* | Admin page > **Gyms**: check the gym is there. Then get a pairing code for that gym and run `node pair.js` again. |
| `ffmpeg is not on this computer` | Download ffmpeg (RTSP-SETUP.md A2), double-click the zip in Downloads, then `node setup-camera.js` again. |
| `password or username rejected (401)` | Check the login on the recorder's web page. You get **one** retry, then it stops so the account isn't locked. |
| `rejected the login AGAIN` / account locked | Recorder: System > User Management. Check the account is enabled. Wait 30 min if it's locked. |
| `Not tried — the recorder rejected this username/password` | `node setup-camera.js` and type the password again. |
| `Cannot reach 192.168.2.54` | Check the cable is in the same spot as Friday, wait 20 s, try again. Still no? The recorder picks its own address (System > Network > Basic shows **DHCP** switched on), so after a restart it can get a new one. Read the **IP Address** on that screen, then `node setup-camera.js` and type the new address. To stop it changing, ask whoever runs the gym's router to "reserve" that address for the recorder. |
| `port 554 (camera video, "RTSP") is closed` | Recorder: System > Network. RTSP must be ON. |
| `Not starting — fix this first` … `no channel number` | That's Friday's address (it shows the pro shop). `node setup-camera.js`, pick channel **4**. |
| `This computer was asleep from …` | The lid was closed or the Mac slept. Lid open, charger in, Energy Saver setting above. |
| `The recorder refused the video connection` / `cannot reach the recorder` / `No answer from the recorder` | Was it working before? The recorder is restarting or the cable came out: check the cable, it retries by itself. |
| `The website is not answering properly` | Render is restarting (a deploy). Wait: crossings are kept on the laptop and sent when it's back. |
| Wrong camera (pro shop instead of door) | `node setup-camera.js` again, pick channel **4**. |
| `the only address that works has NO channel number` | Type **n**. Then `node find-stream.js` (asks the recorder for each camera's real address), then `node setup-camera.js` again. |
| Setup says `Cannot reach 192.168.2.54` but the laptop's cable is in a numbered camera port on the recorder | Use the recorder's camera-side address instead: `ping -c 3 10.1.1.1`; if it answers, type `10.1.1.1` at the recorder IP question. Keep Wi-Fi on and first in Network > Set Service Order (that side has no internet). |
| Motion number never moves | `node setup-camera.js` again, pick a tighter grid box round the turnstile. |
| Fan roaring / `only 1.5 pictures a second` | `node setup-camera.js` again, type **S** for the small one. |
| `The monitor is already running in another window` | Use that window, or Ctrl-C there first. Only one runs at a time, so nothing gets counted twice. |
| `No camera settings yet` | `node setup-camera.js` |
| Test: `…is an older version that can't do the test` | `node update.js`, wait a minute, then `node rtsp-run.js --test` again (a monitor open in another window: Ctrl-C it first). |
| Test: `The daily limit for tests is used up` | Tests are capped at pennies a day. Try again tomorrow. |
| Anything else | Photo of the whole screen, send it. |

The pictures from setup are in `~/securityai/camera-check`.

## Don't check people leaving (saves the daily limit)

People walking OUT through the turnstile are checked too unless you tell the
monitor which way is IN. Once, at the gym:

1. Watch the monitor:  `node rtsp-run.js`
2. Walk **in** through the turnstile. Its line says e.g.
   `crossing detected (2.0 s moving down)`.
3. Ctrl-C, then type the word(s) it showed:  `node rtsp-run.js --entry down`
   (an entry that shows two lines, e.g. "up" then "left": `node rtsp-run.js --entry left,up`)

From then on people moving the other way show
`◁ someone leaving … not checked, costs nothing`. Undo: `node rtsp-run.js --entry off`.

## What else it watches for (nothing to set up)

- **Waiting at the turnstile, then slipping in.** If someone hangs around the
  turnstile and someone comes in within 30 s, Claude is told to look extra
  closely. A wait of 12 s or more always lands in "Worth a check".
  Screen line: `⚠ someone was at the turnstile for about N s before this`.
- **Shared phone code.** A member inside hands their phone back through the
  turnstile so a friend can scan the same code once the lockout is over. When
  someone came back out, or stood at the turnstile, in the 90 s before an
  entry, 1–2 photos of that moment go along with the entry (cost: about a
  tenth of a cent). If Claude sees a phone or card passed over, it is
  **Flagged**: "Someone may have scanned in on another member's phone".
  The manager looks up whose code scanned at that time: that member shared it.
  Screen line: `⚠ someone came out through the turnstile N s before this`.

## Check Ashbourne's clock (2 minutes, once)

Matching a flag to the right scan relies on Ashbourne's times being right.
Open a clock with seconds on your phone (e.g. time.is).

1. Scan in at the turnstile when your phone shows **:55** seconds. Go through.
2. Wait for the next minute, then scan in again at **:05** seconds. Go through.
3. In Ashbourne's Visit Log (Zone 1), look at both scans:
   - Scan 1 shows the same minute as your phone, and scan 2 shows the next one: **Ashbourne is within 5 seconds. Nothing to do.**
   - Scan 1 already shows the NEXT minute: Ashbourne is fast. Repeat with :45, :35… to see by how much.
   - Scan 2 still shows the EARLIER minute: Ashbourne is slow. Repeat with :15, :25… to see by how much.
4. If it's off, put the seconds in the admin page → J Street → settings →
   "Check-in system's clock" (e.g. 20 if it's 20 s fast, -20 if 20 s slow).

## Ashbourne screen check (once, before the reader)

1. Upload the latest zip to GitHub and wait for Render to say Live.
2. On the Ashbourne PC: Ashbourne open on the **Visit Log**.
3. On that PC, open the admin page in a browser → **Ashbourne screen check** →
   **Copy**.
4. Click Start, type **Windows PowerShell**, open it, right-click to paste,
   press Enter.
5. It says *Found Ashbourne* (or shows a numbered list: type the number of
   Ashbourne). When it says **go SCAN IN**, scan in at the turnstile 2–3
   times, come back and press **Enter**.
6. On your phone: admin page → Ashbourne screen check → **Download** → send
   the file to Claude.

## Member numbers: the front-desk reader (once)

The flagged entries can say **"Came in behind member #1776"**, exact to the
second, with member numbers scrambled so only phones you approve can read
them. The website itself can't.

**1. Your owner device (on your own phone, once).** Admin page → *Protected
member numbers* → **Make this my owner device**. Note its code (e.g. Z7P-P76).
Use this phone for approvals. It can always see member numbers for every gym.
(Losing it: "Make this the owner device instead" on a new phone, then set the
reader up again, step 2.)

**2. The reader on the Ashbourne PC.** Admin page → J Street → **Set up the
front-desk reader** gives a 6-number code. On the Ashbourne PC open **Windows
PowerShell** and paste:

    irm https://gym-security.onrender.com/securityai-reader.txt | iex

Type the code. It shows an **owner device code**: it must match yours. Press
Enter for Zone 1. Done: it runs hidden and starts by itself when the PC signs
in. Keep Ashbourne open; the screen can be off, but the PC must not sleep
(Settings → System → Power → Sleep: Never).

**3. Staff phones.** On the gym page a manager taps **Ask for access on this
phone** and types their name. A code shows on their screen. On your owner
device: admin page → **Approve**, after checking the code matches theirs.
**Remove** cuts a phone off straight away.

Update the reader: paste the same line on the Ashbourne PC and pick 1.
Remove it: same line, pick 3. Nothing is left behind.

Admin sign-in: with email set up on Render (SMTP_* and SUPPORT_EMAIL or
ADMIN_EMAIL), each new browser also needs the **Approve** link emailed to you.
If email ever breaks, set ADMIN_EMAIL_CONFIRM=off on Render to get in with the
token alone.

**With the reader running, scans are counted against people automatically**
(scan times only; member numbers stay scrambled):
- 1 person seen, 1 scan → cleared to Passed ("Scan ✓"), unless the camera
  couldn't rule out a second person.
- 2 people seen, 1 scan → red: "2 people came in, only 1 scan".
- Flagged but everyone scanned → moved to Worth a check ("probably fine").
- Someone came in with no scan (exit button, held door) → Worth a check.
- People leaving (exit button) are listed as "Leaving" and never need a scan.

## What it fixes by itself, and what it emails you about

Fixes by itself (no email):
- Ashbourne closed and reopened, or restarted: the reader finds it again and starts fresh (never counts an old pop-up).
- Ashbourne renames the member-number label to a common wording (Member No, Member Number, Mem No…): read anyway.
- The zone moves somewhere else on the pop-up: found anyway.
- Internet drops on the front-desk PC: scans wait on the PC and send when it's back.
- A newer reader on the website: the PC installs it within 6 hours (only when no scans are waiting).

Emails you (subject starts with the gym name), each with what happened and how to fix it:
- Ashbourne not open on the PC for 5 min during watch hours (not overnight).
- The pop-up is there but the member number can't be read for 2 min (Ashbourne changed its screen).
- The PC can't reach the website (scans waiting).
- The reader went quiet, was unpaired, or the owner device changed.
- Scans and camera entries don't line up over the last hour (checked every 15 min), either way round.
- Camera covered, dark, frozen or turned; the daily limit reached.
- A "back to normal" email when a reader problem clears.

Emails need SMTP and SUPPORT_EMAIL set on Render. The admin page shows the same problem and fix under Protected member numbers.
