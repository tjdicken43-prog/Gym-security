// Smoke test: starts the website on a spare port with an empty, throwaway
// data folder and checks what a visitor (or Render) sees. No API keys, no
// email, no gyms needed. Run by GitHub Actions on every push and pull
// request; run it yourself with:  node smoke-test.js
//
// Checks: every page answers 200; /healthz answers; settings, logs and the
// setup notes are never served; the safety headers are on; the desk, lobby
// and signage screens can still be framed by a signage player.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'securityai-smoke-'));
delete process.env.ADMIN_TOKEN;
delete process.env.STRIPE_SECRET_KEY;
delete process.env.SMTP_HOST;
const quiet = console.warn;
console.warn = () => {};
const { start } = require('./server');
console.warn = quiet;

let failures = 0;
const ok = (good, what) => { console.log(`${good ? '[OK]  ' : '[FAIL]'} ${what}`); if (!good) failures++; };

(async () => {
  const server = start(0);
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = p => fetch(base + p, { redirect: 'manual' });
  try {
    const pages = fs.readdirSync(__dirname).filter(f => f.endsWith('.html')).sort();
    for (const p of pages) {
      const r = await get('/' + p);
      ok(r.status === 200, `/${p} answers 200 (got ${r.status})`);
    }
    const h = await get('/healthz');
    const hb = await h.json().catch(() => ({}));
    ok(h.status === 200 && hb.ok === true, `/healthz answers 200 with ok:true (got ${h.status})`);

    for (const p of ['/gyms.json', '/rtsp-zones.json', '/alert-log-test.json', '/PRE-LAUNCH.md', '/SETUP.md', '/package.json', '/render.yaml', '/.env', '/.env.example', '/%2e%2e/etc/passwd', '/node_modules/express/package.json']) {
      const r = await get(p);
      ok(r.status === 404 || r.status === 403, `${p} is not served (got ${r.status})`);
    }
    // Camera computers fetch these two straight from the site (pi-setup.sh, update.js).
    for (const p of ['/update.js', '/pi-setup.sh']) {
      const r = await get(p);
      ok(r.status === 200, `${p} is still served for camera computers (got ${r.status})`);
    }

    const a = await get('/admin.html');
    ok(a.headers.get('x-content-type-options') === 'nosniff', 'nosniff header on pages');
    ok(a.headers.get('x-frame-options') === 'SAMEORIGIN', 'admin page cannot be framed by another site');
    ok(/frame-ancestors 'self'/.test(a.headers.get('content-security-policy') || ''), "admin page has CSP frame-ancestors 'self'");
    ok(!!a.headers.get('referrer-policy'), 'Referrer-Policy header on pages');
    ok(!a.headers.get('x-powered-by'), 'no X-Powered-By header');
    for (const p of ['/lobby.html', '/desk.html', '/signage.html']) {
      const r = await get(p);
      ok(!r.headers.get('x-frame-options'), `${p} can still be shown in a signage player`);
    }
  } finally {
    server.close();
    fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
  }
  console.log(`\n${failures ? failures + ' problem(s) found.' : 'All smoke checks passed.'}`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
