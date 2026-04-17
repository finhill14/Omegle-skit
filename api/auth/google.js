module.exports = (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host;

  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${protocol}://${host}/api/auth/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/drive',
    access_type: 'offline',
    prompt: 'consent'
  });

  res.writeHead(302, {
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`
  });
  res.end();
};
