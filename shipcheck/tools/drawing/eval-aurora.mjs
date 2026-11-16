// Scorecard of the drawing → model conversion on the AURORA general arrangement (local sample, see
// tools/drawing-samples/README.md) against tools/drawing-samples/aurora.truth.json (read by eye from the drawing).
// Runs the real chain: read-pdf → findViews → interpret → mesh → referee (convertDrawing).
//   node tools/drawing/eval-aurora.mjs [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readPdf } from '../../src/drawing/read-pdf.mjs';
import { convertDrawing } from '../../src/drawing/convert.mjs';
import { normText } from '../../src/drawing/vocab.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const samples = path.join(here, '..', 'drawing-samples');
const truth = JSON.parse(fs.readFileSync(path.join(samples, 'aurora.truth.json'), 'utf8'));
const pdfPath = path.join(samples, truth.file);
if (!fs.existsSync(pdfPath)) { console.log(`Sample ${pdfPath} not found: nothing to evaluate.`); process.exit(0); }

const t0 = Date.now();
const [sheet] = await readPdf(pdfjs, new Uint8Array(fs.readFileSync(pdfPath)), { file: truth.file });
const tRead = Date.now() - t0;
const { model, recon, report } = await convertDrawing(sheet, {});
const tTotal = Date.now() - t0;

const key = (s) => normText(String(s).replace(/\d+(?:[.,]\d+)?\s*m\s*[²2]/gi, ' ')).replace(/\s+/g, ' ').trim();
const r1 = (v) => Math.round(v * 10) / 10;
const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };

out(`AURORA scorecard — ${new Date().toISOString().slice(0, 16)}  (read ${tRead} ms, convert ${tTotal - tRead} ms, total ${tTotal} ms)`);
out(`scale: 1:${report.scale.value} (${report.scale.status}; truth 1:${truth.scale})  bow ${report.bow}  origin: ${report.origin}`);
const p = report.ship || {};
out(`particulars: ${['length_overall', 'length_bp', 'beam', 'depth', 'draft'].map((k) => `${k} ${p[k]?.value ?? '—'}${p[k]?.measured != null ? ` (measured ${p[k].measured})` : ''} / truth ${truth.principal[k]}`).join('; ')}`);
out(`decks: ${report.decks.map((d) => `${d.name}=${d.id} z ${d.elevation} h ${d.height} [${d.basis ?? d.elevation_basis}]`).join(' | ')}`);
out('');

// label coverage
let want = 0, found = 0, typeOk = 0;
const missing = [];
for (const [deckName, dt] of Object.entries(truth.decks)) {
  const deck = report.decks.find((d) => normText(d.name) === normText(deckName));
  const rooms = report.rooms.filter((r) => deck && r.deck === deck.id);
  const pool = rooms.slice();
  for (const t of dt.rooms) {
    for (let k = 0; k < (t.count || 1); k++) {
      want++;
      const i = pool.findIndex((r) => key(r.name) === key(t.label) && (t.printedArea == null || Math.abs((r.area_printed ?? -1) - t.printedArea) < 0.05));
      if (i < 0) { missing.push(`${deckName}: "${t.label}"${t.printedArea ? ` (${t.printedArea} m²)` : ''}`); continue; }
      const r = pool.splice(i, 1)[0];
      found++;
      if (r.type === t.type && (r.zone ?? null) === t.zone) typeOk++; else missing.push(`${deckName}: "${t.label}" found as ${r.type}/${r.zone} (want ${t.type}/${t.zone})`);
    }
  }
  const extra = pool.filter((r) => r.name !== 'Unnamed space' && r.name !== 'Open deck');
  if (extra.length) out(`  ${deckName}: rooms not in the truth: ${extra.map((r) => `"${r.name}"`).join(', ')}`);
}
out(`label coverage: ${found}/${want} labels found as rooms, ${typeOk}/${want} with the right type and zone`);
for (const m of missing) out(`  missing/wrong: ${m}`);

