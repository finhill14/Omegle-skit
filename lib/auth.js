const crypto = require('crypto');

function getSecret() {
  return process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || 'dev-secret';
}

function signToken(username) {
  const payload = Buffer.from(JSON.stringify({
    u: username,
    exp: Date.now() + 14 * 24 * 60 * 60 * 1000
  })).toString('base64');
  const sig = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
  if (sig.length !== expected.length) return null;
  const sigBuf = Buffer.from(sig, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (Date.now() > exp) return null;
    return u;
  } catch { return null; }
}

function parseAccounts() {
  const raw = process.env.ACCOUNTS;
  if (!raw) return {};
  try {
    const accounts = JSON.parse(raw);
    return Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k.toLowerCase(), v]));
  } catch { return {}; }
}

module.exports = { signToken, verifyToken, parseAccounts };
