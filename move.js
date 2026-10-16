#!/usr/bin/env node
// Move this camera computer's settings to a new box (e.g. laptop -> Pi),
// without redoing the camera setup.
//
//   On the OLD computer:  cd ~/securityai && node move.js send
//        It shows a one-time move code (good for 30 minutes) and waits.
//   On the NEW computer:  node move.js receive      (the Pi setup does this)
//        Type the code: the settings arrive and the program is downloaded.
//        The old computer then stops watching by itself (its settings stay,
//        so it can go back to watching any time; give it back with
//        node install-service.js --wipe).
//
// The settings (camera address and password, the area you drew, the
// website connection) are encrypted on the old computer with a key made
// from the code; the website only holds the scrambled copy, hands it out
// once, and forgets it. Node built-ins only (it runs before the program
// is downloaded).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const stateDir = () => process.env.SECURITYAI_HOME || path.join(os.homedir(), '.securityai');
const codeDir = () => process.env.SECURITYAI_CODE_DIR || path.join(os.homedir(), 'securityai');
const cfgFile = () => path.join(stateDir(), 'rtsp-zones.json');
const say = m => console.log(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ask(q, def) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${q}${def ? ` [${def}]` : ''}: `, a => { rl.close(); resolve((a || '').trim() || def || ''); });
  });
}
function newCode() { const b = crypto.randomBytes(12); return Array.from(b, x => ALPHA[x % 31]).join('').replace(/(.{4})(?=.)/g, '$1-'); }
const cleanCode = c => String(c || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
const idOf = c => crypto.createHash('sha256').update('securityai-move-id|' + cleanCode(c)).digest('hex').slice(0, 32);
const keyOf = c => crypto.scryptSync(cleanCode(c), 'securityai-move-v1', 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
function seal(code, obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', keyOf(code), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function open(code, blob) {
  const b = Buffer.from(blob, 'base64url');
  const d = crypto.createDecipheriv('aes-256-gcm', keyOf(code), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8'));
}
async function http(method, url, { token, body } = {}) {
  const r = await fetch(url, { method, headers: Object.assign({}, token ? { Authorization: 'Bearer ' + token } : {}, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch (e) { /* not json */ }
  return { status: r.status, json, buf };
}
function writePrivate(f, text) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  fs.writeFileSync(f + '.tmp', text, { mode: 0o600 }); fs.renameSync(f + '.tmp', f);
}
const netSay = e => /ENOTFOUND|EAI_AGAIN/.test(String(e.cause && e.cause.code || e.message)) ? 'Cannot reach the website: is this computer on the internet?' : `Could not reach the website (${e.cause && e.cause.code || e.message}).`;

async function send() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgFile(), 'utf8').replace(/^﻿/, '')); } catch (e) { say(`No camera settings on this computer (${cfgFile()}). Nothing to move.`); process.exit(1); }
  if (!cfg.serverUrl || !cfg.runnerToken) { say('This computer is not connected to the website, so there is nothing to move. (node pair.js)'); process.exit(1); }
  const extra = {};
  for (const n of ['screen-reader.json']) { try { extra[n] = JSON.parse(fs.readFileSync(path.join(stateDir(), n), 'utf8')); } catch (e) { /* none */ } }
  const code = newCode();
  say('Packing up this computer\'s settings (encrypted with a one-time code)...');
  let r;
  try { r = await http('POST', cfg.serverUrl + '/monitor/runner/handoff', { token: cfg.runnerToken, body: { id: idOf(code), blob: seal(code, { v: 1, config: cfg, extra, from: os.hostname(), at: new Date().toISOString() }) } }); }
  catch (e) { say(netSay(e)); process.exit(1); }
  if (r.status !== 200 || !r.json || !r.json.ok) { say('The website did not take it: ' + ((r.json && r.json.error) || r.status)); process.exit(1); }
  say('\n  Move code:   ' + code + '\n');
  say('  On the new computer (the Pi), type it when asked. It works once, for 30 minutes.');
  say('  Waiting here... (this computer stops watching once the new one has the settings)');
  const id = idOf(code), until = Date.now() + 30 * 60e3;
  while (Date.now() < until) {
    await sleep(5000);
    let s = null; try { s = await http('GET', `${cfg.serverUrl}/monitor/runner/handoff/${id}/status`, { token: cfg.runnerToken }); } catch (e) { continue; }
    if (s.json && s.json.pickedUp) {
      say('\n  ✓ The new computer has the settings.');
      try {
        const svc = require(path.join(codeDir(), 'install-service.js'));
        if (svc.isInstalled && svc.isInstalled()) { say('  Stopping the monitor on THIS computer (two computers would send every entry twice)...'); svc.remove ? svc.remove({}) : null; }
      } catch (e) { /* not installed here */ }
      say('  If a monitor is running in a window on this computer, press Ctrl-C there.');
      say('  Settings stay on this computer. To give it back: node install-service.js --wipe');
      process.exit(0);
    }
  }
  say('  The code was not used within 30 minutes. Run  node move.js send  again for a new one.');
  process.exit(1);
}

async function receive() {
  say('Receive camera settings from the old computer\n');
  if (fs.existsSync(cfgFile())) {
    const a = (await ask(`  This computer already has camera settings (${cfgFile().replace(os.homedir(), '~')}). Replace them? (y/N)`, '')).toLowerCase();
    if (!a.startsWith('y')) { say('  Kept them. Nothing changed.'); return; }
  }
  let site = process.env.SECURITYAI_SITE || (await ask('  Website address', 'gym-security.onrender.com'));
  if (!/^https?:\/\//.test(site)) site = 'https://' + site.replace(/\/+$/, '');
  let got = null;
  for (let tries = 0; tries < 3 && !got; tries++) {
    const code = await ask('  Move code from the old computer (like ABCD-EFGH-JKMN)', '');
    if (cleanCode(code).length !== 12) { say('  A move code is 12 letters and numbers.'); continue; }
    let r;
    try { r = await http('GET', `${site}/monitor/handoff/${idOf(code)}`); } catch (e) { say('  ' + netSay(e)); continue; }
    if (r.status !== 200 || !r.json || !r.json.blob) { say('  ' + ((r.json && r.json.error) || `The website said ${r.status}.`)); continue; }
    try { got = open(code, r.json.blob); } catch (e) { say('  That code does not open these settings. Check you typed it exactly.'); }
  }
  if (!got) { say('\n  Not moved. On the old computer run  node move.js send  for a new code, then try again.'); process.exit(1); }
  writePrivate(cfgFile(), JSON.stringify(got.config, null, 2) + '\n');
  for (const [n, v] of Object.entries(got.extra || {})) writePrivate(path.join(stateDir(), n), JSON.stringify(v, null, 1));
  say(`  ✓ Settings from "${got.from}" saved (${cfgFile().replace(os.homedir(), '~')}, readable only by you).`);
  // The few files update.js needs to download the rest of the program.
  const dest = codeDir();
  fs.mkdirSync(dest, { recursive: true });
  for (const n of ['runner-config.js', 'pairing-client.js', 'runner-remote.js', 'update.js']) {
    try {
      const r = await http('GET', `${got.config.serverUrl}/monitor/runner/files/${n}`, { token: got.config.runnerToken });
      if (r.status === 200) fs.writeFileSync(path.join(dest, n), r.buf);
    } catch (e) { /* update.js will say */ }
  }
  say('  Next: the program downloads with  node update.js  (the Pi setup does it for you).');
}

if (require.main === module) {
  const cmd = process.argv[2];
  (cmd === 'send' ? send() : cmd === 'receive' ? receive() : Promise.resolve(say('Use:  node move.js send   (on the old computer)\n      node move.js receive   (on the new one)')))
    .catch(e => { say('Something went wrong: ' + e.message); process.exit(1); });
}
module.exports = { seal, open, idOf, newCode, cleanCode };
