import test from 'node:test';
import assert from 'node:assert/strict';

test('app model config: defaults to the existing local route and can point to an independent model host', async (t) => {
  const previous = process.env.MODEL_BASE_URL;
  const { server } = await import('../server.mjs');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => {
    if (previous === undefined) delete process.env.MODEL_BASE_URL;
    else process.env.MODEL_BASE_URL = previous;
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
      base_url: value || 'model/', manifest: 'stream/manifest.json', legacy_manifest: 'manifest.json',
    });
    const base = new URL(config.base_url, 'https://app.example.com/inspection/');
    assert.equal(new URL(config.manifest, base).href, `${base.href}stream/manifest.json`);
    assert.equal(new URL('props/1.json', base).href, `${base.href}props/1.json`);
  }
});
