// Report export (shared by the UI buttons and node check.mjs --report) and the accuracy badge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkModel } from '../src/checker.mjs';
import { scoreResults } from '../src/score.mjs';
import { reportRows, toCSV, toHTML, badgeText } from '../src/report.mjs';
import { fetchCatalog } from '../src/catalog-api.mjs';

const [rulesCatalog, CRUISE, expectedCruise] = await Promise.all([
  fetchCatalog('rules'),
  fetchCatalog('model-cruise-deck'),
  fetchCatalog('expected-cruise'),
]);
const RULES = rulesCatalog.rules;

test('accuracy badge: "7/7 expected findings, 0 false alarms" for the cruise deck', () => {
  const s = scoreResults(checkModel(CRUISE, RULES), expectedCruise);
  assert.equal(badgeText(s), '7/7 expected findings, 0 false alarms');
  assert.equal(badgeText(null), 'No ground truth for this scenario');
});

test('CSV: one row per finding, quotes escaped, BOM for Excel, deck name resolved', () => {
  const out = checkModel(CRUISE, RULES);
  const rows = reportRows(out, CRUISE, RULES);
  assert.equal(rows.length, 7);
  assert.equal(rows[0].group, 'Deck 5 (starboard section, frames 120-160)');
  const csv = toCSV([{ a: 'say "hi"', b: 'x,y' }]);
  assert.equal(csv, '﻿a,b\r\n"say ""hi""","x,y"');
});

test('HTML report: badge, findings, edits and rule texts are included and escaped', () => {
  const out = checkModel(CRUISE, RULES);
  const score = scoreResults(out, expectedCruise);
  const html = toHTML({ title: 'Deck <5>', scenario: 'cruise', results: out, model: CRUISE, rules: RULES, score,
    edits: [{ id: 'C2', key: 'clear_width', before: '800', after: '1000 mm' }] });
  assert.match(html, /✓ Accuracy: 7\/7 expected findings, 0 false alarms/);
  assert.match(html, /Deck &lt;5&gt;/);
  assert.match(html, /C2\.clear_width 800 → 1000 mm/);
  assert.match(html, /ADA-403\.5\.1/);
  assert.doesNotMatch(html, /<5>/);
});

test('traceability matrix: parts x rules, same data in the report and the CSV', async () => {
  const { traceMatrix, traceCSV } = await import('../src/trace.mjs');
  const out = checkModel(CRUISE, RULES);
  const m = traceMatrix(out, RULES);
  const c2 = m.rows.find((r) => r.id === 'C2');
  assert.equal(c2.cells['FSS-13-CORRIDOR'], 'non_compliant');
  assert.equal(c2.cells['ADA-403.5.1'], 'non_compliant');
  assert.equal(c2.cells['SOLAS-II-2-13-DEADEND-PAX'], 'compliant');
  assert.equal(m.rows[0].worst, 'non_compliant', 'worst first');
  assert.ok(traceMatrix(out, RULES, { findingsOnly: true }).rows.every((r) => r.worst !== 'compliant'));
  assert.match(traceCSV(m), /"C2","Cross corridor to stair","D5","non-compliant"/);
  const html = toHTML({ title: 't', scenario: 'cruise', results: out, model: CRUISE, rules: RULES });
  assert.match(html, /Traceability: parts × rules/);
});

test('a result resting on a value measured from a drawing is marked as a pre-check; design data and typed values are not', async () => {
  const { unconfirmedInputs } = await import('../src/checker.mjs');
  const rule = { id: 'W-MIN', source: 'Code', clause: '1', text: 'width', check: 'min', parameter: 'clear_width', value: 900, unit: 'mm', verified: false, applies_to: { types: ['door'] } };
  const model = { schema: 'ship/1', units: 'mm', decks: [{ id: 'D1', name: 'Main', elevation: 0, height: 2400 }], elements: [
    { id: 'DR1', type: 'door', name: 'Door 1', deck: 'D1', basis: 'measured', props: { clear_width: { value: 800, unit: 'mm', basis: 'measured', source: 'measured from the drawing: arc A1' } } },
    { id: 'DR2', type: 'door', name: 'Door 2', deck: 'D1', basis: 'measured', props: { clear_width: { value: 950, unit: 'mm', basis: 'typed', source: 'typed by the user' } } },
    { id: 'DR3', type: 'door', name: 'Door 3', deck: 'D1', props: { clear_width: 700 } },
  ] };
  const out = checkModel(model, [rule]);
  const r = (id) => out.elements[id].results[0];
  assert.deepEqual(unconfirmedInputs(r('DR1')).map((i) => [i.name, i.basis]), [['clear_width', 'measured']]);
  assert.equal(unconfirmedInputs(r('DR2')).length, 0, 'a value typed by the user counts as confirmed');
  assert.equal(unconfirmedInputs(r('DR3')).length, 0, 'design model data carries no basis');
  const rows = reportRows(out, model, [rule]);
  assert.equal(rows.find((x) => x.element === 'DR1').unconfirmed_input, 'clear_width (measured)');
  assert.equal(rows.find((x) => x.element === 'DR3').unconfirmed_input, '');
  const html = toHTML({ title: 't', scenario: 's', results: out, model, rules: [rule] });
  assert.match(html, /Pre-check: 1 of 3 rule results rest on values measured, read or assumed from a drawing/);
  assert.match(html, /pre-check: input unconfirmed/);
  // A design model (no basis anywhere) gets no pre-check note.
  assert.doesNotMatch(toHTML({ title: 't', scenario: 's', results: checkModel(CRUISE, RULES), model: CRUISE, rules: RULES }), /Pre-check:/);
});
