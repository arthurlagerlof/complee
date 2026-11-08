// dbId map: SVF copy (what export-chunks.mjs reads) -> SVF2 objectid (the APS model, model-properties.json, parts.json).
// The two Autodesk translations number the objects differently (and even the Navisworks node GUIDs differ, they are
// derived from the file name), so the export must translate every SVF node id before looking up its part.
// Key: (source DWG file, DWG entity handle) of each node: stable across translations. Nodes without a handle (files,
// subentities) are matched through the tree: same parent (already matched), same name, same position among the
// parent's children with that name. Ambiguous or unmatched nodes stay unmapped and are reported.
//
// Usage (from shipcheck/tools/export): node --max-old-space-size=12288 map-ids.mjs   -> work/svf-to-svf2.json
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { streamArray } from '../../src/json-stream.mjs';
import { readTree } from './read-tree.mjs';
import { fetchCatalog } from '../../src/catalog-api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = path.join(HERE, 'work');
const SC = path.resolve(HERE, '../..');
const log = (...a) => console.log(...a);

const require = createRequire(import.meta.url);
const { SVFReader } = require('svf-utils');
export const ID_MAP = path.join(WORK, 'svf-to-svf2.json'); // summary
export const ID_BIN = path.join(WORK, 'svf-to-svf2.bin'); // Uint32 per SVF id: SVF2 objectid, 0 = not matched
export const PARENT_BIN = path.join(WORK, 'svf-parent.bin'); // Uint32 per SVF id: parent SVF id, 0 = none

// Loads the map: { toSvf2: Uint32Array, parent: Uint32Array }
export function loadIdMap() {
  if (!fs.existsSync(ID_BIN) || !fs.existsSync(PARENT_BIN)) throw new Error('No dbId map yet: run node map-ids.mjs first');
  const u32 = (f) => { const b = fs.readFileSync(f); return new Uint32Array(b.buffer, b.byteOffset, b.length / 4); };
  return { toSvf2: u32(ID_BIN), parent: u32(PARENT_BIN) };
}

