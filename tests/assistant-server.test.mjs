// AI grounding checks (offline, no API call) and the local server's file whitelist.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDraft, isVerbatim, providerConfig } from '../rule-assistant.mjs';

const PARA = '404.2.3 Clear Width. Door openings shall provide a clear width of 32 inches (815 mm) minimum.';
const good = {
  id: 'ADA-404.2.3-DRAFT', source: 'ADA 2010', clause: '404.2.3', check: 'min', parameter: 'clear_width', value: 815, unit: 'mm',
  text: 'Door openings shall provide a clear width of 32 inches (815 mm) minimum.', applies_to: { types: ['door'] }, verified: false,
};

test('AI draft passes grounding checks only when quote and value come from the text', () => {
  assert.equal(checkDraft(good, PARA, []).valid, true);
  assert.equal(checkDraft({ ...good, text: 'Doors must be at least 815 mm wide.' }, PARA).valid, false, 'paraphrase rejected');
  assert.equal(checkDraft({ ...good, value: 850 }, PARA).valid, false, 'invented value rejected');
  assert.equal(checkDraft(good, PARA, ['ADA-404.2.3-DRAFT']).valid, false, 'duplicate id rejected');
  assert.equal(checkDraft({ ...good, check: 'guess' }, PARA).valid, false, 'unknown check type rejected');
});

test('verbatim match ignores whitespace, case and curly quotes only', () => {
  assert.ok(isVerbatim('door  openings shall provide', PARA));
  assert.ok(!isVerbatim('door openings must provide', PARA));
  assert.ok(!isVerbatim('', PARA));
});

test('no provider is configured without keys', () => {
  assert.equal(providerConfig({}), null);
  assert.equal(providerConfig({ MISTRAL_API_KEY: 'x' }).name, 'mistral');
  assert.equal(providerConfig({ MISTRAL_API_KEY: 'x', ANTHROPIC_API_KEY: 'y', AI_PROVIDER: 'anthropic' }).name, 'anthropic');
});

test('server serves the app and API but never .env or source files outside the whitelist', async (t) => {
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
  assert.equal(await code('/.env'), 404);
  assert.equal(await code('/%2e%2e/.env'), 404);
  assert.equal(await code('/server.mjs'), 404);
  assert.equal(await code('/node_modules/.package-lock.json'), 404);
  const check = await (await fetch(`${base}/api/check?scenario=rcrv`)).json();
  assert.equal(check.score.pass, true);
  const ai = await (await fetch(`${base}/api/ai/status`)).json();
  assert.equal(typeof ai.enabled, 'boolean');

  // APS: keys are never served; the status only says whether they exist.
  assert.equal(await code('/3D_Since_AI/.env'), 404);
  assert.equal(await code('/3D_Since_AI/urn.txt'), 404);
  const statusText = await (await fetch(`${base}/api/aps/status`)).text();
  assert.deepEqual(Object.keys(JSON.parse(statusText)).sort(), ['configured', 'reason', 'urn']);
  assert.doesNotMatch(statusText, /secret|client_id/i);
  const bad = await fetch(`${base}/api/aps/fallback`, { method: 'POST', body: JSON.stringify({ name: '../x', dataUrl: 'data:image/png;base64,AAAA' }) });
  assert.equal(bad.status, 400, 'fallback file names are restricted to [a-z0-9-]');
  assert.equal(await code('/ships/rcrv/results-3d.json'), 200);
});

test('APS objects are mapped with bounding boxes converted from inches', async () => {
  const { mapObjects } = await import('../extract-aps.mjs');
  const { elements, skipped } = mapObjects([
    { objectid: 7, name: 'Stair 02-03', properties: { Item: { Type: 'Stair' }, Geometry: { 'Bounding Box Min X': 0, 'Bounding Box Min Y': 0, 'Bounding Box Min Z': 0, 'Bounding Box Max X': 100, 'Bounding Box Max Y': 40, 'Bounding Box Max Z': 106 } } },
    { objectid: 8, name: 'Pipe support', properties: { Item: { Type: 'Solid' } } },
    { objectid: 9, name: 'Door 12', properties: { Item: { Type: 'Door' } } },
  ], 'in');
  assert.equal(elements.length, 1);
  assert.equal(elements[0].type, 'stair');
  assert.equal(elements[0].geom.ly, 40 * 25.4);
  assert.match(elements[0].source, /APS model/);
  assert.deepEqual(skipped, { no_type: 1, no_bbox: 1 });
});
