#!/usr/bin/env node
// find-stream.js - for a recorder whose camera address style is unknown.
//
// setup-camera.js tries the common address styles. When none of them works
// (every one "not on this recorder (404)" and only the bare address, which
// always shows camera 1), run this:
//
//   cd ~/securityai
//   node find-stream.js
//
// It finds the real address for each camera, two ways:
//   1. Asks the recorder itself (ONVIF - the standard most recorders speak).
//      The recorder replies with the exact video address of every camera.
//   2. If the recorder doesn't speak ONVIF: tries ~35 more address styles.
// What works is saved to ~/.securityai/extra-formats.json, and
// setup-camera.js then uses it automatically. Nothing else changes.
//
// Safety (the recorder locks the account after a few wrong passwords):
// stops at the FIRST rejected login, and never retries it.
// Never prints the password.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const P = require('./camera-probe');
const RC = require('./runner-config');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); args[k] = v === undefined ? true : v; }
}
const say = (...m) => console.log(...m);
let SECRETS = [];
const safe = t => P.maskText(t, SECRETS);

// ---------------------------------------------------------------- prompts
function ask(q, def) {
  return new Promise(resolve => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${q}${def ? ` [${def}]` : ''}: `, a => { rl.close(); resolve(P.normaliseInput(a).value.trim() || def || ''); });
  });
}
function readHidden(prompt) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let buf = '';
      stdin.setEncoding('utf8');
      stdin.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { stdin.pause(); resolve(buf.slice(0, i).replace(/\r$/, '')); } });
      stdin.on('end', () => resolve(buf));
      return;
    }
    process.stdout.write(prompt);
    let val = '';
    stdin.setRawMode(true); stdin.resume();
    const on = b => {
      for (const ch of b.toString('utf8')) {
        if (ch === '\r' || ch === '\n') { stdin.removeListener('data', on); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); return resolve(val); }
        if (ch === '\u0003') { stdin.setRawMode(false); process.stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { if (val) { val = Array.from(val).slice(0, -1).join(''); process.stdout.write('\b \b'); } continue; }
        if (ch >= ' ') { val += ch; process.stdout.write('*'); }
      }
    };
    stdin.on('data', on);
  });
}

// ---------------------------------------------------------------- ONVIF
// Plain SOAP over HTTP with WS-Security UsernameToken (password digest).
// The digest uses the RECORDER's clock (this recorder's clock is ~1 h off,
// and many recorders reject a token whose time is far from theirs).
const ONVIF_PORTS = [80, 8000, 8080, 8899, 2020, 10080, 888];

function soapPost(host, port, pathName, body, extraHeaders, timeoutMs) {
  return new Promise(resolve => {
    const data = Buffer.from(body);
    const req = http.request({
      host, port, path: pathName, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': data.length }, extraHeaders || {}),
    }, res => {
      const c = []; res.on('data', d => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString('utf8') }));
    });
    req.setTimeout(timeoutMs || 5000, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', e => resolve({ status: 0, error: e.code || e.message, body: '' }));
    req.end(data);
  });
}
function envelope(inner, security) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
<s:Header>${security || ''}</s:Header><s:Body>${inner}</s:Body></s:Envelope>`;
}
function wsse(user, pass, createdIso) {
  const nonce = crypto.randomBytes(16);
  const digest = crypto.createHash('sha1').update(Buffer.concat([nonce, Buffer.from(createdIso), Buffer.from(pass, 'utf8')])).digest('base64');
  const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd"><UsernameToken><Username>${x(user)}</Username><Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password><Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</Nonce><Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${createdIso}</Created></UsernameToken></Security>`;
}
// HTTP Digest (some recorders want this instead of WS-Security).
function httpDigestHeader(challenge, user, pass, method, uri) {
  const get = k => { const m = challenge.match(new RegExp(k + '="?([^",]+)"?', 'i')); return m ? m[1] : ''; };
  const realm = get('realm'), nonce = get('nonce'), qop = /auth/.test(get('qop')) ? 'auth' : '', opaque = get('opaque');
  const md5 = s => crypto.createHash('md5').update(s).digest('hex');
  const ha1 = md5(`${user}:${realm}:${pass}`), ha2 = md5(`${method}:${uri}`);
  const nc = '00000001', cnonce = crypto.randomBytes(8).toString('hex');
  const response = qop ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  return `Digest username="${user}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"` +
    (qop ? `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"` : '') + (opaque ? `, opaque="${opaque}"` : '');
}
const tag = (xml, name) => { const m = xml.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`)); return m ? m[1].trim() : null; };
const isAuthFault = r => r.status === 401 || /NotAuthorized|Sender not Authorized|FailedAuthentication|InvalidSecurity|not authorized/i.test(r.body || '');

async function onvifFind(host, user, pass, log) {
  // 1. Which port answers ONVIF? GetSystemDateAndTime needs no password.
  const devPath = '/onvif/device_service';
  let port = null, clockOffsetMs = 0;
  for (const p of ONVIF_PORTS) {
    const r = await soapPost(host, p, devPath, envelope('<tds:GetSystemDateAndTime/>'), null, 3000);
    if (r.status && /SystemDateAndTime|GetSystemDateAndTimeResponse/i.test(r.body)) {
      port = p;
      const utc = tag(r.body, 'UTCDateTime');
      if (utc) {
        const n = k => parseInt(tag(utc, k), 10);
        const t = Date.UTC(n('Year'), n('Month') - 1, n('Day'), n('Hour'), n('Minute'), n('Second'));
        if (!isNaN(t)) clockOffsetMs = t - Date.now();
      }
      break;
    }
  }
  if (!port) return { ok: false, why: 'noonvif' };
  log(`  The recorder answers ONVIF on port ${port}.`);
  if (Math.abs(clockOffsetMs) > 120000) log(`  (Its clock is ${Math.round(clockOffsetMs / 60000)} min off from this laptop - allowing for that.)`);

  // 2. Authenticated calls. ONE credential attempt; stop at the first rejection.
  let mode = 'wsse', digestChallenge = null;
  const call = async (xaddrPath, inner) => {
    const created = new Date(Date.now() + clockOffsetMs).toISOString().replace(/\.\d+Z$/, 'Z');
    const headers = mode === 'digest' && digestChallenge ? { Authorization: httpDigestHeader(digestChallenge, user, pass, 'POST', xaddrPath) } : null;
    let r = await soapPost(host, port, xaddrPath, envelope(inner, mode === 'wsse' ? wsse(user, pass, created) : ''), headers, 8000);
    // Some recorders ignore WS-Security and challenge with HTTP Digest instead.
    // That challenge is not a failed login (no password was checked yet).
    if (r.status === 401 && mode === 'wsse' && /digest/i.test(String(r.headers && r.headers['www-authenticate']))) {
      mode = 'digest'; digestChallenge = String(r.headers['www-authenticate']);
      r = await soapPost(host, port, xaddrPath, envelope(inner, ''), { Authorization: httpDigestHeader(digestChallenge, user, pass, 'POST', xaddrPath) }, 8000);
    }
    return r;
  };

  const cap = await call(devPath, '<tds:GetCapabilities><tds:Category>Media</tds:Category></tds:GetCapabilities>');
  if (isAuthFault(cap)) return { ok: false, why: 'auth' };
  let mediaPath = devPath;
  const mx = (tag(cap.body || '', 'Media') || '').match(/<(?:[\w-]+:)?XAddr>([^<]+)</);
  if (mx) { try { mediaPath = new URL(mx[1].trim()).pathname; } catch (e) { /* keep device path */ } }

  const prof = await call(mediaPath, '<trt:GetProfiles/>');
  if (isAuthFault(prof)) return { ok: false, why: 'auth' };
  const blocks = (prof.body || '').match(/<(?:[\w-]+:)?Profiles\b[\s\S]*?<\/(?:[\w-]+:)?Profiles>/g) || [];
  if (!blocks.length) return { ok: false, why: 'noprofiles', detail: (prof.body || prof.error || '').slice(0, 300) };

  const profiles = [];
  for (const b of blocks) {
    const token = (b.match(/^<[^>]*\btoken="([^"]+)"/) || [])[1];
    if (!token) continue;
    const vsc = tag(b, 'VideoSourceConfiguration') || '';
    const source = tag(vsc, 'SourceToken') || '';
    const enc = tag(b, 'VideoEncoderConfiguration') || '';
    const w = parseInt(tag(enc, 'Width'), 10) || 0, h = parseInt(tag(enc, 'Height'), 10) || 0;
    const su = await call(mediaPath, `<trt:GetStreamUri><trt:StreamSetup><tt:Stream>RTP-Unicast</tt:Stream><tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport></trt:StreamSetup><trt:ProfileToken>${token}</trt:ProfileToken></trt:GetStreamUri>`);
    if (isAuthFault(su)) return { ok: false, why: 'auth' };
    const uri = tag(su.body || '', 'Uri');
    if (!uri) continue;
    profiles.push({ token, name: tag(b, 'Name') || token, source, w, h, uri: uri.replace(/&amp;/g, '&') });
  }
  if (!profiles.length) return { ok: false, why: 'nouris' };
  return { ok: true, port, profiles };
}

// Turn ONVIF profiles into "channel n -> path" maps (main = biggest picture per camera).
function profilesToFormat(profiles, host) {
  const bySource = new Map();
  for (const p of profiles) {
    const k = p.source || p.token;
    if (!bySource.has(k)) bySource.set(k, []);
    bySource.get(k).push(p);
  }
  // Channel order: the number in the source token if every source has one, else as listed.
  let keys = [...bySource.keys()];
  const num = k => { const m = String(k).match(/(\d+)(?!.*\d)/); return m ? parseInt(m[1], 10) : null; };
  if (keys.every(k => num(k) != null)) keys.sort((a, b) => num(a) - num(b));
  const zeroBased = keys.length && num(keys[0]) === 0;
  const paths = {}, subPaths = {};
  let rtspPort = null;
  keys.forEach((k, i) => {
    const list = bySource.get(k).slice().sort((a, b) => (b.w * b.h) - (a.w * a.h));
    const ch = keys.every(x => num(x) != null) ? num(k) + (zeroBased ? 1 : 0) : i + 1;
    const toPath = u => { try { const x = new URL(u); if (!rtspPort && x.port) rtspPort = parseInt(x.port, 10); return (x.pathname + x.search).replace(/^\/+/, ''); } catch (e) { return null; } };
    const mp = toPath(list[0].uri);
    if (mp != null) paths[String(ch)] = mp;
    if (list[1]) { const sp = toPath(list[1].uri); if (sp != null) subPaths[String(ch)] = sp; }
  });
  return { id: 'onvif', name: 'from the recorder itself (ONVIF)', port: rtspPort || 554, paths, subPaths: Object.keys(subPaths).length ? subPaths : undefined };
}

// ---------------------------------------------------------------- more guesses
// Tried only when the recorder doesn't speak ONVIF. {n} etc. as in camera-probe.
const MORE = [
  ['streaming/channels/{n}01', 'streaming/channels/{n}02'],
  ['Streaming/Unicast/channels/{n}01', 'Streaming/Unicast/channels/{n}02'],
  ['Streaming/Channels/{n}', null],
  ['ch{n}', null], ['ch{nn}', null], ['{n}', null], ['ch{n}_0', 'ch{n}_1'], ['ch_{n}', null],
  ['ch{n}/main', 'ch{n}/sub'], ['main/ch{n}', 'sub/ch{n}'], ['channel{n}', null], ['channel/{n}', null],
  ['live/ch{n}', null], ['live/ch{nn}_0', 'live/ch{nn}_1'], ['live/ch{n0}', null], ['live/main?channel={n}', 'live/sub?channel={n}'],
  ['live?channel={n}&stream=0', 'live?channel={n}&stream=1'], ['?channel={n}', null], ['?ch={n}', null],
  ['rtsp/streaming?channel={nn}&subtype=0', 'rtsp/streaming?channel={nn}&subtype=1'],
  ['av{n0}_0', 'av{n0}_1'], ['av0_{n0}', null], ['video{n}', null], ['media/video{n}', null], ['stream{n}', null],
  ['cam{n}', null], ['cam{n}/h264', null], ['LiveChannel/{n0}/media.smp', null], ['profile{n}/media.smp', null],
  ['Preview_{nn}_main', 'Preview_{nn}_sub'], ['live{n0}.sdp', null], ['ch0{n}.264', null], ['{n}/1', '{n}/2'],
  ['user=x&channel={n}&stream=0.sdp', null],
];

async function guessFormats(creds, tmp, ch1File, log) {
  const ports = [creds.port || 554];
  if (!ports.includes(8554)) ports.push(8554);
  for (const port of ports) {
    if (port !== ports[0]) {
      const t = await P.tcpCheck(creds.host, port, 2500);
      if (!t.ok) continue;
      log(`  Port ${port} is open too - trying it.`);
    }
    for (const [mainT, subT] of MORE) {
      const fmt = P.formatFromSaved({ id: 'guess', name: mainT, main: mainT, sub: subT || undefined, port });
      const f4 = path.join(tmp, 'g4.jpg');
      const r4 = await P.grabFrame(P.buildUrl(creds, fmt, 4), f4, { timeoutMs: 8000 });
      process.stdout.write(`  ${(port + ' ' + P.fillTemplate(mainT, 4)).padEnd(46)} ${P.describe(r4)}\n`);
      if (r4.status === 'auth') return { auth: true };
      if (r4.status !== 'ok') continue;
      // It gave a picture - but is it really channel 4, not channel 1 again?
      const d14 = ch1File ? await P.imageDiff(ch1File, f4) : null;
      const f2 = path.join(tmp, 'g2.jpg');
      const r2 = await P.grabFrame(P.buildUrl(creds, fmt, 2), f2, { timeoutMs: 8000 });
      if (r2.status === 'auth') return { auth: true };
      const d24 = r2.status === 'ok' ? await P.imageDiff(f2, f4) : null;
      const differs = x => x != null && x >= P.SAME_PICTURE_BELOW;
      if (differs(d14) || differs(d24) || r2.status === 'notfound') {
        log('     ^ follows the channel number');
        return { found: { id: 'guess', name: `found on this recorder (${mainT})`, port, main: mainT, sub: subT || undefined } };
      }
      log('     ^ same picture as camera 1 - ignores the channel, skipping');
    }
  }
  return {};
}

// ---------------------------------------------------------------- main
(async () => {
  say('Find the camera address on this recorder');
  say('Asks the recorder itself, then tries more address styles. Ctrl-C to stop.\n');

  const ff = await P.ffmpegCheck();
  if (!ff.ok) { say('ffmpeg was not found. Run  node setup-camera.js  once first (it sets ffmpeg up), then run this again.'); process.exit(1); }

  // Defaults: whatever the last camera setup used.
  let remembered = {};
  try {
    const cfg = JSON.parse(fs.readFileSync(RC.resolveConfigPath({ log: () => {} }), 'utf8'));
    const u = new URL(((cfg.zones || [])[0] || {}).cameraUrl || '');
    remembered = { host: u.hostname, user: decodeURIComponent(u.username || '') };
  } catch (e) { /* none yet */ }

  const hostIn = args.ip ? String(args.ip) : await ask('Recorder IP address', remembered.host === '192.168.2.54' ? '10.1.1.1' : (remembered.host || '10.1.1.1'));
  const h = P.parseHostInput(hostIn);
  if (h.error) { say(h.error); process.exit(1); }
  const host = h.host, port = h.port || 554;
  const user = args.user ? String(args.user) : await ask('Username', remembered.user || 'gymai');
  let pass = args['pass-env'] ? process.env[args['pass-env']] : await readHidden('Password (typing shows *): ');
  pass = P.normaliseInput(pass || '').value.trim();
  SECRETS = [pass];
  const creds = { host, port, user, pass };

  const t = await P.tcpCheck(host, port, 4000);
  if (!t.ok) {
    say(`\nCannot reach ${host} on port ${port}. Check the cable is in the same port as for setup, and run this again.`);
    process.exit(1);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'findstream-'));
  const outDir = path.join(__dirname, 'camera-check');
  fs.mkdirSync(outDir, { recursive: true });

  // Camera 1 via the bare address, for comparison (and to confirm the password works).
  const ch1File = path.join(tmp, 'ch1.jpg');
  const r1 = await P.grabFrame(P.buildUrl(creds, P.BARE_ROOT, 1), ch1File, { timeoutMs: 12000 });
  if (r1.status === 'auth') {
    say('\nSTOPPED: the recorder rejected that username or password. Not trying again (it locks the account).');
    say('Do this: check the password, then run  node find-stream.js  again.');
    process.exit(2);
  }

  let found = null;
  say('\n=== 1. Asking the recorder for its camera addresses (ONVIF) ===');
  const ov = await onvifFind(host, user, pass, m => say(safe(m)));
  if (ov.ok) {
    const fmt = profilesToFormat(ov.profiles, host);
    const chans = Object.keys(fmt.paths).map(Number).sort((a, b) => a - b);
    say(`  It listed ${chans.length} camera(s): channels ${chans.join(', ')}.`);
    // Check it really gives different cameras (and that ch 4 exists).
    const test = chans.includes(4) ? 4 : chans[chans.length - 1];
    const f = path.join(tmp, 'onvif-test.jpg');
    const rt = await P.grabFrame(P.buildUrl(creds, P.formatFromSaved(fmt), test), f, { timeoutMs: 12000 });
    say(safe(`  Channel ${test}: ${P.describe(rt)}`));
    if (rt.status === 'auth') { say('\nSTOPPED: password rejected on the video address. Not trying again.'); process.exit(2); }
    if (rt.status === 'ok') {
      found = fmt;
      try { fs.copyFileSync(f, path.join(outDir, `find-stream-ch${String(test).padStart(2, '0')}.jpg`)); } catch (e) { /* ignore */ }
    }
  } else if (ov.why === 'auth') {
    say('  The recorder rejected the login for ONVIF. Not trying again on ONVIF (lockout).');
    say('  (Some recorders need ONVIF switched on and an ONVIF user added: System > Network > Advanced / ONVIF.)');
  } else if (ov.why === 'noonvif') {
    say('  The recorder does not answer ONVIF here (it may be switched off in its settings).');
  } else {
    say(safe(`  ONVIF answered but gave no camera addresses (${ov.why}).`));
  }

  if (!found) {
    say('\n=== 2. Trying more address styles for channel 4 ===');
    const g = await guessFormats(creds, tmp, r1.status === 'ok' ? ch1File : null, m => say(safe(m)));
    if (g.auth) { say('\nSTOPPED: the recorder rejected the login. Not trying again (lockout).'); process.exit(2); }
    if (g.found) found = g.found;
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  if (!found) {
    say('\nNo address for separate cameras was found on this recorder.');
    say('Do this: on the recorder screen go to System > Network > Advanced (or Port) and take a photo of');
    say('every tab there (look for ONVIF and RTSP). Send the photos - the address is usually shown there.');
    process.exit(1);
  }

  // Save for setup-camera.js (tried first from now on).
  const file = RC.statePath('extra-formats.json');
  RC.ensureStateDir();
  let saved = { formats: [] };
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(saved.formats)) saved.formats = []; } catch (e) { /* new */ }
  saved.formats = [found].concat(saved.formats.filter(x => x && x.id !== found.id));
  RC.writePrivate ? RC.writePrivate(file, JSON.stringify(saved, null, 2) + '\n') : fs.writeFileSync(file, JSON.stringify(saved, null, 2) + '\n', { mode: 0o600 });

  say('\nFOUND the camera addresses on this recorder. Saved.');
  say('Next, type these two lines:');
  say('    cd ~/securityai');
  say('    node setup-camera.js');
  say(`At the recorder IP question type  ${host}  then the same username and password.`);
  say('It will now show a picture of every camera - type 4 for the turnstile.');
})().catch(err => { console.error('Error: ' + safe(err && err.message)); process.exit(1); });
