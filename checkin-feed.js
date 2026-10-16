// Check-in feed: takes front-desk check-ins straight from the gym's
// check-in system instead of reading its screen. Runs on the gym's own
// computer, like the screen reader, and uses the same setup: each member
// number is scrambled HERE for the approved phones before anything is sent,
// so the website never sees member numbers.
//
// Two ways in, set in ~/.securityai/checkin-feed.json (readable only by
// this user; it can hold an API key):
//
//   1. "poll": the check-in system's own web API (ABC, Mindbody, ClubReady
//      and others offer one once the gym or a partner account has access).
//      {
//        "mode": "poll",
//        "url": "https://api.example.com/checkins?since={since}",
//        "headers": { "Authorization": "Bearer ..." },
//        "everySec": 5,
//        "list": "data.checkins",              // where the list is in the answer
//        "fields": { "id": "id", "member": "member.number", "time": "checkedInAt", "zone": "location.name" },
//        "zone": "Front Door"                  // optional: only this location
//      }
//   2. "file": a log file the check-in software keeps adding lines to.
//      { "mode": "file", "path": "C:\\Program Files\\...\\checkins.csv",
//        "delimiter": ",", "header": true, "columns": { "time": 0, "member": 1, "zone": 2 } }
//
//   node checkin-feed.js --check    read once and show what it found (numbers hidden)
//   node checkin-feed.js            run (the background service can run this
//                                   INSTEAD of the screen reader on that computer)
//
// Check-ins already there when it starts are not sent (only new ones), and
// the same member within 5 minutes counts once, like the screen reader.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { ReaderCore, netWords, readJson, writePrivate } = require('./reader-core');

const VERSION = 'feed-1.0.0';
const DOUBLE_SEC = 300;
const MAX_AGE_MS = 15 * 60e3;          // a check-in older than this when first seen is history, not a new scan
const stateDir = () => process.env.SECURITYAI_HOME || path.join(os.homedir(), '.securityai');

// "a.b.0.c" -> value
function pick(obj, p) {
  if (p == null || p === '') return obj;
  return String(p).split('.').reduce((o, k) => (o == null ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), obj);
}
function parseTime(v) {
  if (v == null || v === '') return NaN;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;        // seconds or milliseconds
  if (/^\d{10}$/.test(String(v))) return Number(v) * 1000;
  if (/^\d{13}$/.test(String(v))) return Number(v);
  return Date.parse(String(v));
}
const cleanMember = v => String(v == null ? '' : v).trim().replace(/\s+/g, '').slice(0, 40);
// http is only allowed to the gym's own network (an on-site server); anything on the internet must be https.
function allowedUrl(u) {
  let x; try { x = new URL(u); } catch (e) { return false; }
  if (x.protocol === 'https:') return true;
  if (x.protocol !== 'http:') return false;
  return /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(x.hostname);
}
function validate(c) {
  if (!c || typeof c !== 'object') throw new Error('checkin-feed.json is missing or not valid JSON.');
  if (c.mode === 'poll') {
    if (!allowedUrl(String(c.url || '').replace('{since}', ''))) throw new Error('"url" must be https (or http on the gym\'s own network).');
    if (!c.fields || !c.fields.member || !c.fields.time) throw new Error('"fields" needs at least "member" and "time".');
  } else if (c.mode === 'file') {
    if (!c.path) throw new Error('"path" is missing.');
    if (!c.columns || c.columns.member == null || c.columns.time == null) throw new Error('"columns" needs at least "member" and "time".');
  } else throw new Error('"mode" must be "poll" or "file".');
  return c;
}

