// The website's look at itself: a health score per gym and what it thinks
// needs doing, from numbers it already has (no AI calls, nothing new
// stored). Shown on the admin page and emailed to TJ once a week.
//
// It only SUGGESTS. It never loosens detection, changes a gym's settings
// or touches code by itself: anything that could make it miss a tailgater
// stays a decision for a person. (The safe automatic fixes live where the
// problem is: restarts, retries, the backup AI model, the camera
// computer's self-update and roll-back, re-finding the front-desk screen.)
'use strict';

const LEVEL_COST = { red: 25, amber: 10, info: 0 };
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;

// Same buckets as the gym page, from the raw log entry.
function kindOf(e) {
  if (e.error) return 'unchecked';
  if (e.went_out === true && !e.phone_handoff) return 'out';
  if (Number(e.people_count) === 0 && !e.tailgate_flag && !e.phone_handoff) return 'none';
  if (e.tailgate_flag) return e.confidence === 'low' ? 'possible' : 'flag';
  return 'ok';
}

// in: { name, row, log, reviews, tally, reader, ai, warnings, now, eventId }
function reviewGym(input) {
  const i = input || {};
  const now = i.now || Date.now();
  const row = i.row || {};
  const items = [];
  const dot = t => (t && !/[.!?)]$/.test(String(t).trim()) ? String(t).trim() + '.' : t);
  const add = (level, title, detail, fix, area) => items.push({ level, title, detail: dot(detail), fix: dot(fix) || null, area: area || 'general' });
  const real = (i.log || []).filter(e => e && !e.systemEvent && !e.capReached && e.mode !== 'wall' && !e.test);
  const recent = real.filter(e => now - Date.parse(e.timestamp || e.capturedAt) < 48 * 3600e3);
  const kinds = recent.reduce((m, e) => { const k = kindOf(e); m[k] = (m[k] || 0) + 1; return m; }, {});
  const total = recent.length;

  // 1. Is it watching at all?
  const st = row.state;
  const ago = t => { const m = Math.round((now - Date.parse(t)) / 60e3); return !t || isNaN(m) ? 'unknown' : m < 90 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  if (st === 'offline') add('red', 'Camera computer offline', `Last check-in ${ago(row.runner && row.runner.lastSeen)}. Nothing is watched until it is back.`, 'Check the Pi/laptop has power and internet. It restarts itself when it can.', 'camera');
  else if (st === 'no-picture') add('red', 'No camera picture', 'The camera computer is on but gets no picture from the recorder.', 'Check the recorder is on and the network cable is in. Admin page > this gym shows the exact error.', 'camera');
  else if (st === 'problem') add('red', 'Watching stopped', (row.monitoring && row.monitoring.problem) || 'The camera computer reported a problem.', 'See the camera computer card on the admin page.', 'camera');
  else if (st === 'not-paired') add('red', 'Camera computer not paired', 'The website refused it after a new pairing.', 'Pair it again: admin page > Connect a camera computer.', 'camera');
  else if (st === 'not-connected') add('amber', 'No camera computer yet', 'Nothing has checked in for this gym.', 'Set up the Pi (PI-SETUP.md).', 'camera');
  const tampered = ((row.runner && row.runner.zones) || []).filter(z => (z.warnings || []).length);
  if (tampered.length) add('amber', 'Camera warnings', tampered.map(z => `${z.label}: ${z.warnings.slice(0, 2).join('; ')}`).join(' · '), 'Look at a photo from the camera on the gym page.', 'camera');

  // 2. Accuracy, from what staff marked (never changed automatically).
  const t = i.tally || {};
  if ((t.overrides || 0) >= 3) add('amber', `${t.overrides} staff answers went against the camera and the scans`, 'Marked "It was fine" although the camera and the front-desk scans both showed an extra person. They are left out of the accuracy numbers until the owner checks them (Second look on the gym page).', 'Ask the owner to go through Second look.', 'accuracy');
  if (t.flagsChecked >= 5) {
    const real_ = pct(t.flagsConfirmed, t.flagsChecked);
    if (real_ < 50) add('amber', `Only ${real_}% of red flags were real`, `${t.flagsConfirmed} of ${t.flagsChecked} checked red flags were confirmed; the rest were marked "It was fine".`, 'Open 3 of the "fine" ones and look for one cause (staff walking in, a member holding the door for a child, glare). Tell TJ: he decides whether to change anything. Detection is never loosened by itself.', 'accuracy');
    else add('info', `${real_}% of red flags were real`, `${t.flagsConfirmed} of ${t.flagsChecked} checked red flags were confirmed.`, null, 'accuracy');
  } else if (t.cameraFlagged >= 3 && (t.flagsChecked || 0) < 2) {
    add('amber', 'Flags aren\'t being checked', `${plural(t.cameraFlagged, 'flag')} so far, ${t.flagsChecked || 0} checked by staff. Without checks there is no proof of what was caught, and no way to learn what to improve.`, 'Ask the morning staff to open the gym page and tap an answer on each red entry (about a minute).', 'staff');
  }
  // Misses found by the weekly spot-check (the camera said normal).
  if (t.spotChecked >= 10 && t.spotMissed / t.spotChecked > 0.05) add('red', `The camera missed ${t.spotMissed} of ${t.spotChecked} spot-checked entries`, 'Staff found people who got in without paying on entries the camera called normal.', 'Look at the missed ones with Claude: usually the camera angle, the watched box, or light. Detection is only changed by a person.', 'accuracy');
  else if (t.spotChecked >= 10) add('info', `Spot-checks: ${t.spotMissed || 0} misses in ${t.spotChecked}`, 'Normal entries checked by staff found the camera reliable.', null, 'accuracy');
  const reviews = i.reviews || {};
  // Learning from "It was fine": what staff wrote when a flag was wrong.
  // Suggestions only: detection is never loosened by itself.
  const FINE_GROUPS = [
    { re: /\b(staff|employee|trainer|coach|manager|front desk|worker|cleaner|janitor)\b/i, what: 'staff coming through', fix: 'If staff enter through the turnstile without scanning, ask them to scan too (or to use another door); that removes these flags for free.' },
    { re: /\b(kid|kids|child|children|son|daughter|baby|toddler|stroller)\b/i, what: 'children with a parent', fix: 'Decide the gym\'s rule for children. If children may enter free with a parent, tell TJ: he can change how these are shown (never by itself).' },
    { re: /\b(delivery|vendor|repair|maintenance|contractor|plumber|technician)\b/i, what: 'deliveries and contractors', fix: 'Ask visitors on business to use the staff entrance, or to be let in by staff at the desk.' },
    { re: /\b(same person|left and came back|forgot|went back|re-?entered|came back)\b/i, what: 'the same person going back out and in', fix: 'Nothing to change: these are quick to mark. If it happens a lot, tell TJ.' },
    { re: /\b(guest|day pass|paid|bought)\b/i, what: 'guests who had paid', fix: 'Have the front desk scan day passes at the turnstile so the scan count matches.' },
  ];
  const fineNotes = Object.values(reviews).filter(r => r && r.verdict === 'fine' && r.note);
  for (const g of FINE_GROUPS) {
    const n = fineNotes.filter(r => g.re.test(r.note)).length;
    if (n >= 3) add('info', `${n} flags marked fine were ${g.what}`, 'From the notes staff wrote on "It was fine".', g.fix, 'learning');
  }
  const idOf = i.eventId || (e => e.id);
  const stale = recent.filter(e => ['flag', 'possible'].includes(kindOf(e)) && !reviews[idOf(e)] && now - Date.parse(e.timestamp) > 24 * 3600e3);
  if (stale.length) add('amber', `${plural(stale.length, 'red flag')} waiting over a day`, 'Photos are deleted after 48 hours; unchecked flags then can\'t be proven.', 'Remind staff, or check them yourself on the gym page.', 'staff');
  if (t.toFollowUp > 0) add('info', `${plural(t.toFollowUp, 'confirmed tailgate')} with no follow-up yet`, 'Nobody has said what happened next (charged, talked to them...).', 'On the gym page, open the confirmed entry and pick what happened. This is what shows the owner the money recovered.', 'staff');

  // 3. Usage: checks that found nobody coming in cost money and catch nothing.
  const waste = (kinds.none || 0) + (kinds.out || 0);
  if (total >= 20 && pct(waste, total) >= 25) {
    const fixes = [];
    if ((kinds.out || 0) >= waste * 0.25) fixes.push('Set which way is IN on the camera computer (node rtsp-run.js --entry left|right|up|down) so people leaving are skipped for free.');
    if ((kinds.none || 0) >= waste * 0.25) fixes.push('Redraw the watched box tighter around the turnstile (node setup-camera.js), away from windows and the walkway, so passing shadows and lights are ignored for free.');
    add('amber', `${pct(waste, total)}% of AI checks found nobody coming in`, `${kinds.none || 0} were movement with nobody entering, ${kinds.out || 0} were people leaving (last 48 h, of ${total} checks). Each one costs about a cent and catches nothing.`, fixes.join(' '), 'usage');
  }
  const cap = row.monitoring && row.monitoring.dailyBurstCap;
  const used = row.last24h && row.last24h.bursts;
  if (cap && used != null && used >= cap * 0.8) add(used >= cap ? 'red' : 'amber', used >= cap ? 'Daily AI limit reached' : 'Close to the daily AI limit', `${used} of ${cap} checks in the last 24 hours. Past the limit, entries are not checked.`, 'If it was a busy day, raise the daily limit (admin page > Settings). If not, look for wasted checks above.', 'usage');

  // 4. Failures.
  if (kinds.unchecked) add(kinds.unchecked >= 3 ? 'red' : 'amber', `${plural(kinds.unchecked, 'entry', 'entries')} couldn't be checked`, (recent.find(e => e.error) || {}).error || 'The AI check failed.', 'Usually Anthropic being busy (the backup model covers most of it) or the API credit running out: check console.anthropic.com > Billing.', 'ai');
  const ai = i.ai || {};
  if (ai.backupAnswers) add('info', `Backup AI model answered ${plural(ai.backupAnswers, 'check')}`, 'The main model was busy; the backup took over, so nothing was missed.', null, 'ai');

  // 5. Front-desk reader.
  const rd = i.reader;
  if (rd && rd.lastSeen) {
    const age = now - Date.parse(rd.lastSeen);
    if (rd.problem) add('amber', 'Front-desk reader problem', rd.problem, rd.fix || null, 'reader');
    else if (age > 2 * 3600e3 && st === 'watching') add('amber', 'Front-desk reader quiet', `Last heard from ${Math.round(age / 3600e3)} h ago while the camera is watching.`, 'Check the Pi\'s capture stick and the front-desk screen.', 'reader');
    const c = rd.counts || {};
    if ((c.scans || 0) >= 20 && pct(c.conflicts || 0, c.scans) >= 10) add('amber', `${pct(c.conflicts, c.scans)}% of screen reads disagreed`, 'The pop-up and the Visit Log showed different numbers. Those entries say "likely", never "certain".', 'Make the Live Entry pop-up bigger on the front-desk screen, or check the capture is 1080p.', 'reader');
  }

  // 6. Nightly self-test: a confirmed tailgate checked again by today's AI.
  const tst = i.selfTest;
  if (tst && tst.last) {
    const l = tst.last;
    if (l.error) add(tst.failedInARow >= 2 ? 'red' : 'amber', 'Nightly self-test could not run', l.error, 'Usually the Anthropic key or credit: check console.anthropic.com > Billing and the ANTHROPIC_API_KEY on Render.', 'ai');
    else if (!l.pass) add(tst.failedInARow >= 2 ? 'red' : 'amber', 'Nightly self-test: a known tailgate was missed', `A tailgate staff confirmed (${l.seen ? new Date(l.seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : 'earlier'}) was checked again and the AI now says ${l.people == null ? 'it is fine' : l.people + ' ' + (l.people === 1 ? 'person' : 'people')}. ${tst.failedInARow >= 2 ? 'It has happened ' + tst.failedInARow + ' days in a row.' : 'Once can be a borderline photo.'}`, 'Tell Claude: the model or the instructions may have changed. Nothing is changed automatically.', 'accuracy');
    else add('info', 'Nightly self-test passed', `The AI still catches the confirmed tailgates (${tst.passed} of ${tst.runs} checks passed).`, null, 'accuracy');
  }

  // 7. Self-repair: features it paused, fixes waiting for TJ.
  const rp = i.repair;
  if (rp) {
    for (const f of rp.paused || []) add('amber', `Paused by self-repair: ${f}`, 'It kept failing, so it was paused to keep everything else running. Watching the doors is not affected.', 'See Self-repair on the admin page: approve the fix, or Undo to turn it back on.', 'repair');
    const waiting = (rp.repairs || []).filter(x => x.status === 'proposed' || x.status === 'proposed-manual');
    if (waiting.length) add('info', `${plural(waiting.length, 'tested change')} waiting for you`, waiting.map(x => x.fix || x.what).slice(0, 2).join(' · '), 'Approve or reject it from the email or the admin page.', 'repair');
  }

  // 8. Self-update on the camera computer.
  const up = row.runner && row.runner.update;
  if (up && up.lastRollback && now - Date.parse(up.lastRollback.at) < 7 * 864e5) add('amber', 'A program update was rolled back', `Version ${up.lastRollback.version}: ${up.lastRollback.reason}. The camera computer kept watching on the old version.`, 'Fix and deploy again; it updates itself when the door is quiet.', 'camera');

  const score = Math.max(0, 100 - items.reduce((n, x) => n + (LEVEL_COST[x.level] || 0), 0));
  const grade = score >= 90 ? 'Excellent' : score >= 75 ? 'Good' : score >= 50 ? 'Needs attention' : 'Something\'s wrong';
  const order = { red: 0, amber: 1, info: 2 };
  items.sort((a, b) => order[a.level] - order[b.level]);
  return { name: i.name || row.name || null, score, grade, items, checks48h: total, kinds, at: new Date(now).toISOString() };
}

