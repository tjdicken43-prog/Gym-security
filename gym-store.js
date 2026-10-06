// Customer-side (gym) data and access: who is signed in on this device,
// what the gym has marked on each flag, who the gym wants alerted, and
// links for sharing a single incident.
//
// Everything here is per gym, stored in DATA_DIR beside that gym's alert
// log, and keyed by the same filesystem-safe gym code — so one gym can
// never read or change another's reviews, alert list or photos.
//
// No dependencies beyond Node itself, and nothing in here requires
// monitor.js (monitor.js requires this), so there is no load cycle.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;

function safeCode(code) {
  return String(code || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';
}

// --- Signing secret -----------------------------------------------------
// Signs the "remember this device" cookie and share links. Taken from
// GYM_SESSION_SECRET if set; otherwise generated once and kept in DATA_DIR
// (a dotfile, which the static file server never serves), so nobody has
// to configure anything. If DATA_DIR is not writable it falls back to a
// per-process secret: devices then just have to enter the code again
// after a restart.
let secretCache = null;
function secret() {
  if (secretCache) return secretCache;
  if (process.env.GYM_SESSION_SECRET && process.env.GYM_SESSION_SECRET.length >= 16) {
    secretCache = Buffer.from(process.env.GYM_SESSION_SECRET);
    return secretCache;
  }
  const f = path.join(DATA_DIR, '.gym-session-secret');
  try {
    if (fs.existsSync(f)) {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (v.length >= 32) { secretCache = Buffer.from(v); return secretCache; }
    }
    const v = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(f, v, { mode: 0o600 });
    secretCache = Buffer.from(v);
  } catch (e) {
    secretCache = crypto.randomBytes(32);
  }
  return secretCache;
}

function b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function mac(purpose, data) {
  return b64u(crypto.createHmac('sha256', secret()).update(purpose + '|' + data).digest()).slice(0, 32);
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Signed, tamper-proof tokens: "<payload>.<mac>". The purpose string stops
// a share link being replayed as a sign-in cookie and vice versa.
function signToken(purpose, obj) {
  const p = b64u(JSON.stringify(obj));
  return `${p}.${mac(purpose, p)}`;
}
function readToken(purpose, tok) {
  const m = /^([A-Za-z0-9_-]{2,600})\.([A-Za-z0-9_-]{32})$/.exec(String(tok || ''));
  if (!m || !safeEqual(mac(purpose, m[1]), m[2])) return null;
  try {
    const obj = JSON.parse(unb64u(m[1]).toString('utf8'));
    if (!obj || typeof obj !== 'object') return null;
    if (obj.x && Date.now() > obj.x) return null;
    return obj;
  } catch (e) { return null; }
}

// --- Device sign-in cookie ---------------------------------------------
const COOKIE = 'sai_gym';
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k || out[k] !== undefined) return;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { /* ignore */ }
  });
  return out;
}

