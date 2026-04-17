module.exports = (req, res) => {
  res.writeHead(302, {
    'Set-Cookie': 'refresh_token=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    Location: '/'
  });
  res.end();
};
