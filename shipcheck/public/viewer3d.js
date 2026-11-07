// 3D / plan view of a normalised ship model (Three.js, served from node_modules: works offline).
// Model x (forward) -> scene X, model y (port +) -> scene -Z, elevation -> scene Y. Scene unit: metre.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fitPerspectiveBox, viewportAspect } from './src/view-framing.mjs';

export const STATUS_HEX = { compliant: 0x2e9e5b, non_compliant: 0xd64545, not_enough_info: 0xd99a1e, null: 0x9aa3ad };
const M = 0.001;
const EXPLODE_GAP_M = 5;

export function createViewer(container, { onPick } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf3f5f8);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.1);
  sun.position.set(30, 60, 40);
  scene.add(sun);

  const persp = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
  const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 2000);
  ortho.up.set(0, 0, -1); // plan view: bow to the right, port up
  const controlsP = new OrbitControls(persp, renderer.domElement);
  const controlsO = new OrbitControls(ortho, renderer.domElement);
  controlsO.enableRotate = false;
  controlsO.screenSpacePanning = true;
  controlsO.enabled = false;
  for (const c of [controlsP, controlsO]) { c.enableDamping = true; c.dampingFactor = 0.12; }

  let camera = persp, controls = controlsP, plan = false;
  let model = null, results = null;
  let root = new THREE.Group();
  scene.add(root);
  const deckGroups = {}, meshes = {}, deckIndex = {};
  let mode = 'all', selectedId = null, filterIds = null, flight = null;
  let framedBox = null, viewportWidth = 0, viewportHeight = 0;
  const selBox = new THREE.Box3Helper(new THREE.Box3(), 0x1f6feb);
  selBox.visible = false;
  scene.add(selBox);

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
    if (changed && framedBox) frameBox(framedBox);
  }
  new ResizeObserver(resize).observe(container);

  function fitOrtho(span) {
    const half = Math.max(span ?? ortho.userData.span ?? 40, 0.01) / 2;
    ortho.userData.span = half * 2;
    const a = viewportAspect(container.clientWidth, container.clientHeight, persp.aspect);
    ortho.left = -half * a; ortho.right = half * a; ortho.top = half; ortho.bottom = -half;
    ortho.updateProjectionMatrix();
  }

  function deckOffset(deckId) {
    return mode === 'exploded' ? (deckIndex[deckId] ?? 0) * EXPLODE_GAP_M : 0;
  }

  function shapeOf(outline) {
    const s = new THREE.Shape();
    outline.forEach(([x, y], i) => (i ? s.lineTo(x * M, y * M) : s.moveTo(x * M, y * M)));
    return s;
  }

  function build(m, r) {
    scene.remove(root);
    root = new THREE.Group();
    scene.add(root);
    for (const k of Object.keys(meshes)) delete meshes[k];
    for (const k of Object.keys(deckGroups)) delete deckGroups[k];
    model = m; results = r; selectedId = null; selBox.visible = false;
    model.decks.forEach((d, i) => (deckIndex[d.id] = i));

    // Hull shell (translucent), from baseline to the reference deck.
    const hd = model.hull && model.decks.find((d) => d.id === model.hull.deck);
    if (hd) {
      const geo = new THREE.ExtrudeGeometry(shapeOf(hd.outline_mm), { depth: hd.elevation_mm * M, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const shell = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x6b7f99, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false }));
      shell.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 30), new THREE.LineBasicMaterial({ color: 0x40536b, transparent: true, opacity: 0.35 })));
      shell.userData.hull = true;
      root.add(shell);
    }

    for (const d of model.decks) {
      const g = new THREE.Group();
      g.userData.deck = d.id;
      g.position.y = d.elevation_mm * M;
      if (d.outline_mm.length > 2) {
        const geo = new THREE.ShapeGeometry(shapeOf(d.outline_mm));
        geo.rotateX(-Math.PI / 2);
        const plate = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xd9dee5, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
        plate.position.y = -0.01;
        g.add(plate);
        const pts = [...d.outline_mm, d.outline_mm[0]].map(([x, y]) => new THREE.Vector3(x * M, 0, -y * M));
        g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0x334155 })));
      }
      deckGroups[d.id] = g;
      root.add(g);
    }

    for (const el of model.elements) {
      const gm = el.geom_mm;
      if (!gm || !deckGroups[el.deck]) continue;
      const geo = new THREE.BoxGeometry(Math.max(gm.lx, 30) * M, Math.max(gm.h, 30) * M, Math.max(gm.ly, 30) * M);
      let obj;
      if (el.virtual) {
        obj = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineDashedMaterial({ color: 0x9aa3ad, dashSize: 0.4, gapSize: 0.25 }));
        obj.computeLineDistances();
      } else {
        const translucent = el.type === 'space' || el.type === 'machinery_space';
        obj = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x9aa3ad, transparent: true, opacity: translucent ? 0.32 : 0.95, depthWrite: !translucent }));
        obj.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0x334155, transparent: true, opacity: 0.3 })));
        obj.userData.baseOpacity = obj.material.opacity;
      }
      obj.position.set((gm.x + gm.lx / 2) * M, (gm.z + gm.h / 2) * M, -(gm.y + gm.ly / 2) * M);
      obj.userData.id = el.id;
      obj.userData.virtual = !!el.virtual;
      deckGroups[el.deck].add(obj);
      meshes[el.id] = obj;
    }
    applyMode();
    update(r);
    overview();
  }

  function colorFor(id) {
    return STATUS_HEX[results?.elements[id]?.worst ?? null];
  }

  function update(r, ids) {
    results = r;
    for (const id of ids || Object.keys(meshes)) {
      const o = meshes[id];
      if (o) o.material.color.setHex(colorFor(id));
    }
    applyFilter();
  }

  // Temporarily paint everything grey (used by the demo "running check" animation).
  function paintNeutral() {
    for (const o of Object.values(meshes)) o.material.color.setHex(STATUS_HEX.null);
  }

  function applyFilter() {
    for (const [id, o] of Object.entries(meshes)) {
      if (o.userData.virtual) continue;
      const dim = filterIds && !filterIds.has(id);
      o.material.opacity = dim ? 0.08 : o.userData.baseOpacity;
      o.material.depthWrite = !dim && o.userData.baseOpacity > 0.5;
    }
  }

  function applyMode() {
    for (const [id, g] of Object.entries(deckGroups)) {
      const d = model.decks[deckIndex[id]];
      g.position.y = d.elevation_mm * M + deckOffset(id);
      const on = mode === 'all' || mode === 'exploded' || mode === id;
      g.visible = on;
    }
    root.children.forEach((c) => { if (c.userData.hull) c.visible = mode === 'all'; });
    if (selectedId) select(selectedId, { fly: false });
  }

  function bounds(objs) {
    const box = new THREE.Box3();
    for (const o of objs) box.expandByObject(o);
    return box;
  }

  function overview(ms = 0) {
    // Include the visible hull shell down to the baseline, as well as decks and elements.
    const visible = root.children.filter((g) => g.visible);
    const box = bounds(visible.length ? visible : [root]);
    if (box.isEmpty()) return;
    return frameBox(box, ms);
  }

  function currentDirection() {
    const direction = persp.position.clone().sub(controlsP.target);
    return direction.lengthSq() > 1e-12 ? direction : new THREE.Vector3(-0.3, 0.6, 1);
  }

  function frameBox(box, ms = 0) {
    framedBox = box.clone();
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const aspect = viewportAspect(container.clientWidth, container.clientHeight, persp.aspect);
    if (plan) {
      cancelFlight();
      resetDamping(controlsO);
      controlsO.target.copy(c);
      const distance = Math.max(s.y / 2 + 1, 10);
      ortho.position.set(c.x, c.y + distance, c.z);
      ortho.lookAt(c);
      ortho.near = Math.max(0.001, (distance - s.y / 2) / 2);
      ortho.far = distance + s.y / 2 + 10;
      fitOrtho(Math.max(s.z, s.x / aspect, 0.1) * 1.1);
      controlsO.update();
      return Promise.resolve();
    }
    const frame = fitPerspectiveBox(box, {
      aspect, fov: persp.getEffectiveFOV(), direction: currentDirection(), up: persp.up, margin: 1.1,
    });
    persp.aspect = frame.aspect;
    // Keep the previous camera position renderable during a flight; tighten at its endpoint.
    persp.near = ms ? Math.min(persp.near, frame.near) : frame.near;
    persp.far = ms ? Math.max(persp.far, frame.far) : frame.far;
    persp.updateProjectionMatrix();
    return flyTo(new THREE.Vector3(...frame.target), new THREE.Vector3(...frame.position), ms, () => {
      persp.near = frame.near; persp.far = frame.far; persp.updateProjectionMatrix();
    });
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

  for (const control of [controlsP, controlsO]) control.addEventListener('start', cancelFlight);

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

  function flyToElement(id, ms = 1100) {
    const o = meshes[id];
    if (!o) return Promise.resolve();
    o.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(o).expandByScalar(0.08);
    return frameBox(box, ms);
  }

  function select(id, { fly = true } = {}) {
    selectedId = id;
    const o = meshes[id];
    for (const m of Object.values(meshes)) m.material.emissive?.setHex(0x000000);
    if (!o) { selBox.visible = false; label.style.display = 'none'; return; }
    o.material.emissive?.setHex(0x2a2a2a);
    o.updateWorldMatrix(true, false);
    selBox.box.setFromObject(o).expandByScalar(0.08);
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

  function setFilter(ids) { filterIds = ids; applyFilter(); }

  // Picking: prefer real elements over virtual escape zones.
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  ray.params.Line.threshold = 0.15;
  function pickAt(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const objs = Object.values(meshes).filter((o) => o.parent.visible);
    const hits = ray.intersectObjects(objs, false).filter((h) => h.object.userData.id);
    return (hits.find((h) => !h.object.userData.virtual) || hits[0])?.object.userData.id;
  }
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]));
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const id = pickAt(e);
    if (id) onPick?.(id);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (e.buttons) { tip.style.display = 'none'; return; }
    const id = pickAt(e);
    const el = id && model.elements.find((x) => x.id === id);
    if (!el) { tip.style.display = 'none'; return; }
    const r = container.getBoundingClientRect();
    tip.textContent = `${el.id} · ${el.name}`;
    tip.style.display = 'block';
    tip.style.left = `${e.clientX - r.left + 12}px`;
    tip.style.top = `${e.clientY - r.top + 12}px`;
  });

  function updateLabel() {
    const o = selectedId && meshes[selectedId];
    if (!o || !o.parent.visible) { label.style.display = 'none'; return; }
    const p = new THREE.Vector3();
    o.getWorldPosition(p);
    p.y += (o.geometry.parameters?.height ?? 1) / 2 + 0.3;
    p.project(camera);
    if (p.z < -1 || p.z > 1 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1) { label.style.display = 'none'; return; }
    const st = results?.elements[selectedId]?.worst;
    label.className = `scene-label st-${st ?? 'none'}`;
    label.textContent = `${selectedId} · ${({ compliant: 'Compliant', non_compliant: 'Non-compliant', not_enough_info: 'Not enough info' })[st] ?? 'No rule'}`;
    label.style.display = 'block';
    label.style.left = `${((p.x + 1) / 2) * container.clientWidth}px`;
    label.style.top = `${((1 - p.y) / 2) * container.clientHeight}px`;
  }

  renderer.setAnimationLoop((now) => {
    if (!container.offsetParent) return; // hidden (the real model is shown): do not draw frames
    // A pane can be rebuilt while hidden, before ResizeObserver delivers its visible size.
    if (container.clientWidth !== viewportWidth || container.clientHeight !== viewportHeight) resize();
    if (flight) flight.update(now);
    controls.update();
    if (selectedId && meshes[selectedId]) selBox.box.setFromObject(meshes[selectedId]).expandByScalar(0.08);
    updateLabel();
    renderer.render(scene, camera);
  });
  resize();

  return { build, update, paintNeutral, select, flyToElement, setMode, setPlan, setFilter, overview, get mode() { return mode; }, get plan() { return plan; } };
}
