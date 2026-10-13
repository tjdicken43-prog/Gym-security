// Protected member numbers: the browser half (used by activity.html and
// admin.html). Keys are made here and the private halves are stored in this
// browser only (IndexedDB, marked non-exportable: even this page's own code
// can't read them out). See member-keys.js for the formats.
(function (global) {
  'use strict';
  const DB = 'securityai-keys', STORE = 'keys';
  const ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  const subtle = global.crypto && global.crypto.subtle;

  function db() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  async function get(name) {
    const d = await db();
    return new Promise((resolve, reject) => { const t = d.transaction(STORE).objectStore(STORE).get(name); t.onsuccess = () => resolve(t.result || null); t.onerror = () => reject(t.error); });
  }
  async function put(name, val) {
    const d = await db();
    return new Promise((resolve, reject) => { const t = d.transaction(STORE, 'readwrite').objectStore(STORE).put(val, name); t.onsuccess = () => resolve(); t.onerror = () => reject(t.error); });
  }
  async function del(name) {
    const d = await db();
    return new Promise((resolve, reject) => { const t = d.transaction(STORE, 'readwrite').objectStore(STORE).delete(name); t.onsuccess = () => resolve(); t.onerror = () => reject(t.error); });
  }

  const b64uToBytes = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const b = atob(s); const a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; };
  const bytesToB64u = a => { let s = ''; const u = new Uint8Array(a); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const hex = a => Array.from(new Uint8Array(a)).map(x => x.toString(16).padStart(2, '0')).join('');

  async function fingerprint(pub) { return hex(await subtle.digest('SHA-256', new TextEncoder().encode(`${pub.n}.${pub.e}`))); }
  function codeOf(fp) {
    let v = parseInt(String(fp).slice(0, 8), 16) >>> 2, out = '';
    for (let i = 0; i < 6; i++) { out = ALPHA[v % 31] + out; v = Math.floor(v / 31); }
    return out.slice(0, 3) + '-' + out.slice(3);
  }
  async function pubJwk(pair) { const j = await subtle.exportKey('jwk', pair.publicKey); return { kty: 'RSA', n: j.n, e: j.e }; }

  // 'read' = this device's reading key; 'sign' = the owner device's signing key.
  async function getKey(kind) {
    const k = await get(kind);
    return k && k.pair && k.pub ? k : null;
  }
  async function makeKey(kind) {
    const alg = kind === 'sign'
      ? { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
      : { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
    const pair = await subtle.generateKey(alg, false, kind === 'sign' ? ['sign', 'verify'] : ['encrypt', 'decrypt']);
    const pub = await pubJwk(pair);
    const fp = await fingerprint(pub);
    const rec = { pair, pub, fp, code: codeOf(fp), at: new Date().toISOString() };
    await put(kind, rec);
    try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) { /* best effort */ }
    return rec;
  }
  async function getOrMakeKey(kind) { return (await getKey(kind)) || makeKey(kind); }

  async function sign(text) {
    const k = await getKey('sign');
    if (!k) throw new Error('This browser is not the owner device.');
    const sig = await subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, k.pair.privateKey, new TextEncoder().encode(text));
    return bytesToB64u(sig);
  }
  const approvePayload = (gym, fp, at) => `securityai-approve-v1|${gym}|${fp}|${at}`;
  const revokePayload = (gym, fp, at) => `securityai-revoke-v1|${gym}|${fp}|${at}`;

  // One scan: { key (wrapped), iv, ct, mac } -> member number (string)
  async function openScan(scan) {
    const k = await getKey('read');
    if (!k) throw new Error('No reading key on this device.');
    const raw = new Uint8Array(await subtle.decrypt({ name: 'RSA-OAEP' }, k.pair.privateKey, b64uToBytes(scan.key)));
    if (raw.length !== 64) throw new Error('Bad key length');
    const macKey = await subtle.importKey('raw', raw.slice(32, 64), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const iv = b64uToBytes(scan.iv), ct = b64uToBytes(scan.ct);
    const both = new Uint8Array(iv.length + ct.length); both.set(iv, 0); both.set(ct, iv.length);
    if (!(await subtle.verify('HMAC', macKey, b64uToBytes(scan.mac), both))) throw new Error('This scan was changed after it was sent.');
    const encKey = await subtle.importKey('raw', raw.slice(0, 32), { name: 'AES-CBC' }, false, ['decrypt']);
    const plain = await subtle.decrypt({ name: 'AES-CBC', iv }, encKey, ct);
    const obj = JSON.parse(new TextDecoder().decode(plain));
    return obj;
  }

  global.MemberCrypto = { supported: !!(subtle && global.indexedDB), getKey, makeKey, getOrMakeKey, forget: del, sign, approvePayload, revokePayload, fingerprint, codeOf, openScan, b64uToBytes, bytesToB64u };
})(typeof window !== 'undefined' ? window : globalThis);
