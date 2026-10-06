// Server-side RTSP monitoring — Option C.
//
// The browser paths (screen share, capture device) all depend on a tab
// staying open. This one doesn't: ffmpeg pulls frames straight from the
// NVR, the same detection engine decides what's a person crossing a
// doorway, and only real events reach the API. No browser, nothing to
// leave open, survives reboots if you run it under a process manager.
//
// It uses detect.js — the exact module the dashboard uses — so a gym on
// RTSP and a gym on screen share get the same answers.
//
// Requires: ffmpeg on the machine, and network access to the NVR. That
// usually means running this on a small always-on box at the gym rather
// than in the cloud, since most NVRs aren't reachable from the internet.
//
// Also accepts a local video file as the "camera" (anything ffmpeg can
// read that is not a network URL). Files are played at real speed with
// -re so detection timing matches a live camera; used for testing.

const { spawn, spawnSync } = require('child_process');
const detect = require('./detect');
const { maskText, findFfmpeg } = require('./runner-config');

const GRID = detect.DIFF_GRID;
const TICK_MS = detect.MOTION_CHECK_MS;
const FFMPEG = findFfmpeg();       // FFMPEG_PATH, the PATH, or ~/.securityai/bin/ffmpeg

// Every long-running ffmpeg we start, so none outlive us. An ffmpeg
// blocked on a silent network input ignores a single SIGTERM, and an
// orphan would keep an NVR session open all night.
const LIVE = new Set();
function killAll() { for (const ff of LIVE) { try { ff.kill('SIGKILL'); } catch (e) { /* gone */ } } LIVE.clear(); }

