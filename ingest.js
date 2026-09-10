// Camera ingest — receives snapshots the cameras push to us.
//
// This is the path that needs NOTHING running at the gym. The camera's own
// AI decides a human crossed the line, and pushes a snapshot out. We just
// have to be somewhere it can reach, and answer the question the camera
// can't: how many people, versus how many were expected.
//
// Three ways in, because different cameras support different things:
//
//   FTP        — the most widely supported on budget IP cameras. A tiny
//                FTP server is implemented here; no external dependency.
//   Folder     — if the camera writes to a NAS or shared folder, point us
//                at it and we pick up new files.
//   HTTP POST  — for cameras with webhook / HTTP notification support.
//
// Snapshots that arrive close together from the same camera are grouped
// into one event, so a camera that pushes three frames per trigger gets
// analysed as a sequence rather than three separate entries.

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');

const GROUP_WINDOW_MS = 4000;   // snapshots this close together are one event
const MAX_GROUP = 4;            // never send more than this many to analysis

// ---------------------------------------------------------------------
// Event grouping
// ---------------------------------------------------------------------
const pending = new Map();      // cameraKey -> { frames:[], timer, firstAt }

function isJpeg(b) {
  return b && b.length > 3 && b[0] === 0xFF && b[1] === 0xD8 && b[b.length - 2] === 0xFF && b[b.length - 1] === 0xD9;
}

function submit(cameraKey, jpegBuffer, handlers) {
  // Cameras occasionally upload log files, thumbnails or truncated
  // transfers into the same folder. Analysing those wastes money and
  // produces nonsense, so anything that isn't a complete JPEG is dropped.
  if (!jpegBuffer || jpegBuffer.length < 512 || !isJpeg(jpegBuffer)) {
    if (handlers && handlers.onRejected) handlers.onRejected(cameraKey, jpegBuffer ? jpegBuffer.length : 0);
    return;
  }
  let g = pending.get(cameraKey);
  if (!g) {
    g = { frames: [], timer: null, firstAt: Date.now() };
    pending.set(cameraKey, g);
  }
  if (g.frames.length < MAX_GROUP) g.frames.push(jpegBuffer);
  clearTimeout(g.timer);
  g.timer = setTimeout(() => {
    pending.delete(cameraKey);
    const durationSec = ((Date.now() - g.firstAt) / 1000).toFixed(1);
    handlers.onEvent(cameraKey, g.frames, { durationSec, frameCount: g.frames.length });
  }, GROUP_WINDOW_MS);
}

// Cameras name uploads all sorts of ways. Pull something stable out of the
// path so two cameras pushing to the same server don't get mixed up.
// Cameras nest uploads inside dated folders — /IPC-D3083/2026-09-09/ — so
// walking back from the filename finds the date before the camera name.
// Skip anything that looks like a date, time or bare number.
function looksLikeDateOrTime(seg) {
  return /^\d{2,4}([-_.]?\d{1,2}){0,4}$/.test(seg)   // 2026-09-09, 20260909, 14-05
      || /^\d+$/.test(seg)                            // 01, 1234
      || /^(19|20)\d{2}$/.test(seg);                  // a bare year
}

function cameraKeyFromPath(p, fallback) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  for (const seg of parts.slice(0, -1).reverse()) {
    if (!/^[A-Za-z0-9_.-]{2,40}$/.test(seg)) continue;
    if (looksLikeDateOrTime(seg)) continue;
    return seg;
  }
  return fallback || 'camera';
}

