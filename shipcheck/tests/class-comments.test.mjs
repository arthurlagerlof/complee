// Class comments: import from a letter or a comment sheet, links to the model, status against the rule check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModel } from '../src/checker.mjs';
import { parseComments, findLinks, addComments, withComment, withoutComment, commentEvidence, commentSummary, commentsCSV } from '../src/class-comments.mjs';
import { toHTML } from '../src/report.mjs';

const RULES = [{ id: 'W-MIN', source: 'Code', clause: '1', text: 'width', check: 'min', parameter: 'clear_width', value: 900, unit: 'mm', verified: false, applies_to: { types: ['corridor'] } }];
const model = (w1 = 850, w2 = 950) => ({
  name: 'm', units: 'mm', ship: { type: { value: 'cargo' } },
  decks: [{ id: 'D1', name: 'Deck 1', elevation: 0, outline: [[0, 0], [10, 0], [10, 5], [0, 5]] }],
  elements: [
    { id: 'MD-C1', type: 'corridor', name: 'corridor 1', deck: 'D1', props: { clear_width: { value: w1, unit: 'mm' } } },
    { id: 'MD-C10', type: 'corridor', name: 'corridor 10', deck: 'D1', props: { clear_width: { value: w2, unit: 'mm' } } },
    { id: 'MD-D1', type: 'door', name: 'door', deck: 'D1', props: {} },
  ],
});
const IDS = ['MD-C1', 'MD-C10', 'MD-D1'];

test('a class letter is split into numbered comments; the letter head is not a comment', () => {
  const t = 'Dear Sirs,\nour comments on drawing 123-GA:\n1. Corridor MD-C1 clear width to be min. 900 mm,\n   please revise.\n2) Door MD-D1: confirm self-closing device.\nComment 3: Second means of escape to be shown.\n';
  assert.deepEqual(parseComments(t), [
    { ref: '1', text: 'Corridor MD-C1 clear width to be min. 900 mm, please revise.' },
    { ref: '2', text: 'Door MD-D1: confirm self-closing device.' },
    { ref: '3', text: 'Second means of escape to be shown.' },
  ]);
});

test('a comment sheet (CSV with quotes, semicolons) keeps number, document, status and response', () => {
  const csv = 'No;Comment;Drawing;Status;Response\n4.1;"Rail height, ""see"" MD-C1";GA-01;closed;Revised\n4.2;Provide fire plan;FCP;;';
  assert.deepEqual(parseComments(csv), [
    { ref: '4.1', text: 'Rail height, "see" MD-C1', document: 'GA-01', status: 'closed', response: 'Revised' },
    { ref: '4.2', text: 'Provide fire plan', document: 'FCP', status: 'open', response: '' },
  ]);
  assert.deepEqual(parseComments('Comment one.\n\nComment two\non two lines.'), [{ ref: '1', text: 'Comment one.' }, { ref: '2', text: 'Comment two on two lines.' }]);
});

test('only exact ids are linked, never a prefix of a longer id', () => {
  assert.deepEqual(findLinks('See md-c1 and W-MIN', IDS, ['W-MIN']), { elements: ['MD-C1'], rules: ['W-MIN'] });
  assert.deepEqual(findLinks('See MD-C10 only', IDS, []), { elements: ['MD-C10'], rules: [] });
});

test('the current rule check decides the evidence; answering a still-failing comment is flagged', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  let { store, added } = addComments({ comments: [] }, parseComments('1. MD-C1 width.\n2. MD-D1 closer.\n3. General arrangement.'), { document: 'GA', elementIds: IDS, ruleIds: ['W-MIN'] }, now);
  assert.equal(added, 3);
  // Importing the same list again adds nothing.
  assert.equal(addComments(store, parseComments('1. MD-C1 width.'), { document: 'GA', elementIds: IDS }, now).added, 0);
  const [c1, c2, c3] = store.comments;
  const before = checkModel(model(850), RULES);
  assert.equal(commentEvidence(c1, before).state, 'finding');
  assert.equal(commentEvidence(c2, before).state, 'missing'); // no rule applies to the door
  assert.equal(commentEvidence(c3, before).state, 'unlinked');
  assert.throws(() => withComment(store, c1.id, { status: 'answered' }), /Write the response/);
  store = withComment(store, c1.id, { status: 'answered', response: 'Width increased to 950 mm in rev C.' }, now);
  assert.equal(commentSummary(store.comments, before).contradicted, 1);
  const after = checkModel(model(950), RULES);
  assert.equal(commentEvidence(store.comments[0], after).state, 'no_finding');
  assert.deepEqual(commentSummary(store.comments, after), { total: 3, open: 2, answered: 1, closed: 0, contradicted: 0 });
  assert.match(commentsCSV(store.comments, after), /"Rule check: no deviation now","Answered, waiting for class","Width increased/);
  assert.match(toHTML({ title: 't', scenario: 's', results: after, model: model(950), rules: RULES, comments: store.comments }), /Class comments \(3\)/);
  assert.equal(withoutComment(store, c3.id).comments.length, 2);
});
