// Gym accounts — issuing access codes and recovering forgotten ones.
//
// Deliberately NOT a password system. An access code scopes a gym's alert
// log and settings so two customers never see each other's data; it is not
// protecting anything a determined attacker would want, and treating it as
// low-value is the honest framing. What it must not do is leak which gyms
// exist or let anyone mint themselves a code, so:
//   - Creating a gym requires ADMIN_TOKEN (you, not the customer).
//   - Recovery never reveals whether an email is on file.
//   - Recovery is rate limited so it can't be used to spam an inbox.
//
// If this ever grows into something that guards real member data, it
// should be replaced with a proper auth provider rather than extended.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mailer = require('./mailer');
const store = require('./gym-store');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const GYMS_FILE = path.join(DATA_DIR, 'gyms.json');

// A damaged gyms.json must NEVER read as "no gyms": that switches the site
// into open mode (anyone sees the photos, any camera computer is accepted)
// and the next new gym would overwrite every account. So: writes are
// atomic with a .bak of the previous version; a damaged file falls back to
// the .bak, then to the last good copy in memory; and while it is damaged
// the site stays locked (codes "configured") and refuses to save over it.
const GYMS_BAK = GYMS_FILE + '.bak';
let lastGood = null;
let damaged = false;
function readList(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('not a list');
  return parsed;
}
function load() {
  if (!fs.existsSync(GYMS_FILE)) { damaged = false; return []; }
  try {
    const list = readList(GYMS_FILE);
    damaged = false; lastGood = list;
    return list;
  } catch (err) {
    if (!damaged) console.error(`gyms.json is damaged (${err.message}). Using the backup; new gyms can't be saved until it is fixed. Do this: replace ${GYMS_FILE} with ${GYMS_BAK}.`);
    damaged = true;
    try { return readList(GYMS_BAK); } catch (e) { /* no usable backup */ }
    return lastGood || [];
  }
}

function save(list) {
  try {
    if (damaged && fs.existsSync(GYMS_FILE)) { load(); if (damaged) throw new Error(`${GYMS_FILE} is damaged; not overwriting it`); }
    if (fs.existsSync(GYMS_FILE)) { try { readList(GYMS_FILE); fs.copyFileSync(GYMS_FILE, GYMS_BAK); } catch (e) { /* keep the older .bak */ } }
    const tmp = `${GYMS_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
    fs.renameSync(tmp, GYMS_FILE);
    lastGood = list;
    return true;
  } catch (err) {
    console.warn('Could not write gyms file:', err.message);
    return false;
  }
}

// Human-readable but not guessable: the gym's name plus six random hex
// characters, e.g. "ironstreetgym-4f2a9c". Whole words are kept (a name
// is never cut mid-word into "ironstreetgy"); very long names keep their
// first words. Existing codes keep working.
function nameSlug(gymName) {
  const words = String(gymName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  let slug = '';
  for (const w of words) {
    if (!slug) { slug = w.slice(0, 20); continue; }
    if ((slug + w).length > 20) break;
    slug += w;
  }
  return slug || 'gym';
}
function generateCode(gymName) {
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${nameSlug(gymName)}-${suffix}`;
}

function normalize(code) {
  return String(code || '').trim().toLowerCase();
}

// Every gym has two names for itself:
//   code - the sign-in code the gym types (secret-ish, can be re-issued)
//   key  - where its data lives (alert-log-<key>.json, frames-<key>/...)
//          and what camera computers report as gymCode. Never changes
//          once data exists. For gyms made before keys existed it is the
//          code, so nothing on disk moves.
function keyOf(g) { return store.safeCode((g && (g.key || g.code)) || 'default'); }

// Finds a gym by its sign-in code OR its data key.
function findByCode(code) {
  const c = normalize(code);
  if (!c) return null;
  const list = load();
  return list.find(g => normalize(g.code) === c) || list.find(g => keyOf(g) === store.safeCode(c)) || null;
}

// Codes from the environment still work, so an existing single-gym setup
// doesn't break when this store is introduced.
function envCodes() {
  return (process.env.GYM_CODES || '')
    .split(',').map(c => normalize(c)).filter(Boolean);
}

// Sign-in check: the gym's CURRENT code only (not its key, not an old
// code) — so issuing a new code locks out old phones and links.
function isValidCode(code) {
  const c = normalize(code);
  if (!c) return false;
  if (envCodes().includes(c)) return true;
  return load().some(g => normalize(g.code) === c);
}

// Code or key -> the gym's data key, or null if no such gym.
function resolveKey(codeOrKey) {
  const c = normalize(codeOrKey);
  if (!c) return null;
  const g = findByCode(c);
  if (g) return keyOf(g);
  const env = envCodes().find(e => e === c || store.safeCode(e) === store.safeCode(c));
  return env ? store.safeCode(env) : null;
}
function isKnownKey(key) { return !!resolveKey(key); }

function anyCodesConfigured() {
  return envCodes().length > 0 || load().length > 0 || damaged;
}

// IANA zone names only ("America/Chicago"); anything else is dropped so a
// typo can't make the page throw when it formats a time.
function validTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch (e) { return null; }
}

