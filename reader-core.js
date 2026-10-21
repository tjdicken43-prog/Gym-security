// The front-desk reader's core, in Node: the same job as the Windows reader
// (securityai-reader.txt), for readers that run on our own box (the screen
// reader on a Raspberry Pi or the camera laptop).
//
//  - Trust: only devices whose approval was signed by the owner key pinned
//    at setup get member numbers (checked here, not taken from the website).
//  - Each scan's member number is scrambled HERE (AES-256-CBC + HMAC, key
//    wrapped per approved device with RSA-OAEP-SHA256). The website can't
//    read it. Formats: see member-keys.js.
//  - The same member's code again (10 min - 4 h later) is sent as "repeat,
//    N minutes after scan X", from a keyed tag: no member numbers on disk.
//  - Scans wait in a small queue file if the website can't be reached.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const mk = require('./member-keys');

const REPEAT_MIN_SEC = Number(process.env.SECURITYAI_TEST_FAST ? 1 : 600);   // Ashbourne's lockout
const REPEAT_MAX_MIN = 240;

function readJson(f, d) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } }
function writePrivate(f, obj) {
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, f);
}

// The key that signed an approval: the pinned owner's, or a backup
// approver's that the pinned owner signed in (and hasn't removed).
function signerOf(pin, by, delegates, undelegated) {
  if (!pin || !by) return pin ? pin.sign : null;
  if (by === pin.fp) return pin.sign;
  if ((undelegated || []).includes(by)) return null;
  const d = (delegates || []).find(x => x && x.fp === by);
  if (!d || !d.sign || mk.fingerprint(d.sign) !== d.fp) return null;
  if (!mk.verifySig(pin.sign, mk.delegatePayload(d.fp, d.at), d.sig)) return null;
  return d.sign;
}

class ReaderCore {
  // dir: private folder; name: file prefix; version: shown on the admin page
  constructor({ dir, name, version, log }) {
    this.dir = dir; this.version = version; this.log = log || (() => {});
    this.cfgFile = path.join(dir, `${name}.json`);
    this.queueFile = path.join(dir, `${name}-queue.json`);
    this.seenFile = path.join(dir, `${name}-seen.json`);
    this.cfg = readJson(this.cfgFile, null);
    this.trusted = []; this.trustChecked = false; this.trustProblem = null; this.unpaired = false;
    // The devices checked last time (owner-signed when they were saved), so
    // scans made while the website can't be reached are still readable.
    // Each one's owner signature is checked again here, against the owner key
    // pinned at setup (so editing this file can't add a device).
    const revokedNow = new Set((this.cfg && this.cfg.revoked) || []);
    for (const d of (this.cfg && this.cfg.trustCache) || []) {
      try {
        const fp = mk.fingerprint({ n: d.n, e: d.e });
        if (revokedNow.has(fp) || !this.cfg.owner) continue;
        // Approved by the owner, or by a backup approver the owner signed in.
        const signer = d.by ? signerOf(this.cfg.owner, d.by, d.dg ? [d.dg] : [], this.cfg.undelegated || []) : this.cfg.owner.sign;
        if (!signer || !mk.verifySig(signer, mk.approvePayload(this.cfg.gym ? String(this.cfg.gym).toLowerCase() : d.gym, fp, d.at), d.sig)) continue;
        this.trusted.push({ id: d.id, n: d.n, e: d.e, at: d.at, sig: d.sig, gym: d.gym, by: d.by, dg: d.dg, key: crypto.createPublicKey({ key: { kty: 'RSA', n: d.n, e: d.e }, format: 'jwk' }) });
      } catch (e) { /* skip */ }
    }
    this.counts = { scans: 0, otherZone: 0, doubles: 0 };
  }
  save() { writePrivate(this.cfgFile, this.cfg); }

