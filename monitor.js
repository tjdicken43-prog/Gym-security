// SecurityAI — persistent monitoring engine.
//
// This is what makes "runs nonstop until you stop it from the website"
// actually true. A browser tab can't do that — close it, let the laptop
// sleep, or lose focus, and any JS timer running inside it dies. This
// module runs inside the Node process started by `node server.js`, which
// keeps going independently of any browser window, and only stops when
// you call /monitor/stop (or kill the process).
//
// ONE WEBSITE, MANY GYMS. Every gym has its own monitor state, keyed by
// its filesystem-safe gym key: its own config, log, photos, daily cap and
// cost counters, pacing, dead-man's switch and status. J Street's camera
// computer and Iron Street's camera computer run side by side and never
// see or spend each other's budget. MAX_TOTAL_DAILY_BURSTS (optional) is
// a site-wide backstop on top of the per-gym caps.
//
// The older single-gym callers (monitor.html's Start button, the email /
// FTP ingest, rtsp-run.js's local mode) keep calling start()/pushBurst()/
// getStatus() without a gym: those act on the "primary" gym — the one the
// last start() named (or "default").
//
// WHAT THIS NEEDS:
//   - ffmpeg on this machine only for the 'url' / 'webcam' sources.
//   - ANTHROPIC_API_KEY in the environment (Render > Environment).
//   - Optional: SMTP (email alerts) and/or Twilio (text alerts).

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gymStore = require('./gym-store');
const gyms = require('./gyms');

let twilioLib = null;
try { twilioLib = require('twilio'); } catch { /* optional dep not installed */ }

const MAX_LOG = 5000;              // generous — 48h of real events is far below this
// How long the activity log keeps events (and their photos). Set
// LOG_RETENTION_HOURS to change it. Flagged events (and anything the gym
// marks Tailgate) are ALSO kept in the 35-day summary store.
const LOG_RETENTION_HOURS = (() => {
  const n = parseFloat(process.env.LOG_RETENTION_HOURS);
  return (Number.isFinite(n) && n > 0 && n <= 24 * 30) ? n : 48;
})();
const LOG_RETENTION_MS = LOG_RETENTION_HOURS * 60 * 60 * 1000;
// Absolute: express's res.sendFile refuses a relative path (DATA_DIR=./data).
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const DEFAULT_DAILY_BURST_CAP = 400;  // hard ceiling on analyses per rolling 24h

function safeCode(code) {
  return String(code || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';
}
function logFileFor(code) {
  return path.join(DATA_DIR, `alert-log-${safeCode(code)}.json`);
}
function framesDirFor(code) {
  return path.join(DATA_DIR, `frames-${safeCode(code)}`);
}

// --- Time in the gym's own zone ----------------------------------------
// Milliseconds to add to a UTC instant to get the wall clock in `tz`.
function tzOffsetMs(t, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t))) p[x.type] = x.value;
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUtc - Math.floor(t / 1000) * 1000;
}
function partsFromShifted(ms) {
  const x = new Date(ms);
  return {
    day: x.toISOString().slice(0, 10),
    hour: x.getUTCHours(), minute: x.getUTCMinutes(), second: x.getUTCSeconds(),
    minutes: x.getUTCHours() * 60 + x.getUTCMinutes(),
    year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, date: x.getUTCDate(),
  };
}
function zonedAt(t, tz) {
  try { return partsFromShifted(t + tzOffsetMs(t, tz)); } catch (e) { return partsFromShifted(t); }
}
// Hour and calendar day of a moment in the gym's own time zone.
function zonedParts(d, timeZone) {
  try { const p = zonedAt(new Date(d).getTime(), timeZone); return { hour: p.hour, day: p.day }; } catch (e) { return null; }
}
// UTC instant of local midnight on y-m-d in tz (DST-safe to the hour).
function zonedMidnightUtc(y, m, d, tz) {
  const guess = Date.UTC(y, m - 1, d);
  let t = guess - tzOffsetMs(guess, tz);
  t = guess - tzOffsetMs(t, tz);
  return t;
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
// The local clock a config's schedule is written in: an IANA zone set on
// the website wins; else the camera computer's UTC offset; else the gym's
// zone; else the server clock (old behaviour).
function cfgLocal(cfg, now) {
  const t = (now || new Date()).getTime();
  if (cfg && cfg.timeZone) return zonedAt(t, cfg.timeZone);
  if (cfg && typeof cfg.tzOffsetMinutes === 'number' && Number.isFinite(cfg.tzOffsetMinutes)) return partsFromShifted(t - cfg.tzOffsetMinutes * 60000);
  if (cfg && cfg.gymCode) return zonedAt(t, gyms.timeZoneFor(cfg.gymCode));
  const d = new Date(t);
  return partsFromShifted(t - d.getTimezoneOffset() * 60000);
}
function parseSchedule(cfg) {
  if (!cfg || !cfg.scheduleStart || !cfg.scheduleEnd) return null;
  const [sh, sm] = String(cfg.scheduleStart).split(':').map(Number);
  const [eh, em] = String(cfg.scheduleEnd).split(':').map(Number);
  if ([sh, sm, eh, em].some(n => isNaN(n))) return null;
  return { start: sh * 60 + sm, end: eh * 60 + em };
}

// Schedule window enforcement. Handles the overnight wrap case (e.g.
// 23:00 -> 05:00), which is the whole point — an unstaffed gym's risky
// hours cross midnight.
function isWithinSchedule(cfg, now) {
  const w = parseSchedule(cfg);
  if (!w) return true;                        // no window (or unparseable) = always on
  if (w.start === w.end) return true;
  const mins = cfgLocal(cfg, now).minutes;
  return w.start < w.end
    ? (mins >= w.start && mins < w.end)
    : (mins >= w.start || mins < w.end);
}
function scheduleWindowMinutes(cfg) {
  const w = parseSchedule(cfg);
  if (!w) return 24 * 60;
  const mins = w.start < w.end ? w.end - w.start : (24 * 60 - w.start) + w.end;
  return mins || 24 * 60;
}
function minutesIntoWindow(cfg, now) {
  const mins = cfgLocal(cfg, now).minutes;
  const w = parseSchedule(cfg);
  if (!w) return mins;
  return mins >= w.start ? mins - w.start : (24 * 60 - w.start) + mins;
}
// The "night" an instant belongs to: the gym-local date the watch window
// STARTED on (2 am Tuesday belongs to Monday night).
function nightKeyFor(cfg, now) {
  const p = cfgLocal(cfg, now);
  const w = parseSchedule(cfg);
  if (w && w.start > w.end && p.minutes < w.end) {
    return new Date(Date.UTC(p.year, p.month - 1, p.date) - 864e5).toISOString().slice(0, 10);
  }
  return p.day;
}

// --- Per-gym state -------------------------------------------------------
const states = new Map();      // gym key -> state
let primaryKey = null;         // gym used by callers that name none

function loadLogFromDisk(key) {
  try {
    const file = logFileFor(key);
    if (!fs.existsSync(file)) return [];
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? pruneLog(parsed) : [];
  } catch (err) {
    console.warn(`Could not read alert log for "${key}", starting fresh (the damaged file is kept beside it):`, err.message);
    try { const f = logFileFor(key); fs.renameSync(f, `${f}.damaged-${Date.now()}`); } catch (e) { /* none */ }
    return [];
  }
}
function pausedOnDisk(key) { try { return gymStore.isPaused(key); } catch (e) { return false; } }
function newState(key) {
  return {
    key, gymCode: key, running: false, timer: null, startedAt: null, startedAtMs: 0, config: null,
    log: loadLogFromDisk(key), lastError: null, captureCount: 0, inFlight: 0,
    skippedOutOfWindow: 0, skippedOverCap: 0, skippedGlobalCap: 0, capNotified: false,
    lastHeartbeat: null, heartbeatLost: false, startedBy: null, stoppedByOperator: pausedOnDisk(key),
    runnerConfigApplied: false, lastRunnerConfig: null, runnerHost: null, saveTimer: null,
    configSources: null,
  };
}
function stateFor(code) {
  const k = safeCode(code);
  let s = states.get(k);
  if (!s) { s = newState(k); states.set(k, s); }
  return s;
}
function defaultKey() {
  if (primaryKey) return primaryKey;
  let best = null;
  for (const s of states.values()) if (s.running && (!best || s.startedAtMs > best.startedAtMs)) best = s;
  return best ? best.key : 'default';
}
function primary() { return stateFor(defaultKey()); }
function sOrPrimary(code) { return (code === undefined || code === null || code === '') ? primary() : stateFor(code); }

// --- Evidence photos ------------------------------------------------------
function saveEvidenceFrame(code, base64, id) {
  try {
    const dir = framesDirFor(code);
    // Not recursive: if DATA_DIR itself is missing (a Render Disk that
    // isn't mounted), fail loudly instead of quietly creating a folder on
    // the throwaway disk.
    if (!fs.existsSync(dir)) fs.mkdirSync(dir);
    const file = path.join(dir, `${id}.jpg`);
    fs.writeFileSync(file, Buffer.from(base64, 'base64'));
    return `${id}.jpg`;
  } catch (err) {
    console.warn('Could not save evidence frame:', err.message);
    return null;
  }
}
// A photo saved in the last few minutes may belong to a crossing that is
// still being analysed (saved BEFORE the model call, logged after it), so
// it is never pruned yet: the next save after that picks it up if unused.
const PRUNE_MIN_AGE_MS = 15 * 60 * 1000;
function pruneEvidenceFrames(code, keptFiles) {
  try {
    const dir = framesDirFor(code);
    if (!fs.existsSync(dir)) return;
    const keep = new Set(keptFiles.filter(Boolean));
    const young = Date.now() - PRUNE_MIN_AGE_MS;
    for (const f of fs.readdirSync(dir)) {
      if (keep.has(f)) continue;
      const full = path.join(dir, f);
      try { if (fs.statSync(full).mtimeMs > young) continue; } catch (e) { continue; }
      fs.unlinkSync(full);
    }
  } catch (err) { /* best effort */ }
}
// Write-then-rename, so a crash or redeploy mid-write never leaves a
// half-written (unreadable) file behind.
function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// --- Long-term summary store (35 days) --------------------------------
// Flagged events, plus anything the gym marked Tailgate, with their photos.
const SUMMARY_RETENTION_MS = 35 * 24 * 60 * 60 * 1000;
function summaryFileFor(code) {
  return path.join(DATA_DIR, `summary-${safeCode(code)}.json`);
}
// null = the file exists but can't be read (damaged): callers must not
// treat that as "nothing kept" and delete the kept photos.
function readSummaryFile(code) {
  try {
    const f = summaryFileFor(code);
    if (!fs.existsSync(f)) return [];
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    console.warn(`Could not read the 35-day store for "${safeCode(code)}":`, err.message);
    return null;
  }
}
function loadSummary(code) {
  const parsed = readSummaryFile(code);
  if (!parsed) return [];
  const cutoff = Date.now() - SUMMARY_RETENTION_MS;
  return parsed.filter(e => {
    const t = Date.parse(e && e.timestamp);
    return !isNaN(t) && t >= cutoff;
  });
}
function writeSummary(code, list) {
  try {
    const f = summaryFileFor(code);
    // Keep a damaged file for recovery rather than silently replacing it.
    if (readSummaryFile(code) === null) { try { fs.renameSync(f, `${f}.damaged-${Date.now()}`); } catch (e) { /* gone */ } }
    writeFileAtomic(f, JSON.stringify(list));
    return true;
  }
  catch (err) { console.warn('Could not write summary:', err.message); return false; }
}
function recordFlagged(code, entry) {
  const list = loadSummary(code);
  list.unshift(entry);
  writeSummary(code, list);
}

// When an event will be deleted (with its photos): 35 days after it if it
// is in the summary store, otherwise when it ages out of the log.
function purgeAt(code, entry) {
  const t = Date.parse(entry && entry.timestamp);
  if (isNaN(t)) return Date.now();
  const id = gymStore.eventId(entry);
  const inSummary = loadSummary(code).some(e => gymStore.eventId(e) === id);
  return t + (inSummary ? SUMMARY_RETENTION_MS : LOG_RETENTION_MS);
}

// The gym marked an event "Tailgate": copy it (and so its photos) into
// the 35-day store so it survives the 48 h purge. Un-marking removes a
// copy that only existed because of the mark.
function retainForReview(code, id, verdict) {
  const key = safeCode(code);
  const want = String(id || '');
  const list = loadSummary(key);
  const idx = list.findIndex(e => gymStore.eventId(e) === want);
  if (verdict === 'tailgate') {
    if (idx >= 0) return { kept: true, already: true };
    const e = getLogFor(key).find(x => x && !x.systemEvent && gymStore.eventId(x) === want);
    if (!e) return { kept: false };
    const copy = {
      id: want, timestamp: e.timestamp, capturedAt: e.capturedAt || null,
      zoneLabel: e.zoneLabel || null, people_count: e.people_count == null ? null : e.people_count,
      expectedCount: e.expectedCount || 1, note: e.note || null, confidence: e.confidence || null,
      tailgate_flag: !!e.tailgate_flag, error: e.error ? true : undefined,
      frame: e.frame || null, frames: e.frames || null, keptBecause: 'marked-tailgate',
    };
    list.unshift(copy);
    writeSummary(key, list);
    return { kept: true };
  }
  if (idx >= 0 && list[idx].keptBecause === 'marked-tailgate') {
    list.splice(idx, 1);
    writeSummary(key, list);
  }
  return { kept: false };
}

// --- Log -------------------------------------------------------------------
function pruneLog(list) {
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const kept = (list || []).filter(e => {
    const t = Date.parse(e && e.timestamp);
    return !isNaN(t) && t >= cutoff;
  });
  if (kept.length > MAX_LOG) kept.length = MAX_LOG;
  return kept;
}
function saveLogToDisk(s) {
  // Debounced per gym: a burst of writes collapses into one.
  if (s.saveTimer) return;
  s.saveTimer = setTimeout(() => {
    s.saveTimer = null;
    try {
      writeFileAtomic(logFileFor(s.key), JSON.stringify(s.log));
      // Keep frames referenced by EITHER the log or the 35-day summary.
      // A damaged summary file means "don't know what is kept": prune nothing.
      const kept = readSummaryFile(s.key);
      if (kept) {
        pruneEvidenceFrames(s.key, [
          ...s.log.flatMap(e => [e && e.frame, ...((e && e.frames) || [])]),
          ...loadSummary(s.key).flatMap(e => [e && e.frame, ...((e && e.frames) || [])]),
        ]);
      }
    } catch (err) {
      console.warn('Could not persist alert log:', err.message);
    }
  }, 1000);
}
// Write every pending (debounced) log now — on shutdown, so an entry made
// in the last second before a redeploy isn't lost (and re-billed when the
// camera computer resends it).
function flushLogs() {
  for (const s of states.values()) {
    if (!s.saveTimer) continue;
    clearTimeout(s.saveTimer);
    s.saveTimer = null;
    try { writeFileAtomic(logFileFor(s.key), JSON.stringify(s.log)); } catch (err) { console.warn('Could not persist alert log:', err.message); }
  }
  try { gymStore.flushNights(); } catch (e) { /* nicety */ }
}
function pushLog(s, entry) {
  s.log.unshift(entry);
  s.log = pruneLog(s.log);
  saveLogToDisk(s);
}
function getLog(code) {
  const s = sOrPrimary(code);
  s.log = pruneLog(s.log);
  return s.log;
}
function getLogFor(code) { return getLog(safeCode(code)); }

// --- Budget ------------------------------------------------------------
function burstsLast24hOf(s) {
  // Deliberately a fixed 24 hours, not the log retention window.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  return s.log.filter(e => {
    const t = Date.parse(e && e.timestamp);
    return !isNaN(t) && t >= cutoff && !e.systemEvent && !e.capReached;
  }).length;
}
function burstsLast24h(code) { return burstsLast24hOf(sOrPrimary(code)); }

