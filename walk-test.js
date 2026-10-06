// The 5-minute accuracy test, run on the camera computer:
//
//   node rtsp-run.js --test            (options: --wait 90  --gap 30  --zone "Front Door"  --quiet)
//
// It walks you through a short script of walks at the real door, one at a
// time, and at the end prints a scorecard: were the walks noticed (motion
// detection), were the people counted right (the AI), were the tailgates
// caught, any false alarms. It also sends the scorecard to the website
// (admin page) and saves every test walk's photos + answer + what should
// have happened in camera-check/test-<date>/ (and a .zip of it to send).
//
// It never opens a second camera connection: it asks the monitor that is
// already running (the background one, or one in another window) to mark
// the next crossings as test walks, or, if none is running, starts one
// just for the test and stops it again at the end. Test crossings are
// counted by the website like real ones but never alert anyone, never show
// on the gym's activity page or report, and don't use the daily limit.
//
// The two sides talk through small files in ~/.securityai:
//   walk-test.json          written by the test: which walk is "live" now
//   walk-test-events.jsonl  written by the monitor: motion, crossings, answers
//   monitor-status.json     written by the monitor every few seconds
//
// Node built-ins only.

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');
const acc = require('./accuracy');
const RC = require('./runner-config');

const SESSION_FILE = () => RC.statePath('walk-test.json');
const EVENTS_FILE = () => RC.statePath('walk-test-events.jsonl');
const STATUS_FILE = () => RC.statePath('monitor-status.json');
const SESSION_STALE_MS = 20000;   // the test rewrites the session file every 3 s
const STATUS_STALE_MS = 20000;    // the monitor rewrites its status every 5 s
const DIR_RE = /^test-\d{4}-\d{2}-\d{2}-\d{4}(-\d{2})?$/;
const WALK_DIR_RE = /^walk-\d{2}-[a-z-]{3,30}(-try\d{1,2})?$/;
const pad2 = n => String(n).padStart(2, '0');

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } }
function writeJson(file, obj) {
  try { RC.ensureStateDir(); } catch (e) { /* custom path */ }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// =====================================================================
// 1. The monitor's side (used inside rtsp-run.js's watching process)
// =====================================================================
function monitorLink(opts) {
  const codeDir = opts.codeDir;
  let cache = { at: 0, v: null };
  const counts = new Map();      // runId -> crossings sent (analyses asked for)
  const seqs = new Map();        // runId|trial -> last seq
  const dirs = new Map();        // runId -> absolute test folder
  const walkDirs = new Map();    // runId|trial -> that walk's sub-folder
  const walkPos = new Map();     // runId|trial -> walk number shown on screen

  function readSession() {
    const now = Date.now();
    if (now - cache.at < 300) return cache.v;
    let v = readJson(SESSION_FILE());
    if (!v || typeof v !== 'object' || !acc.RUN_ID_RE.test(String(v.runId)) || !DIR_RE.test(String(v.dir))
      || !(now - Number(v.updatedAt) < SESSION_STALE_MS)) v = null;
    cache = { at: now, v };
    return v;
  }
  return {
    // The test session for this camera, if a test is running. trial is set
    // only while a walk is "live" (armed and not yet over).
    session(label) {
      const s = readSession();
      if (!s || s.zone !== label) return null;
      const dir = path.join(codeDir, 'camera-check', s.dir);
      dirs.set(s.runId, dir);
      const t = s.trial;
      const live = t && Number.isInteger(t.n) && t.n >= 1 && t.n <= acc.MAX_TRIALS && Object.prototype.hasOwnProperty.call(acc.KINDS, t.kind) && Date.now() < Number(t.until);
      const trial = live ? { n: t.n, kind: t.kind, pos: Number.isInteger(t.pos) && t.pos > 0 && t.pos < 100 ? t.pos : t.n,
        sub: WALK_DIR_RE.test(String(t.sub)) ? t.sub : `walk-${pad2(t.n)}-${t.kind}` } : null;
      if (trial) walkPos.set(`${s.runId}|${trial.n}`, trial.pos);
      return { runId: s.runId, dir, cap: Math.min(acc.MAX_ANALYSES_PER_RUN, Number(s.cap) >= 0 ? Number(s.cap) : acc.MAX_ANALYSES_PER_RUN), trial };
    },
    // Next crossing number within a walk, or null when the walk already has
    // the most it may have, or the run has used its analyses.
    take(sess) {
      const k = `${sess.runId}|${sess.trial.n}`;
      const seq = (seqs.get(k) || 0) + 1;
      if (seq > acc.MAX_CROSSINGS_PER_TRIAL) return { capped: 'too-many' };
      const used = counts.get(sess.runId) || 0;
      if (used >= sess.cap) return { capped: 'limit' };
      seqs.set(k, seq);
      counts.set(sess.runId, used + 1);
      return { seq };
    },
    emit(obj) {
      try { fs.appendFileSync(EVENTS_FILE(), JSON.stringify(Object.assign({ at: Date.now() }, obj)) + '\n', { mode: 0o600 }); } catch (e) { /* the test just times out */ }
    },
    // Saves a test crossing's photos in the test folder; returns their names
    // relative to it.
    saveCrossing(sess, seq, framesB64, evidenceB64) {
      const sub = sess.trial.sub;
      walkDirs.set(`${sess.runId}|${sess.trial.n}`, sub);
      const out = { frames: [], larger: null };
      try {
        fs.mkdirSync(path.join(sess.dir, sub), { recursive: true });
        framesB64.forEach((b, i) => {
          const f = `${sub}/crossing-${seq}-photo-${i + 1}.jpg`;
          fs.writeFileSync(path.join(sess.dir, f), Buffer.from(b, 'base64'));
          out.frames.push(f);
        });
        if (evidenceB64) {
          const f = `${sub}/crossing-${seq}-larger.jpg`;
          fs.writeFileSync(path.join(sess.dir, f), Buffer.from(evidenceB64, 'base64'));
          out.larger = f;
        }
      } catch (e) { out.error = e.message; }
      return out;
    },
    // The website's answer for a test crossing: into the events file (for
    // the test on screen) and next to its photos (for the folder).
    verdict(test, v) {
      this.emit(Object.assign({ type: 'verdict', runId: test.runId, trial: test.trial, seq: test.seq }, v));
      const dir = dirs.get(test.runId);
      if (!dir) return;
      try {
        const sub = path.join(dir, walkDirs.get(`${test.runId}|${test.trial}`) || `walk-${pad2(test.trial)}-${test.expected}`);
        fs.mkdirSync(sub, { recursive: true });
        fs.writeFileSync(path.join(sub, `crossing-${test.seq}-answer.json`), JSON.stringify(Object.assign({
          expected: test.expected, expectedPeople: acc.KINDS[test.expected].people, instruction: acc.KINDS[test.expected].say,
        }, v), null, 1));
      } catch (e) { /* folder is a nicety */ }
    },
    posOf(test) { return walkPos.get(`${test.runId}|${test.trial}`) || test.trial; },
    writeStatus(obj) { try { writeJson(STATUS_FILE(), Object.assign({ pid: process.pid, at: Date.now(), testSupport: 1 }, obj)); } catch (e) { /* ignore */ } },
  };
}

// =====================================================================
// 2. The test itself (node rtsp-run.js --test)
// =====================================================================
const say = (...a) => console.log(...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const o = { wait: 60, gap: 20, zone: null, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wait') o.wait = Math.max(15, Math.min(300, Number(argv[++i]) || 60));
    else if (a === '--gap') o.gap = Math.max(3, Math.min(180, Number(argv[++i]) || 20));
    else if (a === '--zone') o.zone = String(argv[++i] || '');
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
  }
  if (process.env.WALKTEST_GAP_SEC) o.gap = Number(process.env.WALKTEST_GAP_SEC) || o.gap;      // testing aid
  if (process.env.WALKTEST_WAIT_SEC) o.wait = Number(process.env.WALKTEST_WAIT_SEC) || o.wait;  // testing aid
  return o;
}

// Spoken prompts on a Mac, for when you are at the gate and can't see the
// screen. Off with --quiet. Nothing on other computers.
let sayProc = null;
function speak(o, text) {
  if (o.quiet || process.platform !== 'darwin' || !process.stdout.isTTY) return;
  try { if (sayProc) sayProc.kill(); } catch (e) { /* done */ }
  try { sayProc = spawn('say', [text], { stdio: 'ignore' }); sayProc.on('error', () => {}); } catch (e) { /* no voice */ }
}
function bell() { if (process.stdout.isTTY) process.stdout.write('\x07'); }

function backgroundInstalled() {
  try { return require('./install-service').isInstalled(); } catch (e) { return false; }
}

// Finds the monitor that is watching (or starts one). Returns
// { how, child } or null after saying why.
async function findMonitor(label) {
  const pidFile = process.env.RUNNER_PID_FILE || RC.statePath('runner.pid');
  const started = Date.now();
  let child = null, childAt = 0, toldWaiting = false, toldOld = false;
  const tail = [];
  for (;;) {
    const other = RC.runningMonitor(pidFile);
    const st = readJson(STATUS_FILE());
    const fresh = st && other && st.pid === other.pid && Date.now() - st.at < STATUS_STALE_MS;
    if (fresh) {
      if (st.watching === false) {
        say(`✗ The monitor is not watching the door: ${st.problem || 'a setting needs fixing'}`);
        say('  Fix that first, then run the test again.');
        return null;
      }
      if (!st.remote) {
        say('✗ The accuracy test needs this computer connected to the website.');
        say('  Do this: on your phone, admin page > Connect a camera computer > Get a pairing code; then here: node pair.js');
        return null;
      }
      if (!(st.zones || []).some(z => z.label === label)) {
        say(`✗ The running monitor is not watching "${label}". Its cameras: ${(st.zones || []).map(z => z.label).join(', ') || 'none'}.`);
        return null;
      }
      say(child ? '✓ Monitor started for the test (it stops again at the end).'
        : other.service ? '✓ Using the monitor that runs in the background (no second camera connection).'
        : '✓ Using the monitor that is running in another window (no second camera connection).');
      return { how: child ? 'ours' : other.service ? 'background' : 'window', child };
    }
    if (child && child.exitCode != null) {
      say('✗ The monitor could not start. What it said:');
      for (const l of tail.slice(-12)) say(`   ${l}`);
      return null;
    }
    if (other && !fresh && Date.now() - started > 25000 && !toldOld) {
      toldOld = true;
      say(`The monitor that is running${other.service ? ' in the background' : ' in another window'} is an older version that can't do the test.`);
      say(other.service ? '  It restarts itself on the new version within a minute: waiting…' : '  Do this: press Ctrl-C in that window, then run  node rtsp-run.js --test  again.');
      if (!other.service) return null;
    }
    if (!other && !child) {
      if (backgroundInstalled() && Date.now() - started < 30000) {
        if (!toldWaiting) { say('The background monitor is starting up — waiting for it…'); toldWaiting = true; }
      } else {
        say('No monitor is running, so the test starts one (it stops again at the end)…');
        child = spawn(process.execPath, [path.join(__dirname, 'rtsp-run.js')], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
        childAt = Date.now();
        const grab = d => { for (const l of String(d).split('\n')) if (l.trim()) { tail.push(l); if (tail.length > 40) tail.shift(); } };
        child.stdout.on('data', grab); child.stderr.on('data', grab);
        child.on('error', e => tail.push(e.message));
      }
    }
    const limit = child ? childAt + 60000 : started + 70000;
    if (Date.now() > limit) {
      say(other ? '✗ The running monitor did not answer. Do this: node update.js, wait a minute, then try again.' : '✗ The monitor did not start in time.');
      for (const l of tail.slice(-8)) say(`   ${l}`);
      if (child) { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } }
      return null;
    }
    await sleep(1000);
  }
}

function zoneStatus(label) {
  const st = readJson(STATUS_FILE());
  if (!st || Date.now() - st.at > STATUS_STALE_MS) return null;
  return (st.zones || []).find(z => z.label === label) || null;
}

// ---------- zip (store + deflate, no extra programs needed) ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function listFiles(dir, base) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(listFiles(path.join(dir, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}
function zipFolder(dir, zipPath) {
  const root = path.basename(dir);
  const parts = [], central = [];
  let offset = 0;
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const rel of listFiles(dir, '')) {
    const data = fs.readFileSync(path.join(dir, rel));
    const name = Buffer.from(`${root}/${rel}`, 'utf8');
    const deflated = zlib.deflateRawSync(data);
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8); local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10); cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28); cen.writeUInt32LE(0o100644 << 16 >>> 0, 38); cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat(parts.concat([cenBuf, end])));
  return zipPath;
}

