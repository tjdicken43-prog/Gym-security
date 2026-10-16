// Nightly self-test: does the AI still catch a tailgate it caught before?
//
// When staff confirm a flagged entry as a Tailgate, its photos are copied
// into a small test set for that gym (up to 6, newest kept). Once a day,
// outside watch hours, ONE of them is checked again with today's model and
// prompt (about 1 cent). If the answer changed (no longer a tailgate), or
// the check fails (API key, credit, model retired), the self-check says so.
// Only confirmed tailgates are used: missing a tailgater is the failure
// that matters most, and staff have already said what the right answer is.
//
// Privacy: the copies follow the same rule as marked tailgates: kept 35
// days, then deleted. Un-marking an entry removes it from the test set.
'use strict';
const fs = require('fs');
const path = require('path');

const MAX_CASES = 6;
const KEEP_MS = 35 * 864e5;
const HISTORY = 30;

function create({ dataDir, framesDirFor, vision, timeZoneFor, scheduleFor, keepMsFor, log, onError }) {
  const safe = k => String(k || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';
  const dir = key => path.join(dataDir, `selftest-${safe(key)}`);
  const file = key => path.join(dir(key), 'cases.json');
  const say = log || (() => {});

  function load(key) {
    let s; try { s = JSON.parse(fs.readFileSync(file(key), 'utf8')); } catch (e) { s = null; }
    s = s && typeof s === 'object' ? s : {};
    s.cases = Array.isArray(s.cases) ? s.cases : [];
    s.results = Array.isArray(s.results) ? s.results : [];
    return s;
  }
  function save(key, s) {
    fs.mkdirSync(dir(key), { recursive: true });
    const tmp = file(key) + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file(key));
  }
  function dropFiles(key, c) { for (const f of c.files || []) try { fs.unlinkSync(path.join(dir(key), f)); } catch (e) { /* gone */ } }
  function prune(key, s) {
    const now = Date.now();
    const keep = [];
    const keepMs = Math.min(KEEP_MS, (keepMsFor && Number(keepMsFor(key))) || KEEP_MS);   // a gym's shorter choice wins
    // Counted from when the entry happened (not when staff marked it), like the entry itself.
    for (const c of s.cases) { const born = Date.parse(c.seen) || Date.parse(c.at); if (now - born > keepMs) dropFiles(key, c); else keep.push(c); }
    while (keep.length > MAX_CASES) dropFiles(key, keep.shift());
    s.cases = keep;
  }

  // A review was saved. e = the raw log entry (with its saved frame names).
  function noteReview(key, id, verdict, e) {
    try {
      const s = load(key);
      const had = s.cases.find(c => c.id === id);
      if (verdict !== 'tailgate') {
        if (had) { dropFiles(key, had); s.cases = s.cases.filter(c => c.id !== id); save(key, s); }
        return;
      }
      if (had || !e || e.error || !e.tailgate_flag) return;          // only tailgates the AI itself flagged
      // The frames that were analysed for the crossing, in order (not the
      // "before" stills or the large evidence copy).
      const frames = (e.frames || []).filter(f => /-\d+\.jpg$/.test(f) && !/-b\d+\.jpg$/.test(f));
      if (frames.length < 2) return;
      fs.mkdirSync(dir(key), { recursive: true });
      const files = [];
      for (const [i, f] of frames.entries()) {
        const name = `${String(id).replace(/[^a-z0-9]/gi, '').slice(0, 24)}-${i + 1}.jpg`;
        fs.copyFileSync(path.join(framesDirFor(key), f), path.join(dir(key), name));
        files.push(name);
      }
      s.cases.push({ id, at: new Date().toISOString(), seen: e.capturedAt || e.timestamp, people: e.people_count == null ? null : Number(e.people_count), expectedCount: Number(e.expectedCount) || 1, files });
      prune(key, s);
      save(key, s);
    } catch (err) { say(`self-test: could not keep entry ${id}: ${err.message}`); }
  }

  // Run one case now (the oldest-tested). Returns the result.
  async function runOne(key) {
    const s = load(key);
    prune(key, s);
    if (!s.cases.length) { save(key, s); return null; }
    const lastRun = c => { const r = s.results.filter(x => x.id === c.id).pop(); return r ? Date.parse(r.at) : 0; };
    const c = s.cases.slice().sort((a, b) => lastRun(a) - lastRun(b))[0];
    const res = { id: c.id, at: new Date().toISOString(), seen: c.seen, expected: 'tailgate' };
    try {
      const frames = c.files.map(f => fs.readFileSync(path.join(dir(key), f)).toString('base64'));
      const out = await vision.analyzeEntryBurst(frames, { expectedCount: c.expectedCount });
      res.people = out.people_count;
      res.flag = !!out.tailgate_flag || (Number.isFinite(out.people_count) && out.people_count > c.expectedCount);
      res.pass = res.flag;
      res.model = out.modelUsed || null;
      res.note = out.note ? String(out.note).slice(0, 200) : null;
    } catch (err) {
      res.pass = false; res.error = String(err.message || err).slice(0, 200);
    }
    s.results = s.results.concat([res]).slice(-HISTORY);
    s.lastRunDay = dayOf(key);
    save(key, s);
    say(`self-test ${key}: ${res.error ? 'could not run (' + res.error + ')' : res.pass ? 'passed' : 'FAILED: the AI no longer calls a confirmed tailgate a tailgate'}`);
    return res;
  }

  function dayOf(key, t) {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: timeZoneFor(key), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t || Date.now())); }
    catch (e) { return new Date(t || Date.now()).toISOString().slice(0, 10); }
  }
  function hourOf(key) {
    try { return Number(new Intl.DateTimeFormat('en-US', { timeZone: timeZoneFor(key), hour: 'numeric', hourCycle: 'h23' }).format(new Date())); }
    catch (e) { return new Date().getUTCHours(); }
  }

  // Would another (cheaper) model still catch the known tailgates? Runs
  // every kept case once with that model. Only catches are measured here
  // (false alarms need a week of real use), so it is advice, not a switch.
  async function compare(key, model) {
    const s = load(key); prune(key, s); save(key, s);
    const out = { model, total: s.cases.length, caught: 0, failed: 0, used: [] };
    for (const c of s.cases) {
      try {
        const frames = c.files.map(f => fs.readFileSync(path.join(dir(key), f)).toString('base64'));
        const r = await vision.analyzeEntryBurst(frames, { expectedCount: c.expectedCount, model });
        if (r.tailgate_flag || (Number.isFinite(r.people_count) && r.people_count > c.expectedCount)) out.caught++;
        out.used.push(r.modelUsed || model);
      } catch (e) { out.failed++; }
    }
    return out;
  }

  // Hourly: at 2 PM gym time (well outside overnight watch hours), once a day.
  async function tick(keys) {
    for (const key of keys) {
      try {
        const s = load(key);
        if (!s.cases.length) continue;
        prune(key, s); save(key, s);                       // a shorter keep time applies even on quiet days
        if (!s.cases.length || s.lastRunDay === dayOf(key) || hourOf(key) < 14) continue;
        const sch = scheduleFor ? scheduleFor(key) : null;
        if (sch && sch.watchingNow) continue;
        await runOne(key);
      } catch (e) { say(`self-test ${key}: ${e.message}`); if (onError) onError(e); }
    }
  }

  // For the self-check: { cases, last, failedInARow }.
  function summary(key) {
    const s = load(key);
    const rs = s.results;
    let failedInARow = 0;
    for (let i = rs.length - 1; i >= 0 && !rs[i].pass; i--) failedInARow++;
    return { cases: s.cases.length, last: rs[rs.length - 1] || null, failedInARow, passed: rs.filter(r => r.pass).length, runs: rs.length };
  }

  return { noteReview, runOne, tick, summary, compare, _dir: dir };
}

module.exports = { create };
