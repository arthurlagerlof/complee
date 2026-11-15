// Indexes over the tile manifest, built once, so a camera query does not scan every tile of the ship.
//  - buildTileIndex / queryTiles: a bounding-volume hierarchy over the tile boxes. A query visits only the parts of
//    the ship that are in view and large enough on screen; whole branches outside the view, above the deck cut or
//    too small to matter are skipped (their tile counts are still reported). The result is exactly what a scan of
//    all tiles would give.
//  - buildPartIndex: part (dbId) -> tiles, in two typed arrays instead of one array object per part.
//  - prepareLod / selectLod: the level-of-detail pyramid of the base layer (tools/export/build-lod.mjs): coarse
//    tiles while a region is small on screen, their children as it grows, down to the unchanged source tiles.

const LEAF = 8;

export const diagonal = (b) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
export const distanceSq = (b, p) => {
  let s = 0;
  for (let k = 0; k < 3; k++) { const d = Math.max(b.min[k] - p[k], 0, p[k] - b.max[k]); s += d * d; }
  return s;
};
// On-screen size in CSS pixels: the box diagonal at its nearest distance from the eye. Infinity when the eye is
// unknown or inside the box. screenScale = viewportHeightPx / (2 · tan(fov / 2)).
export function projectedPixels(bounds, eye, screenScale) {
  if (!eye || !screenScale) return Infinity;
  const d = Math.sqrt(distanceSq(bounds, eye));
  return d > 0 ? (diagonal(bounds) * screenScale) / d : Infinity;
}
// 0 = outside, 1 = crosses a plane, 2 = completely inside every plane. Planes are [x, y, z, w], inside is >= 0.
export function classifyPlanes(bounds, planes) {
  let inside = 2;
  for (let i = 0; i < planes.length; i++) {
    const [x, y, z, w] = planes[i];
    const far = x * (x >= 0 ? bounds.max[0] : bounds.min[0]) + y * (y >= 0 ? bounds.max[1] : bounds.min[1]) + z * (z >= 0 ? bounds.max[2] : bounds.min[2]) + w;
    if (far < 0) return 0;
    const near = x * (x >= 0 ? bounds.min[0] : bounds.max[0]) + y * (y >= 0 ? bounds.min[1] : bounds.max[1]) + z * (z >= 0 ? bounds.min[2] : bounds.max[2]) + w;
    if (near < 0) inside = 1;
  }
  return inside;
}
function classifyBox(bounds, box) {
  let inside = 2;
  for (let k = 0; k < 3; k++) {
    if (bounds.max[k] < box.min[k] || bounds.min[k] > box.max[k]) return 0;
    if (bounds.min[k] < box.min[k] || bounds.max[k] > box.max[k]) inside = 1;
  }
  return inside;
}

const groupClass = (g) => (g === 'context' ? 0 : g === 'rest' ? 1 : 2);

// tiles: manifest entries with bounds_mm and group. The index keeps each tile's position in the list (order).
export function buildTileIndex(tiles) {
  const items = tiles.map((tile, order) => ({ tile, order, c: [0, 1, 2].map((k) => (tile.bounds_mm.min[k] + tile.bounds_mm.max[k]) / 2) }));
  function node(list) {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity], counts = [0, 0, 0];
    let maxMinY = -Infinity;
    for (const { tile } of list) {
      const b = tile.bounds_mm;
      for (let k = 0; k < 3; k++) { if (b.min[k] < min[k]) min[k] = b.min[k]; if (b.max[k] > max[k]) max[k] = b.max[k]; }
      if (b.min[1] > maxMinY) maxMinY = b.min[1];
      counts[groupClass(tile.group)]++;
    }
    const n = { min, max, maxMinY, counts, items: null, left: null, right: null };
    if (list.length <= LEAF) { n.items = list; return n; }
    // Split at the median of the tile centres along the longest axis of their spread.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const { c } of list) for (let k = 0; k < 3; k++) { if (c[k] < lo[k]) lo[k] = c[k]; if (c[k] > hi[k]) hi[k] = c[k]; }
    const axis = [0, 1, 2].reduce((a, k) => (hi[k] - lo[k] > hi[a] - lo[a] ? k : a), 0);
    if (hi[axis] === lo[axis]) { n.items = list; return n; } // all centres coincide: no useful split
    list.sort((a, b) => a.c[axis] - b.c[axis] || a.order - b.order);
    const mid = list.length >> 1;
    n.left = node(list.slice(0, mid));
    n.right = node(list.slice(mid));
    return n;
  }
  return { root: items.length ? node(items) : null, size: items.length };
}

