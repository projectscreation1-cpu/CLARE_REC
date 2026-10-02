import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2/+esm';

const MP_VERSION = '0.10.35';
const MP_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

const REQ = { width: 640, height: 480, fps: 25 };
const MAX_SECONDS = 12;
const LUMA_MIN = 60;
const LUMA_MAX = 235;
const STEADY_PX = 22; // per-frame nose movement; do not tighten, handheld phones shake
const STEADY_FRAMES = 5;
const DISCLAIMER =
  'This recording is exclusively for our project purpose and will not be used anywhere else. ' +
  'It is only used for training purposes.';

const L = window.ClarusLogic;
const CFG = window.CLARUS_CONFIG || {};
const $ = (id) => document.getElementById(id);

const setNumber = L.parseSetParam(location.search);
const sentences = L.SENTENCE_SETS[setNumber];

const state = {
  participant: null,
  stream: null,
  landmarker: null,
  rafId: 0,
  lastVideoTime: -1,
  checks: { one: false, light: false, steady: false },
  noseHistory: [],
  lastLuma: null,
  index: 0,
  phase: 'idle', // idle | countdown | recording | processing | uploading | uploaded | failed | rejected
  recording: null, // { recorder, chunks, lumaSamples, startedAt }
  pending: null, // { blob, path, contentType, metadata } awaiting (re)upload
  clips: [],
};

let supabase = null;

// ---------------------------------------------------------------- screens

function show(id) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  const slot = document.querySelector(`#${id} [data-stage]`);
  if (slot) slot.appendChild($('stage-inner'));
  window.scrollTo(0, 0);
}

function setStatus(el, html, kind = '') {
  el.className = `status ${kind}`;
  el.innerHTML = html;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------------------------------------------------------- screen 1

const form = $('consent-form');
const ageSel = $('f-age');

function readForm() {
  const glasses = form.querySelector('input[name="glasses"]:checked');
  return {
    name: $('f-name').value.trim(),
    rollNo: $('f-roll').value.trim(),
    ageGroup: ageSel.value,
    gender: $('f-gender').value,
    skinTone: $('f-skin').value,
    facialHair: $('f-facial').value,
    glasses: glasses ? glasses.value : '',
    consent: $('f-consent').checked,
    guardianConsent: ageSel.value === 'Under 18' ? $('f-guardian').checked : null,
  };
}

function formValid(p) {
  return Boolean(
    p.name && p.rollNo && p.ageGroup && p.gender && p.skinTone && p.facialHair && p.glasses && p.consent &&
    (p.ageGroup !== 'Under 18' || p.guardianConsent)
  );
}

function refreshForm() {
  const minor = ageSel.value === 'Under 18';
  $('guardian-wrap').hidden = !minor;
  $('f-guardian').required = minor;
  if (!minor) $('f-guardian').checked = false;
  $('btn-start').disabled = !formValid(readForm());
}
form.addEventListener('input', refreshForm);
form.addEventListener('change', refreshForm);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = readForm();
  if (!formValid(p)) return;
  state.participant = p;
  show('screen-check');
  await startCamera();
});

// ---------------------------------------------------------------- camera + face model

const video = $('preview');
const overlay = $('overlay');

function showOverlay(html, big = false) {
  overlay.innerHTML = html;
  overlay.classList.toggle('big', big);
  overlay.hidden = false;
}
function hideOverlay() { overlay.hidden = true; }

async function openStream() {
  const audio = { echoCancellation: true, noiseSuppression: true };
  const base = { facingMode: 'user', frameRate: { ideal: REQ.fps } };
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { ...base, width: { exact: REQ.width }, height: { exact: REQ.height } },
      audio,
    });
  } catch (err) {
    // Some cameras can't do exactly 640x480; take the closest and record actual values in metadata.
    if (err.name !== 'OverconstrainedError') throw err;
    return navigator.mediaDevices.getUserMedia({
      video: { ...base, width: { ideal: REQ.width }, height: { ideal: REQ.height } },
      audio,
    });
  }
}

function cameraErrorMessage(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '<strong>Camera or microphone permission was denied.</strong><br>Allow camera and microphone access for this site (tap the lock/“aA” icon in the address bar, or check your browser settings), then reload the page.';
    case 'NotFoundError':
      return '<strong>No camera or microphone was found.</strong> Please use a device with a front camera and microphone.';
    case 'NotReadableError':
      return '<strong>The camera is in use by another app.</strong> Close other apps or tabs using the camera and reload.';
    default:
      return `<strong>Could not start the camera.</strong> ${escapeHtml(err && err.message ? err.message : String(err))}`;
  }
}

