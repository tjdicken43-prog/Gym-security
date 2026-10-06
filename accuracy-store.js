// Website side of the accuracy test (see accuracy.js): keeps each test run
// in DATA_DIR/tests-<gym>/<runId>/ (run.json + the small photos that were
// counted), separate from the activity log, the 35-day store and the
// monthly report, so tests can never show up as real crossings there.
// The photos are kept so the same crossings can be re-checked with the
// other model (admin page). The newest RUNS_KEPT runs per gym are kept.

'use strict';
const fs = require('fs');
const path = require('path');
const acc = require('./accuracy');

// Absolute, like monitor.js (express's sendFile refuses relative paths).
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);

function safeKey(k) { return String(k || 'default').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default'; }
function gymDir(key) { return path.join(DATA_DIR, `tests-${safeKey(key)}`); }
function runDir(key, runId) {
  if (!acc.RUN_ID_RE.test(String(runId))) throw new Error('Not a test run id.');
  return path.join(gymDir(key), runId);
}

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

function loadRun(key, runId) {
  try { return JSON.parse(fs.readFileSync(path.join(runDir(key, runId), 'run.json'), 'utf8')); } catch (e) { return null; }
}
function saveRun(key, run) {
  const d = runDir(key, run.runId);
  fs.mkdirSync(d, { recursive: true });
  writeJsonAtomic(path.join(d, 'run.json'), run);
}

// Newest first.
function listRuns(key) {
  let names = [];
  try { names = fs.readdirSync(gymDir(key)).filter(n => acc.RUN_ID_RE.test(n)); } catch (e) { return []; }
  return names.map(n => loadRun(key, n)).filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

// Keeps the newest run plus the newest finished (or started-with-crossings)
// ones, so tests that were started and abandoned never push a real
// scorecard out.
function pruneRuns(key) {
  const runs = listRuns(key);
  const keep = new Set(runs.slice(0, 1).map(r => r.runId));
  for (const r of runs) if (keep.size < acc.RUNS_KEPT && (r.status === 'finished' || (r.crossings || []).length)) keep.add(r.runId);
  for (const r of runs) if (keep.size < acc.RUNS_KEPT) keep.add(r.runId);
  for (const r of runs.filter(x => !keep.has(x.runId))) {
    try { fs.rmSync(runDir(key, r.runId), { recursive: true, force: true }); } catch (e) { /* next time */ }
  }
}

// Analyses spent on tests (and model comparisons) by this gym in the last
// 24 hours. Kept in its own small file, not worked out from the runs, so
// deleting old runs (or starting lots of empty ones) can never free up
// budget. Separate from the gym's real daily limit.
function usageFile(key) { return path.join(gymDir(key), 'usage.json'); }
function readUsage(key) {
  const cutoff = Date.now() - 24 * 3600e3;
  try { const a = JSON.parse(fs.readFileSync(usageFile(key), 'utf8')); return Array.isArray(a) ? a.filter(t => Number(t) >= cutoff) : []; } catch (e) { return []; }
}
function noteUsage(key) {
  const a = readUsage(key);
  a.push(Date.now());
  fs.mkdirSync(gymDir(key), { recursive: true });
  writeJsonAtomic(usageFile(key), a);
}
function testAnalysesLast24h(key) { return readUsage(key).length; }

function startRun(key, info) {
  const existing = loadRun(key, info.runId);
  if (existing) return existing;
  const run = {
    runId: info.runId, gymKey: safeKey(key), startedAt: new Date().toISOString(), finishedAt: null,
    status: 'running', host: info.host || null, zoneLabel: info.zoneLabel || null, model: info.model,
    crossings: [], trials: null, scorecard: null, compare: null,
  };
  saveRun(key, run);
  pruneRuns(key);
  return run;
}

function findCrossing(run, trial, seq) {
  return (run.crossings || []).find(c => c.trial === trial && c.seq === seq) || null;
}
function analysedCount(run) { return (run.crossings || []).filter(c => !c.skipped).length; }

// Reserve a slot for one test crossing, saving its photos. Returns
// { crossing, run } or { skipped: reason }. Caps are checked here, before
// any call is made; a reserved slot counts even while its analysis runs.
// Every change below re-reads run.json and writes it back in the same
// tick, so two requests at once can't overwrite each other's changes.
function reserveCrossing(key, runId, test, frames, zone) {
  const run = loadRun(key, runId);
  if (!run) return { skipped: 'test-unknown-run' };
  if (run.status !== 'running') return { skipped: 'test-finished' };
  let skipped = null;
  if (analysedCount(run) >= acc.MAX_ANALYSES_PER_RUN) skipped = 'test-run-cap';
  else if (testAnalysesLast24h(key) >= acc.MAX_TEST_ANALYSES_PER_DAY) skipped = 'test-daily-cap';
  const c = {
    trial: test.trial, seq: test.seq, kind: test.expected, reservedAt: new Date().toISOString(),
    capturedAt: zone.capturedAt || null, durationSec: zone.durationSec || null, expectedCount: zone.expectedCount || 1,
    accessibleGate: !!zone.accessibleGate, frames: [], verdict: null, error: null, skipped, model: run.model,
  };
  if (!skipped) {
    const d = runDir(key, run.runId);
    fs.mkdirSync(d, { recursive: true });
    frames.forEach((b64, i) => {
      const name = `t${String(test.trial).padStart(2, '0')}-${test.seq}-${i + 1}.jpg`;
      fs.writeFileSync(path.join(d, name), Buffer.from(b64, 'base64'));
      c.frames.push(name);
    });
  }
  run.crossings.push(c);
  saveRun(key, run);
  if (!skipped) noteUsage(key);
  return skipped ? { skipped, crossing: c, run } : { crossing: c, run };
}
function updateCrossing(key, runId, trial, seq, patch) {
  const run = loadRun(key, runId);
  const c = run && findCrossing(run, trial, seq);
  if (!c) return null;
  Object.assign(c, patch);
  saveRun(key, run);
  return c;
}
// One re-check with the other model, counted BEFORE the call is made.
function noteCompareCall(key) { noteUsage(key); }
// Its answer, saved as soon as it is back, so a comparison that was cut
// short (a restart) only re-checks what is still missing.
function addCompareResult(key, runId, model, result) {
  const run = loadRun(key, runId);
  if (!run) return null;
  if (!run.compare || run.compare.model !== model) run.compare = { model, startedAt: new Date().toISOString(), done: false, crossings: [] };
  run.compare.crossings = run.compare.crossings.filter(c => !(c.trial === result.trial && c.seq === result.seq)).concat([result]);
  saveRun(key, run);
  return run;
}
function finishCompare(key, runId) {
  const run = loadRun(key, runId);
  if (!run || !run.compare) return null;
  const s = scoreWith(run, 'compare');
  Object.assign(run.compare, {
    done: true, finishedAt: new Date().toISOString(), scorecard: s.scorecard,
    judged: s.trials.map(j => ({ n: j.n, pos: j.pos, kind: j.kind, status: j.status, text: j.text, right: j.right })),
    analyses: run.compare.crossings.length,
    cost: Number((run.compare.crossings.length * acc.costPerAnalysis(run.compare.model)).toFixed(4)),
  });
  saveRun(key, run);
  return run;
}
function framesOf(key, run, c) {
  const d = runDir(key, run.runId);
  return (c.frames || []).map(n => {
    if (!/^t\d{2}-\d-\d\.jpg$/.test(n)) return null;
    try { return fs.readFileSync(path.join(d, n)).toString('base64'); } catch (e) { return null; }
  }).filter(Boolean);
}

// Only what scoring needs from a model's answer.
function slimVerdict(v) {
  if (!v || typeof v !== 'object') return null;
  return { people_count: Number.isFinite(v.people_count) ? v.people_count : null, tailgate_flag: v.tailgate_flag === true,
    confidence: v.confidence || null, queued_count: Number.isFinite(v.queued_count) ? v.queued_count : null,
    accessible_gate_used: v.accessible_gate_used === true, note: v.note != null ? String(v.note).slice(0, 300) : null };
}

// Score a run with its own verdicts, or with the comparison's.
function scoreWith(run, source) {
  const list = source === 'compare' ? ((run.compare && run.compare.crossings) || []) : (run.crossings || []);
  const byKey = new Map(list.map(c => [`${c.trial}|${c.seq}`, c]));
  return acc.scoreRun(run.trials || [], (n, s) => {
    const c = byKey.get(`${n}|${s}`);
    return c && c.verdict && !c.error && !c.skipped ? c.verdict : null;
  });
}

function finishRun(key, runId, trials) {
  const run = loadRun(key, runId);
  if (!run) return null;
  if (run.status === 'finished') return run;       // sent twice: keep the first
  run.trials = trials;
  run.status = 'finished';
  run.finishedAt = new Date().toISOString();
  const s = scoreWith(run, 'own');
  run.scorecard = s.scorecard;
  run.judged = s.trials.map(j => ({ n: j.n, pos: j.pos, kind: j.kind, status: j.status, text: j.text, right: j.right }));
  run.analyses = analysedCount(run);
  run.cost = Number((run.analyses * acc.costPerAnalysis(run.model)).toFixed(4));
  saveRun(key, run);
  return run;
}

function latestRun(key) { return listRuns(key)[0] || null; }

module.exports = {
  gymDir, runDir, loadRun, saveRun, listRuns, latestRun, startRun, reserveCrossing, updateCrossing, findCrossing, framesOf, slimVerdict,
  analysedCount, testAnalysesLast24h, finishRun, scoreWith, pruneRuns, addCompareResult, finishCompare, noteCompareCall,
};
