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

    if (!tokens.refresh_token) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><body style="font-family:sans-serif;padding:2rem;background:#0a0a0a;color:#fff">
<h1>No refresh token received</h1>
<p>Google only returns a refresh token on the first authorization. To get a new one:</p>
<ol>
  <li>Go to <a style="color:#4fc3f7" href="https://myaccount.google.com/permissions">your Google Account permissions page</a></li>
  <li>Revoke access to this app</li>
  <li>Try the setup again</li>
</ol>
<a href="/api/auth/google" style="display:inline-block;padding:.7rem 1.5rem;background:#4285f4;color:#fff;border-radius:8px;text-decoration:none">Retry Sign In</a>
</body></html>`);
      return;
    }

    const refreshToken = tokens.refresh_token;
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Setup Complete</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fff; padding: 2rem 1rem; line-height: 1.5; }
  main { max-width: 720px; margin: 0 auto; }
  h1 { color: #4fc3f7; margin-bottom: 1rem; font-size: 1.8rem; }
  h2 { color: #4fc3f7; margin: 2rem 0 .75rem; font-size: 1.1rem; }
  p { color: #ccc; margin-bottom: 1rem; }
  code { background: #222; padding: 2px 8px; border-radius: 4px; font-family: 'SF Mono', Consolas, monospace; color: #4fc3f7; }
  .token-box { background: #1a1a1a; padding: 1rem; border-radius: 8px; word-break: break-all; font-family: monospace; margin: .5rem 0 1rem; border: 1px solid #333; font-size: .85rem; position: relative; }
  .copy-btn { background: #4fc3f7; color: #000; border: none; padding: .5rem 1rem; border-radius: 6px; cursor: pointer; font-weight: 600; font-size: .85rem; margin-bottom: 1rem; }
  .copy-btn:hover { background: #81d4fa; }
  ol { padding-left: 1.5rem; color: #ccc; }
  ol li { margin-bottom: .5rem; }
  .btn { display: inline-block; padding: .8rem 1.5rem; background: #43a047; color: #fff; border-radius: 8px; text-decoration: none; font-weight: 600; margin-top: 1rem; }
  .btn:hover { background: #66bb6a; }
  .warning { background: #2a1f0a; border-left: 3px solid #ffa726; padding: .75rem 1rem; border-radius: 4px; margin: 1rem 0; color: #ffcc80; font-size: .9rem; }
</style>
</head>
<body>
<main>
  <h1>Setup Complete</h1>
  <p>One more step to make the app work without sign-in for your models.</p>

  <div class="warning">
    <strong>Keep this secret.</strong> This token gives full access to your Google Drive. Don't share it.
  </div>

  <h2>1. Copy your refresh token</h2>
  <div class="token-box" id="token">${refreshToken}</div>
  <button class="copy-btn" onclick="copyToken()">Copy to Clipboard</button>

  <h2>2. Add it to Vercel</h2>
  <ol>
    <li>Open your project in <a style="color:#4fc3f7" href="https://vercel.com" target="_blank">Vercel Dashboard</a></li>
    <li>Go to <strong>Settings → Environment Variables</strong></li>
    <li>Add a new variable:
      <ul style="margin-top:.3rem;padding-left:1.5rem">
        <li>Name: <code>GOOGLE_REFRESH_TOKEN</code></li>
        <li>Value: (paste what you just copied)</li>
      </ul>
    </li>
    <li>Click <strong>Save</strong></li>
  </ol>

  <h2>3. Redeploy</h2>
  <p>Go to the <strong>Deployments</strong> tab, click the "..." menu on the latest deployment, and click <strong>Redeploy</strong>. After that, anyone visiting the app will be auto-authenticated to your Drive.</p>

  <a href="/" class="btn">Done — Take me to the app</a>
</main>
<script>
function copyToken() {
  const t = document.getElementById('token').textContent;
  navigator.clipboard.writeText(t).then(() => {
    const btn = document.querySelector('.copy-btn');
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy to Clipboard', 2000);
  });
}
</script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Authentication failed: ' + err.message);
  }
};