async function loadLandmarker() {
  const { FaceLandmarker, FilesetResolver } = await import(`${MP_BASE}/vision_bundle.mjs`);
  const fileset = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  const make = (delegate) => FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate },
    runningMode: 'VIDEO',
    numFaces: 3,
  });
  try {
    return await make('GPU');
  } catch (err) {
    console.warn('GPU delegate failed, using CPU', err);
    return make('CPU');
  }
}

async function startCamera() {
  const status = $('check-status');
  if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus(status, '<strong>Camera access needs a secure (https://) page</strong> and a modern browser. Please open the link in Chrome, Edge or Safari.', 'err');
    return;
  }
  showOverlay('<span><span class="spinner"></span>Loading face-detection model…</span>');
  const modelPromise = state.landmarker ? Promise.resolve(state.landmarker) : loadLandmarker();
  modelPromise.catch(() => {}); // handled below

  try {
    state.stream = await openStream();
  } catch (err) {
    hideOverlay();
    setStatus(status, cameraErrorMessage(err), 'err');
    return;
  }
  video.srcObject = state.stream;
  try { await video.play(); } catch (_) { /* autoplay+muted normally succeeds */ }

  try {
    state.landmarker = await modelPromise;
  } catch (err) {
    showOverlay('Could not load the face model. Check your internet connection and reload.');
    setStatus(status, `Face model failed to load: ${escapeHtml(err.message || err)}`, 'err');
    return;
  }
  hideOverlay();
  loop();
}

function stopCamera() {
  cancelAnimationFrame(state.rafId);
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  video.srcObject = null;
}

// ---------------------------------------------------------------- quality checks

const lumaCanvas = document.createElement('canvas');
lumaCanvas.width = lumaCanvas.height = 48;
const lumaCtx = lumaCanvas.getContext('2d', { willReadFrequently: true });

function faceLuma(lm, vw, vh) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of lm) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const x = Math.max(0, minX * vw), y = Math.max(0, minY * vh);
  const w = Math.min(vw, maxX * vw) - x, h = Math.min(vh, maxY * vh) - y;
  if (w < 4 || h < 4) return null;
  lumaCtx.drawImage(video, x, y, w, h, 0, 0, 48, 48);
  const d = lumaCtx.getImageData(0, 0, 48, 48).data;
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return sum / (d.length / 4);
}

function evaluate(result) {
  const faces = result.faceLandmarks || [];
  const vw = video.videoWidth, vh = video.videoHeight;
  const one = faces.length === 1;
  let light = false, steady = false;

  if (one) {
    const lm = faces[0];
    const luma = faceLuma(lm, vw, vh);
    state.lastLuma = luma;
    light = luma !== null && luma >= LUMA_MIN && luma <= LUMA_MAX;
    if (state.recording && luma !== null) state.recording.lumaSamples.push(luma);

    const nose = { x: lm[1].x * vw, y: lm[1].y * vh };
    const h = state.noseHistory;
    h.push(nose);
    if (h.length > STEADY_FRAMES) h.shift();
    steady = h.length === STEADY_FRAMES &&
      h.slice(1).every((p, i) => Math.hypot(p.x - h[i].x, p.y - h[i].y) <= STEADY_PX);
  } else {
    state.noseHistory = [];
    state.lastLuma = null;
  }

  state.checks = { one, light, steady };
  document.querySelectorAll('#checklist li').forEach((li) => li.classList.toggle('ok', state.checks[li.dataset.check]));
  const allOk = one && light && steady;
  $('btn-continue').disabled = !allOk;
  $('btn-record').disabled = !(allOk && (state.phase === 'idle' || state.phase === 'rejected'));
}

function loop() {
  state.rafId = requestAnimationFrame(loop);
  if (state.recording) drawRecordingFrame();
  if (!state.landmarker || video.readyState < 2 || video.currentTime === state.lastVideoTime) return;
  state.lastVideoTime = video.currentTime;
  try {
    evaluate(state.landmarker.detectForVideo(video, performance.now()));
  } catch (err) {
    console.warn('detect failed', err);
  }
}

$('btn-continue').addEventListener('click', () => {
  show('screen-record');
  renderSentence();
});

// ---------------------------------------------------------------- canvas recording

const recCanvas = $('rec-canvas');
recCanvas.width = REQ.width;
recCanvas.height = REQ.height;
const recCtx = recCanvas.getContext('2d');

