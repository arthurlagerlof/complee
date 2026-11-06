// Extracts the object tree and all properties of the converted model as JSON.
// Usage: node --env-file=.env extract.mjs
// Needs urn.txt (written by status.mjs). Writes model-views.json, model-tree.json, model-properties.json
import fs from 'node:fs';

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET) { console.error('Missing keys in .env'); process.exit(1); }
const urn = fs.readFileSync('urn.txt', 'utf8').trim();
const BASE = `https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}`;

const tokRes = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
  method: 'POST',
  headers: {
    Authorization: 'Basic ' + Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64'),
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }),
});
if (!tokRes.ok) { console.error(`Auth failed (${tokRes.status}): ${await tokRes.text()}`); process.exit(1); }
const { access_token } = await tokRes.json();

// GET with retry: 202 means Autodesk is still preparing the data, 413 means too big without forceget.
async function getJson(url, label) {
  let force = false;
  for (let attempt = 1; attempt <= 60; attempt++) {
    const res = await fetch(force ? `${url}${url.includes('?') ? '&' : '?'}forceget=true` : url, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (res.status === 200) return res.json();
    if (res.status === 202) { console.log(`   ${label}: still being prepared, waiting... (${attempt})`); await new Promise((r) => setTimeout(r, 10000)); continue; }
    if (res.status === 413 && !force) { console.log(`   ${label}: very large, retrying with forceget`); force = true; continue; }
    throw new Error(`${label} failed (${res.status}): ${await res.text()}`);
  }
  throw new Error(`${label}: gave up after waiting 10 minutes`);
}

const views = await getJson(`${BASE}/metadata`, 'views');
fs.writeFileSync('model-views.json', JSON.stringify(views, null, 2));
const view3d = views.data.metadata.find((v) => v.role === '3d') ?? views.data.metadata[0];
console.log(`1/3 Found ${views.data.metadata.length} view(s); using "${view3d.name}" (${view3d.role})`);

const tree = await getJson(`${BASE}/metadata/${view3d.guid}`, 'object tree');
fs.writeFileSync('model-tree.json', JSON.stringify(tree));
console.log('2/3 Saved model-tree.json');

const props = await getJson(`${BASE}/metadata/${view3d.guid}/properties`, 'properties');
fs.writeFileSync('model-properties.json', JSON.stringify(props));
const items = props.data?.collection ?? [];
console.log(`3/3 Saved model-properties.json (${items.length} objects)`);

// Quick overview: most common property groups and a few example names
const groups = {};
for (const o of items) for (const g of Object.keys(o.properties || {})) groups[g] = (groups[g] || 0) + 1;
console.log('\nProperty groups (count):');
Object.entries(groups).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([g, n]) => console.log(`  ${n}\t${g}`));
console.log('\nExample object names:');
items.slice(0, 15).forEach((o) => console.log(`  ${o.objectid}\t${o.name}`));
