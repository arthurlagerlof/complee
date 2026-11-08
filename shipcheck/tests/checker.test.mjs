// Run with: npm test  (node:test, no extra dependencies)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkModel, validateRule, normalizeModel, findingsOf } from '../src/checker.mjs';
import { scoreResults, scoreLine } from '../src/score.mjs';
import { fetchCatalog } from '../src/catalog-api.mjs';

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const [rulesCatalog, CRUISE, INSIDE, expectedLayout, expectedCruise, expectedInside] = await Promise.all([
  fetchCatalog('rules'),
  fetchCatalog('model-cruise-deck'),
  fetchCatalog('model-rcrv-inside'),
  fetchCatalog('expected-rcrv-layout'),
  fetchCatalog('expected-cruise'),
  fetchCatalog('expected-rcrv-inside'),
]);
const RULES = rulesCatalog.rules;
// Estimated RCRV deck layout with planted findings: test data for the layout rules (escape, Load Line, ...).
const RCRV = read('tests/fixtures/rcrv-layout.json');
const clone = (o) => structuredClone(o);
const resultOf = (out, el, rule) => out.elements[el]?.results.find((r) => r.rule_id === rule);
const notApplied = (out, el, rule) => out.elements[el]?.not_applicable.find((r) => r.rule_id === rule);

// ---------- ground truth ----------

for (const [name, model, expected] of [
  ['rcrv-layout', RCRV, expectedLayout],
  ['cruise', CRUISE, expectedCruise],
  ['rcrv-inside', INSIDE, expectedInside],
]) {
  test(`${name}: every planted finding detected, no false alarms`, () => {
    const s = scoreResults(checkModel(model, RULES), expected);
    console.log(`  ${name}: ${scoreLine(s)}`);
    assert.deepEqual(s.missed, [], 'missed findings');
    assert.deepEqual(s.wrong_status, [], 'findings with the wrong status');
    assert.deepEqual(s.false_alarms, [], 'false alarms');
    assert.deepEqual(s.failed_passes, [], 'checks that should pass');
    assert.equal(s.detected, expected.findings.length);
  });
}

test('checker is deterministic', () => {
  assert.deepEqual(checkModel(RCRV, RULES), checkModel(clone(RCRV), RULES));
  assert.deepEqual(checkModel(CRUISE, RULES), checkModel(clone(CRUISE), RULES));
});

test('fixing a planted value turns the element green', () => {
  const m = clone(RCRV);
  m.elements.find((e) => e.id === '01-GR1').props.height = { value: 1000, unit: 'mm', source: 'edited' };
  const out = checkModel(m, RULES);
  assert.equal(out.elements['01-GR1'].worst, 'compliant');
  assert.equal(resultOf(out, '01-GR1', 'DNV-GUARDRAIL').status, 'compliant');
});

// ---------- rule database ----------

test('all rules are structurally valid and related[] ids exist', () => {
  const ids = new Set(RULES.map((r) => r.id));
  assert.equal(ids.size, RULES.length, 'duplicate rule id');
  for (const r of RULES) {
    assert.deepEqual(validateRule(r), [], `rule ${r.id}`);
    for (const rel of r.related || []) assert.ok(ids.has(rel), `${r.id} -> unknown related ${rel}`);
  }
});

test('every unverified rule is listed in VERIFY.md', () => {
  const verify = fs.readFileSync(new URL('../VERIFY.md', import.meta.url), 'utf8');
  for (const r of RULES.filter((x) => !x.verified)) assert.ok(verify.includes(r.id), `${r.id} missing in VERIFY.md`);
});

// ---------- units ----------

test('model in inches is converted to mm (geometry and props)', () => {
  const m = {
    name: 'inch deck', units: 'in', ship: { type: 'passenger', operating_area: ['US'] },
    deck: { length: 400, width: 200 },
    elements: [
      { id: 'C', type: 'corridor', name: 'c', geom: { x: 0, y: 0, lx: 100, ly: 40, h: 1 }, props: { clear_width: 40, dead_end_length: 0, accessible_route: true } },
      { id: 'N', type: 'corridor', name: 'narrow', geom: { x: 0, y: 50, lx: 100, ly: 30, h: 1 }, props: { clear_width: 34, dead_end_length: 0, accessible_route: true } },
    ],
  };
  const n = normalizeModel(m);
  assert.equal(n.decks[0].outline_mm[2][0], 400 * 25.4);
  assert.equal(n.elements[0].geom_mm.ly, 40 * 25.4);
  const out = checkModel(m, RULES);
  assert.equal(resultOf(out, 'C', 'FSS-13-CORRIDOR').status, 'compliant'); // 1016 mm
  const r = resultOf(out, 'N', 'FSS-13-CORRIDOR'); // 863.6 mm
  assert.equal(r.status, 'non_compliant');
  assert.equal(r.measured, '34 in (864 mm)', 'original unit kept for display');
});

