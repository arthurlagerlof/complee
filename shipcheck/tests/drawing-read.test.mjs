// Drawing readers: DXF / PDF / SVG -> Sheet (src/drawing/CONTRACT.md section 1). Small hand-written files only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDxf } from '../src/drawing/read-dxf.mjs';
import { readPdf, plausibleWidth } from '../src/drawing/read-pdf.mjs';
import { readSvg } from '../src/drawing/read-svg.mjs';
import { PathBuilder, circleFit, polylineArc, polylineArcRuns, gridIndex, makeSheet, addPath, tessellateArc, arcSweep } from '../src/drawing/sheet.mjs';

const near = (a, b, tol = 1e-6, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} expected ${b}, got ${a}`);
const nearPt = (p, q, tol = 1e-6, msg) => { near(p[0], q[0], tol, msg); near(p[1], q[1], tol, msg); };
const angleNear = (a, b, tol = 1e-6, msg) => near(((a - b + 540) % 360) - 180, 0, tol, msg);

// ---------- DXF ----------

const g = (...pairs) => { let s = ''; for (let i = 0; i < pairs.length; i += 2) s += `${pairs[i]}\n${pairs[i + 1]}\n`; return s; };
function dxf({ insunits, tables = '', blocks = '', entities = '' }) {
  const header = insunits == null ? '' : g(9, '$INSUNITS', 70, insunits);
  return g(0, 'SECTION', 2, 'HEADER') + header + g(0, 'ENDSEC')
    + g(0, 'SECTION', 2, 'TABLES') + tables + g(0, 'ENDSEC')
    + g(0, 'SECTION', 2, 'BLOCKS') + blocks + g(0, 'ENDSEC')
    + g(0, 'SECTION', 2, 'ENTITIES') + entities + g(0, 'ENDSEC') + g(0, 'EOF');
}

test('DXF: a single-bulge two-vertex LWPOLYLINE quarter arc becomes an arc with the right radius', () => {
  const b = Math.tan(Math.PI / 8); // quarter arc: bulge = tan(90° / 4)
  const s = readDxf(dxf({ insunits: 4, entities: g(0, 'LWPOLYLINE', 8, 'DOORS', 90, 2, 70, 0, 10, 1000, 20, 0, 42, b, 10, 0, 20, 1000) }), { file: 'a.dxf' });
  assert.equal(s.paths.length, 1);
  const p = s.paths[0];
  assert.ok(p.arc, 'arc');
  nearPt(p.arc.c, [0, 0], 1e-6);
  near(p.arc.r, 1000, 1e-6);
  near(p.arc.a0, 0, 1e-6); near(p.arc.a1, 90, 1e-6);
  nearPt(p.pts[0], [1000, 0]); nearPt(p.pts[p.pts.length - 1], [0, 1000]);
  // A true arc, not a chord: the midpoint lies on the circle (chord error ≤ 0.5 % of r).
  for (const q of p.pts) near(Math.hypot(q[0], q[1]), 1000, 1e-6);
  assert.ok(p.pts.length >= 9);
  assert.equal(s.unit, 'mm'); assert.equal(s.unitStated, true); assert.equal(s.paper, false);
  assert.equal(p.layer, 'DOORS');
});

test('DXF: nested blocks with rotation and a mirroring scale are expanded with the full transform', () => {
  const blocks = g(0, 'BLOCK', 8, '0', 2, 'INNER', 70, 0, 10, 0, 20, 0)
    + g(0, 'LINE', 8, '0', 10, 0, 20, 0, 11, 10, 21, 0)
    + g(0, 'ARC', 8, '0', 10, 0, 20, 0, 40, 5, 50, 0, 51, 90)
    + g(0, 'ENDBLK')
    + g(0, 'BLOCK', 8, '0', 2, 'OUTER', 70, 0, 10, 0, 20, 0)
    + g(0, 'INSERT', 8, '0', 2, 'INNER', 10, 100, 20, 0, 50, 90)
    + g(0, 'ENDBLK');
  const s = readDxf(dxf({ insunits: 4, blocks, entities: g(0, 'INSERT', 8, 'FURN', 2, 'OUTER', 10, 1000, 20, 1000, 41, -1, 42, 1) }));
  const line = s.paths.find((p) => !p.arc), arc = s.paths.find((p) => p.arc);
  // INNER line (0,0)-(10,0): rotated 90° -> (0,0)-(0,10), moved to (100,0), mirrored in x and placed at (1000,1000).
  nearPt(line.pts[0], [900, 1000], 1e-9); nearPt(line.pts[1], [900, 1010], 1e-9);
  assert.equal(line.block, 'INNER');
  assert.equal(line.layer, 'FURN', 'layer 0 inside a block takes the insert layer');
  // The arc 0°..90° becomes 90°..180° by the rotation, then the mirror turns it into 0°..90° (counter-clockwise).
  nearPt(arc.arc.c, [900, 1000], 1e-9); near(arc.arc.r, 5, 1e-9);
  angleNear(arc.arc.a0, 0, 1e-6); angleNear(arc.arc.a1, 90, 1e-6);
});

test('DXF: dimension geometry is expanded and its text carries the measured value', () => {
  const blocks = g(0, 'BLOCK', 8, '0', 2, '*D1', 70, 1, 10, 0, 20, 0)
    + g(0, 'LINE', 8, '0', 10, 0, 20, 500, 11, 5000, 21, 500)
    + g(0, 'MTEXT', 8, '0', 10, 2500, 20, 600, 40, 250, 71, 5, 1, '5000')
    + g(0, 'ENDBLK');
  const entities = g(0, 'DIMENSION', 8, 'DIM', 2, '*D1', 10, 5000, 20, 500, 11, 2500, 21, 600, 70, 32, 1, '', 42, 4999.99999)
    + g(0, 'DIMENSION', 8, 'DIM', 2, '*D1', 10, 5000, 20, 500, 11, 2500, 21, 900, 70, 32, 1, '<> mm', 42, 4999.99999);
  const s = readDxf(dxf({ insunits: 4, blocks, entities }));
  assert.deepEqual(s.texts.map((t) => t.text), ['5000', '5000 mm'], 'one text per dimension, not the block copy as well');
  assert.equal(s.texts[0].measure, 4999.99999);
  near(s.texts[0].height, 250, 1e-9);
  const c = [(s.texts[0].box[0] + s.texts[0].box[2]) / 2, (s.texts[0].box[1] + s.texts[0].box[3]) / 2];
  near(c[0], 2500, 1); // centred on the text mid point
  assert.equal(s.paths.length, 2);
  assert.equal(s.paths[0].block, '*D1');
});

test('DXF: units, dashed linetypes, lineweight, colours, frozen layers and paper space', () => {
  const tables = g(0, 'TABLE', 2, 'LTYPE', 70, 2)
    + g(0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid', 72, 65, 73, 0, 40, 0)
    + g(0, 'LTYPE', 2, 'DASHED', 70, 0, 3, '__ __', 72, 65, 73, 2, 40, 0.75, 49, 0.5, 49, -0.25)
    + g(0, 'ENDTAB')
    + g(0, 'TABLE', 2, 'LAYER', 70, 3)
    + g(0, 'LAYER', 2, 'HIDDEN', 70, 0, 62, 1, 6, 'DASHED', 370, 50)
    + g(0, 'LAYER', 2, 'OLD', 70, 1, 62, 7, 6, 'CONTINUOUS')
    + g(0, 'LAYER', 2, 'OFF', 70, 0, 62, -3, 6, 'CONTINUOUS')
    + g(0, 'ENDTAB');
  const entities = g(0, 'LINE', 8, 'HIDDEN', 10, 0, 20, 0, 11, 1, 21, 0)
    + g(0, 'LINE', 8, 'HIDDEN', 6, 'CONTINUOUS', 62, 5, 10, 0, 20, 1, 11, 1, 21, 1)
    + g(0, 'LINE', 8, 'OLD', 10, 0, 20, 2, 11, 1, 21, 2)
    + g(0, 'LINE', 8, 'OFF', 10, 0, 20, 3, 11, 1, 21, 3)
    + g(0, 'LINE', 8, 'HIDDEN', 67, 1, 10, 0, 20, 4, 11, 1, 21, 4)
    + g(0, 'TEXT', 8, 'HIDDEN', 10, 0, 20, 0, 11, 0.5, 21, 0.1, 40, 0.1, 72, 1, 1, 'MAIN DECK');
  const s = readDxf(dxf({ insunits: 6, tables, entities }));
  assert.equal(s.unit, 'm'); assert.equal(s.unitStated, true);
  assert.equal(s.paths.length, 2, 'frozen, off and paper-space lines are skipped');
  const [a, b] = s.paths;
  assert.equal(a.dash, true); assert.equal(a.color, '#ff0000');
  near(a.width, 0.0005, 1e-12, 'lineweight 0.50 mm in metres');
  assert.equal(b.dash, false); assert.equal(b.color, '#0000ff');
  assert.ok(s.warnings.some((w) => /2 entities on frozen or switched-off layers/.test(w)), s.warnings.join(' | '));
  assert.ok(s.warnings.some((w) => /1 paper-space/.test(w)));
  const t = s.texts[0];
  assert.equal(t.text, 'MAIN DECK');
  near((t.box[0] + t.box[2]) / 2, 0.5, 1e-9, 'centred text keeps its centre');

  const none = readDxf(dxf({ entities: g(0, 'LINE', 10, 0, 20, 0, 11, 1, 21, 0) }));
  assert.equal(none.unit, 'mm'); assert.equal(none.unitStated, false);
  assert.ok(none.warnings.some((w) => /does not state its unit/.test(w)));
});

test('DXF: SPLINE, ELLIPSE, SOLID, HATCH boundaries, LEADER', () => {
  const entities = g(0, 'SPLINE', 8, 'S', 70, 8, 71, 2, 72, 6, 73, 3, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 10, 0, 20, 0, 10, 50, 20, 100, 10, 100, 20, 0)
    + g(0, 'ELLIPSE', 8, 'E', 10, 0, 20, 0, 11, 200, 21, 0, 40, 0.5, 41, 0, 42, Math.PI)
    + g(0, 'SOLID', 8, 'F', 10, 0, 20, 0, 11, 10, 21, 0, 12, 0, 22, 10, 13, 10, 23, 10)
    + g(0, 'HATCH', 8, 'H', 10, 0, 20, 0, 2, 'SOLID', 70, 1, 71, 0, 91, 1, 92, 2, 72, 0, 73, 1, 93, 4, 10, 0, 20, 0, 10, 50, 20, 0, 10, 50, 20, 50, 10, 0, 20, 50, 97, 0, 75, 0, 76, 1, 98, 0)
    + g(0, 'LEADER', 8, 'L', 76, 3, 10, 0, 20, 0, 10, 10, 20, 10, 10, 20, 20, 10);
  const s = readDxf(dxf({ insunits: 4, entities }));
  const by = (l) => s.paths.filter((p) => p.layer === l);
  const sp = by('S')[0];
  nearPt(sp.pts[0], [0, 0]); nearPt(sp.pts[sp.pts.length - 1], [100, 0]);
  nearPt(sp.pts[Math.floor(sp.pts.length / 2)], [50, 50], 1e-6); // quadratic Bézier apex
  const el = by('E')[0];
  nearPt(el.pts[0], [200, 0], 1e-9); nearPt(el.pts[el.pts.length - 1], [-200, 0], 1e-9);
  assert.ok(el.pts.some((p) => Math.abs(p[1] - 100) < 1e-9), 'top of the ellipse');
  const so = by('F')[0];
  assert.equal(so.fill, true); assert.equal(so.closed, true);
  assert.deepEqual(so.pts, [[0, 0], [10, 0], [10, 10], [0, 10]], 'SOLID corners 1-2-4-3');
  const h = by('H');
  assert.equal(h.length, 1); assert.equal(h[0].fill, true); assert.equal(h[0].pts.length, 4);
  assert.equal(by('L')[0].pts.length, 3);
});

// ---------- PDF ----------

// A minimal valid PDF written by hand: the xref offsets are computed from the bytes.
function makePdf(pages) {
  const objs = [];
  const add = (body) => { objs.push(body); return objs.length; };
  const catalog = add(null), pagesObj = add(null), font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const p of pages) {
    const content = add(`<< /Length ${Buffer.byteLength(p.content, 'latin1')} >>\nstream\n${p.content}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 600 400]${p.rotate ? ` /Rotate ${p.rotate}` : ''} /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