// The part that turns raw records into scans: shared by both modes, and
// what the tests drive. core: { noteScan(member, zone, ms), counts }.
function createEngine({ core, conf, seenFile, now }) {
  const clock = now || (() => Date.now());
  const seen = new Map(Object.entries(readJson(seenFile, {})));     // key -> ms first seen
  const recent = new Map();                                         // member tag -> last scan ms
  let based = seen.size > 0;
  const wantZone = conf.zone ? String(conf.zone).trim().toLowerCase() : null;
  function keyOf(r) { return r.id != null && r.id !== '' ? 'i:' + String(r.id).slice(0, 80) : 'm:' + core.tag(r.member) + '|' + r.t; }
  function persist() {
    const cut = clock() - 3 * 864e5;
    for (const [k, v] of seen) if (v < cut) seen.delete(k);
    while (seen.size > 5000) seen.delete(seen.keys().next().value);
    writePrivate(seenFile, Object.fromEntries(seen));
  }
  // records: [{ id?, member, t (ms), zone? }]. Returns how many were noted.
  function take(records) {
    let noted = 0;
    const list = records.filter(r => r && r.member && Number.isFinite(r.t)).sort((a, b) => a.t - b.t);
    for (const r of list) {
      const k = keyOf(r);
      if (seen.has(k)) continue;
      seen.set(k, clock());
      if (!based) continue;                                         // already there at start: not new
      if (clock() - r.t > MAX_AGE_MS) continue;                     // late history, not a live check-in
      if (wantZone && r.zone && String(r.zone).trim().toLowerCase() !== wantZone) { core.counts.otherZone = (core.counts.otherZone || 0) + 1; continue; }
      const tg = core.tag(r.member), prev = recent.get(tg);
      if (prev != null && Math.abs(r.t - prev) < DOUBLE_SEC * 1000) { core.counts.doubles = (core.counts.doubles || 0) + 1; continue; }
      recent.set(tg, r.t);
      core.noteScan(r.member, conf.zone || core.cfg.zone, Math.min(r.t, clock()));
      noted++;
    }
    for (const [k, v] of recent) if (clock() - v > 2 * DOUBLE_SEC * 1000) recent.delete(k);
    based = true;
    persist();
    return noted;
  }
  return { take, get based() { return based; } };
}

// Poll mode: one request, mapped to records.
async function pollOnce(conf, sinceMs, fetchImpl) {
  const since = new Date(sinceMs).toISOString();
  const url = String(conf.url).replace('{since}', encodeURIComponent(since));
  if (!allowedUrl(url)) throw new Error('url not allowed');
  const r = await (fetchImpl || fetch)(url, { headers: Object.assign({ Accept: 'application/json' }, conf.headers || {}), signal: AbortSignal.timeout(15e3), redirect: 'error' });
  if (!r.ok) throw new Error(`the check-in system answered ${r.status}`);
  const body = await r.json();
  const arr = pick(body, conf.list);
  if (!Array.isArray(arr)) throw new Error(`no list at "${conf.list || '(top)'}" in the answer`);
  const f = conf.fields;
  return arr.map(x => ({ id: f.id ? pick(x, f.id) : null, member: cleanMember(pick(x, f.member)), t: parseTime(pick(x, f.time)), zone: f.zone ? pick(x, f.zone) : null }));
}

// File mode: the new complete lines since last time.
function fileReader(conf, posFile) {
  let pos = readJson(posFile, null);
  return function readNew() {
    let st; try { st = fs.statSync(conf.path); } catch (e) { throw new Error('the check-in file can\'t be found'); }
    if (!pos || pos.ino !== st.ino || st.size < pos.at) pos = { ino: st.ino, at: 0, header: false };   // new or rotated file
    if (st.size === pos.at) return [];
    const fd = fs.openSync(conf.path, 'r');
    const len = Math.min(st.size - pos.at, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, pos.at); fs.closeSync(fd);
    const text = buf.toString('utf8'), last = text.lastIndexOf('\n');
    if (last < 0) return [];                                        // no complete line yet
    pos.at += Buffer.byteLength(text.slice(0, last + 1));
    const lines = text.slice(0, last).split(/\r?\n/).filter(Boolean);
    const out = [];
    const d = conf.delimiter || ',', c = conf.columns;
    for (const line of lines) {
      if (conf.header && !pos.header) { pos.header = true; continue; }
      const cells = line.split(d).map(s => s.trim().replace(/^"|"$/g, ''));
      out.push({ member: cleanMember(cells[c.member]), t: parseTime(cells[c.time]), zone: c.zone != null ? cells[c.zone] : null });
    }
    writePrivate(posFile, pos);
    return out;
  };
}

