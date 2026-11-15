// Missing, unusable or contradictory data never gives "no deviation": each case below once did (review of 15 Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkModel, findingsOf } from '../src/checker.mjs';

const RULES = JSON.parse(fs.readFileSync(new URL('../catalog/rules.json', import.meta.url), 'utf8')).rules;
const OUTLINE = [[0, 0], [100000, 0], [100000, 30000], [0, 30000]];
const ship = (extra = {}) => ({ type: 'passenger', operating_area: ['US'], length_overall: { value: 100, unit: 'm' }, beam: { value: 30, unit: 'm' }, ...extra });
const model = (elements, shipExtra) => ({ name: 't', units: 'mm', ship: ship(shipExtra), decks: [{ id: 'D', name: 'Deck', outline: OUTLINE, height: 2800 }], elements: elements.map((e) => (e && typeof e === 'object' ? { deck: 'D', name: e.id, ...e } : e)) });
const res = (out, id, rule) => out.elements[id]?.results.find((r) => r.rule_id === rule);

test('a rule whose scope depends on a missing value is open, not "not applicable"', () => {
  const low = res(checkModel(model([{ id: 'd', type: 'door', props: { sill_height: 100 } }]), RULES), 'd', 'LL-REG12-SILL');
  assert.equal(low.status, 'not_enough_info');
  assert.equal(low.applicability, 'unknown');
  assert.match(low.explanation, /weathertight is not set.*If it applies: sill_height is 100 mm/);
  // Met either way: no finding, but the open scope is still stated.
  const high = res(checkModel(model([{ id: 'd', type: 'door', props: { sill_height: 400 } }]), RULES), 'd', 'LL-REG12-SILL');
  assert.equal(high.status, 'compliant');
  assert.match(high.explanation, /met either way/);
  // Stated as not weathertight: not applicable, as before.
  const out = checkModel(model([{ id: 'd', type: 'door', props: { weathertight: false, sill_height: 100 } }]), RULES);
  assert.equal(res(out, 'd', 'LL-REG12-SILL'), undefined);
  // A presence condition ({ exists }) is decided by the missing value: data-quality rules stay off.
  assert.equal(res(out, 'd', 'DQ-DESIGN-STATUS'), undefined);
});

test('vocabulary is compared without case: "Corridor", "lng", "us", "Passenger"', () => {
  const out = checkModel(model([
    { id: 'c', type: 'Corridor', props: { clear_width: 800 } },
    { id: 't', type: 'fuel_tank', geom: { x: 40000, y: 10000, lx: 10000, ly: 10000, h: 2800 }, props: { fuel: 'lng' } },
  ], { type: 'Passenger', operating_area: ['us'] }), RULES);
  assert.equal(res(out, 'c', 'FSS-13-CORRIDOR').status, 'non_compliant');
  assert.ok(res(out, 't', 'IGF-5.3.3-SIDE'));
  assert.ok(res(out, 'c', 'SOLAS-II-2-13-DEADEND-PAX'));
});

test('unknown or unusable ship particulars leave a rule open instead of switching it off', () => {
  const corridor = [{ id: 'c', type: 'corridor', props: { clear_width: 1000, dead_end_length: 20000 } }];
  for (const type of ['cruise', 'ro-pax', '']) {
    const r = res(checkModel(model(corridor, { type }), RULES), 'c', 'SOLAS-II-2-13-DEADEND-PAX');
    assert.equal(r?.status, 'not_enough_info', `ship type "${type}"`);
  }
  const door = [{ id: 'd', type: 'door', props: { weathertight: true, sill_height: 300 } }];
  for (const length_overall of ['abc', { value: 'x', unit: 'm' }, { value: 30, unit: 'yd' }, { value: -5, unit: 'm' }, 60]) {
    const r = res(checkModel(model(door, { length_overall }), RULES), 'd', 'LL-REG12-SILL');
    assert.equal(r?.status, 'not_enough_info', `length ${JSON.stringify(length_overall)}`);
  }
  // A clear size below the scope still decides: 20 m is below 24 m.
  assert.equal(res(checkModel(model(door, { length_overall: { value: 20, unit: 'm' } }), RULES), 'd', 'LL-REG12-SILL'), undefined);
});

test('adjacency: unknown zones, missing spaces and incomplete geometry are open; a declared list does not hide geometry', () => {
  const tank = (extra = {}) => ({ id: 't', type: 'fuel_tank', geom: { x: 40000, y: 10000, lx: 10000, ly: 10000, h: 2800 }, props: { fuel: 'LNG' }, ...extra });
  const cabin = (props, geom = { x: 50000, y: 10000, lx: 5000, ly: 10000, h: 2800 }) => ({ id: 'cab', type: 'space', geom, props });
  const status = (els) => res(checkModel(model(els), RULES), 't', 'IGF-LNG-LOCATION').status;
  assert.equal(status([tank(), cabin({})]), 'not_enough_info', 'neighbour without a zone');
  assert.equal(status([tank(), cabin({ zone: 'Passenger' })]), 'non_compliant', 'zone in another case');
  assert.equal(status([tank(), cabin({ zone: 'passenger' }, { x: 50000, y: 10000, lx: 5000, ly: 10000 })]), 'non_compliant', 'no height: the deck height applies');
  assert.equal(status([tank({ props: { fuel: 'LNG', adjacent: [] } }), cabin({ zone: 'passenger' })]), 'non_compliant', 'empty declared list');
  assert.equal(status([tank({ geom: undefined, props: { fuel: 'LNG', adjacent: ['ghost'] } })]), 'not_enough_info', 'declared space not in the model');
  assert.equal(status([tank({ geom: { x: 40000, y: 10000, lx: 'a', ly: 10000, h: 2800 } }), cabin({ zone: 'passenger' })]), 'not_enough_info', 'tank geometry not a number');
  assert.equal(status([tank(), cabin({ zone: 'passenger' }, { x: 80000, y: 1000 })]), 'not_enough_info', 'a passenger space without geometry could be next door');
  assert.equal(status([tank(), cabin({ zone: 'machinery' })]), 'compliant');
});

