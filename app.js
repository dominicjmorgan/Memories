/* Little Moments — a private photo + voice-memo memory journal.
   Everything is stored locally in IndexedDB. The only network call is the
   optional AI summary, sent directly to the Anthropic API with the user's
   own key (kept in localStorage on this device only). */

'use strict';

/* ----------------------------- IndexedDB ----------------------------- */

const DB_NAME = 'little-moments';
const DB_VERSION = 1;
const STORE = 'memories';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('date', 'date');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbGetAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(memory) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(memory);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ----------------------------- Helpers ----------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const objectUrls = new Set();
function urlFor(blob) {
  const u = URL.createObjectURL(blob);
  objectUrls.add(u);
  return u;
}
function revokeAll() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls.clear();
}

// Point an <img> at a blob using a one-shot object URL that is revoked only
// AFTER it loads (the image stays displayed) or on error. This avoids the
// wholesale revocation that could kill URLs still referenced by the page
// (e.g. lazy-loaded or not-yet-revealed feed cards), which showed as broken
// image icons.
function setImg(img, blob) {
  const url = URL.createObjectURL(blob);
  img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
  img.addEventListener('error', () => {
    URL.revokeObjectURL(url);
    const ph = document.createElement('div');
    ph.className = 'photo-fallback';
    ph.textContent = '📷';
    if (img.parentNode) img.parentNode.replaceChild(ph, img);
  }, { once: true });
  img.src = url;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function dataURLToBlob(dataURL) {
  const [meta, b64] = dataURL.split(',');
  const mime = (meta.match(/data:(.*?);base64/) || [])[1] || 'application/octet-stream';
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/* Downscale large photos so the local database stays lean. */
function processImage(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxDim / Math.max(width, height));
      width = Math.round(width * scale);
      height = Math.round(height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => resolve(blob || file),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

/* ----------------------------- Settings ----------------------------- */

const settings = {
  get apiKey() { return localStorage.getItem('lm.apiKey') || ''; },
  set apiKey(v) { localStorage.setItem('lm.apiKey', v || ''); },
  get model() { return localStorage.getItem('lm.model') || 'claude-opus-5'; },
  set model(v) { localStorage.setItem('lm.model', v || 'claude-opus-5'); },
  get workspaceId() { return localStorage.getItem('lm.workspaceId') || ''; },
  set workspaceId(v) {
    v = (v || '').trim();
    // Be forgiving: if a whole URL was pasted, pull out the workspace id.
    const m = v.match(/wrkspc_[A-Za-z0-9]+/);
    localStorage.setItem('lm.workspaceId', m ? m[0] : v);
  },
  get proxyUrl() { return localStorage.getItem('lm.proxyUrl') || ''; },
  set proxyUrl(v) { localStorage.setItem('lm.proxyUrl', (v || '').trim().replace(/\/+$/, '')); },
};

/* ----------------------------- AI summary ----------------------------- */

const AI_SYSTEM =
  'You are a delightful family storyteller. Turn a parent\'s voice memo (and any ' +
  'photos) into a FUN, playful, entertaining little story about a moment with their ' +
  'child — the kind of thing that is a joy to read aloud later. Write in the first ' +
  'person as the parent: warm, whimsical, full of vivid sensory detail, playful ' +
  'phrasing and gentle humor. You may add small imaginative flourishes to bring the ' +
  'scene to life, but never invent significant facts — names, who was there, where ' +
  'they were, or what actually happened — that are not supported by the memo or the ' +
  'photos. If photos are provided, look closely and weave in real details you can see ' +
  '(expressions, setting, weather, clothes, tiny moments).';

function buildAiPrompt(transcript, imageCount) {
  const memo = transcript
    ? `Here's my voice memo / notes about this memory:\n\n"""${transcript}"""\n\n`
    : 'I did not leave any words for this one — build the story from the photos.\n\n';
  const photos = imageCount
    ? `I'm also attaching ${imageCount} photo${imageCount === 1 ? '' : 's'} from this moment — use what you see to make the story richer and more accurate.\n\n`
    : '';
  return (
    memo + photos +
    'Write it up as a fun, playful, entertaining story of this memory. ' +
    'Return ONLY a JSON object (no markdown, no commentary) with these fields:\n' +
    '- "title": a short, playful, evocative title (max ~6 words)\n' +
    '- "story": 2 to 4 short, entertaining paragraphs in the first person\n' +
    '- "caption": one short, witty, shareable one-liner (max ~14 words) that captures the moment — the kind of caption you would text to family with the photos. No hashtags, no quotes.\n' +
    '- "tags": an array of 3 to 6 short lowercase tags\n' +
    '- "mood": a single word describing the feeling\n'
  );
}

async function summarizeWithAI(transcript, images) {
  images = images || [];
  const content = images.map((im) => ({
    type: 'image',
    source: { type: 'base64', media_type: im.media_type, data: im.data },
  }));
  content.push({ type: 'text', text: buildAiPrompt(transcript, images.length) });

  // One payload for both paths; only the destination and auth differ.
  const payload = {
    model: settings.model,
    max_tokens: 1200,
    system: AI_SYSTEM,
    messages: [{ role: 'user', content }],
  };

  const proxyUrl = settings.proxyUrl.trim();

  // Preferred path: a pass-through proxy holds the key server-side.
  if (proxyUrl) {
    let res;
    try {
      res = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      const err = new Error('Could not reach the proxy. Check the AI proxy URL in Settings.');
      err.code = 'http';
      throw err;
    }
    return await handleAiResponse(res, { viaProxy: true });
  }

  // Fallback path: call Anthropic directly with the key entered in the browser.
  const key = settings.apiKey.trim();
  if (!key) {
    const err = new Error('no-key');
    err.code = 'no-key';
    throw err;
  }
  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  const workspaceId = settings.workspaceId.trim();
  if (workspaceId) headers['anthropic-workspace-id'] = workspaceId;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  return await handleAiResponse(res, { sentWorkspace: !!workspaceId });
}

async function handleAiResponse(res, meta) {
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (_) {}
    const err = new Error(detail || `Request failed (${res.status})`);
    err.code = res.status === 401 ? 'auth' : 'http';
    err.status = res.status;
    Object.assign(err, meta);
    throw err;
  }
  const data = await res.json();
  const text = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return parseAIJson(text);
}

// Downscale the memory's photos and base64-encode them for the vision model.
async function prepareImagesForAI(photos, max = 4) {
  const out = [];
  for (const p of (photos || []).slice(0, max)) {
    try {
      const small = await processImage(p.blob, 1024, 0.8);
      const dataUrl = await blobToDataURL(small);
      const comma = dataUrl.indexOf(',');
      out.push({
        media_type: (small.type || 'image/jpeg'),
        data: dataUrl.slice(comma + 1),
      });
    } catch (_) { /* skip a photo that can't be processed */ }
  }
  return out;
}

function parseAIJson(text) {
  let raw = text.trim();
  // Strip code fences if present.
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  // Extract the outermost JSON object.
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1) raw = raw.slice(start, end + 1);
  const obj = JSON.parse(raw);
  return {
    title: typeof obj.title === 'string' ? obj.title.trim() : '',
    story: typeof obj.story === 'string' ? obj.story.trim() : '',
    caption: typeof obj.caption === 'string' ? obj.caption.trim() : '',
    tags: Array.isArray(obj.tags) ? obj.tags.map((t) => String(t).trim()).filter(Boolean) : [],
    mood: typeof obj.mood === 'string' ? obj.mood.trim() : '',
  };
}

/* ----------------------------- Recording ----------------------------- */

const recorder = {
  mediaRecorder: null,
  stream: null,
  chunks: [],
  recognition: null,
  recognizedFinal: '',
  timer: null,
  startedAt: 0,
  active: false,
};

function makeRecognition(onUpdate) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const chunk = e.results[i][0].transcript;
      if (e.results[i].isFinal) recorder.recognizedFinal += chunk + ' ';
      else interim += chunk;
    }
    onUpdate((recorder.recognizedFinal + interim).trim());
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      // Mic/permission problem is surfaced by MediaRecorder path already.
    }
  };
  rec.onend = () => {
    // Chrome stops recognition periodically; restart while still recording.
    if (recorder.active && recorder.recognition) {
      try { recorder.recognition.start(); } catch (_) {}
    }
  };
  return rec;
}

