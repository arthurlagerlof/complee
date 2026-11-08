// Local server for the compliance viewer: http://localhost:8080
// Usage: npm start   (or: node server.mjs)
// Serves only whitelisted folders (never .env), runs the checker, and exposes a small JSON API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkModel } from './src/checker.mjs';
import { partsToModel } from './src/parts-model.mjs';
import { scoreResults } from './src/score.mjs';
import { parseAllowedOrigins, corsHeaders } from './src/cors.mjs';
import { createEvidenceProvider } from './src/evidence-provider.mjs';
import { reviewDocumentEvidence } from './src/document-review.mjs';
import { s3ConfigFrom, createS3ModelSource } from './src/model-source-s3.mjs';
import { createRegulationText } from './src/regulation-text.mjs';
import { createRateLimiter } from './src/rate-limit.mjs';
import { isIP } from 'node:net';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const SHIPCHECK_DATA_API_URL = process.env.SHIPCHECK_DATA_API_URL
  || (process.env.NODE_ENV === 'production' ? '' : 'http://127.0.0.1:8000');
// CORS: ALLOWED_ORIGINS="https://a.example,https://b.example" (default: localhost on any port only).
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const MODEL_DIR = path.resolve(ROOT, process.env.MODEL_DIR || 'model');
const apiRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 120 });
const modelRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 360 });
const staticRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 600 });
const checkRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 30 });

function clientAddress(req) {
  const cloudflareIp = process.env.TRUST_CLOUDFLARE_TUNNEL === 'true'
    ? String(req.headers['cf-connecting-ip'] || '').trim()
    : '';
  const forwarded = cloudflareIp || String(req.headers['x-real-ip'] || '').trim();
  const address = forwarded.startsWith('::ffff:') ? forwarded.slice(7) : forwarded;
  if (isIP(address)) return address;
  const remote = String(req.socket?.remoteAddress || 'unknown');
  return remote.startsWith('::ffff:') ? remote.slice(7) : remote;
}

function applyRateLimit(req, res, pathname) {
  if (req.method === 'OPTIONS') return true;
  const limiter = pathname === '/api/check'
    ? checkRateLimit
    : pathname.startsWith('/model/') ? modelRateLimit
      : pathname.startsWith('/api/') ? apiRateLimit : staticRateLimit;
  const result = limiter.check(clientAddress(req));
  if (result.allowed) return true;
  res.setHeader('Retry-After', String(result.retryAfter));
  sendJSON(res, 429, { error: 'Too many requests. Please retry shortly.' });
  return false;
}

async function databaseCatalog(sourceKey) {
  if (!SHIPCHECK_DATA_API_URL) {
    throw Object.assign(new Error('SHIPCHECK_DATA_API_URL must point to the database-backed ShipCheck API.'), { status: 503 });
  }
  const target = new URL(`/api/v1/shipcheck/catalog/${sourceKey}`, SHIPCHECK_DATA_API_URL);
  const response = await fetch(target, { signal: AbortSignal.timeout(90_000) });
  if (!response.ok) throw Object.assign(new Error(`ShipCheck catalog ${sourceKey} returned ${response.status}`), { status: response.status });
  return response.json();
}

// Use only the audited high-precision viewport export by default. MODEL_MANIFEST is an explicit override
// for operators who intentionally want to test another manifest.
export function streamManifest(modelDir = MODEL_DIR) {
  if (process.env.MODEL_MANIFEST) return process.env.MODEL_MANIFEST;
  try {
    if (fs.existsSync(path.join(modelDir, 'stream-hp', 'manifest.json')) && JSON.parse(fs.readFileSync(path.join(modelDir, 'stream-hp', 'audit.json'), 'utf8')).pass === true) return 'stream-hp/manifest.json';
  } catch { /* report the missing or invalid audited export below */ }
  throw Object.assign(new Error('No audited high-precision viewport model is configured. Set MODEL_SOURCE=vultr with its VULTR_S3_* settings, or deploy the audited stream-hp model under MODEL_DIR.'), { status: 503 });
}

// MODEL_SOURCE=vultr: the viewer's /model/ files come from the Vultr Object Storage bucket (VULTR_S3_* in the
// environment or in shipcheck/.env) instead of the local folder; see src/model-source-s3.mjs. The .env file is a
// developer convenience and is not read under the test runner (NODE_TEST_CONTEXT), so tests stay offline.
const s3Config = s3ConfigFrom(process.env, process.env.NODE_TEST_CONTEXT ? null : path.join(ROOT, '.env'));
const s3Model = s3Config ? createS3ModelSource(s3Config, { cacheDir: path.resolve(ROOT, process.env.MODEL_CACHE_DIR || '.cache/model-s3') }) : null;

