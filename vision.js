// Shared Claude-vision calls — used by monitor.js's persistent loop AND
// by server.js's /analyze-frame and /scan-cameras endpoints.
//
// Those endpoints exist because the browser demo on securityai.html used
// to call api.anthropic.com directly from the browser. That only worked
// while this page was being built and previewed inside Claude's own
// interface, which proxies that exact call for pages it renders. Once
// deployed to an independent domain, there's no such proxy — the browser
// has no API key and the request fails before it even gets a response
// (shows up as "Failed to fetch"). Routing through this server, which
// holds a real ANTHROPIC_API_KEY, is the actual fix.

async function callClaude({ base64Image, promptText, maxTokens, model }) {
  return callClaudeMulti({ base64Images: [base64Image], promptText, maxTokens, model });
}

// Same as callClaude but takes an ordered array of frames instead of one.
// Claude can reason across multiple images in a single request the way a
// person would flip through a short burst of stills — this is what
// actually gives a "did someone just move fast through this doorway"
// judgment some real temporal information to work with, instead of
// guessing motion from a single frozen instant.
// Model IDs the dashboard is allowed to pick between. Haiku is roughly
// 3x cheaper on both input and output; Sonnet is more capable on edge
// cases like two people overlapping in one doorway. Anything not on this
// list falls back to Sonnet rather than being passed through blindly.
const ALLOWED_MODELS = {
  'claude-sonnet-4-6': true,
  'claude-haiku-4-5-20251001': true,
};
const DEFAULT_MODEL = 'claude-sonnet-4-6';

function resolveModel(model) {
  return ALLOWED_MODELS[model] ? model : DEFAULT_MODEL;
}

async function callClaudeMulti({ base64Images, promptText, maxTokens, model }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set, so nothing can be analysed (website: Render > Environment; laptop local mode: the .env file).');
  }

  const imageBlocks = base64Images.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: img },
  }));

  const bodyFor = m => JSON.stringify({
    model: m,
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [...imageBlocks, { type: 'text', text: promptText }],
    }],
  });
  const primary = resolveModel(model);
  const backup = backupFor(primary);

  // One retry, only for answers that mean "not processed" (rate limit,
  // overloaded, server error) — those are not billed, so a retry can't
  // double-charge. If the main model is still busy, ONE try on the backup
  // model (same accuracy class), so checks don't stop while Anthropic has
  // trouble with one model. A timeout is NOT retried: that call may have
  // been billed.
  let response, used = primary, firstError = null;
  const plan = [primary, primary].concat(backup ? [backup] : []);
  for (let attempt = 0; attempt < plan.length; attempt++) {
    used = plan[attempt];
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: bodyFor(used),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new Error(`Anthropic did not answer within ${CALL_TIMEOUT_MS / 1000} s`);
      throw new Error(`Could not reach Anthropic: ${err && err.message}`);
    }
    if (response.ok || !RETRYABLE.includes(response.status) || attempt === plan.length - 1) break;
    if (attempt === 1) {
      // Main model failed twice: note it, then try the backup.
      firstError = `${response.status}`;
      stats.fallbacks++; stats.lastFallbackAt = new Date().toISOString(); stats.lastFallbackReason = firstError;
      console.warn(`Main AI model ${primary} busy (${firstError}) twice: trying the backup ${backup}.`);
      continue;
    }
    const wait = Math.min(10, Math.max(1, parseInt(response.headers && response.headers.get && response.headers.get('retry-after'), 10) || 2));
    await new Promise(r => setTimeout(r, wait * 1000));
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    stats.failures++; stats.lastFailureAt = new Date().toISOString();
    const failure = new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
    try { if (module.exports.onFailure) module.exports.onFailure(failure); } catch (e) { /* never in the way */ }
    throw new Error(`Anthropic API error ${response.status}${firstError ? ` (main model ${firstError}, backup ${response.status})` : ''}: ${text.slice(0, 200)}`);
  }
  if (used !== primary) { stats.backupAnswers++; stats.lastBackupAnswerAt = new Date().toISOString(); }

  let data;
  try { data = await response.json(); } catch (e) { throw new Error('Anthropic sent back something that is not JSON'); }
  const textBlock = ((data && data.content) || []).find(b => b && b.type === 'text');
  const raw = textBlock ? String(textBlock.text || '').trim() : '';
  const out = parseModelJson(raw);
  Object.defineProperty(out, 'modelUsed', { value: used, enumerable: false });
  return out;
}

