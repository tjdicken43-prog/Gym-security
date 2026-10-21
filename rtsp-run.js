// Standalone camera runner — Option C, no browser involved at all.
//
//   node rtsp-run.js              watch the cameras in rtsp-zones.json
//   node rtsp-run.js --check      check the config + cameras, then exit
//   node rtsp-run.js --snapshot   save one picture per zone, then exit
//   node rtsp-run.js --test       the 5-minute accuracy test (walk-test.js)
//
// Two modes, picked by rtsp-zones.json:
//   REMOTE  "serverUrl" + "runnerToken" set: crossings are sent to the
//           website, which does the counting and shows them on its
//           activity page. No Anthropic key on this laptop.
//   LOCAL   no "serverUrl": counts on this machine (needs
//           ANTHROPIC_API_KEY in .env) and serves the activity page at
//           http://localhost:4242/activity.html
//
// Runs until you stop it (Ctrl-C). node install-service.js makes it start
// by itself when the computer starts, and restart if it ever crashes.
// If it is already running in the background, typing node rtsp-run.js
// just shows you its live output (Ctrl-C then stops watching, not the monitor).
//
// Settings live in ~/.securityai/rtsp-zones.json (an old one next to the
// code is moved there automatically), so code updates never lose them.

// Safe self-update: count starts after an update first of all, so a new
// version that keeps crashing is put back by itself (auto-update.js).
try { require('./auto-update').boot({ service: process.env.SECURITYAI_SERVICE === '1' }); } catch (e) { /* older copy */ }
try { require('dotenv').config(); } catch (e) { /* .env support optional */ }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const detect = require('./detect');
const rtsp = require('./rtsp');
const { loadConfig, maskUrl, maskText, secretsOf, resolveConfigPath, statePath, ensureStateDir, tildify, tooWide, runningMonitor } = require('./runner-config');
let finderOne = null;
const recorderFinder = () => finderOne || (finderOne = require('./recorder-finder').create({ stateDir: path.dirname(statePath('x')), configFile: CONFIG, log: m => say(m) }));

const args = process.argv.slice(2);
const FLAG = {
  check: args.includes('--check'),
  snapshot: args.includes('--snapshot'),
  help: args.includes('--help') || args.includes('-h'),
  verbose: args.includes('--verbose'),
  test: args.includes('--test'),
  entry: (() => { const i = args.indexOf('--entry'); return i >= 0 ? String(args[i + 1] || '') : null; })(),
};
// Background (service) mode: started by launchd / systemd via install-service.js.
const SERVICE = process.env.SECURITYAI_SERVICE === '1';
const startedAtMs = Date.now();
const LOG_FILE = process.env.RUNNER_LOG_FILE || (SERVICE ? statePath('runner.log') : null);
const LOG_MAX_BYTES = 5 * 1024 * 1024;
if (LOG_FILE) teeToLogFile(LOG_FILE);
const CONFIG = process.env.RTSP_CONFIG || resolveConfigPath({ log: m => console.log(m) });
const STATUS_MS = (Number(process.env.RUNNER_STATUS_SEC) || (SERVICE ? 60 : 10)) * 1000;
const HEARTBEAT_MS = (Number(process.env.RUNNER_HEARTBEAT_SEC) || 30) * 1000;
const LOCAL_PORT = Number(process.env.RUNNER_LOCAL_PORT) || 4242;
const QUEUE_DIR = process.env.RUNNER_QUEUE_DIR || statePath('runner-queue');
const PID_FILE = process.env.RUNNER_PID_FILE || statePath('runner.pid');
const WATCHING_FILE = statePath('watching');
const VERSION = '4';
// Long edge of the larger copy of each crossing's middle photo (0 = off).
const EVIDENCE_PX = process.env.RUNNER_EVIDENCE_PX != null ? Number(process.env.RUNNER_EVIDENCE_PX) || 0 : 1024;

// Testing aid: RUNNER_DUMP_DIR=/some/dir saves every crossing's photos there.
function dumpEvent(z, framesB64, extra) {
  try {
    const dir = process.env.RUNNER_DUMP_DIR;
    fs.mkdirSync(dir, { recursive: true });
    const stamp = `${Date.now()}-${z.label.replace(/[^a-z0-9]+/gi, '_')}`;
    framesB64.forEach((b, i) => fs.writeFileSync(path.join(dir, `${stamp}-frame${i}${extra && extra.seqs ? `-seq${extra.seqs[i]}` : ''}.jpg`), Buffer.from(b, 'base64')));
    if (extra && extra.evidence) fs.writeFileSync(path.join(dir, `${stamp}-evidence-seq${extra.evidenceSize.seq}.jpg`), Buffer.from(extra.evidence, 'base64'));
  } catch (e) { /* testing aid only */ }
}

// Every console line also goes to the log file (kept under ~5 MB: the
// old half is renamed runner.log.1). Used in background mode, where
// nobody sees the screen; node rtsp-run.js then shows this file live.
function teeToLogFile(file) {
  try { ensureStateDir(); } catch (e) { /* custom path */ }
  const stamp = () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '  ';
  const write = text => {
    try {
      try { if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, file + '.1'); } catch (e) { /* new file */ }
      fs.appendFileSync(file, String(text).split('\n').map(l => (l ? stamp() + l : l)).join('\n') + '\n', { mode: 0o600 });
    } catch (e) { /* disk full etc: keep running */ }
  };
  for (const k of ['log', 'warn', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { orig(...a); write(a.map(x => (typeof x === 'string' ? x : require('util').inspect(x))).join(' ')); };
  }
}

// ---------- output helpers ----------

