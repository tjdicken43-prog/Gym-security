// Standalone RTSP runner — Option C, no browser involved at all.
//
//   1. cp rtsp-zones.example.json rtsp-zones.json  (and edit it)
//   2. node rtsp-run.js
//
// Runs until you stop it. Pair with pm2 or a systemd unit and it survives
// reboots, which none of the browser-based paths can.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const detect = require('./detect');
const { startRtspZoneResilient } = require('./rtsp');
const monitor = require('./monitor');

const CONFIG = process.env.RTSP_CONFIG || path.join(__dirname, 'rtsp-zones.json');
if (!fs.existsSync(CONFIG)) {
  console.error(`No config at ${CONFIG}. Copy rtsp-zones.example.json and edit it.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set — nothing could be analyzed. Set it in .env.');
  process.exit(1);
}

monitor.start({
  sourceType: 'browser-push',       // frames are pushed in, same as the dashboard does
  gymCode: cfg.gymCode || null,
  scheduleStart: cfg.scheduleStart || null,
  scheduleEnd: cfg.scheduleEnd || null,
  tzOffsetMinutes: new Date().getTimezoneOffset(),
  model: cfg.model || null,
  dailyBurstCap: cfg.dailyBurstCap,
  alertEmail: cfg.alertEmail || null,
  alertPhone: cfg.alertPhone || null,
  label: cfg.label || 'RTSP',
});

const sens = detect.SENSITIVITY[cfg.sensitivity] || detect.SENSITIVITY.moderate;
const handles = [];

for (const z of cfg.zones || []) {
  console.log(`Watching "${z.label}" on ${z.cameraUrl.replace(/\/\/.*@/, '//***@')}`);
  handles.push(startRtspZoneResilient(
    {
      cameraUrl: z.cameraUrl,
      cropX: z.cropX, cropY: z.cropY, cropW: z.cropW, cropH: z.cropH,
      sensitivity: sens,
      jpegMaxPx: 384,
    },
    {
      onEvent: async (framesB64, ev) => {
        try {
          await monitor.pushBurst(framesB64, {
            label: z.label,
            expectedCount: z.expectedCount || 1,
            accessibleGate: !!z.accessibleGate,
            durationSec: ev.durationSec,
          }, framesB64[framesB64.length - 1]);
          console.log(`[${new Date().toLocaleTimeString()}] ${z.label}: crossing analyzed (${ev.durationSec}s)`);
        } catch (err) { console.warn(`${z.label}: ${err.message}`); }
      },
      onError: msg => console.error(`${z.label}: ${msg}`),
      onClose: (code, tail) => console.warn(`${z.label}: stream ended (${code}) — reconnecting. ${tail || ''}`),
    }
  ));
}

// Heartbeat so the dead-man's switch protects this path too.
setInterval(() => monitor.recordHeartbeat(), 30000);
monitor.recordHeartbeat();

function shutdown() {
  console.log('\nStopping…');
  handles.forEach(h => h.stop());
  monitor.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
console.log(`Running. Schedule ${cfg.scheduleStart || 'always'}–${cfg.scheduleEnd || 'always'}. Ctrl-C to stop.`);