// Official regulation text per rule from the regulation database, via the backend API (REGULATION_API_URL).
const regulationText = createRegulationText({
  linksProvider: () => databaseCatalog('regulation-links'),
  ruleIds: async () => (await databaseCatalog('rules')).rules.map((r) => r.id),
  apiBase: process.env.REGULATION_API_URL || SHIPCHECK_DATA_API_URL || 'http://127.0.0.1:8000',
});

function health() {
  let manifest = false;
  try {
    if (s3Model) manifest = true;
    else manifest = fs.existsSync(path.join(MODEL_DIR, 'manifest.json'));
  } catch { /* report basic service health without internal details */ }
  return {
    status: 'ok',
    version: VERSION,
    model_source: s3Model ? 'vultr' : 'local',
    model_available: manifest,
    catalog_source: 'database',
  };
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
  ['/demo/', 'demo'],
  ['/node_modules/three/', 'node_modules/three'],
  ['/node_modules/three-mesh-bvh/', 'node_modules/three-mesh-bvh'],
  // Local 3D viewer model chunks (exported with tools/export; not in Git, deployed with deploy.sh / deploy.ps1)
  ['/model/', process.env.MODEL_DIR || 'model'],
  ['/', 'public'],
];
const MODEL_CATALOG_BY_FILE = {
  'ships/rcrv/parts.json': 'model-rcrv-parts',
  'ships/rcrv/rcrv-3d.meta.json': 'model-rcrv-meta',
  'ships/rcrv/results-3d.json': 'model-rcrv-precomputed',
  'ships/rcrv/inside.json': 'model-rcrv-inside',
  'ships/cruise/deck.json': 'model-cruise-deck',
  'ships/rcrv/layout.json': 'model-rcrv-layout',
};
const EXPECTED_CATALOG_BY_FILE = {
  'tests/expected/rcrv-3d.json': 'expected-rcrv-3d',
  'tests/expected/rcrv-inside.json': 'expected-rcrv-inside',
  'tests/expected/cruise.json': 'expected-cruise',
  'tests/expected/rcrv-layout.json': 'expected-rcrv-layout',
};

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
  for (const [prefix, dir] of STATIC) {
    if (!p.startsWith(prefix)) continue;
    const base = path.resolve(ROOT, dir);
    const candidate = path.normalize(path.join(base, p.slice(prefix.length) || 'index.html'));
    if (candidate.startsWith(base + path.sep) || candidate === base) file = candidate;
    break;
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

async function runDatabaseCheck(scenarioId) {
  const scenarios = (await databaseCatalog('scenarios')).scenarios;
  const scenario = scenarios.find((entry) => entry.id === scenarioId);
  if (!scenario) throw Object.assign(new Error(`Unknown scenario: ${scenarioId}`), { status: 404 });
  const modelCatalog = MODEL_CATALOG_BY_FILE[scenario.model];
  if (!modelCatalog) throw Object.assign(new Error(`No database model is configured for scenario ${scenarioId}`), { status: 503 });
  const rulesPromise = databaseCatalog('rules');
  const modelPromise = databaseCatalog(modelCatalog);
  const metadataPromise = scenario.meta
    ? databaseCatalog(MODEL_CATALOG_BY_FILE[scenario.meta])
    : Promise.resolve({});
  const expectedCatalog = scenario.expected ? EXPECTED_CATALOG_BY_FILE[scenario.expected] : null;
  if (scenario.meta && !MODEL_CATALOG_BY_FILE[scenario.meta]) {
    throw Object.assign(new Error(`No database model metadata is configured for scenario ${scenarioId}`), { status: 503 });
  }
  if (scenario.expected && !expectedCatalog) {
    throw Object.assign(new Error(`No database expected result is configured for scenario ${scenarioId}`), { status: 503 });
  }
  const [catalog, rawModel, metadata, expected] = await Promise.all([
    rulesPromise,
    modelPromise,
    metadataPromise,
    expectedCatalog ? databaseCatalog(expectedCatalog) : Promise.resolve(null),
  ]);
  const model = scenario.kind === 'parts' ? partsToModel(rawModel, metadata) : rawModel;
  const result = {
    generated: new Date().toISOString(),
    scenario: scenario.id,
    ...checkModel(model, catalog.rules),
  };
  if (expected) result.score = scoreResults(result, expected);
  return result;
}

const routes = {
  'GET /api/health': () => health(),
  'GET /api/model/config': async () => (s3Model
    ? { base_url: process.env.MODEL_BASE_URL || 'model/', manifest: await s3Model.streamManifest(), legacy_manifest: 'manifest.json', source: 'vultr' }
    : { base_url: process.env.MODEL_BASE_URL || 'model/', manifest: streamManifest(), legacy_manifest: 'manifest.json' }),
  'GET /api/scenarios': async () => (await databaseCatalog('scenarios')).scenarios,
  'GET /api/rules': () => databaseCatalog('rules'),
  'GET /api/regulations/text': (q) => regulationText.forRule(q.get('rule')),
  'GET /api/check': (q) => runDatabaseCheck(q.get('scenario') || 'rcrv-3d'),
  'GET /api/evidence/provider': () => ({ id: evidenceProvider.id, metadata: evidenceProvider.metadata || null }),
  'GET /api/evidence/search': (q) => evidenceProvider.search(q.get('q') || '', { limit: q.get('limit') || 8, sourceKind: q.get('sourceKind') || undefined, regulation: q.get('regulation') || undefined }),
  'POST /api/evidence/review': (q, body, req) => {
    localOnly(req);
    return reviewDocumentEvidence({ ...body, provider: evidenceProvider });
  },
  // APS 3D viewer (real RCRV model).
  'GET /api/aps/status': () => ({ configured: !!(aps.APS_CLIENT_ID && aps.APS_CLIENT_SECRET) }),
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
  let url;
  let p;
  try {
    url = new URL(req.url, 'http://localhost');
    p = decodeURIComponent(url.pathname);
  } catch {
    return sendJSON(res, 400, { error: 'Invalid request path.' });
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // CORS: headers only for allowed origins; preflight answered here (204 allowed, 403 not allowed).
  const origin = req.headers.origin;
  const cors = corsHeaders(origin, ALLOWED_ORIGINS);
  if (cors) for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
  if (req.method === 'OPTIONS') {
    res.writeHead(origin && !cors ? 403 : 204, cors ? {} : { Vary: 'Origin' });
    return res.end();
  }
  if (!applyRateLimit(req, res, p)) return;
  const catalogMatch = /^\/api\/catalog\/([a-z0-9-]+)$/.exec(p);
  if (req.method === 'GET' && catalogMatch) {
    if (!SHIPCHECK_DATA_API_URL) {
      return sendJSON(res, 503, { error: 'SHIPCHECK_DATA_API_URL must point to the database-backed ShipCheck API.' });
    }
    try {
      if (!SHIPCHECK_DATA_API_URL) {
        return sendJSON(res, 503, { error: 'SHIPCHECK_DATA_API_URL must point to the database-backed ShipCheck API.' });
      }
      const target = new URL(`/api/v1/shipcheck/catalog/${catalogMatch[1]}`, SHIPCHECK_DATA_API_URL);
      const upstream = await fetch(target, { signal: AbortSignal.timeout(90_000) });
      const body = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(upstream.status, {
        'Content-Type': upstream.headers.get('content-type') || 'application/json',
        'Cache-Control': 'no-store',
        'Content-Length': body.length,
      });
      return res.end(body);
    } catch {
      return sendJSON(res, 502, { error: 'ShipCheck database API is temporarily unavailable.' });
    }
  }
  const handler = routes[`${req.method} ${p}`];
  if (handler) {
    try {
      const limit = p === '/api/aps/fallback' ? 8_000_000 : p === '/api/evidence/review' ? 12_000_000 : 200_000;
      const body = req.method === 'POST' ? await readBody(req, limit) : undefined;
      return sendJSON(res, 200, await handler(url.searchParams, body, req));
    } catch (e) {
      const code = e.status || 500;
      return sendJSON(res, code, { error: code >= 500 ? 'Service temporarily unavailable.' : e.message });
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJSON(res, 405, { error: 'Method not allowed' });
  if (s3Model && p.startsWith('/model/')) return s3Model.serve(p.slice('/model/'.length), req, res);
  serveStatic(p === '/' ? '/evidence.html' : p, res, req);
}

export const server = http.createServer(handleRequest);

// Listen on PORT only when started directly (npm start / node server.mjs), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) server.listen(PORT, () => {
  console.log(`Open http://localhost:${PORT}`);
});
