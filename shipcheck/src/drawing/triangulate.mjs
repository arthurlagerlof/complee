// Polygon triangulation for floor slabs, equipment footprints and hull end caps: ear clipping with hole bridging.
// Pure JS, no DOM: runs in the browser, in a Worker and in Node.
//
// Drawings give polygons as they were traced: either winding, repeated points, points on a straight edge, a closing
// point equal to the first. All of that is cleaned first, so the ear clipper only sees a simple ring (outer
// counter-clockwise, holes clockwise). Holes are joined to the outer ring by a zero-width bridge (two coincident
// edges), which turns a polygon with holes into one ring the ear clipper can work on.

// cross(o, a, b) > 0: o -> a -> b turns left (counter-clockwise).
const cross = (ox, oy, ax, ay, bx, by) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

function ringArea(xs, ys) {
  let s = 0;
  for (let i = 0, n = xs.length, j = n - 1; i < n; j = i++) s += xs[j] * ys[i] - xs[i] * ys[j];
  return s / 2;
}

// Removes non-finite points, repeated points, the closing duplicate, points on a straight run and zero-width
// spikes. Returns { xs, ys, src } (src: index of each kept point in the input) or null when less than a triangle remains.
function cleanRing(pts, tol) {
  let xs = [], ys = [], src = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p) continue;
    const x = +p[0], y = +p[1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const n = xs.length;
    if (n && Math.abs(x - xs[n - 1]) <= tol && Math.abs(y - ys[n - 1]) <= tol) continue;
    xs.push(x); ys.push(y); src.push(i);
  }
  while (xs.length > 1 && Math.abs(xs[0] - xs[xs.length - 1]) <= tol && Math.abs(ys[0] - ys[ys.length - 1]) <= tol) { xs.pop(); ys.pop(); src.pop(); }
  // A point is dropped when it lies within tol of the line through its neighbours (straight run or spike). Removing
  // one can make its neighbour removable, so repeat until nothing changes.
  let changed = true;
  while (changed && xs.length >= 3) {
    changed = false;
    for (let i = 0; i < xs.length && xs.length >= 3; ) {
      const n = xs.length, p = (i + n - 1) % n, q = (i + 1) % n;
      const dx = xs[q] - xs[p], dy = ys[q] - ys[p], len = Math.hypot(dx, dy);
      const c = cross(xs[p], ys[p], xs[i], ys[i], xs[q], ys[q]);
      const same = Math.abs(xs[i] - xs[q]) <= tol && Math.abs(ys[i] - ys[q]) <= tol;
      if (same || len <= tol || Math.abs(c) <= tol * len) { xs.splice(i, 1); ys.splice(i, 1); src.splice(i, 1); changed = true; }
      else i++;
    }
  }
  if (xs.length < 3) return null;
  return { xs, ys, src };
}

