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
  const token = process.env.ADMIN_TOKEN;
  return !!token && sameSecret(req.get('X-Admin-Token') || '', token);
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
    if (e.tailgate_flag) return e.confidence === 'low' ? 'possible' : 'flag';
    if (e.accessible_gate_used) return 'gate';
    return 'ok';
  }

  // Plain-words version of an entry for the gym. No costs, no model, no
  // error text, no alert-delivery detail — just what happened.
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
      note: e.error ? null : (e.note || null),
      photos: photos.slice(0, 5),
      review: reviews[id] || null,
      // When this event and its photos will be deleted: 48 h after it,
      // unless it was flagged or marked Tailgate (then 35 days).
      keptUntil: keptIds ? new Date((Date.parse(e.timestamp) || Date.now()) + (keptIds.has(id) ? monitor.SUMMARY_RETENTION_MS : monitor.LOG_RETENTION_HOURS * 3600e3)).toISOString() : undefined,
    };
  }
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
    const zones = rec ? (rec.zones || []).map(z => ({ label: z.label, ok: z.streamOk === true, picture: deps.zonePicture ? deps.zonePicture(z) : (z.streamOk ? 'ok' : 'no-picture') })) : [];
    if (rec && !deps.runnerIsOnline(rec)) { state = 'offline'; since = rec.lastSeen ? new Date(rec.lastSeen).toISOString() : null; }
    else if (st.stoppedByOperator && !st.running) state = 'paused';
    else if (rec) {
      // Checking in, but the server can't act on its events (for example
      // it is busy monitoring a different gym). Not the gym's problem to
      // fix, but it must not read as "Watching".
      if (rec.monitorProblem) state = 'problem';
      else if (zones.some(z => z.picture === 'no-picture')) state = 'no-picture';
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
    const r = monitor.buildReport(v.code, 30);
    res.json({
      gym: gymStatus(v.code),
      gymCode: v.code,          // the caller's own code (they signed in with it); used in photo URLs
      canManageAlerts: !v.open || isOperator(req),
      events,
      month: { days: r.days, flagged: r.totalFlagged, confirmed: r.confirmedByGym, fine: r.markedFineByGym, notReviewed: r.notReviewed, nightsWatched: r.nightsWatched, entriesChecked: r.entriesChecked },
      retention: {
        logHours: monitor.LOG_RETENTION_HOURS,
        keptDays: Math.round(monitor.SUMMARY_RETENTION_MS / 864e5),
        text: `Photos are deleted after ${monitor.LOG_RETENTION_HOURS} hours. Flagged entries, and any you mark Tailgate, are kept ${Math.round(monitor.SUMMARY_RETENTION_MS / 864e5)} days for the monthly report.`,
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
      // Marked Tailgate: keep it (and its photos) for 35 days, not 48 h.
      monitor.retainForReview(v.code, String(id), review ? review.verdict : null);
      res.json({ ok: true, review, keptUntil: new Date(monitor.purgeAt(v.code, e)).toISOString() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
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
