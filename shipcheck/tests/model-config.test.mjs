import test from 'node:test';
import assert from 'node:assert/strict';

test('app model config: defaults to the existing local route and can point to an independent model host', async (t) => {
  const previous = process.env.MODEL_BASE_URL;
  const previousManifest = process.env.MODEL_MANIFEST;
  const { server, streamManifest } = await import('../server.mjs');
  process.env.MODEL_MANIFEST = 'stream-hp/manifest.json';
  const manifest = streamManifest();
  assert.equal(manifest, 'stream-hp/manifest.json');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    if (previous === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = previous;
    if (previousManifest === undefined) delete process.env.MODEL_MANIFEST;
    else process.env.MODEL_MANIFEST = previousManifest;
    server.closeIdleConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const endpoint = `http://127.0.0.1:${server.address().port}/api/model/config`;
  for (const value of [undefined, '', 'https://model.example.com/', 'https://model.example.com/rcrv/v1/']) {
    if (value === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = value;
    const response = await fetch(endpoint);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const config = await response.json();
    assert.deepEqual(config, {
      base_url: value || 'model/', manifest, legacy_manifest: 'manifest.json',
    });
    const base = new URL(config.base_url, 'https://app.example.com/inspection/');
    assert.equal(new URL(config.manifest, base).href, `${base.href}${manifest}`);
    assert.equal(new URL('props/1.json', base).href, `${base.href}props/1.json`);
  }
});

test('app model config: MODEL_MANIFEST overrides the audited viewport manifest', async () => {
  const { streamManifest } = await import('../server.mjs');
  const previous = process.env.MODEL_MANIFEST;
  process.env.MODEL_MANIFEST = 'stream/manifest.json';
  assert.equal(streamManifest('/nonexistent-model-dir'), 'stream/manifest.json', 'explicit override is preserved');
  if (previous === undefined) delete process.env.MODEL_MANIFEST;
  else process.env.MODEL_MANIFEST = previous;
});

test('app model config: refuses to silently select a manifest without an audit pass', async () => {
  const { streamManifest } = await import('../server.mjs');
  const previous = process.env.MODEL_MANIFEST;
  delete process.env.MODEL_MANIFEST;
  try {
    assert.throws(() => streamManifest('/nonexistent-model-dir'), { status: 503, message: /No audited high-precision viewport model/ });
  } finally {
    if (previous !== undefined) process.env.MODEL_MANIFEST = previous;
  }
});
