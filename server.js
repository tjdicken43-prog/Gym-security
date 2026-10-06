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
const crypto = require('crypto');
const cors = require('cors');
const Stripe = require('stripe');
const monitor = require('./monitor');
const mailer = require('./mailer');
const vision = require('./vision');
const report = require('./report');
const gyms = require('./gyms');
const scheduler = require('./scheduler');
const store = require('./gym-store');
const accuracy = require('./accuracy');
const accStore = require('./accuracy-store');

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
const DOMAIN = process.env.DOMAIN || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4242';

app.use(cors());
// The /webhook route needs the exact raw, unparsed request body to verify
// Stripe's signature — if the global JSON parser touches it first, the
// raw bytes are gone by the time express.raw() runs on that route below,
// and signature verification will always fail. So this skips JSON
// parsing for that one path and lets its own route-level middleware
// handle it.
app.use((req, res, next) => {
  if (req.path === '/webhook') return next();
  // The camera-computer routes parse their own body AFTER checking the
  // token, with a smaller 4 MB limit — see the runner section below.
  if (req.path.startsWith('/monitor/runner/')) return next();
  // Raised from the default 100kb — screen-capture frames pushed by
  // monitor.html's browser-push source can be a few MB as base64.
  express.json({ limit: '10mb' })(req, res, next);
});
// express.static below serves EVERY non-dot file in this folder. On the
// camera laptop (rtsp-run.js local mode calls start()) this folder holds
// rtsp-zones.json — the NVR password and runner token — and anyone on the
// gym network could read it at http://<laptop>:4242/rtsp-zones.json. Same
// for logs, gym codes and photos when DATA_DIR is not set. Never serve them.
function isPrivateStaticPath(p) {
  let s;
  try { s = decodeURIComponent(p); } catch (e) { return true; }
  s = path.posix.normalize('/' + s.replace(/\\/g, '/')).toLowerCase();   // Mac disks ignore case
  return /^\/+(rtsp-zones|ingest-zones|gyms|report-sends|runner-pairings)\.json/.test(s)
    || /^\/+(alert-log-|summary-|mail-progress-|gym-reviews-|gym-alerts-|gym-settings-|gym-nights-)[^/]*\.json/.test(s)
    || /^\/+(runner-queue|camera-check|frames-[^/]*|tests-[^/]*|data|node_modules)(\/|$)/.test(s);
}
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && isPrivateStaticPath(req.path)) return res.status(404).send('Not found');
  next();
});
// SEO: the home page's canonical link, robots.txt and sitemap.xml are
// written with a placeholder domain. Fill in this website's real address
// (DOMAIN, or the one Render sets in RENDER_EXTERNAL_URL) so search engines
// are pointed at the live site, not at a domain that doesn't exist.
const SEO_PLACEHOLDER = 'https://your-domain-goes-here.com';
const SEO_FILES = { '/': 'securityai.html', '/securityai.html': 'securityai.html', '/robots.txt': 'robots.txt', '/sitemap.xml': 'sitemap.xml' };
const SEO_TYPES = { html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8' };
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const file = SEO_FILES[req.path];
  if (!file) return next();
  let origin;
  try { origin = new URL(DOMAIN).origin; } catch (e) { return next(); }
  require('fs').readFile(path.join(__dirname, file), 'utf8', (err, text) => {
    if (err) return next();
    res.type(SEO_TYPES[file.split('.').pop()]).send(text.split(SEO_PLACEHOLDER).join(origin));
  });
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
  if (!sameSecret(req.get('X-Admin-Token') || '', token)) { res.status(403).json({ error: 'Not authorized.' }); return false; }
  return true;
}
// Constant-time compare of two secrets of any length (hash both first, so
// timingSafeEqual gets equal lengths and the length itself leaks nothing).
function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Camera computers already sending a gym code this website doesn't know
// (refused ones, or ones that were accepted before the first gym account
// existed). The admin page offers "adopt this code" for them.
// Also gym codes with history saved on this website's disk (log, 35-day
// store or photos) but no gym account — e.g. "jstreet" from before gyms
// had accounts — even when no camera computer is on, so the history can be
// adopted before the laptop is upgraded.
function adoptableRunners() {
  const out = new Map();
  const coded = gyms.anyCodesConfigured();
  for (const r of recentRejected()) out.set(r.code, { code: r.code, host: r.host, lastSeen: r.lastSeen, refused: r.count });
  for (const r of runners.values()) {
    if (gyms.resolveKey(r.gymCode) || out.has(r.gymCode) || r.gymCode === 'default') continue;
    if (coded ? (!r.lastSeen || Date.now() - r.lastSeen > REJECTED_SHOW_MS) : !runnerIsOnline(r)) continue;
    out.set(r.gymCode, { code: r.gymCode, host: r.host || null, lastSeen: new Date(r.lastSeen).toISOString(), refused: 0 });
  }
  for (const h of orphanHistory()) {
    const a = out.get(h.code) || { code: h.code, host: null, lastSeen: null, refused: 0 };
    out.set(h.code, Object.assign(a, { savedEntries: h.entries, savedPhotos: h.photos }));
  }
  for (const a of out.values()) {
    a.label = `Adopt '${a.code}'${a.savedEntries ? ` (${a.savedEntries} saved ${a.savedEntries === 1 ? 'entry' : 'entries'})` : a.savedPhotos ? ` (${a.savedPhotos} saved photos)` : ''}`;
    a.hint = a.host || a.lastSeen
      ? `A camera computer${a.host ? ` ("${a.host}")` : ''} is sending gym code "${a.code}"${a.refused ? ' and is being refused' : ''}.${a.savedEntries ? ` This website also has ${a.savedEntries} saved entries for it.` : ''} If it belongs to this gym, adopt it so it keeps working and its history stays.`
      : `This website has history saved for gym code "${a.code}" (${a.savedEntries ? `${a.savedEntries} saved entries` : `${a.savedPhotos} photos`}) that no gym owns yet. If it is this gym's, adopt it so the activity page keeps showing it.`;
  }
  return [...out.values()];
}
// Gym codes with saved history in DATA_DIR but no gym account.
function orphanHistory() {
  const fsx = require('fs');
  const dir = path.dirname(monitor.framesDirFor('x'));
  const keys = new Set();
  try {
    for (const f of fsx.readdirSync(dir)) {
      const m = /^(?:alert-log-([a-z0-9_-]+)\.json|summary-([a-z0-9_-]+)\.json|frames-([a-z0-9_-]+))$/.exec(f);
      if (m) keys.add(m[1] || m[2] || m[3]);
    }
  } catch (e) { return []; }
  const out = [];
  for (const k of keys) {
    if (k === 'default' || gyms.resolveKey(k) || monitor.safeCode(k) !== k) continue;
    try {
      const ids = new Set();
      for (const e of monitor.getLog(k)) if (e && !e.systemEvent) ids.add(store.eventId(e));
      for (const e of monitor.loadSummary(k)) if (e) ids.add(store.eventId(e));
      let photos = 0;
      try { photos = fsx.readdirSync(monitor.framesDirFor(k)).filter(f => f.endsWith('.jpg')).length; } catch (e) { /* none */ }
      if (ids.size || photos) out.push({ code: k, entries: ids.size, photos });
    } catch (e) { /* next */ }
  }
  return out;
}
// Does this gym key already hold data of its own (log or 35-day store)?
function keyHasData(key) {
  return monitor.getLog(key).length > 0 || monitor.loadSummary(key).length > 0;
}
function adminGymView(g) {
  return { code: g.code, key: g.key, gymName: g.gymName, email: g.email, createdAt: g.createdAt, timeZone: g.timeZone || null, codeIssuedAt: g.codeIssuedAt || null };
}

app.post('/admin/gyms', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  try {
    // Offer to adopt a code a running camera computer already uses —
    // computed BEFORE creating, because creating the first gym is exactly
    // what makes that computer's code "unknown".
    const before = adoptableRunners();
    const gym = gyms.createGym({ gymName: cleanText(b.gymName, 80), email: b.email, timeZone: b.timeZone, adoptCode: b.adoptCode ? String(b.adoptCode).trim() : undefined });
    if (b.adoptCode) rejectedRunners.delete(gym.key);
    const adoptable = b.adoptCode ? [] : before.filter(a => a.code !== gym.key);
    res.json({ ok: true, gym: adminGymView(gym), adoptable,
      adoptHint: adoptable.length ? adoptable[0].hint : undefined });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/admin/gyms', (req, res) => {
  if (!requireAdmin(req, res)) return;
  // Operator-only, so codes ARE included here: the admin page needs them
  // to hand a gym its link. Gyms from GYM_CODES (env) are listed too.
  const list = gyms.listGymsForAdmin();
  const have = new Set(list.map(g => String(g.key || '').toLowerCase()));
  const fromEnv = gyms.envCodes().filter(c => !have.has(monitor.safeCode(c)))
    .map(c => ({ code: c, key: monitor.safeCode(c), gymName: c, email: null, createdAt: null, fromEnv: true }));
  res.json({ gyms: list.concat(fromEnv), adoptable: adoptableRunners() });
});

// The gym named in /admin/gyms/:gym/... (its code or its key) -> key.
function adminGymKey(req, res) {
  const key = gymKeyFrom(req.params.gym);
  if (!key) { res.status(404).json({ ok: false, error: 'No such gym.' }); return null; }
  return key;
}

