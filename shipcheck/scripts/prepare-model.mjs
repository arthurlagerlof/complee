// Streams the APS property dump of the real OSU RCRV model into an external catalog staging file.
// Usage: node scripts/prepare-model.mjs [path/to/model-properties.json] [out.json]
//   defaults: 3D_Since_AI/model-properties.json -> OS temp directory/shipcheck-catalog/ships/rcrv/parts.json
//
// The input (~150 MB, 330,760 objects) is never loaded whole. Kept per part: objectid (= viewer dbId),
// name, source file, the ShipConstructor fields (Material, Stock Thickness, Stock Desc, SWBS, Part Name,
// Drawing Name, Weight, LCG/TCG/VCG) and the Attributes fields (sys, pli, MC, DE, DD, VFI).
// Lengths are converted from inches to mm and weights from lb to kg; the original strings are kept.
// Nothing is guessed: a value that cannot be parsed is kept as text and flagged in `unparsed`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { streamArray } from '../src/json-stream.mjs';
import { parseFeetInch, inchToMM, parseWeightKg, parseOpening } from '../src/units.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IN = path.resolve(ROOT, process.argv[2] || '3D_Since_AI/model-properties.json');
const OUT = path.resolve(
  ROOT,
  process.argv[3] || process.env.SHIPCHECK_CATALOG_STAGING_FILE || path.join(os.tmpdir(), 'shipcheck-catalog', 'shipcheck', 'ships', 'rcrv', 'parts.json'),
);
const URN_FILE = path.join(path.dirname(IN), 'urn.txt');

const GENERIC = /^(Subentity|3D Solid|MESH|_Part|0|Layer|Block|Insert|Region|SURFACE|PLANESURFACE|SWEPTSURFACE|EXTRUDEDSURFACE|PolyFace Mesh)$/i;
const NAMED_ITEM = /HATCH|MANHOLE|SCUTTLE|DOOR|STAIR|LADDER/i;
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const r3 = (v) => (v == null ? null : Math.round(v * 1000) / 1000);
const isBad = (v) => typeof v === 'string' && /^\s*(Error|---)\s*$/i.test(v);

function compactPart(o) {
  const it = o.properties?.Item || {};
  const sc = o.properties?.ShipConstructor;
  const at = o.properties?.Attributes;
  const p = { objectid: o.objectid, name: o.name };
  if (it.Type != null && it.Type !== o.name) p.itemType = it.Type;   // omitted when equal to name
  p.sourceFile = it['Source File'] ?? null;
  const unparsed = [], errors = [];

  if (sc) {
    p.group = 'ShipConstructor';
    const mats = [].concat(sc.Material ?? []).map(String).filter((m) => m && m !== 'ByLayer');
    const uniq = [...new Set(mats)];
    p.material = uniq.length ? uniq.join(', ') : null;       // null = only "ByLayer" (no material assigned)
    // Original list only when it says more than "ByLayer" + the material.
    const rawList = [].concat(sc.Material ?? []).map(String);
    if (rawList.some((m) => m !== 'ByLayer' && m !== p.material)) p.materialRaw = rawList;
    if (sc.SWBS != null) p.swbs = String(sc.SWBS);
    for (const [k, f] of [['partName', 'Part Name'], ['drawing', 'Drawing Name'], ['stockDesc', 'Stock Desc']]) {
      if (sc[f] != null && sc[f] !== '') p[k] = String(sc[f]);
    }
    if (sc['Stock Thickness'] != null) {
      const inch = parseFeetInch(sc['Stock Thickness']);
      p.thickness = { mm: inchToMM(inch), raw: String(sc['Stock Thickness']) };
      if (inch == null) unparsed.push('Stock Thickness');
    }
    if (sc.Weight != null) {
      const kg = parseWeightKg(sc.Weight);
      p.weight = { kg, raw: String(sc.Weight) };
      if (kg == null) unparsed.push('Weight');
    }
    const cg = ['LCG', 'TCG', 'VCG'].map((k) => num(sc[k]));
    if (cg.some((v) => v != null)) {
      p.cg = { in: cg.map(r3), mm: cg.map((v) => (v == null ? null : Math.round(v * 254) / 10)) };
      ['LCG', 'TCG', 'VCG'].forEach((k, i) => { if (sc[k] != null && cg[i] == null) unparsed.push(k); });
    }
    for (const [k, v] of Object.entries(sc)) if (isBad(v)) errors.push(k);
  }

  // Attributes items (piping, HVAC, electrical) are kept when they carry a pipe material (MC) or a design status (VFI).
  if (at && (at.MC != null || at.VFI != null)) {
    p.group = p.group ? `${p.group}+Attributes` : 'Attributes';
    for (const [k, f] of [['sys', 'sys'], ['pli', 'pli'], ['mc', 'MC'], ['de', 'DE'], ['dd', 'DD'], ['vfi', 'VFI']]) {
      if (at[f] != null && at[f] !== '') p[k] = String(at[f]);
    }
    for (const [k, v] of Object.entries(at)) if (isBad(v)) errors.push(`Attributes.${k}`);
  }

  // Named items (hatches, manholes, doors, stairs): keep them even without ShipConstructor data.
  const named = !GENERIC.test(String(o.name)) && NAMED_ITEM.test(String(o.name));
  if (!p.group && !named) return null;
  if (!p.group) p.group = 'Item';
  if (named) {
    const op = parseOpening(o.name);
    if (op) {
      p.opening = op.kind === 'rect'
        ? { kind: 'rect', w_mm: inchToMM(op.w_in), l_mm: inchToMM(op.l_in), w_in: r3(op.w_in), l_in: r3(op.l_in), raw: op.raw }
        : { kind: 'round', d_mm: inchToMM(op.d_in), d_in: r3(op.d_in), raw: op.raw };
    }
  }
  if (unparsed.length) p.unparsed = unparsed;
  if (errors.length) p.errors = errors;
  return p;
}

