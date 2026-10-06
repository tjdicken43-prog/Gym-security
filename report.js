// Monthly summary report — the artifact that justifies the subscription.
//
// A gym owner doesn't renew because alerts arrived. They renew because at
// the end of the month someone hands them a number and some pictures. This
// turns the 35-day flagged-event store into that.
//
// Photos are attached by CID rather than linked, so they render in the
// email without the recipient needing access to your server — and so the
// report is still readable months later in their inbox.

const fs = require('fs');
const path = require('path');
const monitor = require('./monitor');
const mailer = require('./mailer');
const gyms = require('./gyms');

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtHour(h) {
  const ampm = h < 12 ? 'am' : 'pm';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ampm}`;
}

// Dates and times in the GYM's time zone (report.timeZone, from
// monitor.buildReport). The server runs in UTC, which put 2am entries at
// 7am and could land them on the wrong day.
let currentTz = null;
function tzOpt() { return currentTz ? { timeZone: currentTz } : {}; }
function fmtDate(iso) {
  // Day keys like "2026-09-20" are calendar days already — format as-is.
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) {
    return new Date(iso + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  }
  return new Date(iso).toLocaleDateString('en-US', Object.assign({ month: 'short', day: 'numeric' }, tzOpt()));
}

function fmtDateTime(iso) {
  try {
    return new Date(iso).toLocaleString('en-US', Object.assign({
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }, tzOpt()));
  } catch (e) {
    return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
}

// "Central Time" rather than "America/Chicago".
function tzWords(tz) {
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'long' }).formatToParts(new Date()).find(x => x.type === 'timeZoneName');
    return p ? p.value.replace(/ (Daylight|Standard) /, ' ') : tz;
  } catch (e) { return tz; }
}

// What the gym itself decided on the activity page, in words.
function reviewedLine(r) {
  const bits = [];
  if (r.confirmedByGym) bits.push(`you confirmed ${r.confirmedByGym} as ${r.confirmedByGym === 1 ? 'a tailgate' : 'tailgates'}`);
  if (r.markedFineByGym) bits.push(`${r.markedFineByGym} you marked as fine ${r.markedFineByGym === 1 ? 'is' : 'are'} left out`);
  if (r.notReviewed && (r.confirmedByGym || r.markedFineByGym)) bits.push(`${r.notReviewed} not checked yet`);
  if (!bits.length) return '';
  const s = bits.join('; ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}
// The period in words: "August 2026" or "the last 30 days".
function periodWords(r) { return r.periodLabel ? r.periodLabel : `the last ${r.days} days`; }
function plural(n, one, many) { return `${n} ${n === 1 ? one : many}`; }
// Honest headline: flagged is not the same as confirmed.
//   "4 flagged — 1 confirmed by you, 3 not checked"
function headlineFor(r) {
  if (r.totalFlagged === 0) return `No unexpected entries in ${periodWords(r)}`;
  if (r.confirmedByGym === r.totalFlagged) return `${plural(r.totalFlagged, 'confirmed tailgate', 'confirmed tailgates')} in ${periodWords(r)}`;
  const parts = [];
  if (r.confirmedByGym) parts.push(`${r.confirmedByGym} confirmed by you`);
  if (r.notReviewed) parts.push(`${r.notReviewed} not checked`);
  return `${r.totalFlagged} flagged in ${periodWords(r)}${parts.length ? ' — ' + parts.join(', ') : ''}`;
}
// What was done even in a clean month.
function watchedLine(r) {
  if (!r.nightsWatched && !r.entriesChecked) return '';
  return `Watched ${plural(r.nightsWatched, 'night', 'nights')} and checked ${plural(r.entriesChecked, 'entry', 'entries')}.`;
}
function reviewTag(e) {
  if (!e.review) return '';
  return e.review.verdict === 'tailgate' ? ' · <span style="color:#c0392b;font-weight:600;">Confirmed by you</span>' : '';
}

// Pulls the evidence frames for the events we're showing, as mail
// attachments. Capped so a bad month doesn't produce a 40MB email.
function collectAttachments(gymCode, events, max) {
  const dir = monitor.framesDirFor(gymCode);
  const out = [];
  const used = new Set();
  for (const e of events) {
    if (out.length >= (max || 12)) break;
    if (!e.frame) continue;
    const full = path.join(dir, e.frame);
    if (!fs.existsSync(full)) continue;
    const cid = `evt${out.length}@securityai`;
    // Named in the gym's local time ("front-door-2026-09-11-0214-07.jpg"),
    // whatever the stored file is called.
    const when = new Date((e.capturedAt && Date.parse(e.capturedAt) <= Date.parse(e.timestamp) + 120000) ? e.capturedAt : e.timestamp);
    let name = monitor.stampFor(gymCode, e.zoneLabel || 'entrance', isNaN(when) ? new Date() : when);
    while (used.has(name)) name += '-b';
    used.add(name);
    out.push({ filename: `${name}.jpg`, path: full, cid });
    e._cid = cid;
  }
  return out;
}

function renderHtml(report, gymName, opts) {
  const r = report;
  currentTz = r.timeZone || null;
  const web = !!(opts && opts.web);
  const shown = r.events.slice(0, 12);
  const zoneRows = Object.entries(r.byZone).sort((a, b) => b[1] - a[1]);

  const headline = headlineFor(r);
  const base = gyms.publicBaseUrl();
  // A photo opens that event on the activity page, not a bare JPEG.
  const linkFor = e => (opts && opts.linkFor) ? opts.linkFor(e) : (base && e.id ? `${base}/activity.html#ev-${encodeURIComponent(e.id)}` : null);
  const wrap = (e, inner) => { const l = linkFor(e); return l ? `<a href="${esc(l)}">${inner}</a>` : inner; };

  const cards = shown.map(e => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e6e8eb;vertical-align:top;width:120px;">
        ${(web && opts.photoUrl && e.frame)
          ? wrap(e, `<img src="${esc(opts.photoUrl(e))}" width="110" style="border-radius:4px;border:1px solid #d8dbdf;display:block;" alt="Captured frame">`)
          : e._cid
          ? wrap(e, `<img src="cid:${e._cid}" width="110" style="border-radius:4px;border:1px solid #d8dbdf;display:block;" alt="Captured frame">`)
          : `<div style="width:110px;height:74px;background:#f0f2f4;border-radius:4px;"></div>`}
      </td>
      <td style="padding:12px 0 12px 14px;border-bottom:1px solid #e6e8eb;vertical-align:top;">
        <div style="font-size:14px;color:#14171A;font-weight:600;">${esc(e.zoneLabel || 'Entrance')} — ${esc(fmtDateTime(e.capturedAt && Date.parse(e.capturedAt) <= Date.parse(e.timestamp) + 120000 ? e.capturedAt : e.timestamp))}${reviewTag(e)}</div>
        <div style="font-size:13px;color:#5b636b;margin-top:4px;">${e.people_count == null ? 'Could not be counted automatically.' : `${esc(e.people_count)} people crossed, ${esc(e.expectedCount || 1)} expected.`}</div>
        ${e.note ? `<div style="font-size:13px;color:#5b636b;margin-top:2px;font-style:italic;">"${esc(e.note)}"</div>` : ''}
        ${e.review && e.review.note ? `<div style="font-size:13px;color:#14171A;margin-top:2px;">Your note: ${esc(e.review.note)}</div>` : ''}
      </td>
    </tr>`).join('');

  // The web view (the gym opening "monthly report" on a phone) gets a
  // viewport tag and a fluid width; the email keeps its fixed 600px table.
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">${web ? '<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Monthly report — SecurityAI</title><style>img{max-width:100%;height:auto}</style>' : ''}</head><body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
${web ? '<div style="max-width:600px;margin:0 auto;padding:14px 12px 0;"><a href="/activity.html" style="font-size:16px;color:#14171A;display:inline-block;padding:8px 0;">&larr; Back to activity</a></div>' : ''}
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:${web ? '8px 8px 28px' : '28px 12px'};">
<tr><td align="center">
<table ${web ? 'width="100%"' : 'width="600"'} cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e0e3e7;${web ? 'max-width:600px;' : ''}">

  <tr><td style="background:#14171A;padding:22px 28px;">
    <div style="color:#3FCF8E;font-size:12px;letter-spacing:1px;font-family:monospace;">SECURITYAI · MONTHLY SUMMARY</div>
    <div style="color:#ffffff;font-size:20px;font-weight:600;margin-top:6px;">${esc(gymName || r.gymCode)}</div>
    <div style="color:#8B939B;font-size:13px;margin-top:2px;">${r.periodLabel ? esc(r.periodLabel) : `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}`}</div>
  </td></tr>

  <tr><td style="padding:26px 28px 8px;">
    <div style="font-size:26px;font-weight:700;color:#14171A;line-height:1.25;">${esc(headline)}</div>
    ${watchedLine(r) ? `<div style="font-size:15px;color:#14171A;margin-top:8px;">${esc(watchedLine(r))}</div>` : ''}
    ${r.totalFlagged > 0 ? (r.extraPeopleSeen ? `<div style="font-size:14px;color:#5b636b;margin-top:8px;">
      Up to ${esc(r.extraPeopleSeen)} more ${r.extraPeopleSeen === 1 ? 'person' : 'people'} than expected came through, across ${esc(r.daysWithActivity)} ${r.daysWithActivity === 1 ? 'day' : 'days'}.
    </div>` : '') : `<div style="font-size:14px;color:#5b636b;margin-top:8px;">Every entry during monitored hours matched what was expected.</div>`}
    ${r.markedFineByGym ? `<div style="font-size:14px;color:#5b636b;margin-top:6px;">${esc(plural(r.markedFineByGym, 'flag', 'flags'))} you marked as fine ${r.markedFineByGym === 1 ? 'is' : 'are'} left out.</div>` : ''}
  </td></tr>

  ${r.totalFlagged > 0 ? `
  <tr><td style="padding:14px 28px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f9fa;border-radius:6px;">
      <tr>
        ${r.busiestHour ? `<td style="padding:14px 16px;width:50%;">
          <div style="font-size:11px;color:#8B939B;letter-spacing:.5px;">BUSIEST HOUR</div>
          <div style="font-size:17px;color:#14171A;font-weight:600;margin-top:3px;">${esc(fmtHour(r.busiestHour.hour))} (${esc(r.busiestHour.count)})</div>
        </td>` : ''}
        <td style="padding:14px 16px;width:50%;">
          <div style="font-size:11px;color:#8B939B;letter-spacing:.5px;">WORST DAY</div>
          <div style="font-size:17px;color:#14171A;font-weight:600;margin-top:3px;">${r.worstDay ? esc(fmtDate(r.worstDay.date)) + ` (${esc(r.worstDay.count)})` : '—'}</div>
        </td>
      </tr>
    </table>
  </td></tr>

  ${zoneRows.length ? `
  <tr><td style="padding:22px 28px 0;">
    <div style="font-size:12px;color:#8B939B;letter-spacing:.5px;margin-bottom:8px;">BY ENTRANCE</div>
    <table width="100%" cellpadding="0" cellspacing="0">
      ${zoneRows.map(([z, n]) => `<tr>
        <td style="padding:7px 0;font-size:14px;color:#14171A;border-bottom:1px solid #eef0f2;">${esc(z)}</td>
        <td style="padding:7px 0;font-size:14px;color:#14171A;text-align:right;font-weight:600;border-bottom:1px solid #eef0f2;">${esc(n)}</td>
      </tr>`).join('')}
    </table>
  </td></tr>` : ''}

  <tr><td style="padding:24px 28px 0;">
    <div style="font-size:12px;color:#8B939B;letter-spacing:.5px;margin-bottom:4px;">
      WHAT WAS SEEN${r.totalFlagged > shown.length ? ` · SHOWING ${shown.length} OF ${esc(r.totalFlagged)}` : ''}
    </div>
    <table width="100%" cellpadding="0" cellspacing="0">${cards}</table>
  </td></tr>` : ''}

  <tr><td style="padding:24px 28px 28px;">
    <div style="font-size:12px;color:#8b939b;line-height:1.6;border-top:1px solid #e6e8eb;padding-top:16px;">
      These are entries where more people crossed than expected at that door. "Flagged" means the camera check thought so; "confirmed" means you marked it Tailgate on your activity page. SecurityAI counts people and describes what it saw — it does not identify anyone, so these aren't matched to member accounts. Anything you marked "It was fine" is left out. Photos of flagged entries (and anything you mark Tailgate) are kept for 35 days; all others are deleted after 48 hours.${r.timeZone ? ` Times are ${esc(tzWords(r.timeZone))}.` : ''}
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function renderText(report, gymName) {
  const r = report;
  currentTz = r.timeZone || null;
  const base = gyms.publicBaseUrl();
  const lines = [
    `SecurityAI — Monthly Summary for ${gymName || r.gymCode}`,
    r.periodLabel || `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}`,
    '',
    headlineFor(r) + '.',
  ];
  if (watchedLine(r)) lines.push(watchedLine(r));
  if (r.totalFlagged > 0 && r.extraPeopleSeen) lines.push(`Up to ${r.extraPeopleSeen} more people than expected came through, across ${plural(r.daysWithActivity, 'day', 'days')}.`);
  if (r.markedFineByGym) lines.push(`${plural(r.markedFineByGym, 'flag', 'flags')} you marked as fine ${r.markedFineByGym === 1 ? 'is' : 'are'} left out.`);
  if (r.busiestHour) lines.push(`Busiest hour: ${fmtHour(r.busiestHour.hour)} (${r.busiestHour.count})`);
  if (r.worstDay && r.totalFlagged > 0) lines.push(`Worst day: ${fmtDate(r.worstDay.date)} (${r.worstDay.count})`);
  if (Object.keys(r.byZone).length) {
    lines.push('', 'By entrance:');
    for (const [z, n] of Object.entries(r.byZone).sort((a, b) => b[1] - a[1])) lines.push(`  ${z}: ${n}`);
  }
  if (r.events.length) {
    lines.push('', 'What was seen:');
    for (const e of r.events.slice(0, 12)) {
      const when = (e.capturedAt && Date.parse(e.capturedAt) <= Date.parse(e.timestamp) + 120000) ? e.capturedAt : e.timestamp;
      const tag = e.review && e.review.verdict === 'tailgate' ? ' [confirmed by you]' : e.review ? '' : ' [not checked]';
      lines.push(`  ${fmtDateTime(when)} — ${e.zoneLabel || 'Entrance'}: ${e.people_count == null ? 'not counted' : `${e.people_count} crossed, ${e.expectedCount || 1} expected`}.${e.note ? ` "${e.note}"` : ''}${tag}`);
      if (base && e.id) lines.push(`    ${base}/activity.html#ev-${encodeURIComponent(e.id)}`);
    }
  }
  lines.push('', 'SecurityAI counts people and describes behavior; it does not identify anyone.');
  return lines.join('\n');
}

// month: 'YYYY-MM' | 'last' | 'this' (calendar month in the gym's zone).
// Without month, the trailing `days` days (old behaviour).
async function sendMonthlyReport({ gymCode, gymName, to, days, month }) {
  const report = monitor.buildReport(gymCode, days || 30, undefined, month ? { month } : {});
  const attachments = collectAttachments(gymCode, report.events.slice(0, 12), 12);
  const where = gymName || gymCode;
  const when = report.periodLabel || `the last ${report.days} days`;
  const subject = report.totalFlagged === 0
    ? `SecurityAI: ${when} at ${where} — no unexpected entries${report.nightsWatched ? ` (${plural(report.nightsWatched, 'night', 'nights')} watched)` : ''}`
    : `SecurityAI: ${when} at ${where} — ${report.totalFlagged} flagged, ${report.confirmedByGym} confirmed`;

  const result = await mailer.sendMail({
    to,
    subject,
    text: renderText(report, gymName),
    html: renderHtml(report, gymName),
    attachments,
  });
  return { report, delivered: result.delivered, reason: result.reason };
}

module.exports = { buildReport: monitor.buildReport, renderHtml, renderText, sendMonthlyReport, headlineFor };
