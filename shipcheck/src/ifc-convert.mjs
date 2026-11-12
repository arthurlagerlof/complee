// IFC -> Complee model (ship/1) plus the real geometry of every element.
// Works with web-ifc in the browser and in Node (the caller passes the module and an initialised IfcAPI).
//
// What is taken from the file: storeys (as decks), every element with geometry (name, IFC class, GlobalId, bounding
// box, triangles), and which storey it stands on (by position). What is NOT invented: clear widths, sill heights,
// zones and the other properties the rules read are not part of a plain IFC export. Rules that need them report
// "not enough info" until the values are added (what-if editor, or in the exported JSON).
//
// Axes: web-ifc delivers metres with Y up: (x, y, z) = (IFC X, IFC Z, -IFC Y). The Complee model uses
// x = IFC X, y = IFC Y (so y = -z here) and the elevation = IFC Z, all in mm.

// IFC class -> Complee element type. Classes not listed keep their IFC name in lower case without "ifc"
// (beam, column, wall, slab, ...) and are drawn as context; no rule applies to them.
const TYPE_BY_CLASS = {
  IFCDOOR: 'door', IFCSTAIR: 'stair', IFCSTAIRFLIGHT: 'stair', IFCRAMP: 'ramp', IFCRAMPFLIGHT: 'ramp',
  IFCRAILING: 'guard_rail', IFCSPACE: 'space',
};
// Elements of these types are drawn one by one (they carry rule results); everything else is merged per deck.
export const SEMANTIC_TYPES = new Set(['door', 'stair', 'ramp', 'guard_rail', 'space']);

const text = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v) ?? '';

// The project's own length unit: the one listed in IfcProject.UnitsInContext. A file can also contain other length
// units (Revit writes IfcSIUnit METRE as the base of its FOOT conversion unit), so the first unit found is not enough.
function lengthUnitInMetres(WebIFC, api, id) {
  const prefix = { MILLI: 1e-3, CENTI: 1e-2, DECI: 1e-1, KILO: 1e3 };
  const factor = (u) => {
    if (!u || text(u.UnitType) !== 'LENGTHUNIT') return null;
    if (u.type === WebIFC.IFCSIUNIT) return prefix[text(u.Prefix)] ?? 1;
    const name = String(text(u.Name)).toUpperCase();
    if (name.includes('FOOT') || name.includes('FEET')) return 0.3048;
    if (name.includes('INCH')) return 0.0254;
    const measure = u.ConversionFactor && api.GetLine(id, u.ConversionFactor.value);
    const value = Number(text(measure?.ValueComponent));
    const base = measure?.UnitComponent && api.GetLine(id, measure.UnitComponent.value);
    const baseFactor = base ? factor(base) : null;
    return Number.isFinite(value) && baseFactor ? value * baseFactor : null;
  };
  try {
    const projects = api.GetLineIDsWithType(id, WebIFC.IFCPROJECT);
    if (projects.size()) {
      const project = api.GetLine(id, projects.get(0));
      const assignment = project.UnitsInContext && api.GetLine(id, project.UnitsInContext.value);
      for (const ref of assignment?.Units ?? []) {
        const f = factor(api.GetLine(id, ref.value));
        if (f) return f;
      }
    }
  } catch { /* fall back to metres */ }
  return 1;
}

/**
 * @returns {{ model: object, geometry: { elements: Map<string, { positions: Float32Array, normals: Float32Array, indices: Uint32Array, color: number[] }> }, stats: object }}
 */