// The cookie holds the gym code plus a signature, not a random session id,
// so it keeps working across restarts without a session table. It is
// HttpOnly (page scripts can't read it) and is re-checked against the
// list of valid codes on every request, so removing a gym locks it out.
function sessionCookieValue(code) {
  return signToken('session', { c: safeCode(code) });
}
function codeFromRequest(req) {
  const v = parseCookies(req.headers && req.headers.cookie)[COOKIE];
  const t = v ? readToken('session', v) : null;
  return t && t.c ? safeCode(t.c) : null;
}
function isHttps(req) {
  const xf = String((req.headers && req.headers['x-forwarded-proto']) || '').split(',')[0].trim();
  return xf === 'https' || !!(req.socket && req.socket.encrypted);
}
function setSessionCookie(req, res, code) {
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(sessionCookieValue(code))}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
}
function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`);
}

// --- Rate limiting (in memory; resets on restart, which is fine) --------
const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter(t => now - t < windowMs);
  if (list.length >= max) { hits.set(key, list); return true; }
  list.push(now);
  hits.set(key, list);
  if (hits.size > 20000) {                      // keep memory bounded
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 24 * 3600e3) hits.delete(k);
  }
  return false;
}
function count(key, windowMs) {
  const now = Date.now();
  return (hits.get(key) || []).filter(t => now - t < windowMs).length;
}

// --- Event ids ----------------------------------------------------------
// New entries carry an id from monitor.js. Older ones get a stable id
// derived from what they already contain.
function eventId(e) {
  if (!e) return null;
  if (e.id) return String(e.id);
  const basis = `${e.timestamp || ''}|${e.frame || ''}|${e.zoneLabel || ''}`;
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 12);
}
function newEventId() { return crypto.randomBytes(6).toString('hex'); }

// --- Small JSON files ---------------------------------------------------
function readJson(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback; }
  catch (e) { return fallback; }
}
function writeJson(file, value) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.warn('Could not save ' + path.basename(file) + ':', e.message);
    return false;
  }
}

// --- Reviews: what the gym decided about each flag -----------------------
// 'tailgate' = confirmed someone got in without scanning
// 'fine'     = staff / a member / nothing wrong
// Kept 40 days so the monthly report (35-day store) can use them.
const VERDICTS = { tailgate: 'Tailgate', fine: 'It was fine' };
const REVIEW_KEEP_MS = 40 * 24 * 3600e3;
function reviewsFile(code) { return path.join(DATA_DIR, `gym-reviews-${safeCode(code)}.json`); }
function loadReviews(code) {
  const raw = readJson(reviewsFile(code), {});
  const out = {};
  const cutoff = Date.now() - REVIEW_KEEP_MS;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (v && VERDICTS[v.verdict] && Date.parse(v.at) >= cutoff) out[k] = v;
    }
  }
  return out;
}
// Optional short note ("that was Mike from the 6am class"). Plain text,
// one line, 120 characters at most. undefined = keep the existing note.
const REVIEW_NOTE_MAX = 120;
function cleanNote(v) {
  if (v == null) return null;
  const t = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > REVIEW_NOTE_MAX) throw new Error(`Keep the note to ${REVIEW_NOTE_MAX} characters or fewer.`);
  return t || null;
}
function setReview(code, id, verdict, note) {
  const id_ = String(id || '').replace(/[^a-f0-9]/gi, '').slice(0, 24);
  if (!id_) throw new Error('Unknown event.');
  const all = loadReviews(code);
  const prev = all[id_];
  if (verdict == null || verdict === '') delete all[id_];
  else if (VERDICTS[verdict]) {
    const n = note === undefined ? (prev && prev.note) || null : cleanNote(note);
    all[id_] = Object.assign({ verdict, at: new Date().toISOString() }, n ? { note: n } : {});
  }
  else throw new Error('Unknown choice.');
  if (!writeJson(reviewsFile(code), all)) throw new Error('Could not save that just now — please try again.');
  return all[id_] || null;
}

// --- Alert subscribers --------------------------------------------------
const MAX_SUBSCRIBERS = 10;
function alertsFile(code) { return path.join(DATA_DIR, `gym-alerts-${safeCode(code)}.json`); }
function loadSubscribers(code) {
  const raw = readJson(alertsFile(code), []);
  return Array.isArray(raw) ? raw.filter(s => s && s.id && s.to && (s.kind === 'email' || s.kind === 'sms')) : [];
}
function saveSubscribers(code, list) { return writeJson(alertsFile(code), list); }

function normalizeEmail(v) {
  const s = String(v || '').trim().toLowerCase();
  return (s.length <= 200 && /^[^\s@<>()"',;]+@[^\s@<>()"',;]+\.[a-z]{2,}$/.test(s)) ? s : null;
}
// US numbers typed any way ("479-555-0123", "(479) 555 0123") become
// +14795550123. Anything already in +<country> form is kept.
function normalizePhone(v) {
  const s = String(v || '').trim();
  if (!s || s.length > 30) return null;
  const digits = s.replace(/\D/g, '');
  if (s.startsWith('+')) return (digits.length >= 8 && digits.length <= 15) ? '+' + digits : null;
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}
function addSubscriber(code, raw) {
  const email = normalizeEmail(raw);
  const phone = email ? null : normalizePhone(raw);
  if (!email && !phone) throw new Error('That doesn\'t look like an email address or a mobile number.');
  const list = loadSubscribers(code);
  const to = email || phone;
  const existing = list.find(s => s.to === to);
  if (existing) return { sub: existing, added: false };
  if (list.length >= MAX_SUBSCRIBERS) throw new Error(`You can have up to ${MAX_SUBSCRIBERS} people on the alert list. Remove someone first.`);
  const sub = { id: crypto.randomBytes(5).toString('hex'), kind: email ? 'email' : 'sms', to, addedAt: new Date().toISOString() };
  list.push(sub);
  if (!saveSubscribers(code, list)) throw new Error('Could not save that just now — please try again.');
  return { sub, added: true };
}
function removeSubscriber(code, id) {
  const list = loadSubscribers(code);
  const next = list.filter(s => s.id !== String(id));
  if (next.length !== list.length) saveSubscribers(code, next);
  return next.length !== list.length;
}
// Unsubscribe links in every alert work without the gym code, so a
// person added by mistake (or by someone else) can always get off the list.
function unsubscribeToken(code, sub) { return signToken('unsub', { c: safeCode(code), s: sub.id }); }
function readUnsubscribeToken(t) { return readToken('unsub', t); }

// --- Share links for one incident --------------------------------------
// At most 7 days, and never longer than the photos themselves are kept:
// ttlMs lets the caller cut it to when the event will be deleted.
const SHARE_TTL_MS = 7 * 24 * 3600e3;
function shareToken(code, id, ttlMs) {
  const ttl = (Number.isFinite(ttlMs) && ttlMs > 0) ? Math.min(ttlMs, SHARE_TTL_MS) : SHARE_TTL_MS;
  return signToken('share', { c: safeCode(code), e: String(id), x: Date.now() + ttl });
}
function readShareToken(t) { return readToken('share', t); }

// --- Per-gym server-side settings, pairing generation, delivery status ---
// One small file per gym key: gym-settings-<key>.json
//   { settings: {...}, runnerGen: 0, delivery: { lastFailure, lastOkAt } }
// Settings are what the operator sets on the admin page; they win over
// what the camera computer's rtsp-zones.json says.
const metaCache = new Map();
function metaFile(key) { return path.join(DATA_DIR, `gym-settings-${safeCode(key)}.json`); }
function loadMeta(key) {
  const k = safeCode(key);
  if (metaCache.has(k)) return metaCache.get(k);
  const raw = readJson(metaFile(k), {});
  const m = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  if (!m.settings || typeof m.settings !== 'object') m.settings = {};
  metaCache.set(k, m);
  return m;
}
function saveMeta(key, m) {
  const k = safeCode(key);
  metaCache.set(k, m);
  return writeJson(metaFile(k), m);
}

const SETTINGS_MAX_EMAILS = 5;
const SETTINGS_MAX_PHONES = 3;
const CLOCK_NOTE_MAX = 120;
function hhmm(v) {
  return (typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim())) ? v.trim().padStart(5, '0') : null;
}
function listOf(v) {
  if (v == null || v === '') return [];
  if (Array.isArray(v)) return v;
  return String(v).split(/[,;\s]+/).filter(Boolean);
}
function validZone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return null; }
}
// Validates a PATCH-style update. Only keys present in `input` change;
// null or '' clears a setting (the camera computer's value is used again).
// opts: { models: {id:true}, maxCap: n }. Throws with a plain message.
function normalizeSettings(input, current, opts) {
  const o = opts || {};
  const out = Object.assign({}, current || {});
  const has = k => Object.prototype.hasOwnProperty.call(input, k);
  const clear = v => v === null || v === '';
  if (has('watchHours') && String(input.watchHours).toLowerCase() === 'always') {
    out.scheduleStart = '00:00'; out.scheduleEnd = '00:00';
  } else if (has('scheduleStart') || has('scheduleEnd')) {
    const s = input.scheduleStart, e = input.scheduleEnd;
    if (clear(s) && clear(e)) { delete out.scheduleStart; delete out.scheduleEnd; }
    else {
      const a = hhmm(s), b = hhmm(e);
      if (!a || !b) throw new Error('Watch hours need a start and an end, like 21:00 and 05:00 (24-hour clock). Use 00:00 to 00:00 for all day.');
      out.scheduleStart = a; out.scheduleEnd = b;
    }
  }
  if (has('timeZone')) {
    if (clear(input.timeZone)) delete out.timeZone;
    else { const z = validZone(String(input.timeZone).trim()); if (!z) throw new Error('Time zone must look like America/Chicago.'); out.timeZone = z; }
  }
  if (has('alertEmails')) {
    const list = [];
    for (const raw of listOf(input.alertEmails)) {
      const e = normalizeEmail(raw);
      if (!e) throw new Error(`"${String(raw).slice(0, 60)}" doesn't look like an email address.`);
      if (!list.includes(e)) list.push(e);
    }
    if (list.length > SETTINGS_MAX_EMAILS) throw new Error(`Up to ${SETTINGS_MAX_EMAILS} alert emails.`);
    if (list.length) out.alertEmails = list; else delete out.alertEmails;
  }
  if (has('alertPhones')) {
    const list = [];
    for (const raw of listOf(Array.isArray(input.alertPhones) ? input.alertPhones : String(input.alertPhones || '').split(/[,;]+/))) {
      if (!String(raw).trim()) continue;
      const p = normalizePhone(raw);
      if (!p) throw new Error(`"${String(raw).slice(0, 40)}" doesn't look like a mobile number.`);
      if (!list.includes(p)) list.push(p);
    }
    if (list.length > SETTINGS_MAX_PHONES) throw new Error(`Up to ${SETTINGS_MAX_PHONES} alert phone numbers.`);
    if (list.length) out.alertPhones = list; else delete out.alertPhones;
  }
  if (has('model')) {
    if (clear(input.model)) delete out.model;
    else if (o.models && o.models[input.model]) out.model = input.model;
    else throw new Error(`Model must be one of: ${Object.keys(o.models || {}).join(', ')}.`);
  }
  if (has('dailyBurstCap')) {
    if (clear(input.dailyBurstCap)) delete out.dailyBurstCap;
    else {
      const n = parseInt(input.dailyBurstCap, 10);
      if (!Number.isFinite(n) || n < 1) throw new Error('Daily limit must be a whole number, 1 or more.');
      if (o.maxCap && n > o.maxCap) throw new Error(`Daily limit can be at most ${o.maxCap} on this website (MAX_DAILY_BURST_CAP).`);
      out.dailyBurstCap = n;
    }
  }
  if (has('cameraClockNote')) {
    if (clear(input.cameraClockNote)) delete out.cameraClockNote;
    else {
      const t = String(input.cameraClockNote).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (t.length > CLOCK_NOTE_MAX) throw new Error(`Keep the camera clock note to ${CLOCK_NOTE_MAX} characters or fewer.`);
      if (t) out.cameraClockNote = t; else delete out.cameraClockNote;
    }
  }
  return out;
}
function getSettings(key) { return Object.assign({}, loadMeta(key).settings); }
function saveSettings(key, settings) {
  const m = loadMeta(key);
  m.settings = settings;
  if (!saveMeta(key, m)) throw new Error('Could not save the settings just now — is the disk writable?');
  return getSettings(key);
}

