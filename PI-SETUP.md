# Raspberry Pi: camera + front-desk screen reader (one box)

The Pi takes over from the laptop. It watches the camera, and reads member
numbers from the front-desk screen through an HDMI splitter. Nothing gets
installed on the front-desk PC, and Ashbourne and its antivirus are never involved.

## What you need
- Raspberry Pi 5 (2GB is plenty) + its 27W USB-C power supply + 32GB microSD + case
- Powered HDMI splitter (1 in, 2 out) + USB HDMI capture stick (1080p)
- 2 short HDMI cables; a power strip at the front desk
- The laptop (for 15 minutes: to write the memory card and to hand over its settings)

## 1. Prepare the memory card (on the laptop, 10 min)
1. Install **Raspberry Pi Imager** from raspberrypi.com/software and open it.
2. Device: **Raspberry Pi 5**. OS: **Raspberry Pi OS (other) → Raspberry Pi OS Lite (64-bit)**.
   Storage: the microSD card.
3. When it asks about settings, choose **Edit settings**:
   - Hostname: `securityai`
   - Username and password: pick them and **write them down**
   - Wireless LAN: the gym's Wi-Fi name and password (skip if you'll use a cable)
   - Services tab: **Enable SSH** (use password)
4. Save → Yes → wait until it says it's finished. Put the card in the Pi.

## 2. Wire the front desk (5 min)
1. Unplug the HDMI cable from the back of the front-desk monitor and plug it into the
   splitter's **IN**.
2. Splitter **OUT 1** → the monitor (with a short HDMI cable). **OUT 2** → the capture stick.
3. Capture stick → a **blue USB port** on the Pi.
4. Power: the splitter and the Pi into the power strip. (Optional: a network cable from the
   router into the Pi.)
5. On the front-desk PC: Settings → System → Power → Screen and sleep → turn off my screen after: **Never** (turning only the
   monitor off is still fine). Screen saver: **None**. Leave Ashbourne's **Live Entry** pop-up
   showing (anywhere on the screen, not minimized), ideally with the **Visit Log** visible
   too. The Pi reads both: each scan is confirmed when both show it, and a scan the pop-up
   missed (closed or covered) is taken from the Visit Log. If neither is on screen (e.g. the
   PC locked itself) for 5 minutes during watch hours, you get an email.
6. Label the splitter and the cables: **"SecurityAI — don't unplug"**.

## 3. Set up the Pi (on the laptop, 10 min)
1. Wait 2 minutes after the Pi gets power. On the laptop, open **Terminal**:
       ssh YOURUSERNAME@securityai.local
   Type `yes` if asked, then the Pi's password (it doesn't show as you type).
2. Paste this and press Enter:
       curl -fsSL https://gym-security.onrender.com/pi-setup.sh | bash
3. When it asks for the **move code**: open a second Terminal window on the laptop, type
       cd ~/securityai && node move.js send
   and type the code it shows into the Pi. The camera settings move over, and the laptop
   stops watching by itself.
4. When it asks for the **reader code**: admin page → Protected member numbers →
   J Street → **Reader: new code**. Check the owner code it shows matches yours.
5. It checks the picture from the front desk and says what it read (with the number hidden).
   Then it starts everything in the background.

The admin page now shows the Pi as the camera computer and **Front-desk screen reader**.
You'll get an email if the picture or the pop-up goes missing during watch hours.

## Every so often
- Updates are automatic: when you deploy to Render, the Pi updates itself the next time the
  door has been quiet for 20 minutes, checks the new version works, and goes back to the old one
  by itself if it doesn't (the admin page says so). To update by hand anyway: `ssh` in, then
  `cd ~/securityai && node update.js` (`node update.js --undo` goes back one version).
  To turn automatic updates off on one computer, add `"autoUpdate": false` to `~/.securityai/rtsp-zones.json`.
- Camera too much for the Pi? `cd ~/securityai && node camera-speed.js` (the setup runs it once)
- Check the screen reader: `cd ~/securityai && node screen-reader.js --check`
- The admin page shows how many scans it read, how many the Visit Log confirmed, how many it
  caught from the Visit Log, and any "uncertain" (the two showed different numbers: the gym
  page then says "likely", never "certain", for that entry).
- Give the laptop back: on the laptop, `cd ~/securityai && node install-service.js --wipe`
