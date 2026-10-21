# Raspberry Pi: camera + front-desk screen reader (one box per gym)

The Pi watches the gym's entrance camera and reads member numbers from the
front-desk screen through an HDMI splitter. Nothing gets installed on the
front-desk computer. Works with any check-in system: Ashbourne is built in,
and any other system is learned from one test scan on install day, whether its
screen shows a pop-up, a list of check-ins (newest at the top or the bottom),
both, or only the member's name.

## Before you go (check the gym can use it)
Send the owner to **/check** on the website ("Will it work at your gym?"). It tells
you their recorder brand, the camera angle, their check-in system and what plugs into
their front-desk screen, and it's on the admin page under **Gyms that checked**.

## What you need (per gym)
- Raspberry Pi 5 (2GB is plenty) + its 27W USB-C power supply + case
- **Two** high endurance 32GB microSD cards (one goes in the Pi, one becomes the spare, see below)
  and a USB microSD card reader (about $8)
- A network cable from the Pi to the gym's router if there's one nearby (much more reliable than Wi-Fi)
- Powered HDMI splitter (1 in, 2 out) + USB HDMI capture stick (1080p)
- 2 short HDMI cables (a DisplayPort-to-HDMI adapter if the PC uses DisplayPort); a power strip
- Optional: a mini UPS if the gym loses power often
- A laptop, only to write the memory card and type the setup commands

## 1. Prepare the memory card (on the laptop, 10 min)
1. Install **Raspberry Pi Imager** from raspberrypi.com/software and open it.
2. Device: **Raspberry Pi 5**. OS: **Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit)**.
   Storage: the microSD card.
3. When it asks about settings, choose **Edit settings**:
   - Hostname: `securityai-` plus the gym (e.g. `securityai-jstreet`). Each Pi a different name.
   - Username and password: pick them and **write them down**
   - Wireless LAN: the gym's Wi-Fi name and password (skip if you'll use a cable)
   - Services tab: **Enable SSH** (use password)
4. Save → Yes → wait until it says it's finished. Put the card in the Pi.

## 2. Wire the front desk (5 min)
**An iPad at the desk instead of a computer?** No splitter: a USB-C (or Lightning) to HDMI adapter
on the iPad, an HDMI cable from it into the capture stick, and the iPad's charger into the adapter.
The iPad's own screen keeps working. In iPad Settings → Display & Brightness → Auto-Lock: **Never**.

1. Unplug the cable from the back of the front-desk monitor and plug it into the splitter's **IN**.
2. Splitter **OUT 1** → the monitor (short HDMI cable). **OUT 2** → the capture stick.
3. Capture stick → a **blue USB port** on the Pi.
4. Power: the splitter and the Pi into the power strip. (Better: a network cable from the router.)
5. On the front-desk PC: the screen must never turn off (Windows: Settings → System → Power →
   Screen and sleep → **Never**; screen saver **None**). Turning only the monitor off is fine.
6. Leave the check-in screen showing where members appear when they scan. On Ashbourne:
   the **Live Entry** pop-up, ideally with the **Visit Log** too (the Pi reads both). On other
   systems: their check-in pop-up, their list of today's check-ins, or both. Staff can scroll the
   list, open other pages and come back: the Pi tells new rows from old ones (and if the list
   shows times, scans that came in while another page was open are still counted).
7. Label the splitter and the cables: **"SecurityAI — don't unplug"**.

## 3. Set up the Pi (10–15 min)
1. Wait 2 minutes after the Pi gets power. On the laptop, open **Terminal**:
       ssh YOURUSERNAME@securityai-jstreet.local      (the hostname you picked)
   Type `yes` if asked, then the Pi's password (it doesn't show as you type).
2. Paste this and press Enter:
       curl -fsSL https://gym-security.onrender.com/pi-setup.sh | bash
