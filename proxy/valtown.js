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
 *        ANTHROPIC_API_KEY = your Anthropic key   (required)
 *        WORKSPACE_ID       = wrkspc_…            (only for org-scoped keys)
 *        MODEL              = claude-opus-5        (optional; forces a model)
 *   4. Copy the val's HTTP endpoint URL.
 *   5. App → ⚙️ Settings → paste into "AI proxy URL", leave the API key blank.
 */

const MAX_TOKENS_CAP = 2000;

export default async function (req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: { message: 'Use POST with a JSON Anthropic Messages body.' } }, 405, cors);

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

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });
}
