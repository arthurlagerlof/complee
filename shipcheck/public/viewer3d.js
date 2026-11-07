// 3D / plan view of a normalised ship model (Three.js, served from node_modules: works offline).
// Model x (forward) -> scene X, model y (port +) -> scene -Z, elevation -> scene Y. Scene unit: metre.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

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
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h);
    persp.aspect = w / h;
    persp.updateProjectionMatrix();
    fitOrtho();
  }
  new ResizeObserver(resize).observe(container);

  function fitOrtho(span) {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    const half = (span ?? ortho.userData.span ?? 40) / 2;
    ortho.userData.span = half * 2;
    const a = w / h;
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
    const visible = Object.values(deckGroups).filter((g) => g.visible);
    const box = bounds(visible.length ? visible : [root]);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const span = Math.max(s.x, s.z, 8);
    if (plan) {
      controls.target.copy(c);
      ortho.position.set(c.x, c.y + 200, c.z);
      ortho.lookAt(c);
      fitOrtho(Math.max(s.z * 1.3, (s.x * 1.1) / (container.clientWidth / container.clientHeight || 1)));
    } else {
      // Fit the whole restored example using both viewport dimensions, including narrow panes.
      persp.aspect = (container.clientWidth || 1) / (container.clientHeight || 1);
      persp.updateProjectionMatrix();
      const vertical = THREE.MathUtils.degToRad(persp.fov / 2);
      const horizontal = Math.atan(Math.tan(vertical) * persp.aspect);
      const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 4);
      const distance = radius * 1.08 / Math.sin(Math.min(vertical, horizontal));
      const direction = new THREE.Vector3(-0.3, 0.6, 1).normalize();
      flyTo(c, c.clone().addScaledVector(direction, distance), ms);
    }
  }

  function flyTo(target, pos, ms = 900) {
    flight = null;
    if (plan) {
      controls.target.copy(target);
      ortho.position.set(target.x, target.y + 200, target.z);
      return Promise.resolve();
    }
    const t0 = performance.now(), fromT = controls.target.clone(), fromP = persp.position.clone();
    return new Promise((resolve) => {
      if (!ms) { controls.target.copy(target); persp.position.copy(pos); controls.update(); return resolve(); }
      flight = (now) => {
        const k = Math.min(1, (now - t0) / ms), e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
        controls.target.lerpVectors(fromT, target, e);
        persp.position.lerpVectors(fromP, pos, e);
        if (k >= 1) { flight = null; resolve(); }
      };
    });
  }

  function flyToElement(id, ms = 1100) {
    const o = meshes[id];
    if (!o) return Promise.resolve();
    o.updateWorldMatrix(true, false);
    const box = new THREE.Box3().setFromObject(o);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const d = Math.max(s.length() * 1.6, 9);
    if (plan) {
      fitOrtho(Math.max(d, 14));
      return flyTo(c, null);
    }
    return flyTo(c, new THREE.Vector3(c.x - d * 0.55, c.y + d * 0.6, c.z + d * 0.75), ms);
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
    if (p.z > 1) { label.style.display = 'none'; return; }
    const st = results?.elements[selectedId]?.worst;
    label.className = `scene-label st-${st ?? 'none'}`;
    label.textContent = `${selectedId} · ${({ compliant: 'Compliant', non_compliant: 'Non-compliant', not_enough_info: 'Not enough info' })[st] ?? 'No rule'}`;
    label.style.display = 'block';
    label.style.left = `${((p.x + 1) / 2) * container.clientWidth}px`;
    label.style.top = `${((1 - p.y) / 2) * container.clientHeight}px`;
  }

  renderer.setAnimationLoop((now) => {
    if (!container.offsetParent) return; // hidden (the real model is shown): do not draw frames
    if (flight) flight(now);
    controls.update();
    if (selectedId && meshes[selectedId]) selBox.box.setFromObject(meshes[selectedId]).expandByScalar(0.08);
    updateLabel();
    renderer.render(scene, camera);
  });
  resize();

  return { build, update, paintNeutral, select, flyToElement, setMode, setPlan, setFilter, overview, get mode() { return mode; }, get plan() { return plan; } };
}
