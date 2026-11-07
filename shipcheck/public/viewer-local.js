// Local 3D viewer for the real RCRV model: our own glTF chunks (model/manifest.json, exported once from the
// Autodesk model with tools/export), drawn with Three.js from node_modules. No Autodesk viewer, token or CDN.
//
// Same interface and behaviour as viewer-aps.js, so the UI does not change:
//   build, update, paintNeutral, select(id, {fly, label, status}), setLabel, clearSelection, setFilter,
//   highlight / clearHighlight (rule view), setSimple, deckLevels / setDeckCut, overview, screenshot
//
// Each chunk is one merged mesh; every vertex carries the dbId of its part (COLOR_0 bytes = parts.json objectid).
// Colours, isolation and ghosting are per-vertex states, so a chunk is drawn in one call (two when ghosting).
// Nothing is generated: the geometry is the model's own.
//
// Full model: after the 6 main chunks, the rest of the model (parts no rule looks at, manifest group "rest") loads in
// the background, drawn in neutral grey, shown in the overview when no findings filter, rule view or component view is
// active ("Full model" toggle). It never changes a compliance colour or count.
// Off the main thread: meshopt decoding (decoder workers) and the picking index (pick-worker.js, a BVH per chunk).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

MeshoptDecoder.useWorkers?.(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 2)));

// Same colours as the APS viewer (viewer-aps.js).
const COLORS = { non_compliant: [0.84, 0.27, 0.27], not_enough_info: [0.85, 0.6, 0.12], compliant: [0.18, 0.62, 0.36], context: [0.86, 0.88, 0.91], none: [0.72, 0.75, 0.79] };
const lin = (c) => c.map((x) => Math.pow(x, 2.2)); // sRGB UI colour -> linear (as the vertex colours)
const CONTEXT_GROUPS = new Set(['110', '130']);
const HIDDEN = 0, GHOST = 128, VISIBLE = 255; // vertex state (alpha byte)
const HEADROOM_MM = 2300; // deck cut: keep 2.3 m above the deck plating

// Opaque pass draws VISIBLE vertices with their colour; ghost pass draws GHOST vertices faintly.
function makeMaterials(clipPlanes) {
  const opaque = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, clippingPlanes: clipPlanes });
  opaque.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', '#include <color_fragment>\n if (vColor.a < 0.99) discard;\n diffuseColor.a = 1.0;');
  };
  opaque.customProgramCacheKey = () => 'sc-opaque';
  const ghost = new THREE.MeshBasicMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide, vertexColors: true, clippingPlanes: clipPlanes });
  ghost.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', 'if (vColor.a < 0.3 || vColor.a > 0.7) discard;\n diffuseColor.rgb = vec3(0.55, 0.6, 0.66);');
  };
  ghost.customProgramCacheKey = () => 'sc-ghost';
  // Rest of the model (not checked by any rule): one neutral grey, no per-vertex state.
  const rest = new THREE.MeshLambertMaterial({ color: new THREE.Color(...lin(COLORS.none)), side: THREE.DoubleSide, clippingPlanes: clipPlanes });
  return { opaque, ghost, rest };
}