test('a prop with its own unit overrides the model unit', () => {
  const m = clone(CRUISE);
  m.elements.find((e) => e.id === 'C2').props.clear_width = { value: 3, unit: 'ft' }; // 914.4 mm
  const out = checkModel(m, RULES);
  assert.equal(resultOf(out, 'C2', 'FSS-13-CORRIDOR').status, 'compliant');
  assert.equal(resultOf(out, 'C2', 'ADA-403.5.1').status, 'non_compliant');
});

test('edge: 36 in is 914.4 mm and fails the rounded 915 mm metric value (see VERIFY.md)', () => {
  const m = clone(CRUISE);
  m.elements.find((e) => e.id === 'C2').props.clear_width = { value: 36, unit: 'in' };
  assert.equal(resultOf(checkModel(m, RULES), 'C2', 'ADA-403.5.1').status, 'non_compliant');
});

test('unsupported unit gives not_enough_info, not a guess', () => {
  const m = clone(CRUISE);
  m.elements.find((e) => e.id === 'C2').props.clear_width = { value: 1, unit: 'yd' };
  assert.equal(resultOf(checkModel(m, RULES), 'C2', 'FSS-13-CORRIDOR').status, 'not_enough_info');
});

// ---------- missing values ----------

test('missing or non-numeric values give not_enough_info', () => {
  const m = clone(CRUISE);
  delete m.elements.find((e) => e.id === 'S1').props.clear_width;
  m.elements.find((e) => e.id === 'R1').props.slope = 'steep';
  const out = checkModel(m, RULES);
  assert.equal(resultOf(out, 'S1', 'FSS-13-STAIR').status, 'not_enough_info');
  assert.equal(resultOf(out, 'R1', 'ADA-405.2').status, 'not_enough_info');
  assert.equal(resultOf(out, 'R1', 'ADA-405.2').measured, null);
});

test('missing ship beam gives not_enough_info for the B/5 tank rule', () => {
  const m = clone(CRUISE);
  delete m.ship.beam;
  assert.equal(resultOf(checkModel(m, RULES), 'T1', 'IGF-5.3.3-SIDE').status, 'not_enough_info');
});

test('missing escape route list gives not_enough_info', () => {
  const m = clone(RCRV);
  delete m.elements.find((e) => e.id === '01-Z2').props.escape_routes;
  assert.equal(resultOf(checkModel(m, RULES), '01-Z2', 'SOLAS-II-2-13-ESCAPE-ACCOM').status, 'not_enough_info');
});

// ---------- applicability ----------

test('ADA/PVAG does not apply to the research vessel, and says why', () => {
  const m = clone(RCRV);
  m.elements.find((e) => e.id === 'MD-C1').props.accessible_route = true;
  const out = checkModel(m, RULES);
  assert.equal(resultOf(out, 'MD-C1', 'ADA-403.5.1'), undefined);
  assert.match(notApplied(out, 'MD-C1', 'ADA-403.5.1').reason, /ship type is "research"/);
});

test('ADA does not apply to a passenger ship outside US waters', () => {
  const m = clone(CRUISE);
  m.ship.operating_area = ['Baltic'];
  const out = checkModel(m, RULES);
  assert.equal(resultOf(out, 'D2', 'ADA-404.2.3'), undefined);
  assert.match(notApplied(out, 'D2', 'ADA-404.2.3').reason, /operating area/);
});

test('dead-end rule follows ship type: 13 m passenger vs 7 m cargo/research', () => {
  const out = checkModel(RCRV, RULES);
  assert.equal(resultOf(out, '01-C2', 'SOLAS-II-2-13-DEADEND-CARGO').status, 'non_compliant');
  assert.ok(notApplied(out, '01-C2', 'SOLAS-II-2-13-DEADEND-PAX'));
  const pax = clone(RCRV);
  pax.ship.type = 'passenger';
  const out2 = checkModel(pax, RULES);
  assert.equal(resultOf(out2, '01-C2', 'SOLAS-II-2-13-DEADEND-PAX').status, 'compliant');
});

test('unknown ship type gives not_enough_info for ship-dependent rules', () => {
  const m = clone(CRUISE);
  delete m.ship.type;
  const r = resultOf(checkModel(m, RULES), 'D2', 'ADA-404.2.3');
  assert.equal(r.status, 'not_enough_info');
  assert.match(r.explanation, /ship\.type is missing/);
});

test('class rule applies only to ships of that class society', () => {
  const m = clone(RCRV);
  m.ship.class_society = 'ABS';
  const out = checkModel(m, RULES);
  assert.equal(resultOf(out, '01-GR1', 'DNV-GUARDRAIL'), undefined);
  assert.equal(resultOf(out, '01-GR1', 'LL-REG25-GUARDRAIL').status, 'non_compliant');
});

