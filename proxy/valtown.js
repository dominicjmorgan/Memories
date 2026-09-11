/* Little Moments — AI summary proxy for Val Town (https://val.town)
 *
 * The easiest way to host the proxy: no CLI, no build, no "assets" — just paste
 * this into an HTTP val and set one environment variable.
 *
 * Setup:
 *   1. Sign up free at https://val.town (you can use Google to sign in).
 *   2. Click "New" → "HTTP val".
 *   3. Delete the sample code and paste this whole file in.
 *   4. Add your key: click your username → Settings → Environment Variables,
 *      add ANTHROPIC_API_KEY = your Anthropic key.
 *      (Optional) add WORKSPACE_ID = wrkspc_… if your key is org-scoped,
 *      and MODEL = claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5.
 *   5. Copy the val's HTTP endpoint URL (shown at the top of the val).
 *   6. In the Little Moments app → ⚙️ Settings → paste it into "AI proxy URL",
 *      and leave the API key field blank.
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

export default async function (req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: { message: 'Use POST with a JSON { transcript } body.' } }, 405, cors);

  const key = Deno.env.get('ANTHROPIC_API_KEY');
  if (!key) return json({ error: { message: 'The proxy is missing its ANTHROPIC_API_KEY environment variable.' } }, 500, cors);

  let body;
  try { body = await req.json(); } catch (_) { return json({ error: { message: 'Invalid JSON body.' } }, 400, cors); }
  const transcript = body && typeof body.transcript === 'string' ? body.transcript.trim() : '';
  if (!transcript) return json({ error: { message: 'Missing "transcript".' } }, 400, cors);
  if (transcript.length > 20000) return json({ error: { message: 'Transcript is too long.' } }, 413, cors);

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
    body: JSON.stringify({
      model: Deno.env.get('MODEL') || 'claude-opus-5',
      max_tokens: 1200,
      output_config: { effort: 'low' },
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(transcript) }],
    }),
  });

  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { ...cors, 'content-type': 'application/json' } });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, 'content-type': 'application/json' } });
}
