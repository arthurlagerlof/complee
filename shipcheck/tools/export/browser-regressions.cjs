// Real-browser regression suite for ShipCheck (Playwright from the export tools; not part of `npm test`).
// Needs the app running (repo root: .\scripts\start-dev.ps1) and Chrome. Starts and stops no server.
//
//   cd shipcheck/tools/export && npm install
//   node --test --test-concurrency=1 browser-regressions.cjs
//
// Options (environment): SHIPCHECK_URL (default http://localhost:5173/inspection/index.html),
// LANDING_URL (default http://localhost:5173/landing), CHROME_PATH (default: the installed Chrome, else Playwright's),
// HEADED=1 to watch, SKIP_APS=1 to skip the Autodesk check, SKIP_DEMO=1 to skip the 2-3 minute demo run.
// Screenshots go to work/browser-regressions/ (ignored).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright');

const BASE = process.env.SHIPCHECK_URL || 'http://localhost:5173/inspection/index.html';
const LANDING = process.env.LANDING_URL || 'http://localhost:5173/landing';
const SHOTS = path.join(__dirname, 'work', 'browser-regressions');
const CHROME = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome'].find((p) => p && fs.existsSync(p));
let browser;

before(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), headless: !process.env.HEADED,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => { await browser?.close(); });