const CALL_TIMEOUT_MS = 60 * 1000;
const RETRYABLE = [429, 500, 502, 503, 529];
// The backup when the main model is overloaded: another model of the same
// accuracy class (never a smaller one for counting people). BACKUP_MODEL
// can change it; BACKUP_MODEL=off turns it off.
function backupFor(primary) {
  const env = String(process.env.BACKUP_MODEL || '').trim();
  if (/^(off|none|0)$/i.test(env)) return null;
  const b = env || (primary === 'claude-sonnet-4-5' ? 'claude-sonnet-4-6' : 'claude-sonnet-4-5');
  return b === primary ? null : b;
}
// How often the backup was needed (shown on the admin page).
const stats = { fallbacks: 0, backupAnswers: 0, failures: 0, lastFallbackAt: null, lastFallbackReason: null, lastBackupAnswerAt: null, lastFailureAt: null, since: new Date().toISOString() };

// The model is asked for bare JSON but sometimes wraps it in a sentence or
// a ```json fence, or writes "false" as a string. A string "false" is
// truthy in JavaScript — it would send a tailgate alert — so types are
// made strict here.
function parseModelJson(raw) {
  const s = String(raw || '').replace(/```json|```/g, '').trim();
  let obj = null;
  try { obj = JSON.parse(s); } catch (e) {
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e2) { obj = null; } }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`The model's answer could not be read: "${s.slice(0, 80)}"`);
  }
  const bool = v => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true');
  const int = v => { const n = typeof v === 'string' ? Number(v.trim()) : v; return (typeof n === 'number' && Number.isFinite(n)) ? Math.max(0, Math.round(n)) : null; };
  for (const k of ['tailgate_flag', 'accessible_gate_used', 'flag', 'phone_handoff', 'second_person_possible', 'went_out']) if (k in obj) obj[k] = bool(obj[k]);
  if ('same_person' in obj) obj.same_person = obj.same_person === true || obj.same_person === 'true' ? true : obj.same_person === false || obj.same_person === 'false' ? false : null;
  for (const k of ['people_count', 'queued_count', 'turns', 'extra_on_turn']) if (k in obj) obj[k] = int(obj[k]);
  if (obj.turns != null && (obj.turns < 1 || obj.turns > 8)) obj.turns = null;
  if (obj.extra_on_turn != null && (obj.extra_on_turn < 1 || obj.extra_on_turn > (obj.turns || 1))) obj.extra_on_turn = null;
  if ('confidence' in obj) { const c = String(obj.confidence || '').toLowerCase(); obj.confidence = ['high', 'medium', 'low'].includes(c) ? c : null; }
  if ('note' in obj && obj.note != null) obj.note = String(obj.note).slice(0, 500);
  if ('person' in obj) obj.person = obj.person == null ? null : String(obj.person).slice(0, 140);
  if ('picture_clock' in obj) { const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(obj.picture_clock || '').trim()); obj.picture_clock = m && +m[1] < 24 && +m[2] < 60 ? `${m[1].padStart(2, '0')}:${m[2]}:${m[3] || '00'}` : null; }
  if (Array.isArray(obj.cameras)) {
    obj.cameras = obj.cameras.filter(c => c && typeof c === 'object').map(c => Object.assign({}, c, { flag: bool(c.flag), people_count: int(c.people_count) }));
  }
  return obj;
}

// Single-entrance tailgate/queue/accessible-gate detection — the core
// feature, used by monitor.js's persistent loop and by the browser
// demo's single-frame "Capture & analyze" button.
async function analyzeEntry(base64Image, cfg) {
  const gateInstruction = cfg.accessibleGate
    ? `This entrance has a separate marked accessible/disabled-access gate (e.g. a wider gate, ramp, or push-button door) alongside the main scan point. If someone is visibly entering through that accessible gate rather than the main scan point, set accessible_gate_used to true and do NOT set tailgate_flag for that person — accessible gates are frequently not wired to the same scan hardware, so an unmatched entry there is expected, not a violation. Still describe it in the note so staff can confirm the check-in separately.`
    : `This entrance does not have a separate accessible gate — treat all visible entries as going through the single main scan point.`;

  const promptText = `You are an entrance security camera analyzing a gym doorway. The front desk expects ${cfg.expectedCount} check-in(s) at any given moment. ${gateInstruction}

Distinguish between people actually crossing the threshold now versus people simply standing nearby waiting their turn to scan — someone waiting in line is not the same as someone entering unscanned, and should not by itself cause a flag.

Respond ONLY with strict JSON, no markdown fences, no other text:
{"people_count": <int, people actually crossing/entering right now>, "queued_count": <int, people visibly waiting nearby but not yet crossing>, "accessible_gate_used": <true|false>, "tailgate_flag": <true|false>, "note": "<one short plain-language sentence describing what you see>"}

Set tailgate_flag true only if people_count (excluding anyone using the accessible gate) is greater than ${cfg.expectedCount}. Never flag based on queued_count alone.`;

  return callClaude({ base64Image, promptText, maxTokens: 350, model: cfg.model });
}

