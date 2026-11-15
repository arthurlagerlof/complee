// Requests from other websites, oversized bodies, forwarded paths, source model files and CSV formulas
// (security review of 15 Nov 2026). The AI and verification backends are replaced by a local echo server.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLocalRequest, originAllowed, safeForwardPath, clientAddress } from '../src/request-guard.mjs';
import { csvCell } from '../src/csv.mjs';

// Echo backend: records what reached it.
const seen = [];
const echo = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => { seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization }); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
});
await new Promise((r) => echo.listen(0, '127.0.0.1', r));
const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'complee-sec-'));
fs.writeFileSync(path.join(modelDir, 'source.nwd'), 'SOURCE MODEL');
fs.writeFileSync(path.join(modelDir, 'sample.rvt'), 'REVIT');
fs.writeFileSync(path.join(modelDir, 'manifest.json'), '{}');
process.env.AI_API_URL = `http://127.0.0.1:${echo.address().port}`;
process.env.MODEL_DIR = modelDir;
process.env.BACKEND_API_TOKEN = 'test-token-0123456789abcdef';
const log = console.log;
console.log = () => {};
const { server } = await import('../server.mjs');
await new Promise((r) => server.listen(0, '127.0.0.1', r));
console.log = log;
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); echo.close(); fs.rmSync(modelDir, { recursive: true, force: true }); });

// Raw request (fetch would refuse to set Host / Origin freely).
function raw(method, p, headers = {}, body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const json = { 'Content-Type': 'application/json' };

test('another website cannot use the AI, rule verification or Revit upload, with or without a simple content type', async () => {
  seen.length = 0;
  for (const [p, extra] of [['/api/assist/explain-finding', {}], ['/api/rule-verification/import', {}], ['/api/convert/rvt?name=x.rvt', { 'Content-Type': 'application/octet-stream' }]]) {
    const r = await raw('POST', p, { Origin: 'https://evil.example', 'Content-Type': 'text/plain', ...extra }, '{"x":1}');
    assert.equal(r.status, 403, p);
  }
  // Simple content type without an Origin (an old browser or a form): refused for lack of application/json.
  assert.equal((await raw('POST', '/api/assist/explain-finding', { 'Content-Type': 'text/plain' }, '{"x":1}')).status, 415);
  // Cross-site fetch metadata without Origin.
  assert.equal((await raw('POST', '/api/assist/explain-finding', { ...json, 'Sec-Fetch-Site': 'cross-site' }, '{"x":1}')).status, 403);
  assert.deepEqual(seen, [], 'nothing reached the backend');
  // The app itself (same origin) still works.
  const ok = await raw('POST', '/api/assist/explain-finding', { ...json, Origin: `http://localhost:${port}` }, '{"x":1}');
  assert.equal(ok.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].auth, 'Bearer test-token-0123456789abcdef', 'the backend token is sent along');
});

test('a foreign Host name (DNS rebinding) or a proxy header makes a request non-local', async () => {
  assert.equal((await raw('GET', '/api/aps/token', { Host: `attacker.example:${port}` })).status, 403);
  assert.equal((await raw('GET', '/api/aps/token', { 'X-Forwarded-For': '203.0.113.9' })).status, 403);
  assert.equal((await raw('POST', '/api/assist/explain-finding', { ...json, Host: `attacker.example:${port}`, Origin: `http://attacker.example:${port}` }, '{}')).status, 403);
  const req = (h, addr = '127.0.0.1') => ({ socket: { remoteAddress: addr }, headers: h });
  assert.equal(isLocalRequest(req({ host: 'localhost:8080' })), true);
  assert.equal(isLocalRequest(req({ host: 'localhost:8080' }, '192.168.1.5')), false);
  assert.equal(isLocalRequest(req({ host: 'localhost:8080', origin: 'http://localhost:5173' })), true, 'the Vite dev page');
  assert.equal(isLocalRequest(req({ host: 'localhost:8080', origin: 'https://evil.example' })), false);
  assert.equal(originAllowed({ headers: { host: 'app.example', origin: 'https://app.example' } }), true, 'same origin behind a proxy');
});

