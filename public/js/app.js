const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SOURCE_FOLDER = 'Omegle Source';
const OUTPUT_FOLDER = 'Omegle Complete';

const state = {
  accessToken: null,
  tokenExpiry: 0,
  sessionToken: null,
  username: null,
  sourceFolderId: null,
  outputFolderId: null,
  videos: [],
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
    fields: 'files(id,name,mimeType)',
    orderBy: 'name',
    pageSize: '1000',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true'
  });
  return data.files || [];
}

async function downloadFile(fileId, onProgress) {
  const res = await fetch(`/api/video?id=${encodeURIComponent(fileId)}`);
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch {}
    throw new Error(`Download failed: ${res.status} — ${body.slice(0, 200)}`);
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

async function uploadToDrive(blob, name, folderId, onProgress) {
  const token = await getToken();

  const initRes = await fetch(`${UPLOAD_API}/files?uploadType=resumable`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Type': 'video/mp4',
      'X-Upload-Content-Length': String(blob.size)
    },
    body: JSON.stringify({ name, parents: [folderId], mimeType: 'video/mp4' })
  });

  if (!initRes.ok) throw new Error(`Upload init failed: ${initRes.status}`);
  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) throw new Error('Upload failed: no upload URL received from Google Drive');

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', 'video/mp4');
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

  const sourceName = state.videos[state.currentIndex]?.name || 'video.mp4';
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

  let exitCode = await ffmpeg.exec([
    '-i', `source.${sourceExt}`, '-i', `webcam.${webcamExt}`,
    '-filter_complex', videoFilter + ';[0:a][1:a]amix=inputs=2:duration=shortest[a]',
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
    video: { facingMode: 'user', aspectRatio: { ideal: 9 / 16 } },
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

  recordedChunks = [];
  const mimeType = getMimeType();
  state.webcamMime = mimeType || 'video/webm';

  mediaRecorder = new MediaRecorder(webcamStream, {
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
  prerecordedVideo.pause();
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

function initPreview() {
  btnPlayPreview.disabled = true;
  btnPlayPreview.textContent = 'Loading...';

  previewTop.src = state.currentVideoUrl;
  previewBottom.src = state.webcamUrl;

  let ready = 0;
  const onReady = () => {
    ready++;
    if (ready >= 2) {
      btnPlayPreview.disabled = false;
      btnPlayPreview.textContent = 'Play Preview';
    }
  };

  previewTop.addEventListener('loadedmetadata', onReady, { once: true });
  previewBottom.addEventListener('loadedmetadata', onReady, { once: true });

  // Fallback: enable after 4s regardless
  setTimeout(() => {
    if (btnPlayPreview.disabled) {
      btnPlayPreview.disabled = false;
      btnPlayPreview.textContent = 'Play Preview';
    }
  }, 4000);

  previewTop.load();
  previewBottom.load();
  clearSync();
}

function clearSync() {
  if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
}

btnPlayPreview.addEventListener('click', () => {
  if (previewTop.paused) {
    previewTop.currentTime = 0;
    previewBottom.currentTime = 0;
    // Both play() calls must be synchronous to keep iOS user-gesture context
    previewTop.play().catch(() => {});
    previewBottom.play().catch(() => {});
    btnPlayPreview.textContent = 'Pause';

    clearSync();
    syncInterval = setInterval(() => {
      if (previewTop.paused || previewTop.ended) { clearSync(); return; }
      const drift = Math.abs(previewTop.currentTime - previewBottom.currentTime);
      if (drift > 0.1) previewBottom.currentTime = previewTop.currentTime;
    }, 500);
  } else {
    previewTop.pause();
    previewBottom.pause();
    clearSync();
    btnPlayPreview.textContent = 'Play Preview';
  }
});

previewTop.addEventListener('ended', () => {
  previewBottom.pause();
  clearSync();
  btnPlayPreview.textContent = 'Play Preview';
});

$('btn-rerecord').addEventListener('click', async () => {
  previewTop.pause();
  previewBottom.pause();
  clearSync();
  recTimer.textContent = '00:00';
  recTimer.hidden = true;
  try {
    await initCamera();
    goTo('screen-record');
  } catch (err) {
    alert('Camera access failed: ' + err.message);
  }
});

$('btn-approve').addEventListener('click', () => {
  previewTop.pause();
  previewBottom.pause();
  clearSync();
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

  const sourceVideo = state.videos[state.currentIndex];

  try {
    titleEl.textContent = 'Loading FFmpeg...';
    statusEl.textContent = 'Downloading video processor (first time only)...';
    setProgress(0);

    await loadFFmpeg(msg => { statusEl.textContent = msg; });

    titleEl.textContent = 'Merging Video...';
    statusEl.textContent = 'Combining top & bottom into 9:16...';
    setProgress(0);

    const mergedBlob = await mergeVideos(state.currentVideoBlob, state.webcamBlob, p => setProgress(p * 100));

    titleEl.textContent = 'Uploading to Drive...';
    statusEl.textContent = 'Saving to Omegle Complete folder...';
    setProgress(0);

    const outputName = `skit_${state.username}_${sourceVideo.name.replace(/\.[^.]+$/, '')}.mp4`;
    await uploadToDrive(mergedBlob, outputName, state.outputFolderId, p => setProgress(p * 100));

    // Save progress (fire and forget — non-fatal if it fails)
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
    const [sourceId, outputId] = await Promise.all([
      findOrCreateFolder(SOURCE_FOLDER),
      findOrCreateFolder(OUTPUT_FOLDER)
    ]);
    state.sourceFolderId = sourceId;
    state.outputFolderId = outputId;

    $('loading-status').textContent = 'Loading video list...';

    const [sourceVideos, progressRes] = await Promise.all([
      listVideos(sourceId),
      fetch('/api/progress', {
        headers: { Authorization: `Bearer ${state.sessionToken}` }
      })
    ]);

    if (progressRes.status === 401) {
      clearSession();
      goTo('screen-login');
      return;
    }

    const { completed } = await progressRes.json();
    const completedSet = new Set(completed);
    state.videos = sourceVideos.filter(v => !completedSet.has(v.id));
    state.currentIndex = 0;

    if (sourceVideos.length === 0) {
      goTo('screen-empty');
    } else if (state.videos.length === 0) {
      goTo('screen-complete');
    } else {
      await loadCurrentVideo();
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

async function loadCurrentVideo() {
  const video = state.videos[state.currentIndex];
  if (!video) { goTo('screen-complete'); return; }

  goTo('screen-loading');
  $('loading-status').textContent = `Downloading: ${video.name}`;
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

    $('current-num').textContent = state.currentIndex + 1;
    $('total-num').textContent = state.videos.length;
    $('current-name').textContent = video.name;
    recTimer.textContent = '00:00';
    recTimer.hidden = true;

    $('loading-progress').hidden = true;
    $('loading-bar').style.width = '0%';
  } catch (err) {
    $('loading-progress').hidden = true;
    alert('Failed to download video: ' + err.message);
    goTo('screen-empty');
    return;
  }

  try {
    await initCamera();
  } catch (err) {
    alert('Camera access denied. Please allow camera and microphone access and reload the page.');
    goTo('screen-empty');
    return;
  }

  goTo('screen-record');
}

$('btn-skip').addEventListener('click', () => {
  if (isRecording) {
    if (mediaRecorder) mediaRecorder.onstop = null;
    stopRecording();
  }
  stopCamera();
  state.currentIndex++;
  if (state.currentIndex >= state.videos.length) goTo('screen-complete');
  else loadCurrentVideo();
});

$('btn-next').addEventListener('click', () => {
  state.currentIndex++;
  if (state.currentIndex >= state.videos.length) goTo('screen-complete');
  else loadCurrentVideo();
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
