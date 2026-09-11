// SecurityAI — persistent monitoring engine.
//
// This is what makes "runs nonstop until you stop it from the website"
// actually true. A browser tab can't do that — close it, let the laptop
// sleep, or lose focus, and any JS timer running inside it dies. This
// module runs inside the Node process started by `node server.js`, which
// keeps going independently of any browser window, and only stops when
// you call /monitor/stop (or kill the process).
//
// WHAT THIS NEEDS THAT server.js's PAYMENT SIDE DIDN'T:
//   - ffmpeg installed on this machine (a system binary, not an npm
//     package) — used to grab a single JPEG frame from a camera URL.
//       macOS:   brew install ffmpeg
//       Ubuntu:  sudo apt install ffmpeg
//       Windows: https://ffmpeg.org/download.html
//   - A real Anthropic API key in .env as ANTHROPIC_API_KEY. The browser
//     demo on securityai.html could call Claude without one because
//     claude.ai proxies that call for pages rendered inside it — a
//     standalone Node process has no such proxy and needs a real key
//     from console.anthropic.com.
//   - Optional: SMTP credentials (for email alerts) and/or Twilio
//     credentials (for SMS alerts). Both are optional independently —
//     configure either, both, or neither. With neither, flags still show
//     up in the log and on the dashboard, just without a push notification.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let twilioLib = null;
try { twilioLib = require('twilio'); } catch { /* optional dep not installed */ }

const state = {
  running: false,
  timer: null,
  startedAt: null,
  config: null,
  log: [],          // most recent first; rolling 24h, persisted to disk
  lastError: null,
  captureCount: 0,
  gymCode: null,
};

const MAX_LOG = 5000;              // generous — 24h of real events is far below this
const LOG_RETENTION_MS = 24*60*60*1000;
const DATA_DIR = process.env.DATA_DIR || __dirname;
// One log file per gym code, so two gyms sharing a server never see each
// other's entries. Codes are slugified before touching the filesystem so
// a code can't escape DATA_DIR via path characters.
// Evidence frames. An alert nobody can verify is an alert staff stop
// trusting, so every analyzed event keeps the middle frame of its burst
// (the one most likely to show the person mid-crossing). Stored as files
// rather than base64 in the log, which would bloat the JSON badly.
function framesDirFor(code) {
  const safe = safeCode(code);
  return path.join(DATA_DIR, `frames-${safe}`);
}

