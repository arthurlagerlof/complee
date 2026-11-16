// Geometry core of the drawing interpretation: spatial grids, union-find, collinear merging and the planar graph
// whose faces are the rooms of a deck plan. Pure ES module (browser, Web Worker, Node); no I/O.
//
// Segments everywhere are arrays [x1, y1, x2, y2, ref] (ref: whatever the caller needs back, e.g. a path id).
// The planar graph is built in O(n log n)-ish time with a uniform grid: real deck plans have 10k–100k segments.

export const EPS = 1e-9;

// ---------- small vector and polygon helpers ----------

export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const segLen = (s) => Math.hypot(s[2] - s[0], s[3] - s[1]);

/** Signed area of a ring [[x, y], ...] (counter-clockwise positive). */
export function signedArea(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}
export const area = (ring) => Math.abs(signedArea(ring));

export function perimeter(ring) {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) s += dist(ring[i], ring[(i + 1) % n]);
  return s;
}

export function centroid(ring) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n], c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cy += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < EPS) {
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

export function ringBox(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

export const boxContains = (b, p, m = 0) => p[0] >= b[0] - m && p[0] <= b[2] + m && p[1] >= b[1] - m && p[1] <= b[3] + m;
export const boxesOverlap = (a, b, m = 0) => a[0] <= b[2] + m && b[0] <= a[2] + m && a[1] <= b[3] + m && b[1] <= a[3] + m;
export const boxUnion = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** Even-odd point-in-polygon test. */
export function pointInRing(p, ring) {
  let inside = false;
  const [x, y] = p;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from point p to segment s, and the parameter t of the closest point (0..1). */
export function pointSegment(p, s) {
  const dx = s[2] - s[0], dy = s[3] - s[1], L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p[0] - s[0]) * dx + (p[1] - s[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(s[0] + t * dx - p[0], s[1] + t * dy - p[1]), t };
}

/** Intersection of segments a and b: { t, u } parameters, or null (parallel or not crossing). */
export function segIntersect(a, b) {
  const rx = a[2] - a[0], ry = a[3] - a[1], sx = b[2] - b[0], sy = b[3] - b[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < EPS * (Math.abs(rx) + Math.abs(ry)) * (Math.abs(sx) + Math.abs(sy))) return null;
  const qx = b[0] - a[0], qy = b[1] - a[1];
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return { t, u };
}

/** Horizontal line y = c against a ring: sorted x of the crossings. */
export function crossingsAtY(ring, c) {
  const xs = [];
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    if ((p[1] > c) !== (q[1] > c)) xs.push(p[0] + ((c - p[1]) / (q[1] - p[1])) * (q[0] - p[0]));
  }
  return xs.sort((a, b) => a - b);
}
/** Vertical line x = c against a ring: sorted y of the crossings. */
export function crossingsAtX(ring, c) {
  const ys = [];
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i], q = ring[(i + 1) % n];
    if ((p[0] > c) !== (q[0] > c)) ys.push(p[1] + ((c - p[0]) / (q[0] - p[0])) * (q[1] - p[1]));
  }
  return ys.sort((a, b) => a - b);
}

/** Drop repeated points, collinear points and back-and-forth spikes (dangling edges walked twice by a face). */
export function simplifyRing(ring, tol = 1) {
  let pts = ring.slice();
  for (let pass = 0; pass < 4; pass++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const prev = out.length ? out[out.length - 1] : pts[pts.length - 1], cur = pts[i], next = pts[(i + 1) % pts.length];
      if (dist(prev, cur) < tol) continue;
      const ax = cur[0] - prev[0], ay = cur[1] - prev[1], bx = next[0] - cur[0], by = next[1] - cur[1];
      const cross = ax * by - ay * bx, la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
      if (la > 0 && lb > 0 && Math.abs(cross) / Math.max(la, lb) < tol) continue; // collinear or a spike
      out.push(cur);
    }
    if (out.length === pts.length || out.length < 3) { pts = out.length >= 3 ? out : pts; break; }
    pts = out;
  }
  return pts;
}

// ---------- union-find ----------

