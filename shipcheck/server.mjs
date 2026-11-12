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
import { bundledCatalogEnabled, readBundledCatalog, LOCAL_CATALOG_FILES, catalogDir } from './src/catalog-local.mjs';
import crypto from 'node:crypto';
import { createRvtConverter, MAX_RVT_BYTES } from './src/rvt-convert.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// Catalog source. An explicit SHIPCHECK_DATA_API_URL selects the database-backed API. Without it the bundled
// catalog in shipcheck/catalog/ is used, so the viewer runs on its own (no database, no network).
const LOCAL_CATALOG = bundledCatalogEnabled();
const SHIPCHECK_DATA_API_URL = LOCAL_CATALOG ? '' : process.env.SHIPCHECK_DATA_API_URL
  || (process.env.NODE_ENV === 'production' ? '' : 'http://127.0.0.1:8000');
// CORS: ALLOWED_ORIGINS="https://a.example,https://b.example" (default: localhost on any port only).
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const MODEL_DIR = path.resolve(ROOT, process.env.MODEL_DIR || 'model');
const apiRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 120 });
const modelRateLimit = createRateLimiter({ windowMs: 60_000, maxRequests: 4_000 });
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

const localCatalog = readBundledCatalog;
// Bundled catalog as a response: serialized once per file version (size + mtime), with a content ETag, so a reload
// revalidates (304) instead of re-reading and re-sending the JSON. Scenarios depend on which model files exist and
// are small: they are serialized on every request.
const localCatalogCache = new Map(); // sourceKey -> { stamp, entry }
function localCatalogEntry(sourceKey) {
  let stamp = null;
  if (sourceKey !== 'scenarios' && LOCAL_CATALOG_FILES[sourceKey]) {
    try { const st = fs.statSync(path.join(catalogDir(), LOCAL_CATALOG_FILES[sourceKey])); stamp = `${st.size}-${st.mtimeMs}`; } catch { stamp = null; }
  }
  const hit = stamp && localCatalogCache.get(sourceKey);
  if (hit && hit.stamp === stamp) return hit.entry;
  const body = Buffer.from(JSON.stringify(localCatalog(sourceKey)));
  const entry = { status: 200, type: 'application/json', body, etag: `"${crypto.createHash('sha256').update(body).digest('hex')}"` };
  if (stamp) localCatalogCache.set(sourceKey, { stamp, entry });
  return entry;
}

async function databaseCatalog(sourceKey) {
  if (LOCAL_CATALOG) return localCatalog(sourceKey);
  if (!SHIPCHECK_DATA_API_URL) {
    throw Object.assign(new Error('SHIPCHECK_DATA_API_URL must point to the database-backed Complee API.'), { status: 503 });
  }
  const entry = await catalogEntry(sourceKey);
  if (entry.status !== 200) throw Object.assign(new Error(`ShipCheck catalog ${sourceKey} returned ${entry.status}`), { status: entry.status });
  return JSON.parse(entry.body.toString('utf8'));
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
    catalog_source: LOCAL_CATALOG ? 'bundled' : 'database',
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
// shipcheck/.env may hold the same keys (not read under the test runner, so tests stay offline).
if (!process.env.NODE_TEST_CONTEXT && fs.existsSync(path.join(ROOT, '.env'))) {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(APS_CLIENT_ID|APS_CLIENT_SECRET)\s*=\s*(.*?)\s*$/);
    if (m && !aps[m[1]]) aps[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
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
// Revit -> IFC conversion through Autodesk (src/rvt-convert.mjs). The upload uses this server's APS keys, so it is
// open to this computer only unless CONVERT_ALLOW_REMOTE=true.
const CONVERT_DIR = path.resolve(ROOT, process.env.CONVERT_CACHE_DIR || '.cache/convert');
const rvtConverter = createRvtConverter({
  credentials: () => ({ id: aps.APS_CLIENT_ID, secret: aps.APS_CLIENT_SECRET }),
  cacheDir: CONVERT_DIR,
  base: process.env.APS_BASE_URL || undefined, // test override; Autodesk by default
});
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]); // Revit files are OLE compound files

