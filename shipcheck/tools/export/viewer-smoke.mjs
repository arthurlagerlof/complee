// Browser smoke test of the streamed viewer against the synthetic model (no Autodesk data, no database):
//   cd shipcheck/tools/export && node --test viewer-smoke.mjs
// Starts a stub catalog API and the ShipCheck server on free ports, opens the review in headless Chromium and checks
// first picture, tile streaming, part state (selection, filter, rule view), picking, what-if re-check, eviction,
// screenshots and HTTP revalidation. HEADED=1 shows the browser; screenshots go to work/viewer-smoke/.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { writeSyntheticModel } from './synthetic-model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'work', 'viewer-smoke');
const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipcheck-synthetic-'));
const synthetic = await writeSyntheticModel(modelDir);
const catalog = synthetic.catalog;

// Stub of the database API: catalog documents with a content ETag (as the real API answers).
const stubHits = { requests: 0, notModified: 0 };
const stub = http.createServer((req, res) => {
  const m = /^\/api\/v1\/shipcheck\/catalog\/([a-z0-9-]+)$/.exec(req.url || '');
  const doc = m && catalog[m[1]];
  if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"not imported"}}'); }
  const body = Buffer.from(JSON.stringify(doc));
  const etag = `"${crypto.createHash('sha256').update(body).digest('hex')}"`;
  stubHits.requests++;
  if (req.headers['if-none-match'] === etag) { stubHits.notModified++; res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag, 'Cache-Control': 'no-cache', 'Content-Length': body.length });
  res.end(body);
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.SHIPCHECK_DATA_API_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.MODEL_DIR = modelDir;
process.env.EVIDENCE_PROVIDER = 'none';
delete process.env.MODEL_SOURCE;
const { server } = await import('../../server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
fs.mkdirSync(SHOTS, { recursive: true });

// CHROME_PATH: a Chrome/Chromium binary when the local Playwright has no browser of its own.
const CHROME = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium'].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  headless: !process.env.HEADED,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
test.after(async () => {
  await browser.close();
  server.closeIdleConnections();
  stub.closeIdleConnections();
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => stub.close(r))]);
  fs.rmSync(modelDir, { recursive: true, force: true });
});

async function withPage(fn) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(`console: ${m.text()}`); });
  try { await fn(page, errors); assert.deepEqual(errors, [], 'no browser errors'); } finally { await context.close(); }
}
const settled = (page, ms = 60000) => page.waitForFunction(() => { const s = window.localViewer?.stats; return s && !s.pending && s.residentTiles > 0 && [...window.localViewer.tiles.values()].every((c) => c.ready); }, null, { timeout: ms, polling: 200 });
async function openReview(page) {
  await page.goto(`${BASE}/index.html?scenario=rcrv-3d`);
  await page.waitForFunction(() => window.__shipcheck?.sc?.id === 'rcrv-3d' && window.__shipcheck.model, null, { timeout: 60000 });
  await page.waitForFunction(() => window.__shipcheck.viewerReady && window.localViewer?.stats?.firstPicture != null, null, { timeout: 90000 });
  assert.equal(await page.evaluate(() => window.__shipcheck.viewerReady), 'local');
  await settled(page);
}
// Share of the canvas that differs from the background and the mean colour of a screen point.
const picture = (page) => page.evaluate(() => {
  const { renderer, scene, camera } = window.localViewer;
  renderer.render(scene, camera);
  const src = renderer.domElement, w = 160, h = Math.max(1, Math.round(160 * src.height / src.width));
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d'); g.drawImage(src, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data, bg = [d[0], d[1], d[2]];
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) n++;
  return n / (w * h);
});
const colourAt = (page, db) => page.evaluate((db) => {
  const { renderer, scene, camera, tiles } = window.localViewer;
  // World centre of the part from the manifest bounds of the tile holding it, projected to the canvas.
  const info = [...tiles.values()].map((c) => c.info).find((i) => i.dbIds.includes(db));
  if (!info) return null;
  const el = document.querySelector(`#list .item`); void el;
  const b = info.bounds_mm, p = new (renderer.constructor.prototype.constructor.THREE || window.THREE).Vector3(); void p;
  return null;
}, db);
const screenPoint = (page, id) => page.evaluate((id) => {
  const { camera, renderer } = window.localViewer;
  const box = window.__shipcheckViewer.__boxOf?.(id);
  if (!box) return null;
  const rect = renderer.domElement.getBoundingClientRect();
  const x = (box.x + 1) / 2 * rect.width + rect.left, y = (1 - box.y) / 2 * rect.height + rect.top;
  void camera;
  return { x, y };
}, id);
void colourAt; void screenPoint;

