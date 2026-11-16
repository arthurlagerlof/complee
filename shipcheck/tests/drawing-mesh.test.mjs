import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeometry, geometryBoxes, applyBoxes } from '../src/drawing/mesh.mjs';
import { triangulate, triangulatedArea } from '../src/drawing/triangulate.mjs';

// Breadth tapering to nothing at the bow (x = 38 m): the last station collapses to a line on the centreline.
const B = (x) => 4000 * Math.min(1, (38000 - x) / 12000);
const stations = Array.from({ length: 20 }, (_, i) => {
  const x = i * 2000, b = B(x);
  const half = i % 2
    ? [[0, 0], [b * 0.3, 0], [b * 0.6, 0], [b * 0.85, 200], [b, 600], [b, 1800], [b, 3000]]
    : [[0, 0], [b * 0.6, 0], [b, 600], [b, 3000]];
  return { x, half };
});

function recon() {
  return {
    decks: [
      { id: 'LD', name: 'Lower deck', elevation: 0, height: 3000, outline: [[0, -4000], [38000, 0], [0, 4000]], plateThickness: 10 },
      { id: 'MD', name: 'Main deck', elevation: 3000, height: 2600, outline: [[0, -4000], [38000, 0], [0, 4000]], plateThickness: 10 },
    ],
    hull: { id: 'HULL', stations, stem: [[38000, 0], [39500, 3000]], stern: [[0, 1500], [-500, 3000]], keelZ: 0, assumed: [] },
    walls: [
      {
        id: 'W1', deck: 'MD', a: [5000, -2000], b: [15000, -2000], thickness: 100, z0: 3000, z1: 5400, kind: 'bulkhead',
        openings: [
          { from: 2000, to: 2900, z0: 3000, z1: 5000, kind: 'door', ref: 'D1' },
          { from: 6000, to: 7000, z0: 4000, z1: 4800, kind: 'window', ref: 'WIN2' },
        ],
      },
      { id: 'W2', deck: 'MD', a: [5000, -2000], b: [5000, 2000], thickness: 100, z0: 3000, z1: 5400, kind: 'partition', openings: [] },
      { id: 'W3', deck: 'MD', a: [20000, 0], b: [24000, 0], thickness: 80, z0: 3000, z1: 5400, kind: 'shell', openings: [] },
    ],
    rooms: [{
      id: 'R1', deck: 'MD', z0: 3000, z1: 5400,
      // L-shape, clockwise, with a repeated point and a point on a straight edge; the hole counter-clockwise.
      polygon: [[5000, 2000], [10000, 2000], [10000, 0], [15000, 0], [15000, -2000], [12000, -2000], [12000, -2000], [5000, -2000], [5000, 2000]],
      holes: [[[6000, -1000], [7000, -1000], [7000, 0], [6000, 0]]],
    }],
    doors: [{ id: 'D1', deck: 'MD', hinge: [7000, -2000], width: 900, wallDir: [1, 0], swing: 1, z0: 3000, z1: 5000 }],
    stairs: [{ id: 'S1', deck: 'MD', polygon: [[16000, -1000], [19000, -1000], [19000, 0], [16000, 0]], dir: [1, 0], z0: 3000, z1: 5600 }],
    ladders: [{ id: 'L1', deck: 'MD', at: [25000, 1000], width: 400, dir: [1, 0], z0: 3000, z1: 5600 }],
    windows: [
      { id: 'P1', deck: 'LD', at: [12000, 3900], r: 200, z: 2000 },
      { id: 'WIN2', deck: 'MD', at: [11500, -2000], width: 1000, z: 4400 },
    ],
    equipment: [{ id: 'E1', deck: 'MD', polygon: [[30000, 0], [31000, 0], [30500, 800]], z0: 3000, z1: 4000 }],
  };
}

const geo = buildGeometry(recon());