const ENV_MAX_TOTAL_DAILY_BURSTS = (() => {
  const n = parseInt(process.env.MAX_TOTAL_DAILY_BURSTS, 10);
  return (Number.isFinite(n) && n > 0) ? n : null;
})();
let allLogsLoaded = false;
function totalBurstsLast24h() {
  if (!allLogsLoaded) {
    allLogsLoaded = true;
    try { for (const f of fs.readdirSync(DATA_DIR)) { const m = /^alert-log-([a-z0-9_-]+)\.json$/.exec(f); if (m) stateFor(m[1]); } } catch (e) { /* none */ }
  }
  let n = 0;
  for (const s of states.values()) n += burstsLast24hOf(s) + (s.inFlight || 0);
  return n;
}

// Pace the budget across the watch window instead of a hard stop at 1am.
// The base gap matches the browser monitor's cool-down (detect.js
// MOTION_COOLDOWN_MS): pacing 2x = one analysis per 10 s at most.
const PACING_BASE_GAP_MS = 5000;
function pacingFactor(cfg, code) {
  const s = sOrPrimary(code);
  const c = cfg || s.config;
  const cap = (c && c.dailyBurstCap) || DEFAULT_DAILY_BURST_CAP;
  const windowMins = scheduleWindowMinutes(c);
  const elapsed = Math.max(1, minutesIntoWindow(c));
  const expected = cap * Math.min(1, elapsed / windowMins);
  const used = burstsLast24hOf(s);
  if (used <= expected || expected <= 0) return 1;
  return Math.min(8, used / expected);
}

// Rough running cost — an estimate, not a bill.
const PRICE_PER_MTOK = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
};
function estimateCost(entries, model) {
  const p = PRICE_PER_MTOK[model] || PRICE_PER_MTOK['claude-sonnet-4-6'];
  let cost = 0;
  for (const e of entries) {
    if (!e || e.error || e.systemEvent || e.capReached) continue;
    const frames = e.burstFrames || 1;
    const inTok = (384 * 288 / 750) * frames + 320;
    cost += (inTok / 1e6) * p.in + (100 / 1e6) * p.out;
  }
  return cost;
}
// Analyses since gym-local midnight, and their estimated cost.
function todayUsage(code) {
  const s = stateFor(code);
  const tz = gyms.timeZoneFor(s.key);
  const p = zonedAt(Date.now(), tz);
  const since = zonedMidnightUtc(p.year, p.month, p.date, tz);
  const model = (s.config && s.config.model) || vision.DEFAULT_MODEL;
  const today = s.log.filter(e => e && !e.systemEvent && !e.capReached && Date.parse(e.timestamp) >= since);
  return { since: new Date(since).toISOString(), bursts: today.length, estimatedCost: Number(estimateCost(today, model).toFixed(3)), model };
}

