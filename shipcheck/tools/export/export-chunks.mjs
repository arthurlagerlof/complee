// One-time export: RCRV model (Autodesk SVF derivative) -> glTF chunks for ShipCheck's local viewer.
// Usage (from shipcheck/tools/export, after request-svf.mjs):
//   node --max-old-space-size=12288 export-chunks.mjs
// The rest of the model (parts no rule looks at) comes from export-rest.mjs, in sub-chunks.
// Output: shipcheck/model/<chunk>.glb + shipcheck/model/manifest.json (gitignored; deployed with deploy.sh/.ps1)
//
// Each chunk is ONE merged triangle mesh (one draw call in the browser) with:
//   POSITION  mm, glTF frame (Y up): x = model left, y = model up, z = model front, minus manifest.offset_mm
//   NORMAL
//   COLOR_0   RGBA bytes = 32-bit little-endian dbId: the dbId of the checked part (= parts.json objectid) the
//             geometry belongs to; geometry not under a checked part keeps its own node dbId
// Geometry is the model's own (only transformed, merged and compressed); nothing is generated.
// Chunks are chosen from parts.json (SWBS group, type, source file, system) and the checker results.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readKeys, token, manifest as getManifest, svfDerivative, SVF_URN_FILE } from './request-svf.mjs';
import { partsToModel } from '../../src/parts-model.mjs';
import { checkModel } from '../../src/checker.mjs';
import { loadIdMap } from './map-ids.mjs';
import { readTree } from './read-tree.mjs';

const require = createRequire(import.meta.url);
const { SVFReader, SVFDownloader, TwoLeggedAuthenticationProvider } = require('svf-utils');
const IMF = require('svf-utils/lib/common/intermediate-format');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SC = path.resolve(HERE, '../..');
const WORK = path.join(HERE, 'work');
const OUT = path.join(SC, 'model');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(SC, p), 'utf8'));
const log = (...a) => console.log(...a);

// ---------- chunks (load order = array order) ----------
// No simplification: gltfpack's error limit is relative to the whole merged chunk (~60 m), so even 0.2 % let it
// remove triangles from plates and left gaps in the hull. Compression alone keeps the chunks small.
const CHUNKS = [
  { name: 'context', title: 'Outer hull plating (SWBS 110) and decks (SWBS 130)', load: 'first' },
  { name: 'openings', title: 'Hatches, manholes and doors', load: 'eager' },
  { name: 'structure-findings', title: 'Hull structure with findings', load: 'eager' },
  { name: 'piping', title: 'Oil fuel piping and items with a design status', load: 'eager' },
  { name: 'access', title: 'Stairs and ladders', load: 'eager' },
  { name: 'structure', title: 'Other hull structure (SWBS 1xx)', load: 'eager' },
];
// Everything else ('rest': every part no rule looks at) is built separately, in sub-chunks, by export-rest.mjs.

export function chunkOf(el, worst) {
  const g = el.props?.swbs_group?.value, src = el.source || '';
  if (['110', '130'].includes(g) && el.type !== 'hatch' && el.type !== 'manhole' && el.type !== 'door') return 'context';
  if (['hatch', 'manhole', 'door'].includes(el.type)) return 'openings';
  if (/STAIR|LDR|LADDER/i.test(src) || /STAIR|LADDER/i.test(el.name)) return 'access';
  if (el.type === 'pipe' || el.type === 'system_item') return worst ? 'piping' : 'rest';
  if (String(g ?? '').startsWith('1') && (worst === 'non_compliant' || worst === 'not_enough_info')) return 'structure-findings';
  // All hull structure (SWBS 1xx) is loaded, also parts no rule applies to (e.g. the aluminium deckhouse):
  // it is the ship's shape, and the deck cut finds the deck levels from it.
  if (worst || String(g ?? '').startsWith('1')) return 'structure';
  return 'rest';
}

