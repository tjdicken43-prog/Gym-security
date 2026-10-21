// Protected member numbers.
//
// The front-desk reader (on the Ashbourne PC) scrambles each scan's member
// number before it leaves that PC, so that ONLY approved devices can read
// it. This website stores and passes on the scrambled data but holds no
// key that opens it.
//
//   - TJ's "owner device" (his phone/computer, set up on the admin page)
//     has a SIGNING key. Only devices it has signed an approval for get
//     member numbers. The reader on the PC pins the owner's key when it is
//     set up, and checks every approval itself, so even someone in control
//     of this website can't add a device of their own.
//   - Every device that reads (the owner's included) has its own READING
//     key, made in its browser; the private half never leaves it.
//   - Removing a device is a signed revocation: the reader remembers it, so
//     an old approval can't be replayed, and its copies of the scrambled
//     keys are deleted here too.
//
// Formats (shared with the browser and the PowerShell reader):
//   key:          RSA 2048, JWK { n, e } (base64url)
//   fingerprint:  SHA-256 hex of "<n>.<e>"; the 6-character code people
//                 compare is its first 30 bits in base 32 (no 0/O/1/I/L).
//   approval:     RSASSA-PKCS1-v1_5 SHA-256 over
//                 "securityai-approve-v1|<gym>|<fingerprint>|<at>" (at = ms since 1970)
//   revocation:   same, over "securityai-revoke-v1|<gym>|<fingerprint>|<at>"
//   scan:         { t, zone, iv, ct, mac, keys: { <deviceId>: <wrapped> } }
//                 ct = AES-256-CBC(member number), mac = HMAC-SHA256(iv||ct),
//                 wrapped = RSA-OAEP-SHA256(enc key 32 bytes || mac key 32 bytes)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const SCAN_KEEP_MS = 48 * 3600e3;
const KEPT_SCAN_MS = 35 * 864e5;
const MAX_DEVICES = 30;
const MAX_PENDING = 10;
const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';   // 31 letters; 5 bits each, mod 31

const safe = k => String(k || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40) || 'default';
const b64u = /^[A-Za-z0-9_-]+$/;

