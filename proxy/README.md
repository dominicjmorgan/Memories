# AI summary proxy (Cloudflare Worker)

This tiny server holds your Anthropic API key safely (off your phone) and adds
the workspace header for you, so AI summaries "just work" — no key or Workspace
ID stored in the browser. It's free on Cloudflare's plan.

You only need to set this up once. Pick whichever host is easiest for you.

---

## Option 0 — Val Town (simplest, no CLI, ~3 minutes) ⭐ recommended

Val Town lets you paste a small server into a web editor and instantly get a URL —
no "assets", no build, no missing buttons.

1. Sign up free at <https://val.town> (you can sign in with Google).
2. Click **New** → **HTTP val**.
3. Delete the sample code and paste in the entire contents of [`valtown.js`](./valtown.js).
4. Add your key: click your username → **Settings** → **Environment Variables** →
   add `ANTHROPIC_API_KEY` = your Anthropic key.
   - (Only for org-scoped keys) also add `WORKSPACE_ID` = your `wrkspc_…`.
   - (Optional) add `MODEL` = `claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5`.
5. Copy the val's **HTTP endpoint URL** (shown at the top of the val).
6. In the app → ⚙️ **Settings** → paste it into **AI proxy URL**, leave the API key blank.

---

## Option 1 — Cloudflare dashboard (~5 minutes)

> **Heads-up:** the in-dashboard "Edit code" button only appears for a plain Worker.
> If you created a Worker that includes static assets (or via a framework template),
> that button is hidden. To get the editable kind: **Workers & Pages → Create →
> Workers → "Hello World"** (a plain Worker, not a framework/assets template). That
> opens the inline code editor. You can delete the earlier assets-based Worker.

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. In the left sidebar, go to **Compute (Workers)** → **Workers & Pages** → **Create** → **Create Worker**.
3. Give it a name like `little-moments-ai` and click **Deploy** (it deploys a default hello-world).
4. Click **Edit code**. Delete everything in the editor, then paste the entire
   contents of [`worker.js`](./worker.js). Click **Deploy**.
5. Add your key and settings:
   - Go to the Worker's **Settings** → **Variables and Secrets**.
   - Under **Secrets**, click **Add**, name it exactly `ANTHROPIC_API_KEY`, paste your
     Anthropic key as the value, and save.
   - (Only if your key is organization-scoped) Under **Variables**, add `WORKSPACE_ID`
     with your `wrkspc_…` id.
   - (Optional) Add a **Variable** `MODEL` = `claude-opus-5` (or `claude-sonnet-5` / `claude-haiku-4-5`).
6. Copy your Worker's URL — it looks like
   `https://little-moments-ai.<your-subdomain>.workers.dev`.
7. In the Little Moments app, open ⚙️ **Settings**, paste that URL into
   **AI proxy URL**, and leave the API key blank. Done — try **✨ Summarize with AI**.

### Lock it down (recommended, after it works)
Back in **Settings → Variables**, add `ALLOWED_ORIGINS` =
`https://dominicjmorgan.github.io` so only your app can use the Worker (and your key).

---

## Option 2 — Command line (Wrangler)

```bash
cd proxy
npx wrangler login
npx wrangler secret put ANTHROPIC_API_KEY      # paste your key when prompted
# If your key is org-scoped, set the workspace id (or add it to wrangler.toml [vars]):
npx wrangler secret put WORKSPACE_ID           # optional
npx wrangler deploy
```

Wrangler prints the Worker URL. Paste it into the app's **AI proxy URL** field.

---

## How the app uses it

- If **AI proxy URL** is set in Settings, the app sends only the transcript to your
  Worker; the Worker calls Anthropic with the key it holds. No key is stored on your device.
- If the proxy URL is blank, the app falls back to calling Anthropic directly with the
  API key you entered (the original behavior).

## Notes
- The Worker only ever performs the memory-summary request — it can't be used to run
  arbitrary prompts with your key.
- Set `ALLOWED_ORIGINS` to your app's origin to prevent other sites from using your Worker.
- Cloudflare's free tier is generous; personal use won't approach its limits.

