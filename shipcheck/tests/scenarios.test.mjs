import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios, loadModel, readJSON, runCheck } from '../src/load.mjs';

const DATABASE = !!process.env.SHIPCHECK_DATA_API_URL;

test('all scenarios of the catalog are available, including the simplified model example', async () => {
  const scenarios = await loadScenarios();
  const ids = scenarios.map((s) => s.id).sort();
  if (DATABASE) {
    assert.deepEqual(ids, ['cruise', 'rcrv-3d', 'rcrv-inside', 'rcrv-layout']);
    const production = scenarios.find((s) => s.id === 'rcrv-3d');
    assert.equal(production.viewer, 'local', 'the production model uses the server-side model gateway');
    assert.equal(scenarios.find((s) => s.id === 'rcrv-inside').viewer, 'local', 'the in-ship scene uses the same streamed real-model viewer');
  } else {
    // Bundled catalog: every scenario whose model file is bundled, the general arrangement first.
    // The scene inside the production model needs the streamed 3D model, so it is not offered either.
    assert.deepEqual(ids, ['cruise', 'rcrv-layout']);
    assert.equal(scenarios[0].id, 'rcrv-layout', 'the bundled general arrangement opens by default');
  }
  const inside = scenarios.find((s) => s.id === 'rcrv-inside');
  if (inside) assert.equal(inside.scene, true);
  if (inside) for (const e of (await loadModel(inside)).elements) assert.ok(e.geom3d?.min?.length === 3 && e.geom3d?.max?.length === 3, `${e.id} has a position in the real model`);
  const simplified = scenarios.find((s) => s.id === 'rcrv-layout');
  assert.match(simplified.name, DATABASE ? /^Simplified research vessel \(example\)$/ : /general arrangement and escape plan/);
  assert.equal(simplified.model, 'ships/rcrv/layout.json');
  assert.equal(simplified.expected, 'tests/expected/rcrv-layout.json');
  assert.equal(simplified.viewer, 'three');
});

test('production layout preserves fixture inputs and clearly identifies estimated example geometry', { skip: DATABASE ? 'the database copy predates the escape-route network of the bundled layout' : false }, async () => {
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