function triangles(g) {
  const out = [];
  for (let k = 0; k < g.indices.length; k += 3) {
    const v = [0, 1, 2].map((q) => { const i = g.indices[k + q]; return [g.positions[i * 3], g.positions[i * 3 + 1], g.positions[i * 3 + 2]]; });
    const [a, b, c] = v;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    out.push({ v, n, area: Math.hypot(...n) / 2, idx: [g.indices[k], g.indices[k + 1], g.indices[k + 2]] });
  }
  return out;
}

test('every element of the recon gets geometry', () => {
  for (const id of ['HULL', 'W1', 'W2', 'W3', 'R1', 'D1', 'S1', 'L1', 'P1', 'WIN2', 'E1']) assert.ok(geo.has(id), id);
});

test('no NaN, indices in range, unit normals, no degenerate triangles, winding agrees with normals', () => {
  for (const [id, g] of geo) {
    assert.ok(g.positions instanceof Float32Array && g.normals instanceof Float32Array && g.indices instanceof Uint32Array, id);
    assert.equal(g.positions.length, g.normals.length, id);
    assert.equal(g.indices.length % 3, 0, id);
    const nv = g.positions.length / 3;
    for (const x of g.positions) assert.ok(Number.isFinite(x), `${id} position`);
    for (let k = 0; k < g.normals.length; k += 3) {
      const l = Math.hypot(g.normals[k], g.normals[k + 1], g.normals[k + 2]);
      assert.ok(Math.abs(l - 1) < 1e-4, `${id} normal length ${l}`);
    }
    for (const i of g.indices) assert.ok(i < nv, `${id} index ${i} >= ${nv}`);
    for (const t of triangles(g)) {
      assert.ok(t.area > 1e-9, `${id}: degenerate triangle`);
      // Counter-clockwise outward winding: the face normal points the same way as its vertex normals.
      for (const i of t.idx) {
        const d = t.n[0] * g.normals[i * 3] + t.n[1] * g.normals[i * 3 + 1] + t.n[2] * g.normals[i * 3 + 2];
        assert.ok(d > 0, `${id}: triangle winding against its normal`);
      }
    }
    assert.equal(g.color.length, 4, id);
  }
});

test('a plain wall is a closed solid: every edge used twice, once each way', () => {
  const g = geo.get('W3');
  const key = (i) => [0, 1, 2].map((a) => Math.round(g.positions[i * 3 + a] * 1e4)).join(',');
  const directed = new Map();
  for (let k = 0; k < g.indices.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const a = key(g.indices[k + e]), b = key(g.indices[k + (e + 1) % 3]);
      directed.set(`${a}>${b}`, (directed.get(`${a}>${b}`) ?? 0) + 1);
    }
  }
  for (const [edge, n] of directed) {
    assert.equal(n, 1, `edge ${edge} used ${n} times in one direction`);
    const [a, b] = edge.split('>');
    assert.ok(directed.has(`${b}>${a}`), `edge ${edge} has no opposite`);
  }
  assert.equal(geo.get('W3').indices.length, 36); // 6 faces x 2 triangles
  // Outward winding: the signed volume (divergence theorem) is the wall's volume, positive.
  let vol = 0;
  for (const t of triangles(g)) { const [a, b, c] = t.v; vol += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; }
  assert.ok(Math.abs(vol - 4 * 0.08 * 2.4) < 1e-5, `volume ${vol}`);
});

test('hull faces outward: port side towards port, starboard towards starboard, transom aft', () => {
  let port = 0, stbd = 0, aft = 0;
  for (const t of triangles(geo.get('HULL'))) {
    const zMid = (t.v[0][2] + t.v[1][2] + t.v[2][2]) / 3, xMid = (t.v[0][0] + t.v[1][0] + t.v[2][0]) / 3;
    if (Math.abs(t.n[0]) > 0.9 * Math.hypot(...t.n) && xMid < 0.1) aft += t.n[0];
    else if (zMid < -0.01) port += -t.n[2]; // scene -Z = model +y (port)
    else if (zMid > 0.01) stbd += t.n[2];
  }
  assert.ok(port > 0 && stbd > 0 && aft < 0, `port ${port} stbd ${stbd} aft ${aft}`);
});

