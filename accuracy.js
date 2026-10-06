// The 5-minute accuracy test: what "right" means, shared by the camera
// computer (node rtsp-run.js --test, see walk-test.js) and the website
// (server.js scores the run and shows it on the admin page), so both sides
// print the same numbers from the same rules.
//
// A test run is a short script of walks at the real door. Every crossing
// the camera computer sees during a walk is sent with
//   test: { runId, trial, expected, seq }
// and the website counts it with the gym's own model and prompt, but it
// never alerts, never goes in the activity log or the monthly report, and
// never uses the gym's daily limit (tests have their own small limits).
//
// Node built-ins only; no file or network access in here.

'use strict';

// What each walk is, in the words shown to the person doing it.
// people: how many should get through. group: how it is scored.
const KINDS = {
  'alone-normal':     { say: 'Walk through alone, normal speed', short: 'Alone, normal speed', people: 1, group: 'single' },
  'alone-fast':       { say: 'Walk through alone, fast', short: 'Alone, fast', people: 1, group: 'single' },
  'alone-slow':       { say: 'Walk through alone, slowly, and pause in the middle', short: 'Alone, slow with a pause', people: 1, group: 'single' },
  'two-one-rotation': { say: 'Two people on ONE rotation (one right behind the other)', short: 'Two on one rotation', people: 2, group: 'tailgate' },
  'two-separate':     { say: 'Two people, separate rotations, a few seconds apart', short: 'Two, separate rotations', people: 2, group: 'separate' },
  'arm-wave':         { say: 'Wave your arm near the gate without going through', short: 'Arm wave (no one goes through)', people: 0, group: 'wave' },
};
const SCRIPT = [
  'alone-normal', 'alone-normal', 'alone-normal', 'alone-fast', 'alone-slow',
  'two-one-rotation', 'two-one-rotation', 'two-one-rotation',
  'two-separate', 'two-separate', 'arm-wave',
];

// Limits. Per run: 11 walks, the two "separate" ones usually make two
// crossings each (13), plus a redo or two. Per gym per day: three runs.
const MAX_ANALYSES_PER_RUN = 15;
const MAX_TEST_ANALYSES_PER_DAY = 45;
const MAX_COMPARE_PER_RUN = 15;
const MAX_TRIALS = 40;              // attempt numbers, redos included
const MAX_CROSSINGS_PER_TRIAL = 4;
const RUN_ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4,8}$/;
const RUNS_KEPT = 5;                // per gym, on the website

// ---------- models and cost ----------
// Same prices and token estimate as monitor.js (PRICE_PER_MTOK /
// estimateCost): about $0.0038 per 3-photo crossing on Sonnet.
const PRICE_PER_MTOK = {
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
};
const SONNET = 'claude-sonnet-4-6', HAIKU = 'claude-haiku-4-5-20251001';
function costPerAnalysis(model, frames) {
  const p = PRICE_PER_MTOK[model] || PRICE_PER_MTOK[SONNET];
  const inTok = (384 * 288 / 750) * (frames || 3) + 320;
  return (inTok / 1e6) * p.in + (100 / 1e6) * p.out;
}
function modelName(m) { return /haiku/i.test(String(m)) ? 'Haiku' : 'Sonnet'; }
function otherModel(m) { return /haiku/i.test(String(m)) ? SONNET : HAIKU; }
function isCheaper(m) { return /haiku/i.test(String(m)); }
// "about 6 cents" / "about $1.20"
function money(dollars) {
  const d = Math.max(0, Number(dollars) || 0);
  if (d === 0) return 'nothing';
  if (d < 0.995) { const c = Math.max(1, Math.round(d * 100)); return `about ${c} cent${c === 1 ? '' : 's'}`; }
  return `about $${d.toFixed(2)}`;
}

