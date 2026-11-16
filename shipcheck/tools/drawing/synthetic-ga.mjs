// Synthetic general arrangement (GA) drawing with known ground truth, for testing the drawing → model interpretation.
// A ~60 m research vessel: profile (raked stem, transom, keel, rudder, deck lines with names and elevations, portholes,
// frame ticks), four deck plans stacked under the profile at the same x and scale (tank top, main deck, 01 deck,
// bridge deck) with dash-dot centrelines, double-line shell, bulkheads (100 mm) and partitions (60 mm), labelled
// rooms (an L-shaped lounge, a stair trunk standing free inside it), doors with quarter-arc swings and leaf lines
// (two double doors, one gap without an arc), stairs, a ladder, furniture, hatch, dimension lines and a title block.
//
//   makeGA(options) -> { drawing, truth }     drawing: primitives in sheet millimetres at 1:1 (= model mm)
//   toSheet(drawing, { paper, unit })          Sheet as a reader returns it (paper: PDF points at 1:100)
//   toDxf(drawing) / toPdf(drawing) / toSvg(drawing)
//
// Options: { bow: 'right' | 'left', half: false, profile: true }.
// CLI:  node tools/drawing/synthetic-ga.mjs [--bow-left] [--half] [--no-profile] [--unit cm]  → tools/drawing/out/
//
// Ground-truth rooms are computed independently of the drawn lines: the clear space of a deck (inside the shell,
// outside every wall rectangle, door openings closed) is split on a compressed grid of the wall coordinates.

import { makeSheet, addPath, addText, finishSheet, tessellateArc, estimateTextWidth } from '../../src/drawing/sheet.mjs';
import { clipConvex, clipSegmentConvex, area as ringArea, segIntersect } from '../../src/drawing/plan-graph.mjs';

const DEG = Math.PI / 180;
const SCALE = 100; // the drawing scale 1:100
const PAGE = [118900, 84100]; // A0 landscape at 1:100, in sheet mm × 100
const L = 60000;
const PT = 72 / 25.4; // points per paper mm

// ---------- hull form (model mm, x forward from the transom, z above the baseline, y to port) ----------

const xStem = (z) => (z <= 1500 ? 54000 + (z * 2000) / 1500 : 56000 + ((z - 1500) * 4000) / 4500);
const xStern = (z) => (z >= 2000 ? 0 : 6000 * (1 - z / 2000)); // counter: (6000, 0) to the transom foot (0, 2000)

// Closed counter-clockwise outline from the port half-breadth points (aft to forward; the last has y = 0).
function outlineFrom(portPts) {
  const stbd = portPts.map(([x, y]) => [x, -y]);
  const port = portPts.slice().reverse().filter(([, y]) => y > 0);
  return [...stbd, ...port].filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
}

const DECKS = [
  { id: 'TT', name: 'TANK TOP', elevation: 1200, height: 3800, ts: 120,
    port: [[2400, 3000], [8000, 5000], [40000, 5200], [48000, 4200], [53000, 2000], [xStem(1200), 0]] },
  { id: 'MD', name: 'MAIN DECK', elevation: 5000, height: 2800, ts: 120,
    port: [[0, 5400], [8000, 6000], [44000, 6000], [52000, 4800], [57000, 2400], [xStem(5000), 0]] },
  { id: '01', name: '01 DECK', elevation: 7800, height: 2800, ts: 120,
    port: [[20000, 6000], [44000, 6000], [48000, 5400], [48000, 0]] },
  { id: 'BD', name: 'BRIDGE DECK', elevation: 10600, height: 2800, ts: 120,
    port: [[30000, 5800], [45500, 5800], [47000, 4000], [47000, 0]] },
];
for (const d of DECKS) d.outline = outlineFrom(d.port);

/** Inset a convex counter-clockwise polygon by t (each edge moved inward, consecutive edges intersected). */
export function inset(poly, t) {
  const n = poly.length, lines = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy);
    const nx = -dy / l, ny = dx / l; // inward for CCW
    lines.push([a[0] + nx * t, a[1] + ny * t, b[0] + nx * t, b[1] + ny * t]);
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = lines[(i - 1 + n) % n], q = lines[i];
    const x = segIntersect(p, q);
    out.push(x ? [p[0] + (p[2] - p[0]) * x.t, p[1] + (p[3] - p[1]) * x.t] : [q[0], q[1]]);
  }
  return out;
}

// ---------- deck arrangements ----------

const B = 100, P = 60; // bulkhead and partition thickness
const wv = (x, y0, y1, t) => ({ axis: 'v', at: x, from: y0, to: y1, t });
const wh = (y, x0, x1, t) => ({ axis: 'h', at: y, from: x0, to: x1, t });

// door: wall axis, wall position, centre along the wall, width, side (+1: swings to + of the wall normal), hinge end
// (-1: hinge at the low end of the opening), double, opening (no arc)
const door = (axis, at, c, w, side, hinge = -1, extra = {}) => ({ axis, at, c, w, side, hinge, ...extra });

