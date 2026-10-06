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

  const body = JSON.stringify({
    model: resolveModel(model),
    max_tokens: maxTokens,
    messages: [{
      role: 'user',
      content: [...imageBlocks, { type: 'text', text: promptText }],
    }],
  });

  // One retry, only for answers that mean "not processed" (rate limit,
  // overloaded, server error) — those are not billed, so a retry can't
  // double-charge. A timeout is NOT retried: that call may have been billed.
  let response;
  for (let attempt = 1; ; attempt++) {
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) throw new Error(`Anthropic did not answer within ${CALL_TIMEOUT_MS / 1000} s`);
      throw new Error(`Could not reach Anthropic: ${err && err.message}`);
    }
    if (response.ok || attempt >= 2 || ![429, 500, 502, 503, 529].includes(response.status)) break;
    const wait = Math.min(10, Math.max(1, parseInt(response.headers && response.headers.get && response.headers.get('retry-after'), 10) || 2));
    await new Promise(r => setTimeout(r, wait * 1000));
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
  }

  let data;
  try { data = await response.json(); } catch (e) { throw new Error('Anthropic sent back something that is not JSON'); }
  const textBlock = ((data && data.content) || []).find(b => b && b.type === 'text');
  const raw = textBlock ? String(textBlock.text || '').trim() : '';
  return parseModelJson(raw);
}

const CALL_TIMEOUT_MS = 60 * 1000;

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
  for (const k of ['tailgate_flag', 'accessible_gate_used', 'flag']) if (k in obj) obj[k] = bool(obj[k]);
  for (const k of ['people_count', 'queued_count']) if (k in obj) obj[k] = int(obj[k]);
  if ('confidence' in obj) { const c = String(obj.confidence || '').toLowerCase(); obj.confidence = ['high', 'medium', 'low'].includes(c) ? c : null; }
  if ('note' in obj && obj.note != null) obj.note = String(obj.note).slice(0, 500);
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
  const promptText = `These are ${framesInOrder.length} stills from a fixed security camera at a gym entrance, in time order${cfg.durationSec ? `, over about ${cfg.durationSec} seconds` : ''}. Such cameras usually sit high up and look down at an angle through a wide-angle lens: straight lines bend near the edges and people show mostly as heads and shoulders.

The entrance is usually a full-height turnstile: a cage of metal bars that turns round a post and lets one person through per turn after they scan. Turnstile bars, wire-mesh walls, doors, lights, reflections and shadows are not people. Count heads.

The stills are taken on a timer, so the moment someone passes may fall between two of them. Judge from where people are across the sequence: on one side early and the other side later means they went through; standing still in every frame means they have not (they may be scanning in or waiting).
${gate}
Count the DISTINCT people who got through. Expected per scan: ${expected}.
Tailgating means more than ${expected} going through on the same turn (sharing one gap between the bars, or squeezed in right behind) or through a door held open. People who each get their own turn, even seconds apart, are not tailgating.

Respond with ONLY a JSON object, no other text:
{"people_count": <number who got through>, "queued_count": <number waiting, not through>, "accessible_gate_used": <true|false>, "tailgate_flag": <true|false>, "confidence": "<high|medium|low>", "note": "<one plain sentence for gym staff saying what you see>"}

Set confidence "low" when no frame clearly shows the crossing, people overlap, or it is too dark. A confident wrong answer is worse than an admitted doubt: set tailgate_flag true only when you can see it, and say what makes you unsure in the note.`;

  return callClaudeMulti({ base64Images: framesInOrder, promptText, maxTokens: 400, model: cfg.model });
}

module.exports = { analyzeEntry, scanCameraWall, analyzeEntryBurst, ALLOWED_MODELS, DEFAULT_MODEL };
