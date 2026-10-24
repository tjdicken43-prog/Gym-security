// The "still waiting" reminder: a flagged entry nobody has answered (no
// Tailgate / Shared code / It was fine) gets ONE reminder email, so a
// real tailgate isn't lost when its photos are cleared after 48 hours.
// Alarm-monitoring services do the same: an alert nobody acknowledged is
// sent again, once, instead of being forgotten.
//
// Rules: only entries flagged 3 to 40 hours ago whose photos are kept at
// least 2 more hours (younger ones just went out as an alert); only between 8 AM and
// 8 PM in the gym's own time, so nobody is woken; one email per gym per
// run, listing everything waiting; each entry is reminded about once,
// ever. Goes to the gym's email list (the people who get the morning
// summary and tailgate alerts). No texts, no AI calls. Off for a gym with
// the setting reminders: false; each person stops it with the morning
// summary's "stop" link.
'use strict';

const AFTER_MS = 3 * 3600e3;
const UNTIL_MS = 40 * 3600e3;
const DAY_START_H = 8, DAY_END_H = 20;

function create({ monitor, store, gyms, mailer, kindOf, send, log, onError }) {
  const say = log || (() => {});
  const fmt = (key, ms) => new Date(ms).toLocaleString('en-US', { timeZone: gyms.timeZoneFor(key), weekday: 'short', hour: 'numeric', minute: '2-digit' });

  // Flagged, unanswered entries in the reminder window, not reminded before.
  function waiting(key, now) {
    const reviews = store.loadReviews(key);
    const done = new Set((store.getMarker(key, 'nudged') || []).map(String));
    return (monitor.getLog(key) || [])
      .filter(e => e && !e.systemEvent && !e.capReached && e.mode !== 'wall' && !e.test)
      .map(e => ({ e, id: String(store.eventId(e)), at: Date.parse(e.capturedAt || e.timestamp), gone: monitor.purgeAt(key, e) }))
      .filter(x => Number.isFinite(x.at) && now - x.at >= AFTER_MS && now - x.at <= UNTIL_MS && x.gone - now >= 2 * 3600e3)
      .filter(x => ['flag', 'possible'].includes(kindOf(x.e)) && !reviews[x.id] && !done.has(x.id))
      .sort((a, b) => a.at - b.at);
  }

  function build(key, list) {
    const name = gyms.gymNameFor(key) || 'your gym';
    const base = gyms.publicBaseUrl();
    const n = list.length;
    const subject = `${name}: ${n} flagged ${n === 1 ? 'entry is' : 'entries are'} still waiting for an answer`;
    const lines = list.map(x => `${fmt(key, x.at)} (photos cleared ${fmt(key, x.gone)})${base ? `: ${base}/activity.html#ev-${encodeURIComponent(x.id)}` : ''}`);
    const why = `Nobody has answered ${n === 1 ? 'this one' : 'these'} yet. Once the photos are cleared, a real tailgate can't be followed up; marking it Tailgate keeps it for the monthly report. It takes a few seconds: Tailgate, Shared code, or It was fine.`;
    const text = `${subject}.\n\n${lines.join('\n')}\n\n${why}`;
    const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;color:#14171A;">
      <p style="font-size:20px;font-weight:700;margin:0 0 8px;color:#C0392B;">${esc(n)} still waiting for an answer</p>
      ${list.map(x => `<p style="font-size:15px;margin:0 0 6px;">${base ? `<a href="${esc(`${base}/activity.html#ev-${encodeURIComponent(x.id)}`)}" style="color:#1D4FB0;">${esc(fmt(key, x.at))}</a>` : esc(fmt(key, x.at))} <span style="color:#5b646c;">· photos cleared ${esc(fmt(key, x.gone))}</span></p>`).join('')}
      <p style="font-size:15px;margin:12px 0 0;">${esc(why)}</p>
    </div>`;
    return { subject, text, html };
  }

  async function tick(keys, now) {
    const t = now || Date.now();
    const out = [];
    if (mailer && !mailer.isConfigured()) return out;
    for (const key of keys) {
      try {
        if ((store.getSettings(key) || {}).reminders === false) continue;
        const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: gyms.timeZoneFor(key), hour: 'numeric', hourCycle: 'h23' }).format(new Date(t)));
        if (hour < DAY_START_H || hour >= DAY_END_H) continue;
        const list = waiting(key, t);
        if (!list.length) continue;
        const subs = store.loadSubscribers(key).filter(s => s.kind === 'email' && s.morning !== false && s.tailgates !== false);
        const m = build(key, list);
        for (const sub of subs) await send(key, sub, { kind: 'nudge', subject: m.subject, text: m.text, html: m.html });
        // Remembered even with nobody to send to, so it never piles up. Only
        // ids still inside the window are kept: the list stays small.
        const keep = (store.getMarker(key, 'nudged') || []).map(String).filter(id => waitingIdStillLogged(key, id, t));
        store.setMarker(key, 'nudged', [...new Set([...keep, ...list.map(x => x.id)])].slice(-500));
        out.push({ key, to: subs.length, count: list.length });
        say(`reminder ${key}: ${list.length} waiting, sent to ${subs.length}`);
      } catch (e) { say(`reminder ${key}: ${e.message}`); if (onError) onError(e); }
    }
    return out;
  }

  function waitingIdStillLogged(key, id, now) {
    return (monitor.getLog(key) || []).some(e => e && String(store.eventId(e)) === id && now - Date.parse(e.capturedAt || e.timestamp) <= UNTIL_MS + 24 * 3600e3);
  }

  return { tick, waiting, build };
}

module.exports = { create, AFTER_MS, UNTIL_MS };
