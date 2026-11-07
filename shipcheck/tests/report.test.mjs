// Report export (shared by the UI buttons and node check.mjs --report) and the accuracy badge.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkModel } from '../src/checker.mjs';
import { scoreResults } from '../src/score.mjs';
import { reportRows, toCSV, toHTML, badgeText } from '../src/report.mjs';

const read = (p) => JSON.parse(fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8'));
const RULES = read('rules.json').rules;
const CRUISE = read('ships/cruise/deck.json');

test('accuracy badge: "7/7 expected findings, 0 false alarms" for the cruise deck', () => {
  const s = scoreResults(checkModel(CRUISE, RULES), read('tests/expected/cruise.json'));
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
  const score = scoreResults(out, read('tests/expected/cruise.json'));
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
  assert.match(traceCSV(m), /"C2","Cross corridor to stair","D5","fail"/);
  const html = toHTML({ title: 't', scenario: 'cruise', results: out, model: CRUISE, rules: RULES });
  assert.match(html, /Traceability: parts × rules/);
});
