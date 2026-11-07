// High-precision viewport tiles straight from the retained SVF (versioned output: model/stream-hp/).
//
// Why: the first export packed each whole chunk (up to ~60 m) with 16-bit integer positions, a ~0.9 mm grid, which
// collapsed about 4.9 million fine triangles to zero area. The tiler (tile-model.mjs) copies those bytes exactly, so
// the tiles inherit that loss. This export starts again from the source:
//   - positions: float32, relative to each tile's own origin (node translation, whole mm): no position quantization;
//     the only rounding is float32 near the tile origin (reported per run as the maximum deviation, in mm)
//   - same dbIds as the main/rest chunks (map-ids.mjs translation; rest grouping from work/rest-plan.json)
//   - same tile grid as tile-model.mjs (6 m cells by triangle centroid, at most 160,000 triangles per tile)
//   - the source material's opacity per vertex (_OPACITY, 0-255, in the spare 4th byte of the 8-bit normals): e.g. the
//     rescue-boat launch envelope is 96 % transparent in the original and must not be drawn as a solid block
//   - normals as 8-bit (as the existing chunks); dbId in COLOR_0 bytes; meshopt compression (lossless, every byte
//     checked after decoding); no simplification, nothing dropped, degenerate source triangles are kept as they are
// The existing model/stream/ and the packed GLBs stay untouched.
//
// Usage (from shipcheck/tools/export), one group per run (bounded memory):
//   node --max-old-space-size=12288 export-tiles-hp.mjs --group context      (openings, structure-findings, piping,
//                                                                              access, structure, rest-01 … rest-04)
//   node export-tiles-hp.mjs --manifest                                        -> model/stream-hp/manifest.json
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { mapParts, openScene, matrixOf, Grow, SC, WORK, log, freeBytes } from './export-chunks.mjs';

const require = createRequire(import.meta.url);
const IMF = require('svf-utils/lib/common/intermediate-format');
const OUT = path.join(SC, 'model', 'stream-hp');
const PARTS_DIR = path.join(WORK, 'hp');
const PLAN = path.join(WORK, 'rest-plan.json');
const CELL_MM = 6000, MAX_TRIANGLES = 160000, MIN_FREE = 3e9;
const MAIN = ['context', 'openings', 'structure-findings', 'piping', 'access', 'structure'];
const arg = (k) => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1]; };
const align = (n) => (n + 3) & ~3;
const restName = (i) => `rest-${String(i + 1).padStart(2, '0')}`;

function checkDisk(what) {
  const free = freeBytes(SC);
  if (free < MIN_FREE) { console.error(`STOP before ${what}: ${(free / 1e9).toFixed(1)} GB free, at least 3 GB needed`); process.exit(2); }
  return free;
}

function writeGlb(json, body) {
  const j = Buffer.from(JSON.stringify(json)), jp = Buffer.alloc(align(j.length), 32); j.copy(jp);
  const bp = Buffer.alloc(align(body.length)); Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(bp);
  const h = Buffer.alloc(20); h.writeUInt32LE(0x46546c67); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + jp.length + bp.length, 8); h.writeUInt32LE(jp.length, 12); h.writeUInt32LE(0x4e4f534a, 16);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bp.length); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, jp, bh, bp]);
}