// printed areas
const printed = report.rooms.filter((r) => r.area_printed != null);
const within = (f) => printed.filter((r) => Math.abs(r.area / r.area_printed - 1) <= f).length;
out(`printed areas: ${printed.length} rooms carry one; within 2 %: ${within(0.02)}, within 3 %: ${within(0.03)}`);
for (const r of printed) out(`  ${r.deck} ${r.name}: measured ${r.area} m², printed ${r.area_printed} m² (${r1((r.area / r.area_printed - 1) * 100)} %)`);

// doors, stairs, other counts
const fs500 = truth.frameSpacing;
// door recall / precision per deck: a truth door is found by a door of that deck within 1.5 frames and 0.8 m
const doorCentre = (d) => [d.hinge[0] + d.wallDir[0] * d.width / 2, d.hinge[1] + d.wallDir[1] * d.width / 2];
let dWant = 0, dHit = 0, dFound = 0;
for (const [deckName, dt] of Object.entries(truth.decks)) {
  const deck = report.decks.find((d) => normText(d.name) === normText(deckName));
  const found = recon.doors.filter((d) => deck && d.deck === deck.id).map((d) => ({ d, c: doorCentre(d), used: false }));
  const want = dt.doors ?? [];
  let hit = 0;
  for (const t of want) {
    const m = found.filter((f) => !f.used && Math.abs(f.c[0] / fs500 - t.frame) <= 1.5 && Math.abs(f.c[1] / 1000 - t.y) <= 0.8)
      .sort((a, b) => Math.hypot(a.c[0] / fs500 - t.frame, a.c[1] / 1000 - t.y) - Math.hypot(b.c[0] / fs500 - t.frame, b.c[1] / 1000 - t.y))[0];
    if (m) { m.used = true; hit++; }
  }
  dWant += want.length; dHit += hit; dFound += found.length;
  out(`  doors ${deckName}: ${hit}/${want.length} found, ${found.length - hit} not in the truth`);
}
out(`door recall ${dHit}/${dWant}, precision ${dHit}/${dFound}`);
out(`doors: ${report.doors.length}`);
for (const d of recon.doors) {
  const c = [d.hinge[0] + d.wallDir[0] * d.width / 2, d.hinge[1] + d.wallDir[1] * d.width / 2];
  out(`  ${d.id} ${d.deck} at frame ${r1(c[0] / fs500)}, y ${r1(c[1] / 1000)} m, width ${d.width} mm${d.double ? ' (double)' : ''}`);
}
out(`stairs: ${recon.stairs.map((s) => `${s.id} ${s.treads ?? '?'} treads z ${s.z0}→${s.z1}`).join(' | ')}`);
const unnamed = report.rooms.filter((r) => r.name === 'Unnamed space').length;
const open = report.rooms.filter((r) => r.zone === 'open_deck').length;
out(`unnamed spaces: ${unnamed}; open-deck areas: ${open}; unlabelled small areas (not rooms): ${report.counts?.unlabelled_areas ?? '—'}`);
out(`unresolved: ${report.unresolved.length}; warnings: ${report.warnings.length}; check: ${report.check.length}; assumed: ${report.assumed.length}`);
for (const u of report.unresolved) out(`  unresolved: ${u.what}`);
const ref = report.referee;
out(`referee: ${ref ? `${ref.ok ? 'ok' : 'issues'} — ${ref.issues.length} issue${ref.issues.length === 1 ? '' : 's'}` : 'not available'}`);
for (const i of ref?.issues ?? []) out(`  referee ${i.level ?? i.severity ?? ''}: ${i.text ?? i.message ?? JSON.stringify(i)}`);
out(`elements: ${model.elements.length}`);
const jsonAt = process.argv.indexOf('--json');
if (jsonAt > 0) fs.writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ lines, report, recon }, null, 1));
