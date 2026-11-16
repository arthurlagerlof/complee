// Recon (what interpret.mjs read from the drawing) -> triangle meshes for the 3D viewer. See CONTRACT.md section 4.
//
// Output per element: { positions, normals, indices, color, box } in viewer scene coordinates (metres):
// X = x / 1000, Y = z / 1000 (height above the baseline), Z = -y / 1000 — the format ifc-convert.mjs returns and
// viewer3d.js setSource draws. `box` is the element's extent in model mm ({ min: [x, y, z], max }); it equals the
// mesh's bounding box except for rooms, whose mesh is only the floor slab but whose extent is the room volume.
// Walls also carry `colors` (per-vertex RGB, Float32Array): their top face is dark.
//
// Everything is built in model mm with model axes (x forward, y to port, z up) and converted when a vertex is
// written. (x, y, z) -> (X, Y, Z) = (x, z, -y) is a proper rotation, so counter-clockwise outward winding in model
// space stays counter-clockwise outward in the scene.
//
// Pure JS, typed arrays only: runs in a Worker. One growing scratch buffer is reused for every element and copied
// out at the end of each, so a drawing with thousands of walls does not allocate per vertex.
import { triangulate } from './triangulate.mjs';

const M = 0.001;
const Z_UP = [0, 0, 1];
export const COLORS = {
  hull: [0.30, 0.40, 0.52, 1],
  // Warm light greys: walls read as walls next to the zone-tinted floors; the shell a touch cooler.
  shell: [0.80, 0.82, 0.84, 1], bulkhead: [0.87, 0.85, 0.81, 1], partition: [0.94, 0.92, 0.89, 1],
  room: [0.80, 0.82, 0.84, 1], door: [0.55, 0.47, 0.38, 1], stair: [0.62, 0.65, 0.69, 1], ladder: [0.55, 0.59, 0.64, 1],
  window: [0.12, 0.18, 0.25, 1], equipment: [0.60, 0.58, 0.52, 1],
};
// The top face of a wall: dark, so the wall layout reads from above like the plan it came from.
const WALL_CAP = [0.27, 0.29, 0.33];
const SLAB = 50; // room floor slab, mm
// A wall reaching the deck above stops this far below that deck's elevation, under the deck plate the viewer draws
// 30 mm below it: otherwise its top would show through the floor above as a line of the deck below.
const UNDER_DECK = 40;
const LEAF = 40, LEAF_OPEN_DEG = 70, FRAME_W = 50, FRAME_D = 120; // door leaf and frame, mm
const WINDOW_PROUD = 20;
const TREAD_RISE = 180, STRINGER = 40;
const RUNG_STEP = 300, RAIL = 40, RUNG = 30;

// ---------------------------------------------------------------- scratch builder

let P = new Float32Array(3 * 16384), N = new Float32Array(3 * 16384), I = new Uint32Array(3 * 32768);
let nv = 0, ni = 0, bx0 = 0, by0 = 0, bz0 = 0, bx1 = 0, by1 = 0, bz1 = 0;

function begin() {
  nv = 0; ni = 0;
  bx0 = by0 = bz0 = Infinity; bx1 = by1 = bz1 = -Infinity;
}

function grow(a, need) {
  const b = new a.constructor(Math.max(need, a.length * 2));
  b.set(a);
  return b;
}

// Model mm position, unit model normal -> scene.
function vert(x, y, z, nx, ny, nz) {
  const k = nv * 3;
  if (k + 3 > P.length) { P = grow(P, k + 3); N = grow(N, k + 3); }
  P[k] = x * M; P[k + 1] = z * M; P[k + 2] = -y * M;
  N[k] = nx; N[k + 1] = nz; N[k + 2] = -ny;
  if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
  if (y < by0) by0 = y; if (y > by1) by1 = y;
  if (z < bz0) bz0 = z; if (z > bz1) bz1 = z;
  return nv++;
}

function tri(a, b, c) {
  if (ni + 3 > I.length) I = grow(I, ni + 3);
  I[ni++] = a; I[ni++] = b; I[ni++] = c;
}

function finish(color, box) {
  if (!ni) return null;
  return {
    positions: P.slice(0, nv * 3), normals: N.slice(0, nv * 3), indices: I.slice(0, ni), color,
    box: box ?? { min: [bx0, by0, bz0], max: [bx1, by1, bz1] },
  };
}

// ---------------------------------------------------------------- primitives

// Local frame: point = O + a*U + b*V + c*W with U x V = W (right-handed, unit vectors), so a counter-clockwise
// outline in (a, b) gets outward-facing caps and sides.
const C8 = new Float64Array(24);
function corner(O, U, V, W, a, b, c, k) {
  C8[k * 3] = O[0] + a * U[0] + b * V[0] + c * W[0];
  C8[k * 3 + 1] = O[1] + a * U[1] + b * V[1] + c * W[1];
  C8[k * 3 + 2] = O[2] + a * U[2] + b * V[2] + c * W[2];
}
function quad(i0, i1, i2, i3, nx, ny, nz) {
  const v = nv;
  vert(C8[i0 * 3], C8[i0 * 3 + 1], C8[i0 * 3 + 2], nx, ny, nz);
  vert(C8[i1 * 3], C8[i1 * 3 + 1], C8[i1 * 3 + 2], nx, ny, nz);
  vert(C8[i2 * 3], C8[i2 * 3 + 1], C8[i2 * 3 + 2], nx, ny, nz);
  vert(C8[i3 * 3], C8[i3 * 3 + 1], C8[i3 * 3 + 2], nx, ny, nz);
  tri(v, v + 1, v + 2); tri(v, v + 2, v + 3);
}

