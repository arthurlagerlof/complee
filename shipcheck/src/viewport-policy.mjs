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
  } = options;
  const cfg = {
    max_resident_bytes: 512e6,
    max_detail_triangles: 1500000,
    detail_span_mm: 24000,
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
    return {
      tiles,
      bytes,
      candidates: tiles.length,
      deferred: 0,
      overviewDeferred: 0,
      detail: true,
      detailTriangles: tiles.reduce((s, c) => s + c.triangles, 0),
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
        return true; // Do not reject frustum-visible geometry with an unrelated target-distance cutoff.
      })
    : [];
  const near = (a, b) =>
    distanceSq(a.bounds_mm, target) - distanceSq(b.bounds_mm, target) ||
    a.name.localeCompare(b.name);
  base.sort(near);
  extras.sort(near);
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
