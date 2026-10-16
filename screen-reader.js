#!/usr/bin/env node
// Screen reader: member numbers from the front-desk screen, with nothing
// installed on the front-desk PC.
//
// A powered HDMI splitter copies the PC's picture to a USB capture stick
// on this box (the Raspberry Pi). This program reads Ashbourne's Live Entry
// pop-up from that picture: Membership No, Entry Message (zone) and Entry
// Time. A new scan = the pop-up showing a new member/time. The number is
// scrambled HERE for your approved devices only (reader-core.js), exactly
// like the Windows reader. Pictures are never saved or sent: each frame is
// read in memory and only the small pop-up area is OCR'd, from a private
// temporary file that is deleted straight away.
//
//   node screen-reader.js --setup     once: pair, check the picture, check the owner code
//   node screen-reader.js --check     what it reads right now (numbers hidden)
//   node screen-reader.js             run (the background service does this)
//
// Needs: ffmpeg and tesseract (the Pi setup installs both).
// Tests: --source file:<video> [--fast]   SECURITYAI_HOME for the settings folder.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { ReaderCore, netWords } = require('./reader-core');

const VERSION = 'screen-1.0.0';
const W = 1920, H = 1080;                     // every frame is scaled to this
const FPS = Number(process.env.SECURITYAI_SCREEN_FPS || 3);
const DOUBLE_SEC = 300;                       // same member within 5 min = one scan (the lockout is 10 min; a re-read or a double scan)
const LOCATE_EVERY_MS = 20000;                // look for a moved/hidden pop-up this often
const TF = process.env.SECURITYAI_TEST_FAST ? 1 / 24 : 1;  // tests: 5 s instead of 2 min
const T_NO_SIGNAL = 2 * 60e3 * TF, T_HIDDEN = 5 * 60e3 * TF, T_UNREADABLE = 2 * 60e3 * TF;

