// Rule hierarchy: overlapping rules apply cumulatively (strictest governs), a rule may replace or exempt another
// only with a stated basis, conflicting limits are reported, identical limits are marked as one requirement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModel, recheckElements, validateRule, validateRelations, findingsOf } from '../src/checker.mjs';
import { toHTML, reportRows } from '../src/report.mjs';

const rule = (id, extra) => ({ id, source: `src ${id}`, clause: '1', text: id, check: 'min', parameter: 'clear_width', unit: 'mm', verified: false, applies_to: { types: ['corridor'] }, ...extra });
const model = (width, ship = { type: { value: 'passenger' } }) => ({
  name: 'm', units: 'mm', ship,
  decks: [{ id: 'D1', name: 'Deck 1', elevation: 0, outline: [[0, 0], [10, 0], [10, 5], [0, 5]] }],
  elements: [{ id: 'C1', type: 'corridor', name: 'corridor', deck: 'D1', props: { clear_width: { value: width, unit: 'mm' } } }],
});

test('overlapping rules without a relation: all apply, the strictest governs', () => {
  const rules = [rule('A', { value: 900 }), rule('B', { value: 915 })];
  const e = checkModel(model(910), rules).elements.C1;
  assert.deepEqual(e.results.map((r) => [r.rule_id, r.status]), [['A', 'compliant'], ['B', 'non_compliant']]);
  assert.equal(e.governing.clear_width.rule_id, 'B');
  assert.equal(e.governing.clear_width.count, 2);
  assert.deepEqual(e.superseded, []);
  assert.deepEqual(e.conflicts, []);
});

test('a rule that replaces another takes its place where both apply; the replaced result is kept with its basis', () => {
  const rules = [rule('NAT', { value: 850, relations: [{ type: 'replaces', rule: 'INTL', basis: 'National rule §3 applies instead' }] }), rule('INTL', { value: 900 })];
  const out = checkModel(model(870), rules);
  const e = out.elements.C1;
  assert.deepEqual(e.results.map((r) => r.rule_id), ['NAT']);
  assert.equal(e.worst, 'compliant');
  assert.equal(e.superseded.length, 1);
  assert.equal(e.superseded[0].rule_id, 'INTL');
  assert.equal(e.superseded[0].by, 'NAT');
  assert.equal(e.superseded[0].status, 'non_compliant');
  assert.equal(e.superseded[0].basis, 'National rule §3 applies instead');
  assert.deepEqual(out.summary, { compliant: 1, non_compliant: 0, not_enough_info: 0 });
  assert.equal(findingsOf(out).length, 0);
  assert.match(toHTML({ title: 't', scenario: 's', results: out, model: model(870), rules }), /Replaced by a higher-ranking rule \(1\)/);
});

test('no replacement when the replacing rule does not apply or its applicability is unknown', () => {
  const nat = rule('NAT', { value: 850, applies_to: { types: ['corridor'], ship: { equals: { flag: 'DE' } } }, relations: [{ type: 'exempts', rule: 'INTL', basis: 'Exemption by flag' }] });
  const rules = [nat, rule('INTL', { value: 900 })];
  const other = checkModel(model(870, { type: { value: 'passenger' }, flag: { value: 'NO' } }), rules).elements.C1;
  assert.deepEqual(other.results.map((r) => [r.rule_id, r.status]), [['INTL', 'non_compliant']]);
  const unknown = checkModel(model(870), rules).elements.C1;
  // NAT may or may not apply (flag unknown); the design meets it either way, but it cannot exempt INTL.
  assert.deepEqual(unknown.results.map((r) => [r.rule_id, r.status, r.applicability]), [['NAT', 'compliant', 'unknown'], ['INTL', 'non_compliant', undefined]]);
  assert.deepEqual(unknown.superseded, []);
  const unknownLow = checkModel(model(800), rules).elements.C1;
  assert.deepEqual(unknownLow.results.map((r) => [r.rule_id, r.status]), [['NAT', 'not_enough_info'], ['INTL', 'non_compliant']]);
  const applies = checkModel(model(870, { type: { value: 'passenger' }, flag: { value: 'DE' } }), rules).elements.C1;
  assert.deepEqual(applies.superseded.map((x) => [x.rule_id, x.type]), [['INTL', 'exempts']]);
});

