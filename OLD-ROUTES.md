# Old routes — do not follow

> **⚠ WARNING: nothing on this page is the current way to set up SecurityAI.**
> These are earlier methods, kept only as a record of what was tried. Several
> of them caused the problems on the first install night (hand-typed camera
> addresses, the wrong camera, nothing connected to the website).
>
> **Use START-HERE.md instead.** The current way is: the website on Render
> (SETUP.md) plus a laptop or Raspberry Pi at the gym set up with
> `node setup-camera.js` (AT-THE-GYM.md, RTSP-SETUP.md).
>
> **Never type a camera address by hand**, and never try
> `/Streaming/Channels/...` addresses on the J Street recorder (LTS PRO-X):
> they return 404 for every channel, and the bare `rtsp://ip:554/` address
> always shows channel 1 (the pro shop), not the door. The wizard finds the
> right address for you and stops after one wrong password so the recorder
> doesn't lock the account.

---

## 1. Email ingest (was TONIGHT.md)

The recorder emailed a motion snapshot to a Gmail inbox; the website polled
that inbox over IMAP and counted people in the snapshot.

Why it was dropped: one photo taken 1–3 seconds after the motion trigger
often missed the person entirely, and it can't show someone following close
behind. The camera computer reads the live stream instead (about four frames
a second) and sends several photos across each crossing.

**The old instructions said to put the Gmail app password into
`ingest-zones.json` and commit it to GitHub. Never do that.** Anything
committed to a repo should be treated as public. If you did it, delete that
app password at myaccount.google.com/apppasswords and make a new one.

The code (`email-ingest.js`, `ingest-run.js`, `ingest-zones.example.json`) is
still in the repo and still switches itself on if an `ingest-zones.json` exists.

## 2. Browser screen share (was SETUP.md Parts 3A/3B/4/5 and QUICKSTART.md)

A Windows PC showing the cameras opened `monitor.html`, shared its screen,
and the page watched boxes drawn around each doorway. A locked recorder could
be fed in through a ~$20 USB HDMI capture stick instead.

Why it was dropped: a browser tab has to stay open all night. Windows updates,
sleep, the screensaver or someone closing the tab all stop it, and browsers
need a fresh click to restart a screen share. It also needed the front-desk
computer. `monitor.html` still exists, but it's an operator tool now, not a
customer setup route.

## 3. Hand-copied camera addresses (was SETUP.md "Anpviz cameras")

Find each camera's RTSP address with `node find-camera.js`, paste it into
`rtsp-zones.json` as `cameraUrl` by hand, and measure the crop box in pixels
from a screenshot.

Why it was dropped: hand-typed addresses and passwords caused hours of
failures (typos, `!` in passwords breaking in bash, the wrong channel). The
`/Streaming/Channels/101` pattern it suggested doesn't work on the LTS PRO-X.
`node setup-camera.js` now finds the address, shows every channel, and lets
you pick the doorway on a lettered grid.

## 4. Cameras push to the website (was SETUP.md "Route D")

Cameras with their own person detection upload snapshots by FTP or HTTP to
`node ingest-run.js`. Same one-snapshot weakness as email ingest, and every
camera brand configures it differently. Not tested at a real gym.
`scan-cameras.js` (a read-only network scan) is still in the repo.

## 5. Laptop with its own API key (was .env.example and early RTSP-SETUP.md)

`node rtsp-run.js` ran everything on the laptop, with `ANTHROPIC_API_KEY` in a
plain-text `.env` on a borrowed computer, and its own log the website never
saw. The laptop now pairs with the website and sends photos there; the
website does the counting. No API key belongs on a camera computer.

## 6. Windows and Homebrew install steps (was RTSP-SETUP.md A1/A2)

`winget install Gyan.FFmpeg` on Windows, `brew install ffmpeg` on a Mac. On
the borrowed macOS Catalina MacBook, Homebrew no longer supports that version
and the current Node.js installer doesn't run. What works is in RTSP-SETUP.md
Part A.
