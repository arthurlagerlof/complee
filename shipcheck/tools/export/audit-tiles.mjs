// Offline, exact detail-tile audit. Does not regenerate or change any input.
// node --expose-gc --max-old-space-size=4096 tools/export/audit-tiles.mjs
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import v8 from 'node:v8';
import { fileURLToPath } from 'node:url';
import { decodeGlb } from './tile-model.mjs';

const MODEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../model');
const EXPECTED_TRIANGLES = 50_839_715;
const digest = data => crypto.createHash('sha256').update(data).digest('hex');
const bytesPerComponent = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

// Hash tables only locate candidates. All collisions are resolved by comparing the
// complete decoded attribute records or the complete canonical triangle tuple.
// No equality decision is based on a hash or a probabilistic fingerprint.
function avalanche(x) {
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}
function triangleHash(a, b, c) {
  return avalanche(Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^
    Math.imul(b ^ 0xc2b2ae35, 0x27d4eb2d) ^ Math.imul(c, 0x165667b1));
}
function capacity(count) {
  let n = 4;
  while (n < count / 0.65) n *= 2;
  if (n > 0x40000000) throw Error('Input exceeds bounded hash-table implementation');
  return n;
}
// Lexicographically smallest CYCLIC rotation; reversed winding is not equivalent.
function rotation(a, b, c) {
  if (b <= a && b <= c && (b < a || c < b)) return 1;
  if (c <= a && c <= b && (c < a || a < b)) return 2;
  return 0;
}
function increment(map, id) { map.set(id, (map.get(id) || 0) + 1); }
function countIds(map, a, b, c) {
  increment(map, a);
  if (b !== a) increment(map, b);
  if (c !== a && c !== b) increment(map, c);
}

function meshLayout({ json: j, views }) {
  assert.equal(j.nodes?.length, 1, 'Expected one static node');
  assert.equal(j.meshes?.length, 1, 'Expected one mesh');
  assert.equal(j.meshes[0].primitives.length, 1, 'Expected one primitive');
  assert.ok(!j.animations && !j.skins, 'Animated/skinned input is unsupported');
  const p = j.meshes[0].primitives[0];
  assert.equal(p.mode ?? 4, 4, 'Only triangle primitives are supported');
  assert.ok(!p.targets, 'Morph targets are unsupported');
  const attrs = Object.entries(p.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([name, ai]) => {
    const a = j.accessors[ai], view = j.bufferViews[a.bufferView];
    assert.ok(!a.sparse, 'Sparse attributes are unsupported');
    const width = bytesPerComponent[a.componentType] * components[a.type];
    assert.ok(Number.isInteger(width) && width > 0, `Unsupported attribute ${name}`);
    const stride = view.byteStride || width, offset = a.byteOffset || 0;
    assert.equal(stride % 4, 0, 'Audit requires complete, four-byte-aligned attribute records');
    assert.ok(offset + width <= stride, 'Attribute crosses its record boundary');
    const data = views[a.bufferView];
    assert.equal(data.byteLength, stride * a.count, 'Unexpected attribute buffer length');
    assert.equal(data.byteOffset % 4, 0, 'Unaligned decoded attribute buffer');
    const words = new Uint32Array(data.buffer, data.byteOffset, data.byteLength / 4);
    const { bufferView, count, min, max, ...schema } = a;
    return { name, count, stride: stride / 4, offset, words, data, schema: { ...schema, stride } };
  });
  const vertices = attrs[0]?.count;
  assert.ok(Number.isInteger(vertices) && vertices > 0, 'Empty attribute set');
  for (const a of attrs) assert.equal(a.count, vertices, 'Attribute vertex counts differ');
  assert.ok(attrs.some(a => a.name === 'POSITION') && attrs.some(a => a.name === 'NORMAL'), 'Missing position or normal');
  const color = attrs.find(a => a.name === 'COLOR_0');
  assert.equal(color?.schema.componentType, 5121, 'Expected exact four-byte dbIds');
  assert.equal(color.schema.type, 'VEC4', 'Expected exact four-byte dbIds');
  const ia = j.accessors[p.indices], iv = views[ia.bufferView];
  assert.equal(ia.componentType, 5125, 'Audit requires uint32 indices');
  assert.equal(ia.type, 'SCALAR');
  assert.ok(!ia.sparse && !ia.normalized, 'Unsupported index accessor');
  assert.equal(ia.count % 3, 0, 'Incomplete triangle');
  const indices = new Uint32Array(iv.buffer, iv.byteOffset + (ia.byteOffset || 0), ia.count);
  const { attributes, indices: unused, ...primitive } = p;
  return {
    json: j, attrs, vertices, indices, triangles: indices.length / 3,
    schema: attrs.map(a => ({ semantic: a.name, ...a.schema })),
    renderState: { nodes: j.nodes, scene: j.scene ?? 0, scenes: j.scenes, materials: j.materials, primitive,
      extensionsRequired: j.extensionsRequired, extensionsUsed: j.extensionsUsed },
    id(vertex) {
      const o = vertex * color.stride * 4 + color.offset, b = color.data;
      return (b[o] | b[o + 1] << 8 | b[o + 2] << 16 | b[o + 3] << 24) >>> 0;
    },
  };
}

