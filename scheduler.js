// Monthly report scheduler.
//
// The report is the artifact that justifies renewing a subscription, so it
// can't depend on someone remembering to trigger it. This checks once an
// hour and sends on the configured day of the month.
//
// Deliberately not a cron library — one dependency-free interval is easier
// to reason about, and an hourly check is plenty for a monthly job. A sent
// marker on disk means a restart mid-day won't send the report twice.

const fs = require('fs');
const path = require('path');
const report = require('./report');
const gyms = require('./gyms');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const MARKER_FILE = path.join(DATA_DIR, 'report-sends.json');
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

// Day of month to send on (1 = the 1st), and the hour, in server local
// time. Both overridable so you can test without waiting for the 1st.
const SEND_DAY = parseInt(process.env.REPORT_SEND_DAY || '1', 10);
const SEND_HOUR = parseInt(process.env.REPORT_SEND_HOUR || '8', 10);

function loadMarkers() {
  try {
    if (!fs.existsSync(MARKER_FILE)) return {};
    return JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')) || {};
  } catch (err) { return {}; }
}

function saveMarkers(m) {
  try { fs.writeFileSync(MARKER_FILE, JSON.stringify(m)); } catch (err) {
    console.warn('Could not save report markers:', err.message);
  }
}

function periodKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Every gym that has an email on file, plus a fallback single-gym setup
// where there's no gyms.json but a REPORT_TO address is configured.
function recipients() {
  const list = gyms.listGyms();
  if (list.length) {
    // listGyms deliberately omits codes, so re-read for the code we need
    // to build each gym's report.
    return list.map(g => {
      const full = gyms.findByCode(gyms.normalize((g.gymName || '').toLowerCase())) || null;
      return { gymName: g.gymName, email: g.email, code: full ? full.code : null };
    });
  }
  if (process.env.REPORT_TO) {
    return [{ gymName: process.env.REPORT_GYM_NAME || 'your gym', email: process.env.REPORT_TO, code: null }];
  }
  return [];
}

async function runCheck(force) {
  const now = new Date();
  if (!force && (now.getDate() !== SEND_DAY || now.getHours() !== SEND_HOUR)) return { skipped: 'not-scheduled' };

  const markers = loadMarkers();
  const key = periodKey(now);
  const sent = [];

  for (const r of recipients()) {
    if (!r.email) continue;
    const markerId = `${r.code || r.email}:${key}`;
    if (!force && markers[markerId]) continue;   // already sent this period
    try {
      const out = await report.sendMonthlyReport({
        gymCode: r.code,
        gymName: r.gymName,
        to: r.email,
        days: 30,
      });
      markers[markerId] = new Date().toISOString();
      sent.push({ to: r.email, delivered: out.delivered, totalFlagged: out.report.totalFlagged, reason: out.reason });
      console.log(`Monthly report -> ${r.email}: ${out.delivered ? 'sent' : 'not delivered (' + out.reason + ')'}`);
    } catch (err) {
      console.warn(`Monthly report failed for ${r.email}:`, err.message);
      sent.push({ to: r.email, delivered: false, reason: err.message });
    }
  }
  saveMarkers(markers);
  return { sent, count: sent.length };
}

function start() {
  const timer = setInterval(() => { runCheck(false).catch(() => {}); }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  runCheck(false).catch(() => {});   // also check once at boot
  console.log(`Monthly report scheduler active — sends on day ${SEND_DAY} at ${SEND_HOUR}:00 server time.`);
  return timer;
}

module.exports = { start, runCheck, periodKey, SEND_DAY, SEND_HOUR };
