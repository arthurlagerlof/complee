// Head-to-head with SpaceLens on Swiss Dwellings floor plans (CC BY 4.0; local only, gitignored):
//   - the three sample PDFs SpaceLens publishes (tools/drawing-samples/swiss/, with its build-results.json), or
//   - every PDF of a folder (--dir), e.g. the 65 plans of the Stoa preview dataset SpaceLens benchmarks on.
// Independent of our own label matching: every printed "NN.NN m²" text on a plan is a ground-truth area; the room of
// ours that contains the text (smallest containing polygon, mapped to the sheet with the view's toSheet) is compared
// with it. Two counts:
//   strict           every printed area; one we built no room around counts as a miss
//   as SpaceLens     only printed areas inside a room we built (SpaceLens' walls-alone check leaves out rooms its fill
//                    did not find: 390 of its 550 printed areas)
//   node tools/drawing/eval-swiss.mjs [--dir <folder>] [--spacelens <build-results.json>] [--quiet] [--json out.json]
//                                     [--questions <questions.jsonl>] [--one-click] [--scale-from-truth]
// With --questions (the dataset's answer key) door counts are scored too: exact, as the dataset scores counts; the
// SpaceLens column uses the door count it publishes per plan in build-results.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdf } from '../../src/drawing/read-pdf.mjs';
import { convertDrawing } from '../../src/drawing/convert.mjs';
import { findViews } from '../../src/drawing/views.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argOf = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const samples = path.join(here, '..', 'drawing-samples', 'swiss');
const dir = argOf('--dir') ? path.resolve(argOf('--dir')) : samples;
const slFile = argOf('--spacelens') ? path.resolve(argOf('--spacelens')) : path.join(samples, 'build-results.json');
const quiet = process.argv.includes('--quiet');
const jsonOut = argOf('--json');
const TRUE_SCALE = { site1000_bldg2082_floor9385: 200, site1015_bldg2113_floor9557: 200, site1102_bldg2242_floor10281: 100 };
const fixScale = process.argv.includes('--scale-from-truth');
const oneClick = process.argv.includes('--one-click');
if (!fs.existsSync(dir)) { console.log(`Samples ${dir} not found: nothing to evaluate.`); process.exit(0); }
const qFile = argOf('--questions');
const truthOf = new Map(); // file → { doors, windows }
if (qFile) for (const line of fs.readFileSync(path.resolve(qFile), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const q = JSON.parse(line);
  const f = path.basename(q.path);
  const t = truthOf.get(f) ?? {};
  if (/^How many doors \(interior doors and entrance doors together\)/.test(q.question)) t.doors = q.answer;
  if (/^How many windows are drawn/.test(q.question)) t.windows = q.answer;
  truthOf.set(f, t);
}
const sl = fs.existsSync(slFile) ? JSON.parse(fs.readFileSync(slFile, 'utf8')).plans : [];

const AREA = /^\s*(\d+(?:[.,]\d+)?)\s*m\s*[²2]\s*$/;
const inRing = (p, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c; } return c; };
const areaOf = (r) => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) : '—');

