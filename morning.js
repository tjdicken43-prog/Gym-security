// The morning summary: one short email per gym an hour after the watch
// hours end (7 AM when watched all day). What happened last night, what's
// waiting, and what's been caught this month. No AI calls: it reads the
// log, the staff answers and the results tally.
//
// Goes to the gym's alert list (email addresses only; texts cost money and
// the alerts already cover the urgent part). Each person can turn it off
// on the gym page or with the link in the email.
'use strict';

function create({ monitor, store, gyms, mailer, kindOf, send, log, onError }) {
  const say = log || (() => {});
  const fmtT = (key, ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: gyms.timeZoneFor(key), hour: 'numeric', minute: '2-digit' });
  const parts = (key, ms) => monitor.zonedAt(ms, gyms.timeZoneFor(key));
  const hm = v => { const m = /^(\d{1,2}):(\d{2})$/.exec(v || ''); return m ? +m[1] * 60 + +m[2] : null; };

  // The watch window that ended most recently, and when to send for it.
  function lastWindow(key, now) {
    const cfg = (monitor.getStatus(key) || {}).config || {};
    const s = hm(cfg.scheduleStart), e = hm(cfg.scheduleEnd);
    const p = parts(key, now);
    const midnight = monitor.zonedMidnightUtc(p.year, p.month, p.date, gyms.timeZoneFor(key));
    if (s == null || e == null || s === e) {
      const sendAt = midnight + 7 * 3600e3;
      return { start: sendAt - 24 * 3600e3, end: sendAt, sendAt, always: true, day: p.day };
    }
    const end = midnight + e * 60e3;               // today's end of watch (local)
    const start = end - (((e - s) + 1440) % 1440 || 1440) * 60e3;
    return { start, end, sendAt: end + 3600e3, always: false, day: p.day };
  }

  function build(key, now) {
    const w = lastWindow(key, now);
    const name = gyms.gymNameFor(key) || 'your gym';
    const reviews = store.loadReviews(key);
    const log = (monitor.getLog(key) || []).filter(e => e && !e.systemEvent && !e.capReached && e.mode !== 'wall' && !e.test);
    const inW = log.filter(e => { const t = Date.parse(e.capturedAt || e.timestamp); return t >= w.start && t <= w.end; });
    const k = inW.map(e => ({ e, kind: kindOf(e), review: reviews[store.eventId(e)] }));
    const entries = k.filter(x => !['out', 'none'].includes(x.kind)).length;
    const flags = k.filter(x => x.kind === 'flag' || x.kind === 'possible');
    const waiting = flags.filter(x => !x.review).length;
    const confirmed = flags.filter(x => x.review && store.isConfirmed(x.review.verdict)).length;
    const failed = k.filter(x => x.kind === 'unchecked').length;
    const t = store.tallySummary(key);
    // This month's caught + charged, from the lasting tally.
    const mp = parts(key, now), monthKey = `${mp.year}-${String(mp.month).padStart(2, '0')}`;
    const month = store.tallyRows(key).filter(o => String(o.at || '').slice(0, 7) === monthKey && store.isConfirmed(o.verdict));
    const monthUsd = month.reduce((a, o) => a + (o.follow && o.follow.what === 'charged' ? Number(o.follow.usd) || 0 : 0), 0);
    const st = monitor.getStatus(key) || {};
    const label = w.always ? 'Last 24 hours' : `Last night (${fmtT(key, w.start)} – ${fmtT(key, w.end)})`;
    const head = waiting ? `${waiting} ${waiting === 1 ? 'entry needs' : 'entries need'} a look` : flags.length ? 'Everything flagged has been checked' : 'All clear';
    const lines = [
      `${label}: ${entries} ${entries === 1 ? 'entry' : 'entries'}, ${flags.length} flagged${confirmed ? `, ${confirmed} confirmed` : ''}${waiting ? `, ${waiting} waiting for you` : ''}.`,
      failed ? `${failed} ${failed === 1 ? 'entry' : 'entries'} couldn't be checked automatically: look at ${failed === 1 ? 'it' : 'them'} on the gym page.` : null,
      month.length ? `This month: ${month.length} caught${monthUsd ? `, $${monthUsd.toFixed(monthUsd % 1 ? 2 : 0)} charged` : ''}${t.sneakInUsd ? ` (worth about $${month.length * t.sneakInUsd} at $${t.sneakInUsd} a sneak-in)` : ''}.` : null,
      t.toFollowUp ? `${t.toFollowUp} confirmed ${t.toFollowUp === 1 ? 'tailgate has' : 'tailgates have'} no follow-up yet (charged, talked to them...).` : null,
      (() => { const sp = store.getSpot ? store.getSpot(key) : null; if (!sp || !sp.ids || !sp.ids.length) return null; const done = Object.keys(sp.answers || {}).length; return done < sp.ids.length ? `Weekly spot-check: ${done} of ${sp.ids.length} done (about 2 minutes).` : null; })(),
      (() => { const n = Object.values(reviews).filter(r => r && r.verdict === 'fine' && r.override && !r.ownerChecked).length; return n ? `${n} ${n === 1 ? 'answer needs' : 'answers need'} the owner's second look: marked "It was fine" though the camera and the front-desk scans both showed an extra person.` : null; })(),
      !entries && st.heartbeatLost ? 'The camera computer was offline, so nothing was watched.' : null,
    ].filter(Boolean);
    const base = gyms.publicBaseUrl();
    const link = base ? `${base}/gym` : null;
    const subject = `${name}: ${head}`;
    const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const color = waiting ? '#C0392B' : '#1E8F5E';
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;color:#14171A;">
      <p style="font-size:20px;font-weight:700;margin:0 0 8px;color:${color};">${esc(head)}</p>
      ${lines.map(l => `<p style="font-size:15px;margin:0 0 8px;">${esc(l)}</p>`).join('')}
      ${link ? `<p style="margin:14px 0 0;"><a href="${esc(link)}" style="display:inline-block;background:#14171A;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;font-size:14px;">${waiting ? 'Check them now' : 'Open the gym page'}</a></p>` : ''}
    </div>`;
    const text = `${head}\n\n${lines.join('\n')}${link ? `\n\nOpen the gym page: ${link}` : ''}`;
    return { subject, text, html, window: w, waiting, entries, flags: flags.length };
  }

  // Hourly: send each gym's summary once, after its window (and at most 6
  // hours late, so a restart in the afternoon doesn't send a stale one).
  async function tick(keys, now) {
    const t = now || Date.now();
    if (!mailer.isConfigured()) return [];
    const out = [];
    for (const key of keys) {
      try {
        const w = lastWindow(key, t);
        if (t < w.sendAt || t > w.sendAt + 6 * 3600e3) continue;
        const meta = store.getSettings(key) || {};
        if (meta.morningSummary === false) continue;
        if (store.getMarker && store.getMarker(key, 'morning') === w.day) continue;
        const subs = store.loadSubscribers(key).filter(s => s.kind === 'email' && s.morning !== false);
        if (!subs.length) { store.setMarker && store.setMarker(key, 'morning', w.day); continue; }
        const m = build(key, t);
        for (const sub of subs) await send(key, sub, { kind: 'morning', subject: m.subject, text: m.text, html: m.html });
        store.setMarker && store.setMarker(key, 'morning', w.day);
        out.push({ key, to: subs.length, subject: m.subject });
        say(`morning summary ${key}: sent to ${subs.length}`);
      } catch (e) { say(`morning summary ${key}: ${e.message}`); if (onError) onError(e); }
    }
    return out;
  }

  return { build, tick, lastWindow };
}

module.exports = { create };
