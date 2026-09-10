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

  async fetchRaw(id) { return this.cmd(`FETCH ${id} BODY.PEEK[]`); }
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
  const chan = subj.match(/\b(?:CH|Channel|Camera|D)\s*0*(\d{1,2})\b/i);
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

  async function poll() {
    if (busy) return;
    busy = true;
    const imap = new Imap(opts);
    try {
      await imap.connect();
      await imap.login();
      await imap.selectInbox(opts.mailbox);
      const ids = await imap.unseenIds();
      if (ids.length && handlers.onPoll) handlers.onPoll(ids.length);

      for (const id of ids.slice(0, opts.maxPerPoll || 20)) {
        const raw = await imap.fetchRaw(id);
        const jpegs = extractJpegs(raw);
        await imap.markSeen(id);          // mark read either way, or we loop on it forever
        if (!jpegs.length) {
          if (handlers.onSkipped) handlers.onSkipped(id);
          continue;
        }
        handlers.onEvent(cameraFromMessage(raw), jpegs.slice(0, 4), {
          durationSec: null, frameCount: jpegs.length, source: 'email',
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
  return { stop() { clearInterval(timer); }, pollNow: poll };
}

module.exports = { startEmailIngest, extractJpegs, cameraFromMessage, Imap };
