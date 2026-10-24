// Admin 2FA test: the authenticator code (ADMIN_TOTP_SECRET) on the admin
// sign-in. Starts the website on a spare port with a throwaway data folder.
//   node admin-2fa-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'securityai-2fa-'));
process.env.ADMIN_TOKEN = 'test-admin-token-' + crypto.randomBytes(6).toString('hex');
delete process.env.SMTP_HOST;
delete process.env.STRIPE_SECRET_KEY;
const auth = require('./admin-auth');
const key = crypto.randomBytes(20);
process.env.ADMIN_TOTP_SECRET = auth.base32Encode(key);
const quiet = console.warn;
console.warn = () => {};
const { start } = require('./server');
console.warn = quiet;

let failures = 0;
const ok = (good, what) => { console.log(`${good ? '[OK]  ' : '[FAIL]'} ${what}`); if (!good) failures++; };
const step = () => Math.floor(Date.now() / 30e3);

(async () => {
  // RFC 6238 test vectors (SHA-1, last 6 digits).
  const rfc = Buffer.from('12345678901234567890');
  ok(auth.totpAt(rfc, 1) === '287082' && auth.totpAt(rfc, 37037036) === '081804', 'code maker matches RFC 6238');

  const server = start(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const T = process.env.ADMIN_TOKEN;
  const get = (p, h) => fetch(base + p, { headers: h || {} });
  const code = (c, tok) => fetch(base + '/admin/login/code', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': tok || T }, body: JSON.stringify({ code: c }) });

  let r = await get('/admin/overview', { 'X-Admin-Token': T });
  let b = await r.json().catch(() => ({}));
  ok(r.status === 403 && b.needCode === true, 'right token alone is refused and asks for the code');

  r = await get('/admin/overview', { 'X-Admin-Token': 'wrong' });
  b = await r.json().catch(() => ({}));
  ok(r.status === 403 && !b.needCode, 'wrong token gets no hint');

  r = await code(auth.totpAt(key, step()), 'wrong');
  ok(r.status === 403, 'a good code with the wrong token is refused');

  r = await code('000000' === auth.totpAt(key, step()) ? '111111' : '000000');
  ok(r.status === 401, 'a wrong code is refused');

  r = await code(auth.totpAt(key, step() - 5));
  ok(r.status === 401, 'an old code (2.5 minutes) is refused');

  const good = auth.totpAt(key, step());
  r = await code(good);
  b = await r.json().catch(() => ({}));
  ok(r.status === 200 && typeof b.session === 'string', 'token + current code gives a session');
  const session = b.session;

  r = await code(good);
  ok(r.status === 401, 'the same code cannot be used twice');

  r = await get('/admin/overview', { 'X-Admin-Token': T, 'X-Admin-Session': session });
  ok(r.status === 200, 'token + session opens the admin page');

  r = await get('/admin/overview', { 'X-Admin-Session': session });
  ok(r.status === 403, 'a session without the token is refused');

  r = await fetch(base + '/admin/login/start', { method: 'POST', headers: { 'X-Admin-Token': T } });
  b = await r.json().catch(() => ({}));
  ok(r.status === 400 && b.needCode && !b.session, 'the email step cannot skip the code');

  // Changing the secret signs every browser out.
  process.env.ADMIN_TOTP_SECRET = auth.base32Encode(crypto.randomBytes(20));
  r = await get('/admin/overview', { 'X-Admin-Token': T, 'X-Admin-Session': session });
  ok(r.status === 403, 'a new secret signs old sessions out');

  // Too many tries are slowed down.
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await code('123456')).status;
  ok(last === 429, 'too many tries are blocked for 15 minutes');

  // Off: no secret = old behaviour (no email set up = token alone).
  delete process.env.ADMIN_TOTP_SECRET;
  r = await get('/admin/overview', { 'X-Admin-Token': T });
  ok(r.status === 200, 'without ADMIN_TOTP_SECRET the old sign-in still works');

  server.close();
  console.log(failures ? `\n${failures} failed` : '\nAll admin 2FA checks passed');
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
