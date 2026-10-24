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
// An async route that throws must not leave the request hanging (Express 4
// doesn't catch promise rejections): pass the error on to the error
// handler at the bottom, which answers plainly and records it for
// self-repair. Error handlers (4 arguments) are left as they are.
for (const m of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
  if (typeof app[m] !== 'function') continue;
  const orig = app[m].bind(app);
  app[m] = (...args) => {
    if (args.length === 1 && typeof args[0] === 'string') return orig(...args);   // app.get('setting')
    return orig(...args.map(fn => (typeof fn === 'function' && fn.length < 4)
      ? function (req, res, next) { const r = fn.apply(this, arguments); if (r && typeof r.catch === 'function') r.catch(next); return r; }
      : fn));
  };
}
const DOMAIN = process.env.DOMAIN || process.env.RENDER_EXTERNAL_URL || 'http://localhost:4242';

app.use(cors());
// Standard safety headers, the ones every hosted security product sends.
// The front-desk, lobby and signage screens may be shown inside a signage
// player's frame, so only those pages can be framed by another site;
// everything else (admin, the gym page, sign-in) can't be, which stops a
// page elsewhere from dressing up our buttons as its own (clickjacking).
app.disable('x-powered-by');
const FRAMEABLE = /^\/(desk|lobby|signage)(\.html)?$/;
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), usb=()');
  if (!FRAMEABLE.test(req.path)) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
  }
  // Only over https (Render): tells browsers never to try plain http here.
  if (req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
});
// Health check for Render (render.yaml healthCheckPath) and any uptime
// monitor: 200 while the server answers and can write its data folder.
// A deploy that can't write its records (disk not mounted) never goes live.
// Says nothing about any gym.
const STARTED_AT = Date.now();
app.get('/healthz', (req, res) => {
  const fs = require('fs');
  const dir = process.env.DATA_DIR || __dirname;
  let writable = true;
  try {
    const probe = path.join(dir, `.healthz-${process.pid}`);
    fs.writeFileSync(probe, String(Date.now()));
    fs.unlinkSync(probe);
  } catch (e) { writable = false; }
  res.set('Cache-Control', 'no-store').status(writable ? 200 : 503)
    .json({ ok: writable, uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000), data: writable ? 'writable' : 'not writable' });
});
// Big JSON answers (the gym's activity list refreshes every 30 s, often on
// a phone's data) go out gzip-compressed: about 10x smaller. No extra
// package needed.
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = body => {
    try {
      const text = JSON.stringify(body);
      // The pages that refresh by themselves: "nothing new" is a tiny 304
      // instead of the whole list again (the browser keeps its copy).
      if (req.method === 'GET' && (req.path === '/gym/activity' || req.path === '/gym/desk') && res.statusCode === 200 && text) {
        const tag = '"' + require('crypto').createHash('sha1').update(text).digest('base64url').slice(0, 22) + '"';
        res.setHeader('ETag', tag);
        res.setHeader('Cache-Control', 'private, no-cache');
        if (String(req.headers['if-none-match'] || '') === tag) { res.statusCode = 304; res.end(); return res; }
      }
      if (text && text.length > 8192 && /\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && !res.getHeader('Content-Encoding')) {
        const z = require('zlib').gzipSync(text, { level: 6 });
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', z.length);
        res.end(z);
        return res;
      }
    } catch (e) { /* fall back to plain */ }
    return json(body);
  };
  next();
});
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
  return /^\/+(rtsp-zones|ingest-zones|gyms|leads|report-sends|self-review-sends|auto-update|incidents|self-repair|login-links-used|vapid|runner-pairings|pair-codes|admin-pending|handoffs)\.json/.test(s)
    || /^\/+(alert-log-|summary-|mail-progress-|gym-reviews-|gym-alerts-|gym-settings-|gym-nights-|gym-tally-|gym-devices-|gym-scans-|gym-meta-|gym-people-|gym-push-|gym-[a-z]+-|owner-delegates|owner-key|screen-reader)[^/]*\.json/.test(s)
    || /^\/+(runner-queue|camera-check|ashbourne-reports|frames-[^/]*|tests-[^/]*|selftest-[^/]*|archive-[^/]*|logos|data|node_modules)(\/|$)/.test(s);
}
app.use((req, res, next) => {
  if ((req.method === 'GET' || req.method === 'HEAD') && (isPrivateStaticPath(req.path) || isInternalDocPath(req.path))) return res.status(404).send('Not found');
  next();
});
// The setup notes (*.md), package.json and render.yaml are for TJ and the
// camera computers (which get them through /monitor/runner/files, signed
// in), not for anyone who types the address. Kept apart from
// isPrivateStaticPath so camera computers still receive them on update.
function isInternalDocPath(p) {
  let s;
  try { s = decodeURIComponent(p); } catch (e) { return true; }
  s = path.posix.normalize('/' + s.replace(/\\/g, '/')).toLowerCase();
  return /\.md$/.test(s) || /^\/+(package\.json|render\.yaml)$/.test(s);
}
// SEO: the home page's canonical link, robots.txt and sitemap.xml are
// written with a placeholder domain. Fill in this website's real address
// (DOMAIN, or the one Render sets in RENDER_EXTERNAL_URL) so search engines
// are pointed at the live site, not at a domain that doesn't exist.
const SEO_PLACEHOLDER = 'https://your-domain-goes-here.com';
const SEO_FILES = { '/': 'securityai.html', '/securityai.html': 'securityai.html', '/robots.txt': 'robots.txt', '/sitemap.xml': 'sitemap.xml' };
const SEO_TYPES = { html: 'text/html; charset=utf-8', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8' };
// Pages, scripts and styles go out compressed (brotli, or gzip: a page is
// 4 to 6 times smaller, which matters on a phone's data at the front desk)
// with an ETag, so a repeat visit is a tiny "not changed" answer. Each file
// is compressed once and kept in memory until it changes on disk. Fonts and
// images, which never change under the same name, are cached for a year.
const zlib = require('zlib');
const TEXT_TYPES = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'application/javascript; charset=utf-8', svg: 'image/svg+xml', txt: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', webmanifest: 'application/manifest+json' };
const LONG_CACHE = { woff: 'font/woff', woff2: 'font/woff2', png: 'image/png', jpg: 'image/jpeg', ico: 'image/x-icon' };
const packed = new Map();   // file -> { mtime, size, etag, raw, br, gz }
function pack(file, text) {
  const raw = Buffer.from(text);
  return { etag: '"' + require('crypto').createHash('sha1').update(raw).digest('base64url').slice(0, 22) + '"', raw,
    br: raw.length > 1024 ? zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 10, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }) : null,
    gz: raw.length > 1024 ? zlib.gzipSync(raw, { level: 9 }) : null };
}
function sendPacked(req, res, p, type, cache) {
  res.setHeader('Content-Type', type);
  res.setHeader('Cache-Control', cache);
  res.setHeader('ETag', p.etag);
  res.setHeader('Vary', 'Accept-Encoding');
  if (String(req.headers['if-none-match'] || '') === p.etag) { res.statusCode = 304; return res.end(); }
  const ae = String(req.headers['accept-encoding'] || '');
  const body = p.br && /\bbr\b/.test(ae) ? (res.setHeader('Content-Encoding', 'br'), p.br) : p.gz && /\bgzip\b/.test(ae) ? (res.setHeader('Content-Encoding', 'gzip'), p.gz) : p.raw;
  res.setHeader('Content-Length', body.length);
  res.end(req.method === 'HEAD' ? undefined : body);
}
function packedFile(file, transform, cb) {
  const fs = require('fs');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return cb(null);
    const have = packed.get(file);
    if (have && have.mtime === st.mtimeMs && have.size === st.size) return cb(have);
    fs.readFile(file, (e2, buf) => {
      if (e2) return cb(null);
      const p = Object.assign(pack(file, transform ? transform(buf.toString('utf8')) : buf), { mtime: st.mtimeMs, size: st.size });
      if (packed.size > 200) packed.clear();
      packed.set(file, p); cb(p);
    });
  });
}
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const file = SEO_FILES[req.path];
  if (!file) return next();
  let origin;
  try { origin = new URL(DOMAIN).origin; } catch (e) { return next(); }
  packedFile(path.join(__dirname, file), text => text.split(SEO_PLACEHOLDER).join(origin), p => {
    if (!p) return next();
    sendPacked(req, res, p, SEO_TYPES[file.split('.').pop()], 'no-cache');
  });
});
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let rel;
  try { rel = decodeURIComponent(req.path); } catch (e) { return next(); }
  if (rel.includes('\0') || /(^|\/)\.\.?(\/|$)/.test(rel) || /\/\./.test(rel)) return next();   // no dot-files, no "..": express.static decides those
  const ext = (rel.match(/\.([a-z0-9]+)$/i) || [])[1];
  const type = ext && TEXT_TYPES[ext.toLowerCase()], long = ext && LONG_CACHE[ext.toLowerCase()];
  if (!type && !long) return next();
  const file = path.join(__dirname, path.posix.normalize(rel));
  if (!file.startsWith(__dirname + path.sep)) return next();
  if (long) {
    return require('fs').stat(file, (err, st) => {
      if (err || !st.isFile()) return next();
      // Fonts never change under the same name; icons and pictures might, so a week.
      res.setHeader('Cache-Control', /^font\//.test(long) ? 'public, max-age=31536000, immutable' : 'public, max-age=604800');
      res.setHeader('Content-Type', long);
      res.setHeader('Content-Length', st.size);
      if (req.method === 'HEAD') return res.end();
      require('fs').createReadStream(file).on('error', () => res.destroy()).pipe(res);
    });
  }
  // sw.js must always be checked (a new version takes over the phone straight away).
  packedFile(file, null, p => (p ? sendPacked(req, res, p, type, 'no-cache') : next()));
});
app.use(express.static(__dirname)); // everything else (and anything the layer above passed on)

