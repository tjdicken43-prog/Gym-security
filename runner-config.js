// Config loading + validation for rtsp-run.js.
//
// The person editing rtsp-zones.json is usually typing on a borrowed Mac
// at night, so every problem here must come back as ONE plain sentence
// saying what is wrong, where, and what to do about it. Never print a
// password or token.

const fs = require('fs');
const path = require('path');

// ---------- masking ----------

// rtsp://user:pass@host:554/x  ->  rtsp://***@host:554/x
function maskUrl(u) {
  if (typeof u !== 'string') return String(u);
  return u.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\/\s]*@/gi, '$1***@');
}

// Mask URLs, and also any literal secret we know about (a password can
// appear on its own in ffmpeg output, e.g. inside a quoted argument).
function maskText(text, secrets) {
  let out = maskUrl(String(text || ''));
  for (const s of secrets || []) {
    if (s && s.length >= 3) out = out.split(s).join('***');
  }
  return out;
}

function secretsOf(cfg) {
  const out = [];
  if (cfg && cfg.runnerToken) out.push(String(cfg.runnerToken));
  for (const z of (cfg && cfg.zones) || []) {
    const pw = passwordOf(z && z.cameraUrl);
    if (pw) { out.push(pw); try { out.push(decodeURIComponent(pw)); } catch (e) { /* bad % */ } }
  }
  return out;
}

function passwordOf(u) {
  if (typeof u !== 'string') return null;
  const m = u.match(/^[a-z][a-z0-9+.-]*:\/\/([^@\/\s]*)@/i);
  if (!m) return null;
  const i = m[1].indexOf(':');
  return i === -1 ? null : m[1].slice(i + 1);
}

// ---------- JSON parse diagnostics ----------

function lineCol(text, pos) {
  let line = 1, col = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 1; } else col++;
  }
  return { line, col };
}

// Walk the text once, outside strings, and find the first thing that is
// a known hand-editing mistake. Returns { pos, problem, fix } or null.
function findCommonJsonMistake(text) {
  // Smart quotes anywhere (even inside a string they are almost always
  // an autocorrect accident, and outside one they break parsing).
  const sq = text.search(/[“”‘’]/);
  if (sq !== -1) {
    return {
      pos: sq,
      problem: `curly "smart" quote ${text[sq]} found`,
      fix: 'retype that quote as a plain straight " (in TextEdit: Edit > Substitutions > turn OFF Smart Quotes, then retype).',
    };
  }
  const stack = [];
  let inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      else if (c === '\n') return { pos: i, problem: 'a quoted value is not closed before the end of the line', fix: 'add the missing " at the end of the value.' };
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) {
      return { pos: i, problem: 'a // comment was found', fix: 'JSON files cannot contain comments — delete the // and everything after it on that line.' };
    }
    if (c === "'") return { pos: i, problem: "a single quote ' was used", fix: 'JSON needs double quotes " around every name and text value.' };
    if (c === '{' || c === '[') stack.push({ c, i });
    else if (c === '}' || c === ']') {
      const want = c === '}' ? '{' : '[';
      const top = stack.pop();
      if (!top) return { pos: i, problem: `there is an extra ${c}`, fix: `delete that ${c} (it has no matching ${want}).` };
      if (top.c !== want) {
        const need = top.c === '{' ? '}' : ']';
        return { pos: i, problem: `found ${c} but the ${top.c} opened on line ${lineCol(text, top.i).line} was never closed`, fix: `add a ${need} before this ${c}.` };
      }
    } else if (c === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') {
        return { pos: i, problem: `trailing comma before ${text[j]}`, fix: `delete this comma — the last item before a ${text[j]} must not have one.` };
      }
    } else if (c === '\n') {
      // "a": 1 <newline> "b": 2   -> missing comma
      let k = i - 1;
      while (k >= 0 && /[ \t\r]/.test(text[k])) k--;
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (k >= 0 && /["\d}\]el]/.test(text[k]) && text[j] === '"' && stack.length && stack[stack.length - 1].c === '{') {
        return { pos: k + 1, problem: 'a comma is missing at the end of this line', fix: 'add a , at the end of this line (every item except the last needs one).' };
      }
    }
  }
  if (inStr) return { pos: text.length, problem: 'a quoted value is never closed', fix: 'add the missing ".' };
  if (stack.length) {
    const top = stack[stack.length - 1];
    const need = top.c === '{' ? '}' : ']';
    return { pos: top.i, problem: `the ${top.c} opened here is never closed`, fix: `add a ${need} at the right place (usually the end of the file).` };
  }
  return null;
}

