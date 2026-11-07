// Picking index for the local viewer (viewer-local.js), off the main thread: the main chunks and the "Full model"
// rest chunks. The main thread hands over each chunk's positions, triangle indices and per-vertex dbIds once the geometry is
// on the GPU; this worker builds a bounding volume hierarchy (BVH) per chunk and answers ray and box queries.
// Plain JavaScript without imports (module workers do not see the page's import map).
//
// Messages in:  { type: 'chunk', id, pos: {buffer, byteOffset, length, ctor, stride, offset, scale}, index: {...}, ids: {...} }
//               { type: 'ray', qid, rays: [{ id, o: [x,y,z], d: [x,y,z] }] }   (ray in the chunk's local space)
//               { type: 'box', qid, id, db }
// Messages out: { type: 'ready', id, ms, triangles } | { type: 'hits', qid, hits: [{ id, db, v, p }] } | { type: 'box', qid, min, max }
'use strict';

const LEAF = 8;
const chunks = new Map();
const CTORS = { Float32Array, Uint32Array, Uint16Array, Int16Array, Uint8Array, Int8Array };
const view = (d) => new CTORS[d.ctor](d.buffer, d.byteOffset, d.length);

function build(c) {
  const t0 = performance.now();
  const P = c.pos, st = c.stride, of = c.offset, I = c.index;
  const T = I.length / 3;
  const tri = new Uint32Array(T);
  const cen = new Float32Array(T * 3);
  for (let t = 0; t < T; t++) {
    tri[t] = t;
    const a = I[3 * t] * st + of, b = I[3 * t + 1] * st + of, d = I[3 * t + 2] * st + of;
    cen[3 * t] = (P[a] + P[b] + P[d]) / 3;
    cen[3 * t + 1] = (P[a + 1] + P[b + 1] + P[d + 1]) / 3;
    cen[3 * t + 2] = (P[a + 2] + P[b + 2] + P[d + 2]) / 3;
  }
  let cap = Math.max(16, Math.ceil(T / LEAF) * 2 + 16);
  let box = new Float32Array(cap * 6), data = new Uint32Array(cap * 3); // data: [leftChild | start, count (0 = inner), _]
  let nodes = 0;
  const grow = () => {
    cap *= 2;
    const b2 = new Float32Array(cap * 6); b2.set(box); box = b2;
    const d2 = new Uint32Array(cap * 3); d2.set(data); data = d2;
  };
  const bounds = (n, s, e) => {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = s; k < e; k++) {
      const t = tri[k];
      for (let j = 0; j < 3; j++) {
        const v = I[3 * t + j] * st + of;
        const x = P[v], y = P[v + 1], z = P[v + 2];
        if (x < x0) x0 = x; if (y < y0) y0 = y; if (z < z0) z0 = z;
        if (x > x1) x1 = x; if (y > y1) y1 = y; if (z > z1) z1 = z;
      }
    }
    box.set([x0, y0, z0, x1, y1, z1], n * 6);
  };
  // quickselect on tri[s..e) by centroid along axis so that the k-th element is in place
  const select = (s, e, k, ax) => {
    let lo = s, hi = e - 1;
    while (lo < hi) {
      const pv = cen[3 * tri[(lo + hi) >> 1] + ax];
      let i = lo, j = hi;
      while (i <= j) {
        while (cen[3 * tri[i] + ax] < pv) i++;
        while (cen[3 * tri[j] + ax] > pv) j--;
        if (i <= j) { const x = tri[i]; tri[i] = tri[j]; tri[j] = x; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else break;
    }
  };
  const stack = [[0, 0, T]];
  nodes = 1;
  while (stack.length) {
    const [n, s, e] = stack.pop();
    bounds(n, s, e);
    if (e - s <= LEAF) { data[n * 3] = s; data[n * 3 + 1] = e - s; continue; }
    // split along the longest axis of the centroids, in the middle; object median if everything falls on one side
    let c0 = [Infinity, Infinity, Infinity], c1 = [-Infinity, -Infinity, -Infinity];
    for (let k = s; k < e; k++) { const t = tri[k]; for (let a = 0; a < 3; a++) { const v = cen[3 * t + a]; if (v < c0[a]) c0[a] = v; if (v > c1[a]) c1[a] = v; } }
    const ax = c1[0] - c0[0] >= c1[1] - c0[1] && c1[0] - c0[0] >= c1[2] - c0[2] ? 0 : c1[1] - c0[1] >= c1[2] - c0[2] ? 1 : 2;
    const mid = (c0[ax] + c1[ax]) / 2;
    let i = s, j = e - 1;
    while (i <= j) {
      if (cen[3 * tri[i] + ax] < mid) i++;
      else { const x = tri[i]; tri[i] = tri[j]; tri[j] = x; j--; }
    }
    let m = i;
    if (m === s || m === e) { m = (s + e) >> 1; select(s, e, m, ax); }
    while (nodes + 2 > cap) grow();
    const l = nodes; nodes += 2;
    data[n * 3] = l; data[n * 3 + 1] = 0;
    stack.push([l, s, m], [l + 1, m, e]);
  }
  c.tri = tri; c.box = box; c.data = data; c.nodes = nodes;
  return performance.now() - t0;
}

// All hits along the ray (sorted by t): the main thread skips hidden or cut-away parts, so it may need hits behind them.
function raycast(c, o, d, max = Infinity) {
  const P = c.pos, st = c.stride, of = c.offset, I = c.index, box = c.box, data = c.data, tri = c.tri;
  const ix = 1 / d[0], iy = 1 / d[1], iz = 1 / d[2];
  const hits = []; // sorted by t, at most `max`
  const worst = () => (hits.length < max ? Infinity : hits[hits.length - 1].t);
  const stack = [0];
  while (stack.length) {
    const n = stack.pop();
    const b = n * 6;
    let t0 = ((ix >= 0 ? box[b] : box[b + 3]) - o[0]) * ix, t1 = ((ix >= 0 ? box[b + 3] : box[b]) - o[0]) * ix;
    const ty0 = ((iy >= 0 ? box[b + 1] : box[b + 4]) - o[1]) * iy, ty1 = ((iy >= 0 ? box[b + 4] : box[b + 1]) - o[1]) * iy;
    if (t0 > ty1 || ty0 > t1) continue;
    if (ty0 > t0) t0 = ty0; if (ty1 < t1) t1 = ty1;
    const tz0 = ((iz >= 0 ? box[b + 2] : box[b + 5]) - o[2]) * iz, tz1 = ((iz >= 0 ? box[b + 5] : box[b + 2]) - o[2]) * iz;
    if (t0 > tz1 || tz0 > t1) continue;
    if (tz0 > t0) t0 = tz0; if (tz1 < t1) t1 = tz1;
    if (t1 < 0 || t0 > worst()) continue;
    const cnt = data[n * 3 + 1];
    if (!cnt) { stack.push(data[n * 3], data[n * 3] + 1); continue; }
    for (let k = data[n * 3], e = k + cnt; k < e; k++) {
      const t = tri[k];
      const a = I[3 * t] * st + of, bb = I[3 * t + 1] * st + of, cc = I[3 * t + 2] * st + of;
      // Möller–Trumbore, both sides
      const e1x = P[bb] - P[a], e1y = P[bb + 1] - P[a + 1], e1z = P[bb + 2] - P[a + 2];
      const e2x = P[cc] - P[a], e2y = P[cc + 1] - P[a + 1], e2z = P[cc + 2] - P[a + 2];
      const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det > -1e-12 && det < 1e-12) continue;
      const inv = 1 / det;
      const sx = o[0] - P[a], sy = o[1] - P[a + 1], sz = o[2] - P[a + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (tt <= 0 || tt >= worst()) continue;
      const db = c.ids[I[3 * t]];
      let pos = hits.findIndex((h) => h.t > tt);
      if (pos < 0) pos = hits.length;
      hits.splice(pos, 0, { t: tt, db, v: I[3 * t] });
      if (hits.length > max) hits.pop();
    }
  }
  return hits;
}

onmessage = (e) => {
  const m = e.data;
  if (m.type === 'chunk') {
    const c = { pos: view(m.pos), stride: m.pos.stride, offset: m.pos.offset, scale: m.pos.scale, index: view(m.index), ids: view(m.ids) };
    const ms = build(c);
    chunks.set(m.id, c);
    postMessage({ type: 'ready', id: m.id, ms: Math.round(ms), triangles: c.index.length / 3 });
  } else if (m.type === 'ray') {
    const hits = [];
    for (const r of m.rays) {
      const c = chunks.get(r.id);
      if (!c) continue;
      // positions are kept as stored (quantized): rays come in local units, scale them to the stored units
      const s = c.scale, o = [r.o[0] / s, r.o[1] / s, r.o[2] / s];
      for (const h of raycast(c, o, r.d)) hits.push({ id: r.id, db: h.db, v: h.v, p: [(o[0] + r.d[0] * h.t) * s, (o[1] + r.d[1] * h.t) * s, (o[2] + r.d[2] * h.t) * s] });
    }
    postMessage({ type: 'hits', qid: m.qid, hits });
  } else if (m.type === 'box') {
    const c = chunks.get(m.id);
    if (!c) { postMessage({ type: 'box', qid: m.qid, min: null, max: null }); return; }
    const P = c.pos, st = c.stride, of = c.offset, ids = c.ids, s = c.scale;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < ids.length; v++) {
      if (ids[v] !== m.db) continue;
      const b = v * st + of;
      for (let k = 0; k < 3; k++) { const x = P[b + k] * s; if (x < min[k]) min[k] = x; if (x > max[k]) max[k] = x; }
    }
    postMessage({ type: 'box', qid: m.qid, min: min[0] === Infinity ? null : min, max: min[0] === Infinity ? null : max });
  }
};