test('distance to the ship side: outside the hull, a beam of zero or in the wrong unit, and broken geometry are open', () => {
  const tank = (geom) => [{ id: 't', type: 'fuel_tank', geom, props: { fuel: 'LNG' } }];
  const r = (geom, s) => res(checkModel(model(tank(geom), s), RULES), 't', 'IGF-5.3.3-SIDE');
  assert.equal(r({ x: 40000, y: -18000, lx: 10000, ly: 10000, h: 2800 }).status, 'not_enough_info', 'outside the hull');
  assert.match(r({ x: 40000, y: -18000, lx: 10000, ly: 10000, h: 2800 }).explanation, /outside the outline/);
  for (const beam of [0, { value: -30, unit: 'm' }, 30]) {
    assert.equal(r({ x: 40000, y: 10000, lx: 10000, ly: 10000, h: 2800 }, { beam }).status, 'not_enough_info', `beam ${JSON.stringify(beam)}`);
  }
  assert.equal(r({ x: 40000, y: 'q', lx: 10000, ly: 10000, h: 2800 }).status, 'not_enough_info');
  assert.equal(r({ x: 40000, y: 6000, lx: 10000, ly: 10000, h: 2800 }).status, 'compliant', 'exactly 6 m from the side (B/5)');
  assert.equal(r({ x: 40000, y: 5999, lx: 10000, ly: 10000, h: 2800 }).status, 'non_compliant');
});

test('duplicate, missing and reserved ids and non-elements never hide a finding', () => {
  const out = checkModel(model([
    { id: 'c1', type: 'corridor', props: { clear_width: 100 } },
    { id: 'c1', type: 'corridor', props: { clear_width: 1000 } },
    { id: '__proto__', type: 'corridor', props: { clear_width: 200 } },
    { type: 'corridor', props: { clear_width: 300 } },
    null,
  ]), RULES);
  const failing = findingsOf(out).filter((f) => f.rule_id === 'FSS-13-CORRIDOR').map((f) => f.element).sort();
  assert.deepEqual(failing, ['c1', 'element-3', 'element-4']);
  assert.ok(out.elements['c1~2']);
  assert.deepEqual(out.model_issues.map((i) => i.kind), ['duplicate_id', 'missing_id', 'missing_id', 'invalid_element']);
  assert.equal(out.element_summary.non_compliant, failing.length);
});

test('a value equal to the limit meets it; text never says "short by 0 mm"', () => {
  const ramp = (slope) => res(checkModel(model([{ id: 'r', type: 'ramp', props: { accessible_route: true, slope, clear_width: 1000 } }]), RULES), 'r', 'ADA-405.2');
  assert.equal(ramp(1 / 12).status, 'compliant');
  assert.equal(ramp(0.0834).status, 'non_compliant');
  const near = res(checkModel(model([{ id: 'c', type: 'corridor', props: { clear_width: 899.999 } }]), RULES), 'c', 'FSS-13-CORRIDOR');
  assert.equal(near.status, 'non_compliant');
  assert.doesNotMatch(near.explanation, /Short by 0 mm/);
  assert.match(near.explanation, /899\.999 mm unrounded/);
});

test('negative lengths and a zero thickness are data errors, not passes', () => {
  const out = checkModel(model([
    { id: 'c', type: 'corridor', props: { clear_width: 1000, dead_end_length: -5 } },
    { id: 'p', type: 'plate', props: { swbs: '110', swbs_group: '110', material_family: 'carbon steel', steel_grade: 'A', thickness: 0, material_class: 'III' } },
  ]), RULES);
  assert.equal(res(out, 'c', 'SOLAS-II-2-13-DEADEND-PAX').status, 'not_enough_info');
  assert.equal(res(out, 'p', 'IACS-S6-T7-GRADE-THICKNESS').status, 'not_enough_info');
});

test('an invalid rule is not run and is reported', () => {
  const bad = { id: 'BAD', source: 'S', clause: 'c', text: 't', check: 'min', parameter: 'clear_width', value: null, unit: 'mm', applies_to: { types: ['corridor'] }, verified: false };
  const out = checkModel(model([{ id: 'c', type: 'corridor', props: { clear_width: 5 } }]), [bad]);
  assert.equal(res(out, 'c', 'BAD'), undefined);
  assert.deepEqual(out.invalid_rules.map((r) => r.id), ['BAD']);
});