function isNetworkInput(u) { return /^(rtsps?|https?|rtmp|udp|tcp|srt):\/\//i.test(String(u)); }
function isRtsp(u) { return /^rtsps?:\/\//i.test(String(u)); }

// ffmpeg 4.x used -stimeout for the RTSP socket timeout; in 4.x -timeout
// meant "act as a server and wait for a connection", which would hang.
// ffmpeg 5+ renamed it to -timeout. Ask once.
let _ffVersion;
function ffmpegMajor() {
  if (_ffVersion !== undefined) return _ffVersion;
  try {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-version'], { encoding: 'utf8', timeout: 5000 });
    const m = (r.stdout || '').match(/ffmpeg version [^\d]*(\d+)\./);
    _ffVersion = m ? Number(m[1]) : (r.error ? null : 6);
  } catch (e) { _ffVersion = null; }
  return _ffVersion;
}
function ffmpegAvailable() { return ffmpegMajor() !== null; }

// Input options. `live` = for the long-running monitor (files play at
// real speed); probe/snapshot read files as fast as possible.
function inputArgs(url, live, ioTimeoutSec) {
  const a = [];
  if (isRtsp(url)) {
    // TCP only for RTSP: it avoids UDP packet loss smearing HEVC frames.
    // Passing -rtsp_transport to a file input is an error, which is why
    // it is conditional.
    const us = String(Math.round((ioTimeoutSec || 10) * 1e6));
    a.push('-rtsp_transport', 'tcp');
    a.push((ffmpegMajor() || 6) >= 5 ? '-timeout' : '-stimeout', us);
  } else if (live && !isNetworkInput(url)) {
    a.push('-re');
  }
  // Decode speed-ups that cost nothing we use: frames end up at 384px
  // (evidence) and 12x12 (motion), so HEVC deblocking/SAO is invisible.
  // Measured ~12% less decode CPU on 6 Mbps 4K HEVC, no visible change at
  // 384px (PSNR vs full decode ~45 dB avg, 42 dB worst). Opt out with
  // RTSP_FULL_DECODE=1.
  if (live && process.env.RTSP_FULL_DECODE !== '1') a.push('-skip_loop_filter', 'all', '-flags2', 'fast');
  a.push('-i', url, '-an', '-sn', '-dn');
  return a;
}

// ---------- crop ----------

// Crop as an ffmpeg expression so it can never exceed the real frame,
// even when we could not probe it first. Returns '' for "no crop".
// If the zone remembers the picture size it was drawn on (frameW/frameH,
// saved by setup-camera.js) the box is scaled to the live picture, so a
// camera switched from 2048x972 to 1280x720 still watches the same door.
function cropFilter(z) {
  if (!z || !z.cropSet) return '';
  const X = z.cropX || 0, Y = z.cropY || 0;
  const scaled = z.frameW > 0 && z.frameH > 0;
  const sx = v => (scaled ? `trunc(${v}*iw/${z.frameW})` : String(v));
  const sy = v => (scaled ? `trunc(${v}*ih/${z.frameH})` : String(v));
  const w = z.cropW != null ? `max(16\\,min(${sx(z.cropW)}\\,iw))` : `max(16\\,iw-${sx(X)})`;
  const h = z.cropH != null ? `max(16\\,min(${sy(z.cropH)}\\,ih))` : `max(16\\,ih-${sy(Y)})`;
  return `crop=w='${w}':h='${h}':x='min(${sx(X)}\\,iw-ow)':y='min(${sy(Y)}\\,ih-oh)'`;
}

// Same maths in JS, for telling the person what actually happens.
function resolveCrop(z, width, height) {
  if (!z || !z.cropSet) return { x: 0, y: 0, w: width, h: height, full: true, clamped: false, scaled: false, notes: [] };
  const fw = z.frameW > 0 && z.frameH > 0 ? z.frameW : null, fh = fw ? z.frameH : null;
  const scaled = !!fw && (fw !== width || fh !== height);
  const sx = v => (fw ? Math.trunc(v * width / fw) : v);
  const sy = v => (fh ? Math.trunc(v * height / fh) : v);
  const X = sx(z.cropX || 0), Y = sy(z.cropY || 0);
  const W = z.cropW != null ? sx(z.cropW) : null, H = z.cropH != null ? sy(z.cropH) : null;
  const w = W != null ? Math.max(16, Math.min(W, width)) : Math.max(16, width - X);
  const h = H != null ? Math.max(16, Math.min(H, height)) : Math.max(16, height - Y);
  const x = Math.min(X, width - w), y = Math.min(Y, height - h);
  const notes = [];
  if (W != null && W > width) notes.push(`the box is ${W} wide but the picture is only ${width} — using ${w}`);
  if (H != null && H > height) notes.push(`the box is ${H} tall but the picture is only ${height} — using ${h}`);
  if (x !== X) notes.push(`the box went off the right edge — moved it left to ${x}`);
  if (y !== Y) notes.push(`the box went off the bottom edge — moved it up to ${y}`);
  return { x, y, w, h, full: x === 0 && y === 0 && w === width && h === height, clamped: notes.length > 0,
    scaled, from: scaled ? { w: fw, h: fh } : null, notes };
}

// Width x height of a JPEG (reads the SOF marker). null if not a JPEG.
function jpegSize(buf) {
  if (!buf || buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7) || m === 0xFF) { i += (m === 0xFF ? 1 : 2); continue; }
    const len = buf.readUInt16BE(i + 2);
    if ((m >= 0xC0 && m <= 0xC3) || (m >= 0xC5 && m <= 0xC7) || (m >= 0xC9 && m <= 0xCB) || (m >= 0xCD && m <= 0xCF)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

// ---------- error classification ----------

// Turn ffmpeg's stderr into one plain sentence and a fix. `fatal` means
// retrying cannot help and may hurt (auth: the NVR locks the account).
function classifyFfmpegError(stderr, extra) {
  // Drop "[rtsp @ 0x5640148401c0]" style pointers first — a hex address
  // containing 401 must never be mistaken for a wrong password.
  const s = String(stderr || '').replace(/0x[0-9a-f]+/gi, '');
  const e = extra || {};
  const r = (kind, fatal, message, fix) => ({ kind, fatal, message, fix });
  if (e.spawnError) {
    return r('ffmpeg-missing', true, 'ffmpeg is not installed or not on the PATH.',
      'install ffmpeg (see RTSP-SETUP.md), then check that "ffmpeg -version" works in a new Terminal window.');
  }
  if (/\b401\b|Unauthorized|authorization failed/i.test(s)) {
    return r('auth', true, 'The camera/NVR rejected the username or password (401).',
      'check the password in rtsp-zones.json (run node setup-camera.js to re-enter it). Stopped on purpose: this NVR locks the account after repeated wrong passwords.');
  }
  if (/\b403\b|Forbidden/i.test(s)) {
    return r('forbidden', true, 'The NVR refused access (403) — this user is not allowed to view that channel.',
      'in the NVR web page, give this user "Live View" permission for the channel, or use the admin account.');
  }
  if (/\b404\b|Not Found|Stream not found|\b454\b/i.test(s) && !/No such file/i.test(s)) {
    return r('notfound', false, 'The NVR is reachable and the password was accepted, but it has no stream at that path (404).',
      'the channel path is wrong — run node setup-camera.js to find the right one.');
  }
  if (/No such file or directory/i.test(s)) {
    return r('nofile', true, 'That video file does not exist.', 'check the "cameraUrl" path.');
  }
  if (/Protocol not found|Unsupported protocol/i.test(s)) {
    return r('badurl', true, 'The camera address starts with something ffmpeg does not understand.', 'it must start with rtsp://');
  }
  if (/Connection refused/i.test(s)) {
    return r('refused', false, 'The recorder refused the video connection (it may be restarting).',
      'if it was working before, wait: it retries by itself. If it never worked, run node setup-camera.js (wrong address, or RTSP switched off on the recorder).');
  }
  if (/No route to host|Network is unreachable|Host is down|Name or service not known|nodename nor servname|Could not resolve/i.test(s)) {
    return r('network', false, 'This computer cannot reach the recorder on the network.',
      'check the network cable between this computer and the recorder is plugged in at both ends. It retries by itself.');
  }
  if (e.timedOut || /timed out|Connection timed out|Operation timed out|timeout/i.test(s)) {
    return r('timeout', false, 'No answer from the recorder (timed out).',
      'check the network cable between this computer and the recorder. If it worked before, the recorder may be restarting: it retries by itself.');
  }
  if (/Invalid too big or non positive size|crop/i.test(s) && /size|crop/i.test(s)) {
    return r('crop', false, 'The crop box does not fit the picture.', 'fix cropX/cropY/cropW/cropH, or delete them to watch the whole picture.');
  }
  if (/Error initializing complex filters|matches no streams|Output file #0 does not contain any stream/i.test(s)) {
    return r('novideo', false, 'Connected, but no video picture came through.',
      'check the camera address points at a video channel. It will keep retrying.');
  }
  if (/Invalid data found|could not find codec|Could not find codec parameters|decoding for stream/i.test(s)) {
    return r('decode', false, 'Connected, but the video data could not be read.',
      'run node setup-camera.js again and type S for the small sub-stream.');
  }
  if (e.endOfFile) return r('eof', false, 'The video file finished.', '');
  const last = s.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
  return r('unknown', false, last ? `ffmpeg stopped: ${last.slice(0, 160)}` : `ffmpeg stopped (exit ${e.code == null ? '?' : e.code}) without saying why.`,
    'it will keep retrying. If this repeats, run node rtsp-run.js --check');
}

// ---------- probe ----------

// Connects once, reads the stream header and decodes one frame.
// Resolves { ok, width, height, codec, fps, error? }. Never rejects.
function probeStream(url, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 15000;
  return new Promise(resolve => {
    const args = ['-hide_banner', '-nostdin', ...inputArgs(url, false, Math.ceil(timeoutMs / 1000)), '-frames:v', '1', '-f', 'null', '-'];
    let ff, stderr = '', done = false, timedOut = false;
    try { ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (err) { return resolve({ ok: false, error: classifyFfmpegError('', { spawnError: err }) }); }
    LIVE.add(ff); ff.on('close', () => LIVE.delete(ff));
    const timer = setTimeout(() => { timedOut = true; try { ff.kill('SIGKILL'); } catch (e) { /* gone */ } }, timeoutMs);
    ff.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-8000); });
    const finish = (res) => { if (done) return; done = true; clearTimeout(timer); resolve(res); };
    ff.on('error', err => finish({ ok: false, error: classifyFfmpegError('', { spawnError: err }) }));
    ff.on('close', code => {
      const info = parseStreamInfo(stderr);
      if (code === 0 && info.width) return finish({ ok: true, ...info });
      if (info.width && timedOut) {
        // header read, but no frame decoded in time — usable, warn
        return finish({ ok: true, ...info, warning: 'Connected but no picture arrived within the time limit.' });
      }
      finish({ ok: false, ...info, error: classifyFfmpegError(stderr, { timedOut, code }), stderrTail: tail(stderr, o.secrets) });
    });
  });
}

function parseStreamInfo(stderr) {
  const line = (String(stderr).match(/Stream #\d+:\d+[^\n]*Video:[^\n]*/) || [''])[0];
  const out = {};
  const c = line.match(/Video: (\w+)/);
  if (c) out.codec = c[1];
  const d = line.match(/, (\d{2,5})x(\d{2,5})/);
  if (d) { out.width = Number(d[1]); out.height = Number(d[2]); }
  const f = line.match(/([\d.]+) fps/) || line.match(/([\d.]+) tbr/);
  if (f) out.fps = Number(f[1]);
  return out;
}

function tail(stderr, secrets) {
  return maskText(String(stderr || '').trim().split('\n').filter(l => l.trim()).slice(-3).join(' | '), secrets).slice(0, 400);
}

// ---------- snapshot ----------

// One frame: the cropped zone at full resolution, plus (optionally) the
// whole picture at 1280px wide with the crop drawn on it in red.
function snapshot(url, z, dims, outCrop, outFull, opts) {
  const o = opts || {};
  return new Promise(resolve => {
    const crop = cropFilter(z);
    const parts = [];
    let graph;
    if (outFull && dims && dims.width) {
      const c = resolveCrop(z, dims.width, dims.height);
      const t = Math.max(4, Math.round(dims.width / 300));
      graph = `[0:v]split=2[a][b];[a]${crop || 'null'}[c];` +
        `[b]drawbox=x=${c.x}:y=${c.y}:w=${c.w}:h=${c.h}:color=red:t=${t},scale=1280:-2[f]`;
      parts.push('-map', '[c]', '-frames:v', '1', '-q:v', '3', outCrop, '-map', '[f]', '-frames:v', '1', '-q:v', '4', outFull);
    } else {
      graph = `[0:v]${crop || 'null'}[c]`;
      parts.push('-map', '[c]', '-frames:v', '1', '-q:v', '3', outCrop);
    }
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...inputArgs(url, false, 10)];
    if (o.seekSec && !isNetworkInput(url)) args.splice(args.indexOf('-i'), 0, '-ss', String(o.seekSec));
    args.push('-filter_complex', graph, ...parts);
    let ff, stderr = '', timedOut = false;
    try { ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (err) { return resolve({ ok: false, error: classifyFfmpegError('', { spawnError: err }) }); }
    LIVE.add(ff); ff.on('close', () => LIVE.delete(ff));
    const timer = setTimeout(() => { timedOut = true; try { ff.kill('SIGKILL'); } catch (e) { /* gone */ } }, o.timeoutMs || 20000);
    ff.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-4000); });
    ff.on('error', err => { clearTimeout(timer); resolve({ ok: false, error: classifyFfmpegError('', { spawnError: err }) }); });
    ff.on('close', code => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      resolve({ ok: false, error: classifyFfmpegError(stderr, { timedOut, code }), stderrTail: tail(stderr, o.secrets) });
    });
  });
}

