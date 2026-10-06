#!/usr/bin/env node
// Get the latest program onto this computer. Your settings are never touched.
//
//   node update.js          update from your website (the code you last deployed)
//   node update.js --undo   put back the version from before the last update
//
// Where things live:
//   ~/securityai/     the program (this is where every command is typed)
//   ~/.securityai/    your settings (camera, website pairing) and the log
//
// Run it from a freshly downloaded/unzipped folder and it copies that
// folder's program into ~/securityai instead (first install, or no internet).
// Run a lone copy (e.g. after: curl -O https://YOUR-SITE/update.js) on a
// brand-new computer and it pairs with the website, then downloads everything.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// These two are needed to talk to the website. On a brand-new computer
// (only update.js was downloaded) they are fetched first.
let RC, PC, remote;
function loadHelpers() {
  RC = require('./runner-config'); PC = require('./pairing-client'); remote = require('./runner-remote');
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CODE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(js|html|md|svg|txt|xml|yaml)$/;
const say = m => console.log(m);
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function isCodeFile(name) {
  if (!NAME_RE.test(name) || name.includes('..')) return false;
  if (/^(rtsp-zones|ingest-zones|gyms|report-sends|runner-pairings)\.json/i.test(name)) return false;
  return CODE_FILE_RE.test(name) || name === 'package.json' || /^[A-Za-z0-9-]+\.example\.json$/.test(name);
}
function codeHome() { return process.env.SECURITYAI_CODE_DIR || path.join(os.homedir(), 'securityai'); }
function tilde(p) { const h = os.homedir(); return p.startsWith(h + path.sep) ? '~' + p.slice(h.length) : p; }

// Does node accept this JavaScript? (Catches a truncated download.)
function jsOk(file) {
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  return r.status === 0;
}

// Copy the program files from one folder into ~/securityai.
// Returns { copied, dest }. Never copies settings, logs or secrets.
function installFromFolder(src, dest, opts) {
  const o = opts || {};
  dest = dest || codeHome();
  fs.mkdirSync(dest, { recursive: true });
  let copied = 0;
  for (const name of fs.readdirSync(src)) {
    if (!isCodeFile(name)) continue;
    const from = path.join(src, name);
    try { if (!fs.statSync(from).isFile()) continue; } catch (e) { continue; }
    const buf = fs.readFileSync(from);
    const to = path.join(dest, name);
    let same = false;
    try { same = sha256(fs.readFileSync(to)) === sha256(buf); } catch (e) { /* new */ }
    if (same) continue;
    fs.writeFileSync(to + '.new', buf);
    fs.renameSync(to + '.new', to);
    copied++;
  }
  // A .env (Anthropic API key) is NOT copied: the camera computer sends
  // crossings to the website, which holds the key. offerCleanup() below
  // offers to delete it instead.
  // dotenv is optional, but keep it if the download had it.
  const dotenv = path.join(src, 'node_modules', 'dotenv');
  if (fs.existsSync(dotenv) && !fs.existsSync(path.join(dest, 'node_modules', 'dotenv'))) {
    try { fs.cpSync(dotenv, path.join(dest, 'node_modules', 'dotenv'), { recursive: true }); } catch (e) { /* optional */ }
  }
  if (!o.quiet) say(`  Copied ${copied} program file(s) into ${tilde(dest)}`);
  return { copied, dest };
}

function readConfig(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) || {}; } catch (e) { return {}; }
}

// Downloads one file with the runner token (bootstrap: before helpers exist).
function fetchRaw(site, route, token) {
  const u = new URL(route, site);
  const lib = u.protocol === 'https:' ? require('https') : require('http');
  return new Promise(resolve => {
    const req = lib.request(u, { method: 'GET', headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'securityai-update/1' } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
      res.on('error', e => resolve({ status: 0, netError: e.code || e.message }));
    });
    req.setTimeout(75000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', e => resolve({ status: 0, netError: e.code || e.message }));
    req.end();
  });
}