const ARR = {
  TT: {
    walls: [wv(8000, -7000, 7000, B), wv(24000, -7000, 7000, B), wv(28000, -7000, 7000, B), wv(34000, -7000, 7000, B), wv(42000, -7000, 7000, B),
      wh(0, 24000, 28000, B),
      // DRY STORE partition stops 300 mm short of the shell: the two stores are not closed off from each other
      wv(38000, -7000, 4767 - 30, P)],
    doors: [door('v', 8000, 2000, 700, -1), door('v', 24000, 2500, 800, 1)],
    labels: [['STEERING GEAR ROOM', [5000, 0]], ['ENGINE ROOM', [16000, 3500]], ['WORKSHOP', [26000, 2500]], ['FUEL OIL TANK', [26000, -2500]],
      ['FRESH WATER TANK', [31000, 0]], ['PROVISION STORE', [36000, 0]], ['DRY STORE', [40000, 0]], ['FORE PEAK TANK', [47000, 0]]],
    ladders: [{ x0: 22000, y0: 3000, n: 5, pitch: 300, w: 450 }],
    hatch: [{ box: [11000, -2500, 19000, 2500], spacing: 300 }],
    furniture: [],
  },
  MD: {
    walls: [wv(20000, -7000, 7000, B), wv(44000, -7000, 7000, B), wh(600, 20000, 44000, P), wh(-600, 20000, 44000, P),
      wv(27000, 600, 7000, P), wv(33000, 600, 7000, P), wv(39000, 600, 7000, P),
      wv(23000, -7000, -600, P), wv(26500, -7000, -600, P), wv(30000, -7000, -600, P), wv(38000, -7000, -600, P), wv(41000, -7000, -600, P),
      wv(35000, -3000, -600, P), wh(-3000, 35000, 38000, P),
      // stair trunk standing free inside the lounge (a hole in its floor area)
      wv(31000, -3500, -2000, B), wv(34000, -3500, -2000, B), wh(-3500, 31000, 34000, B), wh(-2000, 31000, 34000, B)],
    doors: [door('v', 20000, 0, 900, 1), door('h', 600, 23500, 800, 1), door('h', 600, 30000, 800, 1), door('h', 600, 34500, 800, 1),
      door('h', 600, 41500, 800, 1), door('v', 39000, 4000, 800, -1), door('h', -600, 21500, 800, -1), door('h', -600, 24750, 700, -1),
      door('h', -600, 28250, 700, -1), door('h', -600, 32000, 1400, -1, -1, { double: true }), door('v', 35000, -1800, 800, -1),
      door('v', 31000, -2750, 800, -1), door('h', -600, 42500, 700, -1), door('v', 44000, 0, 900, 1),
      door('h', -600, 39500, 900, -1, -1, { opening: true })],
    labels: [['WORKING DECK', [10000, 0]], ['WET LAB', [23500, 3300]], ['DRY LAB', [30000, 3300]], ['MESS', [36000, 4300]], ['GALLEY', [41500, 3300]],
      ['STORE', [21500, -3300]], ['CABIN 1', [24750, -3300]], ['CABIN 2', [28250, -3300]], ['LOUNGE', [36500, -4500]], ['PANTRY', [36500, -1800]],
      ['STAIR', [32500, -3200]], ['LAUNDRY', [39500, -3300]], ['WC', [42500, -3300]], ['CORRIDOR', [25000, 0]], ['DECK STORE', [50000, 0]]],
    stairs: [{ x0: 31400, n: 10, pitch: 250, y0: -3450, y1: -2050, up: [31700, -2300], arrowY: -2750, arrow: [31200, 33800] }],
    furniture: [[23300, -5500, 25300, -4600], [26800, -5500, 28800, -4600], [35000, 1500, 36600, 2300], [36800, -5400, 37600, -4900], [28500, 2000, 31500, 2900]],
    equipment: [['CRANE', [14000, 3000, 15500, 4500]]],
  },
  '01': {
    walls: [wv(30000, -7000, 7000, B), wh(600, 30000, 44000, P), wh(-600, 30000, 44000, P), wv(44000, -7000, 7000, B),
      wv(34000, 600, 7000, P), wv(38000, 600, 7000, P), wv(42000, 600, 7000, P),
      wv(34000, -7000, -600, P), wv(38000, -7000, -600, P), wv(42000, -7000, -600, P)],
    doors: [door('v', 30000, 0, 900, -1), door('h', 600, 33000, 700, 1), door('h', 600, 37000, 700, 1), door('h', 600, 41000, 700, 1),
      door('h', 600, 43000, 800, 1), door('h', -600, 32000, 1200, -1, -1, { double: true }), door('h', -600, 37000, 700, -1),
      door('h', -600, 41000, 700, -1), door('h', -600, 43000, 800, -1), door('v', 44000, 0, 800, 1)],
    labels: [['OPEN DECK', [25000, 0]], ['CABIN 3', [32000, 3300]], ['CABIN 4', [36000, 3300]], ['CABIN 5', [40000, 3300]], ['HOSPITAL', [43000, 3300]],
      ['STAIRWAY', [32000, -3000]], ['CABIN 6', [36000, -3300]], ['CABIN 7', [40000, -3300]], ['OFFICE', [43000, -3300]],
      ['CORRIDOR', [36000, 0]], ['PAINT STORE', [46000, 0]]],
    stairs: [{ x0: 30600, n: 10, pitch: 250, y0: -5880, y1: -4880, stringer: true, up: [30900, -4500], arrowY: -5380, arrow: [30400, 33200] }],
    furniture: [[35000, -5400, 37000, -4500], [39000, -5400, 41000, -4500], [35000, 4500, 37000, 5400]],
    equipment: [['LIFERAFT', [22000, 4000, 23600, 4700]]],
  },
  BD: {
    walls: [wv(36000, -7000, 7000, B), wv(40000, -7000, 7000, P)],
    doors: [door('v', 36000, -3000, 800, 1), door('v', 40000, 0, 800, 1)],
    labels: [['OPEN DECK', [33000, 0]], ['CHART ROOM', [38000, 0]], ['WHEELHOUSE', [43000, 0]]],
    furniture: [[44000, -1500, 45200, 1500]],
  },
};

const ROOM_TRUTH = {
  'STEERING GEAR ROOM': ['machinery_space', 'machinery'], 'ENGINE ROOM': ['machinery_space', 'machinery'], WORKSHOP: ['space', 'working'],
  'FUEL OIL TANK': ['fuel_tank', 'tank'], 'FRESH WATER TANK': ['tank', 'tank'], 'PROVISION STORE': ['space', 'service'], 'DRY STORE': ['space', 'service'],
  'FORE PEAK TANK': ['tank', 'tank'], 'WORKING DECK': ['space', 'open_deck'], 'WET LAB': ['space', 'lab'], 'DRY LAB': ['space', 'lab'],
  MESS: ['space', 'accommodation'], GALLEY: ['space', 'service'], STORE: ['space', 'service'], LOUNGE: ['space', 'accommodation'],
  PANTRY: ['space', 'service'], STAIR: ['stair', 'circulation'], STAIRWAY: ['stair', 'circulation'], LAUNDRY: ['space', 'service'], WC: ['space', 'service'],
  CORRIDOR: ['corridor', 'circulation'], 'DECK STORE': ['space', 'working'], 'OPEN DECK': ['space', 'open_deck'], HOSPITAL: ['space', 'accommodation'],
  OFFICE: ['space', 'accommodation'], 'PAINT STORE': ['space', 'working'], 'CHART ROOM': ['space', 'control'], WHEELHOUSE: ['space', 'control'],
};
const typeOfLabel = (label) => ROOM_TRUTH[label] ?? (/^CABIN/.test(label) ? ['space', 'accommodation'] : ['space', null]);

// ---------- primitives ----------

class Drawing {
  constructor() { this.prims = []; this.texts = []; }
  line(a, b, o = {}) { this.prims.push({ kind: 'poly', pts: [a, b], closed: false, width: 25, ...o }); }
  poly(pts, closed, o = {}) { this.prims.push({ kind: 'poly', pts, closed, width: 25, ...o }); }
  arc(c, r, a0, a1, o = {}) { this.prims.push({ kind: 'arc', c, r, a0, a1, width: 18, ...o }); }
  circle(c, r, o = {}) { this.prims.push({ kind: 'circle', c, r, width: 18, ...o }); }
  text(text, c, h, o = {}) { this.texts.push({ text, c, h, angle: 0, ...o }); }
}

