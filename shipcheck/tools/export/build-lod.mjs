// Level-of-detail pyramid for the base layer of the streamed viewer (the exterior overview and the hull/deck context).
//
// Why: without it the viewer keeps every base tile of the visible ship resident at source quality (RCRV: 706 overview
// tiles, 3.4 million triangles, about 280 MB). That grows with the ship: a cruise ship would need several GB before the
// first zoom. With the pyramid the whole-ship view loads a handful of coarse tiles, and the amount of geometry on
// screen depends on the view, not on the size of the ship. Zooming in replaces a coarse tile by its children down to
// the unchanged source tiles, so single parts can still be inspected at full quality.
//
// What it does: the existing base tiles are the leaves. Level k merges the tiles of level k-1 inside cells of
// 6 m x 2^k, drops parts smaller than a few pixels at the distance where that level is used, simplifies the rest with
// meshoptimizer within an absolute error bound, and writes one tile per cell in the high-precision tile layout
// (float32 positions relative to the tile origin, 8-bit normals with the source opacity, dbId bytes). Every vertex
// keeps the dbId of a real part, and every triangle belongs to exactly one part, as the viewer's part state requires.
// The detail tiles and the leaves are not touched: no source geometry is changed or removed.
//
//   node tools/export/build-lod.mjs [--model <dir>] [--out <dir>]
//     --model  model directory with stream-hp/manifest.json or stream/manifest.json (default: shipcheck/model)
//     --out    write the tiles and lod.json there and leave the manifests alone (trial run)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import { decodeGlb } from './tile-model.mjs';
import { encode, writeGlb } from './synthetic-model.mjs';

const CELL_MM = 6000;
// Error bound of level k: cell size / RESOLUTION, i.e. a cell is replaced by its children before its error grows
// beyond about a pixel when the cell fills RESOLUTION pixels.
const RESOLUTION = 512;
// Parts whose bounding box is smaller than CULL x the level's error are left out of that level.
const CULL = 2;
// A node larger than this is simplified further (its real error is recorded, so the viewer refines it sooner).
const MAX_NODE_TRIANGLES = 100000;
const MAX_LEVELS = 12;

const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1]; };
const diag = (b) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);

// ---------- geometry in memory: absolute mm ----------
// { pos: Float32Array(3n), nrm: Int8Array(4n) (xyz, 4th byte = opacity 0..255), ids: Uint32Array(n), idx: Uint32Array }

export async function readTile(file, opacityTable = null) {
  const { json: j, views } = await decodeGlb(file);
  const prim = j.meshes[0].primitives[0], node = j.nodes[0];
  if (node.rotation || node.matrix) throw new Error(`${path.basename(file)}: rotated tile nodes are not supported`);
  const at = (i) => { const a = j.accessors[i], bv = j.bufferViews[a.bufferView]; return { a, data: views[a.bufferView], stride: bv.byteStride, off: a.byteOffset || 0 }; };
  const P = at(prim.attributes.POSITION), N = at(prim.attributes.NORMAL), C = at(prim.attributes.COLOR_0), I = at(prim.indices);
  const O = prim.attributes._OPACITY != null ? at(prim.attributes._OPACITY) : null;
  const n = P.a.count, scale = node.scale || [1, 1, 1], tr = node.translation || [0, 0, 0];
  const pos = new Float32Array(3 * n), nrm = new Int8Array(4 * n), ids = new Uint32Array(n);
  const pv = new DataView(P.data.buffer, P.data.byteOffset, P.data.byteLength);
  const float = P.a.componentType === 5126;
  if (!float && P.a.componentType !== 5123) throw new Error(`${path.basename(file)}: unexpected position type ${P.a.componentType}`);
  const ps = P.stride || (float ? 12 : 8);
  for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) {
    const q = float ? pv.getFloat32(P.off + v * ps + 4 * k, true) : pv.getUint16(P.off + v * ps + 2 * k, true);
    pos[3 * v + k] = q * scale[k] + tr[k];
  }
  const ns = N.stride || 4, cs = C.stride || 4, os = O ? (O.stride || 4) : 0;
  for (let v = 0; v < n; v++) {
    const c = C.off + v * cs, id = (C.data[c] | (C.data[c + 1] << 8) | (C.data[c + 2] << 16) | (C.data[c + 3] << 24)) >>> 0;
    ids[v] = id;
    for (let k = 0; k < 3; k++) nrm[4 * v + k] = (N.data[N.off + v * ns + k] << 24) >> 24;
    const opacity = O ? O.data[O.off + v * os] : opacityTable?.[id] ?? 255;
    nrm[4 * v + 3] = (opacity << 24) >> 24;
  }
  const iv = new DataView(I.data.buffer, I.data.byteOffset, I.data.byteLength);
  const wide = I.a.componentType === 5125, idx = new Uint32Array(I.a.count);
  for (let i = 0; i < idx.length; i++) idx[i] = wide ? iv.getUint32(I.off + 4 * i, true) : iv.getUint16(I.off + 2 * i, true);
  return { pos, nrm, ids, idx };
}