async function startRecording(onTranscript) {
  recorder.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  recorder.chunks = [];
  recorder.recognizedFinal = '';
  recorder.active = true;

  const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
    : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
  recorder.mediaRecorder = new MediaRecorder(recorder.stream, mime ? { mimeType: mime } : undefined);
  recorder.mediaRecorder.ondataavailable = (e) => { if (e.data.size) recorder.chunks.push(e.data); };
  recorder.mediaRecorder.start();

  recorder.recognition = makeRecognition(onTranscript);
  if (recorder.recognition) {
    try { recorder.recognition.start(); } catch (_) {}
  }

  recorder.startedAt = Date.now();
}

function stopRecording() {
  return new Promise((resolve) => {
    recorder.active = false;
    if (recorder.recognition) {
      try { recorder.recognition.stop(); } catch (_) {}
      recorder.recognition = null;
    }
    const mr = recorder.mediaRecorder;
    if (!mr || mr.state === 'inactive') {
      cleanupStream();
      resolve(null);
      return;
    }
    mr.onstop = () => {
      const type = mr.mimeType || 'audio/webm';
      const blob = recorder.chunks.length ? new Blob(recorder.chunks, { type }) : null;
      cleanupStream();
      resolve(blob);
    };
    mr.stop();
  });
}

function cleanupStream() {
  if (recorder.stream) {
    recorder.stream.getTracks().forEach((t) => t.stop());
    recorder.stream = null;
  }
  recorder.mediaRecorder = null;
}

/* ----------------------------- Composer state ----------------------------- */

const composer = {
  editingId: null,
  photos: [],        // { id, blob }
  audioBlob: null,
  audioType: '',
};

function resetComposer() {
  composer.editingId = null;
  composer.photos = [];
  composer.audioBlob = null;
  composer.audioType = '';
  $('#titleInput').value = '';
  $('#dateInput').value = todayISO();
  $('#transcriptInput').value = '';
  $('#storyInput').value = '';
  $('#captionInput').value = '';
  $('#tagsInput').value = '';
  $('#photoGrid').innerHTML = '';
  $('#recTimer').textContent = '0:00';
  $('#recordLabel').textContent = 'Record';
  $('#recordBtn').classList.remove('recording');
  const ap = $('#audioPreview');
  ap.hidden = true;
  ap.removeAttribute('src');
  $('#clearAudioBtn').hidden = true;
  const status = $('#aiStatus');
  status.hidden = true;
  status.className = 'ai-status';
}

function renderPhotoGrid() {
  const grid = $('#photoGrid');
  grid.innerHTML = '';
  composer.photos.forEach((p) => {
    const div = document.createElement('div');
    div.className = 'photo-thumb';
    const img = document.createElement('img');
    setImg(img, p.blob);
    img.alt = 'Selected photo';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '✕';
    btn.title = 'Remove photo';
    btn.addEventListener('click', () => {
      composer.photos = composer.photos.filter((x) => x.id !== p.id);
      renderPhotoGrid();
    });
    div.append(img, btn);
    grid.appendChild(div);
  });
}

async function addPhotoFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
  for (const file of files) {
    const blob = await processImage(file);
    composer.photos.push({ id: uid(), blob });
  }
  renderPhotoGrid();
}

function setAudio(blob) {
  composer.audioBlob = blob;
  composer.audioType = blob ? blob.type : '';
  const ap = $('#audioPreview');
  if (blob) {
    ap.src = urlFor(blob);
    ap.hidden = false;
    $('#clearAudioBtn').hidden = false;
  } else {
    ap.hidden = true;
    ap.removeAttribute('src');
    $('#clearAudioBtn').hidden = true;
  }
}

