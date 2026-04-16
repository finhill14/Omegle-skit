const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { mergeVideos } = require('../services/ffmpeg');

const router = express.Router();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

router.post('/', async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    if (!sessionId || !UUID_RE.test(sessionId)) {
      return res.status(400).json({ error: 'Invalid sessionId' });
    }

    const uploadsDir = path.resolve(__dirname, '..', 'uploads');
    const sessionDir = path.join(uploadsDir, sessionId);
    if (!sessionDir.startsWith(uploadsDir) || !fs.existsSync(sessionDir)) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const files = fs.readdirSync(sessionDir);
    const originalFile = files.find(f => f.startsWith('original'));
    const webcamFile = files.find(f => f.startsWith('webcam'));

    if (!originalFile || !webcamFile) {
      return res.status(400).json({ error: 'Missing video files for this session' });
    }

    const prerecordedPath = path.join(sessionDir, originalFile);
    const webcamPath = path.join(sessionDir, webcamFile);
    const outputFilename = `skit_${sessionId}.mp4`;
    const outputPath = path.join(__dirname, '..', 'output', outputFilename);

    const jobId = uuidv4();

    mergeVideos(jobId, prerecordedPath, webcamPath, outputPath);

    res.json({ jobId, outputFilename });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