test('PDF: lines, widths, dashes, cm, rectangles, Bézier arcs and merged text come out in page points', async () => {
  const k = 0.5522847498;
  const content = [
    '2 w 10 10 m 110 10 l S',
    '[6 3] 0 d 10 50 m 110 50 l S [] 0 d',
    'q 1 0 0 1 200 100 cm 0.5 w 0 0 m 50 0 l S Q',
    `400 200 m 400 ${200 + 100 * k} ${300 + 100 * k} 300 300 300 c S`,           // quarter circle, c (300,200) r 100
    `50 300 m 50 380 l ${50 + 80 * k} 380 130 ${300 + 80 * k} 130 300 c S`,        // door: leaf + swing in one subpath
    '1 0 0 rg 500 50 80 40 re f',
    'BT /F1 12 Tf 20 360 Td (MAIN) Tj ET',
    'BT /F1 12 Tf 53.4 360 Td (DECK) Tj ET',
    'BT /F1 10 Tf 0 1 -1 0 580 100 Tm (ROTATED) Tj ET',
    'BT /F1 8 Tf 20 250 Td (CABIN 3) Tj ET',
    'BT /F1 8 Tf 150 250 Td (CABIN 4) Tj ET',
    'BT /F1 8 Tf 280 250 Td (HOSPITAL) Tj ET',
    'BT /F1 8 Tf 400 250 Td (6,4 m) Tj ET',
    'BT /F1 5 Tf 420.9 253.5 Td (2) Tj ET', // "6,4 m" is 20.0 pt wide in Helvetica 8 pt
  ].join('\n');
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const sheets = await readPdf(pdfjs, makePdf([{ content }, { content: '10 10 m 110 10 l S', rotate: 90 }]), { file: 't.pdf' });
  assert.equal(sheets.length, 2);
  const s = sheets[0];
  assert.equal(s.unit, 'pt'); assert.equal(s.paper, true); assert.equal(s.source.page, 1); assert.equal(s.source.pages, 2);
  const p = s.paths;
  nearPt(p[0].pts[0], [10, 10], 1e-6); nearPt(p[0].pts[1], [110, 10], 1e-6);
  near(p[0].width, 2, 1e-9); assert.equal(p[0].dash, false); assert.equal(p[0].stroke, true);
  assert.equal(p[1].dash, true);
  nearPt(p[2].pts[0], [200, 100], 1e-6); nearPt(p[2].pts[1], [250, 100], 1e-6); near(p[2].width, 0.5, 1e-9);
  const quarter = p[3];
  assert.ok(quarter.arc, 'Bézier quarter circle -> arc');
  nearPt(quarter.arc.c, [300, 200], 0.1); near(quarter.arc.r, 100, 0.1);
  angleNear(quarter.arc.a0, 0, 0.1); angleNear(quarter.arc.a1, 90, 0.1);
  // The door subpath splits into the leaf (a line) and the swing (an arc of radius 80 about the hinge).
  const leaf = p[4], swing = p[5];
  assert.ok(!leaf.arc); nearPt(leaf.pts[0], [50, 300], 1e-6); nearPt(leaf.pts[leaf.pts.length - 1], [50, 380], 1e-6);
  assert.ok(swing.arc); nearPt(swing.arc.c, [50, 300], 0.1); near(swing.arc.r, 80, 0.1);
  angleNear(swing.arc.a0, 0, 0.1); angleNear(swing.arc.a1, 90, 0.1);
  const rect = p[6];
  assert.equal(rect.fill, true); assert.equal(rect.stroke, false); assert.equal(rect.closed, true); assert.equal(rect.color, '#ff0000');
  assert.deepEqual(rect.pts.map((q) => q.map((v) => Math.round(v))), [[500, 50], [580, 50], [580, 90], [500, 90]]);
  assert.equal(p.length, 7);

  const texts = Object.fromEntries(s.texts.map((t) => [t.text, t]));
  assert.ok(texts['MAIN DECK'], `texts: ${s.texts.map((t) => t.text).join(' | ')}`);
  nearPt(texts['MAIN DECK'].at, [20, 360], 1e-6); near(texts['MAIN DECK'].height, 12, 1e-6); near(texts['MAIN DECK'].angle, 0, 1e-6);
  const rot = texts.ROTATED;
  nearPt(rot.at, [580, 100], 1e-6); near(rot.angle, 90, 1e-6); near(rot.height, 10, 1e-6);
  // Room labels on one baseline but far apart stay separate. pdf.js puts a " " item spanning the gap between
  // them; it must neither join them nor widen the boxes.
  for (const [name, x] of [['CABIN 3', 20], ['CABIN 4', 150], ['HOSPITAL', 280]]) {
    const t = texts[name];
    assert.ok(t, `${name} alone; texts: ${s.texts.map((q) => q.text).join(' | ')}`);
    nearPt(t.at, [x, 250], 1e-6);
    assert.ok(t.box[2] - t.box[0] < name.length * 8 * 0.75, `${name} box width ${t.box[2] - t.box[0]}`);
  }
  // A smaller raised run of digits right after "m" is a superscript.
  assert.ok(texts['6,4 m²'], `texts: ${s.texts.map((q) => q.text).join(' | ')}`);

  // /Rotate 90: the sheet looks as printed (400 wide, 600 high); user (x, y) shows at (y, 600 - x).
  const r = sheets[1];
  assert.deepEqual(r.paperSize.map(Math.round), [400, 600]);
  nearPt(r.paths[0].pts[0], [10, 590], 1e-6); nearPt(r.paths[0].pts[1], [10, 490], 1e-6);
});

