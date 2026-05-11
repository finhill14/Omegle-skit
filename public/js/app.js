const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SOURCE_FOLDER = 'Omegle Source';
const ORIGINAL_FOLDER = 'Omegle Originals';
const OUTPUT_FOLDER = 'Omegle Complete';

const state = {
  accessToken: null,
  tokenExpiry: 0,
  sessionToken: null,
  username: null,
  sourceFolderId: null,
  originalsFolderId: null,
  outputFolderId: null,
  originalMap: {},
  originalVideoUrl: null,
  allVideos: [],
  completedSet: new Set(),
  currentIndex: 0,
  currentVideoBlob: null,
  currentVideoUrl: null,
  webcamBlob: null,
  webcamUrl: null,
  webcamMime: 'video/webm',
  ffmpeg: null,
  ffmpegLoaded: false
};

// ─── DOM Helpers ─────────────────────────────────────────
const $ = id => document.getElementById(id);

function goTo(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(screen).classList.add('active');
}

// ─── Session ─────────────────────────────────────────────
function saveSession(username, token) {
  state.username = username;
  state.sessionToken = token;
  localStorage.setItem('omegle-session', JSON.stringify({ username, token }));
  $('header-username').textContent = username;
  $('user-info').hidden = false;
}

function clearSession() {
  state.username = null;
  state.sessionToken = null;
  localStorage.removeItem('omegle-session');
  $('user-info').hidden = true;
}

function loadSavedSession() {
  try {
    const saved = localStorage.getItem('omegle-session');
    if (!saved) return false;
    const { username, token } = JSON.parse(saved);
    if (!username || !token) return false;
    state.username = username;
    state.sessionToken = token;
    $('header-username').textContent = username;
    $('user-info').hidden = false;
    return true;
  } catch { return false; }
}

// ─── Auth ────────────────────────────────────────────────
async function refreshAccessToken() {
  try {
    const res = await fetch('/api/auth/refresh');
    if (!res.ok) return false;
    const data = await res.json();
    state.accessToken = data.access_token;
    state.tokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
    return true;
  } catch {
    return false;
  }
}

async function getToken() {
  if (state.accessToken && state.tokenExpiry > Date.now()) return state.accessToken;
  const ok = await refreshAccessToken();
  if (!ok) {
    goTo('screen-setup');
    throw new Error('Not configured.');
  }
  return state.accessToken;
}

// ─── Drive API ───────────────────────────────────────────
async function driveGet(path, params = {}) {
  const token = await getToken();
  const url = new URL(`${DRIVE_API}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) throw new Error('Session expired.');
    const retry = await fetch(url, { headers: { Authorization: `Bearer ${state.accessToken}` } });
    if (!retry.ok) throw new Error(`Drive API error: ${retry.status}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`Drive API error: ${res.status}`);
  return res.json();
}

async function findFolder(name) {
  const data = await driveGet('/files', {
    q: `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id,name)',
    spaces: 'drive',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  return data.files[0] || null;
}

async function createFolder(name) {
  const token = await getToken();
  const res = await fetch(`${DRIVE_API}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' })
  });
  if (!res.ok) throw new Error('Failed to create folder');
  return res.json();
}

async function findOrCreateFolder(name) {
  let folder = await findFolder(name);
  if (!folder) folder = await createFolder(name);
  return folder.id;
}

