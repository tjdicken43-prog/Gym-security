// Email ingest — the route that needs NOTHING at the gym.
//
// The NVR emails a snapshot when its own detection fires. This polls that
// mailbox, pulls the JPEG attachments out, and runs them through the same
// counting analysis as every other route.
//
// Why email rather than FTP: FTP needs a raw TCP port open on the
// receiving side, which Render and most managed hosts don't offer. Email
// is entirely outbound from the gym and entirely pollable from anywhere,
// so this works on hosting you already have.
//
// Implemented directly on Node's tls module — no IMAP dependency — so it
// runs on a plain install with nothing extra to add.

const tls = require('tls');

// ---------------------------------------------------------------------
// Minimal IMAP client. Only the handful of commands this needs.
// ---------------------------------------------------------------------
class Imap {
  constructor(opts) {
    this.host = opts.host;
    this.port = opts.port || 993;
    this.user = opts.user;
    this.pass = opts.pass;
    this.sock = null;
    this.buf = '';
    this.tag = 0;
    this.waiters = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = tls.connect({ host: this.host, port: this.port, servername: this.host }, () => {});
      this.sock.setEncoding('binary');
      let greeted = false;
      this.sock.on('data', chunk => {
        this.buf += chunk;
        if (!greeted && /^\* OK/m.test(this.buf)) { greeted = true; this.buf = ''; resolve(); }
        this._drain();
      });
      this.sock.on('error', reject);
      this.sock.setTimeout(30000, () => { this.sock.destroy(); reject(new Error('IMAP timed out')); });
    });
  }

  _drain() {
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i];
      const re = new RegExp('^' + w.tag + ' (OK|NO|BAD)(.*)$', 'm');
      const m = this.buf.match(re);
      if (m) {
        const payload = this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        this.waiters.splice(i, 1);
        if (m[1] === 'OK') w.resolve(payload);
        else w.reject(new Error(`IMAP ${m[1]}:${m[2]}`));
        return this._drain();
      }
    }
  }

  cmd(command) {
    const tag = 'A' + (++this.tag);
    return new Promise((resolve, reject) => {
      this.waiters.push({ tag, resolve, reject });
      this.sock.write(tag + ' ' + command + '\r\n', 'binary');
    });
  }

  async login() { await this.cmd(`LOGIN "${this.user}" "${this.pass.replace(/"/g, '\\"')}"`); }
  async selectInbox(box) { await this.cmd(`SELECT "${box || 'INBOX'}"`); }

  async unseenIds() {
    const r = await this.cmd('SEARCH UNSEEN');
    const line = (r.match(/^\* SEARCH([^\r\n]*)/m) || [, ''])[1];
    return line.trim().split(/\s+/).filter(Boolean);
  }

  // UIDs are stable for the life of a mailbox; sequence numbers shift as
  // mail arrives and is deleted. Tracking progress by UID is the only way
  // to be certain a message is processed exactly once.
  async uidsAbove(lastUid) {
    const r = await this.cmd(`UID SEARCH UID ${(lastUid || 0) + 1}:*`);
    const line = (r.match(/^\* SEARCH([^\r\n]*)/m) || [, ''])[1];
    return line.trim().split(/\s+/).filter(Boolean)
      .map(Number).filter(n => Number.isFinite(n) && n > (lastUid || 0))
      .sort((a, b) => a - b);
  }

  async fetchRawByUid(uid) { return this.cmd(`UID FETCH ${uid} BODY.PEEK[]`); }
  async markSeenByUid(uid) { try { await this.cmd(`UID STORE ${uid} +FLAGS (\\Seen)`); } catch (e) {} }

  async fetchRaw(id) { return this.cmd(`FETCH ${id} BODY.PEEK[]`); }

  // Flags live in the FETCH response, not the message body. Asking for
  // BODY.PEEK[] alone and then searching the text for \Seen finds
  // nothing, which made every message look unread.
  async flags(id) {
    const r = await this.cmd(`FETCH ${id} (FLAGS)`);
    const m = r.match(/FLAGS \(([^)]*)\)/i);
    return m ? m[1].split(/\s+/).filter(Boolean) : [];
  }
  async markSeen(id) { await this.cmd(`STORE ${id} +FLAGS (\\Seen)`); }
  async logout() { try { await this.cmd('LOGOUT'); } catch (e) {} this.sock.end(); }
}

