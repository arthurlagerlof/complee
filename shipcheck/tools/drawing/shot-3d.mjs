// Screenshots of a drawing converted to 3D, for looking at the result (not an assertion test):
//   cd shipcheck && PORT=8092 node server.mjs            (in another terminal)
//   node tools/drawing/shot-3d.mjs [--tag after] [--file tools/drawing-samples/aurora_1230-01-01_A_GA.pdf]
//        [--base http://localhost:8092] [--sizes 1600x1000,1280x720,820x1000] [--only iso,top]
// Writes tools/drawing/out/shots/<tag>/<size>-<shot>.png and log.json (console errors, page errors, CSP violations).
// Playwright comes from tools/export/node_modules; Chrome from CHROME_PATH (default: the installed Chrome on Windows).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(ROOT, 'tools', 'export', 'package.json'));
const { chromium } = require('playwright');

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', 'http://localhost:8092');
const TAG = arg('tag', 'latest');
const FILE = path.resolve(ROOT, arg('file', 'tools/drawing-samples/aurora_1230-01-01_A_GA.pdf'));
const SIZES = arg('sizes', '1600x1000,1280x720,820x1000').split(',').map((s) => s.split('x').map(Number));
const ONLY = arg('only', null)?.split(',');
const OUT = path.join(HERE, 'out', 'shots', TAG);
fs.mkdirSync(OUT, { recursive: true });

const CHROME = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/opt/pw-browsers/chromium'].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({
  ...(CHROME ? { executablePath: CHROME } : {}),
  headless: !process.env.HEADED,
  args: ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
});
const log = { base: BASE, file: FILE, sizes: {}, startedAt: new Date().toISOString() };
const want = (name) => !ONLY || ONLY.includes(name);

// Wait until the viewer has drawn and the camera stopped (it renders on demand: frames stop when idle).
async function settle(page, ms = 900) {
  await page.waitForTimeout(ms);
  for (let i = 0; i < 20; i++) {
    const a = await page.evaluate(() => window.__shipcheckViewer?.frames ?? 0);
    await page.waitForTimeout(250);
    const b = await page.evaluate(() => window.__shipcheckViewer?.frames ?? 0);
    if (a === b) return;
  }
}

for (const [w, h] of SIZES) {
  const size = `${w}x${h}`;
  const entry = (log.sizes[size] = { console: [], pageErrors: [], csp: [], shots: [], timings: {} });
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile ?? ''}:${e.lineNumber ?? ''}`));
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) entry.console.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => entry.pageErrors.push(e.message));
  const shot = async (name, opts = {}) => {
    const file = path.join(OUT, `${size}-${name}.png`);
    await (opts.el ? page.locator(opts.el).screenshot({ path: file }) : page.screenshot({ path: file }));
    entry.shots.push(path.relative(ROOT, file));
  };
  try {
    const t0 = Date.now();
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__shipcheck?.viewerReady, null, { timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('#loadingScreen'), null, { timeout: 30000 }).catch(() => {});
    await page.setInputFiles('#drawingFile', FILE);
    await page.waitForSelector('#detail #dwConvert:not([disabled])', { timeout: 120000 });
    await page.waitForSelector('#detail .dw-views tbody tr', { timeout: 120000 });
    entry.timings.read = Date.now() - t0;
    if (want('form')) await shot('form');
    const t1 = Date.now();
    await page.click('#detail #dwConvert');
    // Converted: the report in the right-hand panel, or at least the drawing model loaded and checked.
    await page.waitForFunction(() => /Drawing converted to 3D/.test(document.querySelector('#detail')?.textContent ?? '')
      || (/^Drawing/.test(window.__shipcheck?.sc?.name ?? '') && window.__shipcheck?.results), null, { timeout: 180000 });
    entry.timings.convert = Date.now() - t1;
    await settle(page, 1500);
    entry.reportShown = await page.evaluate(() => /Drawing converted to 3D/.test(document.querySelector('#detail')?.textContent ?? ''));
    if (want('report')) await shot('report', { el: '#detail' });
    for (const v of ['iso', 'top', 'side', 'bow']) {
      if (!want(v)) continue;
      await page.click(`#viewTools [data-view="${v}"]`);
      await settle(page, 1200);
      await shot(v);
    }
    if (want('plan')) {
      await page.click('#planBtn');
      await settle(page);
      await shot('plan');
      await page.click('#planBtn');
      await settle(page);
    }
    const decks = await page.$$eval('#deck option', (o) => o.map((x) => [x.value, x.textContent]));
    entry.decks = decks;
    for (const [value] of decks) {
      if (value === 'all' || !want(value === 'exploded' ? 'exploded' : 'decks')) continue;
      await page.selectOption('#deck', value);
      await page.click('#viewTools [data-view="iso"]');
      await settle(page, 1200);
      await shot(value === 'exploded' ? 'exploded' : `deck-${value}`);
    }
    await page.selectOption('#deck', 'all');
    await page.click('#viewTools [data-view="iso"]');
    await settle(page, 1200);
    if (want('noshell')) {
      await page.click('#viewTools [data-act="shell"]');
      await settle(page);
      await shot('iso-noshell');
      await page.click('#viewTools [data-act="shell"]');
      await settle(page);
    }
    // Overlay: the report's "Overlay on drawing" (opens the sheet with what was recognised drawn over it).
    const overlayBtn = page.locator('#detail #dwShowOverlay');
    if (want('overlay') && await overlayBtn.isVisible().catch(() => false)) {
      await overlayBtn.click();
      await settle(page, 2000);
      await shot('overlay');
    }
    entry.csp = await page.evaluate(() => window.__csp);
  } catch (e) {
    entry.failed = e.message;
    await page.screenshot({ path: path.join(OUT, `${size}-failed.png`) }).catch(() => {});
  }
  await context.close();
  console.log(`${size}: ${entry.shots.length} shots, ${entry.console.length} console, ${entry.pageErrors.length} page errors, ${entry.csp.length} CSP${entry.failed ? `, FAILED: ${entry.failed}` : ''}`);
}
await browser.close();
fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 2));
console.log(`shots in ${path.relative(ROOT, OUT)}`);
