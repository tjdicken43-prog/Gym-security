// Connecting a camera computer to the website WITHOUT typing a long token.
//
// On the phone: admin page > "Connect a camera computer" > Get a code
// (6 numbers, lasts 15 minutes, works once). On the computer: type the
// website address and those 6 numbers; the website sends back this gym's
// runner token and gym code, which are saved in ~/.securityai/rtsp-zones.json.
//
// Used by pair.js, setup-camera.js and update.js. Node built-ins only.

const os = require('os');
const readline = require('readline');
const { request } = require('./runner-remote');

// Typo-tolerant website address. Accepts "gym-security.onrender.com",
// "https://gym-security.onrender.com/admin.html", "htps//Gym-Security"...
// A bare name with no dot gets ".onrender.com" added.
function normaliseSite(input) {
  let s = String(input || '').trim().replace(/[“”‘’"'<>]/g, '').replace(/\s+/g, '');
  if (!s) return { error: 'Type the website address, e.g. gym-security.onrender.com' };
  const plainHttp = /^http:\/\//i.test(s);
  // Drop whatever scheme was typed, typos included: https:// htps:// https// //
  const m = s.match(/^([a-z]{2,6})?[:;]*\/\//i);
  if (m) s = s.slice(m[0].length);
  let u;
  try { u = new URL('https://' + s); } catch (e) { return { error: 'That is not a website address. Type it like gym-security.onrender.com' }; }
  let host = u.hostname.toLowerCase().replace(/\.+$/, '');
  if (!host) return { error: 'That is not a website address. Type it like gym-security.onrender.com' };
  const local = /^(localhost|127\.|10\.|192\.168\.)/.test(host);
  if (!host.includes('.') && !local) host += '.onrender.com';
  if (/\.onrender\.co$/.test(host)) host += 'm';                  // common slip
  const proto = local && plainHttp ? 'http:' : 'https:';
  return { url: `${proto}//${host}${u.port ? ':' + u.port : ''}`, guessed: host !== u.hostname.toLowerCase() };
}

// Plain-English reading of "cannot talk to the website".
function explainNet(r, site) {
  const code = r.netError || '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `Cannot find ${site}. Check the spelling, and that this computer is on the internet (Wi-Fi on).`;
  if (code === 'TIMEOUT') return `${site} did not answer within a minute. Check this computer is on the internet, then try again.`;
  if (/CERT|SSL|TLS/i.test(code)) return `The secure connection to ${site} failed (${code}). Check this computer's date and time are right.`;
  if (/ECONNREFUSED/.test(code)) return `${site} refused the connection.`;
  if (r.status === 404) return `${site} answered, but it is not the SecurityAI website (or its latest version is still deploying).`;
  return `Could not reach ${site} (${code || r.status}).`;
}

// Is this really our website (and awake)? Waits up to ~70 s for a Render wake-up.
async function checkSite(site, say) {
  if (say) say('  Contacting the website (up to a minute if it is asleep)...');
  const r = await request('GET', site, '/monitor/requires-code', null, undefined, 75000);
  if (r.status === 200 && r.json && typeof r.json.required === 'boolean') return { ok: true };
  return { ok: false, msg: explainNet(r, site) };
}

// Swap a 6-digit code for this gym's runner token.
async function exchangeCode(site, code, host) {
  const digits = String(code || '').replace(/\D/g, '');
  if (digits.length !== 6) return { ok: false, retry: true, msg: 'A pairing code is 6 numbers, like 482 193.' };
  const r = await request('POST', site, '/monitor/runner/pair', null, { code: digits, host: host || os.hostname() }, 75000);
  if (r.status === 200 && r.json && r.json.ok && r.json.runnerToken) {
    return { ok: true, runnerToken: r.json.runnerToken, gymCode: r.json.gymCode, gymName: r.json.gymName || null };
  }
  if (r.status === 0 || (r.status === 404 && !r.json)) return { ok: false, retry: false, msg: explainNet(r, site) };
  const msg = (r.json && r.json.error) || `The website said ${r.status}.`;
  return { ok: false, retry: r.status === 401 || r.status === 400, stop: r.status === 429 || r.status === 503, msg };
}

// Does the website accept this token? (No side effects: just lists files.)
async function checkToken(site, token) {
  const r = await request('GET', site, '/monitor/runner/files', token, undefined, 75000);
  if (r.status === 200) return { ok: true };
  if (r.status === 401 || r.status === 503) return { ok: false, auth: true, msg: 'The website does not recognise this computer any more.' };
  if (r.status === 404 && r.json) return { ok: false, msg: 'The website is an older version (no pairing yet) — deploy the latest code first.' };
  return { ok: false, msg: r.status ? `The website said ${r.status}.` : explainNet(r, site) };
}

// A small prompt for scripts that don't bring their own. Works with a
// keyboard and with piped answers (tests).
let queue = null, waiters = [], ended = false;
function simpleAsk(question, def) {
  const prompt = `${question}${def ? ` [${def}]` : ''}: `;
  if (process.stdin.isTTY) {
    return new Promise(resolve => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.on('SIGINT', () => { console.log('\nStopped.'); process.exit(130); });
      rl.question(prompt, a => { rl.close(); resolve(a.trim() || def || ''); });
    });
  }
  process.stdout.write(prompt);
  if (!queue) {
    queue = [];
    const rl = readline.createInterface({ input: process.stdin, terminal: false });
    rl.on('line', l => { if (waiters.length) waiters.shift()(l); else queue.push(l); });
    rl.on('close', () => { ended = true; while (waiters.length) waiters.shift()(null); });
  }
  const got = queue.length ? Promise.resolve(queue.shift()) : ended ? Promise.resolve(null) : new Promise(r => waiters.push(r));
  return got.then(a => { process.stdout.write('\n'); return (a == null ? '' : a.trim()) || def || ''; });
}

// The interactive part: website address, then the 6-digit code.
// opts: { ask(q, def) -> Promise<string>, say(msg), site (default), code (given), siteGiven }
// Returns { serverUrl, runnerToken, gymCode, gymName } or null (skipped / failed).
async function pairInteractive(opts) {
  const ask = opts.ask || simpleAsk;
  const say = opts.say || console.log;
  let site = null;
  for (let tries = 0; tries < 4 && !site; tries++) {
    const raw = tries === 0 && opts.siteGiven ? opts.siteGiven : await ask('  Website address (e.g. gym-security.onrender.com)', opts.site || '');
    if (!raw) { if (opts.allowSkip) return null; continue; }
    const n = normaliseSite(raw);
    if (n.error) { say('  ' + n.error); continue; }
    if (n.guessed) say(`  Using ${n.url}`);
    const c = await checkSite(n.url, say);
    if (!c.ok) { say('  ' + c.msg); if (opts.siteGiven && tries === 0 && opts.noRetry) return null; continue; }
    say(`  Found the website: ${n.url} ✓`);
    site = n.url;
  }
  if (!site) { say('  Could not reach the website, so this computer is not connected yet. You can do it later with:  node pair.js'); return null; }

  say('  On your phone: open the admin page > "Connect a camera computer" > Get a code.');
  for (let tries = 0; tries < 4; tries++) {
    const code = tries === 0 && opts.code ? String(opts.code) : await ask('  Pairing code (6 numbers from the admin page)', '');
    if (!code) { if (opts.allowSkip) return null; continue; }
    say('  Checking the code...');
    const r = await exchangeCode(site, code);
    if (r.ok) {
      say(`  Paired ✓  This computer now sends to ${site} for ${r.gymName ? `"${r.gymName}" (gym code ${r.gymCode})` : `gym code "${r.gymCode}"`}.`);
      return { serverUrl: site, runnerToken: r.runnerToken, gymCode: r.gymCode, gymName: r.gymName };
    }
    say('  ' + r.msg);
    if (r.stop || !r.retry || (opts.code && opts.noRetry)) break;
  }
  say('  Not paired. Get a fresh code on the admin page and run:  node pair.js');
  return null;
}

module.exports = { normaliseSite, checkSite, exchangeCode, checkToken, pairInteractive, simpleAsk, explainNet };
