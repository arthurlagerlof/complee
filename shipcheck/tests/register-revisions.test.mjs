// Findings register across revisions: one register per project, stale detection when values change.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkModel } from '../src/checker.mjs';
import { projectKey, registerRows, registerSummary, withDisposition, registerCSV } from '../src/dispositions.mjs';
import { fetchCatalog } from '../src/catalog-api.mjs';

const RULES = (await fetchCatalog('rules')).rules;
const REV_A = JSON.parse(fs.readFileSync(new URL('./fixtures/rcrv-layout.json', import.meta.url), 'utf8'));

test('register: every revision of the same design maps to one project', () => {
  const revB = structuredClone(REV_A);
  revB.name = 'Something else entirely';
  assert.equal(projectKey(revB), projectKey(REV_A), 'same ship, same register');
  assert.equal(projectKey({ project_id: 'P-7', ship: { name: 'X' } }), 'project:P-7', 'an explicit project id wins');
  for (const [a, b] of [['Tower rev A', 'Tower rev B'], ['tower_v3.ifc', 'tower_v4.ifc'], ['Tower (revision 1)', 'Tower']]) {
    assert.equal(projectKey({ name: a }), projectKey({ name: b }), `${a} / ${b}`);
  }
  assert.notEqual(projectKey({ name: 'Research vessel' }), projectKey({ name: 'Research' }), 'a word starting with v is not a version');
});

test('register: a disposition from revision A is carried into B, flagged when the value changed, kept when resolved', () => {
  const outA = checkModel(structuredClone(REV_A), RULES);
  const rowsA = registerRows(outA, {});
  const sill = rowsA.find((r) => r.element === 'MD-D1' && r.rule_id === 'LL-REG12-SILL');
  const stair = rowsA.find((r) => r.element === '02-ST1');
  let store = withDisposition({}, { element: sill.element, rule_id: sill.rule_id, status: sill.status, measured: sill.measured, required: sill.required, name: sill.name, deck: sill.deck },
    { disposition: 'fix', responsible: 'PT', revision: 'rev A' });
  store = withDisposition(store, { element: stair.element, rule_id: stair.rule_id, status: stair.status, measured: stair.measured, required: stair.required, name: stair.name, deck: stair.deck },
    { disposition: 'fix', responsible: 'PT', revision: 'rev A' });

  // Revision B: the sill was changed but is still too low; the stair was widened and passes now.
  const revB = structuredClone(REV_A);
  revB.elements.find((e) => e.id === 'MD-D1').props.sill_height = 350;
  revB.elements.find((e) => e.id === '02-ST1').props.clear_width = 1000;
  const rowsB = registerRows(checkModel(revB, RULES), store);
  const sillB = rowsB.find((r) => r.key === 'MD-D1|LL-REG12-SILL');
  assert.equal(sillB.disposition, 'fix', 'the disposition is still there');
  assert.equal(sillB.revision, 'rev A', 'and says which revision it was written for');
  assert.equal(sillB.stale, true, 'the measured value changed: review again');
  const stairB = rowsB.find((r) => r.element === '02-ST1');
  assert.equal(stairB.resolved, true, 'no longer reported by the check, but not forgotten');
  const s = registerSummary(rowsB);
  assert.equal(s.stale, 1);
  assert.equal(s.resolved, 1);
  assert.match(registerCSV(rowsB), /rev A/);
});
