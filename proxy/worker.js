/* Little Moments — AI proxy (Cloudflare Worker), pass-through version.
 *
 * Holds your Anthropic API key as a server-side secret so it never lives in the
 * browser, and (optionally) adds the workspace header. It forwards the request
 * the app sends straight to Anthropic — so the app owns the prompt, and you
 * never need to edit this Worker again when the story style changes.
 *
 * Required secret:  ANTHROPIC_API_KEY
 * Optional vars:    WORKSPACE_ID     (wrkspc_… — only for org-scoped keys)
 *                   MODEL            (force a model, overriding the app's choice)
 *                   ALLOWED_ORIGINS  (comma-separated; e.g. https://dominicjmorgan.github.io)
 */

const MAX_TOKENS_CAP = 2000; // safety clamp so the key can't be abused for huge outputs

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGINS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const corsOrigin = allowed.length === 0
      ? '*'
      : (allowed.includes(origin) ? origin : allowed[0]);
    const cors = {
      'Access-Control-Allow-Origin': corsOrigin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return err('Use POST with a JSON Anthropic Messages body.', 405, cors);

    if (allowed.length && origin && !allowed.includes(origin)) {
      return err('This origin is not allowed to use the proxy.', 403, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return err('The proxy is missing its ANTHROPIC_API_KEY secret.', 500, cors);
    }

    let body;
    try { body = await request.json(); } catch (_) { return err('Invalid JSON body.', 400, cors); }
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
      return err('Body must be an Anthropic Messages request with a "messages" array.', 400, cors);
    }

    // Safety clamps: force/limit the fields that control cost.
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
      upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (e) {
      return err('Could not reach Anthropic: ' + (e && e.message ? e.message : 'network error'), 502, cors);
    }

    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: { ...cors, 'content-type': 'application/json' },
    });
  },
};

function err(message, status, cors) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { ...cors, 'content-type': 'application/json' },
  });
}
