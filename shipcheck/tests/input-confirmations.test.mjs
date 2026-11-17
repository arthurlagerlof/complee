import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModel, unconfirmedInputs, confirmedInputs } from '../src/checker.mjs';
import { SHIP, inputKey, withInputConfirmation, withoutInputConfirmation, applyInputConfirmations } from '../src/input-confirmations.mjs';
import { registerRows } from '../src/dispositions.mjs';
import { projectFile, readProjectFile } from '../src/project-file.mjs';
import { reportRows, toHTML } from '../src/report.mjs';

const RULE = { id: 'W-MIN', source: 'Code', clause: '1', text: 'width', check: 'min', parameter: 'clear_width', value: 900, unit: 'mm', verified: false, applies_to: { types: ['stair'] } };
const LOA = { id: 'LOA', source: 'Code', clause: '2', text: 'stairs on ships of 24 m and more', check: 'min', parameter: 'clear_width', value: 600, unit: 'mm', verified: false,
  applies_to: { types: ['stair'], ship: { min: { length_overall: { value: 24, unit: 'm' } } } } };
// A model as the drawing converter writes it: element and values carry a basis.
const drawn = () => ({
  schema: 'ship/1', units: 'mm', name: 'GA', ship: { length_overall: { value: 28000, unit: 'mm', basis: 'read', source: 'text on the drawing' } },
  decks: [{ id: 'D1', name: 'Main', elevation: 0, height: 2400 }],
  elements: [{ id: 'ST1', type: 'stair', name: 'Stair', deck: 'D1', basis: 'measured', props: { clear_width: { value: 751, unit: 'mm', basis: 'measured', source: 'measured from the drawing' } } }],
});
const result = (model, rules = [RULE]) => checkModel(model, rules).elements.ST1.results[0];
const NOW = new Date('2026-11-17T12:00:00Z');

test('confirming a value from a drawing needs a name; the confirmed value is no longer a pre-check', () => {
  const model = drawn();
  assert.equal(unconfirmedInputs(result(model)).length, 1);
  assert.deepEqual(unconfirmedInputs(result(model))[0].value_of, { element: 'ST1', prop: 'clear_width' }, 'the input names where it is stored');
  const item = { element: 'ST1', prop: 'clear_width', value: 751, unit: 'mm', basis: 'measured' };
  assert.throws(() => withInputConfirmation({}, item, { responsible: '  ' }), /who checked/);
  const store = withInputConfirmation({}, item, { responsible: 'A. Engineer' }, NOW);
  assert.equal(store[inputKey('ST1', 'clear_width')].kind, 'input');
  const applied = applyInputConfirmations(model, store);
  assert.deepEqual(applied.confirmed, [inputKey('ST1', 'clear_width')]);
  const r = result(model);
  assert.equal(r.status, 'non_compliant', 'a confirmation never changes the result');
  assert.equal(unconfirmedInputs(r).length, 0);
  assert.equal(confirmedInputs(r)[0].confirmed_by, 'A. Engineer');
  assert.equal(model.elements[0].props.clear_width.basis_was, 'measured');
});

test('a confirmation holds only for the confirmed value; removing it makes the value unconfirmed again', () => {
  const model = drawn();
  const store = withInputConfirmation({}, { element: 'ST1', prop: 'clear_width', value: 751, unit: 'mm', basis: 'measured' }, { responsible: 'A. Engineer' }, NOW);
  applyInputConfirmations(model, store);
  // The drawing is converted again and the stair now measures 760 mm: the old confirmation does not cover it.
  model.elements[0].props.clear_width = { value: 760, unit: 'mm', basis: 'measured', source: 'measured from the drawing' };
  const again = applyInputConfirmations(model, store);
  assert.deepEqual(again.stale.map((s) => [s.confirmed, s.now]), [[751, 760]]);
  assert.equal(unconfirmedInputs(result(model)).length, 1);
  // Undo: the mark goes and the earlier basis is back.
  const model2 = drawn();
  applyInputConfirmations(model2, store);
  applyInputConfirmations(model2, withoutInputConfirmation(store, 'ST1', 'clear_width'));
  assert.equal(model2.elements[0].props.clear_width.basis, 'measured');
  assert.equal(model2.elements[0].props.clear_width.confirmed_by, undefined);
  assert.equal(unconfirmedInputs(result(model2)).length, 1);
});

test('a ship particular read from the drawing can be confirmed too', () => {
  const model = drawn();
  assert.ok(unconfirmedInputs(result(model, [LOA])).some((i) => i.name === 'ship.length_overall' && i.value_of?.element === SHIP));
  applyInputConfirmations(model, withInputConfirmation({}, { element: SHIP, prop: 'length_overall', value: 28000, unit: 'mm', basis: 'read' }, { responsible: 'A. Engineer' }, NOW));
  const r = result(model, [LOA]);
  assert.ok(!unconfirmedInputs(r).some((i) => i.name === 'ship.length_overall'));
  assert.ok(confirmedInputs(r).some((i) => i.name === 'ship.length_overall'));
});

test('confirmations live in the register store without becoming findings, and travel with the project file', () => {
  const model = drawn();
  const store = withInputConfirmation({}, { element: 'ST1', prop: 'clear_width', value: 751, unit: 'mm', basis: 'measured' }, { responsible: 'A. Engineer' }, NOW);
  const rows = registerRows(checkModel(model, [RULE]), store);
  assert.equal(rows.length, 1, 'only the finding, not the confirmation as an orphaned entry');
  assert.equal(rows[0].rule_id, 'W-MIN');
  const file = JSON.stringify(projectFile({ project: 'p', model: 'GA', revision: 'A', register: { ...store, 'ST1|input:height': { kind: 'input', element: 'ST1', prop: 'height', value: 2, responsible: '' } } }, NOW));
  const back = readProjectFile(file, 'p').register;
  assert.equal(back[inputKey('ST1', 'clear_width')].value, 751);
  assert.equal(back[inputKey('ST1', 'clear_width')].responsible, 'A. Engineer');
  assert.equal(back['ST1|input:height'], undefined, 'a confirmation without a name is left out');
});

test('the report names who confirmed a value and still flags the unconfirmed ones', () => {
  const model = drawn();
  model.elements.push({ id: 'ST2', type: 'stair', name: 'Stair 2', deck: 'D1', basis: 'measured', props: { clear_width: { value: 700, unit: 'mm', basis: 'measured', source: 'measured from the drawing' } } });
  applyInputConfirmations(model, withInputConfirmation({}, { element: 'ST1', prop: 'clear_width', value: 751, unit: 'mm', basis: 'measured' }, { responsible: 'A. Engineer' }, NOW));
  const out = checkModel(model, [RULE]);
  const rows = reportRows(out, model, [RULE]);
  assert.equal(rows.find((r) => r.element === 'ST1').confirmed_input, 'clear_width (confirmed by A. Engineer, 2026-11-17)');
  assert.equal(rows.find((r) => r.element === 'ST1').unconfirmed_input, '');
  assert.equal(rows.find((r) => r.element === 'ST2').unconfirmed_input, 'clear_width (measured)');
  const html = toHTML({ title: 't', scenario: 's', results: out, model, rules: [RULE] });
  assert.match(html, /Pre-check: 1 of 2 rule results rest on values/);
  assert.match(html, /1 value from the drawing checked and confirmed by a person/);
  assert.match(html, /confirmed: clear_width \(confirmed by A\. Engineer, 2026-11-17\)/);
});
