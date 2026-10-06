// Talks to the website (REMOTE mode): heartbeats + crossing bursts.
//
// Contract (see .agent-brief.md):
//   POST /monitor/runner/heartbeat   every 30 s
//   POST /monitor/runner/burst       one per analysed crossing
//   Authorization: Bearer <runnerToken>
//   401 = wrong token, 503 = RUNNER_TOKEN not set on the server.
//
// Render's free tier sleeps; waking it takes up to ~50 s, so requests
// get a 70 s timeout (crossings 150 s: the website may wait up to ~130 s
// for the counting service, with one retry) and crossings wait in a small
// on-disk queue until the site answers. The queue is capped so it can never fill the disk.
// Node built-ins only.

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const TIMEOUT_MS = Number(process.env.RUNNER_HTTP_TIMEOUT_MS) || 70000;
const BURST_TIMEOUT_MS = Number(process.env.RUNNER_BURST_TIMEOUT_MS) || 150000;
const QUEUE_MAX = 200;                 // crossings kept while offline
const QUEUE_MAX_AGE_MS = 24 * 3600e3;  // older than a day is no use to anyone
// The website said "this gym is not set up here" (403 fatal): nothing on
// this computer can fix that, so ask again only every 10 minutes.
const FATAL_RETRY_MS = Number(process.env.RUNNER_FATAL_RETRY_MS) || 10 * 60 * 1000;

// The website's own words, minus advice that is wrong for the person at the
// camera computer (older websites said "make gymCode ... match", which would
// file one gym's crossings under another gym).
function serverSaid(r) {
  let e = r && r.json && r.json.error ? String(r.json.error) : '';
  if (/make gymCode|gymCode in rtsp-zones/i.test(e)) e = e.replace(/\s*Do this:.*$/i, '') + ' Tell Joseph at SecurityAI.';
  return e.trim();
}

function postJson(baseUrl, route, token, body, timeoutMs) {
  return request('POST', baseUrl, route, token, body, timeoutMs);
}
function getJson(baseUrl, route, token, timeoutMs) {
  return request('GET', baseUrl, route, token, undefined, timeoutMs);
}

// One HTTP(S) call. Never rejects: { status, json, text, body(Buffer) } or
// { status: 0, netError }. token may be null (no Authorization header).
function request(method, baseUrl, route, token, body, timeoutMs) {
  return new Promise(resolve => {
    let url;
    try { url = new URL(route, baseUrl); } catch (e) { return resolve({ status: 0, netError: 'bad serverUrl' }); }
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const lib = url.protocol === 'https:' ? https : http;
    const headers = { 'User-Agent': 'securityai-runner/2' };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (token) headers.Authorization = `Bearer ${token}`;
    let req;
    try { req = lib.request(url, { method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const text = buf.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
        resolve({ status: res.statusCode, json, text: text.slice(0, 300), body: buf, retryAfter: res.headers['retry-after'] });
      });
      res.on('error', err => resolve({ status: 0, netError: err.code || err.message }));
    }); } catch (e) { return resolve({ status: 0, netError: e.code || e.message }); }
    const limit = timeoutMs || TIMEOUT_MS;
    req.setTimeout(limit, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', err => resolve({ status: 0, netError: err.code || err.message, timeoutMs: limit }));
    req.end(data || undefined);
  });
}

