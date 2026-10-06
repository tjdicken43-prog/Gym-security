#!/usr/bin/env node
// Lists which RTSP address formats your recorder/camera answers to.
//
//   RECOMMENDED INSTEAD:  node setup-camera.js
//   (it does all of this, shows every channel, and writes rtsp-zones.json)
//
//   node find-camera.js <recorder-ip> [username] [channel]
//        -> asks for the password (hidden), so no shell quoting problems
//   node find-camera.js <recorder-ip> <username> <password> [channel]
//        -> old form still works, but a password with ! $ " ' in it can be
//           mangled by the shell before this script sees it
//   Flags: --pass-env VAR (read password from an environment variable),
//          --port N, --out DIR (default ./camera-check), --timeout SECONDS
//
// For each format it reports: WORKS (codec + size), password rejected
// (401), not on this recorder (404), timeout or refused. Every working
// address gets a snapshot in ./camera-check/ and is checked against a
// second channel, so addresses that ignore the channel number (like the
// bare rtsp://ip:554/ address, which always shows camera 1) are flagged.
//
// It STOPS at the first 401 — the recorder may lock the account after a
// few wrong passwords, so we never keep trying.
//
// Needs ffmpeg. Node built-ins only.

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./camera-probe');

const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  else pos.push(argv[i]);
}

if (!pos.length || flags.help) {
  console.log(`
Easiest:  node setup-camera.js     (finds the camera AND writes rtsp-zones.json)

This tool only lists which address formats work:
  node find-camera.js <recorder-ip> [username] [channel]
  e.g.  node find-camera.js 192.168.2.54 admin 4
It asks for the password without showing it.
`);
  process.exit(0);
}

function readHidden(prompt) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      // piped: read one line
      let buf = '';
      process.stdout.write(prompt);
      stdin.setEncoding('utf8');
      const on = d => { buf += d; const i = buf.search(/\r?\n/); if (i !== -1) { stdin.removeListener('data', on); stdin.pause(); process.stdout.write('\n'); resolve(buf.slice(0, i)); } };
      stdin.on('data', on);
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

(async () => {
  const h = P.parseHostInput(pos[0]);
  if (h.error) { console.log(h.error); process.exit(1); }
  const host = h.host, port = parseInt(flags.port, 10) || h.port || 554;
  const user = P.normaliseInput(pos[1] || 'admin').value.trim();
  let pass, chanArg;
  // positional: ip user [channel]   or   ip user password [channel]
  // (a 1-2 digit third argument is a channel; a real password is longer)
  if (flags['pass-env']) {
    pass = process.env[flags['pass-env']];
    if (pass == null) { console.log(`--pass-env ${flags['pass-env']}: that environment variable is not set.`); process.exit(1); }
    chanArg = pos[2];
  } else if (pos.length >= 4) { pass = pos[2]; chanArg = pos[3]; }
  else if (pos.length === 3 && /^\d{1,2}$/.test(pos[2])) { chanArg = pos[2]; }
  else if (pos.length === 3) { pass = pos[2]; }
  if (pass == null) pass = await readHidden('Password (typing shows *): ');
  pass = P.normaliseInput(pass).value;
  if (pass !== pass.trim()) { console.log('(Removed spaces from the start/end of the password.)'); pass = pass.trim(); }
  const ch = parseInt(chanArg, 10) || 1;
  const secrets = [pass];
  const outDir = path.resolve(flags.out || 'camera-check');
  const timeoutMs = (parseInt(flags.timeout, 10) || 15) * 1000;

  console.log('\nTip: node setup-camera.js does all of this for you and writes rtsp-zones.json.\n');

  const ff = await P.ffmpegCheck();
  if (!ff.ok) {
    console.log('ffmpeg is not installed. Install it first:');
    console.log('  Mac:    download from evermeet.cx, then  sudo cp ~/Downloads/ffmpeg /usr/local/bin/');
    console.log('  Linux:  sudo apt install ffmpeg');
    process.exit(1);
  }
  const tcp = await P.tcpCheck(host, port, 4000);
  if (!tcp.ok) {
    console.log(tcp.code === 'refused'
      ? `${host} answered but port ${port} is closed: RTSP is off or on another port (check System > Network on the recorder).`
      : `Cannot reach ${host} (${tcp.code}): this computer is on a different network, the cable is out, or the IP is wrong.`);
    const mine = P.localIPv4().map(a => a.address);
    console.log(`This computer's address: ${mine.join(', ') || 'none (not connected)'}`);
    process.exit(1);
  }

  fs.mkdirSync(outDir, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'findcam-'));
  const creds = { host, port, user, pass };
  const total = P.FORMATS.length * 2 + 1;
  console.log(`Testing ${total} address formats on ${host}:${port}, channel ${ch}. Up to ${timeoutMs / 1000}s each.\n`);

  const res = await P.testFormats(creds, ch, tmp, {
    includeSub: true, includeRoot: true, checkChannels: true, timeoutMs,
    otherChannels: ch === 1 ? [2, 3] : [ch === 2 ? 3 : 2, 1].filter(n => n !== ch),
    onResult: e => {
      const name = e.format.name + (e.sub ? ' - sub stream' : '');
      let line = `  ${name.padEnd(56)} ${P.describe(e.result)}`;
      if (e.result.status === 'ok') {
        const snap = path.join(outDir, `find-${e.format.id}${e.sub ? '-sub' : ''}-ch${String(ch).padStart(2, '0')}.jpg`);
        try { fs.copyFileSync(e.result.file, snap); e.snapshot = snap; } catch (err) { /* ignore */ }
        if (e.channel_check && e.channel_check.aware === false) line += '\n      ^ IGNORES the channel number (always the same camera) - do not use';
        else if (e.channel_check && e.channel_check.aware) line += '\n      ^ follows the channel number';
      }
      console.log(P.maskText(line, secrets));
    },
  });
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  console.log('');
  if (res.authFailed) {
    console.log('STOPPED: the recorder rejected the username or password (401).');
    console.log('Not trying anything else - this recorder locks the account after a few wrong tries.');
    console.log('Do this: check the login you use on the recorder web page, then run  node setup-camera.js');
    console.log('If it keeps failing: System > User Management on the recorder - is the account enabled / locked?');
    process.exit(2);
  }
  const good = res.results.filter(e => e.result.status === 'ok');
  if (!good.length) {
    const s = res.results.map(e => e.result.status);
    console.log('Nothing gave a picture.');
    if (s.every(x => x === 'notfound')) console.log('The recorder knows none of these formats. Send a photo of this screen for help.');
    else console.log('Close any other live view of the recorder (web page, phone app) and try again.');
    process.exit(1);
  }
  const aware = good.filter(e => !e.channel_check || e.channel_check.aware !== false);
  const best = aware.find(e => !e.sub) || aware[0];
  if (best) {
    console.log(`BEST: ${best.format.name}${best.sub ? ' (sub stream)' : ''}  ${best.result.width}x${best.result.height}`);
    console.log(`  ${P.buildUrl({ host, port, user: 'USER', pass: 'PASSWORD' }, best.format, ch, { sub: best.sub })}`);
  } else {
    console.log('WARNING: the only working addresses IGNORE the channel number - they always show camera 1.');
  }
  console.log(`\nSnapshots of each working address are in ${outDir}`);
  console.log('Next: run  node setup-camera.js  - it builds this address for you (no typing it by hand)');
  console.log('and writes rtsp-zones.json.');
})().catch(err => { console.error('Error: ' + P.maskUrl(err && err.message)); process.exit(1); });
