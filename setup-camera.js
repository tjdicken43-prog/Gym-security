#!/usr/bin/env node
// Camera setup wizard — connects this computer to the website (6-digit
// pairing code), finds the camera, shows every channel, and saves the
// settings in ~/.securityai/rtsp-zones.json. Nobody types an RTSP address.
//
//   node setup-camera.js                 (asks you everything)
//   node setup-camera.js --channels 32   (recorder has more than 16 channels)
//
// Non-interactive (for testing / scripting), e.g.:
//   CAM_PASS='gymai24!' node setup-camera.js --ip 192.168.2.54 --user admin \
//       --pass-env CAM_PASS --channel 4 --crop full --no-server --yes
//
// Flags: --ip A  --port N  --user U  --pass-env VAR  --channel N  --channels N
//        --label TEXT  --expected N  --crop full|"B2 C3"|X,Y,W,H  --stream main|sub
//        --server-url URL  --pair-code 123456  --token-env VAR  --no-server
//        --gym-code CODE  --service (start in background)  --no-service
//        --config FILE  --check-dir DIR  --no-open  --yes (take defaults, never wait)
//
// Node built-ins + ffmpeg only.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const P = require('./camera-probe');
const RC = require('./runner-config');
const PC = require('./pairing-client');

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    const key = (eq > 0 ? a.slice(2, eq) : a.slice(2));
    const bool = ['yes', 'no-open', 'no-server', 'help', 'service', 'no-service'];
    if (eq > 0) out[key] = a.slice(eq + 1);
    else if (bool.includes(key)) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 20).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}
const CWD = process.cwd();
// Settings live in ~/.securityai/ so a code update can never lose them
// (an old rtsp-zones.json next to the code is moved there automatically).
const CONFIG = args.config ? path.resolve(CWD, args.config) : RC.resolveConfigPath({ log: m => console.log(m) });
const CHECK_DIR = args['check-dir'] ? path.resolve(CWD, args['check-dir']) : path.join(__dirname, 'camera-check');
const MAX_CH = Math.max(1, Math.min(64, parseInt(args.channels, 10) || 16));
const AUTO = !!args.yes;
const GRID_COLS = 6, GRID_ROWS = 6;

// "cd ~/securityai" when the Terminal window is not in the program
// folder (update.js starts us from Friday's old folder, maybe deleted by now).
function cdHint() {
  const shell = process.env.SECURITYAI_SHELL_CWD != null ? process.env.SECURITYAI_SHELL_CWD : CWD;
  if (shell && path.resolve(shell) === path.resolve(__dirname)) return '';
  return path.resolve(__dirname) === path.resolve(RC.codeHome()) ? 'cd ~/securityai' : `cd "${__dirname}"`;
}

// ---------------------------------------------------------------- output
const say = (...a) => console.log(...a);
const step = t => say(`\n=== ${t} ===`);
let SECRETS = [];
const safe = s => P.maskText(s, SECRETS);
function fail(lines, code) {
  say('');
  for (const l of [].concat(lines)) say(safe(l));
  say('');
  process.exit(code == null ? 1 : code);
}
function showFile(file, what) {
  const opened = !args['no-open'] && P.openFile(file);
  say(opened ? `  Opened ${what} on screen:  ${file}` : `  Open this picture to look at it:  ${file}`);
}

// ---------------------------------------------------------------- asking
// TTY: a fresh readline per question (so the masked password reader can
// take over stdin in between). Piped stdin: one shared line queue, so
// answers can be scripted. --yes: never read, always take the default.
let lineQueue = null, lineWaiters = [], stdinEnded = false;
function pipedLine() {
  if (!lineQueue) {
    lineQueue = [];
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', l => { if (lineWaiters.length) lineWaiters.shift()(l); else lineQueue.push(l); });
    rl.on('close', () => { stdinEnded = true; while (lineWaiters.length) lineWaiters.shift()(null); });
  }
  if (lineQueue.length) return Promise.resolve(lineQueue.shift());
  if (stdinEnded) return Promise.resolve(null);
  return new Promise(r => lineWaiters.push(r));
}

async function ask(question, def) {
  const prompt = `${question}${def != null && def !== '' ? ` [${def}]` : ''}: `;
  if (AUTO) { say(`${prompt}${def != null ? def : ''}   (automatic)`); return def != null ? String(def) : ''; }
  let ans;
  if (process.stdin.isTTY) {
    ans = await new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('SIGINT', () => { say('\nStopped.'); process.exit(130); });
      rl.question(prompt, a => { rl.close(); resolve(a); });
    });
  } else {
    process.stdout.write(prompt);
    ans = await pipedLine();
    process.stdout.write((ans == null ? '' : '(answered)') + '\n');
    if (ans == null) ans = '';
  }
  const n = P.normaliseInput(ans);
  const v = n.value.trim();
  return v === '' && def != null ? String(def) : v;
}

async function askYesNo(question, defYes) {
  for (;;) {
    const a = (await ask(`${question} (${defYes ? 'Y/n' : 'y/N'})`, null)).toLowerCase();
    if (!a) return !!defYes;
    if (/^y/.test(a)) return true;
    if (/^n/.test(a)) return false;
    say('  Please type y or n.');
  }
}