/* ----------------------------- Composer wiring ----------------------------- */

function openComposer(memory) {
  resetComposer();
  if (memory) {
    composer.editingId = memory.id;
    composer.photos = (memory.photos || []).map((p) => ({ id: p.id || uid(), blob: p.blob }));
    if (memory.audioBlob) setAudio(memory.audioBlob);
    $('#composerTitle').textContent = 'Edit memory';
    $('#titleInput').value = memory.title || '';
    $('#dateInput').value = memory.date || todayISO();
    $('#transcriptInput').value = memory.transcript || '';
    $('#storyInput').value = memory.story || '';
    $('#captionInput').value = memory.caption || '';
    $('#tagsInput').value = (memory.tags || []).join(', ');
    renderPhotoGrid();
  } else {
    $('#composerTitle').textContent = 'New memory';
  }
  $('#composer').showModal();
}

function wireComposer() {
  $('#photoInput').addEventListener('change', (e) => { addPhotoFiles(e.target.files); e.target.value = ''; });
  $('#cameraInput').addEventListener('change', (e) => { addPhotoFiles(e.target.files); e.target.value = ''; });

  const recordBtn = $('#recordBtn');
  recordBtn.addEventListener('click', async () => {
    if (recorder.active) {
      recordBtn.disabled = true;
      $('#recordLabel').textContent = 'Saving…';
      clearInterval(recorder.timer);
      const blob = await stopRecording();
      recordBtn.classList.remove('recording');
      $('#recordLabel').textContent = 'Re-record';
      recordBtn.disabled = false;
      if (blob) setAudio(blob);
      return;
    }
    try {
      await startRecording((text) => { $('#transcriptInput').value = text; });
    } catch (err) {
      toast('Microphone permission is needed to record. On the web this requires a secure (https or localhost) page.');
      return;
    }
    recordBtn.classList.add('recording');
    $('#recordLabel').textContent = 'Stop';
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) {
      const status = $('#aiStatus');
      status.hidden = false;
      status.textContent = 'Live word capture is not supported in this browser (Chrome works best). Your audio is still recorded — you can type the words in, or use “Summarize with AI” after typing.';
    }
    recorder.timer = setInterval(() => {
      const secs = Math.floor((Date.now() - recorder.startedAt) / 1000);
      $('#recTimer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    }, 250);
  });

  $('#clearAudioBtn').addEventListener('click', () => {
    setAudio(null);
    $('#recTimer').textContent = '0:00';
    $('#recordLabel').textContent = 'Record';
  });

  $('#aiBtn').addEventListener('click', async () => {
    const transcript = $('#transcriptInput').value.trim();
    const status = $('#aiStatus');
    if (!transcript && composer.photos.length === 0) {
      status.hidden = false;
      status.className = 'ai-status error';
      status.textContent = 'Record a voice memo, type a few words, or add a photo first — then I can spin it into a story.';
      return;
    }
    const btn = $('#aiBtn');
    btn.disabled = true;
    status.hidden = false;
    status.className = 'ai-status working';
    status.textContent = composer.photos.length
      ? '✨ Reading your photos and writing a playful story…'
      : '✨ Turning your words into a playful story…';
    try {
      const images = await prepareImagesForAI(composer.photos);
      const result = await summarizeWithAI(transcript, images);
      if (result.story) $('#storyInput').value = result.story;
      if (result.title && !$('#titleInput').value.trim()) $('#titleInput').value = result.title;
      if (result.caption && !$('#captionInput').value.trim()) $('#captionInput').value = result.caption;
      if (result.tags.length && !$('#tagsInput').value.trim()) $('#tagsInput').value = result.tags.join(', ');
      status.className = 'ai-status';
      status.textContent = 'Story ready — edit it however you like.';
    } catch (err) {
      status.className = 'ai-status error';
      if (err.code === 'no-key') {
        status.textContent = 'To use AI summaries, add an AI proxy URL (recommended) or an Anthropic API key in ⚙️ Settings. You can also just write the story yourself.';
      } else if (err.code === 'auth') {
        status.textContent = 'That API key was rejected. Double-check it in Settings.';
      } else {
        const wsNote = err.viaProxy ? ''
          : err.sentWorkspace === false
            ? ' — note: no Workspace ID was sent (it may not have saved; re-open ⚙️ Settings and check it is still shown).'
            : err.sentWorkspace === true
              ? ' — note: a Workspace ID was sent, so if this still mentions the workspace, the ID may be wrong or the key has no access to it.'
              : '';
        status.textContent = 'AI service said: ' + (err.message || 'unknown error') + wsNote;
      }
    } finally {
      btn.disabled = false;
    }
  });

  $('#composerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    // If a recording is still running, stop and capture it first.
    if (recorder.active) {
      clearInterval(recorder.timer);
      const blob = await stopRecording();
      if (blob) setAudio(blob);
    }

    const story = $('#storyInput').value.trim();
    const transcript = $('#transcriptInput').value.trim();
    const title = $('#titleInput').value.trim();

    if (!title && !story && !transcript && composer.photos.length === 0 && !composer.audioBlob) {
      toast('Add a photo, a recording, or some words first.');
      return;
    }

    const now = Date.now();
    const existing = composer.editingId ? memoriesCache.find((m) => m.id === composer.editingId) : null;

    const memory = {
      id: composer.editingId || uid(),
      title: title || 'Untitled memory',
      date: $('#dateInput').value || todayISO(),
      story,
      caption: $('#captionInput').value.trim(),
      transcript,
      tags: $('#tagsInput').value.split(',').map((t) => t.trim()).filter(Boolean),
      photos: composer.photos.map((p) => ({ id: p.id, blob: p.blob })),
      audioBlob: composer.audioBlob || null,
      audioType: composer.audioType || '',
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };

    await dbPut(memory);
    $('#composer').close();
    toast(composer.editingId ? 'Memory updated.' : 'Memory saved.');
    await refresh();
  });
}

/* ----------------------------- Rendering feed ----------------------------- */

let memoriesCache = [];

function sortMemories(list) {
  return list.slice().sort((a, b) => {
    if (a.date !== b.date) return (b.date || '').localeCompare(a.date || '');
    return (b.createdAt || 0) - (a.createdAt || 0);
  });
}

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Reveal cards as they scroll into view (one shared observer for the feed).
let revealObserver = null;
function getRevealObserver() {
  if (prefersReducedMotion || !('IntersectionObserver' in window)) return null;
  if (!revealObserver) {
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.remove('pre');
          entry.target.style.transitionDelay = ''; // keep later hover snappy
          revealObserver.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.04 });
  }
  return revealObserver;
}