// ---------- strict checks for what the camera computer sends ----------
function isInt(v, lo, hi) { return Number.isInteger(v) && v >= lo && v <= hi; }
// The `test` field of a crossing. Returns { value } or { error }.
function validateTest(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return { error: 'test must be an object { runId, trial, expected, seq }.' };
  const keys = Object.keys(t);
  const extra = keys.filter(k => !['runId', 'trial', 'expected', 'seq'].includes(k));
  if (extra.length) return { error: `test has unknown field(s): ${extra.slice(0, 3).map(k => String(k).slice(0, 20)).join(', ')}.` };
  if (typeof t.runId !== 'string' || !RUN_ID_RE.test(t.runId)) return { error: 'test.runId is not a test run id.' };
  if (!isInt(t.trial, 1, MAX_TRIALS)) return { error: `test.trial must be a whole number from 1 to ${MAX_TRIALS}.` };
  if (typeof t.expected !== 'string' || !Object.prototype.hasOwnProperty.call(KINDS, t.expected)) return { error: `test.expected must be one of: ${Object.keys(KINDS).join(', ')}.` };
  if (!isInt(t.seq, 1, MAX_CROSSINGS_PER_TRIAL)) return { error: `test.seq must be a whole number from 1 to ${MAX_CROSSINGS_PER_TRIAL}.` };
  return { value: { runId: t.runId, trial: t.trial, expected: t.expected, seq: t.seq } };
}
const STATUSES = ['done', 'missed', 'skipped', 'redone'];
const MISS_REASONS = ['no-motion', 'motion-ignored', 'no-picture', 'still'];
// The list of walks sent when a run finishes. Returns { value } or { error }.
function validateTrials(list) {
  if (!Array.isArray(list) || list.length > MAX_TRIALS) return { error: `trials must be a list of at most ${MAX_TRIALS}.` };
  const out = [];
  const seen = new Set();
  for (const t of list) {
    if (!t || typeof t !== 'object' || Array.isArray(t)) return { error: 'Each trial must be an object.' };
    const extra = Object.keys(t).filter(k => !['n', 'pos', 'kind', 'status', 'missReason', 'seqs', 'rejected'].includes(k));
    if (extra.length) return { error: 'A trial has unknown fields.' };
    if (!isInt(t.n, 1, MAX_TRIALS) || seen.has(t.n)) return { error: 'Each trial needs its own number n.' };
    seen.add(t.n);
    if (!Object.prototype.hasOwnProperty.call(KINDS, t.kind)) return { error: 'A trial has an unknown kind.' };
    if (!STATUSES.includes(t.status)) return { error: 'A trial has an unknown status.' };
    const missReason = t.missReason == null ? null : String(t.missReason);
    if (missReason && !MISS_REASONS.includes(missReason)) return { error: 'A trial has an unknown missReason.' };
    const seqs = t.seqs == null ? [] : t.seqs;
    if (!Array.isArray(seqs) || seqs.length > MAX_CROSSINGS_PER_TRIAL || !seqs.every(s => isInt(s, 1, MAX_CROSSINGS_PER_TRIAL))) return { error: 'A trial has bad crossing numbers.' };
    const rejected = t.rejected == null ? [] : t.rejected;
    if (!Array.isArray(rejected) || rejected.length > 10 || !rejected.every(r => typeof r === 'string' && r.length <= 30)) return { error: 'A trial has bad "rejected" reasons.' };
    out.push({ n: t.n, pos: isInt(t.pos, 1, 99) ? t.pos : null, kind: t.kind, status: t.status, missReason, seqs: [...new Set(seqs)], rejected: rejected.map(r => r.replace(/[^a-z-]/g, '')) });
  }
  return { value: out };
}

// ---------- scoring ----------
// A verdict counts as an alert only when the gym would get one (monitor.js:
// flagged AND confidence not "low"). A false alarm is ANY flag, low
// confidence included: it still shows on the gym's activity page.
const alerts = v => !!(v && v.tailgate_flag && v.confidence !== 'low');
const flags = v => !!(v && v.tailgate_flag);

