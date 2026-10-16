#!/bin/bash
# SecurityAI: set up a Raspberry Pi (Raspberry Pi OS 64-bit, Bookworm or newer).
# On the Pi (over SSH), paste:
#
#     curl -fsSL https://gym-security.onrender.com/pi-setup.sh | bash
#
# It installs what's needed, takes the camera settings from the laptop (a
# one-time move code, so you don't redo the camera), downloads the program,
# sets up the front-desk screen reader, and starts everything in the
# background (it starts by itself whenever the Pi powers on).
# Safe to run again: it keeps what's already set up.
set -e
SITE="${SECURITYAI_SITE:-https://gym-security.onrender.com}"
B=$(printf '\033[1m'); N=$(printf '\033[0m')
step() { printf '\n%s%s%s\n' "$B" "$*" "$N"; }
ask() { local a; read -r -p "$1 " a </dev/tty; printf '%s' "$a"; }

step "1/5  Installing what the program needs (a few minutes)..."
sudo apt-get update -qq
sudo apt-get install -y -qq nodejs ffmpeg tesseract-ocr tesseract-ocr-eng curl ca-certificates v4l-utils >/dev/null
if ! node -e 'process.exit(parseInt(process.versions.node) >= 18 ? 0 : 1)'; then
  echo "Node.js $(node -v) is too old (need 18+). Use Raspberry Pi OS Bookworm or newer, then run this again."; exit 1
fi
sudo usermod -aG video "$USER" || true            # read the capture stick
echo "  node $(node -v), $(ffmpeg -version | head -1 | cut -d' ' -f1-3), $(tesseract --version 2>&1 | head -1) - OK"

mkdir -p ~/securityai && cd ~/securityai
step "2/5  Camera settings"
if [ -f ~/.securityai/rtsp-zones.json ]; then
  echo "  Already here (kept)."
else
  echo "  Moving from the laptop keeps the camera exactly as it is set up now."
  echo "  On the LAPTOP open a new Terminal window and type:   cd ~/securityai && node move.js send"
  echo "  It shows a move code. Then come back here."
  curl -fsSL "$SITE/move.js" -o move.js
  SECURITYAI_SITE="$SITE" node move.js receive </dev/tty
fi

step "3/5  Downloading the program..."
[ -f update.js ] || curl -fsSL "$SITE/update.js" -o update.js
node update.js --no-service --no-setup </dev/tty

echo
echo "  Checking the Pi keeps up with the camera picture..."
node camera-speed.js </dev/tty || true

step "4/5  Front-desk screen reader (member numbers)"
if [ -f ~/.securityai/screen-reader.json ]; then
  echo "  Already set up (kept). Check it any time:  cd ~/securityai && node screen-reader.js --check"
else
  a=$(ask "  Is the HDMI splitter and capture stick set up at the front desk? Set the screen reader up now? (Y/n)")
  if [ "${a,,}" != "n" ]; then
    echo "  On your phone: admin page > Protected member numbers > J Street > Reader: new code."
    node screen-reader.js --setup </dev/tty || echo "  (You can finish this later:  cd ~/securityai && node screen-reader.js --setup)"
  else
    echo "  Later:  cd ~/securityai && node screen-reader.js --setup"
  fi
fi

step "5/5  Starting it in the background"
node install-service.js </dev/tty
echo
echo "${B}Done.${N} The Pi now watches the camera${B}$( [ -f ~/.securityai/screen-reader.json ] && printf ' and reads the front-desk screen' )${N}."
echo "It starts by itself whenever the Pi has power. The admin page shows it as the camera computer."
echo "See what it's doing:   cd ~/securityai && node rtsp-run.js        (Ctrl-C to stop watching the log)"