function explainJsonError(text, err) {
  const hint = findCommonJsonMistake(text);
  let pos = null;
  const m = String(err.message).match(/position (\d+)/);
  if (m) pos = Number(m[1]);
  const at = hint ? hint.pos : pos;
  const where = at != null ? lineCol(text, at) : null;
  const lines = [];
  lines.push(`rtsp-zones.json is not valid JSON${where ? ` — line ${where.line}, column ${where.col}` : ''}.`);
  if (where) {
    const src = text.split('\n')[where.line - 1] || '';
    lines.push(`    ${maskUrl(src.replace(/\t/g, ' ').slice(0, 110))}`);
    lines.push(`    ${' '.repeat(Math.max(0, Math.min(where.col - 1, 110)))}^`);
  }
  if (hint) {
    lines.push(`Problem: ${hint.problem}.`);
    lines.push(`Do this: ${hint.fix}`);
  } else {
    lines.push(`Problem: ${err.message.replace(/ in JSON.*$/, '')}.`);
    lines.push('Do this: check that line for a missing comma, quote or bracket — or re-run node setup-camera.js to rewrite the file.');
  }
  return lines.join('\n');
}

// ---------- validation ----------

const SENS = ['all', 'moderate', 'fast'];

function isNetworkUrl(u) { return /^(rtsps?|https?|rtmp|udp|tcp|srt):\/\//i.test(u); }

// Returns { cfg, errors:[], warnings:[] }. errors are fatal.
function validateConfig(raw, opts) {
  const o = opts || {};
  const errors = [], warnings = [];
  const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : null;
  if (!cfg) return { cfg: null, errors: ['rtsp-zones.json must be an object that starts with { and ends with }.'], warnings };

  if (!cfg.gymCode || typeof cfg.gymCode !== 'string') {
    warnings.push('No "gymCode" set — events will be filed under "default". Do this: add "gymCode": "yourgym".');
  }
  if (cfg.dailyBurstCap != null) {
    const n = Number(cfg.dailyBurstCap);
    if (!Number.isFinite(n) || n <= 0) errors.push(`"dailyBurstCap" must be a number above 0 (it is ${JSON.stringify(cfg.dailyBurstCap)}).`);
    else cfg.dailyBurstCap = Math.round(n);
  }
  for (const k of ['scheduleStart', 'scheduleEnd']) {
    if (cfg[k] == null || cfg[k] === '') { cfg[k] = null; continue; }
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(cfg[k]))) errors.push(`"${k}" must look like "21:00" (24-hour clock). It is ${JSON.stringify(cfg[k])}.`);
  }
  if (!!cfg.scheduleStart !== !!cfg.scheduleEnd) warnings.push('Only one of scheduleStart / scheduleEnd is set, so the schedule is ignored (always on).');
  if (cfg.sensitivity != null && !SENS.includes(cfg.sensitivity)) {
    warnings.push(`"sensitivity" ${JSON.stringify(cfg.sensitivity)} is not one of ${SENS.join(', ')} — using "moderate".`);
    cfg.sensitivity = 'moderate';
  }

  // Remote mode
  if (cfg.serverUrl != null && cfg.serverUrl !== '') {
    let u = null;
    try { u = new URL(String(cfg.serverUrl).trim()); } catch (e) { /* below */ }
    if (!u || !/^https?:$/.test(u.protocol)) {
      errors.push(`"serverUrl" must start with https:// (it is ${JSON.stringify(maskUrl(String(cfg.serverUrl)))}).`);
    } else {
      if (u.pathname !== '/' && u.pathname !== '') warnings.push(`"serverUrl" should be just the site address — using ${u.origin} (ignoring "${u.pathname}").`);
      if (u.protocol === 'http:' && !/^(localhost|127\.|192\.168\.|10\.)/.test(u.hostname)) warnings.push('"serverUrl" uses http:// — use https:// so the token is not sent in the clear.');
      cfg.serverUrl = u.origin;
      if (!cfg.runnerToken || typeof cfg.runnerToken !== 'string') {
        errors.push('"serverUrl" is set but "runnerToken" is missing — this computer is not paired with the website. Do this: node pair.js');
      } else if (cfg.runnerToken.trim() !== cfg.runnerToken) {
        cfg.runnerToken = cfg.runnerToken.trim();
        warnings.push('"runnerToken" had spaces at the start or end — removed them.');
      }
    }
  } else {
    cfg.serverUrl = null;
  }

  if (!Array.isArray(cfg.zones) || !cfg.zones.length) {
    errors.push('"zones" is missing or empty — there is no camera to watch. Do this: run node setup-camera.js.');
    return { cfg, errors, warnings };
  }

  const labels = new Set();
  cfg.zones = cfg.zones.map((zr, idx) => {
    const name = `Zone ${idx + 1}${zr && zr.label ? ` ("${zr.label}")` : ''}`;
    if (!zr || typeof zr !== 'object') { errors.push(`${name} is not an object { ... }.`); return null; }
    const z = { ...zr };
    if (!z.label || typeof z.label !== 'string' || !z.label.trim()) {
      z.label = `Zone ${idx + 1}`;
      warnings.push(`${name} has no "label" — calling it "${z.label}".`);
    }
    z.label = z.label.trim();
    if (labels.has(z.label.toLowerCase())) errors.push(`Two zones are both called "${z.label}" — give each a different "label".`);
    labels.add(z.label.toLowerCase());

    // expectedCount
    if (z.expectedCount == null) z.expectedCount = 1;
    const ec = Number(z.expectedCount);
    if (!Number.isInteger(ec) || ec < 1) { errors.push(`${name}: "expectedCount" must be a whole number, 1 or more.`); }
    else z.expectedCount = ec;
    z.accessibleGate = !!z.accessibleGate;

    // cameraUrl
    const u = z.cameraUrl;
    if (!u || typeof u !== 'string') {
      errors.push(`${name}: "cameraUrl" is missing. Do this: run node setup-camera.js.`);
    } else {
      checkCameraUrl(z, name, errors, warnings, o);
    }

    // crop
    let cropSet = false;
    for (const k of ['cropX', 'cropY', 'cropW', 'cropH']) {
      if (z[k] == null || z[k] === '') { delete z[k]; continue; }
      const n = Number(z[k]);
      if (!Number.isFinite(n)) { errors.push(`${name}: "${k}" must be a number (it is ${JSON.stringify(z[k])}).`); continue; }
      if (n < 0) { errors.push(`${name}: "${k}" cannot be negative (it is ${n}).`); continue; }
      if ((k === 'cropW' || k === 'cropH') && n < 16) { errors.push(`${name}: "${k}" is ${n} — far too small. Use at least 100, or delete the crop fields to watch the whole picture.`); continue; }
      z[k] = Math.round(n);
      cropSet = true;
    }
    z.cropSet = cropSet;
    // The picture size the box was drawn on (setup-camera.js saves it), so
    // the runner can scale the box if the camera's picture size changes.
    if (z.frameW != null || z.frameH != null) {
      const fw = Number(z.frameW), fh = Number(z.frameH);
      if (Number.isFinite(fw) && Number.isFinite(fh) && fw >= 16 && fh >= 16) { z.frameW = Math.round(fw); z.frameH = Math.round(fh); }
      else { delete z.frameW; delete z.frameH; warnings.push(`${name}: "frameW"/"frameH" are not both sensible numbers — ignoring them.`); }
    }
    return z;
  }).filter(Boolean);

  return { cfg, errors, warnings };
}