// Twice the area of a triangle (double precision).
function area2(ax, ay, az, bx, by, bz, cx, cy, cz) {
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

async function group(name) {
  if (!MAIN.includes(name) && !/^rest-\d\d$/.test(name)) throw new Error(`Unknown group ${name}`);
  checkDisk(name);
  const t0 = Date.now();
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  const { chunkOfPart, resolve } = await mapParts();
  const frame = await openScene();
  const { scene, toOut, scaleMM, offset } = frame;

  // 1) collect the group's geometry in double precision (output frame, mm)
  const pos = new Grow(Float64Array), nrm = new Grow(Float32Array), ids = new Grow(Uint32Array), idx = new Grow(Uint32Array), opq = new Grow(Uint8Array);
  const opById = new Map(); // dbId -> opacity byte if all its fragments share it, -1 if mixed
  let verts = 0, frags = 0, srcZero = 0, unassigned = 0;
  for (let i = 0, n = scene.getNodeCount(); i < n; i++) {
    const node = scene.getNode(i);
    if (node.kind !== IMF.NodeKind.Object) continue;
    const { part, near } = resolve(node.dbid);
    let g, dbid;
    if (part != null && chunkOfPart.get(part) !== 'rest') { g = chunkOfPart.get(part); dbid = part; }
    else {
      dbid = part ?? near;
      const ri = dbid == null ? undefined : plan.assign[dbid];
      if (ri === undefined) { unassigned++; continue; }
      g = restName(ri);
    }
    if (g !== name) continue;
    const geom = scene.getGeometry(node.geometry);
    if (geom.kind !== IMF.GeometryKind.Mesh) continue;
    const V = geom.getVertices(), I = geom.getIndices(), N = geom.getNormals?.();
    if (!V?.length || !I?.length) continue;
    const M = matrixOf(node.transform), nv = V.length / 3, base = verts;
    const op = Math.round(Math.max(0, Math.min(1, scene.getMaterial(node.material)?.opacity ?? 1)) * 255);
    const prevOp = opById.get(dbid); opById.set(dbid, prevOp === undefined || prevOp === op ? op : -1);
    pos.reserve(nv * 3); nrm.reserve(nv * 3); ids.reserve(nv); idx.reserve(I.length); opq.reserve(nv);
    opq.a.fill(op, opq.len, opq.len + nv); opq.len += nv;
    for (let v = 0; v < nv; v++) {
      let x = V[3 * v], y = V[3 * v + 1], z = V[3 * v + 2];
      if (M) { const X = M[0] * x + M[4] * y + M[8] * z + M[12], Y = M[1] * x + M[5] * y + M[9] * z + M[13], Z = M[2] * x + M[6] * y + M[10] * z + M[14]; x = X; y = Y; z = Z; }
      const o = toOut(x, y, z);
      for (let k = 0; k < 3; k++) pos.a[pos.len++] = o[k] * scaleMM - offset[k];
      let nx = 0, ny = 0, nz = 1;
      if (N?.length) {
        nx = N[3 * v]; ny = N[3 * v + 1]; nz = N[3 * v + 2];
        if (M) { const X = M[0] * nx + M[4] * ny + M[8] * nz, Y = M[1] * nx + M[5] * ny + M[9] * nz, Z = M[2] * nx + M[6] * ny + M[10] * nz; nx = X; ny = Y; nz = Z; }
      }
      const on = toOut(nx, ny, nz), l = Math.hypot(...on) || 1;
      nrm.a[nrm.len++] = on[0] / l; nrm.a[nrm.len++] = on[1] / l; nrm.a[nrm.len++] = on[2] / l;
      ids.a[ids.len++] = dbid;
    }
    for (let k = 0; k < I.length; k++) idx.a[idx.len++] = base + I[k];
    verts += nv; frags++;
  }
  const P = pos.a, IX = idx.view(), T = IX.length / 3;
  for (let t = 0; t < T; t++) {
    const a = 3 * IX[3 * t], b = 3 * IX[3 * t + 1], c = 3 * IX[3 * t + 2];
    if (area2(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]) === 0) srcZero++;
  }
  log(`${name}: ${frags.toLocaleString('en')} fragments, ${T.toLocaleString('en')} triangles, ${verts.toLocaleString('en')} vertices (source zero-area triangles: ${srcZero})`);

  // 2) triangles -> 6 m cells by centroid (same rule as tile-model.mjs), counting sort
  const keyOf = new Map(), cellOf = new Int32Array(T), keys = [];
  for (let t = 0; t < T; t++) {
    const a = 3 * IX[3 * t], b = 3 * IX[3 * t + 1], c = 3 * IX[3 * t + 2];
    const key = [0, 1, 2].map((k) => Math.floor((P[a + k] + P[b + k] + P[c + k]) / 3 / CELL_MM)).join('_');
    let ci = keyOf.get(key);
    if (ci === undefined) { ci = keys.length; keyOf.set(key, ci); keys.push(key); }
    cellOf[t] = ci;
  }
  const start = new Uint32Array(keys.length + 1);
  for (let t = 0; t < T; t++) start[cellOf[t] + 1]++;
  for (let c = 0; c < keys.length; c++) start[c + 1] += start[c];
  const order = new Uint32Array(T), fill = start.slice(0, keys.length);
  for (let t = 0; t < T; t++) order[fill[cellOf[t]]++] = t;

  // 3) one GLB per tile
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(PARTS_DIR, { recursive: true });
  const remap = new Int32Array(verts).fill(-1);
  const entries = [];
  let maxDev = 0, outZero = 0, bytes = 0;
  const cellsSorted = keys.map((k, c) => [k, c]).sort((x, y) => x[0].localeCompare(y[0]));
  for (const [key, c] of cellsSorted) {
    for (let s = start[c], part = 0; s < start[c + 1]; s += MAX_TRIANGLES, part++) {
      const e = Math.min(start[c + 1], s + MAX_TRIANGLES), nt = e - s;
      const used = [];
      for (let k = s; k < e; k++) { const t = order[k]; for (let j = 0; j < 3; j++) { const v = IX[3 * t + j]; if (remap[v] < 0) { remap[v] = used.length; used.push(v); } } }
      const nv = used.length;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const v of used) for (let k = 0; k < 3; k++) { const x = P[3 * v + k]; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
      const origin = [0, 1, 2].map((k) => Math.round((min[k] + max[k]) / 2));
      const fpos = new Float32Array(nv * 3), fnrm = new Int8Array(nv * 4), fcol = new Uint8Array(nv * 4);
      const dbs = new Set();
      used.forEach((v, i) => {
        for (let k = 0; k < 3; k++) {
          fpos[3 * i + k] = P[3 * v + k] - origin[k];
          const dev = Math.abs(fpos[3 * i + k] + origin[k] - P[3 * v + k]);
          if (dev > maxDev) maxDev = dev;
          fnrm[4 * i + k] = Math.round(Math.max(-1, Math.min(1, nrm.a[3 * v + k])) * 127);
        }
        fnrm[4 * i + 3] = opq.a[v] > 127 ? opq.a[v] - 256 : opq.a[v]; // the byte is read as unsigned _OPACITY
        const d = ids.a[v]; dbs.add(d);
        fcol[4 * i] = d & 255; fcol[4 * i + 1] = (d >>> 8) & 255; fcol[4 * i + 2] = (d >>> 16) & 255; fcol[4 * i + 3] = (d >>> 24) & 255;
      });
      const findex = nv < 65536 ? new Uint16Array(nt * 3) : new Uint32Array(nt * 3);
      for (let k = s, o = 0; k < e; k++) { const t = order[k]; for (let j = 0; j < 3; j++) findex[o++] = remap[IX[3 * t + j]]; }
      for (let q = 0; q < nt; q++) {
        const a = 3 * findex[3 * q], b = 3 * findex[3 * q + 1], cc = 3 * findex[3 * q + 2];
        if (area2(fpos[a], fpos[a + 1], fpos[a + 2], fpos[b], fpos[b + 1], fpos[b + 2], fpos[cc], fpos[cc + 1], fpos[cc + 2]) === 0) outZero++;
      }
      for (const v of used) remap[v] = -1;
      // local bounds of the stored float32 positions (glTF requires POSITION min/max)
      const lmin = [Infinity, Infinity, Infinity], lmax = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) { const x = fpos[3 * i + k]; if (x < lmin[k]) lmin[k] = x; if (x > lmax[k]) lmax[k] = x; }
      // lossless meshopt compression; decode again and compare every byte
      const streams = [
        { data: new Uint8Array(fpos.buffer), count: nv, stride: 12, mode: 'ATTRIBUTES', target: 34962 },
        { data: new Uint8Array(fnrm.buffer), count: nv, stride: 4, mode: 'ATTRIBUTES', target: 34962 },
        { data: fcol, count: nv, stride: 4, mode: 'ATTRIBUTES', target: 34962 },
        { data: new Uint8Array(findex.buffer), count: nt * 3, stride: findex.BYTES_PER_ELEMENT, mode: 'TRIANGLES', target: 34963 },
      ];
      const packedParts = [], bufferViews = [];
      let compressedOffset = 0, decodedOffset = 0;
      for (const st of streams) {
        const packed = MeshoptEncoder.encodeGltfBuffer(st.data, st.count, st.stride, st.mode);
        const check = new Uint8Array(st.count * st.stride);
        MeshoptDecoder.decodeGltfBuffer(check, st.count, st.stride, packed, st.mode);
        if (st.mode === 'TRIANGLES') {
          // The index codec may rotate a triangle's vertices (abc -> bca): same triangle, same winding. Accept exactly that.
          const A = st.stride === 2 ? new Uint16Array(st.data.buffer, st.data.byteOffset, st.count) : new Uint32Array(st.data.buffer, st.data.byteOffset, st.count);
          const B = st.stride === 2 ? new Uint16Array(check.buffer, 0, st.count) : new Uint32Array(check.buffer, 0, st.count);
          for (let q = 0; q < st.count; q += 3) {
            const a = A[q], b = A[q + 1], c = A[q + 2], x = B[q], y = B[q + 1], z = B[q + 2];
            if (!((x === a && y === b && z === c) || (x === b && y === c && z === a) || (x === c && y === a && z === b))) throw new Error(`${name} ${key}: index round trip changed triangle ${q / 3}`);
          }
        } else if (Buffer.compare(Buffer.from(check), Buffer.from(st.data.buffer, st.data.byteOffset, st.data.byteLength)) !== 0) throw new Error(`${name} ${key}: compression round trip differs (${st.stride}-byte stream)`);
        bufferViews.push({ buffer: 1, byteOffset: decodedOffset, byteLength: st.data.byteLength, ...(st.target === 34962 ? { byteStride: st.stride } : {}), target: st.target,
          extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: compressedOffset, byteLength: packed.length, byteStride: st.stride, count: st.count, mode: st.mode } } });
        packedParts.push(packed);
        compressedOffset += align(packed.length);
        decodedOffset += align(st.data.byteLength);
      }
      const body = new Uint8Array(compressedOffset);
      { let o = 0; for (const p of packedParts) { body.set(p, o); o += align(p.length); } }
      const tile = `${name}-${key}-${part}`;
      const json = {
        asset: { version: '2.0', generator: 'ShipCheck export-tiles-hp.mjs (retained SVF, float32 positions per tile)' },
        extensionsUsed: ['EXT_meshopt_compression', 'KHR_mesh_quantization'], extensionsRequired: ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
        scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: tile, mesh: 0, translation: origin }],
        materials: [{ name: 'part', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.82, 0.85, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
        meshes: [{ name: tile, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2, _OPACITY: 4 }, indices: 3, material: 0 }] }],
        accessors: [
          { bufferView: 0, componentType: 5126, count: nv, type: 'VEC3', min: lmin, max: lmax },
          { bufferView: 1, componentType: 5120, normalized: true, count: nv, type: 'VEC3' },
          { bufferView: 2, componentType: 5121, normalized: true, count: nv, type: 'VEC4' },
          { bufferView: 3, componentType: findex.BYTES_PER_ELEMENT === 2 ? 5123 : 5125, count: nt * 3, type: 'SCALAR' },
          { bufferView: 1, byteOffset: 3, componentType: 5121, normalized: true, count: nv, type: 'SCALAR' }, // _OPACITY
        ],
        bufferViews,
        buffers: [{ byteLength: compressedOffset }, { byteLength: decodedOffset, extensions: { EXT_meshopt_compression: { fallback: true } } }],
      };
      const glb = writeGlb(json, body);
      const hash = crypto.createHash('sha256').update(glb).digest('hex');
      const file = `${tile}-${hash.slice(0, 12)}.glb`;
      fs.writeFileSync(path.join(OUT, file), glb);
      bytes += glb.length;
      entries.push({ name: tile, file, group: name.startsWith('rest-') ? 'rest' : name, source_chunk: name, bytes: glb.length, decoded_bytes: decodedOffset,
        resident_bytes: decodedOffset + nv * 4 + nt * 12, vertices: nv, triangles: nt, parts: dbs.size, dbIds: [...dbs],
        bounds_mm: { min: lmin.map((x, k) => x + origin[k]), max: lmax.map((x, k) => x + origin[k]) }, sha256: hash });
    }
  }
  let transparentTris = 0;
  for (let t = 0; t < T; t++) if (opq.a[IX[3 * t]] < 255) transparentTris++;
  const opacity = {}; for (const [id, o] of opById) if (o >= 0 && o < 255) opacity[id] = o;
  const mixedOpacity = [...opById].filter(([, o]) => o === -1).map(([id]) => id);
  const summary = { group: name, transparent_triangles: transparentTris, mixed_opacity_ids: mixedOpacity.length, generated: new Date().toISOString(), fragments: frags, triangles: T, vertices: verts, tiles: entries.length, bytes,
    source_zero_area_triangles: srcZero, output_zero_area_triangles: outZero, max_position_deviation_mm: maxDev, unassigned_fragments_other_groups: unassigned };
  fs.writeFileSync(path.join(PARTS_DIR, `${name}.json`), JSON.stringify({ summary, entries, opacity }));
  log(`${name}: ${entries.length} tiles, ${(bytes / 1e6).toFixed(1)} MB; zero-area triangles: source ${srcZero}, output ${outZero}; max position deviation ${maxDev.toExponential(2)} mm; ${Math.round((Date.now() - t0) / 1000)} s`);
}