// Multi-camera dashboard scan — rules-based only, no identity matching.
// Used by the browser demo's "Scan visible cameras" button (a preview
// feature — see securityai.html's own disclosure that this isn't part
// of the persistent monitor.js loop yet).
async function scanCameraWall(base64Image, zones) {
  const zoneInstruction = zones && zones.length
    ? `The following zones/cameras should currently show zero people: ${zones.join(', ')}. Flag any of those tiles that have anyone visible in them.`
    : `No restricted zones were specified, so do not flag tiles for presence alone — only flag a tile if you directly observe someone forcing a door, propping one open, or closely following another person through a controlled doorway without pausing.`;

  const promptText = `This screenshot may show a security camera dashboard with multiple tiles/feeds, or a single view. Identify each distinct camera tile you can see (label each by its position or any on-screen camera name/label — e.g. "top-left" or "DOOR-02" if labeled). For each tile report how many people are visible and briefly what they're doing.

${zoneInstruction}

Important: never base a flag on a person's appearance, clothing, age, race, gender, or any guess about who they are or whether they "look like" they belong. Flags come only from the stated zone rule or from directly observed door-forcing/propping/tailgating behavior. You cannot determine anyone's identity or authorization from this image, and should not imply that you can.

Respond ONLY with strict JSON, no markdown fences, no other text:
{"cameras": [{"label": "<string>", "people_count": <int>, "flag": <true|false>, "note": "<one short plain sentence, behavior only>"}], "summary": "<one short sentence>"}`;

  return callClaude({ base64Image, promptText, maxTokens: 700 });
}