function readJson(file, dflt) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return dflt; } }
function writeJson(file, obj) {
  try {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { console.warn('member-keys: could not save', path.basename(file), e.message); return false; }
}

// ---- keys --------------------------------------------------------------
function validJwk(k) {
  if (!k || typeof k !== 'object') return null;
  const n = String(k.n || ''), e = String(k.e || '');
  if (!b64u.test(n) || n.length < 340 || n.length > 700 || e !== 'AQAB') return null;   // RSA 2048+, exponent 65537 only
  return { kty: 'RSA', n, e };
}
function fingerprint(k) { return crypto.createHash('sha256').update(`${k.n}.${k.e}`).digest('hex'); }
function codeOf(fpHex) {
  // 12 letters from the key's fingerprint (about 59 bits): long enough that
  // nobody can make a different key that shows the same code.
  const f = String(fpHex || '');
  let out = '';
  for (let i = 0; i < 12; i++) out += ALPHA[parseInt(f.substr(i * 2, 2), 16) % 31];
  return out.slice(0, 4) + '-' + out.slice(4, 8) + '-' + out.slice(8);
}
function verifySig(signJwk, payload, sigB64u) {
  try {
    const key = crypto.createPublicKey({ key: { kty: 'RSA', n: signJwk.n, e: signJwk.e }, format: 'jwk' });
    return crypto.verify('sha256', Buffer.from(payload, 'utf8'), { key, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(String(sigB64u || ''), 'base64url'));
  } catch (e) { return false; }
}
const approvePayload = (gym, fp, at) => `securityai-approve-v1|${gym}|${fp}|${at}`;
const revokePayload = (gym, fp, at) => `securityai-revoke-v1|${gym}|${fp}|${at}`;
// A backup approver: a second phone the owner device vouches for (signs).
// Readers accept its approvals because the owner key they pinned signed it.
const delegatePayload = (fp, at) => `securityai-delegate-v1|${fp}|${at}`;
const undelegatePayload = (fp, at) => `securityai-undelegate-v1|${fp}|${at}`;

// ---- owner (TJ) ----------------------------------------------------
const ownerFile = () => path.join(DATA_DIR, 'owner-key.json');
function getOwner() { const o = readJson(ownerFile(), null); return o && o.sign && validJwk(o.sign) ? o : null; }
function setOwner(signJwk) {
  const sign = validJwk(signJwk);
  if (!sign) throw new Error('That owner key is not valid.');
  const fp = fingerprint(sign);
  const o = { sign, fp, code: codeOf(fp), at: new Date().toISOString() };
  if (!writeJson(ownerFile(), o)) throw new Error('Could not save — is the disk writable?');
  return o;
}

// ---- backup approvers -----------------------------------------------------
const delFile = () => path.join(DATA_DIR, 'owner-delegates.json');
function loadDelegates() {
  const d = readJson(delFile(), null);
  return { delegates: Array.isArray(d && d.delegates) ? d.delegates : [], undelegated: Array.isArray(d && d.undelegated) ? d.undelegated : [] };
}
function saveDelegates(d) { if (!writeJson(delFile(), d)) throw new Error('Could not save — is the disk writable?'); }
function requestDelegate(signJwk, name) {
  const sign = validJwk(signJwk);
  if (!sign) throw new Error('That key is not valid.');
  const owner = getOwner();
  if (!owner) throw new Error('Set up the owner device first.');
  const fp = fingerprint(sign);
  if (fp === owner.fp) throw new Error('This is already the owner device.');
  const d = loadDelegates();
  const same = d.delegates.find(x => x.fp === fp);
  if (same) return same;
  if (d.undelegated.some(x => x.fp === fp)) throw new Error('This phone was removed as a backup approver. Clear this page’s data in the browser settings to ask again.');
  if (d.delegates.length >= 3) throw new Error('Up to 3 backup approvers. Remove one first.');
  const del = { fp, sign, code: codeOf(fp), name: cleanName(name), status: 'pending', createdAt: new Date().toISOString() };
  d.delegates.push(del); saveDelegates(d);
  return del;
}
function approveDelegate(fp, at, sig) {
  if (!validAt(at)) throw new Error('Bad approval time.');
  const owner = getOwner();
  if (!owner) throw new Error('Set up the owner device first.');
  const d = loadDelegates();
  const del = d.delegates.find(x => x.fp === fp);
  if (!del) throw new Error('That request is gone.');
  if (!verifySig(owner.sign, delegatePayload(fp, at), sig)) throw new Error('Only the owner device can add a backup approver.');
  del.status = 'approved'; del.at = String(at); del.sig = String(sig); del.approvedAt = new Date().toISOString();
  saveDelegates(d);
  return del;
}
function removeDelegate(fp, at, sig) {
  const owner = getOwner();
  const d = loadDelegates();
  const del = d.delegates.find(x => x.fp === fp);
  if (!del) return { removed: false };
  if (del.status === 'approved') {
    if (!validAt(at) || !owner || !verifySig(owner.sign, undelegatePayload(fp, at), sig)) throw new Error('Only the owner device can remove a backup approver.');
    d.undelegated.push({ fp, at: String(at), sig: String(sig) });
  }
  d.delegates = d.delegates.filter(x => x.fp !== fp);
  saveDelegates(d);
  return { removed: true };
}
// The key that must have signed an approval or removal: the owner's, or an
// approved backup approver's (checked against the owner's signature).
function signerKey(by) {
  const owner = getOwner();
  if (!owner) return null;
  if (!by || by === owner.fp) return owner.sign;
  const d = loadDelegates();
  if (d.undelegated.some(x => x.fp === by)) return null;
  const del = d.delegates.find(x => x.fp === by && x.status === 'approved');
  if (!del || fingerprint(del.sign) !== del.fp || !verifySig(owner.sign, delegatePayload(del.fp, del.at), del.sig)) return null;
  return del.sign;
}
const validBy = by => (by == null || by === '' ? null : /^[0-9a-f]{64}$/.test(String(by)) ? String(by) : false);

// ---- devices per gym ---------------------------------------------------
const devFile = gym => path.join(DATA_DIR, `gym-devices-${safe(gym)}.json`);
function loadDevices(gym) {
  const d = readJson(devFile(gym), null);
  return { devices: Array.isArray(d && d.devices) ? d.devices : [], revoked: Array.isArray(d && d.revoked) ? d.revoked : [], reader: (d && d.reader) || null };
}
function saveDevices(gym, d) { if (!writeJson(devFile(gym), d)) throw new Error('Could not save — is the disk writable?'); }
function cleanName(v) { return String(v || '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || 'A phone'; }

function requestDevice(gym, pubJwk, name) {
  const pub = validJwk(pubJwk);
  if (!pub) throw new Error('That device key is not valid.');
  const d = loadDevices(gym);
  const fp = fingerprint(pub);
  const same = d.devices.find(x => x.fp === fp);
  if (same) return same;
  if (d.revoked.some(r => r.fp === fp)) throw new Error('This device was removed. Clear this page’s data in the browser settings to make a new request.');
  if (d.devices.filter(x => x.status === 'pending').length >= MAX_PENDING) throw new Error('Too many devices are waiting for approval. Ask SecurityAI to clear them.');
  if (d.devices.length >= MAX_DEVICES) throw new Error('This gym has the most devices allowed. Remove an old one first.');
  const dev = { id: crypto.randomBytes(9).toString('base64url'), name: cleanName(name), pub, fp, code: codeOf(fp), status: 'pending', createdAt: new Date().toISOString(), approval: null };
  d.devices.push(dev);
  saveDevices(gym, d);
  return dev;
}
// Signed times are plain milliseconds ("1791907654538"): no date text that
// any of the three programs might reformat.
const validAt = at => /^\d{12,15}$/.test(String(at || ''));
function approveDevice(gym, id, at, sig, opts) {
  if (!validAt(at)) throw new Error('Bad approval time.');
  const owner = getOwner();
  if (!owner) throw new Error('Set up your owner device first.');
  const by = validBy(opts && opts.by);
  if (by === false) throw new Error('Bad approver.');
  const key = signerKey(by);
  if (!key) throw new Error('That approver is not the owner device or an approved backup approver.');
  const d = loadDevices(gym);
  const dev = d.devices.find(x => x.id === id);
  if (!dev) throw new Error('That device is gone.');
  if (!verifySig(key, approvePayload(safe(gym), dev.fp, at), sig)) throw new Error('The approval signature did not check out. Is this your owner device?');
  dev.status = 'approved'; dev.approval = Object.assign({ at: String(at), sig: String(sig) }, by && by !== owner.fp ? { by } : {}); dev.approvedAt = new Date().toISOString();
  if (opts && opts.owner) dev.owner = true;
  saveDevices(gym, d);
  return dev;
}
function addApprovedDevice(gym, pubJwk, name, at, sig, by) {
  const dev = requestDevice(gym, pubJwk, name);
  return approveDevice(gym, dev.id, at, sig, { owner: true, by });
}
function removeDevice(gym, id, at, sig, by) {
  if (!validAt(at)) throw new Error('Bad removal time.');
  const owner = getOwner();
  if (!owner) throw new Error('Set up your owner device first.');
  const d = loadDevices(gym);
  const dev = d.devices.find(x => x.id === id);
  if (!dev) return { removed: false };
  if (dev.status === 'approved') {
    const b = validBy(by);
    const key = b === false ? null : signerKey(b);
    if (!key || !verifySig(key, revokePayload(safe(gym), dev.fp, at), sig)) throw new Error('The removal signature did not check out. Is this your owner device?');
    d.revoked.push(Object.assign({ fp: dev.fp, at: String(at), sig: String(sig) }, b && b !== owner.fp ? { by: b } : {}));
  }
  d.devices = d.devices.filter(x => x.id !== id);
  saveDevices(gym, d);
  // Its scrambled copies of the scan keys go too.
  const scans = loadScans(gym);
  let changed = false;
  for (const s of scans) if (s.keys && s.keys[id]) { delete s.keys[id]; changed = true; }
  if (changed) saveScans(gym, scans);
  return { removed: true };
}
function deviceStatus(gym, id) {
  const dev = loadDevices(gym).devices.find(x => x.id === String(id || ''));
  return dev ? { id: dev.id, code: codeOf(dev.fp), status: dev.status, name: dev.name } : null;
}
function touchDevice(gym, id) {
  const d = loadDevices(gym);
  const dev = d.devices.find(x => x.id === id);
  if (dev && (!dev.lastSeen || Date.now() - Date.parse(dev.lastSeen) > 10 * 60e3)) { dev.lastSeen = new Date().toISOString(); saveDevices(gym, d); }
}
// What the admin page shows (no keys, no signatures).
function adminView(gym) {
  const d = loadDevices(gym);
  return {
    devices: d.devices.map(x => ({ id: x.id, name: x.name, code: codeOf(x.fp), status: x.status, owner: !!x.owner, createdAt: x.createdAt, approvedAt: x.approvedAt || null, lastSeen: x.lastSeen || null })),
    removed: d.revoked.length,
    reader: d.reader,
  };
}
// What the reader needs to decide whom to scramble for: it checks every
// approval against the owner key it pinned itself.
function trustFor(gym) {
  const d = loadDevices(gym);
  const owner = getOwner();
  return {
    gym: safe(gym),
    owner: owner ? { sign: owner.sign, fp: owner.fp, code: codeOf(owner.fp) } : null,
    devices: d.devices.filter(x => x.status === 'approved' && x.approval).map(x => ({ id: x.id, pub: x.pub, approval: x.approval })),
    revoked: d.revoked,
    // Backup approvers, each signed by the owner key (readers check that),
    // and the ones the owner removed (also signed).
    delegates: loadDelegates().delegates.filter(x => x.status === 'approved').map(x => ({ fp: x.fp, sign: x.sign, at: x.at, sig: x.sig })),
    undelegated: loadDelegates().undelegated,
  };
}
function noteReader(gym, info) {
  const d = loadDevices(gym);
  const clean = {};
  for (const [k, v] of Object.entries(info || {})) if (v !== undefined && v !== null) clean[k] = v;
  if ('problem' in (info || {})) clean.problem = info.problem || null;    // a cleared problem clears
  if ('problemCode' in (info || {})) clean.problemCode = info.problemCode || null;
  if ('note' in (info || {})) { clean.note = info.note || null; clean.noteText = info.noteText || null; }   // a cleared note clears
  d.reader = Object.assign({}, d.reader || {}, clean, { lastSeen: new Date().toISOString() });
  // When it was online (to tell "no scan" from "reader was off"): merged
  // spans, 48 h. It checks in at least every 5 minutes while running.
  const now = Date.now();
  const spans = (Array.isArray(d.reader.online) ? d.reader.online : []).filter(s => s[1] > now - 49 * 3600e3);
  const last = spans[spans.length - 1];
  if (last && now - last[1] <= 7 * 60e3) last[1] = now; else spans.push([now, now]);
  d.reader.online = spans.slice(-200);
  // When it could actually SEE the check-in screen. Running but blind (no
  // picture, the check-in screen not showing, unreadable) doesn't count: an
  // entry then is "front desk not visible", never "no scan". The reader says
  // when it went blind; an older reader that doesn't is taken as blind from
  // 10 minutes before it said so.
  const blind = BLIND.includes(info && info.problemCode);
  const seeing = (Array.isArray(d.reader.seeing) ? d.reader.seeing : (d.reader.online || []).map(x => x.slice())).filter(s => s[1] > now - 49 * 3600e3);
  const sl = seeing[seeing.length - 1];
  if (blind) {
    const since = Math.min(now, Date.parse(info.blindSince || '') || now - 10 * 60e3);
    if (sl && sl[1] > since) sl[1] = Math.max(sl[0], since);
  } else if (sl && now - sl[1] <= 7 * 60e3) sl[1] = now; else seeing.push([now, now]);
  d.reader.seeing = seeing.filter(s => s[1] > s[0] || s[1] >= now - 1).slice(-200);
  // Worth telling the gym (not a problem): e.g. the Visit Log hidden behind an open account.
  const notes = (Array.isArray(d.reader.notes) ? d.reader.notes : []).filter(n => n[1] > now - 49 * 3600e3);
  const nl = notes[notes.length - 1], note = info && info.note;
  if (note && note.code) {
    const from = Math.min(now, Date.parse(note.since || '') || now);
    if (nl && nl[2] === note.code && now - nl[1] <= 7 * 60e3) nl[1] = now; else notes.push([from, now, String(note.code).slice(0, 30)]);
  }
  d.reader.notes = notes.slice(-100);
  saveDevices(gym, d);
}
const BLIND = ['no-signal', 'popup-hidden', 'labels-changed', 'ashbourne-closed'];

// ---- scans -------------------------------------------------------------
const scanFile = gym => path.join(DATA_DIR, `gym-scans-${safe(gym)}.json`);
function loadScans(gym) {
  const now = Date.now();
  const a = readJson(scanFile(gym), []);
  return (Array.isArray(a) ? a : []).filter(s => s && (Date.parse(s.keepUntil || 0) > now || Date.parse(s.t) > now - SCAN_KEEP_MS));
}
function saveScans(gym, list) { writeJson(scanFile(gym), list); }
function cleanScan(s, skewMs) {
  if (!s || typeof s !== 'object') return null;
  const t = Date.parse(s.t);
  if (isNaN(t)) return null;
  const iv = String(s.iv || ''), ct = String(s.ct || ''), mac = String(s.mac || '');
  if (!/^[A-Za-z0-9+/=_-]{16,40}$/.test(iv) || !/^[A-Za-z0-9+/=_-]{16,400}$/.test(ct) || !/^[A-Za-z0-9+/=_-]{40,60}$/.test(mac)) return null;
  const keys = {};
  if (s.keys && typeof s.keys === 'object') {
    for (const [id, w] of Object.entries(s.keys).slice(0, MAX_DEVICES)) {
      if (/^[A-Za-z0-9_-]{6,24}$/.test(id) && /^[A-Za-z0-9+/=_-]{300,800}$/.test(String(w))) keys[id] = String(w);
    }
  }
  const fixed = Math.abs(skewMs || 0) > 2e3 && Math.abs(skewMs) < 3 * 864e5 ? t + skewMs : t;
  const out = { id: crypto.createHash('sha256').update(mac).digest('hex').slice(0, 16), t: new Date(fixed).toISOString(), zone: String(s.zone || '').slice(0, 30), iv, ct, mac, keys };
  // "The same member's code again, N minutes after scan <prev>" (no member data).
  if (s.uncertain === true) out.uncertain = true;      // the reader's two readings of the number disagreed
  if (s.repeat && typeof s.repeat === 'object') {
    const mins = Math.round(Number(s.repeat.mins));
    if (mins >= 1 && mins <= 600 && /^[a-f0-9]{16}$/.test(String(s.repeat.prev || ''))) out.repeat = { mins, prev: String(s.repeat.prev) };
  }
  return out;
}
function addScans(gym, scans, skewMs) {
  const list = loadScans(gym);
  const have = new Set(list.map(s => s.id));
  let added = 0;
  for (const raw of (Array.isArray(scans) ? scans : []).slice(0, 200)) {
    const s = cleanScan(raw, skewMs);
    if (!s || have.has(s.id)) continue;
    list.push(s); have.add(s.id); added++;
  }
  list.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  saveScans(gym, list);
  return added;
}
// Was the reader running at this moment? (within its check-in spans)
function readerCovered(gym, atMs) {
  const r = loadDevices(gym).reader;
  if (!r) return false;
  // Seeing the check-in screen at that moment (a minute's slack either side: it checks in every few minutes).
  if (Array.isArray(r.seeing)) return r.seeing.some(s => atMs >= s[0] - 60e3 && atMs <= s[1] + 6 * 60e3) && !blindAt(r, atMs);
  return !!(Array.isArray(r.online) && r.online.some(s => atMs >= s[0] - 6 * 60e3 && atMs <= s[1] + 6 * 60e3));
}
// Blind right now and since before atMs (the open end of a blind spell).
function blindAt(r, atMs) {
  if (!BLIND.includes(r.problemCode)) return false;
  const last = r.seeing[r.seeing.length - 1];
  return !last || atMs > last[1];
}
// The spells last night when the front desk wasn't readable, and the notes (for the morning summary).
function readerNight(gym, fromMs, toMs) {
  const r = loadDevices(gym).reader;
  if (!r || !Array.isArray(r.seeing)) return null;
  const gaps = [];
  if (!r.seeing.length) return { blind: [], notes: [] };
  let t = Math.max(fromMs, Math.min(...r.seeing.map(x => x[0])));     // not before the reader was ever running
  for (const s of r.seeing.filter(s => s[1] >= fromMs && s[0] <= toMs).sort((a, b) => a[0] - b[0])) {
    if (s[0] - t > 10 * 60e3) gaps.push([t, s[0]]);
    t = Math.max(t, s[1]);
  }
  if (toMs - t > 10 * 60e3 && Date.parse(r.lastSeen || 0) > fromMs - 3600e3) gaps.push([t, toMs]);
  const notes = (r.notes || []).filter(n => n[1] >= fromMs && n[0] <= toMs).map(n => [Math.max(n[0], fromMs), Math.min(n[1], toMs), n[2]]);
  return { blind: gaps, notes };
}
// Scan TIMES only (no member data): for counting scans against people.
function scanTimes(gym, fromMs, toMs) {
  return loadScans(gym).map(s => Date.parse(s.t)).filter(t => t >= fromMs && t <= toMs).sort((a, b) => a - b);
}
function scanList(gym, fromMs, toMs) {
  return loadScans(gym).map(s => ({ id: s.id, t: Date.parse(s.t), repeat: s.repeat || null, uncertain: !!s.uncertain })).filter(s => s.t >= fromMs && s.t <= toMs).sort((a, b) => a.t - b.t);
}
// Only the asking device's own scrambled key goes out with each scan.
function scansFor(gym, deviceId, fromMs, toMs) {
  return loadScans(gym).filter(s => { const t = Date.parse(s.t); return t >= fromMs && t <= toMs && s.keys && s.keys[deviceId]; })
    .map(s => ({ id: s.id, t: s.t, zone: s.zone, iv: s.iv, ct: s.ct, mac: s.mac, key: s.keys[deviceId] }));
}
// Particular scans (the ones that let someone in on confirmed tailgates),
// still sealed for this device: only the approved phone can open them.
function scansByIds(gym, deviceId, ids) {
  const want = new Set((ids || []).map(String));
  return loadScans(gym).filter(s => want.has(String(s.id)) && s.keys && s.keys[deviceId])
    .map(s => ({ id: s.id, t: s.t, zone: s.zone, iv: s.iv, ct: s.ct, mac: s.mac, key: s.keys[deviceId] }));
}
// A flag confirmed by the gym keeps the scans around it for the monthly
// report (35 days), like its photos.
function keepAround(gym, atIso, keep, keepMs) {
  const ms = Number(keepMs) > 0 ? Math.min(KEPT_SCAN_MS, Number(keepMs)) : KEPT_SCAN_MS;   // the gym's shorter choice wins
  const t = Date.parse(atIso);
  if (isNaN(t)) return;
  const list = loadScans(gym);
  let changed = false;
  for (const s of list) {
    const st = Date.parse(s.t);
    if (Math.abs(st - t) <= 120e3) { if (keep) s.keepUntil = new Date(t + ms).toISOString(); else delete s.keepUntil; changed = true; }
  }
  if (changed) saveScans(gym, list);
}

module.exports = {
  fingerprint, codeOf, verifySig, approvePayload, revokePayload, validJwk,
  getOwner, setOwner, delegatePayload, undelegatePayload, loadDelegates, requestDelegate, approveDelegate, removeDelegate, signerKey,
  scansByIds, loadDevices, requestDevice, approveDevice, addApprovedDevice, removeDevice, deviceStatus, touchDevice, adminView, trustFor, noteReader,
  addScans, scansFor, keepAround, loadScans, readerCovered, readerNight, scanTimes, scanList,
};
