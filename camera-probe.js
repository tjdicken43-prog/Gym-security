// Shared camera-probing helpers for setup-camera.js and find-camera.js.
// Node built-ins + the ffmpeg binary only. Works on Node 18, macOS and Linux.
//
// Everything that talks to the NVR goes through ffmpeg, on purpose: if
// ffmpeg can open a URL here, rtsp-run.js (which also uses ffmpeg) can
// open it too. We read ffmpeg's stderr to tell apart "wrong password"
// (401), "no such path" (404), "nobody answered" and so on.
//
// Nothing in here prints. Callers decide what to say. Nothing in here
// ever returns a password or token in a message: use maskUrl()/maskText().

const { spawn } = require('child_process');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');

// FFMPEG_PATH, the PATH, or ~/.securityai/bin/ffmpeg (setup-camera.js puts
// a copy there when ffmpeg was left in Downloads). setFfmpeg() changes it.
let FFMPEG = require('./runner-config').findFfmpeg();
function setFfmpeg(p) { if (p) FFMPEG = p; }

// ---------------------------------------------------------------------------
// URL formats, most likely first for this site (LTS PRO-X NVR, Dahua-style).
// `main(n)` / `sub(n)` return the path (no leading slash) for channel n.
// channelAware:false means the URL has no channel in it at all.
//
// Deliberately NOT included: formats that carry the password in the query
// string (XMeye "user=..&password=..", "h264?username=.."). They make
// masking unreliable and break on passwords containing & or =.
const FORMATS = [
  { id: 'dahua',    name: 'Dahua style (cam/realmonitor)',
    main: n => `cam/realmonitor?channel=${n}&subtype=0`, sub: n => `cam/realmonitor?channel=${n}&subtype=1` },
  { id: 'uniview',  name: 'Uniview style (unicast/cN/s0/live)',
    main: n => `unicast/c${n}/s0/live`, sub: n => `unicast/c${n}/s1/live` },
  { id: 'h264ch',   name: 'h264/chN/main/av_stream',
    main: n => `h264/ch${n}/main/av_stream`, sub: n => `h264/ch${n}/sub/av_stream` },
  { id: 'chav',     name: 'chN/main/av_stream',
    main: n => `ch${n}/main/av_stream`, sub: n => `ch${n}/sub/av_stream` },
  { id: 'hikvision', name: 'Hikvision style (Streaming/Channels/N01)',
    main: n => `Streaming/Channels/${n}01`, sub: n => `Streaming/Channels/${n}02` },
  { id: 'reolink',  name: 'Reolink style (h264Preview_NN_main)',
    main: n => `h264Preview_${String(n).padStart(2, '0')}_main`, sub: n => `h264Preview_${String(n).padStart(2, '0')}_sub` },
  { id: 'tvt',      name: 'TVT/Provision style (chID=N&streamType=main)',
    main: n => `chID=${n}&streamType=main&linkType=tcp`, sub: n => `chID=${n}&streamType=sub&linkType=tcp` },
];
// Last resort only. On the real NVR this ALWAYS shows camera 1.
const BARE_ROOT = { id: 'root', name: 'bare address (no channel)', channelAware: false, main: () => '', sub: null };
FORMATS.forEach(f => { f.channelAware = true; });

