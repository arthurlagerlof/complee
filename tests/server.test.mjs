// The local server: file whitelist (never .env or source files), check API, APS endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';

test('server serves the app and API but never .env, keys or files outside the whitelist', async (t) => {
  process.env.PORT = '0';
  const log = console.log;
  console.log = () => {};
  const { server } = await import('../server.mjs');
  await new Promise((r) => (server.listening ? r() : server.once('listening', r)));
  console.log = log;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const code = async (p) => (await fetch(base + p)).status;

  assert.equal(await code('/'), 200);
  assert.equal(await code('/src/checker.mjs'), 200);
  assert.equal(await code('/node_modules/three/build/three.module.js'), 200);
  assert.equal(await code('/ships/rcrv/results-3d.json'), 200);
  assert.equal(await code('/.env'), 404);
  assert.equal(await code('/%2e%2e/.env'), 404);
  assert.equal(await code('/server.mjs'), 404);
  assert.equal(await code('/scripts/check.mjs'), 404);
  assert.equal(await code('/node_modules/.package-lock.json'), 404);

  const check = await (await fetch(`${base}/api/check?scenario=cruise`)).json();
  assert.equal(check.score.pass, true);

  // APS: keys are never served; the status only says whether they exist.
  assert.equal(await code('/3D_Since_AI/.env'), 404);
  assert.equal(await code('/3D_Since_AI/urn.txt'), 404);
  const statusText = await (await fetch(`${base}/api/aps/status`)).text();
  assert.deepEqual(Object.keys(JSON.parse(statusText)).sort(), ['configured', 'reason', 'urn']);
  assert.doesNotMatch(statusText, /secret|client_id/i);
  const bad = await fetch(`${base}/api/aps/fallback`, { method: 'POST', body: JSON.stringify({ name: '../x', dataUrl: 'data:image/png;base64,AAAA' }) });
  assert.equal(bad.status, 400, 'fallback file names are restricted to [a-z0-9-]');
});