test('L-shaped room with a hole: triangulated area = polygon - hole', () => {
  const r = recon().rooms[0];
  const expected = 10000 * 2000 + 5000 * 2000 - 1000 * 1000;
  const t = triangulate([r.polygon, ...r.holes]);
  assert.ok(Math.abs(triangulatedArea(t) - expected) / expected < 0.001, `area ${triangulatedArea(t)}`);
  // The slab's top face in the mesh (normal +Y at z0 + 50 mm) has the same area.
  let top = 0;
  for (const tr of triangles(geo.get('R1'))) if (tr.n[1] > 0 && Math.abs(tr.v[0][1] - 3.05) < 1e-5 && tr.v.every((p) => Math.abs(p[1] - 3.05) < 1e-5)) top += tr.area;
  assert.ok(Math.abs(top * 1e6 - expected) / expected < 0.001, `slab top ${top * 1e6}`);
  // Either winding gives the same result, and repeated / collinear points are tolerated.
  const ccw = triangulate([[...r.polygon].reverse(), [...r.holes[0]].reverse()]);
  assert.ok(Math.abs(triangulatedArea(ccw) - expected) / expected < 0.001);
});

test('triangulation: concave rings, several holes, degenerate input', () => {
  // A comb (deeply concave) with two holes in the solid strip.
  const comb = [[0, 0], [10000, 0], [10000, 3000], [8000, 3000], [8000, 1000], [6000, 1000], [6000, 3000], [4000, 3000], [4000, 1000], [2000, 1000], [2000, 3000], [0, 3000]];
  const holes = [[[500, 200], [900, 200], [900, 600], [500, 600]], [[5000, 200], [5500, 200], [5500, 700], [5000, 700]]];
  const area = 10000 * 1000 + 3 * 2000 * 2000 - 400 * 400 - 500 * 500;
  const t = triangulate([comb, ...holes]);
  assert.ok(Math.abs(triangulatedArea(t) - area) / area < 1e-6, `${triangulatedArea(t)} vs ${area}`);
  assert.equal(triangulate([[[0, 0], [1000, 0], [2000, 0]]]), null); // collinear: no area
  assert.equal(triangulate([[[0, 0], [0, 0], [0, 0]]]), null);
  assert.equal(triangulate([]), null);
});

test('wall with a door and a window: no triangles inside the openings', () => {
  const g = geo.get('W1');
  // wall local: s along a->b from a = (5000, -2000), height z
  const open = [{ s0: 2000, s1: 2900, z0: 3000, z1: 5000 }, { s0: 6000, s1: 7000, z0: 4000, z1: 4800 }];
  for (const t of triangles(g)) {
    const s = t.v.map((p) => p[0] * 1000 - 5000), z = t.v.map((p) => p[1] * 1000);
    for (const o of open) {
      const overlapS = Math.max(...s) > o.s0 + 1 && Math.min(...s) < o.s1 - 1;
      const overlapZ = Math.max(...z) > o.z0 + 1 && Math.min(...z) < o.z1 - 1;
      assert.ok(!(overlapS && overlapZ), 'triangle inside an opening');
    }
  }
  // Lintel over the door, sill and head at the window: there is wall material above and below.
  const box = geometryBoxes(geo).get('W1');
  assert.ok(Math.abs(box.max[2] - 5400) < 0.5 && Math.abs(box.min[2] - 3000) < 0.5);
});

