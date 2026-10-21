# Professional email and text-message alerts

Right now alerts go out through a personal Gmail. That works for J Street, but
customers see `tjdicken43@gmail.com`, Gmail allows only about 500 emails a day,
and Gmail can block a burst of alerts as spam. Before gym #2, move email to your
own domain. Text messages need a one-time registration with the phone carriers.

Nothing in the website's code changes for either: it is all settings on Render.

---

## Part 1: email from your own domain (about an hour, mostly waiting)

### 1. A domain
If you don't have one yet: buy one (e.g. `securityai-gym.com`) from Cloudflare,
Namecheap or Porkbun (around $10–15 a year). You need this anyway for the website
address (then set `PUBLIC_URL` on Render to `https://your-domain`).

### 2. An email-sending service
Pick one. Both have a free tier that covers your first gyms (check their sites for the
current limits and prices):

| | Postmark | Resend |
|---|---|---|
| Good for | Best delivery for alerts | Simplest setup |
| SMTP_HOST | `smtp.postmarkapp.com` | `smtp.resend.com` |
| SMTP_PORT | `587` | `587` |
| SMTP_USER | your Server API token | `resend` |
| SMTP_PASS | the same Server API token | your API key |

### 3. Prove you own the domain
In the service, add your domain. It shows 2–4 DNS records (SPF, DKIM, sometimes a
return-path). Copy each into your domain's DNS settings (where you bought it). Wait for
the service to say **Verified** (minutes to a few hours).

### 4. Switch the website over
Render > your service > Environment:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`: from the table above
- `SMTP_FROM`: `SecurityAI <alerts@your-domain>`
- `SUPPORT_EMAIL`: where you want copies (your Gmail is fine)

Save. Then on the admin page: tap a gym > **Send a test alert**. Check it arrives, and
not in spam.

### 5. Your own inbox (optional)
For a `tj@your-domain` address people can write to: Cloudflare Email Routing (free)
forwards it to your Gmail, or Google Workspace for a full mailbox.

---

## Part 2: text-message alerts (start now: approval can take 1–3 weeks)

Since 2023, US phone carriers block texts from business numbers that aren't registered.
The website only offers text alerts once `TWILIO_SID` and `TWILIO_FROM_NUMBER` are set,
so until then gyms get email, phone notifications and team chat, which already work.

### Option A: a toll-free number (simplest for a small business)
1. Make a Twilio account (twilio.com), add a little credit.
2. Buy a **toll-free** number (around $2 a month).
3. Submit **Toll-Free Verification** in the Twilio console:
   - Business: SecurityAI, your name, address, website.
   - Use case: "Account notifications / security alerts".
   - Message sample: `SecurityAI: J Street Gym front door, 2 people came in on 1 scan at 1:52 AM. Photo: https://your-domain/... Reply STOP to stop.`
   - How people opt in: "The gym owner adds staff phone numbers on their SecurityAI page; each
     number gets a first text explaining the alerts and how to stop them (reply STOP)."
4. Wait for **Verified** (often days, sometimes a couple of weeks).

### Option B: a local number (A2P 10DLC)
Buy a local number, then register a **Brand** (you can register as a sole proprietor
without a business tax ID) and a **Campaign** ("Account notifications"). There are small
one-time and monthly fees; Twilio shows them before you pay. Approval: days to weeks.

### Switch it on
Render > Environment:
- `TWILIO_SID`, `TWILIO_AUTH_TOKEN`: from the Twilio console home page
- `TWILIO_FROM_NUMBER`: the number, like `+18005551234`

Save. On a gym page: Alerts > add a mobile number. It gets a test text straight away.

---

## Checklist
- [ ] Domain bought, `PUBLIC_URL` set on Render
- [ ] Email service verified, SMTP settings switched, test alert received (not in spam)
- [ ] Twilio number bought and verification submitted
- [ ] Verified: `TWILIO_*` set, test text received (then the home page can mention text alerts again)