// ---------- the guided test ----------
async function run(argv) {
  const o = parseArgs(argv || []);
  if (o.help) {
    say('node rtsp-run.js --test              the 5-minute accuracy test (about 11 walks at the door)');
    say('   --wait 90     seconds to wait for each walk (default 60)');
    say('   --gap 30      seconds to get in place before each walk (default 20)');
    say('   --zone "Front Door"   which camera, if there are several');
    say('   --quiet       no spoken prompts (Mac)');
    return 0;
  }
  const { postJson, explainFailure } = require('./runner-remote');
  const line = '─'.repeat(60);
  say(`\n${line}\nSecurityAI accuracy test (about 5-10 minutes)\n${line}`);
  say('Only film people who agreed to it: yourself, or a coworker who said yes.');
  say('Pick a quiet moment: while the test runs, real crossings at this door are NOT watched.');
  say('');

  const CONFIG = process.env.RTSP_CONFIG || RC.resolveConfigPath({});
  const r = RC.loadConfig(CONFIG);
  if (!r.cfg) { for (const e of r.errors) say(`✗ ${e}`); return 1; }
  const cfg = r.cfg;
  if (!cfg.serverUrl || !cfg.runnerToken) {
    say('✗ The accuracy test needs this computer connected to the website.');
    say('  Do this: on your phone, admin page > Connect a camera computer > Get a pairing code; then here: node pair.js');
    return 1;
  }
  const zone = o.zone ? cfg.zones.find(z => z.label.toLowerCase() === o.zone.toLowerCase()) : cfg.zones[0];
  if (!zone) { say(`✗ No camera called "${o.zone}". Cameras: ${cfg.zones.map(z => `"${z.label}"`).join(', ')}`); return 1; }
  if (cfg.zones.length > 1 && !o.zone) say(`Testing "${zone.label}" (for another camera: node rtsp-run.js --test --zone "${cfg.zones[1].label}").`);

  // Clean up a test left behind by a crash, then find the monitor.
  try { fs.rmSync(SESSION_FILE(), { force: true }); } catch (e) { /* none */ }
  const mon = await findMonitor(zone.label);
  if (!mon) return 1;
  let child = mon.child;
  const stopChild = () => { if (child && child.exitCode == null) { try { child.kill('SIGTERM'); } catch (e) { /* gone */ } } };

  let sessionTimer = null;
  let session = null;
  const cleanup = () => {
    if (sessionTimer) clearInterval(sessionTimer);
    try { fs.rmSync(SESSION_FILE(), { force: true }); } catch (e) { /* gone */ }
    stopChild();
  };
  process.on('exit', cleanup);
  const onSig = () => { say('\nTest stopped. Nothing more is counted; the door is watched normally again.'); cleanup(); process.exit(130); };
  process.on('SIGINT', onSig); process.on('SIGTERM', onSig);

  // The camera picture must be coming through.
  let zs = zoneStatus(zone.label);
  if (!zs || !zs.streamOk) {
    say('Waiting for the camera picture…');
    const until = Date.now() + 60000;
    while (Date.now() < until && !((zs = zoneStatus(zone.label)) && zs.streamOk)) await sleep(1000);
    if (!zs || !zs.streamOk) {
      say(`✗ No picture from the camera${zs && zs.lastError ? `: ${zs.lastError}` : ''}.`);
      say('  This is a CAMERA problem, not the counting. Do this: node rtsp-run.js --check');
      cleanup(); return 1;
    }
  }
  say(`✓ ${zone.label}: picture is coming through${zs.fps ? ` (${zs.fps} pictures a second)` : ''}.`);

  // Tell the website.
  const runId = acc.newRunId();
  const startedAt = new Date().toISOString();
  say(`Contacting the website (can take up to a minute if it is asleep)…`);
  const st = await postJson(cfg.serverUrl, '/monitor/runner/test', cfg.runnerToken, { action: 'start', runId, zone: zone.label, host: os.hostname() });
  if (st.status !== 200 || !st.json || !st.json.ok) {
    say(`✗ ${st.json && st.json.error ? `The website said: ${st.json.error}` : explainFailure(st).msg.replace(' Will retry.', '')}`);
    if (st.status === 404) say('  The website may be an older version: deploy the new one on Render, then node update.js here.');
    cleanup(); return 1;
  }
  const W = st.json;
  if (!W.room) {
    say(`✗ The daily limit for tests is used up (${W.dailyTestCap} analyses a day, so tests can never cost more than pennies). Try again tomorrow.`);
    cleanup(); return 1;
  }
  const cap = W.room;
  say(`✓ Connected. ${W.gymName}, counting with ${W.modelName}.`);
  say(`Cost: this test counts at most ${cap} crossings: ${W.maxCostText} at most.`);
  say('Test walks send no alerts, do not show on the gym\'s activity page and do not use the gym\'s daily limit.');

  const folderName = acc.folderName(runId);
  const folder = path.join(__dirname, 'camera-check', folderName);
  fs.mkdirSync(folder, { recursive: true });
  try { fs.writeFileSync(EVENTS_FILE(), '', { mode: 0o600 }); } catch (e) { /* created by the monitor */ }
  let evPos = 0;

  session = { runId, zone: zone.label, dir: folderName, cap, trial: null, updatedAt: Date.now() };
  const writeSession = () => { session.updatedAt = Date.now(); try { writeJson(SESSION_FILE(), session); } catch (e) { /* retried in 3 s */ } };
  writeSession();
  sessionTimer = setInterval(writeSession, 3000);

  // Keyboard: Enter = skip, r = redo the last one, q = stop.
  const cmds = [];
  const rl = require('readline').createInterface({ input: process.stdin });
  rl.on('line', l => { const t = l.trim().toLowerCase(); cmds.push(t === '' ? 'skip' : t[0] === 'r' ? 'redo' : t[0] === 'q' ? 'quit' : 'other'); });
  const takeCmd = () => { while (cmds.length) { const c = cmds.shift(); if (c === 'other') { say('   (Enter = skip this walk, r = redo the last one, q = stop the test)'); continue; } return c; } return null; };

  // Events from the monitor.
  const attempts = [];
  let sent = 0;
  const readEvents = () => {
    let size;
    try { size = fs.statSync(EVENTS_FILE()).size; } catch (e) { return; }
    if (size < evPos) evPos = 0;
    if (size === evPos) return;
    const fd = fs.openSync(EVENTS_FILE(), 'r');
    const buf = Buffer.alloc(size - evPos);
    fs.readSync(fd, buf, 0, buf.length, evPos);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    const last = text.lastIndexOf('\n');
    if (last < 0) return;
    evPos += Buffer.byteLength(text.slice(0, last + 1));
    for (const l of text.slice(0, last).split('\n')) {
      let e; try { e = JSON.parse(l); } catch (x) { continue; }
      if (!e || e.runId !== runId) continue;
      const a = attempts.find(x => x.n === e.trial);
      if (!a) continue;
      if (e.type === 'motion') { if (!a.motionSeen && a.phase === 'live') say('   … movement seen'); a.motionSeen = true; a.lastMotionAt = Date.now(); }
      else if (e.type === 'rejected') {
        a.rejected.push(String(e.reason || '').slice(0, 30));
        a.lastMotionAt = Date.now(); a.motionSeen = true;
        if (a.phase === 'live' && !a.crossings.length) say(`   … movement, but ${e.reason === 'no-crossing' ? 'nothing crossed the middle of the watched box' : e.reason === 'too-brief' ? 'too brief to be a person' : 'ignored'} (not a crossing)`);
      } else if (e.type === 'crossing') {
        a.lastMotionAt = Date.now(); a.motionSeen = true;
        const c = { seq: e.seq || null, durationSec: e.durationSec, files: e.files || null, capped: e.capped || null, verdict: null, done: !!e.capped, at: Date.now() };
        if (e.capped) { say(`   ▶ crossing seen, but NOT counted: ${e.capped === 'limit' ? 'the test\'s limit is used up' : 'too many crossings in one walk'}`); if (e.seq) a.crossings.push(c); continue; }
        a.crossings.push(c); sent++;
        bell();
        say(`   ▶ crossing detected (${e.durationSec} s) — counting…`);
      } else if (e.type === 'verdict') {
        const c = a.crossings.find(x => x.seq === e.seq);
        if (!c) continue;
        c.done = true;
        if (e.skipped || e.error) { c.verdict = null; c.problem = e.error || e.skipped; }
        else c.verdict = { people_count: e.people_count, tailgate_flag: e.tailgate_flag === true, confidence: e.confidence || null, note: e.note || null };
      }
    }
  };

  const K = acc.KINDS;
  const queue = acc.SCRIPT.map((kind, i) => ({ kind, pos: i + 1 }));
  const total = acc.SCRIPT.length;
  let quit = false, n = 0;
  say(`\nThere are ${total} walks. Before each one you get ${o.gap} s to get in place, then ${o.wait} s to do it.`);
  say('Keys (then Enter):  Enter = skip a walk   r = redo the last one   q = stop the test');

  while (queue.length && !quit) {
    const item = queue.shift();
    if (sent >= cap) {
      say(`\nThe test's limit of ${cap} counted crossings is used up, so it stops here.`);
      break;
    }
    const a = { n: ++n, pos: item.pos, kind: item.kind, status: 'pending', missReason: null, rejected: [], crossings: [], motionSeen: false, lastMotionAt: 0, phase: 'ready', noPicture: false };
    attempts.push(a);
    const k = K[item.kind];
    say(`\n${line}\nWalk ${item.pos} of ${total}${item.again ? ' (again)' : ''}: ${k.say}`);
    if (k.group === 'wave') say('   Stand right by the gate and wave for 3-4 seconds. Do NOT go through.');
    if (k.group === 'tailgate' || k.group === 'separate') say('   You need a second person for this one.');
    const gap = a.n === 1 ? Math.max(o.gap, 30) : o.gap;
    say(`   Get in place: it starts in ${gap} s. (Movement until then is ignored.)`);
    speak(o, `Walk ${item.pos}. ${k.say.replace(/\(.*\)/, '')}. Starting in ${gap} seconds.`);

    // Get ready.
    let cmd = null;
    const readyUntil = Date.now() + gap * 1000;
    let told5 = false;
    while (Date.now() < readyUntil && !(cmd = takeCmd())) {
      await sleep(200); readEvents();
      if (!told5 && readyUntil - Date.now() <= 5000) { told5 = true; say('   5…'); }
    }
    if (cmd && handleCmd(cmd, a, item)) continue;

    // Live.
    a.phase = 'live';
    const hardUntil = Date.now() + o.wait * 1000;
    const tries = attempts.filter(x => x.pos === a.pos).length;
    session.trial = { n: a.n, pos: a.pos, kind: a.kind, until: hardUntil, sub: `walk-${pad2(a.pos)}-${a.kind}${tries > 1 ? `-try${tries}` : ''}` };
    writeSession();
    bell();
    say(`   GO — waiting up to ${o.wait} s for the walk${k.group === 'wave' ? ' (the wave)' : ''}…`);
    speak(o, 'Go.');
    let until = hardUntil;
    const settle = k.group === 'separate' ? 15000 : 5000;
    while (Date.now() < until) {
      await sleep(200); readEvents();
      if ((cmd = takeCmd())) break;
      const zst = zoneStatus(zone.label);
      if (zst && zst.streamOk === false) a.noPicture = true;
      const lastC = a.crossings.length ? a.crossings[a.crossings.length - 1].at : 0;
      let next = hardUntil;
      if (lastC) next = Math.min(hardUntil, lastC + (k.group === 'separate' && a.crossings.length >= 2 ? 3000 : settle));
      else if (k.group === 'wave' && a.motionSeen) next = Math.min(hardUntil, a.lastMotionAt + 8000);
      if (next !== until) { until = next; session.trial.until = until; writeSession(); }
    }
    session.trial = null; writeSession();
    a.phase = 'counting';
    if (cmd && cmd !== 'redo' && handleCmd(cmd, a, item)) continue;
    let redoAfter = cmd === 'redo';

    // Wait for the answers.
    const pending = () => a.crossings.filter(c => !c.done);
    if (pending().length) {
      say('   Counting… (the website is checking the photos)');
      const until2 = Date.now() + 180000;
      while (pending().length && Date.now() < until2) {
        await sleep(300); readEvents();
        const c2 = takeCmd();
        if (c2 === 'redo') redoAfter = true;
        else if (c2 === 'quit') quit = true;
      }
      for (const c of pending()) { c.done = true; c.problem = 'no answer from the website in 3 minutes'; }
    }
    a.status = a.crossings.length ? 'done' : 'missed';
    if (!a.crossings.length) a.missReason = a.noPicture ? 'no-picture' : (a.motionSeen || a.rejected.length) ? 'motion-ignored' : 'no-motion';
    const j = acc.judgeTrial({ n: a.n, kind: a.kind, status: a.status, missReason: a.missReason }, a.crossings.map(c => c.verdict));
    a.text = j.text;
    for (const c of a.crossings.filter(x => x.problem)) say(`   (a crossing was not counted: ${c.problem})`);
    const notes = a.crossings.map(c => c.verdict && c.verdict.note).filter(Boolean);
    if (notes.length) say(`   The AI said: "${notes[0].slice(0, 160)}"${notes.length > 1 ? ` (+${notes.length - 1} more)` : ''}`);
    say(`   RESULT: ${j.text}${j.right === true && !/✓/.test(j.text) ? ' ✓' : ''}`);
    if (!a.crossings.length && k.group !== 'wave') {
      say(a.missReason === 'no-picture' ? '   (The camera picture dropped out: a CAMERA problem.)'
        : a.missReason === 'motion-ignored' ? '   (The motion detection saw movement but did not treat it as someone going through.)'
        : '   (No movement in the watched box: was the walk inside the box? Did it happen within the time?)');
    }
    speak(o, !a.crossings.length ? (k.group === 'wave' ? 'Done.' : 'Not seen.') : j.right ? 'Right.' : j.right === false ? 'Wrong.' : 'Done.');
    if (redoAfter) { redo(a, item, true); }
  }

  function handleCmd(c, a, item) {
    session.trial = null; writeSession();
    if (c === 'skip') { a.status = 'skipped'; say('   Skipped.'); return true; }
    if (c === 'quit') { a.status = 'skipped'; quit = true; say('   Stopping the test.'); return true; }
    if (c === 'redo') return redo(a, item, false);
    return false;
  }
  // r: do the last finished walk again (and then the one that was about to start).
  function redo(a, item, afterThis) {
    const prev = afterThis ? a : [...attempts].reverse().find(x => x !== a && (x.status === 'done' || x.status === 'missed'));
    if (!prev) { say('   Nothing to redo yet.'); return false; }
    prev.status = 'redone';
    if (!afterThis) { a.status = 'redone'; queue.unshift(item); }
    queue.unshift({ kind: prev.kind, pos: prev.pos, again: true });
    say(`   OK: walk ${prev.pos} again${afterThis ? '' : `, then walk ${item.pos}`}.`);
    return true;
  }
  for (const a of attempts) if (a.status === 'pending') a.status = 'skipped';
  rl.close();
  session.trial = null; writeSession();
  clearInterval(sessionTimer); sessionTimer = null;
  try { fs.rmSync(SESSION_FILE(), { force: true }); } catch (e) { /* gone */ }

  if (!attempts.some(a => a.status === 'done' || a.status === 'missed')) {
    await postJson(cfg.serverUrl, '/monitor/runner/test', cfg.runnerToken, { action: 'finish', runId, trials: attempts.map(a => ({ n: a.n, pos: a.pos, kind: a.kind, status: 'skipped' })) });
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch (e) { /* empty anyway */ }
    say('\nNo walks were done, so there is no scorecard. Nothing was spent.');
    say(mon.how === 'ours' ? 'The monitor that was started for the test is stopping now.' : 'The monitor carries on watching the door as normal.');
    cleanup(); process.removeListener('exit', cleanup);
    await sleep(child ? 1500 : 100);
    return 0;
  }

  // Scorecard: the website scores it (so the admin page shows the same);
  // if it can't be reached, the same rules are applied here.
  const trials = attempts.map(a => ({ n: a.n, pos: a.pos, kind: a.kind, status: a.status, missReason: a.missReason,
    seqs: a.crossings.map(c => c.seq).filter(Boolean), rejected: [...new Set(a.rejected)].slice(0, 10) }));
  say(`\n${line}\nSending the results to the website…`);
  const fin = await postJson(cfg.serverUrl, '/monitor/runner/test', cfg.runnerToken, { action: 'finish', runId, trials });
  let sc, lines, analyses, costText, onWebsite = false;
  if (fin.status === 200 && fin.json && fin.json.ok) {
    ({ scorecard: sc, lines, analyses, costText } = fin.json);
    onWebsite = true;
  } else {
    const local = acc.scoreRun(trials, (tn, s) => { const a = attempts.find(x => x.n === tn); const c = a && a.crossings.find(x => x.seq === s); return c ? c.verdict : null; });
    sc = local.scorecard; lines = acc.formatScorecard(sc);
    analyses = sent; costText = acc.money(sent * (W.costPerAnalysis || acc.costPerAnalysis(W.model)));
    say(`(Could not send it to the website: ${fin.json && fin.json.error ? fin.json.error : explainFailure(fin).msg.replace(' Will retry.', '')}. Scored here instead.)`);
  }
  say(`\n${line}\nSCORECARD — ${zone.label}, counted with ${W.modelName}\n${line}`);
  for (const l of lines) say(l);
  say('');
  say(`It used ${analyses} ${analyses === 1 ? 'analysis' : 'analyses'}: ${costText}.`);
  if (onWebsite) say(`The scorecard is on the admin page too (${W.gymName} > Accuracy test).`);

  // The folder: every walk's photos + answer + what should have happened.
  const summary = {
    about: 'SecurityAI accuracy test: labelled test footage. Each walk says what really happened (expected) and what the AI answered.',
    runId, gym: W.gymName, zone: zone.label, host: os.hostname(), model: W.model, startedAt,
    finishedAt: new Date().toISOString(), options: { wait: o.wait, gap: o.gap },
    walks: attempts.map(a => ({
      walk: a.pos, attempt: a.n, expected: a.kind, instruction: K[a.kind].say, expectedPeople: K[a.kind].people,
      status: a.status, missReason: a.missReason, result: a.text || a.status, motionSeen: a.motionSeen, ignoredMovement: [...new Set(a.rejected)],
      crossings: a.crossings.map(c => ({ seq: c.seq, durationSec: c.durationSec, photos: c.files ? c.files.frames : [], larger: c.files ? c.files.larger : null,
        answer: c.verdict, notCounted: c.capped || c.problem || null })),
    })),
    scorecard: sc, analyses, cost: costText, sentToWebsite: onWebsite,
  };
  let zipPath = null;
  try {
    fs.writeFileSync(path.join(folder, 'summary.json'), JSON.stringify(summary, null, 1));
    zipPath = zipFolder(folder, `${folder}.zip`);
  } catch (e) { say(`(Could not write the test folder: ${e.message})`); }
  say(`\nThe photos and answers of every walk are in: ${RC.tildify(folder)}`);
  if (zipPath) {
    say(`Send this file to Claude (drag it into the chat): ${RC.tildify(zipPath)}`);
    if (process.platform === 'darwin' && process.stdout.isTTY) { try { spawn('open', ['-R', zipPath], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); say('(Finder is showing it now.)'); } catch (e) { /* no Finder */ } }
  }
  say('It is real footage of the door that helps tune the counting. It only has the people who did the test in it.');
  if (mon.how === 'ours') say('\nThe monitor that was started for the test is stopping now.');
  else say('\nThe monitor carries on watching the door as normal.');
  cleanup();
  process.removeListener('exit', cleanup);
  await sleep(child ? 1500 : 100);
  return 0;
}

module.exports = { monitorLink, run, zipFolder, crc32, parseArgs };
