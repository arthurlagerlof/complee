// Independent check of the dbId mapping (map-ids.mjs): for every parts.json part with a ShipConstructor centre of
// gravity (LCG / TCG / VCG, model inches, from the APS model's properties), is that point inside the bounding box of
// the geometry the export assigns to the part? Compared for the old assumption (SVF id = APS id) and the map.
// Usage: node --max-old-space-size=12288 verify-ids.mjs
import fs from 'node:fs';
import path from 'node:path';
import { streamArray } from '../../src/json-stream.mjs';
import { mapParts, openScene, matrixOf, SC, log } from './export-chunks.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const IMF = require('svf-utils/lib/common/intermediate-format');
const MARGIN = 2; // inches

const { model, partOfLeaf, resolve } = await mapParts();
const cg = new Map();
for await (const o of streamArray(path.join(SC, '3D_Since_AI/model-properties.json'), 'collection')) {
  const s = o.properties?.ShipConstructor;
  const v = s && [s.LCG, s.TCG, s.VCG].map(Number);
  if (v && v.every(Number.isFinite)) cg.set(o.objectid, v);
}
const checked = new Set(model.elements.map((e) => e.objectid).filter((id) => cg.has(id)));
const { scene } = await openScene();
const boxes = { old: new Map(), map: new Map() };
const grow = (m, id, p) => { let b = m.get(id); if (!b) m.set(id, (b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity])); for (let k = 0; k < 3; k++) { if (p[k] < b[k]) b[k] = p[k]; if (p[k] > b[k + 3]) b[k + 3] = p[k]; } };
for (let i = 0, n = scene.getNodeCount(); i < n; i++) {
  const node = scene.getNode(i);
  if (node.kind !== IMF.NodeKind.Object) continue;
  const oldPart = partOfLeaf.get(node.dbid), newPart = resolve(node.dbid).part;
  if (!checked.has(oldPart) && !checked.has(newPart)) continue;
  const geom = scene.getGeometry(node.geometry);
  if (geom.kind !== IMF.GeometryKind.Mesh) continue;
  const V = geom.getVertices();
  if (!V?.length) continue;
  const M = matrixOf(node.transform);
  for (let v = 0; v < V.length; v += 3) {
    let x = V[v], y = V[v + 1], z = V[v + 2];
    if (M) { const X = M[0] * x + M[4] * y + M[8] * z + M[12], Y = M[1] * x + M[5] * y + M[9] * z + M[13], Z = M[2] * x + M[6] * y + M[10] * z + M[14]; x = X; y = Y; z = Z; }
    if (checked.has(oldPart)) grow(boxes.old, oldPart, [x, y, z]);
    if (checked.has(newPart)) grow(boxes.map, newPart, [x, y, z]);
  }
}
for (const [label, m] of Object.entries(boxes)) {
  let inside = 0, outside = 0;
  for (const id of checked) {
    const b = m.get(id), c = cg.get(id);
    if (!b) continue;
    const ok = [0, 1, 2].every((k) => c[k] >= b[k] - MARGIN && c[k] <= b[k + 3] + MARGIN);
    ok ? inside++ : outside++;
  }
  log(`${label === 'old' ? 'Old export (SVF id taken as APS id)' : 'With map-ids.mjs              '}: ${m.size.toLocaleString('en')} parts with geometry; centre of gravity inside the geometry box: ${inside.toLocaleString('en')} (${(100 * inside / Math.max(1, inside + outside)).toFixed(1)} %), outside: ${outside.toLocaleString('en')}`);
}
log(`(${checked.size.toLocaleString('en')} parts.json parts have a ShipConstructor centre of gravity)`);