// --- Dead-man's switch ------------------------------------------------
const HEARTBEAT_TIMEOUT_MS = 3 * 60 * 1000;

function markNightWatched(s) {
  if (!s.running || !isWithinSchedule(s.config)) return;
  try { gymStore.noteNight(s.key, nightKeyFor(s.config), 'watched'); } catch (e) { /* counters are a nicety */ }
}

// info: { host } from a camera computer's heartbeat.
function recordHeartbeat(code, info) {
  const s = sOrPrimary(code);
  s.lastHeartbeat = Date.now();
  if (info && info.host) {
    s.runnerHost = String(info.host).slice(0, 80);
    try { gymStore.noteRunnerSeen(s.key, { host: s.runnerHost, config: s.lastRunnerConfig || null }); } catch (e) { /* nicety */ }
  }
  markNightWatched(s);
  if (s.heartbeatLost) {
    s.heartbeatLost = false;
    pushLog(s, {
      timestamp: new Date().toISOString(),
      mode: 'entry',
      systemEvent: 'resumed',
      note: 'Monitoring reconnected — heartbeats are arriving again.',
    });
    if (s.config || s.rearmed) sendSystemAlert(s.key, 'back-online', {}).catch(() => {});
  }
}

async function checkHeartbeatOf(s) {
  // A gym re-armed from disk after a restart has no running monitor yet,
  // but its camera computer's silence still has to be reported.
  const cfg = s.running ? s.config : (s.rearmed && !s.stoppedByOperator ? s.rearmed.cfg : null);
  if (!cfg || s.heartbeatLost) return;
  if (!isWithinSchedule(cfg)) return;               // silence outside watch hours
  if (!s.lastHeartbeat) return;
  if (Date.now() - s.lastHeartbeat < HEARTBEAT_TIMEOUT_MS) return;
  s.heartbeatLost = true;
  const mins = Math.round((Date.now() - s.lastHeartbeat) / 60000);
  const r = await sendSystemAlert(s.key, (s.startedBy === 'runner' || !s.running) ? 'offline' : 'tab-offline', { mins, lastSeen: s.lastHeartbeat, host: s.runnerHost });
  try { gymStore.markOfflineAlerted(s.key, s.lastHeartbeat); } catch (e) { /* nicety */ }
  pushLog(s, {
    timestamp: new Date().toISOString(),
    mode: 'entry',
    systemEvent: 'stopped',
    error: r.text,
    alertResult: r.result,
  });
}
async function checkHeartbeat() {
  for (const s of states.values()) {
    try { await checkHeartbeatOf(s); } catch (e) { /* next gym */ }
  }
}
// After a restart nothing is "running" until a camera computer checks in,
// so a computer that is already off would never be reported. Re-arm the
// offline alert from the last check-in kept on disk (last 7 days, not for
// a gym stopped from the website, and not twice for the same silence).
// Called by server.js on Render only (not the laptop's local mode).
function rearmFromDisk() {
  const out = [];
  for (const key of gymStore.knownMetaKeys()) {
    try {
      const seen = gymStore.runnerSeen(key);
      if (!seen || !seen.at || Date.now() - seen.at > 7 * 864e5) continue;
      if (seen.offlineAlertedFor && seen.offlineAlertedFor >= seen.at) continue;
      const s = stateFor(key);
      if (s.running || s.lastHeartbeat || s.stoppedByOperator) continue;
      s.lastHeartbeat = seen.at;
      s.runnerHost = seen.host || null;
      s.rearmed = { cfg: Object.assign({ gymCode: key }, effectiveRunnerConfig(key, seen.config || null).cfg) };
      out.push(key);
    } catch (e) { /* next gym */ }
  }
  return out;
}
// Photos are promised to be deleted after LOG_RETENTION_HOURS. Pruning
// otherwise only happens when a new entry is written, so a gym that goes
// quiet would keep its photos (and log) on disk indefinitely. Sweep every
// gym on disk hourly (and shortly after start).
function sweepRetention() {
  try { for (const f of fs.readdirSync(DATA_DIR)) { const m = /^alert-log-([a-z0-9_-]+)\.json$/.exec(f); if (m) stateFor(m[1]); } } catch (e) { /* none */ }
  for (const s of states.values()) {
    try { s.log = pruneLog(s.log); if (s.log.length || fs.existsSync(logFileFor(s.key))) saveLogToDisk(s); } catch (e) { /* next gym */ }
  }
}
const sweepTimer = setInterval(sweepRetention, 60 * 60 * 1000);
if (sweepTimer.unref) sweepTimer.unref();
const firstSweep = setTimeout(sweepRetention, 60 * 1000);
if (firstSweep.unref) firstSweep.unref();
const heartbeatTimer = setInterval(checkHeartbeat, 30 * 1000);
if (heartbeatTimer.unref) heartbeatTimer.unref();

// --- Status ------------------------------------------------------------
function getStatus(code) {
  const s = sOrPrimary(code);
  const cfg = s.config;
  const model = (cfg && cfg.model) || vision.DEFAULT_MODEL;
  const day = Date.now() - 24 * 60 * 60 * 1000;
  const recent = s.log.filter(e => Date.parse(e && e.timestamp) >= day);
  const perDay = estimateCost(recent, model);
  return {
    running: s.running,
    startedAt: s.startedAt,
    config: cfg,
    captureCount: s.captureCount,
    lastError: s.lastError,
    skippedOutOfWindow: s.skippedOutOfWindow || 0,
    skippedOverCap: s.skippedOverCap || 0,
    skippedGlobalCap: s.skippedGlobalCap || 0,
    skippedPacing: s.skippedPacing || 0,
    burstsLast24h: burstsLast24hOf(s),
    logRetentionHours: LOG_RETENTION_HOURS,
    costEstimate: {
      model,
      last24h: Number(perDay.toFixed(3)),
      projectedMonthly: Number((perDay * 30).toFixed(2)),
      capMonthlyWorstCase: Number((estimateCost(
        Array.from({ length: (cfg && cfg.dailyBurstCap) || DEFAULT_DAILY_BURST_CAP },
          () => ({ burstFrames: 3 })), model) * 30).toFixed(2)),
    },
    lastHeartbeat: s.lastHeartbeat || null,
    heartbeatLost: !!s.heartbeatLost,
    pacingFactor: s.running ? Number(pacingFactor(cfg, s.key).toFixed(2)) : 1,
    projectedTotal: s.running ? (() => {
      const w = scheduleWindowMinutes(cfg);
      const e = Math.max(1, minutesIntoWindow(cfg));
      return Math.round(burstsLast24hOf(s) / e * w);
    })() : null,
    gymCode: s.key,
    gymName: gyms.gymNameFor(s.key),
    dailyBurstCap: (cfg && cfg.dailyBurstCap) || DEFAULT_DAILY_BURST_CAP,
    globalDailyCap: ENV_MAX_TOTAL_DAILY_BURSTS,
    withinSchedule: s.running ? isWithinSchedule(cfg) : null,
    startedBy: s.startedBy || null,
    stoppedByOperator: !!s.stoppedByOperator,
    // Where each effective setting came from: 'website' (admin settings)
    // or 'camera computer' (its rtsp-zones.json) or 'default'.
    configSources: s.configSources || null,
  };
}
function listStates() { return [...states.values()].map(s => s.key); }

// --- ffmpeg capture (url / webcam sources) -------------------------------
function buildCaptureArgs(cfg, outPath) {
  if (cfg.sourceType === 'webcam') {
    const platform = os.platform();
    const device = cfg.deviceId || '';
    if (!device) {
      throw new Error('No webcam device specified. Use "Detect connected cameras" on the dashboard to find the right value for this OS.');
    }
    if (platform === 'darwin') {
      return ['-y', '-f', 'avfoundation', '-framerate', '30', '-i', device, '-frames:v', '1', '-q:v', '2', outPath];
    }
    if (platform === 'win32') {
      const input = device.startsWith('video=') ? device : `video=${device}`;
      return ['-y', '-f', 'dshow', '-i', input, '-frames:v', '1', '-q:v', '2', outPath];
    }
    return ['-y', '-f', 'v4l2', '-i', device, '-frames:v', '1', '-q:v', '2', outPath];
  }
  const cameraUrl = cfg.cameraUrl;
  return cameraUrl.startsWith('rtsp://')
    ? ['-y', '-rtsp_transport', 'tcp', '-i', cameraUrl, '-frames:v', '1', '-q:v', '2', outPath]
    : ['-y', '-i', cameraUrl, '-frames:v', '1', '-q:v', '2', outPath];
}

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
    const outPath = path.join(os.tmpdir(), `securityai-frame-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`);
    let args;
    try { args = buildCaptureArgs(cfg, outPath); } catch (err) { return reject(err); }
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
        fs.unlink(outPath, () => {});
        if (err) return reject(err);
        resolve(data.toString('base64'));
      });
    });
  });
}