// Plain-English reading of a failed response. `retry` = keep it queued.
function explainFailure(r) {
  if (r.status === 401) return { retry: true, key: '401', msg: 'The website does not recognise this computer (401) — it was unpaired on the admin page, or ADMIN_TOKEN was changed on Render. Do this: on your phone open the admin page > "Connect a camera computer" > Get a code; then in a NEW Terminal window type  cd ~/securityai  and  node pair.js' };
  if (r.status === 503 && r.json && /RUNNER_TOKEN|ADMIN_TOKEN/i.test(r.json.error || '')) return { retry: true, key: '503-token', msg: 'The website cannot accept camera computers: ADMIN_TOKEN is not set on Render (503). Do this: put ADMIN_TOKEN back in Render > Environment. The same value as before: nothing else to do. A new value: pair this computer again (node pair.js). Crossings are kept here meanwhile.' };
  if (r.status === 404) return { retry: true, key: '404', msg: 'The website does not have the runner page yet (404) — it may still be deploying, or "serverUrl" is wrong.' };
  if (r.status === 429) {
    const wait = Number((r.json && r.json.retryAfterSec) || r.retryAfter) || 30;
    return { retry: true, key: '429', waitMs: wait * 1000, msg: `The website asked us to slow down — will send again in ${wait} s.` };
  }
  if (r.status === 403 && r.json && r.json.fatal) {
    return { retry: true, fatal: true, key: '403-fatal', waitMs: FATAL_RETRY_MS,
      msg: `The website refused this computer: ${serverSaid(r) || 'not allowed (403)'}\n   Tell Joseph at SecurityAI. Crossings are kept on this computer and sent once that is fixed (it checks again every ${FATAL_RETRY_MS >= 60000 ? `${Math.round(FATAL_RETRY_MS / 60000)} minutes` : `${Math.round(FATAL_RETRY_MS / 1000)} seconds`}).` };
  }
  if (r.status === 403) return { retry: true, key: '403', msg: `The website refused this computer (403): ${serverSaid(r) || 'not allowed'}` };
  if (r.status === 409) return { retry: true, key: '409', msg: `The website cannot take crossings right now: ${serverSaid(r) || 'conflict'}. Will retry.` };
  if (r.status === 200 && r.json && r.json.ok === false) return { retry: false, key: 'refused-200', msg: `The website did not take it: ${serverSaid(r) || 'no reason given'}` };
  if (r.status === 413) return { retry: false, key: '413', msg: 'The website said the photos were too large (413) — this crossing was dropped.' };
  if (r.status >= 400 && r.status < 500) return { retry: false, key: String(r.status), msg: `The website refused this crossing (${r.status}): ${(r.json && r.json.error) || r.text || ''}`.trim() };
  if (r.status >= 500) return { retry: true, key: '5xx', msg: `The website is not answering properly (${r.status}${r.json && r.json.error ? `: ${r.json.error}` : ''}): it may be restarting after an update. Crossings are kept on this computer and sent when it is back.` };
  const code = r.netError || 'unknown';
  if (code === 'TIMEOUT') {
    const ms = r.timeoutMs || TIMEOUT_MS;
    return { retry: true, key: 'timeout', msg: `The website did not answer within ${Math.round(ms / 1000)} s (${ms > TIMEOUT_MS ? 'it may still be counting a crossing' : 'it may be waking up'}). Will retry.` };
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return { retry: true, key: 'dns', msg: 'Cannot find the website — is this laptop on the internet? Will retry.' };
  if (/ECONNREFUSED/.test(code)) return { retry: true, key: 'refused', msg: 'The website refused the connection. Will retry.' };
  if (/CERT|SSL|TLS/i.test(code)) return { retry: true, key: 'tls', msg: `Secure connection to the website failed (${code}). Check the laptop's date and time are right.` };
  return { retry: true, key: 'net', msg: `Cannot reach the website (${code}). Will retry.` };
}

// ---------- queue ----------

function createQueue(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { /* fall back to memory */ }
  let disk = true;
  try { fs.accessSync(dir, fs.constants.W_OK); } catch (e) { disk = false; }
  const mem = [];   // { id, file?, item }

  if (disk) {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
      const p = path.join(dir, f);
      try { mem.push({ id: f, file: p, item: JSON.parse(fs.readFileSync(p, 'utf8')) }); }
      catch (e) { try { fs.unlinkSync(p); } catch (e2) { /* ignore */ } }
    }
  }
  let seq = 0;
  const q = {
    get length() { return mem.length; },
    get onDisk() { return disk; },
    peek() { return mem[0]; },
    push(item) {
      const id = `${Date.now()}-${String(seq++).padStart(4, '0')}.json`;
      const rec = { id, item };
      if (disk) {
        const p = path.join(dir, id);
        try { fs.writeFileSync(p, JSON.stringify(item)); rec.file = p; } catch (e) { /* memory only */ }
      }
      mem.push(rec);
      const dropped = [];
      while (mem.length > QUEUE_MAX) dropped.push(q.remove(mem[0]));
      return dropped;
    },
    remove(rec) {
      const i = mem.indexOf(rec);
      if (i !== -1) mem.splice(i, 1);
      if (rec && rec.file) { try { fs.unlinkSync(rec.file); } catch (e) { /* gone */ } }
      return rec;
    },
    pruneOld() {
      const cutoff = Date.now() - QUEUE_MAX_AGE_MS;
      const old = mem.filter(r => Date.parse(r.item.capturedAt) < cutoff);
      old.forEach(r => q.remove(r));
      return old.length;
    },
  };
  return q;
}

// ---------- client ----------