// A small, stable tilt derived from the memory id, so cards look hand-placed
// but never jitter when the feed re-renders.
function tiltFor(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) & 0xffff;
  return (((h % 100) / 100) * 5 - 2.5).toFixed(2); // -2.5deg .. 2.5deg
}

function renderFeed(list) {
  const feed = $('#feed');
  feed.innerHTML = '';
  const empty = $('#emptyState');

  if (list.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const observer = getRevealObserver();

  list.forEach((m, idx) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.style.setProperty('--tilt', tiltFor(m.id) + 'deg');

    const photos = m.photos || [];
    if (photos.length) {
      const grid = document.createElement('div');
      grid.className = 'card-photos n' + Math.min(photos.length, 4);
      photos.slice(0, 4).forEach((p, i) => {
        const img = document.createElement('img');
        img.loading = 'lazy';
        setImg(img, p.blob);
        img.alt = m.title || 'Memory photo';
        if (i === 3 && photos.length > 4) {
          const holder = document.createElement('div');
          holder.className = 'more';
          holder.dataset.more = '+' + (photos.length - 4);
          holder.appendChild(img);
          grid.appendChild(holder);
        } else {
          grid.appendChild(img);
        }
      });
      card.appendChild(grid);
    }

    const body = document.createElement('div');
    body.className = 'card-body';
    const preview = m.story || m.transcript || '';
    body.innerHTML =
      `<div class="card-date">${escapeHtml(fmtDate(m.date))}</div>` +
      `<h3 class="card-title">${escapeHtml(m.title || 'Untitled memory')}</h3>` +
      (preview ? `<p class="card-story">${escapeHtml(preview)}</p>` : '') +
      `<div class="card-meta">` +
        (m.audioBlob ? `<span class="has-audio">🎙️ Voice memo</span>` : '') +
        (m.tags || []).slice(0, 3).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('') +
      `</div>`;
    card.appendChild(body);

    const open = () => openViewer(m.id);
    card.addEventListener('click', open);
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });

    if (observer) {
      card.classList.add('pre');
      card.style.transitionDelay = ((idx % 6) * 40) + 'ms'; // gentle cascade
    }
    feed.appendChild(card);
    if (observer) observer.observe(card);
  });
}

function applySearch() {
  const q = $('#search').value.trim().toLowerCase();
  const sorted = sortMemories(memoriesCache);
  if (!q) return renderFeed(sorted);
  const filtered = sorted.filter((m) => {
    const hay = [m.title, m.story, m.transcript, (m.tags || []).join(' ')].join(' ').toLowerCase();
    return hay.includes(q);
  });
  renderFeed(filtered);
}

/* ----------------------------- Viewer ----------------------------- */

function openViewer(id) {
  const m = memoriesCache.find((x) => x.id === id);
  if (!m) return;

  $('#viewerTitle').textContent = m.title || 'Memory';
  const body = $('#viewerBody');
  body.innerHTML = '';

  if ((m.photos || []).length) {
    const carousel = document.createElement('div');
    carousel.className = 'viewer-carousel';
    const gallery = document.createElement('div');
    gallery.className = 'viewer-gallery';
    m.photos.forEach((p, idx) => {
      const img = document.createElement('img');
      img.className = 'viewer-photo';
      img.style.cursor = 'zoom-in';
      setImg(img, p.blob);
      img.alt = m.title || 'Memory photo';
      img.addEventListener('click', () => openLightbox(m.photos, idx));
      gallery.appendChild(img);
    });
    carousel.appendChild(gallery);

    if (m.photos.length > 1) {
      const dots = document.createElement('div');
      dots.className = 'viewer-dots';
      m.photos.forEach((_, i) => {
        const d = document.createElement('span');
        d.className = 'dot' + (i === 0 ? ' on' : '');
        d.addEventListener('click', () => gallery.scrollTo({ left: i * gallery.clientWidth, behavior: 'smooth' }));
        dots.appendChild(d);
      });
      gallery.addEventListener('scroll', () => {
        const i = Math.round(gallery.scrollLeft / gallery.clientWidth);
        Array.from(dots.children).forEach((d, idx) => d.classList.toggle('on', idx === i));
      }, { passive: true });
      carousel.appendChild(dots);
    }
    body.appendChild(carousel);
  }

  const date = document.createElement('div');
  date.className = 'viewer-date';
  date.textContent = fmtDate(m.date);
  body.appendChild(date);

  if (m.audioBlob) {
    const audio = document.createElement('audio');
    audio.className = 'viewer-audio';
    audio.controls = true;
    audio.src = urlFor(m.audioBlob);
    body.appendChild(audio);
  }

  if (m.story) {
    const story = document.createElement('div');
    story.className = 'viewer-story';
    story.textContent = m.story;
    body.appendChild(story);
  }

  if (m.transcript && m.transcript !== m.story) {
    const det = document.createElement('details');
    det.className = 'viewer-transcript';
    det.innerHTML = `<summary>What I said</summary>${escapeHtml(m.transcript)}`;
    body.appendChild(det);
  }

  if ((m.tags || []).length) {
    const tags = document.createElement('div');
    tags.className = 'viewer-tags';
    tags.innerHTML = m.tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('');
    body.appendChild(tags);
  }

  $('#viewerEdit').onclick = () => { $('#viewer').close(); openComposer(m); };
  $('#viewerShare').onclick = () => sharePostcard(m);
  $('#viewerDelete').onclick = async () => {
    if (!confirm('Delete this memory? This cannot be undone.')) return;
    await dbDelete(m.id);
    $('#viewer').close();
    toast('Memory deleted.');
    await refresh();
  };

  $('#viewer').showModal();
}