function checkCameraUrl(z, name, errors, warnings, o) {
  let u = z.cameraUrl;
  if (u !== u.trim()) { u = u.trim(); warnings.push(`${name}: "cameraUrl" had spaces at the start or end — removed them.`); }
  z.cameraUrl = u;
  const masked = maskUrl(u);

  if (/^(rstp|rtps|rtst|rtp|rsp|rtsp:\/[^\/])/i.test(u) || /^rtsp:\\/i.test(u)) {
    errors.push(`${name}: "cameraUrl" is misspelt at the start (${masked.slice(0, 12)}…). Do this: it must start with rtsp://`);
    return;
  }
  if (!isNetworkUrl(u)) {
    // allow a local video file (used for testing and for replaying footage)
    const p = path.resolve(o.baseDir || process.cwd(), u);
    if (fs.existsSync(p)) { z.cameraUrl = p; z.isFile = true; return; }
    errors.push(`${name}: "cameraUrl" must start with rtsp:// (it is ${JSON.stringify(masked.slice(0, 40))}).`);
    return;
  }
  if (/\s/.test(u)) errors.push(`${name}: "cameraUrl" contains a space. Do this: remove it — camera addresses never contain spaces.`);
  if (/[“”‘’]/.test(u)) errors.push(`${name}: "cameraUrl" contains a curly quote — retype it as a plain ".`);

  let parsed = null;
  try { parsed = new URL(u); } catch (e) { /* below */ }
  if (!parsed || !parsed.hostname) {
    errors.push(`${name}: "cameraUrl" is not a valid address (${masked}). Do this: run node setup-camera.js to build it for you.`);
    return;
  }
  if (parsed.hash) warnings.push(`${name}: "cameraUrl" contains a # — if it is in the password, write it as %23 instead.`);
  if (/%21/i.test(u)) warnings.push(`${name}: the password contains %21. This NVR wants the ! typed as-is. Do this: replace %21 with ! in rtsp-zones.json.`);
  // a stray % that is not %XX (e.g. "channel=4%subtype=0" — meant &)
  const badPct = u.match(/%(?![0-9a-f]{2})/i);
  if (badPct) warnings.push(`${name}: "cameraUrl" has a % that is not part of an encoding — did you mean & ? (e.g. channel=4&subtype=0)`);
  if (/realmoniter|realmonitr|relamonitor|realmonior/i.test(u)) errors.push(`${name}: "realmonitor" is misspelt in the camera address. Do this: it is spelt r-e-a-l-m-o-n-i-t-o-r.`);
  // noChannelOk: setup-camera.js saves it when the person confirmed that
  // camera 1 really is the entrance (a recorder with only a bare address).
  if (/^rtsps?:$/i.test(parsed.protocol) && (parsed.pathname === '/' || parsed.pathname === '') && !parsed.search && !z.noChannelOk) {
    warnings.push(`${name}: "cameraUrl" ends in :${parsed.port || 554}/ with no channel. On this recorder that address always shows camera 1 (the pro shop), not the door, so it will not be watched. Do this: run node setup-camera.js`);
    z.noChannel = true;
    addZoneWarning(z, 'The camera address has no channel number, so this recorder always sends camera 1 (the pro shop), not the door. Fix: run node setup-camera.js on the camera computer and pick the door channel.');
  }
  if (/[?&]channel=(\d+)/i.test(u)) z.channel = Number(u.match(/[?&]channel=(\d+)/i)[1]);
  if (/[?&]subtype=0\b/i.test(u)) z.mainStream = true;
  if (/[?&]subtype=1\b/i.test(u)) z.subStream = true;
}