async function receiveRvt(req, res, url) {
  if (process.env.CONVERT_ALLOW_REMOTE !== 'true' && !isLoopback(req)) return sendJSON(res, 403, { error: 'Revit conversion is only available on the computer that runs Complee.' });
  if (!rvtConverter.configured()) {
    req.resume();
    return sendJSON(res, 503, { error: 'Revit conversion needs Autodesk Platform Services keys (APS_CLIENT_ID and APS_CLIENT_SECRET in shipcheck/.env). Without them, export the model from Revit as IFC (File > Export > IFC) and open the .ifc file.' });
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_RVT_BYTES) { req.resume(); return sendJSON(res, 413, { error: 'The file is larger than 1 GB.' }); }
  const name = String(url.searchParams.get('name') || 'model.rvt').replace(/[^\w .()-]+/g, '_').slice(0, 120);
  fs.mkdirSync(path.join(CONVERT_DIR, 'uploads'), { recursive: true });
  const tmp = path.join(CONVERT_DIR, 'uploads', `${crypto.randomUUID()}.rvt`);
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let bytes = 0, head = Buffer.alloc(0);
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > MAX_RVT_BYTES) throw Object.assign(new Error('The file is larger than 1 GB.'), { status: 413 });
      if (head.length < 8) head = Buffer.concat([head, chunk.subarray(0, 8 - head.length)]);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (!bytes) throw Object.assign(new Error('The upload is empty.'), { status: 400 });
    if (!head.subarray(0, 8).equals(OLE_MAGIC)) throw Object.assign(new Error('This is not a Revit file (.rvt).'), { status: 400 });
  } catch (e) {
    out.destroy();
    await fs.promises.rm(tmp, { force: true });
    if (!req.complete) req.destroy();
    return sendJSON(res, e.status || 500, { error: e.status ? e.message : 'The upload failed.' });
  }
  return sendJSON(res, 202, rvtConverter.start(tmp, { name, sha: hash.digest('hex'), bytes }));
}

// AI assistance (explain a finding, escape-route suggestions) runs in the Python backend, which holds the model chain
// and the API keys. The viewer forwards the request; this server never sees a key. The AI costs money and uses the
// backend's keys, so it is open to this computer only unless AI_ALLOW_REMOTE=true.
const AI_API_URL = (process.env.AI_API_URL || process.env.SHIPCHECK_DATA_API_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
async function forwardAssist(req, res, name) {
  if (process.env.AI_ALLOW_REMOTE !== 'true' && !isLoopback(req)) return sendJSON(res, 403, { error: 'AI assistance is only available on the computer that runs Complee.' });
  let body;
  try {
    body = req.method === 'POST' ? JSON.stringify(await readBody(req, 400_000)) : undefined;
  } catch (e) {
    return sendJSON(res, 400, { error: e.message });
  }
  try {
    const upstream = await fetch(`${AI_API_URL}/api/v1/ai/assist/${name}`, {
      method: req.method, body, headers: body ? { 'Content-Type': 'application/json' } : {},
      signal: AbortSignal.timeout(180_000),
    });
    const text = await upstream.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* reported below */ }
    if (!upstream.ok) {
      const message = data?.error?.message || data?.detail || `The AI service answered ${upstream.status}.`;
      return sendJSON(res, upstream.status >= 500 ? 502 : upstream.status, { error: typeof message === 'string' ? message : 'The AI service failed.' });
    }
    return sendJSON(res, 200, data);
  } catch (e) {
    return sendJSON(res, 503, { error: e.name === 'TimeoutError'
      ? 'The AI service did not answer within 3 minutes.'
      : 'The AI service is not running. Start the backend (cd backend; .venv\\Scripts\\python -m uvicorn app.main:app --port 8000).' });
  }
}

