// Checks the Autodesk conversion status of the uploaded model without uploading again.
// Usage: node --env-file=.env status.mjs 12100-RCRV-199_07-08-2021.nwd
// Writes urn.txt once the conversion has succeeded.
import fs from 'node:fs';
import path from 'node:path';

const { APS_CLIENT_ID, APS_CLIENT_SECRET } = process.env;
const FILE = process.argv[2];
if (!APS_CLIENT_ID || !APS_CLIENT_SECRET || !FILE) {
  console.error('Usage: node --env-file=.env status.mjs <model-file>');
  process.exit(1);
}

// Same bucket name and object id as upload.mjs
const BUCKET = `meyer-${APS_CLIENT_ID.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)}`;
const objectId = `urn:adsk.objects:os.object:${BUCKET}/${path.basename(FILE)}`;
const urn = Buffer.from(objectId).toString('base64url');

const res = await fetch('https://developer.api.autodesk.com/authentication/v2/token', {
  method: 'POST',
  headers: {
    Authorization: 'Basic ' + Buffer.from(`${APS_CLIENT_ID}:${APS_CLIENT_SECRET}`).toString('base64'),
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read' }),
});
if (!res.ok) { console.error(`Auth failed (${res.status}): ${await res.text()}`); process.exit(1); }
const { access_token } = await res.json();

const m = await fetch(`https://developer.api.autodesk.com/modelderivative/v2/designdata/${urn}/manifest`, {
  headers: { Authorization: `Bearer ${access_token}` },
});
if (m.status === 404) {
  console.log('No conversion found for this file. Run upload.mjs again.');
  process.exit(1);
}
if (!m.ok) { console.error(`Manifest failed (${m.status}): ${await m.text()}`); process.exit(1); }

const mf = await m.json();
console.log(`Status: ${mf.status}  Progress: ${mf.progress}`);

if (mf.status === 'success') {
  fs.writeFileSync('urn.txt', urn);
  console.log('Done. Saved urn.txt. Now run: node --env-file=.env server.mjs');
} else if (mf.status === 'failed' || mf.status === 'timeout') {
  console.log(JSON.stringify(mf, null, 2));
} else {
  console.log('Still converting. Run this command again in a few minutes.');
}
