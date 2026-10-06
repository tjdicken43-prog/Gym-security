// Shared email sending, used by both the alert system (monitor.js) and
// the support contact form (server.js). Lazily configured from .env —
// if SMTP_HOST isn't set, sendMail() resolves to a clear "not configured"
// result instead of throwing, so callers can degrade gracefully rather
// than crash.

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* optional dep not installed */ }

let transport = null;
function getTransport() {
  if (transport) return transport;
  if (!nodemailer || !process.env.SMTP_HOST) return null;
  transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  return transport;
}

// Plain words for why email can't go out. Render has no .env file, so
// never tell anyone to edit one.
function notConfiguredReason() {
  if (!process.env.SMTP_HOST) return 'SMTP_HOST is not set on Render (Environment tab), so no email can be sent';
  if (!nodemailer) return 'the nodemailer package is not installed on the server, so no email can be sent';
  return 'email is not set up on the server';
}

function isConfigured() {
  return !!getTransport();
}

// Returns { delivered: true } on success, or { delivered: false, reason }
// if SMTP isn't configured or sending failed — never throws, so a
// misconfigured mail server doesn't take down whatever called this.
async function sendMail({ to, subject, text, html, replyTo, attachments }) {
  const t = getTransport();
  if (!t) return { delivered: false, reason: notConfiguredReason() };
  try {
    await t.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to,
      subject,
      text,
      html,
      replyTo,
      attachments,
    });
    return { delivered: true };
  } catch (err) {
    return { delivered: false, reason: err.message };
  }
}

module.exports = { sendMail, isConfigured, notConfiguredReason };
