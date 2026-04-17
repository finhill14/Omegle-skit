const { verifyToken } = require('../lib/auth');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const PROGRESS_FILE = 'omegle-progress.json';

async function getAccessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });
  const data = await res.json();
  return data.access_token || null;
}

async function findProgressFile(token) {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', `name='${PROGRESS_FILE}' and trashed=false`);
  url.searchParams.set('fields', 'files(id)');
  url.searchParams.set('spaces', 'drive');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const data = await res.json();
  return data.files?.[0]?.id || null;
}

async function readData(token, fileId) {
  const res = await fetch(`${DRIVE_API}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return {};
  try { return await res.json(); } catch { return {}; }
}

async function writeData(token, fileId, data) {
  await fetch(`${UPLOAD_API}/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

async function createFile(token, data) {
  const boundary = 'omegleProgressBoundary';
  const metadata = JSON.stringify({ name: PROGRESS_FILE, mimeType: 'application/json' });
  const content = JSON.stringify(data);
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${content}\r\n--${boundary}--`;
  await fetch(`${UPLOAD_API}/files?uploadType=multipart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary="${boundary}"` },
    body
  });
}

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const sessionToken = authHeader.replace('Bearer ', '').trim();
  const username = verifyToken(sessionToken);

  if (!username) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' })); return;
  }

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Drive not configured' })); return;
    }

    const fileId = await findProgressFile(accessToken);
    const allProgress = fileId ? await readData(accessToken, fileId) : {};

    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ completed: allProgress[username] || [] })); return;
    }

    if (req.method === 'POST') {
      let body = '';
      await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });
      let videoId;
      try { ({ videoId } = JSON.parse(body)); } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
      }

      if (!allProgress[username]) allProgress[username] = [];
      if (!allProgress[username].includes(videoId)) {
        allProgress[username].push(videoId);
        if (fileId) await writeData(accessToken, fileId, allProgress);
        else await createFile(accessToken, allProgress);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true })); return;
    }

    res.writeHead(405); res.end();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
};
