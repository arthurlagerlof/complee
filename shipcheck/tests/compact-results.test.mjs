// Compact results (explanations and inputs computed when read) must give exactly what full results give.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkModel, recheckElements, findingsOf } from '../src/checker.mjs';

const read = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const RULES = read('../catalog/rules.json').rules;
const MODELS = { layout: read('./fixtures/rcrv-layout.json'), cruise: read('../catalog/ships/cruise/deck.json'), inside: read('../catalog/ships/rcrv/inside.json') };

test('compact and full results are the same, field by field, also as JSON and as findings', () => {
  for (const [name, m] of Object.entries(MODELS)) {
    const lazy = checkModel(structuredClone(m), RULES), eager = checkModel(structuredClone(m), RULES, { details: 'eager' });
    assert.equal(JSON.stringify(lazy), JSON.stringify(eager), `${name}: JSON`);
    for (const [id, e] of Object.entries(eager.elements)) {
      e.results.forEach((r, i) => {
        const c = lazy.elements[id].results[i];
        for (const k of Object.keys(r)) assert.deepEqual(c[k], r[k], `${name} ${id} ${r.rule_id}.${k}`);
      });
    }
    assert.equal(JSON.stringify(findingsOf(lazy)), JSON.stringify(findingsOf(eager)), `${name}: findings`);
    const f = findingsOf(lazy)[0];
    if (f) assert.ok(f.explanation.length > 0 && Array.isArray(f.inputs) && f.rule_text, `${name}: a finding reads its details`);
  }
});

test('compact results stay compact: no explanation or inputs are stored until read', () => {
  const out = checkModel(structuredClone(MODELS.layout), RULES);
  const r = Object.values(out.elements).flatMap((e) => e.results)[0];
  assert.deepEqual(Object.keys(r).filter((k) => ['explanation', 'inputs', 'rule_text', 'source'].includes(k)), []);
  assert.ok(r.explanation, 'computed on demand');
});

test('a re-check after an edit keeps compact results whose details follow the edit', () => {
  const m = structuredClone(MODELS.layout);
  const base = checkModel(m, RULES);
  const door = m.elements.find((e) => e.id === 'MD-D1');
  door.props.sill_height = { value: 400, unit: 'mm', source: 'edited' };
  const after = recheckElements(base, m, RULES, ['MD-D1'], { inPlace: true });
  const full = checkModel(structuredClone(m), RULES, { details: 'eager' });
  assert.equal(JSON.stringify(after.elements['MD-D1']), JSON.stringify(full.elements['MD-D1']));
  assert.match(after.elements['MD-D1'].results.find((r) => r.rule_id === 'LL-REG12-SILL').explanation, /400 mm/);
});