const arg = n => { const i = process.argv.indexOf('--' + n); return i === -1 ? undefined : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const stateDir = () => process.env.SECURITYAI_HOME || path.join(os.homedir(), '.securityai');
const tmpDir = () => { const d = path.join(stateDir(), 'tmp'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; };
const logFile = () => path.join(stateDir(), 'screen-reader.log');
function log(m) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)}  ${m}`;
  if (!process.env.SECURITYAI_SERVICE) console.log(line);
  try { fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); fs.appendFileSync(logFile(), line + '\n'); const st = fs.statSync(logFile()); if (st.size > 2e6) fs.renameSync(logFile(), logFile() + '.old'); } catch (e) { /* ignore */ }
}
const mask = m => String(m).replace(/.(?=..)/g, '•');            // "4810" -> "••10"

// ------------------------------------------------------------------ OCR
function which(cmd) { const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; }
const TESS = process.env.TESSERACT_PATH || which('tesseract');
const NICE = process.platform === 'win32' ? null : which('nice');
const FFMPEG = process.env.FFMPEG_PATH || (() => { try { return require('./runner-config').findFfmpeg(); } catch (e) { return null; } })() || which('ffmpeg');

// Gray crop, scaled up (bilinear): small screen text reads far better big.
function cropScale(buf, x0, y0, cw, ch, s) {
  const ow = Math.round(cw * s), oh = Math.round(ch * s), out = Buffer.alloc(ow * oh);
  for (let y = 0; y < oh; y++) {
    const fy = y0 + (y + 0.5) / s - 0.5, iy = Math.max(y0, Math.min(y0 + ch - 2, Math.floor(fy))), dy = Math.min(1, Math.max(0, fy - iy));
    for (let x = 0; x < ow; x++) {
      const fx = x0 + (x + 0.5) / s - 0.5, ix = Math.max(x0, Math.min(x0 + cw - 2, Math.floor(fx))), dx = Math.min(1, Math.max(0, fx - ix));
      const a = buf[iy * W + ix], b = buf[iy * W + ix + 1], c = buf[(iy + 1) * W + ix], d = buf[(iy + 1) * W + ix + 1];
      out[y * ow + x] = Math.round(a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy);
    }
  }
  return { buf: out, w: ow, h: oh };
}
// Words with their boxes, in FRAME coordinates. (Async: frames keep coming.)
function ocr(frame, box, s) {
  const c = cropScale(frame, box.x, box.y, box.w, box.h, s);
  const f = path.join(tmpDir(), crypto.randomBytes(6).toString('hex') + '.pgm');
  fs.writeFileSync(f, Buffer.concat([Buffer.from(`P5\n${c.w} ${c.h}\n255\n`), c.buf]), { mode: 0o600 });
  return new Promise((resolve, reject) => {
    // One thread each (much faster for small pictures; two run side by side).
    // Low priority ("nice"): the camera's own work always comes first on the Pi.
    const cmd = NICE ? [NICE, ['-n', '10', TESS, f, 'stdout', '--psm', '11', '-l', 'eng', 'tsv']] : [TESS, [f, 'stdout', '--psm', '11', '-l', 'eng', 'tsv']];
    const p = spawn(cmd[0], cmd[1], { stdio: ['ignore', 'pipe', 'pipe'], env: Object.assign({}, process.env, { OMP_THREAD_LIMIT: '1' }) });
    let out = '', err = '';
    const kill = setTimeout(() => p.kill('SIGKILL'), 60000);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err = (err + d).slice(-300); });
    p.on('error', e => { clearTimeout(kill); try { fs.unlinkSync(f); } catch (x) { /* gone */ } reject(e); });
    p.on('close', code => {
      clearTimeout(kill);
      try { fs.unlinkSync(f); } catch (e) { /* gone */ }
      if (code !== 0) return reject(new Error('tesseract failed: ' + err));
      const words = [];
      for (const line of out.split('\n').slice(1)) {
        const q = line.split('\t');
        if (q.length < 12 || q[0] !== '5' || !q[11].trim()) continue;
        words.push({ t: q[11].trim(), l: box.x + Number(q[6]) / s, top: box.y + Number(q[7]) / s, w: Number(q[8]) / s, h: Number(q[9]) / s, conf: Number(q[10]) });
      }
      resolve(words);
    });
  });
}

// --------------------------------------------------------- reading the pop-up
const norm = t => String(t).toLowerCase().replace(/[^a-z0-9]/g, '');
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const like = (w, target) => { const n = norm(w.t); return n === target || (target.length >= 6 && lev(n, target) <= 1); };
// Every two-word label ("Membership" "No"), with the box around both and
// how good a match the first word is (0 = best).
function findLabels(words, firsts, seconds) {
  const out = [];
  for (const a of words) {
    const rank = firsts.findIndex(f => like(a, f));
    if (rank === -1) continue;
    for (const b of words) {
      if (b === a || !seconds.some(s => like(b, s))) continue;
      if (Math.abs(b.top - a.top) < 0.6 * a.h && b.l > a.l && b.l - (a.l + a.w) < 2.5 * a.h) {
        const l = a.l, r = Math.max(a.l + a.w, b.l + b.w), top = Math.min(a.top, b.top), bot = Math.max(a.top + a.h, b.top + b.h);
        out.push({ l, top, w: r - l, h: bot - top, rank });
        break;
      }
    }
  }
  return out.sort((x, y) => x.rank - y.rank);
}
// The value under a label (Ashbourne's layout), or else just to its right.
function valueOf(words, lab) {
  if (!lab) return null;
  const cx = lab.l + lab.w / 2, reach = Math.max(lab.w * 0.75, 3 * lab.h);
  const below = words.filter(w => w.top > lab.top + lab.h * 0.6 && w.top < lab.top + lab.h * 3.2 && Math.abs((w.l + w.w / 2) - cx) < reach);
  const pick = list => {
    if (!list.length) return null;
    const first = Math.min(...list.map(w => w.top));
    const line = list.filter(w => w.top - first < lab.h * 0.6).sort((a, b) => a.l - b.l);
    return { text: line.map(w => w.t).join(' '), conf: Math.min(...line.map(w => w.conf)) };
  };
  const v = pick(below);
  if (v) return v;
  return pick(words.filter(w => Math.abs(w.top - lab.top) < lab.h * 0.6 && w.l > lab.l + lab.w && w.l < lab.l + lab.w + 4 * lab.w));
}
// OCR look-alikes inside a number: O->0, I/l->1, S->5, B->8, Z->2.
function digits(text) {
  const s = String(text || '').replace(/\s+/g, '');
  const fixed = s.replace(/[Oo]/g, '0').replace(/[Il|i]/g, '1').replace(/[Ss]/g, '5').replace(/B/g, '8').replace(/Z/g, '2');
  return /^\d{2,12}$/.test(fixed) && (fixed.length - s.replace(/[^0-9]/g, '').length) <= 1 ? fixed : null;
}
function zoneOf(text) {
  const m = /zone\s*([0-9Il|oO]{1,3})\b/i.exec(String(text || ''));
  if (!m) return null;
  const n = m[1].replace(/[oO]/g, '0').replace(/[Il|]/g, '1');
  return /^\d+$/.test(n) ? 'Zone ' + Number(n) : null;
}
const LABELS = {
  member: [['membership', 'member', 'mem'], ['no', 'number', 'num']],
  message: [['entry'], ['message', 'msg']],
  time: [['entry'], ['time', 'date']],
};
// The pop-up, not the Visit Log grid: its "Entry Message"/"Entry Time"
// labels sit on a LOWER row than "Membership No" (a grid's headers are all
// on one line), close by.
function readFields(words) {
  const ms = findLabels(words, ...LABELS.member), es = findLabels(words, ...LABELS.message), ts = findLabels(words, ...LABELS.time);
  const near = (m, list) => list.filter(x => x.top > m.top + 1.5 * m.h && x.top < m.top + 30 * m.h && Math.abs(x.l - m.l) < 40 * m.h)
    .sort((x, y) => Math.hypot(x.l - m.l, x.top - m.top) - Math.hypot(y.l - m.l, y.top - m.top))[0] || null;
  // A list's header row ("Mem No  Name  Status  Entry Date  Zone") is never the pop-up.
  // (Only words joined to the label on its own line count: a list row next to the pop-up doesn't.)
  let segs = null;
  const header = m => { segs = segs || lineSegments(words); const sg = segs.find(x => x.some(w => Math.abs(w.top - m.top) < 0.6 * m.h && Math.abs(w.l - m.l) < 2)) || []; return sg.some(w => ['zone', 'name', 'status', 'admission'].includes(norm(w.t))); };
  let mLab = null, eLab = null, tLab = null;
  for (const m of ms) { if (header(m)) continue; const e = near(m, es), t = near(m, ts); if (e || t) { mLab = m; eLab = e; tLab = t; break; } }
  if (!mLab) return { found: false, labels: {}, member: null, zone: null, time: '' };
  const mv = valueOf(words, mLab), ev = valueOf(words, eLab), tv = valueOf(words, tLab);
  let zone = ev && zoneOf(ev.text);
  if (!zone) {   // "Zone 1" shown elsewhere in the pop-up
    const inPop = words.filter(w => w.top > mLab.top && w.top < mLab.top + 30 * mLab.h && Math.abs(w.l - mLab.l) < 40 * mLab.h);
    for (let i = 0; i < inPop.length && !zone; i++) if (norm(inPop[i].t) === 'zone' || /^zone\d/i.test(norm(inPop[i].t))) zone = zoneOf(inPop[i].t + ' ' + ((inPop[i + 1] || {}).t || ''));
  }
  return { found: true, labels: { mLab, eLab, tLab }, member: mv ? digits(mv.text) : null, zone, time: tv ? tv.text.replace(/\s+/g, ' ').trim() : '' };
}

// Where the pop-up is: the box around its labels (plus room for values).
function popupBox(f) {
  if (!f.labels.mLab) return null;
  const m = f.labels.mLab, labs = [m, f.labels.eLab, f.labels.tLab].filter(Boolean);
  const h = m.h, left = Math.min(...labs.map(l => l.l)) - 14 * h, right = Math.max(...labs.map(l => l.l + l.w)) + 14 * h;
  const top = Math.min(...labs.map(l => l.top)) - 3 * h, bottom = Math.max(...labs.map(l => l.top + l.h)) + 5 * h;
  return clampBox(left, top, right, bottom);
}
function clampBox(left, top, right, bottom) {
  const x = Math.max(0, Math.floor(left)), y = Math.max(0, Math.floor(top));
  return { x, y, w: Math.max(8, Math.min(W, Math.ceil(right)) - x), h: Math.max(8, Math.min(H, Math.ceil(bottom)) - y) };
}

// ---- the Visit Log list: a second source, and a check on the pop-up ----
// A row = a line that starts with a number (Mem No) and has a date-time and
// a zone ("2371  Worth Matteson  Live  10/13/2026 2:35 PM  1  Zone 1").
// Found by that pattern, not by its headers, so column names don't matter.
const ROW_DT = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2})[:.](\d{2})\s*([AaPp][Mm])?/;
function lineSegments(words) {
  const sorted = words.slice().sort((a, b) => a.top - b.top);
  const lines = [];
  for (const w of sorted) {
    const ln = lines.find(L => Math.abs(L.top - w.top) < 0.5 * Math.max(L.h, w.h));
    if (ln) { ln.ws.push(w); ln.h = Math.max(ln.h, w.h); } else lines.push({ top: w.top, h: w.h, ws: [w] });
  }
  const segs = [];
  for (const L of lines) {                       // split where there's a big gap (another window)
    const ws = L.ws.sort((a, b) => a.l - b.l);
    let cur = [ws[0]];
    for (let i = 1; i < ws.length; i++) {
      if (ws[i].l - (ws[i - 1].l + ws[i - 1].w) > 6 * L.h) { segs.push(cur); cur = []; }
      cur.push(ws[i]);
    }
    segs.push(cur);
  }
  return segs;
}
function readGridRows(words) {
  // Whole lines here (a list's columns can be far apart).
  const lines = [];
  for (const w of words.slice().sort((a, b) => a.top - b.top)) {
    const ln = lines.find(L => Math.abs(L.top - w.top) < 0.5 * Math.max(L.h, w.h));
    if (ln) { ln.ws.push(w); ln.h = Math.max(ln.h, w.h); } else lines.push({ top: w.top, h: w.h, ws: [w] });
  }
  const rows = [];
  for (const L of lines) {
    const ws = L.ws.sort((a, b) => a.l - b.l);
    const di = ws.findIndex(w => /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(w.t));
    if (di < 1) continue;
    const dm = ROW_DT.exec(ws.slice(di, di + 3).map(w => w.t).join(' '));
    if (!dm) continue;
    let zone = null;                               // the zone nearest after the date
    for (let i = di + 1; i < ws.length && !zone; i++) if (/^zone/i.test(norm(ws[i].t))) zone = zoneOf(ws[i].t + ' ' + ((ws[i + 1] || {}).t || ''));
    const mw = ws.slice(0, di).find(w => digits(w.t));   // Mem No: the first number, left of the date
    if (!zone || !mw) continue;
    const member = digits(mw.t);
    let hr = Number(dm[4]) % 12; if (/p/i.test(dm[6] || '')) hr += 12; if (!dm[6] && Number(dm[4]) >= 12) hr = Number(dm[4]);
    const minute = Date.UTC(Number(dm[3]), Number(dm[1]) - 1, Number(dm[2]), hr, Number(dm[5]));
    const h = L.h, row = ws.filter(w => w.l >= mw.l);
    rows.push({ member, zone, minute, key: `${member}|${minute}|${norm(zone)}`, l: mw.l, top: Math.min(...row.map(w => w.top)), bottom: Math.max(...row.map(w => w.top + w.h)), right: Math.max(...row.map(w => w.l + w.w)), h });
  }
  // The list: at least 2 rows whose first column lines up.
  const best = [];
  for (const r of rows) { const same = rows.filter(x => Math.abs(x.l - r.l) < 2 * r.h); if (same.length > best.length) best.splice(0, best.length, ...same); }
  return best.length >= 2 ? best.sort((a, b) => a.top - b.top) : [];
}
function gridBox(rows) {
  if (rows.length < 2) return null;
  // Newest at the top (usual): watch the top 10 rows only.
  const newestFirst = rows[0].minute >= rows[rows.length - 1].minute;
  const use = newestFirst ? rows.slice(0, 10) : rows.slice(-10);
  const h = use[0].h, rowH = use.length > 1 ? (use[use.length - 1].top - use[0].top) / (use.length - 1) : 2 * h;
  return Object.assign(clampBox(Math.min(...use.map(r => r.l)) - 2 * h, Math.min(...use.map(r => r.top)) - (newestFirst ? 1.2 * rowH : 0.5 * rowH),
    Math.max(...use.map(r => r.right)) + 2 * h, Math.max(...use.map(r => r.bottom)) + (newestFirst ? 0.5 * rowH : 1.2 * rowH)), { newestFirst });
}
// Rows read at two sizes; only rows both reads agree on count.
async function readGrid(frame, box) {
  const [wa, wb] = await Promise.all([ocr(frame, box, 2.5), ocr(frame, box, 2)]);
  const a = readGridRows(wa), b = new Set(readGridRows(wb).map(r => r.key));
  return a.filter(r => b.has(r.key));
}

// Find the pop-up and the Visit Log list on the screen (one full read).
// near: where the pop-up was last time; that area (made bigger) is tried
// first, so a pop-up nudged or briefly covered is found again quickly.
async function locate(frame, near) {
  if (near) {
    const x = Math.max(0, near.x - near.w), y = Math.max(0, near.y - near.h);
    const area = { x, y, w: Math.min(W, near.x + 2 * near.w) - x, h: Math.min(H, near.y + 2 * near.h) - y };
    const f = readFields(await ocr(frame, area, 2));
    if (f.labels.mLab) return { pop: popupBox(f), grid: null, partial: true };
  }
  const words = await ocr(frame, { x: 0, y: 0, w: W, h: H }, 2);
  return { pop: popupBox(readFields(words)), grid: gridBox(readGridRows(words)) };
}
// The pop-up read twice at two sizes; both must agree (accuracy first).
async function readPopup(frame, box) {
  const [wa, wb] = await Promise.all([ocr(frame, box, 3), ocr(frame, box, 2.5)]);
  const a = readFields(wa), b = readFields(wb);
  if (!a.found && !b.found) return { found: false };
  if (a.member && b.member && a.member === b.member && (a.zone || '') === (b.zone || '')) return { found: true, ok: true, member: a.member, zone: a.zone || b.zone, time: a.time || b.time };
  return { found: true, ok: false, why: !a.member && !b.member ? 'no number could be read under "Membership No"' : a.member !== b.member ? 'the two reads of the number did not match' : 'the zone did not read the same twice' };
}

// Small picture of the pop-up area, to notice changes cheaply.
function signature(frame, box) {
  const gx = 48, gy = 24, out = new Float32Array(gx * gy);
  for (let j = 0; j < gy; j++) for (let i = 0; i < gx; i++) {
    const x0 = box.x + Math.floor(i * box.w / gx), y0 = box.y + Math.floor(j * box.h / gy);
    let s = 0, n = 0;
    for (let y = y0; y < y0 + Math.max(1, Math.floor(box.h / gy)); y += 2) for (let x = x0; x < x0 + Math.max(1, Math.floor(box.w / gx)); x += 2) { s += frame[y * W + x]; n++; }
    out[j * gx + i] = n ? s / n : 0;
  }
  return out;
}
const sigDiff = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
function brightness(frame) { let s = 0, s2 = 0, n = 0; for (let i = 0; i < frame.length; i += 97) { s += frame[i]; s2 += frame[i] * frame[i]; n++; } const m = s / n; return { mean: m, sd: Math.sqrt(Math.max(0, s2 / n - m * m)) }; }

// ------------------------------------------------------------- the picture
// Linux: the first USB capture device. Mac: avfoundation device by name.
// (alt: some sticks don't offer MJPEG at 1080p: try again with their default.)
function captureArgs(source, alt) {
  if (source && source.startsWith('file:')) return { args: (arg('fast') ? [] : ['-re']).concat(['-i', source.slice(5)]), file: true };
  if (process.platform === 'darwin') return { args: ['-f', 'avfoundation', '-framerate', '30', '-video_size', '1920x1080', '-i', (source || process.env.SECURITYAI_CAPTURE || '0') + ':none'] };
  const dev = source || process.env.SECURITYAI_CAPTURE || findV4l2();
  return { args: ['-f', 'v4l2'].concat(alt ? [] : ['-input_format', 'mjpeg', '-video_size', '1920x1080', '-framerate', '10'], ['-i', dev]), dev };
}
function findV4l2() {
  // A capture stick shows as /dev/videoN with a name; skip the Pi's own codecs.
  for (const d of fs.existsSync('/sys/class/video4linux') ? fs.readdirSync('/sys/class/video4linux').sort() : []) {
    let name = ''; try { name = fs.readFileSync(`/sys/class/video4linux/${d}/name`, 'utf8').trim(); } catch (e) { continue; }
    if (/bcm2835|rpi|hevc|codec|isp|unicam|pispbe|rp1/i.test(name)) continue;
    let idx = '0'; try { idx = fs.readFileSync(`/sys/class/video4linux/${d}/index`, 'utf8').trim(); } catch (e) { /* assume 0 */ }
    if (idx === '0') return '/dev/' + d;
  }
  return '/dev/video0';
}
// Frames (gray, 1920x1080) to onFrame(buf, ms). Restarts ffmpeg if it stops.
function startFrames(source, onFrame, onEnd, alt) {
  const c = captureArgs(source, alt);
  let args = ['-hide_banner', '-loglevel', 'error'].concat(c.args, ['-vf', `fps=${FPS},scale=${W}:${H},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1']);
  const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  // Chunks are gathered and joined once per frame (no re-copying per chunk).
  const FRAME = W * H;
  let parts = [], have = 0, n = 0, err = '';
  const t0 = Date.now();
  p.stdout.on('data', d => {
    parts.push(d); have += d.length;
    while (have >= FRAME) {
      const all = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
      const f = Buffer.from(all.subarray(0, FRAME));
      const rest = all.subarray(FRAME);
      parts = rest.length ? [rest] : []; have = rest.length;
      onFrame(f, c.file && arg('fast') ? t0 + (n * 1000) / FPS : Date.now()); n++;
    }
  });
  p.stderr.on('data', d => { err = (err + d).slice(-400); });
  p.on('close', code => onEnd(code, err.trim()));
  return p;
}

