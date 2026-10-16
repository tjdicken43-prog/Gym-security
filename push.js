// Phone notifications (Web Push), with Node's own crypto: no packages.
//
//  - VAPID (RFC 8292): the website signs each push with its own key pair,
//    made once and kept in DATA_DIR/vapid.json (private).
//  - Payload encryption (RFC 8291, aes128gcm): only the phone that signed
//    up can read the message; the push service in the middle can't.
//  - Only real push services are contacted (Google, Mozilla, Apple,
//    Microsoft), never an address a browser made up.
//  - A phone that unsubscribed or was reset (404/410) is removed.
// Messages say what happened and link to the gym page. No member numbers
// and no photos are ever in a push.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALLOWED_HOSTS = /^(fcm\.googleapis\.com|android\.googleapis\.com|updates\.push\.services\.mozilla\.com|push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/i;
const MAX_PER_GYM = 40;
const b64u = b => Buffer.from(b).toString('base64url');
const unb64u = s => Buffer.from(String(s || ''), 'base64url');

function create({ dataDir, store, log, fetchImpl }) {
  const say = log || (() => {});
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const vapidFile = path.join(dataDir, 'vapid.json');
  const subsFile = key => path.join(dataDir, `gym-push-${store.safeCode(key)}.json`);
  let vapid = null;

  function keys() {
    if (vapid) return vapid;
    try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); } catch (e) { vapid = null; }
    if (!vapid || !vapid.publicKey || !vapid.privateJwk) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const jwk = privateKey.export({ format: 'jwk' });
      const pub = Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]);
      vapid = { publicKey: b64u(pub), privateJwk: jwk, made: new Date().toISOString() };
      fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 });
      void publicKey;
    }
    return vapid;
  }
  const publicKey = () => keys().publicKey;

  // VAPID JWT (ES256, raw r||s signature).
  function vapidHeader(endpoint) {
    const k = keys();
    const aud = new URL(endpoint).origin;
    const sub = 'mailto:' + (String(process.env.SUPPORT_EMAIL || '').trim() || 'support@securityai.invalid');
    const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
    const body = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub }));
    const key = crypto.createPrivateKey({ key: k.privateJwk, format: 'jwk' });
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), { key, dsaEncoding: 'ieee-p1363' });
    return `vapid t=${head}.${body}.${b64u(sig)}, k=${k.publicKey}`;
  }

  // RFC 8291 message encryption for one subscription.
  function encrypt(sub, plaintext) {
    const uaPublic = unb64u(sub.keys.p256dh);
    const authSecret = unb64u(sub.keys.auth);
    if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('bad subscription keys');
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    const asPublic = ecdh.getPublicKey();
    const shared = ecdh.computeSecret(uaPublic);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32));
    const salt = crypto.randomBytes(16);
    const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
    const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), c.final(), c.getAuthTag()]);
    const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
    return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
  }

  function load(key) { try { const a = JSON.parse(fs.readFileSync(subsFile(key), 'utf8')); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function save(key, list) { const tmp = `${subsFile(key)}.${process.pid}.tmp`; fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 }); fs.renameSync(tmp, subsFile(key)); }

  // Who signed this phone up (a person's id, or a hash of the gym code it
  // used). Each send checks that access still stands: a removed person, a
  // signed-out phone or an old gym code stops getting notifications.
  let check = null;
  function setCheck(fn) { check = typeof fn === 'function' ? fn : null; }
  function add(key, raw, who, access) {
    const s = raw || {};
    let u; try { u = new URL(String(s.endpoint || '')); } catch (e) { throw new Error('That isn\'t a push subscription.'); }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.test(u.hostname)) throw new Error('Notifications from this browser aren\'t supported. Use Chrome, Safari, Firefox or Edge.');
    const p256dh = String((s.keys || {}).p256dh || ''), auth = String((s.keys || {}).auth || '');
    if (unb64u(p256dh).length !== 65 || unb64u(auth).length < 16) throw new Error('That isn\'t a push subscription.');
    const list = load(key).filter(x => x.endpoint !== u.href);
    if (list.length >= MAX_PER_GYM) throw new Error(`Up to ${MAX_PER_GYM} phones per gym. Turn it off on one first.`);
    const a = access || {};
    const sub = { id: crypto.randomBytes(6).toString('hex'), endpoint: u.href, keys: { p256dh, auth }, who: String(who || '').slice(0, 40) || null, personId: a.personId || null, codeTag: a.codeTag || null, addedAt: new Date().toISOString() };
    list.push(sub); save(key, list);
    return sub;
  }
  function remove(key, endpoint) { const list = load(key); const next = list.filter(x => x.endpoint !== endpoint); if (next.length !== list.length) save(key, next); return list.length - next.length; }
  function has(key, endpoint) { return load(key).some(x => x.endpoint === endpoint); }

  // Send to every phone of a gym. msg: { title, body, url, tag }
  async function sendGym(key, msg, kind) {
    let all = load(key);
    if (check) {
      const keep = all.filter(x => { try { return check(key, x) !== false; } catch (e) { return true; } });
      if (keep.length !== all.length) { save(key, keep); say(`push ${key}: ${all.length - keep.length} phone(s) no longer signed in, removed`); all = keep; }
    }
    const list = all.filter(x => !(x.off || []).includes(kind));
    const out = { sent: 0, gone: 0, failed: 0 };
    const payload = JSON.stringify({ title: String(msg.title || 'SecurityAI').slice(0, 80), body: String(msg.body || '').slice(0, 240), url: msg.url || '/activity.html', tag: msg.tag || kind || 'securityai' });
    for (const sub of list) {
      try {
        const r = await doFetch(sub.endpoint, { method: 'POST', signal: AbortSignal.timeout(15e3),
          headers: { TTL: '3600', Urgency: kind === 'tailgate' ? 'high' : 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidHeader(sub.endpoint) },
          body: encrypt(sub, payload) });
        if (r.status === 404 || r.status === 410) { remove(key, sub.endpoint); out.gone++; }
        else if (r.status >= 200 && r.status < 300) out.sent++;
        else { out.failed++; say(`push ${key}: ${r.status}`); }
      } catch (e) { out.failed++; say(`push ${key}: ${e.message}`); }
    }
    return out;
  }
  const count = key => load(key).length;
  // One phone only (the "send a test" button).
  async function sendOne(key, endpoint, msg) {
    const sub = load(key).find(x => x.endpoint === endpoint);
    if (!sub) return { sent: 0 };
    const r = await doFetch(sub.endpoint, { method: 'POST', signal: AbortSignal.timeout(15e3),
      headers: { TTL: '600', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Authorization: vapidHeader(sub.endpoint) },
      body: encrypt(sub, JSON.stringify({ title: msg.title, body: msg.body, url: msg.url || '/activity.html', tag: 'test' })) });
    if (r.status === 404 || r.status === 410) { remove(key, sub.endpoint); return { sent: 0, gone: 1 }; }
    return { sent: r.status >= 200 && r.status < 300 ? 1 : 0, status: r.status };
  }

  return { publicKey, add, remove, has, sendGym, sendOne, count, setCheck, _encrypt: encrypt, _vapidHeader: vapidHeader, _keys: keys };
}

module.exports = { create, ALLOWED_HOSTS };
