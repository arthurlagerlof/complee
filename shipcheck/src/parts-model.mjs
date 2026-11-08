// Turns the prepared parts file (ships/rcrv/parts.json) into a checker model (ship/1 schema).
// Pure function: runs in Node (CLI, tests, precompute) and in the browser.
//
// Every derived value says how it was derived (`source`), and every converted length keeps the text
// written in the model (`original`), so the UI can show  5/16" = 7.94 mm.
// Classifications below are ShipCheck's reading of the model's text fields; they are listed in VERIFY.md.

export const SWBS_GROUPS = {
  '100': 'Hull structure, general', '110': 'Shell plating', '120': 'Hull structural bulkheads', '130': 'Hull decks',
  '140': 'Hull platforms and flats', '150': 'Deckhouse structure', '160': 'Special structures', '170': 'Masts, kingposts, poles',
  '180': 'Foundations', '190': 'Special purpose systems',
};

// First SWBS code -> 3-digit group: "114" -> "110", "1001" -> "100", "100,150" -> "100", "6231" -> "600".
export function swbsGroup(swbs) {
  const code = String(swbs ?? '').split(',')[0].trim();
  if (!/^\d{3,4}$/.test(code)) return null;
  return code[0] === '1' ? `${code.slice(0, 2)}0` : `${code[0]}00`;
}

export function materialFamily(material) {
  const m = String(material ?? '').trim();
  if (!m) return null;
  if (/^CS\b/i.test(m) || /^ASTM A(36|53|106|131|500)\b/i.test(m)) return 'carbon steel';
  if (/^AL\b/i.test(m)) return 'aluminium';
  if (/^SS\b/i.test(m)) return 'stainless steel';
  if (/DETA|FABREEKA|ASTM E-84/i.test(m)) return 'non-structural';
  return 'unknown';
}

// "CS ABS A" -> "A", "CS ABS EH36" -> "EH36"; other carbon steels keep their specification ("API 5L X-52").
export function steelGrade(material) {
  const m = String(material ?? '').trim();
  const abs = m.match(/^CS ABS (\S+)$/i);
  if (abs) return abs[1].toUpperCase();
  if (materialFamily(m) === 'carbon steel') return m.replace(/^CS\s+/i, '');
  return null;
}

export function pipeMaterialFamily(mc) {
  const s = String(mc ?? '');
  if (!s) return null;
  if (/rock ?wool|insulation|F683/i.test(s)) return 'insulation';
  if (/HOSE|RUBBER|ELASTOMER/i.test(s)) return 'flexible';
  if (/CPVC|PVC/i.test(s)) return 'plastic';
  if (/DUCTILE IRON|CAST IRON/i.test(s)) return 'cast iron';
  if (/COPPER|C70600|\bB88\b|B-61|BRONZE|BRASS|B280|NI-AL-BRZ|C96200|B584/i.test(s)) return 'copper alloy';
  if (/ALUMIN|\b50\d\d AL\b/i.test(s)) return 'aluminium';
  if (/\bA-?10[56]\b|\bA-?234\b|\bA53\b|\bA36\b|CARBON STEEL|^STEEL$|GR-A STEEL|GALVANIZED|\bA-?312\b|\bA-?182\b|\bA-?403\b|\bA-?269\b|316L|304L|STAINLESS|ACID PROOF SS|Fe 37|\bA-?216\b|WCB|\bA-?351\b|API 5L/i.test(s)) return 'steel';
  return 'unknown';
}

const OIL_FUEL = /FUEL OIL|\bFO\b|F\.O\.|DIESEL OIL|\bMGO\b|\bMDO\b/i;

export function elementType(p) {
  const n = `${p.name} ${p.itemType ?? ''}`;
  // Whole items only: not drawing files, block definitions, or hatch covers/frames (components of a hatch).
  const item = !/^(File|Block)$/i.test(p.itemType ?? '') && !/\.dwg$/i.test(p.name);
  if (item && /HATCH/i.test(p.name) && !/FDN|FOUNDATION|^hatch (cover|frame)$/i.test(p.name)) return 'hatch';
  if (item && /MANHOLE|SCUTTLE/i.test(p.name)) return 'manhole';
  if (item && /DOOR/i.test(p.name)) return 'door';
  if (/\b(Curved |Standard )?Plate\b/i.test(n) && !/Stiffener/i.test(n)) return 'plate';
  if (/Stiffener|Faceplate/i.test(n)) return 'stiffener';
  if (p.mc) return 'pipe';
  if (p.group?.includes('ShipConstructor')) return 'structure_part';
  return 'system_item';
}

