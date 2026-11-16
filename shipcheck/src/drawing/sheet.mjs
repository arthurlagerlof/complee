// Sheet: what every drawing reader (read-dxf / read-pdf / read-svg) returns, and the geometry helpers they share.
// Pure ES module: runs in the browser, in a Web Worker and in Node. See CONTRACT.md section 1 for the shape.
//
// Conventions used here:
// - Coordinates are sheet units, y up.
// - `arc` angles are degrees, counter-clockwise from a0 to a1. Both are in [0, 360) as DXF writes them, so an arc
//   may wrap (a0 = 270, a1 = 90 is the right half); a full circle is a0 = 0, a1 = 360. Use arcSweep() for the span.
// - Text `at` is the start of the baseline (left end in reading direction); `box` is the axis-aligned extent. For
//   DXF text that is centred or right-aligned the width is estimated from the character count, so the box centre is
//   the most robust position of a text.

const DEG = Math.PI / 180;

/** A new, empty Sheet. */
export function makeSheet({ file = null, format, page = 1, pages = 1, unit = 'mm', unitStated = false, paper = false } = {}) {
  return {
    source: { file, format, page, pages },
    unit, unitStated, paper,
    bbox: [0, 0, 0, 0],
    paths: [],
    texts: [],
    warnings: [],
  };
}

/**
 * Append a path. `pts` is [[x, y], ...] in sheet units; props may carry closed, arc, width, color, dash, fill,
 * stroke, layer, block. Returns the path. Empty point lists are dropped (returns null).
 */
export function addPath(sheet, pts, props = {}, closed = props.closed, arc = props.arc) {
  if (!pts || !pts.length) return null;
  // One object shape for every path (fast property access over a million paths).
  const p = {
    id: `p${sheet.paths.length + 1}`,
    pts,
    closed: !!closed,
    width: props.width > 0 ? props.width : 0,
    color: props.color ?? null,
    dash: !!props.dash,
    fill: !!props.fill,
    stroke: props.stroke ?? !props.fill,
    layer: props.layer ?? null,
    block: props.block ?? null,
  };
  // Only arcs carry the key: a million line paths do not need an `arc: undefined` slot each.
  if (arc) p.arc = arc;
  sheet.paths.push(p);
  return p;
}

/**
 * Append a text. props: text, at (baseline start), height, angle (deg), layer, box (optional), width (optional,
 * advance width along the baseline in sheet units; estimated from the characters when missing), plus any extra
 * fields a reader wants to keep (e.g. `measure` for a DXF dimension value).
 */
export function addText(sheet, props) {
  const text = String(props.text ?? '');
  if (!text.trim()) return null;
  const height = props.height > 0 ? props.height : 0;
  const angle = Number.isFinite(props.angle) ? props.angle : 0;
  const box = props.box || textBox(props.at, height, angle, props.width ?? estimateTextWidth(text, height), text.split('\n').length);
  const { width: _w, box: _b, ...rest } = props;
  const t = { id: `t${sheet.texts.length + 1}`, ...rest, text, at: props.at, height, angle, layer: props.layer ?? null, box };
  sheet.texts.push(t);
  return t;
}

/** Rough advance width of a text: 0.6 × height per character of its longest line (typical CAD/sans fonts). */
export function estimateTextWidth(text, height) {
  let longest = 0;
  for (const line of String(text).split('\n')) longest = Math.max(longest, line.length);
  return longest * height * 0.6;
}

/**
 * Axis-aligned box of a text: baseline start `at`, `height` (cap height ≈ font size), rotated by `angle` degrees,
 * advance `width`. `lines` > 1 extends it downwards (multi-line DXF MTEXT) with 1.5 × height line spacing.
 */
export function textBox(at, height, angle, width, lines = 1) {
  const c = Math.cos(angle * DEG), s = Math.sin(angle * DEG);
  const down = (lines - 1) * height * 1.5;
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [u, v] of [[0, -down - 0.2 * height], [width, -down - 0.2 * height], [width, height], [0, height]]) {
    const x = at[0] + u * c - v * s, y = at[1] + u * s + v * c;
    if (x < box[0]) box[0] = x; if (y < box[1]) box[1] = y; if (x > box[2]) box[2] = x; if (y > box[3]) box[3] = y;
  }
  return box;
}

