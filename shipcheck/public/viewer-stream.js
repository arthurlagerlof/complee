// Viewport-driven local viewer. Only requested spatial tiles are resident; old merged GLBs remain untouched.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { createSceneOverlay } from "./viewer-scene.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import {
  selectFocusTiles,
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
  const configResponse = await fetch("api/model/config", { cache: "no-store" });
  const cfg = await configResponse.json().catch(() => ({}));
  if (!configResponse.ok)
    throw new Error(cfg.error || `Model gateway configuration failed (${configResponse.status})`);
  const base = new URL(cfg.base_url || "model/", document.baseURI),
    manifestUrl = new URL(cfg.manifest || "stream/manifest.json", base);
  const response = await fetch(manifestUrl, { cache: "no-cache" });
  if (!response.ok)
    throw Error(
      `Model gateway could not provide viewport tiles (${response.status})`,
    );
  const manifest = await response.json();
  if (manifest.kind !== "viewport-tiles" || !manifest.chunks?.length)
    throw Error("Expected a viewport tile manifest");
  if (!decoderWorkersStarted) {
    // Meshopt decoding off the main thread: leave two cores to the page and the picking worker.
    MeshoptDecoder.useWorkers?.(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)));
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
    antialias: false,
    // Screenshots render right before reading the canvas, so the drawing buffer need not be preserved
    // (preserving it disables buffer-swap optimisations on most GPUs).
    preserveDrawingBuffer: false,
    powerPreference: "high-performance",
  });
  if (!renderer.capabilities.isWebGL2) {
    renderer.dispose();
    host.remove();
    badge.remove();
    labelEl.remove();
    throw new Error("The 3D viewer needs WebGL 2; this browser only offers WebGL 1");
  }
  // Keep GPU fill/fragment work bounded on high-DPI displays; screenshots still use the preserved drawing buffer.
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
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
  const overviewInfos = manifest.overview?.chunks || [];
  const allInfos = [...manifest.chunks, ...overviewInfos];
  // ---------- per-part state (colour + visibility), one texel per dbId ----------
  // Every vertex carries its part's dbId (the tile's COLOR_0 bytes, bound unchanged as `partId`) and its source
  // opacity (`partOpacity`). The vertex shader looks the part's state up in a small texture, so a state change
  // (selection, filter, rule view) rewrites a few hundred KB of texels instead of every vertex colour of every
  // resident tile, and hidden parts are collapsed in the vertex shader (no fragment work, early depth test intact).
  // State texel: rgb = linear display colour; a = 255 visible (source opacity applies), 254 selected part,
  // 1..253 forced see-through alpha (rule-view context ghost), 0 hidden.
  const STATE_W = 2048;
  let maxDb = 0;
  for (const c of allInfos) for (const db of c.dbIds) if (db > maxDb) maxDb = db;
  const stateRows = Math.max(1, Math.ceil((maxDb + 1) / STATE_W));
  const stateData = new Uint8Array(STATE_W * stateRows * 4);
  const stateTexture = new THREE.DataTexture(stateData, STATE_W, stateRows, THREE.RGBAFormat, THREE.UnsignedByteType);
  stateTexture.magFilter = THREE.NearestFilter;
  stateTexture.minFilter = THREE.NearestFilter;
  stateTexture.generateMipmaps = false;
  stateTexture.flipY = false;
  stateTexture.unpackAlignment = 1;
  stateTexture.needsUpdate = true;
  const LINEAR = Object.fromEntries(Object.entries(COLORS).map(([k, c]) => [k, linear(c).map((x) => Math.round(x * 255))]));
  const STATE_VERTEX_PARS = `
attribute vec4 partId;
attribute float partOpacity;
uniform highp sampler2D uState;
varying vec4 vState;
varying float vSelected;
`;
  // After project_vertex: look the part up, decide the effective alpha and collapse the vertex when this pass does
  // not draw it. All three vertices of a triangle belong to one part, so the whole triangle disappears.
  const stateVertex = (drawn) => `
{
  int pid = int(partId.x * 255.0 + 0.5) | (int(partId.y * 255.0 + 0.5) << 8) | (int(partId.z * 255.0 + 0.5) << 16) | (int(partId.w * 255.0 + 0.5) << 24);
  vec4 st = texelFetch(uState, ivec2(pid & ${STATE_W - 1}, pid >> ${Math.log2(STATE_W)}), 0);
  float a = floor(st.a * 255.0 + 0.5);
  float op = floor(partOpacity * 255.0 + 0.5);
  float eff = a < 0.5 ? 0.0 : (a > 253.5 ? op : min(a, op));
  vSelected = (a > 253.5 && a < 254.5 && eff > 254.5) ? 1.0 : 0.0;
  vState = vec4(st.rgb, eff / 255.0);
  if (!(${drawn})) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;
  const stateFragment = (alpha) => `