  async api(method, p, body) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch(this.cfg.site + p, {
        method, signal: ctl.signal,
        headers: Object.assign({ Authorization: 'Bearer ' + this.cfg.token, 'X-Runner-Time': new Date().toISOString(), 'X-Reader-Host': os.hostname(), 'X-Reader-Version': this.version },
          body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let j = null; try { j = await r.json(); } catch (e) { /* not json */ }
      if (!r.ok) { const e = new Error(`${r.status}: ${(j && j.error) || 'refused'}`); e.status = r.status; throw e; }
      return j;
    } finally { clearTimeout(t); }
  }

  async refreshTrust() {
    let t;
    try { t = await this.api('GET', '/reader/trust'); this.unpaired = false; }
    catch (e) { if (e.status === 401) this.unpaired = true; throw e; }
    this.trustChecked = true;
    const pin = this.cfg.owner;
    if (!t.owner || t.owner.fp !== pin.fp) {
      this.trustProblem = 'The owner device on the website is not the one this reader was set up with. Member numbers are only scrambled for devices approved before. Set the reader up again to change it.';
      this.log('owner key mismatch - keeping the last trusted devices');
      return;
    }
    // Approvals are checked against the gym this reader was set up for,
    // never a gym name the website sends (a device approved for another gym
    // must not get this gym's member numbers).
    if (!this.cfg.gym) { this.cfg.gym = String(t.gym || ''); this.save(); }
    const gym = String(this.cfg.gym).toLowerCase();
    if (!t.gym || String(t.gym).toLowerCase() !== gym) {
      this.trustProblem = 'The website answered for a different gym than this reader was set up for. Member numbers are only scrambled for devices approved before. Set the reader up again if the gym changed.';
      this.log('gym mismatch in trust answer - keeping the last trusted devices');
      return;
    }
    this.trustProblem = null;
    // Backup approvers the owner removed (signed by the owner): never again.
    const undel = new Set(this.cfg.undelegated || []);
    let changedU = false;
    for (const u of t.undelegated || []) if (u && u.fp && !undel.has(u.fp) && mk.verifySig(pin.sign, mk.undelegatePayload(u.fp, u.at), u.sig)) { undel.add(u.fp); changedU = true; }
    if (changedU) { this.cfg.undelegated = [...undel]; this.save(); }
    const dels = t.delegates || [];
    const revoked = new Set(this.cfg.revoked || []);
    let changed = false;
    for (const r of t.revoked || []) {
      const signer = r && r.by ? signerOf(pin, r.by, dels, [...undel]) : pin.sign;
      if (r && r.fp && !revoked.has(r.fp) && signer && mk.verifySig(signer, mk.revokePayload(gym, r.fp, r.at), r.sig)) { revoked.add(r.fp); changed = true; }
    }
    if (changed) { this.cfg.revoked = [...revoked]; this.save(); }
    const list = [];
    for (const d of t.devices || []) {
      if (!d || !d.pub || !d.approval) continue;
      const fp = mk.fingerprint(d.pub);
      if (revoked.has(fp)) continue;
      const by = d.approval.by || null;
      const signer = by ? signerOf(pin, by, dels, [...undel]) : pin.sign;
      if (!signer || !mk.verifySig(signer, mk.approvePayload(gym, fp, d.approval.at), d.approval.sig)) { this.log('ignored a device without a valid owner signature: ' + mk.codeOf(fp)); continue; }
      const dg = by ? dels.find(x => x.fp === by) : null;
      try { list.push({ id: d.id, n: d.pub.n, e: d.pub.e, at: d.approval.at, sig: d.approval.sig, gym, by, dg: dg ? { fp: dg.fp, sign: dg.sign, at: dg.at, sig: dg.sig } : null, key: crypto.createPublicKey({ key: { kty: 'RSA', n: d.pub.n, e: d.pub.e }, format: 'jwk' }) }); } catch (e) { /* bad key */ }
    }
    this.trusted = list;
    const cache = list.map(x => Object.assign({ id: x.id, n: x.n, e: x.e, at: x.at, sig: x.sig, gym: x.gym }, x.by ? { by: x.by, dg: x.dg } : {}));
    if (JSON.stringify(cache) !== JSON.stringify(this.cfg.trustCache || [])) { this.cfg.trustCache = cache; this.save(); }
  }

  protect(member, zone, whenMs) {
    const k = crypto.randomBytes(64);
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', k.subarray(0, 32), iv);
    const ct = Buffer.concat([c.update(JSON.stringify({ m: String(member) }), 'utf8'), c.final()]);
    const mac = crypto.createHmac('sha256', k.subarray(32, 64)).update(Buffer.concat([iv, ct])).digest();
    const keys = {};
    for (const d of this.trusted) keys[d.id] = crypto.publicEncrypt({ key: d.key, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, k).toString('base64url');
    k.fill(0);
    return { t: new Date(whenMs).toISOString(), zone, iv: iv.toString('base64url'), ct: ct.toString('base64url'), mac: mac.toString('base64url'), keys };
  }
  tag(member) { return crypto.createHmac('sha256', Buffer.from(this.cfg.salt, 'base64url')).update(String(member)).digest('hex').slice(0, 24); }

  // A new scan: scramble, mark repeats, queue. Never logs the number.
  noteScan(member, zone, whenMs, opts) {
    this.counts.scans++;
    const p = this.protect(member, zone, whenMs);
    if (opts && opts.uncertain) p.uncertain = true;      // two readings disagreed: the gym page says "likely", not "certain"
    const seen = readJson(this.seenFile, {});
    const tg = this.tag(member);
    if (seen[tg]) {
      const mins = (whenMs - seen[tg].t) / 60000;
      if (mins * 60 >= REPEAT_MIN_SEC && mins <= REPEAT_MAX_MIN) p.repeat = { mins: Math.max(1, Math.round(mins)), prev: seen[tg].id };
    }
    seen[tg] = { t: whenMs, id: crypto.createHash('sha256').update(p.mac).digest('hex').slice(0, 16) };
    for (const [k, v] of Object.entries(seen)) if (whenMs - v.t > REPEAT_MAX_MIN * 60000) delete seen[k];
    writePrivate(this.seenFile, seen);
    const q = this.queue(); q.push(p); writePrivate(this.queueFile, q.slice(-2000));
    this.log(`scan noted at ${new Date(whenMs).toLocaleTimeString()} (${this.trusted.length} device(s))`);
  }
  queue() { const q = readJson(this.queueFile, []); return Array.isArray(q) ? q : []; }
  // Send waiting scans. Only the ones sent are taken off the queue: a scan
  // noted while this was sending stays (it's re-read afterwards).
  async flush(problem) {
    if (this.flushing) return 0;
    const q = this.queue();
    if (!q.length) return 0;
    this.flushing = true;
    try {
      const batch = q.slice(0, 100);
      await this.api('POST', '/reader/scans', { scans: batch, host: os.hostname(), version: this.version, problem: problem || null });
      const sent = new Set(batch.map(x => x.mac));
      writePrivate(this.queueFile, this.queue().filter(x => !sent.has(x.mac)));
      this.log(`sent ${batch.length} scan(s)`);
      return batch.length;
    } finally { this.flushing = false; }
  }
  // Problems every reader shares (the screen reader adds its own first).
  baseHealth() {
    const q = this.queue();
    if (this.unpaired) return { code: 'unpaired', text: 'This reader was unpaired on the website.' };
    if (q.length) {
      const oldest = Date.parse(q[0].t);
      if (q.length >= 20 || (oldest && Date.now() - oldest >= 10 * 60e3)) return { code: 'offline', text: `${q.length} scan(s) are waiting on this computer: it cannot reach the website.` };
    }
    if (this.trustProblem) return { code: 'owner-mismatch', text: this.trustProblem };
    if (this.trustChecked && !this.trusted.length) return { code: 'no-devices', text: 'No approved devices yet, so member numbers are not kept.' };
    return null;
  }
  async status(h) {
    await this.api('POST', '/reader/status', { host: os.hostname(), version: this.version, problem: h ? h.text : null, problemCode: h ? h.code : null, watching: true, counts: this.counts, queued: this.queue().length,
      blindSince: h && h.since ? new Date(h.since).toISOString() : null,                         // stopped seeing the check-in screen at
      note: this.note ? { code: this.note.code, text: this.note.text, since: new Date(this.note.since).toISOString() } : null });
  }
}

// Plain words for a failed connection.
function netWords(err) {
  const m = String((err && (err.cause && err.cause.code || err.cause && err.cause.message)) || '') + ' ' + String(err && err.message || '');
  if (/CERT|SSL|TLS|ECONNRESET|socket hang up/i.test(m)) return 'This computer is blocked from the website (a firewall or antivirus), or the connection was cut. Try again; if it keeps happening, check the network.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'This computer cannot find the website: check its internet connection.';
  if (/ECONNREFUSED|ETIMEDOUT|abort|timed out|fetch failed/i.test(m)) return 'This computer cannot reach the website right now: check its internet connection.';
  return String(err && err.message || err);
}

module.exports = { ReaderCore, netWords, readJson, writePrivate };
