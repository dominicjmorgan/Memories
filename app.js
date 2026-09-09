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
  set workspaceId(v) { localStorage.setItem('lm.workspaceId', (v || '').trim()); },
};

/* ----------------------------- AI summary ----------------------------- */

async function summarizeWithAI(transcript) {
  const key = settings.apiKey.trim();
  if (!key) {
    const err = new Error('no-key');
    err.code = 'no-key';
    throw err;
  }

  const system =
    'You help a parent turn a spoken voice memo into a warm, first-person memory ' +
    'story about a moment with their child. Stay faithful to what was actually said — ' +
    'never invent people, places, or events that are not in the transcript. Keep the ' +
    "parent's voice and real details.";

  const prompt =
    'Here is the transcript of a voice memo about a memory:\n\n' +
    `"""${transcript}"""\n\n` +
    'Return ONLY a JSON object (no markdown, no commentary) with these fields:\n' +
    '- "title": a short, evocative title (max ~6 words)\n' +
    '- "story": 2 to 4 warm paragraphs in the first person, telling the memory as a little story\n' +
    '- "tags": an array of 3 to 6 short lowercase tags\n' +
    '- "mood": a single word describing the feeling\n';

  const headers = {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  // Keys that aren't scoped to a workspace need the workspace passed explicitly.
  const workspaceId = settings.workspaceId.trim();
  if (workspaceId) headers['anthropic-workspace-id'] = workspaceId;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      max_tokens: 1200,
      output_config: { effort: 'low' },
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (_) {}
    const err = new Error(detail || `Request failed (${res.status})`);
    err.code = res.status === 401 ? 'auth' : 'http';
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
    img.src = urlFor(p.blob);
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
    if (!transcript) {
      status.hidden = false;
      status.className = 'ai-status error';
      status.textContent = 'Record a voice memo or type a few words first, then I can shape them into a story.';
      return;
    }
    const btn = $('#aiBtn');
    btn.disabled = true;
    status.hidden = false;
    status.className = 'ai-status working';
    status.textContent = '✨ Turning your words into a story…';
    try {
      const result = await summarizeWithAI(transcript);
      if (result.story) $('#storyInput').value = result.story;
      if (result.title && !$('#titleInput').value.trim()) $('#titleInput').value = result.title;
      if (result.tags.length && !$('#tagsInput').value.trim()) $('#tagsInput').value = result.tags.join(', ');
      status.className = 'ai-status';
      status.textContent = 'Story ready — edit it however you like.';
    } catch (err) {
      status.className = 'ai-status error';
      if (err.code === 'no-key') {
        status.textContent = 'Add your Anthropic API key in Settings (⚙️) to use AI summaries. You can also just write the story yourself.';
      } else if (err.code === 'auth') {
        status.textContent = 'That API key was rejected. Double-check it in Settings.';
      } else if (/workspace/i.test(err.message || '')) {
        status.textContent = 'Your API key isn’t tied to a workspace. Open ⚙️ Settings and paste your Workspace ID (starts with “wrkspc_”), then try again.';
      } else {
        status.textContent = 'Could not reach the AI service: ' + (err.message || 'unknown error');
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

function renderFeed(list) {
  const feed = $('#feed');
  feed.innerHTML = '';
  const empty = $('#emptyState');

  if (list.length === 0) {
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.forEach((m) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const photos = m.photos || [];
    if (photos.length) {
      const grid = document.createElement('div');
      grid.className = 'card-photos n' + Math.min(photos.length, 4);
      photos.slice(0, 4).forEach((p, i) => {
        const img = document.createElement('img');
        img.loading = 'lazy';
        img.src = urlFor(p.blob);
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
    feed.appendChild(card);
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
    const gallery = document.createElement('div');
    gallery.className = 'viewer-gallery';
    m.photos.forEach((p) => {
      const img = document.createElement('img');
      img.className = 'viewer-photo';
      img.src = urlFor(p.blob);
      img.alt = m.title || 'Memory photo';
      gallery.appendChild(img);
    });
    body.appendChild(gallery);
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
  $('#viewerDelete').onclick = async () => {
    if (!confirm('Delete this memory? This cannot be undone.')) return;
    await dbDelete(m.id);
    $('#viewer').close();
    toast('Memory deleted.');
    await refresh();
  };

  $('#viewer').showModal();
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
        id: m.id, title: m.title, date: m.date, story: m.story,
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
    $('#apiKeyInput').value = settings.apiKey;
    $('#modelSelect').value = settings.model;
    $('#workspaceIdInput').value = settings.workspaceId;
    $('#dataStatus').hidden = true;
    dlg.showModal();
  });
  $('#apiKeyInput').addEventListener('change', (e) => { settings.apiKey = e.target.value.trim(); });
  $('#modelSelect').addEventListener('change', (e) => { settings.model = e.target.value; });
  $('#workspaceIdInput').addEventListener('change', (e) => { settings.workspaceId = e.target.value; });
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

  $('#fab').addEventListener('click', () => openComposer(null));
  $('#search').addEventListener('input', applySearch);
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-action="new"]');
    if (t) openComposer(null);
  });

  refresh();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', init);
