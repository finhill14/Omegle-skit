const { signToken, parseAccounts } = require('../../lib/auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }

  let body = '';
  await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });

  let username, password;
  try { ({ username, password } = JSON.parse(body)); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
  }

  if (!username || !password) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Username and password required' })); return;
  }

  const normalised = username.toLowerCase();
  const accounts = parseAccounts();
  if (!accounts[normalised] || accounts[normalised] !== password) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid username or password' })); return;
  }

  const token = signToken(normalised);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ token, username: normalised }));
};