// ---------- SVG ----------

test('SVG: transforms, CSS classes, an arc command, text, rect fill and <use> of a symbol', () => {
  const svg = `<?xml version="1.0"?>
<!DOCTYPE svg>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200mm" height="100mm" viewBox="0 0 200 100">
  <style>.wall { stroke: #000; stroke-width: 0.5; fill: none }</style>
  <!-- walls -->
  <g id="Walls" transform="translate(10,10)">
    <line class="wall" x1="0" y1="0" x2="100" y2="0"/>
    <path class="wall" stroke-dasharray="4 2" d="M 0 50 l 40 0 a40 40 0 0140-40"/>
  </g>
  <text x="20" y="80" style="font-size:5px">MAIN <tspan>DECK</tspan></text>
  <rect x="150" y="10" width="20" height="10" fill="red"/>
  <defs><symbol id="s"><circle cx="0" cy="0" r="5" stroke="blue" fill="none"/></symbol></defs>
  <use xlink:href="#s" x="180" y="80"/>
</svg>`;
  const s = readSvg(svg, { file: 't.svg' });
  assert.equal(s.unit, 'mm'); assert.equal(s.unitStated, true); assert.equal(s.paper, true);
  const [line, leaf, swing, rect, circle] = s.paths;
  nearPt(line.pts[0], [10, 90]); nearPt(line.pts[1], [110, 90]);
  assert.equal(line.layer, 'Walls'); near(line.width, 0.5, 1e-9); assert.equal(line.color, '#000000'); assert.equal(line.fill, false);
  nearPt(leaf.pts[0], [10, 40]); nearPt(leaf.pts[1], [50, 40]); assert.equal(leaf.dash, true);
  // "a40 40 0 0 1 40 -40" (flags packed as "01") from local (40,50) to (80,10): with the sweep flag set the centre is
  // local (80,50) -> sheet (90,40). On the y-up sheet it runs clockwise from 180° to 90°, i.e. counter-clockwise
  // from a0 = 90° to a1 = 180°.
  assert.ok(swing.arc, 'arc command -> arc');
  nearPt(swing.arc.c, [90, 40], 1e-9); near(swing.arc.r, 40, 1e-9);
  near(swing.arc.a0, 90, 1e-9); near(swing.arc.a1, 180, 1e-9);
  nearPt(swing.pts[swing.pts.length - 1], [90, 80], 1e-9);
  for (const q of swing.pts) near(Math.hypot(q[0] - swing.arc.c[0], q[1] - swing.arc.c[1]), 40, 1e-6);
  assert.equal(rect.fill, true); assert.equal(rect.color, '#ff0000'); assert.equal(rect.closed, true);
  assert.deepEqual(rect.pts, [[150, 90], [170, 90], [170, 80], [150, 80]]);
  assert.ok(circle.arc); nearPt(circle.arc.c, [180, 20]); near(circle.arc.r, 5); assert.equal(arcSweep(circle.arc), 360);
  assert.equal(circle.color, '#0000ff');
  assert.equal(s.texts.length, 1);
  assert.equal(s.texts[0].text, 'MAIN DECK');
  nearPt(s.texts[0].at, [20, 20]); near(s.texts[0].height, 5);
});