async function main() {
  const t0 = Date.now();
  const { ensureSvf } = await import('./export-chunks.mjs'); // (export-chunks.mjs imports loadIdMap from here)
  const db = await (await SVFReader.FromFileSystem(await ensureSvf())).getPropertyDb();
  // SVF side: walk the property tree from the root.
  const svf = new Map(); // id -> { name, file, handle, parent, children }
  const stack = [1];
  while (stack.length) {
    const id = stack.pop();
    const n = { name: null, file: null, handle: null, parent: null, children: [] };
    for (const p of db.enumerateProperties(id)) {
      if (p.category === '__name__') n.name = p.value;
      else if (p.name === 'LcOaNode:LcOaNodeSourceFile') n.file = p.value;
      else if (p.category === 'Entity Handle') n.handle = String(p.value);
      else if (p.category === '__parent__') n.parent = p.value;
      else if (p.category === '__child__') n.children.push(p.value);
    }
    svf.set(id, n);
    for (const c of n.children) stack.push(c);
  }
  log(`SVF copy: ${svf.size.toLocaleString('en')} nodes`);

  // SVF2 side: model-tree.json (structure, names) + model-properties.json (file, handle).
  const tree = (await readTree(path.join(SC, '3D_Since_AI/model-tree.json'))).data.objects;
  const props = new Map();
  for await (const o of streamArray(path.join(SC, '3D_Since_AI/model-properties.json'), 'collection')) props.set(o.objectid, o);
  const svf2 = new Map();
  (function walk(nodes, parent) {
    for (const t of nodes || []) {
      const o = props.get(t.objectid);
      svf2.set(t.objectid, { name: t.name ?? o?.name ?? null, file: o?.properties?.Item?.['Source File'] ?? null, handle: o?.properties?.['Entity Handle']?.Value != null ? String(o.properties['Entity Handle'].Value) : null, parent, children: (t.objects || []).map((c) => c.objectid) });
      walk(t.objects, t.objectid);
    }
  })(tree, null);
  log(`SVF2 (APS model): ${svf2.size.toLocaleString('en')} nodes`);

  // 1) (file, handle, name): unique on both sides -> match
  const keyOf = (n) => (n.file && n.handle ? `${n.file}|${n.handle}|${n.name}` : null);
  const index = (m) => { const k = new Map(); for (const [id, n] of m) { const key = keyOf(n); if (key) k.set(key, k.has(key) ? -1 : id); } return k; };
  const k1 = index(svf), k2 = index(svf2);
  const map = new Map(), back = new Map();
  const pair = (a, b) => { if (map.has(a) || back.has(b)) return false; map.set(a, b); back.set(b, a); return true; };
  let byHandle = 0, ambiguous = 0;
  for (const [key, a] of k1) {
    const b = k2.get(key);
    if (a === -1 || b === -1) { ambiguous++; continue; }
    if (b != null && pair(a, b)) byHandle++;
  }
  // 2) tree: roots, then children of matched parents by (name, index among same-named siblings), repeated until stable
  let byTree = 0;
  const roots1 = [...svf].filter(([, n]) => n.parent == null).map(([id]) => id);
  const roots2 = [...svf2].filter(([, n]) => n.parent == null).map(([id]) => id);
  if (roots1.length === 1 && roots2.length === 1 && pair(roots1[0], roots2[0])) byTree++;
  // ambiguous (file, handle, name) keys: candidates whose parents are already matched to each other
  const multi = (m) => { const g = new Map(); for (const [id, n] of m) { const key = keyOf(n); if (!key) continue; if (!g.has(key)) g.set(key, []); g.get(key).push(id); } return g; };
  const m1 = multi(svf), m2 = multi(svf2);
  let byParent = 0;
  const resolveAmbiguous = () => {
    let n = 0;
    for (const [key, la] of m1) {
      const lb = m2.get(key);
      if (!lb || (la.length === 1 && lb.length === 1)) continue;
      for (const a of la) {
        if (map.has(a)) continue;
        const pb = map.get(svf.get(a).parent);
        if (pb == null) continue;
        const cands = lb.filter((b) => !back.has(b) && svf2.get(b).parent === pb);
        if (cands.length === 1 && pair(a, cands[0])) n++;
      }
    }
    return n;
  };
  for (let round = 0, changed = true; changed && round < 20; round++) {
    changed = false;
    const r = resolveAmbiguous();
    if (r) { byParent += r; changed = true; }
    for (const [a, b] of [...map]) {
      const ca = svf.get(a)?.children || [], cb = svf2.get(b)?.children || [];
      const group = (ids, m) => { const g = new Map(); for (const id of ids) { const nm = m.get(id)?.name; if (!g.has(nm)) g.set(nm, []); g.get(nm).push(id); } return g; };
      const ga = group(ca, svf), gb = group(cb, svf2);
      for (const [nm, la] of ga) {
        const lb = gb.get(nm);
        if (!lb || lb.length !== la.length) continue;
        la.forEach((x, i) => { if (!map.has(x) && !back.has(lb[i])) { pair(x, lb[i]); byTree++; changed = true; } });
      }
    }
  }
  log(`Ambiguous handles resolved through their parents: ${byParent.toLocaleString('en')}`);
  // 3) check: matched pairs whose handles / files disagree would mean a wrong tree match
  let conflicts = 0;
  for (const [a, b] of map) { const x = svf.get(a), y = svf2.get(b); if ((x.handle && y.handle && x.handle !== y.handle) || (x.file && y.file && x.file !== y.file) || x.name !== y.name) conflicts++; }
  let maxId = 0; for (const id of svf.keys()) if (id > maxId) maxId = id;
  const toSvf2 = new Uint32Array(maxId + 1), parent = new Uint32Array(maxId + 1);
  for (const [a, b] of map) toSvf2[a] = b;
  for (const [id, n] of svf) parent[id] = n.parent ?? 0;
  fs.writeFileSync(ID_BIN, Buffer.from(toSvf2.buffer));
  fs.writeFileSync(PARENT_BIN, Buffer.from(parent.buffer));
  fs.writeFileSync(ID_MAP, JSON.stringify({ generated: new Date().toISOString(), key: 'source file + DWG entity handle + name, then parent, then tree position', svf_nodes: svf.size, svf2_nodes: svf2.size, matched: map.size, by_handle: byHandle, by_parent: byParent, by_tree: byTree, ambiguous_keys: ambiguous, conflicts }));
  const parts = (await fetchCatalog('model-rcrv-parts')).parts;
  const partsMapped = parts.filter((p) => back.has(p.objectid)).length;
  log(`Matched ${map.size.toLocaleString('en')} of ${svf.size.toLocaleString('en')} SVF nodes (${byHandle.toLocaleString('en')} by file + handle, ${byTree.toLocaleString('en')} by tree position); ambiguous keys ${ambiguous}; conflicts ${conflicts}`);
  log(`parts.json parts found in the SVF copy: ${partsMapped.toLocaleString('en')} of ${parts.length.toLocaleString('en')}`);
  log(`Wrote ${path.relative(SC, ID_MAP)} in ${Math.round((Date.now() - t0) / 1000)} s`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
