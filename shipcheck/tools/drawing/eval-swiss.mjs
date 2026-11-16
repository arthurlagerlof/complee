// Head-to-head with SpaceLens on its three Swiss Dwellings sample PDFs (CC BY 4.0; local only, gitignored, in
// tools/drawing-samples/swiss/ with SpaceLens' build-results.json), independent of our own label matching:
// every printed "NN.NN m²" text on the plan is a ground-truth area; the room of ours that contains the text (smallest
// containing polygon, mapped to the sheet with the view's toSheet) is compared with it. Same metric as SpaceLens'
// "wallFillCheck": share of printed areas matched within 2 % by rooms built from the walls.
//   node tools/drawing/eval-swiss.mjs [--scale-from-truth]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdf } from '../../src/drawing/read-pdf.mjs';
import { convertDrawing } from '../../src/drawing/convert.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'drawing-samples', 'swiss');
const TRUE_SCALE = { site1000_bldg2082_floor9385: 200, site1015_bldg2113_floor9557: 200, site1102_bldg2242_floor10281: 100 };
const DOORS = { site1102_bldg2242_floor10281: 21 }; // dataset answer (SpaceLens eval-results.json)
const fixScale = process.argv.includes('--scale-from-truth');
if (!fs.existsSync(dir)) { console.log(`Samples ${dir} not found: nothing to evaluate.`); process.exit(0); }
const sl = JSON.parse(fs.readFileSync(path.join(dir, 'build-results.json'), 'utf8')).plans;

const inRing = (p, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
const areaOf = (r) => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const tot = { n: 0, ok: 0, found: 0 };
for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.pdf'))) {
  const key = f.replace('.pdf', '');
  const [sheet] = await readPdf(pdfjs, new Uint8Array(fs.readFileSync(path.join(dir, f))), { file: f });
  const t0 = Date.now();
  const { model, recon, report } = await convertDrawing(sheet, fixScale ? { scale: TRUE_SCALE[key] } : {});
  const ms = Date.now() - t0;
  const els = new Map(model.elements.map((e) => [e.id, e]));
  // our rooms on the sheet
  const rooms = [];
  for (const r of recon.rooms) {
    const v = report.views.find((x) => x.deck === r.deck && x.toSheet);
    if (!v) continue;
    const T = v.toSheet;
    const ring = r.polygon.map(([x, y]) => [T[0] * x + T[2] * y + T[4], T[1] * x + T[3] * y + T[5]]);
    const el = els.get(r.id);
    rooms.push({ id: r.id, name: el?.name, ring, sheetArea: areaOf(ring), area: el?.props?.area?.value ?? areaOf(r.polygon) / 1e6 });
  }
  const printed = sheet.texts.map((t) => ({ t, m: String(t.text).match(/^\s*(\d+(?:[.,]\d+)?)\s*m\s*[²2]\s*$/) })).filter((x) => x.m);
  let n = 0, ok = 0, found = 0;
  const bad = [];
  for (const { t, m } of printed) {
    const want = Number(m[1].replace(',', '.'));
    const c = t.box ? [(t.box[0] + t.box[2]) / 2, (t.box[1] + t.box[3]) / 2] : t.c;
    const r = rooms.filter((x) => inRing(c, x.ring)).sort((a, b) => a.sheetArea - b.sheetArea)[0];
    n++;
    if (!r) { bad.push(`${want} m²: no room`); continue; }
    found++;
    const err = (r.area - want) / want;
    if (Math.abs(err) <= 0.02) ok++; else bad.push(`${want} m²: ours ${r.area.toFixed(2)} (${(err * 100).toFixed(1)} %) "${r.name}"`);
  }
  tot.n += n; tot.ok += ok; tot.found += found;
  const doors = model.elements.filter((e) => e.type === 'door').length;
  const s = sl.find((p) => p.file === f);
  console.log(`\n${f}: scale 1:${report.scale.value} [${report.scale.basis}] (true 1:${TRUE_SCALE[key]}; SpaceLens 1:${s?.scale?.n} ${s?.scale?.source})  ${ms} ms (SpaceLens ${s?.ms} ms)`);
  console.log(`  printed areas within 2 %: ours ${ok}/${n} (${found} inside a room)`);
  console.log(`  doors: ours ${doors}; SpaceLens ${s?.doors}${DOORS[key] ? `; dataset truth ${DOORS[key]}` : ''}; rooms ours ${rooms.length}, SpaceLens ${s?.rooms}`);
  for (const b of bad.slice(0, 12)) console.log(`    ${b}`);
}
console.log(`\nTOTAL printed areas within 2 % from our walls: ${tot.ok}/${tot.n} = ${(100 * tot.ok / tot.n).toFixed(1)} %  (SpaceLens wallFillCheck over 65 plans: 84.4 %)`);
