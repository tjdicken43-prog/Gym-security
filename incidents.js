// What went wrong on the website, grouped by cause. Each failure gets a
// fingerprint (the error with numbers, ids and times taken out, plus the
// first line of our own code it came from), so "the same thing again" is
// counted instead of piling up. Kept in DATA_DIR/incidents.json (private).
//
// Nothing here contains photos or member numbers: only the error text and
// where in the code it happened. Emails, tokens and long numbers are
// scrubbed before anything is stored.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX = 200;
const CODE_DIR = __dirname;

function scrub(s) {
  return String(s == null ? '' : s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(sk-ant-[A-Za-z0-9_-]+|Bearer\s+\S+|[A-Za-z0-9_-]{32,})\b/g, '<secret>')
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '<number>')
    .slice(0, 2000);
}
// Our own code's frames only: "server.js:812:14 in handler".
function appFrames(stack) {
  const out = [];
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = /\(?([^()\s]+\.js):(\d+):(\d+)\)?/.exec(line);
    if (!m) continue;
    const file = m[1];
    if (/node_modules|node:internal|^internal\//.test(file)) continue;
    const abs = path.resolve(file);
    if (path.dirname(abs) !== CODE_DIR) continue;            // only files of this program
    const fn = (/at\s+(?:async\s+)?([^\s(]+)\s+\(/.exec(line) || [])[1] || null;
    out.push({ file: path.basename(abs), line: Number(m[2]), col: Number(m[3]), fn });
  }
  return out;
}
function normalize(msg) {
  return scrub(msg).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>').replace(/\b[0-9a-f]{8,}\b/gi, '<id>').replace(/\d+/g, 'N').slice(0, 200);
}

function create({ dataDir, log }) {
  const file = path.join(dataDir, 'incidents.json');
  const say = log || (() => {});
  let cache = null;
  const listeners = [];
  function load() {
    if (cache) return cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { cache = []; }
    if (!Array.isArray(cache)) cache = [];
    return cache;
  }
  function saveNow() {
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(load().slice(0, MAX)));
      fs.renameSync(tmp, file);
    } catch (e) { /* best effort */ }
  }

  // area: where it happened ('route', 'crash', 'morning', 'ai', ...).
  // Returns the incident (with .count).
  function record(area, err, ctx) {
    try {
      const e = err instanceof Error ? err : new Error(String(err && err.message || err));
      const frames = appFrames(e.stack);
      const top = frames[0] || null;
      const fp = crypto.createHash('sha256').update(`${area}|${e.name}|${normalize(e.message)}|${top ? top.file + ':' + (top.fn || top.line) : ''}`).digest('hex').slice(0, 16);
      const list = load();
      let inc = list.find(x => x.fp === fp);
      const now = new Date().toISOString();
      if (!inc) {
        inc = { fp, area, name: e.name, message: scrub(e.message), frames: frames.slice(0, 6), firstAt: now, lastAt: now, count: 0, times: [], context: ctx ? scrub(JSON.stringify(ctx)).slice(0, 300) : null, status: 'open' };
        list.unshift(inc);
      }
      inc.count++;
      inc.lastAt = now;
      inc.times = inc.times.concat([now]).slice(-20);
      if (inc.status === 'fixed') inc.status = 'back';          // came back after a fix
      list.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
      saveNow();
      for (const f of listeners) { try { f(inc); } catch (x) { /* never throw from here */ } }
      return inc;
    } catch (x) { say('could not record a failure: ' + x.message); return null; }
  }
  // How many times in the last ms.
  const recent = (inc, ms) => (inc.times || []).filter(t => Date.now() - Date.parse(t) < ms).length;
  function update(fp, patch) { const inc = load().find(x => x.fp === fp); if (inc) { Object.assign(inc, patch); saveNow(); } return inc; }
  return { record, list: () => load().slice(), get: fp => load().find(x => x.fp === fp) || null, update, recent, onIncident: f => listeners.push(f), saveNow };
}

module.exports = { create, scrub, appFrames, normalize };