// Without this, visiting the bare domain (just "/") 404s with "Cannot GET /",
// because the homepage is named securityai.html, not index.html — the one
// filename express.static automatically serves at "/". This makes the
// root URL work the way a visitor actually expects.
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'securityai.html'));
});
// Short addresses that are easy to say out loud and type on a phone:
// gym-security.onrender.com/gym  -> the gym page (sign-in if needed)
// gym-security.onrender.com/admin -> the admin page
// Query strings (e.g. ?code=) are kept.
for (const [short, page] of [['/gym', 'activity.html'], ['/signin', 'activity.html'], ['/sign-in', 'activity.html'], ['/admin', 'admin.html'], ['/demo', 'activity.html?demo=1'], ['/desk', 'desk.html'], ['/lobby', 'lobby.html'], ['/members', 'members.html'], ['/check', 'check.html']]) {
  app.get(short, (req, res) => {
    const u = String(req.originalUrl || req.url || ''), q = u.indexOf('?');
    res.statusCode = 302;
    res.setHeader('Location', '/' + page + (q >= 0 ? (page.includes('?') ? '&' : '') + u.slice(q + (page.includes('?') ? 1 : 0)) : ''));
    res.setHeader('Cache-Control', 'no-store');
    res.end();
  });
}

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
const adminAuth = require('./admin-auth');
function requireAdmin(req, res) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) { res.status(404).json({ error: 'Not enabled.' }); return false; }
  const c = adminAuth.check(req);
  if (!c.ok) { res.status(403).json(c.needEmail ? { error: 'Approve this browser from the email we send you.', needEmail: true } : { error: 'Not authorized.' }); return false; }
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
  return { code: g.code, key: g.key, gymName: g.gymName, email: g.email, createdAt: g.createdAt, timeZone: g.timeZone || null, codeIssuedAt: g.codeIssuedAt || null, billing: g.billing || null, closedAt: g.closedAt || null };
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
  res.json({ gyms: list.concat(fromEnv).map(g => Object.assign({}, g, { exits: (() => { try { return monitor.exitReadiness(g.key); } catch (e) { return null; } })() })), adoptable: adoptableRunners() });
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
// Skip clear exits (people leaving) to save AI checks: only after a long
// clean run where the AI agreed with every one. Turning it off is always allowed.
app.post('/admin/gyms/:gym/skip-exits', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  const on = (req.body || {}).on === true;
  const r = monitor.exitReadiness(key);
  if (on && !r.ready) return res.status(400).json({ ok: false, error: `Not yet: ${r.agree} of ${r.need} clear exits checked with the AI agreeing every time${r.disagree ? ` (the run restarted after the AI disagreed on ${new Date(r.lastDisagreeAt).toLocaleDateString('en-US')})` : ''}.` });
  const st = store.getSettings(key); st.skipExits = on; store.saveSettings(key, st);
  res.json({ ok: true, exits: monitor.exitReadiness(key) });
});

