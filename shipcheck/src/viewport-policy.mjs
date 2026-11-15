// Bounds-based streaming: retain complete exterior coverage, then refine visible regions.
// Queries use indexes built once per manifest (tile-index.mjs), so their cost follows what is in view, not the size
// of the ship: a spatial index over the detail tiles, part -> tiles, and the level-of-detail pyramid of the base layer.
import { buildTileIndex, queryTiles, buildPartIndex, prepareLod, selectLod, projectedPixels, distanceSq } from './tile-index.mjs';

export { projectedPixels };
export function intersectsPlanes(bounds, planes) {
  return planes.every(
    ([x, y, z, w]) =>
      x * (x >= 0 ? bounds.max[0] : bounds.min[0]) +
        y * (y >= 0 ? bounds.max[1] : bounds.min[1]) +
        z * (z >= 0 ? bounds.max[2] : bounds.min[2]) +
        w >=
      0,
  );
}
const cost = (c) => c.resident_bytes ?? c.decoded_bytes ?? c.bytes;
const groupClass = (c) => (c.group === "context" ? 0 : c.group === "rest" ? 1 : 2);

// Everything derived from a manifest, built on first use and kept as long as the manifest object lives.
const PREPARED = new WeakMap();
export function prepareManifest(manifest) {
  let p = PREPARED.get(manifest);
  if (p && p.chunks === manifest.chunks) return p;
  const context = manifest.chunks.filter((c) => c.group === "context");
  const overview = manifest.overview?.chunks || [];
  const lod = {
    overview: overview.length ? prepareLod(manifest.lod?.trees?.overview, overview) : null,
    context: prepareLod(manifest.lod?.trees?.context, context),
  };
  // Parent of every tile that takes part in a pyramid (node or source tile), for the viewer's level transitions.
  const lodParent = new Map();
  const lodNodes = [];
  for (const tree of [lod.overview, lod.context]) {
    if (!tree) continue;
    for (const [name, up] of tree.parent) lodParent.set(name, up);
    for (const n of tree.nodes) if (n.file) lodNodes.push(n);
  }
  p = { chunks: manifest.chunks, index: buildTileIndex(manifest.chunks), parts: buildPartIndex(manifest.chunks), context, lod, lodParent, lodNodes };
  PREPARED.set(manifest, p);
  return p;
}