// ------------------------------------------------------------------ setup
async function setup() {
  const pc = require('./pairing-client');
  const say = m => console.log(m);
  say('Screen reader setup (member numbers from the front-desk screen)\n');
  if (!FFMPEG) { say('ffmpeg is missing. On the Pi:  sudo apt install -y ffmpeg'); process.exit(1); }
  if (!TESS) { say('tesseract is missing. On the Pi:  sudo apt install -y tesseract-ocr'); process.exit(1); }
  const core = new ReaderCore({ dir: stateDir(), name: 'screen-reader', version: VERSION, log: () => {} });
  const old = core.cfg || {};
  const site0 = old.site || (() => { try { return JSON.parse(fs.readFileSync(path.join(stateDir(), 'rtsp-zones.json'), 'utf8')).serverUrl; } catch (e) { return ''; } })() || 'https://gym-security.onrender.com';
  const siteIn = arg('site') || await pc.simpleAsk('  Website address', site0.replace(/^https:\/\//, ''));
  const n = pc.normaliseSite(siteIn); if (n.error) { say('  ' + n.error); process.exit(1); }
  const chk = await pc.checkSite(n.url, say); if (!chk.ok) { say('  ' + chk.msg); process.exit(1); }
  say('  On your phone: admin page > Protected member numbers > J Street > "Reader: new code".');
  let got = null;
  for (let i = 0; i < 3 && !got; i++) {
    const code = (i === 0 && arg('code')) || await pc.simpleAsk('  Reader code (6 numbers)', '');
    const r = await pc.exchangeCode(n.url, code);
    if (r.ok && r.readerToken) got = r;
    else say('  ' + (r.ok ? 'That code is for a camera computer. Make a "Reader: new code" code on the admin page.' : r.msg));
    if (arg('code')) break;
  }
  if (!got) { say('  Not paired. Make a new reader code on the admin page and run this again.'); process.exit(1); }
  core.cfg = { site: n.url, token: got.readerToken, gym: got.gymCode, gymName: got.gymName || null, owner: null, zone: 'Zone 1', salt: crypto.randomBytes(32).toString('base64url'), revoked: [], setupAt: new Date().toISOString() };
  let t;
  try { t = await core.api('GET', '/reader/trust'); } catch (e) { say('  ' + netWords(e)); process.exit(1); }
  if (!t.owner) { say('  Set up your owner device first (admin page > Protected member numbers), then run this again.'); process.exit(1); }
  const mk = require('./member-keys');
  if (mk.fingerprint(t.owner.sign) !== t.owner.fp) { say('  The owner key did not check out. Stopped.'); process.exit(1); }
  say(`\n  Owner device code (worked out here from its key): ${mk.codeOf(t.owner.fp)}`);
  say('  Check it matches the code on YOUR admin page (Protected member numbers). This stops anyone else approving devices.');
  const ok = arg('yes') ? 'y' : await pc.simpleAsk('  Does it match? (y/n)', '');
  if (!/^y/i.test(ok)) { say('  Stopped. Nothing was saved.'); process.exit(1); }
  core.cfg.owner = { sign: t.owner.sign, fp: t.owner.fp, code: mk.codeOf(t.owner.fp) };
  core.cfg.zone = arg('zone') || await pc.simpleAsk('  Which zone is the front turnstile?', 'Zone 1');
  if (arg('source')) core.cfg.source = arg('source');
  core.save();
  say(`  Saved (${path.join(stateDir(), 'screen-reader.json').replace(os.homedir(), '~')}, readable only by this user).\n`);
  say('  Checking the picture from the capture stick...');
  let r = await checkOnce(core.cfg.source);
  if (!r.ok && /No picture/.test(r.msg)) r = await checkOnce(core.cfg.source, true);
  say(r.ok ? `  ✓ ${r.msg}` : `  ✗ ${r.msg}`);
  say(r.ok ? '\nDone. The background service starts it by itself (node install-service.js if it is not installed yet).' : '\nFix that, then check again with:  node screen-reader.js --check');
  process.exit(r.ok ? 0 : 1);
}
// One look: is there a picture, is the pop-up there, can it be read?
function checkOnce(source, alt) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; try { p.kill('SIGKILL'); } catch (e) { /* gone */ } resolve(r); } };
    let frames = 0;
    let looking = false;
    const p = startFrames(source, async (frame) => {
      if (done || looking || ++frames < 3) return;
      looking = true; p.stdout.pause();
      const b = brightness(frame);
      if (b.mean < 10 && b.sd < 6) return finish({ ok: false, msg: 'The picture is black. Is the PC on, the splitter powered, and Windows set to never turn the screen off (Settings > System > Power > Screen and sleep)?' });
      const found = await locate(frame);
      const rows = found.grid ? await readGrid(frame, found.grid) : [];
      const list = rows.length ? ` Also reading the Visit Log list (${rows.length} rows, newest ${mask(rows[found.grid.newestFirst ? 0 : rows.length - 1].member)}).` : ' (The Visit Log list is not on screen: fine, the pop-up is enough.)';
      if (!found.pop) return finish(rows.length
        ? { ok: true, msg: `The Live Entry pop-up is not on screen, so for now scans are read from the Visit Log list (${rows.length} rows). Best: leave the pop-up open too.` }
        : { ok: false, msg: 'There is a picture, but neither the Live Entry pop-up nor the Visit Log is on it. Open Ashbourne (MVSv4) with the pop-up showing.' });
      const r = await readPopup(frame, found.pop);
      if (!r.ok) return finish({ ok: false, msg: `The pop-up is there but ${r.why}. Send Claude a photo of the front-desk screen (cover the names).` });
      finish({ ok: true, msg: `Read the pop-up: member ${mask(r.member)}, ${r.zone || 'zone not shown'}${r.time ? ', ' + r.time : ''}.${list}` });
    }, (code, err) => finish({ ok: false, msg: 'No picture from the capture stick' + (err ? ` (${err})` : '') + '. Is it plugged into this box, and the HDMI cable into the splitter?' }), alt);
    setTimeout(() => finish({ ok: false, msg: 'No picture from the capture stick within 20 seconds. Check it is plugged in.' }), 20000);
  });
}