const vision = require('./vision');
const mailer = require('./mailer');

// --- Sending ------------------------------------------------------------
let twilioClient = null;
function getTwilioClient() {
  if (twilioClient) return twilioClient;
  if (!twilioLib || !process.env.TWILIO_SID) return null;
  twilioClient = twilioLib(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN);
  return twilioClient;
}
function smsOffReason() {
  if (!process.env.TWILIO_SID) return 'TWILIO_SID is not set on Render (Environment tab), so no text can be sent';
  if (!process.env.TWILIO_FROM_NUMBER) return 'TWILIO_FROM_NUMBER is not set on Render (Environment tab), so no text can be sent';
  if (!twilioLib) return 'the twilio package is not installed on the server, so no text can be sent';
  return 'text messages are not set up on the server';
}
async function sendSms(to, body) {
  let client;
  // The twilio library throws straight away on a mistyped TWILIO_SID
  // ("accountSid must start with AC") or a missing auth token. That must
  // come back as "not sent", never as an exception: it would otherwise
  // turn an analysed tailgate into an error entry and stop the other alerts.
  try { client = getTwilioClient(); }
  catch (err) { return { ok: false, reason: `Twilio settings on Render are wrong (${err.message}). Do this: check TWILIO_SID (starts with AC) and TWILIO_AUTH_TOKEN` }; }
  if (!client || !process.env.TWILIO_FROM_NUMBER) return { ok: false, reason: smsOffReason(), off: true };
  try {
    await client.messages.create({ from: process.env.TWILIO_FROM_NUMBER, to, body });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}
function noteDelivery(key, ok, kind, channel, to, reason) {
  if (!key) return;
  try { gymStore.recordDelivery(key, ok, ok ? null : { kind, channel, to, reason: String(reason || '').slice(0, 300) }); } catch (e) { /* nicety */ }
}

// Sends one message to a list of plain addresses (no unsubscribe link:
// these are the operator's own addresses and SUPPORT_EMAIL). Returns the
// old { email, sms } summary strings plus per-address detail.
async function deliver(key, kind, targets, msg) {
  const detail = [];
  for (const to of targets.emails || []) {
    const r = await mailer.sendMail({ to, subject: msg.subject, text: msg.text, html: msg.html, attachments: msg.attachments });
    detail.push({ to, channel: 'email', delivered: !!r.delivered, reason: r.delivered ? null : r.reason });
    noteDelivery(key, !!r.delivered, kind, 'email', to, r.reason);
  }
  for (const to of targets.phones || []) {
    const r = await sendSms(to, msg.sms || msg.text);
    detail.push({ to, channel: 'sms', delivered: r.ok, reason: r.ok ? null : r.reason });
    noteDelivery(key, r.ok, kind, 'sms', to, r.reason);
  }
  const sum = ch => {
    const d = detail.filter(x => x.channel === ch);
    if (!d.length) return null;
    const bad = d.filter(x => !x.delivered);
    return bad.length ? `skipped/failed — ${bad[0].reason}` : 'sent';
  };
  return { email: sum('email'), sms: sum('sms'), detail };
}

// Legacy: send one message to cfg.alertEmail / cfg.alertPhone.
async function sendAlert(cfg, message, opts) {
  const o = opts || {};
  const r = await deliver(o.key || null, o.kind || 'alert', {
    emails: cfg.alertEmail ? [cfg.alertEmail] : [],
    phones: cfg.alertPhone ? [cfg.alertPhone] : [],
  }, { subject: o.subject || 'SecurityAI alert', text: message, sms: message });
  return { email: r.email, sms: r.sms, detail: r.detail };
}

// The "send a test" button (monitor.html, admin page).
async function sendTestAlert(cfg, message, key) {
  return sendAlert(cfg, message, { subject: 'SecurityAI test alert', kind: 'test', key: key || null });
}

function uniq(list) { return [...new Set(list.filter(Boolean).map(x => String(x).trim()).filter(Boolean))]; }
// The operator's addresses for a gym: set on the admin page (settings),
// plus whatever the camera computer / dashboard config named.
function operatorTargets(key, cfg) {
  const set = gymStore.getSettings(key);
  return {
    emails: uniq([...(set.alertEmails || []), cfg && cfg.alertEmail].map(e => e && String(e).toLowerCase())),
    phones: uniq([...(set.alertPhones || []), cfg && cfg.alertPhone]),
  };
}
function supportEmail() {
  const e = String(process.env.SUPPORT_EMAIL || '').trim();
  return e || null;
}

function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Gym-local time with seconds: "Tue, Sep 22, 3:14:07 AM CDT".
function fmtWhen(key, iso, withDate) {
  const tz = gyms.timeZoneFor(key);
  return gymStore.fmtLocal(iso, tz, withDate
    ? { second: '2-digit', timeZoneName: 'short' }
    : { weekday: undefined, month: undefined, day: undefined, second: '2-digit', timeZoneName: 'short' });
}

// Links for one incident: a no-login share page (at most 7 days, never
// longer than the photos live) and the gym's own activity page.
function incidentLinks(key, entry) {
  const base = gyms.publicBaseUrl();
  if (!base || !entry || !entry.id) return { share: null, activity: null };
  const ttl = purgeAt(key, entry) - Date.now();
  return {
    share: `${base}/s/${gymStore.shareToken(key, entry.id, ttl)}`,
    activity: `${base}/activity.html#ev-${encodeURIComponent(entry.id)}`,
  };
}

// --- Alerts to the gym's own list (managed on the activity page) ------
function gymAlertText(code, entry) {
  const when = fmtWhen(code, entry.capturedAt && Date.parse(entry.capturedAt) <= Date.parse(entry.timestamp) + 120000 ? entry.capturedAt : entry.timestamp);
  const where = entry.zoneLabel || 'your entrance';
  const n = Number(entry.people_count), exp = Number(entry.expectedCount) || 1;
  const what = Number.isFinite(n) && n > exp
    ? `${n} people went through when ${exp} ${exp === 1 ? 'was' : 'were'} expected`
    : 'more people went through than expected';
  return { when, where, what };
}

async function sendToSubscriber(code, sub, { subject, text, html, attachments, sms, kind }) {
  const base = gyms.publicBaseUrl();
  const unsub = base ? `${base}/gym/unsubscribe?t=${encodeURIComponent(gymStore.unsubscribeToken(code, sub))}` : null;
  if (sub.kind === 'email') {
    const r = await mailer.sendMail({
      to: sub.to,
      subject,
      text: text + (unsub ? `\n\nStop these alerts: ${unsub}` : ''),
      html: html ? html + (unsub ? `<p style="font-size:12px;color:#8b939b;margin-top:18px;"><a href="${escHtml(unsub)}" style="color:#8b939b;">Stop these alerts</a></p>` : '') : undefined,
      attachments,
    });
    noteDelivery(code, !!r.delivered, kind || 'gym-alert', 'email', sub.to, r.reason);
    return r.delivered ? { ok: true } : { ok: false, reason: 'email', detail: r.reason };
  }
  const r = await sendSms(sub.to, sms + (unsub ? ` Stop: ${unsub}` : ''));
  if (r.off) { noteDelivery(code, false, kind || 'gym-alert', 'sms', sub.to, r.reason); return { ok: false, reason: 'sms-off', detail: r.reason }; }
  noteDelivery(code, r.ok, kind || 'gym-alert', 'sms', sub.to, r.reason);
  if (!r.ok) console.warn('Gym SMS failed:', r.reason);
  return r.ok ? { ok: true } : { ok: false, reason: 'sms', detail: r.reason };
}

function incidentMessage(code, entry) {
  const gymName = gyms.gymNameFor(code) || 'your gym';
  const { when, where, what } = gymAlertText(code, entry);
  const links = incidentLinks(code, entry);
  const photo = entry.frame ? path.join(framesDirFor(code), entry.frame) : null;
  const attachments = (photo && fs.existsSync(photo)) ? [{ filename: 'entrance.jpg', path: photo, cid: 'entrance@securityai' }] : undefined;
  const subject = `${gymName}: possible tailgate at ${where}, ${when}`;
  const text = `${what} at ${where} (${when}).\n\n"${entry.note || ''}"\n\n`
    + (links.share ? `See the photos: ${links.share}\n` : '')
    + (links.activity ? `Mark it on your activity page: ${links.activity}\n` : 'Mark it on your activity page once you\'ve checked the membership log.\n');
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;color:#14171A;">
    <p style="font-size:16px;font-weight:600;margin:0 0 6px;">${escHtml(what)}</p>
    <p style="font-size:14px;color:#5b636b;margin:0 0 12px;">${escHtml(where)} · ${escHtml(when)}</p>
    ${attachments ? '<img src="cid:entrance@securityai" width="480" style="max-width:100%;border-radius:6px;display:block;" alt="Entrance photo">' : ''}
    <p style="font-size:14px;color:#3a4148;font-style:italic;">"${escHtml(entry.note || '')}"</p>
    ${links.share ? `<p><a href="${escHtml(links.share)}" style="display:inline-block;background:#14171A;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px;">See all photos</a></p>` : ''}
    ${links.activity ? `<p style="font-size:14px;"><a href="${escHtml(links.activity)}" style="color:#14171A;">Mark it on your activity page</a></p>` : ''}
  </div>`;
  const sms = `${gymName}: ${what} at ${where}, ${when}.${links.share ? ' Photos: ' + links.share : ''}${links.activity ? ' Mark it: ' + links.activity : ''}`;
  return { subject, text, html, attachments, sms };
}

async function sendGymAlerts(code, entry) {
  const subs = gymStore.loadSubscribers(code);
  if (!subs.length) return [];
  const msg = incidentMessage(code, entry);
  const out = [];
  for (const sub of subs) out.push(await sendToSubscriber(code, sub, Object.assign({ kind: 'tailgate' }, msg)));
  return out;
}

// The "send a test" button on the activity page, and the welcome message
// a newly added address gets (which also tells them how to get off it).
async function sendGymTestAlert(code, sub) {
  const gymName = gyms.gymNameFor(code) || 'your gym';
  const text = `This is a test from SecurityAI for ${gymName}. You're on the alert list: if the entrance camera sees more people go through than expected, you'll get a message like this with a photo.`;
  return sendToSubscriber(code, sub, {
    kind: 'gym-test',
    subject: `SecurityAI test alert for ${gymName}`,
    text,
    html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;color:#14171A;font-size:15px;">${escHtml(text)}</div>`,
    sms: `SecurityAI test for ${gymName}: alerts are working.`,
  });
}