// ---------- sheet helpers ----------

test('sheet: circleFit accepts arcs and rejects other curves; grid index finds paths by box', () => {
  const arc = tessellateArc([5, 5], 10, 30, 120);
  const fit = circleFit(arc);
  nearPt(fit.c, [5, 5], 1e-9); near(fit.r, 10, 1e-9); near(fit.a0, 30, 1e-9); near(fit.a1, 120, 1e-9);
  assert.equal(circleFit(Array.from({ length: 9 }, (_, i) => [i, (i * i) / 4])), null, 'parabola');
  assert.equal(circleFit([[0, 0], [1, 0], [2, 0], [3, 0]]), null, 'line');
  const reversed = circleFit([...arc].reverse());
  near(reversed.a0, 30, 1e-9); near(reversed.a1, 120, 1e-9);

  const s = makeSheet({ format: 'dxf' });
  for (let i = 0; i < 100; i++) addPath(s, [[i * 10, 0], [i * 10, 5]]);
  addPath(s, [[0, 100], [1000, 100]]);
  const ix = gridIndex(s);
  assert.deepEqual(ix.paths([195, -1, 215, 1]), [20, 21]);
  assert.deepEqual(ix.paths([500, 99, 501, 101]), [100]);
  assert.deepEqual([...ix.segments([0, 99, 1, 101])], [100, 0]);

  // Pre-tessellated arcs are arcs; polygons whose corners lie on a circle are not.
  const swing = polylineArc(tessellateArc([0, 0], 800, 0, 90));
  near(swing.r, 800, 1e-6); near(swing.a0, 0, 1e-6); near(swing.a1, 90, 1e-6);
  const octagon = Array.from({ length: 8 }, (_, i) => [Math.cos(i * Math.PI / 4), Math.sin(i * Math.PI / 4)]);
  assert.equal(polylineArc(octagon, true), null);
  assert.equal(arcSweep(polylineArc(tessellateArc([0, 0], 1, 0, 360).slice(0, -1), true)), 360);

  // PDF run widths: a measured width is kept when plausible, else estimated from the characters.
  near(plausibleWidth(27.57, 'CABIN 3', 7.09), 27.57, 1e-12);
  near(plausibleWidth(94, '0', 7), 0.6 * 7, 1e-12, 'a "0" cannot be 94 pt wide at 7 pt');
  near(plausibleWidth(0, 'DECK', 10), 24, 1e-12, 'unknown width');
});

