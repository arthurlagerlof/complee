// Escape-route analysis on the bundled research-vessel layout (tests/fixtures/rcrv-layout.json).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizeModel } from '../src/checker.mjs';
import { analyzeEscape, buildEscapeGraph, MIN_OPENING_MM, _disjointPair } from '../src/escape.mjs';

const RAW = JSON.parse(fs.readFileSync(new URL('./fixtures/rcrv-layout.json', import.meta.url), 'utf8'));
const model = () => normalizeModel(structuredClone(RAW));
const rooms = (a) => Object.values(a.origins).filter((o) => o.room);

test('escape: every room reaches the muster station; the summary counts rooms only', () => {
  const a = analyzeEscape(model());
  assert.equal(a.available, true);
  assert.deepEqual(a.musters, ['MD-MUSTER']);
  assert.equal(a.summary.no_route, 0);
  assert.equal(a.summary.two_routes + a.summary.shared_route + a.summary.single_route + a.summary.direct, rooms(a).length);
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
  // Crew and officers reach the muster station by two stairs, but both ways meet again in the main deck corridor
  // MD-C1: a fire there blocks both, so they are not independent (blocking MD-C1 leaves them without a route).
  for (const id of ['01-CR1', '01-CR8', '02-SR1', '02-SR6']) {
    assert.equal(a.origins[id].status, 'shared_route', id);
    assert.ok(a.origins[id].shared.includes('MD-C1'), id + ' shares MD-C1');
    assert.equal(analyzeEscape(model(), { blocked: new Set(['MD-C1']) }).origins[id].status, 'no_route', id + ' without MD-C1');
  }
  // The labs open into MD-C1, which leads two ways out: both routes start there and separate (SOLAS counts the corridor).
  assert.equal(a.origins['MD-WETLAB'].status, 'two_routes');
  assert.deepEqual(a.origins['MD-WETLAB'].common_start, ['MD-C1']);
  assert.equal(a.origins['LD-ER'].status, 'two_routes');
  assert.deepEqual(a.origins['LD-ER'].secondary.verticals, ['LD-ET1'], 'engine room: the alternative uses the escape trunk');
});

