// Simple components shown inside the real RCRV model (scenario elements with geom3d, see ships/rcrv/inside.json).
// Each element is drawn as a few clean solid shapes at its real position (model/stream manifest frame, mm):
//   corridor   -> floor slab with crisp edges          door       -> frame + door leaf
//   stair      -> solid steps                          guard_rail -> posts + top and mid rail
// The status colour goes on the part that carries the checked value (floor, leaf, steps, rail).
import * as THREE from 'three';

const srgb = (c) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

export function createSceneOverlay(parent, COLORS) {
  const group = new THREE.Group();
  group.name = 'scenario-scene';
  parent.add(group);
  const items = new Map(); // id -> { group, coloured: Mesh[], all: Mesh[], box: Box3, el }
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x1d2430, transparent: true, opacity: 0.45 });
  const frameMaterial = new THREE.MeshLambertMaterial({ color: srgb([0.42, 0.46, 0.52]) });

  function add(item, w, h, d, x, y, z, { coloured = true, edges = true, material = null } = {}) {
    const geo = new THREE.BoxGeometry(Math.max(w, 1), Math.max(h, 1), Math.max(d, 1));
    const mat = material || new THREE.MeshLambertMaterial({ color: srgb(COLORS.none) });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.userData.sceneId = item.id;
    item.group.add(mesh);
    item.all.push(mesh);
    if (coloured) item.coloured.push(mesh);
    if (edges) {
      const line = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), edgeMaterial);
      line.position.copy(mesh.position);
      line.raycast = () => {};
      item.group.add(line);
    }
    return mesh;
  }

  function shapes(item) {
    const { min, max } = item.el.geom3d;
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, lx = x1 - x0, lz = z1 - z0, h = y1 - y0;
    switch (item.el.type) {
      case 'corridor': {
        // Floor slab on top of the real floor build-up (~250 mm above the deck plating), across the clear width.
        const fy = y0 + 250;
        add(item, lx, 80, lz, cx, fy + 40, cz);
        // Thin kerbs marking the clear width (neutral) and the clear passage as a light volume in the status colour.
        for (const z of [z0 + 15, z1 - 15]) add(item, lx, 60, 30, cx, fy + 110, z, { coloured: false, edges: false, material: frameMaterial });
        const volume = add(item, lx, 1300, lz, cx, fy + 80 + 650, cz, { edges: false, material: new THREE.MeshLambertMaterial({ color: srgb(COLORS.none), transparent: true, opacity: 0.22, depthWrite: false }) });
        volume.userData.volume = true;
        break;
      }
      case 'door': {
        const t = lx, post = 70;
        add(item, t, h, post, cx, y0 + h / 2, z0 + post / 2, { coloured: false, material: frameMaterial });
        add(item, t, h, post, cx, y0 + h / 2, z1 - post / 2, { coloured: false, material: frameMaterial });
        add(item, t, post, lz, cx, y1 - post / 2, cz, { coloured: false, material: frameMaterial });
        const sill = Math.min(600, h / 3);
        add(item, t, sill, lz - 2 * post, cx, y0 + sill / 2, cz, { coloured: false, material: frameMaterial });
        add(item, t * 0.5, h - sill - post, lz - 2 * post, cx, y0 + sill + (h - sill - post) / 2, cz); // leaf
        break;
      }
      case 'stair': {
        // Solid steps; geom3d.rise '+x' climbs towards max x, otherwise towards min x.
        const n = Math.max(3, Math.round(h / 190)), rise = h / n, tread = lx / n, up = item.el.geom3d.rise === '+x';
        for (let i = 0; i < n; i++) {
          const top = y0 + (i + 1) * rise, x = up ? x0 + (i + 0.5) * tread : x1 - (i + 0.5) * tread;
          add(item, tread, top - y0, lz, x, y0 + (top - y0) / 2, cz);
        }
        break;
      }
      case 'guard_rail': {
        const along = lx >= lz, len = along ? lx : lz, n = Math.max(2, Math.round(len / 1000) + 1), post = 45;
        for (let i = 0; i < n; i++) {
          const s = -len / 2 + (i * len) / (n - 1);
          add(item, post, h, post, along ? cx + s : cx, y0 + h / 2, along ? cz : cz + s, { edges: false });
        }
        for (const y of [y1 - 25, y0 + h * 0.5]) add(item, along ? len : 50, 50, along ? 50 : len, cx, y, cz, { edges: false });
        break;
      }
      default:
        add(item, lx, h, lz, cx, y0 + h / 2, cz);
    }
  }

  return {
    group,
    build(elements) {
      this.clear();
      for (const el of elements) {
        if (!el.geom3d) continue;
        const item = { id: el.id, el, group: new THREE.Group(), coloured: [], all: [],
          box: new THREE.Box3(new THREE.Vector3(...el.geom3d.min), new THREE.Vector3(...el.geom3d.max)) };
        shapes(item);
        group.add(item.group);
        items.set(el.id, item);
      }
    },
    clear() {
      for (const item of items.values()) {
        item.group.traverse((o) => { o.geometry?.dispose?.(); if (o.material && o.material !== frameMaterial && o.material !== edgeMaterial) o.material.dispose?.(); });
        group.remove(item.group);
      }
      items.clear();
    },
    get size() { return items.size; },
    has(id) { return items.has(id); },
    ids() { return [...items.keys()]; },
    setStatus(id, key) {
      const item = items.get(id);
      if (!item) return;
      const c = srgb(COLORS[key] || COLORS.none);
      for (const m of item.coloured) m.material.color.copy(c);
    },
    // Component view: the selected element at full strength, the others faded.
    focus(id) {
      for (const item of items.values()) {
        const dim = id != null && item.id !== id;
        for (const m of item.all) {
          if (m.material === frameMaterial) continue;
          const base = m.userData.volume ? 0.22 : 1;
          m.material.transparent = dim || base < 1;
          m.material.opacity = dim ? base * 0.25 : base;
          m.material.depthWrite = !dim && base === 1;
        }
      }
    },
    box(id) { return items.get(id)?.box.clone() || null; },
    bounds(ids = null) {
      const b = new THREE.Box3();
      for (const item of items.values()) if (!ids || ids.includes(item.id)) b.union(item.box);
      return b;
    },
    pick(raycaster) {
      const hit = raycaster.intersectObjects(group.children, true).find((h) => h.object.userData.sceneId != null);
      return hit ? hit.object.userData.sceneId : null;
    },
  };
}