// Closed box [a0, a1] x [b0, b1] x [c0, c1] in the frame, flat-shaded (4 vertices per face).
function box(O, U, V, W, a0, a1, b0, b1, c0, c1) {
  if (!(a1 - a0 > 1e-6 && b1 - b0 > 1e-6 && c1 - c0 > 1e-6)) return;
  // corner index bits: 1 = a1, 2 = b1, 4 = c1
  for (let k = 0; k < 8; k++) corner(O, U, V, W, k & 1 ? a1 : a0, k & 2 ? b1 : b0, k & 4 ? c1 : c0, k);
  quad(4, 5, 7, 6, W[0], W[1], W[2]);
  quad(0, 2, 3, 1, -W[0], -W[1], -W[2]);
  quad(0, 1, 5, 4, -V[0], -V[1], -V[2]);
  quad(2, 6, 7, 3, V[0], V[1], V[2]);
  quad(0, 4, 6, 2, -U[0], -U[1], -U[2]);
  quad(1, 3, 7, 5, U[0], U[1], U[2]);
}

// Prism of a triangulated outline (from triangulate(), or convexOutline()) between c0 and c1 along W.
function extrude(t, O, U, V, W, c0, c1) {
  if (!t || !(c1 - c0 > 1e-6)) return;
  const xy = t.xy, nP = xy.length / 2;
  const at = (a, b, c, out) => {
    out[0] = O[0] + a * U[0] + b * V[0] + c * W[0];
    out[1] = O[1] + a * U[1] + b * V[1] + c * W[1];
    out[2] = O[2] + a * U[2] + b * V[2] + c * W[2];
  };
  const p = [0, 0, 0];
  for (const [c, s] of [[c1, 1], [c0, -1]]) {
    const base = nv;
    for (let k = 0; k < nP; k++) { at(xy[2 * k], xy[2 * k + 1], c, p); vert(p[0], p[1], p[2], s * W[0], s * W[1], s * W[2]); }
    for (let k = 0; k < t.tris.length; k += 3) {
      if (s > 0) tri(base + t.tris[k], base + t.tris[k + 1], base + t.tris[k + 2]);
      else tri(base + t.tris[k], base + t.tris[k + 2], base + t.tris[k + 1]);
    }
  }
  // Sides: outer ring counter-clockwise, holes clockwise, so the right-hand normal of each edge points out of the solid.
  for (const r of t.rings) {
    const n = r.xs.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r.xs[i], ay = r.ys[i], bx = r.xs[j], by = r.ys[j];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const la = dy / len, lb = -dx / len;
      const nx = la * U[0] + lb * V[0], ny = la * U[1] + lb * V[1], nz = la * U[2] + lb * V[2];
      at(ax, ay, c0, p); corner3(0, p); at(bx, by, c0, p); corner3(1, p); at(bx, by, c1, p); corner3(2, p); at(ax, ay, c1, p); corner3(3, p);
      quad(0, 1, 2, 3, nx, ny, nz);
    }
  }
}
function corner3(k, p) { C8[k * 3] = p[0]; C8[k * 3 + 1] = p[1]; C8[k * 3 + 2] = p[2]; }

// Counter-clockwise convex outline given as flat [a0, b0, a1, b1, ...]: fan triangulation, no ear clipping needed.
function convexOutline(flat) {
  const n = flat.length / 2, xs = [], ys = [];
  for (let k = 0; k < n; k++) { xs.push(flat[2 * k]); ys.push(flat[2 * k + 1]); }
  const tris = new Uint32Array(Math.max(0, n - 2) * 3);
  for (let k = 1; k + 1 < n; k++) { tris[(k - 1) * 3] = 0; tris[(k - 1) * 3 + 1] = k; tris[(k - 1) * 3 + 2] = k + 1; }
  return { xy: Float64Array.from(flat), tris, rings: [{ xs, ys }] };
}

function disc(r, segments = 16) {
  const flat = [];
  for (let k = 0; k < segments; k++) { const a = (2 * Math.PI * k) / segments; flat.push(r * Math.cos(a), r * Math.sin(a)); }
  return convexOutline(flat);
}

// ---------------------------------------------------------------- helpers

const num = (v, d = NaN) => {
  const x = v && typeof v === 'object' && 'value' in v ? +v.value : +v;
  return Number.isFinite(x) ? x : d;
};
const pt = (p) => (Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]) ? [+p[0], +p[1]] : null);
function unit2(d, fallback = [1, 0]) {
  const x = num(d?.[0], 0), y = num(d?.[1], 0), l = Math.hypot(x, y);
  return l > 1e-9 ? [x / l, y / l] : fallback;
}
const PLAN = (O2, z = 0) => [O2[0], O2[1], z];
const ORIGIN = [0, 0, 0], X_AX = [1, 0, 0], Y_AX = [0, 1, 0];

// ---------------------------------------------------------------- hull