3. It asks:
   - **A laptop already watching this camera?** Only J Street's first setup: yes, and it moves the
     laptop's settings over. Every new gym: no.
   - **Pairing code** (new gym): admin page → tap the gym → **Connect a camera computer** →
     Get a pairing code. Then it finds the entrance camera with you.
   - **Reader code**: admin page → tap the gym → Protected member numbers → **Reader: new code**.
     Check the owner code it shows matches yours.
   - **Is the front desk on Ashbourne?** If not, it runs the **teach** step. It asks whether the
     screen shows member numbers; if it only shows names, type your first name as the screen shows
     it. Then scan in once at the front desk: it shows the last 2 digits of the number it spotted
     (or "your name") and where: next to a label, as a new row at the top or bottom of a list, or
     both. Say yes if it's yours. (Run it again any time: `node screen-reader.js --teach`.)
   - **Remote access (Tailscale)**: say yes. A link appears; open it on your phone and sign in to
     your own Tailscale account (the same account for every gym). From then on you can reach
     every Pi from the Tailscale app, wherever you are.
     **Then, the same day:** login.tailscale.com > Machines > this Pi > the ... menu >
     **Disable key expiry**. Otherwise remote access quietly switches itself off after 6 months.
   - **Backup Wi-Fi** (only if the Pi is on Wi-Fi): add the gym's other network (guest Wi-Fi) so the
     Pi still gets online if the main Wi-Fi password ever changes.
4. At the end: `sudo reboot` once so the power-cut protection takes full effect.
5. **Make the spare card** (5 minutes): put the second card in the USB card reader, plug it into the
   Pi, and run `cd ~/securityai && bash make-spare-card.sh`. Label it and leave it in the gym
   office. If the Pi's card ever dies, anyone at the gym can swap it in while you talk them through
   it on the phone: unplug the Pi, swap cards, plug it back in. Make a new copy after big changes.

The admin page now shows the Pi as the gym's camera computer and **Front-desk screen reader**.
You get an email if the picture or the check-in screen goes missing during watch hours.

## What the power-cut protection does
- Logs are kept in memory, not on the card (most card damage comes from writes during a power cut).
- The card is checked and repaired every time the Pi starts.
- If the Pi ever freezes, it restarts itself within a couple of minutes.
- The reader's small temporary pictures are kept in memory too.

## Fixing things without driving to the gym
On your phone or laptop with Tailscale on: `ssh YOURUSERNAME@securityai-jstreet`, then `cd ~/securityai`.

| What you're told | What to do |
|---|---|
| **The check-in screen is not showing / couldn't be read overnight** | Usually the front-desk PC was locked, logged off, or an account was left open. Text the staff: "please unlock the front-desk PC and leave the check-in screen (Visit Log) open". Nothing to do on the Pi; entries in that time were judged by the camera only, never called "no scan". |
| **The Visit Log was hidden (an account left open)** | Same text to staff: close member accounts and go back to the Visit Log before leaving. Scans were still read from the pop-ups. |
| **The check-in screen changed / can't be read after an update** | `node screen-reader.js --teach` and ask whoever is at the desk to scan once while it runs. |
| **The camera recorder moved to a new address** | Nothing: the Pi finds the same recorder again by itself (by its hardware address) and carries on. You'll see it in the log. |
| **The recorder rejected the password** | The owner changed it. Get the new password, then `node setup-camera.js` and type it. (The Pi stops trying on purpose so the recorder doesn't lock the account.) |
| **No picture from the camera / the view looks wrong** | Ask staff to look at the camera (bumped? covered?). Check with `node rtsp-run.js --check`. |
| **The Pi is offline** | Ask staff to check the Pi's light and power, and unplug/replug the power. Still offline: the gym's internet or Wi-Fi changed (a network cable fixes this for good). |
| **The Pi won't start at all** | The spare card: unplug, swap the cards, plug back in. |
| Anything else | `sudo reboot` fixes most things; it's back in about a minute. |

## Every so often
- Updates are automatic: when you deploy to Render, the Pi updates itself the next time the
  door has been quiet for 20 minutes, checks the new version works, and goes back to the old one
  by itself if it doesn't (the admin page says so). By hand: `cd ~/securityai && node update.js`
  (`node update.js --undo` goes back one version).
- Camera too much for the Pi? `cd ~/securityai && node camera-speed.js`
- Check the screen reader: `cd ~/securityai && node screen-reader.js --check`
- The check-in system changed its screen? The admin page tells you ("the check-in screen is not
  showing" or "cannot be read"). Run `node screen-reader.js --teach` again.
  Back to Ashbourne: `node screen-reader.js --forget`.

## When a gym cancels
Admin page → tap the gym → **Close this gym**. It switches everything off and deletes their
photos, logins and member data. Collect the Pi, splitter and capture stick. Before reusing the
Pi for another gym, write a fresh card (step 1).
