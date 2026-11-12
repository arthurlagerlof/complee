// Synthetic viewport-tile model for tests and demos: a small steel "ship" (hull plates, decks, hatches, equipment)
// written in exactly the tile layout the real export produces (export-tiles-hp.mjs: float32 positions per tile,
// 8-bit normals with the source opacity in the spare byte, dbId bytes in COLOR_0, meshopt compression) plus rest
// tiles in the older 16-bit quantized layout (tile-model.mjs). It needs no Autodesk data or credentials.
//
//   node tools/export/synthetic-model.mjs <outDir>          -> <outDir>/stream-hp/{manifest.json,audit.json,*.glb}
//                                                             and <outDir>/catalog.json (parts, rules, scenarios)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const CELL_MM = 6000;
const align = (n) => (n + 3) & ~3;

export function writeGlb(json, body) {
  const j = Buffer.from(JSON.stringify(json)), jp = Buffer.alloc(align(j.length), 32); j.copy(jp);
  const bp = Buffer.alloc(align(body.length)); Buffer.from(body.buffer, body.byteOffset, body.byteLength).copy(bp);
  const h = Buffer.alloc(20); h.writeUInt32LE(0x46546c67); h.writeUInt32LE(2, 4); h.writeUInt32LE(28 + jp.length + bp.length, 8); h.writeUInt32LE(jp.length, 12); h.writeUInt32LE(0x4e4f534a, 16);
  const bh = Buffer.alloc(8); bh.writeUInt32LE(bp.length); bh.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([h, jp, bh, bp]);
}

// Axis-aligned box as 12 triangles with per-face normals (24 vertices).
function box(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const faces = [
    [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]],
    [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0], [-1, 0, 0]],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]],
    [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0]],
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]],
    [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]],
  ];
  const pos = [], nrm = [], idx = [];
  for (const [a, b, c, d, n] of faces) {
    const base = pos.length / 3;
    for (const p of [a, b, c, d]) { pos.push(...p); nrm.push(...n); }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { pos, nrm, idx };
}

// The ship: 60 m long (x), 12 m wide (z), 10 m high (y); centred at the origin like the real export frame.
export function buildParts() {
  const parts = []; // { dbId, group, type, name, box: [min, max], opacity, catalog }
  let next = 1;
  const add = (group, name, min, max, catalog, opacity = 255) => { const dbId = next++; parts.push({ dbId, group, name, box: [min, max], opacity, catalog: catalog && { objectid: dbId, name, ...catalog } }); return dbId; };
  const L = 60000, W = 12000, H = 10000, T = 12;
  const plate = (swbs, thickness) => ({ group: 'ShipConstructor', material: 'CS ABS A', swbs, partName: 'PLATE', sourceFile: 'HULL.dwg', thickness: { mm: thickness, raw: `${thickness} mm` } });
  // Shell plating (SWBS 110): side, bottom and transverse plates, each inside one 6 m cell.
  for (let x = -L / 2; x < L / 2; x += CELL_MM) {
    for (let y = -H / 2; y < H / 2; y += CELL_MM / 2) {
      const y1 = Math.min(y + CELL_MM / 2, H / 2);
      add('context', `Shell plate P${x}/${y}`, [x + 10, y + 10, W / 2 - T], [x + CELL_MM - 10, y1 - 10, W / 2], plate('110', 8));
      add('context', `Shell plate S${x}/${y}`, [x + 10, y + 10, -W / 2], [x + CELL_MM - 10, y1 - 10, -W / 2 + T], plate('110', 8));
    }
    for (let z = -W / 2; z < W / 2; z += CELL_MM) {
      add('context', `Bottom plate ${x}/${z}`, [x + 10, -H / 2, z + 10], [x + CELL_MM - 10, -H / 2 + T, z + CELL_MM - 10], plate('110', 10));
    }
  }
  // Main deck (SWBS 130) at y = 0, one thin plate too thin for the rule (6 mm instead of 8) at the bow.
  for (let x = -L / 2; x < L / 2; x += CELL_MM) for (let z = -W / 2; z < W / 2; z += CELL_MM) {
    const thin = x >= L / 2 - CELL_MM && z < 0;
    add('context', `Deck plate ${x}/${z}`, [x + 10, -T, z + 10], [x + CELL_MM - 10, 0, z + CELL_MM - 10], plate('130', thin ? 6 : 8));
  }
  // Hatches on the main deck (checked parts): three pass (24" x 36" >= 600 mm), one fails (20" x 24").
  const hatch = (x, z, w, l) => add('checked', `HATCH ${w}"X${l}"`, [x - w * 12.7, 0, z - l * 12.7], [x + w * 12.7, 300, z + l * 12.7],
    { group: 'Item', sourceFile: 'DECK.dwg', opening: { kind: 'rect', w_mm: Math.min(w, l) * 25.4, l_mm: Math.max(w, l) * 25.4, w_in: Math.min(w, l), l_in: Math.max(w, l), raw: `${w}"X${l}"` } });
  const hatches = [hatch(-20000, 2500, 24, 36), hatch(-5000, -2500, 24, 36), hatch(10000, 2500, 30, 30), hatch(22000, -2500, 20, 24)];
  // Glazing on the deckhouse: 20 % opacity in the source model (drawn see-through, still clickable).
  const glass = add('checked', 'Wheelhouse window', [-12000, 800, W / 2 - 60], [-9000, 2300, W / 2], plate('150', 10), 51);
  // Rest of the model (no rule): equipment boxes, one of them an envelope at 4 % opacity (not clickable).
  const rest = [];
  for (let i = 0; i < 6; i++) rest.push(add('rest', `Equipment ${i + 1}`, [-25000 + i * 9000, 200, -1500], [-23500 + i * 9000, 1700, 1500], null));
  const envelope = add('rest', 'Crane envelope', [15000, 300, -4000], [21000, 5000, 4000], null, 10);
  return { parts, hatches, glass, rest, envelope, bounds: { min: [-L / 2, -H / 2, -W / 2], max: [L / 2, H / 2, W / 2] } };
}