test('escape: rooms rely on openings assumed where no door is modelled, and the result says so', () => {
  const a = analyzeEscape(model());
  assert.ok(a.rooms_with_assumed_openings > 0);
  assert.ok(a.origins['01-CR1'].assumed_openings.length > 0);
  assert.ok(a.assumptions.some((t) => /assumed/.test(t)));
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

test('escape what-if: blocking the main stair sends everyone above the main deck down the forward escape ladder', () => {
  const a = analyzeEscape(model(), { blocked: new Set(['MD-ST1']) });
  assert.deepEqual(a.blocked, ['MD-ST1']);
  assert.equal(a.origins['MD-ST1'], undefined);
  for (const id of ['03-WH', '01-CR1', '01-SR1', '02-SR1']) {
    assert.ok(a.origins[id].primary.via.includes('01-ESC1'), `${id} leaves by the escape ladder`);
    assert.ok(!a.origins[id].primary.via.includes('MD-ST1'), `${id} does not use the blocked stair`);
    assert.equal(a.origins[id].status, 'single_route', `${id}: with the stair gone the ladder is the only way`);
  }
  const door = analyzeEscape(model(), { blocked: new Set(['MD-D1']) });
  assert.ok(door.origins['MD-MAINLAB'].primary.via.includes('MD-D3'), 'labs leave through the hangar door instead');
  assert.ok(!door.origins['MD-MAINLAB'].primary.via.includes('MD-D1'));
});

test('escape: the alternative never even crosses a stair landing or door of the shortest route', () => {
  // Regression: an alternative once crossed the main stair landing on deck 01, so blocking that stair cut both routes.
  const a = analyzeEscape(model());
  for (const o of rooms(a)) {
    if (!o.secondary) continue;
    for (const gate of [...o.primary.verticals, ...o.primary.doors]) assert.ok(!o.secondary.via.includes(gate), `${o.id}: ${gate} is on both routes`);
    const without = analyzeEscape(model(), { blocked: new Set(o.primary.verticals) });
    assert.notEqual(without.origins[o.id].status, 'no_route', `${o.id}: blocking the first route's stairs must leave a way out`);
  }
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

// ---------- small arrangements from the review of 15 Nov 2026 ----------
const deck = (id, elevation = 0) => ({ id, name: id, elevation, height: 2700, outline: [[-20000, -20000], [100000, -20000], [100000, 40000], [-20000, 40000]] });
const el = (id, type, x, y, lx, ly, extra = {}) => ({ id, type, name: id, deck: extra.deck ?? 'D1', geom: { x, y, lx, ly, h: extra.h ?? 2500 }, props: {} });
const run = (elements, decks = [deck('D1')]) => analyzeEscape(normalizeModel({ units: 'mm', ship: {}, decks, elements }));

test('escape: two doors into one dead-end corridor are not two independent routes', () => {
  const a = run([el('R', 'space', 0, 0, 4000, 3000), el('D1', 'door', 500, 3000, 900, 100), el('D2', 'door', 2500, 3000, 900, 100),
    el('C', 'corridor', 0, 3100, 30000, 1500), el('M', 'muster_station', 30000, 3100, 3000, 1500)]);
  assert.equal(a.origins.R.status, 'shared_route');
  assert.deepEqual(a.origins.R.shared, ['C']);
});

test('escape: a room on a long dead-end corridor is a single route, not "direct"', () => {
  const a = run([el('R', 'space', 0, 0, 3000, 3000), el('C', 'corridor', 0, 3000, 60000, 1500), el('M', 'muster_station', 60000, 3000, 3000, 1500)]);
  assert.equal(a.origins.R.status, 'single_route');
  assert.deepEqual(a.origins.R.shared_gates, ['C']);
  assert.deepEqual(a.origins.R.assumed_openings, ['R/C'], 'no door is modelled: the opening is assumed and said so');
});

test('escape: a corridor that leads two ways gives two routes, and the exact search finds separate routes the greedy one misses', () => {
  // Shortest: R > D1 > A > D5 > L > B > D4 > Mb. Separate pair: R > D1 > A > D3 > Ma and R > D2 > N1 > N2 > B > D4 > Mb.
  const a = run([
    el('R', 'space', 20000, 10000, 4000, 4000),
    el('D1', 'door', 21500, 14000, 900, 100), el('A', 'corridor', -10000, 14100, 50000, 1500),
    el('D3', 'door', -9500, 15600, 900, 100), el('Ma', 'muster_station', -10000, 15700, 3000, 2000),
    el('D5', 'door', 30000, 14000, 900, 100), el('L', 'corridor', 30000, 3000, 1500, 11000),
    el('B', 'corridor', 0, 1500, 40000, 1500), el('D4', 'door', 32000, 1400, 900, 100), el('Mb', 'muster_station', 31500, -600, 3000, 2000),
    el('D2', 'door', 21500, 9900, 900, 100), el('N1', 'corridor', 5000, 8400, 17500, 1500), el('N2', 'corridor', 5000, 3000, 1500, 5400),
  ]);
  const o = a.origins.R;
  // Both routes leave through D1 into A and go opposite ways (D5 east, D3 west): a corridor with two ways out.
  assert.equal(o.status, 'two_routes');
  assert.deepEqual(o.common_start, ['D1', 'A']);
  assert.notEqual(o.primary.via[o.primary.via.indexOf('A') + 1], o.secondary.via[o.secondary.via.indexOf('A') + 1]);
  // The exact search alone: two routes that share nothing at all (through D1 and through D2).
  const m = normalizeModel({ units: 'mm', ship: {}, decks: [deck('D1')], elements: [
    el('R', 'space', 20000, 10000, 4000, 4000), el('D1', 'door', 21500, 14000, 900, 100), el('A', 'corridor', -10000, 14100, 50000, 1500),
    el('D3', 'door', -9500, 15600, 900, 100), el('Ma', 'muster_station', -10000, 15700, 3000, 2000), el('D5', 'door', 30000, 14000, 900, 100),
    el('L', 'corridor', 30000, 3000, 1500, 11000), el('B', 'corridor', 0, 1500, 40000, 1500), el('D4', 'door', 32000, 1400, 900, 100),
    el('Mb', 'muster_station', 31500, -600, 3000, 2000), el('D2', 'door', 21500, 9900, 900, 100), el('N1', 'corridor', 5000, 8400, 17500, 1500),
    el('N2', 'corridor', 5000, 3000, 1500, 5400)] });
  const pair = _disjointPair(buildEscapeGraph(m), 'R');
  assert.ok(pair, 'two separate routes exist');
  const [p, q] = pair.map((s) => [...s].filter((e) => !['R', 'Ma', 'Mb'].includes(e)));
  assert.ok(!p.some((e) => q.includes(e)), JSON.stringify([p, q]));
  assert.ok([p, q].some((r) => r.includes('D3')) && [p, q].some((r) => r.includes('N1')));
});

test('escape: a stair through two tween decks serves the deck in between; a narrow door still connects', () => {
  const a = run([el('S', 'stair', 0, 0, 2000, 4000, { h: 5400 }),
    el('C2', 'corridor', 2000, 0, 10000, 1500, { deck: 'D2' }), el('R2', 'space', 2000, 1500, 3000, 3000, { deck: 'D2' }),
    el('C3', 'corridor', 2000, 0, 10000, 1500, { deck: 'D3' }), el('M', 'muster_station', 12000, 0, 3000, 1500, { deck: 'D3' })],
  [deck('D1', 0), deck('D2', 2700), deck('D3', 5400)]);
  assert.notEqual(a.origins.R2.status, 'no_route');
  assert.ok(a.origins.R2.primary.via.includes('S'));
  const narrow = run([el('R', 'space', 0, 0, 3000, 3000), el('D', 'door', 1000, 2950, 650, 100), el('C', 'corridor', 0, 3100, 10000, 1500), el('M', 'muster_station', 10000, 3100, 3000, 1500)]);
  assert.ok(narrow.origins.R.primary.via.includes('D'), 'a 650 mm door is a door; its width is the rule check\'s question');
});
