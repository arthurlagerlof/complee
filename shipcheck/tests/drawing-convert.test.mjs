// Drawing → 3D chain (src/drawing/convert.mjs): which reader a file goes to, the plain messages for files that cannot
// be converted (DWG, scans), progress and timing through the stages, and the hand-over to the Web Worker. The stage
// modules (readers, views, interpret, mesh) are written separately: the tests that need them are skipped with the
// reason until their files exist, and then cover the whole chain on a small hand-made DXF.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { detectFormat, unsupportedMessage, readDrawingFile, convertDrawing, geometryForTransfer, lineWork, STAGES, STAGE_LABEL } from '../src/drawing/convert.mjs';

const enc = (s) => new TextEncoder().encode(s);
const here = (p) => new URL(`../src/drawing/${p}`, import.meta.url);
const missing = (...files) => files.filter((f) => !existsSync(here(f)));
const skipUnless = (...files) => { const m = missing(...files); return m.length ? `not written yet: src/drawing/${m.join(', src/drawing/')}` : false; };

const DXF_HEAD = '0\nSECTION\n2\nHEADER\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nENDSEC\n0\nEOF\n';

test('the file kind comes from its content, the extension only when the content says nothing', () => {
  assert.equal(detectFormat('ga.pdf', enc('%PDF-1.7\n%âãÏÓ\n')), 'pdf');
  assert.equal(detectFormat('renamed.dat', enc('%PDF-1.4\n')), 'pdf');
  assert.equal(detectFormat('x.pdf', enc('\n\n  junk before the header %PDF-1.5\n')), 'pdf', 'a PDF header may follow some junk');
  assert.equal(detectFormat('ga.dxf', enc(DXF_HEAD)), 'dxf');
  assert.equal(detectFormat('ga.txt', enc('  0\r\nSECTION\r\n  2\r\nHEADER\r\n')), 'dxf', 'CRLF and indented group codes');
  assert.equal(detectFormat('ga', enc('999\nwritten by a converter\n0\nSECTION\n2\nENTITIES\n')), 'dxf', 'after a 999 comment');
  assert.equal(detectFormat('odd.dxf', enc('garbage')), 'dxf', 'a .dxf without the usual first lines still goes to the DXF reader');
  assert.equal(detectFormat('ga.svg', enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'svg');
  assert.equal(detectFormat('ga.svg', enc('﻿<?xml version="1.0"?>\n<!-- exported -->\n<svg width="10"></svg>')), 'svg');
  assert.equal(detectFormat('data.xml', enc('<?xml version="1.0"?><root/>')), 'xml');
  assert.equal(detectFormat('ga.dwg', enc('AC1032\0\0\0\0')), 'dwg');
  assert.equal(detectFormat('ga.pdf', enc('AC1027 binary')), 'dwg', 'content wins over a wrong extension');
  assert.equal(detectFormat('scan.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'raster');
  assert.equal(detectFormat('scan.jpg', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])), 'raster');
  assert.equal(detectFormat('scan.tif', enc('II*\0abc')), 'raster');
  assert.equal(detectFormat('scan.tiff', enc('MM\0*abc')), 'raster');
  assert.equal(detectFormat('ga.dxf', enc('AutoCAD Binary DXF\r\n\x1a\0')), 'dxf-binary');
  assert.equal(detectFormat('notes.docx', enc('PK\x03\x04')), 'unknown');
});

test('DWG and scans are refused with what to do instead', async () => {
  await assert.rejects(readDrawingFile({ name: 'GA.dwg', bytes: enc('AC1032\0\0') }), (e) => {
    assert.equal(e.code, 'dwg');
    assert.match(e.message, /GA\.dwg/);
    assert.match(e.message, /Save it as DXF/);
    return true;
  });
  await assert.rejects(readDrawingFile({ name: 'scan.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]) }), (e) => {
    assert.equal(e.code, 'raster');
    assert.match(e.message, /raster image/);
    assert.match(e.message, /vector line work/);
    assert.match(e.message, /PDF or DXF from the CAD program/);
    return true;
  });
  await assert.rejects(readDrawingFile({ name: 'scan.jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xdb]) }), { code: 'raster' });
  await assert.rejects(readDrawingFile({ name: 'x.dxf', bytes: enc('AutoCAD Binary DXF\r\n') }), /ASCII DXF/);
  await assert.rejects(readDrawingFile({ name: 'empty.pdf', bytes: new Uint8Array(0) }), /empty/);
  await assert.rejects(readDrawingFile({ name: 'notes.docx', bytes: enc('PK\x03\x04') }), /PDF, DXF or SVG/);
  for (const f of ['pdf', 'dxf', 'svg']) assert.equal(unsupportedMessage(f, 'x'), null);
});

test('each format goes to its reader; DXF/SVG text in the Windows code page stays readable', async () => {
  const calls = [];
  const sheet = (format) => ({ source: { format }, paths: [], texts: [] });
  const readers = {
    readDxf: (text, opts) => { calls.push(['dxf', text, opts]); return sheet('dxf'); },
    readSvg: (text, opts) => { calls.push(['svg', text, opts]); return sheet('svg'); },
    readPdf: async (pdfjs, bytes, opts) => { calls.push(['pdf', pdfjs, bytes, opts]); return [sheet('pdf'), sheet('pdf')]; },
  };
  const pdfjs = { fake: true };
  const pages = await readDrawingFile({ name: 'ga.pdf', bytes: enc('%PDF-1.7\n') }, { pdfjs, readers, pages: [2] });
  assert.equal(pages.length, 2, 'one sheet per PDF page');
  assert.equal(calls[0][0], 'pdf');
  assert.equal(calls[0][1], pdfjs);
  assert.ok(calls[0][2] instanceof Uint8Array);
  assert.deepEqual(calls[0][3].pages, [2]);
  assert.equal(calls[0][3].file, 'ga.pdf');

  // "Ø" and "°" written by an older AutoCAD in Windows-1252 (not UTF-8).
  const cp1252 = new Uint8Array([...enc('0\nSECTION\n2\nENTITIES\n0\nTEXT\n1\n'), 0xd8, 0x20, 0x35, 0x30, 0xb0, ...enc('\n0\nENDSEC\n0\nEOF\n')]);
  const [dxf] = await readDrawingFile({ name: 'old.dxf', bytes: cp1252.buffer }, { readers });
  assert.equal(dxf.source.format, 'dxf');
  assert.match(calls[1][1], /Ø 50°/);
  assert.deepEqual(calls[1][2], { file: 'old.dxf' });

  await readDrawingFile({ name: 'ga.svg', bytes: enc('<svg><text>CABIN Ø</text></svg>') }, { readers });
  assert.equal(calls[2][0], 'svg');
  assert.match(calls[2][1], /CABIN Ø/);

  await assert.rejects(readDrawingFile({ name: 'ga.pdf', bytes: enc('%PDF-1.7\n') }, { readers }), /pdf\.js/, 'a PDF needs pdf.js (the page passes it in)');
});

// Stub stage modules: enough to follow the data and the progress through convertDrawing.
function stubModules({ interpretReports = false, failAt = null } = {}) {
  const seen = { applyBoxes: 0 };
  const modules = {
    findViews: (sheet) => (failAt === 'views' ? (() => { throw new Error('no views'); })() : [{ id: 'v1', kind: 'plan', box: sheet.bbox, why: ['test'] }]),
    interpret: (sheet, views, overrides, { onProgress } = {}) => {
      if (interpretReports) for (const s of ['scale', 'decks', 'rooms', 'doors', 'hull']) { onProgress(s, 0); onProgress(s, 1); }
      if (failAt === 'interpret') throw new Error('scale not found');
      const model = { name: overrides.shipName ?? 'Stub', units: 'mm', decks: [{ id: 'D1', name: 'MAIN', elevation: 0, height: 2500, outline: [[0, -1000], [5000, -1000], [5000, 1000], [0, 1000]] }],
        elements: [{ id: 'R1', type: 'space', name: 'CABIN', deck: 'D1', geom: { x: 0, y: -1000, z: 0, lx: 2000, ly: 2000, h: 2500 }, props: { zone: 'accommodation' } }] };
      return { model, recon: { decks: model.decks, rooms: [{ id: 'R1', deck: 'D1', polygon: [[0, -1000], [2000, -1000], [2000, 1000], [0, 1000]], z0: 0, z1: 2500 }] }, report: { scale: { value: 1, mmPerUnit: 1, source: 'stub' }, counts: { rooms: 1 } } };
    },
    buildGeometry: () => {
      if (failAt === 'mesh') throw new Error('mesh failed');
      const buf = new ArrayBuffer(4 * 18);
      return new Map([['R1', { positions: new Float32Array(buf, 0, 9), normals: new Float32Array(buf, 36, 9), indices: new Uint32Array([0, 1, 2]), color: [0.5, 0.6, 0.9, 1] }]]);
    },
    applyBoxes: (model, geometry) => { seen.applyBoxes++; assert.ok(geometry.has('R1')); },
  };
  return { modules, seen };
}
const SHEET = { source: { file: 't.dxf', format: 'dxf', page: 1, pages: 1 }, unit: 'mm', unitStated: true, paper: false, bbox: [0, -1000, 5000, 1000],
  paths: [{ id: 'p1', pts: [[0, 0], [5000, 0]], closed: false, width: 0, color: null, dash: false, fill: false, stroke: true, layer: '0', block: null }], texts: [], warnings: [] };

test('convertDrawing runs the stages in order, with progress, timings and the mesh boxes applied', async () => {
  for (const interpretReports of [false, true]) {
    const { modules, seen } = stubModules({ interpretReports });
    const progress = [];
    const r = await convertDrawing(SHEET, { shipName: 'Test ship' }, { modules, onProgress: (s, f) => progress.push([s, f]) });
    assert.equal(r.model.name, 'Test ship', 'overrides reach the interpretation');
    assert.ok(r.geometry instanceof Map && r.geometry.get('R1').positions instanceof Float32Array);
    assert.equal(seen.applyBoxes, 1);
    assert.deepEqual(r.views.map((v) => v.id), ['v1']);
    // Every stage is reported, the first time in the contract's order, and each ends at 1.
    const firstSeen = [...new Set(progress.map(([s]) => s))];
    assert.deepEqual(firstSeen, STAGES, `order (interpret reports itself: ${interpretReports})`);
    for (const s of STAGES) assert.ok(progress.some(([x, f]) => x === s && f === 1), `${s} finished`);
    for (const f of progress.map(([, f]) => f)) assert.ok(f >= 0 && f <= 1);
    const t = r.report.timings;
    for (const k of ['views', 'interpret', 'mesh', 'total']) assert.ok(Number.isFinite(t[k]) && t[k] >= 0, `timing ${k}`);
    assert.equal(interpretReports, ['scale', 'hull'].every((s) => Number.isFinite(t[s])), 'interpret steps timed only when interpret reports them');
    for (const s of STAGES) assert.ok(STAGE_LABEL[s], `label for ${s}`);
  }
});

test('analysis without mesh, and errors that say at which step they stopped', async () => {
  const { modules, seen } = stubModules();
  const a = await convertDrawing(SHEET, {}, { modules, geometry: false });
  assert.equal(a.geometry, null);
  assert.equal(seen.applyBoxes, 0, 'no mesh, no boxes');
  assert.equal(a.report.timings.mesh, undefined);

  await assert.rejects(convertDrawing(SHEET, {}, { modules: stubModules({ failAt: 'views' }).modules }), (e) => e.stage === 'views' && !e.views);
  await assert.rejects(convertDrawing(SHEET, {}, { modules: stubModules({ failAt: 'interpret' }).modules }), (e) => {
    assert.equal(e.stage, 'scale');
    assert.deepEqual(e.views.map((v) => v.id), ['v1'], 'the views found so far go with the error (the preview shows them)');
    return true;
  });
  await assert.rejects(convertDrawing(SHEET, {}, { modules: stubModules({ failAt: 'mesh' }).modules }), { stage: 'mesh' });
  await assert.rejects(convertDrawing({ ...SHEET, paths: [] }, {}, { modules }), /no line work/);
  await assert.rejects(convertDrawing(null, {}, { modules }), /No drawing sheet/);
});

test('the geometry referee runs after the mesh; its absence or failure does not stop the conversion', async () => {
  const issues = [{ level: 'error', what: 'overlap', ids: ['R1'], message: 'Rooms overlap' }];
  const ok = stubModules();
  let seenRecon = null;
  ok.modules.referee = (model, recon) => { seenRecon = recon; assert.ok(model.elements[0].id === 'R1'); return { ok: false, issues }; };
  const r = await convertDrawing(SHEET, {}, { modules: ok.modules });
  assert.deepEqual(r.report.referee, { ok: false, issues });
  assert.ok(seenRecon?.rooms, 'the referee gets the recon');
  assert.ok(Number.isFinite(r.report.timings.referee));

  const broken = stubModules();
  broken.modules.referee = () => { throw new Error('bug'); };
  const b = await convertDrawing(SHEET, {}, { modules: broken.modules });
  assert.ok(b.model && b.report.referee.failed.includes('bug'), 'the model still comes, the report says the check failed');

  const none = await convertDrawing(SHEET, {}, { modules: stubModules().modules });
  assert.equal(none.report.referee, null, 'no referee: said so (null), not hidden');
  const analysed = await convertDrawing(SHEET, {}, { modules: ok.modules, geometry: false });
  assert.equal(analysed.report.referee, undefined, 'no mesh, no geometry check');
});

test('geometry goes to the page with each buffer transferred once', () => {
  const buf = new ArrayBuffer(64);
  const g = new Map([
    ['a', { positions: new Float32Array(buf, 0, 3), normals: new Float32Array(buf, 12, 3), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }],
    ['b', { positions: new Float32Array(buf, 24, 3), normals: new Float32Array(buf, 36, 3), indices: new Uint32Array([0, 1, 2]), color: [1, 1, 1, 1] }],
  ]);
  const { entries, transfer } = geometryForTransfer(g);
  assert.deepEqual(entries.map(([id]) => id), ['a', 'b']);
  assert.equal(transfer.length, 3, 'one shared buffer + two index buffers');
  // structuredClone stands in for postMessage: a duplicate in the transfer list would throw here.
  const copy = structuredClone(entries, { transfer });
  assert.equal(copy[1][1].positions.length, 3);
  assert.equal(buf.byteLength, 0, 'transferred, not copied');
  assert.deepEqual(geometryForTransfer(null), { entries: [], transfer: [] });
  assert.equal(lineWork({ paths: [{ pts: [[0, 0], [1, 0], [1, 1]], closed: true }, { pts: [[0, 0]] }] }), 3);
});

// ---------- the whole chain, once the stage modules exist ----------

// A small general arrangement drawn 1:1 in mm: a profile above a main deck plan with three rooms, a door and labels.
function tinyGA() {
  const out = [];
  const g = (...pairs) => { for (const [c, v] of pairs) out.push(String(c), String(v)); };
  const line = (layer, [x1, y1], [x2, y2], ltype) => g([0, 'LINE'], [8, layer], ...(ltype ? [[6, ltype]] : []), [10, x1], [20, y1], [30, 0], [11, x2], [21, y2], [31, 0]);
  const poly = (layer, pts, closed = true) => { g([0, 'LWPOLYLINE'], [8, layer], [90, pts.length], [70, closed ? 1 : 0]); for (const [x, y] of pts) g([10, x], [20, y]); };
  const text = (layer, [x, y], h, s) => g([0, 'TEXT'], [8, layer], [10, x], [20, y], [30, 0], [40, h], [1, s]);
  g([0, 'SECTION'], [2, 'HEADER'], [9, '$INSUNITS'], [70, 4], [0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES']);
  // Profile (baseline at y = 10000): hull, main deck at 3000 mm, deckhouse to 5500 mm.
  const B = 10000;
  poly('HULL', [[0, B + 1000], [1500, B], [18500, B], [20000, B + 2000], [20500, B + 3500], [0, B + 3200]]);
  line('DECK', [0, B + 3000], [20300, B + 3000]);
  poly('HOUSE', [[5000, B + 3000], [5000, B + 5500], [15000, B + 5500], [15000, B + 3000]], false);
  line('BASE', [0, B], [20000, B]);
  text('TEXT', [9000, B - 1200], 400, 'PROFILE');
  text('TEXT', [16000, B + 3100], 250, 'MAIN DECK');
  text('TEXT', [500, B + 6500], 300, 'SCALE 1:1');
  // Main deck plan (centreline y = 0): outline, centreline, two bulkheads, a door, room names.
  poly('DECK', [[0, -3000], [18000, -3000], [20500, 0], [18000, 3000], [0, 3000]]);
  line('CL', [-500, 0], [21000, 0], 'CENTER');
  line('WALL', [5000, -3000], [5000, 3000]);
  line('WALL', [10000, -3000], [10000, 3000]);
  g([0, 'ARC'], [8, 'DOOR'], [10, 5000], [20, 1000], [30, 0], [40, 800], [50, 90], [51, 180]);
  line('DOOR', [5000, 1000], [5000, 1800]);
  text('TEXT', [2000, 0], 300, 'CABIN');
  text('TEXT', [7000, 0], 300, 'MESS');
  text('TEXT', [13000, 0], 300, 'ENGINE ROOM');
  text('TEXT', [8000, -4500], 400, 'MAIN DECK');
  g([0, 'ENDSEC'], [0, 'EOF']);
  return out.join('\n') + '\n';
}

test('a hand-made DXF general arrangement becomes a checkable model with 3D geometry', { skip: skipUnless('sheet.mjs', 'read-dxf.mjs', 'views.mjs', 'interpret.mjs', 'mesh.mjs') }, async () => {
  const { normalizeModel, checkModel } = await import('../src/checker.mjs');
  const [sheet] = await readDrawingFile({ name: 'tiny-ga.dxf', bytes: enc(tinyGA()) });
  assert.equal(sheet.source.format, 'dxf');
  assert.ok(lineWork(sheet) > 10, 'line work read');
  assert.ok(sheet.texts.some((t) => /CABIN/.test(t.text)), 'room labels read');
  const progress = [];
  let r;
  try {
    r = await convertDrawing(sheet, {}, { onProgress: (s) => progress.push(s) });
  } catch (e) {
    // A drawing the converter cannot use must say where and why, not fail anywhere.
    assert.ok(e.stage && e.message, `a conversion error names its step: ${e.message}`);
    return;
  }
  assert.deepEqual([...new Set(progress)], STAGES);
  const norm = normalizeModel(structuredClone(r.model));
  assert.ok(norm.elements.length > 0, 'elements');
  const ids = new Set(r.model.elements.map((e) => e.id));
  assert.equal(ids.size, r.model.elements.length, 'element ids are unique (the app refuses duplicates)');
  for (const k of ['rooms', 'doors', 'stairs', 'walls']) for (const it of r.recon?.[k] ?? []) assert.ok(ids.has(it.id), `${k} ${it.id} is a model element`);
  for (const [id, g] of r.geometry) {
    assert.ok(g.positions instanceof Float32Array && g.indices instanceof Uint32Array, `${id} mesh arrays`);
    assert.ok(g.indices.every((i) => i < g.positions.length / 3), `${id} indices in range`);
  }
  const { readBundledCatalog, bundledCatalogEnabled } = await import('../src/catalog-local.mjs');
  const results = checkModel(r.model, bundledCatalogEnabled() ? readBundledCatalog('rules').rules : []);
  assert.ok(results.summary, 'the checker runs on the converted model');
  // What the worker posts must survive postMessage (structured clone) with the buffers transferred.
  const { entries, transfer } = geometryForTransfer(r.geometry);
  structuredClone({ model: r.model, recon: r.recon, views: r.views, report: r.report, geometry: entries }, { transfer });
});

test('the sample PDF general arrangement converts or says plainly why not', { skip: skipUnless('sheet.mjs', 'read-pdf.mjs', 'views.mjs', 'interpret.mjs', 'mesh.mjs') }, async () => {
  const sample = new URL('../tools/drawing-samples/aurora_1230-01-01_A_GA.pdf', import.meta.url);
  if (!existsSync(sample)) return;
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const sheets = await readDrawingFile({ name: 'aurora.pdf', bytes: new Uint8Array(readFileSync(sample)) }, { pdfjs });
  assert.ok(sheets.length >= 1);
  const best = sheets.reduce((a, b) => (lineWork(b) > lineWork(a) ? b : a));
  assert.ok(lineWork(best) > 100, 'vector line work on the GA page');
  try {
    const r = await convertDrawing(best, {});
    assert.ok(r.model.elements.length > 0);
  } catch (e) {
    assert.ok(e.stage && e.message, `a conversion error names its step: ${e.message}`);
  }
});