---

## Shared family album (optional)

Lets invited family view the memories you publish, via a private link + a
family password. It reuses this same Worker plus Cloudflare's free key‑value
storage (KV). One‑time setup:

### 1. Create a KV namespace and bind it
1. Cloudflare dashboard → **Storage & Databases → KV → Create a namespace**
   (name it e.g. `little-moments-album`).
2. Open your Worker → **Settings → Bindings → Add → KV namespace**.
   - **Variable name:** `ALBUM` (exactly).
   - **Namespace:** the one you just created. Save/deploy.

### 2. Add the album secrets
On the Worker → **Settings → Variables and Secrets**, add three **Secrets**:
- `ALBUM_OWNER_KEY` — a long random string; only *your* device uses it to publish.
- `ALBUM_READ_KEY` — a long random string; this goes in the family link.
- `ALBUM_PASSWORD` — the password you give family (e.g. a memorable phrase).

(Use a password manager or just make up long random values for the two keys.)

### 3. Re‑deploy the Worker
Make sure the Worker is running the latest [`worker.js`](./worker.js) (it now
handles both the AI proxy and the album). Deploy.

### 4. Turn it on in the app
In Little Moments → ⚙️ **Settings → Shared family album**:
- Enter the **same** Owner key, Read key, and Family password you set on the Worker.
- Tick **Publish my memories to the shared album**.
- Tap **Publish all now** to upload your existing memories.
- Tap **Copy family link** and send it to family. Tell them the **password separately**
  (not in the same message), so a forwarded link alone can't open the album.

Family open the link, enter the password once, and see your album — read‑only.
New memories you save publish automatically. Deleting a memory removes it from
the album too.

**Privacy:** album memories (photos, audio, text) are stored in your Cloudflare
KV, readable only with the read key **and** the password. Your on‑device journal
is unchanged; publishing is a copy. Free‑tier KV is generous but has limits — fine
for a family; very large libraries may eventually need Cloudflare R2 (ask me).

---

## Read-aloud narration (optional)

Adds a warm, real-sounding voice to the **🔊 Read aloud** button, using
[ElevenLabs](https://elevenlabs.io) text-to-speech. Each story is voiced once,
then cached on the memory (and included when it syncs to the family album), so
you only pay to generate it a single time and it replays instantly afterward.
Without this, the button still works using your device's built-in voice.

### 1. Get an ElevenLabs API key
1. Sign up free at <https://elevenlabs.io> (the free tier includes a monthly
   character allowance — plenty to try it out).
2. Click your profile → **API Keys** → **Create API Key**, and copy it.

### 2. Add it to your Worker
On the Worker → **Settings → Variables and Secrets**, add a **Secret**:
- `ELEVENLABS_API_KEY` — the key you just copied.

Optional **Variables** (not secrets):
- `ELEVENLABS_VOICE_ID` — the default voice for everyone. Blank uses `Rachel`
  (a warm, natural narrator). Browse the
  [voice library](https://elevenlabs.io/app/voice-library) and copy any voice's ID.
- `ELEVENLABS_MODEL` — defaults to `eleven_multilingual_v2` (best quality).
  Use `eleven_turbo_v2_5` for roughly half the cost and lower latency.

Re-deploy the Worker with the latest [`worker.js`](./worker.js) (it now handles
the AI proxy, the album, **and** `/tts`).

### 3. (Optional) pick a per-device voice
In the app → ⚙️ **Settings → Read-aloud voice**, paste a **Voice ID** to override
the default just for your device. Leave it blank to use the Worker's default.

With `ELEVENLABS_API_KEY` set, tapping **🔊 Read aloud** narrates the story in the
chosen voice; family hear the same voice on memories that were narrated before
publishing. Val Town setups work the same way — add `ELEVENLABS_API_KEY` (and the
optional variables) as environment variables there too.

**Cost control:** stories are trimmed to 2,500 characters per narration, and the
Worker only ever synthesizes the text the app sends — it can't be used to
generate arbitrary audio with your key. Set `ALLOWED_ORIGINS` (above) so only
your app can reach `/tts`.
