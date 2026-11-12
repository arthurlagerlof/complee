// Escape-route analysis on the bundled research-vessel layout (tests/fixtures/rcrv-layout.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeModel } from '../src/checker.mjs';
import { analyzeEscape, buildEscapeGraph, MIN_OPENING_MM } from '../src/escape.mjs';

const RAW = JSON.parse(fs.readFileSync(new URL('./fixtures/rcrv-layout.json', import.meta.url), 'utf8'));
const model = () => normalizeModel(structuredClone(RAW));
const rooms = (a) => Object.values(a.origins).filter((o) => o.room);

test('escape: every room reaches the muster station; the summary counts rooms only', () => {
  const a = analyzeEscape(model());
  assert.equal(a.available, true);
  assert.deepEqual(a.musters, ['MD-MUSTER']);
  assert.equal(a.summary.no_route, 0);
  assert.equal(a.summary.two_routes + a.summary.single_route + a.summary.direct, rooms(a).length);
  for (const o of rooms(a)) {
    assert.equal(o.primary.muster, 'MD-MUSTER');
    assert.equal(o.primary.via[0], o.id, 'a route starts in its room');
    assert.ok(o.primary.length_mm > 0);
    if (o.secondary) assert.ok(o.secondary.length_mm >= o.primary.length_mm, `${o.id}: the alternative is never shorter`);
  }
});

test('escape: the alternative shares no stair, ladder, escape trunk or door with the shortest route', () => {
  for (const o of rooms(analyzeEscape(model()))) {
    if (!o.secondary) continue;
    const gates = new Set([...o.primary.verticals, ...o.primary.doors]);
    for (const g of [...o.secondary.verticals, ...o.secondary.doors]) assert.ok(!gates.has(g), `${o.id}: ${g} is on both routes`);
  }
});

test('escape: agrees with the planted finding (science berthing has one means of escape; crew and officers have two)', () => {
  const a = analyzeEscape(model());
  for (const id of ['01-SR1', '01-SR2', '01-SR3', '01-SR4', '01-SR5']) {
    assert.equal(a.origins[id].status, 'single_route', id);
    assert.ok(a.origins[id].shared_gates.includes('01-D2'), `${id} depends on the fire door`);
  }
  for (const id of ['01-CR1', '01-CR8', '02-SR1', '02-SR6', 'LD-ER']) assert.equal(a.origins[id].status, 'two_routes', id);
  assert.deepEqual(a.origins['LD-ER'].secondary.verticals, ['LD-ET1'], 'engine room: the alternative uses the escape trunk');
});

test('escape: a stair that opens to nothing at its upper end is reported, not silently used', () => {
  const a = analyzeEscape(model());
  assert.deepEqual(a.disconnected.map((d) => d.id), ['01-EXT1']);
  for (const o of rooms(a)) assert.ok(!o.primary.via.includes('01-EXT1'));
});

test('escape: rooms are never a shortcut between corridors, and a 100 mm gap is a closed bulkhead', () => {
  const g = buildEscapeGraph(model());
  const portals = g.nodes.filter((n) => n.a);
  const linked = (x, y) => portals.some((n) => (n.a === x && n.b === y) || (n.a === y && n.b === x));
  assert.equal(linked('01-SR4', '01-C1'), false, 'stateroom 4 is 100 mm short of the main corridor');
  assert.equal(linked('01-C3', '01-C1'), false, 'the cross passage reaches the main corridor only through the fire door');
  assert.equal(linked('01-CR1', '01-CR2'), false, 'no opening is assumed between two rooms');
  for (const n of portals) assert.ok(n.width >= MIN_OPENING_MM, `${n.a}/${n.b} opening width`);
  // Crew stateroom 5 touches both the cross passage and the main corridor, but is not a way around the fire door.
  const a = analyzeEscape(model());
  assert.ok(!a.origins['01-SR1'].primary.via.includes('01-CR5'));
});

test('escape what-if: blocking the main stair reroutes the crew and cuts off the science berthing', () => {
  const a = analyzeEscape(model(), { blocked: new Set(['MD-ST1']) });
  assert.deepEqual(a.blocked, ['MD-ST1']);
  assert.equal(a.origins['MD-ST1'], undefined);
  assert.equal(a.origins['03-WH'].status, 'no_route', 'the pilothouse has only the stair tower');
  // Without the stair landing the forward escape ladder cannot be reached either.
  assert.equal(a.origins['01-CR1'].status, 'no_route');
  const door = analyzeEscape(model(), { blocked: new Set(['MD-D1']) });
  assert.ok(door.origins['MD-MAINLAB'].primary.via.includes('MD-D3'), 'labs leave through the hangar door instead');
  assert.ok(!door.origins['MD-MAINLAB'].primary.via.includes('MD-D1'));
});

test('escape: a model without a muster station is not analysed as if it had one', () => {
  const m = model();
  m.elements = m.elements.filter((e) => e.type !== 'muster_station');
  const a = analyzeEscape(m);
  assert.equal(a.available, false);
  assert.equal(a.summary.no_route, rooms(a).length);
});

test('escape: the analysis is deterministic and does not change the model', () => {
  const m = model(), before = JSON.stringify(m);
  const first = JSON.stringify(analyzeEscape(m));
  assert.equal(JSON.stringify(analyzeEscape(m)), first);
  assert.equal(JSON.stringify(m), before);
});