// The zone a gym's times are shown in: the gym's own, else GYM_TIMEZONE,
// else Central (every current customer is in Arkansas). Never the
// server's clock — Render runs in UTC.
function timeZoneFor(code) {
  const g = findByCode(code);
  let fromSettings = null;
  try { fromSettings = store.getSettings(g ? keyOf(g) : code).timeZone; } catch (e) { /* none */ }
  return validTimeZone(g && g.timeZone) || validTimeZone(fromSettings) || validTimeZone(process.env.GYM_TIMEZONE) || 'America/Chicago';
}

function gymNameFor(code) {
  const g = findByCode(code);
  return (g && g.gymName) || null;
}

// Every key and code in use, so a new one can't collide.
function takenNames() {
  const t = new Set(envCodes().map(c => store.safeCode(c)));
  for (const g of load()) { t.add(keyOf(g)); t.add(store.safeCode(g.code)); }
  return t;
}

// adoptCode: a gym code a camera computer is ALREADY sending (for example
// "jstreet" from before gyms had accounts). The new gym keeps its data
// under that name, so the runner keeps working and its log is not orphaned.
// The sign-in code is still a fresh random one.
function createGym({ gymName, email, timeZone, adoptCode }) {
  if (!gymName || !email) throw new Error('gymName and email are both required.');
  const list = load();
  const taken = takenNames();
  let code;
  do { code = generateCode(gymName); } while (taken.has(store.safeCode(code)));
  let key = store.safeCode(code);
  if (adoptCode) {
    const a = store.safeCode(adoptCode);
    if (!a || a === 'default' || a !== normalize(adoptCode)) throw new Error('That gym code can only use a-z, 0-9, - and _.');
    if (taken.has(a)) throw new Error(`"${a}" already belongs to another gym here.`);
    key = a;
  }
  const gym = {
    code,
    key,
    gymName: String(gymName).trim().slice(0, 80),
    email: String(email).trim().toLowerCase(),
    createdAt: new Date().toISOString(),
  };
  if (validTimeZone(timeZone)) gym.timeZone = validTimeZone(timeZone);
  list.push(gym);
  if (!save(list)) throw new Error('Could not save the new gym.');
  return gym;
}

// Point an existing gym's data at a code its camera computer already uses.
// The caller (server.js) checks that the gym has no data of its own yet.
function adoptKey(codeOrKey, legacy) {
  const list = load();
  const k = resolveKey(codeOrKey);
  const g = list.find(x => keyOf(x) === k);
  if (!g) throw new Error('No such gym.');
  const a = store.safeCode(legacy);
  if (!a || a === 'default' || a !== normalize(legacy)) throw new Error('That gym code can only use a-z, 0-9, - and _.');
  const taken = takenNames();
  taken.delete(keyOf(g)); taken.delete(store.safeCode(g.code));
  if (taken.has(a)) throw new Error(`"${a}" already belongs to another gym here.`);
  const before = keyOf(g);
  g.key = a;
  if (!save(list)) throw new Error('Could not save.');
  return { gym: g, previousKey: before };
}

// A new sign-in code. The data key stays, so nothing on disk moves; the
// old code, every phone signed in with it and any link containing it
// stop working at once.
function newCode(codeOrKey) {
  const list = load();
  const k = resolveKey(codeOrKey);
  const g = list.find(x => keyOf(x) === k);
  if (!g) throw new Error(envCodes().some(c => store.safeCode(c) === k) ? 'That gym\'s code comes from GYM_CODES on Render. Change it there.' : 'No such gym.');
  const taken = takenNames();
  if (!g.key) g.key = keyOf(g);
  let code;
  do { code = generateCode(g.gymName); } while (taken.has(store.safeCode(code)));
  g.code = code;
  g.codeIssuedAt = new Date().toISOString();
  if (!save(list)) throw new Error('Could not save.');
  return g;
}

function setTimeZone(codeOrKey, tz) {
  const list = load();
  const k = resolveKey(codeOrKey);
  const g = list.find(x => keyOf(x) === k);
  if (!g) return false;               // env/open gyms keep it in their settings file
  if (tz) g.timeZone = validTimeZone(tz); else delete g.timeZone;
  save(list);
  return true;
}