// ---------- growable buffers ----------
export class Grow {
  constructor(Type, n = 1 << 20) { this.Type = Type; this.a = new Type(n); this.len = 0; }
  reserve(k) {
    if (this.len + k <= this.a.length) return;
    let n = this.a.length * 2; while (n < this.len + k) n *= 2;
    const b = new this.Type(n); b.set(this.a.subarray(0, this.len)); this.a = b;
  }
  view() { return this.a.subarray(0, this.len); }
}

export function matrixOf(t) {
  if (!t) return null;
  if (t.kind === IMF.TransformKind.Matrix) return t.elements; // column-major 4x4
  const q = t.rotation || { x: 0, y: 0, z: 0, w: 1 }, s = t.scale || { x: 1, y: 1, z: 1 }, p = t.translation || { x: 0, y: 0, z: 0 };
  const { x, y, z, w } = q;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return [
    (1 - 2 * (yy + zz)) * s.x, 2 * (xy + wz) * s.x, 2 * (xz - wy) * s.x, 0,
    2 * (xy - wz) * s.y, (1 - 2 * (xx + zz)) * s.y, 2 * (yz + wx) * s.y, 0,
    2 * (xz + wy) * s.z, 2 * (yz - wx) * s.z, (1 - 2 * (xx + yy)) * s.z, 0,
    p.x, p.y, p.z, 1,
  ];
}

export async function ensureSvf() {
  if (!fs.existsSync(SVF_URN_FILE)) throw new Error('No SVF copy yet: run node request-svf.mjs first');
  const urn = fs.readFileSync(SVF_URN_FILE, 'utf8').trim();
  const tok = await token('data:read viewables:read');
  const svf = svfDerivative(await getManifest(tok, urn));
  if (svf?.status !== 'success') throw new Error('No finished SVF derivative yet: run node request-svf.mjs first');
  const dir = path.join(WORK, 'svf');
  const find = (d) => { if (!fs.existsSync(d)) return null; for (const f of fs.readdirSync(d, { recursive: true })) if (String(f).endsWith('output.svf')) return path.join(d, String(f)); return null; };
  let file = find(dir);
  if (!file) {
    log('Downloading the SVF derivative (one time)…');
    const { APS_CLIENT_ID, APS_CLIENT_SECRET } = readKeys();
    await new SVFDownloader(new TwoLeggedAuthenticationProvider(APS_CLIENT_ID, APS_CLIENT_SECRET)).download(urn, { outputDir: dir, log: () => {}, region: 'US' });
    file = find(dir);
  }
  if (!file) throw new Error('SVF download produced no output.svf');
  return file;
}

// Parts, checker results, and leaf node -> checked part (geometry often sits on child nodes).
export async function mapParts() {
  const model = partsToModel(readJSON('ships/rcrv/parts.json'), readJSON('ships/rcrv/rcrv-3d.meta.json'));
  const results = checkModel(model, readJSON('rules.json').rules);
  const tree = await readTree(path.join(SC, '3D_Since_AI/model-tree.json'));
  const nodeById = new Map();
  (function walk(nodes) { for (const n of nodes || []) { nodeById.set(n.objectid, n); walk(n.objects); } })(tree.data.objects);
  const partOfLeaf = new Map(), chunkOfPart = new Map();
  for (const el of model.elements) {
    const chunk = chunkOf(el, results.elements[el.id]?.worst);
    chunkOfPart.set(el.objectid, chunk);
    const stack = [nodeById.get(el.objectid)];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      if (!partOfLeaf.has(n.objectid)) partOfLeaf.set(n.objectid, el.objectid);
      for (const c of n.objects || []) stack.push(c);
    }
  }
  log(`Parts: ${model.elements.length.toLocaleString('en')}; nodes mapped to a checked part: ${partOfLeaf.size.toLocaleString('en')}`);
  return { model, results, nodeById, partOfLeaf, chunkOfPart, resolve: makeResolver(partOfLeaf) };
}