// Motion-triggered burst analysis for a single entrance zone cropped out
// of a larger multi-camera screen share. Instead of polling on a fixed
// clock (expensive, and still just guessing at motion from one instant),
// the browser watches only this cropped region for local pixel motion —
// free, no API call — and only sends frames here once it actually sees
// something happening. framesInOrder should be 3-5 crops taken roughly
// 150-300ms apart during the triggering motion, so Claude has an actual
// short sequence to reason across rather than a single still.
async function analyzeEntryBurst(framesInOrder, cfg) {
  const gateInstruction = cfg.accessibleGate
    ? `This entrance has a separate marked accessible/disabled-access gate (e.g. a wider gate, ramp, or push-button door) alongside the main scan point. If someone is visibly entering through that accessible gate rather than the main scan point, set accessible_gate_used to true and do NOT set tailgate_flag for that person — accessible gates are frequently not wired to the same scan hardware, so an unmatched entry there is expected, not a violation. Still describe it in the note so staff can confirm the check-in separately.`
    : `This entrance does not have a separate accessible gate — treat all visible entries as going through the single main scan point.`;

  const gate = cfg.accessibleGate
    ? 'There is also a separate accessible/disabled-access gate beside the main barrier. Someone using it is legitimate and is NOT tailgating.'
    : '';

  // Written for the real camera this was built on (J Street, CAM4): high
  // up, looking down at an angle through a wide-angle lens at a
  // full-height rotating turnstile with wire-mesh walls. Kept short: it is
  // sent with every crossing. The accuracy test (accuracy.js) scores this
  // same prompt: "two on one rotation" must flag, "two on separate
  // rotations" must not.
  const expected = cfg.expectedCount || 1;
  // Which way is IN on this camera (set at the gym with --entry), so people
  // walking out, or only walking up to the turnstile, aren't counted.
  const W = { left: 'the left', right: 'the right', up: 'the top of the picture', down: 'the bottom of the picture' };
  const OPP = { left: 'right', right: 'left', up: 'down', down: 'up' };
  const ins = Array.isArray(cfg.entryDirection) ? cfg.entryDirection.filter(d => W[d]) : [];
  const dirText = ins.length
    ? `On this camera, people coming IN move toward ${ins.map(d => W[d]).join(' or ')}; people going OUT move toward ${ins.map(d => W[OPP[d]]).join(' or ')}. Someone walking out is leaving the gym: never count them and never call it a tailgate, even if two leave together. Someone who only walks up to the turnstile or waits at it has not got in yet.${cfg.direction && W[cfg.direction] ? ` The main movement in these stills was toward ${W[cfg.direction]}.` : ''}\n`
    : 'Only count people coming IN. People walking out, or only walking up to the turnstile and waiting, have not got in.\n';
  // Stills from someone at the turnstile just before this crossing (they
  // came back out through it, or stood there): sent first, and labelled,
  // so a phone handed over for a second scan can be seen.
  const before = (cfg.before && Array.isArray(cfg.before.frames) && cfg.before.frames.length) ? cfg.before : null;
  const nb = before ? before.frames.length : 0;
  // Photos of an EARLIER entry on the same member code (a "repeat" scan).
  const cmp = (cfg.compare && Array.isArray(cfg.compare.frames) && cfg.compare.frames.length) ? cfg.compare : null;
  const nc = cmp ? cmp.frames.length : 0;
  const images = (cmp ? cmp.frames : []).concat(before ? before.frames : [], framesInOrder);
  const cmpText = cmp
    ? `The first ${nc === 1 ? 'image is' : `${nc} images are`} from an EARLIER entry, about ${cmp.mins} minutes ago, on the same member code as this crossing. People do leave and come back, so compare the person in the earlier image with the person coming in now by clothes, build, hair and bag (not by face), and set same_person true if they look like the same person, false if clearly different, null if you can't tell. Don't count anyone from the earlier image.\n\n`
    : '';
  const beforeText = cmpText + (before
    ? `${cmp ? 'The next' : 'The first'} ${nb === 1 ? 'image is' : `${nb} images are`} NOT part of the crossing: ${nb === 1 ? 'it was' : 'they were'} taken about ${before.sec} seconds before it, when someone ${before.kind === 'left' ? 'had just come back out through the turnstile' : 'was at the turnstile without going through'}. The other ${framesInOrder.length} images are the crossing. Only count people from the crossing images.\n\n`
    : cmp ? `The other ${framesInOrder.length} images are the crossing, in time order. Only count people from those.\n\n` : '');
  const promptText = `${beforeText}${before || cmp ? `The crossing images` : `These are ${framesInOrder.length} stills`} from a fixed security camera at a gym entrance, in time order${cfg.durationSec ? `, over about ${cfg.durationSec} seconds` : ''}. Such cameras usually sit high up and look down at an angle through a wide-angle lens: straight lines bend near the edges and people show mostly as heads and shoulders.

The entrance is usually a full-height turnstile: a cage of metal bars that turns round a post and lets one person through per turn after they scan. Turnstile bars, wire-mesh walls, doors, lights, reflections and shadows are not people. Count PEOPLE only, by their heads: a dog or other animal, a duffle bag, gym bag, backpack, suitcase, stroller or scooter is never a person and never a second person, however big it looks or however close it follows.

The stills are taken on a timer, so the moment someone passes may fall between two of them. Judge from where people are across the sequence: on one side early and the other side later means they went through; standing still in every frame means they have not (they may be scanning in or waiting).
${gate}
${cfg.lingerSec ? `Before these stills, someone had been at the turnstile for about ${cfg.lingerSec} seconds without going straight through. Waiting at the gate and then slipping in right behind someone is a common way to tailgate, so look carefully for a second person close behind or squeezed into the same turn. Still only flag what you can see.\n` : ''}${dirText}Count the DISTINCT people who got through. Expected per scan: ${expected}.
Tailgating means more than ${expected} going through on the same turn (sharing one gap between the bars, or squeezed in right behind) or through a door held open. People who each get their own turn, even seconds apart, are not tailgating.

Members scan in with a code on their phone, and the same code works again after a short lockout. Code sharing: a member already inside comes back to the turnstile and hands their phone (or card) over or through it, so the person outside can scan in on the same code. Set phone_handoff true only if you can see something passed between a person inside and a person outside, or someone inside reaching through or over the turnstile to the person about to enter. Someone scanning their own phone at the reader is normal.

Respond with ONLY a JSON object, no other text:
{"people_count": <number who got through>, "queued_count": <number waiting, not through>, "accessible_gate_used": <true|false>, "tailgate_flag": <true|false>, "phone_handoff": <true|false>, "second_person_possible": <true|false>, "went_out": <true if the people in these stills were LEAVING (walking out), else false>,${cmp ? ' "same_person": <true|false|null, comparing with the EARLIER entry>, "person": "<short description of who came in now: clothes, build, hair>",' : ''} "turns": <how many separate turns of the turnstile (separate scans) these people used, usually 1>, "extra_on_turn": <if more people got through than scanned: which of those turns (1 = first) the extra person squeezed into, else null>, "picture_clock": "<the time printed on the camera picture, 24-hour HH:MM:SS, or null if none>", "confidence": "<high|medium|low>", "note": "<one plain sentence for gym staff saying what you see>"}

second_person_possible: true ONLY if a second person could have got through on the same turn and these photos can't rule it out (someone partly hidden behind the first person, the view blocked at the key moment, or a second shape you can't make out). false when you can see one person went through and nobody was close behind them, even if the picture is dark, blurry or bent at the edges.

Set confidence "low" when no frame clearly shows the crossing, people overlap, or it is too dark. A confident wrong answer is worse than an admitted doubt: set tailgate_flag true only when you can see it, and say what makes you unsure in the note.`;

  return callClaudeMulti({ base64Images: images, promptText, maxTokens: 400, model: cfg.model });
}

module.exports = { analyzeEntry, scanCameraWall, analyzeEntryBurst, ALLOWED_MODELS, DEFAULT_MODEL, backupFor, stats: () => Object.assign({}, stats) };
