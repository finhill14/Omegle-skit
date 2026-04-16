const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { mergeVideos } = require('../services/ffmpeg');

const router = express.Router();

router.post('/', async (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const sessionDir = path.join(__dirname, '..', 'uploads', sessionId);
  if (!fs.existsSync(sessionDir)) {
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
});

module.exports = router;