// Streaming variant: the backend's server-sent events reach the browser piece by piece while the model writes.
async function forwardAssistStream(req, res, name) {
  if (process.env.AI_ALLOW_REMOTE !== 'true' && !isLoopback(req)) return sendJSON(res, 403, { error: 'AI assistance is only available on the computer that runs Complee.' });
  if (name === 'status' || req.method !== 'POST') return sendJSON(res, 405, { error: 'Method not allowed' });
  let body;
  try { body = JSON.stringify(await readBody(req, 400_000)); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
  const abort = new AbortController();
  res.on('close', () => abort.abort()); // the viewer went away: stop paying for the answer
  let upstream;
  try {
    upstream = await fetch(`${AI_API_URL}/api/v1/ai/assist/${name}/stream`, {
      method: 'POST', body, headers: { 'Content-Type': 'application/json' }, signal: abort.signal,
    });
  } catch {
    return sendJSON(res, 503, { error: 'The AI service is not running. Start the backend (cd backend; .venv\\Scripts\\python -m uvicorn app.main:app --port 8000).' });
  }
  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    let message = `The AI service answered ${upstream.status}.`;
    try { message = JSON.parse(text)?.error?.message || message; } catch { /* keep the status text */ }
    return sendJSON(res, upstream.status >= 500 ? 502 : upstream.status, { error: message });
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch { /* the viewer closed the page */ }
  res.end();
}

const isLoopback = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req?.socket?.remoteAddress);
const localOnly = (req) => { if (!isLoopback(req)) throw Object.assign(new Error('Only available on this computer'), { status: 403 }); };

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.csv': 'text/csv', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.dxf': 'application/dxf', '.gltf': 'model/gltf+json', '.wasm': 'application/wasm',
};
// URL prefix -> folder on disk. Anything else is 404.
const STATIC = [
  ['/src/', 'src'],
  ['/demo/', 'demo'],
  ['/node_modules/three/', 'node_modules/three'],
  ['/node_modules/three-mesh-bvh/', 'node_modules/three-mesh-bvh'],
  ['/node_modules/web-ifc/', 'node_modules/web-ifc'], // IFC import in the browser (wasm)
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

// Static files: content-addressed model tiles are immutable (cached for a year); everything else is revalidated with
// an ETag (weak, from size and mtime), so the browser keeps the JS modules, the 1.4 MB tile manifest and the CSS in
// its cache and the server answers 304 instead of sending them again. All file-system calls are asynchronous: a
// viewport streams hundreds of tiles and must not block the event loop for other clients.
async function serveStatic(p, res, req) {
  let file = null;
  for (const [prefix, dir] of STATIC) {
    if (!p.startsWith(prefix)) continue;
    const base = path.resolve(ROOT, dir);
    const candidate = path.normalize(path.join(base, p.slice(prefix.length) || 'index.html'));
    if (candidate.startsWith(base + path.sep) || candidate === base) file = candidate;
    break;
  }
  let stat = null;
  if (file) {
    try { stat = await fs.promises.stat(file); } catch { stat = null; }
  }
  if (!stat || !stat.isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  const ext = path.extname(file);
  const size = stat.size;
  const immutable = ext === '.glb';
  const etag = `W/"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'Accept-Ranges': 'bytes',
    ETag: etag,
  };
  const rangeHeader = String(req?.headers?.range || '');
  if (!rangeHeader && req?.headers?.['if-none-match'] && req.headers['if-none-match'].split(',').map((v) => v.trim()).includes(etag)) {
    res.writeHead(304, { 'Cache-Control': headers['Cache-Control'], ETag: etag });
    return res.end();
  }
  // HTTP Range (single range), e.g. for resuming large model chunks.
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
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

// Catalog documents (rules, scenarios, the parts list with ~70,000 records) come from the database API. Each dataset
// version is immutable and the API identifies it with an ETag, so the proxy keeps the last body per source and asks
// upstream only whether that version is still current (304: nothing is transferred again). The browser revalidates
// the same way (Cache-Control: no-cache + ETag), so a reload of the review costs one round trip per catalog instead
// of a full download. Concurrent requests for one source share a single upstream request.
const catalogCache = new Map(); // sourceKey -> { etag, body, type, status }
const catalogInflight = new Map();
function catalogEntry(sourceKey) {
  if (catalogInflight.has(sourceKey)) return catalogInflight.get(sourceKey);
  const job = (async () => {
    const cached = catalogCache.get(sourceKey);
    const target = new URL(`/api/v1/shipcheck/catalog/${sourceKey}`, SHIPCHECK_DATA_API_URL);
    const headers = cached?.etag ? { 'If-None-Match': cached.etag } : {};
    const upstream = await fetch(target, { headers, signal: AbortSignal.timeout(90_000) });
    if (upstream.status === 304 && cached) return cached;
    const body = Buffer.from(await upstream.arrayBuffer());
    const entry = {
      status: upstream.status,
      etag: upstream.ok ? upstream.headers.get('etag') : null,
      type: upstream.headers.get('content-type') || 'application/json',
      body,
    };
    if (upstream.ok && entry.etag) catalogCache.set(sourceKey, entry);
    return entry;
  })().finally(() => catalogInflight.delete(sourceKey));
  catalogInflight.set(sourceKey, job);
  return job;
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
  'GET /api/convert/status': (q, b, req) => ({ rvt: rvtConverter.configured(), allowed: process.env.CONVERT_ALLOW_REMOTE === 'true' || isLoopback(req), max_bytes: MAX_RVT_BYTES }),
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
    if (!LOCAL_CATALOG && !SHIPCHECK_DATA_API_URL) {
      return sendJSON(res, 503, { error: 'SHIPCHECK_DATA_API_URL must point to the database-backed Complee API.' });
    }
    let entry;
    if (LOCAL_CATALOG) {
      try { entry = localCatalogEntry(catalogMatch[1]); } catch (e) { return sendJSON(res, e.status || 500, { error: e.message }); }
    }
    try {
      entry ??= await catalogEntry(catalogMatch[1]);
      const headers = { 'Content-Type': entry.type, 'Cache-Control': entry.etag ? 'no-cache' : 'no-store' };
      if (entry.etag) headers.ETag = entry.etag;
      const wanted = String(req.headers['if-none-match'] || '').split(',').map((v) => v.trim()).filter(Boolean);
      if (entry.etag && entry.status === 200 && wanted.includes(entry.etag)) {
        res.writeHead(304, headers);
        return res.end();
      }
      res.writeHead(entry.status, { ...headers, 'Content-Length': entry.body.length });
      return res.end(entry.body);
    } catch {
      return sendJSON(res, 502, { error: 'Complee database API is temporarily unavailable.' });
    }
  }
  if (req.method === 'POST' && p === '/api/convert/rvt') return receiveRvt(req, res, url);
  const assistMatch = /^\/api\/assist\/(status|explain-finding|escape-suggestions|comment-reply)(\/stream)?$/.exec(p);
  if (assistMatch) return assistMatch[2] ? forwardAssistStream(req, res, assistMatch[1]) : forwardAssist(req, res, assistMatch[1]);
  const convertMatch = /^\/api\/convert\/jobs\/([0-9a-f-]{36})(\/ifc)?$/.exec(p);
  if (req.method === 'GET' && convertMatch) {
    const job = rvtConverter.job(convertMatch[1]);
    if (!job) return sendJSON(res, 404, { error: 'Unknown conversion.' });
    if (!convertMatch[2]) return sendJSON(res, 200, job);
    const file = rvtConverter.ifcFile(convertMatch[1]);
    if (!file || !fs.existsSync(file)) return sendJSON(res, 409, { error: 'The conversion is not finished.' });
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size, 'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${job.name.replace(/\.rvt$/i, '')}.ifc"` });
    return fs.createReadStream(file).pipe(res);
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
  return serveStatic(p === '/' ? '/evidence.html' : p, res, req);
}

export const server = http.createServer(handleRequest);

// Listen on PORT only when started directly (npm start / node server.mjs), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) server.once('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${PORT} is already in use: Complee (or another program) is already running there. Open http://localhost:${PORT}, or stop the other process, or start on another port: set PORT=8090 (PowerShell: $env:PORT=8090).`);
  process.exit(1);
}).listen(PORT, () => {
  console.log(`Open http://localhost:${PORT}`);
});