// Resamples a polyline (ys, zs) to n points evenly spaced by arc length, so stations drawn with different point
// counts can be joined point for point.
function resample(ys, zs, n) {
  const m = ys.length, cum = new Float64Array(m);
  for (let k = 1; k < m; k++) cum[k] = cum[k - 1] + Math.hypot(ys[k] - ys[k - 1], zs[k] - zs[k - 1]);
  const total = cum[m - 1], oy = new Float64Array(n), oz = new Float64Array(n);
  if (!(total > 1e-9)) { oy.fill(ys[0]); oz.fill(zs[0]); return { ys: oy, zs: oz }; }
  let seg = 1;
  for (let j = 0; j < n; j++) {
    const s = (total * j) / (n - 1);
    while (seg < m - 1 && cum[seg] < s) seg++;
    const l = cum[seg] - cum[seg - 1], t = l > 1e-12 ? Math.min(1, Math.max(0, (s - cum[seg - 1]) / l)) : 0;
    oy[j] = ys[seg - 1] + (ys[seg] - ys[seg - 1]) * t;
    oz[j] = zs[seg - 1] + (zs[seg] - zs[seg - 1]) * t;
  }
  oy[n - 1] = ys[m - 1]; oz[n - 1] = zs[m - 1];
  return { ys: oy, zs: oz };
}

// x of a profile line (stem or stern: [[x, z], ...]) at height z, or null outside its height range.
function profileX(profile, z, pick) {
  let best = null;
  for (let k = 1; k < profile.length; k++) {
    const [xa, za] = profile[k - 1], [xb, zb] = profile[k];
    if (z < Math.min(za, zb) || z > Math.max(za, zb)) continue;
    const x = zb === za ? pick(xa, xb) : xa + ((z - za) * (xb - xa)) / (zb - za);
    best = best == null ? x : pick(best, x);
  }
  return best;
}

function prepareHull(hull) {
  const stations = [];
  for (const s of hull?.stations ?? []) {
    const x = num(s?.x);
    if (!Number.isFinite(x)) continue;
    let pts = (s.half ?? []).map(pt).filter(Boolean);
    if (!pts.length) continue;
    if (pts[0][1] > pts[pts.length - 1][1]) pts = pts.reverse(); // keel first
    // Port half: y >= 0. The section must start on the centreline, or the keel would stay open between the sides.
    pts = pts.map(([y, z]) => [Math.abs(y), z]);
    if (pts[0][0] > 0.5) pts.unshift([0, pts[0][1]]);
    stations.push({ x, pts });
  }
  stations.sort((a, b) => a.x - b.x);
  // Two stations at the same x would make zero-length quads: keep the first.
  const uniq = stations.filter((s, k) => k === 0 || s.x - stations[k - 1].x > 0.5);
  if (uniq.length < 2) return null;
  const n = Math.min(48, Math.max(12, ...uniq.map((s) => s.pts.length)));
  const secs = uniq.map((s) => {
    const r = resample(s.pts.map((p) => p[0]), s.pts.map((p) => p[1]), n);
    return { xs: new Float64Array(n).fill(s.x), ys: r.ys, zs: r.zs, x: s.x };
  });
  return { secs, n };
}

// Hull half-breadth at (x, z), from the resampled stations: places portholes on the hull surface.
function hullBreadthFn(prep) {
  if (!prep) return null;
  const { secs, n } = prep;
  const at = (s, z) => {
    if (z >= s.zs[n - 1]) return s.ys[n - 1];
    let best = 0;
    for (let j = 1; j < n; j++) {
      const za = s.zs[j - 1], zb = s.zs[j];
      if (z < Math.min(za, zb) || z > Math.max(za, zb)) continue;
      const y = zb === za ? Math.max(s.ys[j - 1], s.ys[j]) : s.ys[j - 1] + ((z - za) * (s.ys[j] - s.ys[j - 1])) / (zb - za);
      if (y > best) best = y;
    }
    return best;
  };
  return (x, z) => {
    if (x <= secs[0].x) return at(secs[0], z);
    if (x >= secs[secs.length - 1].x) return at(secs[secs.length - 1], z);
    let k = 1;
    while (secs[k].x < x) k++;
    const a = secs[k - 1], b = secs[k], t = (x - a.x) / (b.x - a.x);
    return at(a, z) * (1 - t) + at(b, z) * t;
  };
}