export function merge(meshes) {
  const n = meshes.reduce((s, m) => s + m.ids.length, 0), t = meshes.reduce((s, m) => s + m.idx.length, 0);
  const out = { pos: new Float32Array(3 * n), nrm: new Int8Array(4 * n), ids: new Uint32Array(n), idx: new Uint32Array(t) };
  let v = 0, i = 0;
  for (const m of meshes) {
    out.pos.set(m.pos, 3 * v); out.nrm.set(m.nrm, 4 * v); out.ids.set(m.ids, v);
    for (let k = 0; k < m.idx.length; k++) out.idx[i + k] = m.idx[k] + v;
    v += m.ids.length; i += m.idx.length;
  }
  return out;
}

// Drop the triangles of parts whose bounding box (within this mesh) is smaller than minDiag.
export function cullSmallParts(mesh, minDiag) {
  const box = new Map();
  for (let v = 0; v < mesh.ids.length; v++) {
    let b = box.get(mesh.ids[v]);
    if (!b) box.set(mesh.ids[v], b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
    for (let k = 0; k < 3; k++) { const x = mesh.pos[3 * v + k]; if (x < b[k]) b[k] = x; if (x > b[k + 3]) b[k + 3] = x; }
  }
  const small = new Set();
  for (const [id, b] of box) if (Math.hypot(b[3] - b[0], b[4] - b[1], b[5] - b[2]) < minDiag) small.add(id);
  if (!small.size) return { mesh, culledParts: 0 };
  const idx = new Uint32Array(mesh.idx.length);
  let n = 0;
  for (let t = 0; t < mesh.idx.length; t += 3) {
    if (small.has(mesh.ids[mesh.idx[t]])) continue;
    idx[n++] = mesh.idx[t]; idx[n++] = mesh.idx[t + 1]; idx[n++] = mesh.idx[t + 2];
  }
  return { mesh: { ...mesh, idx: idx.subarray(0, n) }, culledParts: small.size };
}

// Keep only referenced vertices; make every triangle belong to one part (the part of its first vertex): a vertex of
// another part is replaced by a copy that carries the triangle's dbId and opacity. Degenerate triangles are removed.
export function compact(mesh) {
  const map = new Map(); // "vertex|dbId" -> new index
  const pos = [], nrm = [], ids = [], idx = new Uint32Array(mesh.idx.length);
  let n = 0, reassigned = 0;
  for (let t = 0; t < mesh.idx.length; t += 3) {
    const a = mesh.idx[t], b = mesh.idx[t + 1], c = mesh.idx[t + 2];
    if (a === b || b === c || a === c) continue;
    // triPart (after clustering): the part and opacity the triangle had before its vertices were merged.
    const id = mesh.triPart ? mesh.triPart[t / 3] : mesh.ids[a], opacity = mesh.triOpacity ? mesh.triOpacity[t / 3] : mesh.nrm[4 * a + 3];
    for (const v of [a, b, c]) {
      const own = mesh.ids[v] === id, key = own ? v : `${v}|${id}`;
      let w = map.get(key);
      if (w === undefined) {
        w = ids.length;
        map.set(key, w);
        pos.push(mesh.pos[3 * v], mesh.pos[3 * v + 1], mesh.pos[3 * v + 2]);
        nrm.push(mesh.nrm[4 * v], mesh.nrm[4 * v + 1], mesh.nrm[4 * v + 2], own ? mesh.nrm[4 * v + 3] : opacity);
        ids.push(id);
        if (!own) reassigned++;
      }
      idx[n++] = w;
    }
  }
  return { mesh: { pos: Float32Array.from(pos), nrm: Int8Array.from(nrm), ids: Uint32Array.from(ids), idx: idx.slice(0, n) }, reassigned };
}

// Vertex clustering on a grid of g mm: all vertices in one grid cell become one (the first seen), triangles that
// collapse or repeat are removed. Unlike edge collapse it also merges separate parts (thousands of small plates,
// profiles and pipes), so it always reaches a size bound; each triangle keeps the part it came from.
export function cluster(mesh, g) {
  const b = boundsOf(mesh), rep = new Map(), to = new Uint32Array(mesh.ids.length);
  const nx = Math.floor((b.max[0] - b.min[0]) / g) + 2, ny = Math.floor((b.max[1] - b.min[1]) / g) + 2;
  for (let v = 0; v < mesh.ids.length; v++) {
    const key = (Math.floor((mesh.pos[3 * v + 2] - b.min[2]) / g) * ny + Math.floor((mesh.pos[3 * v + 1] - b.min[1]) / g)) * nx + Math.floor((mesh.pos[3 * v] - b.min[0]) / g);
    let r = rep.get(key);
    if (r === undefined) rep.set(key, r = v);
    to[v] = r;
  }
  const seen = new Set(), idx = new Uint32Array(mesh.idx.length), triPart = new Uint32Array(mesh.idx.length / 3), triOpacity = new Int8Array(mesh.idx.length / 3);
  let n = 0;
  for (let t = 0; t < mesh.idx.length; t += 3) {
    const a = to[mesh.idx[t]], c = to[mesh.idx[t + 1]], d = to[mesh.idx[t + 2]];
    if (a === c || c === d || a === d) continue;
    const lo = Math.min(a, c, d), hi = Math.max(a, c, d), mid = a + c + d - lo - hi;
    const key = lo + ':' + mid + ':' + hi; // both faces of a thin plate end up on the same triangle: keep one
    if (seen.has(key)) continue;
    seen.add(key);
    const first = mesh.idx[t];
    triPart[n / 3] = mesh.triPart ? mesh.triPart[t / 3] : mesh.ids[first];
    triOpacity[n / 3] = mesh.triOpacity ? mesh.triOpacity[t / 3] : mesh.nrm[4 * first + 3];
    idx[n++] = a; idx[n++] = c; idx[n++] = d;
  }
  return { ...mesh, idx: idx.subarray(0, n), triPart: triPart.subarray(0, n / 3), triOpacity: triOpacity.subarray(0, n / 3) };
}

// Simplify within an absolute error (mm), then, if the node is still too heavy for one tile, cluster on a growing
// grid until it fits. Returns the mesh and the error actually reached (the viewer refines by that error).
export function simplify(mesh, errorMm, maxTriangles = MAX_NODE_TRIANGLES) {
  if (!mesh.idx.length) return { mesh, error: 0 };
  MeshoptSimplifier.useExperimentalFeatures = true;
  let [idx, error] = MeshoptSimplifier.simplify(mesh.idx, mesh.pos, 3, 0, errorMm, ['ErrorAbsolute', 'Prune']);
  let out = { ...mesh, idx };
  for (let g = errorMm; out.idx.length / 3 > maxTriangles; g *= 1.5) {
    out = cluster({ ...mesh, idx }, g);
    error = Math.max(error, g * Math.sqrt(3)); // a vertex moves at most one grid-cell diagonal
  }
  return { mesh: out, error };
}

function boundsOf(mesh) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < mesh.ids.length; v++) for (let k = 0; k < 3; k++) { const x = mesh.pos[3 * v + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
  return { min, max };
}

// One tile in the hp layout (as export-tiles-hp.mjs writes it).
export function writeTile(dir, name, mesh) {
  const nv = mesh.ids.length, nt = mesh.idx.length / 3, bounds = boundsOf(mesh);
  const origin = [0, 1, 2].map((k) => Math.round((bounds.min[k] + bounds.max[k]) / 2));
  const fpos = new Float32Array(nv * 3), fcol = new Uint8Array(nv * 4);
  const lmin = [Infinity, Infinity, Infinity], lmax = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) {
    for (let k = 0; k < 3; k++) { const x = fpos[3 * v + k] = mesh.pos[3 * v + k] - origin[k]; if (x < lmin[k]) lmin[k] = x; if (x > lmax[k]) lmax[k] = x; }
    const d = mesh.ids[v], o = 4 * v;
    fcol[o] = d & 255; fcol[o + 1] = (d >>> 8) & 255; fcol[o + 2] = (d >>> 16) & 255; fcol[o + 3] = (d >>> 24) & 255;
  }
  const findex = nv < 65536 ? Uint16Array.from(mesh.idx) : Uint32Array.from(mesh.idx);
  const enc = encode([
    { data: new Uint8Array(fpos.buffer), count: nv, stride: 12, mode: 'ATTRIBUTES', target: 34962 },
    { data: new Uint8Array(mesh.nrm.buffer, mesh.nrm.byteOffset, nv * 4), count: nv, stride: 4, mode: 'ATTRIBUTES', target: 34962 },
    { data: fcol, count: nv, stride: 4, mode: 'ATTRIBUTES', target: 34962 },
    { data: new Uint8Array(findex.buffer), count: nt * 3, stride: findex.BYTES_PER_ELEMENT, mode: 'TRIANGLES', target: 34963 },
  ]);
  const json = {
    asset: { version: '2.0', generator: 'Complee build-lod.mjs' },
    extensionsUsed: ['EXT_meshopt_compression', 'KHR_mesh_quantization'], extensionsRequired: ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0, translation: origin }],
    materials: [{ name: 'part', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.82, 0.85, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2, _OPACITY: 4 }, indices: 3, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: 'VEC3', min: lmin, max: lmax },
      { bufferView: 1, componentType: 5120, normalized: true, count: nv, type: 'VEC3' },
      { bufferView: 2, componentType: 5121, normalized: true, count: nv, type: 'VEC4' },
      { bufferView: 3, componentType: findex.BYTES_PER_ELEMENT === 2 ? 5123 : 5125, count: nt * 3, type: 'SCALAR' },
      { bufferView: 1, byteOffset: 3, componentType: 5121, normalized: true, count: nv, type: 'SCALAR' },
    ],
    bufferViews: enc.bufferViews,
    buffers: [{ byteLength: enc.body.length }, { byteLength: enc.decodedOffset, extensions: { EXT_meshopt_compression: { fallback: true } } }],
  };
  const glb = writeGlb(json, enc.body);
  const file = `${name}-${crypto.createHash('sha256').update(glb).digest('hex').slice(0, 12)}.glb`;
  fs.writeFileSync(path.join(dir, file), glb);
  return { file, bytes: glb.length, decoded_bytes: enc.decodedOffset, resident_bytes: nv * 40 + nt * 36, vertices: nv, triangles: nt, parts: new Set(mesh.ids).size, bounds_mm: bounds };
}

