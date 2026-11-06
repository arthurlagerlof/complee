// Tiny local server: serves the viewer page and hands the browser a read-only token.
// Usage: node --env-file=.env server.mjs   then open http://localhost:3000
import http from 'node:http';
import fs from 'node:fs';

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) {
  console.error('Missing APS_CLIENT_ID / APS_CLIENT_SECRET in .env');
  process.exit(1);
}

let cached = null;
async function viewerToken() {
  if (cached && cached.expires > Date.now() + 60000) return cached;
  const res = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'viewables:read' }),
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  const t = await res.json();
  cached = { access_token: t.access_token, expires_in: t.expires_in, expires: Date.now() + t.expires_in * 1000 };
  return cached;
}

http
  .createServer(async (req, res) => {
    try {
      if (req.url === '/token') {
        const t = await viewerToken();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ access_token: t.access_token, expires_in: t.expires_in }));
      } else if (req.url === '/urn') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(fs.readFileSync('urn.txt', 'utf8').trim());
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync('index.html'));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(e.message);
    }
  })
  .listen(3000, () => console.log('Open http://localhost:3000'));
