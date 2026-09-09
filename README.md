# Little Moments 🎙️📷

A private journal of photos and voice-memo memories with the people you love.

**▶️ Live app: <https://dominicjmorgan.github.io/Memories/>** — open it on your phone and use “Add to Home Screen” to install it.

Add a few photos of a moment, record a voice memo describing it, and Little
Moments turns your words into a warm little **story** you can read — while
keeping the original **audio** so you can always play the memory back in your
own voice.

Everything is stored **privately on your own device**. There is no account, no
server, and nothing to host. The only time anything leaves your device is when
you tap **✨ Summarize with AI**, which sends just the transcript text to
Anthropic using an API key you provide.

---

## Features

- **Photos** — add several photos per memory, or snap one with your camera. Images are automatically resized to keep storage small.
- **Voice memos** — record while you talk about the moment. Your words are captured live (in browsers that support it), and the audio is always saved for playback.
- **AI stories** — Claude turns the transcript into a warm, first-person story with a title and tags. You can edit everything, or write it yourself.
- **A gentle feed** — memories appear as photo cards, newest first, searchable by word or tag.
- **Backup & restore** — export all your memories (photos and audio included) to a single file, and restore them on any device.
- **Installable & offline** — add it to your home screen and it works like an app, even without a connection (AI summaries need a connection).

---

## Running it

Because the app uses the microphone and camera, browsers require it to be
served over **https** or from **localhost** (opening the file directly with
`file://` will not allow recording).

### Quick local run

From this folder:

```bash
# Python 3 (already on most machines)
python3 -m http.server 8000
```

Then open <http://localhost:8000> in Chrome (Chrome has the best live
speech-to-text support).

Any static file server works — for example:

```bash
npx serve .
```

### Put it on your phone

Host the folder on any static host that gives you https (GitHub Pages,
Netlify, Cloudflare Pages, etc.), open it on your phone, and use your browser's
**“Add to Home Screen”** option. It will then behave like a normal app.

---

## Turning on AI summaries

1. Get an Anthropic API key at <https://console.anthropic.com/settings/keys>.
2. In the app, tap the **⚙️ Settings** icon.
3. Paste your key and choose a model:
   - **Claude Opus 5** — best quality (default)
   - **Claude Sonnet 5** — faster and cheaper
   - **Claude Haiku 4.5** — cheapest
4. Record or type a memo, then tap **✨ Summarize with AI**.

Your key is stored only in this browser (in `localStorage`) and is sent only to
Anthropic's API, directly from your device.

> **Note on transcription:** live word capture uses the browser's built-in
> speech recognition (best in Chrome). The audio recording itself always works
> and is always saved. If your browser can't capture words live, you can type
> what you said and still use **Summarize with AI**.

---

## Your data & privacy

- Memories live in your browser's **IndexedDB** on this device.
- Clearing your browser's site data for this app will erase them — use
  **Back up to file** regularly, especially before switching devices.
- Nothing is uploaded anywhere except the optional AI summary request.

---

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App markup and dialogs |
| `styles.css` | Styling (light & dark) |
| `app.js` | Storage, recording, transcription, AI, rendering |
| `manifest.webmanifest` | PWA metadata (installable app) |
| `sw.js` | Service worker for offline use |
| `icons/icon.svg` | App icon |

No build step and no dependencies — it's plain HTML, CSS, and JavaScript.