let SECRETS = [];
const clock = (d) => (d ? new Date(d) : new Date()).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const safe = (s) => maskText(s, SECRETS);
function say(msg) { console.log(safe(msg)); }
function sayAt(msg) { console.log(safe(`${clock()}  ${msg}`)); }
function warn(msg) { console.warn(safe(`${clock()}  ⚠ ${msg}`)); }
function loud(lines) {
  const bar = '!'.repeat(64);
  console.warn(`\n${bar}`);
  for (const l of [].concat(lines)) console.warn(safe(`!! ${l}`));
  console.warn(`${bar}\n`);
}
const BARS = '▁▂▃▄▅▆▇█';
function spark(values) {
  return values.map(v => BARS[Math.max(0, Math.min(7, Math.ceil((v / 40) * 7)))]).join('');
}
function plural(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

if (FLAG.help && !FLAG.test) {
  say('node rtsp-run.js             watch the cameras (or, if already running in the background, show it live)');
  say('node rtsp-run.js --test      the 5-minute accuracy test: a few walks at the door, then a scorecard');
  say('node rtsp-run.js --check     check rtsp-zones.json and the cameras, then stop');
  say('node rtsp-run.js --snapshot  save one picture per zone to camera-check/, then stop');
  process.exit(0);
}

// ---------- 1. config ----------

function loadOrExit() {
  const r = loadConfig(CONFIG);
  if (r.cfg) SECRETS = secretsOf(r.cfg);
  for (const w of r.warnings) say(`⚠ ${w}`);
  if (r.errors.length) {
    console.error('');
    for (const e of r.errors) console.error(safe(`✗ ${e}`));
    console.error('');
    return null;
  }
  return r.cfg;
}

// ---------- 2. probe ----------

// Probe each zone ONE AT A TIME. If a password is wrong we stop before
// trying it again on the next zone — the NVR locks the account.
async function probeAll(cfg) {
  const results = [];
  const badLogins = new Set();
  for (const z of cfg.zones) {
    // Friday's hand-typed address (no channel) always shows camera 1 on
    // this recorder, not the door. Never watch it quietly: stop and say so.
    if (z.noChannel) {
      results.push({ z, probe: { ok: false, skipped: true, error: { kind: 'config', fatal: true,
        message: 'The camera address has no channel number, so this recorder would send camera 1 (the pro shop), not the door.',
        fix: 'run node setup-camera.js and pick the door channel (it finds the right address).' } } });
      continue;
    }
    const loginKey = loginOf(z.cameraUrl);
    if (loginKey && badLogins.has(loginKey)) {
      results.push({ z, probe: { ok: false, skipped: true, error: { kind: 'auth', fatal: true, message: 'Not tried — the same username/password was just rejected for another zone.', fix: 'fix the password first (NVR account lockout).' } } });
      continue;
    }
    // A password the recorder already rejected is never sent again until
    // someone re-saves rtsp-zones.json (node setup-camera.js does that
    // after it has tested the password). Without this, --check followed by
    // a start, or pm2/systemd restarting us after the exit below, sends the
    // same wrong password again and again and the NVR locks the account.
    const failedAt = loginFailedAt(z.cameraUrl);
    if (failedAt) {
      results.push({ z, probe: { ok: false, skipped: true, error: { kind: 'auth', fatal: true,
        message: `Not tried — the recorder rejected this username/password at ${clock(failedAt)}, and rtsp-zones.json has not been changed since.`,
        fix: 'run node setup-camera.js and type the password again (the recorder locks the account after repeated wrong passwords).' } } });
      if (loginKey) badLogins.add(loginKey);
      continue;
    }
    say(`Checking ${z.label}… (connecting to ${maskUrl(z.cameraUrl)})`);
    const probe = await rtsp.probeStream(z.cameraUrl, { timeoutMs: 15000, secrets: SECRETS });
    if (!probe.ok && probe.error && probe.error.kind === 'auth' && loginKey) badLogins.add(loginKey);
    if (!probe.ok && probe.error && probe.error.kind === 'auth') rememberLoginFailed(z.cameraUrl);
    else if (probe.ok) forgetLoginFailed(z.cameraUrl);
    let crop = null;
    if (probe.ok) crop = rtsp.resolveCrop(z, probe.width, probe.height);
    results.push({ z, probe, crop, warnings: zoneWarnings(z, probe, crop) });
  }
  return results;
}
// Remembers which recorder logins (username@address — never the password)
// got a 401, in the runner-queue folder so it survives a restart.
const LOGIN_FAIL_FILE = path.join(QUEUE_DIR, 'login-failed.lock');
function urlHash(u) {
  const m = String(u).match(/^[a-z]+:\/\/(?:([^:@\/]*)(?::[^@\/]*)?@)?([^\/?#]+)/i);
  const who = m ? `${m[1] || ''}@${m[2]}` : String(u).replace(/:\/\/[^@\/]*@/, '://');
  return require('crypto').createHash('sha256').update(who).digest('hex');
}
function readLoginFails() {
  try { const o = JSON.parse(fs.readFileSync(LOGIN_FAIL_FILE, 'utf8')); return (o && typeof o === 'object') ? o : {}; } catch (e) { return {}; }
}
function writeLoginFails(o) {
  try {
    if (!Object.keys(o).length) { fs.rmSync(LOGIN_FAIL_FILE, { force: true }); return; }
    fs.mkdirSync(QUEUE_DIR, { recursive: true });
    fs.writeFileSync(LOGIN_FAIL_FILE, JSON.stringify(o));
  } catch (e) { /* best effort */ }
}
function loginFailedAt(u) {
  const at = readLoginFails()[urlHash(u)];
  if (!at) return null;
  let saved = 0;
  try { saved = fs.statSync(CONFIG).mtimeMs; } catch (e) { /* missing */ }
  return saved > at ? null : at;     // file re-saved since the 401: a person has changed it
}
function rememberLoginFailed(u) { const o = readLoginFails(); o[urlHash(u)] = Date.now(); writeLoginFails(o); }
function forgetLoginFailed(u) { const o = readLoginFails(); if (o[urlHash(u)]) { delete o[urlHash(u)]; writeLoginFails(o); } }

function loginOf(u) {
  const m = String(u).match(/^[a-z]+:\/\/([^@\/]*)@([^\/?]+)/i);
  return m ? `${m[1]}@${m[2]}` : null;
}

// Plain warnings about a zone, for this screen AND the website (they go
// in every heartbeat, so the admin page shows them even when the monitor
// runs in the background with nobody watching this screen).
function zoneWarnings(z, probe, crop) {
  const out = [].concat(z.warnings || []);
  if (probe && probe.ok && crop) {
    if (crop.scaled) out.push(`The camera picture is now ${probe.width}x${probe.height}, but the watched box was drawn on a ${crop.from.w}x${crop.from.h} picture. It was scaled to match, so it should still cover the door — check with node rtsp-run.js --snapshot, or redo it with node setup-camera.js.`);
    if (crop.clamped) out.push(`The watched box did not fit the ${probe.width}x${probe.height} picture, so it was shrunk to fit (${crop.notes.join('; ')}). Redo it with node setup-camera.js.`);
    if (tooWide(crop.w, probe.width)) out.push(`The watched area is ${crop.w} pixels wide${crop.full ? ' (the whole picture)' : ''} — a person is too small in that and may be missed. Fix: node setup-camera.js and pick just the doorway on the grid.`);
  }
  return out;
}

function describeProbe(r) {
  const { z, probe, crop } = r;
  const lines = [];
  lines.push(`${z.label}`);
  lines.push(`   camera:   ${z.isFile ? `video file ${path.basename(z.cameraUrl)} (test mode)` : maskUrl(z.cameraUrl)}`);
  if (probe.ok) {
    lines.push(`   picture:  ${probe.width}x${probe.height} ${probe.codec || ''}${probe.fps ? ` @ ${probe.fps} fps` : ''}   ✓ connected`);
    if (crop.full) lines.push(z.cropSet ? '   watching: the whole picture' : '   watching: the whole picture (no box around the door chosen yet)');
    else lines.push(`   watching: a ${crop.w}x${crop.h} box at x ${crop.x}, y ${crop.y}${crop.scaled ? ` (scaled from the ${crop.from.w}x${crop.from.h} picture it was drawn on)` : ''}`);
    for (const w of r.warnings || []) if (!(z.warnings || []).includes(w)) lines.push(`   ⚠ ${w}`);
    if (probe.width >= 2560 && !z.isFile) lines.push('   note: this is the big, sharp version of the camera picture. If "fps" (pictures a second) in the lines below drops under 3, run node setup-camera.js again and type S for the smaller version.');
    if (probe.warning) lines.push(`   ⚠ ${probe.warning}`);
  } else {
    const e = probe.error || {};
    lines.push(`   ✗ ${e.message || 'Could not connect.'}`);
    if (e.fix) lines.push(`   Do this: ${e.fix}`);
    if (probe.stderrTail && FLAG.verbose) lines.push(`   (ffmpeg said: ${probe.stderrTail})`);
  }
  return lines.join('\n');
}

// ---------- --snapshot ----------

async function runSnapshot(cfg, results) {
  const dir = path.join(__dirname, 'camera-check');
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (const r of results) {
    if (!r.probe.ok) continue;
    const slug = r.z.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'zone';
    const outCrop = path.join(dir, `zone-${slug}.jpg`);
    const outFull = path.join(dir, `zone-${slug}-whole.jpg`);
    const s = await rtsp.snapshot(r.z.cameraUrl, r.z, r.probe, outCrop, outFull, { secrets: SECRETS });
    if (s.ok) {
      say(`✓ ${r.z.label}: ${outCrop}`);
      say(`  whole picture with the watched box in red: ${outFull}`);
      saved.push(outCrop, outFull);
    } else {
      say(`✗ ${r.z.label}: could not grab a picture — ${s.error.message}${s.error.fix ? ` Do this: ${s.error.fix}` : ''}`);
    }
  }
  if (saved.length && process.platform === 'darwin') {
    try { spawn('open', saved, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch (e) { /* no open */ }
  }
  return saved.length > 0;
}

// ---------- mode setup ----------

function tzConfig(cfg) {
  return {
    dailyBurstCap: cfg.dailyBurstCap || null,
    scheduleStart: cfg.scheduleStart || null,
    scheduleEnd: cfg.scheduleEnd || null,
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    model: cfg.model || null,
    alertEmail: cfg.alertEmail || null,
    alertPhone: cfg.alertPhone || null,
  };
}

function printVerdict(label, res, durationSec) {
  if (!res) { sayAt(`${label}  crossing sent — no answer details came back.`); return; }
  if (res.skipped) {
    const why = {
      'outside-schedule': 'outside the gym\'s watched hours, so it was not counted',
      'daily-cap': 'the daily limit of analyses was reached, so it was not counted',
      'cooldown': 'skipped to make the daily limit last the whole night (busy so far), so it was not counted',
      'monitoring-stopped': 'monitoring is switched off on the website, so it was not counted',
    }[res.skipped] || `not counted (${res.skipped})`;
    sayAt(`${label}  crossing — ${why}.`);
    return;
  }
  const e = res.entry || {};
  const err = res.analysisError || e.error;
  if (err) { sayAt(`${label}  ✗ crossing received but could not be analysed: ${err} (photos are saved on the activity page)`); return; }
  if (res.duplicate) { sayAt(`${label}  (already received earlier — not counted twice)`); }
  if (e.people_count == null) { sayAt(`${label}  crossing sent ✓`); return; }
  const n = e.people_count, exp = e.expectedCount || 1;
  const counted = `${plural(n, 'person', 'people')} counted, ${exp} expected`;
  if (e.tailgate_flag) {
    sayAt(`${label}  ⚠ FLAGGED: ${e.phone_handoff ? 'looks like a phone handed over to scan in on the same code' : counted}${e.confidence === 'low' ? ' (low confidence — logged, no alert)' : ''}${e.note ? ` — "${e.note}"` : ''}`);
  } else {
    sayAt(`${label}  ✓ ${counted} — OK${durationSec ? ` (${durationSec} s crossing)` : ''}`);
  }
}

// This computer's time zone name (e.g. "America/Chicago"), or null.
function localTimeZone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!tz) return null;
    new Intl.DateTimeFormat('en-US', { timeZone: tz });   // throws if unusable
    return tz;
  } catch (e) { return null; }
}

function setupLocal(cfg) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('');
    console.error('✗ LOCAL mode needs ANTHROPIC_API_KEY in .env, and it is not set — nothing could be counted.');
    console.error('  Better: connect this computer to the website so no key sits on it. Do this: node pair.js');
    return null;
  }
  const monitor = require('./monitor');
  monitor.start({
    sourceType: 'browser-push',       // frames are pushed in, same as the dashboard does
    gymCode: cfg.gymCode || null,
    scheduleStart: cfg.scheduleStart || null,
    scheduleEnd: cfg.scheduleEnd || null,
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    // The zone name too: the offset above is read once, so without it the
    // watch hours would shift an hour when the clocks change (e.g. Nov 1).
    timeZone: localTimeZone(),
    model: cfg.model || null,
    dailyBurstCap: cfg.dailyBurstCap,
    alertEmail: cfg.alertEmail || null,
    alertPhone: cfg.alertPhone || null,
    label: cfg.label || 'RTSP',
  });

  // Serve the activity page from THIS process, so it shows this
  // monitor's events. Optional: needs express and a require-safe server.js.
  let pageUrl = null;
  try {
    const server = require('./server');
    if (typeof server.start !== 'function') throw new Error('server.js has no start() yet (older version)');
    const srv = server.start(LOCAL_PORT);
    const onErr = err => warn(`The local activity page could not start (${err.code === 'EADDRINUSE' ? `port ${LOCAL_PORT} is already in use — is another copy running?` : err.message}). Monitoring continues.`);
    if (srv && typeof srv.on === 'function') srv.on('error', onErr);
    else if (srv && typeof srv.then === 'function') srv.then(s => s && s.on && s.on('error', onErr), onErr);
    pageUrl = `http://localhost:${LOCAL_PORT}/activity.html`;
  } catch (err) {
    const why = /Cannot find module '(express|cors|stripe|nodemailer)'/.test(err.message)
      ? `the website's packages are not installed here (run "npm install" in this folder to get it)`
      : err.message.split('\n')[0];
    say(`note: no local activity page — ${why}. Monitoring still works; results print here.`);
  }

  return {
    label: 'Local',
    pageUrl,
    async send(z, framesB64, ev, capturedAt, evidence) {
      // evidence = the middle photo again at up to 1024 px, for people to
      // look at; without it pushBurst keeps the 384 px middle frame.
      const r = await monitor.pushBurst(framesB64, {
        label: z.label, expectedCount: z.expectedCount, accessibleGate: z.accessibleGate,
        durationSec: ev.durationSec, lingerSec: Number(ev.lingerSec) || null, capturedAt,
        before: ev.before || null,
        entryDirection: z.entryDirection ? [].concat(z.entryDirection) : null, direction: ev.direction || null,
      }, evidence || undefined);
      if (r && r.skipped) return printVerdict(z.label, r);
      // monitor.pushBurst returns { entry } / { entry, error }; older
      // versions returned nothing, so fall back to the newest log entry.
      const e = (r && r.entry) || (monitor.getLog() || []).find(x => x && x.zoneLabel === z.label);
      printVerdict(z.label, { entry: e || {}, analysisError: r && r.error }, ev.durationSec);
    },
    heartbeat() { monitor.recordHeartbeat(); },
    stop() { try { monitor.stop(); } catch (e) { /* ignore */ } },
  };
}

function setupRemote(cfg, handles, warningsOf, testLink) {
  const { createRemote } = require('./runner-remote');
  const remote = createRemote({
    serverUrl: cfg.serverUrl,
    runnerToken: cfg.runnerToken,
    queueDir: QUEUE_DIR,
    log: m => sayAt(m),
    warn: m => warn(m),
    onVerdict: (label, json, item) => item.test ? testVerdict(testLink, label, item, json) : printVerdict(label, json, item.zone.durationSec),
    onDropped: (item, info) => { if (item.test) testVerdict(testLink, item.zone.label, item, { ok: false, error: info.msg }); },
  });
  return {
    label: 'Remote',
    pageUrl: `${cfg.serverUrl}/activity.html`,
    async send(z, framesB64, ev, capturedAt, evidence, test) {
      const item = {
        gymCode: cfg.gymCode || null,
        zone: { label: z.label, expectedCount: z.expectedCount, accessibleGate: z.accessibleGate, durationSec: Number(ev.durationSec), lingerSec: Number(ev.lingerSec) || undefined,
          entryDirection: z.entryDirection ? [].concat(z.entryDirection) : undefined, direction: ev.direction || undefined },
        frames: framesB64.slice(0, 6),
        capturedAt,
      };
      if (ev.before && !test) item.before = ev.before;
      // The MIDDLE photo again at up to 1024 px, for people to look at
      // (the 384 px frames above are what gets counted). Not for test
      // walks: the test keeps its own copy on this computer.
      if (evidence && !test) item.evidence = evidence;
      // An accuracy-test walk (node rtsp-run.js --test): the website counts
      // it but never alerts or logs it as a real crossing.
      if (test) item.test = test;
      remote.enqueue(item);
    },
    heartbeat() {
      const zones = handles.map(({ z, h }) => ({
        label: z.label,
        streamOk: !!h.stats.streamOk,
        // not measured yet in the first seconds: leave it out (not "0 fps")
        fps: !h.stats.streamOk ? 0 : h.stats.fps > 0 ? Number(h.stats.fps.toFixed(1)) : undefined,
        framesSeen: h.stats.framesSeen,
        lastFrameAt: h.stats.lastFrameAt ? new Date(h.stats.lastFrameAt).toISOString() : null,
        lastEventAt: h.stats.lastEventAt ? new Date(h.stats.lastEventAt).toISOString() : null,
        lastError: h.stats.lastError || null,
        tamper: h.stats.tamper ? h.stats.tamper.kind : null,
        tamperSince: h.stats.tamper ? h.stats.tamper.since : null,
        warnings: (warningsOf.get(z) || []).concat(recentNotes()).slice(0, 10),
      }));
      let AU = null; try { AU = require('./auto-update'); } catch (e) { /* older copy */ }
      return remote.heartbeat({
        gymCode: cfg.gymCode || null, host: os.hostname(), version: VERSION,
        config: tzConfig(cfg), zones, update: AU ? AU.summary() : undefined,
      }).then(r => {
        // Behind the website's version? Update when the door is quiet.
        if (AU) try {
          AU.onHeartbeat(r, { service: SERVICE, enabled: cfg.autoUpdate !== false, quiet: ms => !remote.queued && handles.every(({ h }) => !h.stats.lastEventAt || Date.now() - h.stats.lastEventAt >= ms) && Date.now() - startedAtMs >= ms });
        } catch (e) { /* never stops the heartbeat */ }
        return r;
      });
    },
    get queued() { return remote.queued; },
    stop() { remote.stop(); },
  };
}

// The website's answer for an accuracy-test crossing: to the test (via
// walk-test.js's files) and one line here.
function testVerdict(testLink, label, item, json) {
  const t = item.test;
  const e = (json && json.entry) || {};
  const v = {
    skipped: json && json.skipped || null,
    error: (json && (json.analysisError || (json.ok === false ? json.error : null))) || null,
    people_count: Number.isFinite(e.people_count) ? e.people_count : null,
    tailgate_flag: e.tailgate_flag === true, confidence: e.confidence || null, note: e.note || null, model: e.model || null,
  };
  if (testLink) testLink.verdict(t, v);
  const what = v.error ? `not counted: ${v.error}` : v.skipped ? `not counted (${v.skipped})`
    : `${plural(v.people_count || 0, 'person', 'people')} counted${v.tailgate_flag ? ', flagged' : ''}`;
  sayAt(`${label}  [test walk ${testLink ? testLink.posOf(t) : t.trial}] ${what} (test only: no alert)`);
}

// Short-lived notes for the website (e.g. "this laptop was asleep"),
// shown on the admin page for a while after they happen.
const NOTES = [];
function addNote(text, forMs) { NOTES.push({ text, until: Date.now() + forMs }); }
function recentNotes() {
  const now = Date.now();
  while (NOTES.length && NOTES[0].until < now) NOTES.shift();
  return NOTES.map(n => n.text);
}

// A closed lid (or the Mac's sleep setting) freezes everything: no
// pictures, no check-ins. Timers catch up on waking, so a big gap between
// ticks means the computer was asleep. Say so plainly, here and on the
// admin page (until the next evening), instead of blaming the network.
function watchForSleep(onWake) {
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    if (now - last > 60000) onWake(last, now);
    last = now;
  }, 5000).unref();
}