test('a door swing written as one polyline with its leaf: the arc run is cut out as an arc, the leaf stays a line', () => {
  // 90 chords on a quarter circle of radius 900 around (0, 0), then the leaf back to the hinge, as some IFC exporters
  // write a door into a PDF
  const arc = Array.from({ length: 91 }, (_, i) => { const a = (i / 90) * (Math.PI / 2); return [900 * Math.cos(a), 900 * Math.sin(a)]; });
  const runs = polylineArcRuns([...arc, [0, 0]]);
  assert.ok(runs, 'found');
  const arcs = runs.filter((r) => r.arc);
  assert.equal(arcs.length, 1);
  assert.ok(Math.abs(arcs[0].arc.r - 900) < 1 && Math.hypot(arcs[0].arc.c[0], arcs[0].arc.c[1]) < 1, 'radius and centre');
  assert.equal(Math.round(arcSweep(arcs[0].arc)), 90);
  assert.deepEqual(runs.find((r) => !r.arc).pts, [arc[90], [0, 0]], 'the leaf is a line from the arc end to the hinge');
  // no arc: a straight run of equal pieces, and a zigzag of equal pieces
  assert.equal(polylineArcRuns(Array.from({ length: 20 }, (_, i) => [i * 10, 0])), null);
  assert.equal(polylineArcRuns(Array.from({ length: 20 }, (_, i) => [i * 10, (i % 2) * 10])), null);
});