// One walk. verdicts: the analysed answers for its crossings (in order),
// or null for a crossing that was not analysed (limit, error, no answer).
function judgeTrial(t, verdicts) {
  const k = KINDS[t.kind];
  const out = { n: t.n, pos: t.pos, kind: t.kind, group: k.group, expectedPeople: k.people, status: t.status, missReason: t.missReason || null,
    noticed: null, analysed: false, right: null, people: null, flagged: false, alerted: false, falseAlarm: false, caught: null, text: '' };
  if (t.status === 'skipped' || t.status === 'redone') { out.text = t.status === 'skipped' ? 'skipped' : 'redone'; return out; }
  const vs = verdicts || [];
  const got = vs.filter(Boolean);
  const crossings = vs.length;
  if (k.group === 'wave') {
    if (!crossings) {
      if (t.missReason === 'no-motion' || t.missReason === 'still' || t.missReason === 'no-picture') { out.text = t.missReason === 'no-picture' ? 'not tested: no picture from the camera' : 'not tested: no movement seen at all'; return out; }
      out.right = true; out.text = 'ignored (movement seen, not counted as a crossing) ✓'; out.waveResult = 'ignored'; return out;
    }
    if (got.length < crossings) { out.text = 'seen as a crossing, but it was not counted (limit or error)'; out.waveResult = 'not-checked'; return out; }
    out.analysed = true;
    out.people = got.reduce((n, v) => n + (Number(v.people_count) || 0), 0);
    out.flagged = got.some(flags); out.alerted = got.some(alerts);
    out.falseAlarm = out.flagged;
    out.right = out.people === 0 && !out.flagged;
    out.waveResult = out.flagged ? 'flagged' : out.people > 0 ? 'counted' : 'checked-ok';
    out.text = out.flagged ? `✗ flagged as tailgating (${out.people} counted)` : out.people > 0 ? `✗ counted as ${out.people === 1 ? 'a walk-through' : `${out.people} people`}` : 'seen as a crossing, but nobody was counted ✓';
    return out;
  }
  if (!crossings) {
    out.noticed = false;
    out.text = t.missReason === 'no-picture' ? '✗ not noticed: no picture from the camera'
      : t.missReason === 'motion-ignored' ? '✗ not noticed: movement was seen, but it did not count as a crossing'
      : '✗ not noticed: no movement in the watched box';
    return out;
  }
  out.noticed = true;
  if (got.length < crossings) { out.text = 'noticed, but not counted (limit, error or no answer)'; return out; }
  out.analysed = true;
  out.people = got.reduce((n, v) => n + (Number(v.people_count) || 0), 0);
  out.flagged = got.some(flags); out.alerted = got.some(alerts);
  const split = crossings > 1 ? ` (seen as ${crossings} crossings)` : '';
  const counted = `${out.people} ${out.people === 1 ? 'person' : 'people'} counted`;
  if (k.group === 'tailgate') {
    out.caught = out.alerted;
    out.right = out.caught;
    out.text = out.caught ? `✓ caught: ${counted}, flagged${split}`
      : out.flagged ? `✗ flagged with LOW confidence (no alert would go out): ${counted}${split}`
      : `✗ tailgate missed: ${counted}${split}`;
  } else {
    out.falseAlarm = out.flagged;
    out.right = out.people === k.people && !out.flagged;
    out.text = out.falseAlarm ? `✗ false alarm: ${counted}, flagged as tailgating${split}`
      : out.right ? `✓ ${counted}${split}` : `✗ ${counted}, expected ${k.people}${split}`;
  }
  return out;
}