function wrapLines(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) { lines.push(line); line = w; } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawRecordingFrame() {
  const cw = recCanvas.width, ch = recCanvas.height;
  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;
  // Cover-crop the camera frame into the 4:3 canvas (matches the on-screen preview).
  const scale = Math.max(cw / vw, ch / vh);
  const sw = cw / scale, sh = ch / scale;
  recCtx.drawImage(video, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, cw, ch);

  const fontPx = 14, pad = 8, lh = fontPx * 1.3;
  recCtx.font = `600 ${fontPx}px system-ui, -apple-system, Roboto, sans-serif`;
  const lines = wrapLines(recCtx, DISCLAIMER, cw - pad * 2);
  const barH = lines.length * lh + pad * 2;
  recCtx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  recCtx.fillRect(0, ch - barH, cw, barH);
  recCtx.fillStyle = '#ffffff';
  recCtx.textAlign = 'center';
  recCtx.textBaseline = 'top';
  lines.forEach((ln, i) => recCtx.fillText(ln, cw / 2, ch - barH + pad + i * lh));
}

function pickMimeType() {
  const candidates = ['video/webm;codecs=vp9,opus', 'video/webm'];
  // Older iPhone Safari can only record MP4; without this fallback those phones can't take part.
  const fallbacks = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
  if (typeof MediaRecorder === 'undefined') return null;
  return [...candidates, ...fallbacks].find((t) => MediaRecorder.isTypeSupported(t)) || '';
}

// ---------------------------------------------------------------- speech verification

function startSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const sp = { supported: Boolean(SR), committed: '', current: '', error: null, active: false, stopping: false, onEnded: null };
  if (!SR) return sp;

  const fatal = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'network', 'language-not-supported']);
  const begin = () => {
    const r = new SR();
    r.lang = 'en-US';
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      sp.current = Array.from(e.results).map((res) => res[0].transcript).join(' ');
    };
    r.onerror = (e) => {
      if (!sp.error || sp.error === 'no-speech') sp.error = e.error;
    };
    r.onend = () => {
      sp.committed = `${sp.committed} ${sp.current}`.trim();
      sp.current = '';
      sp.active = false;
      // Mobile Chrome ends sessions after short pauses; restart while we're still recording.
      if (!sp.stopping && !fatal.has(sp.error)) {
        try { begin(); return; } catch (_) { /* fall through */ }
      }
      if (sp.onEnded) sp.onEnded();
    };
    sp.rec = r;
    r.start();
    sp.active = true;
  };
  try {
    begin();
  } catch (err) {
    sp.error = 'start-failed';
  }
  return sp;
}

function stopSpeech(sp) {
  return new Promise((resolve) => {
    if (!sp.supported || !sp.active) { resolve(); return; }
    sp.stopping = true;
    const t = setTimeout(resolve, 3000);
    sp.onEnded = () => { clearTimeout(t); resolve(); };
    try { sp.rec.stop(); } catch (_) { clearTimeout(t); resolve(); }
  });
}

const transcriptOf = (sp) => `${sp.committed} ${sp.current}`.trim();

// ---------------------------------------------------------------- screen 3 flow

const recStatus = $('rec-status');

function setPhase(phase) {
  state.phase = phase;
  const vis = {
    'btn-record': phase === 'idle' || phase === 'rejected',
    'btn-stop': phase === 'recording',
    'btn-retry-upload': phase === 'failed',
    'btn-rerecord': phase === 'uploaded' || phase === 'failed',
    'btn-next': phase === 'uploaded',
  };
  for (const [id, v] of Object.entries(vis)) $(id).hidden = !v;
  $('btn-record').textContent = phase === 'rejected' ? '● Record again' : '● Record';
  const c = state.checks;
  $('btn-record').disabled = !(c.one && c.light && c.steady);
  $('btn-next').textContent = state.index === sentences.length - 1 ? 'Finish' : 'Next Sentence';
}