test('a lower limit above an upper limit is reported as a rule conflict', () => {
  const rules = [rule('LO', { value: 1000 }), rule('HI', { check: 'max', value: 900 })];
  const e = checkModel(model(950), rules).elements.C1;
  assert.deepEqual(e.conflicts, [{ parameter: 'clear_width', lower: { rule_id: 'LO', required: '≥ 1000 mm' }, upper: { rule_id: 'HI', required: '≤ 900 mm' } }]);
  // Lower and upper limits are kept apart: the upper limit does not "govern" the lower one.
  assert.equal(e.governing.clear_width.rule_id, 'LO');
  assert.equal(e.governing['clear_width (upper limit)'].rule_id, 'HI');
  assert.match(toHTML({ title: 't', scenario: 's', results: checkModel(model(950), rules), model: model(950), rules }), /Rule conflicts \(1\)/);
});

test('identical limits from two instruments are marked as the same requirement', () => {
  const rules = [rule('LL', { value: 1000 }), rule('CLASS', { value: 1000 }), rule('OTHER', { value: 900 })];
  const out = checkModel(model(950), rules);
  const byId = Object.fromEntries(out.elements.C1.results.map((r) => [r.rule_id, r]));
  assert.deepEqual(byId.LL.same_requirement_as, ['CLASS']);
  assert.deepEqual(byId.CLASS.same_requirement_as, ['LL']);
  assert.equal(byId.OTHER.same_requirement_as, undefined);
  assert.equal(reportRows(out, model(950), rules).find((r) => r.rule === 'LL').same_requirement_as, 'CLASS');
});

test('relations need a basis and a known target; circular precedence is rejected and ignored at run time', () => {
  assert.ok(validateRule(rule('A', { value: 1, relations: [{ type: 'replaces', rule: 'B' }] })).some((m) => m.includes('basis')));
  assert.ok(validateRule(rule('A', { value: 1, relations: [{ type: 'overrules', rule: 'B', basis: 'x' }] })).some((m) => m.includes('relation type')));
  assert.deepEqual(validateRule(rule('A', { value: 1, relations: [{ type: 'replaces', rule: 'B', basis: 'x' }] })), []);
  const loop = [rule('A', { value: 900, relations: [{ type: 'replaces', rule: 'B', basis: 'x' }] }), rule('B', { value: 950, relations: [{ type: 'replaces', rule: 'A', basis: 'y' }] })];
  assert.ok(validateRelations(loop).some((m) => m.includes('circular')));
  assert.ok(validateRelations([rule('A', { value: 1, relations: [{ type: 'replaces', rule: 'Z', basis: 'x' }] })]).some((m) => m.includes('unknown rule')));
  // In a circle neither rule cancels the other: both stay in force.
  const e = checkModel(model(920), loop).elements.C1;
  assert.deepEqual(e.results.map((r) => r.rule_id), ['A', 'B']);
  assert.deepEqual(e.superseded, []);
});

test('re-checking an edited element keeps the hierarchy result identical to a full check', () => {
  const rules = [rule('NAT', { value: 850, relations: [{ type: 'replaces', rule: 'INTL', basis: 'b' }] }), rule('INTL', { value: 900 }), rule('HI', { check: 'max', value: 800 })];
  const m = model(870);
  const base = checkModel(m, rules);
  m.elements[0].props.clear_width.value = 820;
  assert.deepEqual(recheckElements(base, m, rules, ['C1']), checkModel(m, rules));
});
