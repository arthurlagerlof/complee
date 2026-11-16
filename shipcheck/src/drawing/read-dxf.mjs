// Any ASCII DXF -> Sheet (CONTRACT.md section 1). Unlike src/autocad.mjs, which imports drawings made to the
// Complee layer convention, this reader takes every visible model-space entity of any drawing, so the later
// stages can find the views on it. Blocks are expanded with their full transform; what cannot be drawn is counted in
// the warnings, never dropped silently.

import { readDxfGroups, plainText, plainMText } from '../dxf.mjs';
import {
  makeSheet, addPath, addText, finishSheet, tessellateSweep, normDeg, arcSegments,
  mul, apply, scaleOf, transformArc, IDENTITY,
} from './sheet.mjs';

const DEG = Math.PI / 180;
const MAX_DEPTH = 8;
const MAX_MINSERT = 10000;
const UNITS = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm' };
const MM_PER = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };

// ---------- record access ----------

const num = (s, d = 0) => { const n = parseFloat(s); return Number.isFinite(n) ? n : d; };
function first(rec, code) { const i = rec.c.indexOf(code); return i < 0 ? undefined : rec.v[i]; }
const getNum = (rec, code, d = 0) => num(first(rec, code), d);
function all(rec, code) { const out = []; for (let i = 0; i < rec.c.length; i++) if (rec.c[i] === code) out.push(num(rec.v[i])); return out; }
// Points from paired codes (10/20, 11/21 …) in file order.
function points(rec, cx, cy) {
  const out = [];
  for (let i = 0; i < rec.c.length; i++) {
    if (rec.c[i] === cx) out.push([num(rec.v[i]), 0]);
    else if (rec.c[i] === cy && out.length) out[out.length - 1][1] = num(rec.v[i]);
  }
  return out;
}
const pt = (rec, cx, cy, d = [0, 0]) => (first(rec, cx) === undefined ? d : [getNum(rec, cx), getNum(rec, cy)]);

// ---------- colours ----------

const ACI_BASE = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 7: '#000000', 8: '#808080', 9: '#c0c0c0' };
const ACI_GREY = { 250: '#333333', 251: '#505050', 252: '#696969', 253: '#828282', 254: '#bebebe', 255: '#ffffff' };
const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');

/**
 * AutoCAD Color Index -> #rrggbb. 7 (white on a dark screen, black on paper) is the foreground colour and maps to
 * black, as on a plotted sheet. 10–249 follow the ACI wheel: 24 hues of 15°, five brightness steps, even indices
 * saturated, odd ones pastel.
 */
export function aciColor(i) {
  i = Math.abs(i | 0);
  if (ACI_BASE[i]) return ACI_BASE[i];
  if (ACI_GREY[i]) return ACI_GREY[i];
  if (i < 10 || i > 249) return null;
  const hue = Math.floor((i - 10) / 10) * 15, k = (i - 10) % 10;
  const value = [1, 1, 0.8, 0.8, 0.6, 0.6, 0.5, 0.5, 0.3, 0.3][k], sat = k % 2 ? 0.5 : 1;
  const f = (n) => { const h = (n + hue / 60) % 6; return value * (1 - sat * Math.max(0, Math.min(1, Math.min(h, 4 - h)))); };
  return `#${hex2(f(5) * 255)}${hex2(f(3) * 255)}${hex2(f(1) * 255)}`;
}
const trueColor = (v) => `#${(Number(v) & 0xffffff).toString(16).padStart(6, '0')}`;

// ---------- tables ----------

function readLayers(tables) {
  const layers = new Map();
  for (const r of tables.LAYER || []) {
    const name = first(r, 2);
    if (name == null) continue;
    const aci = getNum(r, 62, 7), tc = first(r, 420);
    layers.set(name, {
      name,
      color: tc !== undefined ? trueColor(tc) : aciColor(aci) ?? '#000000',
      off: aci < 0,
      frozen: (getNum(r, 70) & 1) === 1,
      ltype: first(r, 6) || 'CONTINUOUS',
      lw: getNum(r, 370, -3),
    });
  }
  return layers;
}

