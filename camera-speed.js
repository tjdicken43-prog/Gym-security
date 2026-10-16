#!/usr/bin/env node
// Can THIS computer keep up with the camera picture? (The Pi setup runs it.)
//
//   node camera-speed.js          test; if too slow, offer the camera's smaller
//                                  "sub-stream" (the drawn entrance area is kept:
//                                  it scales to the new picture size by itself)
//   node camera-speed.js --yes    switch without asking when too slow
//
// A Raspberry Pi 5 has no hardware decoder for most cameras' H.264, so a 4K
// main stream can be too much for it: pictures get dropped and people can be
// missed. The sub-stream is far lighter and the counting works from a
// close-up of the door either way.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const P = require('./camera-probe');
const RC = require('./runner-config');

const say = m => console.log(m);
const ask = q => new Promise(r => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(q, a => { rl.close(); r((a || '').trim()); }); });

// The same camera's sub-stream address, from the known recorder formats.
function subUrlOf(url) {
  let u; try { u = new URL(url); } catch (e) { return null; }
  const pathq = (u.pathname + u.search).replace(/^\//, '');
  for (const f of P.FORMATS || []) {
    if (!f.main || !f.sub) continue;
    for (let n = 1; n <= 64; n++) {
      let m = null; try { m = f.main(n); } catch (e) { m = null; }
      if (m && m === pathq) { const s = f.sub(n); return `${u.protocol}//${u.username ? u.username + (u.password ? ':' + u.password : '') + '@' : ''}${u.host}/${s}`; }
    }
  }
  return null;
}

module.exports = { subUrlOf };
if (require.main === module) (async () => {
  const file = RC.resolveConfigPath({});
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (e) { say('No camera settings on this computer yet.'); process.exit(1); }
  let changed = false;
  for (const z of cfg.zones || []) {
    if (!/^rtsps?:\/\//i.test(z.cameraUrl || '')) { say(`${z.label}: not a network camera (skipped).`); continue; }
    say(`${z.label}: testing whether this computer keeps up with the camera (10 seconds)...`);
    const sp = await P.decodeSpeed(z.cameraUrl, { seconds: 10 });
    if (!sp.ok || !sp.sourceFps) { say(`  Could not test it (${P.describe ? P.describe(sp) : sp.status}). Check:  node rtsp-run.js --check`); continue; }
    const slow = sp.rate < Math.max(3, sp.sourceFps * 0.85);
    if (!slow) { say(`  ✓ Keeps up: ${Math.round(sp.rate)} of ${Math.round(sp.sourceFps)} pictures a second.`); continue; }
    say(`  Too slow: ${Math.round(sp.rate)} of the ${Math.round(sp.sourceFps)} pictures a second the camera sends (people could be missed).`);
    const sub = subUrlOf(z.cameraUrl);
    if (!sub) { say('  This camera\'s smaller picture could not be worked out. Send Claude a photo of this screen.'); continue; }
    const tmp = path.join(os.tmpdir(), `sai-sub-${process.pid}.jpg`);
    const g = await P.grabFrame(sub, tmp);
    try { fs.unlinkSync(tmp); } catch (e) { /* none */ }
    if (g.status !== 'ok') { say('  The smaller picture did not work either. Send Claude a photo of this screen.'); continue; }
    const sp2 = await P.decodeSpeed(sub, { seconds: 8 });
    say(`  The smaller picture (${g.width}x${g.height}) runs at ${sp2.ok ? Math.round(sp2.rate) : '?'} pictures a second here.`);
    const yes = process.argv.includes('--yes') || !(await ask('  Use the smaller picture? (Y/n) ')).toLowerCase().startsWith('n');
    if (!yes) continue;
    if (!(z.frameW > 0 && z.frameH > 0)) { say('  The entrance area has no picture size saved, so it can\'t be scaled safely. Kept the big picture.'); continue; }
    z.cameraUrl = sub; changed = true;
    say('  ✓ Switched. The entrance area you drew is kept (it scales to the smaller picture).');
  }
  if (changed) {
    try { fs.copyFileSync(file, file + '.bak'); fs.chmodSync(file + '.bak', 0o600); } catch (e) { /* ignore */ }
    RC.writePrivate(file, JSON.stringify(cfg, null, 2) + '\n');
    say('Saved. The background monitor picks it up by itself.');
  }
})().catch(e => { say('Something went wrong: ' + e.message); process.exit(1); });