function saveEvidenceFrame(code, base64, id) {
  try {
    const dir = framesDirFor(code);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jpg`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return `${id}.jpg`;
  } catch (err) {
    console.warn('Could not save evidence frame:', err.message);
    return null;
  }
}

// Deletes frame files whose events have aged out of the 24h log, so disk
// usage stays bounded without a separate cleanup job.
function pruneEvidenceFrames(code, keptFiles) {
  try {
    const dir = framesDirFor(code);
    if (!fs.existsSync(dir)) return;
    const keep = new Set(keptFiles.filter(Boolean));
    for (const f of fs.readdirSync(dir)) {
      if (!keep.has(f)) fs.unlinkSync(path.join(dir, f));
    }
  } catch (err) { /* best effort */ }
}

// --- Long-term summary store ---------------------------------------
// The alert log is deliberately a rolling 24 hours. But the thing that
// actually justifies renewing a subscription is a monthly number:
// "47 unexpected entries last month, here they are." So flagged events
// only (never the routine ones) are kept separately for 35 days, along
// with their evidence frames. Flagged events are rare, so this stays
// small — a few hundred KB a month, not gigabytes.
const SUMMARY_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

function summaryFileFor(code) {
  return path.join(DATA_DIR, `summary-${safeCode(code)}.json`);
}

function loadSummary(code) {
  try {
    const f = summaryFileFor(code);
    if (!fs.existsSync(f)) return [];
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - SUMMARY_RETENTION_MS;
    return parsed.filter(e => {
      const t = Date.parse(e && e.timestamp);
      return !isNaN(t) && t >= cutoff;
    });
  } catch (err) { return []; }
}

function recordFlagged(code, entry) {
  try {
    const list = loadSummary(code);
    list.unshift(entry);
    fs.writeFileSync(summaryFileFor(code), JSON.stringify(list));
  } catch (err) {
    console.warn('Could not record flagged event:', err.message);
  }
}

// Aggregates a period into the shape the monthly email needs.
function buildReport(code, days, tzOffsetMinutes) {
  const span = (days || 30) * 24 * 60 * 60 * 1000;
  const since = Date.now() - span;
  const events = loadSummary(code).filter(e => Date.parse(e.timestamp) >= since);
  const byDay = {}, byZone = {}, byHour = {};
  for (const e of events) {
    const d = new Date(e.timestamp);
    const day = d.toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    const z = e.zoneLabel || 'Unlabelled';
    byZone[z] = (byZone[z] || 0) + 1;
    // Same timezone trap as the schedule: without this the monthly
    // report tells a US gym their busiest hour is 7am when it was 2am.
    const tz = typeof tzOffsetMinutes === 'number' ? tzOffsetMinutes
             : (state.config && state.config.tzOffsetMinutes);
    const hr = Math.floor(localMinutes(d, tz) / 60);
    byHour[hr] = (byHour[hr] || 0) + 1;
  }
  const busiestHour = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
  const worstDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  return {
    gymCode: code || 'default',
    days: days || 30,
    periodStart: new Date(since).toISOString(),
    periodEnd: new Date().toISOString(),
    totalFlagged: events.length,
    extraPeopleSeen: events.reduce((n, e) => n + Math.max(0, (e.people_count || 0) - (e.expectedCount || 1)), 0),
    daysWithActivity: Object.keys(byDay).length,
    byZone,
    busiestHour: busiestHour ? { hour: Number(busiestHour[0]), count: busiestHour[1] } : null,
    worstDay: worstDay ? { date: worstDay[0], count: worstDay[1] } : null,
    events: events.slice(0, 100),
  };
}

function safeCode(code) {
  return String(code || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';
}

function logFileFor(code) {
  return path.join(DATA_DIR, `alert-log-${safeCode(code)}.json`);
}
const DEFAULT_DAILY_BURST_CAP = 400;  // hard ceiling on analyses per rolling 24h

// The log is persisted to disk and pruned to a rolling 24 hours, so it
// survives restarts and reopening the page instead of vanishing. Note on
// hosting: this writes to the local filesystem, which persists across
// process restarts but NOT across a redeploy on ephemeral hosts like
// Render's default disk. Set DATA_DIR to a mounted persistent disk if you
// need it to survive deploys.
function pruneLog(list) {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const kept = (list || []).filter(e => {
    const t = Date.parse(e && e.timestamp);
    return !isNaN(t) && t >= cutoff;
  });
  if (kept.length > MAX_LOG) kept.length = MAX_LOG;
  return kept;
}

function loadLogFromDisk() {
  try {
    const file = logFileFor(state.gymCode);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? pruneLog(parsed) : [];
  } catch (err) {
    console.warn('Could not read alert log, starting fresh:', err.message);
    return [];
  }
}

let saveTimer = null;
function saveLogToDisk() {
  // Debounced: a burst of writes collapses into one, so a busy doorway
  // doesn't hammer the disk.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(logFileFor(state.gymCode), JSON.stringify(state.log));
      // Keep frames referenced by EITHER the 24h log or the 35-day
      // flagged summary — otherwise the monthly report's photos would be
      // deleted a day after the event.
      pruneEvidenceFrames(state.gymCode, [
        ...state.log.flatMap(e => [e && e.frame, ...((e && e.frames) || [])]),
        ...loadSummary(state.gymCode).flatMap(e => [e && e.frame, ...((e && e.frames) || [])]),
      ]);
    } catch (err) {
      console.warn('Could not persist alert log:', err.message);
    }
  }, 1000);
}

// Counts analyses in the trailing 24h — this is what the daily cap is
// measured against. Skipped/out-of-window entries never reach the log, so
// they correctly don't count toward the budget.
// How long the scheduled window is, in minutes. Used to pace the daily
// budget across the night rather than letting it burn out early.
function scheduleWindowMinutes(cfg) {
  if (!cfg || !cfg.scheduleStart || !cfg.scheduleEnd) return 24 * 60;
  const [sh, sm] = cfg.scheduleStart.split(':').map(Number);
  const [eh, em] = cfg.scheduleEnd.split(':').map(Number);
  if ([sh, sm, eh, em].some(n => isNaN(n))) return 24 * 60;
  const start = sh * 60 + sm, end = eh * 60 + em;
  const mins = start < end ? end - start : (24 * 60 - start) + end;
  return mins || 24 * 60;
}

// Minutes past midnight in the GYM's timezone, not the server's.
// getTimezoneOffset() returns minutes to ADD to local to reach UTC, so
// UTC-5 reports +300 — hence subtracting it here.
function localMinutes(date, tzOffsetMinutes) {
  if (typeof tzOffsetMinutes !== 'number' || isNaN(tzOffsetMinutes)) {
    return date.getHours() * 60 + date.getMinutes();   // fall back to server clock
  }
  const utcMins = date.getUTCHours() * 60 + date.getUTCMinutes();
  return ((utcMins - tzOffsetMinutes) % 1440 + 1440) % 1440;
}

// Minutes elapsed since the window opened.
function minutesIntoWindow(cfg, now) {
  const d = now || new Date();
  const mins = localMinutes(d, cfg && cfg.tzOffsetMinutes);
  if (!cfg || !cfg.scheduleStart) return mins;
  const [sh, sm] = cfg.scheduleStart.split(':').map(Number);
  if (isNaN(sh)) return mins;
  const start = sh * 60 + sm;
  return mins >= start ? mins - start : (24 * 60 - start) + mins;
}

// A hard stop at the cap is the wrong failure mode for a busy gym: you'd
// go blind at 1am with no warning, right when coverage matters. Instead,
// pace the budget across the scheduled window. If usage is running ahead
// of where it should be, stretch the per-zone cooldown so captures get
// less frequent but never stop. The cap remains as an absolute backstop.
function pacingFactor(cfg) {
  const cap = (cfg && cfg.dailyBurstCap) || DEFAULT_DAILY_BURST_CAP;
  const windowMins = scheduleWindowMinutes(cfg);
  const elapsed = Math.max(1, minutesIntoWindow(cfg));
  const expected = cap * Math.min(1, elapsed / windowMins);
  const used = burstsLast24h();
  if (used <= expected || expected <= 0) return 1;          // on or under budget
  return Math.min(8, used / expected);                       // over budget -> stretch cooldown, capped at 8x
}

function burstsLast24h() {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  return state.log.filter(e => {
    const t = Date.parse(e && e.timestamp);
    return !isNaN(t) && t >= cutoff;
  }).length;
}

// --- Dead-man's switch ------------------------------------------------
// The browser tab is the weak link: a Windows update, a closed tab, or a
// sleeping PC ends monitoring silently, and you'd only find out in the
// morning. So the tab sends a heartbeat while it's running, and if those
// stop during scheduled hours the server alerts you that monitoring went
// down. A known failure is recoverable; a silent one is not.
const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000;

function recordHeartbeat() {
  state.lastHeartbeat = Date.now();
  if (state.heartbeatLost) {
    state.heartbeatLost = false;
    pushLog({
      timestamp: new Date().toISOString(),
      mode: 'entry',
      systemEvent: 'resumed',
      note: 'Monitoring reconnected — the dashboard is sending heartbeats again.',
    });
    if (state.config) {
      sendAlert(state.config, `SecurityAI: monitoring at ${sourceLabelFor(state.config)} is back online.`).catch(() => {});
    }
  }
}

async function checkHeartbeat() {
  if (!state.running || state.heartbeatLost) return;
  if (!isWithinSchedule(state.config)) return;          // silence outside monitored hours
  if (!state.lastHeartbeat) return;
  if (Date.now() - state.lastHeartbeat < HEARTBEAT_TIMEOUT_MS) return;

  state.heartbeatLost = true;
  const mins = Math.round((Date.now() - state.lastHeartbeat) / 60000);
  const msg = `SecurityAI ALERT: monitoring at ${sourceLabelFor(state.config)} STOPPED ${mins} minutes ago and is not recording. The dashboard tab may have closed, the computer may have slept or restarted, or the screen share ended. Nothing is being watched until it is restarted.`;
  pushLog({
    timestamp: new Date().toISOString(),
    mode: 'entry',
    systemEvent: 'stopped',
    error: msg,
  });
  try { await sendAlert(state.config, msg); } catch (err) { /* logged above regardless */ }
}

// .unref() so this timer never by itself keeps a Node process alive —
// the server has its own reason to stay up, and scripts/tests that only
// require this module should still be able to exit.
const heartbeatTimer = setInterval(checkHeartbeat, 30 * 1000);
if (heartbeatTimer.unref) heartbeatTimer.unref();

// Restore whatever's still inside the 24h window from a previous run.
// Must run after the consts above are initialized, not at the state
// declaration — those are `const` and would still be in the temporal
// dead zone up there.
state.log = loadLogFromDisk();

function getStatus() {
  return {
    running: state.running,
    startedAt: state.startedAt,
    config: state.config,
    captureCount: state.captureCount,
    lastError: state.lastError,
    skippedOutOfWindow: state.skippedOutOfWindow || 0,
    skippedOverCap: state.skippedOverCap || 0,
    burstsLast24h: burstsLast24h(),
    lastHeartbeat: state.lastHeartbeat || null,
    heartbeatLost: !!state.heartbeatLost,
    pacingFactor: state.running ? Number(pacingFactor(state.config).toFixed(2)) : 1,
    projectedTotal: state.running ? (() => {
      const w = scheduleWindowMinutes(state.config);
      const e = Math.max(1, minutesIntoWindow(state.config));
      return Math.round(burstsLast24h() / e * w);
    })() : null,
    gymCode: state.gymCode,
    dailyBurstCap: (state.config && state.config.dailyBurstCap) || DEFAULT_DAILY_BURST_CAP,
    withinSchedule: state.running ? isWithinSchedule(state.config) : null,
  };
}

function getLog() {
  state.log = pruneLog(state.log);
  return state.log;
}

// Grabs one JPEG frame using ffmpeg, from one of two source types:
//
//   'url'    — an RTSP stream or HTTP snapshot URL. This path is fully
//              OS-independent: ffmpeg reads it as a network source, same
//              command on Windows, macOS, or Linux. This is what most
//              real IP cameras and NVR software expose, so it's the
//              recommended source for most gyms regardless of what
//              computer runs this server.
//
//   'webcam' — a USB/built-in camera plugged directly into the machine
//              running this server. Unlike a network URL, grabbing a
//              frame from a local device uses a different ffmpeg input
//              format per OS (v4l2 on Linux, avfoundation on macOS,
//              dshow on Windows), and the device identifier itself
//              (e.g. "/dev/video0" vs "0" vs "USB2.0 Camera") is
//              specific to the machine, not something we can guess
//              reliably — see listDevices() below, which runs the
//              right ffmpeg/OS command to help find it.
function buildCaptureArgs(cfg, outPath) {
  if (cfg.sourceType === 'webcam') {
    const platform = os.platform();
    const device = cfg.deviceId || '';
    if (!device) {
      throw new Error('No webcam device specified. Use "Detect connected cameras" on the dashboard to find the right value for this OS.');
    }
    if (platform === 'darwin') {
      // avfoundation device index, e.g. "0". framerate is required by
      // avfoundation even though we only keep one frame.
      return ['-y', '-f', 'avfoundation', '-framerate', '30', '-i', device, '-frames:v', '1', '-q:v', '2', outPath];
    }
    if (platform === 'win32') {
      // dshow expects "video=<device name>" exactly as listed by
      // -list_devices, quotes and all if the name has spaces.
      const input = device.startsWith('video=') ? device : `video=${device}`;
      return ['-y', '-f', 'dshow', '-i', input, '-frames:v', '1', '-q:v', '2', outPath];
    }
    // Linux and anything else falls back to v4l2, the standard Linux
    // webcam driver interface.
    return ['-y', '-f', 'v4l2', '-i', device, '-frames:v', '1', '-q:v', '2', outPath];
  }

  // 'url' source — RTSP needs an explicit transport flag for reliability
  // behind NAT/firewalls; anything else (HTTP snapshot, local file) is
  // read as-is.
  const cameraUrl = cfg.cameraUrl;
  return cameraUrl.startsWith('rtsp://')
    ? ['-y', '-rtsp_transport', 'tcp', '-i', cameraUrl, '-frames:v', '1', '-q:v', '2', outPath]
    : ['-y', '-i', cameraUrl, '-frames:v', '1', '-q:v', '2', outPath];
}

// Runs the OS-appropriate command to list connected cameras, so a gym
// owner can find the exact device identifier this platform needs — that
// value genuinely can't be guessed reliably in advance; it depends on
// what's plugged into that specific machine. Returns raw command output
// for the dashboard to display as-is, since the format differs by OS
// and isn't worth normalizing into a fake-unified shape.
function listDevices() {
  return new Promise((resolve) => {
    const platform = os.platform();

    if (platform === 'darwin') {
      const ff = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
      let out = '';
      ff.stderr.on('data', d => { out += d.toString(); });
      ff.on('error', err => resolve({ platform, ok: false, output: `ffmpeg not found: ${err.message}` }));
      ff.on('close', () => resolve({ platform, ok: true, output: out || 'No output — ffmpeg may not support avfoundation on this build.' }));
      return;
    }

    if (platform === 'win32') {
      const ff = spawn('ffmpeg', ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy']);
      let out = '';
      ff.stderr.on('data', d => { out += d.toString(); });
      ff.on('error', err => resolve({ platform, ok: false, output: `ffmpeg not found: ${err.message}` }));
      ff.on('close', () => resolve({ platform, ok: true, output: out || 'No output — ffmpeg may not support dshow on this build.' }));
      return;
    }

    // Linux: v4l2 devices show up as /dev/video*. There's no single
    // universal "list devices" ffmpeg subcommand for v4l2 the way there
    // is for avfoundation/dshow, so this lists the device files directly.
    fs.readdir('/dev', (err, files) => {
      if (err) return resolve({ platform, ok: false, output: `Could not read /dev: ${err.message}` });
      const videoDevices = files.filter(f => f.startsWith('video')).map(f => `/dev/${f}`);
      resolve({
        platform,
        ok: true,
        output: videoDevices.length
          ? `Found: ${videoDevices.join(', ')}\nTry the first one (usually /dev/video0). If a device doesn't respond, try the next.`
          : 'No /dev/video* devices found. Is a camera connected, and do you have permission to access it (try running with the right group membership, e.g. "video" group on most distros)?',
      });
    });
  });
}

