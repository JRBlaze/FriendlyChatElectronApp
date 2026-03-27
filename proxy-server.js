// Friendly Chat - Kick OAuth Proxy
// Deploy this to Railway, Render, or any Node.js host.
// Set environment variables KICK_CLIENT_ID, KICK_CLIENT_SECRET, and ALLOWED_ORIGIN.
//
// Railway: railway.app (free tier, deploy in ~2 minutes)
//   1. Create account at railway.app
//   2. New Project > Deploy from GitHub repo (or paste this file)
//   3. Set environment variables in the Railway dashboard
//   4. Copy your deployment URL (e.g. https://friendly-chat-proxy.up.railway.app)
//   5. Put that URL in the app's config.json as "kick_proxy_url"
//
// Render: render.com (free tier)
//   Same process — New Web Service > deploy > set env vars > copy URL

const http = require('http');

const KICK_CLIENT_ID     = process.env.KICK_CLIENT_ID     || '';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const ALLOWED_ORIGIN     = process.env.ALLOWED_ORIGIN     || '*'; // set to your app's origin if desired
const PORT               = process.env.PORT               || 3000;

if(!KICK_CLIENT_ID || !KICK_CLIENT_SECRET) {
  console.error('ERROR: KICK_CLIENT_ID and KICK_CLIENT_SECRET env vars must be set.');
  process.exit(1);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // CORS — allow the Electron app to call this proxy
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if(req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if(url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'friendly-chat-kick-proxy' }));
    return;
  }

  // Returns the Kick Client ID (safe to expose — it's a public identifier)
  // The redirect_uri must match what's registered in the Kick developer console
  if(url.pathname === '/kick-config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ client_id: KICK_CLIENT_ID }));
    return;
  }

  // Exchanges a PKCE auth code for access + refresh tokens
  if(url.pathname === '/kick-token' && req.method === 'POST') {
    try {
      const { code, code_verifier, redirect_uri } = await readBody(req);
      const params = new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     KICK_CLIENT_ID,
        client_secret: KICK_CLIENT_SECRET,
        redirect_uri:  redirect_uri,
        code_verifier,
        code,
      });
      const kickRes = await fetch('https://id.kick.com/oauth/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    params.toString(),
      });
      const data = await kickRes.json();
      if(!kickRes.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: data.error || 'token exchange failed' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_in:    data.expires_in,
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Silently refreshes an expired Kick access token
  if(url.pathname === '/kick-refresh' && req.method === 'POST') {
    try {
      const { refresh_token } = await readBody(req);
      const params = new URLSearchParams({
        grant_type:    'refresh_token',
        client_id:     KICK_CLIENT_ID,
        client_secret: KICK_CLIENT_SECRET,
        refresh_token,
      });
      const kickRes = await fetch('https://id.kick.com/oauth/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    params.toString(),
      });
      const data = await kickRes.json();
      if(!kickRes.ok) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: data.error || 'refresh failed' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token:  data.access_token,
        refresh_token: data.refresh_token,
        expires_in:    data.expires_in,
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Friendly Chat Kick Proxy running on port ${PORT}`);
});
