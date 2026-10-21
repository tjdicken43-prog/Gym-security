#!/bin/bash
# SecurityAI: set up a Raspberry Pi (Raspberry Pi OS 64-bit, Bookworm or newer).
# On the Pi (over SSH), paste:
#
#     curl -fsSL https://gym-security.onrender.com/pi-setup.sh | bash
#
# It installs what's needed, connects the Pi to the website and the gym's
# camera (or takes the camera settings from a laptop that already watches
# it), sets up the front-desk screen reader for any check-in system, protects
# the Pi against power cuts, optionally lets you reach it from anywhere, and
# starts everything in the background (it starts by itself whenever the Pi
# powers on). Safe to run again: it keeps what's already set up.
set -e
SITE="${SECURITYAI_SITE:-https://gym-security.onrender.com}"
B=$(printf '\033[1m'); N=$(printf '\033[0m')
step() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
ask() { local a; read -r -p "$1 " a </dev/tty; printf '%s' "$a"; }

step "1/7  Installing what the program needs (a few minutes)..."
sudo apt-get update -qq
sudo apt-get install -y -qq nodejs ffmpeg tesseract-ocr tesseract-ocr-eng curl ca-certificates v4l-utils >/dev/null
if ! node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)'; then
  echo "Node.js $(node -v) is too old (need 18+). Use Raspberry Pi OS Bookworm or newer, then run this again."; exit 1
fi
sudo usermod -aG video "$USER" || true            # read the capture stick
echo "  node $(node -v), $(ffmpeg -version | head -1 | cut -d' ' -f1-3), $(tesseract --version 2>&1 | head -1) - OK"

step "2/7  Power-cut protection"
# A Pi can damage its memory card if the power drops while it is writing.
# Logs live in memory, the card is checked and repaired at every start, and
# the Pi restarts by itself if it ever freezes.
sudo mkdir -p /etc/systemd/journald.conf.d /etc/systemd/system.conf.d
printf '[Journal]\nStorage=volatile\nRuntimeMaxUse=30M\n' | sudo tee /etc/systemd/journald.conf.d/securityai.conf >/dev/null
printf '[Manager]\nRuntimeWatchdogSec=15s\nRebootWatchdogSec=2min\n' | sudo tee /etc/systemd/system.conf.d/securityai-watchdog.conf >/dev/null
echo 'kernel.panic = 10' | sudo tee /etc/sysctl.d/90-securityai.conf >/dev/null
CMDLINE=/boot/firmware/cmdline.txt; [ -f "$CMDLINE" ] || CMDLINE=/boot/cmdline.txt
if [ -f "$CMDLINE" ] && ! grep -q 'fsck.repair=yes' "$CMDLINE"; then
  sudo cp "$CMDLINE" "$CMDLINE.before-securityai"
  sudo sed -i '1 s/$/ fsck.repair=yes/' "$CMDLINE"
fi
if [ -f /usr/share/systemd/tmp.mount ] && [ ! -f /etc/systemd/system/tmp.mount ]; then
  sudo cp /usr/share/systemd/tmp.mount /etc/systemd/system/ && sudo systemctl enable tmp.mount >/dev/null 2>&1 || true
fi
sudo systemctl daemon-reload || true
echo "  Logs in memory, card checked at every start, restarts itself if it freezes - OK"
echo "  (Best with a 'high endurance' microSD card or a small USB SSD, and a mini UPS if the gym loses power often.)"

mkdir -p ~/securityai && cd ~/securityai
step "3/7  The camera"
MOVED=""
if [ -f ~/.securityai/rtsp-zones.json ]; then
  echo "  Already set up (kept)."
  MOVED=1
else
  a=$(ask "  Is a laptop already watching this gym's camera (moving it to this Pi)? (y/N)")
  if [ "${a,,}" = "y" ]; then
    echo "  On the LAPTOP open a new Terminal window and type:   cd ~/securityai && node move.js send"
    echo "  It shows a move code. Then come back here."
    curl -fsSL "$SITE/move.js" -o move.js
    SECURITYAI_SITE="$SITE" node move.js receive </dev/tty
    MOVED=1
  else
    echo "  New gym: next, this Pi pairs with the website (a 6-number code from the admin page:"
    echo "  tap the gym > Connect a camera computer > Get a pairing code), then finds the entrance camera."
  fi