export class UnionFind {
  constructor(n) { this.p = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
  find(a) { const p = this.p; while (p[a] !== a) { p[a] = p[p[a]]; a = p[a]; } return a; }
  union(a, b) { a = this.find(a); b = this.find(b); if (a !== b) this.p[Math.max(a, b)] = Math.min(a, b); return a !== b; }
}

// ---------- uniform grid over segments ----------

/** Cells (integer pairs) a segment passes through, for a grid of cell size `cell`. Walks the segment (DDA). */
export function segmentCells(s, cell, fn) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(s[2] - s[0]), Math.abs(s[3] - s[1])) / cell) * 2);
  let last = null;
  for (let i = 0; i <= steps; i++) {
    const cx = Math.floor((s[0] + ((s[2] - s[0]) * i) / steps) / cell), cy = Math.floor((s[1] + ((s[3] - s[1]) * i) / steps) / cell);
    const key = cx * 73856093 ^ cy * 19349663;
    if (key === last) continue;
    last = key;
    fn(cx, cy);
  }
}

export class SegGrid {
  constructor(segs, cell) {
    this.cell = cell; this.segs = segs; this.map = new Map();
    segs.forEach((s, i) => segmentCells(s, cell, (cx, cy) => {
      const k = `${cx},${cy}`;
      let a = this.map.get(k); if (!a) this.map.set(k, a = []);
      if (a[a.length - 1] !== i) a.push(i);
    }));
  }
  /** Indices of segments in the cells overlapping box b (may contain duplicates' removal). */
  query(b) {
    const c = this.cell, out = new Set();
    for (let cx = Math.floor(b[0] / c); cx <= Math.floor(b[2] / c); cx++) {
      for (let cy = Math.floor(b[1] / c); cy <= Math.floor(b[3] / c); cy++) {
        const a = this.map.get(`${cx},${cy}`);
        if (a) for (const i of a) out.add(i);
      }
    }
    return out;
  }
}