// Short, plain warnings about one zone, meant for the website too (the
// runner sends them in its heartbeat, so they show on the admin page even
// when nobody can see this computer's screen). Not saved to the file.
function addZoneWarning(z, text) {
  if (!Object.prototype.hasOwnProperty.call(z, 'warnings')) Object.defineProperty(z, 'warnings', { value: [], enumerable: false, writable: true });
  if (!z.warnings.includes(text)) z.warnings.push(text);
}

// Is a watched area this wide too big for the 12x12 motion grid? True for
// the whole of a big picture (Friday: all 4096 px) or anything over 2560.
function tooWide(w, frameW) {
  return w > 2560 || (frameW > 1920 && w >= 0.9 * frameW);
}

// Settings that "work" but will watch the wrong thing or miss people.
// update.js will not switch on the background monitor while any of these
// are true — a background monitor with no screen would hide them.
// Returns plain sentences; [] = fine.
function setupProblems(cfg) {
  const out = [];
  for (const z of (cfg && cfg.zones) || []) {
    const who = (cfg.zones.length > 1 ? `${z.label}: ` : '');
    if (z.noChannel) out.push(`${who}the camera address has no channel number, so it shows camera 1 (the pro shop), not the door.`);
    const watchedW = z.cropSet ? (z.cropW != null ? z.cropW : null) : (z.frameW || null);
    if (watchedW && tooWide(watchedW, z.frameW)) {
      out.push(`${who}it watches an area ${watchedW} pixels wide${!z.cropSet || (z.frameW && watchedW >= 0.9 * z.frameW) ? ' (the whole picture)' : ''} — a person is too small in that to be counted reliably. It needs a tight box around the door.`);
    }
  }
  return out;
}