// Pairing generation. Tokens handed out before any unpair are generation
// 0 and keep working until the operator presses Unpair for that gym.
function runnerGen(key) { const n = Number(loadMeta(key).runnerGen); return Number.isInteger(n) && n > 0 ? n : 0; }
function bumpRunnerGen(key) {
  const m = loadMeta(key);
  m.runnerGen = runnerGen(key) + 1;
  if (!saveMeta(key, m)) throw new Error('Could not save — is the disk writable?');
  return m.runnerGen;
}

// "Stopped from the website" must survive a restart or redeploy: otherwise
// the camera computer's next check-in quietly switches it back on.
function isPaused(key) { return loadMeta(key).paused === true; }
function setPaused(key, on) {
  const m = loadMeta(key);
  if (!!m.paused === !!on) return true;
  if (on) m.paused = true; else delete m.paused;
  return saveMeta(key, m);
}

// The last camera-computer check-in, kept on disk (at most every few
// minutes) so the "camera computer offline" alert still fires if the
// website restarts while the computer is already off.
const RUNNER_SEEN_WRITE_MS = 5 * 60 * 1000;
function noteRunnerSeen(key, info) {
  const m = loadMeta(key);
  const now = Date.now();
  const prev = m.runnerSeen || {};
  if (prev.at && now - prev.at < RUNNER_SEEN_WRITE_MS && prev.host === (info && info.host || null)) return;
  m.runnerSeen = { at: now, host: (info && info.host) || null, config: (info && info.config) || prev.config || null };
  saveMeta(key, m);
}
function runnerSeen(key) { return loadMeta(key).runnerSeen || null; }
function markOfflineAlerted(key, at) {
  const m = loadMeta(key);
  if (!m.runnerSeen) return;
  m.runnerSeen.offlineAlertedFor = at;
  saveMeta(key, m);
}
function knownMetaKeys() {
  try { return fs.readdirSync(DATA_DIR).map(f => /^gym-settings-([a-z0-9_-]+)\.json$/.exec(f)).filter(Boolean).map(x => x[1]); }
  catch (e) { return []; }
}