function listGyms() {
  // Codes deliberately omitted — this is for an operator overview, and
  // there's no reason for a listing endpoint to hand out credentials.
  return load().map(g => ({ gymName: g.gymName, email: g.email, createdAt: g.createdAt }));
}

// Operator-only (the admin routes check ADMIN_TOKEN before calling this):
// includes the codes, which the operator needs to hand a gym its link.
function listGymsForAdmin() {
  return load().map(g => ({ code: g.code, key: keyOf(g), gymName: g.gymName, email: g.email, createdAt: g.createdAt, timeZone: g.timeZone || null, codeIssuedAt: g.codeIssuedAt || null }));
}

// --- Recovery ---------------------------------------------------------
// Rate limited per email and per caller so this can't be turned into an
// email bomb or used to probe which gyms are registered.
const recentRecoveries = new Map();
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_MAX = 3;

function rateLimited(key) {
  const now = Date.now();
  const hits = (recentRecoveries.get(key) || []).filter(t => now - t < RECOVERY_WINDOW_MS);
  if (hits.length >= RECOVERY_MAX) return true;
  hits.push(now);
  recentRecoveries.set(key, hits);
  return false;
}

function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// The site's public address, for links in emails. DOMAIN is already set
// on Render for Stripe; a localhost value is useless in an email, so skip it.
function publicBaseUrl() {
  // RENDER_EXTERNAL_URL is set by Render itself, so alert/report links
  // work even when the optional DOMAIN setting was never added.
  const d = String(process.env.PUBLIC_URL || process.env.DOMAIN || process.env.RENDER_EXTERNAL_URL || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(d) || /\/\/(localhost|127\.)/i.test(d)) return null;
  return d;
}

// Always resolves the same way regardless of whether the email matched.
// The caller must not branch on the result, or it becomes an oracle for
// which gyms are registered.
async function recoverCode({ email, callerKey }) {
  const addr = String(email || '').trim().toLowerCase();
  if (!addr) return { ok: true };

  if (rateLimited(`e:${addr}`) || rateLimited(`c:${callerKey || 'unknown'}`)) {
    return { ok: true, throttled: true };
  }

  const matches = load().filter(g => g.email === addr);
  if (!matches.length) return { ok: true };

  const base = publicBaseUrl();
  const linkFor = g => base ? `${base}/activity.html#code=${encodeURIComponent(g.code)}` : null;
  const lines = matches.map(g => `${g.gymName}: ${g.code}${linkFor(g) ? `\n  Open: ${linkFor(g)}` : ''}`).join('\n');
  await mailer.sendMail({
    to: addr,
    subject: 'Your SecurityAI access code',
    text: `Here ${matches.length === 1 ? 'is the access code' : 'are the access codes'} for your SecurityAI account:\n\n${lines}\n\nTap the link (or enter the code on your gym's activity page) to see what the camera flagged.\n\nIf you didn't ask for this, you can ignore it.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;">
      <p style="font-size:15px;color:#14171A;">Here ${matches.length === 1 ? 'is the access code' : 'are the access codes'} for your SecurityAI account:</p>
      ${matches.map(g => `<div style="background:#f4f6f8;border:1px solid #e0e3e7;border-radius:6px;padding:14px 16px;margin:10px 0;">
        <div style="font-size:13px;color:#5b636b;">${escHtml(g.gymName)}</div>
        <div style="font-size:22px;font-weight:700;color:#14171A;font-family:monospace;letter-spacing:1px;margin-top:4px;">${escHtml(g.code)}</div>
        ${linkFor(g) ? `<a href="${escHtml(linkFor(g))}" style="display:inline-block;margin-top:10px;background:#14171A;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px;">Open your activity page</a>` : ''}
      </div>`).join('')}
      <p style="font-size:13px;color:#5b636b;">Tap the button (or enter the code on your gym's activity page) to see what the camera flagged.</p>
      <p style="font-size:12px;color:#8b939b;">If you didn't ask for this, you can ignore it.</p>
    </div>`,
  });

  return { ok: true };
}

module.exports = {
  createGym, listGyms, listGymsForAdmin, isValidCode, anyCodesConfigured,
  findByCode, recoverCode, generateCode, normalize, timeZoneFor, gymNameFor,
  validTimeZone, publicBaseUrl, keyOf, resolveKey, isKnownKey, envCodes,
  adoptKey, newCode, setTimeZone,
  isDamaged: () => { load(); return damaged; },
};
