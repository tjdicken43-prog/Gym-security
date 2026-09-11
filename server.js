// SecurityAI — real payment backend using Stripe Checkout, plus the
// persistent camera-monitoring engine (see monitor.js).
//
// PAYMENTS: genuine, runnable code — not a mockup — but it needs YOUR OWN
// Stripe account to actually process a payment. Card numbers never touch
// this server or checkout.html; Stripe's own hosted page collects them,
// which is what makes this PCI-compliant out of the box.
//
// MONITORING: also genuine and runnable, but needs ffmpeg installed and a
// real Anthropic API key — see the comment at the top of monitor.js for
// full requirements, and monitor.html for the control panel.
//
// SETUP:
//   1. npm install
//   2. Create a .env file next to this one — see .env.example
//   3. node server.js
//   4. Open http://localhost:4242/securityai.html (marketing site + browser demo)
//      or http://localhost:4242/monitor.html (persistent monitoring control panel)
//      — not by double-clicking the files, they need to be served by this backend.

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const Stripe = require('stripe');
const monitor = require('./monitor');
const mailer = require('./mailer');
const vision = require('./vision');
const report = require('./report');
const gyms = require('./gyms');
const scheduler = require('./scheduler');

// Stripe is only initialized if a key is present. This matters because
// someone might run this server purely for the monitoring feature and
// not have Stripe configured yet — a hard crash at startup would take
// the monitoring endpoints down too, which have nothing to do with Stripe.
let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = Stripe(process.env.STRIPE_SECRET_KEY);
} else {
  console.warn('STRIPE_SECRET_KEY not set — /create-checkout-session and /webhook will return an error until it is configured. Monitoring endpoints are unaffected.');
}
const app = express();
const DOMAIN = process.env.DOMAIN || 'http://localhost:4242';

app.use(cors());
// The /webhook route needs the exact raw, unparsed request body to verify
// Stripe's signature — if the global JSON parser touches it first, the
// raw bytes are gone by the time express.raw() runs on that route below,
// and signature verification will always fail. So this skips JSON
// parsing for that one path and lets its own route-level middleware
// handle it.
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  // Raised from the default 100kb — screen-capture frames pushed by
  // monitor.html's browser-push source can be a few MB as base64.
  express.json({ limit: '10mb' })(req, res, next);
});
app.use(express.static(__dirname)); // serves securityai.html / checkout.html / monitor.html directly

// Without this, visiting the bare domain (just "/") 404s with "Cannot GET /",
// because the homepage is named securityai.html, not index.html — the one
// filename express.static automatically serves at "/". This makes the
// root URL work the way a visitor actually expects.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'securityai.html'));
});

// --- Persistent monitoring controls (see monitor.js for the actual loop) ---
// These are the endpoints monitor.html's Start/Stop buttons call. Once
// started, this keeps running in this Node process — independent of any
// browser tab — until /monitor/stop is called or the process is killed.

// Gym access codes. Set GYM_CODES in .env as a comma-separated list,
// e.g. GYM_CODES=ironoak,westside,downtown — each gets its own alert log
// and its own dashboard settings. Left unset, the dashboard is open to
// anyone who has the URL, which is fine for a single-gym pilot.
app.get('/monitor/requires-code', (req, res) => res.json({ required: gyms.anyCodesConfigured() }));

// Issuing codes is operator-only. Set ADMIN_TOKEN in the environment and
// send it as the X-Admin-Token header. Without ADMIN_TOKEN set, this
// endpoint is disabled entirely rather than left open.
function requireAdmin(req, res) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) { res.status(404).json({ error: 'Not enabled.' }); return false; }
  if (req.get('X-Admin-Token') !== token) { res.status(403).json({ error: 'Not authorized.' }); return false; }
  return true;
}

app.post('/admin/gyms', (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const gym = gyms.createGym(req.body || {});
    res.json({ ok: true, gym });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/admin/gyms', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ gyms: gyms.listGyms() });
});