/** Bounding box [x0, y0, x1, y1] of all paths and texts, or [0, 0, 0, 0] for an empty sheet. */
export function sheetBbox(sheet) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of sheet.paths) {
    for (const q of p.pts) {
      const x = q[0], y = q[1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  for (const t of sheet.texts) {
    const b = t.box;
    if (b[0] < x0) x0 = b[0]; if (b[1] < y0) y0 = b[1]; if (b[2] > x1) x1 = b[2]; if (b[3] > y1) y1 = b[3];
  }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** Compute the bbox once all paths and texts are in. Returns the sheet. */
export function finishSheet(sheet) {
  sheet.bbox = sheetBbox(sheet);
  return sheet;
}

// ---------- arcs ----------

/** Counter-clockwise span of an arc in degrees (0 < sweep ≤ 360). */
export function arcSweep(arc) {
  const s = ((arc.a1 - arc.a0) % 360 + 360) % 360;
  return s === 0 ? 360 : s;
}

/** Normalise an angle to [0, 360). */
export const normDeg = (a) => ((a % 360) + 360) % 360;

/** Number of chords for a sweep so the chord error is at most `relErr` × radius (sagitta r(1 − cos(θ/2))). */
export function arcSegments(sweepDeg, relErr = 0.005) {
  const step = 2 * Math.acos(1 - relErr); // radians per chord: 0.2 rad (11.5°) at 0.5 %
  return Math.max(1, Math.ceil(Math.abs(sweepDeg) * DEG / step));
}

/**
 * Points along a circular arc from angle `startDeg` through a signed `sweepDeg` (positive = counter-clockwise),
 * chord error ≤ relErr × r. Includes both end points.
 */
export function tessellateSweep(c, r, startDeg, sweepDeg, relErr = 0.005) {
  const n = arcSegments(sweepDeg, relErr);
  const pts = new Array(n + 1);
  const a0 = startDeg * DEG, da = (sweepDeg * DEG) / n;
  for (let i = 0; i <= n; i++) pts[i] = [c[0] + r * Math.cos(a0 + i * da), c[1] + r * Math.sin(a0 + i * da)];
  return pts;
}

/** Points along the arc {c, r, a0, a1} counter-clockwise (contract convention), chord error ≤ 0.5 % of r. */
export function tessellateArc(c, r, a0, a1, relErr = 0.005) {
  return tessellateSweep(c, r, a0, arcSweep({ a0, a1 }), relErr);
}

/**
 * Least-squares circle through `pts` ([[x, y], ...]); returns { c, r, a0, a1, err } when every point lies within
 * `tol` × r of the circle and the points run monotonically around it (so a zig-zag or an S-curve is not an arc),
 * else null. a0/a1 follow the contract (counter-clockwise from a0 to a1), whatever the drawing direction was.
 * Needs at least 4 points so that a fit says something (3 points always lie on a circle).
 */
export function circleFit(pts, tol = 0.01) {
  const n = pts.length;
  if (n < 4) return null;
  // Kåsa fit, centred on the mean for numerical stability (coordinates can be 1e5 mm).
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p[0] - mx, v = p[1] - my, uu = u * u, vv = v * v;
    suu += uu; svv += vv; suv += u * v; suuu += uu * u; svvv += vv * v; suvv += u * vv; svuu += v * uu;
  }
  const det = suu * svv - suv * suv;
  if (!(Math.abs(det) > 1e-12 * (suu + svv) ** 2)) return null; // collinear
  const b1 = 0.5 * (suuu + suvv), b2 = 0.5 * (svvv + svuu);
  const uc = (b1 * svv - b2 * suv) / det, vc = (b2 * suu - b1 * suv) / det;
  const cx = uc + mx, cy = vc + my;
  const r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  if (!(r > 0) || !Number.isFinite(r)) return null;
  let err = 0;
  for (const p of pts) err = Math.max(err, Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r));
  if (err > tol * r) return null;
  // Monotonic sweep: all angle steps have the same sign (tiny steps from duplicate points are ignored).
  let sweep = 0, sign = 0;
  let prev = Math.atan2(pts[0][1] - cy, pts[0][0] - cx);
  for (let i = 1; i < n; i++) {
    const a = Math.atan2(pts[i][1] - cy, pts[i][0] - cx);
    let d = a - prev;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    prev = a;
    if (Math.abs(d) < 1e-9) continue;
    const s = d > 0 ? 1 : -1;
    if (sign && s !== sign) return null;
    sign = s;
    sweep += d;
  }
  const sweepDeg = Math.abs(sweep) / DEG;
  if (sweepDeg < 5 || sweepDeg > 360.5) return null;
  const start = Math.atan2(pts[0][1] - cy, pts[0][0] - cx) / DEG;
  const end = Math.atan2(pts[n - 1][1] - cy, pts[n - 1][0] - cx) / DEG;
  const full = sweepDeg > 359.5;
  let a0 = sweep > 0 ? start : end, a1 = sweep > 0 ? end : start;
  if (full) { a0 = 0; a1 = 360; } else { a0 = normDeg(a0); a1 = normDeg(a1); }
  return { c: [cx, cy], r, a0, a1, err: err / r };
}

/**
 * The circle of a polyline that is an already-tessellated arc (CAD exporters often write arcs as short chords),
 * else null. Needs at least 6 points and every chord at most 20° of arc, so that polygons whose corners happen to
 * lie on a circle (a square, a hexagon) are not taken for arcs.
 */
export function polylineArc(pts, closed = false) {
  const n = pts.length;
  if (n < 6) return null;
  const ring = closed ? [...pts, pts[0]] : pts;
  const fit = circleFit(ring, 0.01);
  if (!fit) return null;
  const maxChord = 2 * fit.r * Math.sin(10 * DEG);
  for (let i = 1; i < ring.length; i++) if (Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]) > maxChord) return null;
  delete fit.err;
  return fit;
}

