// Browser test of the OCR step of "Drawing → 3D": a drawing whose labels are line work (the 67' pilot boat GA, local
// only in tools/drawing-samples/blind/) is opened; the OCR option is suggested and on; the conversion reads the labels
// in the browser (engine and data from this server, nothing fetched elsewhere) and the report lists them.
// Also: AURORA (real text) must not suggest OCR. No console errors, no CSP violations.
//   cd shipcheck && node tools/drawing/ocr-smoke.mjs [--port 8092] [--headed]
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
const PORT = Number(arg('port', 8092));
const BASE = `http://localhost:${PORT}`;
const PILOT = path.join(ROOT, 'tools', 'drawing-samples', 'blind', 'pilot-boat-67ft-ga.pdf');
const AURORA = path.join(ROOT, 'tools', 'drawing-samples', 'aurora_1230-01-01_A_GA.pdf');
const OUT = path.join(HERE, 'out', 'shots', 'ocr');
fs.mkdirSync(OUT, { recursive: true });
if (!fs.existsSync(PILOT)) { console.log(`Sample ${PILOT} not found: nothing to test.`); process.exit(0); }
const CHROME = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => p && fs.existsSync(p));

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : ` — ${detail}`}`); };
const server = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
let browser;
const log = { consoleErrors: [], pageErrors: [], requests: [] };
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/index.html`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 200)); }
  browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), headless: !process.argv.includes('--headed') });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`)); });
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log.consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => log.pageErrors.push(e.message));
  context.on('request', (r) => log.requests.push(r.url()));
  await page.goto(`${BASE}/index.html?noaps`);
  await page.waitForFunction(() => window.__shipcheck?.model && document.querySelector('#scenario option'), null, { timeout: 60000 });

  // AURORA has real text: no OCR suggested
  await page.setInputFiles('#drawingFile', AURORA);
  await page.waitForFunction(() => document.querySelector('#detail #dwOcr') && !document.querySelector('#detail #dwConvert')?.disabled, null, { timeout: 90000 });
  check('a drawing with real text: OCR not suggested', !(await page.isChecked('#dwOcr')));

  // the pilot boat: labels as line work
  await page.setInputFiles('#drawingFile', PILOT);
  await page.waitForFunction(() => /pilot-boat/.test(document.querySelector('#detail .muted')?.textContent ?? '') && document.querySelector('#detail #dwOcr') && !document.querySelector('#detail #dwConvert')?.disabled, null, { timeout: 120000 });
  check('labels drawn as lines: OCR suggested and on', await page.isChecked('#dwOcr'), await page.textContent('#detail'));
  await page.screenshot({ path: path.join(OUT, '1-settings.png') });
  const t0 = Date.now();
  await page.click('#dwConvert');
  await page.waitForFunction(() => document.querySelector('#dwSteps li[data-s="ocr"]'), null, { timeout: 10000 });
  check('the steps list shows the OCR step', true);
  await page.waitForFunction(() => document.querySelector('#detail h1')?.textContent === 'Drawing converted to 3D' || document.querySelector('#dwFormMsg .dw-error'), null, { timeout: 240000 });
  const err = await page.textContent('#dwFormMsg').catch(() => '');
  check('the conversion with OCR finishes', (await page.textContent('#detail h1')) === 'Drawing converted to 3D', err);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const words = await page.$$eval('#detail .dw-ocr .dw-word', (w) => w.map((x) => x.textContent));
  check('the report lists the words read by OCR', words.length >= 20, `${words.length} words`);
  for (const w of ['Shower', 'Fridge', 'Engine', 'Hatch']) check(`"${w}" read`, words.some((x) => x.includes(w)), words.join(' | '));
  await page.screenshot({ path: path.join(OUT, '2-report.png') });
  const csp = await page.evaluate(() => window.__csp);
  check('engine and data come from this server only', log.requests.filter((u) => /tesseract|traineddata/.test(u)).every((u) => u.startsWith(BASE)), log.requests.filter((u) => /tesseract|traineddata/.test(u)).join(' '));
  check('no CSP violations', !csp.length, csp.join(' | '));
  check('no console errors', !log.consoleErrors.length, log.consoleErrors.slice(0, 5).join(' | '));
  check('no page errors', !log.pageErrors.length, log.pageErrors.slice(0, 5).join(' | '));
  console.log(`\nconversion with OCR: ${secs} s; ${words.length} words: ${words.join(' | ')}`);
} catch (e) {
  check('test ran', false, e.stack);
} finally {
  await browser?.close();
  server.kill();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed. Screenshots: ${OUT}`);
process.exit(failed ? 1 : 0);
