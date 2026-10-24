// Makes a new authenticator secret for the admin page (2FA).
//
//   node admin-totp.js
//
// 1. In Google Authenticator (or any authenticator app): + > Enter a setup
//    key. Account: SecurityAI admin. Key: the one printed below. Time based.
// 2. On Render > Environment: add ADMIN_TOTP_SECRET with the same key. Save.
// 3. After it says Live, the admin page asks for the 6-digit code once per
//    browser (30 days), instead of the approval email.
// Lost the phone? Delete ADMIN_TOTP_SECRET on Render (back to the email
// step), then run this again for a new key.
'use strict';
const crypto = require('crypto');
const { base32Encode } = require('./admin-auth');

const secret = base32Encode(crypto.randomBytes(20));
const uri = `otpauth://totp/${encodeURIComponent('SecurityAI:admin')}?secret=${secret}&issuer=SecurityAI&algorithm=SHA1&digits=6&period=30`;
console.log(`\nSetup key (ADMIN_TOTP_SECRET):\n  ${secret.replace(/(.{4})/g, '$1 ').trim()}\n`);
console.log(`Or paste this link into an app that takes one:\n  ${uri}\n`);
console.log('Keep the key only in the authenticator app and on Render. Do not email it or save it in notes.\n');