export function encode(streams) {
  const packedParts = [], bufferViews = [];
  let compressedOffset = 0, decodedOffset = 0;
  for (const st of streams) {
    const packed = MeshoptEncoder.encodeGltfBuffer(st.data, st.count, st.stride, st.mode);
    const check = new Uint8Array(st.count * st.stride);
    MeshoptDecoder.decodeGltfBuffer(check, st.count, st.stride, packed, st.mode);
    if (st.mode !== 'TRIANGLES' && Buffer.compare(Buffer.from(check), Buffer.from(st.data.buffer, st.data.byteOffset, st.data.byteLength)) !== 0) throw new Error('round trip differs');
    bufferViews.push({ buffer: 1, byteOffset: decodedOffset, byteLength: st.data.byteLength, ...(st.target === 34962 ? { byteStride: st.stride } : {}), target: st.target,
      extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: compressedOffset, byteLength: packed.length, byteStride: st.stride, count: st.count, mode: st.mode } } });
    packedParts.push(packed);
    compressedOffset += align(packed.length);
    decodedOffset += align(st.data.byteLength);
  }
  const body = new Uint8Array(compressedOffset);
  let o = 0; for (const p of packedParts) { body.set(p, o); o += align(p.length); }
  return { body, bufferViews, decodedOffset };
}