// ---------- where things live ----------
//
// Settings live OUTSIDE the code folder, in ~/.securityai/, so that
// downloading a new version of the code (which lands in a new folder) or
// running node update.js can never lose them. The code itself lives in
// ~/securityai/ (node update.js puts it there). Both can be moved for
// tests with SECURITYAI_HOME / SECURITYAI_CODE_DIR.
const os = require('os');
function stateDir() { return process.env.SECURITYAI_HOME || path.join(os.homedir(), '.securityai'); }
function codeHome() { return process.env.SECURITYAI_CODE_DIR || path.join(os.homedir(), 'securityai'); }
function ensureStateDir() {
  const d = stateDir();
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(d, 0o700); } catch (e) { /* not ours to change */ }
  return d;
}
function statePath(name) { return path.join(stateDir(), name); }
const CONFIG_NAME = 'rtsp-zones.json';

// Pretty path for messages: /Users/joseph/.securityai/x -> ~/.securityai/x
function tildify(p) {
  const h = os.homedir();
  return h && p && (p === h || p.startsWith(h + path.sep)) ? '~' + p.slice(h.length) : p;
}

// Old installs kept rtsp-zones.json inside the code folder. Look where a
// downloaded copy is likely to be: this folder, the folder you are in, and
// one level inside Downloads / home.
function findOldConfigs(extraDirs) {
  const home = os.homedir();
  const dirs = new Set([process.cwd(), __dirname].concat(extraDirs || []));
  // Not Desktop/Documents (or Pictures, Library...): on a Mac, touching those
  // pops up "Terminal would like to access files in your Desktop folder".
  // A GitHub zip lands in Downloads.
  const skip = /^(Desktop|Documents|Library|Pictures|Movies|Music|Applications|Public)$/;
  for (const base of [path.join(home, 'Downloads'), home]) {
    dirs.add(base);
    let ents = [];
    try { ents = fs.readdirSync(base, { withFileTypes: true }); } catch (e) { continue; }   // e.g. macOS privacy block
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && !(base === home && skip.test(e.name))) dirs.add(path.join(base, e.name));
  }
  const found = [];
  for (const d of dirs) {
    const f = path.join(d, CONFIG_NAME);
    if (path.resolve(f) === path.resolve(statePath(CONFIG_NAME))) continue;
    try {
      const st = fs.statSync(f);
      if (!st.isFile() || st.size > 1024 * 1024) continue;
      const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
      if (j && typeof j === 'object' && (Array.isArray(j.zones) || j.serverUrl)) found.push({ file: f, mtime: st.mtimeMs });
    } catch (e) { /* not a usable config */ }
  }
  return found.sort((a, b) => b.mtime - a.mtime).map(x => x.file);
}

function moveFile(from, to) {
  try { fs.renameSync(from, to); } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    fs.copyFileSync(from, to); fs.unlinkSync(from);
  }
}