// A view placement: model coordinates (x, y-or-z) → sheet mm, with optional mirror of x (bow left) and of y.
function placement(ox, oy, { flipX = false, flipY = false } = {}) {
  const f = ([x, y]) => [flipX ? ox + L - x : ox + x, flipY ? oy - y : oy + y];
  f.flipX = flipX; f.flipY = flipY;
  return f;
}
function emit(dr, T, prim) {
  if (prim.kind === 'poly') return dr.prims.push({ ...prim, pts: prim.pts.map(T) });
  const c = T(prim.c);
  if (prim.kind === 'circle') return dr.prims.push({ ...prim, c });
  // mirror one axis: angles reflect and the counter-clockwise order swaps; both axes: rotate 180°
  let { a0, a1 } = prim;
  if (T.flipX && T.flipY) { a0 += 180; a1 += 180; }
  else if (T.flipX) { [a0, a1] = [180 - a1, 180 - a0]; }
  else if (T.flipY) { [a0, a1] = [-a1, -a0]; }
  const norm = (a) => ((a % 360) + 360) % 360;
  dr.prims.push({ ...prim, c, a0: norm(a0), a1: norm(a1) === 0 && norm(a0) > 0 ? 360 : norm(a1) });
}
const emitText = (dr, T, t) => dr.texts.push({ ...t, c: T(t.c) });

// ---------- plan geometry ----------

const wallRect = (w) => (w.axis === 'v' ? [w.at - w.t / 2, Math.min(w.from, w.to) - w.t / 2, w.at + w.t / 2, Math.max(w.from, w.to) + w.t / 2]
  : [Math.min(w.from, w.to) - w.t / 2, w.at - w.t / 2, Math.max(w.from, w.to) + w.t / 2, w.at + w.t / 2]);

// A wall rectangle minus the door openings that cut it.
function cutRect(r, w, doors) {
  let parts = [r];
  for (const d of doors) {
    if (d.axis !== w.axis || Math.abs(d.at - w.at) > 1) continue;
    const lo = d.c - d.w / 2, hi = d.c + d.w / 2;
    const next = [];
    for (const p of parts) {
      const [a, b] = w.axis === 'v' ? [p[1], p[3]] : [p[0], p[2]];
      if (hi <= a || lo >= b) { next.push(p); continue; }
      if (lo > a) next.push(w.axis === 'v' ? [p[0], a, p[2], lo] : [a, p[1], lo, p[3]]);
      if (hi < b) next.push(w.axis === 'v' ? [p[0], hi, p[2], b] : [hi, p[1], b, p[3]]);
    }
    parts = next;
  }
  return parts;
}

// Boundary segments of the union of axis-aligned rectangles (compressed grid).
function unionBoundary(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r[0], r[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r[1], r[3]]))].sort((a, b) => a - b);
  const ix = new Map(xs.map((v, i) => [v, i])), iy = new Map(ys.map((v, i) => [v, i]));
  const cov = Array.from({ length: xs.length }, () => new Uint8Array(ys.length));
  for (const r of rects) for (let i = ix.get(r[0]); i < ix.get(r[2]); i++) for (let j = iy.get(r[1]); j < iy.get(r[3]); j++) cov[i][j] = 1;
  const c = (i, j) => (i >= 0 && j >= 0 && i < xs.length - 1 && j < ys.length - 1 ? cov[i][j] : 0);
  const segs = [];
  for (let i = 0; i < xs.length; i++) {
    let start = null;
    for (let j = 0; j <= ys.length - 1; j++) {
      const edge = j < ys.length - 1 && c(i - 1, j) !== c(i, j);
      if (edge && start === null) start = j;
      if (!edge && start !== null) { segs.push([xs[i], ys[start], xs[i], ys[j]]); start = null; }
    }
  }
  for (let j = 0; j < ys.length; j++) {
    let start = null;
    for (let i = 0; i <= xs.length - 1; i++) {
      const edge = i < xs.length - 1 && c(i, j - 1) !== c(i, j);
      if (edge && start === null) start = i;
      if (!edge && start !== null) { segs.push([xs[start], ys[j], xs[i], ys[j]]); start = null; }
    }
  }
  return segs;
}

// Parts of segment s outside every rectangle.
function subtractRects(s, rects) {
  const L2 = Math.hypot(s[2] - s[0], s[3] - s[1]);
  const cuts = [];
  for (const r of rects) {
    const box = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];
    const c = clipSegmentConvex(s, box);
    if (!c) continue;
    const t0 = Math.hypot(c[0] - s[0], c[1] - s[1]) / L2, t1 = Math.hypot(c[2] - s[0], c[3] - s[1]) / L2;
    cuts.push([Math.min(t0, t1), Math.max(t0, t1)]);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const out = []; let t = 0;
  for (const [a, b] of cuts) { if (a > t + 1e-9) out.push([t, a]); t = Math.max(t, b); }
  if (t < 1 - 1e-9) out.push([t, 1]);
  return out.filter(([a, b]) => (b - a) * L2 > 1).map(([a, b]) => [s[0] + (s[2] - s[0]) * a, s[1] + (s[3] - s[1]) * a, s[0] + (s[2] - s[0]) * b, s[1] + (s[3] - s[1]) * b]);
}

// Sorted coordinates without near-duplicates (two float copies of one vertex would make a zero-width cell column).
const uniq = (vals) => vals.sort((a, b) => a - b).filter((v, i, a) => i === 0 || v - a[i - 1] > 1e-6);

// Clear rooms on a compressed grid: free cells inside the inner shell, joined across shared free edges.
export function truthRooms(rects, inner, labels) {
  const ib = inner.reduce((b, p) => [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])], [Infinity, Infinity, -Infinity, -Infinity]);
  const xs = uniq([ib[0], ib[2], ...rects.flatMap((r) => [r[0], r[2]]).filter((v) => v > ib[0] && v < ib[2]), ...inner.map((p) => p[0])]);
  const ys = uniq([ib[1], ib[3], ...rects.flatMap((r) => [r[1], r[3]]).filter((v) => v > ib[1] && v < ib[3]), ...inner.map((p) => p[1])]);
  const nx = xs.length - 1, ny = ys.length - 1;
  const cellArea = new Float64Array(nx * ny), id = (i, j) => i * ny + j;
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    if (rects.some((r) => cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3])) continue;
    const poly = clipConvex([[xs[i], ys[j]], [xs[i + 1], ys[j]], [xs[i + 1], ys[j + 1]], [xs[i], ys[j + 1]]], inner);
    cellArea[id(i, j)] = poly.length >= 3 ? ringArea(poly) : 0;
  }
  const parent = new Int32Array(nx * ny).map((_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    if (!(cellArea[id(i, j)] > 1)) continue;
    if (i + 1 < nx && cellArea[id(i + 1, j)] > 1 && clipSegmentConvex([xs[i + 1], ys[j], xs[i + 1], ys[j + 1]], inner)) join(id(i, j), id(i + 1, j));
    if (j + 1 < ny && cellArea[id(i, j + 1)] > 1 && clipSegmentConvex([xs[i], ys[j + 1], xs[i + 1], ys[j + 1]], inner)) join(id(i, j), id(i, j + 1));
  }
  const sum = new Map();
  for (let k = 0; k < nx * ny; k++) if (cellArea[k] > 1) sum.set(find(k), (sum.get(find(k)) || 0) + cellArea[k]);
  const cellOf = ([x, y]) => {
    const i = xs.findIndex((v, k) => k < nx && x >= v && x < xs[k + 1]), j = ys.findIndex((v, k) => k < ny && y >= v && y < ys[k + 1]);
    return i < 0 || j < 0 ? null : find(id(i, j));
  };
  const byRoot = new Map();
  for (const [label, at] of labels) {
    const r = cellOf(at);
    if (r == null) continue;
    if (!byRoot.has(r)) byRoot.set(r, []);
    byRoot.get(r).push(label);
  }
  return { rooms: [...byRoot.entries()].map(([r, ls]) => ({ labels: ls, area: sum.get(r) })), components: sum.size };
}

