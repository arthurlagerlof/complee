// OPTIONAL enhancement: reads the converted OSU model from Autodesk Platform Services (Model Derivative
// metadata endpoints) and maps useful objects into ships/rcrv-aps/ship.json. The demo does NOT depend on it.
//
// Needs ../3D_Since_AI/urn.txt (written by status.mjs once the SVF2 conversion succeeded) and the APS keys
// in ../3D_Since_AI/.env. Keys are read, never printed.
// Usage: node extract-aps.mjs [aps-folder]        (default ../3D_Since_AI; APS_UNITS=in by default)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { UNIT_TO_MM } from './src/checker.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BASE = 'https://developer.api.autodesk.com';

const TYPE_RULES = [
  [/stair/i, 'stair'], [/ladder/i, 'ladder'], [/door|hatch/i, 'door'], [/corridor|passage|alleyway/i, 'corridor'],
  [/rail|bulwark/i, 'guard_rail'], [/sludge/i, 'sludge_tank'], [/tank/i, 'tank'], [/escape trunk/i, 'escape_trunk'],
];

function flatProps(props = {}) {
  const out = {};
  for (const [cat, vals] of Object.entries(props)) {
    if (vals && typeof vals === 'object') for (const [k, v] of Object.entries(vals)) out[`${cat}/${k}`] = v;
    else out[cat] = vals;
  }
  return out;
}

const num = (v) => (typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.')));

// Looks for a bounding box in the property list (names differ between exporters).
export function findBBox(flat) {
  const pick = (re) => Object.entries(flat).find(([k]) => re.test(k))?.[1];
  const box = {
    x0: num(pick(/bound.*min.*x|min.*x/i)), y0: num(pick(/bound.*min.*y|min.*y/i)), z0: num(pick(/bound.*min.*z|min.*z/i)),
    x1: num(pick(/bound.*max.*x|max.*x/i)), y1: num(pick(/bound.*max.*y|max.*y/i)), z1: num(pick(/bound.*max.*z|max.*z/i)),
  };
  return Object.values(box).every(Number.isFinite) ? box : null;
}

// Maps APS property collection entries to ship.json elements (pure, tested offline).
export function mapObjects(collection, units = 'in') {
  const k = UNIT_TO_MM[units];
  if (!k) throw new Error(`Unsupported APS unit "${units}"`);
  const elements = [], skipped = { no_type: 0, no_bbox: 0 };
  for (const o of collection) {
    const flat = flatProps(o.properties);
    const category = flat['Item/Type'] || flat['Element/Category'] || flat['Category'] || '';
    const label = `${o.name ?? ''} ${category}`;
    const type = TYPE_RULES.find(([re]) => re.test(label))?.[1];
    if (!type) { skipped.no_type++; continue; }
    const b = findBBox(flat);
    if (!b) { skipped.no_bbox++; continue; }
    elements.push({
      id: `APS-${o.objectid}`, type, name: o.name || `${type} ${o.objectid}`, deck: 'APS',
      source: `APS model (OSU .nwd), object ${o.objectid}${category ? `, category ${category}` : ''}; bbox converted from ${units}`,
      geom: { x: b.x0 * k, y: b.y0 * k, z: b.z0 * k, lx: (b.x1 - b.x0) * k, ly: (b.y1 - b.y0) * k, h: (b.z1 - b.z0) * k },
      props: {},
    });
  }
  return { elements, skipped };
}

function readEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

async function getJSON(url, token, tries = 20) {
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (r.status === 202) { console.log('   APS is still preparing the data, waiting 10 s...'); await new Promise((s) => setTimeout(s, 10000)); continue; }
    if (!r.ok) throw new Error(`${url.replace(BASE, '')} failed (${r.status})`);
    return r.json();
  }
  throw new Error('APS did not finish preparing the metadata');
}

async function main() {
  const dir = path.resolve(ROOT, process.argv[2] || '../3D_Since_AI');
  const urnFile = path.join(dir, 'urn.txt');
  if (!fs.existsSync(urnFile)) {
    console.log(`No ${urnFile}. Run status.mjs in the APS folder until the conversion succeeds. The demo works without this step.`);
    return;
  }
  const env = { ...readEnv(path.join(dir, '.env')), ...process.env };
  if (!env.APS_CLIENT_ID || !env.APS_CLIENT_SECRET) throw new Error(`APS_CLIENT_ID / APS_CLIENT_SECRET missing in ${path.join(dir, '.env')}`);
  const units = env.APS_UNITS || 'in';
  const urn = fs.readFileSync(urnFile, 'utf8').trim();

  const t = await fetch(`${BASE}/authentication/v2/token`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${env.APS_CLIENT_ID}:${env.APS_CLIENT_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'data:read viewables:read' }),
  });
  if (!t.ok) throw new Error(`APS auth failed (${t.status})`);
  const { access_token } = await t.json();
  console.log('1/4 Logged in to APS');

  const meta = await getJSON(`${BASE}/modelderivative/v2/designdata/${urn}/metadata`, access_token);
  const view = meta.data.metadata.find((m) => m.role === '3d') || meta.data.metadata[0];
  console.log(`2/4 Model view: ${view.name}`);

  const tree = await getJSON(`${BASE}/modelderivative/v2/designdata/${urn}/metadata/${view.guid}?forceget=true`, access_token);
  const props = await getJSON(`${BASE}/modelderivative/v2/designdata/${urn}/metadata/${view.guid}/properties?forceget=true`, access_token);
  const collection = props.data.collection || [];
  console.log(`3/4 Read ${collection.length} objects with properties`);

  const { elements, skipped } = mapObjects(collection, units);
  const outDir = path.join(ROOT, 'ships', 'rcrv-aps');
  fs.mkdirSync(outDir, { recursive: true });
  const categories = {};
  for (const o of collection) {
    const c = flatProps(o.properties)['Item/Type'] || 'unknown';
    categories[c] = (categories[c] || 0) + 1;
  }
  fs.writeFileSync(path.join(outDir, 'aps-summary.json'), JSON.stringify({
    urn_view: view.name, objects: collection.length, top_level: tree.data.objects?.map((o) => o.name), categories, mapped: elements.length, skipped,
  }, null, 2));
  const ship = {
    name: 'RCRV from APS model (extracted objects)', units: 'mm', source: 'APS model (OSU .nwd)',
    ship: JSON.parse(fs.readFileSync(path.join(ROOT, 'ships/rcrv/ship.json'), 'utf8')).ship,
    decks: [{ id: 'APS', name: 'Extracted objects (absolute coordinates)', elevation: 0, outline: [] }],
    elements,
  };
  fs.writeFileSync(path.join(outDir, 'ship.json'), JSON.stringify(ship, null, 1));
  console.log(`4/4 Mapped ${elements.length} objects (skipped: ${skipped.no_type} without a known type, ${skipped.no_bbox} without a bounding box).`);
  console.log('Wrote ships/rcrv-aps/ship.json and aps-summary.json. Restart the server: the scenario "RCRV from APS model" appears.');
  if (!elements.length) console.log('No bounding boxes found in the properties: see aps-summary.json for the available categories.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e.message); process.exit(1); });
