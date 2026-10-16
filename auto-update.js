// Safe self-update for the camera computer (Pi or laptop), in the
// background service only.
//
//  - The website says which program version it has (in every heartbeat
//    answer). When this computer is behind, it updates ONLY when the door is
//    quiet: no movement for 20 minutes and nothing waiting to be sent.
//  - update.js --auto downloads the changed files, checks each one arrived
//    whole and runs on this Node, and keeps the old ones (previous-version).
//  - After the restart, the new version must check in with the website. If
//    it keeps crashing (3 starts) or can't check in for 15 minutes when the
//    old one could, the old files are put back by themselves, that version
//    is skipped, and the admin page says so. Settings are never touched.
//
// Turn it off on one computer: "autoUpdate": false in rtsp-zones.json, or
// SECURITYAI_AUTO_UPDATE=0. Only plain Node modules here: this runs first.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = () => process.env.SECURITYAI_HOME || path.join(os.homedir(), '.securityai');
const STATE = () => path.join(HOME(), 'auto-update.json');
const PREV = () => path.join(HOME(), 'previous-version');
const QUIET_MS = Number(process.env.SECURITYAI_UPDATE_QUIET_MS) || 20 * 60e3;
const CONFIRM_MS = Number(process.env.SECURITYAI_UPDATE_CONFIRM_MS) || 2 * 60e3;
const GIVE_UP_MS = Number(process.env.SECURITYAI_UPDATE_GIVEUP_MS) || 15 * 60e3;
const CODE = () => path.resolve(process.env.SECURITYAI_CODE_DIR || path.join(os.homedir(), 'securityai'));
const RETRY_MS = 6 * 3600e3;          // one try per version every 6 hours at most
const MAX_BOOTS = 3;