// ---------- Bézier curves ----------

/**
 * Append the points of a cubic Bézier (p0 excluded, p3 included) to `out`. The number of chords comes from Wang's
 * bound (flatness ≤ tol), capped at `maxSeg` (16: door swings and small curves; the cap keeps million-segment PDFs
 * fast).
 */
export function cubicPoints(out, x0, y0, x1, y1, x2, y2, x3, y3, tol, maxSeg = 16) {
  const ddx = Math.max(Math.abs(x0 - 2 * x1 + x2), Math.abs(x1 - 2 * x2 + x3));
  const ddy = Math.max(Math.abs(y0 - 2 * y1 + y2), Math.abs(y1 - 2 * y2 + y3));
  const m = Math.hypot(ddx, ddy);
  const n = Math.min(maxSeg, Math.max(1, Math.ceil(Math.sqrt((0.75 * m) / tol))));
  for (let i = 1; i <= n; i++) {
    const t = i / n, s = 1 - t;
    const a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
    out.push([a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3]);
  }
  return out;
}

/** 9 evenly spaced points on a cubic Bézier (t = 0 … 1): enough for circleFit to tell an arc from another curve. */
function cubicSamples(x0, y0, x1, y1, x2, y2, x3, y3) {
  const out = [];
  for (let i = 0; i <= 8; i++) {
    const t = i / 8, s = 1 - t;
    const a = s * s * s, b = 3 * s * s * t, c = 3 * s * t * t, d = t * t * t;
    out.push([a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3]);
  }
  return out;
}

// ---------- path builder shared by the PDF and SVG readers ----------

/**
 * Collects subpaths in sheet coordinates (callers transform points before handing them in; Béziers are
 * affine-invariant, so transforming control points is exact) and emits them as Sheet paths on paint().
 *
 * Why the splitting: PDFs and SVGs draw a door as one subpath "leaf line + swing curve". Interpretation needs the
 * swing as its own arc (radius = clear width), so on stroked paths every run of curves that is a circular arc within
 * 1 % becomes a separate path with `arc`; the straight parts stay polylines. Filled shapes are kept whole (they are
 * areas), and a subpath that is entirely one circular run (a circle, a lone arc) keeps its `arc` either way.
 * Straight-only subpaths that are pre-tessellated arcs get `arc` too (polylineArc).
 */