async function withPage(fn, { width = 1440, height = 1000, block = [] } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) errors.push(`console: ${m.text()}`); });
  for (const pattern of block) await context.route(pattern, (r) => r.abort());
  try { await fn(page, errors); assert.deepEqual(errors, [], 'no browser errors'); } finally { await context.close(); }
}
const committed = (page, id) => page.waitForFunction((id) => window.__shipcheck?.sc?.id === id && window.__shipcheck.model, id, { timeout: 90000 });
async function openReal(page, suffix = '') {
  await page.goto(`${BASE}?scenario=rcrv-3d${suffix}`);
  await committed(page, 'rcrv-3d');
  await page.waitForFunction(() => window.__shipcheck.viewerReady && !document.querySelector('#localView').hidden && window.localViewer?.stats?.firstPicture != null, null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => window.__shipcheck.viewerReady), 'local');
}
// Loading queue drained (the view may still report deferred detail: the policy then asks to zoom in).
const settled = (page, ms = 240000) => page.waitForFunction(() => { const s = window.localViewer.stats; return !s.pending && (s.viewComplete || s.deferred > 0 || s.overviewDeferred > 0); }, null, { timeout: ms, polling: 500 });
// Share of the canvas that differs from the background, and where the drawn part sits (0..1 of width / height).
async function picture(page) {
  return page.evaluate(() => {
    const { renderer, scene, camera } = window.localViewer;
    renderer.render(scene, camera);
    const src = renderer.domElement, w = 240, h = Math.max(1, Math.round(240 * src.height / src.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'); g.drawImage(src, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data, bg = [d[0], d[1], d[2]];
    let n = 0, x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = 4 * (y * w + x);
      if (Math.abs(d[o] - bg[0]) + Math.abs(d[o + 1] - bg[1]) + Math.abs(d[o + 2] - bg[2]) > 24) { n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    return { filled: n / (w * h), cx: (x0 + x1) / 2 / w, cy: (y0 + y1) / 2 / h, touches: x0 <= 0 || y0 <= 0 || x1 >= w - 1 || y1 >= h - 1 };
  });
}
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

test('landing and inspection pages load without errors', { timeout: 60000 }, () => withPage(async (page) => {
  const landing = await page.goto(LANDING);
  assert.ok(landing.ok(), `landing ${landing.status()}`);
  await page.waitForLoadState('networkidle');
  assert.ok((await page.locator('body').innerText()).trim().length > 50, 'landing has content');
  await page.goto(`${BASE}?scenario=cruise`);
  await committed(page, 'cruise');
  assert.equal(await page.evaluate(() => window.__shipcheck.baseline.detected), 7);
}));

test('real model overview: complete exterior, centred, not cut off', { timeout: 300000 }, () => withPage(async (page) => {
  await openReal(page);
  await settled(page);
  const p = await picture(page);
  await shot(page, 'overview');
  assert.ok(p.filled > 0.05, `model visible (${(p.filled * 100).toFixed(1)} % of the canvas)`);
  assert.ok(Math.abs(p.cx - 0.5) < 0.12 && Math.abs(p.cy - 0.5) < 0.15, `centred (${p.cx.toFixed(2)}, ${p.cy.toFixed(2)})`);
  assert.equal(p.touches, false, 'the ship does not touch the canvas edge');
  assert.equal(await page.locator('#fullBtn').isVisible(), true);
  assert.deepEqual(await page.evaluate(() => window.localViewer.stats.errors), [], 'no tile errors');
}));

test('parts transparent in the original stay see-through (rescue-boat launch envelope, 4 % opacity)', { timeout: 300000 }, () => withPage(async (page) => {
  await openReal(page);
  await settled(page);
  const envelope = 50426; // MOD124-RESCUE BOAT AND DAVIT.dwg, layer ENV_, material opacity 0.04
  const r = await page.evaluate((db) => {
    let n = 0, max = 0, glass = 0;
    for (const c of window.localViewer.tiles.values()) {
      let has = false;
      for (let v = 0; v < c.dbids.length; v++) if (c.dbids[v] === db) { n++; has = true; max = Math.max(max, c.state[v * 4 + 3]); }
      if (has && c.mesh.parent.children.some((o) => o !== c.mesh && o.material?.transparent)) glass++;
    }
    return { n, max, glass };
  }, envelope);
  assert.ok(r.n > 0, 'the envelope is part of the loaded overview');
  assert.ok(r.max > 0 && r.max <= 26, `drawn with its original opacity, not as a solid block (alpha ${r.max}/255)`);
  assert.ok(r.glass > 0, 'drawn in the see-through pass');
}));

test('Simple / Full model / deck cut stay in sync', { timeout: 300000 }, () => withPage(async (page) => {
  await openReal(page);
  await page.focus('#cutSel'); // deck levels are filled in on first use
  const cut = await page.locator('#cutSel option').evaluateAll((xs) => xs.find((x) => x.value !== '')?.value);
  assert.notEqual(cut, undefined, 'deck levels offered');
  for (const btn of ['#simpleBtn', '#fullBtn']) {
    await page.selectOption('#cutSel', cut);
    await page.waitForFunction(() => window.localViewer.renderer.domElement && document.querySelector('#cutSel').value !== '');
    await page.click(btn);
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#cutSel').inputValue(), '', `${btn} resets the deck cut selector`);
    const planes = await page.evaluate(() => { let n = 0; window.localViewer.scene.traverse((o) => { for (const m of [].concat(o.material || [])) n += (m.clippingPlanes || []).filter((pl) => pl.constant < 1e8).length; }); return n; });
    assert.equal(planes, 0, `${btn}: no clipping plane left active`);
    await page.click(btn); // back
  }
  for (const [btn, key] of [['#simpleBtn', 'simple'], ['#fullBtn', 'fullModel']]) {
    const shown = await page.locator(btn).evaluate((b) => b.classList.contains('on'));
    assert.equal(shown, await page.evaluate((k) => !!window.__shipcheckViewer[k], key), `${btn} button matches the viewer`);
  }
}));

test('rule view, component view and what-if on the real model', { timeout: 300000 }, () => withPage(async (page) => {
  await openReal(page);
  const row = page.locator('#rulesBox .ruleRow').filter({ hasText: '22 hatches' });
  await row.click();
  await page.waitForFunction(() => window.__shipcheck.ruleView);
  await settled(page);
  await shot(page, 'rule-view');
  await page.locator('#ruleParts .item[data-id="P3522"]').click();
  await page.waitForFunction(() => window.__shipcheck.selected === 'P3522');
  await settled(page);
  assert.match(await page.locator('#dStatus').innerText(), /not enough info/i);
  await page.waitForFunction(() => { const l = document.querySelector('#localView .aps-label'); return l && !l.hidden && /P3522|600|required/i.test(l.textContent); }, null, { timeout: 30000 });
  const p = await picture(page);
  await shot(page, 'component-P3522');
  assert.ok(p.filled > 0.01, 'the hatch is drawn');
  const near = await page.evaluate(() => { const { camera, controls } = window.localViewer; return { near: camera.near, dist: camera.position.distanceTo(controls.target) }; });
  assert.ok(near.near > 0 && near.near < near.dist * 0.5, `near plane ${near.near.toFixed(1)} mm is in front of the part (${near.dist.toFixed(0)} mm away)`);
  const input = page.locator('#dEditor input[data-key="clear_opening_min_side"]');
  await input.fill('24');
  const unit = page.locator('#dEditor [data-unit-for="clear_opening_min_side"]');
  if (await unit.count()) await unit.selectOption('in');
  await input.dispatchEvent('change');
  await page.waitForFunction(() => window.__shipcheck.results.elements.P3522.worst === 'compliant', null, { timeout: 20000 });
  assert.match(await page.locator('#dStatus').innerText(), /compliant/i);
  await page.locator('#backOverview').click();
  await page.waitForFunction(() => window.__shipcheck.selected == null);
}));

test('graphics context loss and recovery', { timeout: 300000 }, () => withPage(async (page) => {
  await openReal(page);
  await settled(page);
  const before = await picture(page);
  await page.evaluate(() => { window.__lose = window.localViewer.renderer.getContext().getExtension('WEBGL_lose_context'); window.__lose.loseContext(); });
  await page.waitForFunction(() => window.localViewer.renderer.getContext().isContextLost());
  await page.waitForTimeout(500);
  await page.evaluate(() => window.__lose.restoreContext());
  await page.waitForFunction(() => (window.localViewer.stats.contextRecoveries || 0) >= 1, null, { timeout: 30000 });
  await settled(page);
  const afterPic = await picture(page);
  await shot(page, 'after-context-loss');
  assert.ok(afterPic.filled > before.filled * 0.8, `model drawn again after recovery (${(afterPic.filled * 100).toFixed(1)} % vs ${(before.filled * 100).toFixed(1)} %)`);
  assert.ok(await page.evaluate(() => window.localViewer.stats.residentTiles > 0), 'tiles requested again');
}));

// Note: below about 800 px width the inspection layout (fixed 330 px + 420 px side columns) leaves no room for the
// 3D pane at all; that is the existing desktop layout, so portrait is tested on a tall window that keeps the pane.
test('narrow portrait window: model fits and stays usable', { timeout: 300000 }, () => withPage(async (page) => {
  await openReal(page);
  await settled(page);
  await page.setViewportSize({ width: 1100, height: 1400 });
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelector('#backOverview')?.click());
  const size = await page.evaluate(() => { const c = window.localViewer.renderer.domElement, b = document.querySelector('#localView').getBoundingClientRect(); return { cw: c.clientWidth, ch: c.clientHeight, bw: b.width, bh: b.height }; });
  assert.ok(Math.abs(size.cw - size.bw) <= 2 && Math.abs(size.ch - size.bh) <= 2, `canvas follows its pane (${JSON.stringify(size)})`);
  await settled(page);
  const p = await picture(page);
  await shot(page, 'portrait');
  assert.ok(p.filled > 0.01, 'model visible in portrait');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForTimeout(500);
  assert.ok((await picture(page)).filled > 0.01, 'model visible after resizing back');
}, { width: 1440, height: 1000 }));

test('?viewer=aps loads the Autodesk viewer or falls back cleanly', { timeout: 300000, skip: process.env.SKIP_APS && 'SKIP_APS set' }, () => withPage(async (page) => {
  await page.goto(`${BASE}?scenario=rcrv-3d&viewer=aps`);
  await committed(page, 'rcrv-3d');
  const mode = await page.evaluate(() => Promise.race([window.__shipcheck.viewerReady, new Promise((r) => setTimeout(() => r('timeout'), 240000))]));
  await shot(page, `aps-${mode}`);
  assert.ok(['aps', 'fallback'].includes(mode), `viewer: ${mode}`);
  if (mode === 'fallback') assert.equal(await page.locator('#fallbackView').isVisible(), true);
}));

test('presenter mode: the demo waits for → / Space at every step, Esc stops it', { timeout: 300000 }, () => withPage(async (page) => {
  await page.goto(`${BASE}?scenario=rcrv-3d&demo&present`);
  await committed(page, 'rcrv-3d');
  const cap = () => page.evaluate(() => { const c = document.querySelector('#caption'); return c.hidden ? '' : c.innerText.split('\n')[0]; });
  await page.waitForFunction(() => /OSU RCRV/.test(document.querySelector('#caption').innerText), null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#localView .aps-status')).display), 'none', 'no technical badge during the demo');
  const first = await cap();
  await page.waitForTimeout(6000);
  assert.equal(await cap(), first, 'stays on the step until the presenter moves on');
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction((c) => { const t = document.querySelector('#caption'); return !t.hidden && t.innerText.split('\n')[0] !== c; }, first, { timeout: 15000 });
  assert.match(await page.locator('#caption').innerText(), /Space \/ → next/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.__shipcheck.demo, null, { timeout: 15000 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#localView .aps-status')).display) !== 'none', true, 'badge back after the demo');
}));

test('full demo run-through on the real model', { timeout: 420000, skip: process.env.SKIP_DEMO && 'SKIP_DEMO set' }, () => withPage(async (page) => {
  await page.goto(`${BASE}?scenario=rcrv-3d&demo`);
  await committed(page, 'rcrv-3d');
  await page.waitForFunction(() => window.__shipcheck.demo, null, { timeout: 60000 });
  await page.waitForFunction(() => !window.__shipcheck.demo, null, { timeout: 400000, polling: 1000 });
  await shot(page, 'demo-end');
  assert.match(await page.locator('#demoBtn').innerText(), /Demo run-through/);
  assert.equal(await page.evaluate(() => window.__shipcheck.baseline?.pass), true, 'ground truth still passes');
}));