// Start the pilot fresh: test numbers are archived (no photos) and the
// gym's results start from zero. The gym's name must be typed to confirm.
app.post('/admin/gyms/:gym/fresh-start', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  const want = String(gyms.gymNameFor(key) || key).trim().toLowerCase();
  const typed = String((req.body || {}).confirm || '').trim().toLowerCase();
  if (!typed || (typed !== want && typed !== key)) return res.status(400).json({ ok: false, error: `Type the gym's name exactly (${gyms.gymNameFor(key) || key}) to confirm.` });
  try {
    const entries = monitor.clearEntries(key);
    const r = store.startFresh(key);
    console.log(`Fresh start for ${key}: ${entries} entries cleared, ${r.archived} files archived in ${r.folder}.`);
    res.json({ ok: true, message: `${gyms.gymNameFor(key) || key} starts fresh: ${r.cleared.reviewed} answers, ${r.cleared.confirmed} confirmed and ${r.cleared.nights} nights of test data archived; ${entries} test entries and their photos removed. Settings, alert list, staff logins and pairing are unchanged.` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

// A gym that cancelled: switch everything off and delete what's personal.
// Numbers only (no photos, no names) are archived for your records.
app.post('/admin/gyms/:gym/close', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  const name = gyms.gymNameFor(key) || key;
  const typed = String((req.body || {}).confirm || '').trim().toLowerCase();
  if (!typed || (typed !== String(name).trim().toLowerCase() && typed !== key)) return res.status(400).json({ ok: false, error: `Type the gym's name exactly (${name}) to confirm.` });
  try {
    store.bumpRunnerGen(key);                      // camera computers cut off
    store.bumpReaderGen(key);                      // front-desk reader cut off
    const rec = runners.get(key); if (rec) rec.lastSeen = 0;
    const entries = monitor.clearEntries(key, { all: true });
    const r = store.closeData(key);
    gyms.closeGym(key, (req.body || {}).reason);
    console.log(`Closed ${key}: ${entries} entries and photos deleted, ${r.deleted} files deleted, numbers archived in ${r.folder}.`);
    res.json({ ok: true, message: `${name} is closed. Its sign-in code, staff logins, camera computer and front-desk reader no longer work. ${entries} entries with their photos, the alert list, staff logins, member-number data and notes are deleted. The results (numbers only) are archived on the website's disk for your records.` });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
app.post('/admin/gyms/:gym/reopen', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res);
  if (!key) return;
  try {
    const g = gyms.reopenGym(key);
    store.setPaused(key, false);
    res.json({ ok: true, code: g.code, message: `${g.gymName} is open again with a new sign-in code: ${g.code}. Pair its camera computer and front-desk reader again, and add its people and alert list.` });
  } catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});

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
  const c = adminAuth.check(req);
  if (c.ok) return true;
  res.status(403).json(c.needEmail ? { error: 'Approve this browser from the email we send you.', needEmail: true } : { error: 'Not authorized.' });
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
// The front-desk scan reader's token: "sr1.<gym>[.<n>].<HMAC>", its own
// key and generation, so it can't act as a camera computer (or the other way
// round) and each can be unpaired alone.
function readerSecret() {
  const admin = (process.env.ADMIN_TOKEN || '').trim();
  return admin ? crypto.createHmac('sha256', admin).update('securityai-reader-pairing-v1').digest() : null;
}
function gymReaderToken(code, gen) {
  const key = readerSecret();
  if (!key) return null;
  const n = Number(gen) || 0;
  const mac = crypto.createHmac('sha256', key).update(`reader:${code}:${n}`).digest().toString('base64url');
  return n > 0 ? `sr1.${code}.${n}.${mac}` : `sr1.${code}.${mac}`;
}
function readerAuth(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '');
  const given = m ? m[1].trim() : '';
  const t = /^sr1\.([a-z0-9_-]{1,40})\.(?:(\d{1,6})\.)?[A-Za-z0-9_-]{20,}$/.exec(given);
  if (!t || !readerSecret() || !sameSecret(given, gymReaderToken(t[1], t[2] ? Number(t[2]) : 0))) {
    return res.status(401).json({ ok: false, error: 'This reader is not paired (or ADMIN_TOKEN changed). Get a new code on the admin page and set the reader up again.' });
  }
  const key = gyms.anyCodesConfigured() ? (gyms.resolveKey(t[1]) || monitor.safeCode(t[1])) : monitor.safeCode(t[1]);
  if ((t[2] ? Number(t[2]) : 0) !== store.readerGen(key)) return res.status(401).json({ ok: false, fatal: true, error: 'This reader was unpaired on the website. Get a new code on the admin page and set it up again.' });
  req.readerGym = key;
  next();
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
const runnerJsonParser = express.json({ limit: '6mb' });
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
    update: rec.update || null,
    latestCode: (() => { try { return codeVersion(); } catch (e) { return null; } })(),
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
  // The camera computer's own update state (safe self-update).
  if (b.update && typeof b.update === 'object') {
    const u = b.update, t = v => (v && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
    rec.update = {
      installed: cleanText(u.installed, 20) || null,
      pending: u.pending ? { version: cleanText(u.pending.version, 20), at: t(u.pending.at) } : null,
      lastRollback: u.lastRollback ? { version: cleanText(u.lastRollback.version, 20), at: t(u.lastRollback.at), reason: cleanText(u.lastRollback.reason, 120) } : null,
      lastUpdate: u.lastUpdate ? { version: cleanText(u.lastUpdate.version, 20), at: t(u.lastUpdate.at) } : null,
    };
  }
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
      tamper: ['dark', 'covered', 'frozen', 'moved'].includes(z.tamper) ? z.tamper : null,
      tamperSince: isoOrNull(z.tamperSince),
    }));
  // Camera covered / dark / frozen / turned: tell TJ once per incident,
  // during watch hours (the laptop already waited a minute or two).
  rec.tamperAlerted = rec.tamperAlerted || {};
  for (const z of rec.zones) {
    const key = monitor.safeCode(code);
    if (!z.tamper) { delete rec.tamperAlerted[z.label]; continue; }
    if (rec.tamperAlerted[z.label] === z.tamper) continue;
    rec.tamperAlerted[z.label] = z.tamper;
    if (!monitor.watchingNow(key)) continue;
    const words = { dark: 'the picture has gone almost black', covered: 'the picture is one flat colour — the lens may be covered', frozen: 'the picture is frozen', moved: 'the camera seems to have been turned to point somewhere else' };
    monitor.alertOperator(key, 'tamper', `camera problem at ${z.label}`, `${words[z.tamper]} at ${z.label}. Entries may be missed until it's fixed.`).catch(() => {});
  }

  // How far the camera computer's clock is off ours. A live picture's last
  // frame is under a second old, so (our time - its lastFrameAt) is its
  // clock error. Works for laptops too old to send X-Runner-Time.
  {
    const hdr = Date.parse(req.get('X-Runner-Time') || '');
    const live = rec.zones.find(z => z.streamOk && z.lastFrameAt);
    const skew = !isNaN(hdr) ? Date.now() - hdr : live ? Date.now() - Date.parse(live.lastFrameAt) - 500 : null;
    if (skew != null && Number.isFinite(skew)) rec.clockSkewMs = Math.abs(skew) < 3 * 864e5 ? skew : null;
  }

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
    codeVersion: (() => { try { return codeVersion(); } catch (e) { return undefined; } })(),
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

const DIRS = ['up', 'down', 'left', 'right'];
app.post('/monitor/runner/burst', runnerAuth, runnerJson, async (req, res) => {
  const b = req.body;
  const code = runnerGym(req, res);
  if (!code) return;

  if (!Array.isArray(b.frames) || b.frames.length < 1 || b.frames.length > 6) {
    return res.status(400).json({ ok: false, error: 'frames must be a list of 1 to 6 base64 JPEGs.' });
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
  // "before": 1-2 stills from someone at the turnstile just before this
  // crossing (came back out, or stood there). Checked for a phone handed
  // over for a second scan of the same code.
  let before = null;
  if (b.before && typeof b.before === 'object' && Array.isArray(b.before.frames) && b.before.frames.length >= 1 && b.before.frames.length <= 2) {
    const bf = [];
    for (let i = 0; i < b.before.frames.length; i++) {
      const r = checkJpeg(b.before.frames[i], RUNNER_MAX_FRAME_BYTES, `Earlier photo ${i + 1}`);
      if (r.error) return res.status(400).json({ ok: false, error: r.error });
      bf.push(r.b64);
    }
    const sec = Number(b.before.sec);
    before = {
      frames: bf,
      sec: (Number.isFinite(sec) && sec >= 0) ? Math.min(600, Math.round(sec)) : 0,
      kind: b.before.kind === 'left' ? 'left' : 'waited',
    };
  }
  const z = (b.zone && typeof b.zone === 'object') ? b.zone : {};
  const label = cleanText(z.label, 60) || 'Camera';
  const expected = parseInt(z.expectedCount, 10);
  const dur = Number(z.durationSec);
  const rawCapturedAt = isoOrNull(b.capturedAt);   // as sent: the replay key below
  let capturedAt = rawCapturedAt;
  // The camera computer's clock can be wrong (a borrowed laptop set to
  // another time, or drifting). It says what time it thinks it is as it
  // sends; if that is more than a minute off ours, shift the crossing time
  // by the difference, so times match the gym's check-in system.
  const rt = Date.parse(req.get('X-Runner-Time') || '');
  const hbSkew = (() => { const r = runners.get(code); return r && Number.isFinite(r.clockSkewMs) ? r.clockSkewMs : null; })();
  const skew = !isNaN(rt) ? Date.now() - rt : hbSkew;   // older laptops: the error measured from heartbeats
  if (capturedAt && skew != null && Math.abs(skew) > 60e3 && Math.abs(skew) < 3 * 864e5) capturedAt = new Date(Date.parse(capturedAt) + skew).toISOString();
  const zone = {
    label,
    expectedCount: (expected >= 1 && expected <= 20) ? expected : 1,
    accessibleGate: z.accessibleGate === true,
    durationSec: (Number.isFinite(dur) && dur > 0 && dur <= 120) ? Math.round(dur * 10) / 10 : null,
    lingerSec: (Number.isFinite(Number(z.lingerSec)) && Number(z.lingerSec) > 0) ? Math.min(600, Math.round(Number(z.lingerSec))) : null,
    entryDirection: Array.isArray(z.entryDirection) ? z.entryDirection.filter(d => DIRS.includes(d)).slice(0, 3) : null,
    direction: DIRS.includes(z.direction) ? z.direction : null,
    capturedAt,
    sentCapturedAt: rawCapturedAt !== capturedAt ? rawCapturedAt : null,
    before,
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
  const key = rawCapturedAt ? `${code}|${label}|${rawCapturedAt}` : null;
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
    const logged = monitor.getLog(code).find(e => e && e.zoneLabel === label && (e.sentCapturedAt ? e.sentCapturedAt === rawCapturedAt : e.capturedAt === capturedAt));
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
// Also kept on the disk (hashes only), so a website restart (a deploy or a
// Render setting change) between making a code and typing it doesn't lose it.
const PAIR_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'pair-codes.json') : null;
try { if (PAIR_FILE) for (const [k, v] of JSON.parse(require('fs').readFileSync(PAIR_FILE, 'utf8'))) if (v && v.id) pairCodes.set(k, v); } catch (e) { /* none yet */ }
function savePairCodes() {
  if (!PAIR_FILE) return;
  try { const fsx = require('fs'); fsx.writeFileSync(PAIR_FILE + '.tmp', JSON.stringify([...pairCodes])); fsx.renameSync(PAIR_FILE + '.tmp', PAIR_FILE); } catch (e) { /* best effort */ }
}
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
  let gone = 0;
  for (const [k, v] of pairCodes) if (now - v.expiresAt > 60 * 60 * 1000) { pairCodes.delete(k); gone++; }
  if (gone) savePairCodes();
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
  const role = (req.body || {}).role === 'reader' ? 'reader' : 'camera';
  // One open code per gym (and per kind): making a new one cancels the old one.
  for (const p of pairCodes.values()) if (p.gymCode === code && (p.role || 'camera') === role && pairState(p) === 'waiting') p.revoked = true;
  const digits = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const now = Date.now();
  const rec = { id: crypto.randomBytes(9).toString('base64url'), gymCode: code, gymName, role, createdAt: now, expiresAt: now + PAIR_TTL_MS };
  pairCodes.set(sha(digits), rec);
  savePairCodes();
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
        savePairCodes();
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
    savePairCodes();
    pairingHistory.unshift({ gymCode: p.gymCode, gymName: p.gymName, host: p.usedBy, at: new Date(p.usedAt).toISOString() });
    pairingHistory.length = Math.min(pairingHistory.length, 20);
    try { if (PAIRING_LOG) require('fs').writeFileSync(PAIRING_LOG, JSON.stringify(pairingHistory, null, 2)); } catch (e) { /* history is a convenience */ }
    console.log(`Pairing: ${p.usedBy} paired with gym "${p.gymCode}"${p.role === 'reader' ? ' (front-desk reader)' : ''}.`);
    if (p.role === 'reader') return res.json({ ok: true, readerToken: gymReaderToken(p.gymCode, store.readerGen(p.gymCode)), gymCode: p.gymCode, gymName: p.gymName });
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
      hostConflict: rec.hostConflict || null, usesLegacyToken: !!rec.legacyToken, update: rec.update || null } : null,
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
  for (const r of runners.values()) {
    const rb = r.update && r.update.lastRollback;
    if (rb && rb.at && Date.now() - Date.parse(rb.at) < 3 * 864e5) w.push({ id: 'rollback', gym: r.gymCode, level: 'amber', message: `${gyms.gymNameFor(r.gymCode) || r.gymCode}: the camera computer tried the new program version ${rb.version} and went back to the previous one by itself (${rb.reason}). It keeps watching on the old version. Fix and deploy again; it updates by itself when the door is quiet.` });
  }
  for (const r of recentRejected()) w.push({ id: 'unknown-gym', gym: r.code, level: 'red', message: r.problem });
  const disk = diskCheck();
  if (!disk.survivesDeploys) w.push({ id: 'disk', level: 'amber', message: diskFix(disk) });
  // How full the data disk is (photos fill it): amber at 80%, red at 92%.
  try {
    const st = require('fs').statfsSync(process.env.DATA_DIR || __dirname);
    const used = 1 - st.bavail / st.blocks, pct = Math.round(used * 100), freeMb = Math.round(st.bavail * st.bsize / 1048576);
    if (pct >= 80) w.push({ id: 'disk-full', level: pct >= 92 ? 'red' : 'amber', message: `The data disk is ${pct}% full (${freeMb} MB free). Photos stop being saved when it's full. Do this: Render > Disks > raise the size (1 GB more is about $0.25 a month).` });
  } catch (e) { /* older Node: no statfs */ }
  if (!mailer.isConfigured()) w.push({ id: 'email', level: 'red', message: `${mailer.notConfiguredReason()}. No alert, "camera offline" warning or report can be emailed.` });
  // Self-healing note: the main AI model was busy and the backup answered.
  const ai = vision.stats();
  const recent = t => t && Date.now() - Date.parse(t) < 24 * 3600e3;
  if (recent(ai.lastFailureAt)) w.push({ id: 'ai-failing', level: 'amber', message: `Some AI checks failed in the last 24 hours (last at ${new Date(ai.lastFailureAt).toLocaleString('en-US', { timeZone: 'America/Chicago' })}): Anthropic was busy or unreachable, even for the backup model. The camera computer re-sends what it can. If this keeps happening, check status.anthropic.com and your Anthropic credit balance.` });
  else if (recent(ai.lastBackupAnswerAt)) w.push({ id: 'ai-backup', level: 'info', message: `Self-healed: the main AI model was busy ${ai.fallbacks} time(s) since the website started, and the backup model answered ${ai.backupAnswers} check(s), so nothing was missed. Nothing to do.` });
  return w;
}

// --- Self-review: a health score per gym and what to do (self-review.js) ---
const selfReview = require('./self-review');
function reviewFor(key, site) {
  const row = gymRow(key, knownGymKeys().get(key) || {}, site);
  let reader = null; try { reader = memberKeys.loadDevices(key).reader || null; } catch (e) { /* none */ }
  if (reader && reader.problemCode && READER_FIX[reader.problemCode]) reader = Object.assign({}, reader, { fix: READER_FIX[reader.problemCode][1] });
  let tally = {}; try { tally = store.tallySummary(key); } catch (e) { /* none */ }
  let test = null; try { test = selfTest.summary(key); } catch (e) { /* none */ }
  return selfReview.reviewGym({ name: row.name, row, log: monitor.getLog(key), reviews: store.loadReviews(key), tally, reader, ai: vision.stats(), selfTest: test, repair: (() => { try { return selfRepair.view(); } catch (e) { return null; } })(), eventId: e => store.eventId(e) });
}
app.get('/admin/self-review', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const site = siteUrl(req);
  res.set('Cache-Control', 'no-store').json({ ok: true, gyms: [...knownGymKeys().keys()].map(k => Object.assign({ key: k }, reviewFor(k, site))), nextEmail: nextWeeklyReview() });
});
// Weekly email to TJ (SUPPORT_EMAIL): Mondays 8 am Central, once.
const REVIEW_MARK = () => path.join(process.env.DATA_DIR || __dirname, 'self-review-sends.json');
function nextWeeklyReview() { return process.env.SUPPORT_EMAIL ? 'Mondays at 8 AM Central, to ' + process.env.SUPPORT_EMAIL : 'Off: set SUPPORT_EMAIL on Render'; }
async function weeklyReviewTick(force) {
  const to = String(process.env.SUPPORT_EMAIL || '').trim();
  if (!to || !mailer.isConfigured()) return { sent: false, reason: 'no SUPPORT_EMAIL or email not set up' };
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', weekday: 'short', hour: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  const week = `${p.year}-${p.month}-${p.day}`;
  if (!force && !(p.weekday === 'Mon' && Number(p.hour) >= 8)) return { sent: false, reason: 'not time yet' };
  let mark = {}; try { mark = JSON.parse(require('fs').readFileSync(REVIEW_MARK(), 'utf8')); } catch (e) { /* first */ }
  if (!force && mark.last === week) return { sent: false, reason: 'already sent' };
  const keys = [...knownGymKeys().keys()];
  if (!keys.length) return { sent: false, reason: 'no gyms' };
  const site = DOMAIN || '';
  const mail = selfReview.weeklyEmail(keys.map(k => reviewFor(k, site)), site);
  const r = await mailer.sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });
  if (r && r.delivered !== false && !force) { try { require('fs').writeFileSync(REVIEW_MARK(), JSON.stringify({ last: week, at: new Date().toISOString() })); } catch (e) { /* next hour */ } }
  return { sent: !!(r && r.delivered !== false), subject: mail.subject };
}
app.post('/admin/self-review/send', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(Object.assign({ ok: true }, await weeklyReviewTick(true))); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

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
    const tz = (r.zones || []).find(z => z.tamper);
    if (tz) return bad(`${n}camera "${tz.label}" looks ${tz.tamper === 'moved' ? 'turned away' : tz.tamper} (since ${tz.tamperSince || 'just now'}).`);
    // The front-desk reader went quiet during watch hours.
    try {
      const rd = require('./member-keys').loadDevices(r.gymCode).reader;
      const quiet = rd && rd.lastSeen ? now - Date.parse(rd.lastSeen) : 0;
      if (rd && quiet > 15 * 60e3 && quiet < 24 * 3600e3 && monitor.watchingNow(monitor.safeCode(r.gymCode))) return bad(`${n}the front-desk reader on the Ashbourne PC stopped checking in ${Math.round(quiet / 60000)} min ago (PC asleep, off, or Ashbourne closed).`);
    } catch (e) { /* no reader */ }
  }
  if (want) return res.type('text/plain').send(`OK: ${name(want)}camera computer checking in, pictures coming through.`);
  res.type('text/plain').send(`OK: ${list.length === 1 ? 'camera computer' : list.length + ' camera computers'} checking in, pictures coming through.`);
});