// --- System alerts: camera computer offline / back / no picture ---------
// Go to the gym's alert list, the operator's addresses for that gym, and
// SUPPORT_EMAIL — never to "nobody" because a laptop config was empty.
function systemMessage(key, kind, info) {
  const gymName = gyms.gymNameFor(key) || (key === 'default' ? 'your gym' : key);
  const i = info || {};
  const host = i.host ? ` (${i.host})` : '';
  if (kind === 'offline') {
    const last = i.lastSeen ? fmtWhen(key, new Date(i.lastSeen).toISOString(), true) : 'a while ago';
    const text = `Camera computer offline at ${gymName}. The camera computer${host} stopped checking in ${i.mins} minutes ago (last check-in ${last}). Nothing is being watched right now.\n\nDo this: check the laptop in the back room is plugged in with the lid open and online, and that the monitor is still running on it.`;
    return { subject: `Camera computer offline — ${gymName}`, text, sms: `SecurityAI: camera computer offline at ${gymName} for ${i.mins} min. Nothing is being watched. Check the laptop in the back room is plugged in, lid open.` };
  }
  if (kind === 'tab-offline') {
    const text = `Monitoring stopped at ${gymName} ${i.mins} minutes ago. The dashboard tab may have closed, or the computer slept or restarted. Nothing is being watched until it is restarted.`;
    return { subject: `Monitoring stopped — ${gymName}`, text, sms: `SecurityAI: monitoring stopped at ${gymName} ${i.mins} min ago. Nothing is being watched.` };
  }
  if (kind === 'back-online') {
    const text = `The camera computer at ${gymName} is checking in again (${fmtWhen(key, new Date().toISOString(), true)}). Monitoring is back on.`;
    return { subject: `Camera computer back online — ${gymName}`, text, sms: `SecurityAI: ${gymName} camera computer is back online.` };
  }
  if (kind === 'no-picture') {
    const cam = i.label ? `"${i.label}"` : 'A camera';
    const since = i.since ? fmtWhen(key, new Date(i.since).toISOString(), true) : null;
    const text = `${i.label ? 'Camera ' + cam : cam} at ${gymName} has had no picture for ${i.mins} minutes${since ? ` (since ${since})` : ''}. The camera computer is on, but it can't see that camera, so that entrance is not being watched.\n\nDo this: check the recorder (NVR) is on and its network cable is in. If someone changed the recorder's password, the camera computer needs the new one.`;
    return { subject: `${gymName}: camera has had no picture for ${i.mins}+ min`, text, sms: `SecurityAI: ${gymName} camera ${i.label || ''} has had no picture for ${i.mins} min. That entrance is not being watched.` };
  }
  return { subject: `SecurityAI notice — ${gymName}`, text: String(i.text || ''), sms: String(i.text || '') };
}
// A flapping Wi-Fi link or camera stream must not text the manager every
// few minutes all night: the same warning goes out at most once per 30
// minutes per gym (and camera), and "back online" only follows an
// "offline" that was actually sent. Still logged every time.
const SYSTEM_ALERT_COOLDOWN_MS = 30 * 60 * 1000;
function systemAlertAllowed(s, kind, info) {
  s.systemAlertAt = s.systemAlertAt || {};
  const now = Date.now();
  if (kind === 'back-online') {
    const ok = !!s.offlineAlertSent;
    s.offlineAlertSent = false;
    return ok;
  }
  if (!['offline', 'tab-offline', 'no-picture'].includes(kind)) return true;
  const k = kind === 'no-picture' ? `no-picture|${(info && info.label) || ''}` : 'offline';
  const last = s.systemAlertAt[k];
  if (last && now - last < SYSTEM_ALERT_COOLDOWN_MS) {
    if (k === 'offline') s.offlineAlertSent = false;
    return false;
  }
  s.systemAlertAt[k] = now;
  if (k === 'offline') s.offlineAlertSent = true;
  return true;
}
async function sendSystemAlert(code, kind, info) {
  const key = safeCode(code);
  const s = stateFor(key);
  const msg = systemMessage(key, kind, info);
  if (!systemAlertAllowed(s, kind, info)) {
    return { text: msg.text, subject: msg.subject, suppressed: true,
      result: { email: 'not re-sent (same warning went out in the last 30 minutes)', sms: null, recipients: 0, detail: [] } };
  }
  const ops = operatorTargets(key, s.config);
  const support = supportEmail();
  const subs = gymStore.loadSubscribers(key);
  const subAddrs = new Set(subs.map(x => String(x.to).toLowerCase()));
  const emails = uniq([...ops.emails, support && support.toLowerCase()]).filter(e => !subAddrs.has(e));
  const phones = ops.phones.filter(p => !subAddrs.has(String(p).toLowerCase()));
  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;color:#14171A;font-size:15px;white-space:pre-line;">${escHtml(msg.text)}</div>`;
  const result = await deliver(key, kind, { emails, phones }, { subject: msg.subject, text: msg.text, html, sms: msg.sms });
  for (const sub of subs) {
    const r = await sendToSubscriber(key, sub, { kind, subject: msg.subject, text: msg.text, html, sms: msg.sms });
    result.detail.push({ to: sub.to, channel: sub.kind, delivered: r.ok, reason: r.ok ? null : (r.detail || r.reason) });
  }
  return { text: msg.text, subject: msg.subject, result: { email: result.email, sms: result.sms, recipients: result.detail.length, detail: result.detail } };
}

// "Camera has had no picture for 5+ min" — once per incident, only in
// watch hours. Called by server.js on each heartbeat with the zones that
// are down; returns the labels alerted now.
const NO_PICTURE_ALERT_MS = 5 * 60 * 1000;
function checkNoPicture(code, downSince) {
  const s = stateFor(code);
  s.noPicture = s.noPicture || {};
  const now = Date.now();
  // Picture came back: the incident is over.
  for (const label of Object.keys(s.noPicture)) if (!(label in (downSince || {}))) delete s.noPicture[label];
  const sent = [];
  if (!s.running || !isWithinSchedule(s.config)) return sent;
  for (const [label, since] of Object.entries(downSince || {})) {
    if (s.noPicture[label] || now - since < NO_PICTURE_ALERT_MS) continue;
    s.noPicture[label] = now;
    sent.push(label);
    const mins = Math.round((now - since) / 60000);
    sendSystemAlert(s.key, 'no-picture', { label, mins, since }).then(r => {
      pushLog(s, { timestamp: new Date().toISOString(), mode: 'entry', systemEvent: 'no-picture', zoneLabel: label, error: r.text, alertResult: r.result });
    }).catch(() => {});
  }
  return sent;
}

function sourceLabelFor(cfg) {
  if (cfg.label) return cfg.label;
  if (cfg.sourceType === 'webcam') return `webcam ${cfg.deviceId}`;
  if (cfg.sourceType === 'browser-push') return 'screen share (browser tab)';
  return 'camera';
}

function getActiveZoneNames(zones) {
  const now = new Date();
  return (zones || [])
    .filter(z => z && z.name)
    .filter(z => {
      if (!z.authorizedUntil) return true;
      const authDate = new Date(z.authorizedUntil);
      return isNaN(authDate) || !(authDate > now);
    })
    .map(z => z.name);
}

