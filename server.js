// Friendly Chat - Local Server
// Kick OAuth calls are forwarded to the cloud proxy (which holds the secret).
// No Kick credentials are stored locally.

const http = require('http');
const fs   = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.json': 'application/json',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
    req.on('error', reject);
  });
}

function start(CFG) {
  const PORT       = CFG.port || 8080;
  const PROXY_URL  = (CFG.proxy_url || CFG.kick_proxy_url || '').replace(/\/$/, '');
  const HAS_PROXY  = PROXY_URL && PROXY_URL !== 'YOUR_PROXY_URL_HERE';

  // Pre-fetch Kick client ID from proxy at startup
  let kickClientId = '';
  if(HAS_PROXY) {
    fetch(`${PROXY_URL}/kick-config`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if(d?.client_id) kickClientId = d.client_id; })
      .catch(e => console.warn('Could not reach proxy for Kick config:', e.message));
  }

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, `http://localhost:${PORT}`).pathname;

    res.setHeader('Access-Control-Allow-Origin',  `http://localhost:${PORT}`);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if(req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── /config — public credentials only ───────────────────────────────────
    if(pathname === '/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        twitch:  { client_id: CFG.twitch?.client_id  || '' },
        youtube: { client_id: CFG.youtube?.client_id || '' },
        kick:    { client_id: kickClientId },
        has_kick_proxy: HAS_PROXY,
      }));
      return;
    }

    // ── /kick-token — forward to cloud proxy ─────────────────────────────────
    if(pathname === '/kick-token' && req.method === 'POST') {
      if(!HAS_PROXY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Kick proxy not configured' }));
        return;
      }
      try {
        const body = await readBody(req);
        // Add redirect_uri for the proxy
        body.redirect_uri = `http://localhost:${PORT}/friendly-chat.html`;
        const kickRes = await fetch(`${PROXY_URL}/kick-token`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        const data = await kickRes.json();
        res.writeHead(kickRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── /kick-refresh — forward to cloud proxy ────────────────────────────────
    if(pathname === '/kick-refresh' && req.method === 'POST') {
      if(!HAS_PROXY) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Kick proxy not configured' }));
        return;
      }
      try {
        const body = await readBody(req);
        const kickRes = await fetch(`${PROXY_URL}/kick-refresh`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        const data = await kickRes.json();
        res.writeHead(kickRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── /kick-send — uses user's own access token, no secret needed ──────────
    if(pathname === '/kick-send' && req.method === 'POST') {
      try {
        const { token, text, broadcasterId } = await readBody(req);
        if(!broadcasterId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No broadcaster ID — leave and rejoin the channel' }));
          return;
        }
        const sendRes = await fetch('https://api.kick.com/public/v1/chat', {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify({ type: 'user', content: text, broadcaster_user_id: broadcasterId }),
        });
        const sendData = await sendRes.json();
        if(!sendRes.ok) {
          res.writeHead(sendRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: sendData.message || 'send failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ is_sent: sendData.data?.is_sent ?? true }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── /kick-mod — uses user's own access token, no secret needed ───────────
    if(pathname === '/kick-mod' && req.method === 'POST') {
      try {
        const { token, broadcasterId, action, username, duration, permanent } = await readBody(req);
        const url  = `https://api.kick.com/public/v1/channels/${broadcasterId}/bans`;
        const body = permanent ? { username } : { username, duration };
        const kickRes = await fetch(url, {
          method:  'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify(body),
        });
        const data = await kickRes.json().catch(() => ({}));
        if(!kickRes.ok) {
          res.writeHead(kickRes.status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: data.message || 'mod action failed' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }

    // ── Static file serving ──────────────────────────────────────────────────
    let filePath = pathname === '/' ? '/friendly-chat.html' : pathname;
    filePath = path.join(__dirname, filePath);
    fs.readFile(filePath, (err, data) => {
      if(err) { res.writeHead(404); res.end('Not found'); return; }
      const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });

  server.listen(PORT, () => {
    console.log(`\n  Friendly Chat running on http://localhost:${PORT}\n`);
    if(!HAS_PROXY) console.log('  ⚠  Kick proxy not configured — Kick OAuth will not work\n');
  });

  return server;
}

module.exports = { start };
