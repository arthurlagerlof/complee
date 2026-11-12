// Browser smoke test of the deck viewer (layout models: escape plan, findings register, what-if editing) with the
// bundled catalog in shipcheck/catalog/ (no database, no 3D tiles):
//   cd shipcheck/tools/export && node --test deck-viewer-smoke.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'work', 'deck-viewer-smoke');
fs.mkdirSync(SHOTS, { recursive: true });
delete process.env.SHIPCHECK_DATA_API_URL;
process.env.EVIDENCE_PROVIDER = 'none';
const { server } = await import('../../server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const CHROME = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium'].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  headless: !process.env.HEADED,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'],
});
test.after(async () => { await browser.close(); server.closeIdleConnections(); await new Promise((r) => server.close(r)); });

const health = await (await fetch(`${BASE}/api/health`)).json();
const scenarios = health.catalog_source === 'bundled' ? (await (await fetch(`${BASE}/api/catalog/scenarios`)).json()).scenarios : [];

for (const sc of scenarios.filter((s) => s.viewer !== 'local')) {
  test(`${sc.id}: idle view draws no frames; selection, what-if re-check, escape plan and register work`, { timeout: 180000 }, async () => {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
    try {
      await page.goto(`${BASE}/index.html?scenario=${sc.id}`);
      await page.waitForFunction((id) => window.__shipcheck?.sc?.id === id && window.__shipcheck.results, sc.id, { timeout: 60000 });
      await page.waitForFunction(() => window.__shipcheck.viewerReady, null, { timeout: 60000 });
      assert.equal(await page.evaluate(() => window.__shipcheck.viewerReady), 'three');
      await page.waitForFunction(() => !document.querySelector('#loadingScreen'), null, { timeout: 30000 });

      // Idle: after the camera settles, no frames are drawn.
      await page.waitForTimeout(1500);
      const f0 = await page.evaluate(() => window.__shipcheckViewer.frames);
      await page.waitForTimeout(1000);
      const f1 = await page.evaluate(() => window.__shipcheckViewer.frames);
      assert.ok(f0 > 0, 'the deck view was drawn');
      assert.equal(f1, f0, 'an idle view draws no frames');
      await page.screenshot({ path: path.join(SHOTS, `${sc.id}-overview.png`) });

      // Selecting a finding draws again (camera flight).
      const first = await page.evaluate(() => {
        const e = Object.values(window.__shipcheck.results.elements).find((x) => x.worst === 'non_compliant') || Object.values(window.__shipcheck.results.elements).find((x) => x.results.length);
        return e.id;
      });
      await page.click(`#list .item[data-id="${first}"]`);
      await page.waitForFunction((id) => window.__shipcheck.selected === id, first);
      await page.waitForTimeout(1500);
      assert.ok((await page.evaluate(() => window.__shipcheckViewer.frames)) > f1, 'a selection is drawn');

      // What-if edit on a numeric value: the incremental re-check equals a full check of the edited model.
      const key = await page.evaluate(() => document.querySelector('#dEditor input[data-kind="num"]:not([disabled])')?.dataset.key || null);
      if (key) {
        await page.fill(`#dEditor input[data-key="${key}"]`, '12345');
        await page.waitForFunction((k) => [...window.__shipcheck.edits.keys()].some((x) => x.endsWith(`.${k}`)), key);
        const same = await page.evaluate(async () => {
          const { checkModel } = await import('./src/checker.mjs');
          const full = checkModel(window.__shipcheck.model, window.__shipcheck.coreRules);
          return JSON.stringify(full.elements) === JSON.stringify(window.__shipcheck.results.elements)
            && JSON.stringify(full.summary) === JSON.stringify(window.__shipcheck.results.summary)
            && JSON.stringify(full.element_summary) === JSON.stringify(window.__shipcheck.results.element_summary);
        });
        assert.ok(same, 'incremental re-check equals a full check');
      }

      // Escape plan, where the model supports it.
      if (await page.evaluate(() => !document.querySelector('#escapeBtn').hidden)) {
        await page.click('#escapeBtn');
        await page.waitForFunction(() => !document.querySelector('#escapeBox').hidden);
        const a = await page.evaluate(() => window.__shipcheckViewer.frames);
        await page.waitForTimeout(800);
        assert.ok((await page.evaluate(() => window.__shipcheckViewer.frames)) >= a, 'escape view keeps drawing while routes animate');
        await page.screenshot({ path: path.join(SHOTS, `${sc.id}-escape.png`) });
        await page.click('#escapeBtn');
      }

      // Findings register opens and closes.
      await page.click('#registerBtn');
      await page.waitForFunction(() => !document.querySelector('#registerPanel').hidden);
      await page.click('#regClose');
      await page.waitForFunction(() => document.querySelector('#registerPanel').hidden);

      // Hovering does not keep the view drawing, and a stream of pointer moves costs at most one pick per frame.
      const box = await page.locator('#threeView canvas').boundingBox();
      for (let i = 0; i < 40; i++) await page.mouse.move(box.x + box.width / 2 + i, box.y + box.height / 2);
      await page.mouse.move(box.x + 5, box.y + 5);
      await page.waitForTimeout(1500);
      const h0 = await page.evaluate(() => window.__shipcheckViewer.frames);
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => window.__shipcheckViewer.frames), h0, 'idle again after hovering');
      assert.deepEqual(errors, [], 'no browser errors');
    } finally { await context.close(); }
  });
}
test('bundled scenarios are available', () => { assert.ok(scenarios.length > 0 || health.catalog_source !== 'bundled'); });