function drawPlan(dr, deck, T, truth, { halfPlan }) {
  const arr = ARR[deck.id];
  const inner = inset(deck.outline, deck.ts);
  const keep = halfPlan ? (pts) => pts.every(([, y]) => y >= -1e-6) : () => true;
  const prims = [];
  const P = (p) => prims.push(p);
  // shell: outer line (the deck edge) and the inner line between the walls that meet it
  P({ kind: 'poly', pts: deck.outline, closed: true, width: 50, layer: `${deck.id}-SHELL` });
  const rectsAll = arr.walls.map(wallRect);
  const rectsCut = arr.walls.flatMap((w) => cutRect(wallRect(w), w, arr.doors));
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i], b = inner[(i + 1) % inner.length];
    for (const s of subtractRects([a[0], a[1], b[0], b[1]], rectsCut)) P({ kind: 'poly', pts: [[s[0], s[1]], [s[2], s[3]]], width: 35, layer: `${deck.id}-SHELL` });
  }
  for (const s of unionBoundary(rectsCut)) {
    const c = clipSegmentConvex(s, inner);
    if (c && Math.hypot(c[2] - c[0], c[3] - c[1]) > 1) P({ kind: 'poly', pts: [[c[0], c[1]], [c[2], c[3]]], width: 35, layer: `${deck.id}-WALL` });
  }
  // doors
  const doorTruth = [];
  for (const d of arr.doors) {
    const along = d.axis === 'v' ? [0, 1] : [1, 0], across = d.axis === 'v' ? [1, 0] : [0, 1];
    const t = arr.walls.find((w) => w.axis === d.axis && Math.abs(w.at - d.at) < 1 && d.c > Math.min(w.from, w.to) && d.c < Math.max(w.from, w.to)).t;
    const pt = (u, v) => (d.axis === 'v' ? [d.at + v, u] : [u, d.at + v]);
    const lo = d.c - d.w / 2, hi = d.c + d.w / 2;
    const centre = pt(d.c, 0);
    if (d.opening) { truth.openings.push({ deck: deck.id, centre, width: d.w }); continue; }
    const face = d.side * t / 2;
    const leaves = d.double ? [[lo, d.w / 2, 1], [hi, d.w / 2, -1]] : [[d.hinge < 0 ? lo : hi, d.w, d.hinge < 0 ? 1 : -1]];
    for (const [hu, r, dirAlong] of leaves) {
      const hinge = pt(hu, face);
      const closedDir = [along[0] * dirAlong, along[1] * dirAlong], openDir = [across[0] * d.side, across[1] * d.side];
      const ang = (v) => Math.atan2(v[1], v[0]) / DEG;
      let a0 = ang(closedDir), a1 = ang(openDir);
      // counter-clockwise from a0 to a1 must be the 90° sweep
      if ((((a1 - a0) % 360) + 360) % 360 !== 90) [a0, a1] = [a1, a0];
      P({ kind: 'arc', c: hinge, r, a0: ((a0 % 360) + 360) % 360, a1: ((a1 % 360) + 360) % 360 || 360, width: 13, layer: `${deck.id}-DOOR` });
      P({ kind: 'poly', pts: [hinge, [hinge[0] + openDir[0] * r, hinge[1] + openDir[1] * r]], width: 18, layer: `${deck.id}-DOOR` });
    }
    doorTruth.push({ deck: deck.id, centre, width: d.w, double: !!d.double, hingeY: pt(lo, 0)[1] });
  }
  // stairs: treads, stringer, walk arrow and UP
  for (const s of arr.stairs ?? []) {
    for (let i = 0; i < s.n; i++) { const x = s.x0 + i * s.pitch; P({ kind: 'poly', pts: [[x, s.y0], [x, s.y1]], width: 13, layer: `${deck.id}-STAIR` }); }
    if (s.stringer) P({ kind: 'poly', pts: [[s.x0, s.y1], [s.x0 + (s.n - 1) * s.pitch, s.y1]], width: 13, layer: `${deck.id}-STAIR` });
    const [ax0, ax1] = s.arrow;
    P({ kind: 'poly', pts: [[ax0, s.arrowY], [ax1, s.arrowY]], width: 13, layer: `${deck.id}-STAIR` });
    P({ kind: 'poly', pts: [[ax1 - 250, s.arrowY + 120], [ax1, s.arrowY], [ax1 - 250, s.arrowY - 120]], width: 13, layer: `${deck.id}-STAIR` });
    truth.stairs.push({ deck: deck.id, treads: s.n, width: Math.abs(s.y1 - s.y0), x: [s.x0, s.x0 + (s.n - 1) * s.pitch], y: [Math.min(s.y0, s.y1), Math.max(s.y0, s.y1)] });
    dr.texts.push({ text: 'UP', c: T(s.up), h: 200, angle: 0, layer: `${deck.id}-TEXT`, keep: keep([s.up]) });
  }
  for (const l of arr.ladders ?? []) {
    const x1 = l.x0 + (l.n - 1) * l.pitch;
    for (let i = 0; i < l.n; i++) { const x = l.x0 + i * l.pitch; P({ kind: 'poly', pts: [[x, l.y0], [x, l.y0 + l.w]], width: 13, layer: `${deck.id}-LADDER` }); }
    P({ kind: 'poly', pts: [[l.x0 - 100, l.y0], [x1 + 100, l.y0]], width: 13, layer: `${deck.id}-LADDER` });
    P({ kind: 'poly', pts: [[l.x0 - 100, l.y0 + l.w], [x1 + 100, l.y0 + l.w]], width: 13, layer: `${deck.id}-LADDER` });
    dr.texts.push({ text: 'LADDER', c: T([(l.x0 + x1) / 2, l.y0 + l.w + 400]), h: 200, angle: 0, layer: `${deck.id}-TEXT` });
    truth.ladders.push({ deck: deck.id, at: [(l.x0 + x1) / 2, l.y0 + l.w / 2] });
  }
  // hatch: 45° lines inside a box, clipped to the inner shell (no boundary line, as a DXF HATCH often is)
  for (const h of arr.hatch ?? []) {
    const [x0, y0, x1, y1] = h.box, poly = clipConvex([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], inner);
    const step = h.spacing * Math.SQRT2;
    for (let c = x0 - (y1 - y0); c < x1; c += step) {
      const s = clipSegmentConvex([c, y0, c + (y1 - y0), y1], poly);
      if (s && Math.hypot(s[2] - s[0], s[3] - s[1]) > 50) P({ kind: 'poly', pts: [[s[0], s[1]], [s[2], s[3]]], width: 5, layer: `${deck.id}-HATCH` });
    }
    truth.hatch.push({ deck: deck.id, box: h.box });
  }
  for (const f of arr.furniture ?? []) {
    P({ kind: 'poly', pts: [[f[0], f[1]], [f[2], f[1]], [f[2], f[3]], [f[0], f[3]]], closed: true, width: 13, layer: `${deck.id}-FURN` });
    truth.furniture.push({ deck: deck.id, box: f });
  }
  for (const [label, f] of arr.equipment ?? []) {
    P({ kind: 'poly', pts: [[f[0], f[1]], [f[2], f[1]], [f[2], f[3]], [f[0], f[3]]], closed: true, width: 18, layer: `${deck.id}-EQUIP` });
    dr.texts.push({ text: label, c: T([(f[0] + f[2]) / 2, (f[1] + f[3]) / 2]), h: 200, angle: 0, layer: `${deck.id}-TEXT`, keep: keep([[(f[0] + f[2]) / 2, (f[1] + f[3]) / 2]]) });
    truth.equipment.push({ deck: deck.id, label, box: f });
  }
  // centreline (dash-dot) beyond both ends
  const xs = deck.outline.map((p) => p[0]);
  P({ kind: 'poly', pts: [[Math.min(...xs) - 1000, 0], [Math.max(...xs) + 1000, 0]], dash: true, width: 13, layer: 'CENTRE' });
  // labels
  for (const [label, at] of arr.labels) if (!halfPlan || at[1] >= 0) dr.texts.push({ text: label, c: T(at), h: 250, angle: 0, layer: `${deck.id}-TEXT` });

  for (const p of prims) {
    if (halfPlan) {
      if (p.kind === 'poly') {
        if (p.closed && !keep(p.pts)) {
          // the deck edge: its port half, closed along the centreline
          const portHalf = clipConvex(p.pts, [[-1e6, 0], [1e6, 0], [1e6, 1e6], [-1e6, 1e6]]);
          if (portHalf.length >= 3 && p.layer?.endsWith('SHELL')) { emit(dr, T, { ...p, pts: portHalf.filter((q) => q[1] > 1e-6 || true), closed: false }); }
          continue;
        }
        const segs = [];
        for (let i = 1; i < p.pts.length; i++) {
          const a = p.pts[i - 1], b = p.pts[i];
          const c = clipSegmentConvex([a[0], a[1], b[0], b[1]], [[-1e7, 0], [1e7, 0], [1e7, 1e7], [-1e7, 1e7]]);
          if (c) segs.push([[c[0], c[1]], [c[2], c[3]]]);
        }
        for (const s of segs) emit(dr, T, { ...p, pts: s, closed: false });
        continue;
      }
      if (p.c[1] < -1e-6) continue;
    }
    emit(dr, T, p);
  }

  // ground truth
  const tr = truthRooms(rectsAll, inner, arr.labels);
  const outlineArea = ringArea(deck.outline);
  truth.decks.push({ id: deck.id, name: deck.name, elevation: deck.elevation, height: deck.height, outlineArea, xRange: [Math.min(...xs), Math.max(...xs)], beam: 2 * Math.max(...deck.outline.map((p) => p[1])) });
  for (const r of tr.rooms) {
    const [label, ...others] = r.labels;
    const [type, zone] = typeOfLabel(label);
    truth.rooms.push({ deck: deck.id, label, type, zone, area: r.area, sharesWith: others });
    for (const o of others) truth.unresolvedLabels.push({ deck: deck.id, label: o, sharesWith: label });
  }
  truth.doors.push(...doorTruth);
}