// ---------- the monitor ----------

// Frames per second over the last 10 s of wall-clock time. Recomputed on
// every frame AND every second by the watchdog, so a stall shows 0.
function updateFps(stats, now) {
  const w = stats._fpsWindow;
  while (w.length && now - w[0] > 10000) w.shift();
  const span = Math.min(10, (now - Math.max(stats._fpsSince || 0, now - 10000)) / 1000);
  stats.fps = w.length >= 2 && span >= 1 ? w.length / span : 0;
}

function newStats() {
  return {
    framesSeen: 0, fps: 0, lastFrameAt: null, startedAt: Date.now(),
    motionPct: 0, motionHistory: [], noiseFloor: null, verdict: null,
    events: 0, rejected: 0, lastEventAt: null, lastRejectReason: null,
    lastError: null, lastErrorKind: null, streamOk: false, connects: 0,
    _fpsWindow: [],
  };
}

// ffmpeg is asked for parallel outputs from one connection:
//   1. a tiny GRIDxGRID grayscale stream for motion maths (nearly free)
//   2. 384px JPEGs into a rolling buffer — the frames sent to be counted
//   3. the same frames again at up to 1024px (long edge), kept alongside,
//      so the middle photo of each crossing can also be sent as a copy
//      people can actually recognise someone in ("evidence"). Branches 1
//      and 2 are exactly what they were before, so counting and its cost
//      do not change. Set cfg.evidenceMaxPx = 0 to switch 3 off.
// The fps filter runs BEFORE the split so each frame dropped is dropped
// once, and the crop runs before any scaling. All branches get every
// frame in the same order, so frame N of one output is frame N of the other.
const EVIDENCE_MAX_BYTES = 900 * 1024;     // the website accepts up to 1 MB
function fitFilter(maxPx) {
  // Shrink so the long edge is at most maxPx; never enlarge; even sizes.
  const m = maxPx;
  return `scale=w='trunc(if(gte(iw,ih),min(${m},iw),min(${m},ih)*iw/ih)/2)*2':` +
    `h='trunc(if(gte(iw,ih),min(${m},iw)*ih/iw,min(${m},ih))/2)*2'`;
}
function zoneArgs(cfg) {
  const fps = Math.round(1000 / TICK_MS);
  const crop = cropFilter(cfg);
  const evPx = cfg.evidenceMaxPx === undefined ? 1024 : Number(cfg.evidenceMaxPx) || 0;
  const n = evPx ? 3 : 2;
  const graph = `[0:v]fps=${fps},${crop ? crop + ',' : ''}split=${n}[a][b]${evPx ? '[c]' : ''};` +
    `[a]scale=${GRID}:${GRID}:flags=area,format=gray[small];` +
    `[b]scale=${cfg.jpegMaxPx || 384}:-2[big]` +
    (evPx ? `;[c]${fitFilter(evPx)}[ev]` : '');
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    ...inputArgs(cfg.cameraUrl, true, cfg.ioTimeoutSec || 10),
    '-filter_complex', graph,
    '-map', '[small]', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:3',
    '-map', '[big]', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '6', 'pipe:4',
  ];
  if (evPx) args.push('-map', '[ev]', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '5', 'pipe:5');
  return { args, evidence: !!evPx };
}

