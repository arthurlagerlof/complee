// Bundled catalog (no database API configured): responses carry a content ETag and are revalidated with 304, and
// static modules are revalidated the same way, so a reload of the review does not download them again.
import test from 'node:test';
import assert from 'node:assert/strict';

test('bundled catalog and static files are revalidated with ETags', async (t) => {
  delete process.env.SHIPCHECK_DATA_API_URL;
  const { server } = await import('../server.mjs');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeIdleConnections(); await new Promise((r) => server.close(r)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await (await fetch(`${base}/api/health`)).json();
  if (health.catalog_source !== 'bundled') return t.skip('bundled catalog not present');
  const first = await fetch(`${base}/api/catalog/rules`);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{64}"$/);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const rules = await first.json();
  assert.ok(rules.rules.length > 0);
  const again = await fetch(`${base}/api/catalog/rules`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  assert.equal((await again.arrayBuffer()).byteLength, 0);
  const stale = await fetch(`${base}/api/catalog/rules`, { headers: { 'If-None-Match': '"0000"' } });
  assert.equal(stale.status, 200);
  assert.deepEqual(await stale.json(), rules);
  const scenarios = await fetch(`${base}/api/catalog/scenarios`);
  assert.equal(scenarios.status, 200);
  assert.ok(scenarios.headers.get('etag'));
  assert.equal((await fetch(`${base}/api/catalog/not-a-source`)).status, 404);

  const mod = await fetch(`${base}/src/checker.mjs`);
  assert.equal(mod.status, 200);
  assert.equal(mod.headers.get('cache-control'), 'no-cache');
  const modAgain = await fetch(`${base}/src/checker.mjs`, { headers: { 'If-None-Match': mod.headers.get('etag') } });
  assert.equal(modAgain.status, 304);
  assert.equal((await fetch(`${base}/src/does-not-exist.mjs`)).status, 404);
});