// One tile from a list of parts: hp layout (float32 positions relative to the tile origin) or 16-bit layout.
function tile(name, group, members, { quantized = false } = {}) {
  const P = [], N = [], I = [], O = [], D = [];
  const dbs = new Set();
  for (const part of members) {
    const g = box(part.box[0], part.box[1]);
    const base = P.length / 3;
    P.push(...g.pos); N.push(...g.nrm); I.push(...g.idx.map((i) => i + base));
    for (let v = 0; v < g.pos.length / 3; v++) { O.push(part.opacity); D.push(part.dbId); }
    dbs.add(part.dbId);
  }
  const nv = P.length / 3, nt = I.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], P[3 * v + k]); max[k] = Math.max(max[k], P[3 * v + k]); }
  const fcol = new Uint8Array(nv * 4);
  for (let v = 0; v < nv; v++) { const d = D[v]; fcol[4 * v] = d & 255; fcol[4 * v + 1] = (d >>> 8) & 255; fcol[4 * v + 2] = (d >>> 16) & 255; fcol[4 * v + 3] = (d >>> 24) & 255; }
  const findex = nv < 65536 ? new Uint16Array(I) : new Uint32Array(I);
  let json, body, resident;
  if (!quantized) {
    const origin = [0, 1, 2].map((k) => Math.round((min[k] + max[k]) / 2));
    const fpos = new Float32Array(nv * 3), fnrm = new Int8Array(nv * 4);
    for (let v = 0; v < nv; v++) {
      for (let k = 0; k < 3; k++) { fpos[3 * v + k] = P[3 * v + k] - origin[k]; fnrm[4 * v + k] = Math.round(N[3 * v + k] * 127); }
      fnrm[4 * v + 3] = O[v] > 127 ? O[v] - 256 : O[v];
    }
    const lmin = [0, 1, 2].map((k) => min[k] - origin[k]), lmax = [0, 1, 2].map((k) => max[k] - origin[k]);
    const enc = encode([
      { data: new Uint8Array(fpos.buffer), count: nv, stride: 12, mode: 'ATTRIBUTES', target: 34962 },
      { data: new Uint8Array(fnrm.buffer), count: nv, stride: 4, mode: 'ATTRIBUTES', target: 34962 },
      { data: fcol, count: nv, stride: 4, mode: 'ATTRIBUTES', target: 34962 },
      { data: new Uint8Array(findex.buffer), count: nt * 3, stride: findex.BYTES_PER_ELEMENT, mode: 'TRIANGLES', target: 34963 },
    ]);
    body = enc.body;
    json = {
      asset: { version: '2.0', generator: 'ShipCheck synthetic-model.mjs (hp layout)' },
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
    resident = enc.decodedOffset + nv * 4 + nt * 12;
  } else {
    // 16-bit layout of the first export: normalized uint16 positions, node scale + translation (KHR_mesh_quantization).
    const span = [0, 1, 2].map((k) => Math.max(max[k] - min[k], 1));
    const qpos = new Uint16Array(nv * 4), fnrm = new Int8Array(nv * 4);
    for (let v = 0; v < nv; v++) {
      for (let k = 0; k < 3; k++) { qpos[4 * v + k] = Math.round((P[3 * v + k] - min[k]) / span[k] * 65535); fnrm[4 * v + k] = Math.round(N[3 * v + k] * 127); }
    }
    const enc = encode([
      { data: new Uint8Array(qpos.buffer), count: nv, stride: 8, mode: 'ATTRIBUTES', target: 34962 },
      { data: new Uint8Array(fnrm.buffer), count: nv, stride: 4, mode: 'ATTRIBUTES', target: 34962 },
      { data: fcol, count: nv, stride: 4, mode: 'ATTRIBUTES', target: 34962 },
      { data: new Uint8Array(findex.buffer), count: nt * 3, stride: findex.BYTES_PER_ELEMENT, mode: 'TRIANGLES', target: 34963 },
    ]);
    body = enc.body;
    json = {
      asset: { version: '2.0', generator: 'ShipCheck synthetic-model.mjs (16-bit layout)' },
      extensionsUsed: ['EXT_meshopt_compression', 'KHR_mesh_quantization'], extensionsRequired: ['EXT_meshopt_compression', 'KHR_mesh_quantization'],
      scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0, translation: min, scale: span.map((s) => s / 65535) }],
      materials: [{ name: 'part', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.82, 0.85, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
      meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
      accessors: [
        { bufferView: 0, componentType: 5123, normalized: true, count: nv, type: 'VEC3', min: [0, 0, 0], max: [65535, 65535, 65535] },
        { bufferView: 1, componentType: 5120, normalized: true, count: nv, type: 'VEC3' },
        { bufferView: 2, componentType: 5121, normalized: true, count: nv, type: 'VEC4' },
        { bufferView: 3, componentType: findex.BYTES_PER_ELEMENT === 2 ? 5123 : 5125, count: nt * 3, type: 'SCALAR' },
      ],
      bufferViews: enc.bufferViews,
      buffers: [{ byteLength: enc.body.length }, { byteLength: enc.decodedOffset, extensions: { EXT_meshopt_compression: { fallback: true } } }],
    };
    resident = enc.decodedOffset + nv * 4 + nt * 12;
  }
  const glb = writeGlb(json, body);
  const hash = crypto.createHash('sha256').update(glb).digest('hex').slice(0, 12);
  return { glb, entry: { name, file: `${name}-${hash}.glb`, group, source_chunk: group, bytes: glb.length, decoded_bytes: resident, resident_bytes: resident, vertices: nv, triangles: nt, parts: dbs.size, dbIds: [...dbs], bounds_mm: { min, max } } };
}

