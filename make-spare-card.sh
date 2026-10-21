#!/bin/bash
# SecurityAI: make a SPARE memory card for this Pi (an exact copy of this one).
#
# Put a second microSD card (the same size or bigger) in a USB card reader,
# plug the reader into the Pi, then (over SSH or remote access):
#
#     cd ~/securityai && bash make-spare-card.sh
#
# Leave the spare card in the gym office, labelled. If this Pi's card ever
# dies: power off, swap the cards, power on. Everything comes back the way it
# was on the day the copy was made (camera, front-desk reader, remote access).
# Make a fresh copy after big changes (a new camera, teaching the reader again).
set -e
B=$(printf '\033[1m'); N=$(printf '\033[0m')
SRC=$(findmnt -n -o SOURCE / | sed -E 's/p?[0-9]+$//')          # e.g. /dev/mmcblk0
[ -b "$SRC" ] || { echo "Could not find this Pi's own card."; exit 1; }
SRCSIZE=$(lsblk -b -d -n -o SIZE "$SRC")
# Only a USB disk that is not this Pi's own card.
CANDS=$(lsblk -b -d -n -o NAME,TRAN,SIZE,MODEL | awk -v src="$(basename "$SRC")" '$2=="usb" && $1!=src {print}')
if [ -z "$CANDS" ]; then echo "No card reader with a card found. Plug the USB card reader (with the spare card in it) into the Pi and run this again."; exit 1; fi
if [ "$(echo "$CANDS" | wc -l)" -gt 1 ]; then echo "More than one USB disk is plugged in. Unplug everything except the card reader, then run this again."; echo "$CANDS"; exit 1; fi
DST=/dev/$(echo "$CANDS" | awk '{print $1}'); DSTSIZE=$(echo "$CANDS" | awk '{print $3}')
if [ "$DSTSIZE" -lt "$SRCSIZE" ]; then echo "The spare card is smaller than this Pi's card ($((DSTSIZE/1000000000)) GB vs $((SRCSIZE/1000000000)) GB). Use a card at least as big."; exit 1; fi
echo
echo "This copies ${B}this Pi's card${N} ($SRC, $((SRCSIZE/1000000000)) GB) onto ${B}the card in the USB reader${N} ($DST, $(echo "$CANDS" | cut -d' ' -f4-), $((DSTSIZE/1000000000)) GB)."
echo "Everything on the card in the reader is erased."
read -r -p "Type yes to go ahead: " a </dev/tty
[ "$a" = "yes" ] || { echo "Stopped. Nothing was changed."; exit 1; }
echo "Pausing SecurityAI for the copy (a few minutes; it starts again by itself)..."
sudo systemctl stop securityai.service 2>/dev/null || true
trap 'sudo systemctl start securityai.service 2>/dev/null || true' EXIT
for p in $(lsblk -n -o NAME "$DST" | tail -n +2); do sudo umount "/dev/$p" 2>/dev/null || true; done
sync
sudo dd if="$SRC" of="$DST" bs=4M conv=fsync status=progress
sync
echo
echo "${B}Done.${N} Label the spare card \"SecurityAI spare - $(hostname) - $(date +%Y-%m-%d)\" and keep it at the gym."
echo "If the Pi's card ever dies: unplug the Pi's power, swap the cards, plug the power back in."
