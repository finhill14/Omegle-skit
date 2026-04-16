const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.headers['x-session-id'];
    if (!sessionId) return cb(new Error('Missing session ID'));
    const dir = path.join(__dirname, '..', 'uploads', sessionId);
    if (!fs.existsSync(dir)) return cb(new Error('Invalid session ID'));
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