export function convertIfc(WebIFC, api, bytes, fileName = 'model.ifc') {
  // Reject anything that is not an IFC STEP file before it reaches the parser.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  if (!/^\s*ISO-10303-21\s*;/.test(head) || !/FILE_SCHEMA\s*\(\s*\(\s*'IFC/i.test(head)) {
    throw new Error('Not an IFC file (expected an IFC STEP file: ISO-10303-21 with FILE_SCHEMA IFC2X3 or IFC4). IFC-ZIP and ifcXML are not supported.');
  }
  try { api.SetLogLevel?.(WebIFC.LogLevel?.LOG_LEVEL_OFF ?? 6); } catch { /* older web-ifc */ }
  const id = api.OpenModel(bytes, { COORDINATE_TO_ORIGIN: false });
  if (id == null || id < 0) throw new Error('The file could not be read as IFC.');
  try {
    const schema = (() => { try { return api.GetModelSchema(id) || 'IFC'; } catch { return 'IFC'; } })();
    const unit = lengthUnitInMetres(WebIFC, api, id);

    // ---- geometry: one triangle soup per element (an element can have several placed geometries) ----
    const raw = new Map(); // expressID -> { parts: [{ pos, nor, idx }], color, vertices, indices }
    const collect = (mesh) => {
      const geometries = mesh.geometries;
      for (let g = 0; g < geometries.size(); g++) {
        const placed = geometries.get(g);
        const geom = api.GetGeometry(id, placed.geometryExpressID);
        const v = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
        const ix = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
        if (v.length && ix.length) {
          const m = placed.flatTransformation, n = v.length / 6;
          const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
          for (let i = 0; i < n; i++) {
            const x = v[i * 6], y = v[i * 6 + 1], z = v[i * 6 + 2], nx = v[i * 6 + 3], ny = v[i * 6 + 4], nz = v[i * 6 + 5];
            pos[i * 3] = m[0] * x + m[4] * y + m[8] * z + m[12];
            pos[i * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
            pos[i * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
            const ax = m[0] * nx + m[4] * ny + m[8] * nz, ay = m[1] * nx + m[5] * ny + m[9] * nz, az = m[2] * nx + m[6] * ny + m[10] * nz;
            const len = Math.hypot(ax, ay, az) || 1;
            nor[i * 3] = ax / len; nor[i * 3 + 1] = ay / len; nor[i * 3 + 2] = az / len;
          }
          let e = raw.get(mesh.expressID);
          if (!e) raw.set(mesh.expressID, (e = { parts: [], color: [placed.color.x, placed.color.y, placed.color.z, placed.color.w], vertices: 0, indices: 0 }));
          e.parts.push({ pos, nor, idx: new Uint32Array(ix) });
          e.vertices += n; e.indices += ix.length;
        }
        geom.delete?.();
      }
    };
    api.StreamAllMeshes(id, collect);
    // Spaces are not part of the default stream.
    try { api.StreamAllMeshesWithTypes(id, [WebIFC.IFCSPACE], (mesh) => { if (!raw.has(mesh.expressID)) collect(mesh); }); } catch { /* no spaces */ }
    if (!raw.size) throw new Error('The IFC file contains no element with geometry.');

    // ---- storeys -> decks ----
    const decks = [];
    const storeyOf = new Map(); // element expressID -> deck (IfcRelContainedInSpatialStructure)
    // Height of a placement: the z of every IfcLocalPlacement up the chain (storeys are not rotated in practice).
    const placementZ = (ref, depth = 0) => {
      if (!ref || depth > 20) return 0;
      const p = api.GetLine(id, ref.value);
      const axis = p?.RelativePlacement && api.GetLine(id, p.RelativePlacement.value);
      const point = axis?.Location && api.GetLine(id, axis.Location.value);
      const z = Number(text(point?.Coordinates?.[2]));
      return (Number.isFinite(z) ? z : 0) + placementZ(p?.PlacementRelTo, depth + 1);
    };
    try {
      const ids = api.GetLineIDsWithType(id, WebIFC.IFCBUILDINGSTOREY);
      const byExpress = new Map();
      for (let i = 0; i < ids.size(); i++) {
        const s = api.GetLine(id, ids.get(i));
        let z = null;
        try { z = placementZ(s.ObjectPlacement); } catch { /* use Elevation below */ }
        const elevation = Number(text(s.Elevation));
        const metres = z != null && (z !== 0 || !Number.isFinite(elevation)) ? z : (Number.isFinite(elevation) ? elevation : 0);
        const deck = { id: `L${String(i + 1).padStart(2, '0')}`, name: String(text(s.Name) || text(s.LongName) || `Storey ${i + 1}`), elevation: Math.round(metres * unit * 1000) };
        decks.push(deck);
        byExpress.set(ids.get(i), deck);
      }
      const rels = api.GetLineIDsWithType(id, WebIFC.IFCRELCONTAINEDINSPATIALSTRUCTURE);
      for (let i = 0; i < rels.size(); i++) {
        const r = api.GetLine(id, rels.get(i));
        const deck = byExpress.get(r.RelatingStructure?.value);
        if (deck) for (const el of r.RelatedElements ?? []) storeyOf.set(el.value, deck);
      }
    } catch { /* no storeys */ }
    decks.sort((a, b) => a.elevation - b.elevation);
    // Storeys at the same elevation (within 10 mm) are one deck.
    for (let i = decks.length - 1; i > 0; i--) {
      if (Math.abs(decks[i].elevation - decks[i - 1].elevation) >= 10) continue;
      decks[i - 1].name += ` / ${decks[i].name}`;
      for (const [el, d] of storeyOf) if (d === decks[i]) storeyOf.set(el, decks[i - 1]);
      decks.splice(i, 1);
    }

    // ---- elements ----
    const elements = [], geometry = new Map();
    const used = new Set();
    let minY = Infinity;
    const boxes = [];
    for (const [expressID, e] of raw) {
      const positions = new Float32Array(e.vertices * 3), normals = new Float32Array(e.vertices * 3), indices = new Uint32Array(e.indices);
      let vo = 0, io = 0;
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const p of e.parts) {
        positions.set(p.pos, vo * 3); normals.set(p.nor, vo * 3);
        for (let k = 0; k < p.idx.length; k++) indices[io + k] = p.idx[k] + vo;
        for (let k = 0; k < p.pos.length; k += 3) for (let a = 0; a < 3; a++) { const c = p.pos[k + a]; if (c < min[a]) min[a] = c; if (c > max[a]) max[a] = c; }
        vo += p.pos.length / 3; io += p.idx.length;
      }
      if (!min.every(Number.isFinite)) continue;
      let line = null;
      try { line = api.GetLine(id, expressID); } catch { /* keep the geometry even without attributes */ }
      const cls = line ? String(api.GetNameFromTypeCode(line.type) || '').toUpperCase() : 'IFCELEMENT';
      const type = TYPE_BY_CLASS[cls] ?? (cls.replace(/^IFC/, '').toLowerCase() || 'element');
      let elId = String(text(line?.GlobalId) || `#${expressID}`);
      if (used.has(elId)) elId = `${elId}#${expressID}`;
      used.add(elId);
      minY = Math.min(minY, min[1]);
      boxes.push({ elId, min, max });
      elements.push({
        id: elId, type, name: String(text(line?.Name) || text(line?.ObjectType) || cls.replace(/^IFC/, '')),
        source: `IFC ${cls} #${expressID}`,
        props: { ifc_class: cls, ...(text(line?.ObjectType) ? { object_type: String(text(line.ObjectType)) } : {}), ...(text(line?.Tag) ? { tag: String(text(line.Tag)) } : {}) },
        _box: { min, max },
        _express: expressID,
      });
      geometry.set(elId, { positions, normals, indices, color: e.color });
    }

    if (!decks.length) decks.push({ id: 'L01', name: 'Model', elevation: Math.round(minY * 1000) });
    // An element stands on the highest deck at or below its middle height (small tolerance for slabs).
    const deckOf = (yMid) => { let d = decks[0]; for (const k of decks) if (k.elevation / 1000 <= yMid + 0.05) d = k; return d; };
    const extent = new Map(decks.map((d) => [d.id, { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, top: d.elevation }]));
    for (const el of elements) {
      const { min, max } = el._box;
      delete el._box;
      const deck = storeyOf.get(el._express) ?? deckOf((min[1] + max[1]) / 2);
      delete el._express;
      el.deck = deck.id;
      // model x = X, model y = -Z (web-ifc), elevation = Y; z is relative to the deck.
      el.geom = {
        x: Math.round(min[0] * 1000) + 0, y: Math.round(-max[2] * 1000) + 0, z: Math.round(min[1] * 1000 - deck.elevation) + 0,
        lx: Math.max(1, Math.round((max[0] - min[0]) * 1000)), ly: Math.max(1, Math.round((max[2] - min[2]) * 1000)), h: Math.max(1, Math.round((max[1] - min[1]) * 1000)),
      };
      const ex = extent.get(deck.id);
      ex.x0 = Math.min(ex.x0, el.geom.x); ex.x1 = Math.max(ex.x1, el.geom.x + el.geom.lx);
      ex.y0 = Math.min(ex.y0, el.geom.y); ex.y1 = Math.max(ex.y1, el.geom.y + el.geom.ly);
      ex.top = Math.max(ex.top, Math.round(max[1] * 1000));
    }
    const kept = decks.filter((d) => Number.isFinite(extent.get(d.id).x0));
    kept.forEach((d, i) => {
      const ex = extent.get(d.id);
      d.height = Math.max(500, (kept[i + 1]?.elevation ?? ex.top) - d.elevation);
      d.outline = []; // IFC has no deck outline; the elements themselves show the extent
      d.source = 'IFC building storey';
    });

    const counts = {};
    for (const el of elements) counts[el.type] = (counts[el.type] || 0) + 1;
    const model = {
      name: fileName.replace(/\.ifc$/i, ''), units: 'mm', source: `IFC import (${schema})`,
      provenance_note: `Imported from ${fileName} (${schema}): ${elements.length.toLocaleString('en')} elements with geometry on ${kept.length} storey${kept.length === 1 ? '' : 's'}. Geometry, names and classes are as in the file. Properties the rules read (clear widths, sill heights, zones, ship particulars) are not part of a plain IFC export: such checks show "not enough info" until the values are added.`,
      ship: {}, decks: kept, elements,
    };
    return { model, geometry: { elements: geometry }, stats: { schema, elements: elements.length, decks: kept.length, counts, triangles: [...geometry.values()].reduce((s, g) => s + g.indices.length / 3, 0) } };
  } finally {
    try { api.CloseModel(id); } catch { /* already closed */ }
  }
}
