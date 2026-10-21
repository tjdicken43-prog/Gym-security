// Personal logins: each person at a gym signs in with their own email
// (a one-time link, no password to forget), and gets a role:
//   staff   - check entries, answer them, spot-check, say what happened next
//   manager - + the alert list and the sneak-in price
//   owner   - + add and remove people, change roles
// The gym's account email (gyms.json) is always an owner. The shared gym
// code keeps working as before (full access), so nobody is locked out while
// a gym moves over; removing a person stops their sign-in straight away.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROLES = ['staff', 'manager', 'owner'];
const RIGHTS = {
  staff: ['view', 'answer', 'follow'],
  manager: ['view', 'answer', 'follow', 'alerts', 'price'],
  owner: ['view', 'answer', 'follow', 'alerts', 'price', 'people'],
};
const COOKIE = 'sai_person';
const LINK_MS = 20 * 60e3;
const MAX_PEOPLE = 40;

function create({ dataDir, store, gyms }) {
  const file = key => path.join(dataDir, `gym-people-${store.safeCode(key)}.json`);
  const usedFile = path.join(dataDir, 'login-links-used.json');
  const cleanEmail = v => store.normalizeEmail(v);
  const cleanName = v => String(v || '').replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

  function load(key) {
    let a; try { a = JSON.parse(fs.readFileSync(file(key), 'utf8')); } catch (e) { a = []; }
    return Array.isArray(a) ? a.filter(p => p && p.id && p.email && ROLES.includes(p.role)) : [];
  }
  function save(key, list) {
    const tmp = `${file(key)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file(key));
  }
  // Everyone, with the gym's account email as an owner even if not listed.
  function list(key) {
    const out = load(key);
    let acct = null; try { const g = gyms.findByCode(key); acct = g && cleanEmail(g.email); } catch (e) { /* none */ }
    if (acct && !out.some(p => p.email === acct)) out.unshift({ id: 'acct', name: 'Owner', email: acct, role: 'owner', builtIn: true });
    return out;
  }
  function get(key, id) { return list(key).find(p => p.id === id) || null; }
  function gymKeys() { try { return gyms.listGymsForAdmin().map(g => store.safeCode(g.key || g.code)); } catch (e) { return []; } }
  // Every gym where this email is a person (for sign-in and switching).
  function gymsFor(email) {
    const e = cleanEmail(email); if (!e) return [];
    return gymKeys().filter(k => { try { return !gyms.isClosed(k); } catch (x) { return true; } }).map(k => ({ key: k, person: list(k).find(p => p.email === e) })).filter(x => x.person);
  }

  function add(key, { name, email, role }, by) {
    const e = cleanEmail(email);
    if (!e) throw new Error('That doesn\'t look like an email address.');
    const n = cleanName(name); if (!n) throw new Error('Add their first name.');
    if (!ROLES.includes(role)) throw new Error('Pick a role: staff, manager or owner.');
    const all = load(key);
    if (list(key).some(p => p.email === e)) throw new Error(`${e} is already on the list.`);
    if (all.length >= MAX_PEOPLE) throw new Error(`Up to ${MAX_PEOPLE} people per gym.`);
    const p = { id: crypto.randomBytes(6).toString('hex'), name: n, email: e, role, addedAt: new Date().toISOString(), addedBy: by || null };
    all.push(p); save(key, all);
    return p;
  }
  function update(key, id, { role, name }) {
    const all = load(key);
    const p = all.find(x => x.id === id);
    if (!p) throw new Error(id === 'acct' ? 'The gym account\'s email is always an owner (change it on the admin page).' : 'That person is no longer on the list.');
    if (role !== undefined) {
      if (!ROLES.includes(role)) throw new Error('Pick a role: staff, manager or owner.');
      if (p.role === 'owner' && role !== 'owner' && !list(key).some(x => x.id !== id && x.role === 'owner')) throw new Error('Keep at least one owner.');
      p.role = role;
    }
    if (name !== undefined) { const n = cleanName(name); if (n) p.name = n; }
    save(key, all);
    return p;
  }
  function remove(key, id) {
    if (id === 'acct') throw new Error('The gym account\'s email is always an owner (change it on the admin page).');
    const all = load(key);
    const p = all.find(x => x.id === id);
    if (!p) return false;
    if (p.role === 'owner' && !list(key).some(x => x.id !== id && x.role === 'owner')) throw new Error('Keep at least one owner.');
    save(key, all.filter(x => x.id !== id));
    return true;
  }
  function touch(key, id) {
    const all = load(key); const p = all.find(x => x.id === id);
    if (p && (!p.lastSeen || Date.now() - Date.parse(p.lastSeen) > 3600e3)) { p.lastSeen = new Date().toISOString(); save(key, all); }
  }

  // ---- one-time sign-in links ------------------------------------------
  function linkToken(email) { return store.signToken('login', { e: cleanEmail(email), n: crypto.randomBytes(8).toString('hex'), x: Date.now() + LINK_MS }); }
  function useLink(tok) {
    const t = store.readToken('login', tok);
    if (!t || !t.e || !t.n) return null;
    let used = {}; try { used = JSON.parse(fs.readFileSync(usedFile, 'utf8')); } catch (e) { /* none */ }
    const now = Date.now();
    for (const [k, v] of Object.entries(used)) if (v < now) delete used[k];
    if (used[t.n]) return null;                       // one use only
    used[t.n] = t.x;
    try { fs.writeFileSync(usedFile, JSON.stringify(used)); } catch (e) { return null; }
    return t.e;
  }

  // ---- the person cookie --------------------------------------------------
  function setCookie(req, res, key, person) {
    const v = store.signToken('person', { k: store.safeCode(key), p: person.id, e: person.email });
    const secure = String((req.headers['x-forwarded-proto'] || '')).split(',')[0].trim() === 'https' || !!(req.socket && req.socket.encrypted);
    const c = `${COOKIE}=${encodeURIComponent(v)}; Path=/; Max-Age=${365 * 86400}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [].concat(prev || [], c));
  }
  function clearCookie(req, res) {
    const prev = res.getHeader('Set-Cookie');
    res.setHeader('Set-Cookie', [].concat(prev || [], `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`));
  }
  // The signed-in person, re-checked against the list on every request.
  function fromRequest(req) {
    const raw = store.parseCookies(req.headers && req.headers.cookie)[COOKIE];
    const t = raw ? store.readToken('person', raw) : null;
    if (!t || !t.k || !t.p) return null;
    if (!gyms.isKnownKey(t.k)) return null;
    const p = get(t.k, t.p);
    if (!p || p.email !== t.e) return null;
    return { key: t.k, person: p };
  }
  const can = (role, what) => (RIGHTS[role] || []).includes(what);

  return { list, get, add, update, remove, touch, gymsFor, linkToken, useLink, setCookie, clearCookie, fromRequest, can, ROLES, RIGHTS };
}

module.exports = { create, ROLES, RIGHTS };