// ---------- keep awake / stdin guard ----------

function keepAwake() {
  if (process.platform !== 'darwin') return null;
  try {
    const c = spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], { stdio: 'ignore' });
    c.on('error', () => say('note: could not start caffeinate — set the Mac to never sleep in System Preferences > Energy Saver.'));
    c.on('spawn', () => say('Keeping this Mac awake while the monitor runs (caffeinate).'));
    return c;
  } catch (e) { return null; }
}

function guardStdin() {
  if (!process.stdin.isTTY) return;   // pm2 / systemd / piped: leave stdin alone
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => {
    if (!String(d).trim()) return;
    console.log('\nThis window is busy running the monitor — that command did not run. Open a new Terminal window (Cmd+N on Mac), or press Ctrl-C here to stop.\n');
  });
  process.stdin.on('error', () => {});
  process.stdin.resume();
}

// ---------- live status ----------

function statusLine(z, h, now) {
  const s = h.stats;
  const hist = s.motionHistory.filter(m => now - m.t <= STATUS_MS);
  const buckets = [];
  const nb = 5, bw = STATUS_MS / nb;
  for (let i = nb - 1; i >= 0; i--) {
    const from = now - (i + 1) * bw, to = now - i * bw;
    const vals = hist.filter(m => m.t > from && m.t <= to).map(m => m.pct);
    buckets.push(vals.length ? Math.max(...vals) : 0);
  }
  const peak = hist.length ? Math.max(...hist.map(m => m.pct)) : 0;
  const parts = [];
  if (h.stopped) parts.push('STOPPED');
  else if (s.streamOk) parts.push('stream OK');
  else if (s.lastFrameAt) parts.push(`NO PICTURE for ${Math.round((now - s.lastFrameAt) / 1000)} s`);
  else parts.push('connecting…');
  parts.push(`${(s.streamOk ? s.fps || 0 : 0).toFixed(1)} fps`);
  parts.push(`motion ${spark(buckets)} ${peak}%`);
  parts.push(`events ${s.events}`);
  if (s.rejected) parts.push(`ignored ${s.rejected}`);
  parts.push(`last ${s.lastEventAt ? clock(s.lastEventAt) : '—'}`);
  if (!s.streamOk && s.lastError) parts.push(s.lastError);
  return `${z.label}  ${parts.join(' · ')}`;
}

