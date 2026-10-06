#!/usr/bin/env node
// Connect this computer to the website with a 6-digit code.
//
//   node pair.js
//
// Get the code on your phone: admin page > "Connect a camera computer".
// Saves the website address, this gym's code and a long secret token in
// ~/.securityai/rtsp-zones.json. Nothing else in the file is changed.
// If the monitor is running in the background it reconnects by itself.
//
// For scripts/tests:  node pair.js --site gym-security.onrender.com --code 482193

const fs = require('fs');
const os = require('os');
const rc = require('./runner-config');
const pc = require('./pairing-client');

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  if (i !== -1) return process.argv[i + 1];
  const eq = process.argv.find(a => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

(async () => {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
    return;
  }
  const file = rc.resolveConfigPath({ explicit: arg('config'), log: m => console.log(m) });
  let cfg = {};
  if (fs.existsSync(file)) {
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) || {}; } catch (e) {
      console.log(`Your settings file ${rc.tildify(file)} is damaged (${e.message}). Do this: node setup-camera.js`);
      process.exit(1);
    }
  }
  console.log('Connect this computer to the website');
  if (cfg.serverUrl && cfg.runnerToken) {
    const c = await pc.checkToken(cfg.serverUrl, cfg.runnerToken);
    console.log(c.ok ? `  (Already paired with ${cfg.serverUrl} and it still works — pairing again is harmless.)` : `  Currently set to ${cfg.serverUrl}, but: ${c.msg}`);
  }
  const got = await pc.pairInteractive({
    site: cfg.serverUrl ? cfg.serverUrl.replace(/^https:\/\//, '') : '',
    siteGiven: arg('site'), code: arg('code'), noRetry: !!arg('code'),
  });
  if (!got) process.exit(1);

  const before = cfg.gymCode;
  const out = Object.assign({}, cfg, { gymCode: got.gymCode, serverUrl: got.serverUrl, runnerToken: got.runnerToken });
  if (out.dailyBurstCap == null) out.dailyBurstCap = 60;
  if (!Array.isArray(out.zones)) out.zones = [];
  if (fs.existsSync(file)) { try { fs.copyFileSync(file, file + '.bak'); fs.chmodSync(file + '.bak', 0o600); } catch (e) { /* ignore */ } }
  rc.writePrivate(file, JSON.stringify(out, null, 2) + '\n');
  console.log(`  Saved in ${rc.tildify(file)}`);
  if (before && before !== got.gymCode) console.log(`  (Gym code changed from "${before}" to "${got.gymCode}" to match the website.)`);

  if (!out.zones.length) {
    console.log('\nNext, set up the camera. Type:\n\n    node setup-camera.js\n');
  } else {
    let running = null;
    running = rc.runningMonitor ? rc.runningMonitor() : null;
    console.log(running && running.service
      ? '\nThe background monitor picks up the new pairing by itself within a minute.'
      : running ? '\nThe monitor is running in another window: press Ctrl-C there, then type  node rtsp-run.js'
      : '\nDone. Start watching with:\n\n    node rtsp-run.js\n');
  }
  process.exit(0);
})().catch(err => {
  console.error('\nSomething went wrong: ' + (err && err.message));
  console.error('Send a photo of this screen for help.');
  process.exit(1);
});
