import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createModelServer } from '../model-server.mjs';

const DATA = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

async function fixture(t, allowedOrigins = []) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'shipcheck-model-server-'));
  const model = path.join(temp, 'model');
  await fs.mkdir(path.join(model, 'stream'), { recursive: true });
  await fs.mkdir(path.join(model, 'props'));
  await fs.mkdir(path.join(model, '.hidden'));
  await fs.mkdir(path.join(model, 'stream/not-a-file.glb'));
  await fs.mkdir(path.join(temp, 'outside'));
  await Promise.all([
    fs.writeFile(path.join(model, 'manifest.json'), JSON.stringify({ chunks: [{ file: 'context.glb' }] })),
    fs.writeFile(path.join(model, 'context.glb'), DATA),
    fs.writeFile(path.join(model, 'stream/manifest.json'), JSON.stringify({ kind: 'viewport-tiles', chunks: [{ file: 'stream/tile-01.glb' }, { file: 'stream/tile-02.glb' }] })),
    fs.writeFile(path.join(model, 'stream/tile-01.glb'), DATA),
    fs.writeFile(path.join(model, 'stream/tile-02.glb'), DATA),
    fs.writeFile(path.join(model, 'stream/empty.glb'), ''),
    fs.writeFile(path.join(model, 'props/1.json'), JSON.stringify({ parts: [{ objectid: 1001, name: 'Fixture part' }] })),
    fs.writeFile(path.join(model, '.private.json'), '{"private":true}'),
    fs.writeFile(path.join(model, '.hidden/data.json'), '{"private":true}'),
    fs.writeFile(path.join(model, 'private.txt'), 'not a model file'),
    fs.writeFile(path.join(temp, 'outside/data.json'), '{"outside":true}'),
  ]);
  const server = createModelServer({ modelDir: model, allowedOrigins });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    server.closeIdleConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(temp, { recursive: true, force: true });
  });
  // Raw HTTP paths avoid fetch's automatic removal of dot segments in security tests.
  const request = (url, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
  return { model, temp, request };
}