function buildHull(hull, prep) {
  if (!prep) return null;
  const { n } = prep;
  let secs = prep.secs.slice();
  const maxY = Math.max(...secs.map((s) => Math.max(...s.ys)));
  const tolY = Math.max(1, maxY * 0.002);
  const stern = (hull.stern ?? []).map(pt).filter(Boolean), stem = (hull.stem ?? []).map(pt).filter(Boolean);
  // Stern: where the profile reaches aft of the aftmost station (a raked or overhanging transom), that station's
  // section is carried aft to the profile at each height.
  if (stern.length >= 2) {
    const s0 = secs[0], xs = new Float64Array(n);
    let moved = false;
    for (let j = 0; j < n; j++) {
      const px = profileX(stern, s0.zs[j], Math.min);
      xs[j] = px == null ? s0.x : Math.min(s0.x, px);
      if (s0.x - xs[j] > 1) moved = true;
    }
    if (moved) secs.unshift({ xs, ys: s0.ys.slice(), zs: s0.zs.slice(), x: Math.min(...xs), pseudo: true });
  }
  // Stem: the bow closes on the centreline along the stem profile (or at the foremost station when there is none).
  {
    const s1 = secs[secs.length - 1];
    const open = Math.max(...s1.ys) > tolY;
    if (stem.length >= 2 || open) {
      const xs = new Float64Array(n);
      let moved = false;
      for (let j = 0; j < n; j++) {
        const px = stem.length >= 2 ? profileX(stem, s1.zs[j], Math.max) : null;
        xs[j] = px == null ? s1.xs[j] : Math.max(s1.xs[j], px);
        if (xs[j] - s1.xs[j] > 1) moved = true;
      }
      if (moved) secs.push({ xs, ys: new Float64Array(n), zs: s1.zs.slice(), x: Math.max(...xs), pseudo: true });
    }
  }
  // Smooth between stations: uniform Catmull-Rom on each longitudinal line, clamped to the range
  // of its four control points (no overshoot past the widest section, never across the centreline). The stem and
  // stern sections built above share points with their neighbour station, so they are joined straight, not smoothed.
  const sub = secs.length < 60 ? 3 : 1;
  const grid = [];
  for (let i = 0; i < secs.length; i++) {
    grid.push(secs[i]);
    if (i + 1 === secs.length || sub === 1 || secs[i].pseudo || secs[i + 1].pseudo) continue;
    const s1 = secs[i], s2 = secs[i + 1];
    let s0 = secs[Math.max(0, i - 1)], s3 = secs[Math.min(secs.length - 1, i + 2)];
    if (s0.pseudo) s0 = s1;
    if (s3.pseudo) s3 = s2;
    for (let q = 1; q < sub; q++) {
      const t = q / sub, t2 = t * t, t3 = t2 * t;
      const cr = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      const xs = new Float64Array(n), ys = new Float64Array(n), zs = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        xs[j] = s1.xs[j] + (s2.xs[j] - s1.xs[j]) * t;
        const yMax = Math.max(s0.ys[j], s1.ys[j], s2.ys[j], s3.ys[j]);
        ys[j] = Math.min(yMax, Math.max(0, cr(s0.ys[j], s1.ys[j], s2.ys[j], s3.ys[j])));
        const zMin = Math.min(s0.zs[j], s1.zs[j], s2.zs[j], s3.zs[j]), zMax = Math.max(s0.zs[j], s1.zs[j], s2.zs[j], s3.zs[j]);
        zs[j] = Math.min(zMax, Math.max(zMin, cr(s0.zs[j], s1.zs[j], s2.zs[j], s3.zs[j])));
      }
      grid.push({ xs, ys, zs });
    }
  }
  const S = grid.length, GX = new Float64Array(S * n), GY = new Float64Array(S * n), GZ = new Float64Array(S * n);
  grid.forEach((s, i) => { GX.set(s.xs, i * n); GY.set(s.ys, i * n); GZ.set(s.zs, i * n); });

  // Port surface triangles (i: along the ship, j: keel -> deck edge). (A, B, C) = (i j, i j+1, i+1 j) faces +y.
  const tris = [];
  const acc = new Float64Array(S * n * 3);
  const addTri = (a, b, c) => {
    const ux = GX[b] - GX[a], uy = GY[b] - GY[a], uz = GZ[b] - GZ[a];
    const vx = GX[c] - GX[a], vy = GY[c] - GY[a], vz = GZ[c] - GZ[a];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz < 1e-6) return; // collapsed (a stem station that is a single point): no triangle
    tris.push(a, b, c);
    for (const v of [a, b, c]) { acc[v * 3] += nx; acc[v * 3 + 1] += ny; acc[v * 3 + 2] += nz; }
  };
  for (let i = 0; i + 1 < S; i++) {
    for (let j = 0; j + 1 < n; j++) {
      const A = i * n + j, B = A + 1, C = A + n, D = C + 1;
      addTri(A, B, C); addTri(B, D, C);
    }
  }
  begin();
  // Smooth normals (area-weighted face normals per grid point); port and starboard get their own vertices, so the
  // keel and a closed stem stay a crease.
  const nrm = new Float64Array(S * n * 3);
  for (let v = 0; v < S * n; v++) {
    const x = acc[v * 3], y = acc[v * 3 + 1], z = acc[v * 3 + 2], l = Math.hypot(x, y, z);
    if (l > 1e-12) { nrm[v * 3] = x / l; nrm[v * 3 + 1] = y / l; nrm[v * 3 + 2] = z / l; } else nrm[v * 3 + 1] = 1;
  }
  const port = nv;
  for (let v = 0; v < S * n; v++) vert(GX[v], GY[v], GZ[v], nrm[v * 3], nrm[v * 3 + 1], nrm[v * 3 + 2]);
  const stbd = nv;
  for (let v = 0; v < S * n; v++) vert(GX[v], -GY[v], GZ[v], nrm[v * 3], -nrm[v * 3 + 1], nrm[v * 3 + 2]);
  for (let k = 0; k < tris.length; k += 3) {
    tri(port + tris[k], port + tris[k + 1], port + tris[k + 2]);
    tri(stbd + tris[k], stbd + tris[k + 2], stbd + tris[k + 1]); // mirrored: winding reversed
  }
  // End caps: the transom (aft) and a bow that does not close on the centreline. The section outline (port from the
  // keel up, starboard back down) is triangulated in (y, z); its vertices are the surface's own edge points, so the
  // cap closes the surface exactly. Facing: (y, z) counter-clockwise faces +x; the transom must face -x.
  const cap = (i, facing) => {
    const o = i * n;
    let open = false;
    for (let j = 0; j < n; j++) if (GY[o + j] > tolY) open = true;
    if (!open) return;
    const ring = [], ids = [];
    for (let j = 0; j < n; j++) { ring.push([GY[o + j], GZ[o + j]]); ids.push(o + j); }
    for (let j = n - 1; j >= 0; j--) { ring.push([-GY[o + j], GZ[o + j]]); ids.push(-(o + j) - 1); }
    const t = triangulate([ring]);
    if (!t) return;
    const base = nv, count = t.xy.length / 2;
    for (let k = 0; k < count; k++) {
      const id = ids[t.src[k] & 1048575], g = id >= 0 ? id : -id - 1;
      vert(GX[g], id >= 0 ? GY[g] : -GY[g], GZ[g], facing, 0, 0);
    }
    for (let k = 0; k < t.tris.length; k += 3) {
      if (facing > 0) tri(base + t.tris[k], base + t.tris[k + 1], base + t.tris[k + 2]);
      else tri(base + t.tris[k], base + t.tris[k + 2], base + t.tris[k + 1]);
    }
  };
  cap(0, -1);
  cap(S - 1, 1);
  return finish(COLORS.hull);
}