async function updateFromWebsite(dest, cfgFile) {
  let cfg = readConfig(cfgFile);
  if (!cfg.serverUrl || !cfg.runnerToken) {
    say('This computer is not connected to your website yet.');
    const got = await PC.pairInteractive({});
    if (!got) process.exit(1);
    cfg = Object.assign(cfg, { gymCode: got.gymCode, serverUrl: got.serverUrl, runnerToken: got.runnerToken });
    if (cfg.dailyBurstCap == null) cfg.dailyBurstCap = 60;
    if (!Array.isArray(cfg.zones)) cfg.zones = [];
    RC.writePrivate(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  }
  say(`Checking ${cfg.serverUrl} for a newer version (up to a minute if it is asleep)...`);
  const m = await remote.getJson(cfg.serverUrl, `/monitor/runner/files${cfg.gymCode ? `?gym=${encodeURIComponent(cfg.gymCode)}` : ''}`, cfg.runnerToken, 75000);
  if (m.status !== 200 || !m.json || !Array.isArray(m.json.files)) {
    if (m.status === 401) say('The website does not recognise this computer (pairing lost). Do this: node pair.js, then node update.js again.');
    else if (m.status === 404) say('Your website is an older version without updates. Deploy the latest code to Render first (it adds this).');
    else say('Could not get the update: ' + (m.status ? `the website said ${m.status}` : PC.explainNet(m, cfg.serverUrl)));
    process.exit(1);
  }
  if (m.json.gymKnown === false) {
    say(`\n!! Your settings say gym code "${cfg.gymCode}", which is not set up on the website, so it would refuse the crossings.`);
    say('!! Do this: on your phone, admin page > "Connect a camera computer" > Get a code, then type:  cd ~/securityai  and  node pair.js\n');
  }
  const files = m.json.files.filter(f => f && isCodeFile(f.name) && /^[0-9a-f]{64}$/.test(f.sha256));
  const changed = files.filter(f => {
    try { return sha256(fs.readFileSync(path.join(dest, f.name))) !== f.sha256; } catch (e) { return true; }
  });
  if (!changed.length) { say(`Already up to date (version ${m.json.version}). Nothing changed.`); return { changed: 0 }; }

  const fresh = !fs.existsSync(path.join(dest, 'rtsp-run.js'));
  say(fresh ? `Downloading the program (${changed.length} files)...` : `Downloading ${changed.length} changed file(s)...`);
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'securityai-update-'));
  try {
    for (const f of changed) {
      const r = await fetchRaw(cfg.serverUrl, `/monitor/runner/files/${encodeURIComponent(f.name)}`, cfg.runnerToken);
      if (r.status !== 200 || sha256(r.body) !== f.sha256) {
        say(`Download of ${f.name} failed or arrived damaged. Nothing was changed. Try again in a minute.`);
        process.exit(1);
      }
      fs.writeFileSync(path.join(staging, f.name), r.body);
      if (f.name.endsWith('.js') && !jsOk(path.join(staging, f.name))) {
        say(`${f.name} from the website does not run on this computer's Node ${process.version}. Nothing was changed.`);
        process.exit(1);
      }
    }
    // Keep the files being replaced, for --undo.
    const keep = RC.statePath('previous-version');
    fs.rmSync(keep, { recursive: true, force: true });
    fs.mkdirSync(keep, { recursive: true });
    for (const f of changed) {
      const cur = path.join(dest, f.name);
      if (fs.existsSync(cur)) fs.copyFileSync(cur, path.join(keep, f.name));
      else fs.writeFileSync(path.join(keep, f.name + '.was-new'), '');
    }
    fs.mkdirSync(dest, { recursive: true });
    for (const f of changed) {
      const to = path.join(dest, f.name);
      fs.copyFileSync(path.join(staging, f.name), to + '.new');
      fs.renameSync(to + '.new', to);
    }
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  say(fresh ? `Downloaded the program (${changed.length} files).` : `Updated ${changed.length} file(s) to version ${m.json.version}. Your settings were not touched.`);
  return { changed: changed.length };
}

function undo(dest) {
  const keep = RC.statePath('previous-version');
  let names = [];
  try { names = fs.readdirSync(keep); } catch (e) { /* none */ }
  if (!names.length) { say('There is no earlier version to go back to.'); process.exit(1); }
  for (const n of names) {
    if (n.endsWith('.was-new')) { fs.rmSync(path.join(dest, n.slice(0, -8)), { force: true }); continue; }
    if (!isCodeFile(n)) continue;
    fs.copyFileSync(path.join(keep, n), path.join(dest, n));
  }
  fs.rmSync(keep, { recursive: true, force: true });
  say(`Went back to the previous version (${names.length} file(s)). Settings not touched.`);
}

