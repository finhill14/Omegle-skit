const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

['uploads', 'output'].forEach(dir => {
  fs.mkdirSync(path.join(__dirname, dir), { recursive: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/output', express.static(path.join(__dirname, 'output')));
app.use(express.json());

app.use('/api/upload', require('./routes/upload'));
app.use('/api/record', require('./routes/record'));
app.use('/api/merge', require('./routes/merge'));
app.use('/api/status', require('./routes/status'));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
