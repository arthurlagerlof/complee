// One-time: get an SVF (not SVF2) derivative of the RCRV model, because svf-utils 8 reads SVF only.
// Usage (from shipcheck/tools/export): node request-svf.mjs
//
// Model Derivative will not add SVF to a model that already has SVF2 (a job without x-ads-force is ignored, and
// "svf + svf2 in one job is not supported"). Forcing SVF on the original would replace the SVF2 that the APS
// viewer fallback uses. So the source file is COPIED inside our own bucket (server-side OSS copy, no re-upload)
// and the copy is translated to SVF. The original model and its SVF2 stay untouched.
// Keys: shipcheck/3D_Since_AI/.env (never printed). The copy's URN is written to work/svf-urn.txt (gitignored).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APS_DIR = path.resolve(HERE, '../../3D_Since_AI');
const BASE = 'https://developer.api.autodesk.com';

export function readKeys() {
  const env = {};
  for (const line of fs.readFileSync(path.join(APS_DIR, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(APS_CLIENT_ID|APS_CLIENT_SECRET)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  if (!env.APS_CLIENT_ID || !env.APS_CLIENT_SECRET) throw new Error('APS keys missing in 3D_Since_AI/.env');
  return env;
}
export const readUrn = () => fs.readFileSync(path.join(APS_DIR, 'urn.txt'), 'utf8').trim();

export async function token(scope) {
  const { APS_CLIENT_ID, APS_CLIENT_SECRET } = readKeys();
  const res = await fetch(`${BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }),
  });
  if (!res.ok) throw new Error(`Authentication failed (${res.status})`);
  return (await res.json()).access_token;
}

export async function manifest(tok, urn) {
  const res = await fetch(`${BASE}/modelderivative/v2/designdata/${urn}/manifest`, { headers: { Authorization: `Bearer ${tok}` } });
  if (!res.ok) throw new Error(`Manifest request failed (${res.status})`);
  return res.json();
}

// The SVF (not SVF2) derivative: outputType "svf".
export const svfDerivative = (m) => (m.derivatives || []).find((d) => d.outputType === 'svf');

const b64url = (str) => Buffer.from(str).toString('base64url');
const fromB64url = (u) => Buffer.from(u.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString();
export const SVF_URN_FILE = path.join(HERE, 'work', 'svf-urn.txt');

async function api(tok, route, opts = {}) {
  return fetch(BASE + route, { ...opts, headers: { Authorization: `Bearer ${tok}`, ...(opts.body ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) } });
}

async function main() {
  const src = fromB64url(readUrn()).match(/^urn:adsk\.objects:os\.object:([^/]+)\/(.+)$/);
  if (!src) throw new Error('urn.txt is not an OSS object URN');
  const [, bucket, key] = src;
  const copyKey = key.replace(/(\.[^.]+)$/, '.svf-export$1'); // keep the extension: the translator needs it
  const copyUrn = b64url(`urn:adsk.objects:os.object:${bucket}/${copyKey}`);
  let tok = await token('data:read data:write data:create viewables:read bucket:read');

  // 1. Server-side copy of the source file (skipped when it already exists).
  const exists = await api(tok, `/oss/v2/buckets/${bucket}/objects/${encodeURIComponent(copyKey)}/details`);
  if (exists.ok) console.log('Copy of the source file already exists.');
  else {
    const cp = await api(tok, `/oss/v2/buckets/${bucket}/objects/${encodeURIComponent(key)}/copyto/${encodeURIComponent(copyKey)}`, { method: 'PUT' });
    if (!cp.ok) throw new Error(`Copy failed (${cp.status}): ${(await cp.text()).slice(0, 300)}`);
    console.log('Copied the source file inside the bucket (server-side).');
  }
  fs.mkdirSync(path.dirname(SVF_URN_FILE), { recursive: true });
  fs.writeFileSync(SVF_URN_FILE, copyUrn);

  // 2. Translate the copy to SVF (unless already done).
  let m = await manifest(tok, copyUrn).catch(() => null);
  let svf = m && svfDerivative(m);
  if (svf?.status === 'success') { console.log('SVF derivative of the copy already exists. Nothing to do.'); return; }
  if (!svf || svf.status === 'failed') {
    const res = await api(tok, '/modelderivative/v2/designdata/job', {
      method: 'POST',
      headers: { 'x-ads-region': 'US', region: 'US', 'x-ads-force': 'true' },
      body: JSON.stringify({ input: { urn: copyUrn }, output: { formats: [{ type: 'svf', views: ['3d'] }] } }),
    });
    if (!res.ok) throw new Error(`Job request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const job = await res.json();
    console.log(`Job accepted: result ${job.result}. Waiting for the SVF translation…`);
  }
  const t0 = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 20_000));
    if (Date.now() - t0 > 50 * 60_000) tok = await token('data:read viewables:read');
    m = await manifest(tok, copyUrn).catch(() => null);
    svf = m && svfDerivative(m);
    console.log(`  ${Math.round((Date.now() - t0) / 1000)} s: manifest ${m?.status ?? '-'} ${m?.progress ?? ''}; svf ${svf?.status ?? 'pending'}`);
    if (svf?.status === 'success') break;
    if (svf?.status === 'failed' || svf?.status === 'timeout' || m?.status === 'failed') throw new Error(`SVF translation failed: ${JSON.stringify(m?.derivatives?.map((d) => d.messages)).slice(0, 400)}`);
    if (Date.now() - t0 > 3 * 3600_000) throw new Error('Gave up after 3 h');
  }
  console.log('SVF derivative ready.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
