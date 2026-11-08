import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios, loadModel, readJSON, runCheck } from '../src/load.mjs';

test('all database scenarios are available, including streamed and simplified model examples', async () => {
  const scenarios = await loadScenarios();
  assert.deepEqual(scenarios.map((s) => s.id).sort(), ['cruise', 'rcrv-3d', 'rcrv-inside', 'rcrv-layout']);
  const production = scenarios.find((s) => s.id === 'rcrv-3d');
  assert.equal(production.viewer, 'local', 'the production model uses the server-side model gateway');
  const inside = scenarios.find((s) => s.id === 'rcrv-inside');
  assert.equal(inside.viewer, 'local', 'the in-ship scene uses the same streamed real-model viewer');
  assert.equal(inside.scene, true);
  for (const e of (await loadModel(inside)).elements) assert.ok(e.geom3d?.min?.length === 3 && e.geom3d?.max?.length === 3, `${e.id} has a position in the real model`);
  const simplified = scenarios.find((s) => s.id === 'rcrv-layout');
  assert.equal(simplified.name, 'Simplified research vessel (example)');
  assert.equal(simplified.model, 'ships/rcrv/layout.json');
  assert.equal(simplified.expected, 'tests/expected/rcrv-layout.json');
  assert.equal(simplified.viewer, 'three');
});

test('production layout preserves fixture inputs and clearly identifies estimated example geometry', async () => {
  const scenario = (await loadScenarios()).find((s) => s.id === 'rcrv-layout');
  const model = await loadModel(scenario);
  const { name, provenance_note, ...inputs } = model;
  const { name: fixtureName, provenance_note: fixtureNote, ...fixtureInputs } = readJSON('tests/fixtures/rcrv-layout.json');
  assert.deepEqual(inputs, fixtureInputs, 'geometry, parameters, units and input provenance must stay unchanged');
  assert.match(name, /simplified.*estimated example/i);
  assert.match(provenance_note, /simplified, estimated example/i);
  assert.match(provenance_note, /not measured real geometry/i);
});

test('registered simplified scenario detects all 8 expected findings with no false alarms', async () => {
  const { scenario, score } = await runCheck('rcrv-layout');
  assert.equal(scenario, 'rcrv-layout');
  assert.equal(score.expected, 8);
  assert.equal(score.detected, 8);
  assert.deepEqual(score.false_alarms, []);
  assert.deepEqual(score.missed, []);
  assert.deepEqual(score.wrong_status, []);
  assert.deepEqual(score.failed_passes, []);
  assert.equal(score.pass, true);
});
