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
| The website doesn't know this gym / *Tell Joseph at SecurityAI* | Admin page > **Gyms**: check the gym is there. Then get a pairing code for that gym and run `node pair.js` again. |
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
| Motion number never moves | `node setup-camera.js` again, pick a tighter grid box round the turnstile. |
| Fan roaring / `only 1.5 pictures a second` | `node setup-camera.js` again, type **S** for the small one. |
| `The monitor is already running in another window` | Use that window, or Ctrl-C there first. Only one runs at a time, so nothing gets counted twice. |
| `No camera settings yet` | `node setup-camera.js` |
| Test: `…is an older version that can't do the test` | `node update.js`, wait a minute, then `node rtsp-run.js --test` again (a monitor open in another window: Ctrl-C it first). |
| Test: `The daily limit for tests is used up` | Tests are capped at pennies a day. Try again tomorrow. |
| Anything else | Photo of the whole screen, send it. |

The pictures from setup are in `~/securityai/camera-check`.