// ---------------------------------------------------------------------
// FTP server — minimal, but implements what cameras actually use
// ---------------------------------------------------------------------
function startFtpServer(opts, handlers) {
  const port = opts.port || 2121;
  const user = opts.user || 'camera';
  const pass = opts.pass || null;         // null = accept any password
  // Passive-mode data ports. These are held only for the duration of one
  // transfer — an earlier version kept each listener open for 60 seconds,
  // which meant a camera pushing rapidly during a motion storm exhausted
  // the range and every upload after that failed with 425. The range is
  // also wider now, and a busy port is skipped rather than fatal.
  const pasvMin = opts.pasvMin || 30000;
  const pasvMax = opts.pasvMax || 30100;
  let pasvCursor = pasvMin;

  const server = net.createServer(sock => {
    const state = { user: null, authed: !pass, cwd: '/', type: 'I', pasv: null };
    const say = (code, msg) => sock.write(`${code} ${msg}\r\n`);
    say(220, 'SecurityAI ingest ready');

    let buf = '';
    sock.on('data', chunk => {
      buf += chunk.toString('binary');
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        handleCommand(line);
      }
    });
    sock.on('error', () => {});

    function openPasv(cb, attempt) {
      const tries = attempt || 0;
      if (tries > 20) return say(425, 'No free data port');

      const p = pasvCursor++;
      if (pasvCursor > pasvMax) pasvCursor = pasvMin;

      // Close the previous listener before opening another, so a client
      // issuing PASV repeatedly can't leak ports.
      if (state.pasv) { try { state.pasv.close(); } catch (e) {} state.pasv = null; }

      const data = net.createServer(dsock => {
        // One transfer per listener: stop accepting the moment it's used.
        try { data.close(); } catch (e) {}
        if (state.pasv === data) state.pasv = null;
        cb(dsock);
      });

      data.on('error', err => {
        // Port busy is normal under load — just take the next one.
        if (err && err.code === 'EADDRINUSE') return openPasv(cb, tries + 1);
        say(425, 'Cannot open data connection');
      });

      data.listen(p, () => {
        const host = (opts.publicHost || sock.localAddress || '127.0.0.1').replace(/^::ffff:/, '');
        const [a, b, c, d] = host.split('.');
        say(227, `Entering Passive Mode (${a},${b},${c},${d},${p >> 8},${p & 255})`);
      });
      state.pasv = data;

      // Safety net only — a client that asks for PASV then never connects
      // shouldn't hold the port forever.
      setTimeout(() => { try { data.close(); } catch (e) {} }, 30000);
    }

    function handleCommand(line) {
      const sp = line.indexOf(' ');
      const cmd = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
      const arg = sp === -1 ? '' : line.slice(sp + 1);

      switch (cmd) {
        case 'USER': state.user = arg; return say(pass ? 331 : 230, pass ? 'Password required' : 'Logged in');
        case 'PASS':
          state.authed = !pass || arg === pass;
          return say(state.authed ? 230 : 530, state.authed ? 'Logged in' : 'Not logged in');
        case 'SYST': return say(215, 'UNIX Type: L8');
        case 'FEAT': return sock.write('211-Features\r\n PASV\r\n211 End\r\n');
        case 'TYPE': state.type = arg.toUpperCase(); return say(200, 'Type set');
        case 'PWD':  return say(257, `"${state.cwd}" is current directory`);
        case 'CWD':  state.cwd = arg.startsWith('/') ? arg : path.posix.join(state.cwd, arg); return say(250, 'Directory changed');
        case 'CDUP': state.cwd = path.posix.dirname(state.cwd); return say(250, 'Directory changed');
        // Cameras create dated folders before uploading. We don't keep a
        // real filesystem, so just agree.
        case 'MKD':  return say(257, `"${arg}" created`);
        case 'DELE': case 'RMD': return say(250, 'OK');
        case 'NOOP': return say(200, 'OK');
        case 'PASV': return openPasv(dsock => { state.dataSock = dsock; });
        case 'STOR': {
          if (!state.authed) return say(530, 'Not logged in');
          const full = arg.startsWith('/') ? arg : path.posix.join(state.cwd, arg);
          const key = cameraKeyFromPath(full, opts.defaultCamera);
          say(150, 'Opening data connection');
          const collect = dsock => {
            const chunks = [];
            let total = 0;
            // A doorway snapshot is well under a megabyte. Anything wildly
            // larger is a misconfigured camera or something that isn't an
            // image, and buffering it would be an easy way to exhaust memory.
            const MAX_UPLOAD = (opts.maxUploadBytes || 12 * 1024 * 1024);
            dsock.on('data', d => {
              total += d.length;
              if (total > MAX_UPLOAD) { try { dsock.destroy(); } catch (e) {} return; }
              chunks.push(d);
            });
            dsock.on('close', () => { if (total > MAX_UPLOAD) say(552, 'File too large'); });
            dsock.on('end', () => {
              if (total > MAX_UPLOAD) return;
              const jpeg = Buffer.concat(chunks);
              say(226, 'Transfer complete');
              submit(key, jpeg, handlers);
              if (handlers.onUpload) handlers.onUpload(key, full, jpeg.length);
            });
            dsock.on('error', () => say(426, 'Transfer aborted'));
          };
          if (state.dataSock) { collect(state.dataSock); state.dataSock = null; }
          else if (state.pasv) state.pasv.once('connection', collect);
          else say(425, 'Use PASV first');
          return;
        }
        case 'QUIT': say(221, 'Goodbye'); return sock.end();
        default: return say(502, 'Not implemented');
      }
    }
  });

  server.listen(port, () => {
    if (handlers.onReady) handlers.onReady({ transport: 'ftp', port, user });
  });
  return { stop() { try { server.close(); } catch (e) {} }, port };
}

// ---------------------------------------------------------------------
// Folder watcher — camera writes to a NAS/shared folder, we pick it up
// ---------------------------------------------------------------------
function startFolderWatch(dir, handlers) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const seen = new Set();

  function scan() {
    const walk = d => {
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!/\.jpe?g$/i.test(e.name) || seen.has(full)) continue;
        let st;
        try { st = fs.statSync(full); } catch (e2) { continue; }
        // Wait until the file has stopped growing, or we'd read a
        // half-written upload.
        if (Date.now() - st.mtimeMs < 1200) continue;
        seen.add(full);
        try {
          submit(cameraKeyFromPath(full, path.basename(d)), fs.readFileSync(full), handlers);
          if (handlers.onUpload) handlers.onUpload(cameraKeyFromPath(full, path.basename(d)), full, st.size);
        } catch (e3) { /* skip unreadable file */ }
      }
    };
    walk(dir);
    if (seen.size > 5000) seen.clear();
  }

  const timer = setInterval(scan, 1000);
  if (timer.unref) timer.unref();
  scan();
  if (handlers.onReady) handlers.onReady({ transport: 'folder', dir });
  return { stop() { clearInterval(timer); }, dir };
}

// ---------------------------------------------------------------------
// HTTP push — call this from an Express route
// ---------------------------------------------------------------------
function acceptHttpPush(cameraKey, jpegBuffer, handlers) {
  submit(cameraKey || 'camera', jpegBuffer, handlers);
}

module.exports = {
  startFtpServer, startFolderWatch, acceptHttpPush,
  cameraKeyFromPath, isJpeg, GROUP_WINDOW_MS,
};
