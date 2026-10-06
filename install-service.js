#!/usr/bin/env node
// Run the monitor in the background: it starts by itself when the computer
// starts and restarts itself if it ever stops.
//
//   node install-service.js            switch it on (and start it now)
//   node install-service.js --remove   switch it off (also: --stop)
//   node install-service.js --wipe     giving the laptop back: delete everything
//                                      SecurityAI put on it (password, pairing,
//                                      program, pictures, old copies)
//   node install-service.js --print    only show the file it would install
//
// Mac: a LaunchAgent (~/Library/LaunchAgents/com.securityai.monitor.plist).
//      It runs while you are logged in — turn on automatic login
//      (System Preferences > Users & Groups > Login Options) so it also
//      comes back after a power cut.
// Raspberry Pi / Linux: a systemd service (asks for your password once).
//
// See what it is doing any time with:  node rtsp-run.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const LABEL = 'com.securityai.monitor';
const UNIT = 'securityai.service';
const say0 = m => console.log(m);

function platform() { return process.env.SECURITYAI_PLATFORM || process.platform; }
function dryRun() { return process.env.SECURITYAI_SERVICE_DRYRUN === '1'; }
function stateDir() { return process.env.SECURITYAI_HOME || path.join(os.homedir(), '.securityai'); }
function codeHome() { return process.env.SECURITYAI_CODE_DIR || path.join(os.homedir(), 'securityai'); }
function plistPath() { return path.join(process.env.SECURITYAI_LAUNCHAGENTS_DIR || path.join(os.homedir(), 'Library', 'LaunchAgents'), `${LABEL}.plist`); }
function unitPath() { return path.join(process.env.SECURITYAI_SYSTEMD_DIR || '/etc/systemd/system', UNIT); }

function which(cmd) {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
// PATH for the background job: node's folder, ffmpeg's folder, the usual
// places. Never Downloads/Desktop/Documents: macOS blocks background jobs
// there, so an ffmpeg left in Downloads is copied to ~/.securityai/bin.
function servicePath() {
  const dirs = [path.dirname(process.execPath)];
  let ff = null;
  try { const rc = require('./runner-config'); const p = rc.prepareFfmpeg && rc.prepareFfmpeg(); ff = p && path.isAbsolute(p.path) && !rc.macProtected(p.path) ? p.path : null; } catch (e) { /* older runner-config */ }
  if (!ff) ff = which('ffmpeg');
  if (ff) dirs.push(path.dirname(ff));
  dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  const h = os.homedir();
  return [...new Set(dirs)].filter(d => !['Downloads', 'Desktop', 'Documents'].some(x => (d + path.sep).startsWith(path.join(h, x) + path.sep))).join(':');
}
const xml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function plistText(code) {
  const env = { PATH: servicePath(), HOME: os.homedir(), SECURITYAI_SERVICE: '1' };
  for (const k of ['SECURITYAI_HOME', 'SECURITYAI_CODE_DIR']) if (process.env[k]) env[k] = process.env[k];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(path.join(code, 'rtsp-run.js'))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(code)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>15</integer>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(path.join(stateDir(), 'crash.log'))}</string>
</dict>
</plist>
`;
}

function unitText(code) {
  const user = os.userInfo().username;
  const q = s => (/[\s"\\]/.test(s) ? `"${String(s).replace(/(["\\])/g, '\\$1')}"` : s);
  const env = [`PATH=${servicePath()}`, `HOME=${os.homedir()}`, 'SECURITYAI_SERVICE=1'];
  for (const k of ['SECURITYAI_HOME', 'SECURITYAI_CODE_DIR']) if (process.env[k]) env.push(`${k}=${process.env[k]}`);
  return `[Unit]
Description=SecurityAI camera monitor
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${user}
WorkingDirectory=${q(code)}
${env.map(e => `Environment=${q(e)}`).join('\n')}
ExecStart=${q(process.execPath)} ${q(path.join(code, 'rtsp-run.js'))}
Restart=always
RestartSec=15
StandardOutput=null
StandardError=append:${path.join(stateDir(), 'crash.log')}

[Install]
WantedBy=multi-user.target
`;
}

function run(cmd, args, opts) {
  if (dryRun()) { say0(`  (dry run) ${cmd} ${args.join(' ')}`); return { status: 0 }; }
  return spawnSync(cmd, args, Object.assign({ stdio: 'inherit' }, opts || {}));
}
function sudo(shellCmd) {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  return isRoot ? run('/bin/sh', ['-c', shellCmd]) : run('sudo', ['/bin/sh', '-c', shellCmd]);
}

