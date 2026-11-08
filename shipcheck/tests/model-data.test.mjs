// Real RCRV model data: imperial parsing, streaming, and the prepared parts file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFeetInch, inchToMM, parseWeightKg, parseOpening } from '../src/units.mjs';
import { streamArray } from '../src/json-stream.mjs';
import { fetchCatalog } from '../src/catalog-api.mjs';

test('feet-inch strings are parsed exactly, unknown text gives null', () => {
  assert.equal(parseFeetInch(`5'-4 9/16"`), 64.5625);
  assert.ok(Math.abs(inchToMM(parseFeetInch(`5'-4 9/16"`)) - 1639.8875) < 0.001);
  assert.equal(parseFeetInch(`5/16"`), 0.3125);
  assert.equal(inchToMM(parseFeetInch(`5/16"`)), 7.938);
  assert.equal(parseFeetInch(`1 1/2"`), 1.5);
  assert.equal(parseFeetInch(`1'-0"`), 12);
  assert.equal(parseFeetInch(`0"`), 0);
  assert.equal(parseFeetInch('T=1"'), null);
  assert.equal(parseFeetInch('ByLayer'), null);
  assert.equal(parseWeightKg('40.3lb'), 18.28);
  assert.equal(parseWeightKg('heavy'), null);
});

test('clear openings are parsed from item names', () => {
  assert.deepEqual(parseOpening('30"X36" QUICK ACTING WATERTIGHT FLUSH HATCH WITH RECESSED SPRING'), { kind: 'rect', w_in: 30, l_in: 36, raw: '30"X36"' });
  assert.deepEqual(parseOpening(`HATCH, CARGO, 5'-0" x 5'-0" FLUSH, HINGED`), { kind: 'rect', w_in: 60, l_in: 60, raw: `5'-0" x 5'-0"` });
  assert.equal(parseOpening('15" ROUND RAISED BOLTED MANHOLE').d_in, 15);
  assert.equal(parseOpening('STEELQUICK ACTING WATERTIGHT HATCH - FLUSH'), null, 'no size in the name: not guessed');
});

test('streamArray yields every object across chunk boundaries, including braces in strings', async () => {
  const items = Array.from({ length: 3000 }, (_, i) => ({ objectid: i, name: `p{${i}}"x"`, nested: { a: [1, { b: '}' }] } }));
  const file = path.join(os.tmpdir(), `shipcheck-stream-${process.pid}.json`);
  fs.writeFileSync(file, JSON.stringify({ data: { type: 'properties', collection: items } }));
  const got = [];
  for await (const o of streamArray(file, 'collection')) got.push(o);
  fs.unlinkSync(file);
  assert.deepEqual(got, items);
});

test('database parts catalog: counts match and values keep their original text', async () => {
  const j = await fetchCatalog('model-rcrv-parts');
  assert.equal(j.parts.length, j.counts.kept);
  assert.equal(j.source.model_unit, 'in');
  const ids = new Set(j.parts.map((p) => p.objectid));
  assert.equal(ids.size, j.parts.length, 'objectid is unique');
  for (const p of j.parts) {
    if (p.thickness) {
      assert.ok(typeof p.thickness.raw === 'string');
      if (p.thickness.mm != null) assert.equal(p.thickness.mm, inchToMM(parseFeetInch(p.thickness.raw)));
    }
  }
  const hatch = j.parts.find((p) => /^30"X36"/.test(p.name));
  assert.deepEqual([hatch.opening.w_mm, hatch.opening.l_mm], [762, 914.4]);
});
