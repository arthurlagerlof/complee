// Export of the REST of the RCRV model (every part the 6 main chunks of export-chunks.mjs do not contain, i.e. parts
// no rule looks at) into sub-chunks rest-01.glb, rest-02.glb, … for the local viewer's "Full model".
//
// Usage (from shipcheck/tools/export, after export-chunks.mjs):
//   node --max-old-space-size=12288 export-rest.mjs --plan         assign every rest part to a sub-chunk (work/rest-plan.json)
//   node --max-old-space-size=12288 export-rest.mjs --chunk 3      build rest-03.glb and add it to model/manifest.json
//   node --max-old-space-size=12288 export-rest.mjs --props        part names + properties for clicks (model/props/*.json)
// One sub-chunk per run (memory and disk stay bounded). The 6 main chunks are never touched.
//
// Same format as the main chunks: one merged mesh per sub-chunk, positions in mm (same frame and offset), normals,
// COLOR_0 = the part's dbId on every vertex. Geometry is the model's own: no simplification, nothing dropped
// (gltfpack quantization + meshopt compression only).
import fs from 'node:fs';
import path from 'node:path';
import { streamArray } from '../../src/json-stream.mjs';
import { readTree } from './read-tree.mjs';
import { mapParts, openScene, newBuffer, appendFragment, packChunk, freeBytes, OUT, WORK, SC, log } from './export-chunks.mjs';

const require = (await import('node:module')).createRequire(import.meta.url);
const IMF = require('svf-utils/lib/common/intermediate-format');

const PLAN = path.join(WORK, 'rest-plan.json');
const TARGET_MB = 25; // compressed size per sub-chunk (aim 20-30 MB)
const RATIO = 0.107; // compressed / raw of the main chunks (66.8 MB / 625 MB), used to size the sub-chunks
const MIN_FREE = 3e9; // stop below 3 GB free disk space
const BYTES_PER_VERTEX = 12 + 12 + 4; // raw: position + normal floats, dbId bytes
const name = (i) => `rest-${String(i + 1).padStart(2, '0')}`;
const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1] ?? ''; };

function checkDisk(what) {
  const free = freeBytes(SC);
  log(`Free disk space: ${(free / 1e9).toFixed(1)} GB`);
  if (free < MIN_FREE) {
    console.error(`STOP before ${what}: only ${(free / 1e9).toFixed(1)} GB free (at least 3 GB needed).`);
    process.exit(2);
  }
}

// Every mesh fragment that belongs to the rest, with the dbId it keeps, always an APS model (SVF2) dbId:
//   a parts.json part that no main chunk takes (no rule result): the part's objectid (as in the main chunks);
//   otherwise the nearest matched node (the node itself, or for unmatched sub-nodes their closest matched ancestor).
function* restFragments(scene, resolve, chunkOfPart, stats) {
  for (let i = 0, n = scene.getNodeCount(); i < n; i++) {
    const node = scene.getNode(i);
    if (node.kind !== IMF.NodeKind.Object) continue;
    const { part, own, near } = resolve(node.dbid);
    if (part != null && chunkOfPart.get(part) !== 'rest') continue;
    const geom = scene.getGeometry(node.geometry);
    if (geom.kind !== IMF.GeometryKind.Mesh) { if (stats) stats.nonMesh++; continue; }
    const V = geom.getVertices(), I = geom.getIndices();
    if (!V?.length || !I?.length) { if (stats) stats.empty++; continue; }
    const dbid = part ?? near;
    if (dbid == null) { if (stats) stats.unmatched++; continue; }
    if (stats) { if (part != null) stats.part++; else if (own != null) stats.own++; else stats.ancestor++; }
    yield { node, geom, dbid, V, I };
  }
}