// Always returns the same shape whether or not the email is on file —
// branching here would turn this into a way to discover which gyms exist.
app.post('/gym/recover-code', async (req, res) => {
  try {
    await gyms.recoverCode({
      email: (req.body || {}).email,
      callerKey: req.ip,
    });
  } catch (err) {
    console.warn('Recovery send failed:', err.message);
  }
  res.json({ ok: true, message: 'If that email is on file, the access code is on its way to it.' });
});

app.post('/monitor/start', (req, res) => {
  if (gyms.anyCodesConfigured()) {
    const given = (req.body && req.body.gymCode) || '';
    if (!gyms.isValidCode(given)) {
      return res.status(403).json({ error: 'That gym code isn\'t recognized. Use "Forgot your code?" to have it emailed, or check with whoever set up your account.' });
    }
  }
  try {
    monitor.start(req.body || {});
    res.json({ ok: true, status: monitor.getStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/monitor/stop', (req, res) => {
  monitor.stop();
  res.json({ ok: true, status: monitor.getStatus() });
});

app.post('/monitor/heartbeat', (req, res) => {
  monitor.recordHeartbeat();
  res.json({ ok: true });
});

// Preflight — what's actually configured on this server. Run this before
// relying on a night of monitoring rather than discovering a missing key
// at 2am. Deliberately reports only whether things are SET, never their
// values.
app.get('/monitor/preflight', (req, res) => {
  const fsx = require('fs');
  const dataDir = process.env.DATA_DIR || __dirname;
  let diskWritable = false;
  try {
    const probe = require('path').join(dataDir, '.write-probe');
    fsx.writeFileSync(probe, 'ok');
    fsx.unlinkSync(probe);
    diskWritable = true;
  } catch (err) { diskWritable = false; }

  const checks = [
    {
      id: 'anthropic',
      label: 'Anthropic API key',
      ok: !!process.env.ANTHROPIC_API_KEY,
      critical: true,
      fix: 'Set ANTHROPIC_API_KEY in Render → Environment. Without it nothing can be analyzed.',
    },
    {
      id: 'email',
      label: 'Email alerts (SMTP)',
      ok: !!process.env.SMTP_HOST,
      critical: true,
      fix: 'Set SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM. Without these you get NO alerts and no warning if monitoring stops overnight.',
    },
    {
      id: 'sms',
      label: 'SMS alerts (Twilio)',
      ok: !!(process.env.TWILIO_SID && process.env.TWILIO_FROM_NUMBER),
      critical: false,
      fix: 'Optional but strongly recommended for overnight — a 1am text beats an email you read at 9am.',
    },
    {
      id: 'disk',
      label: 'Data directory writable',
      ok: diskWritable,
      critical: true,
      fix: `Cannot write to ${dataDir}. Alert history and evidence photos will be lost.`,
    },
    {
      id: 'persistence',
      label: 'History survives redeploys',
      ok: !!process.env.DATA_DIR && process.env.DATA_DIR !== __dirname,
      critical: false,
      fix: 'Mount a Render Disk and set DATA_DIR to it. Without this, logs and photos reset on every deploy (they still survive restarts).',
    },
    {
      id: 'codes',
      label: 'Gym access codes',
      ok: gyms.anyCodesConfigured(),
      critical: false,
      fix: 'Optional for a single gym. Set ADMIN_TOKEN and create a gym to scope logs per location.',
    },
  ];

  const blocking = checks.filter(c => c.critical && !c.ok);
  res.json({
    ready: blocking.length === 0,
    blocking: blocking.map(c => c.id),
    checks,
    dataDir,
  });
});

// Sends a real alert through whatever channels are configured, so you can
// confirm they actually arrive before trusting them overnight.
app.post('/monitor/test-alert', async (req, res) => {
  const { email, phone } = req.body || {};
  if (!email && !phone) return res.status(400).json({ error: 'Give an email or phone to test.' });
  const when = new Date().toLocaleString();
  const msg = `SecurityAI test alert — sent ${when}. If you're reading this, alerts are working. A real alert would name the entrance, how many people were seen, and how many were expected.`;
  try {
    const result = await monitor.sendTestAlert({ alertEmail: email || null, alertPhone: phone || null }, msg);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/monitor/status', (req, res) => {
  res.json(monitor.getStatus());
});

// Serves an evidence frame for one logged event. Scoped to the gym code
// and sanitized on both halves so a crafted request can't read arbitrary
// files off the server.
app.get('/monitor/frame/:code/:file', (req, res) => {
  const path_ = require('path');
  const dir = monitor.framesDirFor(req.params.code);
  const file = String(req.params.file).replace(/[^a-zA-Z0-9._-]/g, '');
  if (!file.endsWith('.jpg')) return res.status(400).end();
  const full = path_.join(dir, file);
  if (!full.startsWith(dir)) return res.status(400).end();
  res.sendFile(full, err => { if (err) res.status(404).end(); });
});

// Report data as JSON — used by the dashboard's preview.
app.get('/monitor/report', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const tz = req.query.tz !== undefined ? parseInt(req.query.tz, 10) : undefined;
  res.json(monitor.buildReport(req.query.code || null, days, tz));
});

// Renders the report exactly as the email will look, so you can check it
// before sending anything to a customer.
app.get('/monitor/report/preview', (req, res) => {
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const tzp = req.query.tz !== undefined ? parseInt(req.query.tz, 10) : undefined;
  const data = monitor.buildReport(req.query.code || null, days, tzp);
  // Preview swaps CID attachments for live URLs, since a browser can't
  // resolve cid: references the way a mail client can.
  data.events.forEach(e => { if (e.frame) e._cid = null; });
  let html = report.renderHtml(data, req.query.name);
  html = html.replace(/<img src="cid:[^"]*"/g, '<img src=""');
  data.events.forEach(e => { if (e.frame) {
    html = html.replace('<img src=""', `<img src="/monitor/frame/${encodeURIComponent(req.query.code || 'default')}/${encodeURIComponent(e.frame)}"`);
  }});
  res.set('Content-Type', 'text/html').send(html);
});

// Force the monthly report to run now, ignoring the schedule and the
// already-sent marker. Useful to verify it works before the 1st.
app.post('/admin/report/run-now', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const out = await scheduler.runCheck(true);
    res.json({ ok: true, ...out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/monitor/report/send', async (req, res) => {
  try {
    const { gymCode, gymName, to, days } = req.body || {};
    if (!to) return res.status(400).json({ error: 'A recipient email is required.' });
    const out = await report.sendMonthlyReport({ gymCode, gymName, to, days });
    res.json({ ok: true, delivered: out.delivered, reason: out.reason, totalFlagged: out.report.totalFlagged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/monitor/log', (req, res) => {
  res.json(monitor.getLog());
});

app.get('/monitor/platform', (req, res) => {
  res.json({ platform: monitor.platform });
});

app.get('/monitor/devices', async (req, res) => {
  try {
    const result = await monitor.listDevices();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Called by monitor.html's own screen-share loop (browser-push source
// type) — the browser captured the frame itself via getDisplayMedia,
// this just runs it through the same analysis/alert/log path as any
// server-captured frame. Raised limit: screen frames can be larger than
// a typical camera snapshot.
app.post('/monitor/push-frame', async (req, res) => {
  try {
    const { image } = req.body;
    if (!image) return res.status(400).json({ error: 'image (base64 JPEG) is required.' });
    await monitor.pushFrame(image);
    res.json({ ok: true, status: monitor.getStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Called when the browser's local motion detector fires on a defined
// entrance zone — a short burst of cropped frames from that one zone,
// analyzed together so Claude has an actual sequence to reason across
// instead of a single instant.
app.post('/monitor/push-burst', async (req, res) => {
  try {
    const { frames, zone, evidence } = req.body;
    if (!Array.isArray(frames) || !frames.length) {
      return res.status(400).json({ error: 'frames (array of base64 JPEGs) is required.' });
    }
    await monitor.pushBurst(frames, zone || {}, evidence);
    res.json({ ok: true, status: monitor.getStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Called by securityai.html's "Capture & analyze" button. This used to
// call api.anthropic.com directly from the browser, which only worked
// while the page was rendered inside Claude's own interface (which
// proxies that call). On an independent domain there's no such proxy,
// so this route exists to do the same call server-side, where a real
// ANTHROPIC_API_KEY actually lives.
app.post('/analyze-frame', async (req, res) => {
  try {
    const { image, expectedCount, accessibleGate } = req.body;
    if (!image) return res.status(400).json({ error: 'image (base64 JPEG) is required.' });
    const result = await vision.analyzeEntry(image, {
      expectedCount: parseInt(expectedCount, 10) || 1,
      accessibleGate: !!accessibleGate,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Called by securityai.html's "Scan visible cameras" button — same
// reasoning as /analyze-frame above, just for the multi-camera-scan
// preview feature instead of single-entrance detection.
app.post('/scan-cameras', async (req, res) => {
  try {
    const { image, zones } = req.body;
    if (!image) return res.status(400).json({ error: 'image (base64 JPEG) is required.' });
    const result = await vision.scanCameraWall(image, Array.isArray(zones) ? zones : []);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Called by securityai.html's support form. Emails SUPPORT_EMAIL (falls
// back to SMTP_USER) via the shared mailer if SMTP is configured; if not,
// still logs the message server-side and tells the front end honestly
// that delivery didn't happen, rather than pretending it did.
app.post('/support/contact', async (req, res) => {
  const { name, email, topic, message } = req.body || {};
  if (!email || !message) {
    return res.status(400).json({ error: 'email and message are required.' });
  }

  const to = process.env.SUPPORT_EMAIL || process.env.SMTP_USER;
  const body = `From: ${name || '(no name given)'} <${email}>\nTopic: ${topic || '(none given)'}\n\n${message}`;

  if (!to) {
    console.log('--- Support request received (no SUPPORT_EMAIL/SMTP_USER configured to forward to) ---\n' + body);
    return res.json({ ok: true, delivered: false });
  }

  const result = await mailer.sendMail({
    to,
    subject: `SecurityAI support: ${topic || 'New message'}`,
    text: body,
    replyTo: email,
  });

  if (!result.delivered) {
    console.log(`--- Support request received (email delivery skipped: ${result.reason}) ---\n${body}`);
  }

  res.json({ ok: true, delivered: result.delivered });
});

// Creates a real Stripe Checkout Session for a subscription.
// The front end redirects the browser to the returned URL — Stripe hosts
// the actual card form there, so this server never sees a card number.
app.post('/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe is not configured — set STRIPE_SECRET_KEY in .env.' });
  }
  try {
    const { planName, unitAmountCents, gyms } = req.body;

    if (!planName || !unitAmountCents) {
      return res.status(400).json({ error: 'planName and unitAmountCents are required' });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `SecurityAI — ${planName}` },
            unit_amount: unitAmountCents, // e.g. 14900 = $149.00
            recurring: { interval: 'month' },
          },
          quantity: gyms || 1,
        },
      ],
      // These consent facts get carried into Stripe's own records for this
      // subscription, alongside whatever you log on your own checkout page.
      metadata: {
        recurring_billing_ack: 'true',
        camera_data_ack: 'true',
      },
      success_url: `${DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/checkout.html`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe calls this whenever something happens on a subscription
// (payment succeeded, card declined, customer canceled, etc). This is
// where you'd update your own database — Checkout alone doesn't do that.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe) return res.status(500).send('Stripe is not configured.');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook signature verification failed: ${err.message}`);
  }

  switch (event.type) {
    case 'checkout.session.completed':
      console.log('New subscription started:', event.data.object.id);
      break;
    case 'invoice.payment_failed':
      console.log('Payment failed for subscription:', event.data.object.subscription);
      break;
    case 'customer.subscription.deleted':
      console.log('Subscription canceled:', event.data.object.id);
      break;
  }

  res.json({ received: true });
});

// Render (and most hosting platforms) assign the port dynamically via
// the PORT environment variable and expect the app to listen on
// whatever that is — a hardcoded port means the platform never sees
// anything answering and reports the deploy as failed. Falls back to
// 4242 for local development, where PORT usually isn't set.
const PORT = process.env.PORT || 4242;
scheduler.start();

// --- Camera ingest, in this same process ------------------------------
// Render (and most managed hosts) run a Web Service that must listen on
// an HTTP port; a process that only polls a mailbox is treated as having
// "no open ports detected" and gets shut down. Rather than run a second
// service, the ingest runs alongside the web server here — one process,
// one port, and monitor.html stays reachable while snapshots come in.
//
// Turns itself on if an ingest config exists, or INGEST=1 is set.
(function maybeStartIngest() {
  const fsx = require('fs');
  const pathx = require('path');
  const cfgPath = process.env.INGEST_CONFIG || pathx.join(__dirname, 'ingest-zones.json');
  if (process.env.INGEST !== '1' && !fsx.existsSync(cfgPath)) return;

  let cfg;
  try {
    cfg = JSON.parse(fsx.readFileSync(cfgPath, 'utf8'));
  } catch (err) {
    console.warn(`Ingest config at ${cfgPath} could not be read: ${err.message}`);
    return;
  }

  const ingest = require('./ingest');
  const emailIngest = require('./email-ingest');

  monitor.start({
    sourceType: 'browser-push',
    gymCode: cfg.gymCode || null,
    scheduleStart: cfg.scheduleStart || null,
    scheduleEnd: cfg.scheduleEnd || null,
    tzOffsetMinutes: typeof cfg.tzOffsetMinutes === 'number' ? cfg.tzOffsetMinutes : new Date().getTimezoneOffset(),
    model: cfg.model || null,
    dailyBurstCap: cfg.dailyBurstCap,
    alertEmail: cfg.alertEmail || null,
    alertPhone: cfg.alertPhone || null,
    label: cfg.label || 'Camera ingest',
  });

  function zoneFor(key) {
    const k = String(key).toLowerCase();
    return (cfg.cameras || []).find(c =>
      k === String(c.match).toLowerCase() || k.includes(String(c.match).toLowerCase()))
      || cfg.defaultCamera || { label: key, expectedCount: 1, accessibleGate: false };
  }

  const handlers = {
    onReady: i => console.log(i.transport === 'email'
      ? `Ingest: watching mailbox ${i.user} every ${i.everySec}s`
      : i.transport === 'ftp' ? `Ingest: FTP on port ${i.port}` : `Ingest: watching ${i.dir}`),
    onPoll: n => { if (cfg.verbose) console.log(`  mailbox: ${n} new message(s)`); },
    onSkipped: id => { if (cfg.verbose) console.log(`  message ${id}: no usable image`); },
    onError: msg => console.warn('  ingest error: ' + msg),
    onEvent: async (key, frames, meta) => {
      const z = zoneFor(key);
      const b64 = frames.map(f => Buffer.isBuffer(f) ? f.toString('base64') : f);
      try {
        const r = await monitor.pushBurst(b64, {
          label: z.label || key,
          expectedCount: z.expectedCount || 1,
          accessibleGate: !!z.accessibleGate,
          durationSec: meta.durationSec,
        }, b64[b64.length - 1]);
        console.log(`[${new Date().toLocaleTimeString()}] ${z.label}: ` +
          (r && r.skipped ? `skipped (${r.skipped})` : `${meta.frameCount} frame(s) analyzed`));
      } catch (err) { console.warn(`${z.label}: ${err.message}`); }
    },
  };

  if (cfg.email && cfg.email.host) emailIngest.startEmailIngest(cfg.email, handlers);
  if (cfg.ftp === true) ingest.startFtpServer({ port: cfg.ftpPort || 2121, user: cfg.ftpUser || 'camera', pass: cfg.ftpPass || null, publicHost: cfg.publicHost }, handlers);
  if (cfg.watchFolder) ingest.startFolderWatch(cfg.watchFolder, handlers);

  setInterval(() => monitor.recordHeartbeat(), 30000);
  monitor.recordHeartbeat();
})();

app.listen(PORT, () => console.log(`SecurityAI payment server running on port ${PORT}`));