// ---------------------------------------------------------------------------
// Credentials in the URL.
//
// Tested with ffmpeg 6.1 against a fake server: ffmpeg PERCENT-DECODES the
// user and password before sending them (%40 -> @, %41 -> A, %20 -> space),
// and a raw # in the password makes ffmpeg reject the URL outright.
// So we encode exactly the characters that would otherwise break the URL or
// be mis-decoded: @ / : (URL structure), % (would be decoded), # ? (end the
// address), and whitespace. Everything else — notably ! — stays literal,
// which is the form proven to work on the gym's NVR ("gymai24!").
function encodeCred(s) {
  return String(s).replace(/[@\/:%#?\s]/g, c => encodeURIComponent(c));
}

function hostPort(host, port) {
  const h = /:/.test(host) && !/^\[/.test(host) ? `[${host}]` : host; // bare IPv6
  return `${h}:${port || 554}`;
}

// creds: { host, port, user, pass }
function buildUrl(creds, format, channel, opts) {
  const o = opts || {};
  const fn = o.sub ? format.sub : format.main;
  if (!fn) return null;
  const auth = creds.user || creds.pass
    ? `${encodeCred(creds.user || '')}${creds.pass ? ':' + encodeCred(creds.pass) : ''}@` : '';
  return `rtsp://${auth}${hostPort(creds.host, creds.port)}/${fn(channel)}`;
}

function maskUrl(u) {
  return String(u).replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\/\s]*@/gi, '$1***@');
}
function maskText(text, secrets) {
  let out = maskUrl(String(text || ''));
  for (const s of secrets || []) {
    if (s && s.length >= 2) {
      out = out.split(s).join('***');
      const enc = encodeCred(s);
      if (enc !== s) out = out.split(enc).join('***');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Input clean-up (smart quotes from Notes/Messages, stray spaces).
function normaliseInput(s) {
  const before = String(s == null ? '' : s);
  const after = before
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u00A0\u2007\u202F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
  return { value: after, changed: after !== before };
}

// "192.168.2.54", "rtsp://x@192.168.2.54:554/foo", "http://192.168.2.54/" ...
function parseHostInput(raw) {
  let s = normaliseInput(raw).value.trim();
  s = s.replace(/^[a-z]+:\/\//i, '').replace(/^[^@\/]*@/, '').replace(/[\/?#].*$/, '');
  let port = null;
  const m = s.match(/^(.*):(\d{1,5})$/);
  if (m && !/:.*:/.test(s)) { s = m[1]; port = parseInt(m[2], 10); }
  s = s.replace(/[\s,]+/g, '');
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (ipv4 && ipv4.slice(1).some(x => +x > 255)) return { error: `${s} is not a valid address (each number must be 0-255).` };
  if (!ipv4 && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(s)) return { error: `"${s}" doesn't look like an address. It should look like 192.168.2.54` };
  if (/^\d+(\.\d+){0,2}$/.test(s)) return { error: `"${s}" is missing part of the address. It should have four numbers, like 192.168.2.54` };
  return { host: s, port };
}

// ---------------------------------------------------------------------------
// Process helpers.

function runFfmpeg(args, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    let ff;
    try { ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
      return resolve({ spawnError: e, code: null, stderr: '', stdout: Buffer.alloc(0), timedOut: false });
    }
    let stderr = '';
    const out = [];
    let timedOut = false, done = false;
    const timer = setTimeout(() => { timedOut = true; try { ff.kill('SIGKILL'); } catch (e) { /* gone */ } }, o.timeoutMs || 15000);
    ff.stdout.on('data', d => out.push(d));
    ff.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 200000) stderr = stderr.slice(-100000); });
    ff.on('error', e => { if (done) return; done = true; clearTimeout(timer); resolve({ spawnError: e, code: null, stderr, stdout: Buffer.concat(out), timedOut }); });
    ff.on('close', code => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stderr, stdout: Buffer.concat(out), timedOut }); });
  });
}

async function ffmpegCheck() {
  const r = await runFfmpeg(['-hide_banner', '-version'], { timeoutMs: 10000 });
  if (r.spawnError || r.code !== 0) return { ok: false, notFound: !!(r.spawnError && r.spawnError.code === 'ENOENT') };
  const m = r.stdout.toString().match(/ffmpeg version (\S+)/);
  return { ok: true, version: m ? m[1] : 'unknown' };
}

// TCP connect to the RTSP port. Separates "refused" (the box is there but
// nothing listens on that port) from "timeout/unreachable" (we can't reach
// the box at all: wrong network, cable, or IP).
function tcpCheck(host, port, timeoutMs) {
  return new Promise(resolve => {
    const sock = net.connect({ host, port: port || 554 });
    let settled = false;
    const finish = r => { if (settled) return; settled = true; clearTimeout(t); sock.destroy(); resolve(r); };
    const t = setTimeout(() => finish({ ok: false, code: 'timeout' }), timeoutMs || 4000);
    sock.on('connect', () => finish({ ok: true }));
    sock.on('error', e => {
      const map = { ECONNREFUSED: 'refused', EHOSTUNREACH: 'unreachable', ENETUNREACH: 'unreachable',
        ETIMEDOUT: 'timeout', ENOTFOUND: 'dns', EAI_AGAIN: 'dns', EADDRNOTAVAIL: 'unreachable' };
      finish({ ok: false, code: map[e.code] || 'error', errno: e.code });
    });
  });
}