// A linetype with dash elements (a gap among its 49 codes, or more than one element) is dashed; CONTINUOUS is not.
function readLinetypes(tables) {
  const dashed = new Map();
  for (const r of tables.LTYPE || []) {
    const name = first(r, 2);
    if (name == null) continue;
    const els = all(r, 49);
    dashed.set(name.toUpperCase(), els.some((e) => e < 0) || els.length > 1);
  }
  return dashed;
}
const DASH_NAME = /DASH|HIDDEN|CENT(ER|RE)|PHANTOM|DOT|DIVIDE|BORDER|ACAD_ISO0[2-9]|ACAD_ISO1/i;

// ---------- geometry helpers ----------

/** Arc of a polyline bulge from a to b: { c, r, start (deg), sweep (deg, + = counter-clockwise) }. */
export function bulgeArc(a, b, bulge) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  if (!(L > 0)) return null;
  const off = (L / 2) * (1 - bulge * bulge) / (2 * bulge); // signed distance of the centre left of the chord
  const c = [(a[0] + b[0]) / 2 - (dy / L) * off, (a[1] + b[1]) / 2 + (dx / L) * off];
  return { c, r: Math.hypot(a[0] - c[0], a[1] - c[1]), start: Math.atan2(a[1] - c[1], a[0] - c[0]) / DEG, sweep: (4 * Math.atan(bulge)) / DEG };
}

/**
 * Polyline vertices [{ x, y, b }] -> { pts, arc }. Bulged segments become true arcs; when every segment is a bulge
 * on the same circle (a lone swing arc, a circle drawn as a two-vertex polyline) the result carries `arc`.
 */
function polylinePoints(verts, closed) {
  const pts = [];
  if (!verts.length) return { pts, arc: null };
  pts.push([verts[0].x, verts[0].y]);
  const nseg = closed ? verts.length : verts.length - 1;
  let circle = null, sweepSum = 0, allArcs = nseg > 0;
  for (let i = 0; i < nseg; i++) {
    const a = verts[i], b = verts[(i + 1) % verts.length];
    const arc = a.b ? bulgeArc([a.x, a.y], [b.x, b.y], a.b) : null;
    if (!arc) { allArcs = false; if (!(closed && i === nseg - 1)) pts.push([b.x, b.y]); continue; }
    const seg = tessellateSweep(arc.c, arc.r, arc.start, arc.sweep);
    for (let k = 1; k < seg.length; k++) pts.push(seg[k]);
    if (closed && i === nseg - 1) pts.pop(); // the closing point repeats the first vertex
    if (!circle) { circle = { ...arc }; sweepSum = arc.sweep; }
    else if (Math.hypot(arc.c[0] - circle.c[0], arc.c[1] - circle.c[1]) <= 1e-6 * circle.r && Math.abs(arc.r - circle.r) <= 1e-6 * circle.r
      && Math.sign(arc.sweep) === Math.sign(sweepSum)) sweepSum += arc.sweep;
    else allArcs = false;
  }
  if (!allArcs || !circle) return { pts, arc: null };
  if (Math.abs(sweepSum) >= 359.999) return { pts, arc: { c: circle.c, r: circle.r, a0: 0, a1: 360 } };
  const s = normDeg(circle.start), e = normDeg(circle.start + sweepSum);
  return { pts, arc: { c: circle.c, r: circle.r, a0: sweepSum > 0 ? s : e, a1: sweepSum > 0 ? e : s } };
}

/** NURBS curve points by de Boor (degree p, knots, control points, optional weights), n samples. */
export function nurbsPoints(p, knots, ctrl, weights, n) {
  const m = ctrl.length;
  if (m < p + 1 || knots.length !== m + p + 1) return null;
  const t0 = knots[p], t1 = knots[m];
  if (!(t1 > t0)) return null;
  const w = weights && weights.length === m ? weights : null;
  const out = [];
  for (let s = 0; s <= n; s++) {
    const t = s === n ? t1 : t0 + ((t1 - t0) * s) / n;
    let k = p;
    while (k < m - 1 && knots[k + 1] <= t) k++;
    const d = [];
    for (let j = 0; j <= p; j++) {
      const q = ctrl[k - p + j], wt = w ? w[k - p + j] : 1;
      d.push([q[0] * wt, q[1] * wt, wt]);
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = k - p + j, den = knots[i + p + 1 - r] - knots[i];
        const a = den > 0 ? (t - knots[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1], (1 - a) * d[j - 1][2] + a * d[j][2]];
      }
    }
    out.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
  }
  return out;
}

