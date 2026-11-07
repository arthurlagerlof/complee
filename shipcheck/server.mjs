// Local server for the compliance viewer: http://localhost:8080
// Usage: npm start   (or: node server.mjs)
// Serves only whitelisted folders (never .env), runs the checker, and exposes a small JSON API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, loadRules, loadScenarios } from './src/load.mjs';
import { createEvidenceProvider } from './src/evidence-provider.mjs';
import { reviewDocumentEvidence } from './src/document-review.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const evidenceProvider = await createEvidenceProvider({ kind: process.env.EVIDENCE_PROVIDER || 'sinceai' });

// Autodesk APS keys for the 3D viewer: read from 3D_Since_AI/.env into a private object (not process.env),
// never logged, never served. The browser only gets a short-lived read-only token (scope viewables:read).
const APS_DIR = path.join(ROOT, '3D_Since_AI');
const aps = {};
if (fs.existsSync(path.join(APS_DIR, '.env'))) {
  for (const line of fs.readFileSync(path.join(APS_DIR, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(APS_CLIENT_ID|APS_CLIENT_SECRET)\s*=\s*(.*?)\s*$/);
    if (m) aps[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
aps.APS_CLIENT_ID ??= process.env.APS_CLIENT_ID;
aps.APS_CLIENT_SECRET ??= process.env.APS_CLIENT_SECRET;
const apsUrn = () => (fs.existsSync(path.join(APS_DIR, 'urn.txt')) ? fs.readFileSync(path.join(APS_DIR, 'urn.txt'), 'utf8').trim() : null);
let apsToken = null;
async function apsViewerToken() {
  if (apsToken && apsToken.expires > Date.now() + 60_000) return apsToken;
  const res = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${aps.APS_CLIENT_ID}:${aps.APS_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'viewables:read' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw Object.assign(new Error(`APS authentication failed (${res.status})`), { status: 502 });
  const t = await res.json();
  apsToken = { access_token: t.access_token, expires_in: t.expires_in, expires: Date.now() + t.expires_in * 1000 };
  return apsToken;
}
const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req?.socket?.remoteAddress);
const localOnly = (req) => { if (!isLoopback(req)) throw Object.assign(new Error('Only available on this computer'), { status: 403 }); };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.png': 'image/png',
};
// URL prefix -> folder on disk. Anything else is 404.
const STATIC = [
  ['/src/', 'src'],
  ['/ships/', 'ships'],
  ['/tests/expected/', 'tests/expected'],
  ['/demo/', 'demo'],
  ['/node_modules/three/', 'node_modules/three'],
  ['/', 'public'],
];
const ROOT_FILES = new Set(['/rules.json', '/scenarios.json']);

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function serveStatic(p, res) {
  let file = null;
  if (ROOT_FILES.has(p)) file = path.join(ROOT, p);
  else {
    for (const [prefix, dir] of STATIC) {
      if (!p.startsWith(prefix)) continue;
      const base = path.join(ROOT, dir);
      const candidate = path.normalize(path.join(base, p.slice(prefix.length) || 'index.html'));
      if (candidate.startsWith(base + path.sep) || candidate === base) file = candidate;
      break;
    }
  }
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const routes = {
  'GET /api/scenarios': () => loadScenarios(),
  'GET /api/rules': () => ({ rules: loadRules() }),
  'GET /api/check': (q) => runCheck(q.get('scenario') || 'rcrv-3d'),
  'GET /api/evidence/provider': () => ({ id: evidenceProvider.id, metadata: evidenceProvider.metadata || null }),
  'GET /api/evidence/search': (q) => evidenceProvider.search(q.get('q') || '', { limit: q.get('limit') || 8, sourceKind: q.get('sourceKind') || undefined, regulation: q.get('regulation') || undefined }),
  'POST /api/evidence/review': (q, body, req) => {
    localOnly(req);
    return reviewDocumentEvidence({ ...body, provider: evidenceProvider });
  },
  // APS 3D viewer (real RCRV model).
  'GET /api/aps/status': () => {
    const configured = !!(aps.APS_CLIENT_ID && aps.APS_CLIENT_SECRET);
    return { configured, urn: apsUrn(), reason: configured ? null : 'no APS keys in 3D_Since_AI/.env' };
  },
  'GET /api/aps/token': async (q, b, req) => {
    localOnly(req);
    if (!aps.APS_CLIENT_ID || !aps.APS_CLIENT_SECRET) throw Object.assign(new Error('APS not configured'), { status: 503 });
    const t = await apsViewerToken();
    return { access_token: t.access_token, expires_in: Math.round((t.expires - Date.now()) / 1000) };
  },
  // Saves a viewer screenshot as an offline fallback image (public/fallback/<name>.png). Local only.
  'POST /api/aps/fallback': (q, b, req) => {
    localOnly(req);
    const name = String(b.name || '');
    const m = String(b.dataUrl || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!/^[a-z0-9-]{1,40}$/.test(name) || !m) throw Object.assign(new Error('Expected { name: [a-z0-9-], dataUrl: PNG }'), { status: 400 });
    fs.mkdirSync(path.join(ROOT, 'public', 'fallback'), { recursive: true });
    const file = path.join(ROOT, 'public', 'fallback', `${name}.png`);
    fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
    return { saved: `fallback/${name}.png`, bytes: fs.statSync(file).size };
  },
};

export function addRoute(key, handler) { routes[key] = handler; }

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  const handler = routes[`${req.method} ${p}`];
  if (handler) {
    try {
      const limit = p === '/api/aps/fallback' ? 8_000_000 : p === '/api/evidence/review' ? 12_000_000 : 200_000;
      const body = req.method === 'POST' ? await readBody(req, limit) : undefined;
      return sendJSON(res, 200, await handler(url.searchParams, body, req));
    } catch (e) {
      return sendJSON(res, e.status || 500, { error: e.message });
    }
  }
  if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Method not allowed' });
  serveStatic(p === '/' ? '/evidence.html' : p, res);
});

server.listen(PORT, () => {
  for (const s of loadScenarios()) {
    const out = runCheck(s.id);
    console.log(`${s.name}: ${JSON.stringify(out.summary)}`);
  }
  console.log(`Open http://localhost:${PORT}`);
});
