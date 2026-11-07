// Independent, read-only GLB/JSON host. No APS configuration or app imports.
// Run: MODEL_DIR=/path/to/model MODEL_PORT=8081 node model-server.mjs
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { parseAllowedOrigins, corsHeaders } from './src/cors.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const MIME = { '.glb': 'model/gltf-binary', '.json': 'application/json; charset=utf-8' };
const INVALID_RANGE = Symbol('invalid-range');

function safeRelative(name) {
  if (!name || /[\\\x00-\x1f\x7f:#]/.test(name)) return false;
  return name.split('/').every((part) => part && !part.startsWith('.'));
}

function requestPath(target = '') {
  // Validate before URL normalization can erase literal or encoded dot segments.
  if (!target.startsWith('/') || target.startsWith('//')) return null;
  try {
    const name = decodeURIComponent(target.split('?')[0].slice(1));
    return safeRelative(name) ? name : null;
  } catch { return null; }
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

async function openModelFile(root, name) {
  if (!safeRelative(name) || !MIME[path.extname(name).toLowerCase()]) return null;
  let file;
  try {
    const realRoot = await fs.realpath(root);
    const resolved = await fs.realpath(path.join(realRoot, ...name.split('/')));
    if (!within(realRoot, resolved)) return null;
    // A public alias must not expose a hidden target or an otherwise forbidden extension.
    const realRelative = path.relative(realRoot, resolved).split(path.sep).join('/');
    if (!safeRelative(realRelative) || !MIME[path.extname(resolved).toLowerCase()]) return null;
    file = await fs.open(resolved, 'r');
    const stat = await file.stat();
    if (!stat.isFile()) { await file.close(); return null; }
    return { file, stat, type: MIME[path.extname(resolved).toLowerCase()] };
  } catch (error) {
    await file?.close().catch(() => {});
    if (['ENOENT', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'ELOOP', 'EINVAL'].includes(error.code)) return null;
    throw error;
  }
}

function byteRange(value, size) {
  if (value === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || !size) return INVALID_RANGE;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if ([first, last].some((n) => n !== null && !Number.isSafeInteger(n))) return INVALID_RANGE;
  if (first === null) return last > 0 ? { start: Math.max(0, size - last), end: size - 1 } : INVALID_RANGE;
  if (first >= size || (last !== null && last < first)) return INVALID_RANGE;
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) };
}

function json(req, res, status, value, headers = {}) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store', 'Content-Length': body.length, ...headers });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function readManifest(root, name) {
  const opened = await openModelFile(root, name);
  if (!opened) return null;
  try { return JSON.parse(await opened.file.readFile('utf8')); }
  catch { return null; }
  finally { await opened.file.close(); }
}

async function health(root) {
  const [legacy, stream] = await Promise.all([
    readManifest(root, 'manifest.json'), readManifest(root, 'stream/manifest.json'),
  ]);
  const legacyChunks = Array.isArray(legacy?.chunks) ? legacy.chunks.length : 0;
  const tiles = Array.isArray(stream?.chunks) ? stream.chunks.length : Array.isArray(stream?.tiles) ? stream.tiles.length : 0;
  return {
    status: 'ok', version: VERSION, model_manifest: !!(legacy || stream),
    stream_manifest: !!stream, legacy_chunks: legacyChunks, streaming_tiles: tiles,
    chunks: legacyChunks + tiles,
  };
}

/** Options are injectable so tests use temporary fixtures, never the actual model or credentials. */
export function createModelServer({
  modelDir = process.env.MODEL_DIR || path.join(ROOT, 'model'),
  allowedOrigins = parseAllowedOrigins(process.env.ALLOWED_ORIGINS),
} = {}) {
  const root = path.resolve(modelDir);
  const allowed = Array.isArray(allowedOrigins) ? allowedOrigins : parseAllowedOrigins(allowedOrigins);
  return http.createServer(async (req, res) => {
    // Vary even when the request has no allowed Origin, to avoid cross-origin cache reuse.
    res.setHeader('Vary', 'Origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const cors = corsHeaders(req.headers.origin, allowed);
    if (cors) {
      for (const [key, value] of Object.entries(cors)) res.setHeader(key, value);
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    }
    try {
      const name = requestPath(req.url);
      if (!name) return json(req, res, 404, { error: 'Not found' });
      if (req.method === 'OPTIONS') {
        if (req.headers.origin && !cors) return json(req, res, 403, { error: 'Origin not allowed' });
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (!['GET', 'HEAD'].includes(req.method)) {
        return json(req, res, 405, { error: 'Method not allowed' }, { Allow: 'GET, HEAD, OPTIONS' });
      }
      if (name === 'api/health') return json(req, res, 200, await health(root));
      const opened = await openModelFile(root, name);
      if (!opened) return json(req, res, 404, { error: 'Not found' });
      let { file } = opened;
      try {
        const size = opened.stat.size;
        // If-Range cannot be validated without an entity validator: send the complete file.
        const range = req.headers['if-range'] ? null : byteRange(req.headers.range, size);
        const headers = {
          'Content-Type': opened.type, 'Accept-Ranges': 'bytes',
          'Cache-Control': opened.type === MIME['.glb'] ? 'public, max-age=31536000, immutable' : 'no-store',
        };
        if (range === INVALID_RANGE) {
          res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}`, 'Content-Length': 0 });
          return res.end();
        }
        res.writeHead(range ? 206 : 200, {
          ...headers, 'Content-Length': range ? range.end - range.start + 1 : size,
          ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${size}` } : {}),
        });
        if (req.method === 'HEAD') return res.end();
        const stream = file.createReadStream(range || {});
        file = null; // The stream owns and closes the file descriptor, including on disconnect.
        await pipeline(stream, res);
      } finally { await file?.close(); }
    } catch {
      // Do not return or log filesystem paths, request origins or configuration values.
      if (!res.headersSent) return json(req, res, 500, { error: 'Model request failed' });
      res.destroy();
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.MODEL_PORT || 8081);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('Invalid model server port');
    process.exitCode = 1;
  } else {
    const server = createModelServer();
    server.on('error', () => { console.error('Model server failed to start'); process.exitCode = 1; });
    server.listen(port, () => console.log('Model server ready'));
  }
}