/* ----------------------------- Lightbox ----------------------------- */

const lightbox = { photos: [], index: 0, zoomed: false, panX: 0, panY: 0 };

function openLightbox(photos, index) {
  lightbox.photos = photos || [];
  if (!lightbox.photos.length) return;
  lightbox.index = index || 0;
  renderLightbox();
  const hint = $('#lbHint');
  hint.style.opacity = '1';
  setTimeout(() => { hint.style.opacity = '0'; }, 2600);
  $('#lightbox').showModal();
}

function renderLightbox() {
  resetZoom();
  setImg($('#lbImg'), lightbox.photos[lightbox.index].blob);
  $('#lbCounter').textContent = `${lightbox.index + 1} / ${lightbox.photos.length}`;
  const multi = lightbox.photos.length > 1;
  $('#lbPrev').hidden = !multi;
  $('#lbNext').hidden = !multi;
}

function lbGo(delta) {
  const n = lightbox.photos.length;
  if (n < 2) return;
  lightbox.index = (lightbox.index + delta + n) % n;
  renderLightbox();
}

function resetZoom() {
  lightbox.zoomed = false;
  lightbox.panX = 0;
  lightbox.panY = 0;
  const img = $('#lbImg');
  img.classList.remove('zoomed');
  img.style.transform = 'none';
}

function applyLbTransform() {
  $('#lbImg').style.transform = lightbox.zoomed
    ? `translate(${lightbox.panX}px, ${lightbox.panY}px) scale(2.5)`
    : 'none';
}

function toggleZoom() {
  lightbox.zoomed = !lightbox.zoomed;
  lightbox.panX = 0;
  lightbox.panY = 0;
  $('#lbImg').classList.toggle('zoomed', lightbox.zoomed);
  applyLbTransform();
}

function wireLightbox() {
  const dlg = $('#lightbox');
  const img = $('#lbImg');

  $('#lbClose').addEventListener('click', () => dlg.close());
  $('#lbPrev').addEventListener('click', (e) => { e.stopPropagation(); lbGo(-1); });
  $('#lbNext').addEventListener('click', (e) => { e.stopPropagation(); lbGo(1); });

  // Tap dark area to close; clicks on the image/buttons don't reach here.
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') lbGo(-1);
    else if (e.key === 'ArrowRight') lbGo(1);
  });
  dlg.addEventListener('close', resetZoom);

  // Swipe to browse; tap to toggle zoom; drag to pan when zoomed.
  let startX = 0, startY = 0, lastX = 0, lastY = 0, down = false, moved = false;
  img.addEventListener('pointerdown', (e) => {
    down = true; moved = false;
    startX = lastX = e.clientX; startY = lastY = e.clientY;
    try { img.setPointerCapture(e.pointerId); } catch (_) {}
  });
  img.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (Math.abs(e.clientX - startX) > 6 || Math.abs(e.clientY - startY) > 6) moved = true;
    if (lightbox.zoomed) {
      lightbox.panX += e.clientX - lastX;
      lightbox.panY += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      applyLbTransform();
    }
  });
  img.addEventListener('pointerup', (e) => {
    if (!down) return;
    down = false;
    if (lightbox.zoomed) {
      if (!moved) toggleZoom();           // a tap while zoomed → zoom back out
      return;                             // otherwise it was a pan
    }
    const dx = e.clientX - startX;
    if (moved && Math.abs(dx) > 50) lbGo(dx < 0 ? 1 : -1);
    else if (!moved) toggleZoom();        // a tap → zoom in
  });
}

/* ----------------------------- Share postcard ----------------------------- */

function loadImageBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => { resolve(im); setTimeout(() => URL.revokeObjectURL(url), 0); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image')); };
    im.src = url;
  });
}

function drawCover(ctx, img, x, y, w, h) {
  const r = Math.max(w / img.width, h / img.height);
  const nw = img.width * r, nh = img.height * r;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(img, x + (w - nw) / 2, y + (h - nh) / 2, nw, nh);
  ctx.restore();
}

// Lay out 1–4 images inside (x,y,w,h) as a tidy collage with white gutters.
function drawCollage(ctx, imgs, x, y, w, h, gap) {
  gap = gap || 10;
  const n = Math.min(imgs.length, 4);
  const halfW = (w - gap) / 2;
  const halfH = (h - gap) / 2;
  let rects;
  if (n === 1) {
    rects = [[x, y, w, h]];
  } else if (n === 2) {
    rects = [[x, y, halfW, h], [x + halfW + gap, y, halfW, h]];
  } else if (n === 3) {
    // one tall on the left, two stacked on the right
    rects = [
      [x, y, halfW, h],
      [x + halfW + gap, y, halfW, halfH],
      [x + halfW + gap, y + halfH + gap, halfW, halfH],
    ];
  } else {
    // 2 x 2
    rects = [
      [x, y, halfW, halfH],
      [x + halfW + gap, y, halfW, halfH],
      [x, y + halfH + gap, halfW, halfH],
      [x + halfW + gap, y + halfH + gap, halfW, halfH],
    ];
  }
  for (let i = 0; i < n; i++) {
    drawCover(ctx, imgs[i], rects[i][0], rects[i][1], rects[i][2], rects[i][3]);
  }
}