test('arcs in chains of Bézier curves: a circle of four quarters is one arc; a long spline is read in linear time', () => {
  const K = 0.5522847498; // control-point factor of a quarter circle
  const s = makeSheet({ format: 'pdf' });
  const b = new PathBuilder(s);
  const r = 100;
  b.moveTo(r, 0);
  b.curveTo(r, K * r, K * r, r, 0, r); b.curveTo(-K * r, r, -r, K * r, -r, 0);
  b.curveTo(-r, -K * r, -K * r, -r, 0, -r); b.curveTo(K * r, -r, r, -K * r, r, 0);
  b.closePath();
  b.paint({ width: 1, stroke: true, fill: false });
  assert.equal(s.paths.length, 1);
  assert.ok(Math.abs(s.paths[0].arc?.r - r) < 1 && arcSweep(s.paths[0].arc) === 360, 'one full circle');
  // a wavy spline of 3000 curves (text outlines and splines come like this): no arc, and no cubic search
  const s2 = makeSheet({ format: 'pdf' });
  const b2 = new PathBuilder(s2);
  b2.moveTo(0, 0);
  for (let i = 0; i < 3000; i++) b2.curveTo(i * 10 + 3, 4 + (i % 3), i * 10 + 7, -4 - (i % 2), i * 10 + 10, 0);
  const t0 = Date.now();
  b2.paint({ width: 1, stroke: true, fill: false });
  assert.ok(Date.now() - t0 < 2000, `read in ${Date.now() - t0} ms`);
  assert.ok(!s2.paths.some((p) => p.arc && p.arc.r > 1000), 'the spline is no big arc');
});
