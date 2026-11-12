// 3D / plan view of a normalised ship model (Three.js, served from node_modules: works offline).
// Model x (forward) -> scene X, model y (port +) -> scene -Z, elevation -> scene Y. Scene unit: metre.
//
// Rooms are drawn as a floor with see-through walls and no ceiling, stairs as steps, the hull and deckhouse
// as a see-through shell lofted from the deck outlines. Colours: rule status where a rule applies, otherwise
// a pale tint by zone. Escape routes are an overlay (setEscape).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { fitPerspectiveBox, viewportAspect } from './src/view-framing.mjs';

export const STATUS_HEX = { compliant: 0x2e9e5b, non_compliant: 0xd64545, not_enough_info: 0xd99a1e, null: 0x9aa3ad };
// Elements no rule applies to: pale tint by zone or type, so the arrangement reads at a glance.
export const ZONE_HEX = {
  accommodation: 0xa9c4e6, lab: 0x9fd3cf, working: 0xc9d3a6, service: 0xc9b9e0, machinery: 0xe2b98f,
  tank: 0x7f9fc4, control: 0xf0d58a, circulation: 0xd5dae1, open_deck: 0xcfd6dc, passenger: 0xa9c4e6,
};
const TYPE_HEX = { muster_station: 0x12a150, liferaft: 0xf08a24, door: 0x7a6a55, ladder: 0x8b95a1, escape_trunk: 0x8b95a1, guard_rail: 0x6b7480, tank: 0x7f9fc4, fuel_tank: 0x9c8a6b, sludge_tank: 0x7b6f63 };
const BLOCKED_HEX = 0x5a1620;
const ROUTE_HEX = { primary: 0x0f9d58, secondary: 0x1f6feb, network: 0x0f9d58 };
const M = 0.001;
const EXPLODE_GAP_M = 6;
const ROOMS = new Set(['space', 'machinery_space']);
const LABELLED = new Set(['space', 'machinery_space', 'tank', 'fuel_tank', 'muster_station', 'liferaft']);
const VIEWS = { iso: [-0.55, 0.6, 1], top: [0, 1, 0.0001], side: [0, 0.12, 1], bow: [1, 0.25, 0.25], stern: [-1, 0.3, 0.3] };

function roomGeometry(lx, h, ly) {
  const t = Math.min(0.08, lx / 4, ly / 4);
  const wall = (sx, sz, x, z) => new THREE.BoxGeometry(sx, h, sz).translate(x, 0, z);
  return mergeGeometries([
    wall(lx, t, 0, -ly / 2 + t / 2), wall(lx, t, 0, ly / 2 - t / 2),
    wall(t, ly, -lx / 2 + t / 2, 0), wall(t, ly, lx / 2 - t / 2, 0),
  ]);
}

function stairGeometry(lx, h, ly) {
  const alongX = lx >= ly, run = alongX ? lx : ly, n = Math.max(4, Math.min(16, Math.round(h / 0.19)));
  const steps = [];
  for (let i = 0; i < n; i++) {
    const sh = ((i + 1) * h) / n, d = run / n, c = -run / 2 + d * (i + 0.5);
    const g = alongX ? new THREE.BoxGeometry(d, sh, ly) : new THREE.BoxGeometry(lx, sh, d);
    steps.push(g.translate(alongX ? c : 0, -h / 2 + sh / 2, alongX ? 0 : -c));
  }
  return mergeGeometries(steps);
}

function ladderGeometry(lx, h, ly) {
  const r = 0.04, w = Math.min(0.5, Math.max(lx, ly) * 0.6), parts = [];
  for (const s of [-1, 1]) parts.push(new THREE.BoxGeometry(r, h, r).translate((s * w) / 2, 0, 0));
  for (let y = -h / 2 + 0.3; y < h / 2; y += 0.3) parts.push(new THREE.BoxGeometry(w, r, r).translate(0, y, 0));
  return mergeGeometries(parts);
}

