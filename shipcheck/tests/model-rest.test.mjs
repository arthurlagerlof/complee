// Full model: the rest sub-chunks (rest-01.glb …, tools/export/export-rest.mjs) are listed in model/manifest.json,
// exist on disk, are counted by /api/health and are served with Range support.
// Skipped when no model is exported (model/ is not in Git).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = path.join(ROOT, 'model');
const manifestFile = path.join(MODEL, 'manifest.json');
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, 'utf8')) : null;
const restChunks = manifest?.chunks.filter((c) => c.group === 'rest') ?? [];
const skip = !restChunks.length && 'no rest sub-chunks exported (run tools/export/export-rest.mjs)';

test('manifest lists every rest sub-chunk, and every listed file exists', { skip }, () => {
  const onDisk = fs.readdirSync(MODEL).filter((f) => /^rest-\d+\.glb$/.test(f)).sort();
  assert.deepEqual(restChunks.map((c) => c.file).sort(), onDisk, 'manifest and model/ agree on the rest sub-chunks');
  assert.equal(restChunks.length, manifest.rest?.chunks, 'all planned sub-chunks are built');
  restChunks.forEach((c, i) => {
    assert.equal(c.name, `rest-${String(i + 1).padStart(2, '0')}`);
    assert.equal(fs.statSync(path.join(MODEL, c.file)).size, c.bytes, `${c.file}: size as in the manifest`);
    assert.ok(c.parts > 0 && c.triangles > 0, `${c.file}: parts and triangles`);
    assert.equal(c.simplified, null, `${c.file}: not simplified`);
    for (const k of [0, 1, 2]) assert.ok(c.bounds_mm.min[k] < c.bounds_mm.max[k], `${c.file}: bounding box`);
  });
  // The 6 main chunks are still there, unchanged in name and order.
  assert.deepEqual(manifest.chunks.filter((c) => c.group !== 'rest').map((c) => c.name),
    ['context', 'openings', 'structure-findings', 'piping', 'access', 'structure']);
  assert.ok(fs.readdirSync(path.join(MODEL, 'props')).length > 0, 'rest part data (model/props) exported');
});

test('source audit covers every non-empty geometry fragment across all chunks', { skip }, () => {
  const coverage = manifest.coverage;
  assert.ok(coverage, 'run tools/export/audit-model.mjs after exporting');
  assert.equal(coverage.unmapped_geometry_fragments, 0);
  assert.equal(coverage.non_triangle_fragments, 0);
  assert.equal(coverage.source_fragments, manifest.chunks.reduce((n, c) => n + c.source_fragments, 0));
  assert.equal(coverage.source_triangles, manifest.chunks.reduce((n, c) => n + c.triangles, 0));
});

test('server: health counts the rest sub-chunks; a rest sub-chunk answers a Range request with 206', { skip }, async (t) => {
  const log = console.log;
  console.log = () => {};
  const { server } = await import('../server.mjs');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  console.log = log;
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = await (await fetch(`${base}/api/health`)).json();
  assert.equal(h.chunks, manifest.chunks.length);
  assert.equal(h.rest_chunks, restChunks.length);
  for (const c of restChunks) {
    const head = await fetch(`${base}/model/${c.file}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), 'model/gltf-binary');
    assert.match(head.headers.get('cache-control'), /max-age=31536000/);
    assert.equal(Number(head.headers.get('content-length')), c.bytes);
  }
  const last = restChunks.at(-1);
  const part = await fetch(`${base}/model/${last.file}`, { headers: { Range: 'bytes=1000-1999' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 1000-1999/${last.bytes}`);
  assert.equal((await part.arrayBuffer()).byteLength, 1000);
});
