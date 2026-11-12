// AutoCAD integration: DXF -> ship model -> rule check -> DXF markup. The sample drawing (demo/autocad-sample.dxf)
// is written by ezdxf in the AutoCAD 2010 format (tools/autocad/make_sample.py) with three planted findings.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseDxf, shapeBox, writeDxf, plainMText, plainText } from '../src/dxf.mjs';
import { dxfToModel, resultsToDxf, layerRole, parseValue } from '../src/autocad.mjs';
import { checkModel, normalizeModel } from '../src/checker.mjs';
import { analyzeEscape } from '../src/escape.mjs';
import { readBundledCatalog, bundledCatalogEnabled } from '../src/catalog-local.mjs';

const SAMPLE = fs.readFileSync(new URL('../demo/autocad-sample.dxf', import.meta.url), 'utf8');
const dxf = (...pairs) => pairs.map(([c, v]) => `${c}\n${v}\n`).join('');
const wrap = (entities, header = '') => dxf([0, 'SECTION'], [2, 'HEADER']) + header + dxf([0, 'ENDSEC'], [0, 'SECTION'], [2, 'ENTITIES']) + entities + dxf([0, 'ENDSEC'], [0, 'EOF']);
const lw = (layer, pts, extra = '') => dxf([0, 'LWPOLYLINE'], [5, 'A1'], [8, layer], [90, pts.length], [70, 1]) + extra + pts.map(([x, y]) => dxf([10, x], [20, y])).join('');

test('layer names and written values follow the documented convention', () => {
  assert.deepEqual(layerRole('MD-CORRIDOR'), { deck: 'MD', type: 'corridor' });
  assert.deepEqual(layerRole('deck_01|Doors'), { deck: 'DECK-01', type: 'door' });
  assert.deepEqual(layerRole('STAIRS'), { deck: 'DECK', type: 'stair' });
  assert.deepEqual(layerRole('A$MD$GUARDRAIL'), { deck: 'A-MD', type: 'guard_rail' });
  assert.equal(layerRole('DIMENSIONS'), null);
  assert.equal(layerRole('MD-CORRIDOR-TEXT'), null, 'the type is the last part of the name');
  assert.deepEqual(parseValue('850mm'), { value: 850, unit: 'mm' });
  assert.deepEqual(parseValue('37.4 in'), { value: 37.4, unit: 'in' });
  assert.deepEqual(parseValue('36"'), { value: 36, unit: 'in' });
  assert.deepEqual(parseValue('12'), { value: 12 });
  assert.deepEqual(parseValue('YES'), { value: true });
  assert.deepEqual(parseValue('no'), { value: false });
  assert.deepEqual(parseValue('open_deck'), { value: 'open_deck' });
  assert.equal(plainMText('{\\fArial|b0;Mess}\\PCLEAR_WIDTH=900'), 'Mess\nCLEAR_WIDTH=900');
  assert.equal(plainText('%%c50 \\U+00B0'), 'Ø50 °');
});

test('reader: rejects DWG and binary DXF with a way forward, reads R12 polylines, arcs and mirrored entities', () => {
  assert.throws(() => parseDxf('AC1027\0\0\0binary'), /DWG.*Save it as DXF/s);
  assert.throws(() => parseDxf('AutoCAD Binary DXF\r\n\x1a\0'), /binary DXF/);
  assert.throws(() => parseDxf('{"elements":[]}'), /not an ASCII DXF/);
  assert.throws(() => parseDxf(''), /empty/);
  // R12 POLYLINE with VERTEX records, CRLF line ends, a paper-space entity and an unsupported one.
  const r12 = wrap(dxf([0, 'POLYLINE'], [8, 'MD-SPACE'], [66, 1], [70, 1], [10, 0], [20, 0], [30, 0],
    [0, 'VERTEX'], [8, 'MD-SPACE'], [10, 0], [20, 0], [0, 'VERTEX'], [8, 'MD-SPACE'], [10, 4000], [20, 0],
    [0, 'VERTEX'], [8, 'MD-SPACE'], [10, 4000], [20, 3000], [0, 'VERTEX'], [8, 'MD-SPACE'], [10, 0], [20, 3000], [0, 'SEQEND'],
    [0, 'LINE'], [8, 'X'], [67, 1], [10, 0], [20, 0], [11, 1], [21, 1], [0, 'ELLIPSE'], [8, 'X'], [10, 0], [20, 0])).replace(/\n/g, '\r\n');
  const p = parseDxf(r12);
  assert.equal(p.entities.length, 1);
  assert.deepEqual(p.entities[0].points, [[0, 0], [4000, 0], [4000, 3000], [0, 3000]]);
  assert.equal(p.entities[0].closed, true);
  assert.deepEqual(p.ignored, { ELLIPSE: 1 });
  // Arc extent is the arc, not its circle; an entity with extrusion (0,0,-1) is mirrored in x.
  assert.deepEqual(shapeBox({ kind: 'arc', at: [0, 0], r: 10, a0: 0, a1: 90, flip: 1 }).map((v) => Math.round(v) + 0), [0, 0, 10, 10]);
  assert.deepEqual(shapeBox({ kind: 'arc', at: [0, 0], r: 10, a0: 270, a1: 90, flip: 1 }).map((v) => Math.round(v) + 0), [0, -10, 10, 10]);
  const mirrored = parseDxf(wrap(lw('MD-SPACE', [[1000, 0], [3000, 0], [3000, 500], [1000, 500]], dxf([230, -1]))));
  assert.deepEqual(shapeBox(mirrored.entities[0]), [-3000, 0, -1000, 500]);
});