test('stair: steps rise to z1, ladder rails reach z1', () => {
  const b = geometryBoxes(geo);
  const s = b.get('S1');
  assert.ok(Math.abs(s.max[2] - 5600) < 0.5 && Math.abs(s.min[2] - 3000) < 0.5, JSON.stringify(s));
  assert.ok(Math.abs(s.min[0] - 16000) < 0.5 && Math.abs(s.max[0] - 19000) < 0.5);
  // The highest step top lies at the forward (dir) end.
  const g = geo.get('S1');
  let xTop = -Infinity;
  for (let k = 0; k < g.positions.length; k += 3) if (Math.abs(g.positions[k + 1] - 5.6) < 1e-5) xTop = Math.max(xTop, g.positions[k]);
  assert.ok(Math.abs(xTop - 19) < 1e-4);
  const l = b.get('L1');
  assert.ok(Math.abs(l.max[2] - 5600) < 0.5 && Math.abs(l.min[2] - 3000) < 0.5);
  assert.ok(l.max[1] - l.min[1] >= 400, 'rails stand apart by the ladder width');
});

test('geometryBoxes: extents in model mm', () => {
  const b = geometryBoxes(geo);
  const near = (id, min, max, tol = 1) => {
    const x = b.get(id);
    for (let a = 0; a < 3; a++) {
      assert.ok(Math.abs(x.min[a] - min[a]) <= tol, `${id} min[${a}] ${x.min[a]} != ${min[a]}`);
      assert.ok(Math.abs(x.max[a] - max[a]) <= tol, `${id} max[${a}] ${x.max[a]} != ${max[a]}`);
    }
  };
  // Hull: raked transom carried aft to x = -500 at the deck, stem to 39.5 m, full breadth, keel to deck edge.
  near('HULL', [-500, -4000, 0], [39500, 4000, 3000]);
  // W1 meets W2 square at its aft end: extended by half of W2's thickness there.
  near('W1', [4950, -2050, 3000], [15000, -1950, 5400]);
  near('W2', [4950, -2050, 3000], [5050, 2000, 5400]);
  near('W3', [20000, -40, 3000], [24000, 40, 5400]);
  // Room: the floor slab's plan, the room's height.
  near('R1', [5000, -2000, 3000], [15000, 2000, 5400]);
  near('E1', [30000, 0, 3000], [31000, 800, 4000]);
  // Window in the wall opening: the opening, 20 mm proud of both faces.
  near('WIN2', [11000, -2070, 4000], [12000, -1930, 4800]);
  // Porthole on the hull side (half-breadth 4 m there), 20 mm proud.
  near('P1', [11800, 3970, 1800], [12200, 4020, 2200]);
  // Door: leaf open towards +y (swing 1, wall along +x), frame head above the opening.
  const d = b.get('D1');
  assert.ok(d.max[1] > -2000 + 800, 'leaf swings to the swing side');
  assert.ok(Math.abs(d.max[2] - 5050) < 0.5 && Math.abs(d.min[2] - 3000) < 0.5);
});

test('applyBoxes: geom relative to the deck elevation', () => {
  const model = {
    decks: [{ id: 'LD', elevation: 0 }, { id: 'MD', elevation: 3000 }],
    elements: [
      { id: 'W1', type: 'wall', deck: 'MD' }, { id: 'R1', type: 'space', deck: 'MD' },
      { id: 'HULL', type: 'hull', deck: 'LD' }, { id: 'X', type: 'space', deck: 'MD', geom: { x: 1, y: 2, z: 3, lx: 4, ly: 5, h: 6 } },
    ],
  };
  applyBoxes(model, geo);
  assert.deepEqual(model.elements[0].geom, { x: 4950, y: -2050, z: 0, lx: 10050, ly: 100, h: 2400 });
  assert.deepEqual(model.elements[1].geom, { x: 5000, y: -2000, z: 0, lx: 10000, ly: 4000, h: 2400 });
  assert.deepEqual(model.elements[2].geom, { x: -500, y: -4000, z: 0, lx: 40000, ly: 8000, h: 3000 });
  assert.deepEqual(model.elements[3].geom, { x: 1, y: 2, z: 3, lx: 4, ly: 5, h: 6 }); // no geometry: untouched
});

