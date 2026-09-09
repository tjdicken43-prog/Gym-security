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

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtHour(h) {
  const ampm = h < 12 ? 'am' : 'pm';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ampm}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

// Pulls the evidence frames for the events we're showing, as mail
// attachments. Capped so a bad month doesn't produce a 40MB email.
function collectAttachments(gymCode, events, max) {
  const dir = monitor.framesDirFor(gymCode);
  const out = [];
  for (const e of events) {
    if (out.length >= (max || 12)) break;
    if (!e.frame) continue;
    const full = path.join(dir, e.frame);
    if (!fs.existsSync(full)) continue;
    const cid = `evt${out.length}@securityai`;
    out.push({ filename: e.frame, path: full, cid });
    e._cid = cid;
  }
  return out;
}

function renderHtml(report, gymName) {
  const r = report;
  const shown = r.events.slice(0, 12);
  const zoneRows = Object.entries(r.byZone).sort((a, b) => b[1] - a[1]);

  const headline = r.totalFlagged === 0
    ? `No unexpected entries in the last ${r.days} days`
    : `${r.totalFlagged} unexpected ${r.totalFlagged === 1 ? 'entry' : 'entries'} in the last ${r.days} days`;

  const cards = shown.map(e => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #e6e8eb;vertical-align:top;width:120px;">
        ${e._cid
          ? `<img src="cid:${e._cid}" width="110" style="border-radius:4px;border:1px solid #d8dbdf;display:block;" alt="Captured frame">`
          : `<div style="width:110px;height:74px;background:#f0f2f4;border-radius:4px;"></div>`}
      </td>
      <td style="padding:12px 0 12px 14px;border-bottom:1px solid #e6e8eb;vertical-align:top;">
        <div style="font-size:14px;color:#14171A;font-weight:600;">${esc(e.zoneLabel || 'Entrance')} — ${fmtDateTime(e.timestamp)}</div>
        <div style="font-size:13px;color:#5b636b;margin-top:4px;">${esc(e.people_count)} people crossed, ${esc(e.expectedCount || 1)} expected.</div>
        <div style="font-size:13px;color:#5b636b;margin-top:2px;font-style:italic;">"${esc(e.note)}"</div>
      </td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:28px 12px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e0e3e7;">

  <tr><td style="background:#14171A;padding:22px 28px;">
    <div style="color:#3FCF8E;font-size:12px;letter-spacing:1px;font-family:monospace;">SECURITYAI · MONTHLY SUMMARY</div>
    <div style="color:#ffffff;font-size:20px;font-weight:600;margin-top:6px;">${esc(gymName || r.gymCode)}</div>
    <div style="color:#8B939B;font-size:13px;margin-top:2px;">${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}</div>
  </td></tr>

  <tr><td style="padding:26px 28px 8px;">
    <div style="font-size:26px;font-weight:700;color:#14171A;line-height:1.25;">${esc(headline)}</div>
    ${r.totalFlagged > 0 ? `<div style="font-size:14px;color:#5b636b;margin-top:8px;">
      That's ${esc(r.extraPeopleSeen)} more ${r.extraPeopleSeen === 1 ? 'person' : 'people'} than should have come through, across ${esc(r.daysWithActivity)} ${r.daysWithActivity === 1 ? 'day' : 'days'}.
    </div>` : `<div style="font-size:14px;color:#5b636b;margin-top:8px;">Every entry during monitored hours matched what was expected.</div>`}
  </td></tr>

  ${r.totalFlagged > 0 ? `
  <tr><td style="padding:14px 28px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f9fa;border-radius:6px;">
      <tr>
        <td style="padding:14px 16px;width:50%;">
          <div style="font-size:11px;color:#8B939B;letter-spacing:.5px;">BUSIEST HOUR</div>
          <div style="font-size:17px;color:#14171A;font-weight:600;margin-top:3px;">${r.busiestHour ? esc(fmtHour(r.busiestHour.hour)) + ` (${esc(r.busiestHour.count)})` : '—'}</div>
        </td>
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
      These are entries where more people crossed than the expected count set for that door. SecurityAI counts people and describes behavior — it does not identify anyone, so these aren't matched to member accounts. Photos are the frames that triggered each alert, kept for 35 days.
    </div>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;
}

function renderText(report, gymName) {
  const r = report;
  const lines = [
    `SecurityAI — Monthly Summary for ${gymName || r.gymCode}`,
    `${fmtDate(r.periodStart)} – ${fmtDate(r.periodEnd)}`,
    '',
    r.totalFlagged === 0
      ? `No unexpected entries in the last ${r.days} days.`
      : `${r.totalFlagged} unexpected entries in the last ${r.days} days — ${r.extraPeopleSeen} more people than should have come through, across ${r.daysWithActivity} days.`,
  ];
  if (r.busiestHour) lines.push(`Busiest hour: ${fmtHour(r.busiestHour.hour)} (${r.busiestHour.count})`);
  if (r.worstDay) lines.push(`Worst day: ${fmtDate(r.worstDay.date)} (${r.worstDay.count})`);
  if (Object.keys(r.byZone).length) {
    lines.push('', 'By entrance:');
    for (const [z, n] of Object.entries(r.byZone).sort((a, b) => b[1] - a[1])) lines.push(`  ${z}: ${n}`);
  }
  if (r.events.length) {
    lines.push('', 'Recent events:');
    for (const e of r.events.slice(0, 12)) {
      lines.push(`  ${fmtDateTime(e.timestamp)} — ${e.zoneLabel || 'Entrance'}: ${e.people_count} crossed, ${e.expectedCount || 1} expected. "${e.note}"`);
    }
  }
  lines.push('', 'SecurityAI counts people and describes behavior; it does not identify anyone.');
  return lines.join('\n');
}

async function sendMonthlyReport({ gymCode, gymName, to, days }) {
  const report = monitor.buildReport(gymCode, days || 30);
  const attachments = collectAttachments(gymCode, report.events, 12);
  const subject = report.totalFlagged === 0
    ? `SecurityAI: a clean month at ${gymName || gymCode}`
    : `SecurityAI: ${report.totalFlagged} unexpected ${report.totalFlagged === 1 ? 'entry' : 'entries'} at ${gymName || gymCode}`;

  const result = await mailer.sendMail({
    to,
    subject,
    text: renderText(report, gymName),
    html: renderHtml(report, gymName),
    attachments,
  });
  return { report, delivered: result.delivered, reason: result.reason };
}

module.exports = { buildReport: monitor.buildReport, renderHtml, renderText, sendMonthlyReport };
