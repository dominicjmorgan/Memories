/* Little Moments — AI summary proxy (Cloudflare Worker)
 *
 * Holds your Anthropic API key as a server-side secret so it never lives in
 * the browser, and adds the workspace header for you. The app sends only a
 * transcript; the Worker builds the request, calls Anthropic, and returns the
 * result.
 *
 * Required secret:  ANTHROPIC_API_KEY
 * Optional vars:    WORKSPACE_ID     (wrkspc_… — needed only for org-scoped keys)
 *                   MODEL            (default: claude-opus-5)
 *                   ALLOWED_ORIGINS  (comma-separated; e.g. https://dominicjmorgan.github.io)
 */

const SYSTEM =
  'You help a parent turn a spoken voice memo into a warm, first-person memory ' +
  'story about a moment with their child. Stay faithful to what was actually said — ' +
  'never invent people, places, or events that are not in the transcript. Keep the ' +
  "parent's voice and real details.";

function buildPrompt(transcript) {
  return (
    'Here is the transcript of a voice memo about a memory:\n\n' +
    `"""${transcript}"""\n\n` +
    'Return ONLY a JSON object (no markdown, no commentary) with these fields:\n' +
    '- "title": a short, evocative title (max ~6 words)\n' +
    '- "story": 2 to 4 warm paragraphs in the first person, telling the memory as a little story\n' +
    '- "tags": an array of 3 to 6 short lowercase tags\n' +
    '- "mood": a single word describing the feeling\n'
  );
}

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
    if (request.method !== 'POST') return err('Use POST with a JSON { transcript } body.', 405, cors);

    // Optional origin lock so only your app can use the key.
    if (allowed.length && origin && !allowed.includes(origin)) {
      return err('This origin is not allowed to use the proxy.', 403, cors);
    }
    if (!env.ANTHROPIC_API_KEY) {
      return err('The proxy is missing its ANTHROPIC_API_KEY secret.', 500, cors);
    }

    let body;
    try { body = await request.json(); } catch (_) { return err('Invalid JSON body.', 400, cors); }
    const transcript = body && typeof body.transcript === 'string' ? body.transcript.trim() : '';
    if (!transcript) return err('Missing "transcript".', 400, cors);
    if (transcript.length > 20000) return err('Transcript is too long.', 413, cors);

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
        body: JSON.stringify({
          model: env.MODEL || 'claude-opus-5',
          max_tokens: 1200,
          output_config: { effort: 'low' },
          system: SYSTEM,
          messages: [{ role: 'user', content: buildPrompt(transcript) }],
        }),
      });
    } catch (e) {
      return err('Could not reach Anthropic: ' + (e && e.message ? e.message : 'network error'), 502, cors);
    }

    // Pass Anthropic's response (success or error) straight back to the app.
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