// Tiles in view, in manifest order, and the number of tiles left out only because they are too small on screen.
//   planes | box   the view frustum or an axis-aligned box ({ min, max }); a tile must touch it
//   cutHeight      tiles that start above it are skipped (deck cut)
//   classes        [context, rest, other]: which tile groups are wanted
//   limit          minimum on-screen size in px (null: no size rule); a resident tile needs only limit * keepRatio
export function queryTiles(index, { planes = null, box = null, cutHeight = Infinity, classes = [true, true, true], eye = null, screenScale = null, limit = null, keepRatio = 1, resident = null }) {
  const out = [];
  let small = 0;
  if (!index.root) return { tiles: [], small };
  const sizeRule = limit !== null;
  const floor = sizeRule ? limit * Math.min(1, keepRatio) : 0;
  const wanted = (counts) => (classes[0] ? counts[0] : 0) + (classes[1] ? counts[1] : 0) + (classes[2] ? counts[2] : 0);
  const classify = (b) => (box ? classifyBox(b, box) : planes ? classifyPlanes(b, planes) : 2);
  const touches = (b) => classify(b) > 0;
  (function visit(n, inside) {
    if (n.min[1] > cutHeight || !wanted(n.counts)) return;
    if (!inside) {
      const k = classify(n);
      if (!k) return;
      inside = k === 2;
    }
    const belowCut = n.maxMinY <= cutHeight;
    // Everything in this branch is in view and smaller on screen than any tile may be: count it, do not visit it.
    if (sizeRule && inside && belowCut && projectedPixels(n, eye, screenScale) < floor) { small += wanted(n.counts); return; }
    if (n.items) {
      for (const it of n.items) {
        const t = it.tile, b = t.bounds_mm;
        if (!classes[groupClass(t.group)]) continue;
        if (!belowCut && b.min[1] > cutHeight) continue;
        if (!inside && !touches(b)) continue;
        if (sizeRule && projectedPixels(b, eye, screenScale) < limit * (resident?.has(t.name) ? keepRatio : 1)) { small++; continue; }
        out.push(it);
      }
      return;
    }
    visit(n.left, inside);
    visit(n.right, inside);
  })(index.root, false);
  out.sort((a, b) => a.order - b.order);
  return { tiles: out.map((it) => it.tile), small };
}

// Part -> tiles. get(dbId) returns the tiles that hold geometry of that part (undefined when none), like a Map,
// but stored as two typed arrays: millions of parts cost a few bytes each instead of an array object each.
export function buildPartIndex(tiles) {
  let maxDb = -1, total = 0;
  for (const t of tiles) for (const db of t.dbIds || []) { if (db > maxDb) maxDb = db; total++; }
  const start = new Uint32Array(maxDb + 2), where = new Uint32Array(total);
  for (const t of tiles) for (const db of t.dbIds || []) start[db + 1]++;
  for (let i = 1; i < start.length; i++) start[i] += start[i - 1];
  const fill = start.slice(0, maxDb + 1);
  tiles.forEach((t, i) => { for (const db of t.dbIds || []) where[fill[db]++] = i; });
  const count = (db) => (db >= 0 && db <= maxDb ? start[db + 1] - start[db] : 0);
  return {
    maxDb,
    has: (db) => count(db) > 0,
    get(db) {
      const n = count(db);
      if (!n) return undefined;
      const out = [];
      for (let i = 0; i < n; i++) { const t = tiles[where[start[db] + i]]; if (out[out.length - 1] !== t) out.push(t); } // a tile listing a part twice counts once
      return out;
    },
    // Tiles holding any of the parts, in manifest order.
    union(dbs) {
      const seen = new Set();
      for (const db of dbs) for (let i = db >= 0 && db <= maxDb ? start[db] : 0, e = i + count(db); i < e; i++) seen.add(where[i]);
      return [...seen].sort((a, b) => a - b).map((i) => tiles[i]);
    },
  };
}

// ---------- level of detail for the base layer ----------

// tree: { roots: [name], nodes: [{ name, children: [name], error_mm, file, bounds_mm, ... }] } from the manifest;
// leaves: the source tiles the pyramid was built from (by name). Returns null when the tree does not fit the tiles.
export function prepareLod(tree, leaves) {
  if (!tree?.roots?.length || !tree.nodes?.length) return null;
  const leafByName = new Map(leaves.map((c) => [c.name, c]));
  const infoByName = new Map(tree.nodes.map((n) => [n.name, n]));
  const parent = new Map(), built = new Map();
  let reached = 0;
  const make = (name, up) => {
    if (built.has(name)) return built.get(name);
    const info = infoByName.get(name), leaf = leafByName.get(name);
    if (!info && !leaf) return null;
    if (up) parent.set(name, up);
    const n = { name, info: info || leaf, error: info ? info.error_mm : 0, children: null };
    built.set(name, n);
    if (info) {
      n.children = [];
      for (const child of info.children || []) { const c = make(child, name); if (!c) return null; n.children.push(c); }
    } else reached++;
    return n;
  };
  const roots = [];
  for (const r of tree.roots) { const n = make(r, null); if (!n) return null; roots.push(n); }
  // Every source tile must be reachable, otherwise the pyramid belongs to another export: ignore it.
  if (reached !== leaves.length) return null;
  return { roots, parent, nodes: tree.nodes };
}

// The coarsest tiles whose error stays below pixelError on screen. A tile that is already resident is kept until its
// error exceeds pixelError / keepRatio, so a small camera move does not swap levels back and forth.
export function selectLod(lod, { visible, eye = null, screenScale = null, pixelError = 4, keepRatio = 0.6, resident = null }) {
  const out = [];
  const visit = (n) => {
    if (!visible(n.info)) return;
    if (!n.children) { out.push(n.info); return; }
    let err = Infinity;
    if (eye && screenScale) {
      const d = Math.sqrt(distanceSq(n.info.bounds_mm, eye));
      err = d > 0 ? (n.error * screenScale) / d : Infinity;
    }
    if (err <= pixelError / (resident?.has(n.name) ? keepRatio : 1)) {
      if (n.info.file) out.push(n.info); // a node without a file has nothing visible at this distance
      return;
    }
    for (const c of n.children) visit(c);
  };
  for (const r of lod.roots) visit(r);
  return out;
}