async function plan() {
  checkDisk('planning');
  const { chunkOfPart, resolve } = await mapParts();
  const frame = await openScene();
  const { scene } = frame;
  const st = { part: 0, own: 0, ancestor: 0, unmatched: 0, nonMesh: 0, empty: 0 };
  const tmp = newBuffer();
  const parts = new Map(); // dbid -> { raw, tris, min, max }
  const geomUse = new Map(); // geometry id -> { n, raw } (how often the same mesh repeats: instancing potential)
  let frags = 0;
  for (const { node, geom, dbid, V, I } of restFragments(scene, resolve, chunkOfPart, st)) {
    // Transform with the same code as the export (bounding box per part in the output frame).
    tmp.pos.len = 0; tmp.nrm.len = 0; tmp.id.len = 0; tmp.idx.len = 0; tmp.verts = 0;
    tmp.min = [Infinity, Infinity, Infinity]; tmp.max = [-Infinity, -Infinity, -Infinity];
    appendFragment(tmp, node, geom, dbid, frame);
    const raw = (V.length / 3) * BYTES_PER_VERTEX + I.length * 4;
    const p = parts.get(dbid) || { raw: 0, tris: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    p.raw += raw; p.tris += I.length / 3;
    for (let k = 0; k < 3; k++) { p.min[k] = Math.min(p.min[k], tmp.min[k]); p.max[k] = Math.max(p.max[k], tmp.max[k]); }
    parts.set(dbid, p);
    const g = geomUse.get(node.geometry) || { n: 0, raw };
    g.n++; geomUse.set(node.geometry, g);
    frags++;
  }
  const total = [...parts.values()].reduce((s, p) => s + p.raw, 0);
  const tris = [...parts.values()].reduce((s, p) => s + p.tris, 0);
  // Split along the ship's length (the longest axis): even sizes, and each sub-chunk is a compact slice of the ship,
  // so the browser can skip slices outside the view (frustum culling).
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of parts.values()) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.min[k]); hi[k] = Math.max(hi[k], p.max[k]); }
  const axis = [0, 1, 2].reduce((a, k) => (hi[k] - lo[k] > hi[a] - lo[a] ? k : a), 0);
  const n = Math.max(1, Math.round((total * RATIO) / (TARGET_MB * 1e6)));
  const order = [...parts].map(([db, p]) => ({ db, c: (p.min[axis] + p.max[axis]) / 2, raw: p.raw, tris: p.tris })).sort((a, b) => a.c - b.c || a.db - b.db);
  const assign = {}, chunks = Array.from({ length: n }, (_, i) => ({ name: name(i), raw_est: 0, parts: 0, triangles: 0, from_mm: null, to_mm: null }));
  let acc = 0;
  for (const p of order) {
    const i = Math.min(n - 1, Math.floor((acc + p.raw / 2) / (total / n)));
    acc += p.raw;
    assign[p.db] = i;
    const ch = chunks[i];
    ch.raw_est += p.raw; ch.parts++; ch.triangles += p.tris;
    ch.from_mm ??= Math.round(p.c); ch.to_mm = Math.round(p.c);
  }
  const repeated = [...geomUse.values()].filter((g) => g.n > 1);
  const instancing = {
    fragments: frags, unique_meshes: geomUse.size,
    repeated_meshes: repeated.length, repeated_fragments: repeated.reduce((s, g) => s + g.n, 0),
    raw_bytes_saved_if_instanced: repeated.reduce((s, g) => s + (g.n - 1) * g.raw, 0),
  };
  // A new plan replaces the old sub-chunks: drop them from the manifest (each --chunk run adds its own back).
  const mf = path.join(OUT, 'manifest.json');
  if (fs.existsSync(mf)) { const m = JSON.parse(fs.readFileSync(mf, 'utf8')); m.chunks = m.chunks.filter((c) => c.group !== 'rest'); delete m.rest; fs.writeFileSync(mf, JSON.stringify(m)); }
  fs.writeFileSync(PLAN, JSON.stringify({ generated: new Date().toISOString(), axis: 'xyz'[axis], target_mb: TARGET_MB, total_raw: total, triangles: tris, instancing, chunks, assign }));
  log(`\nRest: ${parts.size.toLocaleString('en')} parts, ${frags.toLocaleString('en')} fragments, ${tris.toLocaleString('en')} triangles, raw ${(total / 1e6).toFixed(0)} MB`);
  log(`dbIds: ${st.part.toLocaleString('en')} fragments of parts.json parts without a rule, ${st.own.toLocaleString('en')} with their own APS dbId, ${st.ancestor.toLocaleString('en')} with the dbId of their closest matched parent; ${st.unmatched} unmatched (left out); ${st.nonMesh.toLocaleString('en')} lines/points and ${st.empty} empty fragments have no triangles`);
  log(`Instancing potential: ${instancing.repeated_fragments.toLocaleString('en')} of ${frags.toLocaleString('en')} fragments reuse one of ${instancing.repeated_meshes.toLocaleString('en')} repeated meshes; would save ${(instancing.raw_bytes_saved_if_instanced / 1e6).toFixed(0)} MB raw`);
  log(`Split along ${'xyz'[axis]} into ${n} sub-chunks of about ${TARGET_MB} MB:`);
  for (const c of chunks) log(`  ${c.name}: ${c.parts.toLocaleString('en').padStart(7)} parts ${c.triangles.toLocaleString('en').padStart(11)} triangles  raw ~${(c.raw_est / 1e6).toFixed(0)} MB  ${'xyz'[axis]} ${(c.from_mm / 1000).toFixed(1)} … ${(c.to_mm / 1000).toFixed(1)} m`);
  log(`Wrote ${path.relative(SC, PLAN)}`);
}

