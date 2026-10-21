#!/usr/bin/env node
// Screen reader: member numbers from the front-desk screen, with nothing
// installed on the front-desk PC.
//
// A powered HDMI splitter copies the PC's picture to a USB capture stick
// on this box (the Raspberry Pi). This program reads Ashbourne's Live Entry
// pop-up from that picture: Membership No, Entry Message (zone) and Entry
// Time. A new scan = the pop-up showing a new member/time. Any other check-in
// system is taught once (--teach): its pop-up or card, its list of check-ins
// (each new row = a scan, newest at the top or the bottom), or both; member
// numbers, codes with letters, or only names; light or dark screens. The number is
// scrambled HERE for your approved devices only (reader-core.js), exactly
// like the Windows reader. Pictures are never saved or sent: each frame is
// read in memory and only the small pop-up area is OCR'd, from a private
// temporary file that is deleted straight away.
//
//   node screen-reader.js --setup     once: pair, check the picture, check the owner code
//   node screen-reader.js --check     what it reads right now (numbers hidden)
//   node screen-reader.js --teach     a gym on another check-in system (not Ashbourne):
//                                     scan in once and it learns where that system shows
//                                     the member number (saved in screen-profile.json)
//   node screen-reader.js --forget    back to Ashbourne (deletes the taught profile)
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

const VERSION = 'screen-1.1.0';
const W = 1920, H = 1080;                     // every frame is scaled to this
const FPS = Number(process.env.SECURITYAI_SCREEN_FPS || 3);
const DOUBLE_SEC = 300;                       // same member within 5 min = one scan (the lockout is 10 min; a re-read or a double scan)
const LOCATE_EVERY_MS = 20000;                // look for a moved/hidden pop-up this often
const TF = process.env.SECURITYAI_TEST_FAST ? 1 / 24 : 1;  // tests: 5 s instead of 2 min
const T_NO_SIGNAL = 2 * 60e3 * TF, T_HIDDEN = 5 * 60e3 * TF, T_UNREADABLE = 2 * 60e3 * TF;