// How to get to the program folder from where this Terminal window is.
// (Captured at start: the folder may be deleted by offerCleanup below.)
const SHELL_CWD = (() => { try { return process.cwd(); } catch (e) { return null; } })();
function cdLine() { return 'cd ~/securityai'; }

// An old copy of the program (Friday's ~/Downloads/Gym-security-main) is
// not used any more, but it can still hold the Anthropic API key (.env),
// old photos, and the old program (which must not be run by mistake). On
// a borrowed laptop none of that should stay. Only a folder that is
// clearly an old copy of this program, whose settings have already been
// moved to ~/.securityai, is offered for deletion.
function oldFolderInfo(dir, dest, cfgFile, forWipe) {
  const d = path.resolve(dir);
  if (d === path.resolve(dest) || d === os.homedir() || d === path.parse(d).root || d === path.dirname(path.resolve(cfgFile))) return null;
  if (!['rtsp-run.js', 'server.js', 'package.json'].every(n => fs.existsSync(path.join(d, n)))) return null;
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')); } catch (e) { return null; }
  if (!/securityai/i.test(String(pkg.name || ''))) return null;
  if (!forWipe && fs.existsSync(path.join(d, 'rtsp-zones.json'))) return null;      // settings still here: keep
  if (fs.existsSync(path.join(d, 'pairing-client.js'))) return null;    // a new download, not an old copy
  let key = false;
  try { key = /ANTHROPIC_API_KEY\s*=\s*['"]?\S/.test(fs.readFileSync(path.join(d, '.env'), 'utf8')); } catch (e) { /* no .env */ }
  let photos = 0;
  const count = (p, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (e.isDirectory() && depth < 3 && e.name !== 'node_modules') count(path.join(p, e.name), depth + 1);
      else if (/\.jpe?g$/i.test(e.name)) photos++;
    }
  };
  count(d, 0);
  return { dir: d, key, photos };
}

// Old copies: the folder update.js ran from, the Terminal's folder, and
// one level inside Downloads (where a GitHub zip lands). Not Desktop or
// Documents: on a Mac that pops up a "would like to access" question.
function oldFolders(dirs, dest, cfgFile, forWipe) {
  const all = new Set(dirs.filter(Boolean).map(d => path.resolve(d)));
  for (const base of ['Downloads'].map(b => path.join(os.homedir(), b))) {
    let ents = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.')) all.add(path.join(base, e.name));
  }
  return [...all].map(d => oldFolderInfo(d, dest, cfgFile, forWipe)).filter(Boolean);
}

async function offerCleanup(dirs, dest, cfgFile) {
  for (const info of oldFolders(dirs, dest, cfgFile)) await offerCleanupOne(info);
}
async function offerCleanupOne(info) {
  const what = [info.key ? 'your Anthropic API key (the .env file)' : null, info.photos ? `${info.photos} old photo(s)` : null, 'the old program'].filter(Boolean);
  say(`\nThe old folder ${tilde(info.dir)} is not used any more.`);
  say(`It still has ${what.join(', ').replace(/, ([^,]*)$/, ' and $1')} in it.`);
  if (info.key) say('This laptop does not need the key any more: the website does the counting now.');
  if (!process.stdin.isTTY) { say(`Delete it when you can (it is safe to):  rm -rf "${info.dir}"`); return; }
  const a = (await PC.simpleAsk('Delete the old folder now? (Y/n)', '')).toLowerCase();
  if (!a.startsWith('n')) {
    try { fs.rmSync(info.dir, { recursive: true, force: true }); say(`  Deleted ${tilde(info.dir)}.`); return; } catch (e) {
      say(`  Could not delete it (${e.code || e.message}). Drag it to the Trash in Finder instead.`);
    }
  }
  if (info.key && fs.existsSync(path.join(info.dir, '.env'))) {
    const b = (await PC.simpleAsk('Delete just the API key file (.env) then? (Y/n)', '')).toLowerCase();
    if (!b.startsWith('n')) { try { fs.rmSync(path.join(info.dir, '.env'), { force: true }); say('  Deleted the API key file.'); } catch (e) { say(`  Could not delete it: ${e.message}`); } }
  }
}

// Settings are missing or would watch the wrong thing: explain, then offer
// to start the camera setup right here (one less thing to type).
async function offerSetup(dest, cfgFile, problems) {
  if (problems && problems.length) {
    // Friday's settings (no channel = the pro shop camera, the whole 4K
    // picture) would run "fine" and count nothing useful. Fix them first.
    say('\n!! The camera settings on this computer need fixing first:');
    for (const p of problems) say(`!!   - ${p.replace(/Do this:.*$/, '').trim()}`);
    say('!! The camera setup fixes that with a few questions.');
  } else say('\nNext, set up the camera.');
  if (process.stdin.isTTY && !process.argv.includes('--no-setup') && fs.existsSync(path.join(dest, 'setup-camera.js'))) {
    const a = (await PC.simpleAsk('Start the camera setup now? (Y/n)', '')).toLowerCase();
    if (!a.startsWith('n')) {
      say('');
      const env = Object.assign({}, process.env, { SECURITYAI_SHELL_CWD: SHELL_CWD || '' });
      const res = spawnSync(process.execPath, [path.join(dest, 'setup-camera.js')], { stdio: 'inherit', cwd: dest, env });
      process.exit(res.status == null ? 1 : res.status);
    }
  }
  say(`\nWhen you are ready, type these two lines:\n\n    ${cdLine()}\n    node setup-camera.js\n`);
}

// What the monitor would complain about with these settings, using the
// runner's own checker from the NEW code. [] = ready for the background.
function settingsProblems(dest, cfgFile) {
  let rc;
  try {
    const f = require.resolve(path.join(dest, 'runner-config.js'));
    delete require.cache[f];
    rc = require(f);
  } catch (e) { return []; }
  if (!rc.loadConfig) return [];
  const r = rc.loadConfig(cfgFile);
  if (r.errors && r.errors.length) return r.errors.map(e => e.split('\n')[0]);
  return rc.setupProblems ? rc.setupProblems(r.cfg) : [];
}

async function afterwards(dest, cfgFile) {
  let svc = null, bg = false;
  try { svc = require(path.join(dest, 'install-service.js')); bg = svc.isInstalled(); } catch (e) { /* none */ }
  const cfg = readConfig(cfgFile);
  const ready = Array.isArray(cfg.zones) && cfg.zones.length;
  const problems = ready ? settingsProblems(dest, cfgFile) : [];
  if (!ready || problems.length) {
    if (bg && problems.length) say('\n(The background monitor is NOT watching with these settings - the website says so too.)');
    return offerSetup(dest, cfgFile, problems);
  }
  if (bg) { say('The background monitor restarts on this version by itself within a minute.'); return; }
  if (svc && ready && process.stdin.isTTY && !process.argv.includes('--no-service') && ['darwin', 'linux'].includes(process.env.SECURITYAI_PLATFORM || process.platform)) {
    say('\nThe monitor can run in the background: it starts by itself when this computer starts');
    say('and restarts itself if anything goes wrong. (Undo any time: node install-service.js --remove)');
    const a = (await PC.simpleAsk('Switch that on now? (Y/n)', '')).toLowerCase();
    if (!a.startsWith('n')) {
      let running = null;
      try { running = RC.runningMonitor ? RC.runningMonitor() : null; } catch (e) { /* none */ }
      if (running) say('First stop the monitor that is running in the other window (Ctrl-C there) - the background one then takes over by itself.');
      if (svc.install({}).ok) { say(`Watch it any time with:  ${cdLine()}  then  node rtsp-run.js`); return; }
    }
  }
  if (ready) say(`If the monitor is running in a window: press Ctrl-C there, then type  node rtsp-run.js`);
}

// Brand-new computer with only update.js: fetch the two helper files first,
// using a pairing, so the normal path below can run.
async function bootstrap(dest) {
  const need = ['runner-config.js', 'pairing-client.js', 'runner-remote.js'];
  if (need.every(n => fs.existsSync(path.join(__dirname, n)))) return false;
  if (need.every(n => fs.existsSync(path.join(dest, n)))) {
    // A full install exists: use its helpers.
    RC = require(path.join(dest, 'runner-config.js'));
    PC = require(path.join(dest, 'pairing-client.js'));
    remote = require(path.join(dest, 'runner-remote.js'));
    return true;
  }
  say('Setting up SecurityAI on this computer.');
  // An old install next to us (or in the folder you are in) may already be
  // connected: try its website + token first, so no pairing code is needed.
  for (const dir of [__dirname, process.cwd()]) {
    let old = null;
    try { old = JSON.parse(fs.readFileSync(path.join(dir, 'rtsp-zones.json'), 'utf8').replace(/^\uFEFF/, '')); } catch (e) { continue; }
    if (!old || !old.serverUrl || !old.runnerToken) continue;
    say(`Using the website connection from your old settings (${old.serverUrl})...`);
    const got = [];
    for (const n of need) {
      const r = await fetchRaw(old.serverUrl, `/monitor/runner/files/${n}`, old.runnerToken);
      if (r.status !== 200) break;
      got.push([n, r.body]);
    }
    if (got.length !== need.length) { say('  (That connection no longer works - pairing instead.)'); break; }
    fs.mkdirSync(dest, { recursive: true });
    for (const [n, body] of got) fs.writeFileSync(path.join(dest, n), body);
    RC = require(path.join(dest, 'runner-config.js'));
    PC = require(path.join(dest, 'pairing-client.js'));
    remote = require(path.join(dest, 'runner-remote.js'));
    return true;
  }
  say('You need two things: your website address, and a pairing code');
  say('(on your phone: admin page > "Connect a camera computer" > Get a code - 6 numbers, works once).\n');
  const readline = require('readline');
  const ask = q => new Promise(r => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    rl.on('close', () => { if (!done) { done = true; r(''); } });      // Ctrl-D / input ended
    rl.question(q, a => { done = true; rl.close(); r(a.trim()); });
  });
  // Same rules as pairing-client.normaliseSite (that file isn't here yet).
  const siteOf = raw0 => {
    const raw = String(raw0 || '').trim().replace(/\s+/g, '').replace(/[\u201c\u201d\u2018\u2019"'<>]/g, '');
    const plainHttp = /^http:\/\//i.test(raw);
    let host = raw.replace(/^([a-z]{2,6})?[:;]*\/\//i, '').replace(/[\/?#].*$/, '').toLowerCase().replace(/\.+$/, '');
    if (!host) return null;
    const local = /^(localhost|127\.|10\.|192\.168\.)/.test(host);
    if (!host.includes('.') && !local) host += '.onrender.com';
    if (/\.onrender\.co$/.test(host)) host += 'm';
    return `${local && plainHttp ? 'http' : 'https'}://${host}`;
  };
  const post = (site, body) => new Promise(resolve => {
    const data = Buffer.from(JSON.stringify(body));
    let req;
    try {
      req = require(site.startsWith('https:') ? 'https' : 'http').request(new URL('/monitor/runner/pair', site), { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
        const c = []; res.on('data', x => c.push(x)); res.on('end', () => {
          let j = null; try { j = JSON.parse(Buffer.concat(c).toString()); } catch (e) { /* not JSON */ }
          resolve(j && typeof j === 'object' ? Object.assign({ status: res.statusCode }, j)
            : { status: res.statusCode, error: res.statusCode === 404 ? `${site} answered, but it is not the SecurityAI website (or it is still deploying).` : `The website said ${res.statusCode}.` });
        });
      });
    } catch (e) { return resolve({ status: 0, error: `That is not a website address.` }); }
    req.setTimeout(75000, () => req.destroy(Object.assign(new Error('no answer within a minute'), { code: 'no answer within a minute' })));
    req.on('error', e => resolve({ status: 0, error: /ENOTFOUND|EAI_AGAIN/.test(e.code || '') ? `Cannot find ${site}. Check the spelling, and that this computer is on the internet.` : `Could not reach ${site} (${e.code || e.message}).` }));
    req.end(data);
  });
  let site = null, pr = null;
  for (let tries = 0; tries < 3 && !(pr && pr.ok); tries++) {
    if (!site) {
      site = siteOf(await ask('Website address (e.g. gym-security.onrender.com): '));
      if (!site) { say('  Type the address like gym-security.onrender.com'); continue; }
    }
    const code = (await ask('Pairing code (6 numbers): ')).replace(/\D/g, '');
    if (code.length !== 6) { say('  A pairing code is 6 numbers, like 482 193.'); continue; }
    say(`  Contacting ${site} (up to a minute if it is asleep)...`);
    pr = await post(site, { code, host: os.hostname() });
    if (!pr.ok) {
      say('  ' + (pr.error || 'Pairing failed.'));
      if (pr.status === 0 || pr.status === 404) site = null;          // wrong address: ask again
      if (pr.status === 429 || pr.status === 503) break;
    }
  }
  if (!pr || !pr.ok) {
    say(pr && pr.status === 503 ? '\nNot connected. Fix that on Render first (wait until it says Live), then type  node update.js  again.'
      : pr && pr.status === 429 ? '\nNot connected. Wait 15 minutes, make a new code on the admin page, then type  node update.js  again.'
      : '\nNot connected. Get a fresh code on the admin page and type  node update.js  again.');
    process.exit(1);
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const n of need) {
    const r = await fetchRaw(site, `/monitor/runner/files/${n}`, pr.runnerToken);
    if (r.status !== 200) { say(`Could not download ${n} (${r.status || r.netError}).`); process.exit(1); }
    fs.writeFileSync(path.join(dest, n), r.body);
  }
  RC = require(path.join(dest, 'runner-config.js'));
  PC = require(path.join(dest, 'pairing-client.js'));
  remote = require(path.join(dest, 'runner-remote.js'));
  const cfgFile = RC.resolveConfigPath({});
  const cfg = Object.assign(readConfig(cfgFile), { gymCode: pr.gymCode, serverUrl: site, runnerToken: pr.runnerToken });
  if (cfg.dailyBurstCap == null) cfg.dailyBurstCap = 60;
  if (!Array.isArray(cfg.zones)) cfg.zones = [];
  RC.writePrivate(cfgFile, JSON.stringify(cfg, null, 2) + '\n');
  say(`Paired ✓ with ${pr.gymName ? `"${pr.gymName}" (gym code ${pr.gymCode})` : `gym code "${pr.gymCode}"`}.`);
  return true;
}

async function main() {
  const dest = path.resolve(codeHome());
  const here = path.resolve(__dirname);
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    say(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const booted = await bootstrap(dest);
  if (!booted) loadHelpers();
  const cfgFile = RC.resolveConfigPath({ log: say, extraDirs: [here] });

  if (process.argv.includes('--undo')) { undo(dest); await afterwards(dest, cfgFile); return; }

  // Run from a downloaded folder (not ~/securityai): install that folder.
  // (pairing-client.js marks a download of THIS version; an old folder
  // that only got update.js added is updated from the website instead.)
  if (here !== dest && fs.existsSync(path.join(here, 'rtsp-run.js')) && fs.existsSync(path.join(here, 'pairing-client.js'))) {
    say(`Installing the program from ${tilde(here)} into ${tilde(dest)} ...`);
    installFromFolder(here, dest);
    say(`Settings: ${tilde(cfgFile)}${fs.existsSync(cfgFile) ? ' (kept)' : ' (none yet)'}`);
    say(`\nThe program is now in ${tilde(dest)}. From now on, always start by typing:  cd ~/securityai`);
    say(`(You can delete ${tilde(here)} and the zip now.)`);
    await offerCleanup([SHELL_CWD], dest, cfgFile);
    await afterwards(dest, cfgFile);
    return;
  }
  const r = await updateFromWebsite(dest, cfgFile);
  if (here !== dest) {
    say(`\nThe program is now in ${tilde(dest)}. From now on, always start by typing:  cd ~/securityai`);
    await offerCleanup([here, SHELL_CWD], dest, cfgFile);
  }
  const cfg = readConfig(cfgFile);
  if (!Array.isArray(cfg.zones) || !cfg.zones.length || settingsProblems(dest, cfgFile).length || r.changed) await afterwards(dest, cfgFile);
}

// Old copies of the program in Downloads (for install-service.js --wipe).
function oldCopies(dest) {
  const cfg = path.join(process.env.SECURITYAI_HOME || path.join(os.homedir(), '.securityai'), 'rtsp-zones.json');
  let here = null;
  try { here = process.cwd(); } catch (e) { /* folder deleted */ }
  return oldFolders([here], dest || codeHome(), cfg, true).map(i => i.dir);
}

module.exports = { installFromFolder, isCodeFile, codeHome, oldCopies };

if (require.main === module) {
  main().catch(err => {
    console.error('\nThe update stopped: ' + (err && err.message));
    console.error('Nothing half-done is left behind. Send a photo of this screen if it keeps happening.');
    process.exit(1);
  });
}
