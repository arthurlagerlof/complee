// Uploads a model to Autodesk APS and converts it for the web viewer (SVF2).
// Usage: node --env-file=.env upload.mjs <model-file>
import fs from 'node:fs';
import path from 'node:path';

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
const FILE = process.argv[2];
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET || !FILE) {
  console.error('Usage: node --env-file=.env upload.mjs <model-file>');
  process.exit(1);
}

const BASE = 'https://developer.api.autodesk.com';
const BUCKET = `meyer-${APS_CLIENT_ID.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)}`;
const PART_SIZE = 50 * 1024 * 1024; // 50 MB per upload part

async function getToken() {
  const res = await fetch(`${BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'data:read data:write data:create bucket:create bucket:read',
    }),
  });
  if (!res.ok) throw new Error(`Auth failed (${res.status}): ${await res.text()}`);
  return (await res.json()).access_token;
}

async function api(token, route, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(BASE + route, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

async function main() {
  const token = await getToken();
  console.log('1/5 Logged in to APS');

  // Create bucket (storage space). 409 means it already exists, which is fine.
  const b = await api(token, '/oss/v2/buckets', {
    method: 'POST',
    // x-ads-region is marked deprecated in the docs; the newer "region" header takes precedence. Send both.
    headers: { 'x-ads-region': 'US', region: 'US' },
    body: { bucketKey: BUCKET, access: 'full', policyKey: 'persistent' },
  });
  if (!b.ok && b.status !== 409) throw new Error(`Bucket failed (${b.status}): ${await b.text()}`);
  console.log(`2/5 Bucket ready: ${BUCKET}`);

  // Upload in parts using signed URLs.
  const objectKey = path.basename(FILE);
  const size = fs.statSync(FILE).size;
  const parts = Math.max(1, Math.ceil(size / PART_SIZE));
  const objRoute = `/oss/v2/buckets/${BUCKET}/objects/${encodeURIComponent(objectKey)}/signeds3upload`;

  const s = await api(token, `${objRoute}?parts=${parts}&firstPart=1&minutesExpiration=60`);
  if (!s.ok) throw new Error(`Upload URL failed (${s.status}): ${await s.text()}`);
  const { uploadKey, urls } = await s.json();

  const fh = await fs.promises.open(FILE, 'r');
  try {
    for (let i = 0; i < urls.length; i++) {
      const start = i * PART_SIZE;
      const len = Math.min(PART_SIZE, size - start);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      const put = await fetch(urls[i], { method: 'PUT', body: buf });
      if (!put.ok) throw new Error(`Part ${i + 1} failed (${put.status}): ${await put.text()}`);
      console.log(`   uploaded part ${i + 1}/${urls.length}`);
    }
  } finally {
    await fh.close();
  }

  const done = await api(token, objRoute, { method: 'POST', body: { uploadKey } });
  if (!done.ok) throw new Error(`Finish upload failed (${done.status}): ${await done.text()}`);
  const { objectId } = await done.json();
  console.log('3/5 Upload complete');

  // Start conversion to SVF2 (the viewer format).
  const urn = Buffer.from(objectId).toString('base64url');
  const job = await api(token, '/modelderivative/v2/designdata/job', {
    method: 'POST',
    headers: { 'x-ads-force': 'true' },
    body: {
      input: { urn },
      output: { formats: [{ type: 'svf2', views: ['2d', '3d'] }] },
    },
  });
  if (!job.ok) throw new Error(`Translation job failed (${job.status}): ${await job.text()}`);
  console.log('4/5 Conversion started (this can take a while for big models)');

  // Wait until done.
  for (;;) {
    await new Promise((r) => setTimeout(r, 10000));
    const m = await api(token, `/modelderivative/v2/designdata/${urn}/manifest`);
    if (!m.ok) { console.log(`   waiting... (${m.status})`); continue; }
    const mf = await m.json();
    console.log(`   status: ${mf.status} ${mf.progress ?? ''}`);
    if (mf.status === 'success') break;
    if (mf.status === 'failed' || mf.status === 'timeout') {
      console.error(JSON.stringify(mf, null, 2));
      throw new Error('Conversion failed. Send me the output above.');
    }
  }

  fs.writeFileSync('urn.txt', urn);
  console.log('5/5 Done. Saved urn.txt. Now run: node --env-file=.env server.mjs');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
