// AutoCAD integration: a general-arrangement drawing (DXF) becomes a checkable ship model, and the check results go
// back to AutoCAD as a markup drawing in the same coordinates. Pure functions: browser and Node.
//
// Import convention (public/autocad.html). The layer name says what an entity is:
//     <DECK>-<TYPE>      e.g.  MD-CORRIDOR, MD-DOOR, 01-SPACE, 01-STAIR, MD-OUTLINE
//   - a closed polyline or a block reference on such a layer is one element (footprint = its bounding box);
//   - block attributes and KEY=VALUE text inside the footprint become its properties (CLEAR_WIDTH=850mm);
//     other text inside the footprint is its name;
//   - <DECK>-OUTLINE holds the deck outline, KEY=VALUE text for the deck (NAME, ELEVATION, HEIGHT) and an optional
//     POINT: the deck's reference origin, when decks are drawn side by side;
//   - a layer COMPLEE-SHIP holds KEY=VALUE text with the ship particulars (TYPE, LENGTH_OVERALL, CLASS_SOCIETY, ...).
// Nothing is guessed: layers that do not follow the convention are listed as not imported, a value that is neither
// drawn nor written stays missing (the checker then reports "not enough info"), and every value says where it
// comes from (file, layer, entity handle).
import { parseDxf, shapeBox, writeDxf, dxfLayerName } from './dxf.mjs';
import { normalizeModel, UNIT_TO_MM } from './checker.mjs';

const TYPE_WORDS = [
  ['outline', /^(OUTLINE|DECKLINE|DECKOUTLINE|HULL)$/],
  ['corridor', /^(CORRIDOR|CORRIDORS|CORR|PASSAGE|PASSAGEWAY)$/],
  ['door', /^(DOOR|DOORS)$/],
  ['stair', /^(STAIR|STAIRS|STAIRWAY)$/],
  ['ladder', /^(LADDER|LADDERS)$/],
  ['escape_trunk', /^(TRUNK|ESCAPETRUNK)$/],
  ['ramp', /^(RAMP|RAMPS)$/],
  ['muster_station', /^(MUSTER|MUSTERSTATION|ASSEMBLY)$/],
  ['guard_rail', /^(RAIL|RAILS|GUARDRAIL|GUARDRAILS|RAILING)$/],
  ['machinery_space', /^(MACHINERY|ENGINEROOM|MACHINERYSPACE)$/],
  ['fuel_tank', /^(FUELTANK|FUELTANKS)$/],
  ['tank', /^(TANK|TANKS)$/],
  ['liferaft', /^(LIFERAFT|LIFERAFTS|RAFT)$/],
  ['space', /^(SPACE|SPACES|ROOM|ROOMS|CABIN|CABINS|COMPARTMENT|COMPARTMENTS)$/],
];
const ABBR = { corridor: 'C', door: 'D', stair: 'ST', ladder: 'L', escape_trunk: 'ET', ramp: 'RP', muster_station: 'MUSTER', guard_rail: 'GR', machinery_space: 'MS', fuel_tank: 'FT', tank: 'T', liferaft: 'LR', space: 'S' };
const VERTICAL = new Set(['stair', 'ladder', 'escape_trunk']);
const INSUNITS = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const SHIP_LAYER = /^COMPLEE[-_ ]?SHIP$/i;
const SHIP_LISTS = new Set(['operating_area']);

/** "MD-CORRIDOR" -> { deck: 'MD', type: 'corridor' }; null when the layer does not follow the convention. */
export function layerRole(name) {
  const tokens = String(name).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (!tokens.length) return null;
  const last = tokens[tokens.length - 1];
  const hit = TYPE_WORDS.find(([, re]) => re.test(last));
  if (!hit) return null;
  return { deck: tokens.slice(0, -1).join('-') || 'DECK', type: hit[0] };
}