/** Points of an ellipse: centre, major-axis vector, minor/major ratio, parameter range (radians). */
function ellipsePoints(c, major, ratio, t0, t1) {
  if (t1 <= t0) t1 += 2 * Math.PI;
  const n = Math.max(4, arcSegments((t1 - t0) / DEG));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n, ct = Math.cos(t), st = Math.sin(t) * ratio;
    out.push([c[0] + ct * major[0] - st * major[1], c[1] + ct * major[1] + st * major[0]]);
  }
  return out;
}

// ---------- the reader ----------

/** readDxf(text, { file }) -> Sheet. Throws only when the file is not an ASCII DXF at all. */
export function readDxf(text, { file = null } = {}) {
  const g = readDxfGroups(text);
  const code = Math.round(num(g.header.$INSUNITS?.find(([c]) => c === 70)?.[1], 0));
  const unit = UNITS[code] || 'mm';
  const sheet = makeSheet({ file, format: 'dxf', unit, unitStated: !!UNITS[code], paper: false });
  if (!UNITS[code]) sheet.warnings.push(code ? `The drawing unit ($INSUNITS = ${code}) is not one of mm, cm, m, in, ft: millimetres are assumed.` : 'The file does not state its unit ($INSUNITS): millimetres are assumed.');
  if (!g.complete) sheet.warnings.push('The file ends early (no EOF marker): it may be cut off; what was read is shown.');

  const r = new Reader(g, sheet, MM_PER[unit]);
  const top = { m: IDENTITY, layer: null, color: '#000000', dash: false, lw: 0, block: null, depth: 0, stack: [] };
  let paperSpace = 0;
  r.drawList(g.entities.filter((e) => { if (getNum(e, 67) === 1) { paperSpace++; return false; } return true; }), top);
  r.summarise(paperSpace);
  return finishSheet(sheet);
}

class Reader {
  constructor(g, sheet, mmPerUnit) {
    this.g = g;
    this.sheet = sheet;
    this.mmPerUnit = mmPerUnit;
    this.layers = readLayers(g.tables);
    this.ltypes = readLinetypes(g.tables);
    this.blocks = new Map(g.blocks.map((b) => [b.name, b]));
    this.hidden = new Map();  // layer -> entities skipped (frozen / off)
    this.ignored = new Map(); // entity type -> count
    this.missing = new Set(); this.xrefs = new Set();
    this.tooDeep = 0; this.cycles = 0; this.invisible = 0;
    const h = g.header;
    const hv = (name, d) => num(h[name]?.[0]?.[1], d);
    this.dimText = hv('$DIMTXT', 2.5) * (hv('$DIMSCALE', 1) || 1);
    this.dimDec = Math.max(0, Math.min(4, Math.round(hv('$DIMDEC', 2))));
  }

  layer(name) {
    return this.layers.get(name) || { name, color: '#000000', off: false, frozen: false, ltype: 'CONTINUOUS', lw: -3 };
  }

  // Effective properties of an entity in a context: layer 0 in a block takes the insert's layer; BYBLOCK takes
  // the insert's colour / linetype / lineweight, BYLAYER the layer's.
  style(e, ctx) {
    const own = e.layer ?? first(e, 8) ?? '0';
    const layerName = own === '0' && ctx.layer ? ctx.layer : own;
    const L = this.layer(layerName);
    const tc = first(e, 420), aci = first(e, 62);
    let color;
    if (tc !== undefined) color = trueColor(tc);
    else if (aci === undefined || num(aci) === 256) color = own === '0' && ctx.layer ? ctx.color : L.color;
    else if (num(aci) === 0) color = ctx.color;
    else color = aciColor(num(aci)) ?? L.color;
    const lt = (first(e, 6) || 'BYLAYER').toUpperCase();
    let dash;
    if (lt === 'BYBLOCK') dash = ctx.dash;
    else if (lt === 'BYLAYER') dash = own === '0' && ctx.layer ? ctx.dash : this.isDashed(L.ltype);
    else dash = this.isDashed(lt);
    const lwRaw = getNum(e, 370, -1);
    let lw = lwRaw === -1 ? (L.lw >= 0 ? L.lw / 100 / this.mmPerUnit : 0) : lwRaw === -2 ? ctx.lw : lwRaw >= 0 ? lwRaw / 100 / this.mmPerUnit : 0;
    if (lwRaw === -1 && own === '0' && ctx.layer) lw = ctx.lw;
    return { layer: layerName, L, color, dash, lw };
  }
  isDashed(name) {
    const n = String(name || '').toUpperCase();
    if (!n || n === 'CONTINUOUS' || n === 'BYBLOCK' || n === 'BYLAYER') return false;
    return this.ltypes.has(n) ? this.ltypes.get(n) : DASH_NAME.test(n);
  }