// Bridge from the hole's right-most vertex M to a vertex of the outer ring it can see (D. Eberly, "Triangulation by
// ear clipping": cast a ray to +x, take the nearest edge hit, then the visible vertex closest in angle to the ray).
function bridgeHole(ring, hole, X, Y, eps) {
  let mi = 0;
  for (let k = 1; k < hole.length; k++) if (X[hole[k]] > X[hole[mi]]) mi = k;
  const M = hole[mi], mx = X[M], my = Y[M];
  const n = ring.length;
  let bestX = Infinity, bestK = -1;
  for (let k = 0; k < n; k++) {
    const a = ring[k], b = ring[(k + 1) % n];
    const ay = Y[a], by = Y[b];
    if (ay === by || my < Math.min(ay, by) || my > Math.max(ay, by)) continue;
    const x = X[a] + ((my - ay) * (X[b] - X[a])) / (by - ay);
    if (x < mx - eps || x >= bestX) continue;
    bestX = x; bestK = k;
  }
  if (bestK < 0) return null; // the hole is not inside the outer ring: ignored
  const ea = ring[bestK], eb = ring[(bestK + 1) % n];
  let P = X[ea] > X[eb] ? bestK : (bestK + 1) % n;
  // Any vertex inside the triangle M, ray hit, P could block the line of sight to P: take the one with the smallest
  // angle to the ray instead. Duplicates of a vertex (earlier bridges) are told apart by whether M lies inside the
  // corner at that vertex.
  const ix = bestX, iy = my, px = X[ring[P]], py = Y[ring[P]];
  const triSign = cross(mx, my, ix, iy, px, py) >= 0 ? 1 : -1;
  let bestTan = Infinity, bestDist = Infinity, chosen = -1;
  for (let k = 0; k < n; k++) {
    const r = ring[k], rx = X[r], ry = Y[r];
    const dx = rx - mx;
    if (dx <= eps && k !== P) continue;
    if (k !== P) {
      const s1 = triSign * cross(mx, my, ix, iy, rx, ry), s2 = triSign * cross(ix, iy, px, py, rx, ry), s3 = triSign * cross(px, py, mx, my, rx, ry);
      if (s1 < -eps || s2 < -eps || s3 < -eps) continue;
    }
    const pr = ring[(k + n - 1) % n], nx = ring[(k + 1) % n];
    const convex = cross(X[pr], Y[pr], rx, ry, X[nx], Y[nx]) >= 0;
    const left1 = cross(rx, ry, X[nx], Y[nx], mx, my) >= 0, left2 = cross(X[pr], Y[pr], rx, ry, mx, my) >= 0;
    if (!(convex ? left1 && left2 : left1 || left2)) continue;
    const tan = Math.abs(ry - my) / Math.max(dx, 1e-300), dist = dx * dx + (ry - my) * (ry - my);
    if (tan < bestTan - 1e-12 || (Math.abs(tan - bestTan) <= 1e-12 && dist < bestDist)) { bestTan = tan; bestDist = dist; chosen = k; }
  }
  if (chosen >= 0) P = chosen;
  // ring: ... P, M, hole (from M round to the vertex before M), M', P', ...  (M', P' are copies)
  const Pv = ring[P];
  const dupM = X.length; X.push(mx); Y.push(my);
  const dupP = X.length; X.push(X[Pv]); Y.push(Y[Pv]);
  const insert = [];
  for (let k = 0; k < hole.length; k++) insert.push(hole[(mi + k) % hole.length]);
  insert.push(dupM, dupP);
  ring.splice(P + 1, 0, ...insert);
  return [dupM, M, dupP, Pv];
}

function earClip(ring, X, Y, eps, out) {
  const n = ring.length;
  if (n < 3) return;
  const prev = new Int32Array(n), next = new Int32Array(n);
  for (let i = 0; i < n; i++) { prev[i] = (i + n - 1) % n; next[i] = (i + 1) % n; }
  const cr = (p, i, q) => cross(X[ring[p]], Y[ring[p]], X[ring[i]], Y[ring[i]], X[ring[q]], Y[ring[q]]);
  const remove = (i) => { next[prev[i]] = next[i]; prev[next[i]] = prev[i]; };
  const isEar = (p, i, q) => {
    const ax = X[ring[p]], ay = Y[ring[p]], bx = X[ring[i]], by = Y[ring[i]], cx = X[ring[q]], cy = Y[ring[q]];
    const x0 = Math.min(ax, bx, cx), x1 = Math.max(ax, bx, cx), y0 = Math.min(ay, by, cy), y1 = Math.max(ay, by, cy);
    for (let k = next[q]; k !== p; k = next[k]) {
      const r = ring[k], rx = X[r], ry = Y[r];
      if (rx < x0 || rx > x1 || ry < y0 || ry > y1) continue;
      // Only a reflex (or flat) vertex can lie inside an ear; copies of the triangle's corners do not block it.
      if (cr(prev[k], k, next[k]) > eps) continue;
      if ((rx === ax && ry === ay) || (rx === bx && ry === by) || (rx === cx && ry === cy)) continue;
      if (cross(ax, ay, bx, by, rx, ry) >= -eps && cross(bx, by, cx, cy, rx, ry) >= -eps && cross(cx, cy, ax, ay, rx, ry) >= -eps) return false;
    }
    return true;
  };
  let remaining = n, i = 0, stall = 0;
  while (remaining > 3) {
    const p = prev[i], q = next[i], c = cr(p, i, q);
    if (Math.abs(c) <= eps) { remove(i); remaining--; i = p; stall = 0; continue; } // flat corner: no area, drop it
    if (c > 0 && isEar(p, i, q)) {
      out.push(ring[p], ring[i], ring[q]);
      remove(i); remaining--; i = q; stall = 0;
      continue;
    }
    i = q;
    if (++stall > remaining) {
      // No clean ear (only on self-touching or otherwise broken input): clip the first convex corner anyway, so the
      // result covers the polygon as well as it can and the loop always ends.
      let j = i, found = -1;
      do { if (cr(prev[j], j, next[j]) > eps) { found = j; break; } j = next[j]; } while (j !== i);
      if (found < 0) { remove(i); remaining--; i = next[i]; }
      else { out.push(ring[prev[found]], ring[found], ring[next[found]]); remove(found); remaining--; i = next[found]; }
      stall = 0;
    }
  }
  const p = prev[i], q = next[i];
  if (cr(p, i, q) > eps) out.push(ring[p], ring[i], ring[q]);
}