export async function createLocalViewer(container, { onPick, onPickRest, base = '' } = {}) {
  const manifest = await fetch(`${base}model/manifest.json`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`model/manifest.json: ${r.status}`))));
  if (!manifest?.chunks?.length) throw new Error('model/manifest.json has no chunks');

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0';
  container.appendChild(host);
  const badge = document.createElement('div');
  badge.className = 'aps-status';
  container.appendChild(badge);
  const labelEl = document.createElement('div');
  labelEl.className = 'aps-label';
  labelEl.hidden = true;
  container.appendChild(labelEl);

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.localClippingEnabled = true;
  renderer.setClearColor(0xeef1f5);
  host.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  // Bright, even lighting so the status colours read like in the APS viewer.
  scene.add(new THREE.HemisphereLight(0xffffff, 0xc8ced8, 2.4));
  const sun = new THREE.DirectionalLight(0xffffff, 0.9);
  sun.position.set(0.4, 1, 0.6);
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(35, 1, 50, 1e6);
  camera.position.set(-40000, 20000, 40000);
  camera.add(new THREE.DirectionalLight(0xffffff, 0.6)); // headlight: faces toward the viewer stay readable
  scene.add(camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.15;
  const root = new THREE.Group();
  scene.add(root);
  const clip = [];
  const mats = makeMaterials(clip);
  const outline = new THREE.Box3Helper(new THREE.Box3(), 0x1f6feb);
  outline.material.depthTest = false;
  outline.renderOrder = 10;
  outline.visible = false;
  scene.add(outline);
  window.localViewer = { renderer, scene, camera, controls }; // for the browser console (stats added below)

  // ---------- render on demand (keeps the laptop GPU idle when nothing moves) ----------
  let dirty = true, frames = 0;
  const invalidate = () => { dirty = true; };
  controls.addEventListener('change', () => { invalidate(); placeLabel(); });
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  }
  new ResizeObserver(resize).observe(container);
  resize();
  renderer.setAnimationLoop(() => {
    if (!container.offsetParent) return;
    controls.update();
    if (!dirty) return;
    dirty = false;
    frames++;
    renderer.render(scene, camera);
    afterRender();
    placeLabel();
  });

  // ---------- model data ----------
  const chunks = []; // { name, mesh, ghostMesh, geom, state(Uint8Array RGBA), dbids(Uint32Array) }
  const partVerts = new Map(); // dbId -> [{ c: chunk index, v: Uint32Array of vertex indices }]
  const partBox = new Map(); // dbId -> Box3 (world)
  let loaded = null, results = null;
  let idToDb = new Map(), dbToId = new Map(), elementsById = new Map(), checked = new Set(), context = new Set();
  let simple = true, override = null, filterDbs = null, selectedId = null, labelAnchor = null, mode = 'all', ghosting = false;
  const stats = { started: performance.now(), firstPicture: null, loaded: null, bytes: 0, restLoaded: null, restBytes: 0, restTriangles: 0, restErrors: [], pickReady: null };
  window.localViewer.stats = stats;
  // Rest of the model ("Full model"): { info, mesh, ids, units, uploaded, sent, ready }
  const restInfos = manifest.chunks.filter((c) => c.group === 'rest');
  const rest = [];
  const restDb = new Map(); // dbId -> rest chunk index
  let fullModel = true, selectedRest = null;
  window.localViewer.rest = rest;

  function indexChunk(ci) {
    const ch = chunks[ci];
    const n = ch.dbids.length;
    const counts = new Map();
    for (let v = 0; v < n; v++) counts.set(ch.dbids[v], (counts.get(ch.dbids[v]) || 0) + 1);
    const lists = new Map();
    for (const [db, k] of counts) lists.set(db, { a: new Uint32Array(k), k: 0 });
    for (let v = 0; v < n; v++) { const l = lists.get(ch.dbids[v]); l.a[l.k++] = v; }
    const pos = ch.geom.attributes.position, p = new THREE.Vector3();
    ch.mesh.updateMatrixWorld(true);
    for (const [db, l] of lists) {
      if (!partVerts.has(db)) partVerts.set(db, []);
      partVerts.get(db).push({ c: ci, v: l.a });
      const box = partBox.get(db) || new THREE.Box3();
      for (let i = 0; i < l.a.length; i++) box.expandByPoint(p.fromBufferAttribute(pos, l.a[i]).applyMatrix4(ch.mesh.matrixWorld));
      partBox.set(db, box);
    }
  }

  async function loadChunk(ci, loader, info) {
    const url = `${base}model/${info.file}`;
    const gltf = await loader.loadAsync(url);
    let mesh = null;
    gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
    if (!mesh) throw new Error(`${info.file}: no mesh found`);
    const geom = mesh.geometry;
    const col = geom.attributes.color;
    const n = geom.attributes.position.count;
    const dbids = new Uint32Array(n);
    // COLOR_0 bytes -> dbId (the attribute may come back as normalized bytes or as floats)
    const raw = col.array;
    if (raw instanceof Uint8Array && col.itemSize === 4) {
      for (let v = 0; v < n; v++) dbids[v] = raw[4 * v] | (raw[4 * v + 1] << 8) | (raw[4 * v + 2] << 16) | (raw[4 * v + 3] << 24) >>> 0;
    } else {
      for (let v = 0; v < n; v++) dbids[v] = Math.round(col.getX(v) * 255) | (Math.round(col.getY(v) * 255) << 8) | (Math.round(col.getZ(v) * 255) << 16) | (Math.round(col.getW(v) * 255) << 24);
    }
    const state = new Uint8Array(n * 4);
    geom.setAttribute('color', new THREE.BufferAttribute(state, 4, true));
    // The picking index is built in pick-worker.js once the geometry is on the GPU (see afterRender).
    mesh.material = mats.opaque;
    mesh.raycast = () => {};
    mesh.frustumCulled = false;
    const ghostMesh = new THREE.Mesh(geom, mats.ghost);
    ghostMesh.matrixAutoUpdate = false;
    ghostMesh.raycast = () => {};
    ghostMesh.renderOrder = 1;
    ghostMesh.visible = false;
    ghostMesh.frustumCulled = false;
    mesh.updateMatrix();
    ghostMesh.matrix.copy(mesh.matrix);
    mesh.parent.add(ghostMesh);
    root.add(gltf.scene);
    chunks[ci] = { name: info.name, mesh, ghostMesh, geom, state, dbids, key: `m${ci}` };
    indexChunk(ci);
    trackUpload(chunks[ci], [geom.attributes.position, geom.attributes.normal, geom.index]);
    stats.bytes += info.bytes || 0;
  }

  // Rest chunk: grey, no per-vertex state; the dbIds only go to the picking worker.
  async function loadRestChunk(ri, loader, info) {
    const gltf = await loader.loadAsync(`${base}model/${info.file}`);
    let mesh = null;
    gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
    if (!mesh) throw new Error(`${info.file}: no mesh found`);
    const geom = mesh.geometry, col = geom.attributes.color, n = geom.attributes.position.count;
    const ids = new Uint32Array(n);
    const raw = col.array;
    if (raw instanceof Uint8Array && col.itemSize === 4 && !col.isInterleavedBufferAttribute) {
      for (let v = 0; v < n; v++) ids[v] = (raw[4 * v] | (raw[4 * v + 1] << 8) | (raw[4 * v + 2] << 16) | (raw[4 * v + 3] << 24)) >>> 0;
    } else {
      for (let v = 0; v < n; v++) ids[v] = Math.round(col.getX(v) * 255) | (Math.round(col.getY(v) * 255) << 8) | (Math.round(col.getZ(v) * 255) << 16) | (Math.round(col.getW(v) * 255) << 24);
    }
    geom.deleteAttribute('color');
    for (let v = 0, prev = -1; v < n; v++) if (ids[v] !== prev) { prev = ids[v]; restDb.set(prev, ri); }
    if (!geom.boundingSphere) geom.computeBoundingSphere();
    mesh.material = mats.rest;
    mesh.raycast = () => {};
    mesh.frustumCulled = true; // a rest chunk is one slice of the ship: skipped when outside the view
    root.add(gltf.scene);
    const r = { info, mesh, geom, ids, key: `r${ri}` };
    rest[ri] = r;
    trackUpload(r, [geom.attributes.position, geom.attributes.normal, geom.index]);
    mesh.visible = restShown();
    stats.restBytes += info.bytes || 0;
    stats.restTriangles += info.triangles || 0;
  }

  // ---------- GPU upload, then hand the geometry to the picking worker ----------
  // Once a chunk's position / normal / index buffers are on the GPU, the page does not need its own copy: the arrays
  // move (zero-copy) to pick-worker.js, which builds the picking index there.
  const picker = new Worker(new URL('./pick-worker.js', import.meta.url));
  const pending = new Map();
  let qid = 0, pickTodo = 0;
  picker.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'ready') {
      const c = m.id[0] === 'm' ? chunks[+m.id.slice(1)] : rest[+m.id.slice(1)];
      if (c) c.ready = true;
      if (--pickTodo === 0 && stats.loaded && (stats.restLoaded || !restInfos.length)) stats.pickReady = performance.now() - stats.started;
      return;
    }
    pending.get(m.qid)?.(m);
    pending.delete(m.qid);
  };
  const ask = (msg) => new Promise((res) => { const q = ++qid; pending.set(q, res); picker.postMessage({ ...msg, qid: q }); });
  function trackUpload(c, attrs) {
    c.units = new Set(); c.uploaded = new Set();
    for (const a of attrs) {
      if (!a) continue;
      const u = a.isInterleavedBufferAttribute ? a.data : a;
      c.units.add(u);
      u.onUpload(() => c.uploaded.add(u));
    }
  }
  const desc = (arr, extra = {}) => ({ buffer: arr.buffer, byteOffset: arr.byteOffset, length: arr.length, ctor: arr.constructor.name, ...extra });
  function sendToPicker(c, ids) {
    const pa = c.geom.attributes.position, ia = c.geom.index;
    const parr = pa.isInterleavedBufferAttribute ? pa.data.array : pa.array;
    const stride = pa.isInterleavedBufferAttribute ? pa.data.stride : pa.itemSize;
    const offset = pa.isInterleavedBufferAttribute ? pa.offset : 0;
    const scale = !pa.normalized ? 1 : parr instanceof Uint16Array ? 1 / 65535 : parr instanceof Int16Array ? 1 / 32767 : parr instanceof Uint8Array ? 1 / 255 : parr instanceof Int8Array ? 1 / 127 : 1;
    const transfer = [...new Set([parr.buffer, ia.array.buffer, ids.buffer])];
    picker.postMessage({ type: 'chunk', id: c.key, pos: desc(parr, { stride, offset, scale }), index: desc(ia.array), ids: desc(ids) }, transfer);
    for (const u of c.units) u.array = null; // moved to the worker; the GPU keeps its copy
    c.sent = true;
    pickTodo++;
  }
  function afterRender() {
    for (const c of chunks) if (c && !c.sent && c.uploaded.size === c.units.size) sendToPicker(c, c.dbids.slice());
    for (const r of rest) if (r && !r.sent && r.uploaded.size === r.units.size) { sendToPicker(r, r.ids); r.ids = null; }
  }
  // Puts one chunk on the GPU right away (a 1x1 off-screen render), so its picking index is built in the background
  // and nothing is uploaded later in the middle of a rotation.
  const uploadTarget = new THREE.WebGLRenderTarget(1, 1);
  function preUpload(mesh) {
    const vis = mesh.visible, fc = mesh.frustumCulled;
    mesh.visible = true; mesh.frustumCulled = false;
    renderer.setRenderTarget(uploadTarget);
    renderer.render(mesh, camera);
    renderer.setRenderTarget(null);
    mesh.visible = vis; mesh.frustumCulled = fc;
    afterRender();
  }

  function load() {
    if (loaded) return loaded;
    loaded = (async () => {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const eager = manifest.chunks.filter((c) => c.group !== 'rest' && c.load !== 'on-demand');
      let done = 0, mb = 0;
      const total = eager.reduce((s, c) => s + (c.bytes || 0), 0) / 1e6;
      for (const info of eager) {
        badge.textContent = `Loading the RCRV model (local) … ${info.title || info.name} · ${mb.toFixed(0)} / ${total.toFixed(0)} MB`;
        await loadChunk(chunks.length, loader, info);
        done++;
        mb += (info.bytes || 0) / 1e6;
        if (results) { recomputeAll(); }
        if (done === 1) {
          // First picture: draw once right away (does not wait for animation frames, which a hidden or
          // throttled tab may not deliver).
          frameHull();
          renderer.render(scene, camera);
          afterRender();
          stats.firstPicture = performance.now() - stats.started;
        } else preUpload(chunks[chunks.length - 1].mesh);
        await new Promise((r) => setTimeout(r, 0)); // let the page update between chunks
      }
      stats.loaded = performance.now() - stats.started;
      badge.textContent = 'Local 3D viewer · real RCRV model';
      loadRest(loader); // background: load() resolves now, the full model follows
    })();
    return loaded;
  }

  async function loadRest(loader) {
    if (!restInfos.length) return;
    const total = restInfos.reduce((s, c) => s + (c.bytes || 0), 0) / 1e6;
    let mb = 0;
    for (const [ri, info] of restInfos.entries()) {
      badge.textContent = `Local 3D viewer · real RCRV model · full model ${mb.toFixed(0)} / ${total.toFixed(0)} MB`;
      try {
        await loadRestChunk(ri, loader, info);
        if (rest[ri]) preUpload(rest[ri].mesh);
      } catch (e) {
        stats.restErrors.push(info.file);
        console.warn(`Full model: ${info.file} not loaded:`, e.message);
      }
      mb += (info.bytes || 0) / 1e6;
      invalidate();
      await new Promise((r) => setTimeout(r, 0));
    }
    stats.restFinished = performance.now() - stats.started;
    if (!stats.restErrors.length) stats.restLoaded = stats.restFinished;
    badge.textContent = stats.restErrors.length
      ? `Full model incomplete: ${stats.restErrors.join(', ')} not loaded; reload to retry`
      : 'Local 3D viewer · real RCRV model';
  }

  // ---------- state per part: colour + visible / ghost / hidden ----------
  function colourOf(id) {
    if (override) return override.get(id) ?? (context.has(id) ? 'context' : null);
    const st = results?.elements[id]?.worst;
    if (simple && context.has(id) && (st === 'compliant' || !st)) return 'context';
    return st ?? null;
  }
  function stateOf(db) {
    const id = dbToId.get(db);
    if (selectedId != null && focusOnly) return id === selectedId ? VISIBLE : HIDDEN;
    if (override) return (id && (override.has(id) || context.has(id))) ? VISIBLE : (ghosting ? GHOST : HIDDEN);
    if (fullModel && !filterDbs && !focusOnly) return VISIBLE;
    const inBase = id && (filterDbs ? filterDbs.has(db) : results?.elements[id]?.worst);
    if (simple) return (inBase || (id && context.has(id))) ? VISIBLE : HIDDEN;
    return inBase ? VISIBLE : GHOST;
  }
  function writePart(db) {
    const id = dbToId.get(db);
    const st = stateOf(db);
    const c = COLORS[(id && colourOf(id)) || 'none'] || COLORS.none;
    // Vertex colours are linear in Three.js: convert the sRGB UI colours so they display as in the APS viewer.
    const r = Math.round(Math.pow(c[0], 2.2) * 255), g = Math.round(Math.pow(c[1], 2.2) * 255), b = Math.round(Math.pow(c[2], 2.2) * 255);
    for (const { c: ci, v } of partVerts.get(db) || []) {
      const s = chunks[ci].state;
      for (let i = 0; i < v.length; i++) { const o = v[i] * 4; s[o] = r; s[o + 1] = g; s[o + 2] = b; s[o + 3] = st; }
    }
  }
  // Rest parts are shown in the overview only: not with a findings filter, the rule view or the component view.
  const restShown = () => fullModel && !filterDbs && !override && !focusOnly;
  function updateRest() {
    const on = restShown();
    for (const r of rest) if (r) r.mesh.visible = on;
  }
  function flush() {
    ghosting = false;
    updateRest();
    for (const ch of chunks) if (ch) { ch.geom.attributes.color.needsUpdate = true; }
    // Ghost pass only when some vertex is ghosted.
    for (const ch of chunks) if (ch) { let any = false; const s = ch.state; for (let i = 3; i < s.length; i += 4) if (s[i] === GHOST) { any = true; break; } ch.ghostMesh.visible = any; }
    invalidate();
  }
  let focusOnly = false;
  function recomputeAll() { for (const db of partVerts.keys()) writePart(db); flush(); }

  // ---------- camera ----------
  function fitBox(box, k = 1.15) {
    if (!box || box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 300) * k;
    const dir = camera.position.clone().sub(controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(-0.6, 0.45, 0.65).normalize();
    const vfov = THREE.MathUtils.degToRad(camera.fov / 2);
    const hfov = Math.atan(Math.tan(vfov) * camera.aspect);
    const dist = r / Math.sin(Math.min(vfov, hfov));
    controls.target.copy(c);
    camera.position.copy(c).addScaledVector(dir, dist);
    camera.near = Math.max(dist / 1000, 5);
    camera.far = dist * 50;
    camera.updateProjectionMatrix();
    controls.update();
    invalidate();
  }
  const unionOf = (dbs) => { const b = new THREE.Box3(); for (const db of dbs) { const x = partBox.get(db); if (x) b.union(x); } return b; };
  const hullDbs = () => [...context].map((id) => idToDb.get(id)).filter((d) => d != null);
  function frameHull() {
    const hull = hullDbs();
    if (fullModel && !filterDbs && !override) {
      const all = new THREE.Box3();
      for (const ch of manifest.chunks) if (ch.bounds_mm) all.union(new THREE.Box3(new THREE.Vector3(...ch.bounds_mm.min), new THREE.Vector3(...ch.bounds_mm.max)));
      fitBox(all, 1.05);
    } else fitBox(hull.length ? unionOf(hull) : unionOf(partBox.keys()), 1.05);
  }

  // ---------- overlays: label and box outline ----------
  function placeLabel() {
    if (!labelAnchor || labelEl.hidden) return;
    const p = labelAnchor.clone().project(camera);
    const x = (p.x + 1) / 2 * container.clientWidth, y = (1 - p.y) / 2 * container.clientHeight;
    labelEl.style.visibility = p.z > 1 || x < 0 || y < 0 || x > container.clientWidth || y > container.clientHeight ? 'hidden' : 'visible';
    labelEl.style.left = `${x}px`;
    labelEl.style.top = `${y}px`;
  }
  function showLabel(box, html, status) {
    if (!box || !html) { labelEl.hidden = true; labelAnchor = null; return; }
    labelAnchor = box.getCenter(new THREE.Vector3());
    labelEl.className = `aps-label st-${status || 'none'}`;
    labelEl.innerHTML = html;
    labelEl.hidden = false;
    placeLabel();
  }
  function showOutline(box) {
    outline.visible = !!box;
    if (box) outline.box.copy(box);
    invalidate();
  }

  // ---------- picking (pick-worker.js) ----------
  const ray = new THREE.Raycaster();
  let down = null;
  // Every hit along the ray in the visible chunks, nearest first, in world coordinates.
  async function hitsAlong(r) {
    const targets = [...chunks.filter((c) => c?.sent), ...rest.filter((c) => c?.sent && c.mesh.visible)];
    if (!targets.length) return [];
    const byKey = new Map(targets.map((c) => [c.key, c]));
    const rays = targets.map((c) => {
      c.mesh.updateMatrixWorld();
      const inv = c.mesh.matrixWorld.clone().invert();
      const o = r.origin.clone().applyMatrix4(inv), d = r.direction.clone().applyMatrix3(new THREE.Matrix3().setFromMatrix4(inv));
      return { id: c.key, o: o.toArray(), d: d.toArray() };
    });
    const res = await ask({ type: 'ray', rays });
    return res.hits.map((h) => {
      const c = byKey.get(h.id);
      const p = new THREE.Vector3(...h.p).applyMatrix4(c.mesh.matrixWorld);
      return { ...h, c, rest: h.id[0] === 'r', p, dist: p.distanceTo(r.origin) };
    }).sort((a, b) => a.dist - b.dist);
  }
  renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', async (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    for (const hit of await hitsAlong(ray.ray.clone())) {
      if (clip[0] && clip[0].distanceToPoint(hit.p) < 0) continue;
      if (!hit.rest && hit.c.state[hit.v * 4 + 3] !== VISIBLE) continue;
      if (hit.rest) { onPickRest?.(hit.db); return; }
      const id = dbToId.get(hit.db);
      if (id) { onPick?.(id); return; }
    }
  });
  // Box (world) of a rest part, from the picking worker.
  async function restBox(db) {
    const ri = restDb.get(db), r = rest[ri];
    if (!r?.sent) return null;
    const m = await ask({ type: 'box', id: r.key, db });
    if (!m.min) return null;
    r.mesh.updateMatrixWorld();
    return new THREE.Box3(new THREE.Vector3(...m.min), new THREE.Vector3(...m.max)).applyMatrix4(r.mesh.matrixWorld);
  }

  // ---------- deck levels from the deck plating (same method as the APS viewer) ----------
  let levels = null;
  function deckLevels() {
    if (levels) return levels;
    // Preferred: deck levels computed in the export from the horizontal geometry of the hull structure.
    if (manifest.deck_levels?.length) return (levels = manifest.deck_levels);
    const hs = [];
    for (const [id, el] of elementsById) {
      if (!['130', '150'].includes(el.group) || el.type !== 'plate') continue;
      const box = partBox.get(idToDb.get(id));
      if (!box) continue;
      const s = box.getSize(new THREE.Vector3());
      const [, b, c] = [s.x, s.y, s.z].sort((p, q) => p - q);
      if (s.y < 3 * 25.4 && b * c > 400 * 645) hs.push((box.min.y + box.max.y) / 2);
    }
    const bins = new Map();
    for (const h of hs) { const k = Math.round(h / 305); bins.set(k, (bins.get(k) || []).concat(h)); }
    const min = Math.max(8, hs.length * 0.04);
    const peaks = [...bins].filter(([, v]) => v.length >= min).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [k, v] of peaks) { const last = merged.at(-1); if (last && k - last.k <= 2) { last.v.push(...v); last.k = k; } else merged.push({ k, v: [...v] }); }
    const avg = (v) => v.reduce((s, x) => s + x, 0) / v.length;
    const base0 = merged.length ? Math.min(...merged.map((g) => avg(g.v))) : 0;
    levels = merged.map((g, i) => ({ id: i, height: avg(g.v), plates: g.v.length, name: `Deck level ${i + 1} (+${((avg(g.v) - base0) / 1000).toFixed(1)} m, ${g.v.length} deck plates)` }));
    return levels;
  }

  return {
    kind: 'local',
    stats,
    get frames() { return frames; },
    load,
    build(norm, r) {
      idToDb = new Map(norm.elements.filter((e) => e.objectid != null).map((e) => [e.id, e.objectid]));
      dbToId = new Map([...idToDb].map(([id, db]) => [db, id]));
      elementsById = new Map(norm.elements.map((e) => [e.id, { group: e.props?.swbs_group?.value ?? null, type: e.type }]));
      context = new Set(norm.elements.filter((e) => CONTEXT_GROUPS.has(e.props?.swbs_group?.value) && e.objectid != null).map((e) => e.id));
      results = r;
      override = null; filterDbs = null; selectedId = null; focusOnly = false; levels = null;
      recomputeAll();
      frameHull();
    },
    update(r, ids) {
      results = r;
      if (!ids) { recomputeAll(); return; }
      for (const id of ids) { const db = idToDb.get(id); if (db != null) writePart(db); }
      flush();
    },
    paintNeutral() {
      for (const ch of chunks) if (ch) for (let i = 0; i < ch.state.length; i += 4) { ch.state[i] = 184; ch.state[i + 1] = 191; ch.state[i + 2] = 201; }
      flush();
    },
    // Component view: only the part, framed tightly; outline and label as overlays.
    select(id, { fly = true, label = null, status = null } = {}) {
      selectedId = id;
      selectedRest = null;
      const db = idToDb.get(id), box = db != null ? partBox.get(db) : null;
      if (!box && restDb.has(db)) {
        // Part without a rule, in the full model: outline and label (no isolation: it is part of the grey rest).
        restBox(db).then((b) => { if (selectedId !== id || !b) return; if (fly) fitBox(b, 0.8); showOutline(b); showLabel(b, label, status); });
        showOutline(null); showLabel(null);
        return;
      }
      if (fly && box) { focusOnly = true; recomputeAll(); fitBox(box, 0.8); }
      showOutline(box);
      showLabel(box, label, status);
    },
    setLabel(id, label, status) { if (id === selectedId) showLabel(partBox.get(idToDb.get(id)), label, status); },
    clearSelection() { const had = selectedId != null || selectedRest != null; selectedId = null; selectedRest = null; focusOnly = false; showOutline(null); showLabel(null); return had; },
    // A clicked rest part (not checked by any rule): outline and label only.
    async selectRest(db, { label = null } = {}) {
      selectedId = null; selectedRest = db;
      if (focusOnly) { focusOnly = false; recomputeAll(); }
      const box = await restBox(db);
      if (selectedRest !== db) return;
      showOutline(box);
      showLabel(box, label, 'none');
    },
    setFullModel(on) { fullModel = !!on; recomputeAll(); },
    get fullModel() { return fullModel; },
    get hasRest() { return restInfos.length > 0; },
    flyToElement(id) { this.select(id); },
    setFilter(set) {
      filterDbs = set ? new Set([...set].map((id) => idToDb.get(id)).filter((d) => d != null)) : null;
      if (!override && selectedId == null) recomputeAll();
      else { updateRest(); invalidate(); }
    },
    highlight(statusById) {
      override = new Map(Object.entries(statusById));
      this.clearSelection();
      recomputeAll();
      fitBox(unionOf([...override.keys()].map((id) => idToDb.get(id)).filter((d) => d != null)), 0.8);
    },
    clearHighlight() { if (!override) return; override = null; recomputeAll(); },
    setSimple(on) { simple = !!on; this.clearSelection(); recomputeAll(); frameHull(); },
    get simple() { return simple; },
    deckLevels,
    setDeckCut(levelId) {
      const lv = levelId == null || levelId === '' ? null : deckLevels().find((l) => String(l.id) === String(levelId));
      clip.length = 0;
      if (lv) {
        clip.push(new THREE.Plane(new THREE.Vector3(0, -1, 0), lv.height + HEADROOM_MM));
        const box = unionOf(hullDbs());
        const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
        controls.target.copy(c);
        camera.position.set(c.x, c.y + Math.max(size.x, size.z) * 1.2, c.z + 1);
        camera.near = 50; camera.far = 1e6;
        camera.updateProjectionMatrix();
        controls.update();
      }
      mats.opaque.needsUpdate = true; mats.ghost.needsUpdate = true; mats.rest.needsUpdate = true;
      invalidate();
      return lv;
    },
    overview() { this.clearSelection(); recomputeAll(); frameHull(); },
    setMode(m) { mode = m; },
    setPlan() {},
    screenshot() { renderer.render(scene, camera); afterRender(); return Promise.resolve(renderer.domElement.toDataURL('image/png')); },
    get mode() { return mode; },
    get plan() { return false; },
  };
}
