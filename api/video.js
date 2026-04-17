export const config = { runtime: 'edge' };

const FILE_ID_RE = /^[a-zA-Z0-9_-]{10,}$/;

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const fileId = searchParams.get('id');

  if (!fileId || !FILE_ID_RE.test(fileId)) {
    return new Response('Invalid file id', { status: 400 });
  }

  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!refreshToken) {
    return new Response(JSON.stringify({ error: 'Not configured' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    return new Response('Auth failed: ' + (tokenData.error_description || tokenData.error), { status: 401 });
  }

  const driveRes = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true&acknowledgeAbuse=true`,
    { headers: { Authorization: `Bearer ${tokenData.access_token}` } }
  );

  if (!driveRes.ok) {
    const text = await driveRes.text();
    return new Response(text, { status: driveRes.status });
  }

  const headers = {
    'Content-Type': driveRes.headers.get('content-type') || 'video/mp4',
    'Cache-Control': 'private, max-age=3600'
  };

  const contentLength = driveRes.headers.get('content-length');
  if (contentLength) headers['Content-Length'] = contentLength;

  return new Response(driveRes.body, { headers });
}