// ---------------------------------------------------------------- walls

// At a corner both walls end on the same point; extending each by half the other's thickness fills the notch.
// Returns per wall [extension at a, extension at b] in mm.
function wallExtensions(walls) {
  const ext = new Float64Array(walls.length * 2);
  const CELL = 1000, grid = new Map();
  const key = (deck, ix, iy) => `${deck}|${ix}|${iy}`;
  const ends = walls.map((w, k) => {
    if (!w) return null;
    const ux = w.b[0] - w.a[0], uy = w.b[1] - w.a[1], l = Math.hypot(ux, uy);
    return { k, deck: w.deck, ux: ux / l, uy: uy / l, t: w.t, p: [w.a, w.b] };
  });
  for (const e of ends) {
    if (!e) continue;
    for (let s = 0; s < 2; s++) {
      const kk = key(e.deck, Math.floor(e.p[s][0] / CELL), Math.floor(e.p[s][1] / CELL));
      let list = grid.get(kk);
      if (!list) grid.set(kk, (list = []));
      list.push(e.k * 2 + s);
    }
  }
  for (const e of ends) {
    if (!e) continue;
    for (let s = 0; s < 2; s++) {
      const [x, y] = e.p[s], ix = Math.floor(x / CELL), iy = Math.floor(y / CELL);
      let best = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        for (const ref of grid.get(key(e.deck, ix + dx, iy + dy)) ?? []) {
          const o = ends[ref >> 1];
          if (o.k === e.k) continue;
          const q = o.p[ref & 1];
          if (Math.hypot(q[0] - x, q[1] - y) > Math.max(e.t, o.t, 10)) continue;
          if (Math.abs(e.ux * o.uy - e.uy * o.ux) < 0.2) continue; // in line: nothing to fill
          best = Math.max(best, o.t / 2);
        }
      }
      ext[e.k * 2 + s] = best;
    }
  }
  return ext;
}

function prepareWalls(list) {
  return list.map((w) => {
    const a = pt(w?.a), b = pt(w?.b), z0 = num(w?.z0), z1 = num(w?.z1);
    if (!a || !b || !(Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.5) || !(z1 > z0) || w.id == null) return null;
    return { src: w, id: w.id, deck: w.deck, a, b, z0, z1, t: num(w.thickness, 10) > 0 ? num(w.thickness, 10) : 10 };
  });
}

function buildWall(w, eA, eB) {
  const [ax, ay] = w.a, L = Math.hypot(w.b[0] - ax, w.b[1] - ay);
  const U = [(w.b[0] - ax) / L, (w.b[1] - ay) / L, 0], V = [-U[1], U[0], 0], O = [ax, ay, 0];
  const s0 = -eA, s1 = L + eB, ht = w.t / 2;
  const ops = [];
  for (const o of w.src.openings ?? []) {
    let f = num(o?.from), t = num(o?.to);
    if (!Number.isFinite(f) || !Number.isFinite(t)) continue;
    if (f > t) [f, t] = [t, f];
    f = Math.max(f, 0); t = Math.min(t, L);
    const oz0 = Math.max(num(o.z0, w.z0), w.z0), oz1 = Math.min(num(o.z1, w.z1), w.z1);
    if (t - f > 0.5 && oz1 - oz0 > 0.5) ops.push({ f, t, z0: oz0, z1: oz1 });
  }
  begin();
  const cuts = [s0, s1];
  for (const o of ops) cuts.push(o.f, o.t);
  cuts.sort((p, q) => p - q);
  for (let k = 0; k + 1 < cuts.length; k++) {
    const a0 = cuts[k], a1 = cuts[k + 1];
    if (a1 - a0 < 0.5) continue;
    const mid = (a0 + a1) / 2;
    // Solid height ranges of this piece: the wall height minus every opening over it (door: lintel above;
    // window: sill below and head above).
    let solid = [[w.z0, w.z1]];
    for (const o of ops) {
      if (o.f > mid || o.t < mid) continue;
      const next = [];
      for (const [lo, hi] of solid) {
        if (o.z1 <= lo || o.z0 >= hi) { next.push([lo, hi]); continue; }
        if (o.z0 > lo) next.push([lo, o.z0]);
        if (o.z1 < hi) next.push([o.z1, hi]);
      }
      solid = next;
    }
    for (const [lo, hi] of solid) if (hi - lo > 0.5) box(O, U, V, Z_UP, a0, a1, -ht, ht, lo, hi);
  }
  const color = COLORS[w.src.kind] ?? COLORS.partition;
  const g = finish(color);
  if (g) {
    // Per-vertex colours (the viewer's merged wall batch uses them): the faces at the wall's top are the dark cap.
    const n = g.positions.length / 3, colors = new Float32Array(n * 3), topY = w.z1 * M - 1e-6;
    for (let v = 0; v < n; v++) {
      const cap = g.normals[v * 3 + 1] > 0.99 && g.positions[v * 3 + 1] >= topY;
      colors[v * 3] = cap ? WALL_CAP[0] : color[0]; colors[v * 3 + 1] = cap ? WALL_CAP[1] : color[1]; colors[v * 3 + 2] = cap ? WALL_CAP[2] : color[2];
    }
    g.colors = colors;
    if (w.src.kind === 'shell') g.role = 'shell'; // the viewer draws outer walls see-through (a cutaway look)
  }
  return g;
}