// -------------------------------------------------------------------- run
// Two things on the screen are watched:
//   - the Live Entry pop-up: each new member shown = a scan, timed to the second;
//   - the Visit Log list (when it's on screen): each new row = a scan too.
// Both are read only when their part of the screen CHANGES (a cheap check
// on every picture; the reading itself only then). A scan the pop-up missed
// (it was closed or covered) is taken from the list; a scan both saw is
// confirmed. Looking for a closed or covered pop-up happens only when the
// screen changes (plus once every few minutes), never in a constant loop.
const GRACE_MS = 15000;              // a list row waits this long for its pop-up read
async function run() {
  const core = new ReaderCore({ dir: stateDir(), name: 'screen-reader', version: VERSION, log });
  if (!core.cfg || !core.cfg.token || !core.cfg.owner) { console.log('Not set up yet. Type:  node screen-reader.js --setup'); process.exit(1); }
  if (!FFMPEG || !TESS) { log('ffmpeg or tesseract missing'); process.exit(1); }
  const source = arg('source') || core.cfg.source;
  const zoneWanted = norm(core.cfg.zone || '');
  const fast = !!arg('fast');
  Object.assign(core.counts, { fromList: 0, confirmed: 0, conflicts: 0 });
  log(`screen reader ${VERSION} started`);
  const now0 = Date.now();
  const st = {
    pop: { box: null, sig: null, dirtyAt: 0, lastBox: null, gone: now0 },
    grid: { box: null, sig: null, dirtyAt: 0, seen: new Set(), newest: -Infinity, base: false, gone: now0 },
    busy: false, lastLocate: 0, locateSig: null, lastKey: undefined, recent: new Map(),
    cands: [],                        // scans waiting to be compared: { src: 'pop'|'list', member, zone, at }
    delays: [],                       // how much later the list shows a scan than the pop-up (ms)
    lastFrameAt: now0, blackSince: 0, badSince: 0, startedAt: now0,
  };
  const health = () => {
    const now = Date.now();
    if (now - st.lastFrameAt > T_NO_SIGNAL || (st.blackSince && now - st.blackSince > T_NO_SIGNAL)) return { code: 'no-signal', text: 'No picture from the front-desk screen.' };
    if (!st.pop.box && !st.grid.box && now - Math.min(st.pop.gone || now, st.grid.gone || now) > T_HIDDEN) return { code: 'popup-hidden', text: 'Neither the Live Entry pop-up nor the Visit Log is on the front-desk screen.' };
    if (st.badSince && now - st.badSince > T_UNREADABLE) return { code: 'labels-changed', text: 'The Live Entry pop-up is there but the member number cannot be read.' };
    return core.baseHealth();
  };
  const median = a => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  // One scan, from either source. The same member within 5 min is one scan.
  const record = (member, zone, at, how, uncertain) => {
    const prev = st.recent.get(member);
    if (prev && Math.abs(at - prev) < DOUBLE_SEC * 1000) { core.counts.doubles++; return false; }
    st.recent.set(member, at);
    for (const [k, v] of st.recent) if (at - v > 2 * DOUBLE_SEC * 1000) st.recent.delete(k);
    core.noteScan(member, core.cfg.zone, at, { uncertain: !!uncertain });
    if (how === 'list') core.counts.fromList++;
    if (arg('print')) console.log(`SCAN ${((at - st.startedAt) / 1000).toFixed(1)}s ${member} ${zone || ''}${how === 'list' ? ' (from the Visit Log)' : ''}${how === 'both' ? ' (confirmed by the Visit Log)' : ''}${uncertain ? ' (UNCERTAIN: the two disagree)' : ''}`);
    return true;
  };
  // Same pop-up content as before? Member and zone must match; the entry
  // time is compared by its digits, and only when both reads have one.
  const sameContent = (a, b) => a.member === b.member && norm(a.zone || '') === norm(b.zone || '') && (!a.t || !b.t || a.t === b.t);
  const acceptPopup = (r, at) => {
    const key = { member: r.member, zone: r.zone, t: String(r.time || '').replace(/\D/g, '') };
    if (st.lastKey === undefined) { st.lastKey = key; log('pop-up found; watching for new scans'); return; }
    if (sameContent(key, st.lastKey)) { if (key.t && !st.lastKey.t) st.lastKey = key; return; }
    st.lastKey = key;
    if (zoneWanted && r.zone && norm(r.zone) !== zoneWanted) { core.counts.otherZone++; return; }   // Iron Street etc. never leave this box
    st.cands.push({ src: 'pop', member: r.member, zone: r.zone, at, list: !!st.grid.box && st.grid.base });
  };
  const acceptRows = (rows, at) => {
    const g = st.grid;
    if (!g.base) { rows.forEach(r => g.seen.add(r.key)); g.newest = Math.max(g.newest, ...rows.map(r => r.minute)); g.base = true; log('Visit Log found; watching it too'); return; }
    for (const r of rows) {
      if (g.seen.has(r.key)) continue;
      g.seen.add(r.key);
      if (r.minute < g.newest - 60000) continue;   // an older row scrolled into view: not new
      g.newest = Math.max(g.newest, r.minute);
      if (zoneWanted && norm(r.zone) !== zoneWanted) { core.counts.otherZone++; continue; }
      st.cands.push({ src: 'list', member: r.member, zone: r.zone, at });
    }
    if (g.seen.size > 600) g.seen = new Set([...g.seen].slice(-300));
  };
  // Every scan waits GRACE_MS so the pop-up and the list can be compared:
  //   both show the same member  -> one scan, confirmed
  //   pop-up only                -> the pop-up's scan (the list may be off screen)
  //   list only                  -> the pop-up missed it (closed/covered): from the list,
  //                                 timed to when the row appeared, less the list's usual lag
  //   they show DIFFERENT members at the same moment -> one scan (the pop-up's number,
  //                                 the larger print) marked uncertain, so the gym page
  //                                 says "likely", never "certain"
  const settle = now => {
    st.cands.sort((a, b) => a.at - b.at);
    const used = new Set();
    for (const c of st.cands) {
      if (c.src !== 'pop' || used.has(c) || now - c.at < GRACE_MS) continue;
      const lists = st.cands.filter(x => x.src === 'list' && !used.has(x) && x.at - c.at > -GRACE_MS && x.at - c.at < 60000);
      const same = lists.find(x => x.member === c.member);
      if (same) { used.add(c); used.add(same); core.counts.confirmed++; st.delays.push(same.at - c.at); if (st.delays.length > 30) st.delays.shift(); record(c.member, c.zone, c.at, 'both'); continue; }
      if (lists.length && now - c.at < GRACE_MS + 45000) continue;   // the list may still show it: wait a bit longer
      const other = lists.find(x => Math.abs(x.at - c.at) < GRACE_MS && !st.cands.some(y => y.src === 'pop' && y !== c && y.member === x.member));
      used.add(c);
      if (other) { used.add(other); core.counts.conflicts = (core.counts.conflicts || 0) + 1; log('the pop-up and the Visit Log showed different numbers for one scan: sent as uncertain'); record(c.member, c.zone, c.at, 'popup', true); continue; }
      record(c.member, c.zone, c.at, 'popup');
    }
    for (const c of st.cands) {
      if (c.src !== 'list' || used.has(c) || now - c.at < GRACE_MS + 45000) continue;
      if (st.cands.some(p => p.src === 'pop' && !used.has(p) && p.member === c.member && Math.abs(p.at - c.at) < 60000)) continue;   // its pop-up read is still waiting
      used.add(c);
      if (record(c.member, c.zone, c.at - Math.max(0, median(st.delays)), 'list')) log('a scan the pop-up did not show was taken from the Visit Log');
    }
    st.cands = st.cands.filter(c => !used.has(c));
  };

  let proc = null, ending = false;
  const todo = [];                              // [{ kind, frame, box, at }]
  const work = async fn => { st.busy = true; if (fast && proc) proc.stdout.pause(); try { await fn(); } catch (e) { log('read error: ' + e.message); } finally { st.busy = false; if (fast && proc) proc.stdout.resume(); pump(); } };
  const pump = () => {
    if (st.busy || !todo.length) return;
    const job = todo.shift();
    work(async () => {
      if (job.kind === 'grid') {
        const rows = await readGrid(job.frame, job.box);
        if (!rows.length) { st.grid.box = null; st.grid.gone = job.at; st.lastLocate = 0; return; }   // covered or closed
        acceptRows(rows, job.at);
        return;
      }
      const r = await readPopup(job.frame, job.box);
      if (!r.found) { st.pop.box = null; st.pop.gone = job.at; st.lastLocate = 0; return; }   // moved, covered or closed: look again
      if (!r.ok) { if (!st.badSince) st.badSince = job.at; return; }
      st.badSince = 0;
      acceptPopup(r, job.at);                   // the moment it changed, not when the read finished
    });
  };
  // Watch one part of the screen: queue a read once a change has settled.
  const watch = (part, kind, frame, at) => {
    const sig = signature(frame, part.box);
    const d = part.sig ? sigDiff(sig, part.sig) : 0; part.sig = sig;
    if (d > 18) { if (!part.dirtyAt) part.dirtyAt = at; return; }
    if (!part.dirtyAt) return;
    if (todo.length < 40) todo.push({ kind, frame, box: part.box, at: part.dirtyAt });
    part.dirtyAt = 0;
    pump();
  };
  const onFrame = (frame, at) => {
    st.lastFrameAt = Date.now(); st.lastVirtual = at;
    const b = brightness(frame);
    if (b.mean < 10 && b.sd < 6) {               // black: start fresh when it's back, and look straight away
      if (!st.blackSince) st.blackSince = at;
      st.pop.box = null; st.grid.box = null; st.grid.base = false; st.lastKey = undefined; st.lastLocate = 0; st.locateSig = null; todo.length = 0;
      return;
    }
    st.blackSince = 0;
    if (st.pop.box) watch(st.pop, 'pop', frame, at);
    if (st.grid.box) watch(st.grid, 'grid', frame, at);
    if (st.pop.box && st.grid.box) return;
    // Something missing: look for it only when the screen has changed since
    // the last look (or every few minutes), not in a constant loop.
    if (st.busy || todo.length) return;
    const whole = signature(frame, { x: 0, y: 0, w: W, h: H });
    const changed = !st.locateSig || sigDiff(whole, st.locateSig) > 18;
    const minGap = fast ? 0 : LOCATE_EVERY_MS, maxGap = fast ? 0 : 5 * 60e3;
    if (st.lastLocate && (at - st.lastLocate < minGap || (!changed && at - st.lastLocate < maxGap))) return;
    st.lastLocate = at; st.locateSig = whole;
    work(async () => {
      const f = await locate(frame, st.pop.box ? null : st.pop.lastBox);
      if (f.pop && !st.pop.box) {
        if (st.lastKey !== undefined && at - st.pop.gone > 30000) st.lastKey = undefined;   // gone a while: what it shows now may be old
        Object.assign(st.pop, { box: f.pop, lastBox: f.pop, sig: signature(frame, f.pop), gone: 0 });
        const r = await readPopup(frame, f.pop);
        if (r.ok) { acceptPopup(r, at); st.badSince = 0; } else if (r.found && !st.badSince) st.badSince = at;
      } else if (!f.pop && !st.pop.box && !st.pop.gone) st.pop.gone = at;
      if (f.grid && !st.grid.box) {
        if (st.grid.base && at - st.grid.gone > 10 * 60e3) st.grid.base = false;   // gone a long time: start fresh
        Object.assign(st.grid, { box: f.grid, sig: signature(frame, f.grid), gone: 0 });
        const rows = await readGrid(frame, f.grid);
        if (rows.length) acceptRows(rows, at);
      } else if (!f.grid && !f.partial && !st.grid.box && !st.grid.gone) st.grid.gone = at;
    });
  };
  let attempt = 0;
  const go = () => { proc = startFrames(source, onFrame, (code, err) => {
    attempt++;
    if (source && source.startsWith('file:')) { ending = true; return; }
    log('capture stopped' + (err ? ': ' + err : '') + '; retrying in 10 s');
    setTimeout(go, 10000);
  }, attempt % 2 === 1); };
  go();
  // Website: trust every minute, send every 5 s, status every 5 min or on change.
  let lastStatus = 0, lastCode = 'start', lastTrust = 0;
  const setupAt = core.cfg.setupAt;
  let ticking = false;
  const tick = async () => {
    if (ticking) return;                        // a slow network: don't pile up
    ticking = true;
    try { await tick2(); } finally { ticking = false; }
  };
  const tick2 = async () => {
    const now = Date.now();
    // Set up again (new pairing/owner): stop; the background service starts it fresh.
    try { const c = JSON.parse(fs.readFileSync(core.cfgFile, 'utf8')); if (c.setupAt !== setupAt && !String(source || '').startsWith('file:')) { log('set up again: restarting'); process.exit(0); } } catch (e) { /* keep going */ }
    settle(fast ? (st.lastVirtual || now) : now);
    try { if (now - lastTrust > 60e3) { lastTrust = now; await core.refreshTrust(); } } catch (e) { log('trust check failed: ' + netWords(e)); }
    const h = health();
    try { await core.flush(h && h.text); } catch (e) { log('send failed, will retry: ' + netWords(e)); }
    if (now - lastStatus > 5 * 60e3 || String(h && h.code) !== String(lastCode)) {
      try { await core.status(h); lastStatus = now; lastCode = h && h.code; if (h) log('problem: ' + h.code); } catch (e) { /* next time */ }
    }
  };
  const timer = setInterval(() => { tick(); if (ending && !st.busy && !todo.length) { clearInterval(timer); setTimeout(() => { settle(Infinity); tick2().then(() => process.exit(0)); }, 300); } }, fast ? 500 : 5000);
  tick();
}

if (require.main === module) {
  if (arg('setup')) setup().catch(e => { console.log('Something went wrong: ' + e.message); process.exit(1); });
  else if (arg('check')) { const core = new ReaderCore({ dir: stateDir(), name: 'screen-reader', version: VERSION }); const src = arg('source') || (core.cfg && core.cfg.source); checkOnce(src).then(r => (!r.ok && /No picture/.test(r.msg)) ? checkOnce(src, true) : r).then(r => { console.log((r.ok ? '✓ ' : '✗ ') + r.msg); process.exit(r.ok ? 0 : 1); }); }
  else run();
}
module.exports = { readFields, findLabels, digits, zoneOf, locate, readPopup, readGrid, readGridRows, lineSegments, ocr, VERSION };
