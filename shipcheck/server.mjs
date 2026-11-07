// Local server for the compliance viewer: http://localhost:8080
// Usage: npm start   (or: node server.mjs)
// Serves only whitelisted folders (never .env), runs the checker, and exposes a small JSON API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCheck, loadRules, loadScenarios } from './src/load.mjs';
import { parseAllowedOrigins, corsHeaders } from './src/cors.mjs';
import { createEvidenceProvider } from './src/evidence-provider.mjs';
import { reviewDocumentEvidence } from './src/document-review.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// CORS: ALLOWED_ORIGINS="https://a.example,https://b.example" (default: localhost on any port only).
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const MODEL_DIR = path.resolve(ROOT, process.env.MODEL_DIR || 'model');

// Viewport tiles the viewer streams: the high-precision tiles (model/stream-hp, float32 positions, see
// tools/export/export-tiles-hp.mjs) once their source audit has passed, else the original tiles (model/stream).
// MODEL_MANIFEST overrides (e.g. MODEL_MANIFEST=stream/manifest.json to go back).
export function streamManifest(modelDir = MODEL_DIR) {
  if (process.env.MODEL_MANIFEST) return process.env.MODEL_MANIFEST;
  try {
    if (fs.existsSync(path.join(modelDir, 'stream-hp', 'manifest.json')) && JSON.parse(fs.readFileSync(path.join(modelDir, 'stream-hp', 'audit.json'), 'utf8')).pass === true) return 'stream-hp/manifest.json';
  } catch { /* no audit yet */ }
  return 'stream/manifest.json';
}

function health() {
  let chunks = 0, restChunks = 0, manifest = false, parts = false;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'manifest.json'), 'utf8'));
    manifest = true; chunks = m.chunks?.length ?? 0; restChunks = m.chunks?.filter((c) => c.group === 'rest').length ?? 0;
  } catch { /* no model deployed */ }
  try { parts = Array.isArray(JSON.parse(fs.readFileSync(path.join(ROOT, 'ships/rcrv/parts.json'), 'utf8')).parts); } catch { /* missing */ }
  return { status: 'ok', version: VERSION, model_manifest: manifest, chunks, rest_chunks: restChunks, parts_loaded: parts, viewer: manifest ? 'local' : 'aps-or-fallback' };
}
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
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm',
};
// URL prefix -> folder on disk. Anything else is 404.
const STATIC = [
  ['/src/', 'src'],
  ['/ships/', 'ships'],
  ['/tests/expected/', 'tests/expected'],
  ['/demo/', 'demo'],
  ['/node_modules/three/', 'node_modules/three'],
  ['/node_modules/three-mesh-bvh/', 'node_modules/three-mesh-bvh'],
  // Local 3D viewer model chunks (exported with tools/export; not in Git, deployed with deploy.sh / deploy.ps1)
  ['/model/', process.env.MODEL_DIR || 'model'],
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

function serveStatic(p, res, req) {
  let file = null;
  if (ROOT_FILES.has(p)) file = path.join(ROOT, p);
  else {
    for (const [prefix, dir] of STATIC) {
      if (!p.startsWith(prefix)) continue;
      const base = path.resolve(ROOT, dir);
      const candidate = path.normalize(path.join(base, p.slice(prefix.length) || 'index.html'));
      if (candidate.startsWith(base + path.sep) || candidate === base) file = candidate;
      break;
    }
  }
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const ext = path.extname(file);
  const size = fs.statSync(file).size;
  // Model chunks never change under the same name: cache them for a year. Everything else: always fresh.
  const cache = ext === '.glb' ? 'public, max-age=31536000, immutable' : 'no-store';
  const headers = { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': cache, 'Accept-Ranges': 'bytes' };
  // HTTP Range (single range), e.g. for resuming large model chunks.
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req?.headers?.range || ''));
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (start < 0) start = 0;
    if (end >= size) end = size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    if (req?.method === 'HEAD') return res.end();
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  if (req?.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const routes = {
  'GET /api/health': () => health(),
  'GET /api/model/config': () => ({ base_url: process.env.MODEL_BASE_URL || 'model/', manifest: streamManifest(), legacy_manifest: 'manifest.json' }),
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

// The request handler is exported so other servers can mount ShipCheck under a path prefix
// (the Vite dev server serves it at /inspection/, see ../vite.config.ts).
export async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  // CORS: headers only for allowed origins; preflight answered here (204 allowed, 403 not allowed).
  const origin = req.headers.origin;
  const cors = corsHeaders(origin, ALLOWED_ORIGINS);
  if (cors) for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') {
    res.writeHead(origin && !cors ? 403 : 204, cors ? {} : { Vary: 'Origin' });
    return res.end();
  }
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
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'Method not allowed' });
  serveStatic(p === '/' ? '/evidence.html' : p, res, req);
}

export const server = http.createServer(handleRequest);

// Listen on PORT only when started directly (npm start / node server.mjs), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) server.listen(PORT, () => {
  for (const s of loadScenarios()) {
    const out = runCheck(s.id);
    console.log(`${s.name}: ${JSON.stringify(out.summary)}`);
  }
  console.log(`Open http://localhost:${PORT}`);
});
