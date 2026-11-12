// Applicability by date of construction (keel laid) and by element properties that a manual check needs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModel, validateRule, dateRange } from '../src/checker.mjs';

const rule = (id, constructed, extra = {}) => ({
  id, source: 'SOLAS', clause: '1', text: id, check: 'min', parameter: 'clear_width', value: 900, unit: 'mm', verified: false,
  applies_to: { types: ['corridor'], ship: { constructed } }, ...extra,
});
const model = (keel, width = 850) => ({
  name: 'm', units: 'mm', ship: { type: { value: 'cargo' }, ...(keel === undefined ? {} : { keel_laid: { value: keel } }) },
  decks: [{ id: 'D1', name: 'Deck 1', elevation: 0, outline: [[0, 0], [10, 0], [10, 5], [0, 5]] }],
  elements: [
    { id: 'C1', type: 'corridor', name: 'corridor', deck: 'D1', props: { clear_width: { value: width, unit: 'mm' } } },
    { id: 'D1', type: 'door', name: 'fire door', deck: 'D1', props: { fire_rating: { value: 'A-60' } } },
    { id: 'D2', type: 'door', name: 'cabin door', deck: 'D1', props: { fire_rating: { value: 'B-15' } } },
    { id: 'D3', type: 'door', name: 'door', deck: 'D1', props: {} },
  ],
});
const NEW = rule('NEW', { on_or_after: '2028-01-01' });
const OLD = rule('OLD', { before: '2028-01-01' });
const statusOf = (m, id = 'C1') => Object.fromEntries(checkModel(m, [NEW, OLD]).elements[id].results.map((r) => [r.rule_id, r.status]));

test('dates: a day, a month or a year stand for an interval; anything else is not a date', () => {
  assert.deepEqual(dateRange('2028-01-01'), ['2028-01-01', '2028-01-01']);
  assert.deepEqual(dateRange('2028-02'), ['2028-02-01', '2028-02-29']);
  assert.deepEqual(dateRange('2027'), ['2027-01-01', '2027-12-31']);
  assert.equal(dateRange('2027-02-30'), null);
  assert.equal(dateRange('next year'), null);
});

test('the keel laying date selects the edition of a requirement', () => {
  assert.deepEqual(statusOf(model('2028-01-01')), { NEW: 'non_compliant' });
  assert.deepEqual(statusOf(model('2027-12-31')), { OLD: 'non_compliant' });
  assert.deepEqual(statusOf(model('2026')), { OLD: 'non_compliant' });
  const na = checkModel(model('2027-12-31'), [NEW, OLD]).elements.C1.not_applicable.find((n) => n.rule_id === 'NEW');
  assert.match(na.reason, /keel laid 2027-12-31; rule applies to ships constructed on or after 2028-01-01/);
});

test('no keel date, or one that spans the boundary, leaves the rule undecided instead of guessing', () => {
  const none = checkModel(model(undefined), [NEW]).elements.C1.results[0];
  assert.equal(none.status, 'not_enough_info');
  assert.match(none.explanation, /ship\.keel_laid is missing/);
  // A boundary in mid-year: "2026" may be before or after 1 July 2026.
  const MID = rule('MID', { on_or_after: '2026-07-01' });
  const year = checkModel(model('2026'), [MID]).elements.C1.results[0];
  assert.equal(year.status, 'not_enough_info');
  assert.match(year.explanation, /exact ship\.keel_laid date/);
  assert.equal(checkModel(model('2026-08'), [MID]).elements.C1.results[0].status, 'non_compliant');
  // A whole year after a 1 January boundary decides.
  assert.deepEqual(statusOf(model('2028')), { NEW: 'non_compliant' });
});

test('date conditions are validated', () => {
  assert.deepEqual(validateRule(NEW), []);
  assert.ok(validateRule(rule('X', { on_or_after: '2028' })).some((m) => m.includes('YYYY-MM-DD')));
  assert.ok(validateRule(rule('X', {})).some((m) => m.includes('on_or_after')));
  assert.ok(validateRule(rule('X', { on_or_after: '2029-01-01', before: '2028-01-01' })).some((m) => m.includes('must be before')));
});

test('a manual check for A-class doors: applies, does not apply, or applies only if the rating is known', () => {
  const FIRE = {
    id: 'FIRE', source: 'SOLAS II-2/9', clause: 'x', text: 'fire doors self-closing', check: 'manual', verified: false,
    applies_note: 'the door is in an A-class division', applies_to: { types: ['door'], where: { fire_rating: { prefix: ['A-', 'A60'] } } },
  };
  assert.deepEqual(validateRule(FIRE), []);
  const els = checkModel(model('2028-01-01'), [FIRE]).elements;
  assert.deepEqual(els.D1.manual.map((m) => m.applicability), ['applies']);
  assert.deepEqual(els.D2.manual, []);
  assert.match(els.D2.not_applicable[0].reason, /fire_rating is "B-15"/);
  assert.equal(els.D3.manual[0].applicability, 'unknown');
  assert.equal(els.D3.manual[0].reason, 'Applies only if the door is in an A-class division: fire_rating is not set in the model.');
});
