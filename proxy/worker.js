/* Little Moments — Cloudflare Worker
 *
 * Three jobs:
 *  1. AI proxy (pass-through): forwards an Anthropic Messages request, adding
 *     the API key server-side (and optional workspace). POST to the base URL.
 *  2. Shared album: stores the owner's memories in KV so invited family can
 *     view them read-only. POST to <base>/album.
 *  3. Narration (text-to-speech): turns a story into a warm, real-sounding
 *     voice using ElevenLabs. POST to <base>/tts, returns audio/mpeg.
 *
 * Required for AI:    ANTHROPIC_API_KEY (secret)
 * Optional for AI:    WORKSPACE_ID, MODEL
 * Required for album: a KV namespace bound as ALBUM, plus secrets
 *                     ALBUM_OWNER_KEY (write), ALBUM_READ_KEY (in the link),
 *                     ALBUM_PASSWORD (family password).
 * Required for TTS:   ELEVENLABS_API_KEY (secret)
 * Optional for TTS:   ELEVENLABS_VOICE_ID (default voice), ELEVENLABS_MODEL
 * Optional (all):     ALLOWED_ORIGINS (comma-separated)
 */

const MAX_TOKENS_CAP = 2000;
const TTS_MAX_CHARS = 2500; // guards cost — long stories are trimmed
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // "Rachel" — warm, natural
const DEFAULT_TTS_MODEL = 'eleven_multilingual_v2';

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    const corsOrigin = allowed.length === 0 ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
    const cors = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return err('Use POST.', 405, cors);
    if (allowed.length && origin && !allowed.includes(origin)) return err('Origin not allowed.', 403, cors);

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');
    if (path.endsWith('/album')) {
      return handleAlbum(request, env, cors);
    }
    if (path.endsWith('/tts')) {
      return handleTts(request, env, cors);
    }

    // ---- AI pass-through ----
    if (!env.ANTHROPIC_API_KEY) return err('The proxy is missing its ANTHROPIC_API_KEY secret.', 500, cors);
    let body;
    try { body = await request.json(); } catch (_) { return err('Invalid JSON body.', 400, cors); }
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
      return err('Body must be an Anthropic Messages request with a "messages" array.', 400, cors);
    }
    if (env.MODEL) body.model = env.MODEL;
    else if (!body.model) body.model = 'claude-opus-5';
    body.max_tokens = Math.min(Number(body.max_tokens) || 1200, MAX_TOKENS_CAP);

    const headers = {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    };
    if (env.WORKSPACE_ID) headers['anthropic-workspace-id'] = env.WORKSPACE_ID;

    let upstream;
    try {
      upstream = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      return err('Could not reach Anthropic: ' + (e && e.message ? e.message : 'network error'), 502, cors);
    }
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { ...cors, 'content-type': 'application/json' } });
  },
};

async function handleTts(request, env, cors) {
  if (!env.ELEVENLABS_API_KEY) {
    return err('Narration is not configured (no ELEVENLABS_API_KEY secret on the proxy).', 500, cors);
  }
  let body;
  try { body = await request.json(); } catch (_) { return err('Invalid JSON body.', 400, cors); }
  const text = (body && typeof body.text === 'string' ? body.text : '').trim();
  if (!text) return err('Nothing to narrate.', 400, cors);

  // A voice id is a short alphanumeric token; sanitize anything the client sends.
  const voiceId = (body.voiceId && /^[A-Za-z0-9]{8,40}$/.test(body.voiceId))
    ? body.voiceId
    : (env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID);
  const model = env.ELEVENLABS_MODEL || DEFAULT_TTS_MODEL;

  const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`;
  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
        'content-type': 'application/json',
        'accept': 'audio/mpeg',
      },
      body: JSON.stringify({
        text: text.slice(0, TTS_MAX_CHARS),
        model_id: model,
        voice_settings: { stability: 0.4, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true },
      }),
    });
  } catch (e) {
    return err('Could not reach the voice service: ' + (e && e.message ? e.message : 'network error'), 502, cors);
  }

  if (!upstream.ok) {
    // ElevenLabs returns JSON errors; surface a readable message.
    let detail = '';
    try { const j = await upstream.json(); detail = j?.detail?.message || j?.detail || j?.message || ''; if (typeof detail === 'object') detail = JSON.stringify(detail); } catch (_) {}
    return err('Voice service said: ' + (detail || `failed (${upstream.status})`), upstream.status === 401 ? 502 : upstream.status, cors);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: { ...cors, 'content-type': 'audio/mpeg', 'Cache-Control': 'no-store' },
  });
}

async function handleAlbum(request, env, cors) {
  const kv = env.ALBUM;
  if (!kv) return err('Album storage is not configured (no ALBUM namespace).', 500, cors);

  let body;
  try { body = await request.json(); } catch (_) { return err('Invalid JSON body.', 400, cors); }
  const action = body && body.action;

  const isOwner = !!(body.ownerKey && env.ALBUM_OWNER_KEY && body.ownerKey === env.ALBUM_OWNER_KEY);
  const readKeyOk = !!(body.readKey && env.ALBUM_READ_KEY && body.readKey === env.ALBUM_READ_KEY);
  const passwordOk = !env.ALBUM_PASSWORD || body.password === env.ALBUM_PASSWORD;
  const canRead = isOwner || (readKeyOk && passwordOk);

  if (action === 'put') {
    if (!isOwner) return err('Not authorized to publish.', 403, cors);
    const mem = body.memory;
    if (!mem || !mem.id) return err('Missing memory.', 400, cors);
    await kv.put('mem:' + mem.id, JSON.stringify(mem));
    const idx = JSON.parse((await kv.get('idx')) || '[]').filter((e) => e.id !== mem.id);
    idx.push({ id: mem.id, date: mem.date || '', createdAt: mem.createdAt || 0 });
    await kv.put('idx', JSON.stringify(idx));
    return json({ ok: true }, 200, cors);
  }

  if (action === 'delete') {
    if (!isOwner) return err('Not authorized.', 403, cors);
    await kv.delete('mem:' + body.id);
    const idx = JSON.parse((await kv.get('idx')) || '[]').filter((e) => e.id !== body.id);
    await kv.put('idx', JSON.stringify(idx));
    return json({ ok: true }, 200, cors);
  }

  if (action === 'list') {
    if (!readKeyOk) return err('This album link is not valid.', 401, cors);
    if (!passwordOk) return err('needs-password', 401, cors);
    let idx = JSON.parse((await kv.get('idx')) || '[]');
    idx.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
    idx = idx.slice(0, 200);
    const items = [];
    for (const e of idx) {
      const v = await kv.get('mem:' + e.id);
      if (v) items.push(JSON.parse(v));
    }
    return json({ items }, 200, cors);
  }

  return err('Unknown album action.', 400, cors);
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });
}
function err(message, status, cors) {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { ...cors, 'content-type': 'application/json' } });
}
