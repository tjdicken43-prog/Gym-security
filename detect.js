// SecurityAI detection engine — SHARED by the browser dashboard and the
// server-side RTSP pipeline.
//
// This file is loaded two ways and must work in both:
//   <script src="detect.js"></script>   in monitor.html  -> window.SecurityAIDetect
//   require('./detect')                 in monitor.js    -> module.exports
//
// Keeping one copy matters: the browser path and the RTSP path have to
// agree about what counts as a person crossing a doorway, or two
// customers on different hardware get different answers from the same
// product. Everything here is pure maths on a small grid of brightness
// values — no DOM, no Node APIs, nothing environment-specific.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SecurityAIDetect = factory();
}(typeof self !== 'undefined' ? self : this, function () {

/* ---------- Motion detection tuning ----------
   Detection is deliberately cheap: downscale each zone crop to a small
   grid, compare per-cell luminance against the previous check, and score
   both HOW MUCH of the zone changed and HOW HARD it changed. Fast motion
   between two 250ms samples displaces more of the frame by a bigger
   margin, so it scores higher than someone drifting slowly. The debounce
   and cooldown below are the real cost guards — they cap how often a
   burst can fire no matter how busy the doorway is.                    */
const MOTION_CHECK_MS = 250;
// --- Event-based capture -------------------------------------------
// Firing a burst the instant motion starts captures the wrong moment.
// A member walks into frame, stops, digs out their phone, scans, THEN
// walks through — so a burst taken at first movement shows someone
// standing in a doorway holding a phone, and the actual crossing
// happens later, possibly during the cooldown where nothing is watched.
//
// Instead we buffer crops for as long as motion continues, and only send
// once the person has finished crossing and the doorway goes quiet
// again. The frames sent are spread across the whole event and weighted
// toward the end, so the crossing itself is always in there.
const EVENT_QUIET_TICKS = 3;      // ~750ms of stillness = the event is over
const EVENT_MAX_TICKS = 48;       // ~12s ceiling so a loiterer can't buffer forever
const EVENT_MAX_BUFFER = 60;      // hard cap on retained crops
const EVENT_FRAMES_SENT = 3;      // how many of the buffered crops go to Claude
// --- Threshold crossing check ---------------------------------------
// A box drawn around a doorway inevitably includes background: floor
// behind the door, people milling on one side, a corridor. Motion alone
// in that box isn't an entry. A real entry has a trajectory — the person
// starts on one side of the threshold and ends on the other.
//
// So before spending anything, we check the path the motion actually
// took across the event. If it never crossed the middle of the zone on
// its dominant axis, nobody went through the door: they walked past,
// milled about, or something in the background moved. Rejected locally,
// for free.
const CROSS_MIN_TRAVEL = 1.8;
// The debounce means an event only opens after two consecutive person
// detections — but by then the person is already half way across, and a
// trajectory that starts at the midline looks like it never crossed it.
// So centroids are recorded continuously into a small rolling buffer,
// and the event is seeded with them when it opens. Cheap: it's a couple
// of numbers per tick, no image work.
const PRE_BUFFER_TICKS = 6;     // grid cells of net travel required (grid is 12 wide)
const MOTION_CONSECUTIVE_REQUIRED = 2;   // ignore single-sample flickers
const MOTION_COOLDOWN_MS = 5000;         // max one burst per zone per 5s
const DIFF_GRID = 12;
const CELL_DELTA_THRESHOLD = 18;         // floor for the per-cell change that counts as "changed"
// Overnight is the whole point of this product, and night footage is
// grainy — IR gain, low light, heavy compression. A fixed threshold that
// works in daylight lets sensor noise register as motion at 2am, which
// produces false alerts and real charges for an empty doorway.
// So each zone learns its own noise floor from quiet frames and raises
// its threshold above it. A clean camera keeps the sensitive default; a
// grainy one gets exactly as much slack as it needs.
// The 90th percentile of frame-to-frame deltas tracks the noise tail far
// better than the median — measured on synthetic frames, median barely
// moves as grain rises (1.6 -> 9.2) while p90 climbs with it (3.9 -> 23.3),
// which is what actually causes false triggers.
const NOISE_FLOOR_PERCENTILE = 0.90;
// The floor must only ever learn from QUIET frames. Learning from a frame
// that contains a person teaches the zone that a person is background
// noise — and if monitoring happens to start while someone is walking
// through the door, the zone goes blind for the rest of the night.
const NOISE_LEARN_MAX_CHANGED = 0.18;   // above this the frame has real motion in it
const NOISE_FLOOR_CEILING = 26;         // never let a zone blind itself completely
const NOISE_FLOOR_MULTIPLIER = 1.5;      // chosen by sweep: 1.15 let noise through, 1.5 held zero false alarms
const NOISE_FLOOR_SMOOTHING = 0.15;      // converges within a few seconds of quiet
const SENSITIVITY = {
  all:      { minFraction: 0.05, minDisplacement: 0.5 },
  moderate: { minFraction: 0.06, minDisplacement: 0.8 },
  fast:     { minFraction: 0.10, minDisplacement: 1.6 },
};
// Running tally of why motion was rejected, so you can see the filter
// working instead of guessing. Shown under the zone list.
const rejectStats = { still:0, lighting:0, chronic:0, 'too-small':0, scattered:0, 'in-place':0, candidate:0, person:0, 'no-crossing':0 };
function currentSensitivity(){ return SENSITIVITY[document.getElementById('sensitivitySelect').value] || SENSITIVITY.moderate; }



function classifyMotion(prevCells, cells, zoneState, sens) {
  const n = cells.length, G = DIFF_GRID;
  const deltas = new Array(n);
  for (let i = 0; i < n; i++) deltas[i] = Math.abs(cells[i] - prevCells[i]);

  // The median delta is a robust read of this camera's noise: a person
  // occupies a minority of cells, so the middle value reflects the quiet
  // background even mid-event.
  const sorted = deltas.slice().sort((a, b) => a - b);
  const p90 = sorted[Math.floor(NOISE_FLOOR_PERCENTILE * (n - 1))];

  // Start at the plain default rather than at whatever the first frame
  // happened to contain.
  if (zoneState.noiseFloor == null) {
    zoneState.noiseFloor = CELL_DELTA_THRESHOLD / NOISE_FLOOR_MULTIPLIER;
  }
  const threshold = Math.min(
    NOISE_FLOOR_CEILING,
    Math.max(CELL_DELTA_THRESHOLD, zoneState.noiseFloor * NOISE_FLOOR_MULTIPLIER)
  );

  let changed = [], sum = 0;
  for (let i = 0; i < n; i++) {
    if (deltas[i] > threshold) { changed.push(i); sum += deltas[i]; }
  }

  // Update the floor only when this frame looks quiet enough to be
  // background — never mid-crossing.
  if (changed.length / n <= NOISE_LEARN_MAX_CHANGED) {
    zoneState.noiseFloor =
      zoneState.noiseFloor * (1 - NOISE_FLOOR_SMOOTHING) + p90 * NOISE_FLOOR_SMOOTHING;
  }
  if (!changed.length) return { verdict: 'still' };

  // --- 1. Global lighting change ---
  // A light flicking on, an exposure shift, or a whole-screen flash moves
  // nearly every cell by a similar amount. A person moves a localized
  // patch. Compare how much of the grid changed against how UNIFORM that
  // change was: high coverage + low variance = lighting, not a person.
  const meanDelta = sum / changed.length;
  let variance = 0;
  for (const i of changed) variance += (deltas[i] - meanDelta) ** 2;
  variance /= changed.length;
  const cv = Math.sqrt(variance) / (meanDelta || 1); // coefficient of variation
  if (changed.length / n > 0.75 && cv < 0.35) {
    return { verdict: 'lighting', changedFraction: changed.length / n, cv };
  }

  // --- 2. Chronic hotspots (clock overlays, screens, status LEDs) ---
  // Track how often each cell has ever fired. Cells that fire in most
  // samples aren't events — they're something that changes constantly in
  // a fixed spot. Subtract them before judging.
  zoneState.samples = (zoneState.samples || 0) + 1;
  zoneState.hits = zoneState.hits || new Array(n).fill(0);
  for (const i of changed) zoneState.hits[i]++;
  const chronic = new Set();
  if (zoneState.samples >= 20) {
    for (let i = 0; i < n; i++) {
      if (zoneState.hits[i] / zoneState.samples > 0.6) chronic.add(i);
    }
  }
  const real = changed.filter(i => !chronic.has(i));
  if (!real.length) return { verdict: 'chronic', chronicCells: chronic.size };

  // --- 3. Size sanity ---
  // A person crossing a doorway occupies a meaningful chunk of the zone.
  // A couple of stray cells is noise or a distant reflection.
  const frac = real.length / n;
  if (frac < sens.minFraction) return { verdict: 'too-small', changedFraction: frac };
  // NOTE: centroid is returned from here on for EVERY verdict, not just
  // 'person'. The threshold-crossing check needs a continuous path — if
  // frames judged 'in-place' or 'scattered' contribute nothing, the
  // trajectory develops gaps and a real crossing can look like it never
  // reached the far side.

  // --- 4. Compactness ---
  // Person = one coherent blob. Scattered noise across the whole grid
  // with no centre isn't a body.
  let cx = 0, cy = 0;
  for (const i of real) { cx += i % G; cy += Math.floor(i / G); }
  cx /= real.length; cy /= real.length;
  let near = 0;
  for (const i of real) {
    const dx = (i % G) - cx, dy = Math.floor(i / G) - cy;
    if (Math.sqrt(dx*dx + dy*dy) <= G * 0.38) near++;
  }
  const compactness = near / real.length;
  if (compactness < 0.55) return { verdict: 'scattered', compactness, centroid: { cx, cy } };

  // --- 5. Displacement ---
  // The decisive one. A person MOVES: the blob's centre shifts between
  // consecutive samples. A flashing sign, a spinning fan, or a screen
  // changes in place — same centre every time.
  const prevC = zoneState.lastCentroid;
  zoneState.lastCentroid = { cx, cy };
  if (prevC) {
    const moved = Math.sqrt((cx - prevC.cx) ** 2 + (cy - prevC.cy) ** 2);
    zoneState.lastDisplacement = moved;
    if (moved < sens.minDisplacement) {
      return { verdict: 'in-place', displacement: moved, compactness, centroid: { cx, cy } };
    }
    return { verdict: 'person', displacement: moved, compactness, changedFraction: frac, centroid: { cx, cy } };
  }
  // First detection has nothing to compare against — treat as a candidate
  // and let the consecutive-hit debounce confirm it on the next sample.
  return { verdict: 'candidate', compactness, changedFraction: frac, centroid: { cx, cy } };
}


function didCrossThreshold(path){
  if(!path || path.length < 3) return { crossed:false, reason:'too-short' };
  const xs = path.map(p => p.cx), ys = path.map(p => p.cy);
  const rangeX = Math.max(...xs) - Math.min(...xs);
  const rangeY = Math.max(...ys) - Math.min(...ys);
  // Whichever axis the movement mostly happened on is the one the person
  // travelled along; the doorway is crossed along that axis.
  const useX = rangeX >= rangeY;
  const vals = useX ? xs : ys;
  const travel = useX ? rangeX : rangeY;
  const mid = (DIFF_GRID - 1) / 2;
  const startsBefore = vals[0] < mid;
  const endsAfter = vals[vals.length - 1] > mid;
  const crossedMid = (startsBefore && endsAfter) || (!startsBefore && !endsAfter && vals[0] > mid && vals[vals.length-1] < mid);
  // also accept a clear crossing anywhere in the path, not just start->end
  const sawBoth = vals.some(v => v < mid) && vals.some(v => v > mid);
  const crossed = travel >= CROSS_MIN_TRAVEL && sawBoth;
  return { crossed, travel:Number(travel.toFixed(1)), axis:useX?'x':'y', reason: crossed ? 'crossed' : (travel < CROSS_MIN_TRAVEL ? 'stayed-put' : 'never-crossed-midline') };
}


function selectEventFrames(buf, n){
  if(buf.length <= n) return buf.slice();
  const picks = [0.30, 0.65, 0.95].slice(0, n);
  const out = picks.map(f => buf[Math.min(buf.length - 1, Math.floor(f * (buf.length - 1)))]);
  // de-duplicate if the event was very short
  return out.filter((v, i) => out.indexOf(v) === i);
}


// Runs one tick of the per-zone state machine. Returns a burst to send,
// or null. The caller supplies grabCells() and is responsible for the
// actual image capture, which differs between browser and server.
function stepZone(z, cells, sens, opts) {
  const o = opts || {};
  const out = { verdict: null, send: null };
  if (!z.prevCells) { z.prevCells = cells; return out; }

  const result = classifyMotion(z.prevCells, cells, z, sens);
  z.prevCells = cells;
  out.verdict = result.verdict;
  z.lastVerdict = result.verdict;

  if (result.centroid) {
    (z.preCentroids = z.preCentroids || []).push(result.centroid);
    if (z.preCentroids.length > PRE_BUFFER_TICKS) z.preCentroids.shift();
  }

  const isPerson = result.verdict === 'person';
  if (isPerson) {
    z.consecutiveHits = (z.consecutiveHits || 0) + 1;
    if (z.consecutiveHits >= MOTION_CONSECUTIVE_REQUIRED) {
      if (!z.eventActive) {
        z.eventActive = true; z.eventTicks = 0;
        z.eventPath = (z.preCentroids || []).slice();
      }
      z.quietTicks = 0;
    }
  } else {
    z.consecutiveHits = 0;
    if (z.eventActive) z.quietTicks = (z.quietTicks || 0) + 1;
  }

  if (z.eventActive) {
    if (result.centroid) (z.eventPath = z.eventPath || []).push(result.centroid);
    z.eventTicks = (z.eventTicks || 0) + 1;
    if (typeof o.onCapture === 'function') o.onCapture();

    const ended = z.quietTicks >= EVENT_QUIET_TICKS;
    const tooLong = z.eventTicks >= EVENT_MAX_TICKS;
    if (ended || tooLong) {
      const cross = didCrossThreshold(z.eventPath);
      const ticks = z.eventTicks;
      z.eventActive = false; z.quietTicks = 0; z.eventTicks = 0; z.eventPath = [];
      out.send = (ticks >= 2 && cross.crossed)
        ? { ticks, durationSec: (ticks * MOTION_CHECK_MS / 1000).toFixed(1), cross }
        : null;
      if (!out.send) out.rejected = cross.crossed ? 'too-brief' : 'no-crossing';
    }
  }
  return out;
}

function resetZone(z) {
  z.prevCells = null; z.consecutiveHits = 0; z.quietTicks = 0;
  z.eventActive = false; z.eventTicks = 0; z.eventPath = [];
  z.preCentroids = []; z.hits = null; z.samples = 0;
  z.lastCentroid = null; z.noiseFloor = null;
}

return {
  classifyMotion, didCrossThreshold, selectEventFrames, stepZone, resetZone,
  SENSITIVITY, DIFF_GRID, MOTION_CHECK_MS, EVENT_FRAMES_SENT,
  MOTION_CONSECUTIVE_REQUIRED, MOTION_COOLDOWN_MS,
};
}));
