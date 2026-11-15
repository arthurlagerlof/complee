// AI escape suggestions are applied to a copy of the model and recomputed before anything is shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { applySuggestion, verifySuggestion, passageBoxes, doorBox } from '../src/escape-actions.mjs';

const RAW = JSON.parse(fs.readFileSync(new URL('./fixtures/rcrv-layout.json', import.meta.url), 'utf8'));

test('escape actions: connecting the unconnected external stair gives the science staterooms a second route', () => {
  const v = verifySuggestion(RAW, { actions: [{ type: 'add_passage', deck: '01', from_element: '01-C2', to_element: '01-EXT1', clear_width_mm: 1000 }] });
  assert.equal(v.ok, true);
  for (const id of ['01-SR1', '01-SR2', '01-SR3', '01-SR4', '01-SR5']) assert.ok(v.improved.includes(id), id);
  assert.deepEqual(v.conflicts, []);
  assert.match(v.notes.join(' '), /outside the outline of deck 01/, 'the stair stands outside the deckhouse: an external walkway');
  assert.deepEqual(v.worse, []);
  assert.ok(v.added.every((e) => e.proposed && e.source.startsWith('AI suggestion')), 'proposals are marked as not in the design');
  assert.equal(RAW.elements.some((e) => e.proposed), false, 'the original model is not changed');
});

test('escape actions: a passage that cuts through a cabin is not offered, even when it would help', () => {
  const v = verifySuggestion(RAW, { actions: [{ type: 'add_passage', deck: '01', from_element: '01-SR1', to_element: '01-C1', clear_width_mm: 1000 }] });
  assert.ok(v.improved.length > 0);
  assert.equal(v.ok, false);
  assert.match(v.conflicts.join(' '), /cuts through 01-SR4/);
});

test('escape actions: unknown ids, wrong decks and elements that do not touch are reported, not applied', () => {
  const bad = applySuggestion(RAW, { actions: [
    { type: 'add_passage', deck: '01', from_element: '01-SR1', to_element: 'NOPE' },
    { type: 'add_passage', deck: 'XX', from_element: '01-SR1', to_element: '01-C1' },
    { type: 'add_passage', deck: 'LD', from_element: '01-SR1', to_element: 'LD-ER' },
    { type: 'add_door', deck: '01', from_element: '01-CR1', to_element: '02-SR1' },
  ] });
  assert.equal(bad.added.length, 0);
  assert.equal(bad.problems.length, 4);
  const v = verifySuggestion(RAW, { actions: [{ type: 'add_passage', deck: '01', from_element: '01-SR1', to_element: 'NOPE' }] });
  assert.equal(v.ok, false);
});

test('escape actions: a proposal that helps no room is not offered', () => {
  // A second door between two crew rooms that already have two routes changes nothing.
  const v = verifySuggestion(RAW, { actions: [{ type: 'add_door', deck: '01', from_element: '01-CR1', to_element: '01-CR2', clear_width_mm: 900 }] });
  assert.equal(v.improved.length, 0);
  assert.equal(v.ok, false);
});

test('escape actions: passage and door geometry', () => {
  // side by side along x: one straight piece that reaches 1 mm into both
  assert.deepEqual(passageBoxes({ x: 0, y: 0, lx: 1000, ly: 3000 }, { x: 3000, y: 0, lx: 1000, ly: 3000 }, 1000),
    [{ x: 999, y: 1000, lx: 2002, ly: 1000 }]);
  // diagonal: an L of two pieces
  assert.equal(passageBoxes({ x: 0, y: 0, lx: 1000, ly: 1000 }, { x: 5000, y: 5000, lx: 1000, ly: 1000 }, 900).length, 2);
  // touching rooms get a door in the middle of the shared wall; separate rooms get none
  assert.deepEqual(doorBox({ x: 0, y: 0, lx: 2000, ly: 2000 }, { x: 2000, y: 0, lx: 2000, ly: 2000 }, 900), { x: 1850, y: 550, lx: 300, ly: 900 });
  assert.equal(doorBox({ x: 0, y: 0, lx: 1000, ly: 1000 }, { x: 3000, y: 0, lx: 1000, ly: 1000 }, 900), null);
});