const arg = n => { const i = process.argv.indexOf('--' + n); return i === -1 ? undefined : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const stateDir = () => process.env.SECURITYAI_HOME || path.join(os.homedir(), '.securityai');
// OCR's small temporary pictures go in memory (/dev/shm) when the computer
// has it: faster, and no wear on a Pi's memory card. Private to this user.
const tmpDir = () => {
  let d = path.join(stateDir(), 'tmp');
  try {
    if (process.platform === 'linux' && process.getuid && fs.statSync('/dev/shm').isDirectory()) {
      const m = path.join('/dev/shm', 'securityai-' + process.getuid());
      fs.mkdirSync(m, { recursive: true, mode: 0o700 });
      const st = fs.lstatSync(m);
      // Only if it is really ours and private (someone else could have made it first).
      if (st.isDirectory() && st.uid === process.getuid() && (st.mode & 0o077) === 0) d = m;
    }
  } catch (e) { /* use the settings folder */ }
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const logFile = () => path.join(stateDir(), 'screen-reader.log');
function log(m) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)}  ${m}`;
  if (!process.env.SECURITYAI_SERVICE) console.log(line);
  try { fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 }); fs.appendFileSync(logFile(), line + '\n'); const st = fs.statSync(logFile()); if (st.size > 2e6) fs.renameSync(logFile(), logFile() + '.old'); } catch (e) { /* ignore */ }
}
const mask = m => String(m).replace(/.(?=..)/g, '•');            // "4810" -> "••10"
const maskId = m => (m === '?' ? '(unreadable)' : /^\d+$/.test(m) ? mask(m) : String(m).charAt(0).toUpperCase() + '…');   // a name: "A…"

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
function ocr(frame, box, s, opts) {
  const c = cropScale(frame, box.x, box.y, box.w, box.h, s);
  // A dark check-in screen (light text on dark): flipped, so the text reads dark on light.
  // (Taught screens only: Ashbourne reads exactly as before.)
  if (!PROFILE.needNear || TEACHING) { let m = 0; for (let i = 0; i < c.buf.length; i += 7) m += c.buf[i]; if (m / Math.ceil(c.buf.length / 7) < 100) for (let i = 0; i < c.buf.length; i++) c.buf[i] = 255 - c.buf[i]; }
  const f = path.join(tmpDir(), crypto.randomBytes(6).toString('hex') + '.pgm');
  fs.writeFileSync(f, Buffer.concat([Buffer.from(`P5\n${c.w} ${c.h}\n255\n`), c.buf]), { mode: 0o600 });
  return new Promise((resolve, reject) => {
    // One thread each (much faster for small pictures; two run side by side).
    // Low priority ("nice"): the camera's own work always comes first on the Pi.
    // psm 11: scattered words (a screen). psm 7 + digits only: one number, read on its own.
    const targs = [f, 'stdout', '--psm', (opts && opts.psm) || '11', '-l', 'eng'].concat(opts && opts.digits ? ['-c', 'tessedit_char_whitelist=0123456789'] : [], ['tsv']);
    const cmd = NICE ? [NICE, ['-n', '10', TESS].concat(targs)] : [TESS, targs];
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
    if (!seconds || !seconds.length) { out.push({ l: a.l, top: a.top, w: a.w, h: a.h, rank }); continue; }   // a one-word label ("Barcode:")
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
function valueOf(words, lab, layout) {
  if (!lab) return null;
  const cx = lab.l + lab.w / 2, reach = Math.max(lab.w * 0.75, 3 * lab.h);
  const below = words.filter(w => w.top > lab.top + lab.h * 0.6 && w.top < lab.top + lab.h * 3.2 && Math.abs((w.l + w.w / 2) - cx) < reach);
  const pick = list => {
    if (!list.length) return null;
    const first = Math.min(...list.map(w => w.top));
    const line = list.filter(w => w.top - first < lab.h * 0.6).sort((a, b) => a.l - b.l);
    // A value longer than its label ("10/19/2026 8:21 PM" under "Entry Time"): the
    // words right after it on its line, with only a space between, belong to it too.
    for (let end = line[line.length - 1], more = true; more;) {
      more = false;
      const nx = words.filter(w => !line.includes(w) && Math.abs(w.top - end.top) < lab.h * 0.6 && w.l > end.l && w.l - (end.l + end.w) < 1.1 * lab.h).sort((a, b) => a.l - b.l)[0];
      if (nx) { line.push(nx); end = nx; more = true; }
    }
    const l = Math.min(...line.map(w => w.l)), top = Math.min(...line.map(w => w.top));
    return { text: line.map(w => w.t).join(' '), conf: Math.min(...line.map(w => w.conf)), box: { l, top, w: Math.max(...line.map(w => w.l + w.w)) - l, h: Math.max(...line.map(w => w.top + w.h)) - top } };
  };
  const right = () => pick(words.filter(w => Math.abs(w.top - lab.top) < lab.h * 0.6 && w.l > lab.l + lab.w && w.l < lab.l + lab.w + Math.max(4 * lab.w, 12 * lab.h)));
  if (layout === 'right') return right();
  const v = pick(below);
  if (v || layout === 'below') return v;
  return right();
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
  admission: [['admission', 'access', 'status'], ['message', 'msg', 'note']],
  member: [['membership', 'member', 'mem'], ['no', 'number', 'num']],
  message: [['entry'], ['message', 'msg']],
  time: [['entry'], ['time', 'date']],
};
// What the reader looks for on the screen. Ashbourne by default; a gym on
// another check-in system gets a profile taught on install day (--teach):
// the label next to the member number and where the number sits (right of
// it or under it). Checked the same way: read twice, both must agree.
const ASHBOURNE = { name: 'Ashbourne', what: 'the Live Entry pop-up', member: LABELS.member, message: LABELS.message, time: LABELS.time, needNear: true, gridNeedsZone: true, layout: 'auto', labelText: 'Membership No' };
const profileFile = () => path.join(stateDir(), 'screen-profile.json');
const pauseFile = () => path.join(stateDir(), 'screen-pause');     // --teach needs the capture stick for a minute
const pausedNow = () => { try { return Date.now() - fs.statSync(pauseFile()).mtimeMs < 5 * 60e3; } catch (e) { return false; } };
const mtimeOf = f => { try { return fs.statSync(f).mtimeMs; } catch (e) { return 0; } };
// A taught profile has a PANEL (a pop-up or card: the value next to or under
// a label), a LIST (a scan log: each new row = a scan, newest at the top or
// the bottom), or both. The value is the member number, or the member's
// name on systems that only show a name. Only labels, column headers and
// positions are saved: never a number, a name or a picture.
const cleanShape = x => (x && typeof x === 'object' && li4(x.pre) && li4(x.post) ? { pre: Number(x.pre), post: Number(x.post) } : null);
const li4 = v => Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 4;
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const words = a => (Array.isArray(a) ? a : []).map(x => norm(x)).filter(Boolean).slice(0, 4);
  const kindOf = k => (k === 'name' ? 'name' : 'number');
  const num = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  // Older profiles: { member, layout, labelText } = a number panel.
  const pa = p.panel || (Array.isArray(p.member) ? { kind: 'number', member: p.member, layout: p.layout, labelText: p.labelText } : null);
  let panel = null, list = null;
  if (pa && Array.isArray(pa.member) && Array.isArray(pa.member[0]) && words(pa.member[0]).length) {
    panel = { kind: kindOf(pa.kind), shape: cleanShape(pa.shape), zone: zoneOf(pa.zone || '') || null,
      pos: pa.pos && typeof pa.pos === 'object' ? { x: num(pa.pos.x, 0, 1, 0.5), y: num(pa.pos.y, 0, 1, 0.5) } : null, member: [words(pa.member[0]), words(pa.member[1])], layout: ['right', 'below'].includes(pa.layout) ? pa.layout : 'auto', labelText: String(pa.labelText || pa.member[0].join(' ')).slice(0, 40) };
  }
  const li = p.list;
  if (li && typeof li === 'object' && li.pos && typeof li.pos === 'object') {
    list = { kind: kindOf(li.kind), shape: cleanShape(li.shape), zone: zoneOf(li.zone || '') || null, header: words(li.header).length ? words(li.header) : null, headerText: li.headerText ? String(li.headerText).slice(0, 40) : null,
      newest: li.newest === 'bottom' ? 'bottom' : 'top', pos: { x: num(li.pos.x, 0, 1, 0.5), y: num(li.pos.y, 0, 1, 0.5), h: num(li.pos.h, 0.004, 0.2, 0.02) },
      cols: words(li.cols).length ? (Array.isArray(li.cols) ? li.cols : []).map(x => norm(x)).filter(x => /^[a-z]{2,}$/.test(x)).slice(0, 8) : null,
      len: li.kind === 'name' ? null : num(li.len, 3, 12, 6), timed: li.timed === true, tzOffMin: Math.round(num(li.tzOffMin, -14 * 60, 14 * 60, 0)) };
  }
  if (!panel && !list) return null;
  const what = [panel ? `the ${panel.kind === 'name' ? 'name' : 'number'} ${panel.layout === 'below' ? 'under' : 'next to'} "${panel.labelText}"` : null,
    list ? `the list${list.headerText ? ` under "${list.headerText}"` : ''} (newest ${list.newest === 'top' ? 'at the top' : 'at the bottom'})` : null].filter(Boolean).join(' and ');
  return { name: String(p.name || 'taught').slice(0, 40), what, panel, list,
    member: panel ? panel.member : null, kind: panel ? panel.kind : list.kind, message: null, time: null, needNear: false, gridNeedsZone: false,
    layout: panel ? panel.layout : 'auto', labelText: panel ? panel.labelText : (list.headerText || 'the check-in list'), taughtAt: p.taughtAt || null };
}
// What gets saved (the clean form, without the worked-out fields).
const profileToSave = P => ({ name: P.name, taughtAt: P.taughtAt, panel: P.panel, list: P.list });
function loadProfile() {
  try { return cleanProfile(JSON.parse(fs.readFileSync(profileFile(), 'utf8'))) || ASHBOURNE; } catch (e) { return ASHBOURNE; }
}
let PROFILE = ASHBOURNE, TEACHING = false;   // TEACHING: --teach is looking at a screen that isn't Ashbourne
function useProfile(p) { PROFILE = p || ASHBOURNE; return PROFILE; }
// The pop-up, not the Visit Log grid: its "Entry Message"/"Entry Time"
// labels sit on a LOWER row than "Membership No" (a grid's headers are all
// on one line), close by.
function readFields(words, P) {
  P = P || PROFILE;
  if (!P.needNear) return readTaught(words, P);
  const ms = findLabels(words, ...P.member), es = findLabels(words, ...P.message), ts = findLabels(words, ...P.time);
  const near = (m, list) => list.filter(x => x.top > m.top + 1.5 * m.h && x.top < m.top + 30 * m.h && Math.abs(x.l - m.l) < 40 * m.h)
    .sort((x, y) => Math.hypot(x.l - m.l, x.top - m.top) - Math.hypot(y.l - m.l, y.top - m.top))[0] || null;
  // A list's header row ("Mem No  Name  Status  Entry Date  Zone") is never the pop-up.
  // (Only words joined to the label on its own line count: a list row next to the pop-up doesn't.)
  let segs = null;
  const header = m => { segs = segs || lineSegments(words); const sg = segs.find(x => x.some(w => Math.abs(w.top - m.top) < 0.6 * m.h && Math.abs(w.l - m.l) < 2)) || []; return sg.some(w => ['zone', 'name', 'status', 'admission'].includes(norm(w.t))); };
  let mLab = null, eLab = null, tLab = null;
  for (const m of ms) { if (header(m)) continue; const e = near(m, es), t = near(m, ts); if (e || t) { mLab = m; eLab = e; tLab = t; break; } }
  if (!mLab) return { found: false, labels: {}, member: null, zone: null, time: '' };
  // A value is under its label (Ashbourne today) or beside it (the newer look). What's under
  // it may be the next label ("Entry Date" under "Member Number"): then the value beside it.
  const either = (lab, good) => { const v = valueOf(words, lab); if (!lab || (v && good(v.text))) return v; const r = valueOf(words, lab, 'right'); return r && good(r.text) ? r : v; };
  const labelish = t => /^[A-Za-z ]+$/.test(t) && Object.values(LABELS).some(([a, b]) => { const n = norm(t); return a.some(x => n.includes(x)) && (!b.length || b.some(x => n.includes(x))); });
  const mv = either(mLab, t => !!digits(t)), ev = either(eLab, t => !!zoneOf(t) || !labelish(t)), tv = either(tLab, t => !!rowTime(t.split(/\s+/).filter(Boolean).map(x => ({ t: x }))));
  const aLab = near(mLab, findLabels(words, ...LABELS.admission)), av = either(aLab, t => !labelish(t));   // "Membership Expired" lives here
  let zone = ev && zoneOf(ev.text);
  if (!zone) {   // "Zone 1" shown elsewhere in the pop-up
    const inPop = words.filter(w => w.top > mLab.top && w.top < mLab.top + 30 * mLab.h && Math.abs(w.l - mLab.l) < 40 * mLab.h);
    for (let i = 0; i < inPop.length && !zone; i++) if (norm(inPop[i].t) === 'zone' || /^zone\d/i.test(norm(inPop[i].t))) zone = zoneOf(inPop[i].t + ' ' + ((inPop[i + 1] || {}).t || ''));
  }
  return { found: true, labels: { mLab, eLab, tLab }, member: mv ? digits(mv.text) : null, zone, time: tv ? tv.text.replace(/\s+/g, ' ').trim() : '', message: (ev ? ev.text : '') + ' ' + (av ? av.text : ''), vbox: mv ? mv.box : null };
}

// A taught system: the first label with a member number (or name) next to it.
function readTaught(words, P) {
  if (!P.member) return { found: false, labels: {}, member: null, zone: null, time: '' };   // a list-only screen
  const ms = findLabels(words, P.member[0], P.member[1]);
  if (!ms.length) return { found: false, labels: {}, member: null, zone: null, time: '' };
  const valueId = P.kind === 'name' ? nameId : codeId;
  // Where the pop-up showed the number on install day: the same label somewhere
  // else on the screen (a member's profile left open) is not the pop-up.
  const pos = P.panel && P.panel.pos;
  const dist = m => (pos ? Math.hypot(m.l / W - pos.x, (m.top / H - pos.y) * 1.2) : 0);
  const near = ms.filter(m => dist(m) < 0.3).sort((a, b) => dist(a) - dist(b));
  if (!near.length) return { found: false, labels: {}, member: null, zone: null, time: '' };
  for (const m of near) {
    const v = valueOf(words, m, P.layout);
    const member = v ? valueId(v.text) : null;
    if (member) return { found: true, labels: { mLab: m }, member, zone: null, time: '', layout: P.layout, vbox: v.box };
  }
  return { found: true, labels: { mLab: near[0] }, member: null, zone: null, time: '' };
}
// A member's name as shown ("Alex Rivera"), made comparable: lower case,
// single spaces. Letters only (with ' - .), 2 to 40 characters, at most 4 words.
function nameId(text) {
  // Edge marks the OCR picks up around a name (a comma before it, a "_" or "|" from a border) are not part of it.
  const s = String(text || '').replace(/^[^\p{L}]+|[^\p{L}.]+$/gu, '').replace(/\s+/g, ' ').trim();
  if (!s || /\d/.test(s) || s.length > 40 || s.split(' ').length > 4) return null;
  if (!/^[\p{L}][\p{L}'’.\- ]*$/u.test(s) || (s.match(/\p{L}/gu) || []).length < 2) return null;
  return s.toLowerCase().replace(/’/g, "'");
}

// A member number on a taught screen: plain digits, digits shown masked
// ("****8210": the visible digits), or a code with a few letters ("GX48210").
function codeId(text) {
  const s = String(text || '').replace(/\s+/g, '').replace(/^[*•●·#]+/, '').replace(/[.,;:]+$/, '');
  const d = digits(s);
  if (d) return d;
  if (/^[A-Za-z]{1,4}-?\d{3,12}[A-Za-z]?$/.test(s) || /^\d{3,12}-?[A-Za-z]{1,3}$/.test(s)) return s.toUpperCase();
  return null;
}

// A scan the system turned down ("Denied", "Expired", "Frozen"...) didn't
// let anyone in: counting it would hide the tailgate that often follows it.
const DENIED = /\b(denied|deny|expired|invalid|rejected|declined|suspended|frozen|inactive|unpaid|overdue|past due|not allowed|no access|blocked|refused|cancell?ed|terminated|unknown card|not found)\b/i;

// ---- table cells: the words of a line, split where there's a column gap ----
function cellsOf(words) {
  const lines = [];
  for (const w of words.slice().sort((a, b) => a.top - b.top)) {
    const ln = lines.find(L => Math.abs(L.top - w.top) < 0.5 * Math.max(L.h, w.h));
    if (ln) { ln.ws.push(w); ln.h = Math.max(ln.h, w.h); } else lines.push({ top: w.top, h: w.h, ws: [w] });
  }
  const out = [];
  for (const L of lines) {
    const ws = L.ws.sort((a, b) => a.l - b.l);
    let cur = [ws[0]];
    const push = () => { const l = cur[0].l, top = Math.min(...cur.map(w => w.top)); out.push({ ws: cur, text: cur.map(w => w.t).join(' '), l, top, r: Math.max(...cur.map(w => w.l + w.w)), h: Math.max(...cur.map(w => w.h)), line: L }); };
    for (let i = 1; i < ws.length; i++) {
      if (ws[i].l - (ws[i - 1].l + ws[i - 1].w) > 1.8 * L.h) { push(); cur = []; }
      cur.push(ws[i]);
    }
    push();
  }
  return out;
}
// A clock time in a row ("2:35 PM", "14:35:07"): { h, m, s (or null), ampm }.
function clockIn(text) {
  const m = /(?:^|[^\d:.])(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s*([AaPp])\.?\s*[Mm]\.?)?(?![\d])/.exec(String(text || ''));
  if (!m) return null;
  let h = Number(m[1]); const mi = Number(m[2]), s = m[3] != null ? Number(m[3]) : null;
  if (mi > 59 || (s != null && s > 59) || h > 23) return null;
  if (m[4]) { if (h < 1 || h > 12) return null; h = h % 12 + (/p/i.test(m[4]) ? 12 : 0); }
  return { h, m: mi, s, ampm: !!m[4] };
}
// That clock time as this computer's time (ms): the one nearest `near`,
// after taking off the screen's offset (a PC in another time zone).
function clockMs(c, near, offMin) {
  const off = (offMin || 0) * 60e3, ref = new Date(near + off);
  let best = null;
  const hours = !c.ampm && c.h < 12 ? [c.h, c.h + 12] : [c.h];   // "2:35" with no AM/PM: either
  for (const h of hours) for (const dd of [-1, 0, 1]) {
    const v = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + dd, h, c.m, c.s || 0).getTime() - off;
    if (best === null || Math.abs(v - near) < Math.abs(best - near)) best = v;
  }
  return best;
}

// Where the pop-up is: the box around its labels (plus room for values).
function popupBox(f) {
  if (!f.labels.mLab) return null;
  const m = f.labels.mLab, labs = [m, f.labels.eLab, f.labels.tLab].filter(Boolean);
  const h = m.h, left = Math.min(...labs.map(l => l.l)) - 14 * h, right = Math.max(...labs.map(l => l.l + l.w)) + (PROFILE.needNear ? 14 * h : Math.max(14 * h, 5 * m.w + 12 * h));
  const top = Math.min(...labs.map(l => l.top)) - 3 * h, bottom = Math.max(...labs.map(l => l.top + l.h)) + 5 * h;
  // Values beside their labels (the newer Ashbourne look): long names and messages run further right.
  const beside = PROFILE.needNear && f.vbox && f.vbox.l > m.l + m.w && Math.abs(f.vbox.top - m.top) < m.h ? f.vbox.l + 22 * h : 0;
  return clampBox(left, top, Math.max(right, beside), bottom);
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
// A row's date and time, in the forms a check-in system (or a new version
// of it) shows: 10/13/2026 2:35 PM, 10/13/26 14:35, 2026-10-13 2:35 PM, or
// just 2:35 PM (today). di = where it starts in the row.
function rowTime(ws) {
  const today = new Date();
  for (let i = 0; i < ws.length; i++) {
    const t = ws[i].t;
    let y, mo, d, k = i;
    let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(t);
    if (m) { mo = +m[1]; d = +m[2]; y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; k = i + 1; }
    else if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t))) { y = +m[1]; mo = +m[2]; d = +m[3]; k = i + 1; }
    // "8:21 PM", "8:21PM", "20:21", "8:21:05 pm" (the reader sometimes joins the PM to the time)
    const tm = /^(\d{1,2})[:.](\d{2})(?::\d{2})?([AaPp]\.?[Mm]\.?)?$/.exec((ws[k] || {}).t || '');
    if (!tm || (k === i && !/^\d{1,2}:\d{2}/.test(t))) continue;
    if (k === i) { y = today.getFullYear(); mo = today.getMonth() + 1; d = today.getDate(); }     // a time only: today
    const ap = tm[3] ? [tm[3], tm[3][0]] : /^([AaPp])\.?[Mm]\.?$/.exec((ws[k + 1] || {}).t || '');
    let hr = +tm[1] % 12; if (ap && /p/i.test(ap[1])) hr += 12; if (!ap && +tm[1] >= 12) hr = +tm[1];
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || +tm[2] > 59) continue;
    // No AM/PM read and an hour like "8": it may be 8 PM with the PM missed (not "08" or "20").
    const amb = !ap && +tm[1] >= 1 && +tm[1] <= 11 && !/^0/.test(tm[1]);
    return { di: i, minute: Date.UTC(y, mo - 1, d, hr, +tm[2]), amb };
  }
  return null;
}
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
    const rt = rowTime(ws);
    if (!rt || rt.di < 1) continue;
    const di = rt.di;
    if (DENIED.test(ws.map(w => w.t).join(' '))) continue;      // a turned-down scan (expired, denied...) let nobody in
    let zone = null;                               // the zone nearest after the date
    for (let i = di + 1; i < ws.length && !zone; i++) if (/^zone/i.test(norm(ws[i].t))) zone = zoneOf(ws[i].t + ' ' + ((ws[i + 1] || {}).t || ''));
    const mw = ws.slice(0, di).find(w => digits(w.t));   // Mem No: the first number, left of the date
    if ((!zone && PROFILE.gridNeedsZone) || !mw) continue;
    const member = digits(mw.t);
    const minute = rt.minute, amb = rt.amb;
    const h = L.h, row = ws.filter(w => w.l >= mw.l);
    rows.push({ member, zone, minute, amb, key: `${member}|${minute}|${norm(zone || '')}`, l: mw.l, top: Math.min(...row.map(w => w.top)), bottom: Math.max(...row.map(w => w.top + w.h)), right: Math.max(...row.map(w => w.l + w.w)), h });
  }
  // The list: at least 2 rows whose first column lines up.
  const best = [];
  for (const r of rows) { const same = rows.filter(x => Math.abs(x.l - r.l) < 2 * r.h); if (same.length > best.length) best.splice(0, best.length, ...same); }
  // One member's own visit history (an account left open) is not the Visit Log.
  if (best.length >= 3 && best.every(r => r.member === best[0].member)) return [];
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

// ---- a taught LIST (any system's scan log): each new row = a scan ----
// Found by its column of member numbers (or names), stacked and lined up,
// under the header learned on install day (or where it was, if it has none).
const isYear = n => /^(19|20)\d\d$/.test(n);
// A code's shape: letters before and after its digits ("GX48210" -> 2 and 0).
const shapeOf = id => (/[A-Z]/.test(id || '') ? { pre: (/^[A-Z]*/.exec(id) || [''])[0].length, post: (/[A-Z]*$/.exec(id) || [''])[0].length } : { pre: 0, post: 0 });
const fitsShape = (id, shape) => !shape || !id || /^[a-z ]/.test(id) || (shapeOf(id).pre === shape.pre && shapeOf(id).post === shape.post);
function cellId(c, kind, len) {
  if (kind === 'name') return nameId(c.text);
  const d = codeId(c.text);
  return d && d.length >= 3 && !isYear(d) && (!len || Math.abs(d.length - len) <= 2) ? d : null;
}
// Value cells stacked in a column: lined up on the left (or, for numbers,
// on the right), the same size as the cell it grows from, one row apart.
function columnFrom(vals, seed, kind) {
  const h0 = seed.c.h, lo = kind === 'name' ? 0.62 : 0.75, hi = 1 / lo;     // names: letters below the line ("y") make boxes taller
  const fits = x => x === seed || (x.c.h / h0 > lo && x.c.h / h0 < hi && (Math.abs(x.c.l - seed.c.l) < h0 || (kind === 'number' && Math.abs(x.c.r - seed.c.r) < h0)));
  const cand = vals.filter(fits).sort((a, b) => a.c.top - b.c.top), i = cand.indexOf(seed), col = [seed];
  for (let j = i - 1, cur = seed; j >= 0; j--) { const dy = cur.c.top - cand[j].c.top; if (dy < 0.8 * h0) continue; if (dy > 4.5 * h0) break; col.unshift(cand[j]); cur = cand[j]; }
  for (let j = i + 1, cur = seed; j < cand.length; j++) { const dy = cand[j].c.top - cur.c.top; if (dy < 0.8 * h0) continue; if (dy > 4.5 * h0) break; col.push(cand[j]); cur = cand[j]; }
  if (col.length < 3) return col;
  // Rows are evenly spaced: a much bigger gap is the end of the list (a title above it, another table below).
  const gaps = col.slice(1).map((v, k) => v.c.top - col[k].c.top), m = gaps.slice().sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  let a = 0, b = col.length - 1;
  const at = col.indexOf(seed);
  for (let k = at - 1; k >= 0; k--) if (gaps[k] > 1.6 * m) { a = k + 1; break; }
  for (let k = at; k < gaps.length; k++) if (gaps[k] > 1.6 * m) { b = k; break; }
  return col.slice(a, b + 1);
}
function columnsOf(vals, kind) {
  const seen = new Set(), out = [];
  for (const v of vals.slice().sort((a, b) => a.c.top - b.c.top)) {
    if (seen.has(v)) continue;
    const col = columnFrom(vals, v, kind);
    col.forEach(x => seen.add(x));
    out.push(col);
  }
  return out;
}
// The column's header: the nearest words just above its first row.
function headerOf(cells, g) {
  const first = g[0].c, h = first.h;
  const gap = g.length > 1 ? (g[g.length - 1].c.top - first.top) / (g.length - 1) : 2.2 * h;
  const colL = Math.min(...g.map(v => v.c.l)), colR = Math.max(...g.map(v => v.c.r));
  const above = cells.filter(c => c.top < first.top - 0.4 * h && c.top > first.top - Math.max(3.2 * gap, 4 * h) && c.r > colL - 1.5 * h && c.l < colR + 1.5 * h && /\p{L}{2,}/u.test(c.text) && !/\d{3,}/.test(c.text));
  if (!above.length) return null;
  const y = Math.max(...above.map(c => c.top)), cx = (colL + colR) / 2;
  const best = above.filter(c => Math.abs(c.top - y) < 0.6 * h).sort((a, b) => Math.abs((a.l + a.r) / 2 - cx) - Math.abs((b.l + b.r) / 2 - cx))[0];
  const ws = best.ws.slice(0, 3);
  const words = ws.map(w => norm(w.t)).filter(Boolean);
  if (!words.length) return null;
  return { words, text: ws.map(w => w.t).join(' ').replace(/[\s:]+$/, '').trim(), l: best.l, top: best.top, r: best.r, h: best.h, cols: headerRow(cells, best) };
}
// All the column names on the header's row ("time member name plan status"):
// what tells this list apart from another table under the same header (a member directory).
function headerRow(cells, hc) {
  const line = cells.filter(o => o.line === hc.line).sort((a, b) => a.l - b.l), i = line.indexOf(hc);
  let a = i, b = i;
  while (a > 0 && line[a].l - line[a - 1].r < 32 * hc.h) a--;
  while (b < line.length - 1 && line[b + 1].l - line[b].r < 32 * hc.h) b++;
  const out = [];
  for (const c of line.slice(a, b + 1)) for (const w of c.ws) { const n = norm(w.t); if (/^[a-z]{2,}$/.test(n) && !out.includes(n)) out.push(n); }
  return out.slice(0, 8);
}
const sameWord = (x, y) => x === y || (y.length >= 6 && lev(x, y) <= 1);
// Every column name learned is there (one may be misread on a wide table).
const colsMatch = (have, L) => !L.cols || L.cols.filter(c => !have.some(h => sameWord(h, c))).length <= (L.cols.length >= 5 ? 1 : 0);
const headerLike = (words, L) => !!L.header && words.some(x => x === L.header[0] || (L.header[0].length >= 6 && lev(x, L.header[0]) <= 1));
// The area to watch: the newest 12 rows, whole rows (the time column too),
// with room on the newest side for the next row.
function listBoxOf(L, cells, items, hdr) {
  const h = items.length ? Math.max(...items.map(c => c.h)) : L.pos.h * H;
  const rowH = items.length > 1 ? (items[items.length - 1].top - items[0].top) / (items.length - 1) : 2.2 * h;
  const use = L.newest === 'top' ? items.slice(0, 12) : items.slice(-12);
  const colL = items.length ? Math.min(...items.map(c => c.l)) : hdr.l, colR = items.length ? Math.max(...items.map(c => c.r)) : hdr.r;
  let left = Math.min(colL, hdr ? hdr.l : colL), right = Math.max(colR, hdr ? hdr.r : colR);
  for (const c of use) {
    const line = cells.filter(o => o.line === c.line).sort((a, b) => a.l - b.l), i = line.indexOf(c);
    for (let j = i - 1; j >= 0 && line[j + 1].l - line[j].r < 32 * h; j--) left = Math.min(left, line[j].l);     // wide tables have wide gaps
    for (let j = i + 1; j < line.length && line[j].l - line[j - 1].r < 32 * h; j++) right = Math.max(right, line[j].r);
  }
  const top = hdr ? hdr.top - 0.3 * h : use[0].top - (L.newest === 'top' ? 0.6 : 0.5) * rowH;
  const lastBottom = use.length ? use[use.length - 1].top + h : (hdr ? hdr.top + hdr.h : 0);
  const bottom = lastBottom + (L.newest === 'bottom' || !use.length ? 1.6 : 0.6) * rowH;
  return Object.assign(clampBox(left - 1.5 * h, top, right + 1.5 * h, bottom), { col: { l: colL, r: colR }, th: h, rowH, newest: L.newest, hdr: !!hdr });
}
function findList(words, L) {
  const cells = cellsOf(words);
  const vals = cells.map(c => ({ c, id: cellId(c, L.kind, L.len) })).filter(v => v.id && !(L.header && norm(v.id) === L.header.join('')));
  let best = null;
  for (const g of columnsOf(vals, L.kind)) {
    const c0 = g[0].c, hr = (c0.h / H) / L.pos.h, dx = Math.abs(c0.l / W - L.pos.x);
    if (hr < 0.6 || hr > 1.6) continue;
    if (g.length >= 3 && g.every(v => v.id === g[0].id)) continue;          // one member's own history (an account left open), not the check-in list
    const hdr = headerOf(cells, g);
    if (L.header) { if (!hdr || !headerLike(hdr.words, L) || dx > 0.3 || !colsMatch(hdr.cols, L)) continue; }
    else if (g.length < 2 || dx > 0.15) continue;
    if (L.timed && g.length >= 2 && g.filter(v => clockIn(cells.filter(o => o !== v.c && o.line === v.c.line).map(o => o.text).join('   '))).length * 2 < g.length) continue;   // no times: another table
    const score = dx + 0.3 * Math.abs(c0.top / H - L.pos.y) - 0.01 * g.length;
    if (!best || score < best.score) best = { g, hdr, score };
  }
  if (best) return listBoxOf(L, cells, best.g.map(v => v.c), best.hdr);
  // An empty list (a new day): just its header.
  if (L.header) {
    const lab = cells.find(c => headerLike(c.ws.map(w => norm(w.t)), L) && Math.abs(c.l / W - L.pos.x) < 0.3 && colsMatch(headerRow(cells, c), L));
    if (lab) return listBoxOf(L, cells, [], { l: lab.l, top: lab.top, r: lab.r, h: lab.h });
  }
  return null;
}
// The rows in one read: the value in the column, and a clock time on the same row.
function rowsIn(words, box, L) {
  const cells = cellsOf(words), out = [];
  for (const c of cells) {
    const inCol = L.kind === 'name' ? Math.abs(c.l - box.col.l) < 1.2 * box.th
      : (c.l + c.r) / 2 > box.col.l - 1.5 * box.th && (c.l + c.r) / 2 < box.col.r + 1.5 * box.th;
    if (!inCol) continue;
    let id = cellId(c, L.kind, L.len);
    if (!id || (L.header && norm(id) === L.header.join(''))) continue;
    if (!fitsShape(id, L.shape)) id = '?';                                  // misread ("GXX70021"): still a row, member unknown
    const rest = cells.filter(o => o !== c && o.line === c.line).map(o => o.text).join('   ');
    out.push({ top: c.top, l: c.l, r: c.r, h: c.h, id, clock: clockIn(rest), denied: DENIED.test(rest), zone: zoneOf(rest) });
  }
  return out;
}
// The list read twice at two sizes. A row both reads agree on keeps its
// value; a row they disagree on is still a row ("?": a scan whose member
// can't be told, sent as uncertain), so a scan is never lost to a misread.
async function readTaughtList(frame, box) {
  const L = PROFILE.list, sz = k => Math.min(3.5, Math.max(1.2, k / box.th));
  const [wa, wb] = await Promise.all([ocr(frame, box, sz(26)), ocr(frame, box, sz(32))]);
  const ra = rowsIn(wa, box, L), rb = rowsIn(wb, box, L);
  // Its header row must still be this list's (the same column names), or it's another page.
  if (L.cols && box.hdr) {
    const rowOf = ws => { const cs = cellsOf(ws), hc = cs.find(c => headerLike(c.ws.map(w => norm(w.t)), L)); return hc ? headerRow(cs, hc) : null; };
    const ha = rowOf(wa), hb = rowOf(wb);
    if ((ha || hb) && !(ha && colsMatch(ha, L)) && !(hb && colsMatch(hb, L))) return { found: false, ok: true, rows: [], other: true };
  }
  // A list that shows times: a table there without them is another page (a member directory), not the list.
  if (L.timed && ra.length >= 2 && ra.filter(r => r.clock).length * 2 < ra.length) return { found: false, ok: true, rows: [], other: true };
  if (!ra.length && !rb.length) {
    // Numbers or names are there, but none read as this list's rows (moved a little, or the
    // look changed): not an empty list. Look for it again (and say so if it can't be found).
    const ids = wa.map(w => cellId({ text: w.t }, L.kind, L.len)).filter(Boolean);
    if (ids.length >= 3) return { found: false, ok: true, rows: [], unreadable: true };
    const hdrSeen = !!L.header && [wa, wb].some(ws => headerLike(ws.map(w => norm(w.t)), L));
    return { found: hdrSeen && box.hdr, ok: true, rows: [] };
  }
  const rows = [], usedB = new Set();
  const sameClock = (a, b) => a && b && a.h === b.h && a.m === b.m && a.s === b.s;
  for (const a of ra) {
    const b = rb.find(x => !usedB.has(x) && Math.abs(x.top - a.top) < 0.6 * box.th);
    if (b) usedB.add(b);
    rows.push({ top: a.top, id: b && a.id === b.id && a.id !== '?' ? a.id : '?', clock: b && sameClock(a.clock, b.clock) ? a.clock : null, denied: a.denied || (b && b.denied), zone: a.zone || (b && b.zone) || null, cell: a });
  }
  for (const b of rb) if (!usedB.has(b)) rows.push({ top: b.top, id: '?', clock: null, cell: b });
  // A row the two reads didn't agree on: a close-up of just that value, read twice more (both must agree).
  let tries = 0;
  for (const r of rows) {
    if (r.id !== '?' || tries++ >= 3) continue;
    const c = r.cell, pad = 0.5 * c.h;
    const tight = clampBox(c.l - pad, c.top - pad, Math.max(c.r, c.l + 4 * c.h) + pad, c.top + c.h + pad);
    const z = k => Math.min(3.5, Math.max(1, k / c.h)), opts = L.kind === 'name' || (L.shape && (L.shape.pre || L.shape.post)) ? { psm: '7' } : { psm: '7', digits: true };
    const z1 = z(26), z2 = z(32) === z1 ? z1 * 1.3 : z(32);
    const reads = await Promise.all([z1, z2, Math.max(z2 * 1.25, 2.5)].map(k => ocr(frame, tight, Math.min(3.5, k), opts)));
    const v = ws => { const t = ws.map(w => w.t).join(L.kind === 'name' ? ' ' : ''); const id = L.kind === 'name' ? nameId(t) : codeId(t); return id && fitsShape(id, L.shape) ? id : null; };
    const vals = reads.map(v).filter(Boolean), agreed = vals.find(x => vals.filter(y => y === x).length >= 2);   // two of three sizes agree
    if (agreed) r.id = agreed;
  }
  rows.forEach(r => { delete r.cell; });
  rows.sort((x, y) => (L.newest === 'top' ? x.top - y.top : y.top - x.top));     // newest first
  const real = rows.filter(r => r.id !== '?').length;
  const known = rows.filter(r => r.id !== '?');
  if (known.length >= 3 && known.every(r => r.id === known[0].id)) return { found: false, ok: true, rows: [], other: true };   // one member's own history, not the check-in list
  return { found: true, ok: real >= Math.min(2, rows.length), rows };
}
// Which rows are new? `hist` is what the list has shown (newest first);
// `cur` is what it shows now. The new rows are the ones before the part
// that lines up with what was there. A list scrolled by hand, or scrolled
// back, lines up further down and adds nothing; a page that shows something
// else entirely lines up nowhere (null: start again from it, add nothing).
function alignList(hist, cur) {
  if (!cur.length) return { fresh: 0, older: [] };
  if (!hist.length) return { fresh: cur.length, older: [] };
  let best = null;
  for (let o = -cur.length; o < hist.length; o++) {
    let real = 0, bad = 0, over = 0, fresh = 0, older = 0;
    for (let i = 0; i < cur.length; i++) {
      const j = i + o;
      if (j < 0) { fresh++; continue; }
      if (j >= hist.length) { older++; continue; }
      over++;
      if (cur[i] === '?' || hist[j] === '?') continue;
      if (cur[i] === hist[j]) real++; else bad++;
    }
    if (!over || bad > (real >= 6 ? 1 : 0) || real < Math.min(2, over)) continue;
    const score = real - older;
    if (!best || score > best.score || (score === best.score && best.o !== 0 && (o === 0 || o > best.o))) best = { o, score, fresh, older };
  }
  if (!best) return null;
  return { fresh: best.fresh, older: best.older ? cur.slice(cur.length - best.older) : [] };
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
  if (PROFILE.needNear) return { pop: popupBox(readFields(words)), grid: gridBox(readGridRows(words)) };
  // A taught screen: its pop-up/panel and/or its list.
  return { pop: PROFILE.panel ? popupBox(readFields(words)) : null, grid: PROFILE.list ? findList(words, PROFILE.list) : null };
}
// The pop-up read twice at two sizes; both must agree (accuracy first).
// A taught screen: find the number, then read just that number twice, at
// sizes worked out from how big it is on screen (OCR misreads text blown up
// too far: a big "55107" can come out "95107"), digits only. Both must agree.
async function readTaughtNumber(frame, box) {
  const words = await ocr(frame, box, 2), a = readFields(words);
  a.panelText = words.map(w => w.t).join(' ');
  const what = PROFILE.kind === 'name' ? 'name' : 'number';
  if (!a.found) return { found: false };
  if (!a.member || !a.vbox) return { found: true, ok: false, why: `no ${what} could be read next to "${PROFILE.labelText}"` };
  const vh = Math.max(4, a.vbox.h), pad = 0.6 * vh;
  // The label just left of the value ("Welcome, Taylor"): stop halfway to it, so its comma isn't read as part of the name.
  const lab = a.labels && a.labels.mLab, labEnd = lab && Math.abs(lab.top - a.vbox.top) < vh && lab.l < a.vbox.l ? lab.l + lab.w : null;
  const padL = labEnd != null ? Math.max(1, Math.min(pad, (a.vbox.l - labEnd) / 2)) : pad;
  const tight = clampBox(a.vbox.l - padL, a.vbox.top - pad, a.vbox.l + a.vbox.w + pad, a.vbox.top + a.vbox.h + pad);
  const sz = k => Math.min(3.5, Math.max(1, k / vh));
  const opts = PROFILE.kind === 'name' || /[A-Z]/.test(a.member) ? { psm: '7' } : { psm: '7', digits: true };   // codes with letters: no digits-only read
  // Two different sizes (big names would otherwise both be read at 1:1, the same read twice).
  const s1 = sz(24), s2 = PROFILE.kind === 'name' && sz(30) === s1 ? s1 * 1.3 : sz(30);
  const [x, y] = await Promise.all([ocr(frame, tight, s1, opts), ocr(frame, tight, s2, opts)]);
  const val = ws => (PROFILE.kind === 'name' ? nameId(ws.map(w => w.t).join(' ')) : codeId(ws.map(w => w.t).join('')));
  const ok = v => (v && fitsShape(v, PROFILE.panel && PROFILE.panel.shape) ? v : null);
  let d1 = ok(val(x)), d2 = ok(val(y));
  // The two disagree (a letter of the label next to it run into the value): a third size; two of three must agree.
  if (d1 !== d2) { const d3 = ok(val(await ocr(frame, tight, Math.min(3.5, Math.max(s2 * 1.3, 1.6)), opts))); if (d3 && (d3 === d1 || d3 === d2)) d1 = d2 = d3; }
  if (d1 && d1 === d2) return { found: true, ok: true, member: d1, zone: zoneOf(a.panelText || ''), time: '', denied: a.panelText ? DENIED.test(a.panelText) : false };
  return { found: true, ok: false, why: `the two reads of the ${what} did not match` };
}
async function readPopup(frame, box) {
  if (!PROFILE.needNear) return readTaughtNumber(frame, box);
  const [wa, wb] = await Promise.all([ocr(frame, box, 3), ocr(frame, box, 2.5)]);
  const a = readFields(wa), b = readFields(wb);
  if (!a.found && !b.found) return { found: false };
  if (a.member && b.member && a.member === b.member && (a.zone || '') === (b.zone || '')) return { found: true, ok: true, member: a.member, zone: a.zone || b.zone, time: a.time || b.time, denied: DENIED.test((a.message || '') + ' ' + (b.message || '')) };
  return { found: true, ok: false, why: !a.member && !b.member ? `no number could be read next to "${PROFILE.labelText}"` : a.member !== b.member ? 'the two reads of the number did not match' : 'the zone did not read the same twice' };
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
  say('  On your phone: admin page > tap the gym > Protected member numbers > "Reader: new code".');
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
      if (!PROFILE.needNear) {                  // a taught screen: its panel and/or its list
        if (!found.pop && !found.grid) return finish({ ok: false, msg: `There is a picture, but ${PROFILE.what} is not on it (${PROFILE.name}). Open the check-in screen, or teach it again:  node screen-reader.js --teach` });
        const parts = [], probs = [];
        if (found.pop) { const r = await readPopup(frame, found.pop); if (r.ok) parts.push(`${PROFILE.kind === 'name' ? 'the name' : 'member'} ${maskId(r.member)} next to "${PROFILE.labelText}"`); else probs.push(`"${PROFILE.labelText}" is there but ${r.why}`); }
        else if (PROFILE.panel) parts.push(`the pop-up next to "${PROFILE.labelText}" is not open right now (fine: the list is read)`);
        if (found.grid) { const l = await readTaughtList(frame, found.grid); if (l.ok) parts.push(`the list (${l.rows.length} row${l.rows.length === 1 ? '' : 's'}${l.rows.length ? ', newest ' + maskId(l.rows[0].id) + (l.rows[0].clock ? ' at ' + l.rows[0].clock.h + ':' + String(l.rows[0].clock.m).padStart(2, '0') : '') : ': empty'})`); else probs.push('the list is there but its rows could not be read'); }
        else if (PROFILE.list) parts.push('the list is not on screen right now' + (PROFILE.panel ? ' (fine: the pop-up is read)' : ''));
        if (probs.length || !parts.length || (!found.grid && !found.pop)) return finish({ ok: false, msg: `${probs.join('; ') || PROFILE.what + ' could not be read'}. Make the check-in window bigger, or teach it again:  node screen-reader.js --teach` });
        return finish({ ok: true, msg: `Read ${PROFILE.name}: ${parts.join('; ')}.` });
      }
      const rows = found.grid ? await readGrid(frame, found.grid) : [];
      const ash = PROFILE.needNear;
      const list = !ash ? '' : rows.length ? ` Also reading the Visit Log list (${rows.length} rows, newest ${mask(rows[found.grid.newestFirst ? 0 : rows.length - 1].member)}).` : ' (The Visit Log list is not on screen: fine, the pop-up is enough.)';
      if (!found.pop) return finish(rows.length && ash
        ? { ok: true, msg: `The Live Entry pop-up is not on screen, so for now scans are read from the Visit Log list (${rows.length} rows). Best: leave the pop-up open too.` }
        : { ok: false, msg: ash ? 'There is a picture, but neither the Live Entry pop-up nor the Visit Log is on it. Open Ashbourne (MVSv4) with the pop-up showing. (Another check-in system? Run:  node screen-reader.js --teach)' : `There is a picture, but "${PROFILE.labelText}" is not on it. Open the check-in screen, or teach it again:  node screen-reader.js --teach` });
      const r = await readPopup(frame, found.pop);
      if (!r.ok) return finish({ ok: false, msg: `${ash ? 'The pop-up' : `"${PROFILE.labelText}"`} is there but ${r.why}. ${ash ? 'Send Claude a photo of the front-desk screen (cover the names).' : 'Teach it again:  node screen-reader.js --teach'}` });
      finish({ ok: true, msg: `Read ${ash ? 'the pop-up' : `"${PROFILE.labelText}" (${PROFILE.name})`}: member ${mask(r.member)}${ash ? `, ${r.zone || 'zone not shown'}` : ''}${r.time ? ', ' + r.time : ''}.${list}` });
    }, (code, err) => finish({ ok: false, msg: 'No picture from the capture stick' + (err ? ` (${err})` : '') + '. Is it plugged into this box, and the HDMI cable into the splitter?' }), alt);
    setTimeout(() => finish({ ok: false, msg: 'No picture from the capture stick within 20 seconds. Check it is plugged in.' }), 20000);
  });
}

// ------------------------------------------------------------------ teach
// A gym on another check-in system: compare the screen before and after one
// scan. A number that appears, with a label next to it ("Member ID 4810"
// or the label above it), is the member number. Only the label and where
// the number sits are saved: never a number, never a picture.
function numbersIn(words) { return words.map(w => ({ w, n: digits(w.t) })).filter(x => x.n && x.n.length >= 3); }
function labelFor(words, v) {
  const letters = w => /[a-z]{2,}/i.test(w.t) && !/^[ap]\.?m\.?$/i.test(w.t) && !codeId(w.t);   // "PM" after a time, or another member code, is not a label
  const mkLab = (seq, layout) => ({ words: seq.map(w => norm(w.t)).filter(Boolean), text: seq.map(w => w.t).join(' ').replace(/[:#]+$/, '').trim(), layout });
  // On the same line, just left of the number ("Member ID: 4810").
  const left = words.filter(w => w !== v && Math.abs(w.top - v.top) < 0.6 * Math.max(v.h, w.h) && w.l + w.w <= v.l + 2 && v.l - (w.l + w.w) < 14 * v.h).sort((a, b) => b.l - a.l);
  if (left.length && letters(left[0])) {
    const seq = [left[0]];
    for (let i = 1; i < left.length && seq.length < 2; i++) { const p = seq[seq.length - 1]; if (p.l - (left[i].l + left[i].w) < 1.6 * v.h && letters(left[i])) seq.push(left[i]); else break; }
    return mkLab(seq.reverse(), 'right');
  }
  // Or the line just above it, roughly over it.
  const cx = v.l + v.w / 2;
  const above = words.filter(w => w !== v && letters(w) && w.top < v.top - 0.3 * v.h && w.top > v.top - 3.5 * v.h && Math.abs((w.l + w.w / 2) - cx) < Math.max(6 * v.h, 2 * v.w));
  if (!above.length) return null;
  const y = Math.max(...above.map(w => w.top));
  const line = above.filter(w => Math.abs(w.top - y) < 0.6 * v.h).sort((a, b) => Math.abs((a.l + a.w / 2) - cx) - Math.abs((b.l + b.w / 2) - cx)).slice(0, 2).sort((a, b) => a.l - b.l);
  return mkLab(line, 'below');
}
// The value someone typed ("Alex") against a word on the screen.
const likeName = (t, typed) => { const a = norm(t), b = norm(typed); return !!a && !!b && (a === b || (b.length >= 5 && lev(a, b) <= 1)); };
// The whole name starting at that word ("Alex" -> "Alex Rivera").
function nameAt(words, w) {
  const line = words.filter(x => Math.abs(x.top - w.top) < 0.6 * Math.max(x.h, w.h) && x.l >= w.l - 1).sort((a, b) => a.l - b.l);
  const seq = [w];
  for (const x of line) {
    if (x === w || x.l < w.l) continue;
    const p = seq[seq.length - 1];
    if (seq.length < 4 && x.l - (p.l + p.w) < 1.2 * w.h && nameId(x.t)) seq.push(x); else break;
  }
  return nameId(seq.map(x => x.t).join(' '));
}
// Is this new value the newest row of a list? It must sit at the top or the
// bottom of a column of values, and that column must have moved on by a row
// (or more) since before the scan. 'inlist': inside a list but not its newest
// row (an older row that moved down). null: not in a list.
function listCand(o, ac, bc, kind, observedMs) {
  const cell = ac.find(c => c.ws.includes(o.w));
  if (!cell || cellId(cell, kind) !== o.id) return null;
  const len = kind === 'number' ? o.id.length : null;
  const vals = ac.map(c => ({ c, id: cellId(c, kind, len) })).filter(v => v.id);
  const seed = vals.find(v => v.c === cell);
  const g = seed ? columnFrom(vals, seed, kind) : null;
  if (!g || g.length < 2) return null;
  const idx = g.findIndex(v => v.c === cell), h = cell.h;
  // Cells that didn't change at all (a names list's "Name" header lines up with the names) can sit beyond the newest row.
  const stillThere = v => bc.some(b => b.text === v.c.text && Math.abs(b.l - v.c.l) < h && Math.abs(b.top - v.c.top) < 0.6 * h);
  const ends = [];
  if (g.slice(0, idx).every(stillThere)) ends.push(['top', g.slice(idx), g.slice(0, idx)]);
  if (g.slice(idx + 1).every(stillThere)) ends.push(['bottom', g.slice(0, idx + 1), g.slice(idx + 1)]);
  if (!ends.length) return 'inlist';
  let lined = false;
  for (const [newest, col, off] of ends) {
    if (col.length < 2) continue;
    const span0 = col[0].c.top - 3 * h, span1 = col[col.length - 1].c.top + 4 * h;
    const bvals = bc.map(c => ({ c, id: cellId(c, kind, len) })).filter(v => v.id && v.c.top > span0 && v.c.top < span1
      && (Math.abs(v.c.l - col[0].c.l) < h || (kind === 'number' && Math.abs(v.c.r - col[0].c.r) < h))
      && !off.some(o => o.c.text === v.c.text && Math.abs(o.c.top - v.c.top) < 0.6 * h));
    const ord = arr => arr.slice().sort((a, b) => (newest === 'top' ? a.c.top - b.c.top : b.c.top - a.c.top));
    let a = alignList(ord(bvals).map(v => v.id), ord(col).map(v => v.id));
    if (!a) {   // a dark or small screen misreads a couple of the older rows: the rest moved down by exactly one row
      // (or missed one): the rows after the new one are, in order, mostly the rows it showed before.
      const B = ord(bvals).map(v => v.id), C = ord(col).map(v => v.id).slice(1);
      const L = Array.from({ length: C.length + 1 }, () => new Array(B.length + 1).fill(0));
      for (let i = 1; i <= C.length; i++) for (let j = 1; j <= B.length; j++) L[i][j] = C[i - 1] === B[j - 1] ? L[i - 1][j - 1] + 1 : Math.max(L[i - 1][j], L[i][j - 1]);
      const over = Math.min(C.length, B.length), same = L[C.length][B.length];
      if (over >= 4 && same >= 0.7 * over && !B.includes(ord(col)[0].id)) a = { fresh: 1, older: [] };
    }
    if (a) lined = true;
    if (!a || a.fresh < 1) continue;
    const hdr = headerOf(ac, col);
    const rowText = ac.filter(x => x !== cell && x.line === cell.line).map(x => x.text).join('   ');
    const clock = clockIn(rowText);
    // The PC's clock against this one, to the minute (a PC in another time zone, or just set wrong).
    const tzOffMin = clock ? Math.round((clockMs(clock, observedMs, 0) - observedMs + (clock.s == null ? 30e3 : 0)) / 60e3) : 0;
    return { newest, zone: zoneOf(rowText), header: hdr ? hdr.words : null, headerText: hdr ? hdr.text : null, cols: hdr && hdr.cols.length >= 2 ? hdr.cols : null, pos: { x: col[0].c.l / W, y: col[0].c.top / H, h: h / H }, len, timed: !!clock, tzOffMin };
  }
  return lined ? 'inlist' : null;   // the old end of a list that moved on, or not a list at all
}
// What the scan put on the screen: for each new value (a member number, or
// the name typed in), where it shows: a pop-up/panel (next to or under a
// label), the newest row of a list, or both.
function teachFind(before, after, want, observedMs) {
  const ac = cellsOf(after), bc = cellsOf(before), byId = new Map();
  const occ = [];
  if (want.kind === 'number') { for (const w of after) { const n = codeId(w.t); if (n && n.length >= 3 && !isYear(n)) occ.push({ w, id: n }); } }
  else for (const w of after) if (likeName(w.t, want.name)) { const id = nameAt(after, w); if (id) occ.push({ w, id }); }
  for (const o of occ) {
    const same = b => (want.kind === 'number' ? codeId(b.t) === o.id : likeName(b.t, want.name));
    if (before.some(b => Math.abs(b.l - o.w.l) < o.w.h && Math.abs(b.top - o.w.top) < 0.6 * o.w.h && same(b))) continue;   // was already there
    const opt = byId.get(o.id) || { id: o.id, kind: want.kind, panel: null, list: null };
    const li = listCand(o, ac, bc, want.kind, observedMs);
    if (li === 'inlist') continue;
    if (li) { if (!opt.list) opt.list = li; }
    else if (!opt.panel) {
      const lab = labelFor(after, o.w);
      // the zone the pop-up shows, if any (words near the value)
      const nearText = after.filter(x => Math.abs(x.top - o.w.top) < 10 * o.w.h && Math.abs(x.l - o.w.l) < 25 * o.w.h).map(x => x.t).join(' ');
      if (lab && lab.words.length) opt.panel = { label: lab.words, labelText: lab.text, layout: lab.layout, zone: zoneOf(nearText), pos: { x: o.w.l / W, y: o.w.top / H } };
    }
    if (opt.panel || opt.list) byId.set(o.id, opt);
  }
  return [...byId.values()];
}
function profileFrom(opt, name) {
  return cleanProfile({ name: name || 'taught', taughtAt: new Date().toISOString(),
    panel: opt.panel ? { kind: opt.kind, shape: opt.kind === 'number' ? shapeOf(opt.id) : null, zone: opt.panel.zone || null, pos: opt.panel.pos || null, member: [[opt.panel.label[0]], opt.panel.label.slice(1, 2)], layout: opt.panel.layout, labelText: opt.panel.labelText } : null,
    list: opt.list ? Object.assign({ kind: opt.kind, shape: opt.kind === 'number' ? shapeOf(opt.id) : null }, opt.list) : null });
}
const describeOpt = o => [o.panel ? `${o.panel.layout === 'right' ? 'next to' : 'under'} "${o.panel.labelText}"` : null,
  o.list ? `as a new row at the ${o.list.newest} of a list${o.list.headerText ? ` (the "${o.list.headerText}" column)` : ''}` : null].filter(Boolean).join(', and ');
async function teach() {
  const pc = require('./pairing-client');
  const say = m => console.log(m);
  say('Teach the reader this gym\'s check-in screen\n');
  TEACHING = true;
  if (!FFMPEG || !TESS) { say('ffmpeg or tesseract is missing. On the Pi:  sudo apt install -y ffmpeg tesseract-ocr'); process.exit(1); }
  const core = new ReaderCore({ dir: stateDir(), name: 'screen-reader', version: VERSION, log: () => {} });
  const source = arg('source') || (core.cfg && core.cfg.source);
  // The background reader holds the capture stick: ask it to let go while this runs.
  if (!String(source || '').startsWith('file:')) {
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(pauseFile(), String(Date.now()), { mode: 0o600 });
    const keep = setInterval(() => { try { fs.utimesSync(pauseFile(), new Date(), new Date()); } catch (e) { /* gone */ } }, 60000); keep.unref();
    process.on('exit', () => { try { fs.unlinkSync(pauseFile()); } catch (e) { /* gone */ } });
    if (core.cfg) await new Promise(r => setTimeout(r, 7000));
  }
  const system = arg('name') || (arg('yes') ? 'taught' : await pc.simpleAsk('  Which check-in system is it? (e.g. ABC, Mindbody, Glofox)', 'other'));
  // Most systems show the member number; some only show the member's name.
  let want = { kind: 'number' };
  const typed = arg('myname') || (!arg('yes') && /^n/i.test(await pc.simpleAsk('  When a member scans, does the screen show their member number (on a pop-up or in a list)? (Y/n)', 'y'))
    ? await pc.simpleAsk('  Then it shows names. Type your first name exactly as the screen shows it (only used to find it now, never saved)', '') : null);
  if (typed) want = { kind: 'name', name: String(typed).trim() };
  say('  Open the check-in screen the front desk keeps open (where scans show up: a pop-up, a list of check-ins, or both).');
  if (!arg('yes')) await pc.simpleAsk('  Press Enter when it is showing', '');
  let base = null, latest = null, reading = false, done = false, opts = [], firstAt = 0, lastSig = null, lastRead = 0, seenFrame = null;
  const t0 = Date.now(), LIMIT = Number(arg('seconds') || 90) * 1000;
  const ready = () => opts.length && Date.now() - firstAt > (opts.some(o => o.panel && o.list) ? 1500 : 6000);
  const result = await new Promise(resolve => {
    const finish = r => { if (!done) { done = true; try { p.kill('SIGKILL'); } catch (e) { /* gone */ } resolve(r); } };
    let frames = 0;
    const p = startFrames(source, async frame => {
      latest = frame;
      if (done || reading || ++frames < 3) return;
      const sig = signature(frame, { x: 0, y: 0, w: W, h: H });
      // Read when the screen changed (small text changes count) or every ~3 s anyway.
      if (base && lastSig && sigDiff(sig, lastSig) < 5 && frames - lastRead < FPS * 3 && !ready()) return;
      lastRead = frames;
      reading = true; p.stdout.pause();
      try {
        const words = await ocr(frame, { x: 0, y: 0, w: W, h: H }, 2);
        lastSig = sig;
        if (!base) { base = words; say('\n  Now scan in at the front desk (your own card or tag). Watching for ' + Math.round(LIMIT / 1000) + ' seconds...'); }
        else {
          const now = teachFind(base, words, want, Date.now());
          if (now.length) seenFrame = frame;           // checked against a picture that shows it (a pop-up may close again)
          for (const o of now) {
            const had = opts.find(x => x.id === o.id);
            if (!had) { opts.push(o); if (!firstAt) firstAt = Date.now(); }
            else { had.panel = had.panel || o.panel; had.list = had.list || o.list; }
          }
          if (ready()) return finish({ opts, frame: seenFrame || frame });
        }
      } catch (e) { say('  Could not read the screen: ' + e.message); return finish({ opts: [] }); }
      finally { reading = false; if (!done) p.stdout.resume(); }
      if (Date.now() - t0 > LIMIT) finish({ opts, frame: seenFrame || latest });
    }, (code, err) => finish({ opts, frame: seenFrame || latest, err: base ? null : (err || 'no picture') }));
    setTimeout(() => finish({ opts, frame: seenFrame || latest }), LIMIT + 30000);
  });
  if (result.err) { say('  No picture from the capture stick' + (result.err !== 'no picture' ? ` (${result.err})` : '') + '. Check it is plugged in, then try again.'); process.exit(1); }
  if (!result.opts.length) {
    say(want.kind === 'number'
      ? '  No new member number showed up. Scan in again while this runs, with the check-in screen showing (not covered).\n  If the screen only shows the member\'s NAME, run this again and answer n to the first question.'
      : `  "${want.name}" did not show up as something new. Scan in again while this runs, and type your name exactly as the screen shows it.`);
    process.exit(1);
  }
  say(`\n  ${want.kind === 'number' ? 'New numbers that appeared (only the last 2 digits are shown)' : 'Your name appeared'}:`);
  result.opts.forEach((o, i) => say(`    ${i + 1}) ${o.kind === 'name' ? 'your name' : 'ends in ' + o.id.slice(-2)}: ${describeOpt(o)}`));
  let pick = 0;
  if (result.opts.length === 1 && arg('yes')) pick = 1;
  else {
    const a = await pc.simpleAsk(result.opts.length === 1 ? `  Is that ${want.kind === 'number' ? 'your member number' : 'you'}? (y/n)` : `  Which one is ${want.kind === 'number' ? 'your member number' : 'you'}? (1-${result.opts.length}, or 0 for none)`, '');
    pick = result.opts.length === 1 ? (/^y/i.test(a) ? 1 : 0) : Number(a) || 0;
  }
  const c = result.opts[pick - 1];
  if (!c) { say('  Nothing saved. Run it again and scan once more.'); process.exit(1); }
  // Check: the new profile reads the same value back from the same picture
  // (the pop-up and the list each; one that can't is left out).
  let prof = profileFrom(c, system);
  useProfile(prof);
  const fl = await locate(result.frame);
  const pOk = !!(prof.panel && fl.pop && await readPopup(result.frame, fl.pop).then(r => r.ok && r.member === c.id));
  const lOk = !!(prof.list && fl.grid && await readTaughtList(result.frame, fl.grid).then(l => l.ok && l.rows.length && l.rows[0].id === c.id));
  if (!pOk && !lOk) { say(`  It found ${want.kind === 'number' ? 'the number' : 'your name'} but could not read it back reliably. Make the check-in window bigger (or zoom in), then run this again.`); process.exit(1); }
  if (prof.panel && !pOk) { say(`  (The pop-up could not be read back reliably, so only the list is used.)`); c.panel = null; }
  if (prof.list && !lOk) { say(`  (The list could not be read back reliably, so only the pop-up is used.)`); c.list = null; }
  prof = profileFrom(c, system);
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(profileFile(), JSON.stringify(profileToSave(prof), null, 1), { mode: 0o600 });
  say(`\n  ✓ Learned (${system}): ${prof.kind === 'name' ? 'the member\'s name' : 'the member number'} shows ${describeOpt(c)}. Saved to ${profileFile().replace(os.homedir(), '~')}.`);
  if (prof.list && prof.list.timed) say('  The list shows the time of each scan: the reader uses it to tell new scans from old rows, and to time scans the screen shows late.');
  if (prof.list && !prof.panel) say('  Leave that list showing at the front desk (scrolling it is fine).');
  if (prof.kind === 'name') say('  Names are scrambled on this Pi exactly like member numbers: never sent or saved as text.');
  const z = (prof.panel && prof.panel.zone) || (prof.list && prof.list.zone);
  if (z) say(`  Only scans for ${z} count (the zone your test scan showed). Other doors and areas are left out.`);
  say('  The background reader switches to it by itself within a minute.');
  say('  Back to Ashbourne any time:  node screen-reader.js --forget');
  process.exit(0);
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
// Where the pop-up shows up on this screen, kept across restarts, so the
// first scan after a restart is seen the moment it appears. A taught screen
// starts from where its pop-up was on install day.
const spotFile = () => path.join(stateDir(), 'screen-reader-spot.json');
function loadSpot() {
  try { const b = JSON.parse(fs.readFileSync(spotFile(), 'utf8')); if (b && b.w > 8 && b.h > 8 && (b.profile || null) === (PROFILE.taughtAt || null)) return clampBox(b.x, b.y, b.x + b.w, b.y + b.h); } catch (e) { /* none yet */ }
  const p = PROFILE.panel && PROFILE.panel.pos;
  return p ? clampBox((p.x - 0.25) * W, (p.y - 0.15) * H, (p.x + 0.2) * W, (p.y + 0.15) * H) : null;
}
function saveSpot(b) {
  try { fs.writeFileSync(spotFile(), JSON.stringify({ x: b.x, y: b.y, w: b.w, h: b.h, profile: PROFILE.taughtAt || null }), { mode: 0o600 }); } catch (e) { /* fine */ }
}
async function run() {
  const core = new ReaderCore({ dir: stateDir(), name: 'screen-reader', version: VERSION, log });
  if (!core.cfg || !core.cfg.token || !core.cfg.owner) { console.log('Not set up yet. Type:  node screen-reader.js --setup'); process.exit(1); }
  if (!FFMPEG || !TESS) { log('ffmpeg or tesseract missing'); process.exit(1); }
  const source = arg('source') || core.cfg.source;
  useProfile(loadProfile());
  if (PROFILE !== ASHBOURNE) log(`reading a taught check-in screen (${PROFILE.name}): ${PROFILE.what}`);
  const TL = PROFILE.needNear ? null : PROFILE.list;   // a taught list (scan log)
  // The front door's zone: Ashbourne's from setup; a taught screen's from the teach scan (if it showed one).
  const zoneWanted = PROFILE.needNear ? norm(core.cfg.zone || '') : PROFILE.panel && PROFILE.panel.zone ? norm(PROFILE.panel.zone) : '';
  const fast = !!arg('fast');
  Object.assign(core.counts, { fromList: 0, confirmed: 0, conflicts: 0 });
  log(`screen reader ${VERSION} started`);
  const now0 = Date.now();
  const st = {
    pop: { box: null, sig: null, dirtyAt: 0, lastBox: loadSpot(), gone: now0 },
    grid: { box: null, sig: null, dirtyAt: 0, seen: new Set(), newest: -Infinity, base: false, gone: now0,
      hist: [], skews: [], mskews: [], offs: [], late: [] },   // a taught list: what it has shown (newest first); its clock against ours; rows shown late
    busy: false, lastLocate: 0, locateSig: null, lastKey: undefined, recent: new Map(),
    cands: [],                        // scans waiting to be compared: { src: 'pop'|'list', member, zone, at }
    delays: [],                       // how much later the list shows a scan than the pop-up (ms)
    lastFrameAt: now0, blackSince: 0, badSince: 0, startedAt: now0,
  };
  const health = () => {
    const now = Date.now();
    if (st.paused) return core.baseHealth();     // being taught on purpose
    // (since: when it stopped seeing the check-in screen, so the website treats entries
    // from then on as "front desk not visible", never as "no scan".)
    if (now - st.lastFrameAt > T_NO_SIGNAL || (st.blackSince && now - st.blackSince > T_NO_SIGNAL)) return { code: 'no-signal', text: 'No picture from the front-desk screen.', since: Math.min(st.lastFrameAt, st.blackSince || Infinity) };
    const parts = PROFILE.needNear ? null : [PROFILE.panel && st.pop, PROFILE.list && st.grid].filter(Boolean);
    const hidden = parts ? parts.every(x => !x.box) && now - Math.max(...parts.map(x => x.gone || now)) > T_HIDDEN
      : !st.pop.box && !st.grid.box && now - Math.min(st.pop.gone || now, st.grid.gone || now) > T_HIDDEN;
    const badAt = Math.min(st.badSince || Infinity, st.grid.badSince || Infinity);
    const hiddenSince = parts ? Math.max(...parts.map(x => x.gone || now)) : Math.max(st.pop.gone || now, st.grid.gone || now);
    if (hidden) return { since: hiddenSince, code: 'popup-hidden', text: PROFILE.needNear ? 'Neither the Live Entry pop-up nor the Visit Log is on the front-desk screen.' : `The check-in screen is not showing at the front desk: ${PROFILE.what} (${PROFILE.name}). If it is open, its look may have changed in an update: teach the reader again.` };
    if (badAt !== Infinity && now - badAt > T_UNREADABLE) return { since: badAt, code: 'labels-changed', text: PROFILE.needNear ? 'The Live Entry pop-up is there but the member number cannot be read.' : `The check-in screen is there but it cannot be read: ${PROFILE.what} (${PROFILE.name}). Make the window bigger, or teach it again.` };
    if (TL && st.grid.late.length >= 6 && st.grid.late.filter(Boolean).length * 2 > st.grid.late.length) return { code: 'list-late', text: `The check-in list at the front desk shows scans late (${PROFILE.name}): it may only refresh every so often. Turn on its live view or auto-refresh${PROFILE.panel ? ', or leave its pop-up open' : ''}.` };
    return core.baseHealth();
  };
  // Not a problem, but worth telling the gym: the pop-ups are read, but the
  // usual list isn't on the screen (an account or another page left open), so
  // nothing double-checks the pop-ups and a pop-up that closes fast could be missed.
  const deskNote = () => {
    const now = Date.now(), hasList = PROFILE.needNear || (PROFILE.panel && PROFILE.list);
    if (!hasList || st.paused || st.grid.box || !st.grid.gone || now - st.grid.gone < 10 * 60e3) return null;
    return { code: 'list-hidden', since: st.grid.gone, text: PROFILE.needNear ? 'The Visit Log is not showing on the front-desk screen (an account or another page left open?). Pop-ups are still read.' : `The check-in list is not showing on the front-desk screen (${PROFILE.name}). Pop-ups are still read.` };
  };
  const median = a => { if (!a.length) return 0; const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  // One scan, from either source. The same member within 5 min is one scan.
  const record = (member, zone, at, how, uncertain) => {
    if (member === '?') { member = 'unread-' + crypto.randomBytes(4).toString('hex'); uncertain = true; }   // a row whose member could not be read: still a scan
    // (A list with no pop-up: every new row is its own scan, already never counted twice,
    // so a member's real second entry a few minutes later isn't dropped.)
    const prev = st.recent.get(member);
    if (prev && Math.abs(at - prev) < DOUBLE_SEC * 1000 && !(how === 'list' && TL && !PROFILE.panel)) { core.counts.doubles++; return false; }
    st.recent.set(member, at);
    for (const [k, v] of st.recent) if (at - v > 2 * DOUBLE_SEC * 1000) st.recent.delete(k);
    core.noteScan(member, core.cfg.zone, at, { uncertain: !!uncertain });
    if (how === 'list') core.counts.fromList++;
    const lname = PROFILE.needNear ? 'the Visit Log' : 'the list';
    if (arg('print')) console.log(`SCAN ${((at - st.startedAt) / 1000).toFixed(1)}s ${member} ${zone || ''}${how === 'list' ? ` (from ${lname})` : ''}${how === 'both' ? ` (confirmed by ${lname})` : ''}${uncertain ? (PROFILE.needNear || how !== 'list' ? ' (UNCERTAIN: the two disagree)' : ' (UNCERTAIN)') : ''}`);
    return true;
  };
  // Same pop-up content as before? Member and zone must match; the entry
  // time is compared by its digits, and only when both reads have one.
  const sameContent = (a, b) => a.member === b.member && norm(a.zone || '') === norm(b.zone || '') && (!a.t || !b.t || a.t === b.t);
  // Everything a pop-up has shown lately (member + zone + entry time). Something
  // shown before is never a new scan: an account left open on the screen
  // coming back into view when the pop-up closes, or a pop-up reopened on the
  // last scan. A member who really scans again shows a new entry time, so
  // still counts (a screen with no time on it: after 10 minutes).
  const keyStr = k => `${k.member}|${norm(k.zone || '')}|${k.t || ''}`;
  st.popSeen = new Map();
  const remember = (k, at) => { st.popSeen.set(keyStr(k), at); for (const [x, v] of st.popSeen) if (at - v > 60 * 60e3) st.popSeen.delete(x); };
  const shownBefore = (k, at) => { const v = st.popSeen.get(keyStr(k)); return v !== undefined && at - v < (k.t ? 60 * 60e3 : 10 * 60e3); };
  // The entry time a pop-up shows. A new scan always shows the newest time;
  // something showing a time well before the newest one seen (a member's
  // account with their last visit, an old pop-up) is not a new scan. Only
  // the screen's own times are compared, never this computer's clock.
  // (A time whose AM/PM wasn't read is left out: it could be 12 hours off.)
  const popTime = r => { const rt = rowTime(String(r.time || '').split(/\s+/).filter(Boolean).map(t => ({ t }))); return rt && !rt.amb ? rt.minute : null; };
  const acceptPopup = (r, at) => {
    const key = { member: r.member, zone: r.zone, t: String(r.time || '').replace(/\D/g, '') };
    const pt = popTime(r);
    // The first pop-up seen is what was already there, unless the reader had already
    // seen the screen without one: then it just appeared, a scan.
    // (Also new: a first pop-up showing a later time than anything the Visit Log showed
    // when it was found, e.g. the pop-up that was there couldn't be read until a scan replaced it.)
    const g = st.grid, newer = pt && g.base && g.newest > 0 && at > (g.baseUntil || 0) && pt > g.newest + 60000;
    if (st.lastKey === undefined && !st.sawNoPop && !newer) { st.lastKey = key; remember(key, at); if (pt) st.popNewest = Math.max(st.popNewest || 0, pt); log('pop-up found; watching for new scans'); return; }
    if (st.lastKey === undefined) { st.lastKey = { member: null, zone: null, t: '' }; log('pop-up appeared; watching for new scans'); }
    // (The newest time the Visit Log showed counts too: the screen's own clock either way.)
    const newestSeen = Math.max(st.popNewest || 0, g.newest > 0 ? g.newest : 0);
    if (pt && newestSeen && pt < newestSeen - 10 * 60e3 && !sameContent(key, st.lastKey)) {
      remember(st.lastKey, at); st.lastKey = key; remember(key, at);
      core.counts.stale = (core.counts.stale || 0) + 1;
      log('the screen showed an older entry time (a member account, or an old pop-up): not a new scan');
      return;
    }
    if (pt) st.popNewest = Math.max(st.popNewest || 0, pt);
    if (sameContent(key, st.lastKey)) { if (key.t && !st.lastKey.t) st.lastKey = key; remember(st.lastKey, at); return; }
    remember(st.lastKey, at);                   // what it showed until now
    if (shownBefore(key, at)) {
      st.lastKey = key; remember(key, at);
      core.counts.reverts = (core.counts.reverts || 0) + 1;
      log('the screen went back to something it showed before (an account left open, or the last scan): not a new scan');
      return;
    }
    st.lastKey = key; remember(key, at);
    if (zoneWanted && r.zone && norm(r.zone) !== zoneWanted) { core.counts.otherZone++; return; }   // Iron Street etc. never leave this box
    if (r.denied) { core.counts.denied = (core.counts.denied || 0) + 1; log('the pop-up turned the member down (denied, expired...): not counted as a scan'); return; }
    st.cands.push({ src: 'pop', member: r.member, zone: r.zone, at, list: !!st.grid.box && st.grid.base });
  };
  const acceptRows = (rows, at) => {
    const g = st.grid;
    if (!g.base) { rows.forEach(r => g.seen.add(r.key)); g.newest = Math.max(g.newest, ...rows.filter(r => !r.amb).map(r => r.minute)); g.base = true; g.baseUntil = at + 8000; log('Visit Log found; watching it too'); return; }
    // The first seconds after it's found: rows a first read missed were already there, not new.
    if (at < (g.baseUntil || 0)) { rows.forEach(r => g.seen.add(r.key)); g.newest = Math.max(g.newest, ...rows.filter(r => !r.amb).map(r => r.minute)); return; }
    for (const r of rows) {
      if (g.seen.has(r.key) || (r.amb && g.seen.has(`${r.member}|${r.minute + 12 * 3600e3}|${norm(r.zone || '')}`))) continue;
      g.seen.add(r.key);
      // An older row scrolled into view, or came out from under the pop-up: not new.
      // (The pop-up's own entry time counts too: the top row can be hidden by it.)
      // (A row whose PM wasn't read is older only if it is older 12 hours later too.)
      if ((r.amb ? r.minute + 12 * 3600e3 : r.minute) < Math.max(g.newest, st.popNewest || 0) - 60000) continue;
      if (!r.amb) g.newest = Math.max(g.newest, r.minute);
      if (zoneWanted && r.zone && norm(r.zone) !== zoneWanted) { core.counts.otherZone++; continue; }
      st.cands.push({ src: 'list', member: r.member, zone: r.zone, at });
    }
    if (g.seen.size > 600) g.seen = new Set([...g.seen].slice(-300));
  };
  // A taught list: the rows before the part that lines up with what it
  // showed before are new scans (see alignList). Each is timed to the moment
  // its row appeared; when the row shows its own time and the list was
  // late (a screen that refreshes every so often), to that time instead.
  const followList = (frame, rows) => {
    const b = st.grid.box;
    if (!TL || TL.newest !== 'bottom' || !rows.length) return;
    const want = rows[0].top + b.th + 1.6 * b.rowH;
    if (want <= b.y + b.h || b.y + b.h >= H) return;
    st.grid.box = Object.assign(clampBox(b.x, b.y, b.x + b.w, want), { col: b.col, th: b.th, rowH: b.rowH, newest: b.newest, hdr: b.hdr });
    st.grid.sig = signature(frame, st.grid.box);
  };
  const pct = (a, q) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(q * b.length))]; };
  const acceptList = (rows, at) => {
    const g = st.grid, ids = rows.map(r => r.id);
    const lastShown = g.base ? g.lastShown || 0 : 0;
    for (const r of rows) if (r.clock) { const t = clockMs(r.clock, at, TL.tzOffMin); if (t <= at + 3 * 60e3) g.lastShown = Math.max(g.lastShown || 0, t); }   // the newest time it has shown
    if (!g.base) { g.hist = ids.slice(0, 80); g.base = true; g.baseUntil = at + 8000; log(`the check-in list found (${ids.length} row${ids.length === 1 ? '' : 's'}); watching for new rows`); return; }
    if (at < (g.baseUntil || 0) && !TL.timed) { if (ids.filter(x => x !== '?').length >= Math.min(2, ids.length)) g.hist = ids.slice(0, 80); return; }   // still settling: what it shows was there
    // Emptied (a new day). (Both reads found the header and no rows at all. A misread
    // can't add scans from this: a list that "fills up" with many rows at once counts none.)
    if (!ids.length) { if (g.hist.length) { g.prevHist = g.hist; g.hist = []; log('the check-in list is empty now (a new day?)'); } return; }
    let a = alignList(g.hist, ids);
    // A list that was empty can't fill up with many rows in a moment: that's a page loading, not scans.
    // (A list with times: only rows newer than anything it showed before can be scans that came in meanwhile.)
    // (Rows it showed before it emptied are never counted again: their time may have been misread.)
    let refilled = false;
    if (a && !g.hist.length && a.fresh > 3) {
      g.hist = ids.slice(0, 80);
      const before = new Set(g.prevHist || []);
      const newer = TL.timed && lastShown ? rows.filter(r => !before.has(r.id) && r.clock && clockMs(r.clock, at, TL.tzOffMin) > lastShown + (r.clock.s != null ? 0 : 60e3) - 1 && clockMs(r.clock, at, TL.tzOffMin) > at - 10 * 60e3) : [];
      log(`the check-in list filled with ${ids.length} rows at once: taken as already there${newer.length ? `; ${newer.length} newer row(s) counted by their times` : ', nothing counted'}`);
      if (!newer.length) return;
      rows = newer; a = { fresh: newer.length, older: [] }; refilled = true;
    }
    if (refilled) { /* the list is taken as it is now (above) */ }
    else if (!a) {
      const before = new Set((g.hist || []).concat(g.prevHist || []));
      g.hist = ids.slice(0, 80); core.counts.listResets = (core.counts.listResets || 0) + 1;
      // A list with times: rows newer than anything it showed before are scans that came in meanwhile.
      const newer = TL.timed && lastShown ? rows.filter(r => !before.has(r.id) && r.clock && clockMs(r.clock, at, TL.tzOffMin) > lastShown + (r.clock.s != null ? 0 : 60e3) - 1 && clockMs(r.clock, at, TL.tzOffMin) > at - 10 * 60e3) : [];
      log(`the check-in list shows something else now (another page, a search or a new day): starting again from it${newer.length ? `; ${newer.length} newer row(s) counted by their times` : ', nothing counted'}`);
      if (!newer.length) return;
      rows = newer; a = { fresh: newer.length, older: [] };
      g.hist = ids.slice(0, 80);
    }
    else {
      if (a.older.length) g.hist = g.hist.concat(a.older).slice(0, 80);       // older rows scrolled into view
      if (!a.fresh) return;
      g.hist = ids.slice(0, a.fresh).concat(g.hist).slice(0, 80);
    }
    for (const r of rows.slice(0, a.fresh).reverse()) {                     // oldest of the new ones first
      if (r.denied) { core.counts.denied = (core.counts.denied || 0) + 1; log('a turned-down check-in (denied, expired...): not counted as a scan'); continue; }
      if (TL.zone && r.zone && r.zone !== TL.zone) { core.counts.otherZone = (core.counts.otherZone || 0) + 1; continue; }   // another door or area
      let when = at, unsure = false;
      if (r.clock) {
        const shown = clockMs(r.clock, at, TL.tzOffMin);
        // A row showing a time long ago is history coming into view (a reload, a scrolled or filtered
        // list), not a scan. "Long ago" is judged against the PC's clock as the newest rows show it
        // (learned as rows come in, so a PC clock that gets changed later is followed).
        g.offs.push(shown - at); if (g.offs.length > 7) g.offs.shift();
        const off = g.offs.length >= 3 ? pct(g.offs, 0.5) : 0;
        if (TL.timed && shown - off < at - 10 * 60e3) { core.counts.oldRows = (core.counts.oldRows || 0) + 1; log(`a row came into view showing ${Math.round((at - shown + off) / 60e3)} min ago: not a new scan`); continue; }
        if (r.clock.s != null) {
          g.skews.push(shown - at); if (g.skews.length > 20) g.skews.shift();
          const est = shown - pct(g.skews, 0.8);                           // the PC's clock is a little off: learned from live rows
          const late = at - est > 12e3; g.late.push(late); if (late) when = est;
        } else {
          // Shown to the minute only: the PC's clock can't be worse than the largest (shown - seen) so far.
          g.mskews.push(shown - at); if (g.mskews.length > 20) g.mskews.shift();
          const m0 = shown - Math.max(...g.mskews);
          const late = at > m0 + 75e3; g.late.push(late); if (late) { when = m0 + 30e3; unsure = true; }
        }
        if (g.late.length > 10) g.late.shift();
      }
      if (zoneWanted) { /* lists of taught systems have no zone */ }
      st.cands.push({ src: 'list', member: r.id, unread: r.id === '?', zone: null, at: when, uncertain: unsure });
    }
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
      const same = lists.find(x => x.member === c.member) || lists.find(x => x.unread && Math.abs(x.at - c.at) < GRACE_MS);
      if (same) { used.add(c); used.add(same); core.counts.confirmed++; st.delays.push(same.at - c.at); if (st.delays.length > 30) st.delays.shift(); record(c.member, c.zone, c.at, 'both'); continue; }
      if (lists.length && now - c.at < GRACE_MS + 45000) continue;   // the list may still show it: wait a bit longer
      const other = lists.find(x => Math.abs(x.at - c.at) < GRACE_MS && !st.cands.some(y => y.src === 'pop' && y !== c && y.member === x.member));
      used.add(c);
      if (other) { used.add(other); core.counts.conflicts = (core.counts.conflicts || 0) + 1; log('the pop-up and the Visit Log showed different numbers for one scan: sent as uncertain'); record(c.member, c.zone, c.at, 'popup', true); continue; }
      record(c.member, c.zone, c.at, 'popup');
    }
    // (A taught screen with no pop-up showing has nothing to wait for.)
    const listWait = PROFILE.needNear || (PROFILE.panel && st.pop.box) ? GRACE_MS + 45000 : 0;
    for (const c of st.cands) {
      if (c.src !== 'list' || used.has(c) || now - c.at < listWait) continue;
      if (st.cands.some(p => p.src === 'pop' && !used.has(p) && p.member === c.member && Math.abs(p.at - c.at) < 60000)) continue;   // its pop-up read is still waiting
      used.add(c);
      if (record(c.member, c.zone, c.at - Math.max(0, median(st.delays)), 'list', c.uncertain) && PROFILE.needNear) log('a scan the pop-up did not show was taken from the Visit Log');
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
      if (job.kind === 'grid' && TL) {
        const l = await readTaughtList(job.frame, job.box);
        if (!l.found) { st.grid.box = null; st.grid.gone = job.at; st.lastLocate = 0; return; }   // covered, closed or another page
        if (!l.ok) { if (!st.grid.badSince) st.grid.badSince = job.at; return; }
        st.grid.badSince = 0;
        const before = st.grid.hist.join('|');
        acceptList(l.rows, job.at);
        st.grid.idle = st.grid.hist.join('|') === before ? (st.grid.idle || 0) + 1 : 0;
        followList(job.frame, l.rows);
        return;
      }
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
      const was = JSON.stringify(st.lastKey);
      acceptPopup(r, job.at);                   // the moment it changed, not when the read finished
      st.pop.idle = JSON.stringify(st.lastKey) === was ? (st.pop.idle || 0) + 1 : 0;
    });
  };
  // Watch one part of the screen: queue a read once a change has settled.
  // (A taught screen that keeps changing without anything new, like a clock
  // ticking inside the watched area, is read at most every 2 s after 5 empty
  // reads in a row. A scan is still timed to when its change first showed.)
  const watch = (part, kind, frame, at) => {
    const sig = signature(frame, part.box);
    const d = part.sig ? sigDiff(sig, part.sig) : 0; part.sig = sig;
    if (d > 18) { if (!part.dirtyAt) part.dirtyAt = at; return; }
    if (!part.dirtyAt) return;
    if (!PROFILE.needNear && (part.idle || 0) >= 5 && at - (part.readAt || 0) < 2000) return;
    if (todo.length < 40) todo.push({ kind, frame, box: part.box, at: part.dirtyAt });
    part.dirtyAt = 0; part.readAt = at;
    pump();
  };
  const onFrame = (frame, at) => {
    st.lastFrameAt = Date.now(); st.lastVirtual = at;
    const b = brightness(frame);
    if (b.mean < 10 && b.sd < 6) {               // black: start fresh when it's back, and look straight away
      if (!st.blackSince) st.blackSince = at;
      st.pop.box = null; st.grid.box = null; st.grid.base = false; st.lastLocate = 0; st.locateSig = null; todo.length = 0;
      return;
    }
    st.blackSince = 0;
    if (st.pop.box) watch(st.pop, 'pop', frame, at);
    if (st.grid.box) watch(st.grid, 'grid', frame, at);
    const needPop = PROFILE.needNear || !!PROFILE.panel, needGrid = PROFILE.needNear || !!PROFILE.list;
    if ((st.pop.box || !needPop) && (st.grid.box || !needGrid)) return;
    // The pop-up closed: watch the spot where it was, and the moment
    // something appears there (the next scan's pop-up), look straight away.
    // The scan is timed to when it appeared.
    // The same for the list: the moment its spot changes (staff back on the check-in
    // page after another page), look straight away, so its new rows are on time.
    const spots = [];
    if (needPop && !st.pop.box && st.pop.lastBox) spots.push(['pop', st.pop.lastBox]);
    if (needGrid && !st.grid.box && st.grid.lastBox) spots.push(['grid', st.grid.lastBox]);
    st.near = st.near || {};
    for (const [k, nb] of spots) {
      const ns = signature(frame, nb);
      const n = st.near[k] = st.near[k] && st.near[k].box === nb ? st.near[k] : { box: nb, sig: null, dirtyAt: 0 };
      const d = n.sig ? sigDiff(ns, n.sig) : 0; n.sig = ns;
      if (d > 18) { if (!n.dirtyAt) n.dirtyAt = at; continue; }   // (still changing: the regular look below still runs)
      if (n.dirtyAt && !st.busy && !todo.length) {
        const t0 = n.dirtyAt; n.dirtyAt = 0;
        st.lastLocate = at; st.locateSig = signature(frame, { x: 0, y: 0, w: W, h: H });
        work(() => found(frame, k === 'pop' ? t0 : at));
        return;
      }
    }
    // Something missing: look for it only when the screen has changed since
    // the last look (or every few minutes), not in a constant loop.
    if (st.busy || todo.length) return;
    const whole = signature(frame, { x: 0, y: 0, w: W, h: H });
    const changed = !st.locateSig || sigDiff(whole, st.locateSig) > 18;
    // (A test run on a video uses the same gaps, in video time, so it behaves like the gym.)
    const minGap = LOCATE_EVERY_MS, maxGap = 5 * 60e3;
    if (st.lastLocate && (at - st.lastLocate < minGap || (!changed && at - st.lastLocate < maxGap))) return;
    st.lastLocate = at; st.locateSig = whole;
    work(() => found(frame, at));
  };
  // One look at the whole screen (the old pop-up spot first): take up what's there.
  const found = async (frame, at) => {
      const f = await locate(frame, st.pop.box ? null : st.pop.lastBox);
      if (f.pop && !st.pop.box) {
        Object.assign(st.pop, { box: f.pop, lastBox: f.pop, sig: signature(frame, f.pop), gone: 0 });
        saveSpot(f.pop);
        const r = await readPopup(frame, f.pop);
        if (r.ok) { acceptPopup(r, at); st.badSince = 0; } else if (r.found && !st.badSince) st.badSince = at;
      } else if (!f.pop && !st.pop.box && !st.pop.gone) st.pop.gone = at;
      if (!f.pop && !f.partial) st.sawNoPop = true;
      if (f.grid && !st.grid.box && TL) {
        // Gone a while: start fresh from what it shows (a list with times keeps going: its times tell new from old).
        if (st.grid.base && at - st.grid.gone > (TL.timed ? 10 * 60e3 : 60e3)) st.grid.base = false;
        Object.assign(st.grid, { box: f.grid, lastBox: f.grid, sig: signature(frame, f.grid), gone: 0 });
        const l = await readTaughtList(frame, f.grid);
        if (l.found && l.ok) acceptList(l.rows, at);
      } else if (f.grid && !st.grid.box) {
        if (st.grid.base && at - st.grid.gone > 10 * 60e3) st.grid.base = false;   // gone a long time: start fresh
        Object.assign(st.grid, { box: f.grid, lastBox: f.grid, sig: signature(frame, f.grid), gone: 0 });
        const rows = await readGrid(frame, f.grid);
        if (rows.length) acceptRows(rows, at);
      } else if (!f.grid && !f.partial && !st.grid.box && !st.grid.gone) st.grid.gone = at;
  };
  let attempt = 0, paused = false;
  const profileAt = mtimeOf(profileFile());
  const go = () => { proc = startFrames(source, onFrame, (code, err) => {
    attempt++;
    if (source && source.startsWith('file:')) { ending = true; return; }
    if (paused) return;                          // --teach has the capture stick; started again after
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
    if (mtimeOf(profileFile()) !== profileAt && !String(source || '').startsWith('file:')) { log('check-in screen taught again: restarting'); process.exit(0); }
    if (!String(source || '').startsWith('file:')) {
      if (pausedNow() && !paused) { paused = st.paused = true; log('paused: the capture stick is being used by --teach'); try { proc && proc.kill('SIGKILL'); } catch (e) { /* gone */ } }
      else if (!pausedNow() && paused) { paused = st.paused = false; st.lastFrameAt = Date.now(); log('resumed'); st.lastKey = undefined; st.grid.base = false; go(); }
    }
    settle(fast ? (st.lastVirtual || now) : now);
    try { if (now - lastTrust > 60e3) { lastTrust = now; await core.refreshTrust(); } } catch (e) { log('trust check failed: ' + netWords(e)); }
    const h = health();
    core.note = h ? null : deskNote();
    try { await core.flush(h && h.text); } catch (e) { log('send failed, will retry: ' + netWords(e)); }
    if (now - lastStatus > 5 * 60e3 || String(h && h.code) !== String(lastCode) || String(core.note && core.note.code) !== String(st.lastNote)) {
      st.lastNote = core.note && core.note.code;
      try { await core.status(h); lastStatus = now; lastCode = h && h.code; if (h) log('problem: ' + h.code); } catch (e) { /* next time */ }
    }
  };
  const timer = setInterval(() => { tick(); if (ending && !st.busy && !todo.length) { clearInterval(timer); setTimeout(() => { settle(Infinity); tick2().then(() => process.exit(0)); }, 300); } }, fast ? 500 : 5000);
  tick();
}

if (require.main === module) {
  if (arg('setup')) setup().catch(e => { console.log('Something went wrong: ' + e.message); process.exit(1); });
  else if (arg('teach')) teach().catch(e => { console.log('Something went wrong: ' + e.message); process.exit(1); });
  else if (arg('forget')) { try { fs.unlinkSync(profileFile()); console.log('Back to reading Ashbourne. Restart the service (or reboot the Pi).'); } catch (e) { console.log('Nothing to forget: it already reads Ashbourne.'); } }
  else if (arg('check')) { useProfile(loadProfile()); const core = new ReaderCore({ dir: stateDir(), name: 'screen-reader', version: VERSION }); const src = arg('source') || (core.cfg && core.cfg.source); checkOnce(src).then(r => (!r.ok && /No picture/.test(r.msg)) ? checkOnce(src, true) : r).then(r => { console.log((r.ok ? '✓ ' : '✗ ') + r.msg); process.exit(r.ok ? 0 : 1); }); }
  else run();
}
module.exports = { codeId, readFields, findLabels, digits, zoneOf, locate, readPopup, readGrid, readGridRows, lineSegments, ocr, VERSION, teachFind, labelFor, profileFrom, cleanProfile, profileToSave, useProfile, ASHBOURNE,
  nameId, cellsOf, clockIn, clockMs, columnsOf, headerOf, findList, readTaughtList, alignList };
