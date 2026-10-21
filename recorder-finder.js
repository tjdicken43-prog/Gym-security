// The recorder got a new address. After a power cut or a new router, the
// gym's router can hand the camera recorder (NVR) a different IP address,
// and the camera computer would keep calling the old one forever.
//
// While the camera works, this remembers the recorder's network card
// address (its MAC, which never changes). When the recorder stops
// answering for a few minutes, it knocks on every address of the gym
// network on the video port (554), then looks the MAC up in this
// computer's own neighbour list. Only the device with that exact MAC is
// tried, so the camera password is never sent to anything else. Found:
// rtsp-zones.json gets the new address (a copy of the old file is kept)
// and the program restarts on it (the background service starts it again).
//
// Linux (the Pi) and Mac. Only private (gym network) addresses.
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const { execFile } = require('child_process');

const PRIVATE = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;
const hostOf = url => { try { return new URL(url).hostname; } catch (e) { return null; } };
const normMac = m => (/^([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2}$/i.test(m || '') ? m.toLowerCase().split(/[:-]/).map(x => x.padStart(2, '0')).join(':') : null);

// This computer's neighbour list: { ip: mac }.
function neighbours() {
  return new Promise(resolve => {
    const parse = (out, re) => { const m = {}; let x; while ((x = re.exec(out))) { const mac = normMac(x[2]); if (mac && mac !== '00:00:00:00:00:00') m[x[1]] = mac; } return m; };
    execFile('ip', ['neigh', 'show'], { timeout: 5000 }, (err, out) => {
      if (!err) return resolve(parse(out, /^(\d+\.\d+\.\d+\.\d+)\s.*?lladdr\s+([0-9a-f:]+)/gim));
      execFile('arp', ['-an'], { timeout: 5000 }, (e2, o2) => resolve(e2 ? {} : parse(o2, /\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)/gim)));
    });
  });
}
function knock(host, port, ms) {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = ok => { s.destroy(); resolve(ok); };
    s.setTimeout(ms || 700, () => done(false));
    s.once('connect', () => done(true)); s.once('error', () => done(false));
  });
}

function create({ stateDir, configFile, log, now }) {
  const clock = now || (() => Date.now());
  const memFile = path.join(stateDir, 'recorder-mac.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(memFile, 'utf8')); } catch (e) { return {}; } };
  const failingSince = new Map();      // host -> first failure ms
  let searching = false, lastSearch = 0;

  // The camera works: remember the recorder's MAC (once an hour is plenty).
  async function noteWorking(cameraUrl) {
    const host = hostOf(cameraUrl);
    failingSince.delete(host);
    if (!host || !PRIVATE.test(host)) return;
    const mem = read();
    if (mem[host] && clock() - (mem[host].at || 0) < 3600e3) return;
    const mac = (await neighbours())[host];
    if (!mac) return;
    mem[host] = { mac, at: clock() };
    try { fs.writeFileSync(memFile, JSON.stringify(mem), { mode: 0o600 }); } catch (e) { /* next time */ }
  }

  // The recorder isn't answering. After 3 minutes, look for it (at most every 10 minutes).
  // Returns the new address when it moved and the settings were updated.
  async function noteFailing(cameraUrl, kind) {
    const host = hostOf(cameraUrl);
    if (!host || !PRIVATE.test(host) || !['refused', 'network', 'timeout', 'stall'].includes(kind)) return null;
    if (!failingSince.has(host)) failingSince.set(host, clock());
    if (clock() - failingSince.get(host) < 3 * 60e3 || searching || clock() - lastSearch < 10 * 60e3) return null;
    const known = read()[host];
    if (!known || !known.mac) return null;
    searching = true; lastSearch = clock();
    try {
      if (await knock(host, 554, 1500)) return null;                // it answers again: not moved
      log(`the recorder (${host}) hasn't answered for a few minutes: looking for it on the network (its address may have changed)`);
      const base = host.split('.').slice(0, 3).join('.');
      for (let i = 1; i <= 254; i += 32) {
        await Promise.all(Array.from({ length: Math.min(32, 255 - i) }, (_, k) => `${base}.${i + k}`).filter(ip => ip !== host).map(ip => knock(ip, 554, 600)));
      }
      const nb = await neighbours();
      const found = Object.keys(nb).find(ip => nb[ip] === known.mac && ip !== host);
      if (!found || !(await knock(found, 554, 1500))) { log('the recorder was not found on the network (is it on? is the cable plugged in?)'); return null; }
      return moveTo(host, found) ? found : null;
    } finally { searching = false; }
  }

  // Every camera address on the old IP moves to the new one. The old file is kept as a copy.
  function moveTo(oldHost, newHost) {
    let text;
    try { text = fs.readFileSync(configFile, 'utf8'); } catch (e) { return false; }
    let cfg; try { cfg = JSON.parse(text); } catch (e) { return false; }
    let changed = 0;
    const swap = v => {
      if (typeof v === 'string') { const r = v.split(`@${oldHost}:`).join(`@${newHost}:`).split(`@${oldHost}/`).join(`@${newHost}/`).split(`//${oldHost}:`).join(`//${newHost}:`).split(`//${oldHost}/`).join(`//${newHost}/`); if (r !== v) changed++; return v === oldHost ? (changed++, newHost) : r; }
      if (Array.isArray(v)) return v.map(swap);
      if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = swap(x); return o; }
      return v;
    };
    const next = swap(cfg);
    if (!changed) return false;
    try {
      fs.writeFileSync(configFile + '.before-' + new Date(clock()).toISOString().replace(/[:.]/g, '-'), text, { mode: 0o600 });
      fs.writeFileSync(configFile, JSON.stringify(next, null, 2), { mode: 0o600 });
    } catch (e) { return false; }
    const mem = read(); mem[newHost] = mem[oldHost]; delete mem[oldHost];
    try { fs.writeFileSync(memFile, JSON.stringify(mem), { mode: 0o600 }); } catch (e) { /* fine */ }
    log(`the recorder moved from ${oldHost} to ${newHost} (same device): settings updated, starting again on the new address`);
    return true;
  }

  return { noteWorking, noteFailing, moveTo, _neighbours: neighbours };
}

module.exports = { create, normMac, hostOf };
