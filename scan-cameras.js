#!/usr/bin/env node
// Camera scanner — works out what's actually on the other end.
//
//   node scan-cameras.js 192.168.1.0/24            find everything on the network
//   node scan-cameras.js 192.168.1.64 admin pass   identify one camera in detail
//
// Written because "it's an Anpviz" isn't enough to configure anything.
// Two cameras from the same brand can want different RTSP paths, and the
// printed manual is often wrong. This probes the device and reports what
// it actually answers to: brand, model, RTSP address, whether it can push
// snapshots to us, and which of the three setup routes will work.
//
// Only reads. Nothing here changes a camera's settings.

const net = require('net');
const http = require('http');
const { spawn } = require('child_process');

const CONNECT_TIMEOUT = 1200;
const HTTP_TIMEOUT = 2500;

// --- basics ----------------------------------------------------------
function tcpOpen(host, port, timeout) {
  return new Promise(resolve => {
    const s = new net.Socket();
    let done = false;
    const finish = v => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(v); } };
    s.setTimeout(timeout || CONNECT_TIMEOUT);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
    s.connect(port, host);
  });
}

function httpGet(host, port, path_, auth) {
  return new Promise(resolve => {
    const req = http.request({
      host, port, path: path_, method: 'GET', timeout: HTTP_TIMEOUT,
      headers: auth ? { Authorization: 'Basic ' + Buffer.from(auth).toString('base64') } : {},
    }, res => {
      let body = '';
      res.on('data', d => { if (body.length < 8000) body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// --- fingerprinting --------------------------------------------------
// Signatures are ordered most-specific first. Several budget brands ship
// Hikvision-derived firmware, so a Hikvision-style API does NOT prove it's
// a Hikvision — hence checking branding strings before API shape.
const SIGNATURES = [
  { brand: 'Anpviz',     test: t => /anpviz/i.test(t) },
  { brand: 'Hikvision',  test: t => /hikvision|\bDS-[0-9]/i.test(t) },
  { brand: 'Dahua',      test: t => /dahua|\bIPC-HF|\bDH-/i.test(t) },
  { brand: 'Reolink',    test: t => /reolink/i.test(t) },
  { brand: 'Amcrest',    test: t => /amcrest/i.test(t) },
  { brand: 'Uniview',    test: t => /uniview|\bUNV\b/i.test(t) },
  { brand: 'Axis',       test: t => /axis communications|\bAXIS\b/i.test(t) },
  { brand: 'Lorex',      test: t => /lorex/i.test(t) },
  { brand: 'Swann',      test: t => /swann/i.test(t) },
  { brand: 'Annke',      test: t => /annke/i.test(t) },
  { brand: 'Foscam',     test: t => /foscam/i.test(t) },
  { brand: 'TP-Link/Tapo', test: t => /tp-?link|tapo|vigi/i.test(t) },
  { brand: 'Ubiquiti',   test: t => /ubiquiti|unifi/i.test(t) },
];

// Pages that tend to reveal branding without needing credentials.
const PROBE_PATHS = [
  '/', '/doc/page/login.asp', '/index.html', '/login.html',
  '/cgi-bin/magicBox.cgi?action=getDeviceType',
  '/ISAPI/System/deviceInfo', '/System/deviceInfo',
  '/onvif/device_service', '/web/index.html',
];

// RTSP paths worth trying, grouped by the family that uses them.
const RTSP_PATHS = [
  { p: '/Streaming/Channels/101', fam: 'Hikvision-style' },
  { p: '/cam/realmonitor?channel=1&subtype=0', fam: 'Dahua-style' },
  { p: '/stream0', fam: 'stream0' },
  { p: '/h264Preview_01_main', fam: 'Reolink' },
  { p: '/live/mpeg4', fam: 'live/mpeg4' },
  { p: '/axis-media/media.amp', fam: 'Axis' },
  { p: '/11', fam: 'short-form' },
  { p: '/', fam: 'bare root' },
];

async function identify(host, user, pass) {
  const out = {
    host, reachable: false, brand: null, model: null, firmware: null,
    openPorts: [], rtsp: null, rtspCandidates: [], onvif: false,
    canPushFtp: null, notes: [], recommendation: null,
  };

  const ports = [80, 554, 8000, 8080, 443, 2020];
  const results = await Promise.all(ports.map(p => tcpOpen(host, p)));
  out.openPorts = ports.filter((p, i) => results[i]);
  out.reachable = out.openPorts.length > 0;
  if (!out.reachable) { out.notes.push('Nothing answering — wrong IP, or a different network.'); return out; }

  // branding + model from whatever the web interface will tell us
  const auth = user ? `${user}:${pass || ''}` : null;
  const webPort = out.openPorts.includes(80) ? 80 : (out.openPorts.includes(8080) ? 8080 : null);
  if (webPort) {
    let combined = '';
    for (const path_ of PROBE_PATHS) {
      const r = await httpGet(host, webPort, path_, auth);
      if (!r) continue;
      combined += ' ' + (r.headers.server || '') + ' ' + (r.headers['www-authenticate'] || '') + ' ' + r.body;
      const m = r.body.match(/<model>([^<]+)<\/model>/i) || r.body.match(/"deviceModel"\s*:\s*"([^"]+)"/i);
      if (m && !out.model) out.model = m[1].trim();
      const f = r.body.match(/<firmwareVersion>([^<]+)<\/firmwareVersion>/i);
      if (f && !out.firmware) out.firmware = f[1].trim();
      if (/onvif/i.test(r.body) || path_.includes('onvif')) out.onvif = true;
      if (r.status === 401 && !auth) out.notes.push('Web interface needs a login — pass a username and password for more detail.');
    }
    for (const sig of SIGNATURES) {
      if (sig.test(combined)) { out.brand = sig.brand; break; }
    }
    if (!out.brand && /hikvision|ISAPI/i.test(combined)) {
      out.brand = 'Hikvision-compatible (rebadged)';
      out.notes.push('Speaks the Hikvision API but does not brand itself as one — common on budget cameras.');
    }
  } else {
    out.notes.push('No web interface on 80 or 8080.');
  }

  // Which RTSP path actually works
  if (out.openPorts.includes(554)) {
    const authPart = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass || '')}@` : '';
    for (const c of RTSP_PATHS) {
      const url = `rtsp://${authPart}${host}:554${c.p}`;
      const r = await probeRtsp(url);
      if (r.ok) {
        out.rtspCandidates.push({ url, family: c.fam, resolution: `${r.w}x${r.h}`, codec: r.codec, pixels: r.w * r.h });
      } else if (r.why === 'auth') {
        out.notes.push('RTSP is up but rejected the credentials — check the username and password.');
        break;
      } else if (r.why === 'noffmpeg') {
        out.notes.push('ffmpeg not installed, so RTSP paths could not be tested.');
        break;
      }
    }
    out.rtspCandidates.sort((a, b) => b.pixels - a.pixels);
    if (out.rtspCandidates.length) out.rtsp = out.rtspCandidates[0].url;
  } else {
    out.notes.push('Port 554 closed — RTSP may be switched off in the camera settings.');
  }

  // Can it push snapshots to us? Only the web UI knows for sure, but the
  // presence of these endpoints is a strong signal.
  if (webPort && auth) {
    const ftpProbe = await httpGet(host, webPort, '/ISAPI/System/Network/ftp', auth);
    if (ftpProbe && ftpProbe.status === 200) out.canPushFtp = true;
    else if (ftpProbe && ftpProbe.status === 401) out.canPushFtp = null;
    else out.canPushFtp = false;
  }

  out.recommendation = recommend(out);
  return out;
}

function probeRtsp(url) {
  return new Promise(resolve => {
    const ff = spawn('ffmpeg', ['-loglevel', 'info', '-rtsp_transport', 'tcp', '-i', url, '-frames:v', '1', '-f', 'null', '-']);
    let err = '';
    const t = setTimeout(() => { try { ff.kill('SIGKILL'); } catch (e) {} }, 9000);
    ff.stderr.on('data', d => { err += d.toString(); });
    ff.on('error', () => { clearTimeout(t); resolve({ ok: false, why: 'noffmpeg' }); });
    ff.on('close', code => {
      clearTimeout(t);
      const m = err.match(/Video:\s*([a-z0-9]+).*?(\d{3,4})x(\d{3,4})/i);
      if (code === 0 && m) return resolve({ ok: true, codec: m[1], w: +m[2], h: +m[3] });
      resolve({ ok: false, why: /401|nauthorized/.test(err) ? 'auth' : 'no' });
    });
  });
}

function recommend(r) {
  if (r.rtsp) {
    return {
      route: 'C',
      title: 'RTSP direct — most reliable',
      why: 'This camera streams RTSP, so a small always-on box at the gym can pull frames itself. Nothing to leave open, survives reboots.',
      next: `Put this in rtsp-zones.json as cameraUrl:\n    ${r.rtsp}`,
    };
  }
  if (r.canPushFtp || r.onvif) {
    return {
      route: 'Ingest',
      title: 'Let the camera push to us',
      why: 'RTSP was not usable, but this camera looks able to upload snapshots on its own motion detection. That needs nothing running at the gym at all.',
      next: 'Point the camera\'s FTP upload at your ingest server, then run: node ingest-run.js',
    };
  }
  if (r.reachable) {
    return {
      route: 'A/B',
      title: 'Screen share or capture device',
      why: 'The camera answered but neither RTSP nor push upload could be confirmed — often just missing credentials.',
      next: 'Re-run with a username and password. If it still fails, use screen share or a USB HDMI capture stick.',
    };
  }
  return { route: '-', title: 'Not reachable', why: 'Nothing answered on this address.', next: 'Check the IP and that you are on the same network.' };
}

// --- subnet sweep ----------------------------------------------------
async function sweep(cidr, user, pass) {
  const m = cidr.match(/^(\d+\.\d+\.\d+)\.\d+\/24$/);
  if (!m) { console.log('Only /24 ranges are supported, e.g. 192.168.1.0/24'); return; }
  const base = m[1];
  console.log(`\nSweeping ${base}.1-254 for cameras. About a minute.\n`);

  const hits = [];
  const BATCH = 32;
  for (let start = 1; start <= 254; start += BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(start + BATCH, 255); i++) batch.push(`${base}.${i}`);
    const found = await Promise.all(batch.map(async ip => {
      const [http80, rtsp] = await Promise.all([tcpOpen(ip, 80, 700), tcpOpen(ip, 554, 700)]);
      return (rtsp || http80) ? { ip, rtsp, http80 } : null;
    }));
    found.filter(Boolean).forEach(h => { hits.push(h); process.stdout.write(`  found ${h.ip}${h.rtsp ? ' (RTSP)' : ''}\n`); });
  }

  if (!hits.length) { console.log('\nNothing found. Are you on the same network as the cameras?'); return; }
  console.log(`\n${hits.length} device(s) responding. Identifying the ones with RTSP…\n`);
  for (const h of hits.filter(x => x.rtsp)) {
    const r = await identify(h.ip, user, pass);
    printReport(r);
  }
}

function printReport(r) {
  console.log('─'.repeat(64));
  console.log(`  ${r.host}`);
  console.log(`  brand        ${r.brand || 'unknown'}${r.model ? '  model ' + r.model : ''}`);
  if (r.firmware) console.log(`  firmware     ${r.firmware}`);
  console.log(`  open ports   ${r.openPorts.join(', ') || 'none'}`);
  console.log(`  onvif        ${r.onvif ? 'yes' : 'not detected'}`);
  if (r.rtspCandidates.length) {
    console.log('  rtsp         ' + r.rtspCandidates[0].url);
    console.log(`               ${r.rtspCandidates[0].resolution} ${r.rtspCandidates[0].codec} (${r.rtspCandidates[0].family})`);
    r.rtspCandidates.slice(1).forEach(c => console.log(`               also works: ${c.resolution} ${c.url}`));
  } else {
    console.log('  rtsp         none of the known paths worked');
  }
  r.notes.forEach(n => console.log(`  note         ${n}`));
  if (r.recommendation) {
    console.log(`\n  USE ROUTE ${r.recommendation.route}: ${r.recommendation.title}`);
    console.log(`  ${r.recommendation.why}`);
    console.log('  ' + r.recommendation.next.replace(/\n/g, '\n  '));
  }
  console.log('');
}

// --- entry -----------------------------------------------------------
if (require.main === module) {
  const [target, user, pass] = process.argv.slice(2);
  if (!target) {
    console.log(`
Usage:
  node scan-cameras.js 192.168.1.0/24                 find cameras on the network
  node scan-cameras.js 192.168.1.64 admin mypassword  identify one camera

Credentials are optional but you'll get much more detail with them.
Nothing is changed on the camera — this only reads.
`);
    process.exit(0);
  }
  (async () => {
    if (target.includes('/')) await sweep(target, user, pass);
    else { console.log(''); printReport(await identify(target, user, pass)); }
  })();
}

module.exports = { identify, sweep, tcpOpen };