// ---------- main ----------

// ---------- one monitor at a time ----------
// Two copies (a Terminal window + the background service, or two windows)
// would each send every crossing. runner.pid says who is running.
function otherRunner() {
  const o = runningMonitor(PID_FILE);
  return o && o.pid !== process.pid ? o : null;
}
function claimPidFile() {
  try { ensureStateDir(); } catch (e) { /* custom path */ }
  fs.writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, service: SERVICE, startedAt: new Date().toISOString(), config: CONFIG }));
  process.on('exit', () => {
    try { const o = JSON.parse(fs.readFileSync(PID_FILE, 'utf8')); if (o.pid === process.pid) fs.unlinkSync(PID_FILE); } catch (e) { /* gone */ }
  });
}

function backgroundInstalled() {
  try { return require('./install-service').isInstalled(); } catch (e) { return false; }
}

// Shows the background monitor's log live. Ctrl-C stops watching only.
function followLog(other) {
  const file = LOG_FILE || statePath('runner.log');
  say(other.starting ? 'The monitor runs in the background (it starts by itself) and is starting up now.'
    : `The monitor is already running${other.service ? ' in the background (it starts by itself)' : ` in another window (started ${clock(other.startedAt)})`}.`);
  if (!other.service) {
    say('Only one can run at a time. Use that window — or close it (Ctrl-C there) and run this again.');
    process.exit(0);
  }
  say('Showing its live output. Press Ctrl-C to stop WATCHING — the monitor keeps running.');
  say('(To stop the monitor itself: node install-service.js --stop)\n');
  const touch = () => { try { const t = new Date(); fs.utimesSync(WATCHING_FILE, t, t); } catch (e) { try { fs.writeFileSync(WATCHING_FILE, ''); } catch (e2) { /* ignore */ } } };
  touch(); setInterval(touch, 2000);
  let pos = 0;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    process.stdout.write(lines.slice(-31).join('\n'));
    pos = Buffer.byteLength(text);
  } catch (e) { say(`(No log yet at ${tildify(file)} — waiting for the first lines…)`); }
  setInterval(() => {
    let size;
    try { size = fs.statSync(file).size; } catch (e) { return; }
    if (size < pos) pos = 0;                      // log was rotated
    if (size === pos) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = size;
    process.stdout.write(buf.toString('utf8'));
  }, 500);
  onSignal = () => { console.log('\nStopped watching. The monitor is still running in the background.'); process.exit(0); };
}

// Somebody is looking at the live output (node rtsp-run.js on a
// background monitor): show motion lines like during the first minutes.
let watchedCache = { at: 0, v: false };
function beingWatched() {
  const now = Date.now();
  if (now - watchedCache.at > 1500) {
    let v = false;
    try { v = now - fs.statSync(WATCHING_FILE).mtimeMs < 6000; } catch (e) { /* no viewer */ }
    watchedCache = { at: now, v };
  }
  return watchedCache.v;
}