function isInstalled() {
  const p = platform();
  if (p === 'darwin') return fs.existsSync(plistPath());
  if (p === 'linux') return fs.existsSync(unitPath());
  return false;
}

// The background job must run the program from ~/securityai (a fixed place;
// on a Mac, background jobs are not allowed to read ~/Downloads).
function ensureCode(say) {
  const code = path.resolve(codeHome());
  if (path.resolve(__dirname) !== code) {
    say(`  Installing the program into ${code.replace(os.homedir(), '~')} (a fixed place, so updates and the background job always find it)...`);
    require('./update').installFromFolder(__dirname, code, { quiet: true });
  }
  return code;
}

// Moving from the laptop to a Raspberry Pi: two computers watching one gym
// would send every crossing twice.
function sayOtherComputer(say) {
  say('  If another computer was watching this gym, run  node install-service.js --remove  on it');
  say('  (otherwise both send every crossing).');
}

// Returns { ok, file }.
function install(opts) {
  const o = opts || {};
  const say = o.say || say0;
  const p = platform();
  if (p !== 'darwin' && p !== 'linux') { say('  Background mode is only set up automatically on a Mac or a Raspberry Pi / Linux.'); return { ok: false }; }
  const code = ensureCode(say);
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  if (p === 'darwin') {
    const file = plistPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) run('launchctl', ['unload', file], { stdio: 'ignore' });
    fs.writeFileSync(file, plistText(code));
    const r = run('launchctl', ['load', '-w', file]);
    if (r.status !== 0) { say(`  launchctl could not start it (${r.error ? r.error.message : 'exit ' + r.status}).`); return { ok: false, file }; }
    if (!o.quiet) { say('  ✓ The monitor now runs in the background and starts by itself when you log in.'); sayOtherComputer(say); }
    return { ok: true, file };
  }
  // linux / systemd
  if (!which('systemctl') && !dryRun()) { say('  This computer has no systemd, so background mode cannot be set up automatically.'); return { ok: false }; }
  const staged = path.join(stateDir(), UNIT);
  fs.writeFileSync(staged, unitText(code));
  if (!o.quiet) say('  Setting up the background service (it may ask for this computer\'s password)...');
  const r = sudo(`install -m 644 '${staged.replace(/'/g, "'\\''")}' '${unitPath()}' && systemctl daemon-reload && systemctl enable ${UNIT} && systemctl restart ${UNIT}`);
  if (r.status !== 0) { say('  Could not set up the service (wrong password, or no permission).'); return { ok: false }; }
  if (!o.quiet) { say('  ✓ The monitor now runs in the background and starts by itself when the computer starts.'); sayOtherComputer(say); }
  return { ok: true, file: unitPath() };
}

function remove(opts) {
  const say = (opts && opts.say) || say0;
  const p = platform();
  if (p === 'darwin') {
    const file = plistPath();
    if (!fs.existsSync(file)) { say('Background monitor is not set up — nothing to remove.'); return { ok: true }; }
    run('launchctl', ['unload', '-w', file]);
    fs.rmSync(file, { force: true });
  } else if (p === 'linux') {
    if (!fs.existsSync(unitPath())) { say('Background monitor is not set up — nothing to remove.'); return { ok: true }; }
    const r = sudo(`systemctl disable --now ${UNIT}; rm -f '${unitPath()}' && systemctl daemon-reload`);
    if (r.status !== 0) { say('Could not remove it (wrong password?).'); return { ok: false }; }
  } else { say('Nothing to remove on this computer.'); return { ok: true }; }
  say('✓ The background monitor is stopped and will not start by itself any more.');
  say('  Run it in a window with:  node rtsp-run.js     Switch background back on with:  node install-service.js');
  return { ok: true };
}