function renderSentence() {
  const i = state.index;
  $('rec-counter').textContent = `Sentence ${i + 1} of ${sentences.length}`;
  $('rec-set').textContent = `Set ${setNumber}`;
  $('rec-progress').style.width = `${(i / sentences.length) * 100}%`;
  $('rec-sentence').textContent = sentences[i];
  setStatus(recStatus, 'When all three checks are green, tap <strong>Record</strong> and read the sentence aloud clearly.');
  state.pending = null;
  setPhase('idle');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

$('btn-record').addEventListener('click', async () => {
  if (state.phase !== 'idle' && state.phase !== 'rejected') return;
  const mimeType = pickMimeType();
  if (mimeType === null || typeof recCanvas.captureStream !== 'function') {
    setStatus(recStatus, 'This browser cannot record video. Please use Chrome or Edge (Android/desktop) or Safari (iPhone).', 'err');
    return;
  }
  setPhase('countdown');
  $('btn-record').hidden = true;
  setStatus(recStatus, 'Get ready…');
  for (const n of [3, 2, 1]) { showOverlay(String(n), true); await wait(1000); }
  hideOverlay();
  startRecording(mimeType);
});

$('btn-stop').addEventListener('click', () => stopRecording());

function startRecording(mimeType) {
  const canvasStream = recCanvas.captureStream(REQ.fps);
  const mixed = new MediaStream([...canvasStream.getVideoTracks(), ...state.stream.getAudioTracks()]);
  const opts = { videoBitsPerSecond: 400000, audioBitsPerSecond: 64000 };
  if (mimeType) opts.mimeType = mimeType;
  const recorder = new MediaRecorder(mixed, opts);
  const rec = {
    recorder, mimeType: recorder.mimeType || mimeType || 'video/webm', chunks: [], lumaSamples: [],
    startedAt: new Date(), canvasStream, timerId: 0, stopped: null,
  };
  rec.stopped = new Promise((resolve) => { recorder.onstop = resolve; });
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); };
  state.recording = rec;
  drawRecordingFrame();
  recorder.start(1000);
  rec.speech = startSpeech();

  setPhase('recording');
  setStatus(recStatus, '<strong>Recording…</strong> Read the sentence aloud, then tap Stop.');
  const timer = $('timer');
  timer.hidden = false;
  const t0 = performance.now();
  const tick = () => {
    const left = Math.max(0, MAX_SECONDS - (performance.now() - t0) / 1000);
    timer.textContent = `● ${left.toFixed(0)}s`;
    if (left <= 0) stopRecording();
  };
  tick();
  rec.timerId = setInterval(tick, 200);
}

async function stopRecording() {
  const rec = state.recording;
  if (!rec || state.phase !== 'recording') return;
  setPhase('processing');
  clearInterval(rec.timerId);
  $('timer').hidden = true;
  setStatus(recStatus, '<span class="spinner"></span>Checking your recording…');

  if (rec.recorder.state !== 'inactive') rec.recorder.stop();
  await Promise.all([rec.stopped, stopSpeech(rec.speech)]);
  rec.canvasStream.getTracks().forEach((t) => t.stop());
  state.recording = null;

  const durationSec = (Date.now() - rec.startedAt.getTime()) / 1000;
  // Plain type without ";codecs=..." so it matches the bucket's allowed_mime_types.
  const contentType = rec.mimeType.split(';')[0];
  const blob = new Blob(rec.chunks, { type: contentType });
  const transcript = transcriptOf(rec.speech);
  const sentence = sentences[state.index];
  const v = L.verifyClip({ supported: rec.speech.supported, transcript, error: rec.speech.error, sentence });

  if (v.outcome === 'blocked') {
    setStatus(recStatus, '<strong>Inappropriate language was detected.</strong> This clip was not uploaded. Please re-record, reading only the sentence shown.', 'err');
    setPhase('rejected');
    return;
  }
  if (v.outcome === 'wrong') {
    const heard = transcript ? `We heard: “${escapeHtml(transcript)}”.` : 'We didn’t hear any speech.';
    setStatus(recStatus, `<strong>That didn’t match the sentence.</strong> ${heard} This clip was not uploaded. Please re-record, reading the sentence clearly.`, 'err');
    setPhase('rejected');
    return;
  }

  const settings = state.stream.getVideoTracks()[0].getSettings();
  const p = state.participant;
  const ext = contentType === 'video/mp4' ? 'mp4' : 'webm';
  const brightness = rec.lumaSamples.length
    ? rec.lumaSamples.reduce((a, b) => a + b, 0) / rec.lumaSamples.length
    : state.lastLuma;

  const metadata = {
    name: p.name,
    rollNo: p.rollNo,
    ageGroup: p.ageGroup,
    gender: p.gender,
    skinTone: p.skinTone,
    facialHair: p.facialHair,
    glasses: p.glasses,
    consent: p.consent,
    guardianConsent: p.guardianConsent,
    sentenceSet: setNumber,
    sentenceIndex: state.index + 1,
    sentenceText: sentence,
    requestedWidth: REQ.width,
    requestedHeight: REQ.height,
    requestedFps: REQ.fps,
    actualWidth: settings.width ?? video.videoWidth,
    actualHeight: settings.height ?? video.videoHeight,
    actualFps: settings.frameRate ?? null,
    outputWidth: recCanvas.width,
    outputHeight: recCanvas.height,
    mimeType: rec.mimeType,
    durationSec: Math.round(durationSec * 10) / 10,
    recordedAt: rec.startedAt.toISOString(),
    verificationStatus: v.status,
    speechError: rec.speech.error,
    transcript,
    matchScore: v.score === null ? null : Math.round(v.score * 1000) / 1000,
    faceBrightness: brightness == null ? null : Math.round(brightness * 10) / 10,
    deviceUserAgent: navigator.userAgent,
  };
  const path = `${L.folderName(p.rollNo, p.name)}/${String(state.index + 1).padStart(2, '0')}.${ext}`;
  state.pending = { blob, path, contentType, metadata };
  await uploadPending();
}