async function listVideos(folderId) {
  const data = await driveGet('/files', {
    q: `'${folderId}' in parents and mimeType contains 'video/' and trashed=false`,
    fields: 'files(id,name,mimeType,description)',
    orderBy: 'name',
    pageSize: '1000',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  return data.files || [];
}

let _driveToken = null, _driveTokenExpiry = 0;

async function getDriveToken() {
  if (_driveToken && _driveTokenExpiry > Date.now()) return _driveToken;
  const res = await fetch('/api/auth/refresh');
  if (!res.ok) throw new Error('Drive auth failed');
  const data = await res.json();
  if (!data.access_token) throw new Error('No access token');
  _driveToken = data.access_token;
  _driveTokenExpiry = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _driveToken;
}

async function downloadFile(fileId, onProgress) {
  const token = await getDriveToken();
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || 'video/mp4';
  const contentLength = res.headers.get('content-length');

  if (!contentLength || !res.body) {
    return new Blob([await res.arrayBuffer()], { type: contentType });
  }

  const reader = res.body.getReader();
  const total = parseInt(contentLength);
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(received / total);
  }

  return new Blob(chunks, { type: contentType });
}

async function uploadToDrive(blob, name, folderId, onProgress, mimeType = 'video/mp4') {
  const token = await getToken();

  const initRes = await fetch(`${UPLOAD_API}/files?uploadType=resumable`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': mimeType,
      'X-Upload-Content-Length': String(blob.size)
    },
    body: JSON.stringify({ name, parents: [folderId], mimeType })
  });

  if (!initRes.ok) throw new Error(`Upload init failed: ${initRes.status}`);
  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) throw new Error('Upload failed: no upload URL received from Google Drive');

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', mimeType);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
      else reject(new Error(`Upload failed: ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.send(blob);
  });
}

// ─── FFmpeg ──────────────────────────────────────────────
async function loadFFmpeg(onStatus) {
  if (state.ffmpegLoaded) return;

  if (onStatus) onStatus('Downloading video processor...');

  const { FFmpeg } = await import('https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js');
  const { toBlobURL } = await import('https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js');

  const ffmpeg = new FFmpeg();
  const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm';

  if (onStatus) onStatus('Loading FFmpeg core (~30MB)...');

  const coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
  const wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
  await ffmpeg.load({ coreURL, wasmURL });

  state.ffmpeg = ffmpeg;
  state.ffmpegLoaded = true;
}

async function mergeVideos(sourceBlob, webcamBlob, onProgress) {
  const ffmpeg = state.ffmpeg;
  const { fetchFile } = await import('https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js');

  const sourceName = state.allVideos[state.currentIndex]?.name || 'video.mp4';
  const sourceExt = sourceName.includes('.') ? sourceName.split('.').pop() : 'mp4';
  const webcamExt = state.webcamMime.includes('mp4') ? 'mp4' : 'webm';

  const progressHandler = ({ progress }) => {
    if (onProgress) onProgress(Math.max(0, Math.min(1, progress)));
  };
  ffmpeg.on('progress', progressHandler);

  await ffmpeg.writeFile(`source.${sourceExt}`, await fetchFile(sourceBlob));
  await ffmpeg.writeFile(`webcam.${webcamExt}`, await fetchFile(webcamBlob));

  // Top (their video): 40% of 1920 = 768px, cover-crop to fill
  // Bottom (webcam): 60% of 1920 = 1152px, cover-crop to fill
  const topH = 768;
  const bottomH = 1152;
  const videoFilter =
    `[0:v]scale=1080:${topH}:force_original_aspect_ratio=increase,crop=1080:${topH},setsar=1[top];` +
    `[1:v]scale=1080:${bottomH}:force_original_aspect_ratio=increase,crop=1080:${bottomH},setsar=1[bottom];` +
    `[top][bottom]vstack=inputs=2[v]`;

  const muteRegions = state.allVideos[state.currentIndex]?.muteRegions || [];
  const audioFilter = muteRegions.length > 0
    ? `[0:a]volume='if(${muteRegions.map(r => `between(t,${r.start},${r.end})`).join('+')},0,1)':eval=frame[sa];[sa][1:a]amix=inputs=2:duration=shortest[a]`
    : '[0:a][1:a]amix=inputs=2:duration=shortest[a]';

  let exitCode = await ffmpeg.exec([
    '-i', `source.${sourceExt}`, '-i', `webcam.${webcamExt}`,
    '-filter_complex', videoFilter + ';' + audioFilter,
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k',
    '-shortest', '-movflags', '+faststart',
    '-y', 'output.mp4'
  ]);

  if (exitCode !== 0) {
    exitCode = await ffmpeg.exec([
      '-i', `source.${sourceExt}`, '-i', `webcam.${webcamExt}`,
      '-filter_complex', videoFilter,
      '-map', '[v]', '-map', '1:a',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '128k',
      '-shortest', '-movflags', '+faststart',
      '-y', 'output.mp4'
    ]);
  }

  if (exitCode !== 0) {
    exitCode = await ffmpeg.exec([
      '-i', `source.${sourceExt}`, '-i', `webcam.${webcamExt}`,
      '-filter_complex', videoFilter,
      '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-shortest', '-movflags', '+faststart',
      '-y', 'output.mp4'
    ]);
  }

  ffmpeg.off('progress', progressHandler);
  if (exitCode !== 0) throw new Error('Video merge failed');

  const data = await ffmpeg.readFile('output.mp4');
  await ffmpeg.deleteFile(`source.${sourceExt}`).catch(() => {});
  await ffmpeg.deleteFile(`webcam.${webcamExt}`).catch(() => {});
  await ffmpeg.deleteFile('output.mp4').catch(() => {});

  return new Blob([data], { type: 'video/mp4' });
}

// ─── Camera & Recording ─────────────────────────────────
const prerecordedVideo = $('prerecorded-video');
const webcamPreview = $('webcam-preview');
const btnRecord = $('btn-record');
const recTimer = $('rec-timer');

let webcamStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let timerInterval = null;
let isRecording = false;
let mirrorState = true;
let _mirrorCanvas = null, _mirrorCtx = null, _mirrorAnim = null, _mirrorVideo = null;

function createMirroredStream() {
  const vTrack = webcamStream.getVideoTracks()[0];
  const s = vTrack.getSettings();
  _mirrorCanvas = document.createElement('canvas');
  _mirrorCanvas.width = s.width || 640;
  _mirrorCanvas.height = s.height || 480;
  _mirrorCtx = _mirrorCanvas.getContext('2d');
  _mirrorVideo = document.createElement('video');
  _mirrorVideo.srcObject = new MediaStream([vTrack]);
  _mirrorVideo.muted = true;
  _mirrorVideo.playsInline = true;
  _mirrorVideo.play().catch(() => {});
  function draw() {
    _mirrorCtx.save();
    _mirrorCtx.scale(-1, 1);
    _mirrorCtx.drawImage(_mirrorVideo, -_mirrorCanvas.width, 0, _mirrorCanvas.width, _mirrorCanvas.height);
    _mirrorCtx.restore();
    _mirrorAnim = requestAnimationFrame(draw);
  }
  draw();
  const stream = _mirrorCanvas.captureStream(30);
  webcamStream.getAudioTracks().forEach(t => stream.addTrack(t));
  return stream;
}

function stopMirroredStream() {
  if (_mirrorAnim) { cancelAnimationFrame(_mirrorAnim); _mirrorAnim = null; }
  if (_mirrorVideo) { _mirrorVideo.pause(); _mirrorVideo.srcObject = null; _mirrorVideo = null; }
  _mirrorCanvas = null; _mirrorCtx = null;
}

function getMimeType() {
  const types = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
  ];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

async function initCamera() {
  if (webcamStream) return;
  webcamStream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', aspectRatio: { ideal: 1 } },
    audio: true
  });
  webcamPreview.srcObject = webcamStream;
}

function stopCamera() {
  if (webcamStream) {
    webcamStream.getTracks().forEach(t => t.stop());
    webcamStream = null;
  }
  webcamPreview.srcObject = null;
}

function startRecording() {
  if (!webcamStream) { alert('Camera not available.'); return; }

  state.trimStart = 0;
  recordedChunks = [];
  const mimeType = getMimeType();
  state.webcamMime = mimeType || 'video/webm';

  const recordStream = webcamStream;
  mediaRecorder = new MediaRecorder(recordStream, {
    mimeType: mimeType || undefined,
    videoBitsPerSecond: 2500000
  });

  mediaRecorder.ondataavailable = e => {
    if (e.data.size > 0) recordedChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    state.webcamBlob = new Blob(recordedChunks, { type: state.webcamMime });
    if (state.webcamUrl) URL.revokeObjectURL(state.webcamUrl);
    state.webcamUrl = URL.createObjectURL(state.webcamBlob);
    stopCamera();
    initPreview();
    goTo('screen-preview');
  };

  mediaRecorder.start(1000);
  prerecordedVideo.currentTime = 0;
  prerecordedVideo.muted = true;
  prerecordedVideo.play().catch(() => {});

  isRecording = true;
  btnRecord.textContent = 'Stop Recording';
  btnRecord.classList.add('recording');
  recTimer.hidden = false;

  let seconds = 0;
  timerInterval = setInterval(() => {
    seconds++;
    const m = String(Math.floor(seconds / 60)).padStart(2, '0');
    const s = String(seconds % 60).padStart(2, '0');
    recTimer.textContent = `${m}:${s}`;
  }, 1000);

  prerecordedVideo.onended = () => {
    if (isRecording) stopRecording();
  };
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  stopMirroredStream();
  prerecordedVideo.pause();
  prerecordedVideo.muted = false;
  isRecording = false;
  btnRecord.textContent = 'Start Recording';
  btnRecord.classList.remove('recording');
  clearInterval(timerInterval);
}

function countdown() {
  return new Promise(resolve => {
    const overlay = $('countdown-overlay');
    const numEl = $('countdown-num');
    let count = 3;

    function show(n) {
      numEl.textContent = n;
      // Reset animation by forcing reflow
      numEl.style.animation = 'none';
      void numEl.offsetWidth;
      numEl.style.animation = '';
    }

    overlay.hidden = false;
    show(count);

    const iv = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(iv);
        overlay.hidden = true;
        resolve();
        return;
      }
      show(count);
    }, 1000);
  });
}

btnRecord.addEventListener('click', async () => {
  if (!isRecording) {
    btnRecord.disabled = true;
    await countdown();
    btnRecord.disabled = false;
    startRecording();
  } else {
    stopRecording();
  }
});

// ─── Preview ─────────────────────────────────────────────
const previewTop = $('preview-top');
const previewBottom = $('preview-bottom');
const btnPlayPreview = $('btn-play-preview');
let syncInterval = null;

// Web Audio for webcam track (previewBottom stays muted so iOS lets it play visually)
let audioCtx = null;
let webcamAudioBuffer = null;
let webcamAudioSource = null;
let previewTopSource = null;
let previewTopGain = null;

function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function stopWebcamAudio() {
  if (webcamAudioSource) {
    try { webcamAudioSource.stop(); } catch {}
    webcamAudioSource = null;
  }
}

function playWebcamAudio(offset = 0) {
  stopWebcamAudio();
  if (!webcamAudioBuffer) return;
  webcamAudioSource = getAudioCtx().createBufferSource();
  webcamAudioSource.buffer = webcamAudioBuffer;
  webcamAudioSource.connect(getAudioCtx().destination);
  webcamAudioSource.start(0, offset);
}

function setupPreviewTopAudio() {
  if (previewTopSource) return;
  try {
    const ctx = getAudioCtx();
    previewTopSource = ctx.createMediaElementSource(previewTop);
    previewTopGain = ctx.createGain();
    previewTopSource.connect(previewTopGain);
    previewTopGain.connect(ctx.destination);
  } catch (e) {
    console.warn('Preview top audio setup failed:', e);
    previewTopSource = null;
    previewTopGain = null;
  }
}

function schedulePreviewGain(fromVideoTime) {
  const muteRegions = state.allVideos[state.currentIndex]?.muteRegions || [];
  if (!previewTopGain || !audioCtx || !muteRegions.length) return;
  const t0 = audioCtx.currentTime;
  previewTopGain.gain.cancelScheduledValues(t0);
  const inMute = muteRegions.some(r => fromVideoTime >= r.start && fromVideoTime <= r.end);
  previewTopGain.gain.setValueAtTime(inMute ? 0 : 1, t0);
  for (const r of muteRegions) {
    if (r.end <= fromVideoTime) continue;
    const rStart = t0 + Math.max(0, r.start - fromVideoTime);
    const rEnd   = t0 + (r.end - fromVideoTime);
    if (r.start > fromVideoTime) previewTopGain.gain.setValueAtTime(0, rStart);
    previewTopGain.gain.setValueAtTime(1, rEnd);
  }
}

function initPreview() {
  btnPlayPreview.disabled = true;
  btnPlayPreview.textContent = 'Loading...';

  previewTop.src = state.currentVideoUrl;
  previewBottom.src = state.webcamUrl;

  let ready = 0;
  const onReady = () => {
    if (++ready >= 2) {
      btnPlayPreview.disabled = false;
      btnPlayPreview.textContent = 'Play Preview';
    }
  };
  previewTop.addEventListener('loadedmetadata', onReady, { once: true });
  previewBottom.addEventListener('loadedmetadata', onReady, { once: true });
  setTimeout(() => {
    if (btnPlayPreview.disabled) {
      btnPlayPreview.disabled = false;
      btnPlayPreview.textContent = 'Play Preview';
    }
  }, 4000);

  previewTop.load();
  previewBottom.load();
  clearSync();
  setupPreviewTopAudio();

  // Pre-decode webcam audio into AudioContext buffer in background
  webcamAudioBuffer = null;
  if (state.webcamBlob) {
    state.webcamBlob.arrayBuffer()
      .then(ab => getAudioCtx().decodeAudioData(ab))
      .then(buf => { webcamAudioBuffer = buf; })
      .catch(() => {});
  }
}

function clearSync() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

function stopPreview() {
  previewTop.pause();
  previewBottom.pause();
  stopWebcamAudio();
  if (previewTopGain && audioCtx) {
    previewTopGain.gain.cancelScheduledValues(audioCtx.currentTime);
    previewTopGain.gain.setValueAtTime(1, audioCtx.currentTime);
  }
  clearSync();
  btnPlayPreview.textContent = 'Play Preview';
}

btnPlayPreview.addEventListener('click', () => {
  if (previewTop.paused) {
    const trimOff = state.trimStart || 0;
    previewTop.currentTime = 0;
    previewBottom.currentTime = trimOff;

    // Resume AudioContext synchronously while inside the user-gesture call stack
    getAudioCtx().resume().catch(() => {});

    // Both video play() calls synchronous — preserves iOS user-gesture context
    previewTop.play().then(() => schedulePreviewGain(0)).catch(() => {});
    previewBottom.play().catch(() => {}); // muted; video sync only

    // Webcam audio via AudioContext — if buffer ready, start immediately;
    // if still decoding, start once done (with time offset to stay in sync)
    if (webcamAudioBuffer) {
      playWebcamAudio(trimOff);
    } else if (state.webcamBlob) {
      state.webcamBlob.arrayBuffer()
        .then(ab => getAudioCtx().decodeAudioData(ab))
        .then(buf => {
          webcamAudioBuffer = buf;
          playWebcamAudio(previewTop.currentTime);
        })
        .catch(() => {});
    }

    btnPlayPreview.textContent = 'Pause';
    clearSync();
    syncInterval = setInterval(() => {
      if (previewTop.paused || previewTop.ended) { clearSync(); return; }
      const expected = previewTop.currentTime + trimOff;
      const drift = Math.abs(expected - previewBottom.currentTime);
      if (drift > 0.15) previewBottom.currentTime = expected;
    }, 500);
  } else {
    stopPreview();
  }
});

previewTop.addEventListener('ended', () => {
  stopPreview();
});

$('btn-rerecord').addEventListener('click', async () => {
  stopPreview();
  recTimer.textContent = '00:00';
  recTimer.hidden = true;
  $('countdown-overlay').hidden = true;
  $('countdown-num').textContent = '';
  try {
    await initCamera();
    goTo('screen-record');
  } catch (err) {
    alert('Camera access failed: ' + err.message);
  }
});

$('btn-approve').addEventListener('click', () => {
  stopPreview();
  processAndUpload();
});

// ─── Processing ──────────────────────────────────────────
async function processAndUpload() {
  goTo('screen-processing');
  const statusEl = $('processing-status');
  const barEl = $('processing-bar');
  const pctEl = $('processing-percent');
  const titleEl = $('processing-title');

  function setProgress(pct) {
    barEl.style.width = pct + '%';
    pctEl.textContent = Math.round(pct) + '%';
  }

  const sourceVideo = state.allVideos[state.currentIndex];

  try {
    const baseName = sourceVideo.name.replace(/\.[^.]+$/, '');
    const webcamExt = state.webcamMime.split(';')[0].split('/')[1] || 'webm';

    titleEl.textContent = 'Uploading recording...';
    statusEl.textContent = 'Saving your recording to Omegle Complete...';
    setProgress(0);

    const rawName = `raw_${state.username}_${baseName}.${webcamExt}`;
    const uploadResult = await uploadToDrive(state.webcamBlob, rawName, state.outputFolderId, p => setProgress(p * 100), state.webcamMime.split(';')[0]);

    if (state.trimStart > 0 && uploadResult?.id) {
      const driveToken = await getDriveToken();
      fetch(`https://www.googleapis.com/drive/v3/files/${uploadResult.id}?supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${driveToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: JSON.stringify({ trimStart: state.trimStart }) })
      }).catch(() => {});
    }

    // Update local state + save to Drive (fire and forget)
    state.completedSet.add(sourceVideo.id);
    fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${state.sessionToken}` },
      body: JSON.stringify({ videoId: sourceVideo.id })
    }).catch(e => console.warn('Progress save failed:', e));

    goTo('screen-done');
  } catch (err) {
    alert('Processing failed: ' + err.message);
    goTo('screen-preview');
  }
}

// ─── Navigation ──────────────────────────────────────────
async function loadVideoList() {
  goTo('screen-loading');
  $('loading-status').textContent = 'Finding your Drive folders...';

  try {
    const [sourceId, originalsId, outputId] = await Promise.all([
      findOrCreateFolder(SOURCE_FOLDER),
      findOrCreateFolder(ORIGINAL_FOLDER),
      findOrCreateFolder(OUTPUT_FOLDER)
    ]);
    state.sourceFolderId = sourceId;
    state.originalsFolderId = originalsId;
    state.outputFolderId = outputId;

    $('loading-status').textContent = 'Loading video list...';

    const [sourceVideos, originalVideos, progressRes] = await Promise.all([
      listVideos(sourceId),
      listVideos(originalsId),
      fetch('/api/progress', {
        headers: { Authorization: `Bearer ${state.sessionToken}` }
      })
    ]);

    state.originalMap = {};
    originalVideos.forEach(v => { state.originalMap[v.name] = v.id; });

    if (progressRes.status === 401) {
      clearSession();
      goTo('screen-login');
      return;
    }

    const { completed } = await progressRes.json();
    state.allVideos = sourceVideos.map(v => {
      let muteRegions = [];
      try {
        if (v.description) {
          const parsed = JSON.parse(v.description);
          if (Array.isArray(parsed.muteRegions)) muteRegions = parsed.muteRegions;
        }
      } catch {}
      return { ...v, muteRegions };
    });
    state.completedSet = new Set(completed);

    if (sourceVideos.length === 0) {
      goTo('screen-empty');
    } else {
      renderVideoList();
      goTo('screen-select');
    }
  } catch (err) {
    if (err.message.includes('Not configured')) {
      goTo('screen-setup');
    } else {
      alert('Failed to load videos: ' + err.message);
      goTo('screen-empty');
    }
  }
}

function renderVideoList() {
  const list = $('video-list');
  const remaining = state.allVideos.filter(v => !state.completedSet.has(v.id));
  $('select-remaining').textContent = remaining.length;
  $('select-total').textContent = state.allVideos.length;

  list.innerHTML = '';
  state.allVideos.forEach((video, index) => {
    const done = state.completedSet.has(video.id);
    const card = document.createElement('button');
    card.className = `video-card${done ? ' completed' : ''}`;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'video-card-name';
    nameSpan.textContent = `Video ${index + 1}`;

    const statusSpan = document.createElement('span');
    statusSpan.className = 'video-card-status';
    statusSpan.style.color = done ? '#43a047' : '#4fc3f7';
    statusSpan.textContent = done ? 'Done \u2713' : 'Record \u2192';

    card.appendChild(nameSpan);
    card.appendChild(statusSpan);
    card.addEventListener('click', () => selectVideo(index));
    list.appendChild(card);
  });
}

let loadingVideo = false;

function selectVideo(index) {
  if (loadingVideo) return;
  state.currentIndex = index;
  showVideoOptions();
}

function showVideoOptions() {
  const video = state.allVideos[state.currentIndex];
  $('video-options-name').textContent = `Video ${state.currentIndex + 1}`;
  const previewEl = $('preview-original');
  previewEl.pause();
  previewEl.style.display = 'none';
  previewEl.removeAttribute('src');
  $('preview-loading').style.display = 'none';
  $('btn-preview-lines').textContent = 'Preview Conversation / Learn Lines';
  $('btn-preview-lines').disabled = false;
  goTo('screen-video-options');
}

function cleanupPreview() {
  const el = $('preview-original');
  el.pause();
  el.removeAttribute('src');
  el.style.display = 'none';
  if (state.originalVideoUrl) { URL.revokeObjectURL(state.originalVideoUrl); state.originalVideoUrl = null; }
}

$('btn-preview-lines').addEventListener('click', async () => {
  const video = state.allVideos[state.currentIndex];
  const fileId = state.originalMap[video.name] || video.id;
  const previewEl = $('preview-original');
  const loadingEl = $('preview-loading');
  const btn = $('btn-preview-lines');

  btn.disabled = true;
  loadingEl.style.display = 'block';

  try {
    const blob = await downloadFile(fileId, p => {
      $('preview-loading-text').textContent = `Downloading… ${Math.round(p * 100)}%`;
    });
    if (state.originalVideoUrl) URL.revokeObjectURL(state.originalVideoUrl);
    state.originalVideoUrl = URL.createObjectURL(blob);
    previewEl.src = state.originalVideoUrl;
    previewEl.style.display = 'block';
    loadingEl.style.display = 'none';
    previewEl.play().catch(() => {});
  } catch (err) {
    alert('Download failed: ' + err.message);
    loadingEl.style.display = 'none';
  } finally {
    btn.disabled = false;
  }
});

$('btn-download-clip').addEventListener('click', async () => {
  const video = state.allVideos[state.currentIndex];
  const fileId = state.originalMap[video.name] || video.id;
  const btn = $('btn-download-clip');
  btn.disabled = true;
  btn.textContent = 'Downloading…';
  try {
    const blob = await downloadFile(fileId, p => {
      btn.textContent = `Downloading… ${Math.round(p * 100)}%`;
    });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), {
      href: url,
      download: `Video_${state.currentIndex + 1}.mp4`
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    btn.textContent = 'Downloaded';
    setTimeout(() => { btn.textContent = 'Download Clip'; }, 2000);
  } catch (err) {
    alert('Download failed: ' + err.message);
    btn.textContent = 'Download Clip';
  } finally {
    btn.disabled = false;
  }
});

$('btn-start-record').addEventListener('click', () => {
  cleanupPreview();
  loadCurrentVideo();
});

$('btn-options-back').addEventListener('click', () => {
  cleanupPreview();
  goTo('screen-select');
});

$('btn-mirror').addEventListener('click', () => {
  mirrorState = !mirrorState;
  $('webcam-preview').style.transform = mirrorState ? '' : 'scaleX(1)';
});

// ─── Upload pre-recorded version ─────────────────────────
$('btn-upload-version').addEventListener('click', () => {
  $('upload-file-input').value = '';
  $('upload-file-input').click();
});

$('upload-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  state.uploadedUrl = URL.createObjectURL(file);
  state.webcamBlob = file;
  state.webcamMime = file.type || 'video/mp4';
  state.trimStart = 0;

  const video = state.allVideos[state.currentIndex];
  if (!state.currentVideoBlob || state._cachedVideoId !== video.id) {
    const btn = $('btn-upload-version');
    btn.disabled = true;
    btn.textContent = 'Loading source…';
    try {
      if (state.currentVideoUrl) URL.revokeObjectURL(state.currentVideoUrl);
      state.currentVideoBlob = await downloadFile(video.id);
      state.currentVideoUrl = URL.createObjectURL(state.currentVideoBlob);
      state._cachedVideoId = video.id;
    } catch (err) {
      alert('Failed to load source video: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Upload Pre-Recorded Version';
      return;
    }
    btn.disabled = false;
    btn.textContent = 'Upload Pre-Recorded Version';
  }

  $('trim-source').src = state.currentVideoUrl;
  $('trim-upload').src = state.uploadedUrl;
  $('trim-source').load();
  $('trim-upload').load();

  $('trim-upload').onloadedmetadata = () => {
    const dur = $('trim-upload').duration;
    $('trim-offset').max = Math.max(dur - 1, 0);
    $('trim-offset').value = 0;
    $('trim-offset-val').textContent = '0.0s';
  };

  goTo('screen-upload-trim');
});

$('trim-offset').addEventListener('input', () => {
  const val = parseFloat($('trim-offset').value);
  $('trim-offset-val').textContent = val.toFixed(1) + 's';
  $('trim-upload').currentTime = val;
  state.trimStart = val;
});

$('btn-play-sync').addEventListener('click', () => {
  const src = $('trim-source');
  const upl = $('trim-upload');
  if (!src.paused || !upl.paused) {
    src.pause();
    upl.pause();
    $('btn-play-sync').textContent = 'Play Sync';
    return;
  }
  src.currentTime = 0;
  upl.currentTime = state.trimStart || 0;
  src.play().catch(() => {});
  upl.play().catch(() => {});
  $('btn-play-sync').textContent = 'Stop';
});

$('btn-confirm-trim').addEventListener('click', () => {
  $('trim-source').pause();
  $('trim-upload').pause();
  $('btn-play-sync').textContent = 'Play Sync';
  if (state.webcamUrl) URL.revokeObjectURL(state.webcamUrl);
  state.webcamUrl = state.uploadedUrl;
  initPreview();
  goTo('screen-preview');
});

$('btn-trim-back').addEventListener('click', () => {
  $('trim-source').pause();
  $('trim-upload').pause();
  $('btn-play-sync').textContent = 'Play Sync';
  if (state.uploadedUrl) { URL.revokeObjectURL(state.uploadedUrl); state.uploadedUrl = null; }
  state.webcamBlob = null;
  state.trimStart = 0;
  goTo('screen-video-options');
});

async function loadCurrentVideo() {
  const video = state.allVideos[state.currentIndex];
  if (!video) { goTo('screen-select'); return; }

  loadingVideo = true;
  goTo('screen-loading');
  $('loading-status').textContent = `Downloading: Video ${state.currentIndex + 1}`;
  $('loading-progress').hidden = false;

  try {
    state.currentVideoBlob = await downloadFile(video.id, p => {
      $('loading-bar').style.width = (p * 100) + '%';
      $('loading-percent').textContent = Math.round(p * 100) + '%';
    });

    if (state.currentVideoUrl) URL.revokeObjectURL(state.currentVideoUrl);
    state.currentVideoUrl = URL.createObjectURL(state.currentVideoBlob);

    prerecordedVideo.src = state.currentVideoUrl;
    prerecordedVideo.load();

    $('current-name').textContent = `Video ${state.currentIndex + 1}`;
    recTimer.textContent = '00:00';
    recTimer.hidden = true;

    $('loading-progress').hidden = true;
    $('loading-bar').style.width = '0%';
  } catch (err) {
    $('loading-progress').hidden = true;
    loadingVideo = false;
    alert('Failed to download video: ' + err.message);
    showVideoOptions();
    return;
  }

  try {
    await initCamera();
  } catch (err) {
    loadingVideo = false;
    alert('Camera access denied. Please allow camera and microphone access and reload the page.');
    showVideoOptions();
    return;
  }

  loadingVideo = false;
  goTo('screen-record');
}

$('btn-back').addEventListener('click', () => {
  if (isRecording) {
    if (mediaRecorder) mediaRecorder.onstop = null;
    stopRecording();
  }
  stopCamera();
  showVideoOptions();
});

$('btn-next').addEventListener('click', () => {
  const remaining = state.allVideos.filter(v => !state.completedSet.has(v.id));
  if (remaining.length === 0) {
    goTo('screen-complete');
  } else {
    renderVideoList();
    goTo('screen-select');
  }
});

$('btn-refresh').addEventListener('click', () => loadVideoList());
$('btn-check-new').addEventListener('click', () => loadVideoList());

// ─── Login / Logout ──────────────────────────────────────
$('btn-login').addEventListener('click', async () => {
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  const errorEl = $('login-error');

  if (!username || !password) {
    errorEl.textContent = 'Please enter your username and password.';
    errorEl.hidden = false;
    return;
  }

  const btn = $('btn-login');
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  errorEl.hidden = true;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();

    if (!res.ok) {
      errorEl.textContent = data.error || 'Login failed';
      errorEl.hidden = false;
      return;
    }

    saveSession(data.username, data.token);
    await loadVideoList();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

$('login-username').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('login-password').focus();
});

$('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('btn-login').click();
});

$('btn-logout').addEventListener('click', () => {
  stopCamera();
  clearSession();
  goTo('screen-login');
});

// ─── Init ────────────────────────────────────────────────
async function init() {
  if (!window.MediaRecorder) {
    alert('Your browser does not support video recording. Please use Chrome or Firefox.');
    return;
  }

  const driveOk = await refreshAccessToken();
  if (!driveOk) {
    goTo('screen-setup');
    return;
  }

  if (!loadSavedSession()) {
    goTo('screen-login');
    return;
  }

  await loadVideoList();
}

init();
