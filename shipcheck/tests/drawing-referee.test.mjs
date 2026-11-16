// The independent geometry check of a drawing conversion (src/drawing/referee.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { referee } from '../src/drawing/referee.mjs';

const OUTLINE = [[0, -5000], [30000, -5000], [34000, 0], [30000, 5000], [0, 5000]];
const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const geom = (x, y, lx, ly, h = 2600) => ({ x, y, z: 0, lx, ly, h });

function sample() {
  const model = {
    units: 'mm',
    decks: [
      { id: 'MD', name: 'Main Deck', elevation: 3000, height: 2600, outline: OUTLINE },
      { id: '01', name: '01 Deck', elevation: 5600, height: 2600, outline: OUTLINE },
    ],
    elements: [
      { id: 'MD-S-1', type: 'space', name: 'Mess', deck: 'MD', geom: geom(1000, -3000, 4000, 4000) },
      { id: 'MD-S-2', type: 'space', name: 'Galley', deck: 'MD', geom: geom(5000, -3000, 4000, 4000) },
      { id: 'MD-C-1', type: 'corridor', name: 'Corridor', deck: 'MD', geom: geom(1000, 1000, 8000, 1200, 150), props: { clear_width: { value: 1150, unit: 'mm', basis: 'measured' } } },
      { id: 'MD-D-1', type: 'door', name: 'Door', deck: 'MD', geom: geom(4950, -1000, 100, 800, 2000), props: { clear_width: { value: 800, unit: 'mm' }, connects: ['MD-S-1', 'MD-S-2'] } },
      { id: 'MD-ST-1', type: 'stair', name: 'Stair', deck: 'MD', geom: geom(10000, 0, 3000, 1000, 2600) },
      { id: 'MD-W-1', type: 'wall', name: 'Wall', deck: 'MD', geom: geom(4950, -3000, 100, 4000) },
    ],
  };
  const recon = {
    rooms: [
      { id: 'MD-S-1', deck: 'MD', polygon: sq(1000, -3000, 4000), z0: 3000, z1: 5600 },
      { id: 'MD-S-2', deck: 'MD', polygon: sq(5000, -3000, 4000), z0: 3000, z1: 5600 },
    ],
    walls: [{ id: 'MD-W-1', deck: 'MD', a: [5000, -3000], b: [5000, 1000], thickness: 100, z0: 3000, z1: 5600, openings: [] }],
    doors: [{ id: 'MD-D-1', deck: 'MD', hinge: [5000, -1000], width: 800, wallDir: [0, 1], swing: 1, z0: 3000, z1: 5000 }],
    stairs: [{ id: 'MD-ST-1', deck: 'MD', polygon: sq(10000, 0, 1000), dir: [1, 0], z0: 3000, z1: 5600, treads: 13 }],
  };
  return { model, recon };
}

test('a consistent conversion has no issues', () => {
  const { model, recon } = sample();
  const r = referee(model, recon);
  assert.deepEqual(r.issues, []);
  assert.equal(r.ok, true);
});

test('overlapping rooms, a room outside the deck, a door off the wall and a stair to nowhere are named', () => {
  const { model, recon } = sample();
  recon.rooms[1].polygon = sq(3000, -3000, 4000);         // half of it on top of the mess
  recon.rooms.push({ id: 'MD-S-3', deck: 'MD', polygon: sq(20000, 3000, 4000), z0: 3000, z1: 5600 }); // sticks out to port
  model.elements.push({ id: 'MD-S-3', type: 'space', name: 'Store', deck: 'MD', geom: geom(20000, 3000, 4000, 4000) });
  recon.doors[0].hinge = [7000, -1000];
  recon.stairs[0].z1 = 4400;
  const what = referee(model, recon).issues.map((i) => i.what).sort();
  assert.deepEqual(what, ['door_off_wall', 'room_outside_deck', 'room_overlap', 'stair_end']);
});

test('contradictions the rule checker would read are errors', () => {
  const { model, recon } = sample();
  model.elements[2].props.clear_width.value = 1900;       // wider than the drawn corridor
  model.elements.push({ ...model.elements[0] });         // duplicate id
  recon.windows = [{ id: 'MD-WIN-9', deck: 'MD', at: [0, 0], r: 200, z: 4000 }]; // drawn, but not in the model
  const r = referee(model, recon);
  assert.equal(r.ok, false);
  assert.deepEqual(r.issues.filter((i) => i.level === 'error').map((i) => i.what).sort(), ['duplicate_id', 'recon_orphan', 'width_exceeds_box']);
});

test('a room inside another room\'s hole, a short wide stair flight and a named small tank are fine', () => {
  const { model, recon } = sample();
  recon.rooms[0].holes = [sq(2000, -2000, 1500)];
  recon.rooms.push({ id: 'MD-T-1', deck: 'MD', polygon: sq(2000, -2000, 600), z0: 3000, z1: 5600 }); // 0.36 m², in the hole
  model.elements.push({ id: 'MD-T-1', type: 'tank', name: 'Lub Oil', deck: 'MD', geom: geom(2000, -2000, 600, 600) });
  // A 4-tread flight running along x: 631 mm run, 751 mm tread length (its clear width).
  model.elements[4].geom = geom(10000, 0, 631, 751, 2600);
  model.elements[4].props = { clear_width: { value: 751, unit: 'mm' } };
  assert.deepEqual(referee(model, recon).issues, []);
});

test('implausible door widths and deck heights are warnings', () => {
  const { model, recon } = sample();
  model.elements[3].props.clear_width.value = 3500;
  model.decks[1].height = 12000;
  const what = referee(model, recon).issues.map((i) => i.what).sort();
  assert.deepEqual(what, ['deck_height', 'door_width']);
});