async function main() {
  const arg = n => process.argv.includes('--' + n);
  const log = m => { const line = `${new Date().toISOString()} ${m}`; console.log(line); try { fs.appendFileSync(path.join(stateDir(), 'checkin-feed.log'), line + '\n'); } catch (e) { /* ok */ } };
  const core = new ReaderCore({ dir: stateDir(), name: 'screen-reader', version: VERSION, log });
  if (!core.cfg || !core.cfg.token || !core.cfg.owner) { console.log('Set up the front-desk reader first:  node screen-reader.js --setup   (the feed uses the same pairing)'); process.exit(1); }
  let conf;
  try { conf = validate(readJson(path.join(stateDir(), 'checkin-feed.json'), null)); }
  catch (e) { console.log('checkin-feed.json: ' + e.message + '\nSee the top of checkin-feed.js for an example.'); process.exit(1); }
  const readNew = conf.mode === 'file' ? fileReader(conf, path.join(stateDir(), 'checkin-feed-pos.json')) : null;
  const fetchRecords = async () => conf.mode === 'file' ? readNew() : pollOnce(conf, Date.now() - 30 * 60e3);
  if (arg('check')) {
    try {
      const recs = await fetchRecords();
      const ok = recs.filter(r => r.member && Number.isFinite(r.t));
      console.log(`Read ${recs.length} check-in(s); ${ok.length} usable.`);
      for (const r of ok.slice(-5)) console.log(`  ${new Date(r.t).toLocaleString()}  member …${String(r.member).slice(-2)}  ${r.zone || ''}`);
      if (recs.length && !ok.length) console.log('None had both a member number and a time: check "fields"/"columns".');
    } catch (e) { console.log('Could not read: ' + e.message); process.exit(1); }
    return;
  }
  const engine = createEngine({ core, conf, seenFile: path.join(stateDir(), 'checkin-feed-seen.json') });
  log(`check-in feed ${VERSION} started (${conf.mode})`);
  let lastOk = Date.now(), lastErr = null, lastTrust = 0, lastStatus = 0, lastCode;
  const every = Math.max(2, Math.min(60, Number(conf.everySec) || 5)) * 1000;
  try { await core.refreshTrust(); lastTrust = Date.now(); } catch (e) { log('trust check failed: ' + netWords(e)); }
  const health = () => (Date.now() - lastOk > 2 * 60e3 ? { code: 'feed-failing', text: `Can't read the check-in system: ${lastErr || 'no answer'}` } : core.baseHealth());
  for (;;) {
    try { const n = engine.take(await fetchRecords()); lastOk = Date.now(); lastErr = null; if (n) log(`${n} new check-in(s)`); }
    catch (e) { lastErr = e.message; log('read failed: ' + e.message); }
    const now = Date.now(), h = health();
    try { if (now - lastTrust > 60e3) { lastTrust = now; await core.refreshTrust(); } } catch (e) { log('trust check failed: ' + netWords(e)); }
    try { await core.flush(h && h.text); } catch (e) { log('send failed, will retry: ' + netWords(e)); }
    if (now - lastStatus > 60e3 || (h && h.code) !== lastCode) { try { await core.status(h); lastStatus = now; lastCode = h && h.code; } catch (e) { /* next time */ } }
    await new Promise(r => setTimeout(r, every));
  }
}

module.exports = { createEngine, pollOnce, fileReader, validate, allowedUrl, parseTime, pick };
if (require.main === module) main().catch(e => { console.error(e.message); process.exit(1); });