#include <color_fragment>
diffuseColor.rgb = vState.rgb;
diffuseColor.a = ${alpha};
`;
  function stateShader(mat, key, drawn, alpha) {
    mat.onBeforeCompile = (s) => {
      s.uniforms.uState = { value: stateTexture };
      s.vertexShader = s.vertexShader
        .replace("#include <common>", `#include <common>${STATE_VERTEX_PARS}`)
        .replace("#include <project_vertex>", `#include <project_vertex>${stateVertex(drawn)}`);
      s.fragmentShader = s.fragmentShader
        .replace("#include <common>", "#include <common>\nvarying vec4 vState;\nvarying float vSelected;")
        .replace("#include <color_fragment>", stateFragment(alpha));
    };
    mat.customProgramCacheKey = () => key;
    return mat;
  }
  // Opaque pass: parts whose effective alpha is 255.
  const material = stateShader(
    new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, clippingPlanes: clipping }),
    "viewport-state", "eff > 254.5", "1.0",
  );
  const overviewMaterial = stateShader(
    new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, clippingPlanes: clipping, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
    "viewport-state-overview", "eff > 254.5", "1.0",
  );
  // Parts that are transparent in the original model (material opacity < 1, e.g. the rescue-boat launch envelope at
  // 4 % or glazing at 20 %) and ghosted context are drawn in a second, see-through pass with that alpha.
  const glassMaterial = stateShader(
    new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, clippingPlanes: clipping, transparent: true, depthWrite: false }),
    "viewport-glass", "eff > 0.5 && eff < 254.5", "vState.a",
  );
  // X-ray: the selected part is drawn once more on top of everything (semi-transparent), so structure in front of it
  // never hides it.
  const xrayMaterial = stateShader(
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    "viewport-xray", "vSelected > 0.5", "0.6",
  );
  const PICK_MIN_ALPHA = 26; // parts below 10 % opacity are practically invisible in the original: not clickable
  // Scenario scene inside the real ship (elements with geom3d, e.g. ships/rcrv/inside.json): the real ship is neutral
  // context, cut just above the scene's deck, and the scene's few components carry the status colours.
  const sceneOverlay = createSceneOverlay(scene, COLORS);
  let sceneMode = false,
    sceneSelected = null,
    sceneDeckY = 0;
  const SCENE_VIEW = new THREE.Vector3(0.5, 1.05, -0.8); // from above, aft and to the side of the corridor
  // Camera flights (scene entry, component view): eased over ms, run by the render loop; instant when not visible.
  let flight = null;
  // Prefetch: the detail tiles around where the camera is going (scene, component) are requested before it flies,
  // so the view never arrives at half-loaded surroundings.
  let focusBox = null;
  async function waitForTiles(ms) {
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      if (![...desired].some((n) => !cache.has(n) && !failed.has(n))) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  // userMoves counts the times the user took hold of the camera (drag, wheel, touch): a flight still running then
  // stops where it is, and a flight that was about to start (after its tiles arrived) does not start.
  let userMoves = 0;
  function cancelFlight() {
    const f = flight;
    flight = null;
    f?.resolve(false);
  }
  // Resolves true when the flight arrived, false when it was replaced or the user took over.
  function flyTo(target, position, ms = 1200, onStep = null) {
    cancelFlight();
    const from = { t: controls.target.clone(), p: camera.position.clone() };
    const done = (k) => {
      controls.target.lerpVectors(from.t, target, k);
      camera.position.lerpVectors(from.p, position, k);
      onStep?.(k);
    };
    if (!ms || !container.offsetParent) {
      done(1);
      controls.update();
      invalidate();
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      flight = { t0: performance.now(), ms, done, resolve };
    });
  }
  const outline = new THREE.Box3Helper(new THREE.Box3(), 0x1f6feb);
  outline.material.depthTest = false;
  outline.renderOrder = 10;
  outline.visible = false;
  scene.add(outline);
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
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
  // Screen margins (1 = edge to edge): the whole ship in the overview, a part with room around it in the component
  // view (outline and label inside the view, the part still large), all parts of a rule in the rule view.
  const MARGIN = { overview: 1.12, component: 3.2, rule: 1.15 };
  const cornersOf = (b) => { const out = []; for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) out.push([x, y, z]); return out; };
  // Component view frame: at least ~4.5 m around the part, so it is seen in its place in the ship.
  const contextBox = (b) => {
    const size = b.getSize(new THREE.Vector3());
    return b.clone().expandByScalar(Math.max(0, (4500 - Math.max(size.x, size.y, size.z)) / 2));
  };
  let framedPoints = null;
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
    state: stateData,
    stateTexture,
  };
  Object.defineProperty(debug, "flying", { get: () => !!flight });
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
    if (framedBox) fitBox(framedBox, frameMargin, framedPoints);
    invalidate();
    schedule();
  }
  new ResizeObserver(resize).observe(container);
  // Near/far planes follow the geometry that is actually resident (the whole ship before the first tile arrives).
  const boundsScratch = { min: [0, 0, 0], max: [0, 0, 0] };
  function residentDepthBoxes() {
    if (selectedDb !== null && framedBox) return [framedBox];
    if (!cache.size) return [allBounds];
    const out = [];
    for (const c of cache.values()) out.push(c.info.bounds_mm);
    return out;
  }
  controls.addEventListener("start", () => {
    userMoves++;
    cancelFlight();
    // The user now frames the view: a resize keeps their camera instead of snapping back to the last framed box.
    framedBox = null;
    framedPoints = null;
  });
  controls.addEventListener("change", () => {
    viewRevision++;
    const d = camera.position.distanceTo(controls.target);
    const range = geometryDepthRange(camera.position, residentDepthBoxes(), d);
    camera.near = range.near;
    camera.far = range.far;
    camera.updateProjectionMatrix();
    invalidate();
    placeLabel();
    schedule();
  });
  void boundsScratch;
  renderer.setAnimationLoop(() => {
    if (!active || gpuLost || !container.offsetParent) return;
    if (flight) {
      const k = Math.min(1, (performance.now() - flight.t0) / flight.ms),
        e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const damping = controls.enableDamping;
      controls.enableDamping = false;
      flight.done(e);
      controls.update();
      controls.enableDamping = damping;
      invalidate();
      if (k >= 1) {
        const f = flight;
        flight = null;
        f.resolve(true);
      }
    }
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
  // points: corners of the real geometry (tile boxes), so the ship itself is centred, not its overall bounding box.
  // ms > 0: fly there smoothly (overview, rule view); 0: jump (first frame, resize).
  function fitBox(box, k = 1.1, points = null, ms = 0, dir = null) {
    if (!box || box.isEmpty()) return;
    framedBox = box.clone();
    frameMargin = k;
    framedPoints = points;
    const direction = dir ?? camera.position.clone().sub(controls.target);
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
      points,
    });
    if (ms && container.offsetParent) {
      camera.up.fromArray(frame.up);
      flyTo(new THREE.Vector3(...frame.target), new THREE.Vector3(...frame.position), ms);
      return;
    }
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
  function overviewItems() {
    return fullModel && overviewInfos.length
      ? overviewInfos
      : manifest.chunks.filter((c) => c.group === "context");
  }
  function overviewBounds() {
    const b = new THREE.Box3();
    for (const c of overviewItems()) b.union(boxOf(c.bounds_mm));
    return b.isEmpty() ? allBounds : b;
  }
  function resetCut() {
    if (clipping.length) {
      clipping.length = 0;
      material.needsUpdate = true;
      overviewMaterial.needsUpdate = true;
    glassMaterial.needsUpdate = true;
    }
    viewRevision++;
  }
  function frameOverview(ms = 0) {
    resetCut();
    geometryNotice = "";
    const view = new THREE.Vector3(-0.75, 0.45, 0.85);
    if (!ms) {
      const center = overviewBounds().getCenter(new THREE.Vector3());
      controls.target.copy(center);
      camera.position.copy(center).add(view);
    }
    fitBox(overviewBounds(), MARGIN.overview, overviewItems().flatMap((c) => cornersOf(c.bounds_mm)), ms, view);
  }

  let badgeText = "";
  function summary() {
    let bytes = 0, triangles = 0;
    for (const c of cache.values()) {
      bytes += c.info.resident_bytes;
      triangles += c.info.triangles;
    }
    stats.residentBytes = bytes;
    stats.residentTriangles = triangles;
    stats.residentTiles = cache.size;
    stats.pending = requests.size;
    let complete = stats.deferred === 0 && desired.size > 0 && failed.size === 0;
    if (complete) for (const n of desired) if (!cache.has(n)) { complete = false; break; }
    stats.viewComplete = complete;
    const text = `Local 3D viewer · ${cache.size}/${desired.size} tiles · ${(stats.residentBytes / 1e6).toFixed(0)} MB geometry estimate${requests.size ? " · loading visible parts…" : selectedDb !== null ? " · component" : camera.position.distanceTo(controls.target) * 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) > manifest.streaming.detail_span_mm ? " · overview; zoom in for detail" : ""}${stats.deferred ? " · " + stats.deferred + " detail tiles deferred; zoom in" : ""}${stats.smallDeferred ? " · " + stats.smallDeferred + " small-part tiles appear closer up" : ""}${stats.overviewDeferred ? " · overview incomplete: memory budget" : ""}${geometryNotice ? " · " + geometryNotice : ""}${failed.size ? " · some tiles unavailable; move view to retry" : ""}`;
    if (text !== badgeText) {
      badgeText = text;
      badge.textContent = text;
    }
  }
  // All dbIds the model contains (every tile), so a full recompute covers tiles that are still to arrive.
  const dbList = Uint32Array.from(new Set(allInfos.flatMap((c) => c.dbIds))).sort();
  function colorState(db, isRest) {
    const id = dbToId.get(db);
    if (selectedDb !== null) return db === selectedDb ? 255 : 0;
    if (override) return override.has(id) || context.has(db) ? 255 : 0;
    if (filterDbs && !context.has(db) && !filterDbs.has(db)) return 0;
    if (isRest && (!fullModel || filterDbs || override)) return 0;
    return 255;
  }
  let ghostParts = 0; // parts with a forced see-through alpha (rule-view context): tiles then need the glass pass
  function writeState(db) {
    const id = dbToId.get(db),
      st = override?.get(id) ?? results?.elements[id]?.worst,
      isRest = id === undefined;
    // Rule view: only the rule's parts carry a status colour; the hull around them is neutral context, so the
    // result of that rule is what stands out (the parts' own results of other rules are not mixed in).
    const ruleContext = override && !override.has(id) && !sceneMode;
    // Component view: the selected part in its colour, the real ship around it solid and neutral (cut open above
    // the part), never a part alone.
    const selGhost = !sceneMode && selectedDb !== null && db !== selectedDb;
    const col = LINEAR[
      sceneMode || selGhost || ruleContext
        ? "context"
        : isRest
          ? "none"
          : simple && context.has(db) && (!st || st === "compliant")
            ? "context"
            : st || "none"
    ];
    const shown = sceneMode
      ? isRest && !fullModel ? 0 : 255
      : selGhost
        ? 255
        : colorState(db, isRest);
    let alpha = shown;
    // Rule view: the hull around the rule's parts is a light see-through ghost, so parts inside the ship show.
    if (ruleContext && alpha) alpha = 40;
    if (!sceneMode && selectedDb !== null && db === selectedDb && alpha === 255) alpha = 254;
    const o = db * 4;
    const was = stateData[o + 3];
    if (was > 0 && was < 254) ghostParts--;
    if (alpha > 0 && alpha < 254) ghostParts++;
    stateData[o] = col[0];
    stateData[o + 1] = col[1];
    stateData[o + 2] = col[2];
    stateData[o + 3] = alpha;
  }
  // Effective alpha of one vertex (state and source opacity), as the shader computes it: used for picking.
  function effectiveAlpha(db, c, v) {
    const a = stateData[db * 4 + 3];
    if (!a) return 0;
    const op = c.opacity ? c.opacity[v] : 255;
    return a >= 254 ? op : Math.min(a, op);
  }
  // Extra passes per tile, created on demand and sharing the tile's geometry: see-through (source transparency or
  // ghosted parts) and x-ray (the tile holds the selected part).
  let xrayFor = undefined, xrayNames = new Set();
  function extraPass(c, key, mat, order) {
    if (c[key]) return c[key];
    const pass = new THREE.Mesh(c.geom, mat);
    pass.raycast = () => {};
    pass.renderOrder = order;
    pass.matrixAutoUpdate = false;
    c.mesh.updateMatrix();
    pass.matrix.copy(c.mesh.matrix);
    c.mesh.parent.add(pass);
    c[key] = pass;
    return pass;
  }
  function tileNeedsGlass(c) {
    if (c.transparentSource) return true;
    if (!ghostParts) return false;
    for (const db of c.info.dbIds) {
      const a = stateData[db * 4 + 3];
      if (a > 0 && a < 254) return true;
    }
    return false;
  }
  function updatePasses(only = null) {
    if (xrayFor !== selectedDb) {
      xrayFor = selectedDb;
      xrayNames = new Set();
      if (selectedDb !== null) for (const info of allInfos) if (info.dbIds.includes(selectedDb)) xrayNames.add(info.name);
    }
    const holdsSelected = !sceneMode && selectedDb !== null && stateData[selectedDb * 4 + 3] === 254;
    for (const c of only ? [only] : cache.values()) {
      const glass = tileNeedsGlass(c);
      if (glass) extraPass(c, "glass", glassMaterial, 2).visible = true;
      else if (c.glass) c.glass.visible = false;
      const xray = holdsSelected && xrayNames.has(c.info.name);
      if (xray) extraPass(c, "xray", xrayMaterial, 5).visible = true;
      else if (c.xray) c.xray.visible = false;
    }
  }
  function recompute(ids) {
    if (ids) {
      for (const id of ids) {
        const db = idToDb.get(id);
        if (db !== undefined && db <= maxDb) writeState(db);
      }
    } else for (let i = 0; i < dbList.length; i++) writeState(dbList[i]);
    stateTexture.needsUpdate = true;
    updatePasses();
    if (sceneMode) colourScene(ids);
    invalidate();
    schedule();
  }
  function colourScene(ids) {
    for (const id of ids || sceneOverlay.ids()) {
      if (!sceneOverlay.has(id)) continue;
      sceneOverlay.setStatus(
        id,
        override
          ? override.get(id) || "context"
          : results?.elements[id]?.worst || "none",
      );
    }
    sceneOverlay.focus(sceneSelected);
    invalidate();
  }
  function setCut(y) {
    clipping.length = 0;
    if (y != null) clipping.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), y));
    material.needsUpdate = true;
    overviewMaterial.needsUpdate = true;
    glassMaterial.needsUpdate = true;
    invalidate();
  }
  // Scene view: cut 1.5 m above the scene's deck (below the real ceilings), camera from above at an angle.
  function sceneFrame(box, margin) {
    return fitPerspectiveBox(box, {
      fov: camera.getEffectiveFOV(),
      aspect: viewportAspect(container.clientWidth, container.clientHeight, camera.aspect),
      direction: SCENE_VIEW,
      up: [0, 1, 0],
      margin,
    });
  }
  async function frameScene(ms = 2400) {
    const box = sceneOverlay.bounds();
    if (box.isEmpty()) return;
    const f = sceneFrame(box, 1.2);
    framedBox = box.clone();
    frameMargin = 1.2;
    framedPoints = null;
    const top = allBounds.max.y + 500,
      cut = sceneDeckY + 1500;
    // Entering: first the ship is cut open from the top down to the deck (camera still), then the camera dives in.
    focusBox = box.clone().expandByScalar(5000);
    if (!clipping.length) setCut(top);
    const startCut = clipping[0].constant, moves = userMoves;
    if (ms && startCut > cut + 1) {
      await flyTo(controls.target.clone(), camera.position.clone(), ms * 0.45, (k) => {
        clipping[0].constant = startCut + (cut - startCut) * k;
      });
    }
    setCut(cut);
    if (ms) {
      schedule();
      await waitForTiles(4000);
    }
    // The user took over during the entry: keep their camera (the scene is cut open already).
    if (userMoves === moves) await flyTo(new THREE.Vector3(...f.target), new THREE.Vector3(...f.position), ms * 0.55);
    schedule();
  }
  const desc = (a, more = {}) => ({
    buffer: a.buffer,
    byteOffset: a.byteOffset,
    length: a.length,
    ctor: a.constructor.name,
    ...more,
  });
  // Once a tile's buffers are on the GPU, its positions, indices and dbIds move (zero-copy) to the picking worker.
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
      const ids = c.dbids;
      c.dbids = null;
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
      n = geom.attributes.position.count;
    if (!col || col.itemSize !== 4) throw Error("Tile has no dbId attribute");
    // dbId per vertex for the picking worker (the attribute itself stays on the GPU, unchanged, as `partId`).
    const dbids = new Uint32Array(n),
      raw = col.array;
    if (raw instanceof Uint8Array && !col.isInterleavedBufferAttribute) {
      for (let v = 0; v < n; v++) dbids[v] = (raw[4 * v] | (raw[4 * v + 1] << 8) | (raw[4 * v + 2] << 16) | (raw[4 * v + 3] << 24)) >>> 0;
    } else {
      for (let v = 0; v < n; v++)
        dbids[v] = (Math.round(col.getX(v) * 255) | (Math.round(col.getY(v) * 255) << 8) | (Math.round(col.getZ(v) * 255) << 16) | (Math.round(col.getW(v) * 255) << 24)) >>> 0;
    }
    geom.setAttribute("partId", col);
    geom.deleteAttribute("color");
    // Source opacity per vertex: from the tile (_OPACITY) or, for tiles without it, the manifest's per-part table.
    // The shader reads it as `partOpacity`; `opacity` (null when everything is opaque) serves the picking filter.
    let opacity = null;
    const opAttr = geom.attributes._opacity;
    if (opAttr) {
      for (let v = 0; v < n; v++) {
        const o = Math.round(opAttr.getX(v) * 255);
        if (o < 255) (opacity ??= new Uint8Array(n).fill(255))[v] = o;
      }
      geom.setAttribute("partOpacity", opAttr);
      geom.deleteAttribute("_opacity");
    } else {
      const table = manifest.opacity_by_dbid;
      const bytes = new Uint8Array(n).fill(255);
      if (table) for (let v = 0; v < n; v++) {
        const o = table[dbids[v]];
        if (o !== undefined && o < 255) { bytes[v] = o; opacity = bytes; }
      }
      geom.setAttribute("partOpacity", new THREE.BufferAttribute(bytes, 1, true));
    }
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
        opacity,
        transparentSource: opacity !== null,
        readyPromise,
        resolveReady,
        units: new Set(),
        uploaded: new Set(),
        sent: false,
        ready: false,
        glass: null,
        xray: null,
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
    updatePasses(c);
    // Put the tile on the GPU right away (a 1x1 off-screen draw): its picking index is then built in the background
    // and nothing is uploaded later in the middle of a rotation.
    const fc = mesh.frustumCulled;
    mesh.frustumCulled = false;
    renderer.setRenderTarget(uploadTarget);
    renderer.render(mesh, camera);
    renderer.setRenderTarget(null);
    mesh.frustumCulled = fc;
    afterRender();
    if (stats.firstPicture === null) {
      // First picture: draw once right away (a hidden or throttled tab may not deliver animation frames).
      renderer.render(scene, camera);
      dirty = false;
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
      tilesByDb: byDb,
      cutHeight: clipping[0]?.constant ?? Infinity,
      // Screen-size rule: small detail tiles load only when they appear large enough (or are selected).
      eye: camera.position.toArray(),
      screenScale:
        (renderer.domElement.clientHeight || 1) /
        (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))),
      resident: new Set(cache.keys()),
    };
  }
  function schedule() {
    if (!active || gpuLost || !loaded) return;
    scheduler.request();
  }
  function refresh() {
    if (!active || gpuLost) return;
    failed.clear();
    const options = viewOptions();
    const plan = selectViewportTiles(manifest, options);
    stats.deferred = plan.deferred;
    stats.overviewDeferred = plan.overviewDeferred || 0;
    stats.smallDeferred = plan.smallDeferred || 0;
    if (plan.componentUnavailable) geometryNotice = plan.componentUnavailable;
    stats.coverageComplete = plan.deferred === 0;
    desired.clear();
    for (const c of plan.tiles) desired.add(c.name);
    if (focusBox) {
      // Context around a scene or rule focus: bounded by screen size and a triangle budget (viewport-policy.mjs).
      const focus = selectFocusTiles(manifest, { min: focusBox.min.toArray(), max: focusBox.max.toArray() }, options);
      for (const c of focus.tiles) desired.add(c.name);
      stats.smallDeferred += focus.smallDeferred;
      stats.deferred += focus.budgetDeferred;
    }
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
    // Tiles are small (tens of KB): keep several requests in flight even from a local disk server.
    const max = Math.max(manifest.streaming.max_requests || 2, 4);
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
    if (sceneMode) {
      const sid = sceneOverlay.pick(ray);
      if (sid) {
        onPick?.(sid);
        return;
      }
    }
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
        effectiveAlpha(h.db, h.c, h.v) < PICK_MIN_ALPHA
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
    const hadScene = sceneSelected !== null;
    sceneSelected = null;
    sceneOverlay.focus(null);
    if (!sceneMode) focusBox = null;
    selectionVersion++;
    viewRevision++;
    geometryNotice = "";
    showBox(null, null);
    return had || hadScene;
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
    glassMaterial.needsUpdate = true;
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
    // keepTiles: the next scenario uses this viewer too (e.g. real ship -> corridor scene): keep the loaded geometry,
    // so the ship does not rebuild; requests in flight are still cancelled.
    setActive(on, { keepTiles = false } = {}) {
      active = !!on;
      if (!active) {
        resolveFirst?.();
        scheduler.cancel();
        for (const r of requests.values()) r.controller.abort();
        if (!keepTiles) {
          for (const n of [...cache.keys()]) evict(n);
          desired.clear();
        }
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
      active = true;
      const sceneEls = norm.elements.filter((e) => e.geom3d);
      const wasScene = sceneMode;
      sceneMode = sceneEls.length > 0;
      sceneOverlay.build(sceneEls);
      if (sceneMode) {
        const floor = sceneEls.find((e) => e.type === "corridor") || sceneEls[0];
        sceneDeckY = floor.geom3d.min[1];
        recompute();
        // Entering: fly in. Rebuilt while the flight runs (the app builds twice on a switch): let it finish.
        if (!wasScene) frameScene(3000);
        else if (!flight) frameScene(0);
        return;
      }
      focusBox = null;
      resetCut();
      recompute();
      frameOverview();
    },
    get sceneMode() {
      return sceneMode;
    },
    update(r, ids) {
      results = r;
      recompute(ids);
    },
    paintNeutral() {
      for (const id of sceneOverlay.ids()) sceneOverlay.setStatus(id, "none");
      for (let i = 0; i < dbList.length; i++) {
        const o = dbList[i] * 4;
        stateData[o] = 184;
        stateData[o + 1] = 191;
        stateData[o + 2] = 201;
      }
      stateTexture.needsUpdate = true;
      invalidate();
    },
    async select(id, { fly = true, label = null, status = null } = {}) {
      if (sceneMode && sceneOverlay.has(id)) {
        selectionVersion++;
        sceneSelected = id;
        sceneOverlay.focus(id);
        const b = sceneOverlay.box(id);
        if (fly) {
          const f = sceneFrame(b, 2.4);
          framedBox = b.clone();
          frameMargin = 2.4;
          framedPoints = null;
          flyTo(new THREE.Vector3(...f.target), new THREE.Vector3(...f.position), 1100);
        }
        showBox(b, label, status);
        return;
      }
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
      if (fly && b) {
        // Cut the ship open 1 m above the part and look down at it from an angle, in its real surroundings.
        setCut(b.max.y + 1000);
        const f = sceneFrame(contextBox(b), 1.15);
        framedBox = contextBox(b);
        frameMargin = 1.15;
        framedPoints = null;
        focusBox = contextBox(b).expandByScalar(2000);
        schedule();
        const moves = userMoves;
        await waitForTiles(3000);
        if (version !== selectionVersion) return;
        if (userMoves === moves) flyTo(new THREE.Vector3(...f.target), new THREE.Vector3(...f.position), 1100);
        schedule();
      }
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
      if (!set && !filterDbs) return; // no filter before, none now: nothing to recompute (the list re-renders often)
      filterDbs = set
        ? new Set([...set].map((id) => idToDb.get(id)).filter((d) => d != null))
        : null;
      recompute();
    },
    highlight(status) {
      override = new Map(Object.entries(status));
      clearSelection();
      if (!sceneMode) resetCut(); // a component view's cut must not hide parts of the rule
      const b = new THREE.Box3(), points = [];
      for (const id of override.keys())
        for (const c of byDb.get(idToDb.get(id)) || []) {
          b.union(boxOf(c.bounds_mm));
          points.push(...cornersOf(c.bounds_mm));
        }
      recompute();
      fitBox(b, MARGIN.rule, points, 1000);
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
    glassMaterial.needsUpdate = true;
      invalidate();
      schedule();
      return l;
    },
    overview() {
      clearSelection();
      recompute();
      if (sceneMode) {
        frameScene(1100);
        return;
      }
      frameOverview(1000);
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
