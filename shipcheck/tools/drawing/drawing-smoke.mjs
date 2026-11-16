// End-to-end smoke test of "Drawing → 3D" in a real browser, with the AURORA general arrangement (PDF):
// open the panel, read the PDF, check the views found, convert, read the report, convert again with a typed scale,
// overlay, Esc, download the model and open it again with "Open…", and the plain messages for a scan and a DWG.
//   cd shipcheck && node tools/drawing/drawing-smoke.mjs [--port 8091] [--headed]
// Starts its own server on the port (stopped at the end). Screenshots and log.json go to
// tools/drawing/out/shots/smoke/ (git-ignored). Exit code 1 when a check fails; every failed check is listed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(path.join(ROOT, 'tools', 'export', 'package.json'));
const { chromium } = require('playwright');

const arg = (name, d) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 8091));
const BASE = `http://localhost:${PORT}`;
const AURORA = path.join(ROOT, 'tools', 'drawing-samples', 'aurora_1230-01-01_A_GA.pdf');
const OUT = path.join(HERE, 'out', 'shots', 'smoke');
fs.mkdirSync(OUT, { recursive: true });
const CHROME = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => p && fs.existsSync(p));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail: ok ? '' : String(detail) }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };
const shots = [];
const shot = async (page, name) => { const file = path.join(OUT, `${name}.png`); await page.screenshot({ path: file }); shots.push(file); };

// ---- server ----
const server = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/index.html`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The server did not start on port ${PORT}:\n${serverLog}`);
}

