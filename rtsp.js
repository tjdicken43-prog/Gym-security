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

const { spawn } = require('child_process');
const detect = require('./detect');

const GRID = detect.DIFF_GRID;
const TICK_MS = detect.MOTION_CHECK_MS;

// ffmpeg is asked for two parallel outputs from one connection:
//   1. a tiny GRIDxGRID grayscale stream for motion maths (nearly free)
//   2. full-size JPEGs only when we decide we want one
// Rather than run two processes, we pull the small stream continuously
// and keep a rolling buffer of recent JPEGs from a second low-rate
// stream. Simplest reliable approach that doesn't decode 1080p 4x/sec.
function startRtspZone(cfg, handlers) {
  const fps = Math.round(1000 / TICK_MS);
  const args = [
    '-loglevel', 'error',
    '-rtsp_transport', 'tcp',
    '-i', cfg.cameraUrl,
    // crop to the zone, then two outputs
    '-filter_complex',
    `[0:v]crop=${cfg.cropW}:${cfg.cropH}:${cfg.cropX}:${cfg.cropY},split=2[a][b];` +
    `[a]fps=${fps},scale=${GRID}:${GRID},format=gray[small];` +
    `[b]fps=${fps},scale=${cfg.jpegMaxPx || 384}:-1[big]`,
    '-map', '[small]', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:3',
    '-map', '[big]', '-f', 'image2pipe', '-vcodec', 'mjpeg', '-q:v', '6', 'pipe:4',
  ];

  const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });

  let stderr = '';
  ff.stderr.on('data', d => { stderr += d.toString().slice(-2000); });

  // --- tiny grayscale frames -> detection ---
  const frameBytes = GRID * GRID;
  let acc = Buffer.alloc(0);
  const zoneState = {};
  detect.resetZone(zoneState);

  // rolling buffer of recent JPEGs, so when an event ends we can pick
  // frames from across it rather than only the current instant
  const jpegBuf = [];
  const JPEG_BUF_MAX = 60;

  ff.stdio[3].on('data', chunk => {
    acc = Buffer.concat([acc, chunk]);
    while (acc.length >= frameBytes) {
      const raw = acc.subarray(0, frameBytes);
      acc = acc.subarray(frameBytes);
      const cells = Array.from(raw);            // already luminance 0-255
      const step = detect.stepZone(zoneState, cells, cfg.sensitivity, {
        onCapture: () => { zoneState._eventJpegs = (zoneState._eventJpegs || []).concat(jpegBuf.slice(-1)); },
      });
      if (step.verdict && handlers.onVerdict) handlers.onVerdict(step.verdict);
      if (step.send) {
        const picks = detect.selectEventFrames(zoneState._eventJpegs || [], detect.EVENT_FRAMES_SENT);
        zoneState._eventJpegs = [];
        if (picks.length >= 2) handlers.onEvent(picks.map(b => b.toString('base64')), step.send);
      } else if (step.rejected) {
        zoneState._eventJpegs = [];
        if (handlers.onRejected) handlers.onRejected(step.rejected);
      }
    }
  });

  // --- full-size JPEGs -> rolling buffer ---
  // mjpeg over a pipe needs framing on SOI/EOI markers.
  let jbuf = Buffer.alloc(0);
  ff.stdio[4].on('data', chunk => {
    jbuf = Buffer.concat([jbuf, chunk]);
    for (;;) {
      const start = jbuf.indexOf(Buffer.from([0xFF, 0xD8]));
      if (start === -1) { jbuf = Buffer.alloc(0); break; }
      const end = jbuf.indexOf(Buffer.from([0xFF, 0xD9]), start + 2);
      if (end === -1) { if (start > 0) jbuf = jbuf.subarray(start); break; }
      jpegBuf.push(jbuf.subarray(start, end + 2));
      if (jpegBuf.length > JPEG_BUF_MAX) jpegBuf.shift();
      jbuf = jbuf.subarray(end + 2);
    }
  });

  ff.on('error', err => handlers.onError && handlers.onError(
    `ffmpeg failed to start — is it installed and on PATH? (${err.message})`));
  ff.on('close', code => handlers.onClose && handlers.onClose(code, stderr.slice(-400)));

  return {
    stop() { try { ff.kill('SIGTERM'); } catch (e) { /* already gone */ } },
    get lastVerdict() { return zoneState.lastVerdict; },
    get noiseFloor() { return zoneState.noiseFloor; },
  };
}

// Wraps startRtspZone with automatic reconnect — cameras drop, networks
// blip, and an overnight service that gives up on the first hiccup is
// worse than useless.
function startRtspZoneResilient(cfg, handlers) {
  let child = null, stopped = false, backoff = 2000;
  function connect() {
    if (stopped) return;
    child = startRtspZone(cfg, Object.assign({}, handlers, {
      onEvent: (...a) => { backoff = 2000; handlers.onEvent(...a); },
      onClose: (code, tail) => {
        if (stopped) return;
        if (handlers.onClose) handlers.onClose(code, tail);
        setTimeout(connect, backoff);
        backoff = Math.min(60000, backoff * 2);
      },
    }));
  }
  connect();
  return {
    stop() { stopped = true; if (child) child.stop(); },
    get lastVerdict() { return child && child.lastVerdict; },
    get noiseFloor() { return child && child.noiseFloor; },
  };
}

module.exports = { startRtspZone, startRtspZoneResilient };
