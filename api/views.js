const { verifyToken } = require('../lib/auth');

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const VIEWS_FILE = 'omegle-views.json';

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

async function findViewsFile(token) {
  const url = new URL(`${DRIVE_API}/files`);
  url.searchParams.set('q', `name='${VIEWS_FILE}' and trashed=false`);
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

module.exports = async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const sessionToken = authHeader.replace('Bearer ', '').trim();
  const username = verifyToken(sessionToken);

  if (!username) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' })); return;
  }

  if (req.method !== 'GET') {
    res.writeHead(405); res.end(); return;
  }

  try {
    const accessToken = await getAccessToken();
    if (!accessToken) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Drive not configured' })); return;
    }

    const fileId = await findViewsFile(accessToken);
    const views = fileId ? await readData(accessToken, fileId) : {};

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ views }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
};
