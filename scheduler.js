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

// Day of month to send on (1 = the 1st) and the hour, in EACH GYM'S OWN
// time zone (8 am Central for an Arkansas gym, not 8 am UTC = 3 am
// there). The report covers the previous calendar month.
const SEND_DAY = parseInt(process.env.REPORT_SEND_DAY || '1', 10);
const SEND_HOUR = parseInt(process.env.REPORT_SEND_HOUR || '8', 10);

function loadMarkers() {
  try {
    if (!fs.existsSync(MARKER_FILE)) return {};
    return JSON.parse(fs.readFileSync(MARKER_FILE, 'utf8')) || {};
  } catch (err) { return {}; }
}

function saveMarkers(m) {
  try {
    const tmp = `${MARKER_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m));
    fs.renameSync(tmp, MARKER_FILE);
  } catch (err) {
    console.warn('Could not save report markers:', err.message);
  }
}

function periodKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Every gym that has an email on file, plus a fallback single-gym setup
// where there's no gyms.json but a REPORT_TO address is configured.
function recipients() {
  const list = gyms.listGymsForAdmin();
  if (list.length) {
    return list.map(g => ({ gymName: g.gymName, email: g.email, code: g.key || g.code || null }));
  }
  if (process.env.REPORT_TO) {
    return [{ gymName: process.env.REPORT_GYM_NAME || 'your gym', email: process.env.REPORT_TO, code: null }];
  }
  return [];
}

// The gym-local date/hour now, and the month the report is about.
function localNow(code) {
  const monitor = require('./monitor');
  const tz = gyms.timeZoneFor(code || 'default');
  const p = monitor.zonedAt(Date.now(), tz);
  const lastY = p.month === 1 ? p.year - 1 : p.year, lastM = p.month === 1 ? 12 : p.month - 1;
  return { tz, day: p.date, hour: p.hour, reportMonth: `${lastY}-${String(lastM).padStart(2, '0')}` };
}

async function runCheck(force) {
  const markers = loadMarkers();
  const sent = [];
  let due = 0;

  for (const r of recipients()) {
    if (!r.email) continue;
    const t = localNow(r.code);
    // Any hour from SEND_HOUR on, that day: a restart or a slow hourly
    // timer can't skip the month, and a failed send is tried again next
    // hour (the marker below is only set once it is actually delivered).
    if (!force && (t.day !== SEND_DAY || t.hour < SEND_HOUR)) continue;
    due++;
    const markerId = `${r.code || r.email}:${t.reportMonth}`;
    if (!force && markers[markerId]) continue;   // already sent this period
    try {
      const out = await report.sendMonthlyReport({
        gymCode: r.code,
        gymName: r.gymName,
        to: r.email,
        month: t.reportMonth,
      });
      if (out.delivered) markers[markerId] = new Date().toISOString();
      sent.push({ to: r.email, gym: r.code, month: t.reportMonth, delivered: out.delivered, totalFlagged: out.report.totalFlagged, reason: out.reason });
      console.log(`Monthly report (${t.reportMonth}) -> ${r.gymName}: ${out.delivered ? 'sent' : 'not delivered (' + out.reason + ')'}`);
    } catch (err) {
      console.warn(`Monthly report failed for ${r.gymName}:`, err.message);
      sent.push({ to: r.email, gym: r.code, delivered: false, reason: err.message });
    }
  }
  if (!force && !due) return { skipped: 'not-scheduled' };
  saveMarkers(markers);
  return { sent, count: sent.length };
}

function start() {
  // Hourly is enough: each gym is checked against its own local hour.
  const timer = setInterval(() => { runCheck(false).catch(() => {}); }, CHECK_INTERVAL_MS);
  if (timer.unref) timer.unref();
  runCheck(false).catch(() => {});   // also check once at boot
  console.log(`Monthly report scheduler active — sends last month's report on day ${SEND_DAY} at ${SEND_HOUR}:00 in each gym's own time zone.`);
  return timer;
}

module.exports = { start, runCheck, periodKey, localNow, SEND_DAY, SEND_HOUR };