// ---------- profile ----------

function drawProfile(dr, T, truth) {
  const prim = (p) => emit(dr, T, p);
  const hull = [[0, 6000], [0, 2000], [6000, 0], [54000, 0], [56000, 1500], [L, 6000]];
  prim({ kind: 'poly', pts: [...hull, [0, 6000]], closed: false, width: 50, layer: 'PROFILE' });
  // rudder hanging from the counter
  prim({ kind: 'poly', pts: [[1100, 2000 - 1100 / 3], [1100, 200], [2300, 200], [2300, 2000 - 2300 / 3]], closed: false, width: 25, layer: 'PROFILE' });
  // decks
  prim({ kind: 'poly', pts: [[xStern(1200), 1200], [xStem(1200), 1200]], width: 35, layer: 'PROFILE' });
  prim({ kind: 'poly', pts: [[0, 5000], [xStem(5000), 5000]], width: 35, layer: 'PROFILE' });
  prim({ kind: 'poly', pts: [[20000, 6000], [20000, 7800], [48000, 7800], [48000, 6000]], width: 35, layer: 'PROFILE' });
  prim({ kind: 'poly', pts: [[30000, 7800], [30000, 10600], [47000, 10600], [47000, 7800]], width: 35, layer: 'PROFILE' });
  prim({ kind: 'poly', pts: [[36000, 10600], [36000, 13400], [47000, 13400], [47000, 10600]], width: 35, layer: 'PROFILE' });
  // bulkheads below the main deck
  for (const x of [8000, 24000, 28000, 34000, 42000]) prim({ kind: 'poly', pts: [[x, 0], [x, 5000]], width: 25, layer: 'PROFILE' });
  // design waterline (dashed)
  prim({ kind: 'poly', pts: [[xStern(3500) - 1500, 3500], [xStem(3500) + 1500, 3500]], dash: true, width: 13, layer: 'CENTRE' });
  dr.texts.push({ text: 'DWL', c: T([xStem(3500) + 2200, 3500]), h: 250, angle: 0, layer: 'PROFILE-TEXT' });
  // portholes
  const portholes = [[21500, 6800], [23500, 6800], [25500, 6800], [27500, 6800], [36000, 4300], [38000, 4300]];
  for (const c of portholes) prim({ kind: 'circle', c, r: 200, width: 18, layer: 'PROFILE' });
  truth.portholes = portholes.map((c) => ({ x: c[0], z: c[1], r: 200 }));
  // frame ticks and labels (frame spacing 600 mm, FR 0 at the transom = AP)
  for (let f = 0; f * 600 <= L; f++) prim({ kind: 'poly', pts: [[f * 600, -150], [f * 600, f % 10 ? -350 : -450]], width: 13, layer: 'FRAMES' });
  for (let f = 0; f * 600 <= L; f += 10) dr.texts.push({ text: `FR ${f}`, c: T([f * 600, -800]), h: 250, angle: 0, layer: 'FRAMES' });
  dr.texts.push({ text: 'AP', c: T([0, -1350]), h: 250, angle: 0, layer: 'FRAMES' });
  dr.texts.push({ text: 'FP', c: T([xStem(3500), -1350]), h: 250, angle: 0, layer: 'FRAMES' });
  // deck names and elevations just above each deck line
  const names = [['TANK TOP', '+1200 ABL', [6500, 1450]], ['MAIN DECK', '+5000 ABL', [3000, 5250]], ['01 DECK', '+7800 ABL', [22500, 8050]], ['BRIDGE DECK', '+10600 ABL', [32800, 10850]]];
  for (const [n, e, [x, z]] of names) {
    dr.texts.push({ text: n, c: T([x, z]), h: 250, angle: 0, layer: 'PROFILE-TEXT' });
    dr.texts.push({ text: e, c: T([x + 2900, z]), h: 250, angle: 0, layer: 'PROFILE-TEXT' });
  }
  // LOA dimension under the profile, deck height dimension aft of it
  dimension(dr, T, [0, -2000], [L, -2000], '60000', [[0, -1000], [L, -1000]]);
  dimension(dr, T, [-1500, 1200], [-1500, 5000], '3800', [[-1300, 1200], [-1300, 5000]]);
}

