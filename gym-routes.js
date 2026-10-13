// Customer-facing routes: what a gym sees on activity.html, and the
// read-only endpoints monitor.html / admin.html already use.
//
// ACCESS RULES (one function, viewerFor, decides every request):
//   - Operator: a valid X-Admin-Token header. Sees everything, can pick a
//     gym with ?code=.
//   - Gym: the signed "remember this device" cookie set by /gym/sign-in.
//     Sees ONLY its own gym — log, photos, reviews, alert list, report.
//   - No gym codes configured at all (single-gym pilot, or the camera
//     laptop's local mode): open, as before, for the gym being monitored.
//   - Anyone else: nothing but "a code is needed".
// Photos are behind the same rule, so a guessed photo URL is a 404.
//
// mount(app, deps) is called from server.js at the point these routes
// used to be defined, so route order is unchanged.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const monitor = require('./monitor');
const gyms = require('./gyms');
const report = require('./report');
const mailer = require('./mailer');
const store = require('./gym-store');

function sameSecret(given, expected) {
  if (!given || !expected) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}
function isOperator(req) {
  return require('./admin-auth').isAdmin(req);
}
function clientKey(req) {
  // Behind Render's proxy the real client is the LAST X-Forwarded-For
  // entry (the one the proxy added); earlier ones can be forged to dodge
  // the rate limits.
  const xff = String(req.get('X-Forwarded-For') || '').split(',').map(x => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : (req.socket && req.socket.remoteAddress) || req.ip || 'unknown';
}

function mount(app, deps) {
  // deps: { runnerFor(code) -> raw record|null, runnerForStatus(status),
  //         runnerPublicView(rec), runnerOperatorView(rec), runnerIsOnline(rec) }

  // The gym to show when none is named (open mode / operator default):
  // the primary gym if it is being watched, else the camera computer that
  // checked in most recently, else the primary gym.
  function currentGym() {
    const k = monitor.defaultKey();
    if (monitor.getStatus(k).running) return k;
    const rec = deps.runnerForStatus(null);
    return rec ? monitor.safeCode(rec.gymCode) : k;
  }
  // A gym named by the operator (?code= / ?gym=): its code or its key.
  function operatorGym(q) {
    return gyms.resolveKey(q) || monitor.safeCode(q);
  }

  function viewerFor(req) {
    if (isOperator(req)) {
      const q = req.query && (req.query.code || req.query.gym);
      return { code: q ? operatorGym(q) : currentGym(), operator: true };
    }
    if (!gyms.anyCodesConfigured()) {
      // No ADMIN_TOKEN and no codes: a local pilot. Treat as operator for
      // the operator-only extras, exactly as the old status route did.
      return { code: currentGym(), open: true, operator: !process.env.ADMIN_TOKEN };
    }
    // The cookie holds the sign-in code it was made with; it only works
    // while that is still the gym's CURRENT code (see "new code").
    const c = store.codeFromRequest(req);
    if (c && gyms.isValidCode(c)) return { code: gyms.resolveKey(c) || c, gym: true };
    return null;
  }
  function needViewer(req, res) {
    const v = viewerFor(req);
    if (!v) res.status(401).json({ error: 'Enter your gym code to see this.', codeRequired: true });
    return v;
  }

  // ---- What time to show for an event ---------------------------------
  // The camera computer's capture time lines up with check-in records, but
  // a recorder clock that runs fast (this site's is ~1 h ahead) would put
  // events in the future. A capture time LATER than when we analysed it is
  // impossible, so fall back to the analysis time. An earlier one is
  // normal (a queued event re-sent after an outage).
  function eventTime(e) {
    const t = Date.parse(e && e.timestamp);
    const c = Date.parse(e && e.capturedAt);
    if (!isNaN(c) && (isNaN(t) || c <= t + 2 * 60 * 1000)) return new Date(c).toISOString();
    return isNaN(t) ? null : new Date(t).toISOString();
  }

  function kindOf(e) {
    if (e.error) return 'unchecked';
    if (e.went_out === true && !e.phone_handoff) return 'out';      // someone leaving (exit button): never needs a scan
    // Movement with nobody coming in (a shadow, a light, someone walking
    // past): never something for the gym to check, whatever the confidence.
    if (Number(e.people_count) === 0 && !e.tailgate_flag && !e.phone_handoff && !e.error) return 'none';
    if (e.tailgate_flag) return e.confidence === 'low' ? 'possible' : 'flag';
    if (e.accessible_gate_used) return 'gate';
    // Not flagged, but worth a human glance rather than a green "Passed":
    // the AI wasn't fully sure, counted more people than one swipe allows
    // without calling it a tailgate, or saw someone waiting at the gate as
    // another went through (how most tailgates start).
    const n = Number(e.people_count), exp = Number(e.expectedCount) || 1;
    // Doubt about the COUNT, not about the picture: newer answers say
    // whether a second person can't be ruled out. "Medium" confidence on a
    // clear single person (dark, blurry, wide-angle) is a normal entry.
    if (typeof e.second_person_possible === 'boolean') {
      if (e.second_person_possible || e.confidence === 'low') return 'check';
    } else if (e.confidence && e.confidence !== 'high') return 'check';   // older entries
    if (Number.isFinite(n) && n > exp) return 'check';
    if (Number(e.queued_count) > 0) return 'check';
    if (Number(e.lingerSec) >= 12) return 'check';   // came in after someone hung around the gate
    return 'ok';
  }

  // Plain-words version of an entry for the gym. No costs, no model, no
  // error text, no alert-delivery detail — just what happened.
  function scanWindow(e) {
    const at = Date.parse(eventTime(e));
    if (isNaN(at)) return { scanFrom: null, scanTo: null };
    const dur = Math.min(60, Math.max(2, Number(e.durationSec) || 8));
    return { scanFrom: new Date(at - 15e3).toISOString(), scanTo: new Date(at + (dur + 10) * 1e3).toISOString() };
  }
  function gymEvent(e, reviews, keptIds) {
    const id = store.eventId(e);
    const photos = [];
    const add = f => { if (f && !photos.includes(f)) photos.push(f); };
    add(e.frame);
    (e.frames || []).forEach(add);
    const n = Number(e.people_count);
    return {
      id,
      at: eventTime(e),
      zone: e.zoneLabel || null,
      kind: kindOf(e),
      people: (e.people_count === null || e.people_count === undefined || e.people_count === '' || !Number.isFinite(n)) ? null : n,
      expected: Number(e.expectedCount) || 1,
      waiting: Number(e.queued_count) || 0,
      lingerSec: Number(e.lingerSec) || 0,
      // When to look in the check-in system: from just before the crossing
      // started until just after it ended (both in true time).
      ...scanWindow(e),
      phoneHandoff: !!e.phone_handoff,
      samePerson: typeof e.same_person === 'boolean' ? e.same_person : null,   // vs the earlier entry on the same code
      repeatOfEvent: e.repeatOfEvent || null,
      person: e.person || null,
      // Not an entry that needs a scan: someone leaving, or nobody came in.
      notEntry: e.went_out === true || Number(e.people_count) === 0,
      turns: Number.isInteger(e.turns) && e.turns >= 1 ? e.turns : 1,
      extraOnTurn: Number.isInteger(e.extra_on_turn) ? e.extra_on_turn : null,
      durationSec: Number(e.durationSec) || null,
      pictureClockOffsetMin: Number.isFinite(e.pictureClockOffsetMin) ? e.pictureClockOffsetMin : null,
      secondPossible: e.second_person_possible === true,
      beforeSec: e.beforeCount ? (Number(e.beforeSec) || 0) : null,   // first photos taken this long before the crossing
      note: e.error ? null : (e.note || null),
      photos: photos.slice(0, 9),
      beforeIdx: photos.slice(0, 9).map((f, i) => /-b\d+\.jpg$/.test(f) ? i : -1).filter(i => i >= 0),   // the larger copy + up to 2 earlier turnstile photos + up to 6 analysed photos
      review: reviews[id] || null,
      // When this event and its photos will be deleted: 48 h after it,
      // unless it was flagged or marked Tailgate (then 35 days).
      keptUntil: keptIds ? new Date((Date.parse(e.timestamp) || Date.now()) + (keptIds.has(id) ? monitor.SUMMARY_RETENTION_MS : monitor.LOG_RETENTION_HOURS * 3600e3)).toISOString() : undefined,
    };
  }
  // ---- Scans vs people (the front-desk reader's scan TIMES; no member
  // data is needed or read). Each entry takes the scans made just before
  // and while it came through, in order, up to the number it needs. Then:
  //   fewer scans than people  -> red, confirmed by the count
  //   as many scans as people  -> a doubtful entry is cleared (unless a
  //                               second person couldn't be ruled out)
  //   no scan at all           -> worth a check (exit button, door held...)
  // Only for moments the reader was running; otherwise nothing changes.
  function applyScanCheck(code, events) {
    let memberKeys;
    try { memberKeys = require('./member-keys'); } catch (e) { return; }
    const entries = events.filter(e => e.kind !== 'gate' && e.kind !== 'out' && e.kind !== 'none' && !e.notEntry && e.people != null)
      .slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (!entries.length) return;
    const t0 = Date.parse(entries[0].at) - 5 * 3600e3, t1 = Date.parse(entries[entries.length - 1].at) + 120e3;
    const scans = memberKeys.scanList(code, t0, t1);
    const scanById = new Map(scans.map(s => [s.id, s]));
    const eventByScan = new Map();
    const endOf = e => Date.parse(e.at) + (Math.min(12, Math.max(2, Number(e.durationSec) || 4)) + 3) * 1e3;
    const need = e => Math.max(e.people, e.turns || 1);
    // Entries close together form a group; the group is CERTAIN when its
    // scans and the scans it needs come out exactly equal.
    const groups = [];
    for (const e of entries) {
      const g = groups[groups.length - 1];
      if (g && Date.parse(e.at) - 8e3 <= g.end + 2e3) { g.list.push(e); g.end = Math.max(g.end, endOf(e)); }
      else groups.push({ list: [e], start: Date.parse(e.at) - 8e3, end: endOf(e) });
    }
    const used = new Set();
    for (const g of groups) {
      if (!memberKeys.readerCovered(code, g.start + 8e3)) continue;
      const inGroup = scans.filter(s => s.t >= g.start && s.t <= g.end);
      const certain = inGroup.length === g.list.reduce((n, e) => n + Math.min(need(e), e.people), 0)
        || inGroup.length === g.list.reduce((n, e) => n + (e.turns || 1), 0);
      for (const e of g.list) {
        const at = Date.parse(e.at), end = endOf(e);
        const ids = [];
        for (const s of scans) {
          if (ids.length >= need(e)) break;
          if (used.has(s.id) || s.t < at - 8e3 || s.t > end) continue;
          used.add(s.id); ids.push(s.id);
        }
        const found = ids.length;
        e.scanCheck = { scans: found, people: e.people, ids, certain };
        for (const id of ids) eventByScan.set(id, e);
        // The same member's code came in earlier too (a few minutes to hours
        // before): possibly a shared code, even with no hand-off on camera.
        const rep = ids.map(id => scanById.get(id)).find(s => s && s.repeat);
        if (rep) {
          const prevScan = scanById.get(rep.repeat.prev);
          const prevEvent = eventByScan.get(rep.repeat.prev);
          e.scanCheck.repeat = { mins: rep.repeat.mins, prevAt: prevScan ? new Date(prevScan.t).toISOString() : null, prevEvent: prevEvent ? prevEvent.id : null };
        }
        if (e.review) continue;                            // the gym already decided
        if (e.scanCheck.repeat) {
          // Same code earlier. Same-looking person = left and came back
          // (normal). Different-looking or unsure = worth a check; when the
          // camera says different, the earlier entry is marked too.
          const r = e.scanCheck.repeat;
          r.same = e.samePerson;
          if (!r.prevEvent && e.repeatOfEvent) r.prevEvent = e.repeatOfEvent;
          if (e.samePerson !== true && e.kind === 'ok') e.kind = 'check';
          if (e.samePerson === false && r.prevEvent) {
            const prev = events.find(x => x.id === r.prevEvent);
            if (prev && !prev.review) {
              prev.scanCheck = Object.assign({}, prev.scanCheck || {}, { repeatLater: { mins: r.mins, laterEvent: e.id } });
              if (prev.kind === 'ok') prev.kind = 'check';
            }
          }
        }
        if (e.phoneHandoff) continue;                      // a shared code scans normally: the count can't clear it
        if (found < e.people) {
          if (found === 0 && e.people === 1) {
          // Only when the reader was clearly working right then (other scans
          // within 20 minutes): a quiet or restarting reader is not a reason
          // to put an entry in front of the gym.
          const busy = scans.some(x => Math.abs(x.t - at) <= 20 * 60e3);
          if (busy) { e.scanCheck.noScan = true; if (e.kind === 'ok') e.kind = 'check'; } else delete e.scanCheck;
        }
          else { e.scanCheck.short = true; e.kind = 'flag'; }
        } else if (e.kind === 'flag') { e.scanCheck.matched = true; e.kind = 'check'; }      // flagged, but everyone scanned
        else if ((e.kind === 'check' || e.kind === 'possible') && !e.secondPossible && !(e.scanCheck.repeat && e.samePerson !== true)) { e.scanCheck.matched = true; e.kind = 'ok'; }
        else e.scanCheck.matched = true;
      }
    }
  }
  // ---- Hourly cross-check: do the camera and the front-desk reader agree?
  // Over the last hour (only while both were running):
  //   many entries with no scan   -> the reader may be missing pop-ups
  //   many scans with no entry    -> the camera may be missing people
  // TJ gets an email saying what was seen and how to fix it (6 h apart at most).
  const crossAlerted = new Map();
  function crossCheck() {
    let memberKeys; try { memberKeys = require('./member-keys'); } catch (e) { return; }
    for (const s of monitor.listStates ? monitor.listStates() : []) {
      const code = s.key || s;
      try {
        if (!monitor.watchingNow(code)) continue;
        const now = Date.now(), from = now - 3600e3;
        if (!memberKeys.readerCovered(code, from) || !memberKeys.readerCovered(code, now)) continue;
        const events = monitor.getLogFor(code).filter(e => e && !e.systemEvent && !e.capReached && e.mode !== 'wall')
          .map(e => gymEvent(e, {}, null)).filter(e => Date.parse(e.at) >= from - 120e3);
        applyScanCheck(code, events);
        // Every camera entry in the hour counts, including ones the matching
        // left alone: a reader that is running but sees NO pop-ups is the
        // very thing to catch.
        const entries = events.filter(e => Date.parse(e.at) >= from && e.kind !== 'gate' && e.kind !== 'out' && e.kind !== 'none' && !e.notEntry && e.people >= 1);
        const noScan = entries.filter(e => !e.scanCheck || !e.scanCheck.scans).length;
        const used = new Set(); events.forEach(e => (e.scanCheck && e.scanCheck.ids || []).forEach(id => used.add(id)));
        const scans = memberKeys.scanList(code, from, now - 60e3);
        const orphan = scans.filter(x => !used.has(x.id)).length;
        const send = (kind, subject, text) => {
          const k = code + '|' + kind;
          if (crossAlerted.has(k) && now - crossAlerted.get(k) < 6 * 3600e3) return;
          crossAlerted.set(k, now);
          monitor.alertOperator(code, kind, subject, text).catch(() => {});
        };
        if (entries.length >= 5 && noScan / entries.length >= 0.4) {
          send('cross-no-scan', 'scans and entries don\'t line up', `in the last hour the camera saw ${entries.length} entries, but ${noScan} had no scan from the front-desk reader.\n\nEither the reader is missing Ashbourne's Live Entry pop-ups, or people are really getting in without scanning.\n\nHow to tell: open the activity page and look at those entries (they're in "Worth a check" as "no scan found"). If the photos show normal entries with people scanning, the reader is missing pop-ups: on the Ashbourne PC make sure the Live Entry pop-up still shows on each scan, then run the screen check again (admin page) and send it to Claude. If the photos show people pushing through without scanning, it's real.`);
        }
        if (scans.length >= 5 && orphan / scans.length >= 0.4) {
          send('cross-no-entry', 'scans without camera entries', `in the last hour the front desk recorded ${scans.length} Zone 1 scans, but ${orphan} had no matching entry from the camera.\n\nThe camera may be missing people (covered, moved, a bad picture, or its laptop asleep), or people scanned and didn't come through.\n\nHow to fix: on the camera laptop run  node rtsp-run.js  and walk through the turnstile: each entry should show "crossing detected". If it doesn't, check the camera picture (node rtsp-run.js --check) and that the laptop isn't asleep. Then tell Claude what you saw.`);
        }
      } catch (e) { /* next gym */ }
    }
  }
  module.exports._crossCheck = crossCheck;   // for tests
  const crossTimer = setInterval(crossCheck, 15 * 60e3);
  if (crossTimer.unref) crossTimer.unref();

  function keptIdSet(code) { return new Set(monitor.loadSummary(code).map(e => store.eventId(e))); }

  function findEvent(code, id) {
    const want = String(id || '');
    if (!want) return null;
    const inLog = monitor.getLogFor(code).find(e => e && !e.systemEvent && store.eventId(e) === want);
    if (inLog) return inLog;
    const kept = monitor.loadSummary(code).find(e => e && store.eventId(e) === want);
    // Older 35-day copies of flagged events don't carry tailgate_flag.
    return kept ? Object.assign({ tailgate_flag: true, mode: 'entry' }, kept) : null;
  }

  // ---- The gym's status in plain words ---------------------------------
  function gymStatus(code) {
    const st = monitor.getStatus(code);
    const watchingThis = st.running;
    const rec = deps.runnerFor(code);
    const cfg = Object.assign({}, (rec && rec.config) || (watchingThis ? st.config : null) || {});
    // Watch hours set on the website win over the camera computer's, the
    // same way monitor.effectiveRunnerConfig applies them.
    let set = {};
    try { set = store.getSettings(code) || {}; } catch (e) { /* no settings yet */ }
    if (set.scheduleStart && set.scheduleEnd) {
      cfg.scheduleStart = set.scheduleStart;
      cfg.scheduleEnd = set.scheduleEnd;
      try { cfg.timeZone = gyms.timeZoneFor(code); } catch (e) { /* fall back to runner offset */ }
    }
    // 00:00-00:00 means "all day": no hours to show (not "12:00 AM - 12:00 AM").
    const schedule = (cfg.scheduleStart && cfg.scheduleEnd && cfg.scheduleStart !== cfg.scheduleEnd) ? { start: cfg.scheduleStart, end: cfg.scheduleEnd } : null;
    const inWindow = monitor.isWithinSchedule(cfg);
    let state, since = null;
    const zones = rec ? (rec.zones || []).map(z => ({ label: z.label, ok: z.streamOk === true, tamper: z.tamper || null, picture: deps.zonePicture ? deps.zonePicture(z) : (z.streamOk ? 'ok' : 'no-picture') })) : [];
    if (rec && !deps.runnerIsOnline(rec)) { state = 'offline'; since = rec.lastSeen ? new Date(rec.lastSeen).toISOString() : null; }
    else if (st.stoppedByOperator && !st.running) state = 'paused';
    else if (rec) {
      // Checking in, but the server can't act on its events (for example
      // it is busy monitoring a different gym). Not the gym's problem to
      // fix, but it must not read as "Watching".
      if (rec.monitorProblem) state = 'problem';
      else if (zones.some(z => z.picture === 'no-picture')) state = 'no-picture';
      else if (zones.some(z => z.tamper)) state = 'tamper';
      else if (zones.some(z => z.picture === 'starting')) state = 'starting';
      else if (!inWindow) state = 'off-hours';
      else state = 'watching';
    } else if (watchingThis) {
      if (st.heartbeatLost) state = 'offline';
      else state = st.withinSchedule === false ? 'off-hours' : 'watching';
    } else {
      // Nothing has checked in since this server started. For a gym with
      // recent events that's almost always a restart the camera computer
      // hasn't caught up with yet (it checks in every 30 s).
      // After a few minutes it isn't a restart any more: say it's offline.
      const recent = monitor.getLogFor(code).some(e => Date.now() - Date.parse(e.timestamp) < 48 * 3600e3);
      if (!recent) state = 'not-set-up';
      else state = process.uptime() < 180 ? 'connecting' : 'offline';
    }
    const settings = store.getSettings(code);
    return {
      name: gyms.gymNameFor(code),
      timeZone: gyms.timeZoneFor(code),
      state, since, schedule, zones,
      retentionHours: st.logRetentionHours,
      keptDays: Math.round(monitor.SUMMARY_RETENTION_MS / 864e5),
      // "Camera clock runs about 1 hour fast" — shown under each photo.
      cameraClockNote: settings.cameraClockNote || null,
      checkinSystem: settings.checkinSystem || null,
      checkinZone: settings.checkinZone || null,
      checkinClockOffsetSec: Number(settings.checkinClockOffsetSec) || 0,
      // How far off the clock printed on the camera picture usually is (the
      // model reads it on every check): the middle of the latest readings.
      pictureClockOffsetMin: (() => {
        const v = monitor.getLogFor(code).map(e => e && e.pictureClockOffsetMin).filter(x => Number.isFinite(x)).slice(0, 15).sort((a, b) => a - b);
        return v.length ? v[Math.floor(v.length / 2)] : null;
      })(),
    };
  }

  // ---- Status ----------------------------------------------------------
  // Operators get the full object (cost, model, config, host). Gyms get
  // their own gym's state. Anonymous callers, when codes are in use, get
  // only whether monitoring is on — and never the gym code, which used to
  // be here and is exactly what unlocks the photos.
  function redactStatus(full, code) {
    const cfg = full.config || {};
    const detail = global.__securityaiIngest || null;
    return {
      running: full.running,
      withinSchedule: full.withinSchedule,
      logRetentionHours: full.logRetentionHours,
      heartbeatLost: full.heartbeatLost,
      ingestMode: !!detail,
      ingestDetail: detail ? { transports: (detail.transports || []).map(t => String(t).replace(/\s*\([^)]*\)/, '')) } : null,
      config: { scheduleStart: cfg.scheduleStart || null, scheduleEnd: cfg.scheduleEnd || null },
      capacityUsedPct: (full.dailyBurstCap && typeof full.burstsLast24h === 'number')
        ? Math.round((full.burstsLast24h / full.dailyBurstCap) * 100) : null,
      pausedFromWebsite: !!full.stoppedByOperator,
      runner: full.runner || null,
      gym: gymStatus(code),
      signedIn: true,
    };
  }

  app.get('/monitor/status', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = viewerFor(req);
    const base = monitor.getStatus(v ? v.code : undefined);
    if (!v) {
      return res.json({ codeRequired: true, signedIn: false, logRetentionHours: base.logRetentionHours });
    }
    const rec = deps.runnerFor(v.code);
    const scoped = monitor.getStatus(v.code);
    const full = Object.assign({}, scoped, {
      ingestMode: !!global.__securityaiIngest,
      ingestDetail: global.__securityaiIngest || null,
      runner: rec ? deps.runnerPublicView(rec) : null,
      runnerDetail: rec ? deps.runnerOperatorView(rec) : null,
    });
    if (v.operator) return res.json(Object.assign(full, { gym: gymStatus(v.code), signedIn: true }));
    const out = redactStatus(full, v.code);
    out.codeRequired = !v.open;
    res.json(out);
  });

  // ---- Log (raw shape, kept for monitor.html / admin tools) -----------
  app.get('/monitor/log', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = needViewer(req, res);
    if (!v) return;
    const reviews = store.loadReviews(v.code);
    const log = monitor.getLogFor(v.code).map(e => {
      const id = store.eventId(e);
      const out = Object.assign({}, e, { id, review: reviews[id] || null });
      if (!v.operator) {
        delete out.alertResult;                      // operator's delivery detail
        if (out.error) out.error = 'Could not be checked automatically';
      }
      return out;
    });
    res.json(log);
  });

  // ---- The gym's activity page data -----------------------------------
  app.get('/gym/activity', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = needViewer(req, res);
    if (!v) return;
    const reviews = store.loadReviews(v.code);
    const kept = keptIdSet(v.code);
    // System notices (monitoring stopped/resumed, daily limit reached) are
    // operator business; the status line covers what the gym needs.
    const events = monitor.getLogFor(v.code)
      .filter(e => e && !e.systemEvent && !e.capReached && e.mode !== 'wall')
      .map(e => gymEvent(e, reviews, kept))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    try { applyScanCheck(v.code, events); } catch (err) { /* a nicety on top */ }
    const r = monitor.buildReport(v.code, 30);
    // Reviews made before the tally existed (or on another device): add them.
    try {
      const t = store.loadTally(v.code);
      for (const ev of events) if (ev.review && (!t.outcomes[ev.id] || t.outcomes[ev.id].verdict !== ev.review.verdict)) store.tallyReview(v.code, ev.id, ev.review.verdict, ev);
    } catch (err) { /* nicety */ }
    res.json({
      results: store.tallySummary(v.code),
      gym: gymStatus(v.code),
      gymCode: v.code,          // the caller's own code (they signed in with it); used in photo URLs
      canManageAlerts: !v.open || isOperator(req),
      events,
      month: { days: r.days, flagged: r.totalFlagged, confirmed: r.confirmedByGym, fine: r.markedFineByGym, notReviewed: r.notReviewed, nightsWatched: r.nightsWatched, entriesChecked: r.entriesChecked },
      retention: {
        logHours: monitor.LOG_RETENTION_HOURS,
        keptDays: Math.round(monitor.SUMMARY_RETENTION_MS / 864e5),
        text: `Photos are deleted after ${monitor.LOG_RETENTION_HOURS} hours. Flagged entries, and any you mark Tailgate or Shared code, are kept ${Math.round(monitor.SUMMARY_RETENTION_MS / 864e5)} days for the monthly report.`,
      },
      reviewNoteMax: store.REVIEW_NOTE_MAX,
    });
  });

  // ---- One event by id (log OR the 35-day store) ------------------------
  // For links from alerts and the monthly report (#ev-<id>) to events that
  // are older than the activity list's 48 hours but still kept.
  app.get('/gym/event/:id', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = needViewer(req, res);
    if (!v) return;
    const e = findEvent(v.code, req.params.id);
    if (!e) return res.status(404).json({ error: 'That event is no longer stored.' });
    res.json({ gymCode: v.code, event: gymEvent(e, store.loadReviews(v.code), keptIdSet(v.code)) });
  });

  // ---- Photos ------------------------------------------------------------
  function sendFrame(res, code, rawFile, operator) {
    const dir = monitor.framesDirFor(code);
    const file = String(rawFile || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!file.endsWith('.jpg')) return res.status(400).json({ error: 'Not a jpg filename.' });
    const full = path.join(dir, file);
    if (!full.startsWith(dir + path.sep)) return res.status(400).json({ error: 'Bad path.' });
    if (!fs.existsSync(full)) {
      if (!operator) return res.status(404).json({ error: 'This photo is no longer available.' });
      // Diagnostics for the operator only: listing the folder to anyone
      // else would hand out other photos' filenames.
      let present = [];
      try { present = fs.existsSync(dir) ? fs.readdirSync(dir).slice(-5) : []; } catch (e) {}
      return res.status(404).json({
        error: 'That frame is not on disk.', lookedIn: dir, gymCode: code, requested: file,
        directoryExists: fs.existsSync(dir), newestFilesHere: present,
        hint: fs.existsSync(dir)
          ? 'The folder exists but not this file — the photo was probably lost in a deploy before the disk was mounted. Newer events will have theirs.'
          : 'No folder for this gym code. The code in the page URL may not match the one the server is saving under — check /monitor/debug.',
      });
    }
    // Filenames never change, so phones can cache them; "private" keeps
    // shared caches (proxies) from holding member photos.
    res.set('Cache-Control', 'private, max-age=86400');
    res.set('Referrer-Policy', 'no-referrer');
    res.sendFile(full);
  }

  app.get('/monitor/frame/:code/:file', (req, res) => {
    const v = viewerFor(req);
    const asked = v && v.operator ? operatorGym(req.params.code) : monitor.safeCode(req.params.code);
    // Same response for "no code" and "someone else's gym": nothing to
    // learn about which gyms or photos exist.
    if (!v || (!v.operator && !v.open && v.code !== asked)) return res.status(404).json({ error: 'This photo is no longer available.' });
    sendFrame(res, v.operator || v.open ? asked : v.code, req.params.file, !!v.operator);
  });

  // ---- Sign in / out -----------------------------------------------------
  app.post('/gym/sign-in', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const key = clientKey(req);
    // 10 wrong codes per device per 15 min, and a server-wide ceiling, so
    // codes can't be guessed by brute force. Right codes are never limited.
    if (store.count(`signin-fail:${key}`, 15 * 60e3) >= 10 || store.count('signin-fail:all', 3600e3) >= 300) {
      return res.status(429).json({ error: 'Too many tries. Wait 15 minutes, or use "Forgot your code?" to have it emailed.' });
    }
    const raw = String((req.body || {}).code || '').trim();
    if (!gyms.anyCodesConfigured()) return res.json({ ok: true, gymName: null, open: true });
    const code = monitor.safeCode(raw);
    if (!raw || !gyms.isValidCode(raw) || !gyms.isValidCode(code)) {
      store.limited(`signin-fail:${key}`, 1e9, 15 * 60e3);
      store.limited('signin-fail:all', 1e9, 3600e3);
      return res.status(403).json({ error: 'That code isn\'t right. Check it and try again: it\'s your gym\'s name, a dash, then 6 letters and numbers. Codes that were replaced no longer work.' });
    }
    store.setSessionCookie(req, res, code);
    res.json({ ok: true, gymName: gyms.gymNameFor(code) });
  });

  app.post('/gym/sign-out', (req, res) => {
    store.clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  // ---- Reviews: "tailgate" / "it was fine" -------------------------------
  app.post('/gym/review', (req, res) => {
    const v = needViewer(req, res);
    if (!v) return;
    if (store.limited(`review:${v.code}`, 300, 3600e3)) return res.status(429).json({ error: 'Too many changes — try again shortly.' });
    const { id, verdict, note } = req.body || {};
    const e = findEvent(v.code, id);
    if (!e) return res.status(404).json({ error: 'That event has expired.' });
    try {
      const review = store.setReview(v.code, id, verdict || null, note);
      // The lasting results tally (counts for showing what the camera found).
      try { store.tallyReview(v.code, String(id), review ? review.verdict : null, gymEvent(e, {})); } catch (err) { /* tally is a nicety */ }
      try { memberKeys.keepAround(v.code, eventTime(e), !!(review && store.isConfirmed(review.verdict))); } catch (err) { /* nicety */ }
      // Marked Tailgate: keep it (and its photos) for 35 days, not 48 h.
      monitor.retainForReview(v.code, String(id), review ? review.verdict : null);
      res.json({ ok: true, review, keptUntil: new Date(monitor.purgeAt(v.code, e)).toISOString() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // ---- Protected member numbers: this device's access ----------------
  // A phone asks for access with its own public key; TJ approves it on
  // his owner device. Only approved devices get scans, and each gets only
  // its own scrambled copy of the key (member-keys.js).
  const memberKeys = require('./member-keys');
  app.post('/gym/keys/device', (req, res) => {
    const v = needViewer(req, res);
    if (!v) return;
    if (store.limited(`keyreq:${v.code}`, 20, 3600e3)) return res.status(429).json({ error: 'Too many requests — try again later.' });
    try {
      const b = req.body || {};
      const d = memberKeys.requestDevice(v.code, b.pub, b.name);
      res.json({ ok: true, id: d.id, code: d.code, status: d.status });
    } catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.get('/gym/keys/device/:id', (req, res) => {
    const v = needViewer(req, res);
    if (!v) return;
    const st = memberKeys.deviceStatus(v.code, req.params.id);
    res.set('Cache-Control', 'no-store').json(st ? Object.assign({ ok: true }, st) : { ok: false, status: 'gone' });
  });
  app.get('/gym/keys/scans', (req, res) => {
    const v = needViewer(req, res);
    if (!v) return;
    const id = String(req.query.device || '');
    const st = memberKeys.deviceStatus(v.code, id);
    if (!st || st.status !== 'approved') return res.status(403).json({ error: 'This device isn’t approved to see member numbers.' });
    memberKeys.touchDevice(v.code, id);
    const now = Date.now();
    const from = Math.max(now - 49 * 3600e3, Date.parse(req.query.from) || now - 48 * 3600e3);
    const to = Math.min(now + 60e3, Date.parse(req.query.to) || now + 60e3);
    res.set('Cache-Control', 'no-store').json({ ok: true, scans: memberKeys.scansFor(v.code, id, from, to) });
  });

  // ---- Results download (a spreadsheet of every checked entry) ---------
  // Times in the gym's own zone; no photos, no names beyond the gym's notes.
  app.get('/gym/results.csv', (req, res) => {
    const v = needViewer(req, res);
    if (!v) return;
    let tz = 'America/Chicago';
    try { tz = gyms.timeZoneFor(v.code) || tz; } catch (e) { /* default */ }
    const f = (iso, o) => store.fmtLocal ? store.fmtLocal(iso, tz, o) : iso;
    const q = x => { const t = x == null ? '' : String(x); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
    const words = { tailgate: 'Tailgate (confirmed)', shared: 'Shared code (confirmed)', fine: 'It was fine' };
    const said = { flag: 'Flagged', possible: 'Not certain', check: 'Worth a check', unchecked: 'Couldn\'t check', ok: 'Normal', gate: 'Accessible gate' };
    const t = store.tallySummary(v.code);
    const lines = [
      ['Date', 'Time', 'Result', 'People seen', 'Scans expected', 'Camera said', 'Camera note'].join(','),
      ...store.tallyRows(v.code).map(o => [
        f(o.at, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: undefined, minute: undefined }),
        f(o.at, { weekday: undefined, month: undefined, day: undefined, hour: 'numeric', minute: '2-digit', second: '2-digit' }),
        words[o.verdict] || o.verdict, o.people == null ? '' : o.people, o.expected, said[o.cameraSaid] || o.cameraSaid || '', o.note || '',
      ].map(q).join(',')),
      '',
      ['Totals since', t.since || ''].map(q).join(','),
      ['Nights watched', t.nightsWatched].join(','),
      ['Entries checked by the camera', t.entriesChecked].join(','),
      ['Flagged by the camera', t.cameraFlagged].join(','),
      ['Confirmed tailgates', t.confirmedTailgates].join(','),
      ['Confirmed shared codes', t.confirmedShared].join(','),
      ['People who got in without their own scan', t.extraPeople].join(','),
      ['Checked and fine', t.markedFine].join(','),
    ];
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="entrance-results.csv"');
    res.set('Cache-Control', 'private, no-store');
    res.send('\ufeff' + lines.join('\r\n') + '\r\n');
  });

  // ---- Share one incident ------------------------------------------------
  app.post('/gym/share', (req, res) => {
    const v = needViewer(req, res);
    if (!v) return;
    if (store.limited(`share:${v.code}`, 60, 3600e3)) return res.status(429).json({ error: 'Too many links — try again later.' });
    const id = String((req.body || {}).id || '');
    const e = findEvent(v.code, id);
    if (!e) return res.status(404).json({ error: 'That event has expired.' });
    // Never promise longer than the photos will actually be kept.
    const ttl = Math.min(store.SHARE_TTL_MS, monitor.purgeAt(v.code, e) - Date.now());
    if (ttl < 60e3) return res.status(404).json({ error: 'That event is about to be deleted, so it can\'t be shared.' });
    const hours = Math.floor(ttl / 3600e3);
    res.json({
      ok: true,
      url: `/s/${store.shareToken(v.code, id, ttl)}`,
      expiresAt: new Date(Date.now() + ttl).toISOString(),
      expiresDays: Math.floor(ttl / 864e5),
      expiresHours: hours,
      expiresText: hours >= 48 ? `for ${Math.floor(ttl / 864e5)} days` : hours >= 1 ? `for ${hours} hours` : 'for less than an hour',
    });
  });

  function sharedFromToken(req, res) {
    const t = store.readShareToken(req.params.token);
    if (!t || !t.c || !t.e) { res.status(404).json({ error: 'This link has expired or isn\'t valid.' }); return null; }
    if (gyms.anyCodesConfigured() && !gyms.isKnownKey(t.c)) { res.status(404).json({ error: 'This link has expired or isn\'t valid.' }); return null; }
    const e = findEvent(t.c, t.e);
    if (!e) { res.status(404).json({ error: 'This incident is no longer stored, so the link has expired.' }); return null; }
    return { code: t.c, entry: e, exp: t.x };
  }

  app.get('/s/:token', (req, res) => {
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Robots-Tag', 'noindex');
    res.sendFile(path.join(__dirname, 'share.html'));
  });
  app.get('/gym/shared/:token', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const s = sharedFromToken(req, res);
    if (!s) return;
    const g = gymEvent(s.entry, store.loadReviews(s.code));
    res.json({
      gymName: gyms.gymNameFor(s.code),
      timeZone: gyms.timeZoneFor(s.code),
      // The earlier of the link's own expiry and when the photos go.
      expiresAt: new Date(Math.min(s.exp || Infinity, monitor.purgeAt(s.code, s.entry))).toISOString(),
      // For "Open in your activity page" (works for someone signed in).
      activityUrl: `/activity.html#ev-${encodeURIComponent(store.eventId(s.entry))}`,
      cameraClockNote: store.getSettings(s.code).cameraClockNote || null,
      // Photo URLs go through the token, never the gym's own frame route.
      event: Object.assign({}, g, { review: null, photos: g.photos.map((_, i) => `/gym/shared/${req.params.token}/photo/${i}`) }),
    });
  });
  app.get('/gym/shared/:token/photo/:n', (req, res) => {
    const s = sharedFromToken(req, res);
    if (!s) return;
    const g = gymEvent(s.entry, {});
    const f = g.photos[parseInt(req.params.n, 10)];
    if (!f) return res.status(404).json({ error: 'No such photo.' });
    sendFrame(res, s.code, f, false);
  });

  // ---- Alert list ----------------------------------------------------------
  function alertViewer(req, res) {
    const v = needViewer(req, res);
    if (!v) return null;
    // In open mode (no gym codes configured) anyone with the URL could add
    // addresses, so the list is managed by the operator instead.
    if (v.open && !isOperator(req)) { res.status(403).json({ error: 'Alert sign-up needs a gym code. Ask SecurityAI to set one up for you.' }); return null; }
    return v;
  }
  function publicSub(s) { return { id: s.id, kind: s.kind, to: s.to, addedAt: s.addedAt }; }
  function smsAvailable() { return !!(process.env.TWILIO_SID && process.env.TWILIO_FROM_NUMBER); }

  app.get('/gym/alerts', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const v = alertViewer(req, res);
    if (!v) return;
    res.json({ subscribers: store.loadSubscribers(v.code).map(publicSub), max: store.MAX_SUBSCRIBERS, textsAvailable: smsAvailable(), emailAvailable: mailer.isConfigured() });
  });

  function explainSend(r, sub) {
    if (r.ok) return sub.kind === 'email' ? `Test sent to ${sub.to}. It can take a minute — check the spam folder too.` : `Test text sent to ${sub.to}.`;
    if (r.reason === 'sms-off') return `Saved. Text alerts aren't switched on for your account yet — SecurityAI will turn them on. Email works today.`;
    // The failure is recorded for the operator (admin page), so the gym
    // doesn't have to report it.
    return `Saved, but the test didn't go out just now. SecurityAI can see this on their side and will sort it out.`;
  }

  app.post('/gym/alerts', async (req, res) => {
    const v = alertViewer(req, res);
    if (!v) return;
    const b = req.body || {};
    const who = clientKey(req);
    try {
      if (b.action === 'add') {
        if (store.limited(`alert-add:${v.code}`, 6, 3600e3) || store.limited(`alert-add-ip:${who}`, 20, 24 * 3600e3)) {
          return res.status(429).json({ error: 'That\'s a lot of changes — try again in an hour.' });
        }
        const { sub, added } = store.addSubscriber(v.code, b.to);
        // Every new address gets a message straight away: it's the test,
        // and it tells the person how to get off the list if it wasn't them.
        let message = `${sub.to} is already on the list.`;
        let delivered = null;
        if (added) {
          store.limited(`alert-test:${sub.id}`, 1e9, 2 * 60e3);
          const r = await monitor.sendGymTestAlert(v.code, sub);
          delivered = r.ok;
          message = explainSend(r, sub);
        }
        return res.json({ ok: true, added, delivered, message, subscribers: store.loadSubscribers(v.code).map(publicSub) });
      }
      if (b.action === 'remove') {
        store.removeSubscriber(v.code, b.id);
        return res.json({ ok: true, subscribers: store.loadSubscribers(v.code).map(publicSub) });
      }
      if (b.action === 'test') {
        const sub = store.loadSubscribers(v.code).find(s => s.id === String(b.id));
        if (!sub) return res.status(404).json({ error: 'That address is no longer on the list.' });
        if (store.count(`alert-test:${sub.id}`, 2 * 60e3) >= 1 || store.limited(`alert-test-gym:${v.code}`, 6, 3600e3)) {
          return res.status(429).json({ error: 'A test was just sent — give it a couple of minutes.' });
        }
        store.limited(`alert-test:${sub.id}`, 1e9, 2 * 60e3);
        const r = await monitor.sendGymTestAlert(v.code, sub);
        return res.json({ ok: true, delivered: r.ok, message: explainSend(r, sub) });
      }
      res.status(400).json({ error: 'Unknown action.' });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Unsubscribe from an alert. GET only shows a button: email scanners
  // follow links, and must not take people off the list by doing so.
  function unsubPage(title, body, form) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Alerts — SecurityAI</title>
<style>body{margin:0;background:#14171A;color:#EDEFF1;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.b{max-width:420px;text-align:center}h1{font-size:22px}p{color:#AEB5BC;font-size:16px;line-height:1.5}button{font-size:17px;padding:14px 22px;border-radius:8px;border:0;background:#3FCF8E;color:#0d1f16;font-weight:600;min-height:48px}</style></head>
<body><div class="b"><h1>${title}</h1><p>${body}</p>${form || ''}</div></body></html>`;
  }
  function escHtml(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  app.get('/gym/unsubscribe', (req, res) => {
    const t = store.readUnsubscribeToken(req.query.t);
    const sub = t && store.loadSubscribers(t.c).find(s => s.id === t.s);
    res.set('Referrer-Policy', 'no-referrer');
    if (!sub) return res.send(unsubPage('You\'re not on the list', 'This address isn\'t getting SecurityAI alerts any more.'));
    const name = gyms.gymNameFor(t.c) || 'this gym';
    res.send(unsubPage('Stop these alerts?', `${escHtml(sub.to)} will stop getting alerts for ${escHtml(name)}.`,
      `<form method="POST" action="/gym/unsubscribe?t=${encodeURIComponent(req.query.t)}"><button type="submit">Stop alerts</button></form>`));
  });
  app.post('/gym/unsubscribe', (req, res) => {
    const t = store.readUnsubscribeToken(req.query.t);
    if (t) store.removeSubscriber(t.c, t.s);
    res.send(unsubPage('Done', 'You won\'t get any more alerts. If this was a mistake, ask the gym to add you again.'));
  });

  // ---- Monthly report ------------------------------------------------------
  function reportViewer(req, res) {
    const v = needViewer(req, res);
    if (!v) return null;
    return v;
  }
  function reportCode(v, req) {
    // Gyms always get their own; the operator may name any gym.
    return v.operator ? (req.query.code ? operatorGym(req.query.code) : v.code) : v.code;
  }
  // ?month=YYYY-MM | last | this  -> a calendar month in the gym's zone.
  // ?days=N (no month)            -> the trailing N days, as before.
  function reportArgs(req) {
    const month = req.query.month ? String(req.query.month).slice(0, 7) : (req.query.days ? null : 'this');
    const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
    const tz = req.query.tz !== undefined ? parseInt(req.query.tz, 10) : undefined;
    return { days, tz: Number.isFinite(tz) ? tz : undefined, opts: month ? { month } : {} };
  }
  app.get('/monitor/report', (req, res) => {
    const v = reportViewer(req, res);
    if (!v) return;
    const a = reportArgs(req);
    res.json(monitor.buildReport(reportCode(v, req), a.days, a.tz, a.opts));
  });

  // Renders the report exactly as the email looks. Photos load through the
  // viewer's own access (cookie or admin token), never a public URL.
  app.get('/monitor/report/preview', (req, res) => {
    const v = reportViewer(req, res);
    if (!v) return;
    const code = reportCode(v, req);
    const a = reportArgs(req);
    const data = monitor.buildReport(code, a.days, a.tz, a.opts);
    const html = report.renderHtml(data, v.operator ? (req.query.name || gyms.gymNameFor(code)) : gyms.gymNameFor(code), {
      web: true,
      photoUrl: e => `/monitor/frame/${encodeURIComponent(code)}/${encodeURIComponent(e.frame)}`,
      // Tapping a photo opens that event on the activity page (review,
      // all photos), not a bare JPEG.
      linkFor: e => `/activity.html#ev-${encodeURIComponent(e.id)}`,
    });
    res.set('Cache-Control', 'no-store');
    res.set('Content-Type', 'text/html').send(html);
  });

  // Emailing a report can send a month of member photos anywhere, so it is
  // operator-only (it used to accept any gym code and any address).
  app.post('/monitor/report/send', async (req, res) => {
    const v = viewerFor(req);
    if (!v || !v.operator) return res.status(403).json({ error: 'Not authorized.' });
    try {
      const { gymCode, gymName, to, days, month } = req.body || {};
      if (!to) return res.status(400).json({ error: 'A recipient email is required.' });
      const key = gymCode ? operatorGym(gymCode) : v.code;
      const out = await report.sendMonthlyReport({ gymCode: key, gymName: gymName || gyms.gymNameFor(key), to, days, month: month || (days ? undefined : 'last') });
      res.json({ ok: true, delivered: out.delivered, reason: out.reason, totalFlagged: out.report.totalFlagged });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { mount, isOperator };