// Masked input: shows * per character. No shell is involved at any point,
// so ! $ " ' & in a password are just characters.
function readSecretTTY(prompt) {
  return new Promise(resolve => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    let val = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    const onData = buf => {
      let s = buf.toString('utf8');
      s = s.replace(/\x1b\[20[01]~/g, '').replace(/\x1b\[[0-9;]*[A-Za-z~]/g, ''); // paste brackets, arrows
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') { finish(); return; }
        if (ch === '\u0003') { stdin.setRawMode(!!wasRaw); process.stdout.write('\n'); say('Stopped.'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { if (val.length) { val = Array.from(val).slice(0, -1).join(''); process.stdout.write('\b \b'); } continue; }
        if (ch === '\u0015') { process.stdout.write('\b \b'.repeat(Array.from(val).length)); val = ''; continue; } // Ctrl-U
        if (ch < ' ') continue;
        val += ch; process.stdout.write('*');
      }
    };
    function finish() {
      stdin.removeListener('data', onData);
      stdin.setRawMode(!!wasRaw);
      stdin.pause();
      process.stdout.write('\n');
      resolve(val);
    }
    stdin.on('data', onData);
  });
}

// Returns the cleaned secret. what = "password" | "token".
async function askSecret(question, envVar, what) {
  let raw;
  if (envVar) {
    raw = process.env[envVar];
    if (raw == null) fail(`--${what === 'token' ? 'token' : 'pass'}-env ${envVar}: that environment variable is not set.`);
    say(`${question}: (from $${envVar})`);
  } else if (AUTO) {
    fail(`No ${what} given. With --yes, pass it with --${what === 'token' ? 'token' : 'pass'}-env VARIABLE.`);
  } else if (process.stdin.isTTY) {
    raw = await readSecretTTY(`${question} (typing shows *): `);
  } else {
    process.stdout.write(`${question}: `);
    raw = await pipedLine();
    process.stdout.write('(answered)\n');
    if (raw == null) raw = '';
  }
  const n = P.normaliseInput(raw);
  let v = n.value.replace(/[\r\n]/g, '');
  if (n.changed) say(`  Note: I changed curly quotes/dashes in the ${what} to plain ones (' " -). Phones and Notes swap them in.`);
  if (v !== v.trim()) {
    const where = /^\s/.test(v) && /\s$/.test(v) ? 'start and end' : /^\s/.test(v) ? 'start' : 'end';
    say(`  Warning: the ${what} has a space at the ${where}. That is almost always a copy-paste accident.`);
    const keep = what === 'password' && !AUTO && !envVar ? await askYesNo('  Keep the space(s)?', false) : false;
    if (!keep) { v = v.trim(); say('  Removed the space(s).'); }
  }
  if (v) SECRETS.push(v);
  return v;
}

// ---------------------------------------------------------------- existing config
function readExisting() {
  if (!fs.existsSync(CONFIG)) return { exists: false, cfg: null };
  let text = fs.readFileSync(CONFIG, 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  try {
    const cfg = JSON.parse(text);
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) return { exists: true, cfg };
  } catch (e) { /* broken file: we'll back it up and rewrite */ }
  return { exists: true, cfg: null, broken: true };
}
function rememberedCamera(cfg) {
  const u = cfg && Array.isArray(cfg.zones) && cfg.zones[0] && cfg.zones[0].cameraUrl;
  if (typeof u !== 'string') return {};
  const m = u.match(/^rtsps?:\/\/(?:([^:@\/]*)(?::[^@\/]*)?@)?([^:\/?#]+)(?::(\d+))?/i);
  if (!m) return {};
  let user = m[1] || null;
  try { if (user) user = decodeURIComponent(user); } catch (e) { /* keep raw */ }
  return { user, host: m[2], port: m[3] ? +m[3] : null };
}

// ---------------------------------------------------------------- validation
// Mirrors the shared schema in .agent-brief.md. Returns list of problems.
function validateSchema(cfg, frame) {
  const bad = [];
  if (!cfg || typeof cfg !== 'object') return ['not an object'];
  if (typeof cfg.gymCode !== 'string' || !cfg.gymCode) bad.push('gymCode missing');
  if (!(Number(cfg.dailyBurstCap) > 0)) bad.push('dailyBurstCap must be a number above 0');
  if (cfg.serverUrl) {
    if (!/^https?:\/\/[^\s/]+$/.test(cfg.serverUrl)) bad.push('serverUrl must be like https://site.com');
    if (!cfg.runnerToken || typeof cfg.runnerToken !== 'string') bad.push('runnerToken required when serverUrl is set');
  }
  if (!Array.isArray(cfg.zones) || !cfg.zones.length) { bad.push('zones missing'); return bad; }
  cfg.zones.forEach((z, i) => {
    const n = `zones[${i}]`;
    if (!z.label) bad.push(`${n}.label missing`);
    if (typeof z.cameraUrl !== 'string' || !/^rtsps?:\/\/[^\s]+$/.test(z.cameraUrl)) bad.push(`${n}.cameraUrl must be an rtsp:// address`);
    else { try { new URL(z.cameraUrl); } catch (e) { bad.push(`${n}.cameraUrl does not parse`); } }
    if (!Number.isInteger(z.expectedCount) || z.expectedCount < 1) bad.push(`${n}.expectedCount must be 1 or more`);
    if (typeof z.accessibleGate !== 'boolean') bad.push(`${n}.accessibleGate must be true/false`);
    const ks = ['cropX', 'cropY', 'cropW', 'cropH'];
    const have = ks.filter(k => z[k] != null);
    if (have.length && have.length !== 4) bad.push(`${n}: crop needs all four of cropX/cropY/cropW/cropH`);
    if (have.length === 4) {
      if (!ks.every(k => Number.isInteger(z[k]) && z[k] >= 0)) bad.push(`${n}: crop values must be whole numbers`);
      if (z.cropW < 16 || z.cropH < 16) bad.push(`${n}: crop too small`);
      if (frame && i === 0 && (z.cropX + z.cropW > frame.width || z.cropY + z.cropH > frame.height)) bad.push(`${n}: crop goes outside the ${frame.width}x${frame.height} picture`);
    }
  });
  return bad;
}

// ---------------------------------------------------------------- explanations
function explainTcp(r, host, port) {
  const mine = P.localIPv4();
  const lines = [];
  if (r.code === 'refused') {
    lines.push(`The recorder at ${host} answered, but port ${port} (camera video, "RTSP") is closed.`);
    lines.push('Meaning: the IP is right and the cable is fine, but RTSP is switched off or uses another port.');
    lines.push(`Do this: on the recorder's web page (http://${host}) look in System > Network for "RTSP port" -`);
    lines.push('make sure RTSP is enabled; if the port is not 554 re-run with  node setup-camera.js --port THATNUMBER');
  } else if (r.code === 'dns') {
    lines.push(`"${host}" is not an address this laptop can find. Use the recorder's number address, like 192.168.2.54.`);
  } else {
    lines.push(`Cannot reach ${host} at all (${r.code === 'timeout' ? 'no answer after 4 seconds' : 'no route to it'}).`);
    lines.push('Meaning: this laptop is on a different network from the recorder, the cable is unplugged, or the IP is wrong.');
    if (mine.length) {
      const same = mine.some(a => P.sameSubnet24(a.address, host));
      lines.push(`This laptop's address: ${mine.map(a => a.address).join(', ')}` + (same ? '  (same network - good)' :
        `  - the recorder is ${host}. If these don't start with the same numbers, the laptop may be on a different network.`));
    } else lines.push('This laptop has NO network address right now - the cable is not connected (or Wi-Fi is off).');
    lines.push("Do this: plug the cable in the same spot as Friday, wait 20 seconds, run this again. Still failing? Turn Wi-Fi off and try once more.");
    lines.push(`Check the IP on the recorder's own screen: System > Network > Basic.`);
  }
  return lines;
}

function authGuidance(entry, second) {
  const stage = entry && entry.result && entry.result.stage;
  const lines = [];
  if (!second) {
    lines.push('The recorder REJECTED the username or password (401).');
    lines.push('I stopped testing straight away - this recorder locks the account after a few wrong tries.');
    if (stage === 'OPTIONS') lines.push('(It asked for the password before even looking at the address, so this is about the login, not the address.)');
    lines.push("Check it: it's the login you use on the recorder's web page (Live View). Capital letters matter.");
  } else {
    lines.push(second === 'noask'
      ? 'Stopping now (running automatically, so I cannot ask again) so the account does not get locked.'
      : 'The recorder rejected the login AGAIN. Stopping now so the account does not get locked.');
    lines.push('');
    lines.push('Do this, on the recorder web page (http://<recorder-ip>) or its own screen:');
    lines.push('  1. System > User Management (or Account): check the username exactly, and that the account is enabled.');
    lines.push('  2. Make sure that account is allowed "Live View" / "Remote preview".');
    lines.push('  3. If it says "locked", wait 30 minutes (or unlock it as admin) before trying again.');
    lines.push('Then run  node setup-camera.js  again.');
  }
  return lines;
}

// ---------------------------------------------------------------- main
(async () => {
  say('Camera setup');
  say('This connects this computer to your website, finds your camera, and saves the settings.');
  say('You will not have to type any camera address. Press Ctrl-C at any time to stop.');

  const existing = readExisting();
  const remembered = rememberedCamera(existing.cfg);
  if (existing.broken) say(`\n(Your current ${path.basename(CONFIG)} is not valid JSON. It will be backed up and replaced.)`);

  // ---- 1. website (first: a wrong address or no internet shows up now,
  //         not after ten minutes of camera questions)
  step('1. Connect to the website');
  const base0 = existing.cfg || {};
  let serverUrl = base0.serverUrl || null, runnerToken = base0.runnerToken || null, pairedGym = null;
  if (runnerToken) SECRETS.push(runnerToken);
  const usePairing = got => { if (got) { serverUrl = got.serverUrl; runnerToken = got.runnerToken; pairedGym = got.gymCode; SECRETS.push(runnerToken); } return !!got; };
  if (args['no-server']) {
    say(serverUrl ? `  Keeping ${serverUrl} as it is (--no-server).` : '  Skipped (--no-server): this computer will count on its own (needs ANTHROPIC_API_KEY in .env).');
  } else if (args['server-url'] && args['pair-code']) {
    if (!usePairing(await PC.pairInteractive({ ask, say, siteGiven: String(args['server-url']), code: String(args['pair-code']), noRetry: true }))) fail('Pairing failed (see above). Nothing was changed.');
  } else if (args['server-url']) {
    const n = PC.normaliseSite(args['server-url']);
    if (n.error) fail(n.error);
    serverUrl = n.url;
    if (args['token-env']) runnerToken = await askSecret('Runner token', args['token-env'], 'token');
    say(`  Website: ${serverUrl}`);
  } else if (AUTO) {
    say(serverUrl ? `  Keeping ${serverUrl}.` : '  Not connected (running automatically - use --server-url and --pair-code to connect).');
  } else if (serverUrl && runnerToken) {
    const c = await PC.checkToken(serverUrl, runnerToken);
    if (c.ok) say(`  Connected to ${serverUrl} ✓ (already paired)`);
    else if (!c.auth) say(`  Could not check ${serverUrl} right now: ${c.msg} Keeping the settings.`);
    else {
      say(`  ${serverUrl}: ${c.msg}`);
      if (await askYesNo('  Pair this computer again now? (you need a code from the admin page)', true)) usePairing(await PC.pairInteractive({ ask, say, site: serverUrl.replace(/^https:\/\//, ''), allowSkip: true }));
      else say('  Keeping the old settings. Pair later with:  node pair.js');
    }
  } else {
    say('  This computer sends each crossing to your website, which does the counting and');
    say('  shows it on the activity page. Nothing secret is stored on this computer except');
    say('  the camera password and a pairing token.');
    usePairing(await PC.pairInteractive({ ask, say, allowSkip: true }));
    if (!serverUrl) say('  Skipped. This computer will count on its own (needs ANTHROPIC_API_KEY in .env). Connect later with:  node pair.js');
  }
  // A pairing code works once: save the pairing NOW, so it is not lost if
  // the camera part below fails or is stopped.
  if (pairedGym) {
    const keep = Object.assign({}, existing.cfg || {}, { gymCode: pairedGym, serverUrl, runnerToken });
    if (keep.dailyBurstCap == null) keep.dailyBurstCap = 60;
    if (!Array.isArray(keep.zones)) keep.zones = [];
    if (existing.exists) { try { fs.copyFileSync(CONFIG, CONFIG + '.bak'); fs.chmodSync(CONFIG + '.bak', 0o600); } catch (e) { /* ignore */ } }
    RC.writePrivate(CONFIG, JSON.stringify(keep, null, 2) + '\n');
    existing.cfg = keep; existing.exists = true; existing.broken = false;
  }

  // ---- 1. questions
  step('2. The recorder');
  let host, port;
  for (let tries = 0; ; tries++) {
    const a = args.ip != null && tries === 0 ? String(args.ip) : await ask("Recorder (NVR) IP address - it's on the recorder's screen under System > Network", remembered.host || null);
    if (args.ip != null && tries === 0) say(`Recorder IP: ${a}`);
    const h = P.parseHostInput(a);
    if (!h.error) { host = h.host; port = parseInt(args.port, 10) || h.port || remembered.port || 554; break; }
    say('  ' + h.error);
    if (AUTO || tries >= 4) fail('No valid recorder address. Run again and type it like 192.168.2.54');
  }
  let user = args.user != null ? P.normaliseInput(args.user).value.trim() : await ask('Username (the login for the recorder web page)', remembered.user || 'admin');
  if (args.user != null) say(`Username: ${user}`);
  let pass = await askSecret('Password', args['pass-env'], 'password');
  if (!pass) say('  (No password entered - trying without one.)');

  // ---- 2. pre-checks
  step('3. Checking this laptop can see the recorder');
  // ffmpeg left in Downloads works here but not for the background
  // monitor (macOS blocks that folder): copy it somewhere that works.
  const ffp = RC.prepareFfmpeg();
  if (ffp) P.setFfmpeg(ffp.path);
  if (ffp && ffp.copiedFrom) say(`  Copied ffmpeg from ${RC.tildify(ffp.copiedFrom)} to ${RC.tildify(ffp.path)} (so the background monitor can use it too).`);
  const ff = await P.ffmpegCheck();
  if (!ff.ok) {
    fail([
      'ffmpeg is not on this computer (or it would not start). It is needed to read the camera.',
      process.platform === 'darwin'
        ? 'Do this: on this Mac, download ffmpeg from evermeet.cx/ffmpeg (the .zip), double-click it in Downloads so a file called ffmpeg appears,\n  then type  node setup-camera.js  again. It finds ffmpeg in Downloads by itself.'
        : 'Do this: sudo apt install -y ffmpeg',
    ]);
  }
  say(`  ffmpeg ${ff.version} - OK`);
  const tcp = await P.tcpCheck(host, port, 4000);
  if (!tcp.ok) fail(explainTcp(tcp, host, port));
  say(`  Recorder ${host} answers on port ${port} - OK`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'camsetup-'));
  process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ } });

  // ---- 3+4. find the address format (channel 1), check it follows the channel
  step('4. Finding the right camera address (tries each known kind, using channel 1)');
  let authFailures = 0, detection;
  for (;;) {
    const creds = { host, port, user, pass };
    detection = await P.testFormats(creds, 1, tmp, {
      checkChannels: true, stopAtFirstGood: true,
      onResult: e => {
        let line = `  ${e.format.name.padEnd(46)} ${P.describe(e.result)}`;
        if (e.channel_check) line += e.channel_check.aware === false ? '  - but IGNORES the channel number' : '  - follows the channel number';
        say(line);
      },
    });
    if (!detection.authFailed) break;
    authFailures++;
    // Second 401, or nobody here to re-type it: stop. Never loop credentials.
    if (authFailures >= 2 || AUTO || args['pass-env']) {
      if (authFailures < 2) { say(''); authGuidance(detection.authFailed, false).forEach(l => say(l)); }
      fail(authGuidance(detection.authFailed, authFailures < 2 ? 'noask' : true).map(l => l.replace('<recorder-ip>', host)));
    }
    say('');
    authGuidance(detection.authFailed, false).forEach(l => say(l));
    say('Type them once more (one more try only):');
    user = await ask('Username', user);
    SECRETS = [];
    pass = await askSecret('Password', null, 'password');
    say('');
  }

  let format, agnostic = false;
  if (detection.found) {
    format = detection.found.format;
    say(`\n  Using: ${format.name}  (${detection.found.channel_check.reason || 'OK'})`);
  } else {
    // Nothing that follows the channel number. Bare root last, with a warning.
    let fallback = detection.agnosticOnly;
    if (!fallback) {
      say('  Last resort: the bare address with no channel...');
      const r = await P.testFormats({ host, port, user, pass }, 1, tmp, { formats: [], includeRoot: true,
        onResult: e => say(`  ${e.format.name.padEnd(46)} ${P.describe(e.result)}`) });
      if (r.authFailed) fail(authGuidance(r.authFailed, true).map(l => l.replace('<recorder-ip>', host)));
      fallback = r.agnosticOnly;
    }
    const statuses = detection.results.map(e => e.result.status);
    if (!fallback) {
      const lines = ['No camera address worked.'];
      if (statuses.every(s => s === 'notfound')) lines.push('The recorder knows none of the usual address formats. Do this: send a photo of this screen for help.');
      else if (statuses.some(s => s === 'timeout')) lines.push('The recorder is slow to answer or too many video connections are open. Do this: close the recorder web page/app live view and try again.');
      else if (statuses.some(s => s === 'refused' || s === 'unreachable')) lines.push('The connection dropped while testing. Do this: check the cable and run this again.');
      else lines.push('Do this: send a photo of this screen for help.');
      fail(lines);
    }
    say('');
    say(fallback.format.channelAware === false
      ? 'WARNING: the only address that works has NO channel number in it.'
      : `WARNING: the only address that works (${fallback.format.name}) ignores the channel number.`);
    say('It ALWAYS shows camera 1, whatever channel you want. Friday night the runner watched');
    say('camera 1 (the pro shop) instead of the door because of exactly this.');
    say('Only use it if camera 1 really IS your entrance.');
    if (!(await askYesNo('Use it anyway?', false))) fail('Stopped. Send a photo of this screen for help.');
    format = fallback.format; agnostic = true;
  }
  if (format.channelAware === false) agnostic = true;

  // ---- 5. scan channels + contact sheet
  step(agnostic ? '5. Taking a picture' : `5. Taking a picture of every channel (1 to ${MAX_CH}, stops after 3 empty ones)`);
  fs.mkdirSync(CHECK_DIR, { recursive: true });
  for (const f of fs.readdirSync(CHECK_DIR)) if (/^(channel-\d+|all-channels|grid|crop-preview)\.jpg$/.test(f)) fs.unlinkSync(path.join(CHECK_DIR, f));
  const creds = { host, port, user, pass };
  const shots = {};
  let misses = 0;
  const last = agnostic ? 1 : MAX_CH;
  for (let n = 1; n <= last; n++) {
    const file = path.join(CHECK_DIR, `channel-${String(n).padStart(2, '0')}.jpg`);
    const r = await P.grabFrame(P.buildUrl(creds, format, n), file);
    say(`  channel ${String(n).padStart(2)}: ${r.status === 'ok' ? `picture saved (${r.width}x${r.height})` : P.describe(r)}`);
    if (r.status === 'auth') fail(['The recorder suddenly rejected the login. The account may have been locked.', 'Do this: wait 30 minutes, check System > User Management, then run this again.']);
    if (r.status === 'ok') { shots[n] = r; misses = 0; } else if (++misses >= 3) { say('  (3 empty channels in a row - stopping here)'); break; }
  }
  const got = Object.keys(shots).map(Number);
  if (!got.length) fail('Could not get a picture from any channel. Do this: close any other live view of the recorder and run this again.');
  let sheet = null;
  if (got.length > 1) {
    sheet = await P.contactSheet(got.map(n => ({ file: shots[n].file, label: `CH ${n}` })), path.join(CHECK_DIR, 'all-channels.jpg'));
    if (sheet.ok) {
      say(`\n  All channels in one picture${sheet.labelled ? '' : ' (no labels - they read left to right, top to bottom: ' + got.join(', ') + ')'}:`);
      showFile(sheet.file, 'all-channels.jpg');
    } else say(`\n  (Could not make the combined picture - look at the single pictures in ${CHECK_DIR})`);
  } else showFile(shots[got[0]].file, 'the picture');

  // ---- 6. choose channel, stream, label, count
  step('6. Which camera is the entrance?');
  let channel;
  for (let tries = 0; ; tries++) {
    let a = args.channel != null && tries === 0 ? String(args.channel) : (got.length === 1 ? String(got[0]) : await ask('Which channel number shows your entrance? (the number in the corner of its picture)', null));
    const m = String(a).match(/\d+/);
    const n = m ? parseInt(m[0], 10) : NaN;
    if (shots[n]) { channel = n; break; }
    say(m ? `  Channel ${n} gave no picture. Choose one of: ${got.join(', ')}` : `  Type just the number, e.g. ${got[got.length > 3 ? 3 : 0]}`);
    if (AUTO || tries >= 4) fail('No usable channel chosen.');
  }
  say(`  Channel ${channel}.`);
  let useSub = false;
  let frameFile = shots[channel].file;
  let frame = { width: shots[channel].width, height: shots[channel].height, codec: shots[channel].codec };
  if (!agnostic && format.sub && (args.stream === 'sub' || (args.stream == null && frame.width > 2560))) {
    const subFile = path.join(tmp, `sub-ch${channel}.jpg`);
    const r = await P.grabFrame(P.buildUrl(creds, format, channel, { sub: true }), subFile);
    if (r.status === 'ok') {
      if (args.stream === 'sub') useSub = true;
      else {
        say(`  This camera sends a very big picture (${frame.width}x${frame.height}). A smaller "sub-stream" (${r.width}x${r.height}) also exists.`);
        // An old laptop often cannot decode the big picture as fast as it
        // arrives (Friday: fan roaring, pictures missed). Measure it.
        let slow = null, sp = null;
        if (!AUTO) {
          say('  Testing whether this laptop keeps up with the big picture (10 seconds)...');
          sp = await P.decodeSpeed(P.buildUrl(creds, format, channel), { seconds: 10 });
          if (sp.ok && sp.sourceFps > 0) slow = sp.rate < Math.max(3, sp.sourceFps * 0.85);
        }
        if (slow) {
          say(`  Too slow: this laptop manages only ${Math.round(sp.rate)} of the ${Math.round(sp.sourceFps)} pictures a second the camera sends.`);
          say('  Use the small one on this laptop. People are still counted from a close-up of the door.');
          useSub = !(await ask('  Press Enter to use the small one, or type B for the big one', '')).toLowerCase().startsWith('b');
        } else {
          if (slow === false) say(`  OK: this laptop keeps up (${Math.round(sp.rate)} pictures a second).`);
          else if (!AUTO) say('  (Could not test the speed.)');
          say('  Big = sharper pictures for counting people, but hard work for an old laptop.');
          useSub = (await ask('  Press Enter to use the big one, or type S for the small one', '')).toLowerCase().startsWith('s');
        }
      }
      if (useSub) { frameFile = r.file; frame = { width: r.width, height: r.height, codec: r.codec }; say(`  Using the sub-stream ${frame.width}x${frame.height}.`); }
    } else if (args.stream === 'sub') say(`  Sub-stream not available (${P.describe(r)}) - using the main one.`);
  }
  const cameraUrl = P.buildUrl(creds, format, channel, { sub: useSub });
  const fsize = await P.mediaSize(frameFile);
  if (fsize && (fsize.width !== frame.width || fsize.height !== frame.height)) frame = Object.assign(frame, fsize);
  say(`  Picture size: ${frame.width}x${frame.height}${frame.codec ? ' ' + frame.codec : ''}`);

  const label = args.label != null ? String(args.label).trim() : await ask('Name for this door', 'Front Door');
  let expectedCount;
  for (let tries = 0; ; tries++) {
    const a = args.expected != null && tries === 0 ? String(args.expected) : await ask('How many people are allowed through per card swipe?', '1');
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= 20) { expectedCount = n; break; }
    say('  Type a whole number like 1.');
    if (AUTO || tries >= 4) fail('Expected count must be a whole number, 1 or more.');
  }

  // ---- 7. crop
  step('7. Which part of the picture to watch');
  say('  Why: the detector shrinks the watched area to a 12x12 grid. On the whole 4K picture a');
  say('  person is smaller than one square and gets missed - a tight box round the door fixes that.');
  const full = { cropX: 0, cropY: 0, cropW: frame.width, cropH: frame.height };
  let crop = full, cropName = 'whole picture';
  for (let round = 0; round < 3; round++) {
    crop = full; cropName = 'whole picture';
    const cropArg = args.crop != null ? String(args.crop).trim() : null;
    const xywh = cropArg && cropArg.match(/^(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)$/);
    if (cropArg && /^full$/i.test(cropArg)) {
      say('  Watching the whole picture (--crop full).');
    } else if (xywh) {
      crop = { cropX: +xywh[1], cropY: +xywh[2], cropW: +xywh[3], cropH: +xywh[4] };
      if (crop.cropX + crop.cropW > frame.width || crop.cropY + crop.cropH > frame.height) fail(`--crop ${cropArg} goes outside the ${frame.width}x${frame.height} picture.`);
      cropName = 'custom';
    } else {
      const wantGrid = cropArg || round > 0 ? true : await askYesNo('  Pick the doorway on a grid now? (recommended)', true);
      if (wantGrid) {
        const g = await P.gridImage(frameFile, path.join(CHECK_DIR, 'grid.jpg'), { cols: GRID_COLS, rows: GRID_ROWS });
        if (!g.ok) say('  (Could not draw the grid picture - using the whole picture.)');
        else {
          say(`  The picture now has squares A1 (top left) to ${P.COL_LETTERS[GRID_COLS - 1]}${GRID_ROWS} (bottom right)${g.labelled ? '' : ' - letters A-F go left to right, numbers 1-6 top to bottom'}.`);
          showFile(g.file, 'grid.jpg');
          say('  (Not the door in that picture? Press Ctrl-C and run  node setup-camera.js  again.)');
          // On a big picture, Enter must not quietly mean "the whole
          // picture" (Friday's mistake): ask for squares until given.
          const big = RC.tooWide(frame.width, frame.width);
          let empty = 0;
          for (let tries = 0; tries < 6; tries++) {
            const a = cropArg && tries === 0 ? cropArg : await ask(big
              ? '  Type the top-left and bottom-right squares around the doorway and the floor in front of it (e.g. B2 C4)'
              : '  Type the top-left and bottom-right squares around the doorway and the floor in front of it (e.g. B2 C4), or Enter for the whole picture', '');
            if (cropArg && tries === 0) say(`  Squares: ${a}`);
            if (big && /^(all|whole)\b/i.test(a)) break;
            if (!a && big) {
              if (++empty >= 3) fail(['Stopped: no doorway squares were typed. Nothing about the camera was saved.',
                `Do this: look at the grid picture (${RC.tildify(g.file)}), find the two squares at the corners of`,
                'the turnstile and the floor in front of it, then run  node setup-camera.js  again and type them, e.g. B2 C4.']);
              say('  Type two squares, e.g. B2 C4 - the letter is the column, the number the row, as on the grid picture.');
              say('  (The whole picture is too big to count people in. To use it anyway, type ALL.)');
              continue;
            }
            if (!a) break;
            const b = P.parseCells(a, GRID_COLS, GRID_ROWS);
            if (b.error) { say('  ' + b.error); if (AUTO) fail(b.error); continue; }
            const c = P.cellsToCrop(b, frame.width, frame.height, GRID_COLS, GRID_ROWS);
            const pv = await P.cropPreview(frameFile, c, path.join(CHECK_DIR, 'crop-preview.jpg'));
            if (pv.ok) showFile(pv.file, 'crop-preview.jpg (what the detector will watch)');
            if (await askYesNo(`  Squares ${P.cellsName(b)} = ${c.cropW}x${c.cropH} pixels. Does the preview show the doorway?`, true)) {
              crop = c; cropName = P.cellsName(b); break;
            }
          }
        }
      }
    }
    // The whole of a big picture is Friday's mistake: a person is smaller
    // than one square of the 12x12 motion grid and gets missed.
    if (!RC.tooWide(crop.cropW, frame.width) || AUTO || cropArg) break;
    say(`  Warning: that watches an area ${crop.cropW} pixels wide${crop.cropW >= frame.width ? ' (the whole picture)' : ''}. On a picture this big a person`);
    say('  is too small in it and will often be missed. A box around just the doorway works much better.');
    if (!(await askYesNo('  Pick the doorway on the grid now?', true))) break;
  }
  say(`  Watching: ${cropName} (x=${crop.cropX} y=${crop.cropY}, ${crop.cropW}x${crop.cropH}).`);

  // ---- 8. website connection + write
  step('8. Saving');
  const base = existing.cfg ? Object.assign({}, existing.cfg) : {};
  let gymCode = pairedGym || base.gymCode;
  if (!gymCode) gymCode = args['gym-code'] || await ask('Gym code (short name used on the website)', 'jstreet');

  // frameW/frameH = the picture size the box was drawn on. If the camera's
  // picture size changes later, the monitor scales the box to match.
  const zone = { label, cameraUrl, cropX: crop.cropX, cropY: crop.cropY, cropW: crop.cropW, cropH: crop.cropH, frameW: frame.width, frameH: frame.height, expectedCount, accessibleGate: false };
  // The person said yes to "Use it anyway?" (camera 1 IS the entrance):
  // tell the monitor, which otherwise refuses an address with no channel.
  if (agnostic) zone.noChannelOk = true;
  // Stable, readable key order; every other existing key is kept as it was.
  const order = ['gymCode', 'dailyBurstCap', 'alertEmail', 'model', 'scheduleStart', 'scheduleEnd', 'serverUrl', 'runnerToken'];
  const out = {};
  const merged = Object.assign({}, base, { gymCode, dailyBurstCap: base.dailyBurstCap != null ? base.dailyBurstCap : 60 });
  if (serverUrl) { merged.serverUrl = serverUrl; merged.runnerToken = runnerToken; } else { delete merged.serverUrl; delete merged.runnerToken; }
  for (const k of order) if (merged[k] !== undefined) out[k] = merged[k];
  for (const k of Object.keys(merged)) if (!(k in out) && k !== 'zones') out[k] = merged[k];
  out.zones = [zone];

  const pre = validateSchema(out, frame);
  if (pre.length) fail(['Internal check failed before saving: ' + pre.join('; '), 'Nothing was written. Send a photo of this screen for help.']);

  if (existing.exists && !pairedGym) {
    fs.copyFileSync(CONFIG, CONFIG + '.bak');
    try { fs.chmodSync(CONFIG + '.bak', 0o600); } catch (e) { /* ignore */ }
    say(`  Old settings backed up to ${path.basename(CONFIG)}.bak`);
    if (existing.cfg && Array.isArray(existing.cfg.zones) && existing.cfg.zones.length > 1) say(`  (The old file had ${existing.cfg.zones.length} cameras; the new one has just this door.)`);
  }
  RC.writePrivate(CONFIG, JSON.stringify(out, null, 2) + '\n');   // owner-only: it holds the camera password

  // re-read and validate what is actually on disk
  let reread;
  try { reread = JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch (e) { fail(`Saved ${CONFIG} but it does not read back as JSON (${e.message}).`); }
  const post = validateSchema(reread, frame);
  if (post.length) fail(['Saved file failed its check: ' + post.join('; ')]);
  if (reread.zones[0].cameraUrl !== cameraUrl) fail('Saved camera address does not match what was tested.');
  // Also run the runner's own checker when it is there, so we see what it will say.
  try {
    const rc = require('./runner-config');
    if (rc && rc.validateConfig) {
      const v = rc.validateConfig(reread, { baseDir: path.dirname(CONFIG) });
      if (v.errors && v.errors.length) fail(['The runner would reject this file:'].concat(v.errors));
      (v.warnings || []).forEach(w => say('  Note: ' + safe(w)));
    }
  } catch (e) { if (e && e.code !== 'MODULE_NOT_FOUND') say('  (Could not run the runner\'s own check: ' + safe(e.message) + ')'); }
  say(`  Saved and checked: ${RC.tildify(CONFIG)}`);
  say(`  Camera: ${P.maskUrl(cameraUrl)}`);
  say(`  Mode: ${serverUrl ? `connected to ${serverUrl} (no API key needed on this laptop)` : 'this laptop only (needs ANTHROPIC_API_KEY in .env)'}`);

  // ---- 9. keep it running
  const svc = require('./install-service');
  const already = svc.isInstalled();
  let background = false;
  if (args['no-service']) background = false;
  else if (args.service || already) background = true;
  else if (!AUTO) {
    step('9. Keep it running');
    say('  The monitor can run in the background: it starts by itself when this computer');
    say('  starts, and restarts itself if anything goes wrong. (Undo any time: node install-service.js --remove)');
    background = await askYesNo('  Start it now and keep it running?', true);
  }
  if (background) {
    const r = svc.install({ say: m => say(m), quiet: already });
    if (r.ok) {
      say(already ? '\n  The background monitor restarts with the new settings within a minute.' : '');
      say('=== Done. Walk through the door now. ===');
      say('Check your phone: the activity page should say "Watching your entrance", and each');
      say('walk-through appears there within a minute. Live output from this computer follows below.');
      say('Press Ctrl-C to stop WATCHING (the monitor keeps running).\n');
      if (!AUTO && process.stdout.isTTY) {
        await new Promise(r2 => setTimeout(r2, 4000));
        process.on('SIGINT', () => {});      // Ctrl-C stops the live view below, then we say one more thing
        require('child_process').spawnSync(process.execPath, [path.join(RC.codeHome(), 'rtsp-run.js')], { stdio: 'inherit' });
        say(`\nTo watch it again later:  ${cdHint() ? cdHint() + '  then  ' : ''}node rtsp-run.js`);
      }
      process.exit(0);
    }
    say('  Could not set up the background monitor - run it in this window instead (below).');
  }
  say('\n=== Done. Next, type exactly: ===\n');
  if (cdHint()) say(`    ${cdHint()}`);
  say('    node rtsp-run.js\n');
  say('You should see "SecurityAI camera monitor", then a line for');
  say(`"${label}" showing ${frame.width}x${frame.height} and ${cropName === 'whole picture' ? 'whole picture' : `a ${crop.cropW}x${crop.cropH} box`}.`);
  say('Walk through the door: the motion number should jump, and a line appears for each crossing.');
  say('That window is then BUSY - typing in it does nothing. For any other command,');
  say('open a NEW Terminal window with Cmd+N.');
  process.exit(0);
})().catch(err => {
  console.error('\nSomething went wrong: ' + P.maskText(err && err.stack || String(err), SECRETS));
  console.error('Send a photo of this screen for help.');
  process.exit(1);
});