/**
 * Triangulates a polygon with optional holes.
 * @param {Array<Array<[number, number]>>} rings  outer ring first, then holes; any winding, open or closed
 * @returns {{ xy: Float64Array, tris: Uint32Array, rings: Array<{ xs: number[], ys: number[] }>, src: Int32Array } | null}
 *   xy: vertex coordinates (x0, y0, x1, y1, ...), tris: counter-clockwise triangles into xy, rings: the cleaned rings
 *   (outer counter-clockwise, holes clockwise; their points are the first vertices of xy, in order), src: for each
 *   vertex, ringIndex * 2^20 + index of the input point. null when the outer ring has no area.
 */
export function triangulate(rings) {
  if (!Array.isArray(rings) || !rings.length || !Array.isArray(rings[0])) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of rings[0]) {
    if (!p || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) continue;
    x0 = Math.min(x0, +p[0]); x1 = Math.max(x1, +p[0]); y0 = Math.min(y0, +p[1]); y1 = Math.max(y1, +p[1]);
  }
  if (!(x1 > x0) || !(y1 > y0)) return null;
  const diag = Math.hypot(x1 - x0, y1 - y0);
  const tol = diag * 1e-7; // distance: repeated / collinear points
  const eps = diag * diag * 1e-12; // doubled triangle area treated as zero
  const cleaned = [];
  for (let r = 0; r < rings.length; r++) {
    if (!Array.isArray(rings[r])) continue;
    const c = cleanRing(rings[r], tol);
    if (!c) { if (r === 0) return null; continue; }
    const a = ringArea(c.xs, c.ys);
    if (Math.abs(a) <= eps) { if (r === 0) return null; continue; }
    if ((r === 0) !== (a > 0)) { c.xs.reverse(); c.ys.reverse(); c.src.reverse(); }
    c.ring = r;
    cleaned.push(c);
  }
  if (!cleaned.length || cleaned[0].ring !== 0) return null;
  const X = [], Y = [], SRC = [];
  const idx = cleaned.map((c) => c.xs.map((x, k) => { X.push(x); Y.push(c.ys[k]); SRC.push(c.ring * 1048576 + c.src[k]); return X.length - 1; }));
  const outer = idx[0];
  const holes = idx.slice(1).map((h) => ({ h, maxX: Math.max(...h.map((v) => X[v])) })).sort((a, b) => b.maxX - a.maxX);
  for (const { h } of holes) {
    const dups = bridgeHole(outer, h, X, Y, eps);
    if (dups) { SRC.push(SRC[dups[1]], SRC[dups[3]]); }
  }
  const tris = [];
  earClip(outer, X, Y, eps, tris);
  const xy = new Float64Array(X.length * 2);
  for (let k = 0; k < X.length; k++) { xy[2 * k] = X[k]; xy[2 * k + 1] = Y[k]; }
  return { xy, tris: Uint32Array.from(tris), rings: cleaned.map((c) => ({ xs: c.xs, ys: c.ys })), src: Int32Array.from(SRC) };
}

// Area of a triangulation (for tests and sanity checks).
export function triangulatedArea(t) {
  let s = 0;
  for (let k = 0; k < t.tris.length; k += 3) {
    const a = t.tris[k] * 2, b = t.tris[k + 1] * 2, c = t.tris[k + 2] * 2;
    s += cross(t.xy[a], t.xy[a + 1], t.xy[b], t.xy[b + 1], t.xy[c], t.xy[c + 1]) / 2;
  }
  return s;
}