// verdictOf(n, seq) -> verdict object, or null when not analysed.
function scoreRun(trials, verdictOf) {
  const judged = (trials || []).map(t => judgeTrial(t, (t.seqs || []).map(s => verdictOf(t.n, s) || null)));
  const live = judged.filter(j => j.status !== 'skipped' && j.status !== 'redone');
  const walks = live.filter(j => j.group !== 'wave');
  const counted = walks.filter(j => j.analysed);
  const tail = live.filter(j => j.group === 'tailgate');
  const tailCounted = tail.filter(j => j.analysed);
  const wave = live.filter(j => j.group === 'wave').slice(-1)[0] || null;
  const noPicture = live.some(j => j.missReason === 'no-picture');
  const sc = {
    walks: walks.length,
    noticed: walks.filter(j => j.noticed).length,
    missedNoMotion: walks.filter(j => j.noticed === false && j.missReason !== 'motion-ignored' && j.missReason !== 'no-picture').length,
    missedIgnored: walks.filter(j => j.missReason === 'motion-ignored' && j.noticed === false).length,
    counted: counted.length,
    right: counted.filter(j => j.right).length,
    tailgatesTried: tail.length,
    tailgates: tailCounted.length,
    tailgatesCaught: tailCounted.filter(j => j.caught).length,
    singlesFlagged: counted.filter(j => j.group !== 'tailgate' && j.falseAlarm).length,
    falseAlarms: counted.filter(j => j.group !== 'tailgate' && j.falseAlarm).length + (wave && wave.falseAlarm ? 1 : 0),
    otherWrong: counted.filter(j => j.group !== 'tailgate' && !j.right && !j.falseAlarm).length,
    wave: wave ? (wave.waveResult || (wave.right === null ? 'not-tested' : null)) : null,
    waveText: wave ? wave.text : 'not done',
    notCounted: walks.filter(j => j.noticed && !j.analysed).length,
    noPicture,
  };
  // "Right" over every walk the model actually judged, arm wave included
  // (only when a crossing was analysed): the like-for-like number used to
  // compare two models on the same photos.
  const modelJudged = live.filter(j => j.analysed);
  sc.judgedAll = modelJudged.length;
  sc.rightAll = modelJudged.filter(j => j.right).length;
  Object.assign(sc, verdictFor(sc));
  return { scorecard: sc, trials: judged };
}

// One-line verdict plus what to do, most useful fix first.
function verdictFor(sc) {
  const fixes = [];
  const problems = [];
  if (sc.noPicture) { problems.push('the camera picture dropped out during the test'); fixes.push('Check the recorder cable, then run: node rtsp-run.js --check'); }
  if (sc.walks && sc.noticed < sc.walks) {
    problems.push(`${sc.walks - sc.noticed} of ${sc.walks} walks were not noticed`);
    fixes.push('Tighten the box round the turnstile: node setup-camera.js');
  }
  const tailMiss = sc.tailgates - sc.tailgatesCaught;
  if (tailMiss > 0) problems.push(`${tailMiss} of ${sc.tailgates} tailgates were missed`);
  if (sc.falseAlarms > 0) problems.push(`${sc.falseAlarms} false alarm${sc.falseAlarms === 1 ? '' : 's'}`);
  if (sc.otherWrong > 0) problems.push(`${sc.otherWrong} walk${sc.otherWrong === 1 ? ' was' : 's were'} counted wrong`);
  if (tailMiss > 0 || sc.falseAlarms > 0 || sc.otherWrong > 0) fixes.push('Probably the camera angle or lighting. Send the test folder to Claude.');
  let verdict, ok = false, level = 'bad';
  if (problems.length) verdict = `Not good enough yet: ${problems.join(', ')}.`;
  else if (sc.tailgates < 2 || sc.counted < 4) { verdict = 'Not enough walks were counted to judge it. Run the test again.'; level = 'warn'; }
  else if (sc.notCounted > 0) { verdict = `Good so far, but ${sc.notCounted} walk${sc.notCounted === 1 ? ' was' : 's were'} not counted (limit or error).`; level = 'warn'; }
  else { verdict = 'Good: it noticed every walk, caught every tailgate and raised no false alarms.'; ok = true; level = 'ok'; }
  if (!ok && !fixes.length && level === 'bad') fixes.push('Send the test folder to Claude.');
  return { verdict, fixes: [...new Set(fixes)], ok, level };
}

function waveWords(sc) {
  return ({ ignored: 'ignored ✓', 'checked-ok': 'checked, nobody counted ✓', counted: 'counted as a walk-through ✗', flagged: 'flagged as tailgating ✗',
    'not-checked': 'not counted (limit or error)', 'not-tested': 'not tested (no movement seen)' })[sc.wave] || 'not done';
}
// The scorecard as the person reads it (terminal / plain text).
function formatScorecard(sc) {
  const pad = s => (s + ':').padEnd(19);
  const lines = [
    `${pad('Walks noticed')}${sc.noticed} of ${sc.walks}`,
    `${pad('Counted right')}${sc.right} of ${sc.counted}`,
    `${pad('Tailgates caught')}${sc.tailgatesCaught} of ${sc.tailgates}  (two people on one rotation${sc.tailgatesTried > sc.tailgates ? `; ${sc.tailgatesTried - sc.tailgates} more not seen at all` : ''})`,
    `${pad('False alarms')}${sc.falseAlarms}  (a walk wrongly flagged as tailgating)`,
    `${pad('Arm wave')}${waveWords(sc)}`,
    '',
    `Verdict: ${sc.verdict}`,
  ];
  for (const f of sc.fixes || []) lines.push(`Do this: ${f}`);
  return lines;
}