function getSupabase() {
  if (supabase) return supabase;
  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes('YOUR-PROJECT-REF') || !CFG.SUPABASE_PUBLISHABLE_KEY || CFG.SUPABASE_PUBLISHABLE_KEY.includes('REPLACE_ME')) {
    throw new Error('Supabase is not configured yet (config.js).');
  }
  supabase = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return supabase;
}

async function uploadFile(path, body, contentType, metadata) {
  const { error } = await getSupabase().storage.from(CFG.BUCKET || 'recordings')
    .upload(path, body, { contentType, upsert: true, cacheControl: '3600', metadata });
  if (error) throw error;
}

async function uploadPending() {
  const job = state.pending;
  if (!job) return;
  setPhase('uploading');
  setStatus(recStatus, '<span class="spinner"></span>Uploading…');
  try {
    await uploadFile(job.path, job.blob, job.contentType, job.metadata);
  } catch (err) {
    setStatus(recStatus, `<strong>Upload failed:</strong> ${escapeHtml(err.message || err)}<br>Your recording is kept on this page. Check your connection and tap <strong>Retry upload</strong>.`, 'err');
    setPhase('failed');
    return;
  }
  state.clips[state.index] = { path: job.path, ...job.metadata };
  const s = job.metadata.verificationStatus;
  let note = '';
  if (s === 'technical_error') note = '<br>We couldn’t verify your speech due to a connection issue; this will be reviewed manually.';
  if (s === 'unsupported') note = '<br>Your browser can’t verify speech, so this clip is marked unverified. For best results, use Chrome or Edge.';
  setStatus(recStatus, `<strong>Uploaded successfully.</strong>${note}`, s === 'pass' ? 'ok' : 'warn');
  $('rec-progress').style.width = `${((state.index + 1) / sentences.length) * 100}%`;
  state.pending = null;
  setPhase('uploaded');
}

$('btn-retry-upload').addEventListener('click', () => {
  if (state.pending && state.pending.path === 'participant.json') finish();
  else uploadPending();
});

$('btn-rerecord').addEventListener('click', () => {
  state.pending = null;
  setStatus(recStatus, 'Tap <strong>Record</strong> when all three checks are green.');
  setPhase('idle');
});

$('btn-next').addEventListener('click', () => {
  if (state.index < sentences.length - 1) {
    state.index++;
    renderSentence();
  } else {
    finish();
  }
});

async function finish() {
  const p = state.participant;
  const folder = L.folderName(p.rollNo, p.name);
  const summary = {
    name: p.name,
    rollNo: p.rollNo,
    ageGroup: p.ageGroup,
    gender: p.gender,
    skinTone: p.skinTone,
    facialHair: p.facialHair,
    glasses: p.glasses,
    consent: p.consent,
    guardianConsent: p.guardianConsent,
    sentenceSet: setNumber,
    sentences,
    clips: state.clips,
    completedAt: new Date().toISOString(),
    deviceUserAgent: navigator.userAgent,
  };
  state.pending = { path: 'participant.json' };
  setPhase('uploading');
  setStatus(recStatus, '<span class="spinner"></span>Saving your details…');
  try {
    const body = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
    await uploadFile(`${folder}/participant.json`, body, 'application/json');
  } catch (err) {
    setStatus(recStatus, `<strong>Couldn’t save your details:</strong> ${escapeHtml(err.message || err)}<br>Tap <strong>Retry upload</strong>.`, 'err');
    setPhase('failed');
    $('btn-rerecord').hidden = true;
    return;
  }
  state.pending = null;
  stopCamera();
  show('screen-done');
  window.removeEventListener('beforeunload', warnUnload);
}

function warnUnload(e) {
  if (state.participant) { e.preventDefault(); e.returnValue = ''; }
}
window.addEventListener('beforeunload', warnUnload);

refreshForm();
