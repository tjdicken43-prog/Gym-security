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

const DATA_DIR = process.env.DATA_DIR || __dirname;
const GYMS_FILE = path.join(DATA_DIR, 'gyms.json');

function load() {
  try {
    if (!fs.existsSync(GYMS_FILE)) return [];
    const parsed = JSON.parse(fs.readFileSync(GYMS_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Could not read gyms file:', err.message);
    return [];
  }
}

function save(list) {
  try {
    fs.writeFileSync(GYMS_FILE, JSON.stringify(list, null, 2));
    return true;
  } catch (err) {
    console.warn('Could not write gyms file:', err.message);
    return false;
  }
}

// Human-readable but not guessable: a slug of the gym name plus four
// random hex characters. "ironoak-4f2a" is easy to read over the phone
// and type on a keypad, while still not being something you'd land on by
// trying names.
function generateCode(gymName) {
  const slug = String(gymName || 'gym').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'gym';
  const suffix = crypto.randomBytes(2).toString('hex');
  return `${slug}-${suffix}`;
}

function normalize(code) {
  return String(code || '').trim().toLowerCase();
}

function findByCode(code) {
  const c = normalize(code);
  if (!c) return null;
  return load().find(g => normalize(g.code) === c) || null;
}

// Codes from the environment still work, so an existing single-gym setup
// doesn't break when this store is introduced.
function envCodes() {
  return (process.env.GYM_CODES || '')
    .split(',').map(c => normalize(c)).filter(Boolean);
}

function isValidCode(code) {
  const c = normalize(code);
  if (!c) return false;
  if (envCodes().includes(c)) return true;
  return !!findByCode(c);
}

function anyCodesConfigured() {
  return envCodes().length > 0 || load().length > 0;
}

function createGym({ gymName, email }) {
  if (!gymName || !email) throw new Error('gymName and email are both required.');
  const list = load();
  const code = generateCode(gymName);
  const gym = {
    code,
    gymName: String(gymName).trim(),
    email: String(email).trim().toLowerCase(),
    createdAt: new Date().toISOString(),
  };
  list.push(gym);
  if (!save(list)) throw new Error('Could not save the new gym.');
  return gym;
}

function listGyms() {
  // Codes deliberately omitted — this is for an operator overview, and
  // there's no reason for a listing endpoint to hand out credentials.
  return load().map(g => ({ gymName: g.gymName, email: g.email, createdAt: g.createdAt }));
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

  const lines = matches.map(g => `${g.gymName}: ${g.code}`).join('\n');
  await mailer.sendMail({
    to: addr,
    subject: 'Your SecurityAI access code',
    text: `Here ${matches.length === 1 ? 'is the access code' : 'are the access codes'} for your SecurityAI account:\n\n${lines}\n\nEnter this on the Live Monitor page to load your gym's settings and alert log.\n\nIf you didn't request this, you can ignore it — the code only scopes your own dashboard and grants nothing else.`,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;">
      <p style="font-size:15px;color:#14171A;">Here ${matches.length === 1 ? 'is the access code' : 'are the access codes'} for your SecurityAI account:</p>
      ${matches.map(g => `<div style="background:#f4f6f8;border:1px solid #e0e3e7;border-radius:6px;padding:14px 16px;margin:10px 0;">
        <div style="font-size:13px;color:#5b636b;">${g.gymName}</div>
        <div style="font-size:22px;font-weight:700;color:#14171A;font-family:monospace;letter-spacing:1px;margin-top:4px;">${g.code}</div>
      </div>`).join('')}
      <p style="font-size:13px;color:#5b636b;">Enter this on the Live Monitor page to load your gym's settings and alert log.</p>
      <p style="font-size:12px;color:#8b939b;">If you didn't request this, you can ignore it — the code only scopes your own dashboard and grants nothing else.</p>
    </div>`,
  });

  return { ok: true };
}

module.exports = {
  createGym, listGyms, isValidCode, anyCodesConfigured,
  findByCode, recoverCode, generateCode, normalize,
};
