// Browser test of the AutoCAD integration with the bundled catalog (no database):
//   cd shipcheck/tools/export && node --test autocad-smoke.mjs
// Opens demo/autocad-sample.dxf through the Open… button, checks the findings, the import summary, provenance, the
// escape plan and a what-if edit, downloads the AutoCAD markup and reads it back; then a DWG and a foreign DXF.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { parseDxf, shapeBox } from '../../src/dxf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.join(HERE, 'work', 'autocad-smoke');
const SAMPLE = path.resolve(HERE, '../../demo/autocad-sample.dxf');
fs.mkdirSync(SHOTS, { recursive: true });
delete process.env.SHIPCHECK_DATA_API_URL;
process.env.EVIDENCE_PROVIDER = 'none';
const { server } = await import('../../server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const CHROME = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium'].find((p) => p && fs.existsSync(p));
const browser = await chromium.launch({ ...(CHROME ? { executablePath: CHROME } : {}), headless: !process.env.HEADED,
  args: ['--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-gl=angle', '--use-angle=swiftshader'] });
test.after(async () => { await browser.close(); server.closeIdleConnections(); await new Promise((r) => server.close(r)); });
const bundled = (await (await fetch(`${BASE}/api/health`)).json()).catalog_source === 'bundled';

test('open a DXF, review it, write the markup back', { timeout: 180000, skip: !bundled && 'bundled catalog not present' }, async () => {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  try {
    await page.goto(`${BASE}/index.html`);
    await page.waitForFunction(() => window.__shipcheck?.results && window.__shipcheck.viewerReady && !document.querySelector('#loadingScreen'), null, { timeout: 60000 });

    await page.setInputFiles('#openFile', SAMPLE);
    await page.waitForFunction(() => window.__shipcheck.sc?.id.startsWith('file-') && window.__shipcheck.model?.cad, null, { timeout: 30000 });
    const s = await page.evaluate(() => ({
      name: window.__shipcheck.model.name, n: window.__shipcheck.model.elements.length, summary: window.__shipcheck.results.element_summary,
      report: document.querySelector('#detail').innerText, dxfBtn: !document.querySelector('#dxfBtn').hidden, escapeBtn: !document.querySelector('#escapeBtn').hidden,
      option: document.querySelector('#scenario').selectedOptions[0].textContent,
    }));
    assert.equal(s.name, 'Sample workboat (autocad-sample.dxf)');
    assert.equal(s.n, 14);
    assert.equal(s.summary.non_compliant, 3);
    assert.match(s.report, /AutoCAD drawing imported/);
    assert.match(s.report, /14 elements on 2 decks/);
    assert.match(s.report, /MD-CORRIDOR/);
    assert.match(s.report, /Not imported[\s\S]*DIMENSIONS/i);
    assert.ok(s.dxfBtn, 'markup export is offered');
    assert.ok(s.escapeBtn, 'the escape plan works on the imported drawing');
    assert.equal(s.option, 'File: autocad-sample.dxf');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(SHOTS, 'imported.png') });

    // The door finding: value, requirement and where the value comes from in the drawing.
    await page.click('#list .item[data-id="MD-D1"]');
    await page.waitForFunction(() => window.__shipcheck.selected === 'MD-D1');
    const detail = await page.evaluate(() => document.querySelector('#detail').innerText);
    assert.match(detail, /LL-REG12-SILL/);
    assert.match(detail, /300 mm/);
    const prov = await page.evaluate(() => [...document.querySelectorAll('#detail .prov')].map((n) => n.title).join(' | '));
    assert.match(prov, /layer MD-DOOR, entity [0-9A-F]+, attribute SILL_HEIGHT/);
    await page.waitForTimeout(1300);
    await page.screenshot({ path: path.join(SHOTS, 'door-finding.png') });

    // What-if: a 400 mm sill passes; the markup then no longer reports it.
    await page.fill('#dEditor input[data-key="sill_height"]', '400');
    await page.waitForFunction(() => window.__shipcheck.results.elements['MD-D1'].worst === 'compliant');
    await page.click('.resetOne');
    await page.waitForFunction(() => window.__shipcheck.results.elements['MD-D1'].worst === 'non_compliant');

    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#dxfBtn')]);
    assert.match(download.suggestedFilename(), /complee-markup\.dxf$/);
    const file = path.join(os.tmpdir(), `complee-markup-${process.pid}.dxf`);
    await download.saveAs(file);
    const markup = parseDxf(fs.readFileSync(file, 'utf8'));
    fs.rmSync(file, { force: true });
    const frames = markup.entities.filter((e) => e.kind === 'polygon');
    assert.equal(frames.length, 7, 'one frame per checked element');
    assert.deepEqual(shapeBox(frames.find((e) => e.layer === 'COMPLEE_MD_NON_COMPLIANT' && shapeBox(e)[0] === 5900)), [5900, -500, 7000, 500], 'the door frame lies on the block in the drawing');
    assert.ok(markup.entities.some((e) => e.kind === 'text' && /^LL-REG12-SILL: .*required >= 380 mm/.test(e.text)));

    // Guide and sample are served.
    assert.equal((await fetch(`${BASE}/autocad.html`)).status, 200);
    const sample = await fetch(`${BASE}/demo/autocad-sample.dxf`);
    assert.equal(sample.status, 200);
    assert.equal(sample.headers.get('content-type'), 'application/dxf');

    // A DWG and a drawing without the layer convention: the model stays, the message says what to do.
    await page.setInputFiles('#openFile', { name: 'ga.dwg', mimeType: 'application/acad', buffer: Buffer.from('AC1027\0\0\0\0') });
    await page.waitForFunction(() => /SAVEAS/.test(document.querySelector('#detail').innerText));
    await page.setInputFiles('#openFile', { name: 'walls.dxf', mimeType: 'application/dxf', buffer: Buffer.from('0\nSECTION\n2\nENTITIES\n0\nLINE\n8\nWALLS\n10\n0\n20\n0\n11\n5\n21\n5\n0\nENDSEC\n0\nEOF\n') });
    await page.waitForFunction(() => /naming convention/.test(document.querySelector('#detail').innerText));
    assert.match(await page.evaluate(() => document.querySelector('#detail').innerHTML), /autocad\.html/);
    assert.equal(await page.evaluate(() => window.__shipcheck.model.name), 'Sample workboat (autocad-sample.dxf)', 'a failed open keeps the current model');
    assert.deepEqual(errors, [], 'no browser errors');
  } finally { await context.close(); }
});
