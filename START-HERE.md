# Start here

**SecurityAI** watches a gym's entrance camera overnight and tells the gym
when more people came through the door than expected (tailgating).

How it fits together:

- **The website** (this repo, hosted on Render as `node server.js`) does the
  counting with Claude, sends the email/text alerts, and shows each gym its
  activity page (`activity.html`). You run it from the admin page
  (`admin.html`).
- **A camera computer at each gym**, a laptop or a Raspberry Pi, sits on the
  gym's network next to the camera recorder (NVR). It watches the entrance
  camera, spots movement in the doorway, and sends a few photos of each
  crossing to the website. It pairs with the website using a 6-digit code:
  no API key, no token and no `.env` file on it.

A new gym is watched **all day** until you set its hours. Set them for each
gym on the admin page (usually **9 PM to 5 AM**), or daytime traffic uses up
the daily limit.

## The three documents you need

1. **[Put the website online and run it](SETUP.md)**: Render, the environment
   variables (`ANTHROPIC_API_KEY`, `ADMIN_TOKEN`, `DATA_DIR` on a disk, email
   through a Gmail app password, optional Twilio), adding gyms, and day-to-day
   checks.
2. **[At the gym](AT-THE-GYM.md)**: the phone card. It starts with a
   night-before checklist (is the website ready, what to bring), then setting
   up a laptop as the camera computer, what to check before leaving, giving the
   laptop back, and what to do when a message on its screen says something is
   wrong.
3. **[Raspberry Pi](RTSP-SETUP.md)**: Part B covers moving from the laptop to
   a permanent Raspberry Pi, and what to buy.

Everything else is background. `PLAYBOOK.md` has lessons from the first
install, and `PRE-LAUNCH.md` covers what to do before charging anyone. Old
setup methods that are no longer used are kept in `OLD-ROUTES.md`: don't
follow them.
