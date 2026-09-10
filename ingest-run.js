#!/usr/bin/env node
// Runs the ingest server — the route that needs nothing at the gym.
//
//   cp ingest-zones.example.json ingest-zones.json   (and edit)
//   node ingest-run.js
//
// The cameras' own AI decides a human crossed, and pushes snapshots here.
// We answer the question they can't: how many people, versus how many
// were expected.

// dotenv is convenient but not essential — if it isn't installed yet, or
// there's no .env file, fall back to whatever is already in the
// environment rather than crashing with a module-not-found stack trace.
try { require('dotenv').config(); } catch (e) { /* env vars can be set directly */ }
const fs = require('fs');
const path = require('path');
const ingest = require('./ingest');
const emailIngest = require('./email-ingest');
const monitor = require('./monitor');

const CONFIG = process.env.INGEST_CONFIG || path.join(__dirname, 'ingest-zones.json');
if (!fs.existsSync(CONFIG)) {
  console.error(`No config at ${CONFIG}. Copy ingest-zones.example.json and edit it.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — nothing could be analyzed.');
  process.exit(1);
}

monitor.start({
  sourceType: 'browser-push',
  gymCode: cfg.gymCode || null,
  scheduleStart: cfg.scheduleStart || null,
  scheduleEnd: cfg.scheduleEnd || null,
  tzOffsetMinutes: new Date().getTimezoneOffset(),
  model: cfg.model || null,
  dailyBurstCap: cfg.dailyBurstCap,
  alertEmail: cfg.alertEmail || null,
  alertPhone: cfg.alertPhone || null,
  label: cfg.label || 'Camera ingest',
});

// Map an incoming camera name onto the rules for that doorway. Names come
// from the folder the camera uploads into, so they're matched loosely.
function zoneFor(cameraKey) {
  const k = String(cameraKey).toLowerCase();
  const z = (cfg.cameras || []).find(c =>
    k === String(c.match).toLowerCase() || k.includes(String(c.match).toLowerCase()));
  return z || cfg.defaultCamera || { label: cameraKey, expectedCount: 1, accessibleGate: false };
}

const handlers = {
  onReady: info => console.log(info.transport === 'ftp'
    ? `FTP ingest listening on port ${info.port} (user "${info.user}")`
    : `Watching folder ${info.dir}`),
  onUpload: (cam, p, bytes) => {
    if (cfg.verbose) console.log(`  <- ${cam}: ${path.basename(p)} (${bytes} bytes)`);
  },
  onEvent: async (cameraKey, frames, meta) => {
    const z = zoneFor(cameraKey);
    const b64 = frames.map(f => f.toString('base64'));
    try {
      const r = await monitor.pushBurst(b64, {
        label: z.label || cameraKey,
        expectedCount: z.expectedCount || 1,
        accessibleGate: !!z.accessibleGate,
        durationSec: meta.durationSec,
      }, b64[b64.length - 1]);
      if (r && r.skipped) console.log(`[${new Date().toLocaleTimeString()}] ${z.label}: skipped (${r.skipped})`);
      else console.log(`[${new Date().toLocaleTimeString()}] ${z.label}: ${meta.frameCount} frame(s) analyzed`);
    } catch (err) {
      console.warn(`${z.label}: ${err.message}`);
    }
  },
};

const running = [];
if (cfg.ftp !== false) {
  running.push(ingest.startFtpServer({
    port: cfg.ftpPort || 2121,
    user: cfg.ftpUser || 'camera',
    pass: cfg.ftpPass || null,
    publicHost: cfg.publicHost,
    defaultCamera: 'camera',
  }, handlers));
}
if (cfg.watchFolder) running.push(ingest.startFolderWatch(cfg.watchFolder, handlers));

// Email route — the NVR sends a snapshot to a mailbox and we poll it.
// This is the only route that needs nothing whatsoever at the gym, so
// it's the right one when there's no machine to leave behind.
if (cfg.email && cfg.email.host) {
  running.push(emailIngest.startEmailIngest(cfg.email, Object.assign({}, handlers, {
    onPoll: n => { if (cfg.verbose) console.log(`  mailbox: ${n} new message(s)`); },
    onSkipped: id => { if (cfg.verbose) console.log(`  message ${id}: no usable image, skipped`); },
    onError: msg => console.warn('  mailbox error: ' + msg),
  })));
}

setInterval(() => monitor.recordHeartbeat(), 30000);
monitor.recordHeartbeat();

function shutdown() { console.log('\nStopping…'); running.forEach(r => r.stop()); monitor.stop(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`Ready. Schedule ${cfg.scheduleStart || 'always'}–${cfg.scheduleEnd || 'always'}. Ctrl-C to stop.`);
