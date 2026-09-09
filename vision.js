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
    throw new Error('ANTHROPIC_API_KEY is not set in .env — required for analysis.');
  }

  const imageBlocks = base64Images.map(img => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data: img },
  }));

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: resolveModel(model),
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [...imageBlocks, { type: 'text', text: promptText }],
      }],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find(b => b.type === 'text');
  const raw = textBlock ? textBlock.text.trim() : '{}';
  return JSON.parse(raw.replace(/```json|```/g, '').trim());
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

  const promptText = `You are an entrance security camera analyzing a gym doorway. These ${framesInOrder.length} images are frames from the same fixed camera position, in chronological order, spanning one complete entry event${cfg.durationSec ? ` of about ${cfg.durationSec} seconds` : ''} — from when someone first appeared until the doorway went still again. Treat them as frames of a short video clip, not unrelated photos.

The frames are spread across the event and weighted toward its end, because people commonly step into view, stop to find their phone or badge, scan, and only then walk through. So an early frame showing someone standing still with a phone is normal and is NOT an entry — judge how many distinct people actually crossed the threshold across the whole sequence, paying most attention to the later frames.

The front desk expects ${cfg.expectedCount} check-in(s) for an event like this. ${gateInstruction}

A queue of people waiting nearby without crossing is not the same as unscanned entry and should not by itself cause a flag. Fast motion alone (someone moving quickly) is also not by itself a violation — the count of distinct people actually crossing during the burst is what matters.

Respond ONLY with strict JSON, no markdown fences, no other text:
{"people_count": <int, distinct people who crossed the threshold during this burst>, "queued_count": <int, people visibly waiting nearby but not crossing>, "accessible_gate_used": <true|false>, "tailgate_flag": <true|false>, "note": "<one short plain-language sentence describing what happened across the burst>"}

Set tailgate_flag true only if people_count (excluding anyone using the accessible gate) is greater than ${cfg.expectedCount}. Never flag based on queued_count or fast motion alone.`;

  return callClaudeMulti({ base64Images: framesInOrder, promptText, maxTokens: 400, model: cfg.model });
}

module.exports = { analyzeEntry, scanCameraWall, analyzeEntryBurst, ALLOWED_MODELS, DEFAULT_MODEL };