// Build one pyramid. leaves: manifest tile entries; read(info) -> mesh; group: tile group of the new nodes.
// Returns { roots, nodes, levels } where nodes reference their children (leaf or node) by name.
export async function buildPyramid({ leaves, read, outDir, prefix, group, log = () => {} }) {
  // The grid starts at the model's minimum corner, so the cells nest and the last level is one cell (one root).
  const anchor = [0, 1, 2].map((k) => Math.floor(Math.min(...leaves.map((c) => c.bounds_mm.min[k])) / CELL_MM) * CELL_MM);
  const center = (b) => [0, 1, 2].map((k) => (b.min[k] + b.max[k]) / 2 - anchor[k]);
  // Current level: entries { name, bounds_mm, error, mesh? (in memory for built nodes), info? (leaf) }
  let current = leaves.map((info) => ({ name: info.name, bounds_mm: info.bounds_mm, error: 0, info }));
  const nodes = [], levels = [];
  for (let level = 1; level <= MAX_LEVELS && current.length > 1; level++) {
    const size = CELL_MM * 2 ** level, target = size / RESOLUTION;
    const cells = new Map();
    for (const e of current) {
      const key = center(e.bounds_mm).map((x) => Math.floor(x / size)).join('_');
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(e);
    }
    const next = [];
    let tin = 0, tout = 0, culled = 0, reassignedTotal = 0;
    for (const [key, children] of [...cells].sort((a, b) => a[0].localeCompare(b[0]))) {
      const meshes = [];
      for (const c of children) meshes.push(c.mesh ?? await read(c.info));
      let mesh = merge(meshes);
      for (const c of children) c.mesh = null; // children are on disk (or leaves): free the memory
      tin += mesh.idx.length / 3;
      const cut = cullSmallParts(mesh, CULL * target);
      culled += cut.culledParts;
      const simple = simplify(cut.mesh, target);
      const packed = compact(simple.mesh);
      reassignedTotal += packed.reassigned;
      mesh = packed.mesh;
      // Error of the node against the source: what its children already carry, this level's simplification, and the
      // size of the parts left out.
      const error = Math.max(...children.map((c) => c.error)) + simple.error + (cut.culledParts ? CULL * target : 0);
      const name = `${prefix}-L${level}-${key}`;
      const childNames = children.map((c) => c.name);
      const union = { min: [0, 1, 2].map((k) => Math.min(...children.map((c) => c.bounds_mm.min[k]))), max: [0, 1, 2].map((k) => Math.max(...children.map((c) => c.bounds_mm.max[k]))) };
      let entry;
      if (mesh.idx.length) {
        const written = writeTile(outDir, name, mesh);
        // The node stands for everything below it: its bounds are those of its children, also where parts were left out.
        entry = { name, group, level, error_mm: Math.round(error * 100) / 100, children: childNames, ...written, bounds_mm: union };
      } else {
        entry = { name, group, level, error_mm: Math.round(error * 100) / 100, children: childNames, file: null, bytes: 0, decoded_bytes: 0, resident_bytes: 0, vertices: 0, triangles: 0, parts: 0, bounds_mm: union };
      }
      tout += entry.triangles;
      nodes.push(entry);
      next.push({ name, bounds_mm: union, error, mesh });
    }
    levels.push({ level, cell_mm: size, target_error_mm: target, nodes: next.length, triangles_in: tin, triangles: tout, culled_parts: culled, reassigned_vertices: reassignedTotal });
    log(`  level ${level} (${size / 1000} m cells, ${target.toFixed(1)} mm): ${next.length} nodes, ${tin.toLocaleString('en')} -> ${tout.toLocaleString('en')} triangles`);
    current = next;
  }
  for (const e of current) e.mesh = null;
  return { roots: current.map((e) => e.name), nodes, levels };
}