function localIPv4() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const a of ifs[name] || []) {
      // Node 18.0-18.3 reports family as the number 4
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push({ iface: name, address: a.address });
    }
  }
  return out;
}
function sameSubnet24(a, b) {
  const pa = String(a).split('.'), pb = String(b).split('.');
  return pa.length === 4 && pb.length === 4 && pa.slice(0, 3).join('.') === pb.slice(0, 3).join('.');
}

// ---------------------------------------------------------------------------
// Classifying what ffmpeg said.
//
// status is one of:
//   ok        picture decoded (codec + width/height filled in)
//   auth      401: username/password rejected
//   notfound  404: server doesn't know this path
//   refused   nothing listening on that port
//   timeout   no answer in time
//   unreachable / dns / noffmpeg / error
//
// IMPORTANT about 401. ffmpeg first sends each request without a password,
// gets a 401 challenge, and retries once WITH the password; only a second
// 401 reaches us. Many NVRs (Dahua firmware included) check the password
// BEFORE they look at the path, and some even demand it at OPTIONS, which
// is sent before any path is examined (stage "OPTIONS" below). So a 401
// tells us about the credentials only — it does NOT prove the path exists.
// (Friday's 401 on cam/realmonitor with a mistyped password therefore did
// not prove Dahua format; it only proved the password was wrong.)
// The only safe reaction to a 401 is: stop, and fix the credentials.
// Conversely a 404 is only possible once the server got past the password
// check, so on an auth-first server a 404 also means "password accepted".
function classify(res) {
  const err = res.stderr || '';
  const out = { status: 'error', stage: null, rtspCode: null };
  const video = err.match(/Stream #\d+:\d+[^\n]*?: Video: ([a-z0-9_]+)[^\n]*?[ ,](\d{2,5})x(\d{2,5})[ ,\[]/i);
  if (video) { out.codec = video[1]; out.width = +video[2]; out.height = +video[3]; }
  const m = err.match(/method (\w+) failed: (\d{3})\s*([^\n\r]*)/);
  if (m) { out.stage = m[1]; out.rtspCode = +m[2]; out.rtspText = m[3].trim(); }

  if (res.spawnError) { out.status = res.spawnError.code === 'ENOENT' ? 'noffmpeg' : 'error'; return out; }
  if (out.rtspCode === 401 || /401 Unauthorized|authorization failed/i.test(err)) { out.status = 'auth'; out.rtspCode = 401; return out; }
  if (out.rtspCode === 404 || /404 Not Found/i.test(err)) { out.status = 'notfound'; out.rtspCode = 404; return out; }
  if (res.code === 0 && video && !res.timedOut) { out.status = 'ok'; return out; }
  if (/Connection refused/i.test(err)) { out.status = 'refused'; return out; }
  if (/No route to host|Network is unreachable|Host is unreachable|Can't assign requested address/i.test(err)) { out.status = 'unreachable'; return out; }
  if (/Name or service not known|nodename nor servname|Failed to resolve|Temporary failure in name resolution/i.test(err)) { out.status = 'dns'; return out; }
  if (res.timedOut || /timed out|Operation timed out/i.test(err)) { out.status = 'timeout'; return out; }
  if (out.rtspCode) { out.status = 'error'; return out; }   // 400/454/503 etc.
  if (video && res.code !== 0) { out.status = 'error'; out.detail = 'video found but no picture decoded'; return out; }
  out.detail = 'no video';
  return out;
}

// One short plain-English phrase per status (for lists of results).
function describe(r) {
  switch (r.status) {
    case 'ok': return `WORKS  ${r.width}x${r.height} ${r.codec || ''}`.trim();
    case 'auth': return 'password or username rejected (401)';
    case 'notfound': return 'not on this recorder (404)';
    case 'refused': return 'recorder refused the connection';
    case 'timeout': return 'no answer (timed out)';
    case 'unreachable': return 'cannot reach the recorder';
    case 'dns': return 'address not found';
    case 'noffmpeg': return 'ffmpeg is not installed';
    default:
      if (r.rtspCode === 503) return 'recorder busy (503) - too many video connections open?';
      if (r.rtspCode) return `recorder said ${r.rtspCode} ${r.rtspText || ''}`.trim();
      return 'connected but no picture';
  }
}

function inputArgs(url) {
  // RTSP over TCP (UDP gets blocked/lost too easily). Files need nothing.
  return /^rtsps?:\/\//i.test(url) ? ['-rtsp_transport', 'tcp', '-i', url] : ['-i', url];
}

// Grab one picture from `url` into `outJpg` and classify the attempt.
// Doubles as the "does this URL work?" test, so every working URL leaves
// a snapshot behind for the user to look at.
async function grabFrame(url, outJpg, opts) {
  const o = opts || {};
  try { fs.unlinkSync(outJpg); } catch (e) { /* not there */ }
  const args = ['-hide_banner', '-nostdin', '-y']
    .concat(inputArgs(url))
    .concat(['-frames:v', '1', '-an', '-q:v', '3', '-update', '1', outJpg]);
  const res = await runFfmpeg(args, { timeoutMs: o.timeoutMs || 15000 });
  const c = classify(res);
  if (c.status === 'ok') {
    let size = 0;
    try { size = fs.statSync(outJpg).size; } catch (e) { /* none */ }
    if (!size) { c.status = 'error'; c.detail = 'no picture saved'; }
    else c.file = outJpg;
  }
  return c;
}

// Can this computer decode the live stream as fast as the camera sends it?
// Reads `url` for `seconds` (same decode shortcuts as the monitor) and
// measures pictures decoded per second after the first 2 s of connecting.
// Returns { ok, rate, sourceFps } or { ok:false, status } (never throws).
function decodeSpeed(url, opts) {
  const o = opts || {};
  const seconds = o.seconds || 8;
  const args = ['-hide_banner', '-nostdin', '-stats'].concat(/^rtsps?:\/\//i.test(url) ? ['-rtsp_transport', 'tcp'] : ['-re'])
    .concat(['-skip_loop_filter', 'all', '-flags2', 'fast', '-i', url, '-an', '-f', 'null', '-']);
  return new Promise(resolve => {
    let ff;
    try { ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { return resolve({ ok: false, status: 'noffmpeg' }); }
    const t0 = Date.now();
    const samples = [];
    let err = '', done = false;
    ff.stderr.on('data', d => {
      const s = d.toString();
      err += s; if (err.length > 20000) err = err.slice(-10000);
      const all = s.match(/frame=\s*(\d+)/g);
      if (all) samples.push({ t: Date.now(), f: Number(all[all.length - 1].replace(/\D/g, '')) });
    });
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer);
      try { ff.kill('SIGKILL'); } catch (e) { /* gone */ }
      const m = err.match(/Video: [^\n]*?([\d.]+) fps/) || err.match(/Video: [^\n]*?([\d.]+) tbr/);
      const sourceFps = m ? Number(m[1]) : null;
      const from = samples.find(x => x.t - t0 >= 2000), to = samples[samples.length - 1];
      if (!from || !to || to.t - from.t < 2000) return resolve({ ok: false, status: classify({ stderr: err, code: 1 }).status, sourceFps });
      resolve({ ok: true, rate: (to.f - from.f) / ((to.t - from.t) / 1000), sourceFps });
    };
    const timer = setTimeout(finish, seconds * 1000);
    ff.on('error', finish);
    ff.on('close', finish);
  });
}

// Width/height of an image or video file.
async function mediaSize(file) {
  const res = await runFfmpeg(['-hide_banner', '-nostdin', '-i', file], { timeoutMs: 10000 });
  const m = (res.stderr || '').match(/Video: [^\n]*?[ ,](\d{2,5})x(\d{2,5})[ ,\[]/);
  return m ? { width: +m[1], height: +m[2] } : null;
}

// ---------------------------------------------------------------------------
// "Does this format really follow the channel number?"

const THUMB_W = 32, THUMB_H = 18;
async function grayThumb(imageFile) {
  const res = await runFfmpeg(['-hide_banner', '-nostdin', '-i', imageFile, '-frames:v', '1',
    '-vf', `scale=${THUMB_W}:${THUMB_H},format=gray`, '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { timeoutMs: 10000 });
  return res.stdout && res.stdout.length >= THUMB_W * THUMB_H ? res.stdout.subarray(0, THUMB_W * THUMB_H) : null;
}
// Mean absolute difference 0..255 between two tiny grayscale frames.
// Same camera a moment apart (noise, on-screen clock) scores ~0-3.
// Two different cameras score well above 10.
const SAME_PICTURE_BELOW = 6;
function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length) return null;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}
async function imageDiff(fileA, fileB) {
  return frameDiff(await grayThumb(fileA), await grayThumb(fileB));
}

// ch1File: a snapshot already taken from urlFor(1).
// urlFor(n): URL for channel n. tmpDir: where to put comparison shots.
// Returns { aware: true|false|null, reason, authFailed?, shots: {n: result} }
//  - another channel 404s -> the recorder reads the channel number (aware)
//  - another channel shows a different picture -> aware
//  - channels 2 AND 3 both show the same picture as 1 -> NOT aware
async function channelCheck(urlFor, ch1File, tmpDir, opts) {
  const o = opts || {};
  const others = o.others || [2, 3];
  const base = o.baseChannel || 1;
  const shots = {};
  let samePicture = 0;
  for (const n of others) {
    const f = path.join(tmpDir, `chk-${o.tag || 'x'}-ch${n}.jpg`);
    const r = await grabFrame(urlFor(n), f, { timeoutMs: o.timeoutMs });
    shots[n] = r;
    if (r.status === 'auth') return { aware: null, authFailed: true, shots };
    if (r.status === 'notfound') return { aware: true, reason: `channel ${n} is "not found", so the recorder is reading the channel number`, shots };
    if (r.status === 'ok') {
      const d = await imageDiff(ch1File, f);
      r.diff = d;
      if (d != null && d >= SAME_PICTURE_BELOW) return { aware: true, reason: `channel ${n} shows a different picture from channel ${base}`, diff: d, shots };
      if (d != null) samePicture++;
    }
  }
  if (samePicture >= 2 || (samePicture >= 1 && others.length === 1)) {
    return { aware: false, reason: `channel${samePicture > 1 ? 's' : ''} ${others.filter(n => shots[n] && shots[n].status === 'ok').join(' and ')} show exactly the same picture as channel ${base} - this address ignores the channel number`, shots };
  }
  if (samePicture === 1) return { aware: null, reason: 'another channel looked the same and the next gave no picture - could not be sure', shots };
  return { aware: null, reason: 'could not get a second channel to compare', shots };
}

// ---------------------------------------------------------------------------
// Test every format against one channel, in order.
// STOPS at the first 401 (account lockout safety) and returns it.
//
// opts.stopAtFirstGood: return as soon as one channel-aware format works
// opts.onResult(format, sub, result): progress callback
// opts.checkChannels: run channelCheck on each working format
// opts.includeSub / opts.includeRoot
async function testFormats(creds, channel, tmpDir, opts) {
  const o = opts || {};
  const list = [];
  for (const f of o.formats || FORMATS) {
    list.push({ format: f, sub: false });
    if (o.includeSub && f.sub) list.push({ format: f, sub: true });
  }
  if (o.includeRoot) list.push({ format: BARE_ROOT, sub: false });

  const results = [];
  for (const item of list) {
    const url = buildUrl(creds, item.format, channel, { sub: item.sub });
    const shot = path.join(tmpDir, `probe-${item.format.id}${item.sub ? '-sub' : ''}-ch${channel}.jpg`);
    const r = await grabFrame(url, shot, { timeoutMs: o.timeoutMs });
    const entry = { format: item.format, sub: item.sub, channel, url, result: r };
    if (r.status === 'ok') {
      if (!item.format.channelAware) {
        entry.channel_check = { aware: false, reason: 'this address has no channel number in it - on this kind of recorder it always shows camera 1' };
      } else if (o.checkChannels) {
        const others = (o.otherChannels || [2, 3]).filter(n => n !== channel);
        entry.channel_check = await channelCheck(n => buildUrl(creds, item.format, n, { sub: item.sub }), shot, tmpDir,
          { others, baseChannel: channel, tag: item.format.id + (item.sub ? 's' : ''), timeoutMs: o.timeoutMs });
        if (entry.channel_check.authFailed) {
          // the comparison shot (channel 2/3) got a 401: treat like any 401
          const shots = entry.channel_check.shots;
          entry.result = Object.values(shots).find(s => s.status === 'auth');
          results.push(entry);
          if (o.onResult) o.onResult(entry);
          return { results, authFailed: entry };
        }
      }
    }
    results.push(entry);
    if (o.onResult) o.onResult(entry);
    if (r.status === 'auth') return { results, authFailed: entry };
    if (r.status === 'noffmpeg') return { results, noFfmpeg: true };
    if (o.stopAtFirstGood && r.status === 'ok' && entry.channel_check && entry.channel_check.aware !== false) {
      return { results, found: entry };
    }
  }
  const good = results.filter(e => e.result.status === 'ok');
  const aware = good.find(e => e.channel_check && e.channel_check.aware !== false) || null;
  return { results, found: aware, agnosticOnly: !aware && good.length ? good[0] : null };
}

// ---------------------------------------------------------------------------
// Pictures: labels, contact sheet, grid, crop preview.

const FONT_CANDIDATES = [
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
  '/System/Library/Fonts/Menlo.ttc',
  '/System/Library/Fonts/SFNSMono.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
  '/usr/share/fonts/truetype/freefont/FreeSansBold.ttf',
  'C:/Windows/Fonts/arialbd.ttf',
];
function escFilterValue(s) {
  // value inside single quotes in a filtergraph: escape \ ' and :
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:');
}
let fontCache;
function findFont() {
  if (fontCache !== undefined) return fontCache;
  if (process.env.CAMERA_PROBE_FONT) return (fontCache = process.env.CAMERA_PROBE_FONT);
  fontCache = FONT_CANDIDATES.find(f => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } }) || null;
  return fontCache;
}
// drawtext options for a label. Returns '' when labels are disabled.
function drawtext(text, x, y, size, noLabels) {
  if (noLabels || process.env.CAMERA_PROBE_NO_DRAWTEXT === '1') return '';
  const font = findFont();
  const ff = font ? `fontfile='${escFilterValue(font)}':` : '';
  return `drawtext=${ff}text='${escFilterValue(text)}':x=${x}:y=${y}:fontsize=${size}:fontcolor=yellow:box=1:boxcolor=black@0.7:boxborderw=6`;
}

// Try with labels; if ffmpeg fails (no drawtext in this build, no font),
// build it again without labels. Returns { ok, labelled }.
async function renderWithFallback(buildArgs) {
  const tries = process.env.CAMERA_PROBE_NO_DRAWTEXT === '1' ? [true] : [false, true];
  for (const noLabels of tries) {
    const r = await runFfmpeg(buildArgs(noLabels), { timeoutMs: 60000 });
    if (r.code === 0) return { ok: true, labelled: !noLabels };
  }
  return { ok: false, labelled: false };
}

// items: [{ file, label }]  ->  one labelled grid of thumbnails.
async function contactSheet(items, outJpg, opts) {
  const o = opts || {};
  if (!items.length) return { ok: false };
  const cols = o.cols || Math.min(4, items.length);
  const rows = Math.ceil(items.length / cols);
  const W = o.cellW || 480, H = o.cellH || 270;
  const build = noLabels => {
    const args = ['-hide_banner', '-nostdin', '-y'];
    items.forEach(it => args.push('-i', it.file));
    const parts = items.map((it, i) => {
      const dt = drawtext(it.label, 10, 10, 34, noLabels);
      return `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,format=yuvj420p${dt ? ',' + dt : ''}[v${i}]`;
    });
    const concatIn = items.map((_, i) => `[v${i}]`).join('');
    const fc = parts.join(';') + `;${concatIn}concat=n=${items.length}:v=1:a=0,tile=${cols}x${rows}:padding=4:color=gray[out]`;
    return args.concat(['-filter_complex', fc, '-map', '[out]', '-frames:v', '1', '-q:v', '3', '-update', '1', outJpg]);
  };
  const r = await renderWithFallback(build);
  return Object.assign(r, { file: outJpg, cols, rows });
}

const COL_LETTERS = 'ABCDEFGHIJKL';
// Picture with a labelled grid: columns A.. left->right, rows 1.. top->bottom.
async function gridImage(inJpg, outJpg, opts) {
  const o = opts || {};
  const cols = o.cols || 6, rows = o.rows || 6;
  const outW = o.width || 1280;
  const size = await mediaSize(inJpg);
  if (!size) return { ok: false };
  const outH = Math.round(outW * size.height / size.width / 2) * 2;
  const cw = outW / cols, ch = outH / rows;
  const fsz = Math.max(16, Math.round(Math.min(cw, ch) / 5));
  const build = noLabels => {
    const f = [`scale=${outW}:${outH}`, `drawgrid=w=${cw.toFixed(3)}:h=${ch.toFixed(3)}:t=3:c=yellow@0.9`];
    if (!noLabels) {
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const dt = drawtext(`${COL_LETTERS[c]}${r + 1}`, Math.round(c * cw + 8), Math.round(r * ch + 8), fsz, false);
        if (dt) f.push(dt);
      }
    }
    return ['-hide_banner', '-nostdin', '-y', '-i', inJpg, '-vf', f.join(','), '-frames:v', '1', '-q:v', '3', '-update', '1', outJpg];
  };
  const r = await renderWithFallback(build);
  return Object.assign(r, { file: outJpg, cols, rows });
}

