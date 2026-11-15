// IFC import: a synthetic IFC4 frame is converted to a Complee model with real geometry, then checked.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as WebIFC from 'web-ifc';
import { convertIfc, SEMANTIC_TYPES } from '../src/ifc-convert.mjs';
import { syntheticIfc } from '../tools/export/synthetic-ifc.mjs';
import { checkModel, normalizeModel } from '../src/checker.mjs';
import { analyzeEscape } from '../src/escape.mjs';
import { fetchCatalog } from '../src/catalog-api.mjs';

const api = new WebIFC.IfcAPI();
await api.Init();
const source = syntheticIfc({ storeys: 3 });
const convert = () => convertIfc(WebIFC, api, new TextEncoder().encode(source.text), 'frame.ifc');

test('ifc: every element with geometry is imported, on the right storey, in mm', () => {
  const { model, geometry, stats } = convert();
  assert.equal(model.units, 'mm');
  assert.equal(model.elements.length, source.elements);
  assert.equal(stats.elements, source.elements);
  assert.deepEqual(model.decks.map((d) => [d.name, d.elevation]), [['Level 1', 0], ['Level 2', 3600], ['Level 3', 7200]]);
  const ids = new Set(model.elements.map((e) => e.id));
  assert.equal(ids.size, model.elements.length, 'ids are unique');
  for (const e of model.elements) assert.ok(geometry.elements.get(e.id).indices.length >= 36, `${e.id} has triangles`);

  const column = model.elements.find((e) => e.name === 'Column A1 L2');
  assert.equal(column.type, 'column');
  assert.equal(column.deck, 'L02');
  assert.deepEqual(column.geom, { x: -150, y: -150, z: 0, lx: 300, ly: 300, h: 3350 });
  assert.match(column.source, /^IFC IFCCOLUMN #\d+$/);
  // A beam hangs below the slab of the storey above but belongs to the storey it is in.
  assert.equal(model.elements.find((e) => e.name === 'Beam X 1-1 L1').deck, 'L01');
});

test('ifc: FireRating from Pset_DoorCommon becomes fire_rating with its source; other doors stay without one', () => {
  const { model } = convert();
  const doors = model.elements.filter((e) => e.type === 'door');
  const rated = doors.filter((d) => d.props.fire_rating);
  assert.equal(rated.length, 3, 'one fire door per storey');
  assert.deepEqual(rated[0].props.fire_rating, { value: 'A-60', source: 'IFC Pset_DoorCommon.FireRating' });
  assert.ok(doors.length > rated.length);
});

test('ifc: classes map to element types; nothing the rules read is invented', async () => {
  const { model } = convert();
  const byType = {};
  for (const e of model.elements) byType[e.type] = (byType[e.type] || 0) + 1;
  for (const t of ['door', 'stair', 'guard_rail', 'space', 'column', 'beam', 'slab', 'wall']) assert.ok(byType[t] > 0, `${t} present`);
  for (const t of ['door', 'stair', 'guard_rail', 'space']) assert.ok(SEMANTIC_TYPES.has(t));
  // Only what the file states: a door without a FireRating in the file gets nothing besides its class.
  const door = model.elements.find((e) => e.type === 'door' && !e.props.fire_rating);
  assert.deepEqual(Object.keys(door.props), ['ifc_class'], 'no clear width, sill height or zone is made up');
  assert.equal(door.geom.lx, 900);

  const rules = (await fetchCatalog('rules')).rules;
  const out = checkModel(structuredClone(model), rules);
  assert.equal(out.summary.compliant, 0, 'nothing can pass without the values the rules read');
  assert.equal(out.summary.non_compliant, 0);
  // Stairs have a clear-width rule without conditions: the missing value is reported, not guessed.
  const stair = model.elements.find((e) => e.type === 'stair');
  assert.equal(out.elements[stair.id].worst, 'not_enough_info');
  assert.equal(analyzeEscape(normalizeModel(structuredClone(model))).available, false, 'no muster station in the file: no escape analysis');
});

test('ifc: a file without geometry or that is not IFC is rejected with a clear message', () => {
  assert.throws(() => convertIfc(WebIFC, api, new TextEncoder().encode('this is not an ifc file'), 'x.ifc'), /IFC/);
});

test('ifc: a cut-off file is refused; a byte-order mark is accepted', () => {
  const bytes = new TextEncoder().encode(source.text);
  assert.throws(() => convertIfc(WebIFC, api, bytes.subarray(0, Math.floor(bytes.length * 0.9)), 'cut.ifc'), /incomplete/);
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...bytes]);
  assert.ok(convertIfc(WebIFC, api, bom, 'bom.ifc').model.elements.length > 0);
});
