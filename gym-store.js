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
// 'shared'   = confirmed someone scanned in on another member's code
// 'fine'     = staff / a member / nothing wrong
// Kept 40 days so the monthly report (35-day store) can use them; the
// results tally below keeps the outcome (no photos) for good.
const VERDICTS = { tailgate: 'Tailgate', shared: 'Shared code', fine: 'It was fine' };
const isConfirmed = v => v === 'tailgate' || v === 'shared';
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
// Who answered (a first name typed once on that phone). Plain text, 30 chars.
function cleanBy(v) {
  if (v == null) return null;
  const t = String(v).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 30);
  return t || null;
}
function setReview(code, id, verdict, note, by, opts) {
  const id_ = String(id || '').replace(/[^a-f0-9]/gi, '').slice(0, 24);
  if (!id_) throw new Error('Unknown event.');
  const o = opts || {};
  const all = loadReviews(code);
  const prev = all[id_];
  if (verdict == null || verdict === '') delete all[id_];
  else if (VERDICTS[verdict]) {
    const n = note === undefined ? (prev && prev.note) || null : cleanNote(note);
    // What happened next stays with a confirmed entry (Tailgate <-> Shared
    // code), and goes when it's changed to "It was fine".
    const follow = prev && prev.follow && isConfirmed(verdict) ? { follow: prev.follow } : {};
    const who = cleanBy(by);
    // "It was fine" when the camera AND the front-desk scans both showed an
    // extra person: kept for the owner's second look (unless the owner said it).
    const override = verdict === 'fine' && o.strong ? { override: true, ...(o.ownerSaid ? { ownerChecked: { by: who || 'owner', at: new Date().toISOString() } } : {}) } : {};
    all[id_] = Object.assign({ verdict, at: new Date().toISOString() }, n ? { note: n } : {}, who ? { by: who } : {}, follow, override);
  }
  else throw new Error('Unknown choice.');
  if (!writeJson(reviewsFile(code), all)) throw new Error('Could not save that just now — please try again.');
  noteAnswer(code, { id: id_, verdict: all[id_] ? all[id_].verdict : null, by: cleanBy(by), strong: !!o.strong });
  return all[id_] || null;
}
// Every answer and change, in order (who, what, when): nothing is changed
// silently. Kept 35 days.
function answersFile(code) { return path.join(DATA_DIR, `gym-answers-${safeCode(code)}.json`); }
function loadAnswers(code) {
  const a = readJson(answersFile(code), []);
  const cut = Date.now() - 35 * 864e5;
  return Array.isArray(a) ? a.filter(x => x && Date.parse(x.at) > cut) : [];
}
function noteAnswer(code, rec) {
  try {
    const list = loadAnswers(code);
    list.push({ id: rec.id, verdict: rec.verdict || null, by: rec.by || null, strong: rec.strong || undefined, at: new Date().toISOString() });
    writeJson(answersFile(code), list.slice(-5000));
  } catch (e) { /* history is a nicety; the answer itself is saved */ }
}
// The owner looked at an override and agrees it was fine.
function ownerAgrees(code, id, by) {
  const id_ = String(id || '').replace(/[^a-f0-9]/gi, '').slice(0, 24);
  const all = loadReviews(code);
  const r = all[id_];
  if (!r || r.verdict !== 'fine' || !r.override) throw new Error('That answer is no longer waiting for a second look.');
  r.ownerChecked = { by: cleanBy(by) || 'owner', at: new Date().toISOString() };
  if (!writeJson(reviewsFile(code), all)) throw new Error('Could not save that just now — please try again.');
  noteAnswer(code, { id: id_, verdict: 'fine (owner agreed)', by: cleanBy(by) });
  try { const t = loadTally(code); if (t.outcomes[id_]) { delete t.outcomes[id_].override; t.outcomes[id_].ownerAgreed = true; saveTallySoon(code); } } catch (e) { /* tally is a nicety */ }
  return r;
}

// What happened after a confirmed tailgate: the outcome the owner sees as
// "$ recovered". usd only for 'charged'.
const FOLLOWS = { talked: 'Talked to them', charged: 'Charged', warned: 'Warning given', noreach: 'Couldn’t reach them', disputed: 'They disputed it' };
function setFollow(code, id, what, usd) {
  const id_ = String(id || '').replace(/[^a-f0-9]/gi, '').slice(0, 24);
  const all = loadReviews(code);
  const r = all[id_];
  if (!r || !isConfirmed(r.verdict)) throw new Error('Mark it Tailgate or Shared code first.');
  if (what == null || what === '') delete r.follow;
  else {
    if (!FOLLOWS[what]) throw new Error('Unknown choice.');
    let amount = null;
    if (what === 'charged') {
      amount = Math.round(Number(String(usd == null ? '' : usd).replace(/[$,\s]/g, '')) * 100) / 100;
      if (!Number.isFinite(amount) || amount <= 0 || amount > 10000) throw new Error('Enter the amount charged, like 10 or 49.99.');
    }
    r.follow = Object.assign({ what, at: new Date().toISOString() }, amount != null ? { usd: amount } : {});
  }
  if (!writeJson(reviewsFile(code), all)) throw new Error('Could not save that just now — please try again.');
  return r.follow || null;
}