// Giving a borrowed laptop back: remove EVERYTHING SecurityAI put on it -
// the background job, the camera password and website pairing, the program
// and its camera pictures, old copies in Downloads (with the old API key),
// and camera addresses (they contain the password) in Terminal's history.
// The website and the gym's history are not touched.
const HISTORY_SECRET = /rtsp:\/\/[^\s'"]*@|sk-ant-[A-Za-z0-9_-]{8,}|ANTHROPIC_API_KEY\s*=|runnerToken/;
function historyFiles() {
  const h = os.homedir();
  const out = ['.bash_history', '.zsh_history', '.sh_history'].map(f => path.join(h, f));
  try { for (const f of fs.readdirSync(path.join(h, '.bash_sessions'))) if (/\.(history|historynew)$/.test(f)) out.push(path.join(h, '.bash_sessions', f)); } catch (e) { /* none */ }
  try { for (const f of fs.readdirSync(path.join(h, '.zsh_sessions'))) if (/\.(history|historynew)$/.test(f)) out.push(path.join(h, '.zsh_sessions', f)); } catch (e) { /* none */ }
  return out.filter(f => fs.existsSync(f));
}
function scrubHistory() {
  let lines = 0;
  for (const f of historyFiles()) {
    try {
      const text = fs.readFileSync(f, 'latin1');
      const kept = text.split('\n').filter(l => { const bad = HISTORY_SECRET.test(l); if (bad) lines++; return !bad; });
      if (kept.length !== text.split('\n').length) fs.writeFileSync(f, kept.join('\n'), 'latin1');
    } catch (e) { /* not ours to read */ }
  }
  return lines;
}
async function wipe(opts) {
  const o = opts || {};
  const say = o.say || say0;
  const state = path.resolve(stateDir()), code = path.resolve(codeHome());
  const tl = p => p.replace(os.homedir(), '~');
  let olds = [];
  try { olds = require('./update').oldCopies ? require('./update').oldCopies(code) : []; } catch (e) { /* none */ }
  say('This removes SecurityAI from this computer completely:');
  say('  - stops the monitor, and stops it starting by itself');
  say(`  - deletes the camera password and the website pairing (${tl(state)})`);
  say(`  - deletes the program and the camera pictures (${tl(code)})`);
  for (const d of olds) say(`  - deletes the old copy ${tl(d)}`);
  say('  - removes camera addresses (they contain the password) from Terminal\'s history');
  say('The website and the gym\'s history are not touched.');
  let answer = o.yes ? 'yes' : '';
  if (!o.yes) {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    answer = await new Promise(r => { let got = null; rl.on('close', () => r(got || '')); rl.question('Type YES to go ahead: ', a => { got = a; rl.close(); }); });
  }
  if (!/^\s*yes\s*$/i.test(answer)) { say('Nothing was deleted.'); return { ok: false }; }
  if (isInstalled()) remove({ say: () => {} });
  // A monitor still running in a Terminal window: stop it.
  try { const o2 = JSON.parse(fs.readFileSync(path.join(state, 'runner.pid'), 'utf8')); if (o2 && o2.pid && o2.pid !== process.pid) process.kill(o2.pid, 'SIGTERM'); } catch (e) { /* none */ }
  const gone = [];
  for (const d of [state, code, ...olds]) {
    if (!d || d === os.homedir() || d === path.parse(d).root) continue;
    try { if (fs.existsSync(d)) { fs.rmSync(d, { recursive: true, force: true }); gone.push(tl(d)); } } catch (e) { say(`Could not delete ${tl(d)} (${e.code || e.message}). Drag it to the Trash in Finder.`); }
  }
  const lines = scrubHistory();
  say(`\n✓ Deleted: ${gone.join(', ') || 'nothing was left'}.`);
  if (lines) say(`✓ Removed ${lines} line(s) with a camera address or key from Terminal's history.`);
  say('Done. Nothing from SecurityAI is left on this computer. Close this Terminal window now (Cmd+Q quits Terminal).');
  return { ok: true };
}

module.exports = { install, remove, wipe, isInstalled, plistText, unitText, plistPath, unitPath };

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a.includes('--help') || a.includes('-h')) {
    console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 19).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  } else if (a.includes('--print')) {
    const code = path.resolve(codeHome());
    console.log(platform() === 'darwin' ? plistText(code) : unitText(code));
  } else if (a.includes('--wipe')) {
    wipe({ yes: a.includes('--yes') }).then(r => process.exit(r.ok ? 0 : 1));
  } else if (a.includes('--remove') || a.includes('--stop') || a.includes('--uninstall')) {
    process.exit(remove().ok ? 0 : 1);
  } else {
    const r = install();
    const away = path.resolve(__dirname) !== path.resolve(codeHome());
    if (r.ok) console.log(`\nWatch it any time with:  ${away ? 'cd ~/securityai  then  ' : ''}node rtsp-run.js   (Ctrl-C stops watching, not the monitor)`);
    process.exit(r.ok ? 0 : 1);
  }
}