test('first picture, streaming, state texture, picking, re-check, eviction, revalidation', { timeout: 300000 }, () => withPage(async (page) => {
  await openReview(page);
  const stats = await page.evaluate(() => ({ ...window.localViewer.stats, tiles: window.localViewer.tiles.size, desired: window.localViewer.manifest.chunks.length }));
  assert.ok(stats.firstPicture > 0 && stats.firstPicture < 60000, `first picture in ${stats.firstPicture} ms`);
  assert.ok(stats.residentTiles > 0, 'overview tiles resident');
  assert.equal(stats.errors.length, 0, 'no tile errors');
  assert.ok(await picture(page) > 0.05, 'the ship is drawn');
  await page.screenshot({ path: path.join(SHOTS, 'overview.png') });

  // Part state: every catalog part has its status colour; hull plates are visible, nothing is ghosted.
  const ids = Object.keys(synthetic.catalog['model-rcrv-parts'].parts.reduce((o, p) => (o[p.objectid] = 1, o), {})).map(Number);
  const alphas = await page.evaluate((ids) => ids.map((db) => window.localViewer.state[db * 4 + 3]), ids);
  assert.ok(alphas.every((a) => a === 255), 'all checked parts visible in the overview');
  const worst = await page.evaluate(() => window.__shipcheck.results.element_summary);
  assert.equal(worst.non_compliant, 2, 'the thin deck plate and the small hatch fail');

  // Selecting a finding: its tiles stream in, the part is marked selected (254), the rest ghosted (context colour).
  const failing = `P${synthetic.hatches[3]}`;
  await page.evaluate((id) => window.__shipcheckViewerSelect?.(id) ?? document.querySelector(`#list .item[data-id="${id}"]`).click(), failing);
  await page.waitForFunction((db) => window.localViewer.state[db * 4 + 3] === 254 && !window.localViewer.stats.pending, synthetic.hatches[3], { timeout: 60000 });
  await settled(page);
  const sel = await page.evaluate((db) => {
    const t = [...window.localViewer.tiles.values()].find((c) => c.info.dbIds.includes(db));
    return { tile: !!t, xray: !!t?.xray?.visible, hullAlpha: window.localViewer.state[1 * 4 + 3], selected: window.__shipcheck.selected };
  }, synthetic.hatches[3]);
  assert.equal(sel.selected, failing);
  assert.ok(sel.tile, 'the component tile is resident');
  assert.ok(sel.xray, 'the x-ray pass is on for the tile holding the selected part');
  assert.equal(sel.hullAlpha, 255, 'surroundings stay solid in the component view');
  await page.screenshot({ path: path.join(SHOTS, 'component.png') });

  // What-if edit: the hatch opening becomes compliant; only this element is re-checked.
  const before = await page.evaluate(() => window.__shipcheck.results.elements);
  await page.fill('#dEditor input[data-key="clear_opening_min_side"]', '700');
  await page.waitForFunction((id) => window.__shipcheck.results.elements[id].worst === 'compliant', failing, { timeout: 10000 });
  const after = await page.evaluate((id) => ({ ms: window.__shipcheck.lastCheckMs, summary: window.__shipcheck.results.element_summary, same: window.__shipcheck.results.elements !== null, n: Object.keys(window.__shipcheck.results.elements).length }), failing);
  assert.equal(after.summary.non_compliant, 1);
  assert.equal(after.n, Object.keys(before).length);
  assert.ok(after.ms < 50, `incremental re-check took ${after.ms} ms`);
  const colour = await page.evaluate((db) => [...window.localViewer.state.slice(db * 4, db * 4 + 3)], synthetic.hatches[3]);
  assert.ok(colour[1] > colour[0] && colour[1] > colour[2], 'the selected hatch is now green');

  // Rule view: the rule's parts coloured, the hull a 40/255 ghost drawn in the see-through pass.
  await page.click('#backOverview');
  await page.evaluate(() => window.__shipcheckViewer.highlight({ [`P${window.__shipcheckHatch}`]: 'compliant' }), null).catch(() => {});
  await page.evaluate((id) => window.__shipcheckViewer.highlight({ [id]: 'non_compliant' }), `P${synthetic.hatches[0]}`);
  await settled(page);
  const rule = await page.evaluate((db) => ({
    hull: window.localViewer.state[1 * 4 + 3], part: window.localViewer.state[db * 4 + 3],
    glass: [...window.localViewer.tiles.values()].filter((c) => c.info.group === 'context').every((c) => c.glass?.visible),
  }), synthetic.hatches[0]);
  assert.equal(rule.hull, 40, 'context parts are ghosted in the rule view');
  assert.equal(rule.part, 255);
  assert.ok(rule.glass, 'hull tiles use the see-through pass while ghosted');
  await page.screenshot({ path: path.join(SHOTS, 'rule-view.png') });
  await page.evaluate(() => { window.__shipcheckViewer.clearHighlight(); window.__shipcheckViewer.overview(); });
  await page.waitForFunction(() => window.localViewer.state[1 * 4 + 3] === 255);
  assert.equal(await page.evaluate(() => [...window.localViewer.tiles.values()].filter((c) => c.info.group === 'context').some((c) => c.glass?.visible)), false, 'ghost passes are switched off again');

  // Findings filter: hidden parts get alpha 0 and are not drawn (the picture shrinks).
  const full = await picture(page);
  await page.evaluate((keep) => window.__shipcheckViewer.setFilter(new Set([keep])), failing);
  await page.waitForFunction(() => window.localViewer.state[1 * 4 + 3] === 255 && window.localViewer.state[2 * 4 + 3] === 255, null);
  const filtered = await page.evaluate(() => { const s = window.localViewer.state; let hidden = 0; for (let i = 3; i < s.length; i += 4) if (s[i] === 0) hidden++; return hidden; });
  assert.ok(filtered > 0, 'parts outside the filter are hidden');
  await page.evaluate(() => window.__shipcheckViewer.setFilter(null));
  void full;

  // Picking: click the centre of a hatch and the app selects it (through the worker's BVH).
  await page.evaluate(() => window.__shipcheckViewer.clearSelection());
  await page.evaluate((id) => window.__shipcheckViewer.select(id, { fly: true }), `P${synthetic.hatches[1]}`);
  await page.waitForFunction(() => !window.localViewer.stats.pending && !window.localViewer.tiles.size === false, null, { timeout: 30000 });
  await page.waitForTimeout(1500); // camera flight
  await settled(page);
  const target = await page.evaluate(() => {
    const { camera, renderer, controls } = window.localViewer;
    const v = controls.target.clone().project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height };
  });
  await page.evaluate(() => { window.__shipcheck.selected = null; window.__shipcheckViewer.clearSelection(); });
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction((id) => window.__shipcheck.selected === id, `P${synthetic.hatches[1]}`, { timeout: 15000 });

  // Screenshot API works without a preserved drawing buffer.
  const shot = await page.evaluate(() => window.__shipcheckViewer.screenshot());
  assert.ok(shot.startsWith('data:image/png;base64,') && shot.length > 5000);

  // Taking hold of the camera stops a running flight where it is (it no longer pulls the view back).
  await page.evaluate(() => window.__shipcheckViewer.overview());
  await page.waitForFunction(() => window.localViewer.flying, null, { timeout: 5000 });
  await page.evaluate(() => window.localViewer.controls.dispatchEvent({ type: 'start' }));
  assert.equal(await page.evaluate(() => window.localViewer.flying), false, 'the user stops the flight');
  await page.evaluate(() => window.localViewer.controls.dispatchEvent({ type: 'end' }));

  // Eviction: looking far away from the ship releases every tile and its picking index (a selected component would
  // stay resident on purpose, so the selection is cleared first). The move is made as the user would: grab, move.
  await page.evaluate(() => {
    window.__shipcheckViewer.clearSelection();
    const { camera, controls } = window.localViewer;
    controls.dispatchEvent({ type: 'start' });
    controls.target.set(500000, 0, 500000); camera.position.set(520000, 10000, 520000); controls.update();
    controls.dispatchEvent({ type: 'change' });
    controls.dispatchEvent({ type: 'end' });
  });
  await page.waitForFunction(() => window.localViewer.tiles.size === 0 && !window.localViewer.stats.pending, null, { timeout: 30000 });
  assert.ok((await page.evaluate(() => window.localViewer.stats.evicted)) > 0);
  await page.evaluate(() => window.__shipcheckViewer.overview());
  await settled(page);
  assert.ok((await page.evaluate(() => window.localViewer.tiles.size)) > 0, 'tiles come back');
}));