// mjpeg over a pipe needs framing on SOI/EOI markers.
function jpegFramer(onJpeg) {
  const SOI = Buffer.from([0xFF, 0xD8]), EOI = Buffer.from([0xFF, 0xD9]);
  let jbuf = Buffer.alloc(0);
  return chunk => {
    jbuf = jbuf.length ? Buffer.concat([jbuf, chunk]) : chunk;
    for (;;) {
      const start = jbuf.indexOf(SOI);
      if (start === -1) { jbuf = Buffer.alloc(0); break; }
      const end = jbuf.indexOf(EOI, start + 2);
      if (end === -1) { if (start > 0) jbuf = jbuf.subarray(start); break; }
      onJpeg(Buffer.from(jbuf.subarray(start, end + 2)));
      jbuf = jbuf.subarray(end + 2);
    }
  };
}

function startRtspZone(cfg, handlers) {
  const stats = cfg.stats || newStats();
  const { args, evidence: wantEvidence } = zoneArgs(cfg);

  let ff;
  try { ff = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'].concat(wantEvidence ? ['pipe'] : []) }); }
  catch (err) {
    setImmediate(() => handlers.onClose && handlers.onClose(null, classifyFfmpegError('', { spawnError: err }), ''));
    return { stop() {}, stats };
  }
  stats.connects++;
  LIVE.add(ff);

  let stderr = '';
  ff.stderr.on('data', d => { stderr = (stderr + d.toString()).slice(-4000); });

  // --- tiny grayscale frames -> detection ---
  const frameBytes = GRID * GRID;
  let acc = Buffer.alloc(0);
  const zoneState = {};
  detect.resetZone(zoneState);
  let prevCells = null;

  // rolling buffer of recent JPEGs, so when an event ends we can pick
  // frames from across it rather than only the current instant.
  // Entries are { jpg, seq }: seq = frame number, shared with the
  // large copies in evBuf.
  const jpegBuf = [];
  const JPEG_BUF_MAX = 60;
  const evBuf = new Map();
  let seq384 = 0, seqEv = 0;

  ff.stdio[3].on('data', chunk => {
    acc = acc.length ? Buffer.concat([acc, chunk]) : chunk;
    while (acc.length >= frameBytes) {
      const raw = acc.subarray(0, frameBytes);
      acc = acc.subarray(frameBytes);
      const cells = Array.from(raw);            // already luminance 0-255
      const now = Date.now();

      // stats
      stats.framesSeen++;
      stats.lastFrameAt = now;
      if (!stats.streamOk) { stats.streamOk = true; if (handlers.onFlowing) handlers.onFlowing(); }
      stats._fpsWindow.push(now);
      updateFps(stats, now);

      // Motion level for humans: share of the zone that changed since the
      // previous sample, using the same threshold detect.js uses. This is
      // the number that jumps when someone walks past.
      if (prevCells) {
        const nf = zoneState.noiseFloor;
        const thr = nf == null ? 18 : Math.min(26, Math.max(18, nf * 1.5));
        let changed = 0;
        for (let i = 0; i < cells.length; i++) if (Math.abs(cells[i] - prevCells[i]) > thr) changed++;
        stats.motionPct = Math.round((changed / cells.length) * 100);
        stats.motionHistory.push({ t: now, pct: stats.motionPct });
        if (stats.motionHistory.length > 400) stats.motionHistory.splice(0, stats.motionHistory.length - 400);
      }
      prevCells = cells;

      const wasActive = !!zoneState.eventActive;
      const step = detect.stepZone(zoneState, cells, cfg.sensitivity, {
        onCapture: () => { zoneState._eventJpegs = (zoneState._eventJpegs || []).concat(jpegBuf.slice(-1)); },
      });
      stats.noiseFloor = zoneState.noiseFloor;
      stats.verdict = step.verdict;
      if (!wasActive && zoneState.eventActive && handlers.onEventStart) handlers.onEventStart();
      if (step.verdict && handlers.onVerdict) handlers.onVerdict(step.verdict);
      if (step.send) {
        const picks = detect.selectEventFrames(zoneState._eventJpegs || [], detect.EVENT_FRAMES_SENT);
        zoneState._eventJpegs = [];
        if (picks.length >= 1) {
          stats.events++;
          stats.lastEventAt = now;
          // evidence = the MIDDLE photo again, larger (the same one the
          // website would otherwise keep). Skipped if it is not bigger.
          const mid = picks[Math.floor(picks.length / 2)];
          let evidence = null, evidenceSize = null;
          const big = wantEvidence ? evBuf.get(mid.seq) : null;
          if (big && big.length <= EVIDENCE_MAX_BYTES) {
            const bs = jpegSize(big), ss = jpegSize(mid.jpg);
            if (bs && (!ss || Math.max(bs.width, bs.height) > Math.max(ss.width, ss.height))) {
              evidence = big.toString('base64'); evidenceSize = { width: bs.width, height: bs.height, bytes: big.length, seq: mid.seq };
            }
          }
          handlers.onEvent(picks.map(p => p.jpg.toString('base64')), step.send, { evidence, evidenceSize, seqs: picks.map(p => p.seq) });
        } else {
          stats.rejected++; stats.lastRejectReason = 'no-photos';
          if (handlers.onRejected) handlers.onRejected('no-photos');
        }
      } else if (step.rejected) {
        zoneState._eventJpegs = [];
        stats.rejected++;
        stats.lastRejectReason = step.rejected;
        if (handlers.onRejected) handlers.onRejected(step.rejected);
      }
    }
  });

  // --- 384px JPEGs -> rolling buffer ---
  ff.stdio[4].on('data', jpegFramer(jpg => {
    jpegBuf.push({ jpg, seq: seq384++ });
    if (jpegBuf.length > JPEG_BUF_MAX) jpegBuf.shift();
  }));
  // --- large copies, by frame number (only the newest ~15 s are kept) ---
  if (wantEvidence) {
    ff.stdio[5].on('data', jpegFramer(jpg => {
      evBuf.set(seqEv, jpg);
      evBuf.delete(seqEv - JPEG_BUF_MAX);
      seqEv++;
    }));
  }

  let closed = false;
  ff.on('error', err => {
    if (closed) return; closed = true;
    handlers.onClose && handlers.onClose(null, classifyFfmpegError('', { spawnError: err }), '');
  });
  ff.on('close', (code, signal) => {
    LIVE.delete(ff);
    if (closed) return; closed = true;
    stats.streamOk = false;
    const endOfFile = code === 0 && !isNetworkInput(cfg.cameraUrl);
    const info = code === 0 && !endOfFile && !stderr.trim()
      ? { kind: 'ended', fatal: false, message: 'The camera stream ended.', fix: 'it will reconnect.' }
      : classifyFfmpegError(stderr, { code, endOfFile: endOfFile && !stderr.trim(), killed: !!signal });
    handlers.onClose && handlers.onClose(code, info, tail(stderr, cfg.secrets));
  });

  return {
    stop() {
      closed = true;
      try { ff.kill('SIGTERM'); } catch (e) { /* already gone */ }
      const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) { /* gone */ } }, 1500);
      if (t.unref) t.unref();
    },
    kill() { try { ff.kill('SIGKILL'); } catch (e) { /* already gone */ } },
    stats,
    get lastVerdict() { return zoneState.lastVerdict; },
    get noiseFloor() { return zoneState.noiseFloor; },
  };
}

