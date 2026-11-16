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
  const planned = readiness({ results, register: unjustified, comments: comments.comments, rules: RULES });
  assert.equal(ids(planned).contradicted, 1);
  // A design change that is only planned leaves the deviation in the design: it blocks the submission.
  assert.equal(ids(planned).fix_planned, 1);
  assert.equal(planned.ready, false);

  const fixed = checkModel(model(950), RULES);
  // The corridor changed (850 -> 950 mm): its manual check was confirmed for the old design and must be checked again.
  r = readiness({ results: fixed, register, comments: comments.comments, rules: RULES });
  assert.equal(ids(r).manual, 1);
  assert.equal(manualRows(fixed, register)[0].stale, true);
  register = withManualCheck(register, manualRows(fixed, register)[0], { done: true, responsible: 'A. Engineer' });
  r = readiness({ results: fixed, register, comments: comments.comments, rules: RULES });
  assert.equal(r.ready, true);
  // Nothing blocks, but one rule check is undecided: never shown as plainly "Ready to submit".
  assert.equal(r.complete, false);
  // The answered comment names the corridor, whose height is still unknown: the check cannot confirm the answer.
  assert.deepEqual(ids(r), { comments_unconfirmed: 1, missing_info: 1, unverified: 1 });
  const html = toHTML({ title: 't', scenario: 's', results: fixed, model: model(950), rules: RULES, register, comments: comments.comments });
  assert.match(html, /No blockers, but 1 rule check undecided · 3 warnings/);
  assert.doesNotMatch(html, /✓ Ready to submit/);
});

test('an empty or broken check is never ready: no results, model data errors, invalid rules', () => {
  const empty = readiness({ results: { elements: {} }, rules: RULES });
  assert.equal(empty.ready, false);
  assert.equal(ids(empty).nothing_checked, 1);
  const results = checkModel({ ...model(950), elements: [...model(950).elements, { ...model(950).elements[0] }] }, RULES);
  assert.equal(ids(readiness({ results, rules: RULES })).model_issues, 1);
  const bad = { id: 'BAD', source: 's', clause: 'c', text: 't', check: 'min', parameter: 'clear_width', value: null, unit: 'mm', applies_to: { types: ['corridor'] }, verified: false };
  assert.equal(ids(readiness({ results: checkModel(model(950), [...RULES, bad]), rules: RULES })).invalid_rules, 1);
});

test('project file round trip; foreign or broken files are refused or flagged', () => {
  const file = projectFile({ project: 'ship:x', model: 'X', revision: 'rev B', register: { 'C1|W': { disposition: 'fix' } }, comments: [{ id: 'c1', text: 'hi' }] }, new Date('2026-11-12T00:00:00Z'));
  assert.equal(file.format, PROJECT_FORMAT);
  const back = readProjectFile(JSON.stringify(file), 'ship:x');
  assert.equal(back.register['C1|W'].disposition, 'fix');
  assert.equal(back.comments.length, 1);
  assert.deepEqual(back.problems, []);
  assert.equal(back.other_project, false);
  assert.equal(readProjectFile(JSON.stringify(file), 'ship:y').other_project, true);
  assert.throws(() => readProjectFile('{"format":"ship/1"}', 'ship:x'), /not a Complee project file/);
  assert.throws(() => readProjectFile('nope', 'ship:x'), /not JSON/);
});

test('a damaged or hand-edited project file is cleaned and the dropped parts are named', () => {
  const raw = JSON.stringify({
    format: PROJECT_FORMAT, project: 'ship:x',
    register: {
      'C1|W': { disposition: 'waived', responsible: 42, note: null },
      'C1|M': { kind: 'manual', done: true, responsible: '  ' },
      'C2|M': { kind: 'manual', done: true, responsible: 'A. Engineer', fingerprint: 'abc' },
      'no-rule': { disposition: 'fix' },
      'C3|W': null,
    },
    comments: [{ id: 'c1', text: 'a', links: { elements: 'C1', rules: ['W', 3] }, status: 'weird' }, { id: 'c1', text: 'again' }, { id: 7, text: 'x' }, null],
  });
  const p = readProjectFile(raw, 'ship:x');
  assert.equal(p.register['C1|W'].disposition, 'open', 'unknown disposition becomes open');
  assert.equal(p.register['C1|W'].responsible, '42');
  assert.equal(p.register['C1|W'].note, '');
  assert.equal(p.register['C1|M'].done, false, 'done without a name is not confirmed');
  assert.equal(p.register['C2|M'].done, true);
  assert.equal(p.register['C2|M'].fingerprint, 'abc');
  assert.deepEqual(Object.keys(p.register).sort(), ['C1|M', 'C1|W', 'C2|M']);
  assert.deepEqual(p.comments.map((c) => c.id), ['c1']);
  assert.deepEqual(p.comments[0].links, { elements: [], rules: ['W'] });
  assert.equal(p.comments[0].status, 'open');
  assert.equal(p.problems.length, 4);
  assert.match(p.problems.join(' '), /2 register entries.*1 manual check.*2 class comments.*1 class comment with an id/);
});

test('saving and opening a project file leaves the register as it was (nothing turns stale)', () => {
  const results = checkModel(model(850), RULES);
  let register = {};
  const [w] = findingsOf(results).filter((f) => f.rule_id === 'W');
  register = withDisposition(register, w, { disposition: 'deviation', note: 'Agreed with flag', responsible: 'A. Engineer' });
  register = withManualCheck(register, manualRows(results, register)[0], { done: true, responsible: 'A. Engineer' });
  const back = readProjectFile(JSON.stringify(projectFile({ project: 'p', register })), 'p').register;
  assert.deepEqual(readiness({ results, register: back, rules: RULES }).items, readiness({ results, register, rules: RULES }).items);
  assert.equal(manualRows(results, back)[0].done, true);
});