test('model server: a separate app origin gets CORS, a disallowed origin does not; preflight is read-only', async (t) => {
  const { request } = await fixture(t, ['https://app.example.com']);
  const ok = await request('/stream/tile-01.glb', { headers: { Origin: 'https://app.example.com' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, DATA);
  assert.equal(ok.headers['access-control-allow-origin'], 'https://app.example.com');
  assert.equal(ok.headers.vary, 'Origin');
  assert.match(ok.headers['access-control-expose-headers'], /Content-Range/);
  const bad = await request('/stream/tile-01.glb', { headers: { Origin: 'https://other.example.com' } });
  assert.equal(bad.status, 200, 'CORS is browser policy; public model requests remain readable without Origin');
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
  assert.equal(bad.headers.vary, 'Origin');
  const pre = await request('/stream/tile-01.glb', { method: 'OPTIONS', headers: {
    Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'Range',
  } });
  assert.equal(pre.status, 204);
  assert.equal(pre.body.length, 0);
  assert.equal(pre.headers['access-control-allow-methods'], 'GET, HEAD, OPTIONS');
  assert.match(pre.headers['access-control-allow-headers'], /Range/);
  const denied = await request('/stream/tile-01.glb', { method: 'OPTIONS', headers: { Origin: 'https://other.example.com' } });
  assert.equal(denied.status, 403);
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
});

test('model server: default CORS allows localhost on a different port only', async (t) => {
  const { request } = await fixture(t);
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:8080', 'http://[::1]:5173']) {
    const response = await request('/stream/manifest.json', { headers: { Origin: origin } });
    assert.equal(response.headers['access-control-allow-origin'], origin);
  }
  const denied = await request('/stream/manifest.json', { headers: { Origin: 'https://app.example.com' } });
  assert.equal(denied.headers['access-control-allow-origin'], undefined);
  const noOrigin = await request('/stream/manifest.json');
  assert.equal(noOrigin.headers['access-control-allow-origin'], undefined);
  assert.equal(noOrigin.status, 200);
});

test('model server: GLB GET/HEAD, single byte ranges, cache and fresh JSON', async (t) => {
  const { request } = await fixture(t);
  const head = await request('/stream/tile-01.glb', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-type'], 'model/gltf-binary');
  assert.equal(head.headers['content-length'], '256');
  assert.equal(head.headers['accept-ranges'], 'bytes');
  assert.equal(head.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(head.headers['x-content-type-options'], 'nosniff');
  for (const [range, start, end] of [['bytes=10-19', 10, 19], ['bytes=250-', 250, 255], ['bytes=-8', 248, 255], ['bytes=250-999', 250, 255], ['bytes=-999', 0, 255]]) {
    const part = await request('/stream/tile-01.glb', { headers: { Range: range } });
    assert.equal(part.status, 206);
    assert.equal(part.headers['content-range'], `bytes ${start}-${end}/256`);
    assert.equal(Number(part.headers['content-length']), end - start + 1);
    assert.deepEqual(part.body, DATA.subarray(start, end + 1));
  }
  const partialHead = await request('/stream/tile-01.glb', { method: 'HEAD', headers: { Range: 'bytes=10-19' } });
  assert.equal(partialHead.status, 206);
  assert.equal(partialHead.headers['content-length'], '10');
  assert.equal(partialHead.body.length, 0);
  for (const range of ['bytes=256-', 'bytes=20-10', 'bytes=-0', 'bytes=-', 'bytes=0-1,3-4', 'bytes=9007199254740992-']) {
    const invalid = await request('/stream/tile-01.glb', { headers: { Range: range } });
    assert.equal(invalid.status, 416, range);
    assert.equal(invalid.headers['content-range'], 'bytes */256');
    assert.equal(invalid.body.length, 0);
  }
  const staleRange = await request('/stream/tile-01.glb', { headers: { Range: 'bytes=10-19', 'If-Range': 'unvalidated' } });
  assert.equal(staleRange.status, 200);
  assert.deepEqual(staleRange.body, DATA);
  const empty = await request('/stream/empty.glb', { headers: { Range: 'bytes=0-' } });
  assert.equal(empty.status, 416);
  const props = await request('/props/1.json?version=fixture');
  assert.equal(props.status, 200);
  assert.match(props.headers['content-type'], /^application\/json/);
  assert.equal(props.headers['cache-control'], 'no-store');
  assert.equal(JSON.parse(props.body).parts[0].objectid, 1001);
});

test('model server: rejects traversal, hidden files, non-model files, directories and write requests', async (t) => {
  const { request } = await fixture(t);
  for (const url of [
    '/../outside/data.json', '/%2e%2e/outside/data.json', '/stream/../../outside/data.json',
    '/stream/%2E%2E/manifest.json', '/stream/..%5coutside/data.json', '//outside/data.json',
    '/.private.json', '/%2eprivate.json', '/.hidden/data.json', '/stream/../.private.json',
    '/private.txt', '/model-server.mjs', '/props', '/', '/stream/not-a-file.glb', '/stream/tile-01.glb%00.json',
    '/C:/private.json', '/stream/tile-01.glb:private.json', '/bad%ZZ.json', '/missing.json',
  ]) {
    const response = await request(url);
    assert.equal(response.status, 404, url);
    assert.deepEqual(JSON.parse(response.body), { error: 'Not found' });
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await request('/stream/tile-01.glb', { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.allow, 'GET, HEAD, OPTIONS');
  }
});

test('model server: a symlink or junction cannot escape MODEL_DIR or alias a hidden directory', async (t) => {
  const { request, temp, model } = await fixture(t);
  const type = process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await fs.symlink(path.join(temp, 'outside'), path.join(model, 'outside-link'), type);
    await fs.symlink(path.join(model, '.hidden'), path.join(model, 'hidden-link'), type);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('This system does not permit test links');
    throw error;
  }
  for (const name of ['outside-link', 'hidden-link']) {
    const response = await request(`/${name}/data.json`);
    assert.equal(response.status, 404);
    assert.deepEqual(JSON.parse(response.body), { error: 'Not found' });
  }
});

test('model server: health includes streaming tile counts and works without legacy model files', async (t) => {
  const { request, model } = await fixture(t);
  let response = await request('/api/health');
  assert.equal(response.status, 200);
  let result = JSON.parse(response.body);
  assert.equal(result.status, 'ok');
  assert.equal(typeof result.version, 'string');
  assert.equal(result.model_manifest, true);
  assert.equal(result.stream_manifest, true);
  assert.equal(result.legacy_chunks, 1);
  assert.equal(result.streaming_tiles, 2);
  assert.equal(result.chunks, 3);
  assert.equal(response.headers['cache-control'], 'no-store');
  const head = await request('/api/health', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  await fs.unlink(path.join(model, 'manifest.json'));
  result = JSON.parse((await request('/api/health')).body);
  assert.equal(result.legacy_chunks, 0);
  assert.equal(result.streaming_tiles, 2);
  assert.equal(result.chunks, 2);
  await fs.writeFile(path.join(model, 'stream/manifest.json'), JSON.stringify({ tiles: [{ file: 'stream/tile-01.glb' }] }));
  result = JSON.parse((await request('/api/health')).body);
  assert.equal(result.streaming_tiles, 1, 'also accepts a manifest using tiles[]');
  await fs.unlink(path.join(model, 'stream/manifest.json'));
  result = JSON.parse((await request('/api/health')).body);
  assert.equal(result.model_manifest, false);
  assert.equal(result.streaming_tiles, 0);
  assert.equal(result.chunks, 0);
  assert.ok(!JSON.stringify(result).includes(model), 'health does not disclose the configured directory');
});