// Walls whose top is at (or within 60 mm of) a deck above end UNDER_DECK below it.
function underDeckAbove(walls, decks) {
  const elevations = (decks ?? []).map((d) => num(d?.elevation)).filter(Number.isFinite);
  for (const w of walls) {
    if (!w) continue;
    for (const e of elevations) {
      if (e > w.z0 + UNDER_DECK && Math.abs(w.z1 - e) <= 60) { w.z1 = Math.min(w.z1, e - UNDER_DECK); break; }
    }
  }
}

// ---------------------------------------------------------------- rooms, equipment

function polygonRings(item) {
  const outer = (item.polygon ?? []).map(pt).filter(Boolean);
  const holes = (item.holes ?? []).map((h) => (h ?? []).map(pt).filter(Boolean)).filter((h) => h.length >= 3);
  return [outer, ...holes];
}

function buildRoom(r) {
  const z0 = num(r.z0, 0), z1 = num(r.z1, z0 + SLAB);
  const t = triangulate(polygonRings(r));
  if (!t) return null;
  begin();
  extrude(t, ORIGIN, X_AX, Y_AX, Z_UP, z0, z0 + SLAB);
  // The mesh is the floor; the element's extent is the room (rules read its height, the viewer frames the volume).
  return finish(COLORS.room, ni ? { min: [bx0, by0, z0], max: [bx1, by1, Math.max(z1, z0 + SLAB)] } : undefined);
}

function buildEquipment(e) {
  const z0 = num(e.z0, 0), z1 = num(e.z1);
  if (!(z1 > z0)) return null;
  const t = triangulate(polygonRings(e));
  if (!t) return null;
  begin();
  extrude(t, ORIGIN, X_AX, Y_AX, Z_UP, z0, z1);
  return finish(COLORS.equipment);
}

// ---------------------------------------------------------------- doors

function buildDoor(d, pairedLatch) {
  const h = pt(d.hinge), w = num(d.width), z0 = num(d.z0), z1 = num(d.z1);
  if (!h || !(w > 0) || !(z1 > z0)) return null;
  const [dx, dy] = unit2(d.wallDir), nx = -dy, ny = dx, s = num(d.swing, 1) < 0 ? -1 : 1;
  const O = PLAN(h);
  begin();
  // Leaf, opened LEAF_OPEN_DEG towards the swing side: the opening stays visible and the swing reads at a glance.
  const ang = (LEAF_OPEN_DEG * Math.PI) / 180, c = Math.cos(ang), sn = Math.sin(ang) * s;
  const lu = [dx * c + nx * sn, dy * c + ny * sn, 0], lv = [-lu[1], lu[0], 0];
  box(O, lu, lv, Z_UP, 0, w, -LEAF / 2, LEAF / 2, z0, z1);
  // Frame: jambs outside the clear width and a head above it. The latch jamb is left out where a second leaf of a
  // double door closes against this one.
  const U = [dx, dy, 0], V = [nx, ny, 0], hd = FRAME_D / 2;
  box(O, U, V, Z_UP, -FRAME_W, 0, -hd, hd, z0, z1 + FRAME_W);
  if (!pairedLatch) box(O, U, V, Z_UP, w, w + FRAME_W, -hd, hd, z0, z1 + FRAME_W);
  box(O, U, V, Z_UP, 0, w, -hd, hd, z1, z1 + FRAME_W);
  return finish(COLORS.door);
}

// Doors whose latch points meet with opposite directions are the two leaves of one double door.
function pairedDoors(doors) {
  const paired = new Set(), byDeck = new Map();
  for (const d of doors) {
    const h = pt(d?.hinge), w = num(d?.width);
    if (!h || !(w > 0)) continue;
    const [dx, dy] = unit2(d.wallDir);
    const e = { d, dx, dy, lx: h[0] + dx * w, ly: h[1] + dy * w };
    let list = byDeck.get(d.deck);
    if (!list) byDeck.set(d.deck, (list = []));
    list.push(e);
  }
  for (const list of byDeck.values()) {
    list.sort((p, q) => p.lx - q.lx);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length && list[j].lx - list[i].lx <= 60; j++) {
        const p = list[i], q = list[j];
        if (Math.hypot(p.lx - q.lx, p.ly - q.ly) <= 60 && p.dx * q.dx + p.dy * q.dy < -0.9) { paired.add(p.d); paired.add(q.d); }
      }
    }
  }
  return paired;
}

// ---------------------------------------------------------------- stairs, ladders

