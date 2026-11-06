// Local server for the compliance viewer: http://localhost:8080
// Usage: npm start   (or: node server.mjs)
// Serves only whitelisted folders (never .env), runs the checker, and exposes a small JSON API.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCheck, loadRules, loadScenarios } from './check.mjs';
import { providerConfig, draftRule, explainResult, approveRule, loadApproved } from './rule-assistant.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 8080);

// Minimal .env loader (no dependency). Values are never logged.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.csv': 'text/csv',
};
// URL prefix -> folder on disk. Anything else is 404.
const STATIC = [
  ['/src/', 'src'],
  ['/ships/', 'ships'],
  ['/tests/expected/', 'tests/expected'],
  ['/node_modules/three/', 'node_modules/three'],
  ['/', 'public'],
];
const ROOT_FILES = new Set(['/rules.json', '/scenarios.json', '/rules-approved.json']);

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 200_000) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > limit) reject(new Error('Request too large')); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } });
  });
}

function serveStatic(p, res) {
  let file = null;
  if (ROOT_FILES.has(p)) file = path.join(ROOT, p);
  else {
    for (const [prefix, dir] of STATIC) {
      if (!p.startsWith(prefix)) continue;
      const base = path.join(ROOT, dir);
      const candidate = path.normalize(path.join(base, p.slice(prefix.length) || 'index.html'));
      if (candidate.startsWith(base + path.sep) || candidate === base) file = candidate;
      break;
    }
  }
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

const routes = {
  'GET /api/scenarios': () => loadScenarios(),
  'GET /api/rules': () => ({ rules: loadRules() }),
  'GET /rules-approved.json': () => (fs.existsSync(path.join(ROOT, 'rules-approved.json'))
    ? JSON.parse(fs.readFileSync(path.join(ROOT, 'rules-approved.json'), 'utf8')) : { rules: [] }),
  'GET /api/check':(q) => runCheck(q.get('scenario') || 'rcrv', 'rules.json', null),
  // Optional AI layer: drafts and explanations only, never pass/fail.
  'GET /api/ai/status': () => { const c = providerConfig(); return { enabled: !!c, provider: c?.name ?? null, model: c?.model ?? null }; },
  'POST /api/ai/draft-rule': (q, b) => draftRule(String(b.text || '').slice(0, 8000), b.source, loadRules().map((r) => r.id)),
  'POST /api/ai/explain': (q, b) => explainResult(b.element, b.result),
  'POST /api/rules/approve': (q, b) => {
    if (!b.rule) throw Object.assign(new Error('Missing rule'), { status: 400 });
    const core = loadRules().filter((r) => !loadApproved().some((a) => a.id === r.id));
    return { rules: approveRule(b.rule, core.map((r) => r.id)) };
  },
  // Kept from Plan B: re-runs the check and writes results.json.
  'GET /recheck': (q) => runCheck(q.get('scenario') || 'rcrv').summary,
};

export function addRoute(key, handler) { routes[key] = handler; }

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = decodeURIComponent(url.pathname);
  const handler = routes[`${req.method} ${p}`];
  if (handler) {
    try {
      const body = req.method === 'POST' ? await readBody(req) : undefined;
      return sendJSON(res, 200, await handler(url.searchParams, body));
    } catch (e) {
      return sendJSON(res, e.status || 500, { error: e.message });
    }
  }
  if (req.method !== 'GET') return sendJSON(res, 405, { error: 'Method not allowed' });
  serveStatic(p === '/' ? '/index.html' : p, res);
});

server.listen(PORT, () => {
  for (const s of loadScenarios()) {
    const out = runCheck(s.id, 'rules.json', null);
    console.log(`${s.name}: ${JSON.stringify(out.summary)}`);
  }
  console.log(`Open http://localhost:${PORT}`);
});
