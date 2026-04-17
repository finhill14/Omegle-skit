const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const SOURCE_FOLDER = 'Omegle Source';
const OUTPUT_FOLDER = 'Omegle Complete';

const state = {
  accessToken: null,
  tokenExpiry: 0,
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
    goTo('screen-login');
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
    if (!refreshed) throw new Error('Session expired. Please sign in again.');
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
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
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
  const token = await getToken();
  const url = `${DRIVE_API}/files/${fileId}?alt=media&acknowledgeAbuse=true&supportsAllDrives=true&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
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

  const videoFilter =
    `[0:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2:black,setsar=1[top];` +
    `[1:v]scale=1080:960:force_original_aspect_ratio=decrease,pad=1080:960:(ow-iw)/2:(oh-ih)/2:black,setsar=1[bottom];` +
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
    video: { width: { ideal: 1080 }, height: { ideal: 1920 }, facingMode: 'user' },
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
  if (!webcamStream) {
    alert('Camera not available.');
    return;
  }

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
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  prerecordedVideo.pause();
  isRecording = false;
  btnRecord.textContent = 'Start Recording';
  btnRecord.classList.remove('recording');
  clearInterval(timerInterval);
}

btnRecord.addEventListener('click', () => {
  if (!isRecording) startRecording();
  else stopRecording();
});

// ─── Preview ─────────────────────────────────────────────
const previewTop = $('preview-top');
const previewBottom = $('preview-bottom');
const btnPlayPreview = $('btn-play-preview');
let syncInterval = null;

function initPreview() {
  previewTop.src = state.currentVideoUrl;
  previewBottom.src = state.webcamUrl;
  previewTop.load();
  previewBottom.load();
  btnPlayPreview.textContent = 'Play Preview';
  clearSync();
}

function clearSync() {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

btnPlayPreview.addEventListener('click', () => {
  if (previewTop.paused) {
    previewTop.currentTime = 0;
    previewBottom.currentTime = 0;
    previewTop.play().catch(() => {});
    previewBottom.play().catch(() => {});
    btnPlayPreview.textContent = 'Pause';

    clearSync();
    syncInterval = setInterval(() => {
      if (previewTop.paused || previewTop.ended) {
        clearSync();
        return;
      }
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

  try {
    titleEl.textContent = 'Loading FFmpeg...';
    statusEl.textContent = 'Downloading video processor (first time only)...';
    setProgress(0);

    await loadFFmpeg(msg => { statusEl.textContent = msg; });

    titleEl.textContent = 'Merging Video...';
    statusEl.textContent = 'Combining top & bottom into 9:16...';
    setProgress(0);

    const mergedBlob = await mergeVideos(
      state.currentVideoBlob,
      state.webcamBlob,
      p => setProgress(p * 100)
    );

    titleEl.textContent = 'Uploading to Drive...';
    statusEl.textContent = 'Saving to Omegle Complete folder...';
    setProgress(0);

    const sourceName = state.videos[state.currentIndex].name;
    const outputName = `skit_${sourceName.replace(/\.[^.]+$/, '')}.mp4`;

    await uploadToDrive(mergedBlob, outputName, state.outputFolderId, p => setProgress(p * 100));

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

    const [sourceVideos, completedVideos] = await Promise.all([
      listVideos(sourceId),
      listVideos(outputId)
    ]);

    const completedSet = new Set(
      completedVideos.map(f => f.name.replace(/^skit_/, '').replace(/\.[^.]+$/, ''))
    );

    state.videos = sourceVideos.filter(v => {
      const baseName = v.name.replace(/\.[^.]+$/, '');
      return !completedSet.has(baseName);
    });

    state.currentIndex = 0;

    if (state.videos.length === 0 && sourceVideos.length === 0) {
      goTo('screen-empty');
    } else if (state.videos.length === 0) {
      goTo('screen-complete');
    } else {
      await loadCurrentVideo();
    }
  } catch (err) {
    if (err.message.includes('Not configured')) {
      goTo('screen-login');
    } else {
      alert('Failed to load videos: ' + err.message);
      goTo('screen-empty');
    }
  }
}

async function loadCurrentVideo() {
  const video = state.videos[state.currentIndex];
  if (!video) {
    goTo('screen-complete');
    return;
  }

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
  if (state.currentIndex >= state.videos.length) {
    goTo('screen-complete');
  } else {
    loadCurrentVideo();
  }
});

$('btn-next').addEventListener('click', () => {
  state.currentIndex++;
  if (state.currentIndex >= state.videos.length) {
    goTo('screen-complete');
  } else {
    loadCurrentVideo();
  }
});

$('btn-refresh').addEventListener('click', () => loadVideoList());
$('btn-check-new').addEventListener('click', () => loadVideoList());

// ─── Init ────────────────────────────────────────────────
async function init() {
  if (!window.MediaRecorder) {
    alert('Your browser does not support video recording. Please use Chrome or Firefox.');
    return;
  }

  const refreshed = await refreshAccessToken();
  if (!refreshed) {
    goTo('screen-login');
    return;
  }

  await loadVideoList();
}

init();
