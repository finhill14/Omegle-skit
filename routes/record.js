const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId || !UUID_RE.test(sessionId)) return cb(new Error('Invalid session ID'));
    const uploadsDir = path.resolve(__dirname, '..', 'uploads');
    const dir = path.join(uploadsDir, sessionId);
    if (!dir.startsWith(uploadsDir) || !fs.existsSync(dir)) return cb(new Error('Invalid session ID'));
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    cb(null, 'webcam.webm');
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

router.post('/', upload.single('recording'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No recording provided' });
  }
  const sessionId = req.headers['x-session-id'];
  res.json({ sessionId, webcamFile: req.file.filename });
});

module.exports = router;
