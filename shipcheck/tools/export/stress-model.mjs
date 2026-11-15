// Large synthetic model for load tests: the production tile layout (hp: float32 positions per tile, 8-bit normals
// with opacity, dbId bytes, meshopt) at a size close to a real production model in part count.
//   node tools/export/stress-model.mjs <outDir> [parts=200000] [length_m=120] [beam_m=18] [height_m=12] [checkedShare=0.3]
// Cruise-ship scale, e.g.: node tools/export/stress-model.mjs work/cruise 2000000 360 48 60 0.02   (then build-lod.mjs)
// Default: 200,000 parts, 9.6 million triangles, 70,000 checked parts in the catalog (as many as the real RCRV).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import { encode, writeGlb } from './synthetic-model.mjs';

const CELL = 6000, PITCH = 400, SIZE = 300, N = 2, MAX_TRIS = 40000;
const VERTS = 6 * (N + 1) * (N + 1), TRIS = 6 * N * N * 2;
// Deterministic hash in [0, 1).
const rnd = (i) => { let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16; return (x >>> 0) / 4294967296; };

// Unit box with subdivided faces: positions in [0, 1]^3, normals, indices.
const UNIT = (() => {
  const pos = [], nrm = [], idx = [];
  const faces = [[[1, 0, 0], [0, 1, 0], [0, 0, 1], 1], [[-1, 0, 0], [0, 0, 1], [0, 1, 0], 0], [[0, 1, 0], [0, 0, 1], [1, 0, 0], 1], [[0, -1, 0], [1, 0, 0], [0, 0, 1], 0], [[0, 0, 1], [1, 0, 0], [0, 1, 0], 1], [[0, 0, -1], [0, 1, 0], [1, 0, 0], 0]];
  for (const [n, u, v, at] of faces) {
    const base = pos.length / 3;
    for (let a = 0; a <= N; a++) for (let b = 0; b <= N; b++) {
      for (let k = 0; k < 3; k++) pos.push(Math.abs(n[k]) * at + u[k] * (a / N) + v[k] * (b / N));
      nrm.push(...n);
    }
    for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
      const p = base + a * (N + 1) + b;
      idx.push(p, p + N + 1, p + 1, p + 1, p + N + 1, p + N + 2);
    }
  }
  return { pos, nrm, idx };
})();

function writeTile(dir, name, group, parts) {
  const nv = parts.length * VERTS, nt = parts.length * TRIS;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let k = 0; k < 3; k++) { if (p.at[k] < min[k]) min[k] = p.at[k]; if (p.at[k] + SIZE > max[k]) max[k] = p.at[k] + SIZE; }
  const origin = [0, 1, 2].map((k) => Math.round((min[k] + max[k]) / 2));
  const fpos = new Float32Array(nv * 3), fnrm = new Int8Array(nv * 4), fcol = new Uint8Array(nv * 4);
  const findex = nv < 65536 ? new Uint16Array(nt * 3) : new Uint32Array(nt * 3);
  parts.forEach((p, i) => {
    const vb = i * VERTS;
    for (let v = 0; v < VERTS; v++) {
      for (let k = 0; k < 3; k++) { fpos[3 * (vb + v) + k] = p.at[k] + UNIT.pos[3 * v + k] * SIZE - origin[k]; fnrm[4 * (vb + v) + k] = UNIT.nrm[3 * v + k] * 127; }
      fnrm[4 * (vb + v) + 3] = -1; // opacity 255
      const o = 4 * (vb + v), d = p.dbId;
      fcol[o] = d & 255; fcol[o + 1] = (d >>> 8) & 255; fcol[o + 2] = (d >>> 16) & 255; fcol[o + 3] = (d >>> 24) & 255;
    }
    for (let t = 0; t < UNIT.idx.length; t++) findex[i * UNIT.idx.length + t] = vb + UNIT.idx[t];
  });
  const enc = encode([
    { data: new Uint8Array(fpos.buffer), count: nv, stride: 12, mode: 'ATTRIBUTES', target: 34962 },
    { data: new Uint8Array(fnrm.buffer), count: nv, stride: 4, mode: 'ATTRIBUTES', target: 34962 },
    { data: fcol, count: nv, stride: 4, mode: 'ATTRIBUTES', target: 34962 },
    { data: new Uint8Array(findex.buffer), count: nt * 3, stride: findex.BYTES_PER_ELEMENT, mode: 'TRIANGLES', target: 34963 },
  ]);
  const json = {
    asset: { version: '2.0', generator: 'ShipCheck stress-model.mjs' },
    extensionsUsed: ['EXT_meshopt_compression', 'KHR_mesh_quantization'], extensionsRequired: ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0, translation: origin }],
    materials: [{ name: 'part', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.82, 0.85, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2, _OPACITY: 4 }, indices: 3, material: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: 'VEC3', min: min.map((x, k) => x - origin[k]), max: max.map((x, k) => x - origin[k]) },
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
  const resident = enc.decodedOffset + nv * 4 + nt * 12;
  return { name, file, group, source_chunk: group, bytes: glb.length, decoded_bytes: resident, resident_bytes: resident, vertices: nv, triangles: nt, parts: parts.length, dbIds: parts.map((p) => p.dbId), bounds_mm: { min, max } };
}