// Returns the config file to use. Order: explicit path / RTSP_CONFIG, then
// ~/.securityai/rtsp-zones.json. If that does not exist yet but an old
// in-folder one does, MOVE it there (and its unsent-crossings queue) and
// say so via log(). Never throws.
function resolveConfigPath(opts) {
  const o = opts || {};
  if (o.explicit) return path.resolve(o.explicit);
  if (process.env.RTSP_CONFIG) return path.resolve(process.env.RTSP_CONFIG);
  const target = statePath(CONFIG_NAME);
  if (fs.existsSync(target)) return target;
  let old = [];
  try { old = findOldConfigs(o.extraDirs); } catch (e) { /* ignore */ }
  if (!old.length) return target;
  try {
    ensureStateDir();
    const from = old[0];
    fs.copyFileSync(from, target);
    try { fs.chmodSync(target, 0o600); } catch (e) { /* ignore */ }
    fs.unlinkSync(from);
    for (const extra of [CONFIG_NAME + '.bak']) {
      try { if (fs.existsSync(path.join(path.dirname(from), extra))) moveFile(path.join(path.dirname(from), extra), statePath(extra)); } catch (e) { /* ignore */ }
    }
    const oldQueue = path.join(path.dirname(from), 'runner-queue');
    try {
      if (fs.existsSync(oldQueue)) {
        const q = statePath('runner-queue');
        fs.mkdirSync(q, { recursive: true });
        for (const f of fs.readdirSync(oldQueue)) moveFile(path.join(oldQueue, f), path.join(q, f));
        fs.rmdirSync(oldQueue);
      }
    } catch (e) { /* queue is best effort */ }
    if (o.log) o.log(`Moved your settings from ${tildify(from)} to ${tildify(target)} — from now on updates can never lose them.`);
  } catch (e) {
    if (o.log) o.log(`(Could not move ${tildify(old[0])} to ${tildify(target)}: ${e.message}. Using it where it is.)`);
    return old[0];
  }
  return target;
}

// ---------- finding ffmpeg ----------
//
// ffmpeg is one file. On the Mac it is often left where the zip was opened
// (~/Downloads), which works in Terminal but NOT for the background monitor:
// macOS does not let background jobs read Downloads, Desktop or Documents.
// prepareFfmpeg() copies it to ~/.securityai/bin (no password needed), and
// every part of the program looks there too.
function isExecFile(p) {
  try { if (!fs.statSync(p).isFile()) return false; fs.accessSync(p, fs.constants.X_OK); return true; } catch (e) { return false; }
}
function macProtected(p) {
  if ((process.env.SECURITYAI_PLATFORM || process.platform) !== 'darwin') return false;
  const h = os.homedir();
  return ['Downloads', 'Desktop', 'Documents'].some(d => path.resolve(p).startsWith(path.join(h, d) + path.sep));
}
function ownFfmpeg() { return path.join(stateDir(), 'bin', 'ffmpeg'); }
// ffmpeg files lying in Downloads (straight from the zip).
function downloadedFfmpegs() {
  const out = [];
  for (const b of ['Downloads'].map(d => path.join(os.homedir(), d))) {
    out.push(path.join(b, 'ffmpeg'));
    let ents = [];
    try { ents = fs.readdirSync(b, { withFileTypes: true }); } catch (e) { continue; }
    for (const e of ents) if (e.isDirectory() && /^ffmpeg/i.test(e.name)) out.push(path.join(b, e.name, 'ffmpeg'));
  }
  return out.filter(f => { try { return fs.statSync(f).isFile() && fs.statSync(f).size > 1e5; } catch (e) { return false; } });
}
// The ffmpeg to run: FFMPEG_PATH, then the PATH, then our copy, then the
// usual places. One outside the protected folders wins. 'ffmpeg' if none.
function findFfmpeg() {
  if (process.env.FFMPEG_PATH) return process.env.FFMPEG_PATH;
  const c = String(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(d => path.join(d, 'ffmpeg'))
    .concat([ownFfmpeg(), '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg']);
  const ok = [...new Set(c)].filter(isExecFile);
  return ok.find(f => !macProtected(f)) || ok[0] || 'ffmpeg';
}
// Make sure there is an ffmpeg the background monitor can run. Returns
// { path, copiedFrom? } or null if there is no ffmpeg on this computer.
function prepareFfmpeg() {
  if (process.env.FFMPEG_PATH) return { path: process.env.FFMPEG_PATH };
  const found = findFfmpeg();
  if (found !== 'ffmpeg' && !macProtected(found)) return { path: found };
  const src = found !== 'ffmpeg' ? found : downloadedFfmpegs()[0];
  if (!src) return null;
  const dst = ownFfmpeg();
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o700 });
    fs.copyFileSync(src, dst + '.tmp');
    fs.chmodSync(dst + '.tmp', 0o755);
    fs.renameSync(dst + '.tmp', dst);
    // Downloaded files are marked "from the internet"; macOS then refuses to
    // run them unattended. The copy is ours, so clear that mark (no password).
    if (process.platform === 'darwin') require('child_process').spawnSync('xattr', ['-d', 'com.apple.quarantine', dst], { stdio: 'ignore' });
    return { path: dst, copiedFrom: src };
  } catch (e) {
    return found !== 'ffmpeg' ? { path: found } : null;
  }
}

