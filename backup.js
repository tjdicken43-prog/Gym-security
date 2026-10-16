// Encrypted backup of the website's records (not photos): gym accounts,
// settings, alert lists, staff answers, results, logs, device approvals.
// Locked with a password (scrypt + AES-256-GCM): without the password the
// file can't be opened, so it is safe to keep in an email inbox.
//
//   On the website: admin page > Backup > download (you type the password),
//   and, if BACKUP_PASSWORD is set on Render, one emailed to SUPPORT_EMAIL
//   every night.
//   To open one:  node backup.js restore <file> <password> <folder>
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const SKIP = /^(pair-codes|admin-pending|handoffs)\.json$|\.tmp$|\.bak$/;
// keepMsFor(kind, gymKey) -> how long that gym keeps 'log' entries and
// 'summary' (kept) entries. Entries older than that are left out, so a
// backup never holds what the website itself has already deleted.
// Encrypted member scans (gym-scans-*) are short-lived and left out.
const ENTRY_FILE = /^(alert-log|summary)-([a-z0-9_-]+)\.json$/;
function trimEntries(name, text, keepMsFor) {
  const m = ENTRY_FILE.exec(name);
  if (!m || !keepMsFor) return text;
  try {
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return text;
    const ms = Number(keepMsFor(m[1] === 'alert-log' ? 'log' : 'summary', m[2]));
    if (!(ms > 0)) return text;
    const cut = Date.now() - ms;
    return JSON.stringify(list.filter(e => { const t = Date.parse(e && e.timestamp); return !isNaN(t) && t >= cut; }));
  } catch (e) { return text; }
}
function collect(dataDir, opts) {
  const o = opts || {};
  const files = {};
  for (const n of fs.readdirSync(dataDir)) {
    if (!/\.json$/.test(n) || SKIP.test(n) || /^gym-scans-/.test(n)) continue;
    const f = path.join(dataDir, n);
    try { if (fs.statSync(f).isFile() && fs.statSync(f).size < 20 * 1024 * 1024) files[n] = trimEntries(n, fs.readFileSync(f, 'utf8'), o.keepMsFor); } catch (e) { /* skip */ }
  }
  return files;
}
function seal(dataDir, password, opts) {
  if (!password || String(password).length < 10) throw new Error('Use a backup password of at least 10 characters.');
  const files = collect(dataDir, opts);
  const plain = zlib.gzipSync(Buffer.from(JSON.stringify({ at: new Date().toISOString(), files })));
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(password), salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(plain), c.final()]);
  return { count: Object.keys(files).length, text: JSON.stringify({ securityaiBackup: 1, at: new Date().toISOString(), kdf: 'scrypt-N32768', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') }) };
}
function open(text, password) {
  const b = JSON.parse(text);
  if (b.securityaiBackup !== 1) throw new Error('Not a SecurityAI backup.');
  const key = crypto.scryptSync(String(password), Buffer.from(b.salt, 'base64'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(b.iv, 'base64'));
  d.setAuthTag(Buffer.from(b.tag, 'base64'));
  let plain;
  try { plain = Buffer.concat([d.update(Buffer.from(b.data, 'base64')), d.final()]); } catch (e) { throw new Error('Wrong password (or the file was changed).'); }
  return JSON.parse(zlib.gunzipSync(plain).toString('utf8'));
}

module.exports = { seal, open, collect };

if (require.main === module) {
  const [cmd, file, pw, out] = process.argv.slice(2);
  if (cmd !== 'restore' || !file || !pw || !out) { console.log('Use:  node backup.js restore <backup file> <password> <folder to write to>'); process.exit(1); }
  const b = open(fs.readFileSync(file, 'utf8'), pw);
  fs.mkdirSync(out, { recursive: true });
  for (const [n, t] of Object.entries(b.files)) if (/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(n)) fs.writeFileSync(path.join(out, n), t);
  console.log(`Wrote ${Object.keys(b.files).length} files from the backup of ${b.at} into ${out}. To use them, copy them into the website's DATA_DIR (Render > Shell) and restart.`);
}