const tot = { plans: 0, failed: 0, scaleRead: 0, n: 0, found: 0, ok: 0, errs: [], doorPlans: 0, doorExact: 0, doorAbs: 0, slDoorPlans: 0, slDoorExact: 0, slDoorAbs: 0 };
const msList = [], rows = [];
for (const f of fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.pdf')).sort()) {
  const key = f.replace(/\.pdf$/i, '');
  tot.plans++;
  let sheet, model, recon, report;
  const t0 = Date.now();
  try {
    [sheet] = await readPdf(pdfjs, new Uint8Array(fs.readFileSync(path.join(dir, f))), { file: f });
    const overrides = fixScale && TRUE_SCALE[key] ? { scale: TRUE_SCALE[key] } : {};
    // --one-click: what the engineer does once in the views table: the largest view is the plan, the rest is ignored
    if (oneClick) {
      const vs = findViews(sheet).filter((v) => v.kind !== 'title');
      const big = vs.slice().sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))[0];
      overrides.views = Object.fromEntries(vs.map((v) => [v.id, v === big ? { kind: 'plan' } : { ignore: true }]));
    }
    ({ model, recon, report } = await convertDrawing(sheet, overrides));
  } catch (e) {
    tot.failed++;
    const n = sheet ? sheet.texts.filter((t) => AREA.test(String(t.text))).length : 0;
    tot.n += n;
    rows.push({ file: f, failed: String(e.message).slice(0, 200), printed: n, found: 0, ok: 0 });
    console.log(`${f}: conversion failed (${String(e.message).slice(0, 160)}); ${n} printed areas counted as misses`);
    continue;
  }
  const ms = Date.now() - t0;
  msList.push(ms);
  if (report.scale.basis !== 'assumed') tot.scaleRead++;
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
  let n = 0, ok = 0, found = 0;
  const bad = [];
  for (const t of sheet.texts) {
    const m = AREA.exec(String(t.text));
    if (!m) continue;
    const want = Number(m[1].replace(',', '.'));
    const c = t.box ? [(t.box[0] + t.box[2]) / 2, (t.box[1] + t.box[3]) / 2] : t.c;
    const r = rooms.filter((x) => inRing(c, x.ring)).sort((a, b) => a.sheetArea - b.sheetArea)[0];
    n++;
    if (!r) { bad.push(`${want} m²: no room`); continue; }
    found++;
    const err = (r.area - want) / want;
    tot.errs.push(Math.abs(err));
    if (Math.abs(err) <= 0.02) ok++; else bad.push(`${want} m²: ours ${r.area.toFixed(2)} (${(err * 100).toFixed(1)} %) "${r.name}"`);
  }
  tot.n += n; tot.found += found; tot.ok += ok;
  // the dataset counts door leaves (a double door is two), as SpaceLens does with its door swings: one per swing arc
  const arcIds = new Set(sheet.paths.filter((p) => p.arc).map((p) => p.id));
  const doors = model.elements.filter((e) => e.type === 'door')
    .reduce((n, d) => n + Math.max(1, (d.props?.clear_width?.evidence ?? []).filter((id) => arcIds.has(id)).length), 0);
  const s = sl.find((p) => p.file === f);
  const truth = truthOf.get(f);
  if (truth?.doors != null) {
    tot.doorPlans++; tot.doorAbs += Math.abs(doors - truth.doors); if (doors === truth.doors) tot.doorExact++;
    const slDoors = s?.doorSwings ?? s?.doors; // SpaceLens answers the door question with its door-swing count
    if (slDoors != null) { tot.slDoorPlans++; tot.slDoorAbs += Math.abs(slDoors - truth.doors); if (slDoors === truth.doors) tot.slDoorExact++; }
  }
  rows.push({ truth, file: f, scale: report.scale.value, scaleBasis: report.scale.basis, printed: n, found, ok, doors, rooms: rooms.length, ms, bad,
    spacelens: s ? { rooms: s.rooms, doors: s.doors, windows: s.windows, withPrintedArea: s.withPrintedArea, verified: s.verified, scale: s.scale?.n, ms: s.ms } : null });
  if (quiet) continue;
  console.log(`\n${f}: scale 1:${report.scale.value} [${report.scale.basis}]${s ? ` (SpaceLens 1:${s.scale?.n})` : ''}  ${ms} ms${s ? ` (SpaceLens ${s.ms} ms)` : ''}`);
  console.log(`  printed areas within 2 %: ours ${ok}/${n} (${found} inside a room)`);
  console.log(`  doors: ours ${doors}${s ? `; SpaceLens ${s.doors}` : ''}${truth?.doors != null ? `; truth ${truth.doors}` : ''}; rooms ours ${rooms.length}${s ? `, SpaceLens ${s.rooms}` : ''}`);
  for (const b of bad.slice(0, 12)) console.log(`    ${b}`);
}
const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
console.log(`\nPLANS ${tot.plans}: converted ${tot.plans - tot.failed}, scale read on ${tot.scaleRead}, median ${med(msList)} ms per plan`);
console.log(`STRICT (every printed area; not found = miss): ${tot.ok}/${tot.n} = ${pct(tot.ok, tot.n)} % within 2 %`);
console.log(`AS SPACELENS COUNTS (only areas inside a room we built): ${tot.ok}/${tot.found} = ${pct(tot.ok, tot.found)} % within 2 %, median error ${tot.errs.length ? (100 * med(tot.errs)).toFixed(2) : '—'} %  (SpaceLens: 84.4 % of 390, median 0.32 %)`);
if (tot.doorPlans) console.log(`DOORS exact: ours ${tot.doorExact}/${tot.doorPlans} = ${pct(tot.doorExact, tot.doorPlans)} % (mean miss ${(tot.doorAbs / tot.doorPlans).toFixed(1)} per plan); SpaceLens ${tot.slDoorExact}/${tot.slDoorPlans} = ${pct(tot.slDoorExact, tot.slDoorPlans)} % (mean miss ${tot.slDoorPlans ? (tot.slDoorAbs / tot.slDoorPlans).toFixed(1) : '—'})`);
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ total: { ...tot, errs: undefined, medianMs: med(msList), medianErr: med(tot.errs) }, rows }, null, 1));
