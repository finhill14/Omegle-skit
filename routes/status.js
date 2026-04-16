const express = require('express');
const { jobs } = require('../services/ffmpeg');

const router = express.Router();

router.get('/:jobId', (req, res) => {
  const { jobId } = req.params;
  const emitter = jobs.get(jobId);

  if (!emitter) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const onProgress = data => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const onDone = data => {
    res.write(`data: ${JSON.stringify({ done: true, outputUrl: `/output/${req.query.filename}` })}\n\n`);
    cleanup();
  };

  const onError = data => {
    res.write(`data: ${JSON.stringify({ error: data.message })}\n\n`);
    cleanup();
  };

  function cleanup() {
    emitter.removeListener('progress', onProgress);
    emitter.removeListener('done', onDone);
    emitter.removeListener('error', onError);
    if (!res.writableEnded) res.end();
  }

  emitter.on('progress', onProgress);
  emitter.on('done', onDone);
  emitter.on('error', onError);

  req.on('close', cleanup);
});

module.exports = router;