// Settings or code changed on disk (node setup-camera.js, node pair.js,
// node update.js): in the background, restart to use them (the service
// starts us again); in a window, say so once.
function watchForChanges(onChange) {
  const files = [CONFIG, ...['rtsp-run.js', 'rtsp.js', 'detect.js', 'runner-config.js', 'runner-remote.js', 'walk-test.js', 'accuracy.js', 'screen-reader.js', 'checkin-feed.js', 'reader-core.js', 'member-keys.js', 'auto-update.js', 'camera-probe.js'].map(f => path.join(__dirname, f))];
  const sig = () => files.map(f => { try { const st = fs.statSync(f); return `${st.mtimeMs}:${st.size}`; } catch (e) { return '-'; } }).join('|');
  const first = sig();
  let told = false;
  const t = setInterval(() => {
    if (told || sig() === first) return;
    told = true;
    onChange();
  }, Number(process.env.RUNNER_WATCH_MS) || 20000);
  t.unref();
}

let shownEntryHint = false;
// Last time someone was at the turnstile without coming in (came back out,
// or stood there), per door: { at, kind, frames }. Sent along with an
// entry that follows within GATE_VISIT_WINDOW_MS, to spot a phone handed
// over so a second person can scan in on the same code.
const gateVisits = new Map();
const GATE_VISIT_WINDOW_MS = 90 * 1000;
// One entry can show as two movements (at J Street: walking UP to the
// turnstile, then LEFT through it). A crossing is held this long; more
// movement in that time joins it and the lot is checked once, so the
// model sees the whole entry (and it costs one check, not two).
const HOLD_MS = 4000;           // quiet this long after the last movement = send
const HOLD_MAX_MS = 15000;      // never hold one entry longer than this
// Up to 6 photos from several movements: the first and last of the
// earlier ones, the rest spread over the last one (the going-through).
function mergeFrames(lists) {
  const all = [].concat(...lists);
  if (all.length <= 6) return all;
  const early = [].concat(...lists.slice(0, -1));
  const late = lists[lists.length - 1];
  const keepEarly = early.length ? [early[0], early[early.length - 1]].filter((f, i, a) => a.indexOf(f) === i) : [];
  const room = 6 - keepEarly.length;
  const pick = [];
  for (let i = 0; i < room; i++) pick.push(late[Math.min(late.length - 1, Math.round(i * (late.length - 1) / Math.max(1, room - 1)))]);
  return keepEarly.concat(pick.filter((f, i, a) => a.indexOf(f) === i));
}