  drawList(list, ctx) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.type === 'POLYLINE' || e.type === 'INSERT') {
        // Followers: VERTEX records of a POLYLINE, ATTRIB records of an INSERT, closed by SEQEND.
        const want = e.type === 'POLYLINE' ? 'VERTEX' : 'ATTRIB';
        const followers = [];
        let j = i + 1;
        while (j < list.length && list[j].type === want) followers.push(list[j++]);
        if (list[j]?.type === 'SEQEND') j++;
        i = j - 1;
        this.entity(e, ctx, followers);
        continue;
      }
      if (e.type === 'VERTEX' || e.type === 'SEQEND' || e.type === 'ATTRIB' || e.type === 'ATTDEF') continue;
      this.entity(e, ctx, null);
    }
  }

  entity(e, ctx, followers) {
    const st = this.style(e, ctx);
    if (st.L.frozen || st.L.off) { this.hidden.set(st.layer, (this.hidden.get(st.layer) || 0) + 1); return; }
    if (getNum(e, 60) === 1) { this.invisible++; return; }
    // Entities drawn in a mirrored object coordinate system (extrusion 0,0,-1) show with x negated.
    const m = getNum(e, 230, 1) < 0 ? mul(ctx.m, [-1, 0, 0, 1, 0, 0]) : ctx.m;
    const props = { layer: st.layer, color: st.color, dash: st.dash, width: st.lw, block: ctx.block };
    const out = (pts, extra = {}, arc = null) => {
      if (!pts || pts.length === 0) return;
      const tpts = pts.map((p) => apply(m, p[0], p[1]));
      const a = arc ? transformArc(arc, m) : null;
      addPath(this.sheet, tpts, { ...props, ...extra, ...(a ? { arc: a } : {}) });
    };
    switch (e.type) {
      case 'LINE': return out([pt(e, 10, 20), pt(e, 11, 21)]);
      case 'CIRCLE': {
        const c = pt(e, 10, 20), r = getNum(e, 40);
        if (!(r > 0)) return;
        return out(tessellateSweep(c, r, 0, 360).slice(0, -1), { closed: true }, { c, r, a0: 0, a1: 360 });
      }
      case 'ARC': {
        const c = pt(e, 10, 20), r = getNum(e, 40), a0 = normDeg(getNum(e, 50)), a1 = normDeg(getNum(e, 51));
        if (!(r > 0)) return;
        const sweep = ((a1 - a0) % 360 + 360) % 360 || 360;
        return out(tessellateSweep(c, r, a0, sweep), {}, { c, r, a0, a1 });
      }
      case 'LWPOLYLINE': return this.lwpolyline(e, out, scaleOf(m));
      case 'POLYLINE': return this.polyline(e, followers || [], out, scaleOf(m));
      case 'SPLINE': return out(this.spline(e), { closed: (getNum(e, 70) & 1) === 1 });
      case 'ELLIPSE': return this.ellipse(e, out);
      case 'SOLID': case 'TRACE': {
        const q = [pt(e, 10, 20), pt(e, 11, 21), pt(e, 13, 23, pt(e, 12, 22)), pt(e, 12, 22)];
        // Corner order is 1-2-4-3 (a "Z"); a triangle repeats the third corner.
        const poly = q[2][0] === q[3][0] && q[2][1] === q[3][1] ? [q[0], q[1], q[3]] : q;
        return out(poly, { closed: true, fill: true, stroke: false });
      }
      case 'HATCH':
        for (const loop of this.hatchLoops(e)) out(loop, { closed: true, fill: true, stroke: false });
        return;
      case 'LEADER': return out(points(e, 10, 20));
      case 'TEXT': case 'ATTRIB': return this.text(e, m, st);
      case 'MTEXT': return this.mtext(e, m, st);
      case 'DIMENSION': return this.dimension(e, ctx, m, st);
      case 'INSERT': return this.insert(e, ctx, st, followers || []);
      default: this.ignored.set(e.type, (this.ignored.get(e.type) || 0) + 1);
    }
  }

  // ----- polylines -----
  lwpolyline(e, out, scale) {
    const verts = [];
    let wmax = 0;
    for (let i = 0; i < e.c.length; i++) {
      const c = e.c[i], v = e.v[i];
      if (c === 10) verts.push({ x: num(v), y: 0, b: 0 });
      else if (!verts.length) continue;
      else if (c === 20) verts[verts.length - 1].y = num(v);
      else if (c === 42) verts[verts.length - 1].b = num(v);
      else if (c === 40 || c === 41) wmax = Math.max(wmax, num(v));
    }
    const closed = (getNum(e, 70) & 1) === 1;
    const width = Math.max(getNum(e, 43), wmax) * scale;
    const { pts, arc } = polylinePoints(verts, closed);
    const extra = { closed };
    if (width > 0) extra.width = width;
    out(pts, extra, arc);
  }
  polyline(e, vertexRecs, out, scale) {
    const flags = getNum(e, 70);
    if (flags & (16 | 64)) { this.ignored.set('POLYLINE (3D mesh / polyface)', (this.ignored.get('POLYLINE (3D mesh / polyface)') || 0) + 1); return; }
    let wmax = Math.max(getNum(e, 40), getNum(e, 41));
    const verts = [];
    for (const v of vertexRecs) {
      if (getNum(v, 70) & 16) continue; // spline frame control point: not on the curve
      verts.push({ x: getNum(v, 10), y: getNum(v, 20), b: getNum(v, 42) });
      wmax = Math.max(wmax, getNum(v, 40), getNum(v, 41));
    }
    const closed = (flags & 1) === 1;
    const { pts, arc } = polylinePoints(verts, closed);
    const extra = { closed };
    if (wmax > 0) extra.width = wmax * scale;
    out(pts, extra, arc);
  }

  // ----- curves -----
  spline(e) {
    const p = Math.max(1, Math.round(getNum(e, 71, 3)));
    const knots = all(e, 40), weights = all(e, 41), ctrl = points(e, 10, 20), fit = points(e, 11, 21);
    const n = Math.max(16, Math.min(512, ctrl.length * 8));
    return nurbsPoints(p, knots, ctrl, weights, n) || (fit.length >= 2 ? fit : ctrl);
  }
  ellipse(e, out) {
    const c = pt(e, 10, 20), major = pt(e, 11, 21), ratio = getNum(e, 40, 1);
    const t0 = getNum(e, 41, 0), t1 = getNum(e, 42, 2 * Math.PI);
    const pts = ellipsePoints(c, major, ratio, t0, t1);
    const full = Math.abs((t1 - t0) - 2 * Math.PI) < 1e-6 || Math.abs(t1 - t0) < 1e-9;
    let arc = null;
    if (Math.abs(ratio - 1) < 1e-6) {
      const r = Math.hypot(major[0], major[1]), rot = Math.atan2(major[1], major[0]) / DEG;
      arc = full ? { c, r, a0: 0, a1: 360 } : { c, r, a0: normDeg(rot + t0 / DEG), a1: normDeg(rot + t1 / DEG) };
    }
    out(full ? pts.slice(0, -1) : pts, { closed: full }, arc);
  }

  // ----- hatch boundary paths (the pattern lines are not drawn: the fill flag says what they mean) -----
  hatchLoops(e) {
    const C = e.c, V = e.v, loops = [];
    let k = C.indexOf(91);
    if (k < 0) return loops;
    const nLoops = num(V[k]); k++;
    // Next value of `code`, skipping at most a few unexpected codes (z values, subclass markers).
    const take = (code, d = 0) => {
      for (let s = k; s < Math.min(C.length, k + 6); s++) if (C[s] === code) { k = s + 1; return num(V[s]); }
      return d;
    };
    for (let l = 0; l < nLoops && k < C.length; l++) {
      const flags = take(92);
      const pts = [];
      const push = (seg) => { for (let i = pts.length ? 1 : 0; i < seg.length; i++) pts.push(seg[i]); };
      if (flags & 2) {
        const hasBulge = take(72); take(73); const nv = take(93); // 73 "closed": a boundary is closed anyway
        const verts = [];
        for (let i = 0; i < nv; i++) {
          const x = take(10), y = take(20), b = hasBulge && C[k] === 42 ? take(42) : 0;
          verts.push({ x, y, b });
        }
        push(polylinePoints(verts, true).pts);
      } else {
        const ne = take(93);
        for (let i = 0; i < ne; i++) {
          const type = take(72);
          if (type === 1) push([[take(10), take(20)], [take(11), take(21)]]);
          else if (type === 2) {
            const c = [take(10), take(20)], r = take(40), a0 = take(50), a1 = take(51), ccw = take(73, 1);
            // Clockwise edges store mirrored angles.
            const s = ccw ? a0 : -a0, en = ccw ? a1 : -a1;
            let sweep = en - s;
            if (ccw) { while (sweep <= 0) sweep += 360; } else { while (sweep >= 0) sweep -= 360; }
            push(tessellateSweep(c, r, s, sweep));
          } else if (type === 3) {
            const c = [take(10), take(20)], major = [take(11), take(21)], ratio = take(40), a0 = take(50) * DEG, a1 = take(51) * DEG, ccw = take(73, 1);
            // Clockwise: from -a0 down to -a1, i.e. the counter-clockwise run -a1 … -a0 walked backwards.
            push(ccw ? ellipsePoints(c, major, ratio, a0, a1) : ellipsePoints(c, major, ratio, -a1, -a0).reverse());
          } else if (type === 4) {
            const deg = take(94), rational = take(73); take(74);
            const nk = take(95), nc = take(96);
            const knots = [], ctrl = [], w = [];
            for (let q = 0; q < nk; q++) knots.push(take(40));
            for (let q = 0; q < nc; q++) { ctrl.push([take(10), take(20)]); if (rational && C[k] === 42) w.push(take(42)); }
            const fit = [];
            if (C[k] === 97 && [11, 12, 97, 72].includes(C[k + 1])) {
              const nf = take(97);
              for (let q = 0; q < nf; q++) fit.push([take(11), take(21)]);
              if (C[k] === 12) { take(12); take(22); }
              if (C[k] === 13) { take(13); take(23); }
            }
            push(nurbsPoints(deg, knots, ctrl, w.length ? w : null, Math.max(16, nc * 8)) || (fit.length ? fit : ctrl));
          } else break; // unknown edge type: the rest of this loop cannot be parsed reliably
        }
      }
      const ns = C[k] === 97 ? take(97) : 0;
      for (let q = 0; q < ns; q++) take(330);
      if (pts.length > 2) {
        const a = pts[0], b = pts[pts.length - 1];
        if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) pts.pop();
        loops.push(pts);
      }
    }
    return loops;
  }

  // ----- text -----
  // Emit a text whose local frame is: baseline start `at`, direction `angle` (deg), `height`, advance `width`,
  // `lines` lines; transformed by m (a block insert can rotate, scale or mirror it).
  emitText(str, at, angle, height, width, lines, m, st, extra = {}) {
    if (!str || !str.trim()) return;
    const c = Math.cos(angle * DEG), s = Math.sin(angle * DEG);
    const down = (lines - 1) * height * 1.5 + 0.2 * height;
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [u, v] of [[0, -down], [width, -down], [width, height], [0, height]]) {
      const [x, y] = apply(m, at[0] + u * c - v * s, at[1] + u * s + v * c);
      if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
    }
    const p = apply(m, at[0], at[1]);
    const d = [m[0] * c + m[2] * s, m[1] * c + m[3] * s];          // baseline direction after m
    const up = [-(m[0] * s) + m[2] * c, -(m[1] * s) + m[3] * c];   // up direction after m
    addText(this.sheet, { text: str, at: p, height: height * Math.hypot(up[0], up[1]), angle: normDeg(Math.atan2(d[1], d[0]) / DEG), layer: st.layer, box, ...extra });
  }

  text(e, m, st) {
    if (e.type === 'ATTRIB' && (getNum(e, 70) & 1)) return; // invisible attribute
    const str = plainText(first(e, 1) ?? '').trim();
    const h = getNum(e, 40, 1), wf = getNum(e, 41, 1) || 1;
    let angle = getNum(e, 50), at = pt(e, 10, 20);
    const hj = getNum(e, 72), vj = getNum(e, e.type === 'ATTRIB' ? 74 : 73);
    let width = str.length * h * 0.6 * wf;
    if (hj || vj) {
      const p2 = pt(e, 11, 21, at);
      if (hj === 3 || hj === 5) { // aligned / fit: the text runs from the first to the second point
        width = Math.hypot(p2[0] - at[0], p2[1] - at[1]) || width;
        if (width > 0 && (p2[0] !== at[0] || p2[1] !== at[1])) angle = Math.atan2(p2[1] - at[1], p2[0] - at[0]) / DEG;
      } else {
        const dx = hj === 1 || hj === 4 ? -width / 2 : hj === 2 ? -width : 0;
        const dy = hj === 4 || vj === 2 ? -h / 2 : vj === 3 ? -h : vj === 1 ? 0.2 * h : 0;
        const c = Math.cos(angle * DEG), s = Math.sin(angle * DEG);
        at = [p2[0] + dx * c - dy * s, p2[1] + dx * s + dy * c];
      }
    }
    this.emitText(str, at, angle, h, width, 1, m, st);
  }

  mtext(e, m, st) {
    const raw = e.c.reduce((acc, c, i) => (c === 3 ? acc + e.v[i] : acc), '') + (first(e, 1) ?? '');
    const str = plainMText(raw).replace(/\s+$/, '');
    const lines = str.split('\n');
    const h = getNum(e, 40, 1);
    const width = Math.max(...lines.map((l) => l.length)) * h * 0.6;
    let angle = getNum(e, 50) / DEG; // MTEXT rotation is in radians
    if (first(e, 11) !== undefined) angle = Math.atan2(getNum(e, 21), getNum(e, 11)) / DEG; // x-axis direction wins
    const att = Math.max(1, Math.min(9, getNum(e, 71, 1)));
    const col = (att - 1) % 3, row = Math.floor((att - 1) / 3);
    const total = h * (1 + 1.5 * (lines.length - 1));
    const dx = -col * width / 2, dy = row * total / 2 - h;
    const c = Math.cos(angle * DEG), s = Math.sin(angle * DEG), p = pt(e, 10, 20);
    this.emitText(str, [p[0] + dx * c - dy * s, p[1] + dx * s + dy * c], angle, h, width, lines.length, m, st);
  }

  // ----- dimensions: the *D block's lines, and one text with the measured value -----
  dimension(e, ctx, m, st) {
    const name = first(e, 2);
    const block = name && this.blocks.get(name);
    let h = this.dimText, angle = getNum(e, 53, 0);
    if (block) {
      const t = block.entities.find((x) => x.type === 'MTEXT' || x.type === 'TEXT');
      if (t) { h = getNum(t, 40, h); angle = t.type === 'MTEXT' ? (first(t, 11) !== undefined ? Math.atan2(getNum(t, 21), getNum(t, 11)) / DEG : getNum(t, 50) / DEG) : getNum(t, 50); }
      const child = { ...ctx, m, layer: st.layer, color: st.color, dash: false, lw: st.lw, block: name, depth: ctx.depth + 1 };
      this.drawList(block.entities.filter((x) => x.type !== 'MTEXT' && x.type !== 'TEXT'), child);
    }
    const type = getNum(e, 70) & 7;
    let value = getNum(e, 42, NaN);
    let shown = '';
    if (Number.isFinite(value)) {
      if (type === 2 || type === 5) shown = `${+(value / DEG).toFixed(this.dimDec)}°`;
      else shown = `${type === 3 ? 'Ø' : type === 4 ? 'R' : ''}${+value.toFixed(this.dimDec)}`;
    } else value = null;
    const over = plainMText(first(e, 1) ?? '').trim();
    const rawOver = first(e, 1);
    let str;
    if (rawOver === ' ') return; // a single space suppresses the dimension text
    if (!over || over === '<>') str = shown;
    else str = over.includes('<>') ? over.replace('<>', shown) : over;
    if (!str) return;
    const mid = pt(e, 11, 21, pt(e, 10, 20));
    const w = str.length * h * 0.6, c = Math.cos(angle * DEG), s = Math.sin(angle * DEG);
    const at = [mid[0] - (w / 2) * c + (h / 2) * s, mid[1] - (w / 2) * s - (h / 2) * c];
    this.emitText(str, at, angle, h, w, 1, m, st, { measure: value, dimension: true });
  }

  // ----- block references -----
  insert(e, ctx, st, attribs) {
    const name = first(e, 2);
    const block = this.blocks.get(name);
    if (!block) this.missing.add(name);
    else if (block.flags & 4) this.xrefs.add(name);
    else if (ctx.depth >= MAX_DEPTH) this.tooDeep++;
    else if (ctx.stack.includes(name)) this.cycles++;
    else {
      const P = pt(e, 10, 20), sx = getNum(e, 41, 1), sy = getNum(e, 42, 1), rot = getNum(e, 50) * DEG;
      const cols = Math.max(1, getNum(e, 70, 1)), rows = Math.max(1, getNum(e, 71, 1));
      const cs = getNum(e, 44), rs = getNum(e, 45);
      const cr = Math.cos(rot), sr = Math.sin(rot);
      const flip = getNum(e, 230, 1) < 0 ? [-1, 0, 0, 1, 0, 0] : IDENTITY;
      const base = block.base;
      const anon = name.startsWith('*');
      let count = 0;
      for (let rIdx = 0; rIdx < rows; rIdx++) {
        for (let cIdx = 0; cIdx < cols; cIdx++) {
          if (++count > MAX_MINSERT) break;
          // flip · T(P) · R(rot) · T(MINSERT offset) · S(sx, sy) · T(-base)
          const ox = cIdx * cs, oy = rIdx * rs;
          const local = [cr * sx, sr * sx, -sr * sy, cr * sy,
            P[0] + cr * ox - sr * oy - (cr * sx * base[0] - sr * sy * base[1]),
            P[1] + sr * ox + cr * oy - (sr * sx * base[0] + cr * sy * base[1])];
          const child = {
            m: mul(ctx.m, mul(flip, local)), layer: st.layer, color: st.color, dash: st.dash, lw: st.lw,
            block: anon ? ctx.block : name, depth: ctx.depth + 1, stack: [...ctx.stack, name],
          };
          this.drawList(block.entities, child);
        }
      }
      if (count > MAX_MINSERT) this.sheet.warnings.push(`MINSERT of block "${name}" has ${rows * cols} copies: only the first ${MAX_MINSERT} are drawn.`);
    }
    // Attributes are stored in the coordinates the INSERT itself lives in, not in the block's.
    for (const a of attribs) {
      const ast = this.style(a, { ...ctx, layer: st.layer, color: st.color, dash: st.dash, lw: st.lw });
      if (ast.L.frozen || ast.L.off) continue;
      this.text(a, getNum(a, 230, 1) < 0 ? mul(ctx.m, [-1, 0, 0, 1, 0, 0]) : ctx.m, ast);
    }
  }

  summarise(paperSpace) {
    const w = this.sheet.warnings;
    const hiddenCount = [...this.hidden.values()].reduce((a, b) => a + b, 0);
    if (hiddenCount) w.push(`${hiddenCount} entities on frozen or switched-off layers were skipped (${[...this.hidden.keys()].slice(0, 12).join(', ')}${this.hidden.size > 12 ? ', …' : ''}).`);
    if (paperSpace) w.push(`${paperSpace} paper-space entities (layout title block, viewports) were skipped: only model space is read.`);
    if (this.invisible) w.push(`${this.invisible} invisible entities were skipped.`);
    if (this.ignored.size) w.push(`Not drawn: ${[...this.ignored].map(([t, n]) => `${t} ×${n}`).join(', ')}.`);
    if (this.missing.size) w.push(`Block references to blocks that are not in the file: ${[...this.missing].slice(0, 12).join(', ')}.`);
    if (this.xrefs.size) w.push(`External references are not included (bind them in AutoCAD first): ${[...this.xrefs].join(', ')}.`);
    if (this.tooDeep) w.push(`${this.tooDeep} block references nested deeper than ${MAX_DEPTH} levels were not expanded.`);
    if (this.cycles) w.push(`${this.cycles} block references that contain themselves were not expanded.`);
  }
}