// --- Analysis results -----------------------------------------------------
async function handleEntryResult(s, result, cfg, extra) {
  let alertResult = null;
  // A low-confidence flag goes in the log but does not wake anyone up.
  const worthAlerting = result.tailgate_flag && result.confidence !== 'low';
  const id = gymStore.newEventId();
  const ts = new Date().toISOString();
  const entry = {
    id,
    timestamp: ts,
    mode: 'entry',
    people_count: result.people_count,
    confidence: result.confidence || null,
    alertSuppressed: (result.tailgate_flag && !worthAlerting) || false,
    expectedCount: cfg.expectedCount,
    queued_count: result.queued_count,
    accessible_gate_used: result.accessible_gate_used,
    tailgate_flag: result.tailgate_flag,
    note: result.note,
    alertResult: null,
    ...extra,
  };
  if (worthAlerting) {
    recordFlagged(s.key, {
      id,
      timestamp: ts,
      capturedAt: (extra && extra.capturedAt) || null,
      zoneLabel: (extra && extra.zoneLabel) || cfg.label || null,
      people_count: result.people_count,
      expectedCount: cfg.expectedCount,
      note: result.note,
      tailgate_flag: true,
      confidence: result.confidence || null,
      frame: (extra && extra.frame) || null,
      frames: (extra && extra.frames) || null,
    });
    // A delivery problem must never turn an analysed crossing into an error.
    try {
      const msg = incidentMessage(s.key, entry);
      const ops = operatorTargets(s.key, cfg);
      const subAddrs = new Set(gymStore.loadSubscribers(s.key).map(x => String(x.to).toLowerCase()));
      const r = await deliver(s.key, 'tailgate', {
        emails: ops.emails.filter(e => !subAddrs.has(e)),
        phones: ops.phones.filter(p => !subAddrs.has(String(p).toLowerCase())),
      }, msg);
      alertResult = { email: r.email, sms: r.sms };
    } catch (err) {
      console.warn('Tailgate alert failed:', err.message);
      alertResult = { email: `skipped/failed — ${err.message}`, sms: null };
    }
    entry.alertResult = alertResult;
  }
  try {
    const night = nightKeyFor(cfg);
    gymStore.noteNight(s.key, night, 'checked');
    if (result.tailgate_flag) gymStore.noteNight(s.key, night, 'flagged');
  } catch (e) { /* counters are a nicety */ }
  pushLog(s, entry);
  if (worthAlerting) {
    sendGymAlerts(s.key, entry).catch(err => console.warn('Gym alert failed:', err.message));
  }
  return entry;
}

async function processFrame(s, base64) {
  const cfg = s.config;
  const ts = new Date().toISOString();
  if (cfg.mode === 'wall') {
    try {
      const activeZones = getActiveZoneNames(cfg.zones);
      const result = await vision.scanCameraWall(base64, activeZones);
      s.captureCount += 1;
      s.lastError = null;
      const cameras = result.cameras || [];
      const flagged = cameras.filter(c => c.flag);
      let alertResult = null;
      if (flagged.length) {
        const summary = flagged.map(c => `${c.label} (${c.people_count} seen — ${c.note})`).join('; ');
        const ops = operatorTargets(s.key, cfg);
        const r = await deliver(s.key, 'zone', ops, { subject: `SecurityAI: zone flag at ${sourceLabelFor(cfg)}`, text: `SecurityAI: zone flag at ${sourceLabelFor(cfg)} — ${summary}` });
        alertResult = { email: r.email, sms: r.sms };
      }
      pushLog(s, { timestamp: ts, mode: 'wall', cameras, summary: result.summary, flaggedCount: flagged.length, alertResult });
    } catch (err) {
      s.lastError = err.message;
      pushLog(s, { timestamp: ts, mode: 'wall', error: err.message });
    }
    return;
  }
  try {
    const result = await vision.analyzeEntry(base64, cfg);
    s.captureCount += 1;
    s.lastError = null;
    await handleEntryResult(s, result, cfg);
  } catch (err) {
    s.lastError = err.message;
    pushLog(s, { timestamp: ts, mode: 'entry', error: err.message });
  }
}

async function tick(s) {
  try {
    const base64 = await captureFrame(s.config);
    await processFrame(s, base64);
  } catch (err) {
    s.lastError = err.message;
    pushLog(s, { timestamp: new Date().toISOString(), error: err.message });
  }
}

// Single frames pushed on a timer were the old "live" mode (no motion
// trigger, no schedule, no daily limit). Removed: send motion-triggered
// bursts (pushBurst) instead.
async function pushFrame(base64, code) {
  throw new Error('Single-frame (live) analysis was removed: only motion-triggered bursts are analysed (/monitor/push-burst).');
}

// "front-door-2026-09-11-0214-07" in the GYM's local time (these names
// show up as email attachment names).
function stampFor(key, label, when) {
  const p = zonedAt(when.getTime(), gyms.timeZoneFor(key));
  const pad = n => String(n).padStart(2, '0');
  const slug = String(label || 'camera').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'camera';
  return `${slug}-${p.year}-${pad(p.month)}-${pad(p.date)}-${pad(p.hour)}${pad(p.minute)}-${pad(p.second)}`;
}

// Motion-triggered bursts from a camera computer, the ingest, or a
// browser tab. force: a manual reprocess (skips schedule and cap).
async function pushBurstFor(code, frames, zoneCfg, evidence, force) {
  const s = stateFor(code);
  zoneCfg = zoneCfg || {};
  if (!s.running || s.config.sourceType !== 'browser-push') {
    throw new Error('Monitoring is not running with a browser-push source.');
  }
  if (!Array.isArray(frames) || frames.length < 1) {
    throw new Error('At least one frame is required.');
  }
  const singleFrame = frames.length === 1;
  recordHeartbeat(s.key);
  if (!force && !isWithinSchedule(s.config)) {
    s.skippedOutOfWindow = (s.skippedOutOfWindow || 0) + 1;
    return { skipped: 'outside-schedule' };
  }

  // Per-gym hard spending ceiling (rolling 24 h). Analyses still waiting
  // on the model count too, so a burst of arrivals can't overshoot.
  const cap = s.config.dailyBurstCap || DEFAULT_DAILY_BURST_CAP;
  if (!force && burstsLast24hOf(s) + (s.inFlight || 0) >= cap) {
    if (!s.capNotified) {
      s.capNotified = true;
      pushLog(s, {
        timestamp: new Date().toISOString(),
        mode: 'entry',
        error: `Daily analysis cap of ${cap} reached — further analyses paused until older ones age out of the 24h window. If this was unexpected, a zone is probably picking up constant motion (a screen, a clock overlay, or a light).`,
        capReached: true,
      });
    }
    s.skippedOverCap = (s.skippedOverCap || 0) + 1;
    return { skipped: 'daily-cap' };
  }
  // Site-wide backstop across every gym (MAX_TOTAL_DAILY_BURSTS).
  if (!force && ENV_MAX_TOTAL_DAILY_BURSTS && totalBurstsLast24h() >= ENV_MAX_TOTAL_DAILY_BURSTS) {
    if (!s.globalCapNotified) {
      s.globalCapNotified = true;
      pushLog(s, {
        timestamp: new Date().toISOString(),
        mode: 'entry',
        error: `The website-wide daily limit (MAX_TOTAL_DAILY_BURSTS = ${ENV_MAX_TOTAL_DAILY_BURSTS}, all gyms together) is reached — analyses paused until older ones age out of the 24h window.`,
        capReached: true,
      });
    }
    s.skippedGlobalCap = (s.skippedGlobalCap || 0) + 1;
    return { skipped: 'global-daily-cap' };
  }
  s.capNotified = false;
  s.globalCapNotified = false;

  // Budget pacing, so the daily limit lasts the whole watch window instead
  // of running out early and stopping. The browser monitor stretches its
  // own cool-down; camera computers send every crossing, so for them
  // (zoneCfg.serverPacing) it is done here. While spending is ahead of an
  // even pace: at most one analysis per PACING_BASE_GAP_MS x pacing factor
  // (up to 8x = 40 s).
  if (!force && zoneCfg.serverPacing) {
    const pf = pacingFactor(s.config, s.key);
    if (pf > 1 && s.lastAcceptedAt && Date.now() - s.lastAcceptedAt < PACING_BASE_GAP_MS * pf) {
      s.skippedPacing = (s.skippedPacing || 0) + 1;
      return { skipped: 'cooldown' };
    }
  }
  s.lastAcceptedAt = Date.now();

  const cfg = {
    ...s.config,
    label: zoneCfg.label || s.config.label,
    durationSec: zoneCfg.durationSec || null,
    expectedCount: parseInt(zoneCfg.expectedCount, 10) || 1,
    accessibleGate: !!zoneCfg.accessibleGate,
  };

  // Save photos BEFORE analysis: if the call fails you still want them.
  // Every analysis frame is kept. The "main" photo is the larger copy the
  // camera computer sends for people to look at (evidence); without one,
  // main simply points at the middle frame — no duplicate copy.
  const parsed = zoneCfg.capturedAt ? new Date(zoneCfg.capturedAt) : null;
  const when = (parsed && !isNaN(parsed)) ? parsed : new Date();
  let stamp = stampFor(s.key, zoneCfg.label, when);
  // Same name already on disk (two crossings in one second, or 1:30 AM
  // twice on the night the clocks go back): never overwrite older photos.
  try { if (fs.existsSync(path.join(framesDirFor(s.key), `${stamp}-1.jpg`))) stamp += '-' + gymStore.newEventId().slice(0, 4); } catch (e) { /* keep stamp */ }
  const allFrames = frames.map((f, i) => saveEvidenceFrame(s.key, f, `${stamp}-${i + 1}`));
  const mid = Math.floor(frames.length / 2);
  let frame = null;
  if (evidence) frame = saveEvidenceFrame(s.key, evidence, `${stamp}-main`);
  if (!frame) frame = allFrames[mid] || allFrames.find(Boolean) || null;
  const savedFrames = allFrames.filter(Boolean);

  s.inFlight = (s.inFlight || 0) + 1;
  let held = true;
  const release = () => { if (held) { held = false; s.inFlight = Math.max(0, s.inFlight - 1); } };
  try {
    const result = singleFrame
      ? await vision.analyzeEntry(frames[0], cfg)
      : await vision.analyzeEntryBurst(frames, cfg);
    s.captureCount += 1;
    s.lastError = null;
    const entry = await handleEntryResult(s, result, cfg, {
      burstFrames: frames.length, zoneLabel: zoneCfg.label || null,
      frame, frames: savedFrames,
      capturedAt: (parsed && !isNaN(parsed)) ? parsed.toISOString() : null,
      clockSkewMinutes: zoneCfg.clockSkewMinutes || null,
    });
    release();
    return { entry };
  } catch (err) {
    release();
    s.lastError = err.message;
    const entry = {
      id: gymStore.newEventId(),
      timestamp: new Date().toISOString(),
      mode: 'entry',
      error: err.message,
      zoneLabel: zoneCfg.label || null,
      frame,
      frames: savedFrames,
      burstFrames: frames.length,
      capturedAt: (parsed && !isNaN(parsed)) ? parsed.toISOString() : null,
      clockSkewMinutes: zoneCfg.clockSkewMinutes || null,
    };
    pushLog(s, entry);
    return { entry, error: err.message };
  }
}
// The settings a real crossing for this gym would be analysed with (model,
// expected count, gate), for the accuracy test (accuracy.js), which must
// ask the model exactly what a real crossing asks. Reads only: nothing is
// logged, counted, alerted or charged to the gym's daily limit here.
function analysisConfigFor(code, zoneCfg, rc) {
  const s = stateFor(code);
  const base = s.running ? s.config : effectiveRunnerConfig(s.key, rc || s.lastRunnerConfig || null).cfg;
  const z = zoneCfg || {};
  return {
    ...base,
    model: vision.ALLOWED_MODELS[base.model] ? base.model : vision.DEFAULT_MODEL,
    label: z.label || base.label,
    durationSec: z.durationSec || null,
    expectedCount: parseInt(z.expectedCount, 10) || 1,
    accessibleGate: !!z.accessibleGate,
  };
}