export class PathBuilder {
  constructor(sheet, { tol = 0.05, maxSeg = 16 } = {}) {
    this.sheet = sheet;
    this.tol = tol;
    this.maxSeg = maxSeg;
    this.subs = [];    // finished subpaths: { pts, closed, curves }
    this.cur = null;   // current subpath
    this.segments = 0; // statistics for the reader
  }
  moveTo(x, y) {
    this._end();
    this.cur = { pts: [[x, y]], closed: false, curves: null };
  }
  lineTo(x, y) {
    if (!this.cur) { this.moveTo(x, y); return; }
    this.cur.pts.push([x, y]);
  }
  curveTo(x1, y1, x2, y2, x3, y3) {
    if (!this.cur) this.moveTo(x1, y1);
    const pts = this.cur.pts, last = pts[pts.length - 1], i0 = pts.length - 1;
    cubicPoints(pts, last[0], last[1], x1, y1, x2, y2, x3, y3, this.tol, this.maxSeg);
    (this.cur.curves ||= []).push({ i0, i1: pts.length - 1, samples: cubicSamples(last[0], last[1], x1, y1, x2, y2, x3, y3), arc: null });
  }
  /** A pre-tessellated arc (SVG `A`): pts start at the current point; `arc` is its circle when it is circular. */
  arcRun(pts, arc) {
    if (!this.cur) this.moveTo(pts[0][0], pts[0][1]);
    const out = this.cur.pts, i0 = out.length - 1;
    for (let i = 1; i < pts.length; i++) out.push(pts[i]);
    (this.cur.curves ||= []).push({ i0, i1: out.length - 1, samples: arc ? null : pts, arc });
  }
  closePath() {
    if (!this.cur) return;
    this.cur.closed = true;
    const first = this.cur.pts[0];
    // The next segment starts at the subpath's start (PDF and SVG semantics).
    this._end();
    this.cur = { pts: [[first[0], first[1]]], closed: false, curves: null, afterClose: true };
  }
  /** Closed four-corner subpath (PDF `re`); corners already transformed. */
  quad(a, b, c, d) {
    this._end();
    this.subs.push({ pts: [a, b, c, d], closed: true, curves: null });
  }
  _end() {
    const s = this.cur;
    this.cur = null;
    if (!s || s.pts.length < 2) return; // a lone moveTo (or the restart after a close) draws nothing
    this.subs.push(s);
  }
  /** Drop the collected path (PDF `n`, clipping paths). */
  discard() { this.subs.length = 0; this.cur = null; }
  /** Emit the collected subpaths with a style { width, color, dash, fill, stroke, layer, block }. */
  paint(style) {
    this._end();
    for (const s of this.subs) this._emit(s, style);
    this.subs.length = 0;
  }
  _emit(s, style) {
    const sheet = this.sheet;
    let { pts } = s;
    // Drop a closing point that repeats the start: `closed` already says it.
    if (s.closed && pts.length > 2 && !s.curves) {
      const a = pts[0], b = pts[pts.length - 1];
      if (a[0] === b[0] && a[1] === b[1]) pts = pts.slice(0, -1);
    }
    this.segments += Math.max(1, pts.length - (s.closed ? 0 : 1));
    if (!s.curves) { addPath(sheet, pts, style, s.closed, pts.length >= 6 ? polylineArc(pts, s.closed) : null); return; }
    const curves = s.curves;
    const last = pts.length - 1;
    // Whole subpath is one run of curves (a circle, a lone swing arc)?
    if (curves[0].i0 === 0 && curves[curves.length - 1].i1 === last && contiguous(curves, 0, curves.length - 1)) {
      const arc = runArc(curves, 0, curves.length - 1, pts);
      if (arc) { addPath(sheet, pts, style, s.closed || arcSweep(arc) === 360, arc); return; }
    }
    if (style.fill && !style.stroke) { addPath(sheet, pts, style, s.closed, null); return; }
    // Stroked: split circular runs out. A closed subpath is opened by repeating its start point at the end.
    const full = s.closed ? [...pts, pts[0]] : pts;
    const pieces = [];
    let from = 0; // start index of the pending polyline piece
    for (let k = 0; k < curves.length;) {
      // Longest run starting at k that is one circular arc (runs are short: try longest first).
      let end = k;
      while (end + 1 < curves.length && curves[end + 1].i0 === curves[end].i1) end++;
      let found = null, foundEnd = -1;
      for (let e = end; e >= k; e--) {
        const arc = runArc(curves, k, e, full);
        if (arc) { found = arc; foundEnd = e; break; }
      }
      if (!found) { k++; continue; }
      const i0 = curves[k].i0, i1 = curves[foundEnd].i1;
      if (i0 > from) pieces.push({ pts: full.slice(from, i0 + 1) });
      pieces.push({ pts: full.slice(i0, i1 + 1), arc: found });
      from = i1;
      k = foundEnd + 1;
    }
    if (!pieces.length) { addPath(sheet, pts, style, s.closed, null); return; }
    if (from < full.length - 1) pieces.push({ pts: full.slice(from) });
    for (const p of pieces) if (p.pts.length > 1) addPath(sheet, p.pts, style, false, p.arc);
  }
}

