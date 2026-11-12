// Manual checks and coverage: requirements no algorithm can decide are listed for a person to confirm, never
// counted as a pass, and the coverage of the automatic check is reported next to the result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModel, recheckElements, validateRule, coverageOf, findingsOf } from '../src/checker.mjs';
import { manualRows, manualSummary, withManualCheck, registerRows } from '../src/dispositions.mjs';
import { toHTML } from '../src/report.mjs';
import { traceMatrix } from '../src/trace.mjs';

const RULES = [
  { id: 'AUTO', source: 'Code A', clause: '1', text: 'width', check: 'min', parameter: 'clear_width', value: 900, unit: 'mm', verified: true, applies_to: { types: ['corridor'] } },
  { id: 'MAN', source: 'Code A', clause: '2', text: 'Escape route marked.', check: 'manual', evidence: 'Marking plan', verified: false, applies_to: { types: ['corridor'] } },
  { id: 'MAN-PAX', source: 'Code B', clause: '3', text: 'Passenger only.', check: 'manual', verified: false, applies_to: { types: ['corridor'], ship: { type_in: ['passenger'] } } },
];
const model = (ship = { type: { value: 'passenger' } }, width = 950) => ({
  name: 'm', units: 'mm', ship,
  decks: [{ id: 'D1', name: 'Deck 1', elevation: 0, outline: [[0, 0], [10, 0], [10, 5], [0, 5]] }],
  elements: [{ id: 'C1', type: 'corridor', name: 'corridor', deck: 'D1', props: { clear_width: { value: width, unit: 'mm' } } }],
});

test('a manual rule is valid without parameter or value', () => {
  for (const r of RULES) assert.deepEqual(validateRule(r), [], r.id);
});

test('manual checks are listed per element and never counted as a result', () => {
  const out = checkModel(model(), RULES);
  const e = out.elements.C1;
  assert.deepEqual(e.results.map((r) => r.rule_id), ['AUTO']);
  assert.equal(e.worst, 'compliant');
  assert.deepEqual(e.manual.map((m) => [m.rule_id, m.applicability]), [['MAN', 'applies'], ['MAN-PAX', 'applies']]);
  assert.deepEqual(out.summary, { compliant: 1, non_compliant: 0, not_enough_info: 0 });
  assert.equal(findingsOf(out).length, 0);
  assert.deepEqual(traceMatrix(out, RULES).rules.map((r) => r.id), ['AUTO']);
});

test('ship conditions decide whether a manual check applies; unknown applicability is said so', () => {
  const cargo = checkModel(model({ type: { value: 'cargo' } }), RULES).elements.C1;
  assert.deepEqual(cargo.manual.map((m) => m.rule_id), ['MAN']);
  const unknown = checkModel(model({}), RULES).elements.C1;
  const pax = unknown.manual.find((m) => m.rule_id === 'MAN-PAX');
  assert.equal(pax.applicability, 'unknown');
  assert.match(pax.reason, /missing in the ship particulars/);
});

test('coverage counts automatic rules and manual checks per instrument', () => {
  const c = coverageOf(checkModel(model(), RULES), RULES);
  assert.deepEqual(c.by_source, [{ source: 'Code A', automatic: 1, manual: 1 }, { source: 'Code B', automatic: 0, manual: 1 }]);
  assert.equal(c.automatic, 1);
  assert.equal(c.automatic_verified, 1);
  assert.equal(c.manual, 2);
});

test('confirming a manual check needs a name; it is stored apart from finding dispositions', () => {
  const out = checkModel(model(), RULES);
  const [man] = manualRows(out, {});
  assert.equal(man.done, false);
  assert.throws(() => withManualCheck({}, man, { done: true }), /who checked it/);
  const store = withManualCheck({}, man, { done: true, responsible: 'A. Engineer', note: 'Drawing 123-45' }, new Date('2026-11-12T10:00:00Z'));
  const rows = manualRows(out, store);
  assert.equal(rows[0].done, true);
  assert.equal(rows[0].responsible, 'A. Engineer');
  assert.deepEqual(manualSummary(rows), { total: 2, done: 1, open: 1 });
  // Not shown as a resolved finding in the findings register.
  assert.deepEqual(registerRows(out, store), []);
  // Unticking without name or note removes the entry again.
  assert.deepEqual(withManualCheck(store, man, { done: false, responsible: '', note: '' }), {});
  const html = toHTML({ title: 't', scenario: 's', results: out, model: model(), rules: RULES, register: store });
  assert.match(html, /Manual checks \(1 of 2 confirmed\)/);
  assert.match(html, /not a statement\s+of full compliance/);
});

test('re-checking an edited element keeps manual checks identical to a full check', () => {
  const m = model();
  const base = checkModel(m, RULES);
  m.elements[0].props.clear_width.value = 800;
  assert.deepEqual(recheckElements(base, m, RULES, ['C1']), checkModel(m, RULES));
});
