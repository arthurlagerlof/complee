// AutoCAD DXF (ASCII) reader and a minimal R12 writer. Pure JavaScript: runs in the browser and in Node.
//
// Reader: the HEADER variables, the LAYER table, BLOCKS and the model-space ENTITIES that carry a general
// arrangement: LWPOLYLINE, POLYLINE (+VERTEX), LINE, CIRCLE, ARC, POINT, TEXT, MTEXT and INSERT (+ATTRIB).
// Everything else is counted per type in `ignored`, never silently interpreted.
// DWG is AutoCAD's closed binary format and is not read: save the drawing as DXF (SAVEAS, or DXFOUT).

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// MTEXT formatting codes -> plain text with newlines.
export function plainMText(s) {
  return String(s)
    .replace(/\\P/g, '\n').replace(/\\~/g, ' ')
    .replace(/\\[ACFHQTWfp][^;]*;/g, '')       // \fArial|b0;  \H2.5x;  \C1; ...
    .replace(/\\S([^;]*);/g, '$1')             // stacked fractions
    .replace(/\\[LlOoKk]/g, '')                // underline / overline / strike
    .replace(/[{}]/g, '')
    .replace(/\\\\/g, '\\');
}
// %%c, %%d, %%p and \U+XXXX in TEXT.
export function plainText(s) {
  return String(s).replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±').replace(/%%[uUoO]/g, '')
    .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function parseDxf(text) {
  if (typeof text !== 'string' || !text.length) throw new Error('The file is empty.');
  if (text.startsWith('AutoCAD Binary DXF')) throw new Error('This is a binary DXF. Save it as ASCII DXF (SAVEAS > AutoCAD DXF, format ASCII).');
  if (text.startsWith('AC10') || text.charCodeAt(0) === 0) throw new Error('This is a DWG (binary) file. Save it as DXF in AutoCAD (SAVEAS > AutoCAD DXF) and open that file.');
  const lines = text.split(/\r\n|\r|\n/);
  const n = lines.length - (lines.length % 2);
  const header = {}, layers = {}, blocks = {}, entities = [], ignored = {};
  let i = 0;
  const code = (k) => parseInt(lines[k], 10);
  // Find the first SECTION (some writers put comments, code 999, in front).
  while (i < n && !(code(i) === 0 && lines[i + 1].trim() === 'SECTION')) i += 2;
  if (i >= n) throw new Error('No DXF sections found: this is not an ASCII DXF file.');

  let section = null, target = null;   // target: list new entities go to (model space or the current block)
  let current = null, owner = null;    // owner: POLYLINE collecting VERTEX / INSERT collecting ATTRIB
  let headerVar = null, table = null, block = null, layer = null;

  const finish = () => {
    const e = current;
    current = null;
    if (!e || e.type === 'BLOCK') return;
    if (e.type === 'VERTEX') {
      if (owner?.type === 'POLYLINE') { const p = e.pts[0] || [0, 0]; owner.pts.push([p[0] * (num(owner.v[230] ?? 1) < 0 ? -1 : 1), p[1]]); }
      return;
    }
    if (e.type === 'ATTRIB') { if (owner?.type === 'INSERT' && e.v[2] != null) owner.attribs[String(e.v[2]).trim().toUpperCase()] = plainText(e.v[1] ?? '').trim(); return; }
    if (e.type === 'SEQEND') { owner = null; return; }
    if (e.type === 'POLYLINE') owner = e;
    else if (e.type === 'INSERT') { e.attribs = {}; owner = num(e.v[66]) ? e : null; }
    else owner = null;
    if (num(e.v[67]) === 1) return; // paper space
    const out = shape(e);
    if (out) target.push(out); else if (target === entities) ignored[e.type] = (ignored[e.type] || 0) + 1; // model space only
  };

  for (; i < n; i += 2) {
    const c = code(i), raw = lines[i + 1], v = raw.trim();
    if (c === 0) {
      finish();
      if (v === 'SECTION') { section = (code(i + 2) === 2 ? lines[i + 3].trim() : null); i += 2; target = entities; continue; }
      if (v === 'ENDSEC') { section = null; continue; }
      if (v === 'EOF') break;
      if (section === 'HEADER') { headerVar = null; continue; }
      if (section === 'TABLES') {
        if (v === 'TABLE') { table = (code(i + 2) === 2 ? lines[i + 3].trim() : null); i += 2; layer = null; }
        else if (v === 'ENDTAB') { table = null; layer = null; }
        else if (v === 'LAYER' && table === 'LAYER') layer = { name: null, color: 7, frozen: false };
        else layer = null;
        continue;
      }
      if (section === 'BLOCKS') {
        if (v === 'BLOCK') { block = { name: null, base: [0, 0], entities: [] }; target = block.entities; current = { type: 'BLOCK', pts: [], v: {} }; continue; }
        if (v === 'ENDBLK') { if (block?.name) blocks[block.name] = block; block = null; target = entities; owner = null; continue; }
      }
      if (section === 'BLOCKS' || section === 'ENTITIES') current = { type: v, layer: '0', handle: null, pts: [], v: {} };
      continue;
    }
    if (section === 'HEADER') {
      if (c === 9) headerVar = v; else if (headerVar && header[headerVar] === undefined) header[headerVar] = v;
      continue;
    }
    if (section === 'TABLES') {
      if (!layer) continue;
      if (c === 2) { layer.name = v; layers[v] = layer; }
      else if (c === 62) { layer.color = Math.abs(num(v)); if (num(v) < 0) layer.off = true; }
      else if (c === 70) layer.frozen = (num(v) & 1) === 1;
      continue;
    }
    if (!current) continue;
    if (current.type === 'BLOCK') {
      if (c === 2) block.name = v; else if (c === 10) block.base[0] = num(v); else if (c === 20) block.base[1] = num(v);
      continue;
    }
    if (c === 8) current.layer = v;
    else if (c === 5) current.handle = v;
    else if (c === 10) current.pts.push([num(v), 0]);
    else if (c === 20) { if (current.pts.length) current.pts[current.pts.length - 1][1] = num(v); }
    else if (c === 3 && current.type === 'MTEXT') current.v[3] = (current.v[3] || '') + raw;
    else if (c === 1) current.v[1] = raw.replace(/^\s+|\s+$/g, '');
    else if (current.v[c] === undefined) current.v[c] = v;
  }
  finish();
  return { header, layers, blocks, entities, ignored };
}

// Raw entity -> the small set of shapes the importer uses. Entities drawn in a mirrored object coordinate system
// (extrusion direction 0,0,-1) have their x negated, as AutoCAD displays them.
function shape(e) {
  const flip = num(e.v[230] ?? 1) < 0 ? -1 : 1;
  const P = (p) => [p[0] * flip, p[1]];
  const base = { layer: e.layer, handle: e.handle };
  const thickness = e.v[39] !== undefined ? Math.abs(num(e.v[39])) : null;
  switch (e.type) {
    case 'LWPOLYLINE': case 'POLYLINE': {
      if (e.type === 'POLYLINE' && (num(e.v[70]) & (16 | 64))) return null; // 3D mesh / polyface
      const pts = e.pts.map(P);
      // POLYLINE: the first 10/20/30 is a dummy point; its 30 is the elevation. VERTEX points are appended later.
      const out = { kind: 'polygon', ...base, points: pts, closed: (num(e.v[70]) & 1) === 1, thickness,
        elevation: e.type === 'LWPOLYLINE' ? num(e.v[38] ?? 0) : num(e.v[30] ?? 0), bulged: e.v[42] !== undefined && num(e.v[42]) !== 0 };
      if (e.type === 'POLYLINE') { out.points = []; e.pts = out.points; }
      return out;
    }
    case 'LINE': return { kind: 'line', ...base, points: [P(e.pts[0] || [0, 0]), [num(e.v[11]) * flip, num(e.v[21])]] };
    case 'CIRCLE': return { kind: 'circle', ...base, at: P(e.pts[0] || [0, 0]), r: num(e.v[40]) };
    case 'ARC': return { kind: 'arc', ...base, at: P(e.pts[0] || [0, 0]), r: num(e.v[40]), a0: num(e.v[50]), a1: num(e.v[51]), flip };
    case 'POINT': return { kind: 'point', ...base, at: P(e.pts[0] || [0, 0]) };
    case 'TEXT': return { kind: 'text', ...base, at: P(e.pts[0] || [0, 0]), text: plainText(e.v[1] ?? '') };
    case 'MTEXT': return { kind: 'text', ...base, at: P(e.pts[0] || [0, 0]), text: plainMText((e.v[3] || '') + (e.v[1] ?? '')) };
    case 'INSERT': return { kind: 'insert', ...base, name: e.v[2], at: P(e.pts[0] || [0, 0]), sx: num(e.v[41] ?? 1) * flip, sy: num(e.v[42] ?? 1),
      rotation: num(e.v[50] ?? 0), thickness, get attribs() { return e.attribs || {}; } };
    default: return null;
  }
}

// Bounding box [x0, y0, x1, y1] of a shape, or null. Arcs use their real extent, not the full circle.
export function shapeBox(s, blocks = {}, depth = 0) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x, y) => { if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y; };
  if (s.kind === 'polygon' || s.kind === 'line') for (const [x, y] of s.points) add(x, y);
  else if (s.kind === 'circle') { add(s.at[0] - s.r, s.at[1] - s.r); add(s.at[0] + s.r, s.at[1] + s.r); }
  else if (s.kind === 'arc') {
    const rad = (d) => (d * Math.PI) / 180;
    let a0 = s.a0, a1 = s.a1;
    while (a1 < a0) a1 += 360;
    const pt = (a) => add(s.at[0] + s.r * Math.cos(rad(a)) * s.flip, s.at[1] + s.r * Math.sin(rad(a)));
    pt(a0); pt(a1);
    for (let q = Math.ceil(a0 / 90) * 90; q <= a1; q += 90) pt(q);
  } else if (s.kind === 'insert') {
    const b = blocks[s.name];
    if (!b || depth > 4) return null;
    const inner = [Infinity, Infinity, -Infinity, -Infinity];
    for (const child of b.entities) {
      const cb = shapeBox(child, blocks, depth + 1);
      if (!cb) continue;
      inner[0] = Math.min(inner[0], cb[0]); inner[1] = Math.min(inner[1], cb[1]); inner[2] = Math.max(inner[2], cb[2]); inner[3] = Math.max(inner[3], cb[3]);
    }
    if (inner[0] === Infinity) return null;
    const r = (s.rotation * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
    for (const [x, y] of [[inner[0], inner[1]], [inner[2], inner[1]], [inner[2], inner[3]], [inner[0], inner[3]]]) {
      const lx = (x - b.base[0]) * s.sx, ly = (y - b.base[1]) * s.sy;
      add(s.at[0] + lx * cos - ly * sin, s.at[1] + lx * sin + ly * cos);
    }
  } else return null;
  return box[0] === Infinity ? null : box;
}

