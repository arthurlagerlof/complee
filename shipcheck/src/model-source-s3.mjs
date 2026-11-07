// 3D model tiles from S3-compatible object storage (Vultr Object Storage) instead of the local model/ folder.
// The bucket is private: the ShipCheck server signs each GET (AWS Signature V4, node:crypto only) and serves
// the file under the same /model/... paths the viewer already uses, so no client code changes and no bucket
// policy or CORS change is needed. Only files the viewer needs are reachable (allow-list below); the source
// model (.nwd), screenshots and check reports in the bucket are never served.
// Content-addressed tiles (name ends in -<12 hex>.glb) never change under the same name: they are kept in a
// disk cache, so each tile crosses the network once per server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 3986 encoding per path segment, as S3 expects in the canonical URI.
const encodeSegment = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

// AWS Signature V4 for a request without a body. Returns the headers to send (including Authorization).
export function signV4({ method = 'GET', host, path: uriPath, headers = {}, accessKey, secretKey, region, service = 's3', amzDate, payloadHash = sha256('') }) {
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${all[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [method, uriPath, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const out = { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  delete out.host; // set by fetch from the URL
  return out;
}

// Files the viewer loads: the tile manifest and tiles, the per-part property shards, the main chunk GLBs and
// their manifest (legacy viewer). Everything else in the bucket is not served.
const ALLOWED = [
  /^manifest\.json$/,
  /^stream-hp\/(manifest|audit)\.json$/,
  /^stream-hp\/[a-z0-9_-]+-[0-9a-f]{12}\.glb$/,
  // The high-precision manifest reuses the coarse overview tiles of the original set (../stream/overview-*).
  /^stream\/overview-[a-z0-9_-]+-[0-9a-f]{12}\.glb$/,
  /^props\/\d{1,6}\.json$/,
  /^[a-z0-9-]{1,40}\.glb$/,
];
export const isServableKey = (key) => typeof key === 'string' && !key.includes('..') && ALLOWED.some((r) => r.test(key));
const isImmutable = (key) => /-[0-9a-f]{12}\.glb$/.test(key);

// Reads MODEL_SOURCE and VULTR_S3_* from the environment, falling back to a local .env file (kept in a private
// object, not process.env; never logged or served). Returns null when the S3 source is not selected.
export function s3ConfigFrom(env = process.env, envFile = null) {
  const file = {};
  if (envFile && fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(MODEL_SOURCE|VULTR_S3_[A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m) file[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  const get = (k) => env[k] ?? file[k];
  if (String(get('MODEL_SOURCE') || '').toLowerCase() !== 'vultr') return null;
  const cfg = {
    endpoint: get('VULTR_S3_ENDPOINT'), bucket: get('VULTR_S3_BUCKET'),
    accessKey: get('VULTR_S3_ACCESS_KEY'), secretKey: get('VULTR_S3_SECRET_KEY'),
    // Vultr accepts any signing region; "us-east-1" is the S3 default when none is configured.
    region: get('VULTR_S3_REGION') || 'us-east-1', prefix: (get('VULTR_S3_PREFIX') || '').replace(/^\/+|\/+$/g, ''),
  };
  const missing = ['endpoint', 'bucket', 'accessKey', 'secretKey'].filter((k) => !cfg[k]);
  if (missing.length) throw new Error(`MODEL_SOURCE=vultr needs VULTR_S3_${missing.map((k) => k.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()).join(', VULTR_S3_')}`);
  return cfg;
}

export function createS3ModelSource(cfg, { cacheDir, fetchImpl = fetch, now = () => new Date() } = {}) {
  const base = new URL(cfg.endpoint);
  const inflight = new Map();
  const stats = { requests: 0, cacheHits: 0, bytesFromBucket: 0, errors: 0 };

  function request(key, headers = {}) {
    const objectKey = cfg.prefix ? `${cfg.prefix}/${key}` : key;
    const uriPath = `/${encodeSegment(cfg.bucket)}/${objectKey.split('/').map(encodeSegment).join('/')}`;
    const amzDate = now().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const signed = signV4({ host: base.host, path: uriPath, headers, accessKey: cfg.accessKey, secretKey: cfg.secretKey, region: cfg.region, amzDate });
    stats.requests++;
    return fetchImpl(new URL(uriPath, base), { headers: signed, signal: AbortSignal.timeout(60_000) });
  }

  // Whole object as a Buffer (used for cached tiles and small JSON). Concurrent requests for one key share a download.
  function getBuffer(key) {
    if (inflight.has(key)) return inflight.get(key);
    const job = (async () => {
      const cached = cacheDir && isImmutable(key) ? path.join(cacheDir, ...key.split('/')) : null;
      if (cached && fs.existsSync(cached)) { stats.cacheHits++; return fs.readFileSync(cached); }
      const res = await request(key);
      if (!res.ok) throw Object.assign(new Error(`Model file ${key}: bucket returned ${res.status}`), { status: res.status === 404 || res.status === 403 ? 404 : 502 });
      const buf = Buffer.from(await res.arrayBuffer());
      stats.bytesFromBucket += buf.length;
      if (cached) {
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        const tmp = `${cached}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, cached);
      }
      return buf;
    })().finally(() => inflight.delete(key));
    inflight.set(key, job);
    return job;
  }

  // Fetches keys into the disk cache with bounded parallelism (errors are left for the on-demand request to report).
  async function warm(keys, concurrency = 16) {
    const queue = keys.filter((k) => isServableKey(k) && isImmutable(k));
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) await getBuffer(queue.shift()).catch(() => {});
    }));
  }

  // A viewport tile manifest, adjusted for remote storage: the viewer may request up to 6 tiles at once (the local
  // default of 2 assumes a disk next to the server; each bucket round trip costs ~70-200 ms), and the coarse
  // overview tiles every first view needs are pre-fetched in parallel. Detail tiles stay on demand.
  const warmed = new Set();
  function remoteManifest(key, buf) {
    let manifest;
    try { manifest = JSON.parse(buf.toString('utf8')); } catch { return buf; }
    if (manifest?.kind !== 'viewport-tiles' || !manifest.streaming) return buf;
    manifest.streaming.max_requests = Math.max(manifest.streaming.max_requests || 2, 6);
    if (!warmed.has(key)) {
      warmed.add(key);
      const dir = new URL('.', `https://bucket/${key}`);
      warm((manifest.overview?.chunks || []).map((c) => new URL(c.file, dir).pathname.slice(1)));
    }
    return Buffer.from(JSON.stringify(manifest));
  }

  let manifestChoice = null;
  return {
    warm,
    id: 'vultr',
    stats,
    // Same rule as the local folder: the high-precision tiles only once their source audit has passed.
    async streamManifest() {
      if (manifestChoice && manifestChoice.until > Date.now()) return manifestChoice.value;
      let value = 'stream/manifest.json';
      try {
        const audit = JSON.parse((await getBuffer('stream-hp/audit.json')).toString('utf8'));
        if (audit.pass === true) value = 'stream-hp/manifest.json';
      } catch { /* no audit in the bucket */ }
      manifestChoice = { value, until: Date.now() + 5 * 60_000 };
      return value;
    },
    async serve(key, req, res) {
      if (!isServableKey(key)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found');
      }
      const type = key.endsWith('.json') ? 'application/json' : 'model/gltf-binary';
      try {
        if (isImmutable(key) || key.endsWith('.json')) {
          let buf = await getBuffer(key);
          if (key.endsWith('/manifest.json')) buf = remoteManifest(key, buf);
          res.writeHead(200, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': isImmutable(key) ? 'public, max-age=31536000, immutable' : 'no-store' });
          return res.end(req.method === 'HEAD' ? undefined : buf);
        }
        // Large main chunks (up to ~55 MB): streamed through, not buffered.
        const upstream = await request(key);
        if (!upstream.ok) throw Object.assign(new Error(`Model file ${key}: bucket returned ${upstream.status}`), { status: upstream.status === 404 || upstream.status === 403 ? 404 : 502 });
        const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache' };
        if (upstream.headers.get('content-length')) headers['Content-Length'] = upstream.headers.get('content-length');
        res.writeHead(200, headers);
        if (req.method === 'HEAD') return res.end();
        Readable.fromWeb(upstream.body).on('data', (c) => { stats.bytesFromBucket += c.length; }).pipe(res);
      } catch (e) {
        stats.errors++;
        if (res.headersSent) return res.destroy(e);
        res.writeHead(e.status || 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: e.status === 404 ? 'Not found' : 'Model storage unavailable' }));
      }
    },
  };
}