test('server: revalidation with ETags for catalogs, modules and the tile manifest; tiles immutable', async () => {
  const rules = await fetch(`${BASE}/api/catalog/rules`);
  assert.equal(rules.status, 200);
  const etag = rules.headers.get('etag');
  assert.ok(etag, 'catalog responses carry the dataset ETag');
  assert.equal(rules.headers.get('cache-control'), 'no-cache');
  const again = await fetch(`${BASE}/api/catalog/rules`, { headers: { 'If-None-Match': etag } });
  assert.equal(again.status, 304);
  const upstreamBefore = stubHits.notModified;
  await fetch(`${BASE}/api/catalog/rules`);
  assert.ok(stubHits.notModified > upstreamBefore, 'the proxy revalidates upstream instead of downloading the catalog again');

  const mod = await fetch(`${BASE}/src/checker.mjs`);
  assert.equal(mod.headers.get('cache-control'), 'no-cache');
  const modAgain = await fetch(`${BASE}/src/checker.mjs`, { headers: { 'If-None-Match': mod.headers.get('etag') } });
  assert.equal(modAgain.status, 304);
  const manifest = await fetch(`${BASE}/model/stream-hp/manifest.json`);
  assert.equal(manifest.status, 200);
  const tile = (await manifest.json()).chunks[0].file;
  const glb = await fetch(`${BASE}/model/stream-hp/${tile}`);
  assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
  assert.match(glb.headers.get('cache-control'), /immutable/);
  const range = await fetch(`${BASE}/model/stream-hp/${tile}`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 10);
});