// ---------- writer: DXF R12 (AC1009), the version every AutoCAD release and viewer reads ----------

const pair = (c, v) => `${String(c).padStart(3, ' ')}\n${v}\n`;
const coord = (v) => (Math.round(v * 1e4) / 1e4).toString();
// R12 text is ASCII: other characters are written as \U+XXXX, which AutoCAD displays as the character.
const ASCII_SIGNS = { '≥': '>=', '≤': '<=', '×': 'x', '·': '-', '–': '-', '—': '-', '…': '...', '′': "'", '″': '"' };
export const dxfText = (s) => String(s).replace(/[\r\n]+/g, ' ').replace(/[≥≤×·–—…′″]/g, (ch) => ASCII_SIGNS[ch]).replace(/[^\x20-\x7e]/g, (ch) => `\\U+${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
export const dxfLayerName = (s) => String(s).toUpperCase().replace(/[^A-Z0-9_$-]+/g, '_').slice(0, 31) || 'LAYER';

/** layers: [{ name, color }] (AutoCAD colour index); entities: { type: 'rect' | 'text' | 'line', layer, ... }. */
export function writeDxf({ layers, entities }) {
  let out = pair(0, 'SECTION') + pair(2, 'HEADER') + pair(9, '$ACADVER') + pair(1, 'AC1009') + pair(0, 'ENDSEC');
  out += pair(0, 'SECTION') + pair(2, 'TABLES');
  out += pair(0, 'TABLE') + pair(2, 'LTYPE') + pair(70, 1) + pair(0, 'LTYPE') + pair(2, 'CONTINUOUS') + pair(70, 0) + pair(3, 'Solid line') + pair(72, 65) + pair(73, 0) + pair(40, '0.0') + pair(0, 'ENDTAB');
  out += pair(0, 'TABLE') + pair(2, 'LAYER') + pair(70, layers.length);
  for (const l of layers) out += pair(0, 'LAYER') + pair(2, l.name) + pair(70, 0) + pair(62, l.color) + pair(6, 'CONTINUOUS');
  out += pair(0, 'ENDTAB') + pair(0, 'ENDSEC') + pair(0, 'SECTION') + pair(2, 'ENTITIES');
  for (const e of entities) {
    if (e.type === 'rect') {
      const [x0, y0, x1, y1] = e.box;
      out += pair(0, 'POLYLINE') + pair(8, e.layer) + pair(66, 1) + pair(70, 1) + pair(10, '0.0') + pair(20, '0.0') + pair(30, '0.0');
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) out += pair(0, 'VERTEX') + pair(8, e.layer) + pair(10, coord(x)) + pair(20, coord(y)) + pair(30, '0.0');
      out += pair(0, 'SEQEND') + pair(8, e.layer);
    } else if (e.type === 'line') {
      out += pair(0, 'LINE') + pair(8, e.layer) + pair(10, coord(e.from[0])) + pair(20, coord(e.from[1])) + pair(30, '0.0') + pair(11, coord(e.to[0])) + pair(21, coord(e.to[1])) + pair(31, '0.0');
    } else if (e.type === 'text') {
      out += pair(0, 'TEXT') + pair(8, e.layer) + pair(10, coord(e.at[0])) + pair(20, coord(e.at[1])) + pair(30, '0.0') + pair(40, coord(e.height)) + pair(1, dxfText(e.text));
    }
  }
  return out + pair(0, 'ENDSEC') + pair(0, 'EOF');
}