function vertexHash(mesh, vertex) {
  let h = 0x811c9dc5;
  for (const a of mesh.attrs) {
    const start = vertex * a.stride;
    for (let k = 0; k < a.stride; k++) h = Math.imul(h ^ a.words[start + k], 0x01000193);
  }
  return avalanche(h);
}
function sameVertex(a, av, b, bv) {
  for (let n = 0; n < a.attrs.length; n++) {
    const x = a.attrs[n], y = b.attrs[n], xo = av * x.stride, yo = bv * y.stride;
    for (let k = 0; k < x.stride; k++) if (x.words[xo + k] !== y.words[yo + k]) return false;
  }
  return true;
}

export class ExactTileMatcher {
  constructor(decoded) {
    this.source = meshLayout(decoded);
    const s = this.source;
    this.vertexSlots = new Uint32Array(capacity(s.vertices));
    this.vertexMask = this.vertexSlots.length - 1;
    this.triangleSlots = new Uint32Array(capacity(s.triangles));
    this.triangleMask = this.triangleSlots.length - 1;
    this.remaining = new Uint32Array(s.triangles);
    this.sourceIds = new Map(); this.tileIds = new Map();
    this.matched = 0; this.uniqueVertices = 0; this.uniqueTriangles = 0;
    this.mixedIdTriangles = 0;
    const canonical = new Uint32Array(s.vertices);
    for (let v = 0; v < s.vertices; v++) {
      let slot = vertexHash(s, v) & this.vertexMask;
      while (this.vertexSlots[slot] && !sameVertex(s, v, s, this.vertexSlots[slot] - 1)) slot = (slot + 1) & this.vertexMask;
      if (!this.vertexSlots[slot]) { this.vertexSlots[slot] = v + 1; this.uniqueVertices++; }
      canonical[v] = this.vertexSlots[slot] - 1;
    }
    // Only the in-memory source index buffer is canonicalized. Source files are read-only.
    for (let t = 0; t < s.triangles; t++) {
      const o = t * 3;
      let a = s.indices[o], b = s.indices[o + 1], c = s.indices[o + 2];
      assert.ok(a < s.vertices && b < s.vertices && c < s.vertices, 'Source index out of bounds');
      a = canonical[a]; b = canonical[b]; c = canonical[c];
      const r = rotation(a, b, c);
      if (r === 1) [a, b, c] = [b, c, a]; else if (r === 2) [a, b, c] = [c, a, b];
      s.indices[o] = a; s.indices[o + 1] = b; s.indices[o + 2] = c;
      const ai = s.id(a), bi = s.id(b), ci = s.id(c);
      countIds(this.sourceIds, ai, bi, ci);
      if (ai !== bi || ai !== ci) this.mixedIdTriangles++;
      let slot = triangleHash(a, b, c) & this.triangleMask;
      while (this.triangleSlots[slot]) {
        const p = (this.triangleSlots[slot] - 1) * 3;
        if (s.indices[p] === a && s.indices[p + 1] === b && s.indices[p + 2] === c) break;
        slot = (slot + 1) & this.triangleMask;
      }
      if (!this.triangleSlots[slot]) { this.triangleSlots[slot] = t + 1; this.uniqueTriangles++; }
      this.remaining[this.triangleSlots[slot] - 1]++;
    }
  }
  addTile(decoded) {
    const tile = meshLayout(decoded), s = this.source;
    assert.deepEqual(tile.schema, s.schema, 'Attribute interpretation/layout changed');
    assert.deepEqual(tile.renderState, s.renderState, 'Node transform, scene, primitive or material changed');
    const canonical = new Uint32Array(tile.vertices), ids = new Set();
    for (let v = 0; v < tile.vertices; v++) {
      ids.add(tile.id(v));
      let slot = vertexHash(tile, v) & this.vertexMask;
      while (this.vertexSlots[slot] && !sameVertex(tile, v, s, this.vertexSlots[slot] - 1)) slot = (slot + 1) & this.vertexMask;
      assert.ok(this.vertexSlots[slot], `Tile vertex ${v} has attribute bytes absent from source`);
      canonical[v] = this.vertexSlots[slot] - 1;
    }
    for (let t = 0; t < tile.triangles; t++) {
      const o = t * 3;
      let a = tile.indices[o], b = tile.indices[o + 1], c = tile.indices[o + 2];
      assert.ok(a < tile.vertices && b < tile.vertices && c < tile.vertices, 'Tile index out of bounds');
      const ai = tile.id(a), bi = tile.id(b), ci = tile.id(c);
      countIds(this.tileIds, ai, bi, ci);
      a = canonical[a]; b = canonical[b]; c = canonical[c];
      const r = rotation(a, b, c);
      if (r === 1) [a, b, c] = [b, c, a]; else if (r === 2) [a, b, c] = [c, a, b];
      let slot = triangleHash(a, b, c) & this.triangleMask;
      while (this.triangleSlots[slot]) {
        const p = (this.triangleSlots[slot] - 1) * 3;
        if (s.indices[p] === a && s.indices[p + 1] === b && s.indices[p + 2] === c) break;
        slot = (slot + 1) & this.triangleMask;
      }
      assert.ok(this.triangleSlots[slot], `Tile triangle ${t} has connectivity/winding absent from source`);
      const representative = this.triangleSlots[slot] - 1;
      assert.ok(this.remaining[representative], `Tile triangle ${t} exceeds source duplicate multiplicity`);
      this.remaining[representative]--; this.matched++;
    }
    return { triangles: tile.triangles, vertices: tile.vertices, dbIds: [...ids].sort((a, b) => a - b) };
  }
  finish() {
    let missing = 0;
    for (const n of this.remaining) missing += n;
    const counts = [...new Set([...this.sourceIds.keys(), ...this.tileIds.keys()])].sort((a, b) => a - b)
      .map(id => [id, this.sourceIds.get(id) || 0, this.tileIds.get(id) || 0]);
    const mismatches = counts.filter(([, a, b]) => a !== b);
    return { passed: missing === 0 && this.matched === this.source.triangles && !mismatches.length,
      source_triangles: this.source.triangles, matched_triangles: this.matched, missing_triangles: missing,
      source_vertices: this.source.vertices, unique_attribute_records: this.uniqueVertices,
      unique_oriented_triangles: this.uniqueTriangles, mixed_dbid_triangles: this.mixedIdTriangles,
      dbids: this.sourceIds.size, dbid_mismatches: mismatches, per_dbid: counts };
  }
}