// Dimension line p→q with 45° ticks, extension lines from `from` points, the value centred above.
function dimension(dr, T, p, q, value, from) {
  const prim = (x) => emit(dr, T, x);
  prim({ kind: 'poly', pts: [p, q], width: 13, layer: 'DIM' });
  for (const e of [p, q]) prim({ kind: 'poly', pts: [[e[0] - 125, e[1] - 125], [e[0] + 125, e[1] + 125]], width: 13, layer: 'DIM' });
  from.forEach((f, i) => { const e = i ? q : p; const dx = Math.sign(e[0] - f[0]), dy = Math.sign(e[1] - f[1]); prim({ kind: 'poly', pts: [f, [e[0] + dx * 300, e[1] + dy * 300]], width: 13, layer: 'DIM' }); });
  const vertical = Math.abs(q[0] - p[0]) < Math.abs(q[1] - p[1]);
  const mid = [(p[0] + q[0]) / 2 + (vertical ? -250 : 0), (p[1] + q[1]) / 2 + (vertical ? 0 : 250)];
  dr.texts.push({ text: value, c: T(mid), h: 250, angle: vertical ? 90 : 0, layer: 'DIM' });
}

// ---------- title block and notes ----------

function drawSheet(dr) {
  const [W, H] = PAGE, m = 1000;
  dr.prims.push({ kind: 'poly', pts: [[m, m], [W - m, m], [W - m, H - m], [m, H - m]], closed: true, width: 70, layer: 'BORDER' });
  const tb = [W - m - 19000, m, W - m, m + 8000];
  dr.prims.push({ kind: 'poly', pts: [[tb[0], tb[1]], [tb[2], tb[1]], [tb[2], tb[3]], [tb[0], tb[3]]], closed: true, width: 50, layer: 'TITLE' });
  for (const y of [m + 2000, m + 4000, m + 6000]) dr.prims.push({ kind: 'poly', pts: [[tb[0], y], [tb[2], y]], width: 25, layer: 'TITLE' });
  dr.prims.push({ kind: 'poly', pts: [[tb[0] + 9500, tb[1]], [tb[0] + 9500, m + 4000]], width: 25, layer: 'TITLE' });
  const t = (text, x, y, h = 350) => dr.texts.push({ text, c: [x, y], h, angle: 0, layer: 'TITLE' });
  t('RESEARCH VESSEL SYNTHIA', tb[0] + 9500, m + 7000, 500);
  t('GENERAL ARRANGEMENT', tb[0] + 9500, m + 5000, 450);
  t('SCALE 1:100', tb[0] + 4750, m + 3000);
  t('DWG NO 1001-GA', tb[0] + 14250, m + 3000);
  t('DRAWN JD', tb[0] + 4750, m + 1000);
  t('CHECKED PT', tb[0] + 14250, m + 1000);
  const notes = [['PRINCIPAL DIMENSIONS', 400], ['LENGTH OVERALL 60.00 m', 300], ['BREADTH MOULDED 12.00 m', 300], ['DEPTH TO MAIN DECK 5.00 m', 300], ['DRAUGHT 3.50 m', 300], ['FRAME SPACING 600 mm', 300]];
  notes.forEach(([s, h], i) => dr.texts.push({ text: s, c: [tb[0] + 6000, m + 15500 - i * 900], h, angle: 0, layer: 'NOTES' }));
}

// ---------- the whole sheet ----------

/**
 * makeGA({ bow, half, profile }) -> { drawing, truth }.
 * drawing: { page: [w, h], scale: 100, prims, texts } in sheet millimetres at 1:1 (model mm on the paper at 1:100 × 100).
 */
export function makeGA({ bow = 'right', half: halfPlan = false, profile = true } = {}) {
  const dr = new Drawing();
  const truth = { scale: SCALE, bow, loa: L, beam: 12000, depth: 5000, draft: 3500, frameSpacing: 600, halfPlan, profile,
    decks: [], rooms: [], doors: [], openings: [], stairs: [], ladders: [], hatch: [], furniture: [], equipment: [], unresolvedLabels: [], portholes: [] };
  const left = bow === 'left';
  const X0 = 8000, Yp = 68200;
  drawSheet(dr);
  if (profile) {
    const Tp = placement(X0, Yp, { flipX: left });
    drawProfile(dr, Tp, truth);
    dr.texts.push({ text: 'PROFILE', c: Tp([L / 2, -3300]), h: 500, angle: 0, layer: 'TITLE', underline: true });
  }
  // plans from the top deck down, centres every 15.5 m below the profile
  const order = ['BD', '01', 'MD', 'TT'];
  order.forEach((id, k) => {
    const deck = DECKS.find((d) => d.id === id);
    const Yc = Yp - 11500 - k * 15500;
    const T = placement(X0, Yc, { flipX: left, flipY: left });
    drawPlan(dr, deck, T, truth, { halfPlan });
    // the title right under the drawing (a half plan with the bow to the right ends at the centre line)
    const titleAt = [X0 + L / 2, Yc - (halfPlan && !left ? 0 : 6000) - 1300];
    dr.texts.push({ text: deck.name, c: titleAt, h: 500, angle: 0, layer: 'TITLE', underline: true });
    if (id === 'MD') dimension(dr, T, [-1500, -6000], [-1500, 6000], '12000', [[-1300, -6000], [-1300, 6000]]);
  });
  // title underlines
  for (const t of dr.texts.filter((x) => x.underline)) {
    const w = estimateTextWidth(t.text, t.h);
    dr.prims.push({ kind: 'poly', pts: [[t.c[0] - w / 2, t.c[1] - t.h * 0.9], [t.c[0] + w / 2, t.c[1] - t.h * 0.9]], width: 25, layer: 'TITLE' });
  }
  dr.texts = dr.texts.filter((t) => t.keep !== false);
  truth.views = { profile: profile ? 1 : 0, plans: 4, title: 1 };
  return { drawing: { page: PAGE, scale: SCALE, prims: dr.prims, texts: dr.texts }, truth };
}