function buildStair(st) {
  const poly = (st.polygon ?? []).map(pt).filter(Boolean), z0 = num(st.z0), z1 = num(st.z1);
  if (poly.length < 3 || !(z1 > z0)) return null;
  let d = unit2(st.dir, null);
  if (!d) {
    const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
    d = Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys) ? [1, 0] : [0, 1];
  }
  const pp = [-d[1], d[0]];
  // The flight fills the polygon's rectangle aligned with the walking direction.
  let smin = Infinity, smax = -Infinity, tmin = Infinity, tmax = -Infinity;
  for (const [x, y] of poly) {
    const s = x * d[0] + y * d[1], t = x * pp[0] + y * pp[1];
    smin = Math.min(smin, s); smax = Math.max(smax, s); tmin = Math.min(tmin, t); tmax = Math.max(tmax, t);
  }
  if (!(smax - smin > 1 && tmax - tmin > 1)) return null;
  const n = num(st.treads) >= 1 ? Math.round(num(st.treads)) : Math.max(1, Math.round((z1 - z0) / TREAD_RISE));
  const run = (smax - smin) / n, rise = (z1 - z0) / n, sw = Math.min(STRINGER, (tmax - tmin) / 6);
  const U = [d[0], d[1], 0], V = [pp[0], pp[1], 0];
  begin();
  for (let i = 0; i < n; i++) box(ORIGIN, U, V, Z_UP, smin + i * run, smin + (i + 1) * run, tmin + sw, tmax - sw, z0, z0 + (i + 1) * rise);
  // Stringers: a band one rise deep under the nosing line, on both sides. Profile in (along, height), extruded
  // across: frame U = walking direction, V = up, W = U x V = -V(plan).
  const W = [d[1], -d[0], 0];
  const prof = convexOutline([smin, z0, smax, z1 - rise, smax, z1, smin, z0 + rise]); // one step: a rectangle
  extrude(prof, ORIGIN, U, Z_UP, W, -(tmin + sw), -tmin);
  extrude(prof, ORIGIN, U, Z_UP, W, -tmax, -(tmax - sw));
  return finish(COLORS.stair);
}

function buildLadder(l) {
  const at = pt(l.at), z0 = num(l.z0), z1 = num(l.z1);
  if (!at || !(z1 > z0)) return null;
  const w = num(l.width, 400) > 0 ? num(l.width, 400) : 400;
  // dir: the way the ladder faces (the climber looks against it); rungs run across it.
  const [dx, dy] = unit2(l.dir);
  const U = [-dy, dx, 0], V = [-dx, -dy, 0], O = PLAN(at); // U x V = +z
  begin();
  box(O, U, V, Z_UP, -w / 2 - RAIL, -w / 2, -RAIL / 2, RAIL / 2, z0, z1);
  box(O, U, V, Z_UP, w / 2, w / 2 + RAIL, -RAIL / 2, RAIL / 2, z0, z1);
  for (let z = z0 + RUNG_STEP; z + RUNG / 2 <= z1; z += RUNG_STEP) box(O, U, V, Z_UP, -w / 2, w / 2, -RUNG / 2, RUNG / 2, z - RUNG / 2, z + RUNG / 2);
  return finish(COLORS.ladder);
}

// ---------------------------------------------------------------- windows

function buildWindow(win, ctx) {
  const at = pt(win.at);
  const r = num(win.r), width = num(win.width), size = r > 0 ? 2 * r : width > 0 ? width : 400;
  const z = num(win.z, num(win.z0, 0) + size / 2);
  begin();
  const hit = ctx.openingOf.get(win.id);
  if (hit) {
    // In a wall opening: a pane filling the opening, standing WINDOW_PROUD out of both wall faces.
    const { wall: w, op } = hit;
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    const U = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L, 0], V = [-U[1], U[0], 0];
    const f = Math.max(0, Math.min(num(op.from), num(op.to))), t = Math.min(L, Math.max(num(op.from), num(op.to)));
    const oz0 = num(op.z0, z - size / 2), oz1 = num(op.z1, z + size / 2), ht = w.t / 2 + WINDOW_PROUD;
    if (r > 0) {
      const O = [w.a[0] + U[0] * (f + t) / 2, w.a[1] + U[1] * (f + t) / 2, (oz0 + oz1) / 2];
      extrude(disc(Math.min(r, (t - f) / 2, (oz1 - oz0) / 2)), O, [-U[0], -U[1], 0], Z_UP, V, -ht, ht);
    } else box(PLAN(w.a), U, V, Z_UP, f, t, -ht, ht, oz0, oz1);
    return finish(COLORS.window);
  }
  if (!at) return null;
  const wall = ctx.nearestWall(win.deck, at);
  let O, Wn, c0, c1;
  if (wall) {
    const L = Math.hypot(wall.b[0] - wall.a[0], wall.b[1] - wall.a[1]);
    const ux = (wall.b[0] - wall.a[0]) / L, uy = (wall.b[1] - wall.a[1]) / L;
    const s = (at[0] - wall.a[0]) * ux + (at[1] - wall.a[1]) * uy;
    O = [wall.a[0] + ux * s, wall.a[1] + uy * s, z];
    Wn = [-uy, ux, 0];
    c0 = -wall.t / 2 - WINDOW_PROUD; c1 = wall.t / 2 + WINDOW_PROUD;
  } else {
    // In the hull side: on the surface at that height, facing out along the side's horizontal normal.
    const side = at[1] < 0 ? -1 : 1;
    let y = Math.abs(at[1]), slope = 0;
    if (ctx.breadth) {
      y = ctx.breadth(at[0], z);
      slope = (ctx.breadth(at[0] + 200, z) - ctx.breadth(at[0] - 200, z)) / 400;
    }
    const l = Math.hypot(slope, 1);
    O = [at[0], side * y, z];
    Wn = [-slope / l, side / l, 0];
    c0 = -WINDOW_PROUD - 10; c1 = WINDOW_PROUD;
  }
  const U = [-Wn[1], Wn[0], 0]; // Z x W: U x Z = W
  const outline = r > 0 ? disc(r) : convexOutline([-size / 2, -size / 2, size / 2, -size / 2, size / 2, size / 2, -size / 2, size / 2]);
  extrude(outline, O, U, Z_UP, Wn, c0, c1);
  return finish(COLORS.window);
}