// --- Alert subscribers --------------------------------------------------
const MAX_SUBSCRIBERS = 10;
function alertsFile(code) { return path.join(DATA_DIR, `gym-alerts-${safeCode(code)}.json`); }
function loadSubscribers(code) {
  const raw = readJson(alertsFile(code), []);
  return Array.isArray(raw) ? raw.filter(s => s && s.id && s.to && (s.kind === 'email' || s.kind === 'sms' || (s.kind === 'chat' && normalizeChatHook(s.to)))) : [];
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
// Team chat channels (incoming webhooks). Only these services' own
// webhook addresses are accepted, over https on the normal port, so an
// alert can never be pointed at the server's own network or anywhere else.
const CHAT_HOOKS = [
  { host: /^hooks\.slack\.com$/i, path: /^\/(services|triggers|workflows)\/[A-Za-z0-9/_-]+$/, service: 'Slack' },
  { host: /^chat\.googleapis\.com$/i, path: /^\/v1\/spaces\/[A-Za-z0-9_-]+\/messages$/, service: 'Google Chat' },
  { host: /^[a-z0-9-]+\.webhook\.office\.com$/i, path: /^\/webhookb2\//, service: 'Teams' },
  { host: /^[a-z0-9-]+\.[a-z0-9-]+\.logic\.azure\.com$/i, path: /^\/workflows\/[A-Za-z0-9]+\/triggers\//, service: 'Teams' },
  { host: /^(discord|discordapp)\.com$/i, path: /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/, service: 'Discord' },
];
function normalizeChatHook(v) {
  const s = String(v == null ? '' : v).trim();
  if (!/^https:\/\//i.test(s) || s.length > 700) return null;
  let u; try { u = new URL(s); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || u.hash) return null;
  const h = CHAT_HOOKS.find(x => x.host.test(u.hostname) && x.path.test(u.pathname));
  return h ? { url: u.href, service: h.service } : null;
}
function addSubscriber(code, raw) {
  const hook = normalizeChatHook(raw);
  if (!hook && /^\s*https?:/i.test(String(raw || ''))) throw new Error('That link isn\'t a Slack, Teams, Google Chat or Discord webhook address.');
  if (hook) {
    const list = loadSubscribers(code);
    const existing = list.find(x => x.to === hook.url);
    if (existing) return { sub: existing, added: false };
    if (list.length >= MAX_SUBSCRIBERS) throw new Error(`You can have up to ${MAX_SUBSCRIBERS} on the alert list. Remove one first.`);
    const sub = { id: crypto.randomBytes(5).toString('hex'), kind: 'chat', service: hook.service, to: hook.url, addedAt: new Date().toISOString() };
    list.push(sub);
    if (!saveSubscribers(code, list)) throw new Error('Could not save that just now — please try again.');
    return { sub, added: true };
  }
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
  // Times staff or expected visitors come in ("05:00-06:00 Cleaners"), so
  // flags then show "probably staff" (a hint only: nothing is hidden).
  if (has('staffTimes')) {
    const lines = (Array.isArray(input.staffTimes) ? input.staffTimes : String(input.staffTimes || '').split(/\n|;/)).map(x => String(x).trim()).filter(Boolean);
    const list = [];
    for (const l of lines.slice(0, 12)) {
      const m = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s*(.*)$/.exec(l);
      if (!m || +m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59) throw new Error(`"${l.slice(0, 40)}" should look like 05:00-06:00 Cleaners (24-hour clock).`);
      list.push({ from: `${m[1].padStart(2, '0')}:${m[2]}`, to: `${m[3].padStart(2, '0')}:${m[4]}`, label: String(m[5] || 'Staff').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 40) || 'Staff' });
    }
    if (list.length) out.staffTimes = list; else delete out.staffTimes;
  }
  // Night mode: unstaffed hours when alerts are stricter (less certain
  // flags alert too). Adds alerts only; never makes detection looser.
  if (has('nightHours')) {
    const v = String(input.nightHours || '').trim();
    if (!v) delete out.nightHours;
    else {
      const m = /^(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})$/.exec(v);
      if (!m || +m[1] > 23 || +m[3] > 23 || +m[2] > 59 || +m[4] > 59 || v.replace(/\s/g, '').split(/[-–]/)[0] === v.replace(/\s/g, '').split(/[-–]/)[1]) throw new Error('Night hours should look like 22:00-05:00 (24-hour clock).');
      out.nightHours = { from: `${m[1].padStart(2, '0')}:${m[2]}`, to: `${m[3].padStart(2, '0')}:${m[4]}` };
    }
  }
  // Event mode: no alerts until this time (entries still recorded).
  // Shorter keep times only (privacy): photos 24 or 48 h, kept entries 14 or 35 days.
  if (has('photoHours')) { const h = Number(input.photoHours); if (![24, 48].includes(h)) throw new Error('Photos can be kept 24 or 48 hours.'); if (h === 48) delete out.photoHours; else out.photoHours = h; }
  if (has('keptDays')) { const d = Number(input.keptDays); if (![14, 35].includes(d)) throw new Error('Kept entries can stay 14 or 35 days.'); if (d === 35) delete out.keptDays; else out.keptDays = d; }
  if (has('eventUntil')) {
    if (clear(input.eventUntil)) delete out.eventUntil;
    else { const t = Date.parse(input.eventUntil); if (isNaN(t) || t < Date.now() || t > Date.now() + 24 * 3600e3) throw new Error('An event can last up to 24 hours.'); out.eventUntil = new Date(t).toISOString(); }
  }
  // What one sneak-in costs the gym (a day pass or a month's dues), so the
  // results can say what was caught in dollars. Whole dollars, 0-500.
  if (has('sneakInUsd')) {
    if (clear(input.sneakInUsd)) delete out.sneakInUsd;
    else {
      const n = Math.round(Number(String(input.sneakInUsd).replace(/[$,\s]/g, '')));
      if (!Number.isFinite(n) || n < 0 || n > 500) throw new Error('The sneak-in price must be a whole number of dollars, 0 to 500.');
      out.sneakInUsd = n;
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
  // The gym's check-in software and the zone its front entrance logs as
  // (e.g. "Ashbourne", "Zone 1"), so the page can say exactly where to look.
  for (const [k, max] of [['checkinSystem', 40], ['checkinZone', 30]]) {
    if (!has(k)) continue;
    const t = clear(input[k]) ? '' : String(input[k]).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length > max) throw new Error(`Keep that to ${max} characters or fewer.`);
    if (t) out[k] = t; else delete out[k];
  }
  // How far the check-in system's clock is off real time, in seconds
  // (+ = its times are ahead). Found with two test scans (AT-THE-GYM.md).
  if (has('checkinClockOffsetSec')) {
    if (clear(input.checkinClockOffsetSec)) delete out.checkinClockOffsetSec;
    else {
      const n = Math.round(Number(input.checkinClockOffsetSec));
      if (!Number.isFinite(n) || Math.abs(n) > 3600) throw new Error('Check-in clock correction must be a number of seconds between -3600 and 3600.');
      if (n) out.checkinClockOffsetSec = n; else delete out.checkinClockOffsetSec;
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
// The front-desk scan reader's own generation (Unpair it without touching
// the camera computer, and the other way round).
function readerGen(key) { const n = Number(loadMeta(key).readerGen); return Number.isInteger(n) && n > 0 ? n : 0; }
function bumpReaderGen(key) {
  const m = loadMeta(key);
  m.readerGen = readerGen(key) + 1;
  if (!saveMeta(key, m)) throw new Error('Could not save — is the disk writable?');
  return m.readerGen;
}
function runnerGen(key) { const n = Number(loadMeta(key).runnerGen); return Number.isInteger(n) && n > 0 ? n : 0; }
function bumpRunnerGen(key) {
  const m = loadMeta(key);
  m.runnerGen = runnerGen(key) + 1;
  if (!saveMeta(key, m)) throw new Error('Could not save — is the disk writable?');
  return m.runnerGen;
}

// "Stopped from the website" must survive a restart or redeploy: otherwise
// the camera computer's next check-in quietly switches it back on.
// Small "already done today" markers (e.g. the morning summary's day).
function getMarker(key, name) { const m = loadMeta(key); return (m.markers && m.markers[name]) || null; }
function setMarker(key, name, value) { const m = loadMeta(key); m.markers = Object.assign({}, m.markers, { [name]: value }); return saveMeta(key, m); }
// One alert-list person's choices: tailgate alerts, camera problems,
// morning summary (emails only). Default on; off is stored as false.
const SUB_CHOICES = ['tailgates', 'camera', 'morning'];
function setSubscriberChoice(code, id, what, on) {
  if (!SUB_CHOICES.includes(what)) throw new Error('Unknown choice.');
  const list = loadSubscribers(code);
  const sub = list.find(s => s.id === String(id));
  if (!sub) throw new Error('That address is no longer on the list.');
  if (what === 'morning' && sub.kind !== 'email') throw new Error('Morning summaries go by email only.');
  if (!on && SUB_CHOICES.filter(c => c !== what && (c !== 'morning' || sub.kind === 'email')).every(c => sub[c] === false)) throw new Error('Keep at least one on, or remove the address instead.');
  if (on) delete sub[what]; else sub[what] = false;
  if (!saveSubscribers(code, list)) throw new Error('Could not save that just now — please try again.');
  return sub;
}
function setSubscriberMorning(code, id, on) {
  const list = loadSubscribers(code);
  const sub = list.find(s => s.id === String(id));
  if (!sub) throw new Error('That address is no longer on the list.');
  if (sub.kind !== 'email') throw new Error('Morning summaries go by email only.');
  if (on) delete sub.morning; else sub.morning = false;
  if (!saveSubscribers(code, list)) throw new Error('Could not save that just now — please try again.');
  return sub;
}
// Weekly spot-check: a few normal entries a person glances at, so misses
// (someone the camera called normal who did get in without paying) can be
// counted. { week, ids:[...], answers:{id:'right'|'missed'} } in the meta.
function getSpot(key) { return loadMeta(key).spot || null; }
function setSpot(key, spot) { const m = loadMeta(key); m.spot = spot; return saveMeta(key, m); }
function tallySpot(key, answer, undo) {
  const t = loadTally(key);
  t.spotChecked = Math.max(0, (Number(t.spotChecked) || 0) + (undo ? -1 : 1));
  if (answer === 'missed') t.spotMissed = Math.max(0, (Number(t.spotMissed) || 0) + (undo ? -1 : 1));
  saveTallySoon(key);
}
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
function noteNight(key, day, what, hour) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) return;
  const n = loadNights(key);
  const rec = n[day] || (n[day] = { w: 0, c: 0, f: 0 });
  // Entries and flags by hour of the day (gym time), for the busiest-hours chart.
  if (Number.isInteger(hour) && hour >= 0 && hour < 24 && (what === 'checked' || what === 'flagged')) {
    const f = what === 'checked' ? 'h' : 'hf';
    if (!Array.isArray(rec[f]) || rec[f].length !== 24) rec[f] = new Array(24).fill(0);
    rec[f][hour] += 1;
  }
  if (what === 'watched') { if (rec.w) return; rec.w = 1; }
  else if (what === 'checked') { rec.w = 1; rec.c = (rec.c || 0) + 1; }
  else if (what === 'flagged') { rec.f = (rec.f || 0) + 1; }
  saveNightsSoon(key);
  // The never-expiring results tally (for showing what the camera found).
  const t = loadTally(key);
  if (what === 'watched' || what === 'checked') { if (!t.nights.includes(day)) t.nights.push(day); }
  if (what === 'checked') t.checked += 1;
  if (what === 'flagged') t.flagged += 1;
  saveTallySoon(key);
}
function flushNights() {
  for (const [k, t] of nightsTimers) { clearTimeout(t); nightsTimers.delete(k); writeJson(nightsFile(k), loadNights(k)); }
  for (const [k, t] of tallyTimers) { clearTimeout(t); tallyTimers.delete(k); writeJson(tallyFile(k), loadTally(k)); }
}

// Clear-exit record (see monitor.js): how often the AI agreed that a
// crossing the camera computer saw as someone leaving was someone leaving.
// A disagreement resets the clean run.
function noteExit(key, what, audited) {
  const st = getSettings(key);
  const x = st.exitShadow || { agree: 0, disagree: 0, skipped: 0, audited: 0 };
  if (what === 'agree') x.agree = (x.agree || 0) + 1;
  else if (what === 'disagree') { x.disagree = (x.disagree || 0) + 1; x.agree = 0; x.lastDisagreeAt = new Date().toISOString(); }
  else if (what === 'skipped') x.skipped = (x.skipped || 0) + 1;
  if (audited) x.audited = (x.audited || 0) + 1;
  st.exitShadow = x;
  saveSettings(key, st);
}

// --- Start fresh (before a pilot) --------------------------------------
// Test walk-throughs shouldn't count toward a gym's real results. This
// keeps a copy of the numbers (no photos) in DATA_DIR/archive-<gym>-<time>/
// and starts the results, staff answers, nightly counts, answer history,
// camera problems and this week's spot-check again from zero.
function startFresh(key) {
  const k = safeCode(key);
  // Pending delayed writes would put the old numbers back.
  for (const m of [nightsTimers, tallyTimers]) { const t = m.get(k); if (t) { clearTimeout(t); m.delete(k); } }
  const files = [tallyFile(k), reviewsFile(k), nightsFile(k), answersFile(k), problemsFile(k)];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(DATA_DIR, `archive-${k}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let kept = 0;
  for (const f of files) { try { if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(dir, path.basename(f))); kept++; } } catch (e) { /* copy what we can */ } }
  const before = tallySummary(k);
  writeJson(tallyFile(k), { since: null, nights: [], checked: 0, flagged: 0, outcomes: {}, freshStart: new Date().toISOString() });
  writeJson(reviewsFile(k), {});
  writeJson(nightsFile(k), {});
  writeJson(answersFile(k), []);
  writeJson(problemsFile(k), []);
  tallyCache.delete(k); nightsCache.delete(k);
  const m = loadMeta(k); delete m.spot; saveMeta(k, m);
  return { archived: kept, folder: path.basename(dir), cleared: { reviewed: before.reviewed, confirmed: (before.confirmedTailgates || 0) + (before.confirmedShared || 0), nights: before.nightsWatched } };
}

// A gym that cancelled: its numbers are archived (no photos, no names),
// then everything personal is deleted: staff logins, the alert list, phone
// notifications, approved devices, scrambled member numbers, who read them,
// answers and notes, the logo. Photos and entries go in monitor.clearEntries.
function closeData(key) {
  const k = safeCode(key);
  const r = startFresh(k);
  let deleted = 0;
  for (const n of ['alerts', 'people', 'push', 'devices', 'scans', 'access', 'reviews', 'answers', 'problems', 'nights']) {
    try { fs.unlinkSync(path.join(DATA_DIR, `gym-${n}-${k}.json`)); deleted++; } catch (e) { /* not there */ }
  }
  for (const ext of ['png', 'jpg']) try { fs.unlinkSync(path.join(DATA_DIR, 'logos', `${k}.${ext}`)); deleted++; } catch (e) { /* none */ }
  try { fs.rmSync(path.join(DATA_DIR, `selftest-${k}`), { recursive: true, force: true }); } catch (e) { /* none */ }
  const m = loadMeta(k); m.paused = true; delete m.spot; saveMeta(k, m);
  return Object.assign(r, { deleted });
}

// --- Results tally (kept for good) -------------------------------------
// Running totals since the camera started, and what the gym decided about
// each checked entry — times, counts and the camera's words, never photos.
// { since, nights:[dates], checked, flagged, outcomes: { id: {...} } }
const TALLY_MAX_OUTCOMES = 2000;
const tallyCache = new Map();
const tallyTimers = new Map();
function tallyFile(key) { return path.join(DATA_DIR, `gym-tally-${safeCode(key)}.json`); }
function loadTally(key) {
  const k = safeCode(key);
  if (tallyCache.has(k)) return tallyCache.get(k);
  let t = readJson(tallyFile(k), null);
  if (!t || typeof t !== 'object' || Array.isArray(t)) {
    // First time: start from the nightly counters already on disk.
    const n = loadNights(k);
    const days = Object.keys(n).filter(d => n[d] && n[d].w).sort();
    t = { since: days[0] || null, nights: days, checked: days.reduce((a, d) => a + (n[d].c || 0), 0), flagged: days.reduce((a, d) => a + (n[d].f || 0), 0), outcomes: {} };
  }
  if (!Array.isArray(t.nights)) t.nights = [];
  if (!t.outcomes || typeof t.outcomes !== 'object') t.outcomes = {};
  t.checked = Number(t.checked) || 0; t.flagged = Number(t.flagged) || 0;
  tallyCache.set(k, t);
  return t;
}
function saveTallySoon(key) {
  const k = safeCode(key);
  if (tallyTimers.has(k)) return;
  const tm = setTimeout(() => { tallyTimers.delete(k); writeJson(tallyFile(k), loadTally(k)); }, 1500);
  if (tm.unref) tm.unref();
  tallyTimers.set(k, tm);
}
// ev: { at, people, expected, kind, note } from the gym's view of the event.
function tallyReview(key, id, verdict, ev) {
  const t = loadTally(key);
  const id_ = String(id || '');
  if (!id_) return;
  const prevOutcome = t.outcomes[id_];
  if (!verdict || !VERDICTS[verdict]) delete t.outcomes[id_];
  else {
    const e = ev || {};
    t.outcomes[id_] = {
      at: e.at || null, verdict,
      people: Number.isFinite(Number(e.people)) && e.people !== null ? Number(e.people) : null,
      expected: Number(e.expected) || 1,
      cameraSaid: e.kind || null,
      note: e.note ? String(e.note).slice(0, 200) : null,
      by: e.reviewBy ? String(e.reviewBy).slice(0, 30) : null,
    };
    // The scan that let them in, when the scans were certain (an id only; the member number stays sealed).
    if (e.scanId && isConfirmed(verdict)) t.outcomes[id_].scanId = String(e.scanId).slice(0, 40);
    if (e.override) t.outcomes[id_].override = true;
    if (isConfirmed(verdict) && prevOutcome && prevOutcome.follow) t.outcomes[id_].follow = prevOutcome.follow;
    const ids = Object.keys(t.outcomes);
    if (ids.length > TALLY_MAX_OUTCOMES) {
      ids.sort((a, b) => String(t.outcomes[a].at).localeCompare(String(t.outcomes[b].at)));
      for (const old of ids.slice(0, ids.length - TALLY_MAX_OUTCOMES)) delete t.outcomes[old];
    }
  }
  const d = t.outcomes[id_] && t.outcomes[id_].at ? String(t.outcomes[id_].at).slice(0, 10) : null;
  if (d && (!t.since || d < t.since)) t.since = d;
  saveTallySoon(key);
}
// The follow-up on one confirmed entry, kept with the lasting tally.
function tallyFollow(key, id, follow) {
  const t = loadTally(key);
  const o = t.outcomes[String(id || '')];
  if (!o) return;
  if (follow) o.follow = follow; else delete o.follow;
  saveTallySoon(key);
}
function tallySummary(key) {
  const t = loadTally(key);
  const out = Object.values(t.outcomes);
  const tailgates = out.filter(o => o.verdict === 'tailgate');
  const shared = out.filter(o => o.verdict === 'shared');
  const fine = out.filter(o => o.verdict === 'fine');
  // Extra people who got in: on a tailgate, everyone past the one swipe.
  const extra = tailgates.reduce((a, o) => a + (o.people != null && o.people > o.expected ? o.people - o.expected : 1), 0) + shared.length;
  const flaggedReviewed = out.filter(o => o.cameraSaid === 'flag' && !(o.override && o.verdict === 'fine'));   // disputed answers aren't counted as false alarms
  return {
    since: t.since || (t.nights.slice().sort()[0]) || null,
    nightsWatched: t.nights.length,
    entriesChecked: t.checked,
    cameraFlagged: t.flagged,
    reviewed: out.length,
    confirmedTailgates: tailgates.length,
    confirmedShared: shared.length,
    extraPeople: extra,
    markedFine: fine.length,
    // Of the red flags someone checked, how many were real.
    flagsChecked: flaggedReviewed.length,
    flagsConfirmed: flaggedReviewed.filter(o => isConfirmed(o.verdict)).length,
    // "It was fine" against both the camera and the scans: counted apart,
    // so they can't make the camera look wrong.
    overrides: out.filter(o => o.override && o.verdict === 'fine').length,
    overridesByPerson30d: out.filter(o => o.override && o.verdict === 'fine' && Date.now() - Date.parse(o.at) < 30 * 864e5).reduce((m, o) => (m[o.by || 'unknown'] = (m[o.by || 'unknown'] || 0) + 1, m), {}),
    // Thanks, not rankings: how many each person resolved in the last 7 days.
    thanks7d: out.filter(o => o.by && Date.now() - Date.parse(o.at) < 7 * 864e5).reduce((m, o) => (m[o.by] = (m[o.by] || 0) + 1, m), {}),
    spotChecked: Number(t.spotChecked) || 0,
    spotMissed: Number(t.spotMissed) || 0,
    // Money: what staff actually charged, and what the confirmed sneak-ins
    // were worth at the gym's sneak-in price.
    recoveredUsd: Math.round(out.reduce((a, o) => a + (o.follow && o.follow.what === 'charged' ? Number(o.follow.usd) || 0 : 0), 0) * 100) / 100,
    followedUp: out.filter(o => isConfirmed(o.verdict) && o.follow).length,
    toFollowUp: out.filter(o => isConfirmed(o.verdict) && !o.follow).length,
    sneakInUsd: (() => { const v = Number(getSettings(key).sneakInUsd); return Number.isFinite(v) ? v : 10; })(),
    // This calendar month (the gym's time zone), for the owner's line at the top.
    ...(() => {
      let ym; try { ym = new Intl.DateTimeFormat('en-CA', { timeZone: getSettings(key).timeZone || process.env.GYM_TIMEZONE || 'America/Chicago', year: 'numeric', month: '2-digit' }).format(new Date()).slice(0, 7); } catch (e) { ym = new Date().toISOString().slice(0, 7); }
      const m = out.filter(o => isConfirmed(o.verdict) && String(o.at || '').slice(0, 7) === ym);
      return { month: ym, monthConfirmed: m.length, monthRecoveredUsd: Math.round(m.reduce((a, o) => a + (o.follow && o.follow.what === 'charged' ? Number(o.follow.usd) || 0 : 0), 0) * 100) / 100 };
    })(),
  };
}
// Trends for the gym page: last 8 weeks, busiest hours (last 28 nights),
// and "since the camera started": the first 14 watched nights against the
// latest 14. Only shown with enough entries to mean something.
const TREND_MIN_ENTRIES = 50;
function trends(key, today) {
  const n = loadNights(key);
  const t = loadTally(key);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(today)) ? today : new Date().toISOString().slice(0, 10);
  const back = k => new Date(Date.parse(day + 'T00:00:00Z') - k * 864e5).toISOString().slice(0, 10);
  const rows = tallyRows(key).filter(o => isConfirmed(o.verdict) && o.at);
  const sum = (from, to) => {   // from inclusive, to exclusive (YYYY-MM-DD)
    let checked = 0, flagged = 0, nights = 0;
    for (const [d, r] of Object.entries(n)) if (d >= from && d < to && r) { checked += Number(r.c) || 0; flagged += Number(r.f) || 0; if (r.w) nights++; }
    const confirmed = rows.filter(o => { const d = String(o.at).slice(0, 10); return d >= from && d < to; }).length;
    return { from, to, nights, checked, flagged, confirmed };
  };
  const weeks = [];
  for (let i = 7; i >= 0; i--) weeks.push(sum(back(7 * i + 6), back(7 * i - 1)));
  const hours = new Array(24).fill(0), hoursFlagged = new Array(24).fill(0);
  const from28 = back(27);
  for (const [d, r] of Object.entries(n)) {
    if (d < from28 || !r) continue;
    if (Array.isArray(r.h)) r.h.forEach((v, i) => { hours[i] += Number(v) || 0; });
    if (Array.isArray(r.hf)) r.hf.forEach((v, i) => { hoursFlagged[i] += Number(v) || 0; });
  }
  // Baseline: kept for good once the first 14 watched nights are in.
  const watched = Object.keys(n).filter(d => n[d] && n[d].w).sort();
  if (!t.baseline && watched.length >= 14 && (!t.since || watched[0] <= t.since)) {
    const b = sum(watched[0], new Date(Date.parse(watched[13] + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10));
    if (b.checked >= TREND_MIN_ENTRIES) { t.baseline = b; saveTallySoon(key); }
  }
  const recent = sum(back(13), back(-1));
  let change = null;
  const b = t.baseline;
  if (b && recent.checked >= TREND_MIN_ENTRIES && recent.from > b.to) {
    const rate = x => x.checked ? x.confirmed / x.checked * 100 : 0;
    const flagRate = x => x.checked ? x.flagged / x.checked * 100 : 0;
    const useConfirmed = b.confirmed >= 3;
    const before = useConfirmed ? rate(b) : flagRate(b), after = useConfirmed ? rate(recent) : flagRate(recent);
    change = { measure: useConfirmed ? 'confirmed' : 'flagged', before: Math.round(before * 10) / 10, after: Math.round(after * 10) / 10,
      pct: before > 0 ? Math.round((after - before) / before * 100) : null, baselineFrom: b.from, baselineTo: b.to };
  }
  return { weeks, hours, hoursFlagged, change, baseline: b || null, recent, minEntries: TREND_MIN_ENTRIES };
}

// Member-number access log: which approved phone fetched member numbers,
// when, and who was signed in. One line per phone per 10 minutes, kept
// 90 days. The owner sees it on the gym page.
const ACCESS_KEEP_MS = 90 * 864e5;
const accessSeen = new Map();
function accessFile(key) { return path.join(DATA_DIR, `gym-access-${safeCode(key)}.json`); }
function loadAccess(key) {
  const a = readJson(accessFile(key), []);
  const cut = Date.now() - ACCESS_KEEP_MS;
  return Array.isArray(a) ? a.filter(x => x && Date.parse(x.at) > cut) : [];
}
function noteMemberAccess(key, rec) {
  const k = `${safeCode(key)}|${rec.deviceId}|${rec.who || ''}`;   // a second person on a shared tablet is logged too
  const last = accessSeen.get(k);
  if (last && Date.now() - last < 10 * 60e3) return false;
  accessSeen.set(k, Date.now());
  const list = loadAccess(key);
  list.push({ at: new Date().toISOString(), device: String(rec.device || 'A phone').slice(0, 60), who: rec.who ? String(rec.who).slice(0, 60) : null, scans: Number(rec.scans) || 0 });
  writeJson(accessFile(key), list.slice(-2000));
  return true;
}

// Camera problems inbox: each problem is open until it fixes itself (the
// camera computer checks in again, the picture comes back). Kept 30 days.
function problemsFile(key) { return path.join(DATA_DIR, `gym-problems-${safeCode(key)}.json`); }
function loadProblems(key) {
  const a = readJson(problemsFile(key), []);
  const cut = Date.now() - 30 * 864e5;
  return Array.isArray(a) ? a.filter(x => x && Date.parse(x.at) > cut) : [];
}
function openProblem(key, kind, label, text) {
  const list = loadProblems(key);
  const id = `${kind}|${label || ''}`;
  if (list.some(x => x.id === id && !x.fixedAt)) return;
  list.push({ id, kind, label: label ? String(label).slice(0, 60) : null, text: text ? String(text).slice(0, 300) : null, at: new Date().toISOString(), fixedAt: null });
  writeJson(problemsFile(key), list.slice(-200));
}
function fixProblem(key, kind, label) {
  const list = loadProblems(key);
  let changed = false;
  for (const x of list) if (!x.fixedAt && x.kind === kind && (label === undefined || x.label === (label || null))) { x.fixedAt = new Date().toISOString(); changed = true; }
  if (changed) writeJson(problemsFile(key), list);
}

function tallyRows(key) {
  const t = loadTally(key);
  return Object.entries(t.outcomes).map(([id, o]) => Object.assign({ id }, o))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

// --- Formatting in the gym's own time zone ------------------------------
function fmtLocal(iso, timeZone, opts) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const o = Object.assign({ weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, opts || {});
  try { return d.toLocaleString('en-US', Object.assign({ timeZone }, o)); }
  catch (e) { return d.toLocaleString('en-US', Object.assign({ timeZone: 'UTC', timeZoneName: 'short' }, o)); }
}

// --- Leads: gyms that used "Will it work at your gym?" ----------------------
// Contact details and their answers, for TJ to reply to. Kept a year, at
// most 300; never served as a file (server.js blocks leads.json).
function leadsFile() { return path.join(DATA_DIR, 'leads.json'); }
function loadLeads() { const l = readJson(leadsFile(), []); return Array.isArray(l) ? l : []; }
function addLead(lead) {
  const cut = Date.now() - 365 * 864e5;
  const list = loadLeads().filter(x => Date.parse(x.at) > cut);
  const rec = Object.assign({ id: crypto.randomBytes(6).toString('hex'), at: new Date().toISOString(), done: false }, lead);
  list.unshift(rec);
  writeJson(leadsFile(), list.slice(0, 300));
  return rec;
}
function markLead(id, done) {
  const list = loadLeads(); const x = list.find(l => l.id === id); if (!x) return false;
  x.done = !!done; writeJson(leadsFile(), list); return true;
}

module.exports = {
  safeCode, signToken, readToken, loadLeads, addLead, markLead, closeData,
  COOKIE, parseCookies, codeFromRequest, setSessionCookie, clearSessionCookie,
  limited, count,
  eventId, newEventId,
  VERDICTS, isConfirmed, loadReviews, setReview, REVIEW_NOTE_MAX, FOLLOWS, setFollow, tallyFollow,
  loadTally, tallyReview, tallySummary, tallyRows,
  normalizeSettings, getSettings, saveSettings, runnerGen, bumpRunnerGen, readerGen, bumpReaderGen,
  isPaused, setPaused, noteRunnerSeen, runnerSeen, markOfflineAlerted, knownMetaKeys,
  recordDelivery, deliveryStatus, loadNights, noteNight, flushNights, trends, normalizeChatHook, loadAccess, noteMemberAccess, loadProblems, openProblem, fixProblem, loadAnswers, ownerAgrees, noteExit, startFresh,
  MAX_SUBSCRIBERS, loadSubscribers, addSubscriber, removeSubscriber, normalizeEmail, normalizePhone, getMarker, setMarker, setSubscriberMorning, setSubscriberChoice, getSpot, setSpot, tallySpot,
  unsubscribeToken, readUnsubscribeToken,
  shareToken, readShareToken, SHARE_TTL_MS,
  fmtLocal,
};