function captureFrame(cfg) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(os.tmpdir(), `securityai-frame-${Date.now()}.jpg`);
    let args;
    try {
      args = buildCaptureArgs(cfg, outPath);
    } catch (err) {
      return reject(err);
    }

    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); });

    ff.on('error', err => {
      reject(new Error(`ffmpeg failed to start — is it installed and on your PATH? (${err.message})`));
    });

    ff.on('close', code => {
      if (code !== 0 || !fs.existsSync(outPath)) {
        return reject(new Error(`ffmpeg exited with code ${code}. Last output: ${stderr.slice(-300)}`));
      }
      fs.readFile(outPath, (err, data) => {
        fs.unlink(outPath, () => {}); // best-effort cleanup, don't block on it
        if (err) return reject(err);
        resolve(data.toString('base64'));
      });
    });
  });
}

const vision = require('./vision');
const mailer = require('./mailer');

let twilioClient = null;
function getTwilioClient() {
  if (twilioClient) return twilioClient;
  if (!twilioLib || !process.env.TWILIO_SID) return null;
  twilioClient = twilioLib(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
  return twilioClient;
}

async function sendAlert(cfg, message) {
  const results = { email: null, sms: null };

  if (cfg.alertEmail) {
    const result = await mailer.sendMail({
      to: cfg.alertEmail,
      subject: 'SecurityAI alert — unscanned entry detected',
      text: message,
    });
    results.email = result.delivered ? 'sent' : `skipped/failed — ${result.reason}`;
  }

  if (cfg.alertPhone) {
    const client = getTwilioClient();
    if (!client) {
      results.sms = 'skipped — Twilio not configured in .env';
    } else if (!process.env.TWILIO_FROM_NUMBER) {
      results.sms = 'skipped — TWILIO_FROM_NUMBER not set in .env';
    } else {
      try {
        await client.messages.create({
          from: process.env.TWILIO_FROM_NUMBER,
          to: cfg.alertPhone,
          body: message,
        });
        results.sms = 'sent';
      } catch (err) {
        results.sms = `failed — ${err.message}`;
      }
    }
  }

  return results;
}

// Fires a real alert through the configured channels without touching
// monitoring state — used by the preflight test button.
async function sendTestAlert(cfg, message) {
  return sendAlert(cfg, message);
}

function pushLog(entry) {
  state.log.unshift(entry);
  state.log = pruneLog(state.log);
  saveLogToDisk();
}

function sourceLabelFor(cfg) {
  if (cfg.label) return cfg.label;
  if (cfg.sourceType === 'webcam') return `webcam ${cfg.deviceId}`;
  if (cfg.sourceType === 'browser-push') return 'screen share (browser tab)';
  return cfg.cameraUrl;
}

// Same time-boxed authorization logic as the browser demo's zone list
// (securityai.html's getActiveRestrictedZones), just evaluated fresh on
// the server's clock every tick instead of once per manual click — a
// zone's authorization can expire mid-run, and the next capture should
// reflect that immediately. Deliberately plain date comparison, never
// handed to Claude as a "figure out if this is currently allowed"
// judgment call.
function getActiveZoneNames(zones) {
  const now = new Date();
  return (zones || [])
    .filter(z => z && z.name)
    .filter(z => {
      if (!z.authorizedUntil) return true;
      const authDate = new Date(z.authorizedUntil);
      return isNaN(authDate) || !(authDate > now); // authorized right now -> excluded (fail-safe on bad dates)
    })
    .map(z => z.name);
}

// Schedule window enforcement. Times are "HH:MM" strings in the SERVER's
// local timezone. Handles the overnight wrap case (e.g. 23:00 -> 05:00)
// which is the whole point here — an unstaffed gym's risky hours cross
// midnight, so a naive start<now<end comparison would never match.
// Enforced here on the server as well as in the browser, so a stale or
// tampered-with browser tab can't run up charges outside the window.
function isWithinSchedule(cfg, now) {
  if (!cfg || !cfg.scheduleStart || !cfg.scheduleEnd) return true; // no window set = always on
  const d = now || new Date();
  // The schedule the user typed is in THEIR timezone, but this server
  // almost certainly runs in UTC (Render does). Comparing the two
  // directly silently rejects everything outside the accidental overlap
  // — for a US gym that means the small hours, which is exactly when it
  // matters. tzOffsetMinutes comes from the browser's
  // Date.getTimezoneOffset(), so this converts to the gym's local clock.
  const mins = localMinutes(d, cfg.tzOffsetMinutes);
  const [sh, sm] = cfg.scheduleStart.split(':').map(Number);
  const [eh, em] = cfg.scheduleEnd.split(':').map(Number);
  if ([sh, sm, eh, em].some(n => isNaN(n))) return true; // unparseable = fail open rather than silently never running
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (start === end) return true;
  return start < end
    ? (mins >= start && mins < end)          // same-day window
    : (mins >= start || mins < end);         // wraps past midnight
}

// Shared by anything that produces an "entry-shaped" result (people_count/
// tailgate_flag/etc.) — the fixed-interval tick loop, browser-pushed
// single frames, and motion-triggered bursts all funnel through here so
// the alert/log behavior is identical no matter how the frame arrived.
async function handleEntryResult(result, cfg, extra) {
  let alertResult = null;
  if (result.tailgate_flag) {
    recordFlagged(state.gymCode, {
      timestamp: new Date().toISOString(),
      zoneLabel: (extra && extra.zoneLabel) || cfg.label || null,
      people_count: result.people_count,
      expectedCount: cfg.expectedCount,
      note: result.note,
      frame: (extra && extra.frame) || null,
    });
    const message = `SecurityAI: unscanned entry at ${sourceLabelFor(cfg)} — ${result.people_count} seen, ${cfg.expectedCount} expected. "${result.note}"`;
    alertResult = await sendAlert(cfg, message);
  }
  pushLog({
    timestamp: new Date().toISOString(),
    mode: 'entry',
    people_count: result.people_count,
    queued_count: result.queued_count,
    accessible_gate_used: result.accessible_gate_used,
    tailgate_flag: result.tailgate_flag,
    note: result.note,
    alertResult,
    ...extra,
  });
}

// Shared by both acquisition paths: ffmpeg pulling a frame on its own
// timer (tick, below), and a browser tab pushing a screen-share frame it
// captured itself (pushFrame, below). Branches by cfg.mode: 'entry' is
// the original single-doorway tailgate/queue/accessible-gate detection;
// 'wall' is multi-camera dashboard scanning against zone rules.
async function processFrame(base64) {
  const cfg = state.config;
  const ts = new Date().toISOString();

  if (cfg.mode === 'wall') {
    try {
      const activeZones = getActiveZoneNames(cfg.zones);
      const result = await vision.scanCameraWall(base64, activeZones);
      state.captureCount += 1;
      state.lastError = null;

      const cameras = result.cameras || [];
      const flagged = cameras.filter(c => c.flag);
      let alertResult = null;
      if (flagged.length) {
        const summary = flagged.map(c => `${c.label} (${c.people_count} seen — ${c.note})`).join('; ');
        const message = `SecurityAI: zone flag at ${sourceLabelFor(cfg)} — ${summary}`;
        alertResult = await sendAlert(cfg, message);
      }

      pushLog({
        timestamp: ts,
        mode: 'wall',
        cameras,
        summary: result.summary,
        flaggedCount: flagged.length,
        alertResult,
      });
    } catch (err) {
      state.lastError = err.message;
      pushLog({ timestamp: ts, mode: 'wall', error: err.message });
    }
    return;
  }

  try {
    const result = await vision.analyzeEntry(base64, cfg);
    state.captureCount += 1;
    state.lastError = null;
    await handleEntryResult(result, cfg);
  } catch (err) {
    state.lastError = err.message;
    pushLog({ timestamp: ts, mode: 'entry', error: err.message });
  }
}

// ffmpeg-driven acquisition, used for 'url' and 'webcam' sources — the
// server pulls a frame on its own timer, independent of any browser.
async function tick() {
  const cfg = state.config;
  try {
    const base64 = await captureFrame(cfg);
    await processFrame(base64);
  } catch (err) {
    state.lastError = err.message;
    pushLog({ timestamp: new Date().toISOString(), error: err.message });
  }
}

// Browser-driven acquisition, used for 'browser-push' (screen share).
// A screen share is fundamentally a browser-mediated permission — there
// is no way for a headless server process to capture a screen without
// an active, consenting browser tab doing the sharing. So for this
// source only, the browser tab itself captures each frame and POSTs it
// here on its own timer; this function just runs the same analysis/
// alert/log path once a frame arrives. If that browser tab closes, this
// source stops receiving frames — which is an inherent property of
// screen-sharing, not a bug specific to this implementation.
async function pushFrame(base64) {
  if (!state.running || state.config.sourceType !== 'browser-push') {
    throw new Error('Monitoring is not running with a browser-push source.');
  }
  await processFrame(base64);
}

// Motion-triggered zone bursts (see securityai.html / monitor.html's ROI
// motion detection — the browser watches a cropped region of the shared
// screen for local pixel motion, for free, with no API call, and only
// sends frames here once it actually sees something happen at that
// specific entrance). Each zone carries its own expectedCount/
// accessibleGate/label, independent of whatever the top-level monitoring
// config says, since one screen can have several different entrances
// each with their own rules.
async function pushBurst(frames, zoneCfg, evidence) {
  if (!state.running || state.config.sourceType !== 'browser-push') {
    throw new Error('Monitoring is not running with a browser-push source.');
  }
  if (!Array.isArray(frames) || frames.length < 1) {
    throw new Error('At least one frame is required.');
  }
  // Multi-frame bursts are better — a sequence shows whether someone
  // paused to scan before crossing. But plenty of NVRs only send a single
  // snapshot per event, and one frame still answers the main question:
  // how many people are in the doorway. Single frames get the
  // single-image prompt rather than the sequence one, which would
  // otherwise tell Claude to reason about movement it cannot see.
  const singleFrame = frames.length === 1;
  recordHeartbeat();
  if (!isWithinSchedule(state.config)) {
    // Outside the configured window: drop it silently rather than paying
    // for an analysis nobody asked for. Not an error — this is the
    // schedule working as intended.
    state.skippedOutOfWindow = (state.skippedOutOfWindow || 0) + 1;
    return { skipped: 'outside-schedule' };
  }

  // Hard spending ceiling. Without this, something that moves constantly
  // in a drawn zone — a TV, a screensaver, a flickering light, or a
  // dashboard clock overlay ticking every second — could fire a burst
  // every 5 seconds all night and run up a bill far beyond what the
  // subscription covers. Measured over a rolling 24h, not a calendar day.
  const cap = state.config.dailyBurstCap || DEFAULT_DAILY_BURST_CAP;
  if (burstsLast24h() >= cap) {
    if (!state.capNotified) {
      state.capNotified = true;
      pushLog({
        timestamp: new Date().toISOString(),
        mode: 'entry',
        error: `Daily analysis cap of ${cap} reached — further analyses paused until older ones age out of the 24h window. If this was unexpected, a zone is probably picking up constant motion (a screen, a clock overlay, or a light).`,
        capReached: true,
      });
    }
    state.skippedOverCap = (state.skippedOverCap || 0) + 1;
    return { skipped: 'daily-cap' };
  }
  state.capNotified = false;

  const cfg = {
    ...state.config,
    label: zoneCfg.label || state.config.label,
    durationSec: zoneCfg.durationSec || null,
    expectedCount: parseInt(zoneCfg.expectedCount, 10) || 1,
    accessibleGate: !!zoneCfg.accessibleGate,
  };

  // Save the evidence frame BEFORE analysis, not after. If the API call
  // fails you still want the picture — otherwise the one event you most
  // need to look at is the one with nothing attached.
  // Middle frame of the burst is most likely to catch the person actually
  // mid-doorway rather than just entering or leaving the crop.
  // Prefer the larger evidence copy the browser sent for human viewing;
  // fall back to the middle analysis frame if it wasn't provided.
  // Save every frame that was sent for analysis, not just one. The log
  // shows Claude's conclusion, and you should be able to see exactly the
  // images it drew that conclusion from — one representative thumbnail
  // isn't enough to check its work.
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const allFrames = frames
    .map((f, i) => saveEvidenceFrame(state.gymCode, f, `${stamp}-${i}`))
    .filter(Boolean);
  const keep = evidence || frames[Math.floor(frames.length / 2)];
  const frame = saveEvidenceFrame(state.gymCode, keep, `${stamp}-main`) || allFrames[0];

  try {
    const result = singleFrame
      ? await vision.analyzeEntry(frames[0], cfg)
      : await vision.analyzeEntryBurst(frames, cfg);
    state.captureCount += 1;
    state.lastError = null;
    await handleEntryResult(result, cfg, { burstFrames: frames.length, zoneLabel: zoneCfg.label || null, frame, frames: allFrames });
  } catch (err) {
    state.lastError = err.message;
    pushLog({
      timestamp: new Date().toISOString(),
      mode: 'entry',
      error: err.message,
      zoneLabel: zoneCfg.label || null,
      frame,
      frames: allFrames,
    });
  }
}

function start(cfg) {
  if (state.running) throw new Error('Monitoring is already running — stop it first.');

  // Switching to a different gym loads that gym's own log rather than
  // carrying the previous one over.
  const code = (cfg.gymCode || '').trim() || null;
  if (code !== state.gymCode) {
    state.gymCode = code;
    state.log = loadLogFromDisk();
  }

  const validTypes = ['url', 'webcam', 'browser-push'];
  const sourceType = validTypes.includes(cfg.sourceType) ? cfg.sourceType : 'url';
  if (sourceType === 'url' && !cfg.cameraUrl) {
    throw new Error('cameraUrl is required for an IP camera / stream source.');
  }
  if (sourceType === 'webcam' && !cfg.deviceId) {
    throw new Error('deviceId is required for a webcam source — use "Detect connected cameras" to find it.');
  }
  // browser-push needs no server-side address — the browser tab captures
  // and posts frames itself, so there's nothing to validate here beyond
  // the shared fields below.

  // mode is independent of sourceType — any of the three sources above
  // can feed either kind of analysis. 'entry' is the original
  // single-doorway tailgate/queue/accessible-gate detection; 'wall' is
  // rules-based multi-camera dashboard scanning (see vision.scanCameraWall).
  const mode = cfg.mode === 'wall' ? 'wall' : 'entry';
  const zones = mode === 'wall' && Array.isArray(cfg.zones)
    ? cfg.zones
        .filter(z => z && typeof z.name === 'string' && z.name.trim())
        .map(z => ({ name: z.name.trim(), authorizedUntil: z.authorizedUntil || null }))
    : [];

  let secs = parseInt(cfg.intervalSeconds, 10);
  if (!secs || secs < 5) secs = 5; // floor — this hits a real API on a real bill every tick/push

  state.config = {
    sourceType,
    mode,
    zones,
    cameraUrl: cfg.cameraUrl || null,
    deviceId: cfg.deviceId || null,
    label: cfg.label || '',
    expectedCount: parseInt(cfg.expectedCount, 10) || 1,
    accessibleGate: !!cfg.accessibleGate,
    alertEmail: cfg.alertEmail || null,
    alertPhone: cfg.alertPhone || null,
    intervalSeconds: secs,
    model: cfg.model || null,
    scheduleStart: cfg.scheduleStart || null,
    scheduleEnd: cfg.scheduleEnd || null,
    // A negative or zero cap used to be accepted, which made every burst
    // fail the cap check and silently disabled monitoring for the night.
    // A typo in config should not quietly turn the product off.
    dailyBurstCap: (() => {
      const n = parseInt(cfg.dailyBurstCap, 10);
      return (Number.isFinite(n) && n > 0) ? n : DEFAULT_DAILY_BURST_CAP;
    })(),
    gymCode: code,
    tzOffsetMinutes: typeof cfg.tzOffsetMinutes === 'number' ? cfg.tzOffsetMinutes : null,
  };
  state.skippedOutOfWindow = 0;
  state.skippedOverCap = 0;
  state.capNotified = false;
  state.lastHeartbeat = Date.now();
  state.heartbeatLost = false;
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.captureCount = 0;
  state.lastError = null;
  state.log = pruneLog(state.log);

  if (sourceType === 'browser-push') {
    // No server-side timer — the browser tab drives its own interval and
    // hits /monitor/push-frame directly. We just sit and wait.
    return;
  }

  tick(); // run one immediately
  state.timer = setInterval(tick, secs * 1000);
}

function stop() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  state.running = false;
}

module.exports = { start, stop, getStatus, getLog, listDevices, pushFrame, pushBurst, getActiveZoneNames, isWithinSchedule, burstsLast24h, framesDirFor, safeCode, pacingFactor, scheduleWindowMinutes, localMinutes, buildReport, loadSummary, recordHeartbeat, sendTestAlert, platform: os.platform() };