test('Load Line rules do not apply below 24 m length', () => {
  const m = clone(RCRV);
  m.ship.length_overall = { value: 20, unit: 'm' };
  assert.ok(notApplied(checkModel(m, RULES), 'MD-D1', 'LL-REG12-SILL'));
});

test('IGF rules do not apply to MGO tanks', () => {
  const out = checkModel(RCRV, RULES);
  assert.equal(resultOf(out, 'LD-FOP', 'IGF-LNG-LOCATION'), undefined);
  assert.match(notApplied(out, 'LD-FOP', 'IGF-LNG-LOCATION').reason, /fuel is "MGO"/);
});

// ---------- check types ----------

test('count_min ignores ids that do not exist or have the wrong type', () => {
  const m = clone(RCRV);
  m.elements.find((e) => e.id === '01-Z1').props.escape_routes = ['MD-ST1', 'NOPE', 'MD-WETLAB'];
  const r = resultOf(checkModel(m, RULES), '01-Z1', 'SOLAS-II-2-13-ESCAPE-ACCOM');
  assert.equal(r.status, 'non_compliant');
  assert.match(r.explanation, /NOPE not found/);
  assert.match(r.explanation, /MD-WETLAB not counted/);
  m.elements.find((e) => e.id === '01-Z1').props.escape_routes = ['MD-ST1', '01-EXT1'];
  assert.equal(resultOf(checkModel(m, RULES), '01-Z1', 'SOLAS-II-2-13-ESCAPE-ACCOM').status, 'compliant');
});

test('requires: removing the sludge tank is a finding', () => {
  const m = clone(RCRV);
  m.elements = m.elements.filter((e) => e.type !== 'sludge_tank');
  assert.equal(resultOf(checkModel(m, RULES), 'LD-ER', 'MARPOL-I-12-SLUDGE').status, 'non_compliant');
});

test('distance to ship side is computed from geometry', () => {
  const m = clone(CRUISE);
  const t = m.elements.find((e) => e.id === 'T1');
  t.geom.y = 600; // 12000 - (600 + 5400) = 6000 mm from the shell, still < 6400
  t.props.adjacent = ['STORE'];
  let r = resultOf(checkModel(m, RULES), 'T1', 'IGF-5.3.3-SIDE');
  assert.equal(r.status, 'non_compliant');
  assert.match(r.measured, /^6000 mm/);
  t.geom.y = 0; // 6600 mm
  r = resultOf(checkModel(m, RULES), 'T1', 'IGF-5.3.3-SIDE');
  assert.equal(r.status, 'compliant');
});

test('adjacency is derived from geometry when not declared', () => {
  const m = clone(CRUISE);
  delete m.elements.find((e) => e.id === 'T1').props.adjacent;
  const r = resultOf(checkModel(m, RULES), 'T1', 'IGF-LNG-LOCATION');
  assert.equal(r.status, 'non_compliant');
  assert.match(r.explanation, /CAB5/);
  assert.match(r.inputs[0].source, /derived from 3D geometry/);
});

test('overlapping rules: the strictest value governs', () => {
  const g = checkModel(CRUISE, RULES).elements.C2.governing.clear_width;
  assert.equal(g.rule_id, 'ADA-403.5.1');
  assert.equal(g.value, 915);
  assert.equal(g.count, 2);
});

// ---------- backwards compatibility and provenance ----------

test('every RCRV element and every planted value has provenance', () => {
  for (const e of RCRV.elements) {
    assert.ok(e.source, `${e.id} has no source`);
    for (const [k, v] of Object.entries(e.props)) {
      if (v && typeof v === 'object' && 'value' in v) assert.ok(v.source, `${e.id}.${k} has no source`);
    }
  }
  const planted = findingsOf(checkModel(RCRV, RULES)).filter((f) => f.status === 'non_compliant');
  for (const f of planted) {
    const srcs = f.inputs.map((i) => i.source).join(' ');
    assert.match(srcs, /planted test case|estimated|computed/, `${f.element} ${f.rule_id}`);
  }
});

test('cruise: C2 fails FSS and ADA (915 mm governs); 1000 mm fixes both', () => {
  const out = checkModel(CRUISE, RULES);
  assert.equal(resultOf(out, 'C2', 'FSS-13-CORRIDOR').status, 'non_compliant');
  assert.equal(resultOf(out, 'C2', 'ADA-403.5.1').status, 'non_compliant');
  assert.equal(out.elements.C2.governing.clear_width.rule_id, 'ADA-403.5.1');
  const m = clone(CRUISE);
  m.elements.find((e) => e.id === 'C2').props.clear_width = { value: 1000, unit: 'mm', source: 'edited in session by engineer' };
  assert.equal(checkModel(m, RULES).elements.C2.worst, 'compliant');
});