// The weekly email: every gym, worst first. Plain text and simple HTML.
function weeklyEmail(reviews, site) {
  const list = reviews.slice().sort((a, b) => a.score - b.score);
  const worst = list[0];
  const subject = !list.length ? 'SecurityAI weekly self-check'
    : list.every(r => r.score >= 90) ? `SecurityAI weekly self-check: all good (${list.map(r => r.score).join(', ')})`
    : `SecurityAI weekly self-check: ${worst.name} ${worst.score}/100 (${worst.grade.toLowerCase()})`;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const txt = [];
  const html = [`<div style="font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111;max-width:620px">`, `<p>What SecurityAI thinks needs doing, from its own numbers. It only suggests: nothing that could make it miss someone is changed by itself.</p>`];
  for (const r of list) {
    txt.push(`${r.name}: ${r.score}/100 (${r.grade})`);
    html.push(`<h2 style="font-size:18px;margin:18px 0 4px">${esc(r.name)}: ${r.score}/100 <span style="color:#666;font-weight:400">${esc(r.grade)}</span></h2>`);
    const todo = r.items.filter(x => x.level !== 'info');
    if (!todo.length) { txt.push('  Nothing to do.'); html.push('<p style="margin:0;color:#2a7">Nothing to do.</p>'); }
    for (const x of r.items) {
      txt.push(`  ${x.level === 'red' ? '!!' : x.level === 'amber' ? '! ' : '- '} ${x.title}. ${x.detail}${x.fix ? ' Fix: ' + x.fix : ''}`);
      html.push(`<p style="margin:6px 0;border-left:3px solid ${x.level === 'red' ? '#d33' : x.level === 'amber' ? '#e90' : '#2a7'};padding-left:8px"><b>${esc(x.title)}.</b> ${esc(x.detail)}${x.fix ? `<br><i>What to do:</i> ${esc(x.fix)}` : ''}</p>`);
    }
  }
  if (site) { txt.push('', `Admin page: ${site}/admin`); html.push(`<p><a href="${esc(site)}/admin">Open the admin page</a></p>`); }
  html.push('</div>');
  return { subject, text: txt.join('\n'), html: html.join('\n') };
}

module.exports = { reviewGym, weeklyEmail, kindOf };
