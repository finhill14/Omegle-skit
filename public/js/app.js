(function () {
  const state = {
    sessionId: null,
    prerecordedUrl: null,
    webcamBlob: null,
    webcamUrl: null,
    jobId: null,
    outputFilename: null
  };

  const screens = {
    upload: document.getElementById('screen-upload'),
    record: document.getElementById('screen-record'),
    preview: document.getElementById('screen-preview'),
    done: document.getElementById('screen-done')
  };

  function goTo(screen) {
    Object.values(screens).forEach(s => s.classList.remove('active'));
    screens[screen].classList.add('active');
  }

  // ─── UPLOAD ────────────────────────────────────────────
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const uploadProgress = document.getElementById('upload-progress');
  const uploadBar = document.getElementById('upload-bar');
  const uploadPercent = document.getElementById('upload-percent');

  dropzone.addEventListener('dragover', e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) uploadFile(fileInput.files[0]);
  });

  function uploadFile(file) {
    if (!file.type.startsWith('video/')) {
      alert('Please select a video file.');
      return;
    }

    const formData = new FormData();
    formData.append('video', file);

    const xhr = new XMLHttpRequest();
    uploadProgress.hidden = false;

    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        uploadBar.style.width = pct + '%';
        uploadPercent.textContent = pct + '%';
      }
    };

    xhr.onload = () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        state.sessionId = data.sessionId;
        state.prerecordedUrl = `/uploads/${data.sessionId}/${data.filename}`;
        initRecordScreen();
        goTo('record');
      } else {
        alert('Upload failed: ' + xhr.responseText);
      }
    };

    xhr.onerror = () => alert('Upload failed. Please try again.');
    xhr.open('POST', '/api/upload');
    xhr.send(formData);
  }

  // ─── RECORD ────────────────────────────────────────────
  const prerecordedVideo = document.getElementById('prerecorded-video');
  const webcamPreview = document.getElementById('webcam-preview');
  const btnRecord = document.getElementById('btn-record');
  const recTimer = document.getElementById('rec-timer');

  let mediaRecorder = null;
  let webcamStream = null;
  let recordedChunks = [];
  let timerInterval = null;
  let isRecording = false;

  async function initRecordScreen() {
    prerecordedVideo.src = state.prerecordedUrl;
    prerecordedVideo.load();

    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1080 }, height: { ideal: 1920 }, facingMode: 'user' },
        audio: true
      });
      webcamPreview.srcObject = webcamStream;
    } catch (err) {
      alert('Camera access denied. Please allow camera and microphone access.');
    }
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

  btnRecord.addEventListener('click', () => {
    if (!isRecording) {
      startRecording();
    } else {
      stopRecording();
    }
  });

  function startRecording() {
    if (!webcamStream) {
      alert('No camera available.');
      return;
    }

    recordedChunks = [];
    const mimeType = getMimeType();

    mediaRecorder = new MediaRecorder(webcamStream, {
      mimeType: mimeType || undefined,
      videoBitsPerSecond: 2500000
    });

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const mType = mimeType || 'video/webm';
      state.webcamBlob = new Blob(recordedChunks, { type: mType });
      if (state.webcamUrl) URL.revokeObjectURL(state.webcamUrl);
      state.webcamUrl = URL.createObjectURL(state.webcamBlob);
      uploadRecording();
    };

    mediaRecorder.start(1000);
    prerecordedVideo.currentTime = 0;
    prerecordedVideo.play();

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

  function uploadRecording() {
    const formData = new FormData();
    formData.append('recording', state.webcamBlob, 'webcam.webm');

    const xhr = new XMLHttpRequest();
    xhr.onload = () => {
      if (xhr.status === 200) {
        stopWebcam();
        initPreviewScreen();
        goTo('preview');
      } else {
        alert('Failed to upload recording. Please try again.');
      }
    };
    xhr.onerror = () => alert('Failed to upload recording.');
    xhr.open('POST', '/api/record');
    xhr.setRequestHeader('X-Session-Id', state.sessionId);
    xhr.send(formData);
  }

  function stopWebcam() {
    if (webcamStream) {
      webcamStream.getTracks().forEach(t => t.stop());
      webcamStream = null;
    }
    webcamPreview.srcObject = null;
  }

  // ─── PREVIEW ───────────────────────────────────────────
  const previewTop = document.getElementById('preview-top');
  const previewBottom = document.getElementById('preview-bottom');
  const btnPlayPreview = document.getElementById('btn-play-preview');
  const btnRerecord = document.getElementById('btn-rerecord');
  const btnApprove = document.getElementById('btn-approve');

  let syncInterval = null;

  function initPreviewScreen() {
    previewTop.src = state.prerecordedUrl;
    previewBottom.src = state.webcamUrl;
    previewTop.load();
    previewBottom.load();
    btnPlayPreview.textContent = 'Play Preview';
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
      previewTop.play();
      previewBottom.play();
      btnPlayPreview.textContent = 'Pause';

      clearSync();
      syncInterval = setInterval(() => {
        if (previewTop.paused || previewTop.ended) {
          clearSync();
          return;
        }
        const drift = Math.abs(previewTop.currentTime - previewBottom.currentTime);
        if (drift > 0.1) {
          previewBottom.currentTime = previewTop.currentTime;
        }
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
    btnPlayPreview.textContent = 'Play Preview';
  });

  btnRerecord.addEventListener('click', () => {
    previewTop.pause();
    previewBottom.pause();
    clearSync();
    recTimer.textContent = '00:00';
    recTimer.hidden = true;
    initRecordScreen();
    goTo('record');
  });

  btnApprove.addEventListener('click', () => {
    previewTop.pause();
    previewBottom.pause();
    startMerge();
  });

  // ─── MERGE / DONE ─────────────────────────────────────
  const mergingState = document.getElementById('merging-state');
  const doneState = document.getElementById('done-state');
  const mergeBar = document.getElementById('merge-bar');
  const mergePercent = document.getElementById('merge-percent');
  const downloadLink = document.getElementById('download-link');
  const btnNew = document.getElementById('btn-new');

  function startMerge() {
    mergingState.hidden = false;
    doneState.hidden = true;
    mergeBar.style.width = '0%';
    mergePercent.textContent = '0%';
    goTo('done');

    fetch('/api/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId })
    })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          alert('Merge failed: ' + data.error);
          return;
        }
        state.jobId = data.jobId;
        state.outputFilename = data.outputFilename;
        watchProgress(data.jobId, data.outputFilename);
      })
      .catch(err => alert('Merge request failed: ' + err.message));
  }

  function watchProgress(jobId, filename) {
    const source = new EventSource(`/api/status/${jobId}?filename=${encodeURIComponent(filename)}`);

    source.onmessage = e => {
      const data = JSON.parse(e.data);

      if (data.error) {
        source.close();
        alert('Merge error: ' + data.error);
        goTo('preview');
        return;
      }

      if (data.percent !== undefined) {
        mergeBar.style.width = data.percent + '%';
        mergePercent.textContent = data.percent + '%';
      }

      if (data.done) {
        source.close();
        mergeBar.style.width = '100%';
        mergePercent.textContent = '100%';
        mergingState.hidden = true;
        doneState.hidden = false;
        downloadLink.href = data.outputUrl;
        downloadLink.textContent = 'Download Video';
      }
    };

    source.onerror = () => {
      source.close();
    };
  }

  btnNew.addEventListener('click', () => {
    state.sessionId = null;
    state.prerecordedUrl = null;
    state.webcamBlob = null;
    state.webcamUrl = null;
    state.jobId = null;
    state.outputFilename = null;
    uploadProgress.hidden = true;
    uploadBar.style.width = '0%';
    uploadPercent.textContent = '0%';
    fileInput.value = '';
    goTo('upload');
  });

  if (!window.MediaRecorder) {
    alert('Your browser does not support video recording. Please use Chrome or Firefox.');
  }
})();
