import test from 'node:test';
import assert from 'node:assert/strict';
import { ExactTileMatcher } from '../tools/export/audit-tiles.mjs';

// Tiny decoded-GLB fixture: two distinct triangles, a duplicated first triangle,
// and one duplicated vertex record with a different index. Matches actual layouts.
const vertices = [
  [0, 0, 0, 101], [10, 0, 0, 101], [0, 10, 0, 101],
  [0, 0, 20, 202], [10, 0, 20, 202], [0, 10, 20, 202], [0, 0, 0, 101],
];
function fixture(v = vertices, triangles = [[0, 1, 2], [6, 1, 2], [3, 4, 5]]) {
  const positions = new Uint8Array(v.length * 8), normals = new Uint8Array(v.length * 4);
  const colors = new Uint8Array(v.length * 4), p = new DataView(positions.buffer), c = new DataView(colors.buffer);
  for (let i = 0; i < v.length; i++) {
    for (let k = 0; k < 3; k++) p.setUint16(i * 8 + 2 * k, v[i][k], true);
    normals[i * 4 + 2] = 127; c.setUint32(i * 4, v[i][3], true);
  }
  const indices = new Uint32Array(triangles.flat());
  return {
    json: {
      nodes: [{ mesh: 0, translation: [-20, 5, 8], scale: [0.5, 0.5, 0.5] }],
      scene: 0, scenes: [{ nodes: [0] }], materials: [{ doubleSided: true }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
      bufferViews: [{ byteStride: 8 }, { byteStride: 4 }, { byteStride: 4 }, {}],
      accessors: [
        { bufferView: 0, byteOffset: 0, componentType: 5123, type: 'VEC3', count: v.length },
        { bufferView: 1, byteOffset: 0, componentType: 5120, type: 'VEC3', normalized: true, count: v.length },
        { bufferView: 2, byteOffset: 0, componentType: 5121, type: 'VEC4', normalized: true, count: v.length },
        { bufferView: 3, byteOffset: 0, componentType: 5125, type: 'SCALAR', count: indices.length },
      ],
    },
    views: [positions, normals, colors, new Uint8Array(indices.buffer)],
  };
}

test('exact audit accepts repartitioning, vertex/index reordering and cyclic rotations, with duplicate multiplicity', () => {
  const matcher = new ExactTileMatcher(fixture());
  const reordered = [vertices[5], vertices[3], vertices[4]];
  matcher.addTile(fixture(reordered, [[0, 1, 2]]));
  matcher.addTile(fixture([vertices[2], vertices[0], vertices[1]], [[0, 1, 2], [1, 2, 0]]));
  const r = matcher.finish();
  assert.equal(r.passed, true);
  assert.equal(r.matched_triangles, 3);
  assert.equal(r.unique_attribute_records, 6);
  assert.equal(r.unique_oriented_triangles, 2);
  assert.deepEqual(r.per_dbid, [[101, 2, 2], [202, 1, 1]]);
});

test('exact audit detects a missing triangle and its dbId count deficit', () => {
  const matcher = new ExactTileMatcher(fixture());
  matcher.addTile(fixture(vertices, [[0, 1, 2], [3, 4, 5]]));
  const r = matcher.finish();
  assert.equal(r.passed, false); assert.equal(r.missing_triangles, 1);
  assert.deepEqual(r.dbid_mismatches, [[101, 2, 1]]);
});

test('exact audit rejects a duplicate replacing another triangle despite unchanged total count', () => {
  const matcher = new ExactTileMatcher(fixture());
  assert.throws(() => matcher.addTile(fixture(vertices, [[0, 1, 2], [0, 1, 2], [0, 1, 2]])), /duplicate multiplicity/);
});

test('exact audit rejects changed connectivity and reversed winding with unchanged attributes/counts', () => {
  for (const indices of [[[0, 2, 1], [6, 1, 2], [3, 4, 5]], [[0, 1, 3], [6, 1, 2], [2, 4, 5]]]) {
    const matcher = new ExactTileMatcher(fixture());
    assert.throws(() => matcher.addTile(fixture(vertices, indices)), /connectivity\/winding/);
  }
});

test('exact audit rejects position, normal, ID and attribute-padding byte changes', () => {
  for (const [view, byte] of [[0, 0], [1, 2], [2, 0], [0, 6], [1, 3]]) {
    const matcher = new ExactTileMatcher(fixture()), changed = fixture();
    changed.views[view][byte] ^= 1;
    assert.throws(() => matcher.addTile(changed), /attribute bytes absent from source/);
  }
});

test('exact audit rejects changed transform, normalized flag and material state', () => {
  for (const modify of [
    x => { x.json.nodes[0].translation[0] += 1; },
    x => { x.json.accessors[1].normalized = false; },
    x => { x.json.materials[0].doubleSided = false; },
  ]) {
    const matcher = new ExactTileMatcher(fixture()), changed = fixture(); modify(changed);
    assert.throws(() => matcher.addTile(changed), /changed/);
  }
});

test('exact audit handles degenerate triangles and preserves their multiplicity', () => {
  const matcher = new ExactTileMatcher(fixture(vertices, [[0, 0, 1], [0, 0, 0]]));
  matcher.addTile(fixture(vertices, [[0, 0, 0], [1, 0, 0]]));
  assert.equal(matcher.finish().passed, true);
});
