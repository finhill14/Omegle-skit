module.exports = async (req, res) => {
  const { code } = req.query;
  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('Missing authorization code');
    return;
  }

  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${protocol}://${host}/api/auth/callback`,
        grant_type: 'authorization_code'
      })
    });

    const tokens = await tokenRes.json();

    if (tokens.error) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end(`Auth error: ${tokens.error_description || tokens.error}`);
      return;
    }

    const cookies = [];
    if (tokens.refresh_token) {
      cookies.push(
        `refresh_token=${tokens.refresh_token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`
      );
    }

    res.writeHead(302, {
      'Set-Cookie': cookies,
      Location: `/#access_token=${encodeURIComponent(tokens.access_token)}&expires_in=${tokens.expires_in}`
    });
    res.end();
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Authentication failed: ' + err.message);
  }
};