export function partsToModel(partsFile, meta = {}) {
  const SRC = (p) => `ShipConstructor model (APS): ${p.sourceFile ?? 'file not stated'}`;
  const DER = (what) => `derived by Complee from ${what} (src/parts-model.mjs)`;
  const groups = new Map();
  const elements = [];
  for (const p of partsFile.parts) {
    const type = elementType(p);
    const fluid = OIL_FUEL.test(`${p.sys ?? ''} ${p.pli ?? ''}`) ? 'oil fuel' : null;
    // Only parts a rule can look at are loaded: structure, named openings, oil fuel piping, items with a design status.
    const keep = p.group?.includes('ShipConstructor') || ['hatch', 'manhole', 'door'].includes(type) || (type === 'pipe' && fluid) || p.vfi;
    if (!keep) continue;
    const src = SRC(p);
    const props = { objectid: { value: p.objectid, source: 'APS viewer dbId' } };
    const set = (k, value, extra = {}) => { if (value != null && value !== '') props[k] = { value, source: src, ...extra }; };
    set('part_name', p.partName);
    set('drawing', p.drawing);
    set('swbs', p.swbs);
    const g = swbsGroup(p.swbs);
    if (g) props.swbs_group = { value: g, source: DER('SWBS (first code)') };
    if (p.group?.includes('ShipConstructor')) {
      set('material', p.material, p.materialRaw ? { original: p.materialRaw.join(', ') } : {});
      const fam = materialFamily(p.material);
      if (fam) props.material_family = { value: fam, source: DER(`Material "${p.material}"`) };
      const grade = steelGrade(p.material);
      if (grade) props.steel_grade = { value: grade, source: DER(`Material "${p.material}"`) };
      set('stock_desc', p.stockDesc);
    }
    if (p.thickness?.mm != null) props.thickness = { value: p.thickness.mm, unit: 'mm', original: p.thickness.raw, source: src };
    if (p.weight?.kg != null) props.weight_kg = { value: p.weight.kg, original: p.weight.raw, source: src };
    if (p.cg) props.cg_mm = { value: p.cg.mm, original: `${p.cg.in.join(', ')} in (LCG, TCG, VCG)`, source: src };
    if (p.errors) props.data_errors = { value: p.errors, source: src };
    set('design_status', p.vfi);
    set('system', p.sys);
    set('pipeline', p.pli);
    set('pipe_material', p.mc);
    set('description', p.de);
    set('size', p.dd);
    if (p.mc) props.pipe_material_family = { value: pipeMaterialFamily(p.mc), source: DER(`MC "${p.mc}"`) };
    if (fluid) props.fluid = { value: fluid, source: DER('sys / pli') };
    if (p.opening) {
      const o = p.opening;
      props.clear_opening_min_side = o.kind === 'rect'
        ? { value: o.w_mm, unit: 'mm', original: `${o.w_in}" (smaller side of ${o.raw})`, source: DER(`item name "${p.name}"`) }
        : { value: o.d_mm, unit: 'mm', original: `${o.d_in}" diameter (${o.raw})`, source: DER(`item name "${p.name}"`) };
      if (o.kind === 'rect') props.clear_opening = { value: `${o.w_mm} × ${o.l_mm} mm`, original: o.raw, source: DER(`item name "${p.name}"`) };
    }
    // UR S6 material class is not in the model: offered as an editable, missing value on the members Table 1 covers.
    if (props.material_family?.value === 'carbon steel' && ['110', '120', '130'].includes(g) && type === 'plate') {
      props.material_class = { value: null, options: ['I', 'II', 'III'], source: 'not in the model: depends on member category and position (UR S6 Table 1)' };
    }

    const deck = type === 'pipe' ? 'PIPING' : g ?? (type === 'system_item' ? 'SYSTEMS' : 'OTHER');
    if (!groups.has(deck)) groups.set(deck, deck === 'PIPING' ? 'Oil fuel piping' : deck === 'SYSTEMS' ? 'Systems (design status)' : deck === 'OTHER' ? 'Other / no SWBS' : `SWBS ${deck} ${SWBS_GROUPS[deck] ?? ''}`.trim());
    // Readable label: part name for structure, description for piping/system items (their names are block ids).
    const label = p.partName ? `${p.partName} · ${p.itemType ?? p.name}`
      : p.de ? `${p.de.length > 60 ? p.de.slice(0, 58) + '…' : p.de}${p.sys ? ` · ${p.sys}` : ''}` : p.name;
    elements.push({ id: `P${p.objectid}`, objectid: p.objectid, type, name: label, deck, source: src, props });
  }
  const order = (id) => (/^\d/.test(id) ? Number(id) : id === 'PIPING' ? 2000 : id === 'SYSTEMS' ? 3000 : 4000);
  const decks = [...groups].sort((a, b) => order(a[0]) - order(b[0])).map(([id, name]) => ({ id, name, elevation: 0, outline: [] }));
  return {
    name: meta.name ?? partsFile.name,
    units: 'mm',
    kind: 'parts',
    source: partsFile.source?.file,
    provenance_note: meta.provenance_note,
    ship: meta.ship ?? {},
    viewer: { type: 'aps', urn: partsFile.source?.urn ?? null },
    decks,
    demo: meta.demo,
    counts: partsFile.counts,
    elements,
  };
}