// The monitor named in runner.pid, if it is REALLY still running; else null.
// After a power cut or restart the file is left behind, and by then its
// process number may belong to something else (then the background monitor
// would wait for it for ever). So: a record written before this computer
// last started is stale, and the process must be an rtsp-run.js.
function runningMonitor(file) {
  let o;
  try { o = JSON.parse(fs.readFileSync(file || statePath('runner.pid'), 'utf8')); } catch (e) { return null; }
  if (!o || !Number.isInteger(o.pid) || o.pid <= 0) return null;
  const bootAt = Date.now() - os.uptime() * 1000;
  const started = Date.parse(o.startedAt);
  if (Number.isFinite(started) && started < bootAt - 60000) return null;
  try { process.kill(o.pid, 0); } catch (e) { if (e.code !== 'EPERM') return null; }
  try {
    const r = require('child_process').spawnSync('ps', ['-ww', '-p', String(o.pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0 && r.stdout && !/rtsp-run/.test(r.stdout)) return null;
    if (r.status === 1) return null;              // ps: no such process
  } catch (e) { /* no ps: trust the checks above */ }
  return o;
}

// Writes a file atomically with owner-only permissions (it holds passwords).
function writePrivate(file, text) {
  if (path.resolve(path.dirname(file)) === path.resolve(stateDir())) ensureStateDir();
  else fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (e) { /* ignore */ }
}

// Reads and validates. Never throws; returns { cfg, errors, warnings, file }.
function loadConfig(file) {
  if (!fs.existsSync(file)) {
    return { file, cfg: null, warnings: [], errors: [`No camera settings yet (looked for ${tildify(file)}). Do this: run node setup-camera.js (it writes them for you).`] };
  }
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  if (/^\s*\{\\rtf/.test(text)) {
    return { file, cfg: null, warnings: [], errors: ['rtsp-zones.json was saved by TextEdit as rich text, not plain text. Do this: open it in TextEdit, choose Format > Make Plain Text, then save.'] };
  }
  if (!text.trim()) return { file, cfg: null, warnings: [], errors: ['rtsp-zones.json is empty. Do this: run node setup-camera.js.'] };
  let raw;
  try { raw = JSON.parse(text); } catch (err) {
    return { file, cfg: null, warnings: [], errors: [explainJsonError(text, err)] };
  }
  const r = validateConfig(raw, { baseDir: path.dirname(file) });
  r.file = file;
  return r;
}

module.exports = {
  loadConfig, validateConfig, setupProblems, addZoneWarning, tooWide, explainJsonError, findCommonJsonMistake, maskUrl, maskText, secretsOf, isNetworkUrl,
  stateDir, codeHome, ensureStateDir, statePath, resolveConfigPath, findOldConfigs, writePrivate, tildify, CONFIG_NAME, runningMonitor,
  findFfmpeg, prepareFfmpeg, macProtected,
};