// The SVF copy numbers its nodes differently from the APS model (SVF2), which parts.json and model-properties.json
// use. resolve(svfNodeId) -> { part, own, near }:
//   own  = the node's own SVF2 objectid (null if map-ids.mjs could not match the node)
//   near = SVF2 objectid of the nearest matched node (the node itself or its closest matched ancestor)
//   part = the parts.json objectid that node belongs to (null: no checked part)
export function makeResolver(partOfLeaf) {
  const { toSvf2, parent } = loadIdMap();
  const cache = new Map();
  return (svfId) => {
    let r = cache.get(svfId);
    if (r) return r;
    let near = null;
    for (let a = svfId, guard = 0; a && guard < 64; a = parent[a], guard++) if (toSvf2[a]) { near = toSvf2[a]; break; }
    r = { own: toSvf2[svfId] || null, near, part: near != null ? partOfLeaf.get(near) ?? null : null };
    cache.set(svfId, r);
    return r;
  };
}

// Reads the SVF and returns the scene plus the output frame (mm, glTF Y up, centred on the model's bounding box).
export async function openScene() {
  const svfFile = await ensureSvf();
  log('Reading the SVF into memory…');
  const reader = await SVFReader.FromFileSystem(svfFile);
  const scene = await reader.read({ log: () => {} });
  const meta = scene.getMetadata();
  const unit = meta['distance unit']?.value || 'inch';
  const scaleMM = { inch: 25.4, in: 25.4, foot: 304.8, ft: 304.8, meter: 1000, m: 1000, centimeter: 10, cm: 10, millimeter: 1, mm: 1 }[unit] ?? 25.4;
  const up = meta['world up vector']?.XYZ || [0, 0, 1];
  const front = meta['world front vector']?.XYZ || [0, -1, 0];
  const left = [up[1] * front[2] - up[2] * front[1], up[2] * front[0] - up[0] * front[2], up[0] * front[1] - up[1] * front[0]];
  const bb = meta['world bounding box'];
  const c = bb ? [0, 1, 2].map((i) => (bb.minXYZ[i] + bb.maxXYZ[i]) / 2) : [0, 0, 0];
  const toOut = (x, y, z) => [left[0] * x + left[1] * y + left[2] * z, up[0] * x + up[1] * y + up[2] * z, front[0] * x + front[1] * y + front[2] * z];
  const offset = toOut(...c).map((v) => v * scaleMM);
  log(`Unit: ${unit} (x ${scaleMM} -> mm); up ${up.join(',')}; front ${front.join(',')}`);
  return { scene, unit, scaleMM, toOut, offset };
}

export const newBuffer = () => ({
  pos: new Grow(Float32Array), nrm: new Grow(Float32Array), id: new Grow(Uint8Array), idx: new Grow(Uint32Array),
  verts: 0, parts: new Set(), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity],
});

// Appends one SVF mesh fragment (transformed to the output frame) with its dbId to a chunk buffer.
// Returns the vertex base of the fragment in the buffer.
export function appendFragment(b, node, geom, dbid, frame) {
  const { toOut, scaleMM, offset } = frame;
  const V = geom.getVertices(), I = geom.getIndices(), N = geom.getNormals?.();
  b.parts.add(dbid);
  const M = matrixOf(node.transform);
  const nv = V.length / 3;
  b.pos.reserve(nv * 3); b.nrm.reserve(nv * 3); b.id.reserve(nv * 4); b.idx.reserve(I.length);
  const base = b.verts;
  for (let v = 0; v < nv; v++) {
    let x = V[3 * v], y = V[3 * v + 1], z = V[3 * v + 2];
    if (M) { const X = M[0] * x + M[4] * y + M[8] * z + M[12], Y = M[1] * x + M[5] * y + M[9] * z + M[13], Z = M[2] * x + M[6] * y + M[10] * z + M[14]; x = X; y = Y; z = Z; }
    const o = toOut(x, y, z);
    for (let k = 0; k < 3; k++) {
      const val = o[k] * scaleMM - offset[k];
      b.pos.a[b.pos.len++] = val;
      if (val < b.min[k]) b.min[k] = val;
      if (val > b.max[k]) b.max[k] = val;
    }
    let nx = 0, ny = 0, nz = 1;
    if (N?.length) {
      nx = N[3 * v]; ny = N[3 * v + 1]; nz = N[3 * v + 2];
      if (M) { const X = M[0] * nx + M[4] * ny + M[8] * nz, Y = M[1] * nx + M[5] * ny + M[9] * nz, Z = M[2] * nx + M[6] * ny + M[10] * nz; nx = X; ny = Y; nz = Z; }
    }
    const on = toOut(nx, ny, nz), l = Math.hypot(...on) || 1;
    b.nrm.a[b.nrm.len++] = on[0] / l; b.nrm.a[b.nrm.len++] = on[1] / l; b.nrm.a[b.nrm.len++] = on[2] / l;
    b.id.a[b.id.len++] = dbid & 255; b.id.a[b.id.len++] = (dbid >>> 8) & 255; b.id.a[b.id.len++] = (dbid >>> 16) & 255; b.id.a[b.id.len++] = (dbid >>> 24) & 255;
  }
  for (let k = 0; k < I.length; k++) b.idx.a[b.idx.len++] = base + I[k];
  b.verts += nv;
  return base;
}

