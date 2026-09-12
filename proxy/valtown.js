/* Little Moments — AI proxy for Val Town (https://val.town), pass-through version.
 *
 * Paste this into an HTTP val and set one environment variable. It forwards the
 * request the app sends straight to Anthropic (adding your key), so the app owns
 * the prompt and you never need to edit this val again when the story changes.
 *
 * Setup:
 *   1. Sign up free at https://val.town (Google sign-in works).
 *   2. New → HTTP val. Delete the sample and paste this whole file in.
 *   3. Your username → Settings → Environment Variables:
 *        ANTHROPIC_API_KEY  = your Anthropic key   (required)
 *        WORKSPACE_ID       = wrkspc_…            (only for org-scoped keys)
 *        MODEL              = claude-opus-5        (optional; forces a model)
 *        ELEVENLABS_API_KEY = your ElevenLabs key  (optional; enables 🔊 Read aloud)
 *        ELEVENLABS_VOICE_ID / ELEVENLABS_MODEL    (optional narration tuning)
 *   4. Copy the val's HTTP endpoint URL.
 *   5. App → ⚙️ Settings → paste into "AI proxy URL", leave the API key blank.
 */

const MAX_TOKENS_CAP = 2000;
const TTS_MAX_CHARS = 2500;
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // "Rachel" — warm, natural
const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2';

export default async function (req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: { message: 'Use POST with a JSON body.' } }, 405, cors);

  // Narration: POST to <val>/tts, returns audio/mpeg from ElevenLabs.
  if (new URL(req.url).pathname.replace(/\/+$/, '').endsWith('/tts')) {
    return handleTts(req, cors);
  }

  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return json({ error: { message: 'The proxy is missing its ANTHROPIC_API_KEY environment variable.' } }, 500, cors);

  let body;
  try { body = await req.json(); } catch (_) { return json({ error: { message: 'Invalid JSON body.' } }, 400, cors); }
  if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
    return json({ error: { message: 'Body must be an Anthropic Messages request with a "messages" array.' } }, 400, cors);
  }

  const forcedModel = Deno.env.get('MODEL');
  if (forcedModel) body.model = forcedModel;
  else if (!body.model) body.model = 'claude-opus-5';
  body.max_tokens = Math.min(Number(body.max_tokens) || 1200, MAX_TOKENS_CAP);

  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  };
  const ws = Deno.env.get('WORKSPACE_ID');
  if (ws) headers['anthropic-workspace-id'] = ws;

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { ...cors, 'content-type': 'application/json' } });
}

async function handleTts(req, cors) {
  const key = Deno.env.get('ELEVENLABS_API_KEY');
  if (!key) return json({ error: { message: 'Narration is not configured (no ELEVENLABS_API_KEY).' } }, 500, cors);

  let body;
  try { body = await req.json(); } catch (_) { return json({ error: { message: 'Invalid JSON body.' } }, 400, cors); }
  const text = (body && typeof body.text === 'string' ? body.text : '').trim();
  if (!text) return json({ error: { message: 'Nothing to narrate.' } }, 400, cors);

  const voiceId = (body.voiceId && /^[A-Za-z0-9]{8,40}$/.test(body.voiceId))
    ? body.voiceId
    : (Deno.env.get('ELEVENLABS_VOICE_ID') || DEFAULT_VOICE_ID);
  const model = Deno.env.get('ELEVENLABS_MODEL') || DEFAULT_TTS_MODEL;

  const upstream = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': key, 'content-type': 'application/json', 'accept': 'audio/mpeg' },
    body: JSON.stringify({
      text: text.slice(0, TTS_MAX_CHARS),
      model_id: model,
      voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
    }),
  });
  if (!upstream.ok) {
    let detail = '';
    try { const j = await upstream.json(); detail = j?.detail?.message || j?.detail || j?.message || ''; if (typeof detail === 'object') detail = JSON.stringify(detail); } catch (_) {}
    return json({ error: { message: 'Voice service said: ' + (detail || `failed (${upstream.status})`) } }, upstream.status === 401 ? 502 : upstream.status, cors);
  }
  return new Response(upstream.body, { status: 200, headers: { ...cors, 'content-type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });
}