// Legacy: the primary gym (monitor.html, ingest, rtsp-run local mode).
function pushBurst(frames, zoneCfg, evidence, force) {
  return pushBurstFor(defaultKey(), frames, zoneCfg, evidence, force);
}

// --- Start / stop ------------------------------------------------------
const ENV_MAX_DAILY_BURST_CAP = (() => {
  const n = parseInt(process.env.MAX_DAILY_BURST_CAP, 10);
  return (Number.isFinite(n) && n > 0) ? n : null;
})();
const RUNNER_MAX_DAILY_BURST_CAP = ENV_MAX_DAILY_BURST_CAP || DEFAULT_DAILY_BURST_CAP;
const RUNNER_DEFAULT_DAILY_BURST_CAP = Math.min(60, RUNNER_MAX_DAILY_BURST_CAP);

function startState(s, cfg) {
  if (s.running) throw new Error('Monitoring is already running — stop it first.');
  // Motion-triggered only: the old timed "live" capture (a camera URL or
  // webcam grabbed every N seconds and analysed every time, outside the
  // daily limit) was removed at the owner's request. Frames now only
  // arrive as motion-triggered bursts ('browser-push').
  if (cfg.sourceType && cfg.sourceType !== 'browser-push') {
    throw new Error('Timed (live) capture was removed: SecurityAI only analyses motion-triggered crossings. Use a camera computer (node rtsp-run.js) or the motion monitor page.');
  }
  const sourceType = 'browser-push';
  if (sourceType === 'url' && !cfg.cameraUrl) throw new Error('cameraUrl is required for an IP camera / stream source.');
  if (sourceType === 'webcam' && !cfg.deviceId) throw new Error('deviceId is required for a webcam source — use "Detect connected cameras" to find it.');
  const mode = cfg.mode === 'wall' ? 'wall' : 'entry';
  const zones = mode === 'wall' && Array.isArray(cfg.zones)
    ? cfg.zones.filter(z => z && typeof z.name === 'string' && z.name.trim())
        .map(z => ({ name: z.name.trim(), authorizedUntil: z.authorizedUntil || null }))
    : [];
  let secs = parseInt(cfg.intervalSeconds, 10);
  if (!secs || secs < 5) secs = 5;

  s.config = {
    sourceType, mode, zones,
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
    dailyBurstCap: (() => {
      const n = parseInt(cfg.dailyBurstCap, 10);
      const v = (Number.isFinite(n) && n > 0) ? n : DEFAULT_DAILY_BURST_CAP;
      return ENV_MAX_DAILY_BURST_CAP ? Math.min(v, ENV_MAX_DAILY_BURST_CAP) : v;
    })(),
    gymCode: s.key,
    tzOffsetMinutes: typeof cfg.tzOffsetMinutes === 'number' ? cfg.tzOffsetMinutes : null,
    timeZone: cfg.timeZone || null,
    cameraClockNote: cfg.cameraClockNote || null,
  };
  s.skippedOutOfWindow = 0;
  s.skippedOverCap = 0;
  s.skippedGlobalCap = 0;
  s.skippedPacing = 0;
  s.capNotified = false;
  s.lastHeartbeat = Date.now();
  // Offline was already reported for a re-armed gym: keep the flag so the
  // first check-in sends "back online".
  s.heartbeatLost = !!(s.heartbeatLost && s.rearmed);
  s.running = true;
  s.startedAt = new Date().toISOString();
  s.startedAtMs = Date.now();
  s.captureCount = 0;
  s.lastError = null;
  s.startedBy = null;
  if (s.stoppedByOperator) { try { gymStore.setPaused(s.key, false); } catch (e) { /* nicety */ } }
  s.stoppedByOperator = false;
  s.rearmed = null;
  s.configSources = null;
  s.log = pruneLog(s.log);
  if (sourceType === 'browser-push') return;
  tick(s);
  s.timer = setInterval(() => tick(s), secs * 1000);
}

// Operator / ingest / local-mode start: names the primary gym.
function start(cfg) {
  const c = cfg || {};
  const key = safeCode((c.gymCode || '').trim() || 'default');
  const s = stateFor(key);
  if (s.running) throw new Error('Monitoring is already running — stop it first.');
  startState(s, c);
  primaryKey = key;
  const persistent = !!process.env.DATA_DIR && process.env.DATA_DIR !== __dirname;
  console.log(
    `Log restored: ${s.log.length} event(s) for "${key}" from ${logFileFor(key)}` +
    (persistent ? '' : '  [WARNING: DATA_DIR is not set to a mounted disk — this will be wiped on the next deploy]')
  );
}

// opts.byOperator: someone pressed Stop on the website. A remote runner
// must not quietly switch monitoring back on after that.
// opts.gymCode: which gym (default: the primary one).
function stop(opts) {
  const o = opts || {};
  const s = sOrPrimary(o.gymCode);
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  s.running = false;
  if (o.byOperator) { s.stoppedByOperator = true; try { gymStore.setPaused(s.key, true); } catch (e) { /* in memory still */ } }
  return s.key;
}
// The operator pressed Start again for a runner-driven gym: clear the
// "stopped from the website" hold so the camera computer can resume.
function allowRemote(code) {
  const s = stateFor(code);
  s.stoppedByOperator = false;
  try { gymStore.setPaused(s.key, false); } catch (e) { /* in memory still */ }
  return s.key;
}

// --- Remote runner (laptop / Raspberry Pi posting to /monitor/runner/*) ---
function clampRunnerCap(v) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) return RUNNER_DEFAULT_DAILY_BURST_CAP;
  return Math.min(n, RUNNER_MAX_DAILY_BURST_CAP);
}
function validHHMM(v) {
  return (typeof v === 'string' && /^([01]?\d|2[0-3]):[0-5]\d$/.test(v.trim())) ? v.trim() : null;
}
function normaliseRunnerConfig(rc) {
  const c = (rc && typeof rc === 'object') ? rc : {};
  const tz = Number(c.tzOffsetMinutes);
  const start = validHHMM(c.scheduleStart), end = validHHMM(c.scheduleEnd);
  const str = (v, max) => (typeof v === 'string' && v.trim()) ? v.trim().slice(0, max) : null;
  return {
    dailyBurstCap: clampRunnerCap(c.dailyBurstCap),
    requestedDailyBurstCap: c.dailyBurstCap == null ? null : Number(c.dailyBurstCap),
    scheduleStart: (start && end) ? start : null,
    scheduleEnd: (start && end) ? end : null,
    tzOffsetMinutes: (c.tzOffsetMinutes != null && Number.isFinite(tz) && Math.abs(tz) <= 840) ? tz : null,
    model: (c.model && vision.ALLOWED_MODELS[c.model]) ? c.model : null,
    alertEmail: str(c.alertEmail, 200),
    alertPhone: str(c.alertPhone, 40),
  };
}