function localFile(dir, name) {
  assert.equal(typeof name, 'string');
  assert.equal(path.basename(name), name, 'Only local flat GLB paths are supported');
  assert.ok(name.endsWith('.glb'), 'Expected GLB filename');
  return path.join(dir, name);
}
function assertIdList(actual, info) {
  assert.equal(info.parts, actual.length, 'Manifest part count changed');
  assert.deepEqual([...info.dbIds].sort((a, b) => a - b), actual, 'Manifest dbId list differs from decoded attributes');
}

async function main() {
  const oldSpaceMB = Number(process.execArgv.find(a => /^--max[-_]old[-_]space[-_]size=/.test(a))?.split('=')[1]);
  assert.ok(oldSpaceMB > 0 && oldSpaceMB <= 4096, 'Run with --max-old-space-size=4096 (or less)');
  const started = performance.now(), streamDir = path.join(MODEL, 'stream');
  const rootFile = path.join(MODEL, 'manifest.json'), streamFile = path.join(streamDir, 'manifest.json');
  const rootBytes = fs.readFileSync(rootFile), streamBytes = fs.readFileSync(streamFile);
  const root = JSON.parse(rootBytes), stream = JSON.parse(streamBytes);
  const report = {
    version: 1, generated: new Date().toISOString(), passed: false,
    scope: 'stream.chunks DETAIL tiles only; overview.chunks intentionally excluded',
    method: 'Exact oriented triangle multiset matching over complete decoded attribute-record bytes. Hashes only locate candidates; collisions are resolved by exact byte/tuple comparisons. Cyclic rotations are equivalent; reversed winding is not. Duplicate multiplicities and per-dbId counts are exact.',
    inputs: { root_manifest_sha256: digest(rootBytes), stream_manifest_sha256: digest(streamBytes),
      source_glbs: root.chunks.length, detail_tiles: stream.chunks.length,
      excluded_overview_tiles: stream.overview?.chunks?.length || 0 },
    per_dbid_columns: ['dbId', 'source_triangle_count', 'detail_triangle_count'],
    groups: [], errors: [],
    limits: [
      'Proves preservation relative to the ten packed source GLBs, not the original NWD/SVF, its hierarchy, semantic correctness or pre-export quantization.',
      'Checks all triangle-referenced attribute records, including padding, normals, dbIds and positions; unused source vertices and non-rendered container/compression bytes are not required to be reproduced.',
      'Scene/node transforms, primitive/material state and attribute interpretation are compared exactly as decoded JSON. File identity is checked by SHA-256; tile filenames carry only its 48-bit prefix.',
      'Reuses tile-model.decodeGlb and its meshoptimizer decoder as requested; a shared decoder defect is outside this independent matching proof. This is not a browser/viewport-visibility test.',
    ],
  };
  let peakRss = 0, peakHeap = 0, peakArray = 0;
  const memory = () => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); peakArray = Math.max(peakArray, m.arrayBuffers); };
  const seen = new Set();
  for (const c of stream.chunks) { assert.ok(!seen.has(c.file), 'Duplicate detail file in manifest'); seen.add(c.file); }
  assert.equal(root.chunks.length, 10, 'Expected the original ten packed GLBs');
  assert.equal(stream.chunks.length, 851, 'Expected all 851 detail tiles');
  assert.deepEqual([...new Set(stream.chunks.map(c => c.source_chunk))].sort(), root.chunks.map(c => c.name).sort());
  assert.deepEqual(stream.sources.map(s => s.file).sort(), root.chunks.map(c => c.file).sort());
  const unlisted = fs.readdirSync(streamDir).filter(f => f.endsWith('.glb') && !f.startsWith('overview-') && !seen.has(f));
  assert.deepEqual(unlisted, [], 'Unlisted detail GLBs exist');
  console.log(`Auditing ${stream.chunks.length} DETAIL tiles / ${root.chunks.length} sources; excluding ${report.inputs.excluded_overview_tiles} overview tiles. Exact matching, 4096 MB heap cap.`);

  async function group(info, index) {
    const tiles = stream.chunks.filter(t => t.source_chunk === info.name);
    const record = stream.sources.find(s => s.file === info.file);
    const result = { name: info.name, source_file: info.file, tiles: tiles.length, passed: false, errors: [] };
    console.log(`[${index + 1}/${root.chunks.length}] ${info.name}: ${tiles.length} tiles`);
    const file = localFile(MODEL, info.file);
    assert.equal(fs.statSync(file).size, info.bytes, 'Source size differs from root manifest');
    const source = await decodeGlb(file); memory();
    result.source_sha256 = source.hash;
    assert.equal(source.hash, record.sha256, 'Source SHA-256 differs from stream.sources');
    const matcher = new ExactTileMatcher(source); memory();
    assert.equal(matcher.source.triangles, record.triangles, 'Source packed triangle count differs from stream.sources');
    assert.equal(tiles.length, record.tiles, 'Source tile count differs from stream.sources');
    let tileBytes = 0;
    for (const tile of tiles) {
      try {
        const tileFile = localFile(streamDir, tile.file);
        assert.equal(fs.statSync(tileFile).size, tile.bytes, 'Tile size differs from manifest');
        const decoded = await decodeGlb(tileFile); memory();
        const prefix = /-([a-f0-9]{12})\.glb$/.exec(tile.file)?.[1];
        assert.equal(decoded.hash.slice(0, 12), prefix, 'Tile filename content hash differs');
        const actual = matcher.addTile(decoded);
        assert.equal(actual.triangles, tile.triangles, 'Tile triangle count differs from manifest');
        assert.equal(actual.vertices, tile.vertices, 'Tile vertex count differs from manifest');
        assertIdList(actual.dbIds, tile);
        tileBytes += tile.bytes;
      } catch (e) {
        result.errors.push({ file: tile.file, message: e.message });
        console.log(`  FAIL ${tile.name}: ${e.message.split('\n')[0]}`);
      }
    }
    Object.assign(result, matcher.finish(), { bytes: tileBytes });
    result.passed &&= result.errors.length === 0;
    memory();
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'} ${result.matched_triangles.toLocaleString('en')} / ${result.source_triangles.toLocaleString('en')} triangles; ${result.dbids.toLocaleString('en')} dbIds; ${(performance.now() - started).toFixed(0)} ms elapsed`);
    return result;
  }
  for (let i = 0; i < root.chunks.length; i++) {
    try { report.groups.push(await group(root.chunks[i], i)); }
    catch (e) { report.groups.push({ name: root.chunks[i].name, passed: false, errors: [{ message: e.message }] }); console.log(`  FAIL ${e.message.split('\n')[0]}`); }
    global.gc?.(); memory();
  }
  report.totals = {
    source_triangles: report.groups.reduce((s, g) => s + (g.source_triangles || 0), 0),
    matched_triangles: report.groups.reduce((s, g) => s + (g.matched_triangles || 0), 0),
    missing_triangles: report.groups.reduce((s, g) => s + (g.missing_triangles || 0), 0),
    detail_bytes: report.groups.reduce((s, g) => s + (g.bytes || 0), 0),
    dbid_count_mismatches: report.groups.reduce((s, g) => s + (g.dbid_mismatches?.length || 0), 0),
    file_errors: report.groups.reduce((s, g) => s + g.errors.length, 0),
  };
  if (report.totals.source_triangles !== EXPECTED_TRIANGLES) report.errors.push(`Expected ${EXPECTED_TRIANGLES} packed source triangles`);
  if (digest(fs.readFileSync(rootFile)) !== report.inputs.root_manifest_sha256 ||
      digest(fs.readFileSync(streamFile)) !== report.inputs.stream_manifest_sha256) report.errors.push('A manifest changed during audit; rerun against a stable snapshot');
  report.passed = !report.errors.length && report.groups.every(g => g.passed);
  report.elapsed_seconds = (performance.now() - started) / 1000;
  report.memory = { max_old_space_mb: oldSpaceMB, heap_limit_bytes: v8.getHeapStatistics().heap_size_limit,
    peak_observed_rss_bytes: peakRss, peak_observed_heap_used_bytes: peakHeap, peak_observed_array_buffer_bytes: peakArray,
    note: 'One decoded source plus one decoded tile; source-local exact-match tables. Peaks sampled at decode/build/finish boundaries.' };
  fs.writeFileSync(path.join(MODEL, 'tile-integrity.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`${report.passed ? 'PASS' : 'FAIL'} ${report.totals.matched_triangles.toLocaleString('en')} exact triangle matches, ${report.totals.dbid_count_mismatches} dbId count mismatches, ${report.totals.file_errors} file errors; ${report.elapsed_seconds.toFixed(1)} s; observed RSS ${(peakRss / 2 ** 20).toFixed(0)} MiB. Report: model/tile-integrity.json`);
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(`Audit stopped: ${e.message}`); process.exitCode = 1; });
}
