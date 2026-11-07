import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios, loadModel, readJSON, runCheck } from '../src/load.mjs';

test('all scenarios are available, including the simplified Three.js example and the scene inside the real ship', () => {
  const scenarios = loadScenarios();
  assert.deepEqual(scenarios.map((s) => s.id).sort(), ['cruise', 'rcrv-3d', 'rcrv-inside', 'rcrv-layout']);
  const inside = scenarios.find((s) => s.id === 'rcrv-inside');
  assert.equal(inside.viewer, 'aps', 'shown in the real-model viewer');
  assert.equal(inside.scene, true);
  for (const e of loadModel(inside).elements) assert.ok(e.geom3d?.min?.length === 3 && e.geom3d?.max?.length === 3, `${e.id} has a position in the real model`);
  const simplified = scenarios.find((s) => s.id === 'rcrv-layout');
  assert.equal(simplified.name, 'Simplified research vessel (example)');
  assert.equal(simplified.model, 'ships/rcrv/layout.json');
  assert.equal(simplified.expected, 'tests/expected/rcrv-layout.json');
  assert.equal(simplified.viewer, 'three');
});

test('production layout preserves fixture inputs and clearly identifies estimated example geometry', () => {
  const scenario = loadScenarios().find((s) => s.id === 'rcrv-layout');
  const model = loadModel(scenario);
  const { name, provenance_note, ...inputs } = model;
  const { name: fixtureName, provenance_note: fixtureNote, ...fixtureInputs } = readJSON('tests/fixtures/rcrv-layout.json');
  assert.deepEqual(inputs, fixtureInputs, 'geometry, parameters, units and input provenance must stay unchanged');
  assert.match(name, /simplified.*estimated example/i);
  assert.match(provenance_note, /simplified, estimated example/i);
  assert.match(provenance_note, /not measured real geometry/i);
});

test('registered simplified scenario detects all 8 expected findings with no false alarms', () => {
  const { scenario, score } = runCheck('rcrv-layout');
  assert.equal(scenario, 'rcrv-layout');
  assert.equal(score.expected, 8);
  assert.equal(score.detected, 8);
  assert.deepEqual(score.false_alarms, []);
  assert.deepEqual(score.missed, []);
  assert.deepEqual(score.wrong_status, []);
  assert.deepEqual(score.failed_passes, []);
  assert.equal(score.pass, true);
});