test('units: stated units are used, a unitless drawing is flagged, an unsupported unit is refused', () => {
  const room = lw('MD-SPACE', [[0, 0], [10, 0], [10, 8], [0, 8]]);
  const inches = dxfToModel(wrap(room, dxf([9, '$INSUNITS'], [70, 1])));
  assert.equal(inches.model.units, 'in');
  assert.equal(normalizeModel(structuredClone(inches.model)).elements[0].geom_mm.lx, 254);
  const none = dxfToModel(wrap(room));
  assert.equal(none.model.units, 'mm');
  assert.equal(none.report.units_stated, false);
  assert.match(none.report.warnings.join(' '), /unit not stated/);
  assert.equal(dxfToModel(wrap(room, dxf([9, '$MEASUREMENT'], [70, 0]))).model.units, 'in', 'an imperial drawing without INSUNITS is read in inches');
  assert.throws(() => dxfToModel(wrap(room, dxf([9, '$INSUNITS'], [70, 7]))), /unit.*not supported/);
  assert.throws(() => dxfToModel(wrap(lw('WALLS', [[0, 0], [1, 0], [1, 1]]))), /naming convention/);
});

test('sample drawing: every convention layer is imported with provenance, the rest is reported', () => {
  const { model, report } = dxfToModel(SAMPLE, { filename: 'autocad-sample.dxf' });
  assert.equal(report.version, 'AC1024');
  assert.equal(report.units, 'mm');
  assert.equal(report.decks, 2);
  assert.equal(report.elements, 14);
  assert.deepEqual(report.skipped_layers, [{ layer: 'DIMENSIONS', entities: 2 }]);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(model.decks.map((d) => [d.id, d.name, d.elevation, d.height]), [['MD', 'Main deck', 0, 2700], ['01', '01 level', 2700, 2500]]);
  assert.deepEqual(model.decks[1].cad.origin, [0, 20000]);
  const el = Object.fromEntries(model.elements.map((e) => [e.name, e]));
  // Drawn 20 m up the sheet, placed at the deck's reference origin.
  assert.deepEqual(el['Cabin 1'].geom, { x: 14000, y: 500, lx: 5000, ly: 3000, h: 2400 });
  // Width measured from the drawing, labelled as such; a written value wins.
  const main = el['Main deck corridor'].props.clear_width;
  assert.equal(main.value, 850);
  assert.match(main.source, /measured from the drawing geometry.*layer MD-CORRIDOR, entity [0-9A-F]+.*not a stated clear width/);
  assert.equal(el['Cross corridor'].props.clear_width.value, 1100);
  assert.match(el['Cross corridor'].props.clear_width.source, /\(text\)$/);
  // Block reference: attributes become properties, the id comes from the drawing, scale is applied.
  const door = model.elements.find((e) => e.id === 'MD-D1');
  assert.equal(door.type, 'door');
  assert.deepEqual([door.props.weathertight.value, door.props.sill_height.value, door.props.sill_height.unit], [true, 300, 'mm']);
  assert.match(door.props.sill_height.source, /attribute SILL_HEIGHT$/);
  assert.deepEqual([el['Guard rail, 01 level aft'].geom.lx, el['Guard rail, 01 level aft'].geom.ly], [100, 7000]);
  assert.equal(el['Main stair'].geom.h, 2700, 'the entity thickness is the height');
  assert.equal(el['Muster station'].props.zone.value, 'open_deck');
  assert.deepEqual([model.ship.type.value, model.ship.length_overall.value, model.ship.length_overall.unit, model.ship.class_society.value], ['research', 30, 'm', 'DNV']);
  assert.equal(new Set(model.elements.map((e) => e.id)).size, model.elements.length);
  for (const e of model.elements) assert.match(e.source, /^AutoCAD autocad-sample\.dxf: layer /);
});