export async function prepare(input = IN, output = OUT) {
  const t0 = Date.now();
  const parts = [];
  const counts = { objects: 0, kept: 0, shipconstructor: 0, attributes: 0, named_items: 0, with_opening: 0,
    swbs_1xx: 0, material_bylayer_only: 0, thickness_parsed: 0, thickness_unparsed: 0, weight_parsed: 0,
    vfi_final: 0, vfi_preliminary: 0, with_error_values: 0 };
  for await (const o of streamArray(input, 'collection')) {
    counts.objects++;
    const p = compactPart(o);
    if (!p) continue;
    parts.push(p);
    counts.kept++;
    if (p.group.includes('ShipConstructor')) counts.shipconstructor++;
    if (p.group.includes('Attributes')) counts.attributes++;
    if (p.group === 'Item') counts.named_items++;
    if (p.opening) counts.with_opening++;
    if (/^1/.test(p.swbs ?? '')) counts.swbs_1xx++;
    if (p.group.includes('ShipConstructor') && p.material == null) counts.material_bylayer_only++;
    if (p.thickness) p.thickness.mm != null ? counts.thickness_parsed++ : counts.thickness_unparsed++;
    if (p.weight?.kg != null) counts.weight_parsed++;
    if (p.vfi === 'Final') counts.vfi_final++;
    if (p.vfi === 'Preliminary') counts.vfi_preliminary++;
    if (p.errors) counts.with_error_values++;
  }
  const out = {
    name: 'OSU Regional Class Research Vessel (RCRV): ShipConstructor production model',
    source: {
      file: '12100-RCRV-199_07-08-2021.nwd (converted with Autodesk APS Model Derivative, SVF2)',
      urn: fs.existsSync(URN_FILE) ? fs.readFileSync(URN_FILE, 'utf8').trim() : null,
      model_unit: 'in',
      prepared: new Date().toISOString(),
      note: 'objectid = APS viewer dbId. Lengths: raw inch / feet-inch strings converted to mm (1 in = 25.4 mm); weights lb -> kg (1 lb = 0.45359237 kg).',
    },
    counts,
    parts,
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  // One part per line: small diffs, still valid JSON.
  const body = JSON.stringify({ ...out, parts: '__PARTS__' }, null, 1)
    .replace('"__PARTS__"', `[\n${parts.map((p) => JSON.stringify(p)).join(',\n')}\n]`);
  fs.writeFileSync(output, body);
  return { counts, ms: Date.now() - t0, bytes: Buffer.byteLength(body) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!fs.existsSync(IN)) { console.error(`Not found: ${IN}`); process.exit(1); }
  const { counts, ms, bytes } = await prepare();
  console.log(`Read ${counts.objects.toLocaleString('en')} objects in ${(ms / 1000).toFixed(1)} s, wrote ${path.relative(ROOT, OUT)} (${(bytes / 1e6).toFixed(1)} MB)`);
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${v.toLocaleString('en')}`);
}