test('an oversized body is refused without reading it into memory, and the server keeps running', async () => {
  // Declared too large: refused at once.
  const declared = await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => sock.write(`POST /api/aps/fallback HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\nContent-Length: 600000000\r\n\r\n{"a":`));
    let text = '';
    sock.on('data', (d) => { text += d; if (/\r\n\r\n/.test(text)) { sock.destroy(); resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])); } });
    sock.on('error', () => resolve('reset'));
  });
  assert.equal(declared, 413);
  // Not declared (chunked) and 30 MB: the server stops at its limit. On Windows the closed connection can reach the
  // client as a reset before the 413 is read; what matters is that the process survives.
  const status = await new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`POST /api/aps/fallback HTTP/1.1\r\nHost: localhost:${port}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`);
      const chunk = 'a'.repeat(1 << 20);
      let n = 0;
      const pump = () => { while (n < 30) { n++; if (!sock.write(`${(1 << 20).toString(16)}\r\n${chunk}\r\n`)) return sock.once('drain', pump); } sock.write('0\r\n\r\n'); };
      pump();
    });
    let text = '';
    sock.on('data', (d) => { text += d; });
    sock.on('close', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1])));
    sock.on('error', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]) || 'reset'));
  });
  assert.ok(status === 413 || status === 'reset', String(status));
  assert.equal((await fetch(`${base}/api/health`)).status, 200, 'still running');
});

test('the verification forward stays inside its API and keeps the query string; the AI forward fixes the method', async () => {
  seen.length = 0;
  for (const p of ['/api/rule-verification/%252e%252e/ai/built-in-providers', '/api/rule-verification/..%2fai', '/api/rule-verification/%2e%2e%2fai']) {
    assert.equal((await raw('GET', p)).status, 404, p);
  }
  // A dot segment the URL parser resolves itself stays inside the verification API.
  await raw('GET', '/api/rule-verification/a/%2e%2e/rules');
  assert.ok(seen.every((s) => s.url.startsWith('/api/v1/rule-verification/')), JSON.stringify(seen));
  seen.length = 0;
  assert.equal((await raw('GET', '/api/rule-verification/rules?status=draft&limit=5')).status, 200);
  assert.deepEqual(seen.map((s) => s.url), ['/api/v1/rule-verification/rules?status=draft&limit=5']);
  assert.equal((await raw('PUT', '/api/assist/explain-finding', json, '{}')).status, 405);
  assert.equal((await raw('POST', '/api/assist/status', json, '{}')).status, 405);
  assert.equal(safeForwardPath('rules/R-1/versions'), true);
  assert.equal(safeForwardPath('rules/../x'), false);
});

test('the model folder serves tiles and manifests, never the source model', async () => {
  assert.equal((await fetch(`${base}/model/manifest.json`)).status, 200);
  assert.equal((await fetch(`${base}/model/source.nwd`)).status, 404);
  assert.equal((await fetch(`${base}/model/sample.rvt`)).status, 404);
  assert.equal((await fetch(`${base}/api/catalog/constructor`)).status, 404, 'no prototype key lookup');
});

test('the rate limit ignores client-chosen address headers unless a proxy is declared', () => {
  const req = { socket: { remoteAddress: '198.51.100.4' }, headers: { 'x-real-ip': '203.0.113.7' } };
  assert.equal(clientAddress(req), '198.51.100.4');
  assert.equal(clientAddress(req, { trustProxy: true }), '203.0.113.7');
});

test('CSV cells never start a formula; plain negative numbers stay as written', () => {
  assert.equal(csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
  for (const v of ['+cmd', '@SUM(A1)', '-2+3', '\tx']) assert.match(csvCell(v), /^"'/, v);
  for (const v of ['-5 mm', '-12.5', -3, 'Corridor']) assert.doesNotMatch(csvCell(v), /^"'/, String(v));
});