test('hull: collapsed stem station and odd point counts give a clean surface', () => {
  const g = geo.get('HULL');
  // Port and starboard are mirror images.
  let port = 0, stbd = 0;
  for (let k = 0; k < g.positions.length; k += 3) { if (g.positions[k + 2] < -1e-6) port++; else if (g.positions[k + 2] > 1e-6) stbd++; }
  assert.equal(port, stbd);
  // A hull with only collapsed or broken stations still builds or is skipped, never throws or yields NaN.
  const odd = buildGeometry({ hull: { stations: [{ x: 0, half: [[0, 0], [0, 3000]] }, { x: 1000, half: [[0, 0]] }, { x: NaN, half: [] }], stem: [], stern: [] } });
  for (const g2 of odd.values()) for (const x of g2.positions) assert.ok(Number.isFinite(x));
});

test('walls: dark top face per vertex, shell role, top under the deck plate above', () => {
  const g = geo.get('W1');
  assert.equal(g.colors.length, g.positions.length);
  let cap = 0, side = 0;
  for (let v = 0; v < g.positions.length / 3; v++) {
    const top = g.normals[v * 3 + 1] > 0.99 && Math.abs(g.positions[v * 3 + 1] - 5.4) < 1e-5;
    if (top) { cap++; assert.ok(g.colors[v * 3] < 0.4, 'top face dark'); } else { side++; assert.ok(g.colors[v * 3] > 0.7, 'sides light'); }
  }
  assert.ok(cap >= 4 && side > cap);
  assert.equal(geo.get('W3').role, 'shell');
  assert.equal(geo.get('W1').role, undefined);
  // A wall up to the next deck (5400 = elevation of a deck above) stops 40 mm under it, its door opening is kept.
  const r = recon();
  r.decks.push({ id: 'UD', elevation: 5400, height: 2400, outline: [] });
  const b = geometryBoxes(buildGeometry(r)).get('W1');
  assert.ok(Math.abs(b.max[2] - 5360) < 0.5, `top ${b.max[2]}`);
});

test('5,000 walls and 1,000 rooms build in under a second', () => {
  const walls = [], rooms = [];
  for (let i = 0; i < 1000; i++) {
    const cx = (i % 40) * 3000, cy = Math.floor(i / 40) * 3000;
    rooms.push({ id: `r${i}`, deck: 'D', z0: 0, z1: 2400, polygon: [[cx, cy], [cx + 3000, cy], [cx + 3000, cy + 1500], [cx + 1500, cy + 1500], [cx + 1500, cy + 3000], [cx, cy + 3000]] });
    for (let k = 0; k < 5; k++) {
      const horizontal = k % 2 === 0, y = cy + k * 600, x = cx + k * 600;
      walls.push({
        id: `w${i}_${k}`, deck: 'D', a: horizontal ? [cx, y] : [x, cy], b: horizontal ? [cx + 3000, y] : [x, cy + 3000], thickness: 100, z0: 0, z1: 2400,
        kind: 'partition', openings: k === 0 ? [{ from: 1000, to: 1900, z0: 0, z1: 2000, kind: 'door' }] : k === 1 ? [{ from: 500, to: 1500, z0: 900, z1: 1800, kind: 'window' }] : [],
      });
    }
  }
  const t0 = performance.now();
  const g = buildGeometry({ decks: [{ id: 'D', elevation: 0 }], hull: { stations, stem: [[38000, 0], [39500, 3000]], stern: [] }, walls, rooms });
  const ms = performance.now() - t0;
  assert.equal(g.size, 1 + 5000 + 1000);
  assert.ok(ms < 1000, `took ${ms.toFixed(0)} ms`);
  console.log(`  5,000 walls + 1,000 rooms + hull: ${ms.toFixed(0)} ms`);
});