async function main() {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const model = path.resolve(arg('--model') || path.join(here, '../../model'));
  const trial = arg('--out') ? path.resolve(arg('--out')) : null;
  const hpFile = path.join(model, 'stream-hp', 'manifest.json'), plainFile = path.join(model, 'stream', 'manifest.json');
  const manifestFile = fs.existsSync(hpFile) ? hpFile : plainFile;
  if (!fs.existsSync(manifestFile)) throw new Error(`No tile manifest under ${model}`);
  const manifestDir = path.dirname(manifestFile);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  // Tiles go next to the overview tiles (model/stream when it exists), referenced relative to each manifest.
  const tileDir = trial || (fs.existsSync(plainFile) ? path.dirname(plainFile) : manifestDir);
  fs.mkdirSync(tileDir, { recursive: true });
  const free = fs.statfsSync(tileDir); // refuse to fill the disk
  if (free.bavail * free.bsize < 2e9) throw new Error('STOP: at least 2 GB of free disk space is required');
  const read = (info) => readTile(path.resolve(manifestDir, info.file), manifest.opacity_by_dbid);
  const t0 = Date.now(), trees = {};
  const sets = { overview: manifest.overview?.chunks || [], context: manifest.chunks.filter((c) => c.group === 'context') };
  for (const [key, leaves] of Object.entries(sets)) {
    if (leaves.length < 2) continue;
    console.log(`${key}: ${leaves.length} tiles, ${leaves.reduce((s, c) => s + c.triangles, 0).toLocaleString('en')} triangles`);
    trees[key] = await buildPyramid({ leaves, read, outDir: tileDir, prefix: `overview-lod-${key}`, group: key, log: console.log });
  }
  const lod = { version: 1, generated: new Date().toISOString(), pixel_error: 4, resolution: RESOLUTION, trees,
    note: 'Simplified stand-ins for the base tiles at a distance; children lists lead down to the unchanged source tiles.' };
  if (trial) {
    fs.writeFileSync(path.join(trial, 'lod.json'), JSON.stringify(lod));
    console.log(`Trial run: tiles and lod.json in ${trial}; manifests unchanged.`);
  } else {
    for (const file of [hpFile, plainFile]) {
      if (!fs.existsSync(file)) continue;
      const m = file === manifestFile ? manifest : JSON.parse(fs.readFileSync(file, 'utf8'));
      const rel = path.relative(path.dirname(file), tileDir).replaceAll('\\', '/');
      const withPath = (n) => (n.file ? { ...n, file: rel ? `${rel}/${n.file}` : n.file } : n);
      m.lod = { ...lod, trees: Object.fromEntries(Object.entries(trees).map(([k, t]) => [k, { ...t, nodes: t.nodes.map(withPath) }])) };
      const pending = file.replace(/\.json$/, '.pending.json');
      fs.writeFileSync(pending, JSON.stringify(m));
      fs.renameSync(pending, file);
      console.log(`Updated ${path.relative(model, file)}`);
    }
  }
  const all = Object.values(trees).flatMap((t) => t.nodes);
  console.log(`${all.length} LOD tiles, ${(all.reduce((s, n) => s + n.bytes, 0) / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)} s`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