// Last alert delivery outcome per gym, so a failure that only the gym saw
// ("the test didn't go out") is visible to the operator too.
function recordDelivery(key, ok, info) {
  const m = loadMeta(key);
  const d = Object.assign({}, m.delivery || {});
  const now = new Date().toISOString();
  if (ok) {
    // Only write when it changes something, to spare the disk.
    if (d.lastOkAt && Date.now() - Date.parse(d.lastOkAt) < 60e3) return;
    d.lastOkAt = now;
  } else {
    d.lastFailure = Object.assign({ at: now }, info || {});
  }
  m.delivery = d;
  saveMeta(key, m);
}
function deliveryStatus(key) {
  const d = loadMeta(key).delivery || {};
  return { lastFailure: d.lastFailure || null, lastOkAt: d.lastOkAt || null };
}

// --- Per-night counters -------------------------------------------------
// A clean month still has something to show: how many nights were watched
// and how many crossings were checked. { "2026-09-20": { w:1, c:12, f:1 } }
// keyed by the gym-local date the watch window STARTED on.
const NIGHTS_KEEP_DAYS = 75;
const nightsCache = new Map();
const nightsTimers = new Map();
function nightsFile(key) { return path.join(DATA_DIR, `gym-nights-${safeCode(key)}.json`); }
function loadNights(key) {
  const k = safeCode(key);
  if (nightsCache.has(k)) return nightsCache.get(k);
  const raw = readJson(nightsFile(k), {});
  const n = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  nightsCache.set(k, n);
  return n;
}
function saveNightsSoon(key) {
  const k = safeCode(key);
  if (nightsTimers.has(k)) return;
  const t = setTimeout(() => {
    nightsTimers.delete(k);
    const n = loadNights(k);
    const cutoff = new Date(Date.now() - NIGHTS_KEEP_DAYS * 864e5).toISOString().slice(0, 10);
    for (const d of Object.keys(n)) if (d < cutoff) delete n[d];
    writeJson(nightsFile(k), n);
  }, 1500);
  if (t.unref) t.unref();
  nightsTimers.set(k, t);
}
function noteNight(key, day, what) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return;
  const n = loadNights(key);
  const rec = n[day] || (n[day] = { w: 0, c: 0, f: 0 });
  if (what === 'watched') { if (rec.w) return; rec.w = 1; }
  else if (what === 'checked') { rec.w = 1; rec.c = (rec.c || 0) + 1; }
  else if (what === 'flagged') { rec.f = (rec.f || 0) + 1; }
  saveNightsSoon(key);
}
function flushNights() {
  for (const [k, t] of nightsTimers) { clearTimeout(t); nightsTimers.delete(k); writeJson(nightsFile(k), loadNights(k)); }
}

// --- Formatting in the gym's own time zone ------------------------------
function fmtLocal(iso, timeZone, opts) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const o = Object.assign({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, opts || {});
  try { return d.toLocaleString('en-US', Object.assign({ timeZone }, o)); }
  catch (e) { return d.toLocaleString('en-US', Object.assign({ timeZone: 'UTC', timeZoneName: 'short' }, o)); }
}

module.exports = {
  safeCode, signToken, readToken,
  COOKIE, parseCookies, codeFromRequest, setSessionCookie, clearSessionCookie,
  limited, count,
  eventId, newEventId,
  VERDICTS, loadReviews, setReview, REVIEW_NOTE_MAX,
  normalizeSettings, getSettings, saveSettings, runnerGen, bumpRunnerGen,
  isPaused, setPaused, noteRunnerSeen, runnerSeen, markOfflineAlerted, knownMetaKeys,
  recordDelivery, deliveryStatus, loadNights, noteNight, flushNights,
  MAX_SUBSCRIBERS, loadSubscribers, addSubscriber, removeSubscriber, normalizeEmail, normalizePhone,
  unsubscribeToken, readUnsubscribeToken,
  shareToken, readShareToken, SHARE_TTL_MS,
  fmtLocal,
};