const GLTFPACK = path.join(HERE, 'node_modules', '.bin', process.platform === 'win32' ? 'gltfpack.cmd' : 'gltfpack');
export const freeBytes = (dir) => { const s = fs.statfsSync(dir); return s.bavail * s.bsize; };

// Writes a chunk buffer as raw glTF (temporary) and compresses it with gltfpack into <outDir>/<name>.glb.
// Returns { bytes, raw_bytes, triangles } or null when the disk is too full for the temporary file.
export function packChunk(name, b, outDir, { minFree = 0 } = {}) {
  const rawDir = path.join(WORK, 'raw');
  fs.mkdirSync(rawDir, { recursive: true });
  const pos = b.pos.view(), nrm = b.nrm.view(), ids = b.id.view(), idx = b.idx.view();
  const parts = [pos, nrm, ids, idx].map((a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength));
  const offs = []; let off = 0;
  for (const p of parts) { offs.push(off); off += p.length + ((4 - (p.length % 4)) % 4); }
  const bin = Buffer.alloc(off);
  parts.forEach((p, i) => p.copy(bin, offs[i]));
  const binName = `${name}.bin`;
  // Disk space: the raw file is temporary (deleted after gltfpack); skip a chunk that would not fit.
  const free = freeBytes(rawDir);
  if (bin.length * 1.2 + 50e6 + minFree > free) {
    log(`  ${name}: SKIPPED, not enough free disk space including the reserved minimum (needs about ${Math.round(bin.length * 1.5 / 1e6)} MB, free ${Math.round(free / 1e6)} MB)`);
    return null;
  }
  fs.writeFileSync(path.join(rawDir, binName), bin);
  const gltf = {
    asset: { version: '2.0', generator: 'ShipCheck export-chunks.mjs (svf-utils reader)' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name, mesh: 0 }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ name: 'part', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.82, 0.85, 1], metallicFactor: 0, roughnessFactor: 0.8 } }],
    buffers: [{ uri: binName, byteLength: bin.length }],
    bufferViews: parts.map((p, i) => ({ buffer: 0, byteOffset: offs[i], byteLength: p.length, ...(i < 3 ? { target: 34962 } : { target: 34963 }) })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: b.verts, type: 'VEC3', min: b.min, max: b.max },
      { bufferView: 1, componentType: 5126, count: b.verts, type: 'VEC3' },
      { bufferView: 2, componentType: 5121, normalized: true, count: b.verts, type: 'VEC4' },
      { bufferView: 3, componentType: 5125, count: idx.length, type: 'SCALAR' },
    ],
  };
  const raw = path.join(rawDir, `${name}.gltf`);
  fs.writeFileSync(raw, JSON.stringify(gltf));
  const glb = path.join(outDir, `${name}.glb`);
  // -cc meshopt compression (+ quantization), -kv keep COLOR_0 (dbIds), -vp 16 positions to ~1 mm, -vc 8 keeps the id bytes exact.
  // No -si: nothing is simplified.
  try {
    execFileSync(GLTFPACK, ['-i', raw, '-o', glb, '-cc', '-kv', '-vp', '16', '-vc', '8'], { stdio: 'pipe', shell: process.platform === 'win32' });
  } finally {
    fs.rmSync(raw, { force: true }); fs.rmSync(path.join(rawDir, binName), { force: true }); // temporary files
  }
  return { bytes: fs.statSync(glb).size, raw_bytes: bin.length, triangles: idx.length / 3 };
}

