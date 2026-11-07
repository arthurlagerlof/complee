// Independent audit of the high-precision tiles (model/stream-hp/, export-tiles-hp.mjs) against the retained SVF.
// Decodes every tile GLB (meshopt decoder, node translation applied), and compares per dbId with a fresh pass over the
// SVF source (double precision):
//   triangle count (exact), bounding box and mean triangle centroid (within 0.001 mm), total area (within the bound a
//   0.0005 mm vertex deviation allows: |dA| <= sqrt(3)/2 * 0.0005 mm * perimeter, summed per id; thin slivers are
//   ill-conditioned, so a relative area test would flag rounding, not loss),
//   zero-area triangles (source vs tiles), file hashes against the manifest.
// Writes model/stream-hp/audit.json (summary + the worst ids) and exits 1 on any failure.
// Usage: node --max-old-space-size=12288 audit-hp.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { decodeGlb } from './tile-model.mjs';
import { mapParts, openScene, matrixOf, SC, WORK, log } from './export-chunks.mjs';

const require = createRequire(import.meta.url);
const IMF = require('svf-utils/lib/common/intermediate-format');
const HP = path.join(SC, 'model', 'stream-hp');
const TOL_MM = 0.001; // bounds / centroid tolerance (float32 near a tile origin is ~0.0005 mm)
const DEV_MM = 0.0005; // maximum float32 rounding of a stored position (export-tiles-hp.mjs reports the real maximum)
const t0 = Date.now();
const acc = () => ({ n: 0, zero: 0, area: 0, perim: 0, cx: 0, cy: 0, cz: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
function addTri(a, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  const ar = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
  a.n++; if (ar === 0) a.zero++;
  a.area += ar; a.perim += Math.hypot(ux, uy, uz) + Math.hypot(vx, vy, vz) + Math.hypot(cx - bx, cy - by, cz - bz);
  a.cx += (ax + bx + cx) / 3; a.cy += (ay + by + cy) / 3; a.cz += (az + bz + cz) / 3;
  for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
    if (x < a.min[0]) a.min[0] = x; if (y < a.min[1]) a.min[1] = y; if (z < a.min[2]) a.min[2] = z;
    if (x > a.max[0]) a.max[0] = x; if (y > a.max[1]) a.max[1] = y; if (z > a.max[2]) a.max[2] = z;
  }
}

// 1) tiles
const manifest = JSON.parse(fs.readFileSync(path.join(HP, 'manifest.json'), 'utf8'));
const tiles = new Map();
let hashErrors = 0, tileTris = 0;
for (const info of manifest.chunks) {
  const bin = fs.readFileSync(path.join(HP, info.file));
  if (crypto.createHash('sha256').update(bin).digest('hex') !== info.sha256) hashErrors++;
  const { json, views } = await decodeGlb(path.join(HP, info.file));
  const pr = json.meshes[0].primitives[0], acs = json.accessors, tr = json.nodes[0].translation || [0, 0, 0];
  const pa = acs[pr.attributes.POSITION], ca = acs[pr.attributes.COLOR_0], ia = acs[pr.indices];
  if (pa.componentType !== 5126) throw new Error(`${info.file}: positions are not float32`);
  const pv = views[pa.bufferView], P = new Float32Array(pv.buffer, pv.byteOffset, pv.byteLength / 4);
  const C = views[ca.bufferView];
  const iv = views[ia.bufferView], I = ia.componentType === 5123 ? new Uint16Array(iv.buffer, iv.byteOffset, ia.count) : new Uint32Array(iv.buffer, iv.byteOffset, ia.count);
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k], b = I[k + 1], c = I[k + 2];
    const id = (C[4 * a] | (C[4 * a + 1] << 8) | (C[4 * a + 2] << 16) | (C[4 * a + 3] << 24)) >>> 0;
    let t = tiles.get(id); if (!t) tiles.set(id, (t = acc()));
    addTri(t, P[3 * a] + tr[0], P[3 * a + 1] + tr[1], P[3 * a + 2] + tr[2], P[3 * b] + tr[0], P[3 * b + 1] + tr[1], P[3 * b + 2] + tr[2], P[3 * c] + tr[0], P[3 * c + 1] + tr[1], P[3 * c + 2] + tr[2]);
    tileTris++;
  }
}
log(`Tiles: ${manifest.chunks.length} files, ${tileTris.toLocaleString('en')} triangles, ${tiles.size.toLocaleString('en')} dbIds, hash errors ${hashErrors}`);

