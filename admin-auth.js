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
'use strict';
const crypto = require('crypto');

const SESSION_DAYS = 30;
const LINK_MINUTES = 15;
const pending = new Map();      // id -> { approveToken, expires, approved, ua, ip, at, session }

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
function sessionKey() {
  return crypto.createHmac('sha256', String(process.env.ADMIN_TOKEN || '')).update('securityai-admin-session-v1').digest();
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

// { ok } | { ok:false, needEmail:true } | { ok:false }
function check(req) {
  const token = process.env.ADMIN_TOKEN;
  if (!token || !sameSecret(req.get('X-Admin-Token') || '', token)) return { ok: false };
  if (!emailConfirmOn()) return { ok: true };
  if (verifySession(req.get('X-Admin-Session'))) return { ok: true };
  return { ok: false, needEmail: true };
}
function isAdmin(req) { return check(req).ok; }

function prune() {
  const now = Date.now();
  for (const [id, p] of pending) if (p.expires < now - 5 * 60e3) pending.delete(id);
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
<style>body{margin:0;background:#14171A;color:#EDEFF1;font:17px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:24px 16px;}
.c{max-width:460px;margin:8vh auto;background:#1C2124;border:1px solid #353D43;border-radius:14px;padding:22px;}
h1{font-size:21px;margin:0 0 8px;} p{color:#A3ABB3;margin:6px 0;} b{color:#EDEFF1;}
button{width:100%;min-height:52px;margin-top:16px;border:0;border-radius:10px;font:inherit;font-weight:700;cursor:pointer;}
.ok{background:#3FCF8E;color:#0b1f15;} .no{background:transparent;color:#A3ABB3;border:1px solid #353D43;}</style></head><body><div class="c">${body}</div></body></html>`;
}

function mount(app, deps) {
  const { publicBaseUrl } = deps || {};
  const limited = (() => { const hits = new Map(); return (k, n, ms) => { const now = Date.now(); const a = (hits.get(k) || []).filter(t => now - t < ms); a.push(now); hits.set(k, a); return a.length > n; }; })();

  // Step 2: send the Approve link. Needs the right token first.
  app.post('/admin/login/start', async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    if (!token || !sameSecret(req.get('X-Admin-Token') || '', token)) return res.status(403).json({ error: 'Not authorized.' });
    if (!emailConfirmOn()) return res.json({ ok: true, session: signSession(), emailOff: true });
    if (limited('login-start', 6, 15 * 60e3)) return res.status(429).json({ error: 'Too many sign-in emails. Wait 15 minutes.' });
    prune();
    const id = crypto.randomBytes(16).toString('hex');
    const approveToken = crypto.randomBytes(24).toString('base64url');
    const p = { approveToken, expires: Date.now() + LINK_MINUTES * 60e3, approved: false, ua: req.get('User-Agent') || '', ip: String(req.get('X-Forwarded-For') || req.socket.remoteAddress || '').split(',').pop().trim(), at: new Date().toISOString() };
    pending.set(id, p);
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
      pending.delete(id);
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
    pending.delete(String(req.query.id));     // the session is handed out once
    res.set('Cache-Control', 'no-store').json({ ok: true, session: p.session });
  });

  // Step 3: the link in the email. GET only shows a button.
  app.get('/admin/approve', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const t = String(req.query.t || '');
    const p = [...pending.values()].find(x => sameSecret(t, x.approveToken));
    if (!p || p.expires < Date.now()) return res.status(410).send(page('Link expired', '<h1>This link has expired</h1><p>Go back to the admin page and sign in again for a new one.</p>'));
    if (p.approved) return res.send(page('Approved', '<h1>Already approved ✓</h1><p>The admin page you were signing in on is now open.</p>'));
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
    const p = [...pending.values()].find(x => sameSecret(t, x.approveToken));
    if (!p || p.expires < Date.now()) return res.status(410).send(page('Link expired', '<h1>This link has expired</h1><p>Sign in again on the admin page for a new one.</p>'));
    if (!p.approved) { p.approved = true; p.session = signSession(); p.expires = Date.now() + 5 * 60e3; }
    res.send(page('Approved', '<h1>Approved ✓</h1><p>Go back to the admin page: it opens by itself in a few seconds.</p>'));
  });
}

module.exports = { mount, check, isAdmin, emailConfirmOn, adminEmail, signSession, verifySession, sameSecret };