function windowContext(walls, breadth) {
  const openingOf = new Map(), byDeck = new Map();
  for (const w of walls) {
    if (!w) continue;
    for (const op of w.src.openings ?? []) if (op?.ref != null && op.kind === 'window') openingOf.set(op.ref, { wall: w, op });
    let list = byDeck.get(w.deck);
    if (!list) byDeck.set(w.deck, (list = []));
    list.push(w);
  }
  // Wall within reach of the point (on its centreline +- half thickness and 300 mm), nearest first.
  const nearestWall = (deck, p) => {
    let best = null, bestD = Infinity;
    for (const w of byDeck.get(deck) ?? []) {
      const ex = w.b[0] - w.a[0], ey = w.b[1] - w.a[1], l2 = ex * ex + ey * ey;
      const t = Math.max(0, Math.min(1, ((p[0] - w.a[0]) * ex + (p[1] - w.a[1]) * ey) / l2));
      const dd = Math.hypot(p[0] - w.a[0] - ex * t, p[1] - w.a[1] - ey * t);
      if (dd <= w.t / 2 + 300 && dd < bestD) { bestD = dd; best = w; }
    }
    return best;
  };
  return { openingOf, nearestWall, breadth };
}

// ---------------------------------------------------------------- public

/**
 * @param {object} recon  CONTRACT.md section 3
 * @returns {Map<string, { positions: Float32Array, normals: Float32Array, indices: Uint32Array, color: number[], box: { min: number[], max: number[] } }>}
 */
export function buildGeometry(recon) {
  const out = new Map();
  if (!recon) return out;
  // One broken item (missing points, NaN) must not cost the whole drawing: it is skipped, the rest is built.
  const put = (id, fn) => {
    if (id == null) return;
    let g = null;
    try { g = fn(); } catch { g = null; }
    if (g) out.set(id, g); // same key as the model element id (the viewer looks it up by el.id)
  };
  const hullPrep = recon.hull ? prepareHull(recon.hull) : null;
  if (recon.hull) put(recon.hull.id ?? 'hull', () => buildHull(recon.hull, hullPrep));
  const walls = prepareWalls(recon.walls ?? []);
  underDeckAbove(walls, recon.decks);
  const ext = wallExtensions(walls);
  walls.forEach((w, k) => { if (w) put(w.id, () => buildWall(w, ext[k * 2], ext[k * 2 + 1])); });
  for (const r of recon.rooms ?? []) put(r?.id, () => buildRoom(r));
  const paired = pairedDoors(recon.doors ?? []);
  for (const d of recon.doors ?? []) put(d?.id, () => buildDoor(d, paired.has(d)));
  for (const s of recon.stairs ?? []) put(s?.id, () => buildStair(s));
  for (const l of recon.ladders ?? []) put(l?.id, () => buildLadder(l));
  const ctx = windowContext(walls, hullBreadthFn(hullPrep));
  for (const w of recon.windows ?? []) put(w?.id, () => buildWindow(w, ctx));
  for (const e of recon.equipment ?? []) put(e?.id, () => buildEquipment(e));
  return out;
}

/**
 * Element extents in model mm (x forward, y to port, z above the baseline). Uses the `box` buildGeometry stores;
 * geometry from elsewhere (IFC) is measured from its positions.
 * @returns {Map<string, { min: [number, number, number], max: [number, number, number] }>}
 */
export function geometryBoxes(geometry) {
  const boxes = new Map();
  for (const [id, g] of geometry ?? []) {
    if (g?.box && g.box.min?.every(Number.isFinite) && g.box.max?.every(Number.isFinite)) { boxes.set(id, { min: [...g.box.min], max: [...g.box.max] }); continue; }
    const p = g?.positions;
    if (!p?.length) continue;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < p.length; k += 3) {
      const x = p[k] * 1000, y = -p[k + 2] * 1000, z = p[k + 1] * 1000;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    if (Number.isFinite(x0)) boxes.set(id, { min: [x0, y0, z0], max: [x1, y1, z1] });
  }
  return boxes;
}

/** Sets each element's geom from its geometry box (z relative to its deck's elevation, sizes at least 1 mm). */
export function applyBoxes(model, geometry) {
  const boxes = geometryBoxes(geometry);
  const elevation = new Map((model?.decks ?? []).map((d) => [d.id, num(d.elevation, 0)]));
  for (const el of model?.elements ?? []) {
    const b = boxes.get(el.id);
    if (!b) continue;
    const e = elevation.get(el.deck) ?? 0;
    el.geom = {
      x: Math.round(b.min[0]) + 0, y: Math.round(b.min[1]) + 0, z: Math.round(b.min[2] - e) + 0,
      lx: Math.max(1, Math.round(b.max[0] - b.min[0])), ly: Math.max(1, Math.round(b.max[1] - b.min[1])), h: Math.max(1, Math.round(b.max[2] - b.min[2])),
    };
  }
  return model;
}
