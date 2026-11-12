// Incremental re-check (what-if editing): the result for an edited element and the summaries must be exactly what a
// full check of the edited model gives. Independent of the database catalog: small models and rules written here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkModel, recheckElements } from '../src/checker.mjs';

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const LOCAL_RULES = [
  { id: 'T-MIN', source: 'test', clause: '1', text: 'min thickness', check: 'min', parameter: 'thickness', value: 8, unit: 'mm', verified: false, applies_to: { types: ['plate'] } },
  { id: 'T-MAX', source: 'test', clause: '2', text: 'max thickness', check: 'max', parameter: 'thickness', value: 20, unit: 'mm', verified: false, applies_to: { types: ['plate'] } },
  { id: 'M-SET', source: 'test', clause: '3', text: 'material', check: 'in_set', parameter: 'material', values: ['steel'], verified: false, applies_to: { types: ['plate', 'pipe'] } },
  { id: 'DRAFT', source: 'test', clause: '4', text: 'draft', check: 'min', parameter: 'thickness', value: null, unit: 'mm', verified: false, draft: true, draft_reason: 'no value yet', applies_to: { types: ['plate'] } },
];
const model = () => ({
  name: 'parts', units: 'mm', ship: { type: { value: 'research' } },
  decks: [{ id: 'D1', name: 'Deck 1', elevation: 0, outline: [[0, 0], [10, 0], [10, 5], [0, 5]] }],
  elements: [
    { id: 'P1', type: 'plate', name: 'plate 1', deck: 'D1', props: { thickness: { value: 6, unit: 'mm' }, material: { value: 'steel' } } },
    { id: 'P2', type: 'plate', name: 'plate 2', deck: 'D1', props: { thickness: { value: 12, unit: 'mm' }, material: { value: 'aluminium' } } },
    { id: 'P3', type: 'plate', name: 'plate 3', deck: 'D1', props: { material: { value: 'steel' } } },
    { id: 'X1', type: 'pipe', name: 'pipe', deck: 'D1', props: { material: { value: 'steel' } } },
    { id: 'N1', type: 'other', name: 'no rule', deck: 'D1', props: {} },
  ],
});

test('re-checking edited elements equals a full check of the edited model', () => {
  const m = model();
  const base = checkModel(m, LOCAL_RULES);
  assert.equal(base.elements.P1.worst, 'non_compliant');
  assert.deepEqual(base.summary, { compliant: 6, non_compliant: 2, not_enough_info: 2 });
  // Fix P1, break P2 further, give P3 its thickness: three edits in a row, each re-checked alone.
  let out = base;
  const edits = [['P1', { thickness: { value: 10, unit: 'mm' }, material: { value: 'steel' } }],
    ['P2', { thickness: { value: 30, unit: 'mm' }, material: { value: 'aluminium' } }],
    ['P3', { thickness: { value: 15, unit: 'mm' }, material: { value: 'steel' } }]];
  for (const [id, props] of edits) {
    m.elements.find((e) => e.id === id).props = props;
    out = recheckElements(out, m, LOCAL_RULES, [id]);
    assert.deepEqual(out, checkModel(m, LOCAL_RULES), `after editing ${id}`);
  }
  assert.equal(out.elements.P1.worst, 'compliant');
  assert.equal(out.elements.P2.worst, 'non_compliant');
  assert.deepEqual(out.summary, { compliant: 8, non_compliant: 2, not_enough_info: 0 });
  assert.notEqual(out.elements, base.elements, 'the previous result object is not mutated');
  assert.equal(base.elements.P1.worst, 'non_compliant');
});

test('rules that look beyond one element fall back to a full check', () => {
  const rules = [...LOCAL_RULES, { id: 'REQ', source: 'test', clause: '5', text: 'needs a pipe', check: 'requires', requires: { type: 'pipe' }, verified: false, applies_to: { types: ['plate'] } }];
  const m = model();
  const base = checkModel(m, rules);
  m.elements = m.elements.filter((e) => e.id !== 'X1');
  const out = recheckElements(base, m, rules, ['P1']);
  assert.deepEqual(out, checkModel(m, rules));
  assert.equal(out.elements.P2.results.find((r) => r.rule_id === 'REQ').status, 'non_compliant', 'other plates see the removed pipe too');
});

test('layout fixture: an incremental re-check after an edit matches the full check', () => {
  const layout = read('tests/fixtures/rcrv-layout.json');
  const rules = [
    { id: 'GR', source: 'test', clause: '1', text: 'guard rail height', check: 'min', parameter: 'height', value: 1000, unit: 'mm', verified: false, applies_to: { types: ['guard_rail'] } },
  ];
  const base = checkModel(layout, rules);
  const rail = layout.elements.find((e) => e.type === 'guard_rail');
  assert.ok(rail, 'fixture has a guard rail');
  rail.props.height = { value: 1200, unit: 'mm', source: 'edited' };
  const out = recheckElements(base, layout, rules, [rail.id]);
  assert.deepEqual(out, checkModel(layout, rules));
  assert.equal(out.elements[rail.id].worst, 'compliant');
});