// "B2 C3", "b2-c3", "B2,C3", "B2 to C3", "C3"  ->  { c0, c1, r0, r1 } (0-based, inclusive)
function parseCells(text, cols, rows) {
  const s = normaliseInput(text).value.toUpperCase();
  const cells = [];
  const re = /([A-Z])\s*(\d{1,2})/g;
  let m;
  while ((m = re.exec(s))) {
    const c = COL_LETTERS.indexOf(m[1]);
    const r = parseInt(m[2], 10) - 1;
    if (c < 0 || c >= cols) return { error: `There is no column ${m[1]} - columns go A to ${COL_LETTERS[cols - 1]}.` };
    if (r < 0 || r >= rows) return { error: `There is no row ${m[2]} - rows go 1 to ${rows}.` };
    cells.push({ c, r });
  }
  const leftover = s.replace(/([A-Z])\s*(\d{1,2})/g, '').replace(/\b(TO|AND|THROUGH|THRU)\b/g, '').replace(/[\s,;\-–:+&]/g, '');
  if (!cells.length || leftover) return { error: 'Type squares like B2 C3 (a letter then a number).' };
  return {
    c0: Math.min(...cells.map(x => x.c)), c1: Math.max(...cells.map(x => x.c)),
    r0: Math.min(...cells.map(x => x.r)), r1: Math.max(...cells.map(x => x.r)),
  };
}
function cellsName(b) { return `${COL_LETTERS[b.c0]}${b.r0 + 1}-${COL_LETTERS[b.c1]}${b.r1 + 1}`; }