export async function writeSyntheticModel(outDir) {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  const dir = path.join(outDir, 'stream-hp');
  fs.mkdirSync(dir, { recursive: true });
  const { parts, hatches, glass, rest, envelope, bounds } = buildParts();
  const cellOf = (p) => [0, 1, 2].map((k) => Math.floor((p.box[0][k] + p.box[1][k]) / 2 / CELL_MM)).join('_');
  const groups = new Map();
  for (const p of parts) {
    const key = `${p.group}-${cellOf(p)}`;
    if (!groups.has(key)) groups.set(key, { group: p.group, members: [] });
    groups.get(key).members.push(p);
  }
  const chunks = [];
  const opacityByDb = {};
  for (const [key, { group, members }] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const quantized = group === 'rest';
    const t = tile(`${key}-0`, group, members, { quantized });
    fs.writeFileSync(path.join(dir, t.entry.file), t.glb);
    chunks.push(t.entry);
    if (quantized) for (const m of members) if (m.opacity < 255) opacityByDb[m.dbId] = m.opacity;
  }
  const manifest = {
    version: 3, kind: 'viewport-tiles', precision: 'synthetic test model: float32 positions per tile (hp layout) and 16-bit rest tiles',
    opacity_by_dbid: opacityByDb,
    units: 'mm', coordinate_system: 'glTF, Y up', offset_mm: [0, 0, 0],
    deck_levels: [{ id: 0, height: 0, name: 'Main deck (+0.0 m)' }],
    chunks,
    sources: [{ group: 'synthetic', triangles: chunks.reduce((s, c) => s + c.triangles, 0) }],
    integrity: { triangles: chunks.reduce((s, c) => s + c.triangles, 0) },
    streaming: { detail_span_mm: 24000, max_resident_bytes: 512000000, max_detail_triangles: 1500000, max_requests: 2, min_detail_screen_px: 56, detail_keep_ratio: 0.6 },
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify({ pass: true, generated: new Date().toISOString(), note: 'synthetic test model' }));
  // Catalogs the app reads from the database API: a stub server can serve these as-is.
  const catalog = {
    scenarios: { scenarios: [{ id: 'rcrv-3d', name: 'Synthetic research vessel (test model)', kind: 'parts', viewer: 'local', model: 'ships/rcrv/parts.json', meta: 'ships/rcrv/rcrv-3d.meta.json', expected: null, precomputed: null }] },
    rules: { rules: [
      { id: 'TEST-PLATE-MIN', source: 'test rule set', clause: 'A.1', text: 'Hull and deck plating is at least 8 mm thick.', check: 'min', parameter: 'thickness', value: 8, unit: 'mm', verified: false, applies_to: { types: ['plate'], where: { swbs_group: { prefix: '1' } } } },
      { id: 'TEST-HATCH-OPENING', source: 'test rule set', clause: 'B.2', text: 'Hatch clear opening is at least 600 mm on the smaller side.', check: 'min', parameter: 'clear_opening_min_side', value: 600, unit: 'mm', verified: false, applies_to: { types: ['hatch'] } },
    ] },
    'model-rcrv-parts': { name: 'Synthetic ship (parts)', source: { file: 'synthetic.nwd', model_unit: 'mm' }, counts: { objects: parts.length, kept: parts.filter((p) => p.catalog).length }, parts: parts.filter((p) => p.catalog).map((p) => p.catalog) },
    'model-rcrv-meta': { name: 'Synthetic research vessel', ship: { type: { value: 'research vessel', source: 'test' }, length_overall: { value: 60, unit: 'm', source: 'test' } } },
    'regulation-links': { database: 'none', loaded_instruments: 'none', method: 'none', rules: {} },
  };
  fs.writeFileSync(path.join(outDir, 'catalog.json'), JSON.stringify(catalog));
  return { manifest, catalog, hatches, glass, rest, envelope, bounds, parts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || 'work/synthetic-model');
  const { manifest } = await writeSyntheticModel(out);
  console.log(`${manifest.chunks.length} tiles, ${(manifest.chunks.reduce((s, c) => s + c.bytes, 0) / 1e3).toFixed(0)} KB -> ${out}`);
}