// --- Code updates for the camera computer (node update.js) -------------
// The website already runs exactly the code TJ deployed, so the laptop
// updates FROM the website: no GitHub login, no zip, settings untouched.
// Only plain code/doc files at the top level are offered — never data,
// settings, logs or anything private — and only to a paired computer.
const UPDATE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(js|html|md|svg|txt|xml|yaml|sh)$/;
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
// The program version this website serves (for the camera computers' safe
// self-update). Files only change with a deploy (a restart), so it is
// worked out once and kept for 10 minutes.
let codeVersionCache = { at: 0, v: null };
function codeVersion(files) {
  if (!files && codeVersionCache.v && Date.now() - codeVersionCache.at < 600e3) return codeVersionCache.v;
  const list = files || updateFiles();
  const v = crypto.createHash('sha256').update(list.map(f => f.name + ':' + f.sha256).join('\n')).digest('hex').slice(0, 12);
  codeVersionCache = { at: Date.now(), v };
  return v;
}
app.get('/monitor/runner/files', runnerAuth, (req, res) => {
  const files = updateFiles();
  const version = codeVersion(files);
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

// --- Moving a camera computer's settings to a new box (laptop -> Pi) ------
// The old computer uploads its settings ENCRYPTED with a one-time code it
// shows (AES-256-GCM, key from the code by scrypt); this website only ever
// holds the scrambled copy, for 30 minutes, handed out once. move.js.
const HANDOFF_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'handoffs.json') : null;
const handoffs = new Map();     // id -> { blob, gym, at, pickedUpAt }
try { if (HANDOFF_FILE) for (const [k, v] of Object.entries(JSON.parse(require('fs').readFileSync(HANDOFF_FILE, 'utf8')))) handoffs.set(k, v); } catch (e) { /* none */ }
function saveHandoffs() {
  for (const [k, v] of handoffs) if (Date.now() - v.at > 2 * 3600e3) handoffs.delete(k);
  if (!HANDOFF_FILE) return;
  try { const fsx = require('fs'); fsx.writeFileSync(HANDOFF_FILE + '.tmp', JSON.stringify(Object.fromEntries(handoffs)), { mode: 0o600 }); fsx.renameSync(HANDOFF_FILE + '.tmp', HANDOFF_FILE); } catch (e) { /* best effort */ }
}
app.post('/monitor/runner/handoff', runnerAuth, express.json({ limit: '200kb' }), (req, res) => {
  const b = req.body || {};
  const id = String(b.id || ''), blob = String(b.blob || '');
  if (!/^[a-f0-9]{32}$/.test(id) || !/^[A-Za-z0-9_-]{40,180000}$/.test(blob)) return res.status(400).json({ ok: false, error: 'Bad request.' });
  if (store.limited('handoff-up:' + (req.runnerGymScope || 'legacy'), 10, 3600e3)) return res.status(429).json({ ok: false, error: 'Too many tries. Wait an hour.' });
  handoffs.set(id, { blob, gym: req.runnerGymScope || null, at: Date.now(), pickedUpAt: null });
  saveHandoffs();
  res.json({ ok: true, minutes: 30 });
});
app.get('/monitor/runner/handoff/:id/status', runnerAuth, (req, res) => {
  const h = handoffs.get(String(req.params.id));
  res.set('Cache-Control', 'no-store').json({ ok: true, exists: !!h, pickedUp: !!(h && h.pickedUpAt) });
});
app.get('/monitor/handoff/:id', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (store.limited('handoff-get:' + callerKey(req), 20, 3600e3)) return res.status(429).json({ ok: false, error: 'Too many tries from here. Wait an hour.' });
  const h = handoffs.get(String(req.params.id));
  if (!h || h.pickedUpAt || Date.now() - h.at > 30 * 60e3) return res.status(404).json({ ok: false, error: 'That move code is not right, was already used, or is more than 30 minutes old. Make a new one on the old computer.' });
  h.pickedUpAt = Date.now(); const blob = h.blob; h.blob = null; saveHandoffs();
  res.json({ ok: true, blob });
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
// ---- Protected member numbers (member-keys.js) -------------------------
const memberKeys = require('./member-keys');
const keysJson = express.json({ limit: '32kb' });
app.get('/admin/keys', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const owner = memberKeys.getOwner();
  const out = {};
  for (const key of knownGymKeys().keys()) {
    const v = Object.assign({ name: gyms.gymNameFor(key) || key }, memberKeys.adminView(key));
    // The plain-words fix next to a reader problem, and whether it's up to date.
    if (v.reader && v.reader.problemCode && READER_FIX[v.reader.problemCode]) v.reader = Object.assign({}, v.reader, { fix: READER_FIX[v.reader.problemCode][1] });
    if (v.reader && v.reader.version) v.reader = Object.assign({}, v.reader, { latest: READER_VERSION() });
    out[key] = v;
  }
  const dl = memberKeys.loadDelegates();
  res.set('Cache-Control', 'no-store').json({ ok: true, owner: owner ? { code: owner.code, fp: owner.fp, at: owner.at } : null, gyms: out,
    delegates: dl.delegates.map(x => ({ fp: x.fp, code: x.code, name: x.name, status: x.status, sign: x.sign, createdAt: x.createdAt, approvedAt: x.approvedAt || null })) });
});
app.post('/admin/keys/owner', keysJson, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const b = req.body || {};
  if (memberKeys.getOwner() && b.replace !== true) return res.status(409).json({ ok: false, error: 'There is already an owner device. Replacing it means setting the front-desk reader up again.' });
  try { const o = memberKeys.setOwner(b.sign); res.json({ ok: true, code: o.code, fp: o.fp }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});
// Backup approvers: a second phone asks; the owner device signs it in.
app.post('/admin/keys/delegates', keysJson, (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { const d = memberKeys.requestDelegate((req.body || {}).sign, (req.body || {}).name); res.json({ ok: true, fp: d.fp, code: d.code, status: d.status }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});
app.post('/admin/keys/delegates/:fp/approve', keysJson, (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { const d = memberKeys.approveDelegate(String(req.params.fp), (req.body || {}).at, (req.body || {}).sig); res.json({ ok: true, fp: d.fp, status: d.status }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});
app.post('/admin/keys/delegates/:fp/remove', keysJson, (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(Object.assign({ ok: true }, memberKeys.removeDelegate(String(req.params.fp), (req.body || {}).at, (req.body || {}).sig))); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});
app.post('/admin/keys/:gym/devices', keysJson, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res); if (!key) return;
  const b = req.body || {};
  try { const d = memberKeys.addApprovedDevice(key, b.pub, b.name, b.at, b.sig, b.by); res.json({ ok: true, id: d.id, code: d.code, status: d.status }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});
app.post('/admin/keys/:gym/devices/:id/approve', keysJson, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res); if (!key) return;
  try { const d = memberKeys.approveDevice(key, req.params.id, (req.body || {}).at, (req.body || {}).sig, { by: (req.body || {}).by }); res.json({ ok: true, id: d.id, status: d.status }); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});
app.post('/admin/keys/:gym/devices/:id/remove', keysJson, (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res); if (!key) return;
  try { res.json(Object.assign({ ok: true }, memberKeys.removeDevice(key, req.params.id, (req.body || {}).at, (req.body || {}).sig, (req.body || {}).by))); }
  catch (err) { res.status(400).json({ ok: false, error: err.message }); }
});
// The pending device's key, so the owner device can sign over its fingerprint.
app.get('/admin/keys/:gym/devices/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res); if (!key) return;
  const d = memberKeys.loadDevices(key).devices.find(x => x.id === req.params.id);
  if (!d) return res.status(404).json({ ok: false, error: 'That device is gone.' });
  res.json({ ok: true, id: d.id, pub: d.pub, fp: d.fp, code: d.code, status: d.status });
});
// Scans for the admin's own (owner) reading device, to look into problems.
app.get('/admin/keys/:gym/scans', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res); if (!key) return;
  const hours = Math.min(48, Math.max(1, Number(req.query.hours) || 12));
  res.set('Cache-Control', 'no-store').json({ ok: true, scans: memberKeys.scansFor(key, String(req.query.device || ''), Date.now() - hours * 3600e3, Date.now() + 60e3) });
});
app.post('/admin/gyms/:gym/unpair-reader', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = adminGymKey(req, res); if (!key) return;
  try { store.bumpReaderGen(key); res.json({ ok: true }); } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});