// Cell box -> pixel crop on a W x H frame. Even numbers (safe for yuv420).
function cellsToCrop(b, W, H, cols, rows) {
  const even = n => Math.max(0, Math.floor(n / 2) * 2);
  const x0 = even(b.c0 * W / cols), y0 = even(b.r0 * H / rows);
  const x1 = Math.min(W, Math.round((b.c1 + 1) * W / cols)), y1 = Math.min(H, Math.round((b.r1 + 1) * H / rows));
  return { cropX: x0, cropY: y0, cropW: even(x1 - x0), cropH: even(y1 - y0) };
}

async function cropPreview(inJpg, crop, outJpg) {
  const vf = `crop=${crop.cropW}:${crop.cropH}:${crop.cropX}:${crop.cropY},scale='min(1280,iw)':-2`;
  const r = await runFfmpeg(['-hide_banner', '-nostdin', '-y', '-i', inJpg, '-vf', vf, '-frames:v', '1', '-q:v', '3', '-update', '1', outJpg], { timeoutMs: 30000 });
  return { ok: r.code === 0, file: outJpg };
}

// Open a picture for the user (macOS only; elsewhere the caller prints the path).
function openFile(file) {
  if (process.platform !== 'darwin') return false;
  try { spawn('open', [file], { stdio: 'ignore', detached: true }).unref(); return true; } catch (e) { return false; }
}

module.exports = {
  get FFMPEG() { return FFMPEG; }, setFfmpeg, FORMATS, BARE_ROOT, SAME_PICTURE_BELOW, COL_LETTERS,
  encodeCred, buildUrl, maskUrl, maskText, normaliseInput, parseHostInput,
  runFfmpeg, ffmpegCheck, tcpCheck, localIPv4, sameSubnet24,
  classify, describe, grabFrame, mediaSize, decodeSpeed,
  grayThumb, frameDiff, imageDiff, channelCheck, testFormats,
  findFont, contactSheet, gridImage, parseCells, cellsName, cellsToCrop, cropPreview, openFile,
};