// ---------- emitters ----------

const TEXT_W = (t) => estimateTextWidth(t.text, t.h);
// baseline start of a text from its centre (texts are placed by their centre so they read the same in every variant)
function textAt(t, k = 1) {
  const a = (t.angle || 0) * DEG, w = TEXT_W(t);
  return [t.c[0] - (Math.cos(a) * w) / 2 + (Math.sin(a) * t.h) / 2, t.c[1] - (Math.sin(a) * w) / 2 - (Math.cos(a) * t.h) / 2].map((v) => v * k);
}

/**
 * The drawing as a Sheet (CONTRACT.md §1). paper: true → PDF points of an A0 sheet at 1:100 (y up); false → 1:1 in
 * `unit` (mm by default; 'cm' divides by 10), unit stated as a DXF with $INSUNITS would.
 */
export function toSheet(drawing, { paper = false, unit = 'mm' } = {}) {
  const k = paper ? PT / drawing.scale : 1 / ({ mm: 1, cm: 10, m: 1000 }[unit] ?? 1);
  const sheet = makeSheet({ file: 'synthetic-ga', format: paper ? 'pdf' : 'dxf', unit: paper ? 'pt' : unit, unitStated: true, paper });
  const P = (p) => [p[0] * k, p[1] * k];
  for (const p of drawing.prims) {
    const props = { width: p.width * k, dash: !!p.dash, layer: paper ? null : p.layer ?? null, color: null };
    if (p.kind === 'poly') addPath(sheet, p.pts.map(P), { ...props, closed: !!p.closed });
    else if (p.kind === 'circle') addPath(sheet, tessellateArc(P(p.c), p.r * k, 0, 360), { ...props, closed: true, arc: { c: P(p.c), r: p.r * k, a0: 0, a1: 360 } });
    else addPath(sheet, tessellateArc(P(p.c), p.r * k, p.a0, p.a1), { ...props, arc: { c: P(p.c), r: p.r * k, a0: p.a0, a1: p.a1 } });
  }
  for (const t of drawing.texts) addText(sheet, { text: t.text, at: textAt(t, k), height: t.h * k, angle: t.angle || 0, layer: paper ? null : t.layer ?? null, width: TEXT_W(t) * k });
  return finishSheet(sheet);
}

/** ASCII DXF (AC1015): INSUNITS 4 (mm), layers, CENTER linetype for centre lines, LWPOLYLINE with bulges for arcs. */
export function toDxf(drawing) {
  const out = [];
  const g = (c, v) => out.push(String(c), String(v));
  let handle = 0x100;
  const h = () => (handle++).toString(16).toUpperCase();
  const layers = [...new Set([...drawing.prims.map((p) => p.layer || '0'), ...drawing.texts.map((t) => t.layer || '0')])];
  g(0, 'SECTION'); g(2, 'HEADER'); g(9, '$ACADVER'); g(1, 'AC1015'); g(9, '$INSUNITS'); g(70, 4); g(9, '$MEASUREMENT'); g(70, 1); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2);
  g(0, 'LTYPE'); g(5, h()); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, 0);
  g(0, 'LTYPE'); g(5, h()); g(2, 'CENTER'); g(70, 0); g(3, 'Center ____ _ ____ _'); g(72, 65); g(73, 4); g(40, 2000);
  for (const v of [1250, -250, 250, -250]) { g(49, v); g(74, 0); }
  g(0, 'ENDTAB');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.length);
  for (const l of layers) { g(0, 'LAYER'); g(5, h()); g(2, l); g(70, 0); g(62, l === 'CENTRE' ? 1 : 7); g(6, l === 'CENTRE' ? 'CENTER' : 'CONTINUOUS'); }
  g(0, 'ENDTAB'); g(0, 'ENDSEC');
  g(0, 'SECTION'); g(2, 'ENTITIES');
  const n6 = (v) => Number(v.toFixed(3));
  for (const p of drawing.prims) {
    const layer = p.layer || '0', lw = Math.round(Math.min(211, p.width / SCALE * 100));
    if (p.kind === 'circle') { g(0, 'CIRCLE'); g(5, h()); g(8, layer); g(370, lw); g(10, n6(p.c[0])); g(20, n6(p.c[1])); g(30, 0); g(40, n6(p.r)); continue; }
    let verts, closed = false;
    if (p.kind === 'arc') {
      const sweep = ((((p.a1 - p.a0) % 360) + 360) % 360) || 360;
      const a = [p.c[0] + p.r * Math.cos(p.a0 * DEG), p.c[1] + p.r * Math.sin(p.a0 * DEG)];
      const b = [p.c[0] + p.r * Math.cos(p.a1 * DEG), p.c[1] + p.r * Math.sin(p.a1 * DEG)];
      verts = [[...a, Math.tan((sweep * DEG) / 4)], [...b, 0]];
    } else { verts = p.pts.map((q) => [q[0], q[1], 0]); closed = !!p.closed; }
    g(0, 'LWPOLYLINE'); g(5, h()); g(100, 'AcDbEntity'); g(8, layer); if (p.dash) g(6, 'CENTER'); g(370, lw); g(100, 'AcDbPolyline'); g(90, verts.length); g(70, closed ? 1 : 0);
    for (const [x, y, bulge] of verts) { g(10, n6(x)); g(20, n6(y)); if (bulge) g(42, bulge.toFixed(6)); }
  }
  for (const t of drawing.texts) {
    const at = textAt(t);
    g(0, 'TEXT'); g(5, h()); g(8, t.layer || '0'); g(10, n6(at[0])); g(20, n6(at[1])); g(30, 0); g(40, n6(t.h)); g(1, t.text); if (t.angle) g(50, t.angle);
  }
  g(0, 'ENDSEC'); g(0, 'EOF');
  return out.join('\n') + '\n';
}

// PDF string literal in WinAnsi (Latin-1 for the characters used here), with the special characters escaped.
const pdfStr = (s) => `(${[...String(s)].map((ch) => {
  const c = ch.charCodeAt(0);
  if (ch === '(' || ch === ')' || ch === '\\') return `\\${ch}`;
  if (c < 32 || c > 126) return c < 256 ? `\\${c.toString(8).padStart(3, '0')}` : '?';
  return ch;
}).join('')})`;