// The front-desk reader.
app.get('/reader/trust', readerAuth, (req, res) => {
  memberKeys.noteReader(req.readerGym, { host: cleanText(req.get('X-Reader-Host'), 80), version: cleanText(req.get('X-Reader-Version'), 20) });
  res.set('Cache-Control', 'no-store').json(Object.assign({ ok: true }, memberKeys.trustFor(req.readerGym)));
});
app.post('/reader/scans', readerAuth, express.json({ limit: '1mb' }), (req, res) => {
  const b = req.body || {};
  const rt = Date.parse(req.get('X-Runner-Time') || '');
  const skew = isNaN(rt) ? 0 : Date.now() - rt;
  const added = memberKeys.addScans(req.readerGym, b.scans, skew);
  memberKeys.noteReader(req.readerGym, { host: cleanText(b.host, 80), version: cleanText(b.version, 20), problem: cleanText(b.problem, 300), lastScanAt: added ? new Date().toISOString() : undefined, clockSkewSec: Math.round(skew / 1000) });
  res.json({ ok: true, added });
});
// What each reader problem means, and how to fix it (the email says both).
const READER_FIX = {
  'ashbourne-closed': ['Ashbourne isn\'t open on the front-desk PC', 'Open Ashbourne on the Visit Log screen and leave it open (it\'s fine to use other screens, then come back). The reader picks it up again by itself.'],
  'labels-changed': ['the reader can see Ashbourne\'s Live Entry pop-up but can\'t read the member number from it', 'Ashbourne may have changed its screen in an update. On the Pi at the front desk run: cd ~/securityai && node screen-reader.js --check, and send what it prints to Claude to adjust the reader.'],
  'offline': ['the front-desk PC can\'t reach the website, so scans are waiting on that PC', 'Check that PC\'s internet / Wi-Fi. Nothing is lost: the waiting scans send by themselves when it\'s back.'],
  'owner-mismatch': ['the owner device on the website is not the one the reader was set up with', 'If you replaced your owner device on purpose, set the reader up again (on the Pi: node screen-reader.js --setup). If you did NOT, someone may have changed it: change ADMIN_TOKEN on Render and tell Claude.'],
  'no-devices': ['no devices are approved to read member numbers, so they aren\'t being kept', 'On your own phone: admin page > Protected member numbers > Make this my owner device.'],
  'no-signal': ['the screen reader gets no picture from the front-desk screen', 'At the front desk: is the PC on, and the small HDMI splitter\'s power plugged in? Check the cable from the splitter to the capture stick, and that the capture stick is in the Raspberry Pi. On the PC, Windows must never turn the screen off (Settings > System > Power > Screen and sleep > turn off my screen after: Never). Turning just the monitor off is fine.'],
  'popup-hidden': ['the screen reader can\'t see the check-in screen at the front desk (the PC may be locked or logged off, or the check-in program closed or covered)', 'Ask whoever is at the gym to unlock the front-desk PC and open the check-in screen: on Ashbourne, Home with the Visit Log, and the Live Entry pop-up allowed to show (an open member account is fine during the day, but close it before leaving). The reader finds it again by itself. If the screen IS open and this stays, the check-in program may have changed its look in an update: teach the reader again (node screen-reader.js --teach on the Pi, over remote access). Until then, entries are judged by the camera only and are never called "no scan".'],
  'list-late': ['the check-in list at the front desk shows scans late', 'In the check-in program, turn on its live view or auto-refresh (or leave its pop-up open). Scans are still timed by the times on each row.'],
  'unpaired': ['the reader was unpaired on the website', 'Pair it again: admin page > Protected member numbers > your gym > "Reader: new code", then on the Pi at the front desk run: cd ~/securityai && node screen-reader.js --setup'],
};
const readerAlerted = new Map();   // gym|code -> time emailed
// The reader version the website hands out (the reader updates itself to it).
let readerVersionCache = null;
function READER_VERSION() {
  if (readerVersionCache) return readerVersionCache;
  try { const m = /\$ReaderVersion = '([0-9.]+)'/.exec(require('fs').readFileSync(path.join(__dirname, 'securityai-reader.txt'), 'utf8')); readerVersionCache = m ? m[1] : null; } catch (e) { readerVersionCache = null; }
  return readerVersionCache;
}
app.post('/reader/status', readerAuth, express.json({ limit: '8kb' }), (req, res) => {
  const b = req.body || {};
  const key = req.readerGym;
  const before = memberKeys.loadDevices(key).reader || {};
  const code = READER_FIX[b.problemCode] ? b.problemCode : null;
  const c = b.counts && typeof b.counts === 'object' ? b.counts : {};
  const note = b.note && typeof b.note === 'object' && /^[a-z-]{2,30}$/.test(String(b.note.code || '')) ? { code: String(b.note.code), text: cleanText(b.note.text, 300), since: cleanText(b.note.since, 40) } : null;
  memberKeys.noteReader(key, { host: cleanText(b.host, 80), version: cleanText(b.version, 20), problem: cleanText(b.problem, 300), problemCode: code, watching: b.watching === true,
    blindSince: cleanText(b.blindSince, 40), note, noteText: note ? note.text : null,
    counts: { scans: Number(c.scans) || 0, otherZone: Number(c.otherZone) || 0, doubles: Number(c.doubles) || 0, fromList: Number(c.fromList) || 0, confirmed: Number(c.confirmed) || 0, conflicts: Number(c.conflicts) || 0, listResets: Number(c.listResets) || 0, oldRows: Number(c.oldRows) || 0, denied: Number(c.denied) || 0 }, queued: Number(b.queued) || 0 });
  // Email TJ when a problem starts (again after 6 h if it lasts), and when it's fixed.
  // Ashbourne closed outside watch hours (the PC restarted overnight) is normal: no email.
  const k = key + '|' + code;
  const quietHours = ['ashbourne-closed', 'popup-hidden', 'no-signal'].includes(code) && !monitor.watchingNow(key);
  if (code && !quietHours && (!readerAlerted.has(k) || Date.now() - readerAlerted.get(k) > 6 * 3600e3)) {
    readerAlerted.set(k, Date.now());
    const [what, fix] = READER_FIX[code];
    monitor.alertOperator(key, 'reader-' + code, 'front-desk reader needs attention', `${what}.\n\nWhat it said: ${cleanText(b.problem, 300) || '-'}\n\nHow to fix: ${fix}\n\nUntil then, entries are still checked by the camera; only the member numbers and scan matching are affected.`).catch(() => {});
  } else if (!code && before.problemCode) {
    const had = [...readerAlerted.keys()].filter(x => x.startsWith(key + '|'));
    had.forEach(x => readerAlerted.delete(x));
    if (had.length) monitor.alertOperator(key, 'reader-ok', 'front-desk reader back to normal', `the front-desk reader is working normally again (it had reported: ${READER_FIX[before.problemCode] ? READER_FIX[before.problemCode][0] : before.problemCode}). Nothing for you to do.`).catch(() => {});
  }
  res.json({ ok: true });
});