// Closed band between two outlines (model mm, [x, y]) at two heights (m).
function bandGeometry(a, za, b, zb) {
  const pos = [], n = a.length;
  const P = (p, z) => [p[0] * M, z, -p[1] * M];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    pos.push(...P(a[i], za), ...P(a[j], za), ...P(b[j], zb), ...P(a[i], za), ...P(b[j], zb), ...P(b[i], zb));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

export function createViewer(container, { onPick } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xeef2f6);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a97a8, 1.25));
  const sun = new THREE.DirectionalLight(0xffffff, 1.25);
  sun.position.set(-40, 80, 50);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  fill.position.set(50, 30, -60);
  scene.add(fill);

  const persp = new THREE.PerspectiveCamera(38, 1, 0.1, 4000);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000);
  ortho.up.set(0, 0, -1); // plan view: bow to the right, port up
  const controlsP = new OrbitControls(persp, renderer.domElement);
  const controlsO = new OrbitControls(ortho, renderer.domElement);
  controlsO.enableRotate = false;
  controlsO.screenSpacePanning = true;
  controlsO.enabled = false;
  for (const c of [controlsP, controlsO]) { c.enableDamping = true; c.dampingFactor = 0.14; c.zoomToCursor = true; c.zoomSpeed = 1.3; }
  controlsP.minDistance = 0.6;
  controlsP.maxDistance = 900;
  controlsP.maxPolarAngle = Math.PI * 0.93;
  controlsO.minZoom = 0.2; controlsO.maxZoom = 60;

  let camera = persp, controls = controlsP, plan = false;
  let model = null, results = null;
  let root = new THREE.Group();
  scene.add(root);
  const deckGroups = {}, meshes = {}, deckIndex = {}, elById = {};
  let mode = 'all', selectedId = null, filterIds = null, flight = null;
  let framedBox = null, framedMargin = 1.1, viewportWidth = 0, viewportHeight = 0;
  let labelsOn = true, shellOn = true, blocked = new Set();
  let escape = null, escapeGroup = null, runners = [];
  // Render on demand: a frame is drawn only after something changed (camera, size, a viewer call, a flight, the
  // escape runners). An idle view costs no GPU time, which matters for imported models with thousands of elements.
  let dirty = true, frames = 0;
  const invalidate = () => { dirty = true; };
  const lineMaterials = new Set();
  const selBox = new THREE.Box3Helper(new THREE.Box3(), 0x1f6feb);
  selBox.visible = false;
  scene.add(selBox);

  const labelLayer = document.createElement('div');
  labelLayer.className = 'room-labels';
  container.appendChild(labelLayer);
  let roomLabels = []; // { id, node, width }
  const label = document.createElement('div');
  label.className = 'scene-label';
  container.appendChild(label);
  const tip = document.createElement('div');
  tip.className = 'scene-tip';
  container.appendChild(tip);

  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    // A hidden scenario has no viewport yet. Preserve its last real projection until shown.
    if (!(w > 0 && h > 0)) return;
    const changed = w !== viewportWidth || h !== viewportHeight;
    viewportWidth = w; viewportHeight = h;
    renderer.setSize(w, h);
    persp.aspect = viewportAspect(w, h, persp.aspect);
    persp.updateProjectionMatrix();
    fitOrtho();
    for (const m of lineMaterials) m.resolution.set(w, h);
    if (changed && framedBox) frameBox(framedBox, 0, framedMargin);
    invalidate();
  }
  new ResizeObserver(resize).observe(container);

  function fitOrtho(span) {
    const half = Math.max(span ?? ortho.userData.span ?? 40, 0.01) / 2;
    ortho.userData.span = half * 2;
    const a = viewportAspect(container.clientWidth, container.clientHeight, persp.aspect);
    ortho.left = -half * a; ortho.right = half * a; ortho.top = half; ortho.bottom = -half;
    ortho.zoom = 1;
    ortho.updateProjectionMatrix();
  }

  const deckOffset = (deckId) => (mode === 'exploded' ? (deckIndex[deckId] ?? 0) * EXPLODE_GAP_M : 0);
  const deckY = (deckId) => (model.decks[deckIndex[deckId]]?.elevation_mm ?? 0) * M + deckOffset(deckId);
  const deckShown = (deckId) => mode === 'all' || mode === 'exploded' || mode === deckId;

  function shapeOf(outline) {
    const s = new THREE.Shape();
    outline.forEach(([x, y], i) => (i ? s.lineTo(x * M, y * M) : s.moveTo(x * M, y * M)));
    return s;
  }

  function shellMesh(geo, color, opacity) {
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, roughness: 0.6, metalness: 0.1 }));
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), new THREE.LineBasicMaterial({ color: 0x3b4d63, transparent: true, opacity: 0.28 })));
    mesh.userData.shell = true;
    mesh.renderOrder = 3;
    return mesh;
  }

  // Hull below the reference deck (lofted between deck outlines, narrowed to the keel) and one see-through
  // tier per deck above it.
  function buildShell() {
    const hullDeck = model.hull && model.decks.find((d) => d.id === model.hull.deck);
    if (!hullDeck) return;
    const decks = [...model.decks].filter((d) => d.outline_mm.length > 2).sort((a, b) => a.elevation_mm - b.elevation_mm);
    const lower = decks.filter((d) => d.elevation_mm <= hullDeck.elevation_mm);
    if (lower.length) {
      const first = lower[0];
      const xs = first.outline_mm.map((p) => p[0]), x0 = Math.min(...xs), x1 = Math.max(...xs), mid = (x0 + x1) / 2;
      const keel = first.outline_mm.map(([x, y]) => [mid + (x - mid) * 0.94, y * 0.42]);
      root.add(shellMesh(bandGeometry(keel, 0, first.outline_mm, first.elevation_mm * M), 0x2f4a6b, 0.2));
      for (let i = 0; i + 1 < lower.length; i++) {
        const a = lower[i], b = lower[i + 1];
        const same = a.outline_mm.length === b.outline_mm.length;
        root.add(shellMesh(bandGeometry(a.outline_mm, a.elevation_mm * M, same ? b.outline_mm : a.outline_mm, b.elevation_mm * M), 0x2f4a6b, 0.16));
      }
    }
    for (const d of decks) {
      if (d.elevation_mm <= hullDeck.elevation_mm) continue;
      const top = (d.elevation_mm + d.height_mm) * M;
      const tier = shellMesh(bandGeometry(d.outline_mm, d.elevation_mm * M, d.outline_mm, top), 0xf7f9fb, 0.2);
      root.add(tier);
    }
  }

  function elementObject(el) {
    const gm = el.geom_mm;
    const lx = Math.max(gm.lx, 30) * M, h = Math.max(gm.h, 30) * M, ly = Math.max(gm.ly, 30) * M;
    const box = new THREE.BoxGeometry(lx, h, ly);
    let obj;
    if (el.virtual) {
      obj = new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineDashedMaterial({ color: 0x9aa3ad, dashSize: 0.4, gapSize: 0.25 }));
      obj.computeLineDistances();
      obj.userData.mats = [];
    } else if (ROOMS.has(el.type) && el.props?.zone !== 'open_deck' && gm.h > 400) {
      // Floor (pick target, status colour) + see-through walls, no ceiling.
      const floor = new THREE.BoxGeometry(lx, 0.06, ly).translate(0, -h / 2 + 0.03, 0);
      obj = new THREE.Mesh(floor, new THREE.MeshStandardMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.96, roughness: 0.85 }));
      const walls = new THREE.Mesh(roomGeometry(lx, h, ly), new THREE.MeshStandardMaterial({ color: 0x9aa3ad, transparent: true, opacity: 0.26, depthWrite: false, side: THREE.DoubleSide, roughness: 0.9 }));
      walls.renderOrder = 2;
      obj.add(walls);
      obj.add(new THREE.LineSegments(new THREE.EdgesGeometry(box), new THREE.LineBasicMaterial({ color: 0x2c3a4d, transparent: true, opacity: 0.42 })));
      obj.userData.mats = [{ m: obj.material, base: 0.96 }, { m: walls.material, base: 0.26 }];
    } else {
      let geo = box, opacity = 0.97;
      if (el.type === 'stair' && gm.h > 600) geo = stairGeometry(lx, h, ly);
      else if (el.type === 'ladder') { geo = ladderGeometry(lx, h, ly); }
      else if (el.type === 'liferaft') geo = new THREE.CapsuleGeometry(Math.min(ly, h) / 2, Math.max(lx - Math.min(ly, h), 0.1), 6, 14).rotateZ(Math.PI / 2);
      else if (el.type === 'escape_trunk') opacity = 0.45;
      else if (/tank/.test(el.type)) opacity = 0.8;
      obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9aa3ad, transparent: opacity < 0.97, opacity, depthWrite: opacity > 0.5, roughness: 0.8 }));
      obj.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 20), new THREE.LineBasicMaterial({ color: 0x2c3a4d, transparent: true, opacity: 0.35 })));
      if (el.type === 'ladder') {
        // A slim ladder is hard to hit: an invisible box around it takes the click.
        const hit = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ visible: false }));
        obj.add(hit);
      }
      obj.userData.mats = [{ m: obj.material, base: opacity }];
    }
    obj.position.set((gm.x + gm.lx / 2) * M, (gm.z + gm.h / 2) * M, -(gm.y + gm.ly / 2) * M);
    obj.userData.id = el.id;
    obj.userData.virtual = !!el.virtual;
    obj.userData.size = [lx, h, ly];
    return obj;
  }

  function build(m, r) {
    scene.remove(root);
    root = new THREE.Group();
    scene.add(root);
    for (const k of Object.keys(meshes)) delete meshes[k];
    for (const k of Object.keys(deckGroups)) delete deckGroups[k];
    for (const k of Object.keys(elById)) delete elById[k];
    model = m; results = r; selectedId = null; selBox.visible = false;
    blocked = new Set(); escape = null; escapeGroup = null; runners = [];
    model.decks.forEach((d, i) => (deckIndex[d.id] = i));

    buildShell();

    for (const d of model.decks) {
      const g = new THREE.Group();
      g.userData.deck = d.id;
      g.position.y = d.elevation_mm * M;
      if (d.outline_mm.length > 2) {
        const geo = new THREE.ShapeGeometry(shapeOf(d.outline_mm));
        geo.rotateX(-Math.PI / 2);
        const plate = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xdfe4ea, transparent: true, opacity: 0.9, side: THREE.DoubleSide, roughness: 0.95 }));
        plate.position.y = -0.03;
        g.add(plate);
        const pts = [...d.outline_mm, d.outline_mm[0]].map(([x, y]) => new THREE.Vector3(x * M, 0, -y * M));
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x334155 })));
      }
      deckGroups[d.id] = g;
      root.add(g);
    }

    for (const el of model.elements) {
      elById[el.id] = el;
      if (!el.geom_mm || !deckGroups[el.deck]) continue;
      const obj = elementObject(el);
      deckGroups[el.deck].add(obj);
      meshes[el.id] = obj;
    }

    labelLayer.replaceChildren();
    roomLabels = [];
    for (const el of model.elements) {
      if (!meshes[el.id] || el.virtual || !LABELLED.has(el.type)) continue;
      const node = document.createElement('div');
      node.className = `room-label${el.type === 'muster_station' ? ' muster' : ''}`;
      node.textContent = el.type === 'muster_station' ? `▲ ${el.name}` : el.name;
      labelLayer.appendChild(node);
      roomLabels.push({ id: el.id, node, chars: node.textContent.length, always: el.type === 'muster_station' });
    }
    applyMode();
    update(r);
    overview();
  }

  function colorFor(id) {
    if (blocked.has(id)) return BLOCKED_HEX;
    // Escape plan: rooms by route status, everything else neutral (rule colours would mix two meanings).
    if (escape?.tint?.[id] != null) return escape.tint[id];
    const st = escape?.plan ? null : results?.elements[id]?.worst ?? null;
    if (st) return STATUS_HEX[st];
    const el = elById[id];
    return TYPE_HEX[el?.type] ?? ZONE_HEX[el?.props?.zone] ?? STATUS_HEX.null;
  }

  function paint(o, hex) {
    if (!o.userData.mats?.length) { o.material.color?.setHex(hex); return; }
    for (const { m } of o.userData.mats) m.color.setHex(hex);
  }

  function update(r, ids) {
    results = r;
    for (const id of ids || Object.keys(meshes)) {
      const o = meshes[id];
      if (o) paint(o, colorFor(id));
    }
    applyFilter();
  }

  // Temporarily paint everything grey (used by the demo "running check" animation).
  function paintNeutral() {
    for (const o of Object.values(meshes)) paint(o, STATUS_HEX.null);
  }

  function applyFilter() {
    for (const [id, o] of Object.entries(meshes)) {
      if (o.userData.virtual) continue;
      const dim = filterIds && !filterIds.has(id);
      for (const { m, base } of o.userData.mats) {
        m.opacity = dim ? base * 0.1 : base;
        m.transparent = dim || base < 0.97;
        m.depthWrite = !dim && base > 0.5;
        m.needsUpdate = true;
      }
    }
  }

  function applyMode() {
    for (const [id, g] of Object.entries(deckGroups)) {
      g.position.y = deckY(id);
      g.visible = deckShown(id);
    }
    root.children.forEach((c) => { if (c.userData.shell) c.visible = shellOn && mode === 'all'; });
    drawEscape();
    if (selectedId) select(selectedId, { fly: false });
  }

  function bounds(objs) {
    const box = new THREE.Box3();
    for (const o of objs) box.expandByObject(o);
    return box;
  }

  function overview(ms = 0, direction = null) {
    // Include the visible hull shell down to the baseline, as well as decks and elements.
    const visible = root.children.filter((g) => g.visible && !g.userData.overlay);
    const box = bounds(visible.length ? visible : [root]);
    if (box.isEmpty()) return;
    return frameBox(box, ms, 1.1, direction);
  }

  function currentDirection() {
    const direction = persp.position.clone().sub(controlsP.target);
    return direction.lengthSq() > 1e-12 ? direction : new THREE.Vector3(...VIEWS.iso);
  }

  // margin: 1.1 for the deck overview; 2.6 for one element, so its neighbours (corridor, stair, doors) stay in view.
  // direction: view direction (target -> camera); default keeps the current one.
  function frameBox(box, ms = 0, margin = 1.1, direction = null) {
    framedBox = box.clone();
    framedMargin = margin;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const aspect = viewportAspect(container.clientWidth, container.clientHeight, persp.aspect);
    if (plan) {
      cancelFlight();
      resetDamping(controlsO);
      controlsO.target.copy(c);
      const distance = Math.max(s.y / 2 + 1, 10) + 60;
      ortho.position.set(c.x, c.y + distance, c.z);
      ortho.lookAt(c);
      ortho.near = 0.5;
      ortho.far = distance + s.y / 2 + 200;
      fitOrtho(Math.max(s.z, s.x / aspect, 0.1) * margin);
      controlsO.update();
      return Promise.resolve();
    }
    const frame = fitPerspectiveBox(box, {
      aspect, fov: persp.getEffectiveFOV(), direction: direction ?? currentDirection(), up: persp.up, margin,
    });
    persp.aspect = frame.aspect;
    persp.updateProjectionMatrix();
    return flyTo(new THREE.Vector3(...frame.target), new THREE.Vector3(...frame.position), ms);
  }

  // OrbitControls r160 has no public damping reset. With damping disabled one update
  // consumes/clears the pending deltas. Restore the intended transform only AFTER that.
  function resetDamping(control) {
    const damping = control.enableDamping, autoRotate = control.autoRotate;
    control.enableDamping = false; control.autoRotate = false;
    try { control.update(); } finally { control.enableDamping = damping; control.autoRotate = autoRotate; }
  }

  function cancelFlight() {
    const previous = flight;
    flight = null;
    previous?.cancel();
  }

  for (const control of [controlsP, controlsO]) {
    control.addEventListener('start', () => { cancelFlight(); framedBox = null; });
    control.addEventListener('change', invalidate);
  }

  function flyTo(target, pos, ms = 900, done = () => {}) {
    cancelFlight();
    const t0 = performance.now(), fromT = controls.target.clone(), fromP = persp.position.clone();
    resetDamping(controlsP);
    controlsP.target.copy(fromT); persp.position.copy(fromP);
    return new Promise((resolve) => {
      if (!ms) { controlsP.target.copy(target); persp.position.copy(pos); controlsP.update(); done(); return resolve(); }
      flight = { cancel: resolve, update(now) {
        const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        controlsP.target.lerpVectors(fromT, target, e);
        persp.position.lerpVectors(fromP, pos, e);
        if (k >= 1) { flight = null; done(); resolve(); }
      } };
    });
  }

  function boxOf(o) {
    o.updateWorldMatrix(true, false);
    const [lx, h, ly] = o.userData.size ?? [1, 1, 1];
    const c = o.getWorldPosition(new THREE.Vector3());
    return new THREE.Box3(new THREE.Vector3(c.x - lx / 2, c.y - h / 2, c.z - ly / 2), new THREE.Vector3(c.x + lx / 2, c.y + h / 2, c.z + ly / 2));
  }

  function flyToElement(id, ms = 1100) {
    const o = meshes[id];
    if (!o) return Promise.resolve();
    // One element on a deck: look down at it from above at an angle, so other elements on the same deck
    // (corridors, walls) cannot stand between the camera and the element.
    return frameBox(boxOf(o).expandByScalar(0.08), ms, 2.6, new THREE.Vector3(-0.35, 1, 0.55));
  }

  function select(id, { fly = true } = {}) {
    selectedId = id;
    const o = meshes[id];
    for (const m of Object.values(meshes)) for (const { m: mat } of m.userData.mats ?? []) mat.emissive?.setHex(0x000000);
    if (!o) { selBox.visible = false; label.style.display = 'none'; return; }
    for (const { m: mat } of o.userData.mats ?? []) mat.emissive?.setHex(0x26303c);
    selBox.box.copy(boxOf(o).expandByScalar(0.08));
    selBox.visible = o.parent.visible;
    if (fly) flyToElement(id);
  }

  function setMode(m) {
    mode = m;
    applyMode();
    overview();
  }

  function setPlan(on) {
    cancelFlight();
    plan = on;
    camera = on ? ortho : persp;
    controlsP.enabled = !on;
    controlsO.enabled = on;
    controls = on ? controlsO : controlsP;
    overview();
  }

  function setView(name) {
    if (plan) setPlan(false);
    return overview(700, new THREE.Vector3(...(VIEWS[name] ?? VIEWS.iso)));
  }

  function setFilter(ids) { filterIds = ids; applyFilter(); }
  function setLabels(on) { labelsOn = on; }
  function setShell(on) { shellOn = on; root.children.forEach((c) => { if (c.userData.shell) c.visible = shellOn && mode === 'all'; }); }

  // ---------- escape-route overlay ----------

  const scenePoint = (p) => new THREE.Vector3(p.x * M, p.z * M + deckOffset(p.deck) + 0.22, -p.y * M);

  function fatMaterial(color, width, { dashed = false, opacity = 1 } = {}) {
    const m = new LineMaterial({ color, linewidth: width, dashed, dashSize: 0.7, gapSize: 0.45, transparent: true, opacity, depthTest: false });
    m.resolution.set(Math.max(viewportWidth, 1), Math.max(viewportHeight, 1));
    lineMaterials.add(m);
    return m;
  }

  // Runs of consecutive points whose decks are on screen.
  function visibleRuns(points) {
    const runs = [];
    let run = [];
    for (let i = 0; i < points.length; i++) {
      if (deckShown(points[i].deck)) run.push(points[i]);
      else { if (run.length > 1) runs.push(run); run = []; }
    }
    if (run.length > 1) runs.push(run);
    return runs;
  }

  function drawEscape() {
    if (escapeGroup) {
      root.remove(escapeGroup);
      escapeGroup.traverse((o) => { o.geometry?.dispose?.(); if (o.material?.isLineMaterial) { lineMaterials.delete(o.material); o.material.dispose(); } });
    }
    escapeGroup = null; runners = [];
    if (!escape || !model) return;
    escapeGroup = new THREE.Group();
    escapeGroup.userData.overlay = true;
    escapeGroup.renderOrder = 10;
    root.add(escapeGroup);

    if (escape.network?.length) {
      const seen = new Set(), pos = [];
      for (const points of escape.network) for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i], b = points[i + 1];
        if (!deckShown(a.deck) || !deckShown(b.deck)) continue;
        const k = `${a.x}|${a.y}|${a.z}>${b.x}|${b.y}|${b.z}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const p = scenePoint(a), q = scenePoint(b);
        pos.push(p.x, p.y, p.z, q.x, q.y, q.z);
      }
      if (pos.length) {
        const net = new LineSegments2(new LineSegmentsGeometry().setPositions(pos), fatMaterial(ROUTE_HEX.network, 2.4, { opacity: 0.6 }));
        net.renderOrder = 10;
        escapeGroup.add(net);
      }
    }

    for (const route of escape.routes ?? []) {
      const color = ROUTE_HEX[route.kind] ?? ROUTE_HEX.primary;
      for (const run of visibleRuns(route.points)) {
        const pts = run.map(scenePoint);
        const halo = new Line2(new LineGeometry().setPositions(pts.flatMap((p) => [p.x, p.y, p.z])), fatMaterial(0xffffff, route.kind === 'primary' ? 9 : 7, { opacity: 0.9 }));
        halo.renderOrder = 11;
        escapeGroup.add(halo);
        const line = new Line2(new LineGeometry().setPositions(pts.flatMap((p) => [p.x, p.y, p.z])), fatMaterial(color, route.kind === 'primary' ? 5 : 3.5, { dashed: route.kind !== 'primary' }));
        line.computeLineDistances();
        line.renderOrder = 12;
        escapeGroup.add(line);
        // Direction arrows along the route.
        const cone = new THREE.ConeGeometry(0.24, 0.6, 12).rotateX(Math.PI / 2);
        const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
        let next = 1.6, walked = 0; // distance along the whole run of the next arrow / of the segment start
        for (let i = 0; i + 1 < pts.length; i++) {
          const len = pts[i].distanceTo(pts[i + 1]);
          for (; next < walked + len; next += 3.4) {
            const arrow = new THREE.Mesh(cone, mat);
            arrow.position.lerpVectors(pts[i], pts[i + 1], (next - walked) / len);
            arrow.lookAt(pts[i + 1]);
            arrow.renderOrder = 13;
            escapeGroup.add(arrow);
          }
          walked += len;
        }
        if (route.kind === 'primary') {
          const cum = [0];
          for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
          const dot = new THREE.SphereGeometry(0.2, 12, 10), dmat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true });
          const count = Math.max(1, Math.min(8, Math.round(cum[cum.length - 1] / 9)));
          for (let k = 0; k < count; k++) {
            const mesh = new THREE.Mesh(dot, dmat);
            mesh.renderOrder = 14;
            escapeGroup.add(mesh);
            runners.push({ mesh, pts, cum, phase: k / count });
          }
        }
      }
      // Start marker.
      const start = route.points[0];
      if (route.kind === 'primary' && deckShown(start.deck)) {
        const pin = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), new THREE.MeshBasicMaterial({ color: 0x1d2430, depthTest: false, transparent: true }));
        pin.position.copy(scenePoint(start));
        pin.renderOrder = 14;
        escapeGroup.add(pin);
      }
    }
  }

  function moveRunners(now) {
    for (const r of runners) {
      const total = r.cum[r.cum.length - 1];
      if (!(total > 0)) continue;
      const d = (((now / 1000) * 4.2) / total + r.phase) % 1 * total;
      let i = 1;
      while (i < r.cum.length - 1 && r.cum[i] < d) i++;
      r.mesh.position.lerpVectors(r.pts[i - 1], r.pts[i], (d - r.cum[i - 1]) / Math.max(r.cum[i] - r.cum[i - 1], 1e-6));
    }
  }

  // escape: null or { network: [points[]], routes: [{ kind: 'primary' | 'secondary', points }], blocked: [ids] }
  function setEscape(next) {
    escape = next;
    blocked = new Set(next?.blocked ?? []);
    for (const [id, o] of Object.entries(meshes)) paint(o, colorFor(id));
    drawEscape();
  }

  // Frames a route (all its points on visible decks).
  function frameRoute(points, ms = 900) {
    const box = new THREE.Box3();
    for (const p of points) if (deckShown(p.deck)) box.expandByPoint(scenePoint(p));
    if (box.isEmpty()) return Promise.resolve();
    box.expandByScalar(1.5);
    return frameBox(box, ms, 1.25, plan ? null : new THREE.Vector3(-0.4, 1, 0.75));
  }

  // ---------- picking ----------

  // Prefer real elements over virtual escape zones.
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  ray.params.Line.threshold = 0.15;
  const idOf = (o) => { for (let n = o; n; n = n.parent) if (n.userData?.id) return n; return null; };
  function pickAt(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const objs = Object.values(meshes).filter((o) => o.parent.visible);
    const hits = ray.intersectObjects(objs, true).map((h) => idOf(h.object)).filter(Boolean);
    const real = hits.find((o) => !o.userData.virtual);
    return (real || hits[0])?.userData.id;
  }
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const id = pickAt(e);
    if (id) onPick?.(id);
  });
  renderer.domElement.addEventListener('dblclick', (e) => {
    const id = pickAt(e);
    if (id) flyToElement(id, 700); else overview(700);
  });
  renderer.domElement.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
  // Hover tooltip: at most one raycast per animation frame, however fast the pointer moves.
  let hoverEvent = null, hoverQueued = false;
  renderer.domElement.addEventListener('pointermove', (e) => {
    hoverEvent = e;
    if (hoverQueued) return;
    hoverQueued = true;
    requestAnimationFrame(() => { hoverQueued = false; if (hoverEvent) hover(hoverEvent); });
  });
  renderer.domElement.addEventListener('pointerleave', () => { hoverEvent = null; });
  function hover(e) {
    if (e.buttons || !model) { tip.style.display = 'none'; return; }
    const id = pickAt(e);
    const el = id && elById[id];
    renderer.domElement.style.cursor = el ? 'pointer' : '';
    if (!el) { tip.style.display = 'none'; return; }
    const r = container.getBoundingClientRect();
    const g = el.geom_mm;
    tip.textContent = `${el.id} · ${el.name} · ${(g.lx / 1000).toFixed(1)} × ${(g.ly / 1000).toFixed(1)} m`;
    tip.style.display = 'block';
    tip.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 260)}px`;
    tip.style.top = `${e.clientY - r.top + 14}px`;
  }

  const projected = new THREE.Vector3(), corner = new THREE.Vector3();
  function updateLabel() {
    const o = selectedId && meshes[selectedId];
    if (!o || !o.parent.visible) { label.style.display = 'none'; return; }
    o.getWorldPosition(projected);
    projected.y += (o.userData.size?.[1] ?? 1) / 2 + 0.3;
    projected.project(camera);
    if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1) { label.style.display = 'none'; return; }
    const st = results?.elements[selectedId]?.worst;
    label.className = `scene-label st-${st ?? 'none'}`;
    label.textContent = `${selectedId} · ${({ compliant: 'Compliant', non_compliant: 'Non-compliant', not_enough_info: 'Not enough info' })[st] ?? 'No rule'}`;
    label.style.display = 'block';
    label.style.left = `${((projected.x + 1) / 2) * container.clientWidth}px`;
    label.style.top = `${((1 - projected.y) / 2) * container.clientHeight}px`;
  }

  // Room names appear once the room is wide enough on screen to carry its name.
  function updateRoomLabels() {
    const w = container.clientWidth, h = container.clientHeight;
    for (const L of roomLabels) {
      const o = meshes[L.id];
      let show = labelsOn && o?.parent.visible && !(filterIds && !filterIds.has(L.id));
      if (show) {
        o.getWorldPosition(projected);
        const [lx, hh] = o.userData.size;
        projected.y += -hh / 2 + 0.1;
        corner.copy(projected); corner.x += lx / 2;
        projected.project(camera); corner.project(camera);
        const px = Math.abs(corner.x - projected.x) * w; // full room length on screen
        show = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1.02 && Math.abs(projected.y) < 1.02 && (L.always || px > L.chars * 5.2 + 10);
        if (show) {
          L.node.style.left = `${((projected.x + 1) / 2) * w}px`;
          L.node.style.top = `${((1 - projected.y) / 2) * h}px`;
        }
      }
      L.node.style.display = show ? 'block' : 'none';
    }
  }

  renderer.setAnimationLoop((now) => {
    if (!container.offsetParent) return; // hidden (the real model is shown): do not draw frames
    // A pane can be rebuilt while hidden, before ResizeObserver delivers its visible size.
    if (container.clientWidth !== viewportWidth || container.clientHeight !== viewportHeight) resize();
    if (flight) { flight.update(now); dirty = true; }
    if (controls.update()) dirty = true; // damping still moving the camera
    if (runners.length) dirty = true;
    if (!dirty) return;
    dirty = false;
    frames++;
    if (!plan) {
      // Clip planes follow the zoom, so the model stays on screen from the whole ship down to one door.
      const d = persp.position.distanceTo(controlsP.target);
      const near = Math.max(0.05, d * 0.02), far = Math.max(600, d * 12);
      if (Math.abs(near - persp.near) > near * 0.05 || Math.abs(far - persp.far) > 1) { persp.near = near; persp.far = far; persp.updateProjectionMatrix(); }
    }
    if (selectedId && meshes[selectedId]) selBox.box.copy(boxOf(meshes[selectedId]).expandByScalar(0.08));
    if (runners.length) moveRunners(now);
    updateLabel();
    if (model) updateRoomLabels();
    renderer.render(scene, camera);
  });
  resize();

  // Every call that changes what is shown requests a frame (and again when a returned promise settles).
  const redraws = (fn) => (...args) => {
    const out = fn(...args);
    invalidate();
    if (out && typeof out.then === 'function') out.then(invalidate, invalidate);
    return out;
  };
  const api = { build, update, paintNeutral, select, flyToElement, setMode, setPlan, setFilter, overview, setEscape, frameRoute, setLabels, setShell, setView };
  for (const key of Object.keys(api)) api[key] = redraws(api[key]);
  // Live getters (Object.assign would copy their current values instead).
  return Object.defineProperties(api, Object.getOwnPropertyDescriptors({
    get mode() { return mode; }, get plan() { return plan; }, get labels() { return labelsOn; }, get shell() { return shellOn; },
    get frames() { return frames; },
  }));
}