// opts: { serverUrl, runnerToken, gymCode, queueDir, log(msg), warn(msg),
//         onVerdict(zoneLabel, response, item), onDropped(item, info) }
function createRemote(opts) {
  const log = opts.log || console.log, warn = opts.warn || console.warn;
  const queue = createQueue(opts.queueDir);
  let sending = false, retryTimer = null, retryDelay = 5000;
  let lastProblemKey = null, connected = null;
  // "Refused" (403 fatal) waits: heartbeats and crossings separately, so a
  // website that takes heartbeats but refuses crossings is not reported
  // as "Connected ✓ ... refused ... Connected ✓" over and over.
  let hbRefused = false, hbRefusedUntil = 0, burstRefusedUntil = 0;
  const now = () => Date.now();
  const state = { lastHeartbeatOk: null, lastHeartbeatError: null, sent: 0, failed: 0, refused: null };

  function problem(info, fromBurst) {
    // Say each distinct problem once, not every retry.
    if (info.key !== lastProblemKey) { warn(info.msg); lastProblemKey = info.key; }
    if (info.fatal) {
      state.refused = info.msg;
      if (fromBurst) burstRefusedUntil = now() + (info.waitMs || FATAL_RETRY_MS);
      else { hbRefused = true; hbRefusedUntil = now() + (info.waitMs || FATAL_RETRY_MS); }
    }
    if (!(info.fatal && fromBurst)) connected = false;    // a refused crossing is not a lost connection
  }
  // Only a heartbeat the website ACCEPTED counts as connected.
  function accepted() {
    hbRefused = false; hbRefusedUntil = 0;
    if (burstRefusedUntil <= now()) { state.refused = null; if (lastProblemKey === '403-fatal') lastProblemKey = null; }
    if (connected !== true) {
      log(`Connected to the website ✓  ${opts.serverUrl}/activity.html`);
      if (queue.length && burstRefusedUntil <= now()) log(`Sending ${queue.length} saved crossing(s) now…`);
    }
    connected = true;
    if (lastProblemKey !== '403-fatal') lastProblemKey = null;
  }
  const refusedNow = () => hbRefused || burstRefusedUntil > now();

  async function heartbeat(body) {
    if (hbRefusedUntil > now()) return { ok: false, waiting: true, info: { key: '403-fatal', msg: state.refused } };
    const r = await postJson(opts.serverUrl, '/monitor/runner/heartbeat', opts.runnerToken, body);
    if (r.status === 200 && (!r.json || r.json.ok !== false)) {
      state.lastHeartbeatOk = Date.now(); state.lastHeartbeatError = null;
      accepted();
      retryDelay = 5000;
      if (queue.length && !sending) kick(0);
      return { ok: true, json: r.json };
    }
    const info = explainFailure(r);
    state.lastHeartbeatError = info.msg;
    problem(info);
    return { ok: false, info };
  }

  function enqueue(item) {
    const dropped = queue.push(item);
    if (dropped.length) warn(`Offline too long — dropped the ${dropped.length} oldest saved crossing(s) (keeping the newest ${QUEUE_MAX}).`);
    // While the website is refusing this computer, just keep it: it is
    // sent with the others once a heartbeat is accepted again.
    if (refusedNow()) {
      log(`  Kept on this computer (${queue.length} waiting) — the website is refusing this computer for now.`);
      return;
    }
    // Website not answering and a retry is already planned: wait for it
    // (a busy doorway must not turn the back-off into a request per person).
    if (connected === false && retryTimer && !sending) {
      log(`  Kept on this computer (${queue.length} waiting) — will send when the website answers.`);
      return;
    }
    kick(0);
  }

  function kick(delay) {
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    retryTimer = setTimeout(drain, delay);
  }

  async function drain() {
    retryTimer = null;
    if (sending) return;
    sending = true;
    try {
      queue.pruneOld();
      while (queue.length) {
        // Refused: crossings wait. After a refused heartbeat, the next
        // accepted heartbeat restarts sending; after a refused crossing,
        // try one again when the wait is over.
        if (hbRefused) break;
        if (burstRefusedUntil > now()) { kick(burstRefusedUntil - now() + 50); break; }
        const rec = queue.peek();
        const r = await postJson(opts.serverUrl, '/monitor/runner/burst', opts.runnerToken, rec.item, BURST_TIMEOUT_MS);
        if (r.status === 200 && r.json && r.json.ok !== false) {
          queue.remove(rec);
          state.sent++;
          lastProblemKey = null;
          retryDelay = 5000;
          if (opts.onVerdict) opts.onVerdict(rec.item.zone.label, r.json, rec.item);
          continue;
        }
        const info = r.status === 200
          ? { retry: false, key: 'server-error', msg: `The website could not take a crossing: ${serverSaid(r) || 'unknown error'}` }
          : explainFailure(r);
        if (!info.retry) {
          // Refused for a reason about THIS crossing — the connection is fine.
          queue.remove(rec);
          state.failed++;
          warn(`${rec.item.zone.label}: ${info.msg}`);
          if (opts.onDropped) { try { opts.onDropped(rec.item, info); } catch (e) { /* display only */ } }
          continue;
        }
        problem(info, true);
        if (info.fatal) { kick((info.waitMs || FATAL_RETRY_MS) + 50); break; }   // one try again after the wait
        const delay = info.waitMs || retryDelay;
        log(`  ${queue.length} crossing(s) saved on this laptop — will send when the website answers (next try in ${Math.round(delay / 1000)} s).`);
        kick(delay);
        if (!info.waitMs) retryDelay = Math.min(120000, retryDelay * 2);
        break;
      }
    } finally { sending = false; }
  }

  if (queue.length) {
    log(`${queue.length} crossing(s) were saved from last time — sending them once the website answers.`);
  }

  return {
    heartbeat, enqueue, state,
    get queued() { return queue.length; },
    get connected() { return connected; },
    get refused() { return refusedNow() ? state.refused : null; },
    stop() { if (retryTimer) clearTimeout(retryTimer); },
  };
}

module.exports = { createRemote, postJson, getJson, request, explainFailure, serverSaid, createQueue, QUEUE_MAX, FATAL_RETRY_MS, TIMEOUT_MS, BURST_TIMEOUT_MS };