// Wraps startRtspZone with automatic reconnect — cameras drop, networks
// blip, and an overnight service that gives up on the first hiccup is
// worse than useless. EXCEPT a wrong password: the NVR has account
// lockout, so after a 401 we stop and say so instead of looping.
//
// handlers: onEvent, onEventStart, onRejected, onFlowing,
//   onClose(code, info, tail)  every time ffmpeg exits (will retry)
//   onFatal(info, tail)        stopped for good (auth, missing ffmpeg, file ended)
//   onStall(secondsSilent)     no frames for stallMs while "running"
function startRtspZoneResilient(cfg, handlers) {
  const stats = cfg.stats || newStats();
  const stallMs = cfg.stallMs || 15000;
  const killAfterMs = cfg.killAfterMs || 30000;
  let child = null, stopped = false, backoff = 2000, connectedAt = 0, stallWarned = false, stallKilled = false;

  function connect() {
    if (stopped) return;
    connectedAt = Date.now();
    stallWarned = false; stallKilled = false;
    stats._fpsWindow = []; stats._fpsSince = connectedAt;
    child = startRtspZone(Object.assign({}, cfg, { stats }), Object.assign({}, handlers, {
      onFlowing: () => {
        backoff = 2000;
        stats.lastError = null; stats.lastErrorKind = null;
        if (handlers.onFlowing) handlers.onFlowing();
      },
      onClose: (code, info, tailText) => {
        child = null;
        if (stopped) return;
        if (stallKilled) info = { kind: 'stall', fatal: false, message: 'Connected, but no picture arrived for 30 s.', fix: 'reconnecting. If this keeps happening, check the network cable to the recorder.' };
        stats.streamOk = false;
        stats.fps = 0;
        stats.lastError = info.message;
        stats.lastErrorKind = info.kind;
        if (info.fatal || info.kind === 'eof' || (code === 0 && !isNetworkInput(cfg.cameraUrl))) {
          stopped = true;
          stats.fps = 0;
          clearInterval(watch);
          if (handlers.onFatal) handlers.onFatal(info, tailText);
          return;
        }
        if (handlers.onClose) handlers.onClose(code, info, tailText, backoff);
        setTimeout(connect, backoff);
        backoff = Math.min(60000, backoff * 2);
      },
    }));
  }

  // Watchdog: ffmpeg can sit connected with no frames (NVR half-hung,
  // Wi-Fi dropped without a reset). Warn at stallMs, force a reconnect
  // at killAfterMs.
  const watch = setInterval(() => {
    if (stopped || !child) return;
    updateFps(stats, Date.now());
    const since = Math.max(stats.lastFrameAt || 0, connectedAt);
    const silent = Date.now() - since;
    if (silent >= stallMs) {
      stats.streamOk = false;
      if (!stallWarned) { stallWarned = true; if (handlers.onStall) handlers.onStall(Math.round(silent / 1000)); }
    }
    if (silent >= killAfterMs && isNetworkInput(cfg.cameraUrl)) {
      stats.lastError = `No picture for ${Math.round(silent / 1000)} s — reconnecting.`;
      if (child && !stallKilled) { stallKilled = true; child.kill(); }
    }
  }, 1000);
  if (watch.unref) watch.unref();

  connect();
  return {
    stop() { stopped = true; clearInterval(watch); if (child) child.stop(); },
    stats,
    get stopped() { return stopped; },
    get lastVerdict() { return child && child.lastVerdict; },
    get noiseFloor() { return stats.noiseFloor; },
  };
}

module.exports = {
  startRtspZone, startRtspZoneResilient, probeStream, snapshot,
  classifyFfmpegError, cropFilter, resolveCrop, jpegSize, zoneArgs, fitFilter, inputArgs, isNetworkInput, isRtsp,
  ffmpegAvailable, ffmpegMajor, killAll, parseStreamInfo, newStats,
};
