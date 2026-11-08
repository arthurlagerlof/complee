import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { signV4, isServableKey, s3ConfigFrom, createS3ModelSource } from '../src/model-source-s3.mjs';

test('S3 source: Signature V4 matches the AWS documentation example (GET object with Range)', () => {
  const headers = signV4({
    host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', headers: { Range: 'bytes=0-9' },
    accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', amzDate: '20130524T000000Z',
  });
  assert.equal(headers.authorization,
    'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, '
    + 'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(headers.host, undefined, 'host comes from the URL');
});

test('S3 source: only files the viewer needs are servable', () => {
  for (const key of ['manifest.json', 'stream-hp/manifest.json', 'stream-hp/audit.json', 'props/12.json', 'context.glb',
    'stream-hp/access--1_-1_-1-0-b036aaf845ff.glb', 'stream/overview-context--1_-1_1-0--1_-1_1-0-b1190a7bdaab.glb']) {
    assert.ok(isServableKey(key), key);
  }
  for (const key of ['old_model/12100-RCRV-199_07-08-2021.nwd', 'browser-check.json', 'full-overview.png', '.env',
    '../.env', 'stream-hp/../.env', 'props/3056(1).json', 'stream-hp-prev/access--1_-1_-1-0-b036aaf845ff.glb',
    'stream/rest-01--3_-3_0-7-18711bd16a7b.glb', 'stream/manifest.json', 'stream-hp/%2e%2e/.env', 'stream-hp\\..\\.env', '', null]) {
    assert.ok(!isServableKey(key), String(key));
  }
});

test('S3 source: selected only by MODEL_SOURCE=vultr; settings from the environment or a .env file', () => {
  assert.equal(s3ConfigFrom({}), null);
  assert.equal(s3ConfigFrom({ MODEL_SOURCE: 'local', VULTR_S3_BUCKET: 'b' }), null);
  assert.throws(() => s3ConfigFrom({ MODEL_SOURCE: 'vultr', VULTR_S3_BUCKET: 'b' }), /VULTR_S3_ENDPOINT, VULTR_S3_ACCESS_KEY, VULTR_S3_SECRET_KEY/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipcheck-s3-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'MODEL_SOURCE=vultr\nVULTR_S3_ENDPOINT=https://ams1.example.com\nVULTR_S3_BUCKET="models"\nVULTR_S3_ACCESS_KEY=ak\nVULTR_S3_SECRET_KEY=sk\nOTHER_SECRET=x\n');
  const cfg = s3ConfigFrom({ VULTR_S3_BUCKET: 'from-env' }, file);
  assert.deepEqual(cfg, { endpoint: 'https://ams1.example.com', bucket: 'from-env', accessKey: 'ak', secretKey: 'sk', region: 'us-east-1', prefix: '' });
  assert.throws(() => s3ConfigFrom({ MODEL_SOURCE: 'vultr', VULTR_S3_ENDPOINT: 'https://ams1.example.com', VULTR_S3_BUCKET: 'b', VULTR_S3_ACCESS_KEY: 'ak', VULTR_S3_SECRET_KEY: 'sk', VULTR_S3_PREFIX: 'safe/../outside' }), /safe object-key prefix/);
  assert.throws(() => createS3ModelSource({ endpoint: 'http://ams1.example.com', bucket: 'b', accessKey: 'ak', secretKey: 'sk', region: 'us-east-1', prefix: '' }), /HTTPS origin/);
  assert.equal(process.env.VULTR_S3_SECRET_KEY === 'sk', false, 'not copied into process.env');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('S3 source: signed requests, disk cache for content-addressed tiles, remote manifest, errors mapped', async (t) => {
  const tile = 'stream-hp/context--1_-1_-1-0-8bd5c979f0d7.glb';
  const overview = 'stream/overview-context--1_-1_1-0--1_-1_1-0-b1190a7bdaab.glb';
  const objects = {
    [`models/${tile}`]: Buffer.from('tile-bytes'),
    [`models/${overview}`]: Buffer.from('overview-bytes'),
    'models/stream-hp/audit.json': Buffer.from('{"pass":true}'),
    'models/stream-hp/manifest.json': Buffer.from(JSON.stringify({ kind: 'viewport-tiles', streaming: { max_requests: 2 }, chunks: [], overview: { chunks: [{ file: '../stream/overview-context--1_-1_1-0--1_-1_1-0-b1190a7bdaab.glb' }] } })),
  };
  const calls = [];
  const fetchImpl = async (url, { headers }) => {
    const key = decodeURIComponent(new URL(url).pathname).replace(/^\/bucket-1\//, '');
    calls.push(key);
    assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=ak\/20261107\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    return objects[key] ? new Response(objects[key]) : new Response('no', { status: 404 });
  };
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipcheck-s3-cache-'));
  const source = createS3ModelSource({ endpoint: 'https://ams1.example.com', bucket: 'bucket-1', accessKey: 'ak', secretKey: 'sk', region: 'us-east-1', prefix: 'models' },
    { cacheDir, fetchImpl, now: () => new Date('2026-11-07T21:00:00Z') });
  const server = http.createServer((req, res) => source.serve(decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1)), req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); fs.rmSync(cacheDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/`;

  assert.equal(await source.streamManifest(), 'stream-hp/manifest.json', 'audit passed in the bucket');
  const manifest = await (await fetch(base + 'stream-hp/manifest.json')).json();
  assert.equal(manifest.streaming.max_requests, 6, 'more parallel requests for remote storage');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(fs.existsSync(path.join(cacheDir, 'stream', path.basename(overview))), 'overview tiles pre-fetched into the cache');

  for (let i = 0; i < 2; i++) {
    const res = await fetch(base + tile);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'tile-bytes');
  }
  assert.equal(calls.filter((k) => k.endsWith(tile)).length, 1, 'second request served from the disk cache');
  assert.equal(source.stats.cacheHits, 1);

  assert.equal((await fetch(base + 'stream-hp/missing-0123456789ab.glb')).status, 404);
  const before = calls.length;
  assert.equal((await fetch(base + 'old_model/x.nwd')).status, 404);
  assert.equal(calls.length, before, 'blocked keys never reach the bucket');
});

test('S3 source: refuses an unaudited bucket instead of selecting the legacy viewport manifest', async () => {
  const source = createS3ModelSource({
    endpoint: 'https://ams1.example.com', bucket: 'bucket-1', accessKey: 'ak', secretKey: 'sk',
    region: 'us-east-1', prefix: '',
  }, { fetchImpl: async () => new Response('missing', { status: 404 }) });
  await assert.rejects(source.streamManifest(), { status: 503, message: /no passing stream-hp audit/ });
});