// Laptop config overlaid with the website's settings for this gym. The
// website wins wherever it has a value.
function effectiveRunnerConfig(key, rc) {
  const c = rc || normaliseRunnerConfig(null);
  const set = gymStore.getSettings(key);
  const src = { schedule: 'camera computer', dailyBurstCap: 'camera computer', model: 'camera computer' };
  const out = {
    dailyBurstCap: c.dailyBurstCap,
    scheduleStart: c.scheduleStart,
    scheduleEnd: c.scheduleEnd,
    tzOffsetMinutes: c.tzOffsetMinutes,
    timeZone: null,
    model: c.model,
    alertEmail: rc ? c.alertEmail : null,
    alertPhone: rc ? c.alertPhone : null,
    cameraClockNote: set.cameraClockNote || null,
  };
  if (!rc) { src.schedule = 'default'; src.dailyBurstCap = 'default'; src.model = 'default'; }
  if (!out.scheduleStart) src.schedule = 'default';
  if (set.scheduleStart && set.scheduleEnd) {
    out.scheduleStart = set.scheduleStart;
    out.scheduleEnd = set.scheduleEnd;
    out.timeZone = gyms.timeZoneFor(key);
    src.schedule = 'website';
  }
  if (set.model && vision.ALLOWED_MODELS[set.model]) { out.model = set.model; src.model = 'website'; }
  if (set.dailyBurstCap) { out.dailyBurstCap = Math.min(parseInt(set.dailyBurstCap, 10) || RUNNER_DEFAULT_DAILY_BURST_CAP, RUNNER_MAX_DAILY_BURST_CAP); src.dailyBurstCap = 'website'; }
  if (ENV_MAX_DAILY_BURST_CAP) out.dailyBurstCap = Math.min(out.dailyBurstCap, ENV_MAX_DAILY_BURST_CAP);
  return { cfg: out, sources: src };
}

// Makes sure this gym is being monitored so a runner's bursts can be
// analysed. Every gym has its own state, so another gym being watched is
// never a reason to refuse. Returns { ok:true } or { ok:false, reason, error }.
function ensureRemoteMonitoring(gymCode, rc) {
  const s = stateFor(gymCode);
  if (rc) s.lastRunnerConfig = rc;
  if (s.stoppedByOperator && !s.running) {
    return { ok: false, reason: 'stopped', error: 'Monitoring was stopped from the website. Do this: press Start on the admin or monitor page to switch it back on.' };
  }
  if (s.running) {
    if (s.config.sourceType !== 'browser-push') {
      return { ok: false, reason: 'other-source', error: 'This website is pulling frames from a camera itself for this gym. Do this: stop that on the monitor page first.' };
    }
    if (s.startedBy === 'runner') applyEffective(s, rc || s.lastRunnerConfig);
    return { ok: true, started: false };
  }
  const { cfg, sources } = effectiveRunnerConfig(s.key, rc);
  startState(s, Object.assign({ sourceType: 'browser-push', label: 'Camera computer' }, cfg));
  s.startedBy = 'runner';
  s.configSources = sources;
  s.runnerConfigApplied = !!rc;
  console.log(`Monitoring started by the camera computer for gym "${s.key}" (daily cap ${s.config.dailyBurstCap}${rc ? '' : ', safe defaults until its first check-in'}).`);
  return { ok: true, started: true };
}
function applyEffective(s, rc) {
  const { cfg, sources } = effectiveRunnerConfig(s.key, rc);
  Object.assign(s.config, cfg);
  s.configSources = sources;
  if (rc) s.runnerConfigApplied = true;
}
// Settings changed on the admin page: apply them now to a runner-driven gym.
function applySettings(code) {
  const s = stateFor(code);
  if (s.running && s.startedBy === 'runner') applyEffective(s, s.lastRunnerConfig);
  return getStatus(s.key);
}

// --- Monthly report data -----------------------------------------------
// opts.month: 'YYYY-MM' (a calendar month in the gym's zone), 'last' or
// 'this'. Without it: the trailing `days` days, as before.
function monthRange(key, month) {
  const tz = gyms.timeZoneFor(key);
  const now = zonedAt(Date.now(), tz);
  let y, m;
  if (month === 'this') { y = now.year; m = now.month; }
  else if (!month || month === 'last') { y = now.month === 1 ? now.year - 1 : now.year; m = now.month === 1 ? 12 : now.month - 1; }
  else {
    const mm = /^(\d{4})-(\d{2})$/.exec(String(month));
    if (!mm) return null;
    y = +mm[1]; m = +mm[2];
    if (m < 1 || m > 12) return null;
  }
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const since = zonedMidnightUtc(y, m, 1, tz);
  const until = Math.min(Date.now(), zonedMidnightUtc(ny, nm, 1, tz));
  const label = new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { since, until, label, month: `${y}-${String(m).padStart(2, '0')}`, firstDay: `${y}-${String(m).padStart(2, '0')}-01`, endDay: `${ny}-${String(nm).padStart(2, '0')}-01` };
}

function buildReport(code, days, tzOffsetMinutes, opts) {
  const key = safeCode(code);
  const o = opts || {};
  const timeZone = gyms.timeZoneFor(key);
  let since, until, periodLabel = null, month = null, firstDay, endDay;
  const range = o.month ? monthRange(key, o.month) : null;
  if (range) {
    ({ since, until } = range); periodLabel = range.label; month = range.month; firstDay = range.firstDay; endDay = range.endDay;
  } else {
    until = Date.now();
    since = until - (days || 30) * 864e5;
    firstDay = (zonedParts(new Date(since), timeZone) || { day: new Date(since).toISOString().slice(0, 10) }).day;
    endDay = '9999-12-31';
  }
  const reviews = gymStore.loadReviews(key);
  const all = loadSummary(key).filter(e => { const t = Date.parse(e.timestamp); return t >= since && t < until + 1000; }).map(e => {
    const id = gymStore.eventId(e);
    return Object.assign({}, e, { id, review: reviews[id] || null });
  });
  // Flags the gym marked "it was fine" are not unexpected entries.
  const events = all.filter(e => !(e.review && e.review.verdict === 'fine'));
  const byDay = {}, byZone = {}, byHour = {};
  for (const e of events) {
    const d = new Date(e.timestamp);
    const zp = typeof tzOffsetMinutes === 'number' ? null : zonedParts(d, timeZone);
    const day = zp ? zp.day : d.toISOString().slice(0, 10);
    byDay[day] = (byDay[day] || 0) + 1;
    const z = e.zoneLabel || 'Unlabelled';
    byZone[z] = (byZone[z] || 0) + 1;
    const hr = zp ? zp.hour : Math.floor(localMinutes(d, tzOffsetMinutes) / 60);
    byHour[hr] = (byHour[hr] || 0) + 1;
  }
  const busiest = Object.entries(byHour).sort((a, b) => b[1] - a[1])[0];
  const worstDay = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  // Nights watched and crossings checked (kept per gym-local night).
  let nightsWatched = 0, entriesChecked = 0;
  try {
    const nights = gymStore.loadNights(key);
    for (const [d, n] of Object.entries(nights)) {
      if (d < firstDay || d >= endDay) continue;
      if (n.w) nightsWatched++;
      entriesChecked += Number(n.c) || 0;
    }
  } catch (e) { /* none */ }
  const confirmed = events.filter(e => e.review && e.review.verdict === 'tailgate').length;
  return {
    gymCode: key,
    days: range ? Math.round((until - since) / 864e5) : (days || 30),
    month, periodLabel,
    periodStart: new Date(since).toISOString(),
    periodEnd: new Date(until).toISOString(),
    totalFlagged: events.length,
    confirmedByGym: confirmed,
    markedFineByGym: all.length - events.length,
    notReviewed: events.filter(e => !e.review).length,
    timeZone,
    extraPeopleSeen: events.reduce((n, e) => n + Math.max(0, (Number(e.people_count) || 0) - (e.expectedCount || 1)), 0),
    daysWithActivity: Object.keys(byDay).length,
    nightsWatched, entriesChecked,
    byZone,
    // Hidden under 3: "busiest hour: 2am (1)" is noise, not a pattern.
    busiestHour: (busiest && busiest[1] >= 3) ? { hour: Number(busiest[0]), count: busiest[1] } : null,
    worstDay: worstDay ? { date: worstDay[0], count: worstDay[1] } : null,
    events: events.slice(0, 100),
  };
}

module.exports = {
  getLogFor, sendGymTestAlert, sendGymAlerts, ensureRemoteMonitoring, normaliseRunnerConfig, RUNNER_MAX_DAILY_BURST_CAP, analysisConfigFor,
  start, stop, allowRemote, getStatus, getLog, listDevices, pushFrame, pushBurst, pushBurstFor, getActiveZoneNames,
  isWithinSchedule, burstsLast24h, totalBurstsLast24h, framesDirFor, safeCode, pacingFactor, scheduleWindowMinutes,
  localMinutes, buildReport, loadSummary, recordHeartbeat, sendTestAlert, sendSystemAlert, checkNoPicture,
  applySettings, effectiveRunnerConfig, retainForReview, purgeAt, todayUsage, listStates, defaultKey, checkHeartbeat,
  zonedAt, zonedMidnightUtc, monthRange, nightKeyFor, stampFor, fmtWhen, operatorTargets, rearmFromDisk, flushLogs, sweepRetention,
  LOG_RETENTION_HOURS, SUMMARY_RETENTION_MS, ENV_MAX_TOTAL_DAILY_BURSTS,
  platform: os.platform(),
};