fi

step "4/7  Downloading the program..."
[ -f update.js ] || curl -fsSL "$SITE/update.js" -o update.js
if [ -n "$MOVED" ]; then
  node update.js --no-service --no-setup </dev/tty
else
  node update.js --no-service </dev/tty
fi
echo
echo "  Checking the Pi keeps up with the camera picture..."
node camera-speed.js </dev/tty || true

step "5/7  Front-desk screen reader (member numbers)"
if [ -f ~/.securityai/screen-reader.json ]; then
  echo "  Already set up (kept). Check it any time:  cd ~/securityai && node screen-reader.js --check"
else
  a=$(ask "  Is the HDMI splitter and capture stick set up at the front desk? Set the screen reader up now? (Y/n)")
  if [ "${a,,}" != "n" ]; then
    echo "  On your phone: admin page > tap the gym > Protected member numbers > Reader: new code."
    if node screen-reader.js --setup </dev/tty; then
      s=$(ask "  Is the front desk on Ashbourne? (Y/n)")
      if [ "${s,,}" = "n" ]; then
        echo "  Another check-in system: the reader learns its screen from one test scan."
        node screen-reader.js --teach </dev/tty || echo "  (Later:  cd ~/securityai && node screen-reader.js --teach)"
      fi
    else
      echo "  (You can finish this later:  cd ~/securityai && node screen-reader.js --setup)"
    fi
  else
    echo "  Later:  cd ~/securityai && node screen-reader.js --setup"
  fi
fi

step "6/7  Remote access (fix this Pi from anywhere)"
if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
  echo "  Already on (Tailscale). Reach it from your phone or laptop:  ssh $USER@$(hostname)"
else
  a=$(ask "  Set up remote access with Tailscale (free), so you can fix this Pi without driving to the gym? (Y/n)")
  if [ "${a,,}" != "n" ]; then
    curl -fsSL https://tailscale.com/install.sh | sh
    echo "  A link appears next: open it on your phone and sign in to YOUR Tailscale account (the same one every time)."
    sudo tailscale up --ssh --hostname "$(hostname)" || echo "  (Later:  sudo tailscale up --ssh)"
    echo "  ${B}Important:${N} remote access switches itself off after 6 months unless you stop it."
    echo "  On your phone: login.tailscale.com > Machines > $(hostname) > the ... menu > Disable key expiry."
  else
    echo "  Later:  curl -fsSL https://tailscale.com/install.sh | sh   then   sudo tailscale up --ssh"
  fi
fi

# A second Wi-Fi network the Pi falls back to (the gym changes its Wi-Fi
# password, or the router is replaced). Best of all is a network cable.
if command -v nmcli >/dev/null 2>&1 && ! ip route get 1.1.1.1 2>/dev/null | grep -q " dev eth"; then
  a=$(ask "  Add a backup Wi-Fi network (e.g. the gym's other or guest network) in case the main one changes? (y/N)")
  if [ "${a,,}" = "y" ]; then
    ssid=$(ask "    Backup Wi-Fi name:")
    psk=$(ask "    Its password:")
    if [ -n "$ssid" ]; then
      sudo nmcli connection add type wifi con-name securityai-backup ifname wlan0 ssid "$ssid" wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$psk" connection.autoconnect yes connection.autoconnect-priority -10 >/dev/null 2>&1 \
        && echo "  Saved. The Pi uses it only if the main Wi-Fi isn't there." || echo "  Could not save it (you can add it later with: sudo nmtui)."
    fi
  fi
fi

step "7/7  Starting it in the background"
node install-service.js </dev/tty
echo
echo "${B}Done.${N} The Pi now watches the camera${B}$( [ -f ~/.securityai/screen-reader.json ] && printf ' and reads the front-desk screen' )${N}."
echo "It starts by itself whenever the Pi has power. The admin page shows it as the camera computer."
echo "Power-cut protection takes full effect after one restart:   sudo reboot"
echo "See what it's doing:   cd ~/securityai && node rtsp-run.js        (Ctrl-C to stop watching the log)"