test('sample drawing: the planted findings are found, routes connect the decks, and the markup lies on the drawing', { skip: !bundledCatalogEnabled() && 'bundled rule catalog not available' }, () => {
  const { model } = dxfToModel(SAMPLE, { filename: 'autocad-sample.dxf' });
  const rules = readBundledCatalog('rules').rules;
  const out = checkModel(model, rules);
  const failing = Object.values(out.elements).filter((e) => e.worst === 'non_compliant')
    .map((e) => `${e.name}: ${e.results.filter((r) => r.status === 'non_compliant').map((r) => r.rule_id).sort().join('+')}`).sort();
  assert.deepEqual(failing, [
    'Guard rail, 01 level aft: DNV-GUARDRAIL+LL-REG25-GUARDRAIL',
    'Main deck corridor: FSS-13-CORRIDOR',
    'Weathertight door to the working deck: LL-REG12-SILL',
  ]);
  // A value that is neither drawn nor written is missing, not invented.
  const dead = out.elements[model.elements.find((e) => e.name === 'Main deck corridor').id].results.find((r) => r.parameter === 'dead_end_length');
  assert.equal(dead.status, 'not_enough_info');

  const escape = analyzeEscape(normalizeModel(structuredClone(model)));
  assert.equal(escape.available, true);
  const cabin = escape.origins[model.elements.find((e) => e.name === 'Cabin 1').id];
  assert.ok(cabin.primary, 'a cabin on the 01 level reaches the muster station on the main deck');
  assert.ok(cabin.primary.via.includes(model.elements.find((e) => e.name === 'Main stair').id));

  const { dxf: markup, frames, findings } = resultsToDxf(model, out);
  assert.equal(findings, Object.values(out.elements).reduce((n, e) => n + e.results.filter((r) => r.status !== 'compliant').length, 0));
  const back = parseDxf(markup);
  assert.equal(back.header.$ACADVER, 'AC1009');
  assert.equal(back.entities.filter((e) => e.kind === 'polygon').length, frames);
  assert.ok(Object.keys(back.layers).includes('COMPLEE_MD_NON_COMPLIANT') && Object.keys(back.layers).includes('COMPLEE_01_NON_COMPLIANT'));
  assert.equal(back.layers.COMPLEE_MD_NON_COMPLIANT.color, 1);
  // The frame of the 01-level guard rail sits on the block in the source drawing (20 m up the sheet), 50 mm off it.
  const rail = back.entities.find((e) => e.kind === 'polygon' && e.layer === 'COMPLEE_01_NON_COMPLIANT');
  assert.deepEqual(shapeBox(rail), [7950, 16450, 8150, 23550]);
  const texts = back.entities.filter((e) => e.kind === 'text').map((e) => e.text);
  assert.ok(texts.some((t) => /^LL-REG12-SILL: .*300 mm.*required >= 380 mm/.test(t)), 'finding text with measured and required value');
  assert.ok(!/[^\x00-\x7f]/.test(markup), 'the R12 file is plain ASCII');
});

test('writer output is stable and re-readable', () => {
  const text = writeDxf({ layers: [{ name: 'A', color: 1 }], entities: [{ type: 'rect', layer: 'A', box: [0, 0, 10, 5] }, { type: 'text', layer: 'A', at: [1, 2], height: 3, text: 'x ≥ 1\nline' }, { type: 'line', layer: 'A', from: [0, 0], to: [1, 1] }] });
  const p = parseDxf(text);
  assert.deepEqual(p.entities.map((e) => e.kind), ['polygon', 'text', 'line']);
  assert.equal(p.entities[1].text, 'x >= 1 line');
  assert.equal(parseDxf(writeDxf({ layers: [], entities: [{ type: 'text', layer: '0', at: [0, 0], height: 1, text: 'Ø 5°' }] })).entities[0].text, 'Ø 5°', 'other characters round-trip as \\U+XXXX');
  assert.deepEqual(p.ignored, {});
});