// node rtsp-run.js --entry up|down|left|right|off
// Saves which way people come IN on the picture. Crossings the other way
// (people leaving) are then skipped. The background monitor notices the
// changed settings and restarts by itself within about 20 seconds.
function setEntryDirection(val) {
  const v = String(val || '').toLowerCase().replace(/\s+/g, '');
  const ok = ['up', 'down', 'left', 'right'];
  const list = v === 'off' ? [] : [...new Set(v.split(',').filter(Boolean))];
  const clash = list.some(d => list.includes(detect.OPPOSITE[d]));
  if (v !== 'off' && (!list.length || list.some(d => !ok.includes(d)) || clash)) {
    if (clash) say('Those point opposite ways (e.g. up and down) - pick the ways people come IN only.');
    say('Type one of:  node rtsp-run.js --entry up   (or down, left, right, or off to check everyone)');
    say('Not sure which? Watch with  node rtsp-run.js , walk IN once, and look for "moving up/down/left/right" on that crossing line.');
    return 1;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { say(`Could not read the settings (${tildify(CONFIG)}). Run  node setup-camera.js  first.`); return 1; }
  for (const z of raw.zones || []) { if (v === 'off') delete z.entryDirection; else z.entryDirection = list.length === 1 ? list[0] : list; }
  require('./runner-config').writePrivate(CONFIG, JSON.stringify(raw, null, 2) + '\n');
  say(v === 'off'
    ? 'Saved: everyone crossing is checked again (in and out).'
    : `Saved: people coming in move ${list.join(' / ')} on the picture. People moving ${list.map(d => detect.OPPOSITE[d]).join(' / ')} (leaving) are skipped and cost nothing.`);
  say('The background monitor picks this up within about 20 seconds. Watch it with:  node rtsp-run.js');
  return 0;
}

// The front-desk screen reader (screen-reader.js) rides along with the
// background monitor when it has been set up on this box: one service runs
// both, and it is restarted if it ever stops.
let screenChild = null;
function startScreenReader() {
  const cfg = path.join(process.env.SECURITYAI_HOME || path.join(os.homedir(), '.securityai'), 'screen-reader.json');
  if (!fs.existsSync(path.join(__dirname, 'screen-reader.js'))) return;
  // Not set up yet: start it as soon as it is (node screen-reader.js --setup).
  if (!fs.existsSync(cfg)) { const t = setInterval(() => { if (fs.existsSync(cfg)) { clearInterval(t); startScreenReader(); } }, 60000); t.unref(); return; }
  const { spawn } = require('child_process');
  const go = () => {
    // A check-in feed set up on this computer replaces reading the screen.
    const feedCfg = path.join(process.env.SECURITYAI_HOME || path.join(os.homedir(), '.securityai'), 'checkin-feed.json');
    const script = fs.existsSync(feedCfg) && fs.existsSync(path.join(__dirname, 'checkin-feed.js')) ? 'checkin-feed.js' : 'screen-reader.js';
    screenChild = spawn(process.execPath, [path.join(__dirname, script)], { stdio: 'ignore', env: process.env });
    screenChild.on('exit', () => { screenChild = null; setTimeout(go, 15000).unref(); });
  };
  go();
  process.on('exit', () => { if (screenChild) try { screenChild.kill(); } catch (e) { /* gone */ } });
}

async function main() {
  if (FLAG.entry !== null) process.exit(setEntryDirection(FLAG.entry));
  if (SERVICE) startScreenReader();
  if (SERVICE) try { require('./auto-update').start({ log: m => sayAt(m), note: (t, ms) => addNote(t, ms) }); } catch (e) { /* older copy */ }
  // The accuracy test drives the monitor that is running (or starts one);
  // it never opens a camera connection itself.
  if (FLAG.test) {
    onSignal = () => {};    // walk-test.js handles Ctrl-C (it tidies up first)
    const code = await require('./walk-test').run(args.filter(a => a !== '--test').concat(FLAG.help ? ['--help'] : []));
    process.exit(code || 0);
  }
  const watchMode = !FLAG.check && !FLAG.snapshot;
  if (watchMode) {
    let other = otherRunner();
    if (other && !SERVICE && process.stdout.isTTY) return followLog(other);
    // The background monitor is switched on but (re)starting right now:
    // show its output instead of starting a second monitor in this window.
    if (!other && !SERVICE && process.stdout.isTTY && backgroundInstalled()) return followLog({ service: true, starting: true });
    if (other) {
      say(!SERVICE ? `Another monitor is already running (process ${other.pid}). Not starting a second one.`
        : other.service ? 'Restarting…'
        : 'The monitor is running in a Terminal window: the background one takes over when that window is closed (Ctrl-C there).');
      if (!SERVICE) process.exit(0);
      while ((other = otherRunner())) await new Promise(r => setTimeout(r, 3000));
    }
    claimPidFile();
  }
  const cfg = loadOrExit();
  if (!cfg) process.exit(1);
  const remoteMode = !!cfg.serverUrl;

  if (!rtsp.ffmpegAvailable()) {
    console.error('✗ ffmpeg is not installed or not on the PATH. Do this: install ffmpeg (see RTSP-SETUP.md), then check "ffmpeg -version" works in a new Terminal window.');
    process.exit(1);
  }

  if (FLAG.check || FLAG.snapshot) {
    say(`Config: ${CONFIG} ✓ (${plural(cfg.zones.length, 'zone')})`);
    say(`Mode:   ${remoteMode ? `Remote → ${cfg.serverUrl}` : 'Local (this laptop does the counting)'}`);
    if (FLAG.check && !remoteMode && !process.env.ANTHROPIC_API_KEY) say('✗ Local mode but ANTHROPIC_API_KEY is not set in .env — running would stop with an error. (Or use Remote mode: add serverUrl + runnerToken.)');
  }

  const results = await probeAll(cfg);
  console.log('');
  for (const r of results) say(describeProbe(r) + '\n');

  if (FLAG.check) {
    let ok = results.every(r => r.probe.ok) && (remoteMode || !!process.env.ANTHROPIC_API_KEY);
    if (remoteMode) {
      const { postJson, explainFailure } = require('./runner-remote');
      say(`Contacting the website ${cfg.serverUrl} (can take up to a minute if it is asleep)…`);
      const r = await postJson(cfg.serverUrl, '/monitor/runner/heartbeat', cfg.runnerToken, {
        gymCode: cfg.gymCode || null, host: os.hostname(), version: VERSION, config: tzConfig(cfg), zones: [],
      });
      if (r.status === 200) say('Website: ✓ connected, token accepted.');
      else { ok = false; say(`Website: ✗ ${explainFailure(r).msg.replace(' Will retry.', '')}`); }
    }
    say(ok ? '\nAll good. Start watching with:  node rtsp-run.js' : '\nFix the ✗ items above, then run  node rtsp-run.js --check  again.');
    process.exit(ok ? 0 : 1);
  }
  if (FLAG.snapshot) {
    const any = await runSnapshot(cfg, results);
    process.exit(any ? 0 : 1);
  }

  // Stop now on problems that retrying cannot fix (wrong password!).
  const fatal = results.filter(r => !r.probe.ok && r.probe.error && r.probe.error.fatal);
  if (fatal.length) {
    loud(['Not starting — fix this first:', ...fatal.map(r => `${r.z.label}: ${r.probe.error.message}`),
      ...fatal.filter(r => r.probe.error.fix).map(r => `Do this: ${r.probe.error.fix}`),
      ...(fatal.some(r => r.probe.error.kind === 'auth') ? ['Stopped instead of retrying: this NVR locks the account after repeated wrong passwords.'] : [])]);
    // In the background nobody sees this screen: keep telling the website
    // (the admin page shows it) until the settings are fixed.
    if (SERVICE && remoteMode) return waitForFix(cfg, results);
    process.exit(1);
  }

  const handles = [];
  // warnings per zone: from the settings + what the probe found (+ later,
  // a too-slow computer). Sent in every heartbeat.
  const warningsOf = new Map(results.map(r => [r.z, (r.warnings || []).slice()]));
  const addWarning = (z, w) => { const a = warningsOf.get(z) || []; if (!a.includes(w)) a.push(w); warningsOf.set(z, a); };
  // The accuracy test (walk-test.js) talks to this monitor through small
  // files; only in REMOTE mode (the website does the test's counting).
  const testLink = require('./walk-test').monitorLink({ codeDir: __dirname });
  const testHere = remoteMode ? testLink : null;
  const mode = remoteMode ? setupRemote(cfg, handles, warningsOf, testLink) : setupLocal(cfg);
  if (!mode) process.exit(1);

  // ---- banner ----
  const line = '─'.repeat(60);
  console.log(`\n${line}`);
  say(`SecurityAI camera monitor — ${mode.label} mode`);
  if (remoteMode) say(`Sending crossings to ${cfg.serverUrl} (the website does the counting).`);
  else say('Counting on this laptop.');
  if (mode.pageUrl) say(`Activity page: ${mode.pageUrl}`);
  say(`Schedule: ${cfg.scheduleStart && cfg.scheduleEnd ? `${cfg.scheduleStart}–${cfg.scheduleEnd} (crossings outside these hours are not counted)` : 'always on'}`);
  for (const r of results) {
    const c = r.crop;
    say(`• ${r.z.label}: ${r.z.isFile ? path.basename(r.z.cameraUrl) : maskUrl(r.z.cameraUrl)}`);
    if (r.probe.ok) say(`    ${r.probe.width}x${r.probe.height}, ${c.full ? 'whole picture' : `watching a ${c.w}x${c.h} box at ${c.x},${c.y}`}${c.scaled ? ` (scaled from ${c.from.w}x${c.from.h})` : ''}${c.clamped ? ' (box shrunk to fit)' : ''} · expects ${r.z.expectedCount} per crossing`);
    else say(`    not connected yet (${r.probe.error.message}) — will keep retrying.`);
  }
  say('Walk past the camera now — the motion number should jump.');
  say(SERVICE ? 'Running in the background (starts by itself). Watch it with: node rtsp-run.js' : 'Leave this window open. Use Cmd+N for a new window.');
  console.log(`${line}\n`);
  const scaledCrop = results.filter(r => r.crop && r.crop.scaled);
  if (scaledCrop.length) {
    loud(scaledCrop.map(r => `${r.z.label}: the camera picture changed size (was ${r.crop.from.w}x${r.crop.from.h}, now ${r.probe.width}x${r.probe.height}).`)
      .concat(['The watched box was scaled to match, so it should still cover the door.',
        'To check: node rtsp-run.js --snapshot  (in a new window) and look at the red box.']));
  }

  // Heartbeats: the website's "is the camera computer alive, is there a
  // picture" check. One at start, one the moment the first picture
  // arrives (so the website does not show "no picture" for 30 s), then
  // every 30 s. beatSoon() never sends more than one a second.
  let beating = false, beatAgain = false, lastBeatAt = 0, soonTimer = null;
  function beat() {
    if (beating) { beatAgain = true; return; }
    beating = true; lastBeatAt = Date.now();
    Promise.resolve(mode.heartbeat()).catch(err => warn(`heartbeat: ${err.message}`))
      .then(() => { beating = false; if (beatAgain) { beatAgain = false; beatSoon(); } });
  }
  function beatSoon() {
    if (soonTimer) return;
    soonTimer = setTimeout(() => { soonTimer = null; beat(); }, Math.max(0, 1000 - (Date.now() - lastBeatAt)));
  }

  const sens = detect.SENSITIVITY[cfg.sensitivity] || detect.SENSITIVITY.moderate;
  const startedAt = Date.now();
  const SETUP_WINDOW_MS = 5 * 60 * 1000;   // live motion lines for the walk test

  for (const r of results) {
    const z = r.z;
    let lastMotionLine = 0, lastRejectLine = 0, slowWarned = false, lastTestMotion = 0, lastBetweenLine = 0;
    // A crossing waiting a few seconds in case the person goes on through
    // (see HOLD_MS): { parts:[{frames, ev, evd, crossing}], capturedAt, firstAt, timer, busy }
    let held = null;
    const sendHeld = () => {
      const hd = held; held = null;
      if (!hd) return;
      clearTimeout(hd.timer);
      const crossings = hd.parts.filter(p => p.crossing);
      const last = crossings[crossings.length - 1];
      const frames = mergeFrames(hd.parts.map(p => p.frames));
      const span = (hd.lastAt - Date.parse(hd.capturedAt)) / 1000;
      const linger = Math.max(0, ...hd.parts.map(p => Number(p.ev.lingerSec) || 0));
      const ev = Object.assign({}, last.ev, {
        durationSec: Math.max(Number(last.ev.durationSec) || 0, span).toFixed(1),
        lingerSec: linger || undefined,
        before: hd.parts[0].ev.before,
      });
      const evd = last.evd || (hd.parts.find(p => p.evd) || {}).evd || null;
      const joined = hd.parts.length > 1 ? ` (${hd.parts.length} movements together, ${ev.durationSec} s)` : '';
      sayAt(`${z.label}  → sending ${plural(frames.length, 'photo')} to be counted${joined}${evd ? ' + a larger copy to look at' : ''}…`);
      if (process.env.RUNNER_DUMP_DIR) dumpEvent(z, frames, { evidence: evd });
      Promise.resolve(mode.send(z, frames, ev, hd.capturedAt, evd))
        .catch(err => warn(`${z.label}: ${err.message}`));
    };
    const holdTimer = () => {
      clearTimeout(held.timer);
      const left = HOLD_MAX_MS - (Date.now() - held.firstAt);
      held.timer = setTimeout(sendHeld, Math.max(0, Math.min(HOLD_MS, left)));
    };
    const h = rtsp.startRtspZoneResilient({
      cameraUrl: z.cameraUrl,
      cropSet: z.cropSet, cropX: z.cropX, cropY: z.cropY, cropW: z.cropW, cropH: z.cropH,
      frameW: z.frameW, frameH: z.frameH,
      sensitivity: sens, jpegMaxPx: 384, evidenceMaxPx: EVIDENCE_PX, secrets: SECRETS,
    }, {
      onEventStart: () => {
        // More movement while a crossing is held: wait for it to finish
        // (up to HOLD_MAX_MS) so it can join the same check.
        if (!held) return;
        clearTimeout(held.timer);
        held.timer = setTimeout(sendHeld, Math.max(0, HOLD_MAX_MS - (Date.now() - held.firstAt)));
      },
      onTamper: kind => {
        const words = { dark: 'the picture has gone almost black', covered: 'the picture is one flat colour (lens covered?)', frozen: 'the picture is frozen', moved: 'the camera seems to point somewhere else' };
        sayAt(kind ? `${z.label}  ⚠ CAMERA PROBLEM: ${words[kind] || kind}. SecurityAI is told.` : `${z.label}  ✓ the camera picture looks normal again.`);
        beatSoon();
      },
      onFlowing: () => {
        recorderFinder().noteWorking(z.cameraUrl).catch(() => {});
        sayAt(`${z.label}  ✓ picture is coming through.`);
        beatSoon();          // tell the website straight away, not in 30 s
      },
      onEvent: (framesB64, ev, extra) => {
        const capturedAt = new Date(Date.now() - Number(ev.durationSec || 0) * 1000).toISOString();
        const evd = extra && extra.evidence;
        // Accuracy test running: crossings during a test walk are test
        // crossings; crossings between walks (people getting in place)
        // are ignored and cost nothing.
        const ts = testHere && testHere.session(z.label);
        if (ts) {
          if (!ts.trial) {
            if (Date.now() - lastBetweenLine > 10000) { lastBetweenLine = Date.now(); sayAt(`${z.label}  crossing ignored (accuracy test running: between test walks)`); }
            return;
          }
          const got = testHere.take(ts);
          if (got.capped) {
            sayAt(`${z.label}  [test walk ${ts.trial.pos}] crossing seen, not sent (${got.capped === 'limit' ? 'the test\'s limit is used up' : 'too many in one walk'})`);
            testHere.emit({ type: 'crossing', runId: ts.runId, trial: ts.trial.n, capped: got.capped, durationSec: ev.durationSec });
            return;
          }
          const files = testHere.saveCrossing(ts, got.seq, framesB64, evd);
          sayAt(`${z.label}  ▶ [test walk ${ts.trial.pos}] crossing detected (${ev.durationSec} s) — sending to be counted (test only: no alert)…`);
          testHere.emit({ type: 'crossing', runId: ts.runId, trial: ts.trial.n, seq: got.seq, durationSec: ev.durationSec, files });
          Promise.resolve(mode.send(z, framesB64, ev, capturedAt, null, { runId: ts.runId, trial: ts.trial.n, expected: ts.trial.kind, seq: got.seq }))
            .catch(err => warn(`${z.label}: ${err.message}`));
          return;
        }
        // People LEAVING through the same turnstile: the opposite way to
        // the entry direction set with  node rtsp-run.js --entry <dir>.
        // Skipped here, so they cost nothing and don't use the daily limit.
        // Unclear direction = sent anyway (never miss a way in).
        const dirWord = ev.direction ? ` moving ${ev.direction}` : '';
        const ins = [].concat(z.entryDirection || []);
        if (ins.length && ev.direction && !ins.includes(ev.direction) && ins.some(d => detect.OPPOSITE[d] === ev.direction)) {
          sayAt(`${z.label}  ◁ someone leaving (${ev.durationSec} s,${dirWord}) — not checked, costs nothing`);
          // Remembered (free): if someone comes IN soon after, this moment
          // is sent too, to check for a phone handed back to scan again.
          gateVisits.set(z.label, { at: Date.now(), kind: 'left', frames: [framesB64[Math.floor(framesB64.length / 2)], framesB64[framesB64.length - 1]].filter((f, i, a) => f && a.indexOf(f) === i) });
          return;
        }
        if (!z.entryDirection && ev.direction && !shownEntryHint) {
          shownEntryHint = true;
          sayAt(`${z.label}  Tip: people leaving are checked too. Walk IN once, note the direction on its line, then run  node rtsp-run.js --entry up  (or down/left/right).`);
        }
        // Someone came back out, or stood at the turnstile, shortly before
        // this crossing: send that moment too (1-2 small photos), so a phone
        // handed over for a second scan of the same code can be seen.
        const visit = held ? null : gateVisits.get(z.label);
        if (!held) gateVisits.delete(z.label);
        const crossStart = Date.now() - Number(ev.durationSec || 0) * 1000;
        if (visit && visit.frames && visit.frames.length && crossStart - visit.at <= GATE_VISIT_WINDOW_MS) {
          ev = Object.assign({}, ev, { before: { frames: visit.frames.slice(0, 2), sec: Math.max(0, Math.round((crossStart - visit.at) / 1000)), kind: visit.kind } });
          sayAt(`${z.label}  ⚠ someone ${visit.kind === 'left' ? 'came out through' : 'was at'} the turnstile ${ev.before.sec} s before this — sending that moment too, to check for a phone handed over`);
        }
        if (ev.lingerSec) sayAt(`${z.label}  ⚠ someone was at the turnstile for about ${ev.lingerSec} s before this — looking closely`);
        sayAt(`${z.label}  ▶ crossing detected (${ev.durationSec} s${dirWord})${held ? ' — same entry as the movement just before' : ''}`);
        if (FLAG.verbose && extra && extra.evidenceSize) say(`    larger copy: ${extra.evidenceSize.width}x${extra.evidenceSize.height}, ${Math.round(extra.evidenceSize.bytes / 1024)} KB`);
        const part = { frames: framesB64, ev, evd, crossing: true };
        if (held) { held.parts.push(part); held.lastAt = Date.now(); }
        else held = { parts: [part], capturedAt, firstAt: Date.now(), lastAt: Date.now() };
        if (held.parts.length >= 4 || Date.now() - held.firstAt >= HOLD_MAX_MS) return sendHeld();
        holdTimer();
      },
      onRejected: (reason, info) => {
        const now = Date.now();
        if (held) {
          // Movement that didn't count as a crossing on its own, right after
          // one: often the going-through itself. Its photos join the check.
          if (info && info.frames && info.frames.length) { held.parts.push({ frames: info.frames, ev: {}, crossing: false }); held.lastAt = now; }
          holdTimer();
          return;
        }
        if (info && info.frames && info.frames.length) gateVisits.set(z.label, { at: now, kind: 'waited', frames: info.frames });
        const ts = testHere && testHere.session(z.label);
        if (ts && ts.trial) testHere.emit({ type: 'rejected', runId: ts.runId, trial: ts.trial.n, reason });
        if (now - lastRejectLine < 10000 && !FLAG.verbose) return;
        lastRejectLine = now;
        const why = reason === 'no-crossing' ? 'movement, but nothing crossed the middle of the watched area — ignored'
          : reason === 'too-brief' ? 'movement too brief to be a person — ignored'
          : `movement ignored (${reason})`;
        sayAt(`${z.label}  ${why}`);
      },
      onClose: (code, info, tail, retryIn) => {
        warn(`${z.label}: ${info.message}${info.fix ? ` Do this: ${info.fix}` : ''} (retrying in ${Math.round(retryIn / 1000)} s)`);
        // The recorder may have a new address (a power cut, a new router): find it and start again on it.
        recorderFinder().noteFailing(z.cameraUrl, info.kind).then(moved => {
          if (!moved) return;
          loud([`${z.label}: the recorder moved to ${moved} on the gym network (same recorder). Settings updated; starting again.`]);
          setTimeout(() => process.exit(0), 1500);     // the background service starts it again on the new address
        }).catch(() => {});
        if (FLAG.verbose && tail) say(`    ffmpeg said: ${tail}`);
      },
      onFatal: (info, tail) => {
        if (info.kind === 'auth') rememberLoginFailed(z.cameraUrl);
        if (info.kind === 'eof') { sendHeld(); sayAt(`${z.label}  the video file finished.`); maybeExitAllDone(); return; }
        loud([`${z.label}: STOPPED — ${info.message}`, info.fix ? `Do this: ${info.fix}` : '', tail && FLAG.verbose ? `ffmpeg said: ${tail}` : ''].filter(Boolean));
        maybeExitAllDone();
      },
      onStall: secs => {
        loud([`${z.label}: NO PICTURE for ${secs} seconds.`,
          h && h.stats.lastError ? `Last problem: ${h.stats.lastError}` : 'The camera connection is open but nothing is arriving.',
          'Likely cause: the laptop lost the gym network, or the NVR is busy/rebooting.',
          'It will reconnect by itself. If this repeats, check Wi-Fi, then run: node rtsp-run.js --check']);
      },
    });
    const origStats = h.stats;
    // live motion feedback during the first minutes (the walk test)
    const motionTimer = setInterval(() => {
      const now = Date.now();
      const ts = testHere && testHere.session(z.label);
      if (ts && ts.trial && now - lastTestMotion >= 1000) {
        const recent = origStats.motionHistory.filter(m => now - m.t <= 1000);
        const peak = recent.length ? Math.max(...recent.map(m => m.pct)) : 0;
        if (peak >= 5) { lastTestMotion = now; testHere.emit({ type: 'motion', runId: ts.runId, trial: ts.trial.n, peak }); }
      }
      if (!FLAG.verbose && now - startedAt > SETUP_WINDOW_MS && !beingWatched()) return;
      const recent = origStats.motionHistory.filter(m => now - m.t <= 1000);
      const peak = recent.length ? Math.max(...recent.map(m => m.pct)) : 0;
      if (peak >= 5 && now - lastMotionLine >= 2000) {
        lastMotionLine = now;
        sayAt(`${z.label}  motion ${spark([peak])} ${peak}%`);
      }
    }, 500);
    motionTimer.unref();
    // slow-computer hint once
    const slowTimer = setInterval(() => {
      if (slowWarned || !origStats.streamOk || Date.now() - startedAt < 30000) return;
      if (origStats.fps > 0 && origStats.fps < 3) {
        slowWarned = true;
        warn(`${z.label}: only ${origStats.fps.toFixed(1)} pictures a second (should be 4) — this computer is struggling to keep up with the camera. Do this: press Ctrl-C, run node setup-camera.js again and type S for the smaller version of the camera picture.`);
        addWarning(z, `Only ${origStats.fps.toFixed(1)} pictures a second (should be 4) — the camera computer cannot keep up with the big camera picture, so fast crossings may be missed. Fix: node setup-camera.js and type S for the smaller version.`);
        beatSoon();
      }
    }, 5000);
    slowTimer.unref();
    handles.push({ z, h });
  }

  function maybeExitAllDone() {
    if (handles.length === cfg.zones.length && handles.every(x => x.h.stopped)) {
      // Everything stopped: give queued sends a moment, then leave.
      const allEof = handles.every(x => x.h.stats.lastErrorKind === 'eof');
      setTimeout(() => shutdown(allEof ? 0 : 1), remoteMode ? 3000 : 500);
    }
  }

  // For the accuracy test (and anyone curious): what this monitor is doing.
  const writeStatus = () => testLink.writeStatus({ version: VERSION, remote: remoteMode, watching: true, service: SERVICE,
    zones: handles.map(({ z, h }) => ({ label: z.label, streamOk: !!h.stats.streamOk, fps: h.stats.streamOk && h.stats.fps ? Number(h.stats.fps.toFixed(1)) : 0,
      lastFrameAt: h.stats.lastFrameAt || null, lastError: h.stats.streamOk ? null : maskText(h.stats.lastError || '', SECRETS) || null })) });
  writeStatus();
  setInterval(writeStatus, 5000).unref();

  // status lines
  setInterval(() => {
    const now = Date.now();
    for (const { z, h } of handles) sayAt(statusLine(z, h, now));
    if (remoteMode && mode.queued) sayAt(`(${plural(mode.queued, 'crossing')} waiting to be sent to the website)`);
  }, STATUS_MS);

  // heartbeats (the website's "is the runner alive" check)
  if (remoteMode) say(`Contacting the website (can take up to a minute if it is asleep)…`);
  beat();
  setInterval(beat, HEARTBEAT_MS);

  const caff = keepAwake();
  watchForSleep((from, to) => {
    const mins = Math.max(1, Math.round((to - from) / 60000));
    const when = `from ${clock(from)} to ${clock(to)} (${mins} min)`;
    const text = `This computer was asleep ${when}, so nothing was watched then. Keep its lid open and the charger plugged in.`;
    loud([`This computer was asleep ${when}: nothing was watched then.`, 'Keep the lid OPEN and the charger plugged in: a closed lid puts a Mac to sleep.']);
    addNote(text, 18 * 3600e3);
    beatSoon();
  });
  guardStdin();

  let stopping = false;
  function shutdown(code) {
    if (stopping) return;
    stopping = true;
    console.log('\nStopping…');
    handles.forEach(({ h }) => h.stop());
    mode.stop();
    if (caff) { try { caff.kill(); } catch (e) { /* gone */ } }
    // give ffmpeg a moment to hang up politely, then make sure it is gone
    setTimeout(() => { rtsp.killAll(); process.exit(typeof code === 'number' ? code : 0); }, 700);
  }
  onSignal = () => shutdown(0);

  watchForChanges(() => {
    if (SERVICE) { sayAt('Settings or program files changed — restarting to use them.'); shutdown(0); }
    else loud(['Settings or program files changed since this started.', 'Do this: press Ctrl-C, then type  node rtsp-run.js  to use them.']);
  });
}

// Background mode, not watching because of a problem only a person can fix
// (wrong password, no channel...): check in with the website every 30 s so
// the admin page says what is wrong, instead of "computer offline". Starts
// again by itself when the settings file is re-saved (node setup-camera.js).
function waitForFix(cfg, results) {
  const { createRemote } = require('./runner-remote');
  const remote = createRemote({ serverUrl: cfg.serverUrl, runnerToken: cfg.runnerToken, queueDir: QUEUE_DIR, log: m => sayAt(m), warn: m => warn(m) });
  const zones = cfg.zones.map(z => {
    const r = results.find(x => x.z === z);
    const e = r && !r.probe.ok && r.probe.error;
    return { label: z.label, streamOk: false, fps: 0, framesSeen: 0, lastFrameAt: null, lastEventAt: null,
      lastError: e ? `Not watching: ${e.message}${e.fix ? ` Fix: ${e.fix.replace(/^run /, 'on the camera computer run ')}` : ''}` : 'Not watching until the other camera is fixed.',
      warnings: (z.warnings || []).slice(0, 10) };
  });
  const beat = () => Promise.resolve(remote.heartbeat({ gymCode: cfg.gymCode || null, host: os.hostname(), version: VERSION, config: tzConfig(cfg), zones })).catch(() => {});
  sayAt('Waiting for the settings to be fixed. The website shows this problem too.');
  const link = require('./walk-test').monitorLink({ codeDir: __dirname });
  const status = () => link.writeStatus({ version: VERSION, remote: true, watching: false, service: SERVICE,
    problem: zones.map(z => `${z.label}: ${z.lastError}`).join(' · ').slice(0, 400), zones: [] });
  status(); setInterval(status, 5000).unref();
  beat();
  setInterval(beat, HEARTBEAT_MS);
  watchForChanges(() => { sayAt('Settings changed — starting again.'); process.exit(0); });
  onSignal = () => process.exit(0);
}

process.on('exit', () => rtsp.killAll());
// Until the monitor is running (probing, --check, --snapshot), Ctrl-C
// just stops — main() swaps in the full shutdown once it starts.
let onSignal = () => { rtsp.killAll(); process.exit(130); };
process.on('SIGINT', () => onSignal());
process.on('SIGTERM', () => onSignal());

main().catch(err => {
  console.error(safe(`✗ The monitor crashed: ${err && err.stack || err}`));
  process.exit(1);
});
