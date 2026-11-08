// CORS (ALLOWED_ORIGINS), preflight, health endpoint and model-file serving (MIME, cache, Range).
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedOrigin, parseAllowedOrigins, corsHeaders } from '../src/cors.mjs';

test('CORS rules: default localhost only; configured exact origins; wildcard is rejected', () => {
  assert.ok(isAllowedOrigin('http://localhost:5173', []));
  assert.ok(isAllowedOrigin('http://127.0.0.1:8080', []));
  assert.ok(!isAllowedOrigin('https://evil.example', []));
  const list = parseAllowedOrigins('https://complee.example.com, https://team.example/');
  assert.deepEqual(list, ['https://complee.example.com', 'https://team.example']);
  assert.ok(isAllowedOrigin('https://complee.example.com', list));
  assert.ok(!isAllowedOrigin('http://localhost:5173', list), 'an explicit list replaces the localhost default');
  assert.throws(() => parseAllowedOrigins('*'), /exact website origins/);
  assert.throws(() => parseAllowedOrigins('https://example.com/path'), /exact HTTP\(S\) origins/);
  assert.equal(corsHeaders('https://evil.example', list), null);
});

test('server: CORS headers for an allowed and a disallowed origin, preflight, health, model files', async (t) => {
  process.env.ALLOWED_ORIGINS = 'https://complee.example.com';
  const log = console.log;
  console.log = () => {};
  const { server } = await import('../server.mjs');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log = log;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const ok = await fetch(`${base}/api/health`, { headers: { Origin: 'https://complee.example.com' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://complee.example.com');
  assert.match(ok.headers.get('vary') || '', /Origin/);
  const h = await ok.json();
  assert.equal(h.status, 'ok');
  assert.equal(typeof h.version, 'string');
  assert.equal(h.catalog_source, 'database');
  assert.equal(typeof h.model_available, 'boolean');
  assert.equal('model_requests' in h, false, 'health does not expose internal S3 request diagnostics');
  assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');

  const bad = await fetch(`${base}/api/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(bad.status, 200, 'the request itself is answered; the browser blocks it without CORS headers');
  assert.equal(bad.headers.get('access-control-allow-origin'), null);

  const pre = await fetch(`${base}/api/check`, { method: 'OPTIONS', headers: { Origin: 'https://complee.example.com', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(pre.status, 204);
  assert.match(pre.headers.get('access-control-allow-methods'), /GET/);
  const preBad = await fetch(`${base}/api/check`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preBad.status, 403);
  assert.equal(preBad.headers.get('access-control-allow-origin'), null);

  // Model files: served with the glTF MIME type, long cache and Range support when a model is deployed.
  if (h.model_available) {
    const m = await (await fetch(`${base}/model/manifest.json`)).json();
    const file = `${base}/model/${m.chunks[0].file}`;
    const full = await fetch(file, { method: 'HEAD' });
    assert.equal(full.headers.get('content-type'), 'model/gltf-binary');
    assert.match(full.headers.get('cache-control'), /max-age=31536000/);
    const part = await fetch(file, { headers: { Range: 'bytes=0-99' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 100);
  }
});