function contiguous(curves, k, e) {
  for (let i = k; i < e; i++) if (curves[i + 1].i0 !== curves[i].i1) return false;
  return true;
}

// The circle of curves k..e when together they are one circular arc, else null.
function runArc(curves, k, e, pts) {
  if (k === e && curves[k].arc) return curves[k].arc;
  const sample = [];
  for (let i = k; i <= e; i++) {
    const c = curves[i];
    const src = c.samples || pts.slice(c.i0, c.i1 + 1);
    for (let j = i === k ? 0 : 1; j < src.length; j++) sample.push(src[j]);
  }
  const fit = circleFit(sample, 0.01);
  if (!fit) return null;
  delete fit.err;
  return fit;
}

// ---------- iteration and spatial index ----------

/**
 * Call fn(x0, y0, x1, y1, path, segmentIndex) for every straight segment of every path, the closing segment of
 * closed paths included. A single-point path yields one zero-length segment.
 */
export function forEachSegment(sheet, fn) {
  for (const p of sheet.paths) {
    const pts = p.pts, n = pts.length;
    if (n === 1) { fn(pts[0][0], pts[0][1], pts[0][0], pts[0][1], p, 0); continue; }
    for (let i = 0; i < n - 1; i++) fn(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], p, i);
    if (p.closed && n > 2) fn(pts[n - 1][0], pts[n - 1][1], pts[0][0], pts[0][1], p, n - 1);
  }
}

/**
 * Uniform-grid index over the path segments of a sheet. Build once (O(segments)), then query by box:
 *   const ix = gridIndex(sheet);
 *   ix.paths([x0, y0, x1, y1])     -> indices into sheet.paths whose segments touch the box (bounding-box test)
 *   ix.segments([x0, y0, x1, y1])  -> Int32Array of [pathIndex, segmentIndex] pairs, same test
 * The cell size defaults to about two segments per cell; the grid is capped at 1024 × 1024 cells.
 */