async function main() {
  const t0 = Date.now();
  fs.mkdirSync(WORK, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { chunkOfPart, resolve } = await mapParts();
  const frame = await openScene();
  const { scene, unit, offset } = frame;

  const buf = Object.fromEntries(CHUNKS.map((ch) => [ch.name, newBuffer()]));

  // Deck levels from the geometry: area of horizontal triangles of the hull structure per 100 mm of height.
  const DECK_CHUNKS = new Set(['context', 'structure', 'structure-findings']);
  const horiz = new Map();
  let frags = 0, skipped = 0;
  for (let i = 0, n = scene.getNodeCount(); i < n; i++) {
    const node = scene.getNode(i);
    if (node.kind !== IMF.NodeKind.Object) continue;
    const geom = scene.getGeometry(node.geometry);
    if (geom.kind !== IMF.GeometryKind.Mesh) { skipped++; continue; }
    const V = geom.getVertices(), I = geom.getIndices();
    if (!V?.length || !I?.length) { skipped++; continue; }
    const { part } = resolve(node.dbid); // SVF node -> checked part (parts.json objectid = APS dbId)
    if (part == null) continue; // not a checked part: built by export-rest.mjs
    const dbid = part;
    const chunk = chunkOfPart.get(part);
    const b = buf[chunk];
    if (!b) continue; // chunk not built (the rest is built with export-rest.mjs)
    const base = appendFragment(b, node, geom, dbid, frame);
    if (DECK_CHUNKS.has(chunk)) {
      const P = b.pos.a;
      for (let k = 0; k + 2 < I.length; k += 3) {
        const a3 = (base + I[k]) * 3, b3 = (base + I[k + 1]) * 3, c3 = (base + I[k + 2]) * 3;
        const ux = P[b3] - P[a3], uy = P[b3 + 1] - P[a3 + 1], uz = P[b3 + 2] - P[a3 + 2];
        const vx = P[c3] - P[a3], vy = P[c3 + 1] - P[a3 + 1], vz = P[c3 + 2] - P[a3 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (!len || Math.abs(ny) / len < 0.98) continue;
        const bin = Math.round((P[a3 + 1] + P[b3 + 1] + P[c3 + 1]) / 3 / 100);
        horiz.set(bin, (horiz.get(bin) || 0) + len / 2 / 1e6); // m2
      }
    }
    frags++;
  }
  log(`Fragments merged: ${frags.toLocaleString('en')} (skipped ${skipped.toLocaleString('en')} lines/points/empty)`);

  // ---------- write raw glTF, then compress with gltfpack ----------
  const out = [];
  for (const ch of CHUNKS) {
    const b = buf[ch.name];
    if (!b.verts) { log(`  ${ch.name}: empty, skipped`); continue; }
    const packed = packChunk(ch.name, b, OUT);
    if (!packed) { buf[ch.name] = null; continue; }
    const glb = path.join(OUT, `${ch.name}.glb`);
    const bin = { length: packed.raw_bytes }, idx = { length: packed.triangles * 3 };
    out.push({
      name: ch.name, file: `${ch.name}.glb`, title: ch.title, load: ch.load, simplified: ch.simplify ? `gltfpack -si ${ch.simplify}` : null,
      bytes: fs.statSync(glb).size, raw_bytes: bin.length, vertices: b.verts, triangles: idx.length / 3,
      parts: b.parts.size, dbIds: [...b.parts].sort((x, y) => x - y),
      bounds_mm: { min: b.min.map(Math.round), max: b.max.map(Math.round) },
    });
    buf[ch.name] = null; // free memory
    log(`  ${ch.name}: ${(fs.statSync(glb).size / 1e6).toFixed(1)} MB (raw ${(bin.length / 1e6).toFixed(1)} MB), ${b.parts.size.toLocaleString('en')} parts, ${(idx.length / 3).toLocaleString('en')} triangles`);
  }

  // Peaks: bins with much more horizontal area than their neighbourhood; neighbours within 600 mm merged.
  const binsSorted = [...horiz].sort((a, b) => a[0] - b[0]);
  const totalH = binsSorted.reduce((t, [, v]) => t + v, 0);
  const near = (k, r) => binsSorted.filter(([b]) => Math.abs(b - k) <= r).reduce((t, [, v]) => t + v, 0);
  let peaks = binsSorted.filter(([k, v]) => v >= totalH * 0.03 && v >= near(k, 3) * 0.5)
    .map(([k]) => ({ k, area: near(k, 1) }));
  const merged = [];
  for (const p of peaks) { const last = merged.at(-1); if (last && p.k - last.k <= 6) { if (p.area > last.area) Object.assign(last, p); } else merged.push({ ...p }); }
  const base0 = merged.length ? merged[0].k : 0;
  const deckLevels = merged.map((p, i) => ({ id: i, height: p.k * 100, area_m2: Math.round(p.area),
    name: `Deck level ${i + 1} (+${((p.k - base0) / 10).toFixed(1)} m, ${Math.round(p.area)} m² deck area)` }));
  log(`Deck levels: ${deckLevels.map((d) => d.name).join('; ') || 'none found'}`);

  const manifestOut = {
    version: 1,
    generated: new Date().toISOString(),
    model: 'OSU RCRV (ShipConstructor), SVF derivative of the APS model',
    units: 'mm',
    source_unit: unit,
    coordinate_system: 'glTF, Y up: x = model left, y = model up (world up vector), z = model front; position = model coordinate (inch) x 25.4 - offset_mm',
    offset_mm: offset.map((v) => Math.round(v * 1000) / 1000),
    deck_levels: deckLevels,
    deck_levels_note: 'Heights (y, mm, same frame as the chunks) where the hull structure has the most horizontal triangle area.',
    dbid_encoding: 'COLOR_0 RGBA bytes = little-endian 32-bit dbId of the checked part (parts.json objectid = APS model dbId); SVF copy node ids are translated with tools/export/map-ids.mjs',
    chunks: [...out, ...keepRest()],
  };
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifestOut));
  log(`\nWrote ${path.relative(SC, OUT)}/manifest.json in ${Math.round((Date.now() - t0) / 1000)} s\n`);
  log('chunk               MB     raw MB   parts     triangles  load');
  for (const c of out) log(`${c.name.padEnd(19)} ${(c.bytes / 1e6).toFixed(1).padStart(6)} ${(c.raw_bytes / 1e6).toFixed(1).padStart(8)} ${String(c.parts).padStart(7)} ${String(c.triangles).padStart(13)}  ${c.load}`);
  const total = out.reduce((s, c) => s + c.bytes, 0), eager = out.filter((c) => c.load !== 'on-demand').reduce((s, c) => s + c.bytes, 0);
  log(`total ${(total / 1e6).toFixed(1)} MB; loaded by default (without rest) ${(eager / 1e6).toFixed(1)} MB`);
}

// Rest sub-chunks (rest-01.glb …, built by export-rest.mjs) stay in the manifest when the main chunks are re-exported.
function keepRest() {
  try { return JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')).chunks.filter((c) => c.group === 'rest'); } catch { return []; }
}

export { OUT, WORK, SC, HERE, readJSON, log };

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