const key = (k) => String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
/** "850mm" -> { value: 850, unit: 'mm' }, "YES" -> true, "12" -> 12, anything else stays text. */
export function parseValue(text) {
  const s = String(text).trim();
  if (/^(yes|true)$/i.test(s)) return { value: true };
  if (/^(no|false)$/i.test(s)) return { value: false };
  const m = /^(-?\d+(?:\.\d+)?)\s*(mm|cm|m|in|ft|"|')?$/i.exec(s);
  if (m) {
    const unit = m[2] ? ({ '"': 'in', "'": 'ft' }[m[2]] ?? m[2].toLowerCase()) : null;
    return unit ? { value: Number(m[1]), unit } : { value: Number(m[1]) };
  }
  return { value: s };
}
// Text block -> { name, props } (KEY=VALUE or KEY: VALUE lines are properties, the first other line is the name).
function readText(text) {
  const props = {}; let name = null;
  for (const line of String(text).split('\n').map((l) => l.trim()).filter(Boolean)) {
    const m = /^([A-Za-z][A-Za-z0-9 _-]{0,40}?)\s*[=:]\s*(.+)$/.exec(line);
    if (m) props[key(m[1])] = m[2].trim(); else if (name == null) name = line;
  }
  return { name, props };
}

export function dxfToModel(text, { filename = 'drawing.dxf' } = {}) {
  const dxf = parseDxf(text);
  const warnings = [];
  // Units: $INSUNITS; a drawing without it says metric or imperial in $MEASUREMENT.
  const ins = Number(dxf.header.$INSUNITS ?? 0);
  let units = INSUNITS[ins], unitsNote;
  if (!units) {
    if (ins !== 0) throw new Error(`The drawing unit (INSUNITS ${ins}) is not supported. Set the drawing units to millimetres, centimetres, metres, inches or feet (UNITS command).`);
    units = dxf.header.$MEASUREMENT === '0' ? 'in' : 'mm';
    unitsNote = `the drawing states no unit (INSUNITS 0): read as ${units === 'in' ? 'inches (imperial drawing)' : 'millimetres'}`;
    warnings.push(`Drawing unit not stated (INSUNITS 0): coordinates are read as ${units}. Set it with the UNITS command to be explicit.`);
  }
  const src = (e, what = '') => `AutoCAD ${filename}: layer ${e.layer}${e.handle ? `, entity ${e.handle}` : ''}${what}`;

  const decks = new Map(); // id -> { id, outline: polygon, texts, origin, elements: [] }
  const deck = (id) => { if (!decks.has(id)) decks.set(id, { id, outlines: [], texts: [], origin: null, items: [], notes: [] }); return decks.get(id); };
  const layerStats = new Map(), skipped = new Map();
  const shipTexts = [];
  let open = 0;
  for (const e of dxf.entities) {
    if (SHIP_LAYER.test(e.layer)) { if (e.kind === 'text') shipTexts.push(e); continue; }
    const role = layerRole(e.layer);
    if (!role) { skipped.set(e.layer, (skipped.get(e.layer) || 0) + 1); continue; }
    const d = deck(role.deck);
    const stat = layerStats.get(e.layer) || { layer: e.layer, deck: role.deck, type: role.type, elements: 0 };
    layerStats.set(e.layer, stat);
    if (e.kind === 'text') { (role.type === 'outline' ? d.texts : d.items).push({ role, text: e }); continue; }
    if (e.kind === 'point') { if (role.type === 'outline') d.origin = e.at; continue; }
    let box = null, closed = true;
    if (e.kind === 'polygon') {
      const p = e.points, same = p.length > 2 && Math.abs(p[0][0] - p[p.length - 1][0]) < 1e-9 && Math.abs(p[0][1] - p[p.length - 1][1]) < 1e-9;
      closed = (e.closed || same) && p.length >= 3;
      if (closed) box = shapeBox(e);
    } else if (e.kind === 'insert') {
      box = shapeBox(e, dxf.blocks);
      if (!box) { warnings.push(`Block reference ${e.name ?? '?'} on layer ${e.layer} has no geometry and was not imported.`); continue; }
    } else closed = false;
    if (!closed || !box) { open++; continue; }
    if (role.type === 'outline') d.outlines.push(e);
    else { d.items.push({ role, shape: e, box }); stat.elements++; }
  }
  if (open) warnings.push(`${open} open line${open === 1 ? '' : 's'} / arc${open === 1 ? '' : 's'} on element layers were not imported: an element is a closed polyline or a block reference.`);
  if (!decks.size) throw new Error('No layer follows the naming convention <DECK>-<TYPE> (for example MD-CORRIDOR, MD-DOOR, MD-OUTLINE). The AutoCAD guide (autocad.html) describes it; demo/autocad-sample.dxf is a working example.');

  // ---- decks ----
  const area = (pts) => Math.abs(pts.reduce((s, p, i) => { const q = pts[(i + 1) % pts.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
  const deckList = [];
  for (const d of decks.values()) {
    const info = d.texts.map((t) => readText(t.text.text)).reduce((a, t) => ({ name: a.name ?? t.name, props: { ...a.props, ...t.props } }), { name: null, props: {} });
    const outline = d.outlines.sort((a, b) => area(b.points) - area(a.points))[0];
    const o = d.origin || [0, 0];
    const lengthOf = (k) => { if (info.props[k] == null) return undefined; const v = parseValue(info.props[k]); return typeof v.value === 'number' ? (v.unit ? v.value * UNIT_TO_MM[v.unit] / UNIT_TO_MM[units] : v.value) : undefined; };
    let elevation = lengthOf('elevation');
    if (elevation === undefined && outline && outline.elevation) elevation = outline.elevation;
    if (elevation === undefined) { elevation = 0; if (decks.size > 1) warnings.push(`Deck ${d.id}: no elevation (ELEVATION=… text on ${d.id}-OUTLINE, or the outline's elevation). It is placed at 0, so stairs cannot connect it to other decks.`); }
    let points;
    if (outline) {
      points = outline.points.map(([x, y]) => [x - o[0], y - o[1]]);
      if (outline.bulged) warnings.push(`Deck ${d.id}: arc segments of the outline are drawn as straight lines.`);
    } else {
      const boxes = d.items.filter((i) => i.box).map((i) => i.box);
      if (!boxes.length) continue;
      const b = boxes.reduce((a, c) => [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[2], c[2]), Math.max(a[3], c[3])]);
      points = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(([x, y]) => [x - o[0], y - o[1]]);
      warnings.push(`Deck ${d.id}: no outline on layer ${d.id}-OUTLINE; the extent of its elements is shown instead.`);
    }
    deckList.push({ d, entry: { id: d.id, name: info.props.name ?? info.name ?? `Deck ${d.id}`, elevation, ...(lengthOf('height') !== undefined ? { height: lengthOf('height') } : {}), outline: points,
      source: outline ? src(outline) : `AutoCAD ${filename}: extent of the elements on deck ${d.id}`, cad: { origin: o } } });
  }
  deckList.sort((a, b) => a.entry.elevation - b.entry.elevation || a.entry.id.localeCompare(b.entry.id));

  // ---- elements ----
  const elements = [], ids = new Set();
  for (const [index, { d, entry }] of deckList.entries()) {
    const o = entry.cad.origin;
    const above = deckList.slice(index + 1).find((x) => x.entry.elevation > entry.elevation)?.entry;
    const shapes = d.items.filter((i) => i.shape);
    const texts = d.items.filter((i) => i.text);
    // Text belongs to the smallest footprint of its own layer that contains its insertion point.
    const owned = new Map();
    let stray = 0;
    for (const t of texts) {
      const [x, y] = t.text.at;
      const host = shapes.filter((s) => s.shape.layer === t.text.layer && x >= s.box[0] && x <= s.box[2] && y >= s.box[1] && y <= s.box[3])
        .sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0];
      if (!host) { stray++; continue; }
      if (!owned.has(host)) owned.set(host, []);
      owned.get(host).push(t.text);
    }
    if (stray) warnings.push(`Deck ${d.id}: ${stray} text${stray === 1 ? '' : 's'} outside every element footprint of the same layer ${stray === 1 ? 'was' : 'were'} not used.`);
    for (const item of shapes) {
      const e = item.shape, type = item.role.type, [x0, y0, x1, y1] = item.box;
      const lx = x1 - x0, ly = y1 - y0;
      const source = src(e);
      const written = {}; let name = null;
      for (const t of owned.get(item) || []) { const r = readText(t.text); name ??= r.name; for (const [k, v] of Object.entries(r.props)) written[k] = { text: v, from: src(t, ' (text)') }; }
      if (e.kind === 'insert') for (const [tag, v] of Object.entries(e.attribs)) if (v !== '') written[key(tag)] = { text: v, from: `${source}, attribute ${tag}` };
      const props = {};
      for (const [k, w] of Object.entries(written)) {
        if (['id', 'name', 'type', 'extrusion', 'note'].includes(k)) continue;
        props[k] = { ...parseValue(w.text), source: w.from };
      }
      // Widths that the drawing itself shows: stated as measured from the geometry, never as a written clear width.
      const measured = (what) => `measured from the drawing geometry (${source}): ${what}, not a stated clear width`;
      if (['corridor', 'stair', 'ramp', 'ladder'].includes(type) && !props.clear_width) props.clear_width = { value: Math.min(lx, ly), unit: units, source: measured('drawn width') };
      if (type === 'door' && !props.clear_width) props.clear_width = { value: Math.max(lx, ly), unit: units, source: measured('drawn door width') };
      // Height in the 3D view: the entity's thickness (AutoCAD extrusion), EXTRUSION=…, or a display default.
      let h = e.thickness || null, hNote = null;
      if (!h && written.extrusion) { const v = parseValue(written.extrusion.text); if (typeof v.value === 'number') h = v.unit ? v.value * UNIT_TO_MM[v.unit] / UNIT_TO_MM[units] : v.value; }
      if (!h && VERTICAL.has(type)) {
        if (above) { h = above.elevation - entry.elevation; hNote = `No thickness on the entity: assumed to reach deck ${above.id}.`; }
        else hNote = 'No thickness on the entity and no deck above: it connects to no other deck.';
      }
      if (!h) h = ({ corridor: 150, muster_station: 40, door: 2000, guard_rail: 1000, ramp: 150 }[type] ?? 2400) / UNIT_TO_MM[units];
      let id = written.id?.text.trim() || `${d.id}-${ABBR[type] ?? type.toUpperCase()}-${e.handle ?? elements.length + 1}`;
      if (ids.has(id)) { warnings.push(`Element id ${id} is used twice in the drawing; the second one was renamed.`); id = `${id}-${e.handle ?? elements.length + 1}`; }
      ids.add(id);
      // A footprint is a bounding box: say so where the drawn shape is not that rectangle.
      const notRect = e.kind === 'polygon' && Math.abs(area(e.points) - lx * ly) > 0.01 * lx * ly;
      const notes = [written.note?.text, hNote,
        notRect ? `Footprint simplified to the bounding box of a polygon with ${e.points.length} vertices (${Math.round((area(e.points) / (lx * ly)) * 100)} % of the box).` : null,
        e.kind === 'insert' && e.rotation % 90 !== 0 ? `Block rotated by ${e.rotation}°: the footprint is its bounding box.` : null].filter(Boolean);
      elements.push({
        id, type: written.type ? key(written.type.text) : type, name: written.name?.text ?? name ?? `${type.replace(/_/g, ' ')} (${e.kind === 'insert' ? `block ${e.name}` : 'polyline'})`,
        deck: d.id, source,
        geom: { x: x0 - o[0], y: y0 - o[1], lx, ly, h },
        props, ...(notes.length ? { note: notes.join(' ') } : {}),
        cad: { layer: e.layer, handle: e.handle, kind: e.kind },
      });
    }
  }
  if (!elements.length) throw new Error('The drawing has convention layers but no element on them: an element is a closed polyline or a block reference.');

  // ---- ship particulars ----
  const ship = {};
  for (const t of shipTexts) {
    for (const [k, v] of Object.entries(readText(t.text).props)) {
      const from = src(t, ' (text)');
      if (SHIP_LISTS.has(k)) ship[k] = { value: v.split(/[,;]/).map((s) => s.trim()).filter(Boolean), source: from };
      else ship[k] = { ...parseValue(v), source: from };
    }
  }
  if (!shipTexts.length) warnings.push('No ship particulars (text on layer COMPLEE-SHIP, e.g. TYPE=research, LENGTH_OVERALL=60m): rules that depend on them report "not enough info".');

  const skippedLayers = [...skipped].map(([layer, entities]) => ({ layer, entities })).sort((a, b) => a.layer.localeCompare(b.layer));
  const ignored = Object.entries(dxf.ignored).map(([type, count]) => `${count} ${type}`);
  const report = {
    file: filename, version: dxf.header.$ACADVER ?? null, units, units_stated: !unitsNote,
    decks: deckList.length, elements: elements.length,
    layers: [...layerStats.values()].sort((a, b) => a.layer.localeCompare(b.layer)),
    skipped_layers: skippedLayers, ignored_entities: ignored, warnings,
  };
  const model = {
    name: ship.name?.value ? `${ship.name.value} (${filename})` : filename,
    units, source: `AutoCAD drawing ${filename}`,
    provenance_note: `Imported from the AutoCAD drawing ${filename}: ${elements.length} elements on ${deckList.length} deck${deckList.length === 1 ? '' : 's'}, drawing unit ${units}${unitsNote ? ` (${unitsNote})` : ''}. Footprints are bounding boxes of the drawn entities.`
      + (skippedLayers.length ? ` Not imported (layer name outside the convention): ${skippedLayers.map((l) => l.layer).join(', ')}.` : ''),
    ship, decks: deckList.map((x) => x.entry), elements,
    cad: report,
  };
  normalizeModel(structuredClone(model)); // fails here, with a clear message, rather than later in the viewer
  return { model, report };
}

// ---------- results -> AutoCAD markup ----------

const STATUS_LAYER = { non_compliant: ['NON_COMPLIANT', 1], not_enough_info: ['NOT_ENOUGH_INFO', 30], compliant: ['COMPLIANT', 3] };

/**
 * The check results as a DXF drawing in the model's own coordinates and unit: one frame per checked element and a
 * line of text per finding, on layers COMPLEE_<DECK>_<STATUS>. Attach it to the source drawing as an external
 * reference (XREF, insertion point 0,0,0) or open it on its own. Decks that were drawn at a reference origin are
 * written back at that origin, so each frame lies on the entity it came from.
 */
export function resultsToDxf(rawModel, results, { includeCompliant = true } = {}) {
  const norm = normalizeModel(structuredClone(rawModel));
  const k = UNIT_TO_MM[norm.units];
  const origins = Object.fromEntries((Array.isArray(rawModel.decks) ? rawModel.decks : []).map((d) => [d.id, d.cad?.origin || [0, 0]]));
  const layers = new Map(), entities = [];
  const layer = (deckId, status) => {
    const [suffix, color] = STATUS_LAYER[status];
    const name = dxfLayerName(`COMPLEE_${deckId}_${suffix}`);
    layers.set(name, { name, color });
    return name;
  };
  let findings = 0;
  for (const el of norm.elements) {
    const r = results.elements[el.id];
    if (!r?.worst || !el.geom_mm || el.virtual) continue;
    if (r.worst === 'compliant' && !includeCompliant) continue;
    const o = origins[el.deck] || [0, 0], g = el.geom_mm;
    const x0 = g.x / k + o[0], y0 = g.y / k + o[1], x1 = x0 + g.lx / k, y1 = y0 + g.ly / k;
    const name = layer(el.deck, r.worst);
    // The frame stands 50 mm off the entity so both stay visible when overlaid.
    const off = 50 / k;
    entities.push({ type: 'rect', layer: name, box: [x0 - off, y0 - off, x1 + off, y1 + off] });
    const bad = r.results.filter((x) => x.status !== 'compliant');
    if (!bad.length) continue;
    const height = 180 / k;
    entities.push({ type: 'text', layer: name, at: [x0, y1 + off + height * 0.6], height, text: `${el.id} ${el.name}` });
    bad.forEach((x, i) => {
      findings++;
      entities.push({ type: 'text', layer: layer(el.deck, x.status), at: [x0, y1 + off + height * (2.2 + 1.6 * i)], height,
        text: `${x.rule_id}: ${x.measured ?? 'value not in model'}, required ${x.required}` });
    });
  }
  return { dxf: writeDxf({ layers: [...layers.values()].sort((a, b) => a.name.localeCompare(b.name)), entities }), frames: entities.filter((e) => e.type === 'rect').length, findings };
}
