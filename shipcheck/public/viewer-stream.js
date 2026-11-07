// Viewport-driven local viewer. Only requested spatial tiles are resident; old merged GLBs remain untouched.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import {
  selectViewportTiles,
  viewportScheduler,
} from "./src/viewport-policy.mjs";
import {
  fitPerspectiveBox,
  viewportAspect,
  geometryDepthRange,
} from "./src/view-framing.mjs";
let decoderWorkersStarted = false;
const COLORS = {
  non_compliant: [0.84, 0.27, 0.27],
  not_enough_info: [0.85, 0.6, 0.12],
  compliant: [0.18, 0.62, 0.36],
  context: [0.86, 0.88, 0.91],
  none: [0.72, 0.75, 0.79],
};
const linear = (c) => c.map((x) => Math.pow(x, 2.2));
const boxOf = (b) =>
  new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
export async function createLocalViewer(
  container,
  { onPick, onPickRest } = {},
) {
  const cfg = await fetch("api/model/config")
    .then((r) => (r.ok ? r.json() : {}))
    .catch(() => ({}));
  const base = new URL(cfg.base_url || "model/", document.baseURI),
    manifestUrl = new URL(cfg.manifest || "stream/manifest.json", base);
  const response = await fetch(manifestUrl, { cache: "no-store" });
  if (!response.ok)
    throw Error(
      `Viewport tiles unavailable (${response.status}); run tools/export/tile-model.mjs`,
    );
  const manifest = await response.json();
  if (manifest.kind !== "viewport-tiles" || !manifest.chunks?.length)
    throw Error("Expected a viewport tile manifest");
  if (!decoderWorkersStarted) {
    MeshoptDecoder.useWorkers?.(2);
    decoderWorkersStarted = true;
  }
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;inset:0";
  container.append(host);
  const badge = document.createElement("div");
  badge.className = "aps-status";
  container.append(badge);
  const labelEl = document.createElement("div");
  labelEl.className = "aps-label";
  labelEl.hidden = true;
  container.append(labelEl);
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    preserveDrawingBuffer: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setClearColor(0xeef1f5);
  renderer.localClippingEnabled = true;
  host.append(renderer.domElement);
  const scene = new THREE.Scene(),
    root = new THREE.Group();
  scene.add(root, new THREE.HemisphereLight(0xffffff, 0xc8ced8, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(0.4, 1, 0.6);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(35, 1, 50, 1e6);
  camera.position.set(-40000, 20000, 40000);
  camera.add(new THREE.DirectionalLight(0xffffff, 0.6));
  scene.add(camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;
  const clipping = [];
  const material = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,
    clippingPlanes: clipping,
  });
  material.onBeforeCompile = (s) => {
    s.fragmentShader = s.fragmentShader.replace(
      "#include <color_fragment>",
      "#include <color_fragment>\nif (vColor.a < 0.99) discard; diffuseColor.a = 1.0;",
    );
  };
  material.customProgramCacheKey = () => "viewport-state";
  const overviewMaterial = material.clone();
  overviewMaterial.onBeforeCompile = material.onBeforeCompile;
  overviewMaterial.customProgramCacheKey = material.customProgramCacheKey;
  overviewMaterial.clippingPlanes = clipping;
  overviewMaterial.polygonOffset = true;
  overviewMaterial.polygonOffsetFactor = 1;
  overviewMaterial.polygonOffsetUnits = 1;
  const outline = new THREE.Box3Helper(new THREE.Box3(), 0x1f6feb);
  outline.material.depthTest = false;
  outline.renderOrder = 10;
  outline.visible = false;
  scene.add(outline);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const overviewInfos = manifest.overview?.chunks || [];
  const allInfos = [...manifest.chunks, ...overviewInfos];
  const cache = new Map(),
    requests = new Map(),
    desired = new Set(),
    failed = new Set(),
    infoByName = new Map(allInfos.map((c) => [c.name, c]));
  const byDb = new Map();
  for (const c of manifest.chunks)
    for (const db of c.dbIds) {
      if (!byDb.has(db)) byDb.set(db, []);
      byDb.get(db).push(c);
    }
  let idToDb = new Map(),
    dbToId = new Map(),
    context = new Set(),
    results = null,
    filterDbs = null,
    override = null;
  let selectedDb = null,
    selectedId = null,
    selectedRest = null,
    fullModel = true,
    simple = false,
    active = true,
    loaded = null,
    resolveFirst = null,
    rejectFirst = null;
  let framedBox = null,
    frameMargin = 1.1,
    viewRevision = 0,
    tileRevision = 0,
    pickerFailed = false,
    geometryNotice = "",
    gpuLost = false,
    selectionBox = null;
  const workerChunks = new Map();
  let dirty = true,
    mode = "all",
    labelAnchor = null,
    labelHTML = null,
    labelStatus = null,
    selectionVersion = 0;
  const stats = {
    started: performance.now(),
    firstPicture: null,
    loaded: null,
    bytes: 0,
    residentBytes: 0,
    residentTriangles: 0,
    residentTiles: 0,
    pending: 0,
    deferred: 0,
    evicted: 0,
    errors: [],
    errorDetails: [],
    kind: "viewport",
  };
  const picker = new Worker(new URL("./pick-worker.js", import.meta.url));
  let qid = 0;
  const pending = new Map();
  picker.onmessage = ({ data: m }) => {
    if (m.type === "ready") {
      const c = workerChunks.get(m.id);
      if (c) {
        c.ready = true;
        c.resolveReady();
      }
      return;
    }
    pending.get(m.qid)?.(m);
    pending.delete(m.qid);
  };
  const ask = (m) =>
    pickerFailed
      ? Promise.resolve({ hits: [], min: null, unavailable: true })
      : new Promise((resolve) => {
          const id = ++qid;
          const timeout = setTimeout(() => {
            pending.delete(id);
            resolve({ hits: [], min: null, unavailable: true });
          }, 15000);
          pending.set(id, (value) => {
            clearTimeout(timeout);
            resolve(value);
          });
          picker.postMessage({ ...m, qid: id });
        });
  picker.onerror = () => {
    pickerFailed = true;
    geometryNotice = "3D picking unavailable; reload the view to retry";
    for (const c of cache.values()) c.resolveReady(false);
    for (const resolve of pending.values())
      resolve({ hits: [], min: null, unavailable: true });
    pending.clear();
    summary();
  };
  const debug = {
    renderer,
    scene,
    camera,
    controls,
    stats,
    manifest,
    tiles: cache,
  };
  window.localViewer = debug;
  Object.defineProperty(debug, "rest", {
    get: () => [...cache.values()].filter((c) => c.info.group === "rest"),
  });
  const invalidate = () => {
    dirty = true;
  };
  const scheduler = viewportScheduler(refresh);
  function resize() {
    const w = container.clientWidth,
      h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = viewportAspect(w, h, camera.aspect);
    camera.updateProjectionMatrix();
    if (framedBox) fitBox(framedBox, frameMargin);
    invalidate();
    schedule();
  }
  new ResizeObserver(resize).observe(container);
  controls.addEventListener("change", () => {
    viewRevision++;
    const d = camera.position.distanceTo(controls.target);
    const range = geometryDepthRange(
      camera.position,
      selectedDb !== null && framedBox
        ? [framedBox]
        : allInfos.map((c) => c.bounds_mm),
      d,
    );
    camera.near = range.near;
    camera.far = range.far;
    camera.updateProjectionMatrix();
    invalidate();
    placeLabel();
    schedule();
  });
  renderer.setAnimationLoop(() => {
    if (!active || gpuLost || !container.offsetParent) return;
    controls.update();
    if (dirty) {
      dirty = false;
      renderer.render(scene, camera);
      afterRender();
      placeLabel();
    }
  });
  function showBox(box, html = labelHTML, status = labelStatus) {
    selectionBox = box?.clone() || null;
    outline.visible = !!box;
    if (box) outline.box.copy(box);
    labelHTML = html;
    labelStatus = status;
    labelAnchor = box?.getCenter(new THREE.Vector3()) || null;
    labelEl.hidden = !box || !html;
    labelEl.innerHTML = html || "";
    labelEl.className = `aps-label st-${status || "none"}`;
    placeLabel();
    invalidate();
  }
  function placeLabel() {
    if (!labelAnchor || labelEl.hidden) return;
    const p = labelAnchor.clone().project(camera);
    labelEl.style.visibility =
      p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1 ? "hidden" : "visible";
    labelEl.style.left = `${((p.x + 1) / 2) * container.clientWidth}px`;
    labelEl.style.top = `${((1 - p.y) / 2) * container.clientHeight}px`;
  }
  function fitBox(box, k = 1.1) {
    if (!box || box.isEmpty()) return;
    framedBox = box.clone();
    frameMargin = k;
    const direction = camera.position.clone().sub(controls.target);
    const frame = fitPerspectiveBox(box, {
      fov: camera.getEffectiveFOV(),
      aspect: viewportAspect(
        container.clientWidth,
        container.clientHeight,
        camera.aspect,
      ),
      direction,
      up: camera.up,
      margin: k,
    });
    const damping = controls.enableDamping,
      auto = controls.autoRotate;
    controls.enableDamping = false;
    controls.autoRotate = false;
    controls.update();
    controls.target.fromArray(frame.target);
    camera.position.fromArray(frame.position);
    camera.up.fromArray(frame.up);
    camera.aspect = frame.aspect;
    camera.updateProjectionMatrix();
    controls.update();
    controls.enableDamping = damping;
    controls.autoRotate = auto;
    invalidate();
  }
  const allBounds = new THREE.Box3();
  for (const c of allInfos) allBounds.union(boxOf(c.bounds_mm));
  function overviewBounds() {
    const b = new THREE.Box3();
    const items =
      fullModel && overviewInfos.length
        ? overviewInfos
        : manifest.chunks.filter((c) => c.group === "context");
    for (const c of items) b.union(boxOf(c.bounds_mm));
    return b.isEmpty() ? allBounds : b;
  }
  function resetCut() {
    if (clipping.length) {
      clipping.length = 0;
      material.needsUpdate = true;
      overviewMaterial.needsUpdate = true;
    }
    viewRevision++;
  }
  function frameOverview() {
    resetCut();
    geometryNotice = "";
    const center = overviewBounds().getCenter(new THREE.Vector3());
    controls.target.copy(center);
    camera.position.copy(center).add(new THREE.Vector3(-0.75, 0.45, 0.85));
    fitBox(overviewBounds());
  }

  function summary() {
    stats.residentBytes = [...cache.values()].reduce(
      (s, c) => s + c.info.resident_bytes,
      0,
    );
    stats.residentTriangles = [...cache.values()].reduce(
      (s, c) => s + c.info.triangles,
      0,
    );
    stats.residentTiles = cache.size;
    stats.pending = requests.size;
    stats.viewComplete =
      stats.deferred === 0 &&
      desired.size > 0 &&
      [...desired].every((n) => cache.has(n)) &&
      failed.size === 0;
    badge.textContent = `Local 3D viewer · ${cache.size}/${desired.size} tiles · ${(stats.residentBytes / 1e6).toFixed(0)} MB geometry estimate${requests.size ? " · loading visible parts…" : selectedDb !== null ? " · component" : camera.position.distanceTo(controls.target) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) > manifest.streaming.detail_span_mm ? " · overview; zoom in for detail" : ""}${stats.deferred ? " · " + stats.deferred + " detail tiles deferred; zoom in" : ""}${stats.overviewDeferred ? " · overview incomplete: memory budget" : ""}${geometryNotice ? " · " + geometryNotice : ""}${failed.size ? " · some tiles unavailable; move view to retry" : ""}`;
  }
  function colorState(db, isRest) {
    const id = dbToId.get(db);
    if (selectedDb !== null) return db === selectedDb ? 255 : 0;
    if (override) return override.has(id) || context.has(db) ? 255 : 0;
    if (filterDbs && !context.has(db) && !filterDbs.has(db)) return 0;
    if (isRest && (!fullModel || filterDbs || override)) return 0;
    return 255;
  }
  function recolor(c, ids) {
    const only = ids && new Set(ids.map((id) => idToDb.get(id)));
    for (let v = 0; v < c.dbids.length; v++) {
      const db = c.dbids[v];
      if (only && !only.has(db)) continue;
      const id = dbToId.get(db),
        st = override?.get(id) ?? results?.elements[id]?.worst;
      const col = linear(
        COLORS[
          c.info.group === "rest"
            ? "none"
            : simple && context.has(db) && (!st || st === "compliant")
              ? "context"
              : st || "none"
        ],
      );
      const o = v * 4;
      c.state[o] = Math.round(col[0] * 255);
      c.state[o + 1] = Math.round(col[1] * 255);
      c.state[o + 2] = Math.round(col[2] * 255);
      c.state[o + 3] = colorState(db, c.info.group === "rest");
    }
    c.geom.attributes.color.needsUpdate = true;
    invalidate();
  }
  function recompute(ids) {
    for (const c of cache.values()) recolor(c, ids);
    schedule();
  }
  const desc = (a, more = {}) => ({
    buffer: a.buffer,
    byteOffset: a.byteOffset,
    length: a.length,
    ctor: a.constructor.name,
    ...more,
  });
  function afterRender() {
    for (const c of cache.values()) {
      if (c.sent || c.uploaded.size !== c.units.size) continue;
      const p = c.geom.attributes.position,
        ix = c.geom.index,
        arr = p.isInterleavedBufferAttribute ? p.data.array : p.array;
      const s = !p.normalized
        ? 1
        : arr instanceof Uint16Array
          ? 1 / 65535
          : arr instanceof Int16Array
            ? 1 / 32767
            : 1;
      const ids = c.dbids.slice();
      const transfer = [...new Set([arr.buffer, ix.array.buffer, ids.buffer])];
      picker.postMessage(
        {
          type: "chunk",
          id: c.key,
          pos: desc(arr, {
            stride: p.isInterleavedBufferAttribute ? p.data.stride : p.itemSize,
            offset: p.isInterleavedBufferAttribute ? p.offset : 0,
            scale: s,
          }),
          index: desc(ix.array),
          ids: desc(ids),
        },
        transfer,
      );
      for (const u of c.units) u.array = null;
      c.sent = true;
    }
  }
  const uploadTarget = new THREE.WebGLRenderTarget(1, 1);
  function adopt(gltf, info) {
    let mesh;
    gltf.scene.traverse((o) => {
      if (o.isMesh && !mesh) mesh = o;
    });
    if (!mesh) throw Error("Tile has no mesh");
    const geom = mesh.geometry,
      col = geom.attributes.color,
      n = geom.attributes.position.count,
      dbids = new Uint32Array(n),
      raw = col.array;
    for (let v = 0; v < n; v++)
      dbids[v] =
        raw instanceof Uint8Array && !col.isInterleavedBufferAttribute
          ? (raw[4 * v] |
              (raw[4 * v + 1] << 8) |
              (raw[4 * v + 2] << 16) |
              (raw[4 * v + 3] << 24)) >>>
            0
          : (Math.round(col.getX(v) * 255) |
              (Math.round(col.getY(v) * 255) << 8) |
              (Math.round(col.getZ(v) * 255) << 16) |
              (Math.round(col.getW(v) * 255) << 24)) >>>
            0;
    const state = new Uint8Array(n * 4);
    geom.setAttribute("color", new THREE.BufferAttribute(state, 4, true));
    mesh.material = info.group === "overview" ? overviewMaterial : material;
    mesh.raycast = () => {};
    mesh.frustumCulled = true;
    root.add(gltf.scene);
    mesh.updateWorldMatrix(true, false);
    let resolveReady;
    const readyPromise = new Promise((r) => (resolveReady = r)),
      c = {
        key: info.name + "#" + ++tileRevision,
        info,
        group: gltf.scene,
        mesh,
        geom,
        dbids,
        state,
        readyPromise,
        resolveReady,
        units: new Set(),
        uploaded: new Set(),
        sent: false,
        ready: false,
      };
    for (const a of [
      geom.attributes.position,
      geom.attributes.normal,
      geom.index,
    ]) {
      const u = a.isInterleavedBufferAttribute ? a.data : a;
      c.units.add(u);
      u.onUpload(() => c.uploaded.add(u));
    }
    cache.set(info.name, c);
    workerChunks.set(c.key, c);
    recolor(c);
    const fc = mesh.frustumCulled;
    mesh.frustumCulled = false;
    renderer.setRenderTarget(uploadTarget);
    renderer.render(mesh, camera);
    renderer.setRenderTarget(null);
    mesh.frustumCulled = fc;
    afterRender();
    renderer.render(scene, camera);
    if (stats.firstPicture === null) {
      stats.firstPicture = performance.now() - stats.started;
      resolveFirst?.();
    }
    invalidate();
    return c;
  }
  function releaseGltf(gltf) {
    gltf.scene.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (o.material !== material) {
          for (const m of [].concat(o.material)) m.dispose();
        }
      }
    });
  }
  function evict(name) {
    const c = cache.get(name);
    if (!c) return;
    root.remove(c.group);
    c.geom.dispose();
    picker.postMessage({ type: "drop", id: c.key });
    workerChunks.delete(c.key);
    cache.delete(name);
    c.resolveReady(false);
    stats.evicted++;
  }
  function viewOptions() {
    camera.updateMatrixWorld();
    const f = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(
        camera.projectionMatrix,
        camera.matrixWorldInverse,
      ),
    );
    return {
      planes: f.planes.map((p) => [...p.normal.toArray(), p.constant]),
      target: controls.target.toArray(),
      span:
        camera.position.distanceTo(controls.target) *
        2 *
        Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)),
      fullModel,
      filterDbs,
      ruleDbs: override
        ? new Set([...override.keys()].map((id) => idToDb.get(id)))
        : null,
      selectedDb,
      cutHeight: clipping[0]?.constant ?? Infinity,
    };
  }
  function schedule() {
    if (!active || gpuLost || !loaded) return;
    scheduler.request();
  }
  function refresh() {
    if (!active || gpuLost) return;
    failed.clear();
    const plan = selectViewportTiles(manifest, viewOptions());
    stats.deferred = plan.deferred;
    stats.overviewDeferred = plan.overviewDeferred || 0;
    if (plan.componentUnavailable) geometryNotice = plan.componentUnavailable;
    stats.coverageComplete = plan.deferred === 0;
    desired.clear();
    for (const c of plan.tiles) desired.add(c.name);
    for (const [name, r] of requests)
      if (!desired.has(name)) r.controller.abort();
    for (const name of cache.keys()) if (!desired.has(name)) evict(name);
    pump();
    summary();
  }
  async function requestTile(info, controller) {
    const r = await fetch(new URL(info.file, manifestUrl), {
      signal: controller.signal,
    });
    if (!r.ok) throw Error(`Tile unavailable (${r.status})`);
    const bytes = await r.arrayBuffer();
    stats.bytes += bytes.byteLength;
    const gltf = await loader.parseAsync(bytes, new URL(".", manifestUrl).href);
    if (
      !active ||
      gpuLost ||
      controller.signal.aborted ||
      !desired.has(info.name)
    ) {
      releaseGltf(gltf);
      return;
    }
    adopt(gltf, info);
  }
  function pump() {
    if (!active || gpuLost) return;
    const max = manifest.streaming.max_requests || 2;
    for (const name of desired) {
      if (requests.size >= max) break;
      if (cache.has(name) || requests.has(name) || failed.has(name)) continue;
      const controller = new AbortController();
      requests.set(name, { controller });
      requestTile(infoByName.get(name), controller)
        .catch((e) => {
          if (
            !controller.signal.aborted &&
            active &&
            desired.has(name) &&
            e.name !== "AbortError"
          ) {
            failed.add(name);
            stats.errors.push(name);
            stats.errorDetails.push({
              tile: name,
              type: e.name,
              message: e.message.replace(/https?:[^\s)]+/g, "[model host]"),
            });
          }
        })
        .finally(() => {
          requests.delete(name);
          pump();
          summary();
          if (
            !requests.size &&
            [...desired].every((n) => cache.has(n) || failed.has(n))
          ) {
            stats.loaded = performance.now() - stats.started;
            if (!cache.size && failed.size && stats.firstPicture === null)
              rejectFirst?.(
                new Error("No visible model tiles could be loaded"),
              );
            else resolveFirst?.();
          }
        });
    }
    summary();
  }
  async function ensurePart(db) {
    const infos = byDb.get(db) || [];
    if (!infos.length) return null;
    selectedDb = db;
    refresh();
    const names = infos.map((c) => c.name).filter((n) => desired.has(n));
    while (
      names.some((n) => !cache.has(n) && !failed.has(n)) &&
      active &&
      selectedDb === db
    )
      await new Promise((r) => setTimeout(r, 30));
    if (!active || selectedDb !== db) return null;
    const b = new THREE.Box3();
    for (const name of names) {
      const c = cache.get(name);
      if (!c) continue;
      await c.readyPromise;
      if (cache.get(name) !== c) continue;
      const r = await ask({ type: "box", id: c.key, db });
      if (r.min)
        b.union(
          new THREE.Box3(
            new THREE.Vector3(...r.min),
            new THREE.Vector3(...r.max),
          ).applyMatrix4(c.mesh.matrixWorld),
        );
    }
    return b.isEmpty() ? null : b;
  }
  const ray = new THREE.Raycaster();
  let down;
  renderer.domElement.addEventListener("pointerdown", (e) => {
    down = [e.clientX, e.clientY];
  });
  renderer.domElement.addEventListener("pointerup", async (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4)
      return;
    const rect = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(
      new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        (-(e.clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const revision = viewRevision;
    const origin = ray.ray.origin.clone();
    const targets = [...cache.values()].filter((c) => c.ready),
      rays = targets.map((c) => {
        const inv = c.mesh.matrixWorld.clone().invert();
        return {
          id: c.key,
          o: ray.ray.origin.clone().applyMatrix4(inv).toArray(),
          d: ray.ray.direction
            .clone()
            .applyMatrix3(new THREE.Matrix3().setFromMatrix4(inv))
            .toArray(),
        };
      });
    const out = await ask({ type: "ray", rays });
    if (!active || revision !== viewRevision) return;
    const hits = (out.hits || [])
      .flatMap((h) => {
        const c = workerChunks.get(h.id);
        if (!c) return [];
        const p = new THREE.Vector3(...h.p).applyMatrix4(c.mesh.matrixWorld);
        return [{ ...h, c, p, d: p.distanceTo(origin) }];
      })
      .sort((a, b) => a.d - b.d);
    for (const h of hits) {
      if (
        (clipping[0] && clipping[0].distanceToPoint(h.p) < 0) ||
        h.c.state[h.v * 4 + 3] !== 255
      )
        continue;
      const id = dbToId.get(h.db);
      if (h.c.info.group === "rest" || !id) onPickRest?.(h.db);
      else onPick?.(id);
      break;
    }
  });
  const propsCache = new Map();
  function clearSelection() {
    const had = selectedDb !== null || selectedRest !== null;
    selectedId = null;
    selectedDb = null;
    selectedRest = null;
    selectionVersion++;
    viewRevision++;
    geometryNotice = "";
    showBox(null, null);
    return had;
  }
  renderer.domElement.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    gpuLost = true;
    viewRevision++;
    scheduler.cancel();
    for (const r of requests.values()) r.controller.abort();
    for (const name of [...cache.keys()]) evict(name);
    desired.clear();
    stats.viewComplete = false;
    geometryNotice = "Recovering 3D graphics";
    outline.visible = false;
    labelEl.hidden = true;
    summary();
  });
  renderer.domElement.addEventListener("webglcontextrestored", () => {
    gpuLost = false;
    stats.contextRecoveries = (stats.contextRecoveries || 0) + 1;
    geometryNotice = "";
    material.needsUpdate = true;
    overviewMaterial.needsUpdate = true;
    if (active) {
      refresh();
      if (selectionBox) showBox(selectionBox, labelHTML, labelStatus);
      invalidate();
    }
  });
  resize();
  frameOverview();
  return {
    kind: "local",
    stats,
    get frames() {
      return renderer.info.render.frame;
    },
    get hasRest() {
      return true;
    },
    get fullModel() {
      return fullModel;
    },
    get simple() {
      return simple;
    },
    load() {
      if (!loaded) {
        loaded = new Promise((r, j) => {
          resolveFirst = r;
          rejectFirst = j;
        });
        loaded.catch(() => {
          loaded = null;
        });
        active = true;
        refresh();
      } else {
        active = true;
        refresh();
      }
      return loaded;
    },
    setActive(on) {
      active = !!on;
      if (!active) {
        resolveFirst?.();
        scheduler.cancel();
        for (const r of requests.values()) r.controller.abort();
        for (const n of [...cache.keys()]) evict(n);
        desired.clear();
      } else schedule();
    },
    build(norm, r) {
      idToDb = new Map(
        norm.elements
          .filter((e) => e.objectid != null)
          .map((e) => [e.id, e.objectid]),
      );
      dbToId = new Map([...idToDb].map(([id, db]) => [db, id]));
      context = new Set(
        norm.elements
          .filter((e) => ["110", "130"].includes(e.props?.swbs_group?.value))
          .map((e) => e.objectid),
      );
      results = r;
      override = null;
      filterDbs = null;
      clearSelection();
      resetCut();
      active = true;
      recompute();
      frameOverview();
    },
    update(r, ids) {
      results = r;
      recompute(ids);
    },
    paintNeutral() {
      for (const c of cache.values()) {
        for (let v = 0; v < c.state.length; v += 4) {
          c.state[v] = 184;
          c.state[v + 1] = 191;
          c.state[v + 2] = 201;
        }
        c.geom.attributes.color.needsUpdate = true;
      }
      invalidate();
    },
    async select(id, { fly = true, label = null, status = null } = {}) {
      const db = idToDb.get(id);
      if (db == null) return;
      resetCut();
      geometryNotice = "";
      viewRevision++;
      const version = ++selectionVersion;
      selectedId = id;
      selectedRest = null;
      selectedDb = db;
      showBox(null, null);
      recompute();
      const b = await ensurePart(db);
      if (version !== selectionVersion) return;
      if (!b) {
        geometryNotice = gpuLost
          ? "Recovering 3D graphics"
          : pickerFailed
            ? "Selection index unavailable; reload the view"
            : geometryNotice ||
              "No geometry mapping is available for this part";
        summary();
        return;
      }
      if (fly && b) fitBox(b, 1.05);
      showBox(b, label, status);
    },
    setLabel(id, html, status) {
      if (id === selectedId) {
        labelHTML = html;
        labelStatus = status;
        labelEl.innerHTML = html;
        labelEl.className = `aps-label st-${status || "none"}`;
      }
    },
    clearSelection,
    async selectRest(db, { label = null } = {}) {
      const v = ++selectionVersion;
      selectedRest = db;
      selectedId = null;
      const b = new THREE.Box3();
      for (const c of cache.values()) {
        if (!c.info.dbIds.includes(db)) continue;
        await c.readyPromise;
        const r = await ask({ type: "box", id: c.key, db });
        if (r.min)
          b.union(
            new THREE.Box3(
              new THREE.Vector3(...r.min),
              new THREE.Vector3(...r.max),
            ).applyMatrix4(c.mesh.matrixWorld),
          );
      }
      if (v === selectionVersion && !b.isEmpty()) showBox(b, label, "none");
    },
    async getProperties(db) {
      const shard = Math.floor(db / 1000);
      if (!propsCache.has(shard))
        propsCache.set(
          shard,
          fetch(new URL(`props/${shard}.json`, base))
            .then((r) => (r.ok ? r.json() : {}))
            .catch(() => ({})),
        );
      return (await propsCache.get(shard))[db];
    },
    setFullModel(on) {
      fullModel = !!on;
      if (on) simple = false;
      clearSelection();
      recompute();
      frameOverview();
    },
    flyToElement(id) {
      return this.select(id);
    },
    setFilter(set) {
      filterDbs = set
        ? new Set([...set].map((id) => idToDb.get(id)).filter((d) => d != null))
        : null;
      recompute();
    },
    highlight(status) {
      override = new Map(Object.entries(status));
      clearSelection();
      const b = new THREE.Box3();
      for (const id of override.keys())
        for (const c of byDb.get(idToDb.get(id)) || [])
          b.union(boxOf(c.bounds_mm));
      recompute();
      fitBox(b, 1.05);
    },
    clearHighlight() {
      override = null;
      recompute();
    },
    setSimple(on) {
      simple = !!on;
      if (on) fullModel = false;
      clearSelection();
      recompute();
      frameOverview();
    },
    deckLevels() {
      return manifest.deck_levels || [];
    },
    setDeckCut(id) {
      geometryNotice = "";
      const l = (manifest.deck_levels || []).find(
        (l) => String(l.id) === String(id),
      );
      clipping.length = 0;
      if (l) {
        clipping.push(
          new THREE.Plane(new THREE.Vector3(0, -1, 0), l.height + 2300),
        );
        const c = allBounds.getCenter(new THREE.Vector3()),
          s = allBounds.getSize(new THREE.Vector3());
        controls.target.copy(c);
        camera.position.set(c.x, c.y + Math.max(s.x, s.z) * 1.2, c.z + 1);
        controls.update();
      }
      material.needsUpdate = true;
      overviewMaterial.needsUpdate = true;
      invalidate();
      schedule();
      return l;
    },
    overview() {
      clearSelection();
      recompute();
      frameOverview();
    },
    setMode(m) {
      mode = m;
    },
    setPlan() {},
    get mode() {
      return mode;
    },
    get plan() {
      return false;
    },
    screenshot() {
      renderer.render(scene, camera);
      return Promise.resolve(renderer.domElement.toDataURL("image/png"));
    },
  };
}
