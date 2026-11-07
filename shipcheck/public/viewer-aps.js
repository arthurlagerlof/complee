// Autodesk APS viewer for the real production model, with the same interface as viewer3d.js:
// build, update, paintNeutral, select, setMode, setPlan, setFilter, overview.
// Parts are coloured by their worst result: red = non-compliant, amber = not enough info,
// green = compliant; parts without a result are ghosted (dimmed). Clicking a finding isolates the part
// and fits the camera to it. The viewer script and token come from Autodesk; if either fails, the app
// switches to createFallbackViewer (screenshots + the locally computed findings list).

const VIEWER_BASE = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*';
const LOAD_TIMEOUT_MS = 90_000;
const COLORS = { non_compliant: [0.84, 0.27, 0.27], not_enough_info: [0.85, 0.6, 0.12], compliant: [0.18, 0.62, 0.36] };

function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000} s`)), ms))]);
}

function loadViewerScript() {
  if (window.Autodesk?.Viewing) return Promise.resolve();
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = `${VIEWER_BASE}/style.min.css`;
  document.head.appendChild(css);
  return withTimeout(new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = `${VIEWER_BASE}/viewer3D.min.js`;
    s.onload = res;
    s.onerror = () => rej(new Error('Autodesk viewer script could not be loaded (offline?)'));
    document.head.appendChild(s);
  }), 20_000, 'Loading the Autodesk viewer script');
}

export async function createApsViewer(container, { onPick } = {}) {
  const status = await fetch('/api/aps/status', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ configured: false }));
  if (!status.configured) throw new Error(status.reason || 'APS is not configured on the server (3D_Since_AI/.env)');
  if (!status.urn) throw new Error('No model URN (3D_Since_AI/urn.txt)');
  await loadViewerScript();
  const AV = window.Autodesk.Viewing;
  const getAccessToken = async (cb) => {
    const r = await fetch('/api/aps/token', { cache: 'no-store' });
    if (!r.ok) throw new Error(`token: ${r.status}`);
    const t = await r.json();
    cb(t.access_token, t.expires_in);
  };
  await withTimeout(new Promise((res) => AV.Initializer({ env: 'AutodeskProduction2', api: 'streamingV2', getAccessToken }, res)), 20_000, 'Viewer initialisation');

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0';
  container.appendChild(host);
  const badge = document.createElement('div');
  badge.className = 'aps-status';
  container.appendChild(badge);
  badge.textContent = 'Starting the Autodesk APS viewer…';
  const viewer = new AV.GuiViewer3D(host);
  viewer.start();
  viewer.setGhosting(true);
  // Plain background: no environment map (its bright sky distracts from the colours).
  viewer.setEnvMapBackground?.(false);
  viewer.setGroundShadow?.(false);
  viewer.setGroundReflection?.(false);
  viewer.setBackgroundColor?.(243, 245, 248, 226, 231, 238);
  window.apsViewer = viewer; // for the browser console

  let loaded = null;
  let idToDb = new Map(), dbToId = new Map(), results = null, checked = [];
  let mode = 'all';

  function load() {
    if (loaded) return loaded;
    badge.textContent = 'Loading the RCRV model from Autodesk APS…';
    loaded = withTimeout(new Promise((res, rej) => {
      AV.Document.load(`urn:${status.urn}`, (doc) => {
        const node = doc.getRoot().getDefaultGeometry();
        viewer.addEventListener(AV.GEOMETRY_LOADED_EVENT, () => res(), { once: true });
        viewer.loadDocumentNode(doc, node).catch(rej);
      }, (code, msg) => rej(new Error(`APS model load failed (${code}): ${msg}`)));
    }), LOAD_TIMEOUT_MS, 'Loading the APS model').then(() => { badge.textContent = 'Autodesk APS viewer · real RCRV model'; });
    return loaded;
  }

  // A click may hit a sub-object: walk up the instance tree to a checked part.
  viewer.addEventListener(AV.SELECTION_CHANGED_EVENT, (e) => {
    const db = e.dbIdArray?.[0];
    if (db == null) return;
    const tree = viewer.model?.getInstanceTree();
    let cur = db;
    for (let i = 0; i < 12 && cur != null && cur > 0; i++) {
      if (dbToId.has(cur)) { onPick?.(dbToId.get(cur)); return; }
      cur = tree?.getNodeParentId(cur);
    }
  });

  // fitToView frames a small part so tightly that the camera ends up inside the hull. Frame the part's
  // bounds enlarged (at least ~5 m across) so the surrounding structure gives context.
  function focus(db) {
    const m = viewer.model, tree = m?.getInstanceTree();
    if (!tree) return viewer.fitToView([db]);
    const T = window.THREE, box = new T.Box3(), fl = m.getFragmentList();
    tree.enumNodeFragments(db, (f) => { const b = new T.Box3(); fl.getWorldBounds(f, b); box.union(b); }, true);
    if (box.isEmpty()) return viewer.fitToView([db]);
    const c = box.getCenter(new T.Vector3()), s = box.getSize(new T.Vector3());
    const half = Math.max(s.x, s.y, s.z) * 1.5 + 100; // model unit: inch
    viewer.navigation.fitBounds(false, new T.Box3(c.clone().subScalar(half), c.clone().addScalar(half)));
  }

  const vec = (st) => { const c = COLORS[st]; return c ? new window.THREE.Vector4(c[0], c[1], c[2], 1) : null; };

  function paint(ids) {
    const m = viewer.model;
    if (!m || !results) return;
    for (const id of ids ?? idToDb.keys()) {
      const db = idToDb.get(id);
      const c = vec(results.elements[id]?.worst);
      if (db != null && c) viewer.setThemingColor(db, c, m, true);
    }
  }

  return {
    load,
    build(norm, r) {
      idToDb = new Map(norm.elements.filter((e) => e.objectid != null).map((e) => [e.id, e.objectid]));
      dbToId = new Map([...idToDb].map(([id, db]) => [db, id]));
      results = r;
      checked = [...idToDb].filter(([id]) => r.elements[id]?.worst).map(([, db]) => db);
      viewer.clearThemingColors(viewer.model);
      paint();
      viewer.isolate(checked);
      viewer.fitToView(checked);
    },
    update(r, ids) {
      results = r;
      if (!ids) viewer.clearThemingColors(viewer.model);
      paint(ids);
    },
    paintNeutral() { viewer.clearThemingColors(viewer.model); },
    select(id, { fly = true } = {}) {
      const db = idToDb.get(id);
      if (db == null) return;
      if (fly) {
        viewer.isolate([db]);
        focus(db);
      }
    },
    flyToElement(id) { this.select(id); },
    setFilter(set) {
      const dbs = set ? [...set].map((id) => idToDb.get(id)).filter((d) => d != null) : checked;
      viewer.isolate(dbs.length ? dbs : checked);
    },
    overview() { viewer.isolate(checked); viewer.fitToView(checked); },
    setMode(m) { mode = m; },
    setPlan() {},
    screenshot(w = 1280, h = 720) { return new Promise((res) => viewer.getScreenShot(w, h, (blobUrl) => res(blobUrl))); },
    get mode() { return mode; },
    get plan() { return false; },
  };
}

// Used when APS is unreachable: shows saved screenshots of the real model and says why.
// The findings list on the left still comes from the local deterministic check.
export function createFallbackViewer(container) {
  let images = [], reason = '', selected = null;
  function render() {
    container.innerHTML = `<div class="fb-head"><b>3D viewer offline</b>: ${reason ? `the Autodesk APS viewer could not be loaded (${reason.replace(/[<>&]/g, '')}).` : ''}
      The findings on the left are computed locally by the deterministic checker; the screenshots below show the same model.
      ${selected ? `<br>Selected: <b>${selected}</b>` : ''}</div>` +
      images.map((src) => `<figure><img src="/${src}" alt="RCRV model screenshot" onerror="this.closest('figure').remove()"><figcaption>${src.split('/').pop()}</figcaption></figure>`).join('');
  }
  return {
    setImages(list) { images = list; render(); },
    setReason(r) { reason = r; render(); },
    build() { render(); }, update() {}, paintNeutral() {},
    select(id) { selected = id; render(); }, flyToElement() {}, setFilter() {}, overview() {}, setMode() {}, setPlan() {},
    get mode() { return 'all'; }, get plan() { return false; },
  };
}