// ---- Ashbourne screen check reports ------------------------------------
// The check on the front-desk PC sends its BLANKED report here (names and
// numbers already turned into Xxxx / 9999 on the PC), so TJ can download
// it on his phone. Anyone could post one, so: text only, 400 KB at most,
// a few an hour, only the last 5 kept, and only the admin can read them.
const CHECK_DIR = path.join(process.env.DATA_DIR || __dirname, 'ashbourne-reports');
const checkPosts = [];
app.post('/ashbourne-check/report', (req, res) => {
  const now = Date.now();
  while (checkPosts.length && now - checkPosts[0] > 3600e3) checkPosts.shift();
  if (checkPosts.length >= 10) return res.status(429).json({ ok: false, error: 'Too many reports this hour.' });
  let raw = '', size = 0, tooBig = false;
  req.on('data', d => { size += d.length; if (size > 400 * 1024) { tooBig = true; return; } raw += d; });
  req.on('end', () => {
    if (tooBig || !raw.trim()) return res.status(400).json({ ok: false, error: tooBig ? 'Report too large.' : 'Empty report.' });
    if (!/^\uFEFF?SecurityAI - Ashbourne screen check/.test(raw)) return res.status(400).json({ ok: false, error: 'Not a screen check report.' });
    checkPosts.push(now);
    try {
      const fsx = require('fs');
      if (!fsx.existsSync(CHECK_DIR)) fsx.mkdirSync(CHECK_DIR);
      const host = String(req.get('X-Check-Host') || 'PC').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 30) || 'PC';
      const name = `${new Date(now).toISOString().replace(/[:.]/g, '-')}_${host}.txt`;
      fsx.writeFileSync(path.join(CHECK_DIR, name), raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ''), { mode: 0o600 });
      const all = fsx.readdirSync(CHECK_DIR).filter(f => f.endsWith('.txt')).sort();
      for (const old of all.slice(0, Math.max(0, all.length - 5))) fsx.unlinkSync(path.join(CHECK_DIR, old));
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ ok: false, error: 'Could not save.' }); }
  });
});
app.get('/admin/ashbourne-reports', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const fsx = require('fs');
  let files = [];
  try { files = fsx.readdirSync(CHECK_DIR).filter(f => f.endsWith('.txt')).sort().reverse(); } catch (e) { /* none yet */ }
  res.set('Cache-Control', 'no-store').json({ ok: true, reports: files.map(f => ({ id: f, at: f.slice(0, 24).replace(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z.*/, '$1:$2:$3.$4Z'), host: (f.split('_')[1] || '').replace(/\.txt$/, ''), bytes: fsx.statSync(path.join(CHECK_DIR, f)).size })) });
});
app.get('/admin/ashbourne-reports/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const id = String(req.params.id || '');
  if (!/^[0-9TZ-]+_[A-Za-z0-9_-]*\.txt$/.test(id)) return res.status(400).json({ ok: false, error: 'Bad name.' });
  try {
    const text = require('fs').readFileSync(path.join(CHECK_DIR, id), 'utf8');
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.send(text);
  } catch (e) { res.status(404).json({ ok: false, error: 'Gone.' }); }
});

// The front-desk reader stopped checking in during watch hours: tell TJ
// once (it checks in every minute while it runs).
const readerQuietAlerted = new Map();
setInterval(() => {
  try {
    for (const key of knownGymKeys().keys()) {
      const rd = memberKeys.loadDevices(key).reader;
      if (!rd || !rd.lastSeen) continue;
      const quiet = Date.now() - Date.parse(rd.lastSeen);
      if (quiet < 15 * 60e3) { readerQuietAlerted.delete(key); continue; }
      if (quiet > 24 * 3600e3 || readerQuietAlerted.get(key) === rd.lastSeen || !monitor.watchingNow(key)) continue;
      readerQuietAlerted.set(key, rd.lastSeen);
      monitor.alertOperator(key, 'reader-offline', 'front-desk reader stopped', `the front-desk reader on the Ashbourne PC hasn't checked in for ${Math.round(quiet / 60000)} minutes, so member numbers aren't being matched (the camera still checks entries).\n\nHow to fix: make sure the Ashbourne PC is on, not asleep (Settings > System > Power > Sleep: Never) and signed in to Windows. If it was restarted, the reader starts by itself when Windows signs in. If it still doesn't come back, paste the reader line on that PC again and choose 1 (update/restart).\n\nIf the PC is on and nothing else changed: its antivirus (ESET) or the network may have started blocking the website. Test it on that PC: open Edge and go to ${(gyms.publicBaseUrl && gyms.publicBaseUrl()) || 'the website'}/alive . A "Website blocked" page means whoever manages the antivirus must allow gym-security.onrender.com again.`).catch(() => {});
    }
  } catch (e) { /* next time */ }
}, 60e3).unref();

adminAuth.mount(app, { publicBaseUrl: () => { try { return require('./gyms').publicBaseUrl(); } catch (e) { return null; } } });
// Nightly self-test: one staff-confirmed tailgate re-checked each day.
const selfTest = require('./self-test').create({
  dataDir: process.env.DATA_DIR || __dirname, framesDirFor: monitor.framesDirFor, vision,
  timeZoneFor: k => gyms.timeZoneFor(k), scheduleFor: k => ({ watchingNow: monitor.watchingNow(k) }), keepMsFor: k => monitor.summaryMsFor(k), log: m => console.log(m),
  onError: e => { try { incidents.record('self-test', e); } catch (x) { /* later */ } },
});
// Morning summary email, an hour after each gym's watch hours.
const morning = require('./morning').create({ monitor, store, gyms, mailer, kindOf: e => selfReview.kindOf(e), send: (k, sub, m) => monitor.sendToSubscriber(k, sub, m), log: m => console.log(m), onError: e => { try { incidents.record('morning', e); } catch (x) { /* later */ } } });
// One reminder for a flagged entry nobody has answered (nudge.js), daytime only.
const nudge = require('./nudge').create({ monitor, store, gyms, mailer, kindOf: e => selfReview.kindOf(e), send: (k, sub, m) => monitor.sendToSubscriber(k, sub, m), log: m => console.log(m), onError: e => { try { incidents.record('nudge', e); } catch (x) { /* later */ } } });
require('./gym-routes').mount(app, {
  runnerFor: code => runners.get(monitor.safeCode(code)) || null,
  zonePicture,
  runnerForStatus, runnerPublicView, runnerOperatorView, runnerIsOnline,
  selfTest, morning,
});
app.post('/admin/gyms/:gym/morning', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = gyms.resolveKey(req.params.gym) || monitor.safeCode(req.params.gym);
  const m = morning.build(key, Date.now());
  const to = String((req.body || {}).to || process.env.SUPPORT_EMAIL || '').trim();
  if (!to) return res.json({ ok: true, preview: { subject: m.subject, text: m.text } });
  const r = await mailer.sendMail({ to, subject: m.subject, text: m.text, html: m.html });
  res.json({ ok: true, sent: !!(r && r.delivered !== false), to, subject: m.subject });
});
app.post('/admin/gyms/:gym/compare-model', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = gyms.resolveKey(req.params.gym) || monitor.safeCode(req.params.gym);
  const model = String((req.body || {}).model || 'claude-haiku-4-5-20251001');
  if (!vision.ALLOWED_MODELS[model]) return res.status(400).json({ ok: false, error: 'Unknown model.' });
  try { res.json({ ok: true, result: await selfTest.compare(key, model) }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
app.post('/admin/gyms/:gym/self-test', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const key = gyms.resolveKey(req.params.gym) || monitor.safeCode(req.params.gym);
  try { const r = await selfTest.runOne(key); res.json({ ok: true, result: r, summary: selfTest.summary(key) }); }
  catch (e) { res.status(500).json({ ok: false, error: e.message }); }
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
//   DEMO_DAILY_CAP        default 0    (whole site, rolling 24 h; 0 = demo off)
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
// Off by default: the home page no longer has the webcam demo (the sample
// report shows the real thing at no cost). Set DEMO_DAILY_CAP to turn it on.
const DEMO_DAILY_CAP = demoEnvInt('DEMO_DAILY_CAP', 0);
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

// "Will it work at your gym?" (check.html): the answers, the verdict and
// how to reach them, saved for the admin page and emailed to TJ.
app.post('/check/submit', async (req, res) => {
  const b = req.body || {};
  const email = store.normalizeEmail(b.email);
  const gymName = cleanText(b.gym, 100);
  if (!email || !gymName) return res.status(400).json({ error: 'Add your gym name and email.' });
  if (store.limited(`check:${callerKey(req)}`, 5, 3600e3) || store.limited('check:all', 40, 864e5)) return res.status(429).json({ error: 'We have your earlier answers. Please call or email instead.' });
  const answers = {};
  for (const k of ['recorder', 'brand', 'angle', 'checkin', 'desk', 'shows', 'video', 'wired']) answers[k] = cleanText(b[k], 60);
  const v = require('./compat').verdict(answers);
  const lead = store.addLead({ gym: gymName, city: cleanText(b.city, 80), name: cleanText(b.name, 80), email, phone: cleanText(b.phone, 30), note: cleanText(b.note, 500), answers, verdict: v.overall.title, level: v.overall.level });
  const to = process.env.SUPPORT_EMAIL || process.env.SMTP_USER;
  const text = [`${lead.gym}${lead.city ? ' (' + lead.city + ')' : ''} checked whether SecurityAI works for them.`, '', `Verdict: ${v.overall.title}`, ...v.items.map(x => `- ${x.title}: ${x.text}`), '',
    `Their answers: recorder ${answers.recorder || '?'} ${answers.brand || ''} · entrance camera ${answers.angle || '?'} · check-in ${answers.checkin || '?'} · front desk ${answers.desk || '?'} ${answers.video || ''} (shows ${answers.shows || '?'}) · cable ${answers.wired || '?'}`,
    `Contact: ${lead.name || '(no name)'} <${email}>${lead.phone ? ' · ' + lead.phone : ''}`, lead.note ? `Note: ${lead.note}` : '', '', 'Reply to this email to answer them. It is also on the admin page under Gyms that checked.'].filter(x => x !== null).join('\n');
  let delivered = false;
  if (to) { const r = await mailer.sendMail({ to, subject: `${v.overall.level === 'ok' ? 'Ready' : 'Check'}: ${lead.gym} asked if SecurityAI works for them`, text, replyTo: email }).catch(() => ({})); delivered = !!(r && r.delivered); }
  res.json({ ok: true, delivered, verdict: v.overall });
});
app.get('/admin/leads', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: true, leads: store.loadLeads().slice(0, 100) });
});
app.post('/admin/leads/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ ok: store.markLead(String(req.params.id), !!(req.body || {}).done) });
});