function manifest() {
  const groups = [...MAIN, ...JSON.parse(fs.readFileSync(PLAN, 'utf8')).chunks.map((c, i) => restName(i))];
  const v1 = JSON.parse(fs.readFileSync(path.join(SC, 'model', 'stream', 'manifest.json'), 'utf8'));
  const chunks = [], summaries = [], opacity = {};
  for (const g of groups) {
    const f = path.join(PARTS_DIR, `${g}.json`);
    if (!fs.existsSync(f)) throw new Error(`Group ${g} not exported yet: node export-tiles-hp.mjs --group ${g}`);
    const { summary, entries, opacity: op } = JSON.parse(fs.readFileSync(f, 'utf8'));
    chunks.push(...entries); summaries.push(summary); Object.assign(opacity, op || {});
  }
  const sum = (k) => summaries.reduce((s, x) => s + x[k], 0);
  const m = {
    version: 3, kind: 'viewport-tiles', precision: 'float32 positions relative to each tile origin (no position quantization); 8-bit normals; dbId bytes; source opacity per vertex (_OPACITY)',
    // Original material opacity (0-255) of parts whose fragments all share one opacity below 1, for tiles without a
    // per-vertex _OPACITY attribute (the exterior overview tiles). Parts mixing opacities stay opaque there.
    opacity_by_dbid: opacity,
    units: v1.units, coordinate_system: v1.coordinate_system, offset_mm: v1.offset_mm, deck_levels: v1.deck_levels,
    chunks,
    sources: summaries,
    integrity: { triangles: sum('triangles'), source_zero_area_triangles: sum('source_zero_area_triangles'), output_zero_area_triangles: sum('output_zero_area_triangles'),
      max_position_deviation_mm: Math.max(...summaries.map((s) => s.max_position_deviation_mm)), transparent_triangles: sum('transparent_triangles'), attribute_roundtrip: 'every compressed stream decoded and compared byte for byte' },
    streaming: v1.streaming,
    // The exterior overview (visibility-sampled faces, used only from a distance) is reused from model/stream/ until it
    // is re-baked from these tiles; detail always comes from the high-precision tiles above.
    overview: v1.overview ? { ...v1.overview, chunks: v1.overview.chunks.map((c) => ({ ...c, file: `../stream/${c.file}` })), note: `${v1.overview.note || ''} (reused from model/stream: 16-bit source)`.trim() } : undefined,
  };
  fs.writeFileSync(path.join(OUT, 'manifest.pending.json'), JSON.stringify(m));
  fs.renameSync(path.join(OUT, 'manifest.pending.json'), path.join(OUT, 'manifest.json'));
  log(`model/stream-hp/manifest.json: ${chunks.length} tiles, ${(chunks.reduce((s, c) => s + c.bytes, 0) / 1e6).toFixed(1)} MB, ${m.integrity.triangles.toLocaleString('en')} triangles; zero-area: source ${m.integrity.source_zero_area_triangles}, output ${m.integrity.output_zero_area_triangles}; max deviation ${m.integrity.max_position_deviation_mm.toExponential(2)} mm`);
}

if (process.argv.includes('--manifest')) manifest();
else if (arg('--group')) await group(arg('--group'));
else { console.error('Usage: node export-tiles-hp.mjs --group <name> | --manifest'); process.exit(1); }