/** Point grid: nearest-within-radius lookups. */
export class PointGrid {
  constructor(cell) { this.cell = cell; this.map = new Map(); }
  key(x, y) { return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`; }
  add(p, v) { const k = this.key(p[0], p[1]); let a = this.map.get(k); if (!a) this.map.set(k, a = []); a.push([p, v]); }
  near(p, r) {
    const c = this.cell, out = [];
    for (let cx = Math.floor((p[0] - r) / c); cx <= Math.floor((p[0] + r) / c); cx++) {
      for (let cy = Math.floor((p[1] - r) / c); cy <= Math.floor((p[1] + r) / c); cy++) {
        const a = this.map.get(`${cx},${cy}`);
        if (a) for (const e of a) if (dist(e[0], p) <= r) out.push(e);
      }
    }
    return out;
  }
}

// ---------- collinear merging ----------

/**
 * Merge collinear, overlapping or nearly touching segments into maximal lines. Returns
 * [{ a, b, dir, n, rho, t0, t1, len, members: [segment index] }] with a→b along dir.
 * angTol in degrees, offTol and gapTol in drawing units.
 */
export function mergeCollinear(segs, { angTol = 0.5, offTol = 2, gapTol = 2 } = {}) {
  const items = [];
  segs.forEach((s, i) => {
    const L = segLen(s); if (L <= EPS) return;
    let th = Math.atan2(s[3] - s[1], s[2] - s[0]);
    if (th < 0) th += Math.PI;
    if (th >= Math.PI - 1e-12) th -= Math.PI;
    items.push({ i, th, s, L });
  });
  const angBin = (angTol * Math.PI) / 180;
  // Bucket by angle, then by offset from the origin; neighbouring buckets are joined so nothing falls on a border.
  const byAng = new Map();
  for (const it of items) {
    const k = Math.round(it.th / angBin) % Math.round(Math.PI / angBin);
    let a = byAng.get(k); if (!a) byAng.set(k, a = []); a.push(it);
  }
  const lines = [];
  const used = new Set();
  const nBins = Math.round(Math.PI / angBin);
  for (const k of [...byAng.keys()].sort((a, b) => a - b)) {
    if (used.has(k)) continue;
    // collect this bucket and its neighbours (angle wrap at 180°)
    const group = [];
    for (const kk of [k - 1, k, k + 1]) {
      const key = ((kk % nBins) + nBins) % nBins;
      if (used.has(key) || !byAng.has(key)) continue;
      if (kk !== k && Math.abs(kk - k) === 1 && byAng.has(key)) { /* neighbours join */ }
      append(group, byAng.get(key)); used.add(key);
    }
    // common direction: length-weighted mean (handling wrap)
    let sx = 0, sy = 0;
    for (const it of group) { sx += Math.cos(2 * it.th) * it.L; sy += Math.sin(2 * it.th) * it.L; }
    const th = Math.atan2(sy, sx) / 2, d = [Math.cos(th), Math.sin(th)], n = [-d[1], d[0]];
    const rows = group.map((it) => {
      const s = it.s, r0 = n[0] * s[0] + n[1] * s[1], r1 = n[0] * s[2] + n[1] * s[3];
      const t0 = d[0] * s[0] + d[1] * s[1], t1 = d[0] * s[2] + d[1] * s[3];
      return { i: it.i, rho: (r0 + r1) / 2, t0: Math.min(t0, t1), t1: Math.max(t0, t1), dth: Math.abs(it.th - th) };
    }).sort((a, b) => a.rho - b.rho);
    // split by offset into rows of the same line
    let start = 0;
    for (let j = 1; j <= rows.length; j++) {
      if (j < rows.length && rows[j].rho - rows[j - 1].rho <= offTol) continue;
      const row = rows.slice(start, j).sort((a, b) => a.t0 - b.t0);
      start = j;
      let cur = null;
      const flush = () => {
        if (!cur) return;
        const rho = cur.rhoSum / cur.wSum;
        lines.push({ a: [d[0] * cur.t0 + n[0] * rho, d[1] * cur.t0 + n[1] * rho], b: [d[0] * cur.t1 + n[0] * rho, d[1] * cur.t1 + n[1] * rho],
          dir: d, n, rho, t0: cur.t0, t1: cur.t1, len: cur.t1 - cur.t0, members: cur.members });
      };
      for (const r of row) {
        const w = r.t1 - r.t0;
        if (cur && r.t0 <= cur.t1 + gapTol) { cur.t1 = Math.max(cur.t1, r.t1); cur.members.push(r.i); cur.rhoSum += r.rho * w; cur.wSum += w; }
        else { flush(); cur = { t0: r.t0, t1: r.t1, members: [r.i], rhoSum: r.rho * w, wSum: w }; }
      }
      flush();
    }
  }
  return lines;
}

// ---------- planar graph and faces ----------

/**
 * Planar graph of segments: endpoints snapped within tol, segments split where they cross or where an endpoint
 * touches another segment. Returns { verts: [[x, y]], edges: [[u, v, ref]], faces, comps } where faces are the
 * closed areas: { ring: [[x, y]], area (signed), comp, edges: [edge index] }. A face with positive area is a bounded
 * area (counter-clockwise); each connected component also has one outer face (negative area: its outline, clockwise).
 */
export function planarGraph(segs, { tol = 10 } = {}) {
  const verts = [];
  const vgrid = new PointGrid(Math.max(tol * 4, EPS));
  const vertexAt = (p) => {
    const hit = vgrid.near(p, tol);
    if (hit.length) {
      let best = hit[0]; for (const h of hit) if (dist(h[0], p) < dist(best[0], p)) best = h;
      return best[1];
    }
    verts.push([p[0], p[1]]); vgrid.add(p, verts.length - 1);
    return verts.length - 1;
  };
  // short pieces stay: a curve drawn as many tiny steps must not break; snapping merges their ends
  const clean = segs.filter((s) => segLen(s) > 1e-9);
  if (!clean.length) return { verts, edges: [], faces: [], comps: [] };
  // grid cell ~ a few typical segment lengths, never so small that long lines cover thousands of cells
  const lens = clean.map(segLen).sort((a, b) => a - b);
  const box = clean.reduce((b, s) => [Math.min(b[0], s[0], s[2]), Math.min(b[1], s[1], s[3]), Math.max(b[2], s[0], s[2]), Math.max(b[3], s[1], s[3])], [Infinity, Infinity, -Infinity, -Infinity]);
  const diag = Math.hypot(box[2] - box[0], box[3] - box[1]);
  const cell = Math.max(lens[Math.floor(lens.length / 2)] * 2, diag / 400, tol * 4);
  const grid = new SegGrid(clean, cell);
  const cuts = clean.map(() => []);
  const seen = new Set();
  for (const ids of grid.map.values()) {
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const i = ids[x], j = ids[y];
        const key = i < j ? i * 4294967296 + j : j * 4294967296 + i;
        if (seen.has(key)) continue;
        seen.add(key);
        cutPair(clean[i], clean[j], cuts[i], cuts[j], tol);
      }
    }
  }
  const edgeKey = new Set(), edges = [];
  clean.forEach((s, i) => {
    const L = segLen(s);
    const ts = [0, 1, ...cuts[i]].sort((a, b) => a - b);
    let prev = vertexAt([s[0], s[1]]), prevT = 0;
    for (const t of ts.slice(1)) {
      if ((t - prevT) * L < tol * 0.25 && t !== 1) continue;
      const v = t === 1 ? vertexAt([s[2], s[3]]) : vertexAt([s[0] + (s[2] - s[0]) * t, s[1] + (s[3] - s[1]) * t]);
      if (v !== prev) {
        const k = prev < v ? `${prev},${v}` : `${v},${prev}`;
        if (!edgeKey.has(k)) { edgeKey.add(k); edges.push([prev, v, s[4]]); }
      }
      prev = v; prevT = t;
    }
  });
  return facesOf(verts, edges);
}

// Records where a and b cross or touch, as parameters along each (their own split lists).
function cutPair(a, b, ca, cb, tol) {
  const La = segLen(a), Lb = segLen(b);
  if (Math.min(a[0], a[2]) > Math.max(b[0], b[2]) + tol || Math.min(b[0], b[2]) > Math.max(a[0], a[2]) + tol) return;
  if (Math.min(a[1], a[3]) > Math.max(b[1], b[3]) + tol || Math.min(b[1], b[3]) > Math.max(a[1], a[3]) + tol) return;
  const x = segIntersect(a, b);
  const ta = tol / La, tb = tol / Lb;
  if (x && x.t > -ta && x.t < 1 + ta && x.u > -tb && x.u < 1 + tb) {
    if (x.t > ta && x.t < 1 - ta) ca.push(x.t);
    if (x.u > tb && x.u < 1 - tb) cb.push(x.u);
    return;
  }
  // parallel / collinear overlap, or an endpoint lying on the other segment
  for (const [p, s, c, t] of [[[b[0], b[1]], a, ca, ta], [[b[2], b[3]], a, ca, ta], [[a[0], a[1]], b, cb, tb], [[a[2], a[3]], b, cb, tb]]) {
    const r = pointSegment(p, s);
    if (r.d <= tol && r.t > t && r.t < 1 - t) c.push(r.t);
  }
}

/** Faces of a planar graph (vertices and undirected edges without crossings). */
export function facesOf(verts, edges) {
  const out = verts.map(() => []); // outgoing half-edges per vertex: [angle, half-edge id]
  // half-edge h = 2e (u→v) and 2e+1 (v→u)
  edges.forEach(([u, v], e) => {
    out[u].push([Math.atan2(verts[v][1] - verts[u][1], verts[v][0] - verts[u][0]), 2 * e]);
    out[v].push([Math.atan2(verts[u][1] - verts[v][1], verts[u][0] - verts[v][0]), 2 * e + 1]);
  });
  const pos = new Int32Array(edges.length * 2);
  for (const list of out) { list.sort((a, b) => a[0] - b[0]); list.forEach(([, h], i) => { pos[h] = i; }); }
  const from = (h) => (h & 1 ? edges[h >> 1][1] : edges[h >> 1][0]);
  const to = (h) => (h & 1 ? edges[h >> 1][0] : edges[h >> 1][1]);
  const next = (h) => {
    const v = to(h), twin = h ^ 1, list = out[v];
    const i = pos[twin];
    return list[(i - 1 + list.length) % list.length][1];
  };
  const uf = new UnionFind(verts.length);
  for (const [u, v] of edges) uf.union(u, v);
  const visited = new Uint8Array(edges.length * 2);
  const faces = [];
  for (let h0 = 0; h0 < edges.length * 2; h0++) {
    if (visited[h0]) continue;
    const ring = [], hs = [], halves = [];
    let h = h0, guard = 0;
    while (!visited[h] && guard++ < 4 * edges.length + 8) {
      visited[h] = 1; ring.push(verts[from(h)]); hs.push(h >> 1); halves.push(h);
      h = next(h);
    }
    faces.push({ ring, area: signedArea(ring), comp: uf.find(from(h0)), edges: hs, halves });
  }
  // components: their outer face (most negative area)
  const comps = new Map();
  for (const f of faces) {
    const c = comps.get(f.comp) || { id: f.comp, outer: null, faces: [] };
    comps.set(f.comp, c);
    c.faces.push(f);
    if (f.area <= 0 && (!c.outer || f.area < c.outer.area)) c.outer = f;
  }
  return { verts, edges, faces, comps: [...comps.values()] };
}

/**
 * Nest components: each component's outline lies inside the smallest bounded face of another component (a stair
 * trunk inside a lounge, a deckhouse inside the deck edge), which gets it as a hole. Returns
 * [{ face, ring, area (positive, minus holes), holes: [ring], comp }] for every bounded face.
 */
export function nestFaces(graph, { minArea = 0 } = {}) {
  const bounded = graph.faces.filter((f) => f.area > minArea).map((f) => ({ face: f, ring: f.ring, box: ringBox(f.ring), gross: f.area, holes: [], comp: f.comp }));
  bounded.sort((a, b) => a.gross - b.gross);
  for (const c of graph.comps) {
    if (!c.outer || c.outer.area >= 0) continue;
    const p = c.outer.ring[0];
    const q = innerPoint(c.outer.ring);
    const host = bounded.find((b) => b.comp !== c.id && b.gross > -c.outer.area && boxContains(b.box, p) && pointInRing(q || p, b.ring));
    if (host) host.holes.push({ ring: c.outer.ring, area: -c.outer.area, comp: c.id });
  }
  for (const b of bounded) b.area = b.gross - b.holes.reduce((s, h) => s + h.area, 0);
  return bounded;
}

// A vertex of the ring nudged a little outward of the component (so the containment test does not sit on a line).
function innerPoint(ring) {
  if (ring.length < 3) return null;
  const p = ring[0];
  return [p[0] + 1e-6, p[1] + 1e-6];
}

/** A point strictly inside a ring (for labels and tests): the centroid if inside, else a scanline midpoint. */
export function pointInside(ring, holes = []) {
  const c = centroid(ring);
  const ok = (p) => pointInRing(p, ring) && !holes.some((h) => pointInRing(p, h));
  if (ok(c)) return c;
  const b = ringBox(ring);
  for (let k = 1; k < 16; k++) {
    const y = b[1] + ((b[3] - b[1]) * k) / 16;
    const xs = crossingsAtY(ring, y);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const p = [(xs[i] + xs[i + 1]) / 2, y];
      if (ok(p)) return p;
    }
  }
  return c;
}

/** Clip a polygon by a convex polygon (Sutherland–Hodgman). Both counter-clockwise. */
export function clipConvex(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i], b = clip[(i + 1) % clip.length];
    const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-9;
    const input = out; out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j], q = input[(j + 1) % input.length];
      const pi = inside(p), qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) {
        const x = segIntersect([p[0], p[1], q[0], q[1]], [a[0], a[1], b[0], b[1]]);
        if (x) out.push([p[0] + (q[0] - p[0]) * x.t, p[1] + (q[1] - p[1]) * x.t]);
      }
    }
  }
  return out;
}

/** Clip a segment to a convex counter-clockwise polygon; returns the inner part or null. */
export function clipSegmentConvex(s, poly) {
  let t0 = 0, t1 = 1;
  const dx = s[2] - s[0], dy = s[3] - s[1];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const nx = -(b[1] - a[1]), ny = b[0] - a[0]; // inward normal for CCW
    const num = nx * (s[0] - a[0]) + ny * (s[1] - a[1]), den = nx * dx + ny * dy;
    if (Math.abs(den) < EPS) { if (num < 0) return null; continue; }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [s[0] + dx * t0, s[1] + dy * t0, s[0] + dx * t1, s[1] + dy * t1, s[4]];
}

/**
 * Connected groups of segments: two segments are in the same group when they come within `gap` of each other
 * (approximated on a grid of cell gap/2, so the effective joining distance is between gap/2 and gap·1.5).
 * Returns an Int32Array: group id per segment.
 */
export function groupSegments(segs, gap) {
  const uf = new UnionFind(segs.length);
  const cell = gap / 2;
  const rep = new Map();
  segs.forEach((s, i) => segmentCells(s, cell, (cx, cy) => {
    const k = cx * 1000003 + cy;
    const r = rep.get(k);
    if (r === undefined) rep.set(k, i); else uf.union(r, i);
  }));
  for (const [k, r] of rep) {
    const cy = ((k % 1000003) + 1000003) % 1000003 > 500000 ? (k % 1000003) - 1000003 : k % 1000003;
    const cx = Math.round((k - cy) / 1000003);
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      const o = rep.get((cx + dx) * 1000003 + (cy + dy));
      if (o !== undefined) uf.union(r, o);
    }
  }
  const out = new Int32Array(segs.length);
  for (let i = 0; i < segs.length; i++) out[i] = uf.find(i);
  return out;
}

/** a.push(...b) without spreading b into arguments (that overflows the call stack for very large drawings). */
export function append(a, b) {
  for (let i = 0; i < b.length; i++) a.push(b[i]);
  return a;
}
