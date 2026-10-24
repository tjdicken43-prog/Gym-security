// Admin sign-in: ADMIN_TOKEN, plus (when email is set up) a one-time
// "Approve" link emailed to TJ for each new browser.
//
//   1. The admin page sends the token. A browser that hasn't been approved
//      gets 403 { needEmail: true }.
//   2. It asks for a link (POST /admin/login/start). The email goes to
//      ADMIN_EMAIL (or SUPPORT_EMAIL) — never to an address the browser picks.
//   3. TJ taps Approve in the email (a button on a page, so email
//      scanners that open links can't approve by themselves).
//   4. The waiting admin page picks up a signed session (30 days) and is in.
//
// The session is signed with a key derived from ADMIN_TOKEN: changing
// ADMIN_TOKEN on Render signs every browser out. ADMIN_EMAIL_CONFIRM=off
// turns the email step off (the way back in if email ever breaks).
//
// Authenticator app (2FA): set ADMIN_TOTP_SECRET on Render (make one with
// `node admin-totp.js`). Then a new browser needs the token AND the
// 6-digit code from the app, instead of the email. Removing the variable
// turns it off. Changing it signs every browser out.
'use strict';
const crypto = require('crypto');

const SESSION_DAYS = 30;
const LINK_MINUTES = 15;
// id -> { approveHash, expires, approved, ua, ip, at }. Kept on the disk
// too, so a website restart (every deploy or Render setting change) while
// TJ is opening the email doesn't lose the sign-in. Only a HASH of the
// email link is kept, and the session is made when it's handed out.
const path = require('path'), fs = require('fs');
const PENDING_FILE = process.env.DATA_DIR ? path.join(process.env.DATA_DIR, 'admin-pending.json') : null;
const pending = new Map();
try { if (PENDING_FILE) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')))) if (v && v.approveHash) pending.set(k, v); } catch (e) { /* none yet */ }
function savePending() {
  if (!PENDING_FILE) return;
  try { fs.writeFileSync(PENDING_FILE + '.tmp', JSON.stringify(Object.fromEntries(pending))); fs.renameSync(PENDING_FILE + '.tmp', PENDING_FILE); } catch (e) { /* best effort */ }
}
const hashLink = t => crypto.createHash('sha256').update('admin-approve|' + String(t || '')).digest('hex');
function findByLink(t) { const h = hashLink(t); for (const p of pending.values()) if (sameSecret(h, p.approveHash)) return p; return null; }

function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}
function adminEmail() {
  return String(process.env.ADMIN_EMAIL || process.env.SUPPORT_EMAIL || '').trim();
}
function mailerOk() {
  try { return require('./mailer').isConfigured(); } catch (e) { return false; }
}
// Email approval is on when it can work: email sending set up, an address
// to send to, and not switched off.
function emailConfirmOn() {
  if (String(process.env.ADMIN_EMAIL_CONFIRM || '').toLowerCase() === 'off') return false;
  return !!(process.env.ADMIN_TOKEN && adminEmail() && mailerOk());
}
// --- Authenticator codes (RFC 6238: SHA-1, 30 s, 6 digits) ---------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Decode(s) {
  const clean = String(s || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) return null;
    val = (val << 5) | i; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function base32Encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function totpSecret() {
  const key = base32Decode(process.env.ADMIN_TOTP_SECRET);
  return key && key.length >= 10 ? key : null;     // 80+ bits, or treat as unset
}
function totpOn() { return !!(process.env.ADMIN_TOKEN && totpSecret()); }
function totpAt(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
// One step either side (phone clock drift). A code works once: replays of
// the same or an older step are refused.
let lastTotpStep = 0;
function checkTotp(code, now) {
  const key = totpSecret();
  const c = String(code || '').replace(/\s/g, '');
  if (!key || !/^\d{6}$/.test(c)) return false;
  const step = Math.floor((now || Date.now()) / 30e3);
  for (const d of [0, -1, 1]) {
    if (step + d <= lastTotpStep) continue;
    if (sameSecret(totpAt(key, step + d), c)) { lastTotpStep = step + d; return true; }
  }
  return false;
}

function sessionKey() {
  // Turning the authenticator on (or changing it) signs every browser out.
  const key = totpSecret();
  const tag = key ? '|totp:' + crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) : '';
  return crypto.createHmac('sha256', String(process.env.ADMIN_TOKEN || '')).update('securityai-admin-session-v1' + tag).digest();
}
function signSession(days) {
  const body = Buffer.from(JSON.stringify({ v: 1, exp: Date.now() + (days || SESSION_DAYS) * 864e5, n: crypto.randomBytes(8).toString('hex') })).toString('base64url');
  const mac = crypto.createHmac('sha256', sessionKey()).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function verifySession(s) {
  const m = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(String(s || ''));
  if (!m || !process.env.ADMIN_TOKEN) return false;
  const want = crypto.createHmac('sha256', sessionKey()).update(m[1]).digest('base64url');
  if (!sameSecret(m[2], want)) return false;
  try { const b = JSON.parse(Buffer.from(m[1], 'base64url').toString()); return b && b.v === 1 && b.exp > Date.now(); } catch (e) { return false; }
}

// { ok } | { ok:false, needCode:true } | { ok:false, needEmail:true } | { ok:false }
function check(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || !sameSecret(req.get('X-Admin-Token') || '', token)) return { ok: false };
  if (totpOn()) return verifySession(req.get('X-Admin-Session')) ? { ok: true } : { ok: false, needCode: true };
  if (!emailConfirmOn()) return { ok: true };
  if (verifySession(req.get('X-Admin-Session'))) return { ok: true };
  return { ok: false, needEmail: true };
}
function isAdmin(req) { return check(req).ok; }
// The 403 body for a failed check(): tells the admin page which step is next.
function denyBody(c) {
  if (c && c.needCode) return { error: 'Enter the 6-digit code from your authenticator app.', needCode: true };
  if (c && c.needEmail) return { error: 'Approve this browser from the email we send you.', needEmail: true };
  return { error: 'Not authorized.' };
}