// ---------------------------------------------------------------------
// MIME: pull JPEG attachments out of a raw message
// ---------------------------------------------------------------------
function extractJpegs(raw) {
  const out = [];
  const boundaryMatch = raw.match(/boundary="?([^";\r\n]+)"?/i);
  if (!boundaryMatch) return out;
  const parts = raw.split('--' + boundaryMatch[1]);

  for (const part of parts) {
    const headerEnd = part.search(/\r?\n\r?\n/);
    if (headerEnd === -1) continue;
    const headers = part.slice(0, headerEnd);
    if (!/image\/jpe?g/i.test(headers) && !/\.jpe?g/i.test(headers)) continue;
    if (!/base64/i.test(headers)) continue;

    const body = part.slice(headerEnd).replace(/[^A-Za-z0-9+/=]/g, '');
    try {
      const buf = Buffer.from(body, 'base64');
      // Only keep complete JPEGs — a truncated transfer is worse than nothing.
      if (buf.length > 512 && buf[0] === 0xFF && buf[1] === 0xD8 &&
          buf[buf.length - 2] === 0xFF && buf[buf.length - 1] === 0xD9) {
        out.push(buf);
      }
    } catch (e) { /* unparseable part */ }
  }
  return out;
}

// The NVR usually puts the channel or camera name in the subject line.
function cameraFromMessage(raw) {
  const subj = (raw.match(/^Subject:\s*(.+)$/im) || [, ''])[1].trim();
  // Subjects vary a lot by brand and firmware: "Channel: 1",
  // "Channel No.: 1", "D1", "Camera01", "CH03". Allow punctuation and
  // filler between the word and the number.
  const chan = subj.match(/\b(?:CH|Channel|Camera|Cam|D)(?:\s*No\.?)?[\s.:#-]*0*(\d{1,2})\b/i);
  if (chan) return 'channel' + chan[1];
  const clean = subj.replace(/[^A-Za-z0-9 _-]/g, '').trim();
  return clean ? clean.slice(0, 40) : 'nvr';
}

// ---------------------------------------------------------------------
// Poller
// ---------------------------------------------------------------------
function startEmailIngest(opts, handlers) {
  const intervalMs = Math.max(15000, (opts.pollSeconds || 30) * 1000);
  let busy = false;

  // Progress is remembered on disk as the highest UID already handled.
  // This is deliberately independent of the read/unread flag: opening an
  // alarm email in Gmail marks it read, and a poller that trusted that
  // flag would silently skip the event. It also guarantees a message is
  // never analysed twice, which would mean paying twice for one entry.
  const fs = require('fs');
  const path = require('path');
  const stateFile = path.join(
    process.env.DATA_DIR || __dirname,
    `mail-progress-${String(opts.user || 'default').replace(/[^a-z0-9]/gi, '').slice(0, 40)}.json`
  );

  function loadProgress() {
    try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) || {}; }
    catch (e) { return {}; }
  }
  function saveProgress(p) {
    try { fs.writeFileSync(stateFile, JSON.stringify(p)); }
    catch (e) { console.warn('Could not save mail progress: ' + e.message); }
  }

  async function poll() {
    if (busy) return;
    busy = true;
    const imap = new Imap(opts);
    try {
      await imap.connect();
      await imap.login();
      await imap.selectInbox(opts.mailbox);

      const progress = loadProgress();
      let lastUid = Number(progress.lastUid) || 0;

      // First run on an existing mailbox: start from the newest message
      // rather than analysing months of old alarm mail at once.
      if (!lastUid) {
        const all = await imap.uidsAbove(0);
        lastUid = all.length ? all[all.length - 1] - 1 : 0;
        if (all.length > 1) {
          console.log(`  mailbox has ${all.length} existing message(s); starting from the newest.`);
        }
      }

      const fresh = await imap.uidsAbove(lastUid);
      if (handlers.onPoll) handlers.onPoll(fresh.length);

      for (const uid of fresh.slice(0, opts.maxPerPoll || 20)) {
        const raw = await imap.fetchRawByUid(uid);
        const jpegs = extractJpegs(raw);
        // Advance the watermark whether or not this one had a usable
        // image, so a junk message can't wedge the queue forever.
        lastUid = Math.max(lastUid, uid);
        saveProgress({ lastUid, updated: new Date().toISOString() });
        await imap.markSeenByUid(uid);

        if (!jpegs.length) {
          if (handlers.onSkipped) handlers.onSkipped(uid);
          continue;
        }
        await handlers.onEvent(cameraFromMessage(raw), jpegs.slice(0, 4), {
          durationSec: null, frameCount: jpegs.length, source: 'email', uid,
        });
      }
      await imap.logout();
    } catch (err) {
      if (handlers.onError) handlers.onError(err.message);
      try { imap.sock && imap.sock.destroy(); } catch (e) {}
    } finally {
      busy = false;
    }
  }

  poll();
  const timer = setInterval(poll, intervalMs);
  if (timer.unref) timer.unref();
  if (handlers.onReady) handlers.onReady({ transport: 'email', host: opts.host, user: opts.user, everySec: intervalMs / 1000 });
  return { stop() { clearInterval(timer); }, pollNow: poll, progressFile: stateFile };
}