// A short, clean caption for the postcard: whole sentences up to maxChars,
// never cut mid-word. Falls back to a word-boundary trim with an ellipsis.
function shortCaption(text, maxChars) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  if (clean.length <= maxChars) return clean;
  const sentences = clean.match(/[^.!?]+[.!?]+/g) || [clean];
  let out = '';
  for (const s of sentences) {
    const next = (out + s).trim();
    if (next.length > maxChars) break;
    out = next + ' ';
  }
  out = out.trim();
  if (!out) {
    // First sentence already too long — trim to a word boundary.
    let t = clean.slice(0, maxChars);
    t = t.slice(0, t.lastIndexOf(' ') > 0 ? t.lastIndexOf(' ') : t.length);
    out = t + '…';
  }
  return out;
}

function wrapCentered(ctx, text, cx, y, maxWidth, lineHeight, maxLines) {
  maxLines = maxLines || 99;
  const words = (text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxWidth && line) {
      lines.push(line);
      line = w;
      if (lines.length >= maxLines) { line = ''; break; }
    } else {
      line = t;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length >= maxLines && (words.join(' ').length > lines.join(' ').length)) {
    let last = lines[maxLines - 1] || '';
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  for (const l of lines.slice(0, maxLines)) { ctx.fillText(l, cx, y); y += lineHeight; }
  return y;
}

/* ---- Hand-drawn doodles for the postcard ---- */

function markerStyle(ctx, s, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(6, s * 0.075);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

const DOODLES = {
  sun(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    const r = s * 0.22;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    for (let i = 0; i < 8; i++) {
      const a = i * Math.PI / 4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * 1.5, cy + Math.sin(a) * r * 1.5);
      ctx.lineTo(cx + Math.cos(a) * r * 2.1, cy + Math.sin(a) * r * 2.1);
      ctx.stroke();
    }
  },
  cloud(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    const r = s * 0.2, by = cy + r * 0.6;
    ctx.beginPath();
    ctx.arc(cx - r * 1.1, by - r * 0.1, r * 0.9, Math.PI * 0.5, Math.PI * 1.5);
    ctx.arc(cx - r * 0.3, by - r, r, Math.PI, Math.PI * 1.9);
    ctx.arc(cx + r * 0.9, by - r * 0.8, r * 0.85, Math.PI * 1.35, Math.PI * 2.1);
    ctx.arc(cx + r * 1.35, by - r * 0.05, r * 0.7, Math.PI * 1.7, Math.PI * 0.5);
    ctx.closePath(); ctx.stroke();
  },
  rain(ctx, cx, cy, s, color) {
    DOODLES.cloud(ctx, cx, cy - s * 0.12, s * 0.85, color);
    markerStyle(ctx, s, color);
    for (let i = -1; i <= 1; i++) {
      const x = cx + i * s * 0.2, y = cy + s * 0.26;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - s * 0.06, y + s * 0.16); ctx.stroke();
    }
  },
  wave(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    const w = s * 0.9;
    for (let row = 0; row < 2; row++) {
      const y = cy - s * 0.12 + row * s * 0.26;
      ctx.beginPath();
      ctx.moveTo(cx - w / 2, y);
      ctx.quadraticCurveTo(cx - w / 4, y - s * 0.14, cx, y);
      ctx.quadraticCurveTo(cx + w / 4, y + s * 0.14, cx + w / 2, y);
      ctx.stroke();
    }
  },
  heart(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    const r = s * 0.5;
    ctx.save(); ctx.translate(cx, cy - r * 0.15); ctx.beginPath();
    ctx.moveTo(0, r * 0.28);
    ctx.bezierCurveTo(r * 0.5, -r * 0.42, r * 1.05, r * 0.12, 0, r * 0.72);
    ctx.bezierCurveTo(-r * 1.05, r * 0.12, -r * 0.5, -r * 0.42, 0, r * 0.28);
    ctx.closePath(); ctx.fill(); ctx.restore();
  },
  star(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    const outer = s * 0.5, inner = s * 0.22;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? inner : outer, a = -Math.PI / 2 + i * Math.PI / 5;
      const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  },
  balloon(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    const rx = s * 0.26, ry = s * 0.32, topY = cy - s * 0.12;
    ctx.beginPath(); ctx.ellipse(cx, topY, rx, ry, 0, 0, 7); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, topY + ry); ctx.lineTo(cx - s * 0.04, topY + ry + s * 0.06);
    ctx.lineTo(cx + s * 0.04, topY + ry + s * 0.06); ctx.closePath(); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx, topY + ry + s * 0.06);
    ctx.quadraticCurveTo(cx + s * 0.12, cy + s * 0.28, cx - s * 0.04, cy + s * 0.44);
    ctx.stroke();
  },
  cake(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    const w = s * 0.68, h = s * 0.32, x = cx - w / 2, y = cy - h * 0.05;
    ctx.strokeRect(x, y, w, h);
    ctx.beginPath(); ctx.moveTo(x - s * 0.06, y + h); ctx.lineTo(x + w + s * 0.06, y + h); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx, y - s * 0.18); ctx.stroke();
    ctx.beginPath(); ctx.ellipse(cx, y - s * 0.23, s * 0.035, s * 0.06, 0, 0, 7); ctx.fill();
  },
  tree(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    ctx.beginPath(); ctx.arc(cx, cy - s * 0.08, s * 0.27, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, cy + s * 0.19); ctx.lineTo(cx, cy + s * 0.4); ctx.stroke();
  },
  flower(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    const pr = s * 0.13, dist = s * 0.2;
    for (let i = 0; i < 5; i++) {
      const a = -Math.PI / 2 + i * 2 * Math.PI / 5;
      ctx.beginPath(); ctx.arc(cx + Math.cos(a) * dist, cy + Math.sin(a) * dist, pr, 0, 7); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(cx, cy, s * 0.1, 0, 7); ctx.fill();
  },
  paw(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    ctx.beginPath(); ctx.ellipse(cx, cy + s * 0.13, s * 0.22, s * 0.18, 0, 0, 7); ctx.fill();
    for (const [tx, ty] of [[-0.22, -0.16], [-0.075, -0.27], [0.075, -0.27], [0.22, -0.16]]) {
      ctx.beginPath(); ctx.ellipse(cx + tx * s, cy + ty * s, s * 0.075, s * 0.1, 0, 0, 7); ctx.fill();
    }
  },
  smiley(ctx, cx, cy, s, color) {
    markerStyle(ctx, s, color);
    const r = s * 0.36;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.2, r * 0.09, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + r * 0.35, cy - r * 0.2, r * 0.09, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy + r * 0.05, r * 0.5, 0.15 * Math.PI, 0.85 * Math.PI); ctx.stroke();
  },
};