// J2: adopt the code a camera computer already sends, as this gym's data
// key. Only for a gym with no history of its own yet (nothing to orphan).
app.post('/admin/gyms/:gym/adopt', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  const legacy = String((req.body || {}).legacyCode || '').trim().toLowerCase();
  if (!legacy) return res.status(400).json({ ok: false, error: 'Say which code to adopt (legacyCode), e.g. the one the camera computer is sending.' });
  if (monitor.safeCode(legacy) === key) return res.json({ ok: true, gym: adminGymView(gyms.findByCode(key)), unchanged: true });
  if (keyHasData(key)) return res.status(409).json({ ok: false, error: 'This gym already has its own history, so its data can\'t be moved to another code. Do this: pair the camera computer again instead (admin page > Connect a camera computer).' });
  try {
    const out = gyms.adoptKey(key, legacy);
    monitor.stop({ gymCode: out.previousKey });
    rejectedRunners.delete(out.gym.key);
    res.json({ ok: true, gym: adminGymView(out.gym), message: `Done. Camera computers sending "${out.gym.key}" now report for ${out.gym.gymName}; its earlier history is kept. The gym still signs in with ${out.gym.code}.` });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// G13: a new sign-in code. Old code, old links, and every phone signed in
// with the old code stop working at once. History stays (keyed by key).
app.post('/admin/gyms/:gym/new-code', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  try {
    const g = gyms.newCode(key);
    res.json({ ok: true, gym: adminGymView(g), message: `New code for ${g.gymName}: ${g.code}. The old code and every phone signed in with it no longer work — send the gym the new one.` });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// J3: per-gym settings kept on the website. They win over the camera
// computer's rtsp-zones.json and apply straight away.
function settingsView(key) {
  const st = monitor.getStatus(key);
  const rec = runners.get(key);
  return {
    ok: true, key, gymName: gyms.gymNameFor(key),
    settings: Object.assign({ timeZone: gyms.timeZoneFor(key) }, store.getSettings(key)),
    timeZoneSource: (gyms.findByCode(key) && gyms.findByCode(key).timeZone) ? 'gym account' : store.getSettings(key).timeZone ? 'settings'
      : gyms.validTimeZone(process.env.GYM_TIMEZONE) ? 'GYM_TIMEZONE' : 'default (Central)',
    effective: st.config ? { scheduleStart: st.config.scheduleStart, scheduleEnd: st.config.scheduleEnd, timeZone: st.config.timeZone || null,
      tzOffsetMinutes: st.config.tzOffsetMinutes, dailyBurstCap: st.config.dailyBurstCap, model: st.config.model || null, sources: st.configSources || null } : null,
    cameraComputerConfig: rec ? rec.rawConfig : null,
    limits: { maxDailyBurstCap: monitor.RUNNER_MAX_DAILY_BURST_CAP, models: Object.keys(vision.ALLOWED_MODELS), noteMax: 120, maxEmails: 5, maxPhones: 3 },
    delivery: store.deliveryStatus(key),
  };
}
app.get('/admin/gyms/:gym/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  res.set('Cache-Control', 'no-store').json(settingsView(key));
});
app.post('/admin/gyms/:gym/settings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  const input = (req.body && typeof req.body === 'object') ? req.body : {};
  try {
    const next = store.normalizeSettings(input, store.getSettings(key), { models: vision.ALLOWED_MODELS, maxCap: monitor.RUNNER_MAX_DAILY_BURST_CAP });
    // A gym account keeps its time zone on the account itself.
    if (Object.prototype.hasOwnProperty.call(input, 'timeZone') && gyms.setTimeZone(key, next.timeZone || null)) delete next.timeZone;
    store.saveSettings(key, next);
    monitor.applySettings(key);
    res.json(settingsView(key));
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// J13: cut off this gym's paired camera computers (all of them). They get
// 401 "This computer was unpaired" and need a new pairing code.
app.post('/admin/gyms/:gym/unpair', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  try {
    const gen = store.bumpRunnerGen(key);
    const rec = runners.get(key);
    if (rec) rec.lastSeen = Math.min(rec.lastSeen || 0, Date.now() - RUNNER_ONLINE_MS);
    res.json({ ok: true, generation: gen, message: `Every camera computer paired with ${gyms.gymNameFor(key) || key} is now cut off. To connect one again, make a pairing code and run node pair.js on it.${(process.env.RUNNER_TOKEN || '').trim() ? ' Note: RUNNER_TOKEN is still set on Render, and a computer using it is NOT cut off — delete RUNNER_TOKEN.' : ''}` });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Stop / start watching one gym from the admin page.
app.post('/admin/gyms/:gym/monitoring', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  const action = String((req.body || {}).action || '');
  if (action === 'stop') monitor.stop({ byOperator: true, gymCode: key });
  else if (action === 'start') monitor.allowRemote(key);
  else return res.status(400).json({ ok: false, error: 'action must be "stop" or "start".' });
  res.json({ ok: true, key, running: monitor.getStatus(key).running, stoppedByOperator: monitor.getStatus(key).stoppedByOperator,
    message: action === 'stop' ? 'Stopped. The camera computer\'s crossings are ignored (and cost nothing) until you press Start.' : 'Started. Crossings are analysed again from the camera computer\'s next check-in (within 30 s).' });
});

// J4: "Send a test to me". Goes to `to` if given, otherwise to this gym's
// alert emails/phones from its settings and SUPPORT_EMAIL.
app.post('/admin/test-alert', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  const key = b.gymCode ? gymKeyFrom(b.gymCode) : null;
  if (b.gymCode && !key) return res.status(404).json({ ok: false, error: 'No such gym.' });
  let emails = [], phones = [];
  if (b.to) {
    const e = store.normalizeEmail(b.to), p = e ? null : store.normalizePhone(b.to);
    if (!e && !p) return res.status(400).json({ ok: false, error: 'That doesn\'t look like an email address or a mobile number.' });
    if (e) emails.push(e); else phones.push(p);
  } else {
    const t = key ? monitor.operatorTargets(key, null) : { emails: [], phones: [] };
    emails = t.emails; phones = t.phones;
    const sup = String(process.env.SUPPORT_EMAIL || '').trim().toLowerCase();
    if (sup && !emails.includes(sup)) emails.push(sup);
  }
  if (!emails.length && !phones.length) return res.status(400).json({ ok: false, error: 'Nowhere to send it: give an address, or set SUPPORT_EMAIL on Render, or add alert emails in this gym\'s settings.' });
  const name = key ? (gyms.gymNameFor(key) || key) : 'SecurityAI';
  const when = new Date().toLocaleString('en-US', { timeZone: gyms.timeZoneFor(key || 'default'), timeZoneName: 'short' });
  const msg = `SecurityAI test for ${name}, sent ${when}. If you're reading this, alerts reach you.`;
  const out = [];
  for (const to of emails) {
    const r = await mailer.sendMail({ to, subject: `SecurityAI test — ${name}`, text: msg });
    out.push({ to, channel: 'email', delivered: !!r.delivered, reason: r.delivered ? null : r.reason });
    if (key) store.recordDelivery(key, !!r.delivered, r.delivered ? null : { kind: 'operator-test', channel: 'email', to, reason: r.reason });
  }
  for (const to of phones) {
    const r = await monitor.sendTestAlert({ alertPhone: to }, msg, key);
    out.push({ to, channel: 'sms', delivered: r.sms === 'sent', reason: r.sms === 'sent' ? null : String(r.sms || '').replace(/^skipped\/failed — /, '') });
  }
  res.json({ ok: true, delivered: out.every(x => x.delivered), results: out });
});

// Always returns the same shape whether or not the email is on file —
// branching here would turn this into a way to discover which gyms exist.
app.post('/gym/recover-code', async (req, res) => {
  try {
    await gyms.recoverCode({
      email: (req.body || {}).email,
      // Not req.ip: without 'trust proxy' that is Render's proxy address,
      // one shared bucket for every visitor (3 tries per 15 min site-wide).
      callerKey: callerKey(req),
    });
  } catch (err) {
    console.warn('Recovery send failed:', err.message);
  }
  res.json({ ok: true, message: 'If that email is on file, the access code is on its way to it.' });
});

// Start / Stop / heartbeat / test alert change what the website does (and
// spends), so they are OPERATOR-ONLY: X-Admin-Token must match ADMIN_TOKEN.
// With no ADMIN_TOKEN set they only answer requests from this machine
// (the camera laptop's local mode), never from the internet.
// Resolves a gym named in a request to its data key; null = unknown gym.
function gymKeyFrom(raw) {
  const given = String(raw || '').trim();
  if (!gyms.anyCodesConfigured()) return monitor.safeCode(given || 'default');
  if (!given) return null;
  return gyms.resolveKey(given);
}

app.post('/monitor/start', (req, res) => {
  if (!requireOperator(req, res)) return;
  const body = req.body || {};
  const key = gymKeyFrom(body.gymCode);
  if (!key) return res.status(403).json({ error: 'That gym isn\'t set up on this website. Create it on the admin page first.' });
  try {
    monitor.start(Object.assign({}, body, { gymCode: key }));
    res.json({ ok: true, status: monitor.getStatus(key) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/monitor/stop', (req, res) => {
  if (!requireOperator(req, res)) return;
  const body = req.body || {};
  const key = body.gymCode ? gymKeyFrom(body.gymCode) : monitor.defaultKey();
  if (!key) return res.status(404).json({ error: 'No such gym.' });
  // byOperator: a connected camera computer must not switch it back on.
  monitor.stop({ byOperator: true, gymCode: key });
  res.json({ ok: true, status: monitor.getStatus(key) });
});

app.post('/monitor/heartbeat', (req, res) => {
  if (!requireOperator(req, res)) return;
  const key = (req.body && req.body.gymCode) ? gymKeyFrom(req.body.gymCode) : undefined;
  monitor.recordHeartbeat(key || undefined);
  res.json({ ok: true });
});

// Preflight — what's actually configured on this server. Run this before
// relying on a night of monitoring rather than discovering a missing key
// at 2am. Deliberately reports only whether things are SET, never their
// values.
// Is DATA_DIR writable, and is it a separately mounted disk? A folder on
// the app's own disk (plain /tmp, or /var/data created by mkdir) passes a
// write test but is wiped on every deploy; a mounted Render Disk has a
// different device id from the folder the code lives in.
function diskCheck() {
  const fsx = require('fs');
  const dataDir = process.env.DATA_DIR || __dirname;
  let writable = false, exists = false, separateDisk = false;
  try { exists = fsx.statSync(dataDir).isDirectory(); } catch (e) { exists = false; }
  try { const pr = path.join(dataDir, '.write-probe'); fsx.writeFileSync(pr, 'ok'); fsx.unlinkSync(pr); writable = true; } catch (err) { writable = false; }
  try { separateDisk = exists && fsx.statSync(dataDir).dev !== fsx.statSync(__dirname).dev; } catch (e) { separateDisk = false; }
  const set = !!process.env.DATA_DIR && path.resolve(process.env.DATA_DIR) !== path.resolve(__dirname);
  return { dataDir, exists, writable, separateDisk, dataDirSet: set, survivesDeploys: set && writable && separateDisk };
}
function diskFix(d) {
  if (!d.dataDirSet) return 'Render > Disks: add a 1 GB disk at /var/data, then set DATA_DIR=/var/data. Without it, every deploy wipes gym accounts and history.';
  if (!d.exists) return `DATA_DIR is ${d.dataDir}, but that folder does not exist. Do this: Render > Disks, add a disk mounted at exactly that path.`;
  if (!d.writable) return `Cannot write to ${d.dataDir}. Do this: check the Render Disk is mounted there.`;
  if (!d.separateDisk) return `${d.dataDir} is on the same disk as the code, so it is wiped on every deploy. Do this: Render > Disks, add a disk mounted at ${d.dataDir}.`;
  return '';
}

app.get('/monitor/preflight', (req, res) => {
  const disk = diskCheck();
  const dataDir = disk.dataDir;
  const diskWritable = disk.writable;

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
      fix: 'SMTP_HOST is not set on Render. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM in Render > Environment (a Gmail app password works). Without these you get NO alerts and no warning if monitoring stops overnight.',
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
      ok: disk.survivesDeploys,
      critical: false,
      fix: diskFix(disk) || 'OK',
    },
    {
      id: 'runner',
      label: 'Camera computer pairing (ADMIN_TOKEN)',
      ok: !!(process.env.ADMIN_TOKEN || process.env.RUNNER_TOKEN),
      critical: false,
      fix: 'Needed only if a laptop or Raspberry Pi sends events here. Set ADMIN_TOKEN in Render → Environment, then pair the computer from the admin page (node pair.js).',
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
// confirm they actually arrive before trusting them overnight. Operator
// only: otherwise anyone could make this server email or text anyone.
function plainResult(r) {
  return {
    email: r.email ? r.email.replace(/^skipped\/failed — /, 'Not sent: ') : null,
    sms: r.sms ? r.sms.replace(/^skipped\/failed — /, 'Not sent: ') : null,
    detail: r.detail || [],
  };
}
app.post('/monitor/test-alert', async (req, res) => {
  if (!requireOperator(req, res)) return;
  const { email, phone } = req.body || {};
  if (!email && !phone) return res.status(400).json({ error: 'Give an email or phone to test.' });
  const em = email ? store.normalizeEmail(email) : null;
  const ph = phone ? store.normalizePhone(phone) : null;
  if (email && !em) return res.status(400).json({ error: 'That doesn\'t look like an email address.' });
  if (phone && !ph) return res.status(400).json({ error: 'That doesn\'t look like a mobile number.' });
  const when = new Date().toLocaleString('en-US', { timeZone: gyms.timeZoneFor(monitor.defaultKey()), timeZoneName: 'short' });
  const msg = `SecurityAI test alert — sent ${when}. If you're reading this, alerts are working. A real alert names the gym and entrance, how many people went through and how many were expected, with a photo link.`;
  try {
    const result = await monitor.sendTestAlert({ alertEmail: em, alertPhone: ph }, msg);
    res.json({ ok: true, result: plainResult(result) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Reports what's actually in the configured mailbox — read/unread counts
// and the newest few subjects — so a silent ingest can be diagnosed from
// the dashboard instead of guessing.
app.get('/monitor/mailbox-test', async (req, res) => {
  if (!requireOperator(req, res)) return;
  const fsx = require('fs'); const pathx = require('path');
  const cfgPath = process.env.INGEST_CONFIG || pathx.join(__dirname, 'ingest-zones.json');
  if (!fsx.existsSync(cfgPath)) return res.json({ configured: false, reason: 'No ingest-zones.json found.' });
  let cfg;
  try { cfg = JSON.parse(fsx.readFileSync(cfgPath, 'utf8')); }
  catch (e) { return res.json({ configured: false, reason: 'ingest-zones.json is not valid JSON: ' + e.message }); }
  if (!cfg.email || !cfg.email.host) return res.json({ configured: false, reason: 'No email section in ingest-zones.json.' });
  try {
    const emailIngest = require('./email-ingest');
    const out = await emailIngest.diagnose(cfg.email);
    res.json(Object.assign({ configured: true, user: cfg.email.user }, out));
  } catch (err) {
    res.json({ configured: true, error: err.message });
  }
});

// Reprocesses the newest alarm email(s) regardless of read state.
app.post('/monitor/process-latest', async (req, res) => {
  if (!requireOperator(req, res)) return;
  const fsx = require('fs'); const pathx = require('path');
  const cfgPath = process.env.INGEST_CONFIG || pathx.join(__dirname, 'ingest-zones.json');
  if (!fsx.existsSync(cfgPath)) return res.status(400).json({ error: 'No ingest-zones.json found.' });
  let cfg;
  try { cfg = JSON.parse(fsx.readFileSync(cfgPath, 'utf8')); }
  catch (e) { return res.status(400).json({ error: 'Config is not valid JSON: ' + e.message }); }
  if (!cfg.email || !cfg.email.host) return res.status(400).json({ error: 'No email section configured.' });
  try {
    const emailIngest = require('./email-ingest');
    const handlers = global.__securityaiIngestHandlers;
    if (!handlers) return res.status(400).json({ error: 'Ingest is not running.' });
    const done = await emailIngest.processLatest(cfg.email, handlers, Math.min(100, Math.max(1, parseInt(req.query.count, 10) || 1)));   // each one is a paid analysis
    res.json({ ok: true, processed: done });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// One page that answers "why is the log empty" without needing to cross
// reference the Render console. Everything that can stop an event
// reaching the log, in one place.
// Operator-only. These expose the mailbox address, config paths and cost
// figures, none of which belong on a page a customer can open. When
// ADMIN_TOKEN is unset they stay open so nothing breaks mid-setup — but
// the response says so, and the ops page shows the warning.
// A request from this very machine, not relayed by a proxy (Render always
// adds X-Forwarded-For, so nothing from the internet passes this).
function isLocalRequest(req) {
  if (req.get('X-Forwarded-For')) return false;
  const a = String((req.socket && req.socket.remoteAddress) || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function requireOperator(req, res) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) {
    if (isLocalRequest(req)) return true;       // laptop local mode / setup on this machine
    res.status(403).json({ error: 'Not authorized. Set ADMIN_TOKEN on Render and send it as X-Admin-Token.', adminTokenSet: false });
    return false;
  }
  if (sameSecret(req.get('X-Admin-Token') || '', token)) return true;
  res.status(403).json({ error: 'Not authorized.' });
  return false;
}

app.get('/monitor/debug', (req, res) => {
  if (!requireOperator(req, res)) return;
  const fsx = require('fs'); const pathx = require('path');
  // ?gym=<code or key> picks the gym; default: the primary one.
  const key = req.query.gym ? (gymKeyFrom(req.query.gym) || monitor.safeCode(req.query.gym)) : monitor.defaultKey();
  const st = monitor.getStatus(key);
  const disk = diskCheck();
  const dataDir = disk.dataDir;
  const cfgPath = process.env.INGEST_CONFIG || pathx.join(__dirname, 'ingest-zones.json');

  let files = [];
  try { files = fsx.readdirSync(dataDir).filter(f => /^(alert-log|summary|mail-progress|frames|gym-)/.test(f)); } catch (e) {}

  const log = monitor.getLog(key);
  const errs = log.filter(e => e && e.error && !e.systemEvent);
  const runnerRec = runners.get(key) || null;
  const runnerOnline = !!(runnerRec && runnerIsOnline(runnerRec));
  const rejected = recentRejected();
  const warnings = siteWarnings();

  res.json({
    gym: key,
    gymName: gyms.gymNameFor(key),
    summary: {
      monitoringRunning: st.running,
      ingestRunning: !!global.__securityaiIngest,
      entriesInLog: log.length,
      entriesWithErrors: errs.length,
      withinSchedule: st.withinSchedule,
      analysedLast24h: st.burstsLast24h,
      skippedOutsideHours: st.skippedOutOfWindow,
      skippedOverCap: st.skippedOverCap,
      skippedSiteWideCap: st.skippedGlobalCap,
      skippedPacing: st.skippedPacing,
    },
    likelyProblem: (() => {
      if (rejected.length) return rejected[0].problem;
      if (runnerRec && !runnerOnline) return `The camera computer (${runnerRec.host || 'unknown host'}) last checked in ${new Date(runnerRec.lastSeen).toISOString()} and has gone quiet. Check it is on, awake, online and running node rtsp-run.js.`;
      if (runnerRec && runnerRec.monitorProblem) return runnerRec.monitorProblem;
      if (runnerRec && runnerRec.hostConflict) return runnerRec.hostConflict.message;
      if (!global.__securityaiIngest && !runners.size) return 'Nothing is feeding this server: no camera computer has checked in (pair one from the admin page, then run the monitor on it) and no ingest-zones.json was found.';
      if (!st.running) return 'Monitoring is not started for this gym, so nothing can be logged.';
      if (st.withinSchedule === false) return `Outside the monitored hours (${(st.config||{}).scheduleStart}–${(st.config||{}).scheduleEnd}), so events are deliberately discarded without spending anything.`;
      if (st.skippedOverCap) return 'The daily analysis cap has been reached.';
      if (st.skippedGlobalCap) return 'The website-wide daily limit (MAX_TOTAL_DAILY_BURSTS) has been reached.';
      if (errs.length && errs.length === log.filter(e => !e.systemEvent).length) return `Every analysis failed. First error: ${errs[0].error}`;
      if (!log.length) return 'Nothing has reached the log yet. If the Render console shows analyses, the service has restarted since — an unmounted disk loses the log on every deploy.';
      return 'Nothing obviously wrong — entries exist.';
    })(),
    warnings,
    rejectedRunners: rejected,
    gyms: overviewRows(req),
    adminTokenSet: !!process.env.ADMIN_TOKEN,
    runnerTokenSet: !!(process.env.RUNNER_TOKEN || process.env.ADMIN_TOKEN),   // i.e. a camera computer CAN connect (legacy token or pairing)
    legacyRunnerTokenSet: !!(process.env.RUNNER_TOKEN || '').trim(),
    runnerConnected: runnerOnline,
    // Full detail on every camera computer that has checked in since this
    // server started: host, fps, frames, errors, the config it sent.
    runners: [...runners.values()].map(runnerOperatorView),
    apiKeySet: !!process.env.ANTHROPIC_API_KEY,
    emailSendingConfigured: mailer.isConfigured(),
    emailProblem: mailer.isConfigured() ? null : mailer.notConfiguredReason(),
    delivery: store.deliveryStatus(key),
    gymCode: st.gymCode,
    schedule: st.config ? `${st.config.scheduleStart || 'always'}–${st.config.scheduleEnd || 'always'}` : null,
    tzOffsetMinutes: st.config ? st.config.tzOffsetMinutes : null,
    serverTime: new Date().toISOString(),
    dataDir,
    dataDirIsPersistent: disk.survivesDeploys,
    disk,
    dataFiles: files,
    frameFolders: (() => {
      try {
        return fsx.readdirSync(dataDir).filter(f => f.startsWith('frames-')).map(f => {
          let n = 0;
          try { n = fsx.readdirSync(pathx.join(dataDir, f)).length; } catch (e) {}
          return { folder: f, photos: n };
        });
      } catch (e) { return []; }
    })(),
    ingestConfigFound: fsx.existsSync(cfgPath),
    ingestDetail: global.__securityaiIngest || null,
    lastThreeEntries: log.slice(0, 3),
  });
});


// --- Camera computer (laptop / Raspberry Pi) -> this website ----------
// rtsp-run.js on site watches the camera, detects motion locally for free,
// and posts short bursts here. THIS server makes the Anthropic call via
// monitor.pushBurstFor, so the laptop holds no API key and every cost
// control (schedule, daily cap, evidence photos, alerts, retention)
// applies — per gym. Contract: .agent-brief.md.
//
// Auth: "Authorization: Bearer <token>". Unset -> 503, wrong -> 401.
const RUNNER_ONLINE_MS = 90 * 1000;              // 3 missed 30 s heartbeats
const RUNNER_MAX_FRAME_BYTES = 600 * 1024;       // per analysis frame, decoded
const RUNNER_MAX_EVIDENCE_BYTES = 1024 * 1024;   // the larger human-viewing copy
const RUNNER_DEDUPE_MS = 48 * 60 * 60 * 1000;
const RUNNER_DEDUPE_MAX = 5000;
const RUNNER_BUCKET_SIZE = 5;
const RUNNER_REFILL_MS = 3000;
const REJECTED_SHOW_MS = 15 * 60 * 1000;         // a refused runner counts as a live problem this long

const runners = new Map();        // gym key -> last heartbeat record
const runnerBuckets = new Map();  // gym key -> { tokens, at }
const recentBursts = new Map();   // gym|label|capturedAt -> { at, promise }
const rejectedRunners = new Map(); // gym code a runner sent that this site doesn't know -> record

// Two kinds of runner token are accepted:
//  1. RUNNER_TOKEN from the environment (the original shared secret; any
//     gym). Still works, but should be deleted: it unlocks every gym.
//  2. A per-gym token from PAIRING: "sa1.<gym>.<HMAC>" (generation 0) or
//     "sa1.<gym>.<n>.<HMAC>" after the operator pressed Unpair n times.
//     The HMAC key is derived from ADMIN_TOKEN, so nothing secret is kept
//     on disk. Unpair bumps the gym's generation (stored in its settings
//     file), which cuts off that gym's paired computers only.
function pairingSecret() {
  const admin = (process.env.ADMIN_TOKEN || '').trim();
  return admin ? crypto.createHmac('sha256', admin).update('securityai-runner-pairing-v1').digest() : null;
}
function gymRunnerToken(code, gen) {
  const key = pairingSecret();
  if (!key) return null;
  const n = Number(gen) || 0;
  const what = n > 0 ? `gym:${code}:${n}` : 'gym:' + code;
  const mac = crypto.createHmac('sha256', key).update(what).digest().toString('base64url');
  return n > 0 ? `sa1.${code}.${n}.${mac}` : `sa1.${code}.${mac}`;
}
function runnerAuth(req, res, next) {
  const legacy = (process.env.RUNNER_TOKEN || '').trim();
  const canPair = !!pairingSecret();
  if (!legacy && !canPair) return res.status(503).json({ ok: false, error: 'RUNNER_TOKEN is not set on the server, and neither is ADMIN_TOKEN. Do this: set ADMIN_TOKEN in Render > Environment, then pair this computer (node pair.js).' });
  const m = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '');
  const given = m ? m[1].trim() : '';
  if (legacy && sameSecret(given, legacy)) { req.runnerGymScope = null; req.runnerLegacyToken = true; return next(); }
  const t = /^sa1\.([a-z0-9_-]{1,40})\.(?:(\d{1,6})\.)?[A-Za-z0-9_-]{20,}$/.exec(given);
  if (t && canPair && sameSecret(given, gymRunnerToken(t[1], t[2] ? Number(t[2]) : 0))) {
    const key = gyms.anyCodesConfigured() ? (gyms.resolveKey(t[1]) || monitor.safeCode(t[1])) : monitor.safeCode(t[1]);
    const gen = t[2] ? Number(t[2]) : 0;
    if (gen !== store.runnerGen(key)) {
      return refuseUnpaired(req, res, t[1], 'unpaired', { ok: false, fatal: true, error: 'This computer was unpaired on the website. Do this: get a new pairing code on the admin page, then run node pair.js' });
    }
    req.runnerGymScope = t[1];
    return next();
  }
  return refuseUnpaired(req, res, t ? t[1] : null, 'wrong-token', { ok: false, error: 'Wrong runner token (this computer is not paired, or ADMIN_TOKEN was changed). Do this: get a pairing code on the admin page, then run node pair.js' });
}

// Check-ins refused because the computer is not paired (unpaired on the
// admin page, never paired, or ADMIN_TOKEN changed since it was paired).
// Remembered in memory per gym, so the admin page can say "on but not
// paired" instead of a plain "offline". Host and time only: the token it
// sent is never kept. The gym comes from the token's "sa1.<gym>." prefix or
// (heartbeats only, body capped at 64 KB) the gymCode it sent; only gyms
// this website knows are recorded, so the list stays small.
const unpairedCheckins = new Map();   // gym key -> { host, at, firstAt, count, why }
const refusedBodyParser = express.json({ limit: '64kb' });
function refuseUnpaired(req, res, tokenGym, why, body) {
  const finish = () => {
    try {
      const raw = tokenGym || (req.body && typeof req.body === 'object' && req.body.gymCode) || '';
      const key = raw ? (gyms.anyCodesConfigured() ? gyms.resolveKey(raw) : monitor.safeCode(raw)) : null;
      if (key) {
        const prev = unpairedCheckins.get(key) || { firstAt: Date.now(), count: 0 };
        const host = cleanText(req.body && typeof req.body === 'object' ? req.body.host : null, 80) || prev.host || null;
        unpairedCheckins.delete(key);
        unpairedCheckins.set(key, { host, at: Date.now(), firstAt: prev.firstAt, count: prev.count + 1, why });
        while (unpairedCheckins.size > 50) unpairedCheckins.delete(unpairedCheckins.keys().next().value);
      }
    } catch (e) { /* only a nicety for the admin page */ }
    res.status(401).json(body);
  };
  if (!req.path.endsWith('/heartbeat')) return finish();
  refusedBodyParser(req, res, () => finish());
}
// A refused "not paired" check-in for this gym newer than its last accepted one.
function unpairedFor(key) {
  const u = unpairedCheckins.get(key);
  if (!u || Date.now() - u.at > REJECTED_SHOW_MS) return null;
  const rec = runners.get(key);
  if (rec && rec.lastSeen && rec.lastSeen > u.at) return null;
  return { host: u.host, at: new Date(u.at).toISOString(), since: new Date(u.firstAt).toISOString(), count: u.count, why: u.why,
    message: 'Computer is on but not paired — pair it again (Connect a camera computer).' };
}

// Route-level JSON parser, run only after the token is accepted, so an
// anonymous caller cannot make the server buffer 4 MB.
const runnerJsonParser = express.json({ limit: '4mb' });
function runnerJson(req, res, next) {
  runnerJsonParser(req, res, err => {
    if (err) {
      const tooBig = err.type === 'entity.too.large' || err.status === 413;
      return res.status(tooBig ? 413 : 400).json({ ok: false, error: tooBig
        ? 'Request is over 4 MB. Do this: send smaller frames (384 px crops are plenty).'
        : 'Request body is not valid JSON.' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ ok: false, error: 'Expected a JSON object.' });
    }
    next();
  });
}

// Plain text from the runner, which is untrusted: control characters out,
// length capped. The pages still escape it; this just keeps it sane.
function cleanText(v, max) {
  if (v == null) return null;
  const t = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
  return t || null;
}
function isoOrNull(v) {
  if (v == null || v === '') return null;
  const t = Date.parse(v);
  return isNaN(t) ? null : new Date(t).toISOString();
}

// The gym a runner request is for, as its data key. When gym accounts
// exist, an unknown gym is refused (403, fatal: the runner should stop and
// say so) and recorded, so the admin page and the uptime check show it
// instead of "all good". Returns null after answering.
function runnerGym(req, res) {
  const raw = req.runnerGymScope || (req.body && req.body.gymCode) || '';
  if (!gyms.anyCodesConfigured()) return monitor.safeCode(raw || 'default');
  const key = gyms.resolveKey(raw);
  if (key) return key;
  const shown = cleanText(raw, 40) || '(none)';
  const code = monitor.safeCode(raw || 'none');
  const rec = rejectedRunners.get(code) || { code, count: 0, firstSeen: Date.now() };
  rec.count++;
  rec.lastSeen = Date.now();
  rec.host = cleanText(req.body && req.body.host, 80) || rec.host || null;
  rec.via = req.path.endsWith('/burst') ? 'burst' : 'heartbeat';
  rec.paired = !!req.runnerGymScope;
  rejectedRunners.set(code, rec);
  while (rejectedRunners.size > 50) rejectedRunners.delete(rejectedRunners.keys().next().value);
  res.status(403).json({ ok: false, fatal: true, error: `This website doesn't know gym "${shown}" — tell SecurityAI` });
  return null;
}
function rejectedView(r) {
  const who = r.host ? `"${r.host}"` : 'A camera computer';
  return {
    code: r.code, host: r.host || null, count: r.count, via: r.via,
    firstSeen: new Date(r.firstSeen).toISOString(), lastSeen: new Date(r.lastSeen).toISOString(),
    problem: `${who} is sending crossings for gym "${r.code}", which this website doesn't know, so they are being refused (${r.count} so far). Do this: pair that computer again (admin page > Connect a camera computer > Get a pairing code, then node pair.js on it). If it belongs to a gym not added yet, add the gym and tick the box for "${r.code}".`,
  };
}
function recentRejected() {
  const cutoff = Date.now() - REJECTED_SHOW_MS;
  return [...rejectedRunners.values()].filter(r => r.lastSeen >= cutoff && !gyms.resolveKey(r.code))
    .sort((a, b) => b.lastSeen - a.lastSeen).map(rejectedView);
}

function runnerIsOnline(rec) {
  return !!(rec && rec.lastSeen && (Date.now() - rec.lastSeen) < RUNNER_ONLINE_MS);
}

// The runner a status request is about: the one for the given status's
// gym, or (if nothing is running) the most recently seen one.
function runnerForStatus(st) {
  if (st && st.gymCode && runners.has(monitor.safeCode(st.gymCode))) return runners.get(monitor.safeCode(st.gymCode));
  if (st && st.running) return null;
  let best = null;
  for (const r of runners.values()) if (!best || r.lastSeen > best.lastSeen) best = r;
  return best;
}

function zonePicture(z) {
  if (z.streamOk) return 'ok';
  if (!z.lastError && !z.framesSeen) return 'starting';
  return 'no-picture';
}

function runnerPublicView(rec) {
  return {
    online: runnerIsOnline(rec),
    lastSeen: rec.lastSeen ? new Date(rec.lastSeen).toISOString() : null,
    ageSec: rec.lastSeen ? Math.max(0, Math.round((Date.now() - rec.lastSeen) / 1000)) : null,
    zones: (rec.zones || []).map(z => ({
      label: z.label,
      streamOk: z.streamOk,
      picture: zonePicture(z),
      lastEventAt: z.lastEventAt || (rec.lastBurstByLabel && rec.lastBurstByLabel[z.label]) || null,
    })),
  };
}

function runnerOperatorView(rec) {
  return Object.assign(runnerPublicView(rec), {
    gymCode: rec.gymCode,
    gymName: gyms.gymNameFor(rec.gymCode),
    host: rec.host,
    version: rec.version,
    firstSeen: rec.firstSeen ? new Date(rec.firstSeen).toISOString() : null,
    heartbeats: rec.heartbeats || 0,
    configReceived: rec.rawConfig || null,
    configApplied: rec.config || null,
    zonesDetail: rec.zones || [],
    lastBurstAt: rec.lastBurstAt ? new Date(rec.lastBurstAt).toISOString() : null,
    lastBurstResult: rec.lastBurstResult || null,
    bursts: rec.bursts || 0,
    duplicatesIgnored: rec.duplicates || 0,
    rateLimited: rec.rateLimited || 0,
    monitorProblem: rec.monitorProblem || null,
    hostConflict: rec.hostConflict || null,
    usesLegacyToken: !!rec.legacyToken,
  });
}

function runnerRecord(code) {
  let rec = runners.get(code);
  if (!rec) {
    rec = { gymCode: code, lastSeen: null, firstSeen: null, heartbeats: 0, zones: [], config: null,
            rawConfig: null, bursts: 0, duplicates: 0, rateLimited: 0, lastBurstByLabel: {}, hosts: {} };
    runners.set(code, rec);
  }
  return rec;
}

// Two different computers checking in for one gym within 90 s (the old
// laptop still running after the Pi took over): both would send every
// crossing, doubling the cost. Say so on the admin page.
function noteHost(rec, host, now) {
  rec.hosts = rec.hosts || {};
  if (host) rec.hosts[host] = now;
  for (const [h, t] of Object.entries(rec.hosts)) if (now - t > 10 * 60 * 1000) delete rec.hosts[h];
  const live = Object.entries(rec.hosts).filter(([, t]) => now - t < RUNNER_ONLINE_MS).map(([h]) => h);
  if (live.length > 1) {
    const name = gyms.gymNameFor(rec.gymCode) || rec.gymCode;
    rec.hostConflict = { hosts: live, since: (rec.hostConflict && rec.hostConflict.since) || new Date(now).toISOString(),
      message: `Two computers are sending for ${name}: ${live.map(h => `"${h}"`).join(' and ')}. Only one should — both send every crossing. Do this: on the old one, run node install-service.js --remove (or close the monitor window).` };
  } else rec.hostConflict = null;
}

function takeBurstToken(code) {
  const now = Date.now();
  const b = runnerBuckets.get(code) || { tokens: RUNNER_BUCKET_SIZE, at: now };
  b.tokens = Math.min(RUNNER_BUCKET_SIZE, b.tokens + (now - b.at) / RUNNER_REFILL_MS);
  b.at = now;
  runnerBuckets.set(code, b);
  if (b.tokens < 1) return Math.ceil((1 - b.tokens) * RUNNER_REFILL_MS / 1000);
  b.tokens -= 1;
  return 0;
}

// Returns { b64 } or { error }. Accepts plain base64 (a data: URL prefix
// is tolerated and stripped). Must decode to a JPEG (FF D8 FF).
function checkJpeg(v, maxBytes, what) {
  if (typeof v !== 'string' || !v) return { error: `${what} must be a base64 JPEG string.` };
  const b64 = v.replace(/^data:image\/jpe?g;base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return { error: `${what} is not valid base64.` };
  if (Math.floor(b64.length * 3 / 4) > maxBytes + 3) return { error: `${what} is over ${Math.round(maxBytes / 1024)} KB. Do this: send smaller crops.` };
  const buf = Buffer.from(b64, 'base64');
  if (buf.length > maxBytes) return { error: `${what} is over ${Math.round(maxBytes / 1024)} KB. Do this: send smaller crops.` };
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return { error: `${what} is not a JPEG.` };
  return { b64 };
}

function pruneRecentBursts() {
  const cutoff = Date.now() - RUNNER_DEDUPE_MS;
  for (const [k, v] of recentBursts) if (v.at < cutoff) recentBursts.delete(k);
  while (recentBursts.size > RUNNER_DEDUPE_MAX) recentBursts.delete(recentBursts.keys().next().value);
}

app.post('/monitor/runner/heartbeat', runnerAuth, runnerJson, (req, res) => {
  const b = req.body;
  // A paired computer always reports for the gym it was paired with.
  const code = runnerGym(req, res);
  if (!code) return;
  const rec = runnerRecord(code);
  const now = Date.now();
  if (!rec.firstSeen) rec.firstSeen = now;
  rec.lastSeen = now;
  rec.heartbeats = (rec.heartbeats || 0) + 1;
  rec.host = cleanText(b.host, 80);
  rec.version = cleanText(b.version, 20);
  rec.legacyToken = !!req.runnerLegacyToken;
  noteHost(rec, rec.host || 'unknown computer', now);
  const rawCfg = (b.config && typeof b.config === 'object' && !Array.isArray(b.config)) ? b.config : {};
  rec.rawConfig = {
    dailyBurstCap: rawCfg.dailyBurstCap ?? null,
    scheduleStart: cleanText(rawCfg.scheduleStart, 10),
    scheduleEnd: cleanText(rawCfg.scheduleEnd, 10),
    tzOffsetMinutes: rawCfg.tzOffsetMinutes ?? null,
    model: cleanText(rawCfg.model, 60),
    alertEmail: cleanText(rawCfg.alertEmail, 200),
    alertPhone: cleanText(rawCfg.alertPhone, 40),
  };
  rec.config = monitor.normaliseRunnerConfig(rawCfg);
  rec.zones = (Array.isArray(b.zones) ? b.zones : []).slice(0, 16)
    .filter(z => z && typeof z === 'object')
    .map(z => ({
      label: cleanText(z.label, 60) || 'Camera',
      streamOk: z.streamOk === true,
      fps: Number.isFinite(Number(z.fps)) ? Math.round(Number(z.fps) * 10) / 10 : null,
      framesSeen: Number.isFinite(Number(z.framesSeen)) ? Math.max(0, Math.floor(Number(z.framesSeen))) : null,
      lastFrameAt: isoOrNull(z.lastFrameAt),
      lastEventAt: isoOrNull(z.lastEventAt),
      lastError: cleanText(z.lastError, 300),
      // Setup warnings the runner found (e.g. "this address ignores the
      // channel"): shown on the admin page so a picture that is coming
      // through from the WRONG camera is never shown as plain green.
      warnings: (Array.isArray(z.warnings) ? z.warnings : []).slice(0, 10).map(w => cleanText(w, 300)).filter(Boolean),
    }));

  // When each camera lost its picture (server clock), for /monitor/runner/alive.
  const downSince = {};
  for (const z of rec.zones) if (!z.streamOk) downSince[z.label] = (rec.zoneDownSince && rec.zoneDownSince[z.label]) || now;
  rec.zoneDownSince = downSince;

  const m = monitor.ensureRemoteMonitoring(code, rec.config);
  rec.monitorProblem = m.ok ? null : m.error;
  // Feeds this gym's dead-man's switch.
  if (m.ok) monitor.recordHeartbeat(code, { host: rec.host });
  // "Camera has had no picture for 5+ min": once per incident, watch hours only.
  if (m.ok) monitor.checkNoPicture(code, downSince);
  const st = monitor.getStatus(code);
  const c = st.config || {};
  res.json({
    ok: true,
    serverTime: new Date(now).toISOString(),
    gymCode: code,
    gymName: gyms.gymNameFor(code),
    monitoring: m.ok,
    problem: m.ok ? undefined : m.error,
    warning: rec.hostConflict ? rec.hostConflict.message : undefined,
    withinSchedule: st.withinSchedule,
    dailyBurstCap: m.ok ? st.dailyBurstCap : undefined,
    pacingFactor: m.ok ? st.pacingFactor : undefined,
    // What the website is actually using (its own settings win over this
    // computer's rtsp-zones.json), so the runner can print it.
    settings: m.ok ? {
      scheduleStart: c.scheduleStart || null, scheduleEnd: c.scheduleEnd || null,
      timeZone: c.timeZone || null, dailyBurstCap: c.dailyBurstCap, model: c.model || null,
      cameraClockNote: c.cameraClockNote || null, sources: st.configSources || null,
    } : undefined,
  });
});

app.post('/monitor/runner/burst', runnerAuth, runnerJson, async (req, res) => {
  const b = req.body;
  const code = runnerGym(req, res);
  if (!code) return;

  if (!Array.isArray(b.frames) || b.frames.length < 1 || b.frames.length > 4) {
    return res.status(400).json({ ok: false, error: 'frames must be a list of 1 to 4 base64 JPEGs.' });
  }
  const frames = [];
  for (let i = 0; i < b.frames.length; i++) {
    const r = checkJpeg(b.frames[i], RUNNER_MAX_FRAME_BYTES, `Frame ${i + 1}`);
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    frames.push(r.b64);
  }
  let evidence;
  if (b.evidence != null && b.evidence !== '') {
    const r = checkJpeg(b.evidence, RUNNER_MAX_EVIDENCE_BYTES, 'Evidence photo');
    if (r.error) return res.status(400).json({ ok: false, error: r.error });
    evidence = r.b64;
  }
  const z = (b.zone && typeof b.zone === 'object') ? b.zone : {};
  const label = cleanText(z.label, 60) || 'Camera';
  const expected = parseInt(z.expectedCount, 10);
  const dur = Number(z.durationSec);
  const capturedAt = isoOrNull(b.capturedAt);
  const zone = {
    label,
    expectedCount: (expected >= 1 && expected <= 20) ? expected : 1,
    accessibleGate: z.accessibleGate === true,
    durationSec: (Number.isFinite(dur) && dur > 0 && dur <= 120) ? Math.round(dur * 10) / 10 : null,
    capturedAt,
    serverPacing: true,   // camera computers don't pace themselves (monitor.js)
  };

  // Accuracy-test crossing (node rtsp-run.js --test): kept apart from
  // real crossings. No alert, no activity log, no monthly report, and not
  // counted against the gym's daily limit (tests have their own limits).
  if (b.test !== undefined) return testBurst(res, code, frames, zone, b.test);

  const rec = runnerRecord(code);

  // Replays from the runner's retry queue must not be analysed — or
  // billed — twice. Keyed on gym + zone + capture time; also checked
  // against the log on disk so it holds across a server restart.
  const key = capturedAt ? `${code}|${label}|${capturedAt}` : null;
  pruneRecentBursts();
  if (key && recentBursts.has(key)) {
    rec.duplicates = (rec.duplicates || 0) + 1;
    const prior = await recentBursts.get(key).promise;
    return res.status(prior.ok ? 200 : 500).json(Object.assign({}, prior, { duplicate: true }));
  }

  const m = monitor.ensureRemoteMonitoring(code, rec.config);
  rec.monitorProblem = m.ok ? null : m.error;
  if (!m.ok) {
    if (m.reason === 'stopped') return res.json({ ok: true, skipped: 'monitoring-stopped' });
    return res.status(409).json({ ok: false, error: m.error });
  }

  if (capturedAt) {
    const logged = monitor.getLog(code).find(e => e && e.zoneLabel === label && e.capturedAt === capturedAt);
    if (logged) {
      rec.duplicates = (rec.duplicates || 0) + 1;
      return res.json({ ok: true, entry: logged, duplicate: true });
    }
  }

  const wait = takeBurstToken(code);
  if (wait) {
    rec.rateLimited = (rec.rateLimited || 0) + 1;
    res.set('Retry-After', String(wait));
    return res.status(429).json({ ok: false, error: `Too many bursts — try again in ${wait} s.`, retryAfterSec: wait });
  }

  const promise = (async () => {
    try {
      const r = await monitor.pushBurstFor(code, frames, zone, evidence);
      if (r && r.skipped) return { ok: true, skipped: r.skipped };
      // An analysis that failed is still logged, with its photos. It is
      // reported as received (ok:true) so the runner does NOT resend it.
      if (r && r.error) return { ok: true, entry: r.entry, analysisError: r.error };
      return { ok: true, entry: r ? r.entry : null };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  })();
  if (key) recentBursts.set(key, { at: Date.now(), promise });
  const out = await promise;
  if (!out.ok && key) recentBursts.delete(key);   // a real failure may be retried

  rec.bursts = (rec.bursts || 0) + 1;
  rec.lastBurstAt = Date.now();
  rec.lastBurstResult = out.ok ? (out.skipped ? `skipped (${out.skipped})` : (out.analysisError ? 'analysis failed' : 'analysed')) : `error: ${out.error}`;
  if (out.ok && !out.skipped) rec.lastBurstByLabel[label] = new Date().toISOString();
  res.status(out.ok ? 200 : 500).json(out);
});

// --- Accuracy test (node rtsp-run.js --test on the camera computer) -----
// See accuracy.js. The camera computer starts a run, sends each test walk's
// crossing to /monitor/runner/burst with a `test` field, then finishes the
// run with what it saw (including walks it never noticed); the website
// scores it with its own saved answers and shows it on the admin page.
const testInFlight = new Map();   // gym|run|trial|seq -> promise of the reply
function testReply(t, c, run) {
  if (c.skipped) return { ok: true, skipped: c.skipped, test: t };
  if (c.error) return { ok: true, test: t, analysisError: c.error, entry: { test: true, model: run.model } };
  if (!c.verdict) return { ok: true, test: t, skipped: 'test-pending' };
  return { ok: true, test: t, entry: Object.assign({ test: true, expectedCount: c.expectedCount, model: run.model }, c.verdict) };
}
async function testBurst(res, code, frames, zone, raw) {
  const v = accuracy.validateTest(raw);
  if (v.error) return res.status(400).json({ ok: false, error: v.error });
  const t = v.value;
  const k = `${code}|${t.runId}|${t.trial}|${t.seq}`;
  if (testInFlight.has(k)) return res.json(Object.assign({}, await testInFlight.get(k), { duplicate: true }));
  const run = accStore.loadRun(code, t.runId);
  if (!run) return res.json({ ok: true, skipped: 'test-unknown-run', test: t });
  const prior = accStore.findCrossing(run, t.trial, t.seq);
  if (prior) return res.json(Object.assign(testReply(t, prior, run), { duplicate: true }));
  if (run.status !== 'running') return res.json({ ok: true, skipped: 'test-finished', test: t });
  const wait = takeBurstToken(code);
  if (wait) {
    res.set('Retry-After', String(wait));
    return res.status(429).json({ ok: false, error: `Too many bursts — try again in ${wait} s.`, retryAfterSec: wait });
  }
  const promise = (async () => {
    const r = accStore.reserveCrossing(code, t.runId, t, frames, zone);
    if (r.skipped) return { ok: true, skipped: r.skipped, test: t };
    const patch = { at: new Date().toISOString() };
    try {
      const rec = runners.get(code);
      const cfg = Object.assign(monitor.analysisConfigFor(code, zone, rec ? rec.config : null), { model: r.run.model });
      const verdict = frames.length === 1 ? await vision.analyzeEntry(frames[0], cfg) : await vision.analyzeEntryBurst(frames, cfg);
      patch.verdict = accStore.slimVerdict(verdict);
    } catch (err) {
      patch.error = String(err && err.message || err).slice(0, 300);
    }
    const c = accStore.updateCrossing(code, t.runId, t.trial, t.seq, patch) || Object.assign(r.crossing, patch);
    return testReply(t, c, r.run);
  })();
  testInFlight.set(k, promise);
  let out;
  try { out = await promise; } finally { testInFlight.delete(k); }
  res.json(out);
}

app.post('/monitor/runner/test', runnerAuth, runnerJson, (req, res) => {
  const b = req.body;
  const code = runnerGym(req, res);
  if (!code) return;
  const runId = typeof b.runId === 'string' ? b.runId : '';
  if (!accuracy.RUN_ID_RE.test(runId)) return res.status(400).json({ ok: false, error: 'runId is not a test run id.' });
  if (b.action === 'start') {
    const rec = runnerRecord(code);
    const cfg = monitor.analysisConfigFor(code, {}, rec.config);
    let run;
    try { run = accStore.startRun(code, { runId, host: cleanText(b.host, 80), zoneLabel: cleanText(b.zone, 60), model: cfg.model }); }
    catch (err) { return res.status(500).json({ ok: false, error: `Could not save the test on the website: ${err.message}` }); }
    const used = accStore.testAnalysesLast24h(code);
    const room = Math.max(0, Math.min(accuracy.MAX_ANALYSES_PER_RUN, accuracy.MAX_TEST_ANALYSES_PER_DAY - used));
    const cpa = accuracy.costPerAnalysis(run.model);
    return res.json({ ok: true, runId, gymName: gyms.gymNameFor(code) || code, model: run.model, modelName: accuracy.modelName(run.model),
      perRunCap: accuracy.MAX_ANALYSES_PER_RUN, dailyTestCap: accuracy.MAX_TEST_ANALYSES_PER_DAY, usedToday: used, room,
      costPerAnalysis: cpa, maxCostText: accuracy.money(room * cpa) });
  }
  if (b.action === 'finish') {
    const v = accuracy.validateTrials(b.trials);
    if (v.error) return res.status(400).json({ ok: false, error: v.error });
    if (!accStore.loadRun(code, runId)) return res.status(404).json({ ok: false, error: 'The website has no test with that id (was it started on another website?).' });
    const run = accStore.finishRun(code, runId, v.value);
    return res.json({ ok: true, runId, model: run.model, modelName: accuracy.modelName(run.model), scorecard: run.scorecard,
      lines: accuracy.formatScorecard(run.scorecard), judged: run.judged, analyses: run.analyses, cost: run.cost, costText: accuracy.money(run.cost) });
  }
  res.status(400).json({ ok: false, error: 'action must be "start" or "finish".' });
});

// The latest test for a gym's admin card: the scorecard, and (after the
// operator asked for it) the same photos re-checked with the other model.
const comparing = new Set();
function accuracyView(key) {
  const rec = runners.get(key);
  const cfg = monitor.analysisConfigFor(key, {}, rec ? rec.config : null);
  const current = cfg.model, cap = cfg.dailyBurstCap || 60;
  const runs = accStore.listRuns(key);
  const newest = runs[0];
  // "Running now" only while it shows signs of life (a stopped test is
  // never finished on the website, so its start time alone would say
  // "running" for too long).
  const lastSign = newest ? Math.max(Date.parse(newest.startedAt) || 0, ...(newest.crossings || []).map(c => Date.parse(c.reservedAt) || 0)) : 0;
  const running = newest && newest.status === 'running' && Date.now() - lastSign < 10 * 60e3 ? { startedAt: newest.startedAt } : null;
  const base = { currentModel: current, currentModelName: accuracy.modelName(current), dailyCap: cap, running };
  // The newest finished test in which at least one walk was actually done
  // (a test stopped before the first walk has nothing to show).
  const run = runs.find(r => r.status === 'finished' && r.scorecard && (r.judged || []).some(j => j.status === 'done' || j.status === 'missed'));
  if (!run) return Object.assign(base, { none: true });
  const other = accuracy.otherModel(run.model);
  const recheckable = (run.crossings || []).filter(c => !c.skipped && c.verdict && !c.error && (c.frames || []).length).length;
  const n = Math.min(recheckable, accuracy.MAX_COMPARE_PER_RUN);
  const out = Object.assign(base, {
    runId: run.runId, startedAt: run.startedAt, finishedAt: run.finishedAt, zoneLabel: run.zoneLabel, host: run.host,
    model: run.model, modelName: accuracy.modelName(run.model), scorecard: run.scorecard,
    judged: (run.judged || []).map(j => Object.assign({}, j, { label: accuracy.KINDS[j.kind] ? accuracy.KINDS[j.kind].short : j.kind })),
    analyses: run.analyses, costText: accuracy.money(run.cost),
    otherModel: other, otherModelName: accuracy.modelName(other),
    compareEstimate: { crossings: n, costText: accuracy.money(n * accuracy.costPerAnalysis(other)) },
    comparing: comparing.has(key),
    compare: null, recommendation: null,
  });
  const c = run.compare;
  if (c && c.done && c.scorecard) {
    out.compare = { model: c.model, modelName: accuracy.modelName(c.model), at: c.finishedAt, scorecard: c.scorecard, judged: c.judged || [], analyses: c.analyses, costText: accuracy.money(c.cost) };
    out.recommendation = accuracy.recommend({ model: run.model, scorecard: run.scorecard }, { model: c.model, scorecard: c.scorecard }, current, cap);
  }
  return out;
}

app.post('/admin/gyms/:gym/tests/:runId/compare', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  const runId = String(req.params.runId || '');
  if (!accuracy.RUN_ID_RE.test(runId)) return res.status(400).json({ ok: false, error: 'Not a test run id.' });
  const run = accStore.loadRun(key, runId);
  if (!run) return res.status(404).json({ ok: false, error: 'No such test for this gym.' });
  if (run.status !== 'finished') return res.status(409).json({ ok: false, error: 'That test has not finished yet.' });
  if (run.compare && run.compare.done) return res.json({ ok: true, already: true, accuracy: accuracyView(key) });
  const lock = key;    // one comparison per gym at a time: the daily test limit holds
  if (comparing.has(lock)) return res.status(409).json({ ok: false, error: 'Already comparing a test for this gym — wait for it to finish.' });
  const other = accuracy.otherModel(run.model);
  const done = new Set(((run.compare && run.compare.model === other && run.compare.crossings) || []).map(c => `${c.trial}|${c.seq}`));
  const all = (run.crossings || []).filter(c => !c.skipped && c.verdict && !c.error && (c.frames || []).length).slice(0, accuracy.MAX_COMPARE_PER_RUN);
  const todo = all.filter(c => !done.has(`${c.trial}|${c.seq}`));
  const room = accuracy.MAX_TEST_ANALYSES_PER_DAY - accStore.testAnalysesLast24h(key);
  if (todo.length > room) return res.status(409).json({ ok: false, error: `The daily limit for tests (${accuracy.MAX_TEST_ANALYSES_PER_DAY} analyses) has no room for this (${todo.length} needed, ${Math.max(0, room)} left). Try again tomorrow.` });
  comparing.add(lock);
  try {
    const rec = runners.get(key);
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const c = todo[i++];
        const frames = accStore.framesOf(key, run, c);
        const result = { trial: c.trial, seq: c.seq, at: new Date().toISOString(), verdict: null, error: null };
        try {
          if (!frames.length) throw new Error('the photos for this crossing are gone');
          if (accStore.testAnalysesLast24h(key) >= accuracy.MAX_TEST_ANALYSES_PER_DAY) throw new Error('the daily limit for tests was reached');
          accStore.noteCompareCall(key);
          const cfg = Object.assign(monitor.analysisConfigFor(key, { label: run.zoneLabel, durationSec: c.durationSec, expectedCount: c.expectedCount, accessibleGate: c.accessibleGate }, rec ? rec.config : null), { model: other });
          const v = frames.length === 1 ? await vision.analyzeEntry(frames[0], cfg) : await vision.analyzeEntryBurst(frames, cfg);
          result.verdict = accStore.slimVerdict(v);
        } catch (err) { result.error = String(err && err.message || err).slice(0, 300); }
        accStore.addCompareResult(key, runId, other, result);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    accStore.finishCompare(key, runId);
    res.json({ ok: true, accuracy: accuracyView(key) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  } finally { comparing.delete(lock); }
});

// --- Pairing a camera computer (no long token to type) -----------------
// Admin page: "Get pairing code" -> 6 digits, valid 15 minutes, works ONCE.
// On the laptop/Pi: node pair.js asks for the website and the code, and
// gets back that gym's runner token (see gymRunnerToken above).
// Brute force: at most 10 wrong codes in total (from anyone) are accepted
// while codes are open — the 10th wrong one cancels every open code — plus
// 5 wrong per caller per 15 minutes. Codes are kept only as hashes, only
// in memory.
const PAIR_TTL_MS = 15 * 60 * 1000;
const PAIR_MAX_WRONG = 10;
const PAIR_MAX_WRONG_PER_CALLER = 5;
const pairCodes = new Map();      // sha256(code) -> { id, gymCode, gymName, createdAt, expiresAt, usedAt, usedBy, revoked }
const pairWrongByCaller = new Map();
let pairWrongTotal = 0;
const pairingHistory = [];        // recent successful pairings (no secrets)
// Only kept on disk when DATA_DIR is set (never in the served code folder).
const PAIRING_LOG = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'runner-pairings.json') : null;
try { const j = PAIRING_LOG && JSON.parse(require('fs').readFileSync(PAIRING_LOG, 'utf8')); if (Array.isArray(j)) pairingHistory.push(...j.slice(0, 20)); } catch (e) { /* none yet */ }
const pairJsonParser = express.json({ limit: '2kb' });
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

function callerKey(req) {
  const xff = String(req.get('X-Forwarded-For') || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || 'unknown';
}
function isHttpsOrLocal(req) {
  if (req.secure || String(req.get('X-Forwarded-Proto') || '').split(',')[0].trim() === 'https') return true;
  const host = String(req.get('host') || '').replace(/:\d+$/, '');
  return /^(localhost|127\.|10\.|192\.168\.|\[::1\])/.test(host);
}
function prunePairCodes() {
  const now = Date.now();
  for (const [k, v] of pairCodes) if (now - v.expiresAt > 60 * 60 * 1000) pairCodes.delete(k);
  for (const [k, v] of pairWrongByCaller) {
    const keep = v.filter(t => now - t < PAIR_TTL_MS);
    if (keep.length) pairWrongByCaller.set(k, keep); else pairWrongByCaller.delete(k);
  }
}
function pairState(p) {
  if (p.usedAt) return 'used';
  if (p.revoked) return 'revoked';
  if (Date.now() > p.expiresAt) return 'expired';
  return 'waiting';
}

app.post('/admin/pair', (req, res) => {
  if (!requireAdmin(req, res)) return;
  prunePairCodes();
  const want = String((req.body || {}).gymCode || '').trim();
  let code = monitor.safeCode(want || 'default');
  let gymName = null;
  if (gyms.anyCodesConfigured()) {
    const key = want ? gyms.resolveKey(want) : null;
    if (!key) return res.status(400).json({ ok: false, error: 'Pick a gym first (create it below if it is new).' });
    code = key;                              // tokens carry the data key, which never changes
    gymName = gyms.gymNameFor(key);
  }
  // One open code per gym: making a new one cancels the old one.
  for (const p of pairCodes.values()) if (p.gymCode === code && pairState(p) === 'waiting') p.revoked = true;
  const digits = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  const rec = { id: crypto.randomBytes(9).toString('base64url'), gymCode: code, gymName, createdAt: now, expiresAt: now + PAIR_TTL_MS };
  pairCodes.set(sha(digits), rec);
  pairWrongTotal = 0;
  res.json({ ok: true, id: rec.id, code: digits, display: `${digits.slice(0, 3)} ${digits.slice(3)}`, gymCode: code, gymName, expiresAt: new Date(rec.expiresAt).toISOString() });
});

app.get('/admin/pair/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const p = [...pairCodes.values()].find(x => x.id === req.params.id);
  if (!p) return res.json({ ok: true, state: 'expired' });
  res.json({ ok: true, state: pairState(p), usedBy: p.usedBy || null, usedAt: p.usedAt ? new Date(p.usedAt).toISOString() : null,
    wrongTries: pairWrongTotal, expiresAt: new Date(p.expiresAt).toISOString() });
});

app.get('/admin/pairings', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, pairings: pairingHistory.slice(0, 20), canPair: !!pairingSecret(), legacyRunnerToken: !!(process.env.RUNNER_TOKEN || '').trim() });
});

app.post('/monitor/runner/pair', (req, res) => {
  if (!isHttpsOrLocal(req)) return res.status(400).json({ ok: false, error: 'Use the https:// address of the website.' });
  if (!pairingSecret()) return res.status(503).json({ ok: false, error: 'Pairing is not switched on: ADMIN_TOKEN is not set on the website. Do this: set ADMIN_TOKEN in Render > Environment.' });
  pairJsonParser(req, res, err => {
    if (err || !req.body || typeof req.body !== 'object') return res.status(400).json({ ok: false, error: 'Bad request.' });
    prunePairCodes();
    const digits = String(req.body.code || '').replace(/\D/g, '');
    if (digits.length !== 6) return res.status(400).json({ ok: false, error: 'A pairing code is 6 numbers, like 482 193.' });
    const who = callerKey(req);
    const mine = pairWrongByCaller.get(who) || [];
    if (mine.length >= PAIR_MAX_WRONG_PER_CALLER) {
      return res.status(429).json({ ok: false, error: 'Too many wrong codes from this computer. Wait 15 minutes, then make a new code on the admin page.' });
    }
    const p = pairCodes.get(sha(digits));
    if (!p || pairState(p) !== 'waiting') {
      mine.push(Date.now()); pairWrongByCaller.set(who, mine);
      pairWrongTotal++;
      if (pairWrongTotal >= PAIR_MAX_WRONG) {
        for (const x of pairCodes.values()) if (pairState(x) === 'waiting') x.revoked = true;
        console.warn(`Pairing: ${pairWrongTotal} wrong codes — all open pairing codes cancelled.`);
        return res.status(401).json({ ok: false, error: 'Too many wrong codes, so every open code was cancelled. Do this: make a new code on the admin page.' });
      }
      const why = p && pairState(p) === 'used' ? 'That code was already used (each code works once).'
        : p && pairState(p) === 'expired' ? 'That code has expired (they last 15 minutes).'
        : 'That code is not right.';
      return res.status(401).json({ ok: false, error: `${why} Do this: check the code on the admin page, or make a new one.` });
    }
    p.usedAt = Date.now();
    p.usedBy = cleanText(req.body.host, 80) || 'unknown computer';
    pairingHistory.unshift({ gymCode: p.gymCode, gymName: p.gymName, host: p.usedBy, at: new Date(p.usedAt).toISOString() });
    pairingHistory.length = Math.min(pairingHistory.length, 20);
    try { if (PAIRING_LOG) require('fs').writeFileSync(PAIRING_LOG, JSON.stringify(pairingHistory, null, 2)); } catch (e) { /* history is a convenience */ }
    console.log(`Pairing: ${p.usedBy} paired with gym "${p.gymCode}".`);
    res.json({ ok: true, runnerToken: gymRunnerToken(p.gymCode, store.runnerGen(p.gymCode)), gymCode: p.gymCode, gymName: p.gymName });
  });
});

// --- One row per gym, for the admin page ---------------------------------
// The public id used in a gym's uptime URL: never the sign-in code.
function uptimeId(key) {
  return 'u-' + crypto.createHmac('sha256', 'securityai-uptime:' + (process.env.ADMIN_TOKEN || '')).update(key).digest('hex').slice(0, 12);
}
function siteUrl(req) {
  const base = gyms.publicBaseUrl();
  if (base) return base;
  const proto = String(req.get('X-Forwarded-Proto') || req.protocol || 'http').split(',')[0].trim() || 'http';
  return `${proto}://${req.get('host') || 'localhost'}`;
}
function knownGymKeys() {
  const keys = new Map();   // key -> { account, fromEnv }
  for (const g of gyms.listGymsForAdmin()) keys.set(g.key, { account: g });
  for (const c of gyms.envCodes()) { const k = monitor.safeCode(c); if (!keys.has(k)) keys.set(k, { fromEnv: true }); }
  const coded = gyms.anyCodesConfigured();
  for (const k of runners.keys()) if (!keys.has(k) && (!coded || gyms.resolveKey(k))) keys.set(k, {});
  for (const k of monitor.listStates()) {
    const st = monitor.getStatus(k);
    if (!keys.has(k) && st.running && (!coded || gyms.resolveKey(k))) keys.set(k, {});
  }
  return keys;
}
function gymRow(key, meta, site) {
  const st = monitor.getStatus(key);
  const rec = runners.get(key) || null;
  const log = monitor.getLog(key);
  const last = log.find(e => e && !e.systemEvent && !e.capReached && e.mode !== 'wall');
  const zones = rec ? (rec.zones || []).map(z => ({ label: z.label, picture: zonePicture(z), since: (rec.zoneDownSince && rec.zoneDownSince[z.label]) ? new Date(rec.zoneDownSince[z.label]).toISOString() : null, lastError: z.lastError || null, warnings: z.warnings || [], fps: z.fps })) : [];
  const online = runnerIsOnline(rec);
  const picture = !zones.length ? (rec ? 'no-camera' : null) : zones.some(z => z.picture === 'no-picture') ? 'no-picture' : zones.some(z => z.picture === 'starting') ? 'starting' : 'ok';
  const usage = monitor.todayUsage(key);
  const unpaired = unpairedFor(key);
  let state;
  if (st.stoppedByOperator && !st.running) state = 'paused';
  else if (unpaired) state = 'not-paired';   // refused after its last accepted check-in
  else if (!rec && !st.running) state = 'not-connected';
  else if (rec && !online) state = 'offline';
  else if (rec && rec.monitorProblem) state = 'problem';
  else if (picture === 'no-picture' || picture === 'no-camera') state = 'no-picture';
  else if (picture === 'starting') state = 'starting';
  else if (st.withinSchedule === false) state = 'off-hours';
  else state = 'watching';
  const cfg = st.config || {};
  return {
    key,
    name: gyms.gymNameFor(key) || (meta.fromEnv ? `${key} (GYM_CODES)` : key),
    account: !!meta.account,
    fromEnv: !!meta.fromEnv,
    timeZone: gyms.timeZoneFor(key),
    state,
    monitoring: { running: st.running, startedBy: st.startedBy, stoppedByOperator: st.stoppedByOperator, withinSchedule: st.withinSchedule,
      schedule: (cfg.scheduleStart && cfg.scheduleEnd && cfg.scheduleStart !== cfg.scheduleEnd) ? { start: cfg.scheduleStart, end: cfg.scheduleEnd } : null,
      dailyBurstCap: st.dailyBurstCap, model: st.costEstimate.model, sources: st.configSources || null, problem: rec ? rec.monitorProblem || null : null,
      // The most this gym can cost: its daily limit used every day for 30 days.
      capMonthly: st.running ? st.costEstimate.capMonthlyWorstCase : null },
    runner: rec ? { online, host: rec.host || null, version: rec.version || null, lastSeen: rec.lastSeen ? new Date(rec.lastSeen).toISOString() : null,
      ageSec: rec.lastSeen ? Math.round((Date.now() - rec.lastSeen) / 1000) : null, picture, zones,
      hostConflict: rec.hostConflict || null, usesLegacyToken: !!rec.legacyToken } : null,
    lastCrossing: last ? (last.capturedAt || last.timestamp) : null,
    today: { bursts: usage.bursts, estimatedCost: usage.estimatedCost, since: usage.since },
    last24h: { bursts: st.burstsLast24h, estimatedCost: st.costEstimate.last24h },
    delivery: store.deliveryStatus(key),
    pairingGeneration: store.runnerGen(key),
    hasHistory: keyHasData(key),
    unpaired,
    accuracy: (() => { try { return accuracyView(key); } catch (e) { return { error: e.message }; } })(),
    uptimeUrl: `${site}/monitor/runner/alive?gym=${uptimeId(key)}`,
  };
}
function overviewRows(req) {
  const site = siteUrl(req);
  return [...knownGymKeys()].map(([k, meta]) => gymRow(k, meta, site));
}
function siteWarnings() {
  const w = [];
  if (gyms.isDamaged()) w.push({ id: 'gyms-file', level: 'red', message: 'The gym accounts file (gyms.json in DATA_DIR) is damaged. The site is using its backup and can\'t save gym changes. Do this: Render > Shell, type  cp "$DATA_DIR/gyms.json.bak" "$DATA_DIR/gyms.json"  then reload this page (SETUP.md, Part 4).' });
  if ((process.env.RUNNER_TOKEN || '').trim()) w.push({ id: 'runner-token', level: 'amber', message: 'RUNNER_TOKEN is set on Render. It unlocks every gym and can\'t be unpaired. Do this: pair each camera computer from the admin page, then delete RUNNER_TOKEN in Render > Environment.' });
  for (const r of runners.values()) if (r.hostConflict) w.push({ id: 'two-hosts', gym: r.gymCode, level: 'amber', message: r.hostConflict.message });
  for (const r of recentRejected()) w.push({ id: 'unknown-gym', gym: r.code, level: 'red', message: r.problem });
  const disk = diskCheck();
  if (!disk.survivesDeploys) w.push({ id: 'disk', level: 'amber', message: diskFix(disk) });
  if (!mailer.isConfigured()) w.push({ id: 'email', level: 'red', message: `${mailer.notConfiguredReason()}. No alert, "camera offline" warning or report can be emailed.` });
  return w;
}

app.get('/admin/overview', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true, serverTime: new Date().toISOString(), site: siteUrl(req), gyms: overviewRows(req), rejectedRunners: recentRejected(), warnings: siteWarnings(),
    siteWideDailyCap: monitor.ENV_MAX_TOTAL_DAILY_BURSTS, siteWideLast24h: monitor.totalBurstsLast24h(), siteUptimeUrl: `${siteUrl(req)}/monitor/runner/alive` });
});

// --- "Is everything OK?" for a free uptime checker (e.g. UptimeRobot) ---
// 200 "OK ..." when camera computers are checking in AND their cameras
// have pictures; 503 "PROBLEM: ..." otherwise. ?gym=<uptime id from the
// admin page> checks one gym and names it. Without ?gym the answer covers
// every gym but names none (it is public).
const SERVER_STARTED_AT = Date.now();
const ALIVE_STARTUP_GRACE_MS = 2 * 60 * 1000;
const ALIVE_PICTURE_GRACE_MS = 3 * 60 * 1000;   // an NVR reboot takes ~2 min
function keyForAlive(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  for (const k of knownGymKeys().keys()) if (uptimeId(k) === v) return k;
  for (const k of runners.keys()) if (uptimeId(k) === v) return k;
  // Older uptime URLs used the gym code itself.
  return gyms.resolveKey(v) || (rejectedRunners.has(monitor.safeCode(v)) || runners.has(monitor.safeCode(v)) ? monitor.safeCode(v) : null);
}
app.get('/monitor/runner/alive', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const want = req.query.gym ? keyForAlive(req.query.gym) : null;
  const bad = msg => res.status(503).type('text/plain').send(`PROBLEM: ${msg}`);
  const now = Date.now();
  if (req.query.gym && !want) return bad('this uptime link names a gym this website doesn\'t know. Copy the link again from the admin page.');
  const name = k => want ? `${gyms.gymNameFor(k) || k}: ` : '';
  // A camera computer being refused (unknown gym) is a problem even though
  // it is checking in.
  const rejected = recentRejected().filter(r => !want || r.code === want);
  if (rejected.length) return bad(want ? `${rejected[0].host || 'the camera computer'} is being refused: this website doesn't know gym "${rejected[0].code}". Adopt it on the admin page.` : 'a camera computer is sending for a gym this website doesn\'t know, so its crossings are refused. See the admin page.');
  if (want && unpairedFor(want) && !runnerIsOnline(runners.get(want))) return bad(`${name(want)}the camera computer is on but not paired. Pair it again from the admin page (Connect a camera computer).`);
  const list = [...runners.values()].filter(r => !want || r.gymCode === want);
  if (!list.length) {
    if (now - SERVER_STARTED_AT < ALIVE_STARTUP_GRACE_MS) return res.type('text/plain').send(`OK: ${name(want)}website just restarted, waiting for the camera computer to check in.`);
    return bad(`${name(want)}no camera computer has checked in since the website started. Is the laptop/Pi on, online and running the monitor?`);
  }
  for (const r of list) {
    const n = want ? name(r.gymCode) : '';
    if (!runnerIsOnline(r)) return bad(`${n}the camera computer stopped checking in ${Math.round((now - r.lastSeen) / 60000)} min ago (asleep, off, offline, or the monitor stopped).`);
    if (!(r.zones || []).length) return bad(`${n}the camera computer is checking in but has no camera set up (run node setup-camera.js on it).`);
    for (const [label, since] of Object.entries(r.zoneDownSince || {})) {
      if (now - since > ALIVE_PICTURE_GRACE_MS) return bad(`${n}camera "${label}" has had no picture for ${Math.round((now - since) / 60000)} min (recorder rebooting, cable, or password).`);
    }
    if (r.monitorProblem) return bad(`${n}the website is not monitoring this gym — see the admin page.`);
  }
  if (want) return res.type('text/plain').send(`OK: ${name(want)}camera computer checking in, pictures coming through.`);
  res.type('text/plain').send(`OK: ${list.length === 1 ? 'camera computer' : list.length + ' camera computers'} checking in, pictures coming through.`);
});

// --- Code updates for the camera computer (node update.js) -------------
// The website already runs exactly the code Joseph deployed, so the laptop
// updates FROM the website: no GitHub login, no zip, settings untouched.
// Only plain code/doc files at the top level are offered — never data,
// settings, logs or anything private — and only to a paired computer.
const UPDATE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(js|html|md|svg|txt|xml|yaml)$/;
function updateFiles() {
  const fsx = require('fs');
  const out = [];
  for (const name of fsx.readdirSync(__dirname).sort()) {
    const ok = UPDATE_FILE_RE.test(name) || name === 'package.json' || /^[A-Za-z0-9-]+\.example\.json$/.test(name);
    if (!ok || isPrivateStaticPath('/' + name)) continue;
    const full = path.join(__dirname, name);
    let st;
    try { st = fsx.statSync(full); } catch (e) { continue; }
    if (!st.isFile() || st.size > 2 * 1024 * 1024) continue;
    const buf = fsx.readFileSync(full);
    out.push({ name, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') });
  }
  return out;
}
app.get('/monitor/runner/files', runnerAuth, (req, res) => {
  const files = updateFiles();
  const version = crypto.createHash('sha256').update(files.map(f => f.name + ':' + f.sha256).join('\n')).digest('hex').slice(0, 12);
  // ?gym=<code>: does that gym code exist here? (update.js warns if not.)
  const asked = req.runnerGymScope || (req.query.gym ? monitor.safeCode(req.query.gym) : null);
  const gymKnown = asked ? (!gyms.anyCodesConfigured() || !!gyms.resolveKey(asked)) : undefined;
  res.set('Cache-Control', 'no-store').json({ ok: true, version, files, gymKnown });
});
app.get('/monitor/runner/files/:name', runnerAuth, (req, res) => {
  const f = updateFiles().find(x => x.name === req.params.name);
  if (!f) return res.status(404).json({ ok: false, error: 'No such file.' });
  res.set('Cache-Control', 'no-store').type('application/octet-stream').sendFile(path.join(__dirname, f.name));
});

// --- Render settings checklist for the admin page ----------------------
// Says which environment variables are set (never their values), grouped
// into must-have / should-have / only-if, each with what it is for.
app.get('/admin/setup', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const e = k => !!String(process.env[k] || '').trim();
  const disk = diskCheck();
  const dataDir = disk.dataDir;
  const writable = disk.writable;
  const smtpMissing = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM'].filter(k => !e(k));
  const items = [
    { key: 'ADMIN_TOKEN', need: 'required', ok: e('ADMIN_TOKEN'), why: 'Opens this page and lets camera computers pair.', fix: 'Render > Environment > Add > key ADMIN_TOKEN, press Generate.' },
    { key: 'ANTHROPIC_API_KEY', need: 'required', ok: e('ANTHROPIC_API_KEY'), why: 'Counts the people in each crossing.', fix: 'From console.anthropic.com > API Keys.' },
    { key: 'SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM', need: 'required', ok: !smtpMissing.length,
      why: 'Sends tailgating alerts, the "camera computer offline" warning and the monthly report.', fix: smtpMissing.length ? `Not set on Render: ${smtpMissing.join(', ')}. A Gmail account with an app password works (SMTP_HOST smtp.gmail.com, SMTP_PORT 587).` : '' },
    { key: 'SUPPORT_EMAIL', need: 'recommended', ok: e('SUPPORT_EMAIL'), why: 'Your own address: gets every "camera computer offline" / "no picture" warning for every gym, and the admin test.', fix: 'Render > Environment > SUPPORT_EMAIL = your email.' },
    { key: 'DATA_DIR (+ a Render Disk)', need: 'recommended', ok: disk.survivesDeploys,
      why: 'Keeps the log, photos, gym accounts and settings when you deploy an update.', fix: diskFix(disk) },
    { key: 'TWILIO_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER', need: 'optional', ok: e('TWILIO_SID') && e('TWILIO_AUTH_TOKEN') && e('TWILIO_FROM_NUMBER'), why: 'Text-message alerts.', fix: '' },
    { key: 'STRIPE_SECRET_KEY', need: 'optional', ok: e('STRIPE_SECRET_KEY'), why: 'Only when you start taking card payments on the website.', fix: '' },
    { key: 'MAX_TOTAL_DAILY_BURSTS', need: 'optional', ok: true, why: e('MAX_TOTAL_DAILY_BURSTS') ? `Set: at most ${monitor.ENV_MAX_TOTAL_DAILY_BURSTS} analyses a day across ALL gyms together.` : 'Optional backstop: at most this many analyses a day across all gyms together (each gym also has its own limit).', fix: '' },
    e('RUNNER_TOKEN')
      ? { key: 'RUNNER_TOKEN', need: 'remove', ok: false, level: 'amber', why: 'Set (old way). It unlocks EVERY gym and can\'t be unpaired, so a lost laptop can post for any gym.', fix: 'Delete this: pair each camera computer from this page (node pair.js), then Render > Environment > delete RUNNER_TOKEN.' }
      : { key: 'RUNNER_TOKEN', need: 'not needed', ok: true, why: 'Not needed — camera computers pair with a 6-digit code instead.', fix: '' },
  ];
  res.json({ ok: true, site: siteUrl(req), items, dataDir, dataDirWritable: writable, disk, warnings: siteWarnings() });
});

// --- Customer-facing routes (activity page, photos, report, gym sign-in,
// reviews, sharing, alert list) live in gym-routes.js. Mounted here so the
// route order is what it always was. Every one of them is scoped to ONE
// gym: the gym signed in on this device, or any gym for the admin token.
require('./gym-routes').mount(app, {
  runnerFor: code => runners.get(monitor.safeCode(code)) || null,
  zonePicture,
  runnerForStatus, runnerPublicView, runnerOperatorView, runnerIsOnline,
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
  if (!requireOperator(req, res)) return;
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
  if (!requireOperator(req, res)) return;
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

// --- Limits on the public demo (/analyze-frame, /scan-cameras) ---------
// These two are anonymous (the marketing page's webcam demo) and every call
// is a paid model call, so each visitor gets a few per hour and the whole
// site a fixed number per day. Env (both optional):
//   DEMO_PER_IP_PER_HOUR  default 10   (per visitor, rolling hour)
//   DEMO_DAILY_CAP        default 50   (whole site, rolling 24 h; 0 = demo off)
// At 50 a day the demo can cost at most about $20 a month (usually far less).
// It is not part of any gym's daily limit, so keep it small.
// Counts live in memory: a restart resets them, which is fine for a cap
// that is about a surprise bill, not about exact accounting.
function demoEnvInt(name, def) {
  const raw = String(process.env[name] || '').trim();
  const n = parseInt(raw, 10);
  return raw && Number.isFinite(n) && n >= 0 ? n : def;
}
const DEMO_PER_IP_PER_HOUR = demoEnvInt('DEMO_PER_IP_PER_HOUR', 10);
const DEMO_DAILY_CAP = demoEnvInt('DEMO_DAILY_CAP', 50);
const demoByCaller = new Map();   // caller -> [ms, ...] in the last hour
let demoToday = [];               // ms of every demo call in the last 24 h
// true = go ahead (and counted); false = a 429 has been sent.
function demoAllowed(req, res) {
  const now = Date.now();
  demoToday = demoToday.filter(t => now - t < 864e5);
  if (demoToday.length >= DEMO_DAILY_CAP) {
    const wait = demoToday.length ? Math.max(60, Math.ceil((demoToday[0] + 864e5 - now) / 1000)) : 3600;
    res.set('Retry-After', String(wait));
    res.status(429).json({ error: 'The live demo is resting: it has had its share of tries for today. Please come back tomorrow, or see the sample morning report.', retryAfterSec: wait });
    return false;
  }
  const who = callerKey(req);
  const mine = (demoByCaller.get(who) || []).filter(t => now - t < 3600e3);
  if (mine.length >= DEMO_PER_IP_PER_HOUR) {
    const wait = Math.max(1, Math.ceil((mine[0] + 3600e3 - now) / 1000));
    const mins = Math.ceil(wait / 60);
    res.set('Retry-After', String(wait));
    res.status(429).json({ error: `That's the limit for the live demo for now (${DEMO_PER_IP_PER_HOUR} tries an hour). Please try again in ${mins} minute${mins === 1 ? '' : 's'}.`, retryAfterSec: wait });
    return false;
  }
  mine.push(now);
  demoByCaller.set(who, mine);
  demoToday.push(now);
  if (demoByCaller.size > 5000) {
    for (const [k, v] of demoByCaller) if (!v.length || now - v[v.length - 1] >= 3600e3) demoByCaller.delete(k);
  }
  return true;
}

// Called by securityai.html's "Capture & analyze" button. This used to
// call api.anthropic.com directly from the browser, which only worked
// while the page was rendered inside Claude's own interface (which
// proxies that call). On an independent domain there's no such proxy,
// so this route exists to do the same call server-side, where a real
// ANTHROPIC_API_KEY actually lives.
app.post('/analyze-frame', async (req, res) => {
  try {
    const { image, expectedCount, accessibleGate } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image (base64 JPEG) is required.' });
    if (!demoAllowed(req, res)) return;
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
    const { image, zones } = req.body || {};
    if (!image) return res.status(400).json({ error: 'image (base64 JPEG) is required.' });
    if (!demoAllowed(req, res)) return;
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
  // Anonymous, and it sends through the same mailbox as the tailgate
  // alerts: a flood would use up Gmail's daily sending limit and the
  // alerts would stop. So: a few per visitor, and a daily ceiling.
  if (store.limited(`support:${callerKey(req)}`, 5, 3600e3) || store.limited('support:all', 40, 864e5)) {
    return res.status(429).json({ error: 'Thanks — we have your earlier messages. Please try again later, or email us directly.' });
  }

  const to = process.env.SUPPORT_EMAIL || process.env.SMTP_USER;
  const body = `From: ${cleanText(name, 100) || '(no name given)'} <${cleanText(email, 200)}>\nTopic: ${cleanText(topic, 100) || '(none given)'}\n\n${String(message).slice(0, 5000)}`;

  if (!to) {
    console.log('--- Support request received (no SUPPORT_EMAIL/SMTP_USER configured to forward to) ---\n' + body);
    return res.json({ ok: true, delivered: false });
  }

  const result = await mailer.sendMail({
    to,
    subject: `SecurityAI support: ${cleanText(topic, 100) || 'New message'}`,
    text: body,
    replyTo: store.normalizeEmail(email) || undefined,
  });

  if (!result.delivered) {
    console.log(`--- Support request received (email delivery skipped: ${result.reason}) ---\n${body}`);
  }

  res.json({ ok: true, delivered: result.delivered });
});

// Creates a real Stripe Checkout Session for a subscription.
// The front end redirects the browser to the returned URL — Stripe hosts
// the actual card form there, so this server never sees a card number.
//
// The PRICE comes from this table, never from the browser: the page used
// to send unitAmountCents from ?price= in its URL, so ?price=1 bought the
// plan for $1. The browser names a plan; anything else it sends about
// money is ignored.
const PLANS = {
  'single-door': { name: 'One entrance', cents: 9900, maxQty: 1 },
  gym: { name: 'Whole gym — every entrance', aliases: ['Whole gym — unlimited entrances'], cents: 19900, maxQty: 1 },
  multi: { name: 'Multi-gym contract (per gym)', cents: 16900, minQty: 2, maxQty: 50 },
};
function planFrom(body) {
  const b = body || {};
  if (b.plan && Object.prototype.hasOwnProperty.call(PLANS, b.plan)) return String(b.plan);
  // Older checkout pages send the display name instead of the plan id.
  const byName = Object.keys(PLANS).find(k => PLANS[k].name === b.planName || (PLANS[k].aliases || []).includes(b.planName));
  return byName || null;
}
app.get('/plans', (req, res) => {
  res.json({ plans: Object.entries(PLANS).map(([id, p]) => ({ id, name: p.name, monthlyUsd: p.cents / 100, minGyms: p.minQty || 1, maxGyms: p.maxQty })) });
});

app.post('/create-checkout-session', async (req, res) => {
  const b = req.body || {};
  const planId = planFrom(b);
  if (!planId) return res.status(400).json({ error: 'Unknown plan. Pick a plan on the pricing page.' });
  const plan = PLANS[planId];
  let qty = parseInt(b.gyms, 10);
  if (!Number.isFinite(qty) || qty < 1) qty = plan.minQty || 1;
  qty = Math.max(plan.minQty || 1, Math.min(plan.maxQty || 1, qty));
  const email = store.normalizeEmail(b.email);
  const meta = s => cleanText(s, 100) || '';
  if (!stripe) {
    // Card payments aren't switched on yet (no STRIPE_SECRET_KEY): the
    // product works without them (gyms are set up from the admin page), so
    // tell the customer how to start instead of showing an error.
    console.warn(`Checkout tried while payments are off: plan ${planId}${email ? ', ' + email : ''}${b.gym ? ', gym ' + cleanText(b.gym, 100) : ''}.`);
    return res.status(503).json({ paymentsOff: true, error: `Online card payment isn't open yet, so nothing was charged. Email ${process.env.SUPPORT_EMAIL || 'tjdicken43@gmail.com'} and we'll set your gym up and send you an invoice.` });
  }
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: `SecurityAI — ${plan.name}` },
            unit_amount: plan.cents,
            recurring: { interval: 'month' },
          },
          quantity: qty,
        },
      ],
      ...(email ? { customer_email: email } : {}),
      // Consent facts, and who is buying for which gym, carried into
      // Stripe's own records for this subscription.
      metadata: {
        plan: planId,
        recurring_billing_ack: 'true',
        camera_data_ack: 'true',
        customer_name: meta(b.name),
        customer_email: email || '',
        gym_name: meta(b.gymName || b.gym),
      },
      subscription_data: { metadata: { plan: planId, gym_name: meta(b.gymName || b.gym) } },
      success_url: `${DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${DOMAIN}/checkout.html?plan=${encodeURIComponent(planId)}`,
    });

    res.json({ url: session.url, plan: planId, monthlyUsd: plan.cents / 100, quantity: qty });
  } catch (err) {
    console.error('Stripe checkout failed:', err.message);
    res.status(500).json({ error: 'The payment page could not be opened just now. Please try again in a minute.' });
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

// Listens and returns the http server. Exported so rtsp-run.js's local
// mode can serve activity.html from the same monitor instance; that path
// deliberately does NOT start the monthly-report scheduler or the email
// ingest (a laptop must not send customers a second report).
function start(port) {
  const p = (port === undefined || port === null) ? PORT : port;
  return app.listen(p, () => console.log(`SecurityAI payment server running on port ${p}`));
}

module.exports = { app, start };

// `node server.js` (how Render runs it): everything, exactly as before.
// require('./server'): nothing listens and nothing starts until start().
if (require.main === module) {
scheduler.start();
// A camera computer that is already off when the website restarts must
// still trigger the "offline" alert.
try { const re = monitor.rearmFromDisk(); if (re.length) console.log(`Watching for check-ins from: ${re.join(', ')} (offline alert armed).`); } catch (e) { console.warn('Could not re-arm offline alerts:', e.message); }
// Last line of defence: one unexpected async failure must not take the
// whole website (every gym) down. Logged loudly instead.
process.on('unhandledRejection', err => console.error('Unexpected error (kept running):', err && err.stack || err));
// Render stops the old copy with SIGTERM on every deploy: save the log
// first (it is written a second after each change).
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { try { monitor.flushLogs(); } catch (e) { /* exiting anyway */ } process.exit(0); });
}

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
    onPoll: n => { if (n) console.log(`  mailbox: ${n} new message(s) to analyse`); else if (cfg.verbose) console.log('  mailbox checked: nothing new'); },
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
          capturedAt: meta.capturedAt || null,
          clockSkewMinutes: meta.clockSkewMinutes || null,
        }, undefined, meta.manual === true);   // main photo = the middle frame, not a copy
        const outcome = (r && r.skipped) ? `skipped (${r.skipped})` : `${meta.frameCount} frame(s) analyzed`;
        console.log(`[${new Date().toLocaleTimeString()}] ${z.label}: ${outcome}`);
        return outcome;
      } catch (err) {
        console.warn(`${z.label}: ${err.message}`);
        return 'failed: ' + err.message;
      }
    },
  };

  global.__securityaiIngest = {
    transports: [
      cfg.email && cfg.email.host ? 'email (' + cfg.email.user + ')' : null,
      cfg.ftp === true ? 'ftp' : null,
      cfg.watchFolder ? 'folder' : null,
    ].filter(Boolean),
    gymCode: cfg.gymCode || null,
    schedule: (cfg.scheduleStart && cfg.scheduleEnd) ? `${cfg.scheduleStart}–${cfg.scheduleEnd}` : 'always',
  };

  global.__securityaiIngestHandlers = handlers;
  if (cfg.email && cfg.email.host) emailIngest.startEmailIngest(cfg.email, handlers);
  if (cfg.ftp === true) ingest.startFtpServer({ port: cfg.ftpPort || 2121, user: cfg.ftpUser || 'camera', pass: cfg.ftpPass || null, publicHost: cfg.publicHost }, handlers);
  if (cfg.watchFolder) ingest.startFolderWatch(cfg.watchFolder, handlers);

  setInterval(() => monitor.recordHeartbeat(), 30000);
  monitor.recordHeartbeat();
})();

start(PORT);
}