function load() {
  try { const s = JSON.parse(fs.readFileSync(STATE(), 'utf8')); return s && typeof s === 'object' ? s : {}; } catch (e) { return {}; }
}
function save(s) {
  try {
    fs.mkdirSync(HOME(), { recursive: true, mode: 0o700 });
    const tmp = `${STATE()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, STATE());
  } catch (e) { /* best effort */ }
}
const bootedAt = Date.now();
let log = () => {};
let note = () => {};

// Put the files from before the last update back (same as update.js --undo).
function rollback(reason) {
  const s = load();
  const p = s.pending || {};
  let names = [];
  try { names = fs.readdirSync(PREV()); } catch (e) { /* none */ }
  const dest = CODE();
  let n = 0;
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) continue;
    try {
      if (name.endsWith('.was-new')) { fs.rmSync(path.join(dest, name.slice(0, -8)), { force: true }); continue; }
      fs.copyFileSync(path.join(PREV(), name), path.join(dest, name + '.old'));
      fs.renameSync(path.join(dest, name + '.old'), path.join(dest, name));
      n++;
    } catch (e) { /* keep going */ }
  }
  try { fs.rmSync(PREV(), { recursive: true, force: true }); } catch (e) { /* ignore */ }
  s.skip = [...new Set([].concat(s.skip || [], p.version ? [p.version] : []))].slice(-10);
  s.installed = s.before || null;
  s.lastRollback = { version: p.version || null, at: new Date().toISOString(), reason, files: n };
  delete s.pending;
  save(s);
  return n;
}

// First thing at start (background service only): count starts after an
// update; too many = the new version keeps crashing, so go back.
function boot(opts) {
  const o = opts || {};
  if (!o.service) return;
  const s = load();
  if (!s.pending) return;
  s.pending.boots = (s.pending.boots || 0) + 1;
  save(s);
  if (s.pending.boots > MAX_BOOTS) {
    const n = rollback(`it stopped by itself ${MAX_BOOTS} times after updating`);
    try { process.stderr.write(`Update to version ${s.pending.version} kept stopping: went back to the previous version (${n} files). Starting again...\n`); } catch (e) { /* ignore */ }
    process.exit(1);          // the service starts the old version again
  }
}

// After start: wire up logging, and watch the new version prove itself.
function start(opts) {
  const o = opts || {};
  log = o.log || log; note = o.note || note;
  const s = load();
  if (s.lastRollback && Date.now() - Date.parse(s.lastRollback.at) < 24 * 3600e3) {
    note(`The automatic update to version ${s.lastRollback.version} didn't work on this computer (${s.lastRollback.reason}), so it went back to the previous version by itself. It won't try that version again. Nothing to do here.`, 24 * 3600e3);
  }
  const t = setInterval(() => {
    const st = load();
    const p = st.pending;
    if (!p) return;
    const since = Date.now() - Date.parse(p.at);
    // Couldn't check in for 15 minutes after the update, although the old
    // version could just before it: go back.
    if (!p.beatOk && since > GIVE_UP_MS && p.prevBeatOk) {
      const n = rollback('it could not check in with the website');
      log(`Update to version ${p.version} could not check in with the website: went back to the previous version (${n} files).`);
      if (o.restart) o.restart();
    }
  }, Number(process.env.SECURITYAI_UPDATE_TICK_MS) || 60e3);
  if (t.unref) t.unref();
}

// Every heartbeat answer: { ok, json: { codeVersion, withinSchedule } }.
// quiet(): true when nothing has moved at the door for a while.
let running = false;
function onHeartbeat(r, ctx) {
  const c = ctx || {};
  const s = load();
  const ok = !!(r && r.ok);
  if (ok) {
    s.lastBeatOkAt = new Date().toISOString();
    const p = s.pending;
    if (p) {
      const at = Date.parse(p.at);
      // Restarted on the new version and checking in for 2 minutes, or the
      // update changed nothing this program runs (no restart came): keep it.
      const restartedOnIt = bootedAt > at && Date.now() - bootedAt >= CONFIRM_MS;
      const noRestartNeeded = bootedAt < at && Date.now() - at > 90e3;
      if (restartedOnIt || noRestartNeeded) {
        s.history = [].concat(s.history || [], [{ version: p.version, at: p.at, ok: true }]).slice(-10);
        log(`Update to version ${p.version} is working: kept.`);
        delete s.pending;
      }
    }
    save(s);
  }
  if (!ok || !r.json || !r.json.codeVersion) return;
  const want = String(r.json.codeVersion);
  if (!c.service || c.enabled === false || process.env.SECURITYAI_AUTO_UPDATE === '0') return;
  if (running || s.pending || want === s.installed || (s.skip || []).includes(want)) return;
  if (s.lastTry && s.lastTry.version === want && Date.now() - Date.parse(s.lastTry.at) < RETRY_MS) return;
  // Only the installed program updates itself (not a copy run from Downloads).
  if (path.resolve(__dirname) !== CODE() || !fs.existsSync(path.join(__dirname, 'update.js'))) return;
  if (!(c.quiet ? c.quiet(QUIET_MS) : true)) return;
  run(want, s);
}

function run(want, s) {
  running = true;
  s.lastTry = { version: want, at: new Date().toISOString() };
  const before = s.installed || null;
  const prevBeatOk = !!(s.lastBeatOkAt && Date.now() - Date.parse(s.lastBeatOkAt) < 10 * 60e3);
  save(s);
  log(`A newer version (${want}) is on the website and the door is quiet: updating...`);
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [path.join(__dirname, 'update.js'), '--auto'], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  let out = '';
  child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
  const killer = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } }, 5 * 60e3);
  child.on('exit', code => {
    clearTimeout(killer);
    running = false;
    const st = load();
    const lastLine = out.trim().split('\n').pop() || '';
    if (code === 10) {
      st.before = before;
      st.pending = { version: st.installed || want, at: new Date().toISOString(), boots: 0, beatOk: false, prevBeatOk };
      save(st);
      log(`Updated to version ${st.pending.version}. Restarting to use it (about 10 seconds).`);
    } else if (code === 0) {
      log(`Already up to date (${st.installed || want}).`);
    } else {
      log(`The automatic update didn't finish (${lastLine.slice(0, 160)}). The current version keeps running; it tries again later.`);
    }
  });
}

// For the heartbeat: what the admin page shows about updates here.
function summary() {
  const s = load();
  return {
    installed: s.installed || null,
    pending: s.pending ? { version: s.pending.version, at: s.pending.at } : null,
    lastRollback: s.lastRollback || null,
    lastUpdate: (s.history || []).slice(-1)[0] || null,
  };
}

// Called by update.js --auto when it finishes.
function recordInstalled(version) { const s = load(); s.installed = version; save(s); }

module.exports = { boot, start, onHeartbeat, summary, rollback, recordInstalled, _load: load, _save: save };