async function chunk(k) {
  if (!fs.existsSync(PLAN)) throw new Error('No plan yet: run node export-rest.mjs --plan first');
  const pl = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  const i = Number(k) - 1;
  if (!(i >= 0 && i < pl.chunks.length)) throw new Error(`--chunk must be 1 … ${pl.chunks.length}`);
  const nm = name(i);
  checkDisk(nm);
  const t0 = Date.now();
  const { chunkOfPart, resolve } = await mapParts();
  const frame = await openScene();
  const b = newBuffer();
  for (const { node, geom, dbid } of restFragments(frame.scene, resolve, chunkOfPart)) {
    if (pl.assign[dbid] === i) appendFragment(b, node, geom, dbid, frame);
  }
  checkDisk(`writing ${nm}`);
  const packed = packChunk(nm, b, OUT, { minFree: MIN_FREE });
  if (!packed) process.exit(2);
  const c = pl.chunks[i];
  const entry = {
    name: nm, file: `${nm}.glb`, group: 'rest', load: 'background',
    title: `Rest of the model ${i + 1}/${pl.chunks.length} (${pl.axis} ${(c.from_mm / 1000).toFixed(1)} … ${(c.to_mm / 1000).toFixed(1)} m), not checked by any rule`,
    simplified: null, bytes: packed.bytes, raw_bytes: packed.raw_bytes, vertices: b.verts, triangles: packed.triangles,
    parts: b.parts.size, bounds_mm: { min: b.min.map(Math.round), max: b.max.map(Math.round) },
  };
  const mf = path.join(OUT, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  m.chunks = [...m.chunks.filter((x) => x.group !== 'rest' && x.name !== 'rest'), ...[...m.chunks.filter((x) => x.group === 'rest' && x.name !== nm), entry].sort((a, b2) => a.name.localeCompare(b2.name))];
  m.rest = { chunks: pl.chunks.length, axis: pl.axis, props: 'props/<floor(dbId / 1000)>.json', note: 'Parts no rule looks at, loaded in the background for the Full model view' };
  fs.writeFileSync(mf, JSON.stringify(m));
  log(`\n${nm}: ${(packed.bytes / 1e6).toFixed(1)} MB (raw ${(packed.raw_bytes / 1e6).toFixed(1)} MB), ${b.parts.size.toLocaleString('en')} parts, ${packed.triangles.toLocaleString('en')} triangles, ${Math.round((Date.now() - t0) / 1000)} s`);
}

// Names and properties of the rest parts, for the click card ("not checked by any rule"). Sharded by dbId so a click
// loads one small file. Parts whose own node carries few properties (e.g. "Subentity") also get the nearest ancestor
// that has ShipConstructor properties.
async function props() {
  if (!fs.existsSync(PLAN)) throw new Error('No plan yet: run node export-rest.mjs --plan first');
  checkDisk('props');
  const pl = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  log('Reading 3D_Since_AI/model-properties.json …');
  const byId = new Map();
  for await (const o of streamArray(path.join(SC, '3D_Since_AI/model-properties.json'), 'collection')) byId.set(o.objectid, o);
  const tree = await readTree(path.join(SC, '3D_Since_AI/model-tree.json'));
  const parent = new Map();
  (function walk(nodes, p) { for (const n of nodes || []) { if (p != null) parent.set(n.objectid, p); walk(n.objects, n.objectid); } })(tree.data.objects, null);
  const nameOf = (id) => byId.get(id)?.name ?? null;
  const pathOf = (id) => { const out = []; for (let p = parent.get(id); p != null; p = parent.get(p)) { const nm = nameOf(p); if (nm) out.unshift(nm); } return out; };
  const rich = (o) => !!o?.properties?.ShipConstructor;
  const shards = new Map();
  for (const db of Object.keys(pl.assign).map(Number)) {
    const o = byId.get(db);
    const rec = { name: o?.name ?? null, path: pathOf(db), chunk: name(pl.assign[db]), properties: o?.properties ?? {} };
    if (!rich(o)) {
      for (let p = parent.get(db); p != null; p = parent.get(p)) {
        const a = byId.get(p);
        if (rich(a)) { rec.part_of = { dbId: p, name: a.name, properties: a.properties }; break; }
      }
    }
    const s = Math.floor(db / 1000);
    if (!shards.has(s)) shards.set(s, {});
    shards.get(s)[db] = rec;
  }
  const dir = path.join(OUT, 'props');
  // Preserve existing property shards; regenerate the shards referenced by the current plan.
  fs.mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const [s, obj] of shards) { const f = path.join(dir, `${s}.json`); fs.writeFileSync(f, JSON.stringify(obj)); bytes += fs.statSync(f).size; }
  log(`Wrote ${shards.size} property files for ${Object.keys(pl.assign).length.toLocaleString('en')} rest parts to model/props (${(bytes / 1e6).toFixed(1)} MB)`);
}

const main = process.argv.includes('--plan') ? plan : arg('--chunk') != null ? () => chunk(arg('--chunk')) : process.argv.includes('--props') ? props : null;
if (!main) { console.error('Usage: node export-rest.mjs --plan | --chunk <n> | --props'); process.exit(1); }
await Promise.resolve().then(main).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
