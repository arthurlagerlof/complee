// Load test of the review with the large synthetic model (stress-model.mjs): prints measurements as JSON.
//   node stress-model.mjs work/stress-model && node stress-run.mjs work/stress-model
// Headless Chromium draws with a software rasteriser here, so frame times are an upper bound for a laptop GPU;
// everything else (loading, part state, checks, picking, memory) is CPU work and representative.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { chromium } from 'playwright';

const modelDir = path.resolve(process.argv[2] || 'work/stress-model');
const catalog = JSON.parse(fs.readFileSync(path.join(modelDir, 'catalog.json'), 'utf8'));
const bodies = Object.fromEntries(Object.entries(catalog).map(([k, v]) => { const b = Buffer.from(JSON.stringify(v)); return [k, { b, etag: `"${crypto.createHash('sha256').update(b).digest('hex')}"` }]; }));
const stub = http.createServer((req, res) => {
  const m = /^\/api\/v1\/shipcheck\/catalog\/([a-z0-9-]+)$/.exec(req.url || ''), doc = m && bodies[m[1]];
  if (!doc) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"error":{"message":"not imported"}}'); }
  if (req.headers['if-none-match'] === doc.etag) { res.writeHead(304, { ETag: doc.etag }); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json', ETag: doc.etag, 'Content-Length': doc.b.length }); res.end(doc.b);
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
process.env.SHIPCHECK_DATA_API_URL = `http://127.0.0.1:${stub.address().port}`;
process.env.MODEL_DIR = modelDir; process.env.EVIDENCE_PROVIDER = 'none'; delete process.env.MODEL_SOURCE;
const { server } = await import('../../server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const CHROME = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium'].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), headless: true,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader', '--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
const out = {};
const settled = (ms = 240000) => page.waitForFunction(() => { const s = window.localViewer?.stats; return s && !s.pending && s.residentTiles > 0 && [...window.localViewer.tiles.values()].every((c) => c.ready); }, null, { timeout: ms, polling: 250 });
const timed = (fn, arg) => page.evaluate(async ([src, a]) => { const f = (0, eval)(`(${src})`); const t = performance.now(); await f(a); return Math.round((performance.now() - t) * 10) / 10; }, [fn.toString(), arg]);
const frame = () => page.evaluate(() => { const { renderer, scene, camera } = window.localViewer; const gl = renderer.getContext(); const t = performance.now(); renderer.render(scene, camera); gl.finish(); return Math.round(performance.now() - t); });
const heap = () => page.evaluate(() => { window.gc?.(); return Math.round(performance.memory.usedJSHeapSize / 1e6); });

let t0 = Date.now();
await page.goto(`${BASE}/index.html?scenario=rcrv-3d`);
await page.waitForFunction(() => window.__shipcheck?.sc?.id === 'rcrv-3d' && window.__shipcheck.results, null, { timeout: 180000 });
out.data_and_check_ready_ms = Date.now() - t0;
out.elements = await page.evaluate(() => window.__shipcheck.model.elements.length);
out.full_check_ms = await page.evaluate(() => Math.round(window.__shipcheck.lastCheckMs));
out.summary = await page.evaluate(() => window.__shipcheck.results.element_summary);
await page.waitForFunction(() => window.localViewer?.stats?.firstPicture != null, null, { timeout: 180000 });
out.first_picture_ms = Date.now() - t0;
await settled();
out.overview_complete_ms = Date.now() - t0;
out.overview = await page.evaluate(() => { const s = window.localViewer.stats; return { tiles: s.residentTiles, triangles: s.residentTriangles, resident_MB: Math.round(s.residentBytes / 1e6), downloaded_MB: Math.round(s.bytes / 1e6), deferred: s.deferred, errors: s.errors.length }; });
out.heap_overview_MB = await heap();
out.frame_overview_ms = await frame();

// Part state: selection, filter, rule view over 215k parts.
const fail = await page.evaluate(() => Object.values(window.__shipcheck.results.elements).filter((e) => e.worst === 'non_compliant').map((e) => e.id));
out.findings = fail.length;
out.set_filter_ms = await timed((ids) => window.__shipcheckViewer.setFilter(new Set(ids)), fail);
out.clear_filter_ms = await timed(() => window.__shipcheckViewer.setFilter(null));
out.rule_view_ms = await timed((ids) => window.__shipcheckViewer.highlight(Object.fromEntries(ids.map((i) => [i, 'non_compliant']))), fail);
await settled();
out.rule_view = await page.evaluate(() => ({ tiles: window.localViewer.stats.residentTiles, triangles: window.localViewer.stats.residentTriangles, deferred: window.localViewer.stats.deferred }));
out.frame_rule_view_ms = await frame();
out.clear_rule_view_ms = await timed(() => { window.__shipcheckViewer.clearHighlight(); window.__shipcheckViewer.overview(); });
await page.waitForTimeout(1500); await settled();

// UI: findings list filter (renders the list and sets the viewer filter), selection of a finding with fly-in.
out.ui_filter_click_ms = await timed(() => document.querySelector('#filters .chip[data-st="compliant"]').click());
out.ui_filter_back_ms = await timed(() => document.querySelector('#filters .chip[data-st="compliant"]').click());
t0 = Date.now();
await page.evaluate((id) => document.querySelector(`#list .item[data-id="${id}"]`).click(), fail[0]);
await page.waitForFunction(() => document.querySelector('.aps-label') && !document.querySelector('.aps-label').hidden, null, { timeout: 60000 });
out.select_to_label_ms = Date.now() - t0;
await page.waitForTimeout(1600); await settled();
out.component = await page.evaluate(() => ({ tiles: window.localViewer.stats.residentTiles, triangles: window.localViewer.stats.residentTriangles, resident_MB: Math.round(window.localViewer.stats.residentBytes / 1e6), deferred: window.localViewer.stats.deferred }));
out.frame_component_ms = await frame();
// What-if edit: time on the main thread from the committed value to the redrawn lists (the typing pause of 250 ms
// on large models is not counted), and the re-check alone.
out.edit_main_thread_ms = await page.evaluate((id) => new Promise((resolve) => {
  const inp = document.querySelector('#dEditor input[data-key="thickness"]');
  inp.value = '12';
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  const t = performance.now();
  inp.dispatchEvent(new Event('change', { bubbles: true })); // commits at once
  const done = window.__shipcheck.results.elements[id].worst === 'compliant';
  resolve(done ? Math.round(performance.now() - t) : -1);
}), fail[0]);
out.incremental_check_ms = await page.evaluate(() => Math.round(window.__shipcheck.lastCheckMs * 100) / 100);
// Picking in the component view.
const pt = await page.evaluate(() => { const { camera, renderer, controls } = window.localViewer; const v = controls.target.clone().project(camera); const r = renderer.domElement.getBoundingClientRect(); return { x: r.left + (v.x + 1) / 2 * r.width, y: r.top + (1 - v.y) / 2 * r.height }; });
await page.evaluate(() => { window.__shipcheck.selected = null; window.__pickT = null; const o = window.__shipcheckViewer.select; });
t0 = Date.now();
await page.mouse.click(pt.x, pt.y);
await page.waitForFunction(() => window.__shipcheck.selected != null || document.querySelector('#detail h1')?.textContent.startsWith('dbId'), null, { timeout: 30000 }).then(() => { out.pick_ms = Date.now() - t0; }, () => { out.pick_ms = 'no hit'; });
// Zoomed interior view with the full model: the detail budget in action.
await page.evaluate(() => { window.__shipcheckViewer.clearSelection(); window.__shipcheckViewer.overview(); });
await page.waitForTimeout(1500); await settled();
await page.evaluate(() => { const { camera, controls } = window.localViewer; controls.dispatchEvent({ type: 'start' }); controls.target.set(0, 0, 0); camera.position.set(-9000, 5000, 9000); controls.update(); controls.dispatchEvent({ type: 'change' }); controls.dispatchEvent({ type: 'end' }); });
await page.waitForTimeout(600); await settled();
out.zoomed = await page.evaluate(() => { const s = window.localViewer.stats; return { tiles: s.residentTiles, triangles: s.residentTriangles, resident_MB: Math.round(s.residentBytes / 1e6), deferred: s.deferred, small_deferred: s.smallDeferred, evicted: s.evicted, badge: document.querySelector('.aps-status').textContent }; });
out.frame_zoomed_ms = await frame();
out.heap_zoomed_MB = await heap();
// Viewport policy cost per camera query, and traceability / report on 86k elements.
out.policy_query_ms = await page.evaluate(async () => { const { selectViewportTiles } = await import('./src/viewport-policy.mjs'); const m = window.localViewer.manifest; const t = performance.now(); for (let i = 0; i < 20; i++) selectViewportTiles(m, { planes: [], target: [0, 0, 0], span: 10000, eye: [-9000, 5000, 9000], screenScale: 1500, resident: new Set() }); return Math.round((performance.now() - t) / 20 * 10) / 10; });
out.open_trace_ms = await timed(() => document.querySelector('#traceBtn').click());
await page.evaluate(() => document.querySelector('#traceBtn').click());
out.errors = errors;
await page.screenshot({ path: path.join(modelDir, 'zoomed.png') });
console.log(JSON.stringify(out, null, 1));
await browser.close(); server.closeIdleConnections(); stub.closeIdleConnections(); server.close(); stub.close();