let browser;
const log = { base: BASE, consoleErrors: [], pageErrors: [], csp: [] };
try {
  await waitForServer();
  browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), headless: !process.argv.includes('--headed') });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, acceptDownloads: true });
  await context.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`));
  });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => log.pageErrors.push(e.message));

  // ?noaps: the 3D viewer without the Autodesk model gateway (not needed here, and not available offline).
  await page.goto(`${BASE}/index.html?noaps`);
  await page.waitForFunction(() => window.__shipcheck?.model && document.querySelector('#scenario option'), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const optionsAtStart = await page.$$eval('#scenario option', (o) => o.length);

  // ---- a. open the panel; the button opens the file dialog ----
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), page.click('#drawingBtn')]);
  check('the button opens a file dialog for PDF, DXF and SVG', /\.pdf/.test(await page.getAttribute('#drawingFile', 'accept')));
  check('the drawing panel opens', await page.isVisible('#drawingPanel'));
  check('the findings list folds away while the drawing is open', !(await page.isVisible('#side')));
  await chooser.setFiles(AURORA);

  // ---- b. views ----
  await page.waitForFunction(() => document.querySelectorAll('#detail tr[data-view]').length > 0 && !document.querySelector('#detail #dwConvert')?.disabled, null, { timeout: 90000 });
  await page.waitForTimeout(400);
  const views = await page.$$eval('#detail tr[data-view]', (rows) => rows.map((r) => ({ id: r.dataset.view, kind: r.querySelector('select').value, deck: r.querySelector('input[data-f=deckName]').value || r.querySelector('input[data-f=deckName]').placeholder })));
  const kinds = (k) => views.filter((v) => v.kind === k);
  check('8 views found', views.length === 8, JSON.stringify(views));
  check('2 profiles, 1 section, 5 plans', kinds('profile').length === 2 && kinds('section').length === 1 && kinds('plan').length === 5, JSON.stringify(views.map((v) => v.kind)));
  const wantDecks = ['Below Tanktop', 'Below Main Deck', 'Main Deck', "F'cle Deck", 'Wheel House Top'];
  const decksFound = kinds('plan').map((v) => v.deck);
  check('plan deck names', wantDecks.every((d) => decksFound.includes(d)), JSON.stringify(decksFound));
  const canvasBox = await page.locator('.dw-canvas').boundingBox();
  check('the sheet preview gets most of the width at 1280 × 720', canvasBox && canvasBox.width > 700, JSON.stringify(canvasBox));
  check('the scale is prefilled from the drawing', /100/.test(await page.getAttribute('#dwScale', 'placeholder')));
  await shot(page, '01-preview-1280');

  // ---- c./d. convert ----
  const t0 = Date.now();
  await page.click('#dwConvert');
  await page.waitForFunction(() => document.querySelector('#detail h1')?.textContent === 'Drawing converted to 3D', null, { timeout: 120000 });
  log.convertMs = Date.now() - t0;
  await page.waitForTimeout(1200);
  const scenario = await page.evaluate(() => ({ id: window.__shipcheck.sc.id, name: window.__shipcheck.sc.name, elements: window.__shipcheck.model.elements.length, geometry: window.__shipcheck.sc.geometry?.elements?.size ?? 0 }));
  check('the converted model is the current scenario', /^Drawing: aurora/.test(scenario.name), JSON.stringify(scenario));
  check('it has elements and 3D geometry', scenario.elements > 50 && scenario.geometry > 50, JSON.stringify(scenario));
  check('it is in the model list', (await page.$$eval('#scenario option', (o) => o.map((x) => x.textContent))).some((t) => /^Drawing: aurora/.test(t)));
  check('the drawing panel closed and the 3D view shows', !(await page.isVisible('#drawingPanel')) && await page.isVisible('#threeView canvas'));
  check('the findings list is back', await page.isVisible('#side'));
  const report = await page.innerText('#detail');
  for (const h of ['Scale', 'Decks', 'Geometry check', 'Recognised', 'Measured from the drawing', 'Assumed — check these']) check(`report section "${h}"`, new RegExp(h, 'i').test(report));
  check('report: no [object Object]', !/\[object Object\]/.test(report), report.match(/.{0,60}\[object Object\].{0,30}/)?.[0]);
  check('report: no "undefined"', !/\bundefined\b/.test(report), report.match(/.{0,60}\bundefined\b.{0,30}/)?.[0]);
  check('report: no "NaN"', !/\bNaN\b/.test(report), report.match(/.{0,60}\bNaN\b.{0,30}/)?.[0]);
  check('report: deck sources stated', !/not stated/.test(await page.innerText('#detail .dw-decks')));
  check('report: rooms counted by zone', /\d+ (accommodation|tank|service|working)/.test(report), report.match(/Rooms.{0,120}/)?.[0]);
  check('report: door hint', /check doors against the drawing/.test(report));
  check('report: badges from the check', await page.locator('#detail .badge.st-non_compliant').count() === 1);
  await shot(page, '02-report-3d-1280');

  // ---- back to drawing, typed scale 1:50, convert again: the same scenario is replaced ----
  await page.click('#dwBack');
  await page.waitForSelector('#dwScale');
  await page.fill('#dwScale', '50');
  await page.click('#dwConvert');
  await page.waitForFunction(() => document.querySelector('#detail h1')?.textContent === 'Drawing converted to 3D', null, { timeout: 120000 });
  await page.waitForTimeout(800);
  const again = await page.evaluate(() => window.__shipcheck.sc.id);
  check('converting again replaces the same scenario', again === scenario.id, `${scenario.id} → ${again}`);
  check('no extra entry in the model list', (await page.$$eval('#scenario option', (o) => o.length)) === optionsAtStart + 1);
  const report50 = await page.innerText('#detail');
  check('the typed scale is used and the disagreement is shown', /1 : 50/.test(report50) && /another scale than 1:50/.test(report50), report50.match(/SCALE[\s\S]{0,400}/i)?.[0]);
  await shot(page, '03-report-scale-50');
  // Back to the drawing's own scale for the rest (the overlay should match the sheet).
  await page.click('#dwBack');
  await page.fill('#dwScale', '');
  await page.click('#dwConvert');
  await page.waitForFunction(() => document.querySelector('#detail h1')?.textContent === 'Drawing converted to 3D', null, { timeout: 120000 });
  await page.waitForTimeout(600);

  // ---- overlay, doors only, an unresolved label, Esc ----
  await page.click('#dwShowOverlay');
  await page.waitForTimeout(700);
  check('the overlay opens on the drawing', await page.isVisible('#drawingPanel') && await page.isVisible('#dwLegend'));
  await shot(page, '04-overlay');
  if (await page.locator('#dwShowDoors').count()) {
    await page.click('#dwReportBtn');
    await page.click('#dwShowDoors');
    await page.waitForTimeout(500);
    check('doors-only overlay', /door/.test(await page.innerText('#dwLegend')));
    await shot(page, '05-overlay-doors');
  }
  const show = page.locator('#detail button[data-at]').first();
  if (await show.count()) {
    await page.click('#dwReportBtn');
    await page.locator('#detail button[data-at]').first().click();
    await page.waitForTimeout(700);
    await shot(page, '06-unresolved-zoomed');
  }
  // Hover in the middle of the canvas: a tip appears when something recognised is there (not asserted: depends on the zoom).
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  check('Esc closes the drawing panel', !(await page.isVisible('#drawingPanel')));

  // ---- download the model and open it again with "Open…" ----
  await page.click('#drawingBtn');
  await page.click('#dwReportBtn');
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dwDownload')]);
  const file = path.join(OUT, download.suggestedFilename());
  await download.saveAs(file);
  let json = null;
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { json = null; log.downloadError = e.message; }
  check('"Download model" gives valid ship/1 JSON', json && Array.isArray(json.elements) && Array.isArray(json.decks), log.downloadError);
  await page.keyboard.press('Escape');
  await page.setInputFiles('#openFile', file);
  await page.waitForFunction((n) => window.__shipcheck.sc?.name === `File: ${n}`, download.suggestedFilename(), { timeout: 60000 }).catch(() => {});
  const reopened = await page.evaluate(() => ({ name: window.__shipcheck.sc.name, elements: window.__shipcheck.model.elements.length }));
  check('"Open…" accepts the downloaded model', reopened.name === `File: ${download.suggestedFilename()}` && reopened.elements === json?.elements?.length, JSON.stringify(reopened));

  // ---- error paths: a scan and a DWG ----
  await page.click('#drawingBtn').catch(() => {});
  await page.setInputFiles('#drawingFile', { name: 'scan.png', mimeType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]) });
  await page.waitForFunction(() => /raster image/.test(document.querySelector('#detail')?.innerText ?? ''), null, { timeout: 10000 }).catch(() => {});
  const pngMsg = await page.innerText('#detail');
  check('a PNG scan gets the plain message', /raster image/.test(pngMsg) && /PDF or DXF/.test(pngMsg), pngMsg.slice(0, 300));
  await shot(page, '07-error-png');
  await page.setInputFiles('#drawingFile', { name: 'GA.dwg', mimeType: 'application/octet-stream', buffer: Buffer.from('AC1032\0\0\0\0') });
  await page.waitForFunction(() => /DWG/.test(document.querySelector('#detail')?.innerText ?? ''), null, { timeout: 10000 }).catch(() => {});
  const dwgMsg = await page.innerText('#detail');
  check('a DWG gets the plain message', /Save it as DXF/.test(dwgMsg), dwgMsg.slice(0, 300));

  // ---- the drawing again at a narrow width (820) and at 1280 × 720: nothing overlaps or is cut off ----
  await page.setInputFiles('#drawingFile', AURORA);
  await page.waitForFunction(() => document.querySelectorAll('#detail tr[data-view]').length > 0 && !document.querySelector('#detail #dwConvert')?.disabled, null, { timeout: 90000 });
  for (const [w, h] of [[820, 1000], [1280, 720]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(700);
    const layout = await page.evaluate(() => {
      const r = (s) => document.querySelector(s)?.getBoundingClientRect();
      const stage = r('.dw-stage'), detail = r('#detail'), head = document.querySelector('.dw-head');
      return { scrollW: document.documentElement.scrollWidth, innerW: innerWidth, stage: stage && { w: stage.width, h: stage.height, right: stage.right, bottom: stage.bottom }, detail: detail && { left: detail.left, top: detail.top, w: detail.width },
        headOverflow: head ? head.scrollWidth > head.clientWidth + 1 : null };
    });
    log[`layout${w}`] = layout;
    check(`${w}px: no horizontal scroll`, layout.scrollW <= layout.innerW, JSON.stringify(layout));
    check(`${w}px: the preview has room`, layout.stage && layout.stage.w > 400 && layout.stage.h > 250, JSON.stringify(layout.stage));
    check(`${w}px: the panel header fits`, layout.headOverflow === false, JSON.stringify(layout));
    check(`${w}px: preview and settings do not overlap`, layout.stage && layout.detail && (layout.detail.left >= layout.stage.right - 1 || layout.detail.top >= layout.stage.bottom - 1), JSON.stringify(layout));
    await shot(page, `08-preview-${w}`);
  }
  // Fit, then a resize: the sheet is fitted again (centred and whole), not cut off.
  await page.click('#dwFit');
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.waitForTimeout(600);
  await shot(page, '09-refit-after-resize-1100');
  await page.click('#dwConvert');
  await page.waitForFunction(() => document.querySelector('#detail h1')?.textContent === 'Drawing converted to 3D', null, { timeout: 120000 });
  await page.waitForTimeout(800);
  await shot(page, '10-report-1100');
  await page.setViewportSize({ width: 820, height: 1000 });
  await page.waitForTimeout(600);
  await shot(page, '11-report-820');

  log.csp = await page.evaluate(() => window.__csp);
  check('no CSP violations', !log.csp.length, log.csp.join('; '));
  check('no console errors', !log.consoleErrors.length, log.consoleErrors.slice(0, 5).join(' | '));
  check('no page errors', !log.pageErrors.length, log.pageErrors.slice(0, 5).join(' | '));
} catch (e) {
  check('the flow ran to the end', false, e.stack || e.message);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  log.results = results;
  log.shots = shots;
  fs.writeFileSync(path.join(OUT, 'log.json'), JSON.stringify(log, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} checks passed${log.convertMs ? `; first conversion ${log.convertMs} ms (click to report)` : ''}. Screenshots: ${OUT}`);
  process.exitCode = failed.length ? 1 : 0;
}
