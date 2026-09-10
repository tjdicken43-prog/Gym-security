#!/usr/bin/env node
// Finds the working RTSP address for your cameras.
//
//   node find-camera.js 192.168.1.64 admin yourpassword
//
// Anpviz (and most budget IP camera brands) use several different RTSP
// URL formats depending on the model and firmware, and the manual often
// lists the wrong one. Rather than guess, this tries every format that's
// known to work on these cameras and tells you which one actually
// connects — plus the resolution, so you know you got the main stream
// and not the low-res substream.
//
// Needs ffmpeg installed. Nothing else.

const { spawn } = require('child_process');

const [ip, user, pass, chan] = process.argv.slice(2);
if (!ip) {
  console.log(`
Usage:  node find-camera.js <camera-ip> [username] [password] [channel]

Examples:
  node find-camera.js 192.168.1.64 admin mypassword
  node find-camera.js 192.168.1.64 admin mypassword 2     (second camera on an NVR)

Don't know the IP? See the notes printed at the end.
`);
  process.exit(0);
}

const u = user || 'admin';
const p = pass || '';
const ch = parseInt(chan, 10) || 1;
const auth = p ? `${encodeURIComponent(u)}:${encodeURIComponent(p)}@` : `${encodeURIComponent(u)}@`;

// Every format these cameras are known to use, main stream first.
const CANDIDATES = [
  { url: `rtsp://${auth}${ip}:554/Streaming/Channels/${ch}01`, note: 'Hikvision-style main stream (most common on Anpviz)' },
  { url: `rtsp://${auth}${ip}:554/Streaming/Channels/${ch}02`, note: 'Hikvision-style sub stream (lower res)' },
  { url: `rtsp://${auth}${ip}:554/stream0`,                    note: 'stream0 main' },
  { url: `rtsp://${auth}${ip}:554/stream1`,                    note: 'stream1 sub' },
  { url: `rtsp://${ip}:554/h264?username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}`, note: 'query-string auth, main' },
  { url: `rtsp://${ip}:554/h264cif?username=${encodeURIComponent(u)}&password=${encodeURIComponent(p)}`, note: 'query-string auth, sub' },
  { url: `rtsp://${auth}${ip}:554/live/mpeg4`,                 note: 'live/mpeg4' },
  { url: `rtsp://${auth}${ip}:554/cam/realmonitor?channel=${ch}&subtype=0`, note: 'Dahua-style main' },
  { url: `rtsp://${auth}${ip}:554/11`,                         note: 'short-form main' },
  { url: `rtsp://${auth}${ip}:554/`,                           note: 'bare root' },
];

function mask(url) { return url.replace(/\/\/[^@]*@/, '//***:***@'); }

// ffprobe would be tidier but isn't always installed alongside ffmpeg, so
// this uses ffmpeg itself and reads what it reports on stderr.
function test(url) {
  return new Promise(resolve => {
    const ff = spawn('ffmpeg', [
      '-loglevel', 'info', '-rtsp_transport', 'tcp',
      '-i', url, '-frames:v', '1', '-f', 'null', '-',
    ]);
    let err = '';
    const timer = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} }, 12000);
    ff.stderr.on('data', d => { err += d.toString(); });
    ff.on('error', () => { clearTimeout(timer); resolve({ ok: false, why: 'ffmpeg not found' }); });
    ff.on('close', code => {
      clearTimeout(timer);
      const m = err.match(/Video:\s*([a-z0-9]+).*?(\d{3,4})x(\d{3,4})/i);
      if (code === 0 && m) {
        resolve({ ok: true, codec: m[1], w: +m[2], h: +m[3] });
      } else {
        let why = 'no response';
        if (/401|[Uu]nauthorized/.test(err)) why = 'wrong username or password';
        else if (/Connection refused/.test(err)) why = 'nothing listening on 554';
        else if (/404|[Nn]ot [Ff]ound/.test(err)) why = 'wrong path for this model';
        else if (/timed out|Timeout/i.test(err)) why = 'timed out';
        resolve({ ok: false, why });
      }
    });
  });
}

(async () => {
  console.log(`\nTesting ${CANDIDATES.length} known Anpviz address formats against ${ip}`);
  console.log('This takes a minute. Each one gets up to 12 seconds.\n');

  const working = [];
  for (const c of CANDIDATES) {
    process.stdout.write('  trying ' + c.note.padEnd(52));
    const r = await test(c.url);
    if (r.ok) {
      console.log(`WORKS  ${r.w}x${r.h} ${r.codec}`);
      working.push(Object.assign({}, c, r));
    } else {
      console.log(`no  (${r.why})`);
      if (r.why === 'ffmpeg not found') {
        console.log('\nffmpeg is not installed. Install it first:');
        console.log('  Windows:  download from ffmpeg.org, add to PATH');
        console.log('  Mac:      brew install ffmpeg');
        console.log('  Linux:    sudo apt install ffmpeg\n');
        process.exit(1);
      }
    }
  }

  console.log('');
  if (!working.length) {
    console.log('Nothing connected. Most likely causes, in order:');
    console.log('  1. Wrong password. Anpviz ships as admin / 123456 — but if it was');
    console.log('     set up properly that was changed. Check the NVR or ask whoever installed it.');
    console.log('  2. Wrong IP. See below.');
    console.log('  3. RTSP switched off in the camera settings. Log into the camera in a');
    console.log('     browser (http://' + ip + ') and look under Network > Advanced.');
    console.log('  4. This computer is on a different network from the cameras.');
  } else {
    // Prefer the highest resolution that connected — that's the main stream.
    working.sort((a, b) => (b.w * b.h) - (a.w * a.h));
    const best = working[0];
    console.log('USE THIS ONE:\n');
    console.log('  ' + best.url);
    console.log(`  (${best.w}x${best.h} ${best.codec} — ${best.note})\n`);
    console.log('Paste it into rtsp-zones.json as "cameraUrl". For your other cameras,');
    console.log('the address is usually the same with a different channel number:');
    console.log('  ...Channels/101  = camera 1');
    console.log('  ...Channels/201  = camera 2');
    console.log('  ...Channels/301  = camera 3');
    console.log('\nOr re-run this with a channel number:  node find-camera.js ' + ip + ' ' + u + ' <pass> 2');
    if (working.length > 1) {
      console.log('\nOthers that also worked (lower resolution, usable if you want to save bandwidth):');
      working.slice(1).forEach(w => console.log(`  ${w.w}x${w.h}  ${mask(w.url)}`));
    }
  }

  console.log(`
--- Finding your camera's IP address ---
  * Log into your router and look at connected devices for something named
    like IPC, ANPVIZ, or an unfamiliar device.
  * Or in the NVR's own menu: Network, or Camera / Channel Management —
    each camera's IP is listed there.
  * Anpviz cameras ship at 192.168.0.123 if never configured.
  * On Windows you can also run:  arp -a
    and look for addresses in your camera's range.
`);
})();