// Connects once and reports what's actually in the mailbox, without
// consuming or marking anything. For working out why nothing is arriving.
async function diagnose(opts) {
  const out = { connected: false, loggedIn: false, mailbox: opts.mailbox || 'INBOX',
                unread: 0, totalMessages: 0, recentSubjects: [], jpegsInNewest: 0, error: null };
  const imap = new Imap(opts);
  try {
    await imap.connect();      out.connected = true;
    await imap.login();        out.loggedIn = true;
    await imap.selectInbox(opts.mailbox);

    const unseen = await imap.unseenIds();
    out.unread = unseen.length;

    // What actually governs processing is the UID watermark, not the read
    // flag — report that so the dashboard tells the truth.
    try {
      const fs = require('fs'), path = require('path');
      const f = path.join(process.env.DATA_DIR || __dirname,
        `mail-progress-${String(opts.user || 'default').replace(/[^a-z0-9]/gi, '').slice(0, 40)}.json`);
      out.lastProcessedUid = fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')).lastUid || 0) : 0;
      out.awaitingAnalysis = (await imap.uidsAbove(out.lastProcessedUid)).length;
    } catch (e) { out.lastProcessedUid = null; }

    const all = await imap.cmd('SEARCH ALL');
    const allIds = ((all.match(/^\* SEARCH([^\r\n]*)/m) || [, ''])[1]).trim().split(/\s+/).filter(Boolean);
    out.totalMessages = allIds.length;

    for (const id of allIds.slice(-3).reverse()) {
      const raw = await imap.fetchRaw(id);
      const subj = (raw.match(/^Subject:\s*(.+)$/im) || [, '(no subject)'])[1].trim().slice(0, 70);
      const jpegs = extractJpegs(raw).length;
      out.recentSubjects.push({ id, subject: subj, attachments: jpegs });
      if (!out.jpegsInNewest) out.jpegsInNewest = jpegs;
    }
    await imap.logout();
  } catch (err) {
    out.error = err.message;
    try { imap.sock && imap.sock.destroy(); } catch (e) {}
  }
  return out;
}

// Reprocesses the newest messages regardless of the watermark. The poller
// only ever moves forward, so this is the way to re-run something that has
// already been handled — for testing, or to catch up after a config fix.
async function processLatest(opts, handlers, count) {
  const imap = new Imap(opts);
  const done = [];
  try {
    await imap.connect();
    await imap.login();
    await imap.selectInbox(opts.mailbox);
    const all = await imap.cmd('SEARCH ALL');
    const ids = ((all.match(/^\* SEARCH([^\r\n]*)/m) || [, ''])[1]).trim().split(/\s+/).filter(Boolean);
    for (const id of ids.slice(-(count || 1))) {
      const raw = await imap.fetchRaw(id);
      const jpegs = extractJpegs(raw);
      if (!jpegs.length) { done.push({ id, frames: 0, skipped: 'no image' }); continue; }
      // manual: true tells the handler to bypass the schedule and cap,
      // and to report back whether the event actually landed.
      const outcome = await handlers.onEvent(cameraFromMessage(raw), jpegs.slice(0, 4), {
        durationSec: null, frameCount: jpegs.length, source: 'email-manual', manual: true,
      });
      done.push({ id, frames: jpegs.length, result: outcome || 'analysed' });
    }
    await imap.logout();
  } catch (err) {
    try { imap.sock && imap.sock.destroy(); } catch (e) {}
    throw err;
  }
  return done;
}

module.exports = { startEmailIngest, extractJpegs, cameraFromMessage, diagnose, processLatest, Imap };