export function selectViewportTiles(manifest, options) {
  const {
    planes = [],
    target = [0, 0, 0],
    span = Infinity,
    fullModel = true,
    filterDbs = null,
    ruleDbs = null,
    selectedDb = null,
    cutHeight = Infinity,
    eye = null,
    screenScale = null,
    resident = null,
  } = options;
  const cfg = {
    max_resident_bytes: 512e6,
    max_detail_triangles: 1500000,
    detail_span_mm: 24000,
    // Detail tiles smaller than this on screen wait until the view comes closer (the exterior overview still
    // covers the ship). Tiles already loaded stay down to keep_ratio of it, so zooming does not make them flicker.
    min_detail_screen_px: 56,
    detail_keep_ratio: 0.6,
    // Base layer with a level-of-detail pyramid: a coarse tile stands in while its error is below this on screen,
    // and the base layer as a whole stays below max_base_triangles (it gets coarser instead of heavier).
    lod_pixel_error: manifest.lod?.pixel_error ?? 4,
    max_base_triangles: 2500000,
    ...manifest.streaming,
    ...options.budget,
  };
  const prep = prepareManifest(manifest);
  // A component is atomic: never silently omit some of its tiles to fit a budget.
  if (selectedDb !== null) {
    const tiles = options.tilesByDb?.get(selectedDb) ?? prep.parts.get(selectedDb) ?? [],
      bytes = tiles.reduce((s, c) => s + cost(c), 0);
    if (bytes > cfg.max_resident_bytes)
      return {
        tiles: [],
        bytes: 0,
        candidates: tiles.length,
        deferred: tiles.length,
        overviewDeferred: 0,
        detail: true,
        componentUnavailable:
          "The complete component exceeds the geometry memory budget",
        requiredBytes: bytes,
      };
    // Context: the part is shown in its place in the ship, so the tiles the current view would request anyway are
    // added within the memory that remains (the component itself always comes first and complete).
    const context = selectViewportTiles(manifest, {
      ...options,
      selectedDb: null,
      budget: { ...options.budget, max_resident_bytes: Math.max(0, cfg.max_resident_bytes - bytes) },
    });
    const names = new Set(tiles.map((c) => c.name));
    const extra = context.tiles.filter((c) => !names.has(c.name));
    return {
      tiles: [...tiles, ...extra],
      bytes: bytes + extra.reduce((s, c) => s + cost(c), 0),
      candidates: tiles.length + context.candidates,
      deferred: context.deferred,
      overviewDeferred: context.overviewDeferred || 0,
      smallDeferred: context.smallDeferred || 0,
      detail: true,
      detailTriangles: tiles.reduce((s, c) => s + c.triangles, 0) + (context.detailTriangles || 0),
      componentTiles: tiles.length,
      baseTriangles: context.baseTriangles || 0,
      lodError: context.lodError ?? null,
    };
  }
  const visible = (c) =>
    c.bounds_mm.min[1] <= cutHeight && intersectsPlanes(c.bounds_mm, planes);
  const exterior =
    fullModel && manifest.overview?.chunks?.length
      ? manifest.overview.chunks
      : null;
  // Base layer: the pyramid's cut for this view when there is one, else every visible base tile.
  const lod = exterior ? prep.lod.overview : prep.lod.context;
  let base,
    lodError = null;
  if (lod) {
    lodError = cfg.lod_pixel_error;
    for (let attempt = 0; ; attempt++) {
      base = selectLod(lod, { visible, eye, screenScale, pixelError: lodError, keepRatio: cfg.detail_keep_ratio, resident });
      const triangles = base.reduce((s, c) => s + c.triangles, 0);
      if (triangles <= cfg.max_base_triangles || attempt >= 5 || !eye || !screenScale) break;
      lodError *= 1.6; // too heavy for this view: accept a coarser picture rather than an unbounded load
    }
  } else base = (exterior || prep.context).filter(visible);
  const detail =
    span <= cfg.detail_span_mm ||
    filterDbs !== null ||
    ruleDbs !== null ||
    Number.isFinite(cutHeight);
  // Selected parts (rule or findings filter) always load; everything else must be large enough on screen.
  const sizeRule = ruleDbs === null && filterDbs === null;
  let smallDeferred = 0;
  let extras = [];
  if (detail) {
    // Tile groups in play: hull/deck context only next to an exterior overview; the unchecked rest only in the
    // full model and never under a rule view or findings filter.
    const classes = [!!exterior, fullModel && sizeRule, true];
    if (sizeRule) {
      // Frustum-visible geometry is not cut by distance to the target, only by its own size on screen.
      const found = queryTiles(prep.index, { planes, cutHeight, classes, eye, screenScale, limit: cfg.min_detail_screen_px, keepRatio: cfg.detail_keep_ratio, resident });
      extras = found.tiles;
      smallDeferred = found.small;
    } else {
      // Only tiles that hold one of the selected parts: looked up by part when the selection is small.
      const sets = [ruleDbs, filterDbs].filter(Boolean).sort((a, b) => a.size - b.size);
      const candidates = sets[0].size < manifest.chunks.length ? prep.parts.union(sets[0]) : manifest.chunks;
      extras = candidates.filter((c) => {
        if (!visible(c) || !classes[groupClass(c)]) return false;
        if (ruleDbs !== null && !c.dbIds.some((d) => ruleDbs.has(d))) return false;
        if (filterDbs !== null && !c.dbIds.some((d) => filterDbs.has(d))) return false;
        return true;
      });
    }
  }
  const near = (a, b) =>
    distanceSq(a.bounds_mm, target) - distanceSq(b.bounds_mm, target) ||
    a.name.localeCompare(b.name);
  base.sort(near);
  // The detail budget goes to what is largest on screen first, so small parts are the last to load.
  const size = new Map(extras.map((c) => [c, projectedPixels(c.bounds_mm, eye, screenScale)]));
  extras.sort((a, b) => (Number.isFinite(size.get(a)) && Number.isFinite(size.get(b)) ? size.get(b) - size.get(a) : 0) || near(a, b));
  const tiles = [];
  let bytes = 0,
    detailTriangles = 0,
    baseTriangles = 0,
    overviewDeferred = 0;
  for (const c of base) {
    if (bytes + cost(c) > cfg.max_resident_bytes) {
      overviewDeferred++;
      continue;
    }
    tiles.push(c);
    bytes += cost(c);
    baseTriangles += c.triangles;
  }
  for (const c of extras) {
    if (
      bytes + cost(c) > cfg.max_resident_bytes ||
      detailTriangles + c.triangles > cfg.max_detail_triangles
    )
      continue;
    tiles.push(c);
    bytes += cost(c);
    detailTriangles += c.triangles;
  }
  return {
    tiles,
    bytes,
    candidates: base.length + extras.length,
    deferred: base.length + extras.length - tiles.length,
    overviewDeferred,
    smallDeferred,
    detail,
    detailTriangles,
    baseTriangles,
    hasExterior: !!exterior,
    // Pixel error the base layer was selected with (null: no pyramid); above lod_pixel_error = coarsened for budget.
    lodError,
  };
}
// Continuous camera events must not keep postponing requests.
export function viewportScheduler(
  callback,
  delay = 120,
  timers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  },
) {
  let timer = null;
  return {
    request() {
      if (timer !== null) return;
      timer = timers.setTimeout(() => {
        timer = null;
        callback();
      }, delay);
    },
    cancel() {
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
  };
}
// Context around a scene or rule focus (the cut-open ship around a corridor or part): tiles in the focus box below
// the cut, largest on screen first, small ones only when large enough on screen (as in selectViewportTiles), and at
// most max_focus_triangles in total, so a close-up never pulls in every tile of the surrounding hull.
export function selectFocusTiles(manifest, box, options = {}) {
  const { cutHeight = Infinity, fullModel = true, eye = null, screenScale = null, resident = null } = options;
  const cfg = { min_detail_screen_px: 56, detail_keep_ratio: 0.6, max_focus_triangles: 8000000, ...manifest.streaming, ...options.budget };
  const found = queryTiles(prepareManifest(manifest).index, { box, cutHeight, classes: [true, fullModel, true], eye, screenScale, limit: cfg.min_detail_screen_px, keepRatio: cfg.detail_keep_ratio, resident });
  const size = new Map(found.tiles.map((c) => [c, projectedPixels(c.bounds_mm, eye, screenScale)]));
  const wanted = found.tiles.sort(
    (a, b) => (Number.isFinite(size.get(a)) && Number.isFinite(size.get(b)) ? size.get(b) - size.get(a) : 0) || a.name.localeCompare(b.name),
  );
  const tiles = [];
  let triangles = 0;
  for (const c of wanted) {
    if (triangles + c.triangles > cfg.max_focus_triangles) continue;
    tiles.push(c);
    triangles += c.triangles;
  }
  return { tiles, triangles, smallDeferred: found.small, budgetDeferred: wanted.length - tiles.length };
}