export async function writeStressModel(outDir, { parts: wanted = 200000, length = 120, beam = 18, height = 12, checkedShare = 0.3 } = {}) {
  const L = length * 1000, W = beam * 1000, H = height * 1000;
  const NX = L / PITCH, NY = H / PITCH, NZ = W / PITCH;
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const dir = path.join(outDir, 'stream-hp');
  fs.mkdirSync(dir, { recursive: true });
  const fill = wanted / (NX * NY * NZ);
  const cells = new Map();
  const catalogParts = [];
  let dbId = 0;
  for (let ix = 0; ix < NX; ix++) for (let iy = 0; iy < NY; iy++) for (let iz = 0; iz < NZ; iz++) {
    const slot = (ix * NY + iy) * NZ + iz;
    const shell = iy === 0 || iz === 0 || iz === NZ - 1;
    if (!shell && rnd(slot) > fill) continue;
    dbId++;
    const r = rnd(slot + 7919);
    const group = shell ? 'context' : r < checkedShare ? 'checked' : 'rest';
    const at = [ix * PITCH - L / 2, iy * PITCH - H / 2, iz * PITCH - W / 2];
    const key = `${group}-${Math.floor(at[0] / CELL)}_${Math.floor(at[1] / CELL)}_${Math.floor(at[2] / CELL)}`;
    if (!cells.has(key)) cells.set(key, { group, parts: [] });
    cells.get(key).parts.push({ dbId, at });
    if (group !== 'rest') {
      // 1.5 % of the checked plates are thinner than the rule's 8 mm; 1 % have no thickness.
      const q = rnd(slot + 104729);
      catalogParts.push({ objectid: dbId, name: `Plate ${dbId}`, group: 'ShipConstructor', material: 'CS ABS A', swbs: shell ? '110' : '120', partName: 'PLATE', sourceFile: `UNIT-${Math.floor(ix / 15)}.dwg`,
        ...(q < 0.01 ? {} : { thickness: { mm: q < 0.025 ? 6 : 8 + Math.floor(q * 10), raw: 'synthetic' } }) });
    }
  }
  const chunks = [];
  for (const [key, cell] of [...cells].sort((a, b) => a[0].localeCompare(b[0]))) {
    for (let i = 0, n = 0; i < cell.parts.length; i += Math.floor(MAX_TRIS / TRIS), n++) {
      chunks.push(writeTile(dir, `${key}-${n}`, cell.group, cell.parts.slice(i, i + Math.floor(MAX_TRIS / TRIS))));
    }
  }
  const triangles = chunks.reduce((s, c) => s + c.triangles, 0);
  const manifest = {
    version: 3, kind: 'viewport-tiles', precision: 'synthetic load-test model (hp layout)', opacity_by_dbid: {},
    units: 'mm', coordinate_system: 'glTF, Y up', offset_mm: [0, 0, 0], deck_levels: [{ id: 0, height: 0, name: 'Mid height' }],
    chunks, sources: [{ group: 'synthetic', triangles }], integrity: { triangles },
    streaming: { detail_span_mm: 24000, max_resident_bytes: 512000000, max_detail_triangles: 1500000, max_requests: 6, min_detail_screen_px: 56, detail_keep_ratio: 0.6 },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify({ pass: true, note: 'synthetic load-test model' }));
  const catalog = {
    scenarios: { scenarios: [{ id: 'rcrv-3d', name: 'Load-test model', kind: 'parts', viewer: 'local', model: 'ships/rcrv/parts.json', meta: 'ships/rcrv/rcrv-3d.meta.json', expected: null, precomputed: null }] },
    rules: { rules: [
      { id: 'TEST-PLATE-MIN', source: 'test rule set', clause: 'A.1', text: 'Plating is at least 8 mm thick.', check: 'min', parameter: 'thickness', value: 8, unit: 'mm', verified: false, applies_to: { types: ['plate'], where: { swbs_group: { prefix: '1' } } } },
      { id: 'TEST-MATERIAL', source: 'test rule set', clause: 'A.2', text: 'Plating is carbon steel.', check: 'in_set', parameter: 'material_family', values: ['carbon steel'], verified: false, applies_to: { types: ['plate'] } },
    ] },
    'model-rcrv-parts': { name: 'Load-test ship (parts)', source: { file: 'synthetic.nwd', model_unit: 'mm' }, counts: { objects: dbId, kept: catalogParts.length }, parts: catalogParts },
    'model-rcrv-meta': { name: 'Load-test ship', ship: { type: { value: 'research vessel', source: 'test' }, length_overall: { value: length, unit: 'm', source: 'test' } } },
    'regulation-links': { database: 'none', loaded_instruments: 'none', method: 'none', rules: {} },
  };
  fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify(catalog));
  return { manifest, catalog, parts: dbId, triangles, tiles: chunks.length, bytes: chunks.reduce((s, c) => s + c.bytes, 0), checked: catalogParts.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const r = await writeStressModel(path.resolve(process.argv[2] || 'work/stress-model'), { parts: Number(process.argv[3]) || 200000, length: Number(process.argv[4]) || 120, beam: Number(process.argv[5]) || 18, height: Number(process.argv[6]) || 12, checkedShare: process.argv[7] ? Number(process.argv[7]) : 0.3 });
  console.log(`${r.parts.toLocaleString('en')} parts (${r.checked.toLocaleString('en')} checked), ${r.triangles.toLocaleString('en')} triangles, ${r.tiles} tiles, ${(r.bytes / 1e6).toFixed(1)} MB, manifest ${(fs.statSync(path.join(process.argv[2] || 'work/stress-model', 'stream-hp/manifest.json')).size / 1e6).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)} s`);
}