export function gridIndex(sheet, { cell } = {}) {
  const paths = sheet.paths;
  let nseg = 0;
  for (const p of paths) nseg += p.pts.length < 2 ? 1 : p.pts.length - 1 + (p.closed && p.pts.length > 2 ? 1 : 0);
  const [bx0, by0, bx1, by1] = sheetBbox({ paths, texts: [] });
  const w = Math.max(bx1 - bx0, 1e-9), h = Math.max(by1 - by0, 1e-9);
  const size = cell > 0 ? cell : Math.max(Math.sqrt((w * h * 2) / Math.max(1, nseg)), Math.max(w, h) / 1024);
  const nx = Math.min(1024, Math.max(1, Math.ceil(w / size))), ny = Math.min(1024, Math.max(1, Math.ceil(h / size)));
  const sx = nx / w, sy = ny / h;
  const cx = (x) => Math.min(nx - 1, Math.max(0, Math.floor((x - bx0) * sx)));
  const cy = (y) => Math.min(ny - 1, Math.max(0, Math.floor((y - by0) * sy)));

  // Segment table, then a two-pass CSR layout (count per cell, prefix sums, fill): no per-cell arrays.
  const segPath = new Int32Array(nseg), segIdx = new Int32Array(nseg), segBox = new Float64Array(nseg * 4);
  let k = 0;
  for (let pi = 0; pi < paths.length; pi++) {
    forEachSegment({ paths: [paths[pi]] }, (x0, y0, x1, y1, p, i) => {
      segPath[k] = pi; segIdx[k] = i;
      segBox[4 * k] = Math.min(x0, x1); segBox[4 * k + 1] = Math.min(y0, y1);
      segBox[4 * k + 2] = Math.max(x0, x1); segBox[4 * k + 3] = Math.max(y0, y1);
      k++;
    });
  }

  const start = new Int32Array(nx * ny + 1);
  for (let s = 0; s < nseg; s++) {
    const x0 = cx(segBox[4 * s]), y0 = cy(segBox[4 * s + 1]), x1 = cx(segBox[4 * s + 2]), y1 = cy(segBox[4 * s + 3]);
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) start[j * nx + i + 1]++;
  }
  for (let c = 0; c < nx * ny; c++) start[c + 1] += start[c];
  const items = new Int32Array(start[nx * ny]);
  const fillAt = start.slice(0, nx * ny);
  for (let s = 0; s < nseg; s++) {
    const x0 = cx(segBox[4 * s]), y0 = cy(segBox[4 * s + 1]), x1 = cx(segBox[4 * s + 2]), y1 = cy(segBox[4 * s + 3]);
    for (let j = y0; j <= y1; j++) for (let i = x0; i <= x1; i++) items[fillAt[j * nx + i]++] = s;
  }

  const segStamp = new Uint32Array(nseg), pathStamp = new Uint32Array(paths.length);
  let stamp = 0;
  // Visit each segment whose box overlaps the query box once.
  function visit(box, fn) {
    if (++stamp === 0xffffffff) { segStamp.fill(0); pathStamp.fill(0); stamp = 1; }
    const [qx0, qy0, qx1, qy1] = box;
    if (qx1 < bx0 || qy1 < by0 || qx0 > bx1 || qy0 > by1) return;
    const i0 = cx(qx0), i1 = cx(qx1), j0 = cy(qy0), j1 = cy(qy1);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * nx + i;
        for (let q = start[c]; q < start[c + 1]; q++) {
          const s = items[q];
          if (segStamp[s] === stamp) continue;
          segStamp[s] = stamp;
          if (segBox[4 * s] > qx1 || segBox[4 * s + 2] < qx0 || segBox[4 * s + 1] > qy1 || segBox[4 * s + 3] < qy0) continue;
          fn(s);
        }
      }
    }
  }
  return {
    cell: size, nx, ny, segmentCount: nseg,
    paths(box) {
      const out = [];
      visit(box, (s) => { const p = segPath[s]; if (pathStamp[p] !== stamp) { pathStamp[p] = stamp; out.push(p); } });
      return out.sort((a, b) => a - b);
    },
    segments(box) {
      const out = [];
      visit(box, (s) => { out.push(segPath[s], segIdx[s]); });
      return Int32Array.from(out);
    },
  };
}

// ---------- 2D affine transforms [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f (PDF order) ----------

export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
/** m1 × m2: apply m2 first, then m1. */
export function mul(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}
export const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Geometric mean scale of a transform (√|det|): how line widths and radii scale. */
export const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
/** True when the transform keeps circles circles (rotation × uniform scale, possibly mirrored), within 0.1 %. */
export function isSimilarity(m) {
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  const dot = m[0] * m[2] + m[1] * m[3];
  return sx > 0 && Math.abs(sx - sy) <= 1e-3 * sx && Math.abs(dot) <= 1e-3 * sx * sy;
}

/** The arc {c, r, a0, a1} after transform m, or null when m is not a similarity (the arc becomes an ellipse). */
export function transformArc(arc, m) {
  if (!isSimilarity(m)) return null;
  const c = apply(m, arc.c[0], arc.c[1]);
  const r = arc.r * Math.hypot(m[0], m[1]);
  if (arcSweep(arc) === 360) return { c, r, a0: 0, a1: 360 };
  const p0 = apply(m, arc.c[0] + Math.cos(arc.a0 * DEG), arc.c[1] + Math.sin(arc.a0 * DEG));
  const p1 = apply(m, arc.c[0] + Math.cos(arc.a1 * DEG), arc.c[1] + Math.sin(arc.a1 * DEG));
  let a0 = normDeg(Math.atan2(p0[1] - c[1], p0[0] - c[0]) / DEG), a1 = normDeg(Math.atan2(p1[1] - c[1], p1[0] - c[0]) / DEG);
  if (m[0] * m[3] - m[1] * m[2] < 0) [a0, a1] = [a1, a0]; // a mirror turns counter-clockwise into clockwise
  return { c, r, a0, a1 };
}