// 2) source (same dbId assignment rule as the export: checked part, else the nearest matched APS node)
const plan = JSON.parse(fs.readFileSync(path.join(WORK, 'rest-plan.json'), 'utf8'));
const { chunkOfPart, resolve } = await mapParts();
const { scene, toOut, scaleMM, offset } = await openScene();
const src = new Map();
let srcTris = 0, skipped = 0;
for (let i = 0, n = scene.getNodeCount(); i < n; i++) {
  const node = scene.getNode(i);
  if (node.kind !== IMF.NodeKind.Object) continue;
  const geom = scene.getGeometry(node.geometry);
  if (geom.kind !== IMF.GeometryKind.Mesh) continue;
  const V = geom.getVertices(), I = geom.getIndices();
  if (!V?.length || !I?.length) continue;
  const { part, near } = resolve(node.dbid);
  const id = part != null && chunkOfPart.get(part) !== 'rest' ? part : (part ?? near);
  if (id == null || (!(part != null && chunkOfPart.get(part) !== 'rest') && plan.assign[id] === undefined)) { skipped++; continue; }
  const M = matrixOf(node.transform), W = new Float64Array(V.length);
  for (let v = 0; v < V.length; v += 3) {
    let x = V[v], y = V[v + 1], z = V[v + 2];
    if (M) { const X = M[0] * x + M[4] * y + M[8] * z + M[12], Y = M[1] * x + M[5] * y + M[9] * z + M[13], Z = M[2] * x + M[6] * y + M[10] * z + M[14]; x = X; y = Y; z = Z; }
    const o = toOut(x, y, z);
    for (let k = 0; k < 3; k++) W[v + k] = o[k] * scaleMM - offset[k];
  }
  let s = src.get(id); if (!s) src.set(id, (s = acc()));
  for (let k = 0; k < I.length; k += 3) {
    const a = 3 * I[k], b = 3 * I[k + 1], c = 3 * I[k + 2];
    addTri(s, W[a], W[a + 1], W[a + 2], W[b], W[b + 1], W[b + 2], W[c], W[c + 1], W[c + 2]);
    srcTris++;
  }
}
log(`Source: ${srcTris.toLocaleString('en')} triangles, ${src.size.toLocaleString('en')} dbIds (fragments without an assignment: ${skipped})`);

// 3) compare
const fail = { count: [], bounds: [], centroid: [], area: [], missing: [], extra: [] };
let worstBounds = 0, worstCentroid = 0, worstArea = 0, srcZero = 0, tileZero = 0, lostArea = 0;
for (const [id, s] of src) {
  srcZero += s.zero;
  const t = tiles.get(id);
  if (!t) { fail.missing.push(id); continue; }
  if (t.n !== s.n) fail.count.push({ id, source: s.n, tiles: t.n });
  const db = Math.max(...[0, 1, 2].flatMap((k) => [Math.abs(t.min[k] - s.min[k]), Math.abs(t.max[k] - s.max[k])]));
  worstBounds = Math.max(worstBounds, db); if (db > TOL_MM) fail.bounds.push({ id, mm: db });
  const bound = Math.sqrt(3) / 2 * DEV_MM * s.perim, dA = Math.abs(t.area - s.area);
  worstArea = Math.max(worstArea, bound ? dA / bound : 0); if (dA > bound + 1e-9) fail.area.push({ id, source_mm2: s.area, tiles_mm2: t.area, bound_mm2: bound });
  lostArea += s.area - t.area;
  if (s.n && t.n === s.n) {
    const dc = Math.hypot((t.cx - s.cx) / s.n, (t.cy - s.cy) / s.n, (t.cz - s.cz) / s.n);
    worstCentroid = Math.max(worstCentroid, dc); if (dc > TOL_MM) fail.centroid.push({ id, mm: dc });
  }
}
for (const [id, t] of tiles) { tileZero += t.zero; if (!src.has(id)) fail.extra.push(id); }
const failures = Object.values(fail).reduce((n, l) => n + l.length, 0) + hashErrors + (tileTris !== srcTris ? 1 : 0);
const report = {
  generated: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), pass: failures === 0,
  triangles: { source: srcTris, tiles: tileTris }, dbids: { source: src.size, tiles: tiles.size },
  zero_area_triangles: { source: srcZero, tiles: tileZero, note: 'float32 rounding near the tile origin turns sub-micron slivers into exact zero area; see area' },
  worst: { bounds_mm: worstBounds, mean_centroid_mm: worstCentroid, area_difference_vs_rounding_bound: worstArea }, area_difference_mm2: lostArea,
  tolerances: { bounds_and_centroid_mm: TOL_MM, vertex_rounding_mm: DEV_MM, area: 'sqrt(3)/2 * vertex_rounding * perimeter per id' }, hash_errors: hashErrors,
  failures: Object.fromEntries(Object.entries(fail).map(([k, l]) => [k, { count: l.length, first: l.slice(0, 20) }])),
};
fs.writeFileSync(path.join(HP, 'audit.json'), JSON.stringify(report, null, 1));
log(`Triangles: source ${srcTris.toLocaleString('en')}, tiles ${tileTris.toLocaleString('en')}; dbIds: source ${src.size.toLocaleString('en')}, tiles ${tiles.size.toLocaleString('en')}`);
log(`Worst per-id difference: bounds ${worstBounds.toExponential(2)} mm, centroid ${worstCentroid.toExponential(2)} mm, area difference ${(worstArea * 100).toFixed(1)} % of the rounding bound; total area difference ${lostArea.toExponential(2)} mm²`);
log(`Zero-area triangles: source ${srcZero.toLocaleString('en')}, tiles ${tileZero.toLocaleString('en')}`);
log(`Failures: ${Object.entries(fail).map(([k, l]) => `${k} ${l.length}`).join(', ')}, hashes ${hashErrors} -> ${report.pass ? 'PASS' : 'FAIL'} (${report.seconds} s)`);
process.exit(report.pass ? 0 : 1);