const DOODLE_KEYWORDS = [
  ['cake', ['birthday', 'cake', 'candle', 'candles']],
  ['balloon', ['party', 'balloon', 'celebrate', 'celebration']],
  ['rain', ['rain', 'rainy', 'puddle', 'storm', 'wet', 'splash', 'umbrella']],
  ['wave', ['beach', 'ocean', 'sea', 'swim', 'pool', 'lake', 'water', 'boat', 'sail', 'wave', 'waves', 'river']],
  ['sun', ['sun', 'sunny', 'summer', 'warm', 'morning', 'sunshine', 'picnic']],
  ['tree', ['park', 'tree', 'forest', 'woods', 'autumn', 'leaves', 'nature', 'hike', 'camping']],
  ['flower', ['flower', 'flowers', 'garden', 'spring', 'bloom', 'daisy', 'petal']],
  ['paw', ['dog', 'puppy', 'cat', 'kitten', 'pet', 'animal', 'zoo', 'duck', 'farm', 'bunny']],
  ['balloon', ['fair', 'carnival']],
  ['star', ['star', 'stars', 'night', 'wish', 'magic', 'sparkle', 'wonder', 'dream', 'proud']],
  ['smiley', ['laugh', 'laughing', 'giggle', 'giggles', 'giggling', 'smile', 'happy', 'joy', 'funny', 'silly', 'grin']],
  ['heart', ['love', 'cuddle', 'hug', 'hugs', 'sweet', 'tender', 'kiss', 'snuggle', 'adore', 'family']],
  ['cloud', ['cloud', 'clouds', 'sky']],
];

function chooseDoodles(m) {
  const text = [m.mood, (m.tags || []).join(' '), m.title, m.caption, m.story, m.transcript]
    .join(' ').toLowerCase();
  const picked = [];
  for (const [name, words] of DOODLE_KEYWORDS) {
    if (picked.length >= 3) break;
    if (words.some((w) => text.includes(w)) && !picked.includes(name)) picked.push(name);
  }
  for (const f of ['heart', 'star', 'sun']) {
    if (picked.length >= 3) break;
    if (!picked.includes(f)) picked.push(f);
  }
  return picked.slice(0, 3);
}

function drawDoodleRow(ctx, cx, cy, names, size, seed) {
  const colors = ['#c96f4a', '#7a8b6f', '#a9542f', '#d99a4e'];
  const gap = size * 0.5;
  const total = names.length * size + (names.length - 1) * gap;
  let x = cx - total / 2 + size / 2;
  names.forEach((name, i) => {
    const fn = DOODLES[name] || DOODLES.star;
    const rot = (((i + seed) * 47 % 19) - 9) * Math.PI / 180; // gentle, deterministic tilt
    ctx.save();
    ctx.translate(x, cy);
    ctx.rotate(rot);
    fn(ctx, 0, 0, size, colors[i % colors.length]);
    ctx.restore();
    x += size + gap;
  });
}

async function buildPostcard(m) {
  try { await document.fonts.load('600 40px "Caveat"'); await document.fonts.ready; } catch (_) {}

  const W = 1080, H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#fffdf8';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#ece1d7';
  ctx.lineWidth = 2;
  ctx.strokeRect(24, 24, W - 48, H - 48);

  const fx = 75, fy = 70, fw = W - 150, fh = 720;

  // White polaroid frame with a soft shadow.
  ctx.save();
  ctx.shadowColor = 'rgba(70,50,35,0.22)';
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(fx - 16, fy - 16, fw + 32, fh + 32 + 36);
  ctx.restore();

  // Load up to 4 photos and lay them out as a mini collage.
  const loaded = [];
  for (const p of (m.photos || []).slice(0, 4)) {
    try { loaded.push(await loadImageBlob(p.blob)); } catch (_) {}
  }
  if (loaded.length) {
    drawCollage(ctx, loaded, fx, fy, fw, fh, 10);
  } else {
    ctx.fillStyle = '#f0e7dd';
    ctx.fillRect(fx, fy, fw, fh);
    ctx.fillStyle = '#c9b8a8';
    ctx.font = '120px serif';
    ctx.textAlign = 'center';
    ctx.fillText('📷', W / 2, fy + fh / 2 + 40);
  }

  ctx.textAlign = 'center';
  let y = fy + fh + 36 + 66;

  ctx.fillStyle = '#a9542f';
  ctx.font = '700 40px "Caveat", cursive';
  if (fmtDate(m.date)) { ctx.fillText(fmtDate(m.date), W / 2, y); }
  y += 58;

  ctx.fillStyle = '#2c2622';
  ctx.font = '600 52px Georgia, "Times New Roman", serif';
  y = wrapCentered(ctx, m.title || 'A little moment', W / 2, y, W - 180, 58, 2);
  y += 16;

  const caption = (m.caption && m.caption.trim()) || shortCaption(m.story || m.transcript || '', 170);
  if (caption) {
    ctx.fillStyle = '#6b615a';
    ctx.font = 'italic 31px Georgia, "Times New Roman", serif';
    y = wrapCentered(ctx, caption, W / 2, y, W - 200, 42, 3);
  }

  // Fill the space beneath the caption with a trio of hand-drawn doodles
  // picked from the memory's mood / tags / words.
  const bandTop = y + 18;
  const bandBottom = H - 100; // keep clear of the footer
  const band = bandBottom - bandTop;
  if (band > 80) {
    const size = Math.max(70, Math.min(132, band * 0.72));
    drawDoodleRow(ctx, W / 2, bandTop + band / 2, chooseDoodles(m), size, m.id ? m.id.charCodeAt(0) : 0);
  }

  ctx.fillStyle = '#c96f4a';
  ctx.font = '700 34px "Caveat", cursive';
  ctx.textAlign = 'center';
  ctx.fillText('✽ Little Moments', W / 2, H - 54);

  return await new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.92));
}

