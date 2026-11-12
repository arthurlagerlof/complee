// Streamed AI answers are shown while they are written: every prefix of a JSON answer must read as far as it goes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePartialJson } from '../src/partial-json.mjs';

test('partial JSON: every prefix parses, text grows word by word, the end is the full answer', () => {
  const answer = { summary: 'Door MD-D1: sill 300 mm, required 380 mm.', reasons: ['a "quoted" word', 'back\slash'], options: [{ change: 'raise the sill', effect: 'passes' }], suggestions: [] };
  const text = JSON.stringify(answer, null, 2);
  let previous = '';
  for (let i = 1; i <= text.length; i++) {
    const value = parsePartialJson(text.slice(0, i));
    if (value?.summary != null) {
      assert.ok(answer.summary.startsWith(value.summary), `prefix ${i}: summary is a prefix of the final text`);
      assert.ok(value.summary.length >= previous.length, `prefix ${i}: the summary never shrinks`);
      previous = value.summary;
    }
  }
  assert.deepEqual(parsePartialJson(text), answer);
});

test('partial JSON: text before the JSON and nothing useful yet', () => {
  assert.equal(parsePartialJson(''), null);
  assert.equal(parsePartialJson('Sure, here it is'), null);
  assert.deepEqual(parsePartialJson('```json\n{"a": [1, 2'), { a: [1, 2] });
});
