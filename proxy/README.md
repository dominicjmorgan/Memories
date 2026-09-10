# AI summary proxy (Cloudflare Worker)

This tiny server holds your Anthropic API key safely (off your phone) and adds
the workspace header for you, so AI summaries "just work" — no key or Workspace
ID stored in the browser. It's free on Cloudflare's plan.

You only need to set this up once. Two ways: the **dashboard** (no tools, easiest)
or the **command line**.

---

## Option 1 — Cloudflare dashboard (easiest, ~5 minutes)

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
