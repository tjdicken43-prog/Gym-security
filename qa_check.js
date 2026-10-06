const fs = require('fs');

function check(path){
  const html = fs.readFileSync(path, 'utf8');
  console.log(`\n=== ${path} ===`);

  // 1. JS syntax check (all <script> blocks concatenated)
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  try {
    new Function(scripts.join('\n;\n'));
    console.log('[OK] JS syntax valid');
  } catch(e){
    console.log('[FAIL] JS syntax error:', e.message);
  }

  // 2. Every getElementById('X') / getElementById("X") has a matching id="X" in the HTML
  // (skips calls with template-literal interpolation like `${id}` — those are dynamic
  // IDs resolved at runtime, not something a static check can meaningfully verify)
  const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
  const referenced = new Set(
    [...html.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)]
      .map(m => m[1])
      .filter(id => !id.includes('${'))
  );
  const missing = [...referenced].filter(id => !ids.has(id));
  console.log(missing.length ? `[FAIL] getElementById refs with no matching id=: ${missing.join(', ')}` : '[OK] All getElementById refs resolve');

  // 3. Duplicate ids (invalid HTML, first match wins silently otherwise)
  const idList = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]);
  const dupes = idList.filter((id, i) => idList.indexOf(id) !== i);
  console.log(dupes.length ? `[FAIL] Duplicate id attributes: ${[...new Set(dupes)].join(', ')}` : '[OK] No duplicate ids');

  // 4. Rough tag balance for structural tags
  ['div','section','button','label'].forEach(tag => {
    const open = (html.match(new RegExp(`<${tag}(\\s|>)`, 'g')) || []).length;
    const close = (html.match(new RegExp(`</${tag}>`, 'g')) || []).length;
    console.log(open === close ? `[OK] <${tag}> balanced (${open})` : `[FAIL] <${tag}> mismatch: ${open} open vs ${close} close`);
  });

  // 5. onclick/onchange handlers reference functions actually defined
  const handlers = [...html.matchAll(/on(?:click|change)=["']([a-zA-Z0-9_]+)\(/g)].map(m => m[1]);
  const fnDefs = new Set([...html.matchAll(/function\s+([a-zA-Z0-9_]+)\s*\(/g)].map(m => m[1]));
  const missingFns = [...new Set(handlers)].filter(fn => !fnDefs.has(fn));
  console.log(missingFns.length ? `[FAIL] onclick/onchange calls undefined function(s): ${missingFns.join(', ')}` : '[OK] All onclick/onchange handlers resolve to defined functions');
}

// Load-check every Node module, not just syntax-check it. `node --check`
// only parses; it cannot see that a name in module.exports was never
// defined. That exact gap shipped a crash-on-startup once — a file that
// parsed perfectly and threw ReferenceError the moment it was required.
function loadCheck(files) {
  const Module = require('module');
  const orig = Module._load;
  const stubs = {
    express: (() => { const f = () => { const app = () => {}; ['get','post','use','listen'].forEach(m => app[m] = () => ({ close(){} })); return app; };
      f.json = () => () => {}; f.raw = () => () => {}; f.static = () => () => {}; return f; })(),
    cors: () => () => {},
    stripe: () => ({}),
    dotenv: { config() {} },
    nodemailer: { createTransport: () => ({ sendMail: async () => {} }) },
    twilio: () => ({}),
  };
  Module._load = function (req, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req];
    return orig.apply(this, arguments);
  };
  let failed = 0;
  for (const f of files) {
    try { delete require.cache[require.resolve(f)]; require(f); console.log(`[OK] ${f} loads`); }
    catch (err) { failed++; console.log(`[FAIL] ${f} threw on load: ${err.message}`); }
  }
  Module._load = orig;
  return failed;
}

// Loads server.js against a stub express that RECORDS routes, then checks
// the runner routes exist, the exports are right, and require() did not
// start listening (Render's `node server.js` is the only path that should).
function routeCheck() {
  const Module = require('module');
  const orig = Module._load;
  const routes = []; let listened = 0;
  const express = () => {
    const app = () => {};
    app.use = () => {};
    app.get = (p) => { routes.push('GET ' + p); };
    app.post = (p) => { routes.push('POST ' + p); };
    app.listen = () => { listened++; return { close() {} }; };
    return app;
  };
  express.json = () => () => {}; express.raw = () => () => {}; express.static = () => () => {};
  const stubs = { express, cors: () => () => {}, stripe: () => ({}), dotenv: { config() {} },
    nodemailer: { createTransport: () => ({ sendMail: async () => {} }) }, twilio: () => ({}) };
  Module._load = function (req) {
    if (Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req];
    return orig.apply(this, arguments);
  };
  let failed = 0;
  const say = (ok, msg) => { if (!ok) failed++; console.log(`${ok ? '[OK]' : '[FAIL]'} ${msg}`); };
  try {
    const f = require.resolve('./server.js');
    delete require.cache[f];
    const srv = require(f);
    for (const r of ['POST /monitor/runner/heartbeat', 'POST /monitor/runner/burst', 'GET /monitor/status', 'GET /monitor/debug', 'GET /monitor/log',
      'GET /admin/overview', 'GET /admin/gyms/:gym/settings', 'POST /admin/gyms/:gym/settings', 'POST /admin/gyms/:gym/adopt',
      'POST /admin/gyms/:gym/new-code', 'POST /admin/gyms/:gym/unpair', 'POST /admin/test-alert', 'GET /gym/event/:id', 'GET /plans',
      'POST /monitor/runner/test', 'POST /admin/gyms/:gym/tests/:runId/compare']) {
      say(routes.includes(r), `route ${r}`);
    }
    say(srv && srv.app && typeof srv.start === 'function', 'server.js exports { app, start }');
    say(listened === 0, 'require(\'./server\') does not listen');
    // getStatus() once shipped a ReferenceError (an undefined constant)
    // that load checks could not see because it only ran per request.
    try { require('./monitor').getStatus(); say(true, 'monitor.getStatus() runs'); }
    catch (e) { say(false, `monitor.getStatus() threw: ${e.message}`); }
  } catch (err) {
    say(false, `server.js route check threw: ${err.message}`);
  }
  Module._load = orig;
  return failed;
}

// Syntax-only check for scripts that do real work when run (they spawn
// ffmpeg, read config, or exit), so they are parsed but not required.
function syntaxCheck(files) {
  const { spawnSync } = require('child_process');
  let failed = 0;
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status === 0) console.log(`[OK] ${f} parses`);
    else { failed++; console.log(`[FAIL] ${f} syntax: ${(r.stderr || '').trim().split('\n').slice(0, 5).join(' | ')}`); }
  }
  return failed;
}