// Creates a real Stripe Checkout Session for a subscription.
// The front end redirects the browser to the returned URL — Stripe hosts
// the actual card form there, so this server never sees a card number.
//
// The PRICE comes from this table, never from the browser: the page used
// to send unitAmountCents from ?price= in its URL, so ?price=1 bought the
// plan for $1. The browser names a plan; anything else it sends about
// money is ignored.
// $200 a month for the first entrance, $100 for each extra entrance or
// location. 'gym' and 'multi' are the same plan (older links use either):
// the quantity is the number of entrances, the first billed at the full
// price and the rest at the extra price.
const PLANS = {
  'single-door': { name: 'One entrance', cents: 20000, maxQty: 1 },
  gym: { name: 'Several entrances or locations', aliases: ['Whole gym — every entrance', 'Whole gym — unlimited entrances', 'Multi-gym contract (per gym)'], cents: 20000, extraCents: 10000, minQty: 2, maxQty: 50 },
};
PLANS.multi = PLANS.gym;
function planFrom(body) {
  const b = body || {};
  if (b.plan && Object.prototype.hasOwnProperty.call(PLANS, b.plan)) return String(b.plan);
  // Older checkout pages send the display name instead of the plan id.
  const byName = Object.keys(PLANS).find(k => PLANS[k].name === b.planName || (PLANS[k].aliases || []).includes(b.planName));
  return byName || null;
}
app.get('/plans', (req, res) => {
  res.json({ plans: Object.entries(PLANS).filter(([id]) => id !== 'multi').map(([id, p]) => ({ id, name: p.name, monthlyUsd: p.cents / 100, extraUsd: p.extraCents ? p.extraCents / 100 : null, minEntrances: p.minQty || 1, maxEntrances: p.maxQty })) });
});

app.post('/create-checkout-session', async (req, res) => {
  const b = req.body || {};
  const planId = planFrom(b);
  if (!planId) return res.status(400).json({ error: 'Unknown plan. Pick a plan on the pricing page.' });
  const plan = PLANS[planId];
  let qty = parseInt(b.entrances !== undefined ? b.entrances : b.gyms, 10);
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
            product_data: { name: plan.extraCents ? 'SecurityAI — first entrance' : `SecurityAI — ${plan.name}` },
            unit_amount: plan.cents,
            recurring: { interval: 'month' },
          },
          quantity: plan.extraCents ? 1 : qty,
        },
      ].concat(plan.extraCents && qty > 1 ? [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'SecurityAI — each extra entrance or location' },
          unit_amount: plan.extraCents,
          recurring: { interval: 'month' },
        },
        quantity: qty - 1,
      }] : []),
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

    res.json({ url: session.url, plan: planId, monthlyUsd: (plan.cents + (plan.extraCents ? plan.extraCents * (qty - 1) : plan.cents * (qty - 1))) / 100, quantity: qty });
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

  // Answer Stripe at once (it retries slow answers); the work runs after.
  res.json({ received: true });
  handleStripeEvent(event).catch(e => { try { incidents.record('stripe', e, { type: event.type }); } catch (x) { console.error('stripe:', e.message); } });
});

// Self-serve signup. A paid checkout creates the gym (once per checkout),
// emails the owner how to sign in, and tells TJ. A failed payment or a
// cancellation tells TJ and shows on the admin page; nothing is switched
// off automatically (TJ decides).
async function handleStripeEvent(event) {
  const o = (event && event.data && event.data.object) || {};
  const tell = (subject, text) => { const to = String(process.env.SUPPORT_EMAIL || '').trim(); return to && mailer.isConfigured() ? mailer.sendMail({ to, subject, text }) : null; };
  if (event.type === 'checkout.session.completed') {
    if (o.mode && o.mode !== 'subscription') return;
    if (store.getMarker('_site', 'stripe-' + o.id)) return;                 // Stripe can send the same event twice
    const md = o.metadata || {};
    const email = store.normalizeEmail(o.customer_email || (o.customer_details && o.customer_details.email) || md.customer_email);
    const gymName = cleanText(md.gym_name, 80) || (email ? email.split('@')[1].split('.')[0] : 'New gym');
    if (!email) { await tell('SecurityAI: paid checkout with no email', `Checkout ${o.id} was paid but had no email address. Set the gym up by hand from the admin page.`); store.setMarker('_site', 'stripe-' + o.id, 'no-email'); return; }
    const gym = gyms.createGym({ gymName, email });
    gyms.setBilling(gym.key, { status: 'active', plan: md.plan || null, customer: o.customer || null, subscription: o.subscription || null, checkout: o.id });
    store.setMarker('_site', 'stripe-' + o.id, gym.key);
    const base = gyms.publicBaseUrl() || String(DOMAIN || '').replace(/\/+$/, '');
    const name = cleanText(md.customer_name, 60);
    await mailer.sendMail({ to: email, subject: `Welcome to SecurityAI, ${gym.gymName}`,
      text: `Hi${name ? ' ' + name.split(' ')[0] : ''},\n\nThanks for signing up. Your gym's page is ready:\n${base}/gym\n\nSign in: tap "Email me a sign-in link" and use this email (${email}). You're the owner, so you can add your staff from there.\n\nYour gym code (share it only with your staff): ${gym.code}\n\nWhat happens next:\n1. TJ will call or email within one business day to book the install (about an hour at the gym, using the camera you already have).\n2. Put the entrance sign up (on the gym page under Getting started).\n3. Add yourself to alerts.\n\nQuestions: reply to this email.\n\nTJ, SecurityAI` });
    await tell(`New SecurityAI signup: ${gym.gymName}`, `${gym.gymName} signed up (${md.plan || 'plan ?'}).\nOwner: ${name || '?'} <${email}>\nGym key: ${gym.key}\nStripe checkout: ${o.id}\n\nNext: call them to book the install. The gym is on the admin page.`);
    return;
  }
  if (event.type === 'invoice.payment_failed' || event.type === 'customer.subscription.deleted') {
    const subId = event.type === 'invoice.payment_failed' ? o.subscription : o.id;
    const g = gyms.findBySubscription(subId) || gyms.findBySubscription(o.customer);
    const status = event.type === 'invoice.payment_failed' ? 'payment-failed' : 'canceled';
    if (g) gyms.setBilling(g.key || g.code, { status });
    await tell(`SecurityAI billing: ${g ? g.gymName : 'unknown gym'} ${status === 'canceled' ? 'canceled' : 'payment failed'}`,
      `${g ? g.gymName + ' (' + (g.key || g.code) + ')' : 'A subscription not matched to a gym'}: ${status === 'canceled' ? 'the subscription was canceled.' : 'a payment failed. Stripe retries by itself; check the Stripe dashboard.'}\nStripe ${event.type === 'invoice.payment_failed' ? 'invoice' : 'subscription'}: ${o.id}\n\nNothing was switched off. ${status === 'canceled' && g ? `When their last paid day is over, close it out: ${(gyms.publicBaseUrl() || '')}/admin.html#gym=${encodeURIComponent(g.key || g.code)} > Close this gym. That switches it off and deletes their photos, logins and member data.` : 'Decide on the admin page.'}`);
    return;
  }
  if (event.type === 'invoice.paid' && o.subscription) {
    const g = gyms.findBySubscription(o.subscription);
    if (g && g.billing && g.billing.status !== 'active') gyms.setBilling(g.key || g.code, { status: 'active' });
  }
}

// Render (and most hosting platforms) assign the port dynamically via
// the PORT environment variable and expect the app to listen on
// whatever that is — a hardcoded port means the platform never sees
// anything answering and reports the deploy as failed. Falls back to
// 4242 for local development, where PORT usually isn't set.
const PORT = process.env.PORT || 4242;

// --- Self-repair: failures are recorded, diagnosed and (when safe) fixed ---
// incidents.js groups failures by cause; self-repair.js decides what to do
// and emails TJ every time. Only the website does this (not a laptop in
// local mode), so it is switched on in the "node server.js" block below.
const incidents = require('./incidents').create({ dataDir: process.env.DATA_DIR || __dirname, log: m => console.warn(m) });
const selfRepair = require('./self-repair').create({
  dataDir: process.env.DATA_DIR || __dirname, codeDir: __dirname, incidents, mailer, store, monitor,
  siteUrl: () => String(DOMAIN || '').replace(/\/+$/, ''), gymKeys: () => [...knownGymKeys().keys()], gymName: k => gyms.gymNameFor(k) || k, log: m => console.log(m),
});
// A route that threw: answer plainly, and record it.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413 || err.status === 400)) return next(err);
  incidents.record('route', err, { path: req.path, method: req.method });
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on our side. It has been recorded and TJ has been told.' });
});

