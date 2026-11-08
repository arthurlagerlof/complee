// Bounds-based streaming: retain complete exterior coverage, then refine visible regions.
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
const distanceSq = (b, p) =>
  b.min.reduce((s, x, k) => s + Math.max(x - p[k], 0, p[k] - b.max[k]) ** 2, 0);
const cost = (c) => c.resident_bytes ?? c.decoded_bytes ?? c.bytes;
const diagonal = (b) => Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
// On-screen size of a tile in CSS pixels: its diagonal at its nearest distance from the eye. screenScale is
// viewportHeightPx / (2 · tan(fov / 2)). Infinity when the eye is unknown or inside the tile.
export function projectedPixels(bounds, eye, screenScale) {
  if (!eye || !screenScale) return Infinity;
  const d = Math.sqrt(distanceSq(bounds, eye));
  return d > 0 ? (diagonal(bounds) * screenScale) / d : Infinity;
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
    ...manifest.streaming,
    ...options.budget,
  };
  // A component is atomic: never silently omit some of its tiles to fit a budget.
  if (selectedDb !== null) {
    const tiles = manifest.chunks.filter((c) => c.dbIds.includes(selectedDb)),
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
    };
  }
  const visible = (c) =>
    c.bounds_mm.min[1] <= cutHeight && intersectsPlanes(c.bounds_mm, planes);
  const exterior =
    fullModel && manifest.overview?.chunks?.length
      ? manifest.overview.chunks
      : null;
  const base = (
    exterior || manifest.chunks.filter((c) => c.group === "context")
  ).filter(visible);
  const detail =
    span <= cfg.detail_span_mm ||
    filterDbs !== null ||
    ruleDbs !== null ||
    Number.isFinite(cutHeight);
  // Selected parts (rule or findings filter) always load; everything else must be large enough on screen.
  const sizeRule = ruleDbs === null && filterDbs === null;
  let smallDeferred = 0;
  const bigEnough = (c) => {
    const limit = cfg.min_detail_screen_px * (resident?.has(c.name) ? cfg.detail_keep_ratio : 1);
    if (projectedPixels(c.bounds_mm, eye, screenScale) >= limit) return true;
    smallDeferred++;
    return false;
  };
  const extras = detail
    ? manifest.chunks.filter((c) => {
        if (!visible(c) || (!exterior && c.group === "context")) return false;
        if (
          c.group === "rest" &&
          (!fullModel || filterDbs !== null || ruleDbs !== null)
        )
          return false;
        if (ruleDbs !== null && !c.dbIds.some((d) => ruleDbs.has(d)))
          return false;
        if (filterDbs !== null && !c.dbIds.some((d) => filterDbs.has(d)))
          return false;
        // Frustum-visible geometry is not cut by distance to the target, only by its own size on screen.
        return !sizeRule || bigEnough(c);
      })
    : [];
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
    overviewDeferred = 0;
  for (const c of base) {
    if (bytes + cost(c) > cfg.max_resident_bytes) {
      overviewDeferred++;
      continue;
    }
    tiles.push(c);
    bytes += cost(c);
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
    hasExterior: !!exterior,
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
  const inside = (b) => b.min[1] <= cutHeight && [0, 1, 2].every((k) => b.max[k] >= box.min[k] && b.min[k] <= box.max[k]);
  const candidates = manifest.chunks.filter((c) => (fullModel || c.group !== 'rest') && inside(c.bounds_mm));
  const size = new Map(candidates.map((c) => [c, projectedPixels(c.bounds_mm, eye, screenScale)]));
  const bigEnough = (c) => size.get(c) >= cfg.min_detail_screen_px * (resident?.has(c.name) ? cfg.detail_keep_ratio : 1);
  const wanted = candidates
    .filter(bigEnough)
    .sort((a, b) => (Number.isFinite(size.get(a)) && Number.isFinite(size.get(b)) ? size.get(b) - size.get(a) : 0) || a.name.localeCompare(b.name));
  const tiles = [];
  let triangles = 0;
  for (const c of wanted) {
    if (triangles + c.triangles > cfg.max_focus_triangles) continue;
    tiles.push(c);
    triangles += c.triangles;
  }
  const smallDeferred = candidates.length - wanted.length;
  return { tiles, triangles, smallDeferred, budgetDeferred: wanted.length - tiles.length };
}
