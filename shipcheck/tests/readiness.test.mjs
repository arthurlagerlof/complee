// Submission readiness and the project file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModel, findingsOf } from '../src/checker.mjs';
import { withDisposition, withManualCheck, manualRows } from '../src/dispositions.mjs';
import { addComments, parseComments, withComment } from '../src/class-comments.mjs';
import { readiness } from '../src/readiness.mjs';
import { projectFile, readProjectFile, PROJECT_FORMAT } from '../src/project-file.mjs';
import { toHTML } from '../src/report.mjs';

const RULES = [
  { id: 'W', source: 'Code', clause: '1', text: 'width', check: 'min', parameter: 'clear_width', value: 900, unit: 'mm', verified: false, applies_to: { types: ['corridor'] } },
  { id: 'H', source: 'Code', clause: '2', text: 'height', check: 'min', parameter: 'height', value: 2000, unit: 'mm', verified: true, applies_to: { types: ['corridor'] } },
  { id: 'M', source: 'Code', clause: '3', text: 'marked', check: 'manual', verified: false, applies_to: { types: ['corridor'] } },
];
const model = (width) => ({
  name: 'm', units: 'mm', ship: { type: { value: 'cargo' } },
  decks: [{ id: 'D1', name: 'Deck 1', elevation: 0, outline: [[0, 0], [10, 0], [10, 5], [0, 5]] }],
  elements: [{ id: 'C1', type: 'corridor', name: 'corridor', deck: 'D1', props: { clear_width: { value: width, unit: 'mm' } } }],
});
const ids = (r) => Object.fromEntries(r.items.map((i) => [i.id, i.count]));

test('open work is counted as blockers and warnings; cleared work disappears', () => {
  const results = checkModel(model(850), RULES);
  let register = {};
  let comments = addComments({ comments: [] }, parseComments('1. C1 width to 900 mm.'), { elementIds: ['C1'] }).store;
  let r = readiness({ results, register, comments: comments.comments, rules: RULES, edits: 1 });
  assert.equal(r.ready, false);
  assert.deepEqual(ids(r), { what_if: 1, nc_open: 1, manual: 1, comments_open: 1, missing_info: 1, unverified: 1 });

  const [w] = findingsOf(results).filter((f) => f.rule_id === 'W');
  register = withDisposition(register, w, { disposition: 'deviation' });
  r = readiness({ results, register, comments: comments.comments, rules: RULES });
  assert.equal(ids(r).no_note, 1, 'a deviation needs a justification');
  register = withDisposition(register, w, { note: 'Equivalent arrangement agreed with flag, letter 12/2026' });
  register = withManualCheck(register, manualRows(results, register)[0], { done: true, responsible: 'A. Engineer' });
  comments = withComment(comments, comments.comments[0].id, { status: 'answered', response: 'See equivalence letter.' });
  r = readiness({ results, register, comments: comments.comments, rules: RULES });
  // Answered while the deviation remains, but with a justified deviation in the register: legitimate, no blocker.
  assert.deepEqual(ids(r), { missing_info: 1, unverified: 1 });
  // Without that justification the reply and the design disagree: a blocker.
  const unjustified = withDisposition(register, w, { disposition: 'fix', note: '' });
  assert.equal(ids(readiness({ results, register: unjustified, comments: comments.comments, rules: RULES })).contradicted, 1);

  const fixed = checkModel(model(950), RULES);
  r = readiness({ results: fixed, register, comments: comments.comments, rules: RULES });
  assert.equal(r.ready, true);
  assert.deepEqual(ids(r), { missing_info: 1, unverified: 1 });
  assert.match(toHTML({ title: 't', scenario: 's', results: fixed, model: model(950), rules: RULES, register, comments: comments.comments }), /✓ Ready to submit · 2 warnings/);
});

test('project file round trip; foreign or broken files are refused or flagged', () => {
  const file = projectFile({ project: 'ship:x', model: 'X', revision: 'rev B', register: { 'C1|W': { disposition: 'fix' } }, comments: [{ id: 'c1', text: 'hi' }] }, new Date('2026-11-12T00:00:00Z'));
  assert.equal(file.format, PROJECT_FORMAT);
  const back = readProjectFile(JSON.stringify(file), 'ship:x');
  assert.deepEqual(back.register, { 'C1|W': { disposition: 'fix' } });
  assert.equal(back.comments.length, 1);
  assert.equal(back.other_project, false);
  assert.equal(readProjectFile(JSON.stringify(file), 'ship:y').other_project, true);
  assert.throws(() => readProjectFile('{"format":"ship/1"}', 'ship:x'), /not a Complee project file/);
  assert.throws(() => readProjectFile('nope', 'ship:x'), /not JSON/);
});