function prune() {
  const now = Date.now();
  let changed = false;
  for (const [id, p] of pending) if (p.expires < now - 5 * 60e3) { pending.delete(id); changed = true; }
  if (changed) savePending();
}
function maskEmail(e) {
  const [u, d] = String(e).split('@');
  if (!d) return 'your email';
  return `${u.slice(0, 2)}${'•'.repeat(Math.max(1, u.length - 2))}@${d}`;
}
function esc(v) { return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function deviceWords(ua) {
  const s = String(ua || '');
  const os = /iPhone/.test(s) ? 'iPhone' : /iPad/.test(s) ? 'iPad' : /Android/.test(s) ? 'Android phone' : /Mac OS X/.test(s) ? 'Mac' : /Windows/.test(s) ? 'Windows PC' : /Linux/.test(s) ? 'Linux computer' : 'a device';
  const br = /Edg\//.test(s) ? 'Edge' : /CriOS|Chrome\//.test(s) ? 'Chrome' : /FxiOS|Firefox\//.test(s) ? 'Firefox' : /Safari\//.test(s) ? 'Safari' : 'a browser';
  return `${br} on ${os}`;
}
function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title>
<link rel="stylesheet" href="/brand.css"><style>body{margin:0;background:#E4E6E3;color:#1E2124;font:17px/1.55 var(--body);padding:24px 16px;}
.c{max-width:460px;margin:8vh auto;background:#F7F7F5;border-radius:16px;padding:24px;box-shadow:var(--lift-hi);}
h1{font:800 34px/1 var(--display);text-transform:uppercase;margin:0 0 10px;} p{color:#3A4146;margin:6px 0;} b{color:#1E2124;}
button{width:100%;min-height:52px;margin-top:16px;border:0;border-radius:10px;font:inherit;font-weight:700;cursor:pointer;}
.ok{background:#1D4FB0;color:#fff;} .no{background:transparent;color:#1E2124;border:2px solid #1E2124;}</style></head><body><div class="c">${body}</div></body></html>`;
}

function mount(app, deps) {
  const { publicBaseUrl } = deps || {};
  const limited = (() => { const hits = new Map(); return (k, n, ms) => { const now = Date.now(); const a = (hits.get(k) || []).filter(t => now - t < ms); a.push(now); hits.set(k, a); return a.length > n; }; })();

  // Authenticator sign-in: token + 6-digit code -> 30-day session.
  app.post('/admin/login/code', require('express').json({ limit: '1kb' }), (req, res) => {
    res.set('Cache-Control', 'no-store');
    const token = process.env.ADMIN_TOKEN;
    if (!token || !sameSecret(req.get('X-Admin-Token') || '', token)) return res.status(403).json({ error: 'Not authorized.' });
    if (!totpOn()) return res.status(400).json({ error: 'The authenticator app is not set up (ADMIN_TOTP_SECRET).' });
    if (limited('login-code', 5, 15 * 60e3)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes.' });
    if (!checkTotp(req.body && req.body.code)) return res.status(401).json({ error: 'That code did not work. Use the newest code in the app.' });
    res.json({ ok: true, session: signSession() });
  });

  // Step 2: send the Approve link. Needs the right token first.
  app.post('/admin/login/start', async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    if (!token || !sameSecret(req.get('X-Admin-Token') || '', token)) return res.status(403).json({ error: 'Not authorized.' });
    if (totpOn()) return res.status(400).json({ error: 'Use the code from your authenticator app.', needCode: true });
    if (!emailConfirmOn()) return res.json({ ok: true, session: signSession(), emailOff: true });
    if (limited('login-start', 6, 15 * 60e3)) return res.status(429).json({ error: 'Too many sign-in emails. Wait 15 minutes.' });
    prune();
    const id = crypto.randomBytes(16).toString('hex');
    const approveToken = crypto.randomBytes(24).toString('base64url');
    const p = { approveHash: hashLink(approveToken), expires: Date.now() + LINK_MINUTES * 60e3, approved: false, ua: req.get('User-Agent') || '', ip: String(req.get('X-Forwarded-For') || req.socket.remoteAddress || '').split(',').pop().trim(), at: new Date().toISOString() };
    pending.set(id, p); savePending();
    const proto = String(req.get('X-Forwarded-Proto') || req.protocol || 'http').split(',')[0].trim();
    const base = (publicBaseUrl && publicBaseUrl()) || `${proto}://${req.get('host')}`;
    const link = `${base}/admin/approve?t=${encodeURIComponent(approveToken)}`;
    const who = deviceWords(p.ua);
    try {
      const r = await require('./mailer').sendMail({
        to: adminEmail(),
        subject: 'SecurityAI admin: approve sign-in?',
        text: `Someone just entered your admin token on ${who}.\n\nIf that was you, approve it (link works for ${LINK_MINUTES} minutes):\n${link}\n\nIf it wasn't you, ignore this email and change ADMIN_TOKEN on Render.`,
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:480px;"><p style="font-size:16px;"><b>Someone just entered your admin token</b> on ${esc(who)}.</p><p>If that was you, approve it. The link works for ${LINK_MINUTES} minutes.</p><p><a href="${esc(link)}" style="display:inline-block;background:#14171A;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:600;">Approve sign-in</a></p><p style="color:#666;font-size:13px;">If it wasn't you, ignore this email and change ADMIN_TOKEN on Render.</p></div>`,
      });
      if (!r || !r.delivered) throw new Error((r && r.reason) || 'not sent');
    } catch (err) {
      pending.delete(id); savePending();
      return res.status(502).json({ error: `The approval email could not be sent (${err.message}). To get in anyway, set ADMIN_EMAIL_CONFIRM=off on Render.` });
    }
    res.json({ ok: true, id, sentTo: maskEmail(adminEmail()), minutes: LINK_MINUTES });
  });

  // Step 4: the waiting admin page asks "approved yet?" (token required).
  app.get('/admin/login/status', (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    if (!token || !sameSecret(req.get('X-Admin-Token') || '', token)) return res.status(403).json({ error: 'Not authorized.' });
    const p = pending.get(String(req.query.id || ''));
    if (!p || p.expires < Date.now() && !p.approved) return res.json({ ok: false, expired: true });
    if (!p.approved) return res.json({ ok: false, waiting: true });
    pending.delete(String(req.query.id)); savePending();     // the session is handed out once
    res.set('Cache-Control', 'no-store').json({ ok: true, session: signSession() });
  });

  // Step 3: the link in the email. GET only shows a button.
  app.get('/admin/approve', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const t = String(req.query.t || '');
    const p = findByLink(t);
    if (!p || p.expires < Date.now()) return res.status(410).send(page('Link expired', '<h1>This link has expired</h1><p>Go back to the admin page and sign in again for a new one.</p>'));
    if (p.approved) return res.send(page('Approved', '<h1>Already approved ✓</h1><p>The admin page you were signing in on opens by itself.</p><a href="/admin.html" class="ok" style="display:block;text-align:center;text-decoration:none;line-height:52px;border-radius:10px;font-weight:700;margin-top:12px;">Open the admin page</a>'));
    res.send(page('Approve sign-in', `<h1>Approve admin sign-in?</h1>
      <p>From <b>${esc(deviceWords(p.ua))}</b>, ${esc(new Date(p.at).toUTCString())}.</p>
      <form method="post" action="/admin/approve"><input type="hidden" name="t" value="${esc(t)}">
      <button class="ok" type="submit">Yes, that was me — approve</button></form>
      <p style="margin-top:14px;font-size:14px;">Not you? Close this page and change ADMIN_TOKEN on Render.</p>`));
  });
  // The form's one field, read by hand (tiny, and no extra parser needed).
  const formBody = (req, res, next) => {
    if (req.body && typeof req.body === 'object' && req.body.t) return next();
    let raw = '';
    req.on('data', d => { raw += d; if (raw.length > 2048) req.destroy(); });
    req.on('end', () => { req.body = Object.fromEntries(new URLSearchParams(raw)); next(); });
  };
  app.post('/admin/approve', formBody, (req, res) => {
    res.set('Cache-Control', 'no-store');
    const t = String((req.body && req.body.t) || '');
    const p = findByLink(t);
    if (!p || p.expires < Date.now()) return res.status(410).send(page('Link expired', '<h1>This link has expired</h1><p>Sign in again on the admin page for a new one.</p>'));
    if (!p.approved) { p.approved = true; p.expires = Date.now() + 5 * 60e3; savePending(); }
    // Also approve THIS browser (the session is useless without the admin
    // token, so it's safe here), so "Open the admin page" works from this
    // tab too, not only from the tab that was waiting.
    res.send(page('Approved', `<h1>Approved ✓</h1>
      <p>The admin page you were signing in on opens by itself within a few seconds.</p>
      <p>Or open it here:</p>
      <a href="/admin.html" style="display:block;text-align:center;text-decoration:none;line-height:52px;border-radius:10px;font-weight:700;margin-top:12px;" class="ok">Open the admin page</a>
      <script>try{localStorage.setItem('securityai:adminSession', ${JSON.stringify(signSession())});}catch(e){}</script>`));
  });
}

module.exports = { mount, check, isAdmin, denyBody, emailConfirmOn, totpOn, checkTotp, totpAt, base32Encode, base32Decode, adminEmail, signSession, verifySession, sameSecret };