const fsx = require('fs');
const pathx = require('path');
process.chdir(__dirname);
const args = process.argv.slice(2);
let html = args.filter(a => a.endsWith('.html'));
let js = args.filter(a => a.endsWith('.js'));
const noArgs = !args.length;
if (noArgs) {
  // No arguments: check everything. This used to print nothing at all.
  html = fsx.readdirSync(__dirname).filter(f => f.endsWith('.html')).sort();
  // Library modules: safe to require (no side effects beyond timers).
  js = ['server.js', 'monitor.js', 'vision.js', 'gyms.js', 'mailer.js', 'report.js', 'scheduler.js',
        'ingest.js', 'email-ingest.js', 'detect.js', 'rtsp.js'].filter(f => fsx.existsSync(f));
}
let failures = 0;
const origLog = console.log;
console.log = (...a) => { if (typeof a[0] === 'string' && a[0].startsWith('[FAIL]')) failures++; origLog(...a); };
html.forEach(check);
console.log = origLog;
if (js.length) { console.log(''); failures += loadCheck(js.map(f => f.startsWith('/') ? f : './' + f)); }
if (noArgs) {
  console.log('');
  const scripts = fsx.readdirSync(__dirname).filter(f => f.endsWith('.js') && !js.includes(f)).sort();
  failures += syntaxCheck(scripts);
  console.log('');
  failures += routeCheck();
}
console.log(`\n${failures ? failures + ' problem(s) found.' : 'All checks passed.'}`);
process.exitCode = failures ? 1 : 0;