// --- Encrypted backup of the records (backup.js) ---------------------------
const backup = require('./backup');
const backupOpts = { keepMsFor: (kind, key) => kind === 'log' ? monitor.logMsFor(key) : monitor.summaryMsFor(key) };
app.post('/admin/backup', (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (store.limited(`backup:${callerKey(req)}`, 10, 3600e3)) return res.status(429).json({ error: 'Too many backups — try again in an hour.' });
  try {
    const b = backup.seal(process.env.DATA_DIR || __dirname, (req.body || {}).password, backupOpts);
    res.set('Cache-Control', 'no-store').set('Content-Type', 'application/octet-stream')
      .set('Content-Disposition', `attachment; filename="securityai-backup-${new Date().toISOString().slice(0, 10)}.sabak"`).send(b.text);
  } catch (e) { res.status(400).json({ error: e.message }); }
});
// A practice restore: opens a backup file with its password and says what
// is inside, compared with the website now. Nothing is written or changed.
function rawText(limit) {
  return (req, res, next) => {
    if (typeof req.body === 'string') return next();
    let size = 0; const parts = [];
    req.on('data', d => { size += d.length; if (size > limit) { res.status(413).json({ error: 'That file is too big.' }); req.destroy(); return; } parts.push(d); });
    req.on('end', () => { if (res.headersSent) return; req.body = Buffer.concat(parts).toString('utf8'); next(); });
    req.on('error', () => { if (!res.headersSent) res.status(400).json({ error: 'Could not read the file.' }); });
  };
}
app.post('/admin/backup/check', (req, res, next) => { if (requireAdmin(req, res)) next(); }, rawText(60 * 1024 * 1024), (req, res) => {
  if (store.limited(`backupcheck:${callerKey(req)}`, 10, 3600e3)) return res.status(429).json({ error: 'Too many checks — try again in an hour.' });
  try {
    const b = backup.open(String(req.body || ''), req.get('X-Backup-Password') || '');
    const files = b.files || {};
    let gymList = []; try { gymList = JSON.parse(files['gyms.json'] || '[]'); } catch (e) { /* none */ }
    const entries = Object.entries(files).filter(([n]) => /^alert-log-/.test(n)).reduce((sum, [, t]) => { try { return sum + JSON.parse(t).length; } catch (e) { return sum; } }, 0);
    const nowGyms = gyms.listGymsForAdmin().length;
    res.json({ ok: true, at: b.at, files: Object.keys(files).length, gyms: (Array.isArray(gymList) ? gymList : []).map(g => g.gymName || g.key || '?'), entries, nowGyms });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
// Nightly copy by email (3 AM Central) when BACKUP_PASSWORD is set.
async function nightlyBackupTick() {
  const pw = String(process.env.BACKUP_PASSWORD || ''), to = String(process.env.SUPPORT_EMAIL || '').trim();
  if (!pw || !to || !mailer.isConfigured()) return;
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  const day = `${p.year}-${p.month}-${p.day}`;
  if (Number(p.hour) < 3 || store.getMarker('_site', 'backup') === day) return;
  const b = backup.seal(process.env.DATA_DIR || __dirname, pw, backupOpts);
  const r = await mailer.sendMail({ to, subject: `SecurityAI backup ${day} (${b.count} files, locked)`, text: `The website's records from ${day}, locked with your BACKUP_PASSWORD. Photos are not included, and entries past each gym's keep time are left out.\n\nKeep only the last 30 days of these emails: delete older ones.\n\nTo open it: node backup.js restore <this file> <password> <folder>`, attachments: [{ filename: `securityai-backup-${day}.sabak`, content: b.text }] });
  if (r && r.delivered !== false) store.setMarker('_site', 'backup', day);
  else throw new Error('backup email not sent: ' + (r && r.reason));
}

// Email links and the admin page: approve, reject, keep, undo.
const repairPage = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${escHtmlS(title)}</title>
<link rel="stylesheet" href="/brand.css"><style>body{margin:0;background:#E4E6E3;color:#1E2124;font:17px/1.55 var(--body);padding:24px 16px;}
.c{max-width:520px;margin:6vh auto;background:#F7F7F5;border-radius:16px;padding:24px;box-shadow:var(--lift-hi);}
h1{font:800 34px/1 var(--display);text-transform:uppercase;margin:0 0 10px;} p{color:#3A4146;margin:6px 0;} b{color:#1E2124;} pre{white-space:pre-wrap;background:#fff;border:1px solid #D3D6D3;border-radius:8px;padding:10px;font-size:12px;color:#1E2124;max-height:50vh;overflow:auto;}
button{width:100%;min-height:52px;margin-top:16px;border:0;border-radius:10px;font:inherit;font-weight:700;cursor:pointer;background:#1D4FB0;color:#fff;}
button.warn{background:#C8281F;color:#fff;} a{color:#1D4FB0;}</style></head><body><div class="c">${body}</div></body></html>`;
function escHtmlS(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
const REPAIR_WORDS = { approve: ['Approve and deploy this change?', 'It merges on GitHub, and Render deploys it in a few minutes. It is watched for 30 minutes and put back by itself if anything goes wrong.', 'Approve and deploy', ''],
  reject: ['Reject this change?', 'Nothing on the website changes.', 'Reject', 'warn'],
  undo: ['Undo this?', 'It goes back exactly to how it was before.', 'Undo', 'warn'],
  keep: ['Keep it?', 'It stays as it is now.', 'Keep it', ''] };
app.get('/self-repair/:id/:action', (req, res) => {
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  const { id, action } = req.params, w = REPAIR_WORDS[action];
  if (!w || !selfRepair.linkOk(id, action, req.query.e, req.query.t)) return res.status(403).send(repairPage('Link not valid', '<h1>This link doesn\'t work</h1><p>It has expired or isn\'t for this website. Use the admin page instead (Self-repair).</p>'));
  const r = (selfRepair.view().repairs || []).find(x => x.id === id);
  res.send(repairPage(w[0], `<h1>${escHtmlS(w[0])}</h1>${r ? `<p><b>${escHtmlS(r.fix || r.cause || r.what || '')}</b></p><p>Status now: ${escHtmlS(r.status)}</p>${r.diff && action === 'approve' ? `<pre>${escHtmlS(r.diff)}</pre>` : ''}` : ''}<p>${escHtmlS(w[1])}</p>
    <form method="POST" action="/self-repair/${encodeURIComponent(id)}/${encodeURIComponent(action)}?e=${encodeURIComponent(req.query.e)}&t=${encodeURIComponent(req.query.t)}"><button type="submit" class="${w[3]}">${escHtmlS(w[2])}</button></form>`));
});
app.post('/self-repair/:id/:action', async (req, res) => {
  res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer');
  const { id, action } = req.params;
  if (!REPAIR_WORDS[action] || !selfRepair.linkOk(id, action, req.query.e, req.query.t)) return res.status(403).send(repairPage('Link not valid', '<h1>This link doesn\'t work</h1><p>It has expired or isn\'t for this website.</p>'));
  if (store.limited(`repair-link:${callerKey(req)}`, 20, 3600e3)) return res.status(429).send(repairPage('Slow down', '<h1>Too many tries</h1><p>Try again in an hour.</p>'));
  try { const msg = await selfRepair.act(id, action, 'TJ (email link)'); res.send(repairPage('Done', `<h1>Done</h1><p>${escHtmlS(msg)}</p>`)); }
  catch (e) { res.status(400).send(repairPage('Not done', `<h1>Not done</h1><p>${escHtmlS(e.message)}</p>`)); }
});
app.get('/admin/self-repair', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.set('Cache-Control', 'no-store').json(Object.assign({ ok: true }, selfRepair.view(), { incidents: incidents.list().slice(0, 20).map(i => ({ fp: i.fp, area: i.area, message: i.message, count: i.count, lastAt: i.lastAt, where: (i.frames || [])[0] || null, status: i.status, diagnosis: i.diagnosis || null })) }));
});
app.post('/admin/self-repair/request', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json(Object.assign({ ok: true }, await selfRepair.request((req.body || {}).text, 'TJ (admin page)'))); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.post('/admin/self-repair/:id/:action', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try { res.json({ ok: true, message: await selfRepair.act(req.params.id, req.params.action, 'TJ (admin page)') }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});

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
// Self-repair on (website only): record failures and act on them.
incidents.onIncident(inc => selfRepair.onIncident(inc));
try { selfRepair.onBoot(); } catch (e) { console.warn('Self-repair start:', e.message); }
process.on('uncaughtException', err => { console.error('Crashed:', err && err.stack || err); try { incidents.record('crash', err); } catch (e) { /* exiting */ } setTimeout(() => process.exit(1), 300); });
// Failures inside a 500 answer that a route caught itself (no stack, but
// the message is enough for the known problems: key, credit, email...).
vision.onFailure = err => incidents.record('ai', err);
const sendMailOrig = mailer.sendMail;
mailer.sendMail = async o => { const r = await sendMailOrig(o); if (r && r.delivered === false && /EAUTH|Invalid login|535|not accepted/i.test(String(r.reason || ''))) incidents.record('email', new Error(String(r.reason))); return r; };
scheduler.start();
// The extras: each can be paused by self-repair if it keeps failing (the
// doors are watched either way), and every failure is recorded.
const extra = (name, fn) => () => { if (!selfRepair.featureOn(name)) return; Promise.resolve().then(fn).catch(e => { console.warn(`${name}:`, e.message); incidents.record(name, e); }); };
setInterval(extra('weekly', () => weeklyReviewTick(false)), 3600e3).unref();
setInterval(extra('backup', () => nightlyBackupTick()), 3600e3).unref();
setInterval(extra('self-test', () => selfTest.tick([...knownGymKeys().keys()])), 3600e3).unref();
// The morning summary is checked every 15 minutes so it lands close to its time.
setInterval(extra('morning', () => morning.tick([...knownGymKeys().keys()])), 15 * 60e3).unref();
setInterval(extra('nudge', () => nudge.tick([...knownGymKeys().keys()])), 15 * 60e3).unref();
// A camera computer that is already off when the website restarts must
// still trigger the "offline" alert.
try { const re = monitor.rearmFromDisk(); if (re.length) console.log(`Watching for check-ins from: ${re.join(', ')} (offline alert armed).`); } catch (e) { console.warn('Could not re-arm offline alerts:', e.message); }
// Last line of defence: one unexpected async failure must not take the
// whole website (every gym) down. Logged loudly instead.
process.on('unhandledRejection', err => { console.error('Unexpected error (kept running):', err && err.stack || err); incidents.record('rejection', err); });
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