async function sharePostcard(m) {
  toast('Making your postcard…');
  let blob;
  try {
    blob = await buildPostcard(m);
  } catch (_) {
    toast('Sorry — could not create the postcard.');
    return;
  }
  if (!blob) { toast('Sorry — could not create the postcard.'); return; }

  const safe = (m.title || 'memory').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'memory';
  const file = new File([blob], `little-moments-${safe}.jpg`, { type: 'image/jpeg' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: m.title || 'A memory', text: m.title || 'A little moment 💛' });
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user dismissed the share sheet
      downloadBlob(blob, file.name);
    }
  } else {
    downloadBlob(blob, file.name);
    toast('Postcard saved to your device.');
  }
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

/* ----------------------------- Backup / restore ----------------------------- */

async function exportData() {
  const status = $('#dataStatus');
  status.hidden = false;
  status.className = 'ai-status working';
  status.textContent = 'Preparing backup…';
  try {
    const all = await dbGetAll();
    const serialized = [];
    for (const m of all) {
      const photos = [];
      for (const p of (m.photos || [])) {
        photos.push({ id: p.id, dataURL: await blobToDataURL(p.blob) });
      }
      serialized.push({
        id: m.id, title: m.title, date: m.date, story: m.story, caption: m.caption || '',
        transcript: m.transcript, tags: m.tags, createdAt: m.createdAt, updatedAt: m.updatedAt,
        photos,
        audio: m.audioBlob ? await blobToDataURL(m.audioBlob) : null,
      });
    }
    const payload = { app: 'little-moments', version: 1, exportedAt: new Date().toISOString(), memories: serialized };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `little-moments-backup-${todayISO()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    status.className = 'ai-status';
    status.textContent = `Backed up ${serialized.length} memor${serialized.length === 1 ? 'y' : 'ies'}.`;
  } catch (err) {
    status.className = 'ai-status error';
    status.textContent = 'Backup failed: ' + (err.message || 'unknown error');
  }
}

async function importData(file) {
  const status = $('#dataStatus');
  status.hidden = false;
  status.className = 'ai-status working';
  status.textContent = 'Restoring…';
  try {
    const payload = JSON.parse(await file.text());
    if (!payload || !Array.isArray(payload.memories)) throw new Error('Not a Little Moments backup file.');
    let count = 0;
    for (const m of payload.memories) {
      const memory = {
        id: m.id || uid(),
        title: m.title || 'Untitled memory',
        date: m.date || todayISO(),
        story: m.story || '',
        caption: m.caption || '',
        transcript: m.transcript || '',
        tags: Array.isArray(m.tags) ? m.tags : [],
        photos: (m.photos || []).map((p) => ({ id: p.id || uid(), blob: dataURLToBlob(p.dataURL) })),
        audioBlob: m.audio ? dataURLToBlob(m.audio) : null,
        audioType: m.audio ? dataURLToBlob(m.audio).type : '',
        createdAt: m.createdAt || Date.now(),
        updatedAt: m.updatedAt || Date.now(),
      };
      await dbPut(memory);
      count++;
    }
    status.className = 'ai-status';
    status.textContent = `Restored ${count} memor${count === 1 ? 'y' : 'ies'}.`;
    await refresh();
  } catch (err) {
    status.className = 'ai-status error';
    status.textContent = 'Restore failed: ' + (err.message || 'unknown error');
  }
}

/* ----------------------------- App bootstrap ----------------------------- */

async function refresh() {
  revokeAll();
  memoriesCache = await dbGetAll();
  applySearch();
}

function wireSettings() {
  const dlg = $('#settings');
  $('#settingsBtn').addEventListener('click', () => {
    $('#proxyUrlInput').value = settings.proxyUrl;
    $('#apiKeyInput').value = settings.apiKey;
    $('#modelSelect').value = settings.model;
    $('#workspaceIdInput').value = settings.workspaceId;
    $('#dataStatus').hidden = true;
    dlg.showModal();
  });
  // Use 'input' (not 'change') so pasted values persist immediately, even if
  // the dialog is closed without the field losing focus first.
  $('#proxyUrlInput').addEventListener('input', (e) => { settings.proxyUrl = e.target.value; });
  $('#apiKeyInput').addEventListener('input', (e) => { settings.apiKey = e.target.value.trim(); });
  $('#modelSelect').addEventListener('change', (e) => { settings.model = e.target.value; });
  $('#workspaceIdInput').addEventListener('input', (e) => { settings.workspaceId = e.target.value; });
  $('#exportBtn').addEventListener('click', exportData);
  $('#importInput').addEventListener('change', (e) => {
    if (e.target.files[0]) importData(e.target.files[0]);
    e.target.value = '';
  });
}

function wireDialogs() {
  // Close buttons and backdrop clicks.
  $$('dialog').forEach((dlg) => {
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close(); // click on backdrop
    });
    $$('[data-close]', dlg).forEach((btn) => btn.addEventListener('click', () => dlg.close()));
  });
  // Make sure a stray recording is stopped if the composer is dismissed.
  $('#composer').addEventListener('close', () => {
    if (recorder.active) {
      clearInterval(recorder.timer);
      stopRecording();
    }
  });
}

function init() {
  wireComposer();
  wireSettings();
  wireDialogs();
  wireLightbox();

  $('#fab').addEventListener('click', () => openComposer(null));
  $('#search').addEventListener('input', applySearch);
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action="new"]');
    if (t) openComposer(null);
  });

  refresh();

  // Skip the service worker on the /fresh/ test page so it stays fully
  // cache-free (there is no sw.js there to register anyway).
  if ('serviceWorker' in navigator && !location.pathname.includes('/fresh/')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
