// Revit -> IFC conversion against a simulated Autodesk Platform Services (no network, no keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRvtConverter, partPlan, findIfcDerivative, manifestErrors } from '../src/rvt-convert.mjs';

const IFC = "ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n";

// A small APS: token, buckets, signed S3 upload, translation job, manifest, signed-cookie download.
function fakeAps({ fail = false, badKeys = false, flaky = 0, polls = 2 } = {}) {
  const calls = [];
  const objects = new Map(), parts = new Map();
  let manifestReads = 0, errorsLeft = flaky;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    calls.push(`${req.method} ${url.pathname}`);
    const json = (code, obj, headers = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };
    if (errorsLeft > 0 && url.pathname.startsWith('/modelderivative')) { errorsLeft--; return json(503, { error: 'busy' }); }
    if (url.pathname === '/authentication/v2/token') return badKeys ? json(401, { error: 'invalid_client' }) : json(200, { access_token: 'T', expires_in: 3599 });
    if (req.headers.authorization !== 'Bearer T' && !url.pathname.startsWith('/s3/') && !url.pathname.startsWith('/cdn/')) return json(401, {});
    if (req.method === 'POST' && url.pathname === '/oss/v2/buckets') return json(409, { reason: 'Bucket already exists' });
    let m = /^\/oss\/v2\/buckets\/([^/]+)\/objects\/([^/]+)\/signeds3upload$/.exec(url.pathname);
    if (m && req.method === 'GET') {
      const n = Number(url.searchParams.get('parts'));
      return json(200, { uploadKey: 'UK', urls: Array.from({ length: n }, (_, i) => `http://127.0.0.1:${server.address().port}/s3/${m[2]}/${i}`) });
    }
    if (m && req.method === 'POST') {
      const key = decodeURIComponent(m[2]);
      const all = [...(parts.get(key) ?? new Map()).entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      objects.set(key, Buffer.concat(all));
      return json(200, { objectId: `urn:adsk.objects:os.object:${m[1]}/${key}`, size: objects.get(key).length });
    }
    m = /^\/s3\/([^/]+)\/(\d+)$/.exec(url.pathname);
    if (m && req.method === 'PUT') { const key = decodeURIComponent(m[1]); if (!parts.has(key)) parts.set(key, new Map()); parts.get(key).set(Number(m[2]), body); res.writeHead(200); return res.end(); }
    if (req.method === 'POST' && url.pathname === '/modelderivative/v2/designdata/job') return json(200, { result: 'created', urn: JSON.parse(body).input.urn });
    m = /^\/modelderivative\/v2\/designdata\/([^/]+)\/manifest$/.exec(url.pathname);
    if (m) {
      manifestReads++;
      if (manifestReads < polls) return json(200, { status: 'inprogress', progress: '40% complete', derivatives: [{ outputType: 'ifc', status: 'inprogress', progress: '40% complete' }] });
      if (fail) return json(200, { status: 'failed', derivatives: [{ outputType: 'ifc', status: 'failed', messages: [{ type: 'error', code: 'Revit-Error', message: '<b>The file is from a newer Revit version.</b>' }] }] });
      return json(200, { status: 'success', progress: 'complete', derivatives: [
        { outputType: 'svf2', status: 'success', children: [] },
        { outputType: 'ifc', status: 'success', children: [{ role: 'ifc', urn: `urn:adsk.viewing:fs.file:${m[1]}/output/model.ifc` }] },
      ] });
    }
    m = /^\/modelderivative\/v2\/designdata\/([^/]+)\/manifest\/([^/]+)\/signedcookies$/.exec(url.pathname);
    if (m) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': ['CloudFront-Policy=P; Path=/', 'CloudFront-Signature=S; Path=/', 'CloudFront-Key-Pair-Id=K; Path=/'] });
      return res.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/cdn/model.ifc`, size: IFC.length }));
    }
    if (url.pathname === '/cdn/model.ifc') {
      if (!/CloudFront-Policy=P/.test(req.headers.cookie ?? '') || !/CloudFront-Signature=S/.test(req.headers.cookie ?? '')) { res.writeHead(403); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      return res.end(IFC);
    }
    json(404, { path: url.pathname });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, objects, base: `http://127.0.0.1:${server.address().port}` })));
}

function tmpFile(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvt-'));
  const file = path.join(dir, 'upload.rvt');
  fs.writeFileSync(file, bytes);
  return { dir, file, sha: crypto.createHash('sha256').update(bytes).digest('hex') };
}
async function finish(conv, job) {
  for (let i = 0; i < 400; i++) { const j = conv.job(job.id); if (j.state === 'done' || j.state === 'failed') return j; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('conversion did not finish');
}
const creds = () => ({ id: 'client', secret: 'secret' });

test('rvt: upload in parts, translate to IFC, download with signed cookies, then cache', async () => {
  const aps = await fakeAps({ flaky: 1 });
  const bytes = crypto.randomBytes(12 * 1024 * 1024 + 123); // three parts of at least 5 MB
  const { dir, file, sha } = tmpFile(bytes);
  try {
    const conv = createRvtConverter({ credentials: creds, cacheDir: path.join(dir, 'cache'), base: aps.base, pollMs: 1 });
    const job = conv.start(file, { name: 'tower.rvt', sha, bytes: bytes.length });
    const done = await finish(conv, job);
    assert.equal(done.state, 'done', done.error);
    assert.equal(fs.readFileSync(conv.ifcFile(job.id), 'utf8'), IFC);
    assert.ok([...aps.objects.values()][0].equals(bytes), 'the parts are reassembled to the same file');
    assert.equal(aps.calls.filter((c) => c.startsWith('PUT /s3/')).length, partPlan(bytes.length).parts);
    assert.ok(!fs.existsSync(file), 'the uploaded file is deleted after the conversion');

    // Same content again: no upload, no translation.
    const before = aps.calls.length;
    const again = tmpFile(bytes);
    const cached = conv.start(again.file, { name: 'copy.rvt', sha, bytes: bytes.length });
    assert.equal(cached.state, 'done');
    assert.equal(cached.cached, true);
    assert.equal(aps.calls.length, before);
  } finally { aps.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rvt: a failed translation reports Autodesk\'s reason; bad keys are named as such', async () => {
  const aps = await fakeAps({ fail: true });
  const { dir, file, sha } = tmpFile(crypto.randomBytes(1000));
  try {
    const conv = createRvtConverter({ credentials: creds, cacheDir: path.join(dir, 'cache'), base: aps.base, pollMs: 1 });
    const done = await finish(conv, conv.start(file, { name: 'x.rvt', sha, bytes: 1000 }));
    assert.equal(done.state, 'failed');
    assert.match(done.error, /could not convert the file to IFC: The file is from a newer Revit version\./);
    assert.ok(!fs.existsSync(path.join(dir, 'cache', `${sha}.ifc`)));
  } finally { aps.server.close(); fs.rmSync(dir, { recursive: true, force: true }); }

  const bad = await fakeAps({ badKeys: true });
  const t = tmpFile(crypto.randomBytes(100));
  try {
    const conv = createRvtConverter({ credentials: creds, cacheDir: path.join(t.dir, 'cache'), base: bad.base, pollMs: 1 });
    const done = await finish(conv, conv.start(t.file, { name: 'x.rvt', sha: t.sha, bytes: 100 }));
    assert.match(done.error, /rejected the APS keys/);
  } finally { bad.server.close(); fs.rmSync(t.dir, { recursive: true, force: true }); }
});

test('rvt: without keys nothing is sent and the message says what is needed', () => {
  const { dir, file, sha } = tmpFile(Buffer.from('x'));
  try {
    const conv = createRvtConverter({ credentials: () => ({}), cacheDir: path.join(dir, 'cache'), fetchImpl: () => { throw new Error('must not be called'); } });
    assert.equal(conv.configured(), false);
    const job = conv.start(file, { name: 'x.rvt', sha, bytes: 1 });
    assert.equal(job.state, 'failed');
    assert.match(job.error, /APS_CLIENT_ID and APS_CLIENT_SECRET/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rvt: part plan and manifest helpers', () => {
  assert.deepEqual(partPlan(100), { partSize: 5 * 1024 * 1024, parts: 1 });
  const big = partPlan(1024 * 1024 * 1024);
  assert.ok(big.parts <= 25 && big.partSize * big.parts >= 1024 * 1024 * 1024);
  assert.equal(findIfcDerivative({ derivatives: [{ outputType: 'svf2' }] }), null);
  assert.equal(findIfcDerivative({ derivatives: [{ outputType: 'ifc', children: [{ children: [{ role: 'ifc', urn: 'u/x.ifc' }] }] }] }).node.urn, 'u/x.ifc');
  assert.deepEqual(manifestErrors({ derivatives: [] }, { messages: [{ type: 'info', message: 'ok' }, { type: 'error', message: 'bad' }] }), ['bad']);
});