// Should the gym use the cheaper model? Only if, on the SAME photos, it
// caught every tailgate and raised no more false alarms than the other.
// a, b: { model, scorecard }. dailyCap: the gym's daily limit.
function recommend(a, b, currentModel, dailyCap) {
  const cheap = isCheaper(a.model) ? a : b, dear = cheap === a ? b : a;
  const cap = Number(dailyCap) || 60;
  const saving = cap * 30 * (costPerAnalysis(dear.model) - costPerAnalysis(cheap.model));
  const cs = cheap.scorecard, ds = dear.scorecard;
  const cn = modelName(cheap.model), dn = modelName(dear.model);
  const onCheap = isCheaper(currentModel);
  const base = { cheaper: cheap.model, savingPerMonth: Number(saving.toFixed(2)), savingText: money(saving) };
  if (!cs.tailgates) {
    return Object.assign(base, { recommend: null, level: 'warn', text: 'No tailgate walk was counted, so the two can\'t be compared fairly. Run the test again.' });
  }
  const allTail = cs.tailgatesCaught === cs.tailgates;
  const noWorse = cs.falseAlarms <= ds.falseAlarms;
  if (allTail && noWorse) {
    return Object.assign(base, { recommend: cheap.model, level: 'ok',
      text: onCheap ? `Stay on ${cn}: it caught every tailgate (${cs.tailgatesCaught} of ${cs.tailgates}) with no more false alarms than ${dn}.`
        : `Switch to ${cn}: it caught every tailgate (${cs.tailgatesCaught} of ${cs.tailgates}) with no more false alarms than ${dn}, and saves ${money(saving)} a month at your limit of ${cap} a day.` });
  }
  const why = [!allTail ? `${cn} missed ${cs.tailgates - cs.tailgatesCaught} of ${cs.tailgates} tailgates` : null,
    !noWorse ? `${cn} raised ${cs.falseAlarms} false alarm${cs.falseAlarms === 1 ? '' : 's'} (${dn}: ${ds.falseAlarms})` : null].filter(Boolean).join(' and ');
  return Object.assign(base, { recommend: dear.model, level: onCheap ? 'bad' : 'ok',
    text: onCheap ? `Switch to ${dn}: ${why}. ${dn} costs ${money(saving)} a month more at your limit of ${cap} a day.`
      : `Stay on ${dn}: ${why}.${ds.tailgatesCaught < ds.tailgates ? ` (${dn} missed ${ds.tailgates - ds.tailgatesCaught} too: fix what the scorecard says first, then test again.)` : ''}` });
}

// "test-2026-09-27-1412" from a run id "20260927-141205-ab12".
function folderName(runId) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(String(runId));
  return m ? `test-${m[1]}-${m[2]}-${m[3]}-${m[4]}${m[5]}` : 'test';
}
function newRunId(now, rand) {
  const d = now ? new Date(now) : new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${rand || Math.random().toString(36).slice(2, 6).padEnd(4, '0')}`;
}

module.exports = {
  KINDS, SCRIPT, MAX_ANALYSES_PER_RUN, MAX_TEST_ANALYSES_PER_DAY, MAX_COMPARE_PER_RUN, MAX_TRIALS, MAX_CROSSINGS_PER_TRIAL, RUN_ID_RE, RUNS_KEPT,
  SONNET, HAIKU, costPerAnalysis, modelName, otherModel, isCheaper, money,
  validateTest, validateTrials, judgeTrial, scoreRun, verdictFor, formatScorecard, waveWords, recommend, folderName, newRunId,
};