/** Arc as cubic Béziers (at most 90° each): [[p0, c1, c2, p3], ...]. */
function arcBeziers(c, r, a0, sweep) {
  const n = Math.max(1, Math.ceil(sweep / 90)), d = sweep / n, k = (4 / 3) * Math.tan((d * DEG) / 4), out = [];
  for (let i = 0; i < n; i++) {
    const s = (a0 + i * d) * DEG, e = (a0 + (i + 1) * d) * DEG;
    const p0 = [c[0] + r * Math.cos(s), c[1] + r * Math.sin(s)], p3 = [c[0] + r * Math.cos(e), c[1] + r * Math.sin(e)];
    out.push([p0, [p0[0] - k * r * Math.sin(s), p0[1] + k * r * Math.cos(s)], [p3[0] + k * r * Math.sin(e), p3[1] - k * r * Math.cos(e)], p3]);
  }
  return out;
}

/** A minimal valid PDF (A0 landscape, 1:100): stroked paths, Béziers for arcs, Helvetica text, correct xref. */
export function toPdf(drawing) {
  const k = PT / drawing.scale;
  const f = (v) => (Math.round(v * k * 1000) / 1000).toString();
  const ops = ['1 J 1 j'];
  for (const p of drawing.prims) {
    ops.push(`${f(p.width)} w ${p.dash ? `[${f(1250)} ${f(250)} ${f(250)} ${f(250)}] 0 d` : '[] 0 d'}`);
    if (p.kind === 'poly') {
      ops.push(`${f(p.pts[0][0])} ${f(p.pts[0][1])} m ${p.pts.slice(1).map((q) => `${f(q[0])} ${f(q[1])} l`).join(' ')}${p.closed ? ' h' : ''} S`);
    } else {
      const sweep = p.kind === 'circle' ? 360 : ((((p.a1 - p.a0) % 360) + 360) % 360) || 360;
      const bz = arcBeziers(p.c, p.r, p.kind === 'circle' ? 0 : p.a0, sweep);
      ops.push(`${f(bz[0][0][0])} ${f(bz[0][0][1])} m ${bz.map(([, c1, c2, p3]) => `${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p3[0])} ${f(p3[1])} c`).join(' ')}${p.kind === 'circle' ? ' h' : ''} S`);
    }
  }
  for (const t of drawing.texts) {
    const a = (t.angle || 0) * DEG, at = textAt(t);
    const size = t.h * k;
    ops.push(`BT /F1 ${(Math.round(size * 1000) / 1000)} Tf ${Math.cos(a).toFixed(5)} ${Math.sin(a).toFixed(5)} ${(-Math.sin(a)).toFixed(5)} ${Math.cos(a).toFixed(5)} ${f(at[0])} ${f(at[1])} Tm ${pdfStr(t.text)} Tj ET`);
  }
  const content = ops.join('\n');
  const W = (drawing.page[0] / drawing.scale) * PT, H = (drawing.page[1] / drawing.scale) * PT;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W.toFixed(2)} ${H.toFixed(2)}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ];
  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets = [];
  objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // one byte per character (Latin-1): the offsets above are byte offsets
  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}

/** SVG of the sheet at 1:100 in paper millimetres (y down, as SVG is). */
export function toSvg(drawing) {
  const k = 1 / drawing.scale, Hmm = drawing.page[1] * k;
  const X = (v) => (v * k).toFixed(3), Y = (v) => (Hmm - v * k).toFixed(3);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${drawing.page[0] * k}mm" height="${Hmm}mm" viewBox="0 0 ${drawing.page[0] * k} ${Hmm}">`, '<g fill="none" stroke="#000">'];
  for (const p of drawing.prims) {
    const st = `stroke-width="${(p.width * k).toFixed(3)}"${p.dash ? ' stroke-dasharray="12.5 2.5 2.5 2.5"' : ''}`;
    if (p.kind === 'poly') parts.push(`<path ${st} d="M${p.pts.map((q) => `${X(q[0])} ${Y(q[1])}`).join(' L')}${p.closed ? ' Z' : ''}"/>`);
    else if (p.kind === 'circle') parts.push(`<circle ${st} cx="${X(p.c[0])}" cy="${Y(p.c[1])}" r="${(p.r * k).toFixed(3)}"/>`);
    else {
      const sweep = ((((p.a1 - p.a0) % 360) + 360) % 360) || 360;
      const a = [p.c[0] + p.r * Math.cos(p.a0 * DEG), p.c[1] + p.r * Math.sin(p.a0 * DEG)], b = [p.c[0] + p.r * Math.cos(p.a1 * DEG), p.c[1] + p.r * Math.sin(p.a1 * DEG)];
      // counter-clockwise in y-up is clockwise in SVG's y-down: sweep-flag 0
      parts.push(`<path ${st} d="M${X(a[0])} ${Y(a[1])} A${(p.r * k).toFixed(3)} ${(p.r * k).toFixed(3)} 0 ${sweep > 180 ? 1 : 0} 0 ${X(b[0])} ${Y(b[1])}"/>`);
    }
  }
  parts.push('</g><g font-family="Helvetica, Arial, sans-serif" fill="#000">');
  for (const t of drawing.texts) {
    const at = textAt(t);
    parts.push(`<text x="${X(at[0])}" y="${Y(at[1])}" font-size="${(t.h * k).toFixed(3)}"${t.angle ? ` transform="rotate(${-t.angle} ${X(at[0])} ${Y(at[1])})"` : ''}>${esc(t.text)}</text>`);
  }
  parts.push('</g></svg>');
  return parts.join('\n');
}

// ---------- CLI ----------

const isMain = typeof process !== 'undefined' && process.argv?.[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:')}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opts = { bow: args.includes('--bow-left') ? 'left' : 'right', half: args.includes('--half'), profile: !args.includes('--no-profile') };
  const unit = args.includes('--unit') ? args[args.indexOf('--unit') + 1] : 'mm';
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'out');
  fs.mkdirSync(dir, { recursive: true });
  const { drawing, truth } = makeGA(opts);
  const tag = `ga${opts.bow === 'left' ? '-bowleft' : ''}${opts.half ? '-half' : ''}${opts.profile ? '' : '-noprofile'}`;
  fs.writeFileSync(path.join(dir, `${tag}.dxf`), toDxf(drawing));
  fs.writeFileSync(path.join(dir, `${tag}.pdf`), toPdf(drawing));
  fs.writeFileSync(path.join(dir, `${tag}.svg`), toSvg(drawing));
  fs.writeFileSync(path.join(dir, `${tag}.truth.json`), JSON.stringify(truth, null, 1));
  fs.writeFileSync(path.join(dir, `${tag}.sheet.json`), JSON.stringify(toSheet(drawing, { paper: true, unit })));
  console.log(`wrote ${tag}.{dxf,pdf,svg,truth.json,sheet.json} to ${dir}`);
}

export { DECKS as SYNTHETIC_DECKS };
