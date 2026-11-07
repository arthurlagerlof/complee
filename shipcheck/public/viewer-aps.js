// Autodesk APS viewer for the real production model, with the same interface as viewer3d.js
// (build, update, paintNeutral, select, setMode, setPlan, setFilter, overview) plus the component views:
//   setSimple(on)        context (shell SWBS 110 + decks SWBS 130) + checked parts only, rest hidden
//   deckLevels()/setDeckCut(level)   section cut above one deck (Autodesk.Section), looked at like a plan
//   select(id, {label})  isolate + frame one part (rest ghosted), box outline + 3D label as overlays
//   highlight(statusById) / clearHighlight()   rule view: the parts one rule applies to, coloured by that rule
//
// The model itself is never changed: parts are only isolated, hidden, ghosted, coloured, cut and framed.
// Labels and outlines are overlays on top (HTML label, overlay-scene lines from the part's bounding box).
// If the viewer script or token cannot be loaded, the app uses createFallbackViewer instead.

const VIEWER_BASE = 'https://developer.api.autodesk.com/modelderivative/v2/viewers/7.*';
const LOAD_TIMEOUT_MS = 180_000; // the full RCRV model can take 1-2 min on a cold cache
const COLORS = { non_compliant: [0.84, 0.27, 0.27], not_enough_info: [0.85, 0.6, 0.12], compliant: [0.18, 0.62, 0.36], context: [0.86, 0.88, 0.91] };
const CONTEXT_GROUPS = new Set(['110', '130']); // shell plating, hull decks (ESWBS)
const HEADROOM_IN = 90; // deck cut: keep 90 in (2.3 m) above the deck plating
const OVERLAY = 'shipcheck-outline';

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
  const status = await fetch('api/aps/status', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ configured: false }));
  if (!status.configured) throw new Error(status.reason || 'APS is not configured on the server (3D_Since_AI/.env)');
  if (!status.urn) throw new Error('No model URN (3D_Since_AI/urn.txt)');
  await loadViewerScript();
  const AV = window.Autodesk.Viewing;
  const getAccessToken = async (cb) => {
    const r = await fetch('api/aps/token', { cache: 'no-store' });
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
  const labelEl = document.createElement('div');
  labelEl.className = 'aps-label';
  labelEl.hidden = true;
  container.appendChild(labelEl);
  badge.textContent = 'Starting the Autodesk APS viewer…';
  const viewer = new AV.GuiViewer3D(host);
  viewer.start();
  // Light rendering for a 330,000-object model on a laptop GPU: no ghosting (it draws the whole ship
  // semi-transparent every frame), no ambient occlusion or antialiasing, simplified navigation rendering.
  viewer.setGhosting(false);
  viewer.setQualityLevel?.(false, false);
  viewer.setOptimizeNavigation?.(true);
  viewer.setProgressiveRendering?.(true);
  // Plain background: no environment map (its bright sky distracts from the colours).
  viewer.setEnvMapBackground?.(false);
  viewer.setGroundShadow?.(false);
  viewer.setGroundReflection?.(false);
  viewer.setBackgroundColor?.(243, 245, 248, 226, 231, 238);
  window.apsViewer = viewer; // for the browser console

  let loaded = null;
  let idToDb = new Map(), dbToId = new Map(), results = null, checked = [], context = new Set();
  let mode = 'all', simple = true, override = null, cut = null, selectedId = null, labelAnchor = null;

  // The viewer keeps a local model cache (OPFS "otg_cache"). In testing, every load that read from it stalled
  // (the viewer's cache writer fails with "truncate ... outside the range"), while a fresh download takes about
  // 30 s. So the cache is removed before each load: slower than a working cache, but never stuck.
  const FLAG = 'shipcheck.apsLoadPending';
  async function clearStaleCache() {
    const root = await navigator.storage?.getDirectory?.().catch(() => null);
    if (!root) return;
    await Promise.race([root.removeEntry('otg_cache', { recursive: true }).catch(() => null), new Promise((r) => setTimeout(r, 3000))]);
  }
  const setFlag = (on) => { try { on ? localStorage.setItem(FLAG, '1') : localStorage.removeItem(FLAG); } catch { /* ignore */ } };

  // Ready only when ALL geometry has arrived. Starting earlier (while ~300,000 fragments still stream in) made
  // the demo stutter and crash the browser. The badge shows the progress meanwhile. (Selective loading with the
  // `ids` option was tried: the loader accepts it, but this SVF2 model still streams nearly every fragment.)
  let onGeometryDone = null;
  function load() {
    if (loaded) return loaded;
    badge.textContent = 'Loading the RCRV model from Autodesk APS…';
    const progress = (e) => {
      const pct = Math.round(e.percent ?? 0);
      if (pct > 0 && pct < 100) badge.textContent = `Loading the RCRV model from Autodesk APS… ${pct} %`;
    };
    viewer.addEventListener(AV.PROGRESS_UPDATE_EVENT, progress);
    loaded = clearStaleCache().then(() => {
      setFlag(true);
      return withTimeout(new Promise((res, rej) => {
        AV.Document.load(`urn:${status.urn}`, (doc) => {
          const node = doc.getRoot().getDefaultGeometry();
          viewer.addEventListener(AV.GEOMETRY_LOADED_EVENT, () => res(), { once: true });
          viewer.loadDocumentNode(doc, node).catch(rej);
        }, (code, msg) => rej(new Error(`APS model load failed (${code}): ${msg}`)));
      }), LOAD_TIMEOUT_MS, 'Loading the APS model');
    }).then(async () => {
      viewer.removeEventListener(AV.PROGRESS_UPDATE_EVENT, progress);
      setFlag(false);
      onGeometryDone?.();
      badge.textContent = 'Autodesk APS viewer · real RCRV model';
      await viewer.loadExtension('Autodesk.Section').catch(() => null); // section tool in the toolbar; our deck cut uses its cut planes
    });
    return loaded;
  }

  // A click may hit a sub-object: walk up the instance tree to a checked part.
  viewer.addEventListener(AV.SELECTION_CHANGED_EVENT, (e) => {
    const db = e.dbIdArray?.[0];
    if (db == null) return;
    const tree = viewer.model?.getInstanceTree();
    let cur = db;
    for (let i = 0; i < 12 && cur != null && cur > 0; i++) {
      if (dbToId.has(cur)) { viewer.clearSelection(); onPick?.(dbToId.get(cur)); return; }
      cur = tree?.getNodeParentId(cur);
    }
  });
  viewer.addEventListener(AV.CAMERA_CHANGE_EVENT, () => placeLabel());

  const T = () => window.THREE;
  function boxOf(db) {
    const m = viewer.model, tree = m?.getInstanceTree();
    if (!tree) return null;
    const box = new (T().Box3)(), fl = m.getFragmentList();
    tree.enumNodeFragments(db, (f) => { const b = new (T().Box3)(); fl.getWorldBounds(f, b); box.union(b); }, true);
    return box.isEmpty() ? null : box;
  }

  // Component view: only the part is shown, so it can be framed tightly and fills most of the view.
  function focus(db) {
    const box = boxOf(db);
    if (!box) return viewer.fitToView([db]);
    const c = box.getCenter(new (T().Vector3)()), s = box.getSize(new (T().Vector3)());
    const half = Math.max(Math.max(s.x, s.y, s.z) * 0.75, 12); // model unit: inch; at least 2 ft across
    viewer.navigation.fitBounds(false, new (T().Box3)(c.clone().subScalar(half), c.clone().addScalar(half)));
  }

  // ---------- overlays: box outline and 3D label ----------
  function clearOutline() {
    if (viewer.impl.overlayScenes?.[OVERLAY]) viewer.impl.clearOverlay(OVERLAY);
    viewer.impl.invalidate(false, false, true);
  }
  function drawOutline(box) {
    clearOutline();
    if (!box) return;
    const TH = T(), a = box.min, b = box.max;
    const p = [[a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, b.y, a.z], [a.x, b.y, a.z], [a.x, a.y, b.z], [b.x, a.y, b.z], [b.x, b.y, b.z], [a.x, b.y, b.z]];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    const geom = new TH.Geometry();
    for (const [i, j] of edges) geom.vertices.push(new TH.Vector3(...p[i]), new TH.Vector3(...p[j]));
    const mat = new TH.LineBasicMaterial({ color: 0x1f6feb, linewidth: 2, depthTest: false, transparent: true });
    const lines = TH.LineSegments ? new TH.LineSegments(geom, mat) : new TH.Line(geom, mat, TH.LinePieces);
    if (!viewer.impl.overlayScenes?.[OVERLAY]) viewer.impl.createOverlayScene(OVERLAY);
    viewer.impl.addOverlay(OVERLAY, lines);
    viewer.impl.invalidate(false, false, true);
  }
  function placeLabel() {
    if (!labelAnchor || labelEl.hidden) return;
    const p = viewer.worldToClient(labelAnchor);
    const off = p.z > 1 || p.x < 0 || p.y < 0 || p.x > container.clientWidth || p.y > container.clientHeight;
    labelEl.style.visibility = off ? 'hidden' : 'visible';
    labelEl.style.left = `${p.x}px`;
    labelEl.style.top = `${p.y}px`;
  }
  function showLabel(box, html, statusClass) {
    if (!box || !html) { labelEl.hidden = true; labelAnchor = null; return; }
    const c = box.getCenter(new (T().Vector3)());
    labelAnchor = new (T().Vector3)(c.x, c.y, c.z);
    labelEl.className = `aps-label st-${statusClass || 'none'}`;
    labelEl.innerHTML = html;
    labelEl.hidden = false;
    placeLabel();
  }

  // ---------- colours and visibility ----------
  const vec = (st) => { const c = COLORS[st]; return c ? new (T().Vector4)(c[0], c[1], c[2], 1) : null; };

  function colourOf(id) {
    if (override) return override.get(id) ?? (context.has(id) ? 'context' : null);
    const st = results?.elements[id]?.worst;
    if (simple && context.has(id) && (st === 'compliant' || !st)) return 'context';
    return st ?? null;
  }
  function paint(ids) {
    const m = viewer.model;
    if (!m || !results) return;
    for (const id of ids ?? idToDb.keys()) {
      const db = idToDb.get(id), st = colourOf(id);
      const c = st && vec(st);
      if (db != null && c) viewer.setThemingColor(db, c, m, true);
    }
  }
  function repaint() { viewer.clearThemingColors(viewer.model); paint(); }
  // Isolation and colours are set by dbId; geometry that streams in later gets them re-applied in one pass.
  let lastIsolate = null, filterDbs = null;
  function isolate(dbs) { lastIsolate = dbs; viewer.isolate(dbs); }
  onGeometryDone = () => {
    levels = null;
    if (!results) return;
    repaint();
    if (lastIsolate) viewer.isolate(lastIsolate);
    viewer.impl.invalidate(true, true, true);
  };
  const hullDbs = () => [...context].map((id) => idToDb.get(id)).filter((d) => d != null);
  function visibleDbs() {
    // Rule view: the rule's parts on the light-grey hull, so their positions on the ship are readable.
    if (override) return [...new Set([...[...override.keys()].map((id) => idToDb.get(id)).filter((d) => d != null), ...hullDbs()])];
    const base = filterDbs?.length ? filterDbs : checked;
    if (simple) return [...new Set([...base, ...hullDbs()])];
    return base;
  }
  // Simple view (default): hull + checked parts, everything else hidden. Full model: checked parts with the
  // rest of the ship ghosted (heavier to draw). Rule view: always the light version.
  function applyVisibility(fit = false) {
    viewer.setGhosting(!simple && !override);
    const dbs = visibleDbs();
    isolate(dbs);
    // Frame the hull rather than every part: a few outfitting items far from the ship would zoom out too far.
    const hull = hullDbs();
    if (fit) viewer.fitToView(hull.length ? hull : dbs);
  }

  function setCut(level) {
    cut = level;
    if (level == null) { viewer.setCutPlanes([]); return; }
    const up = viewer.navigation.getWorldUpVector();
    viewer.setCutPlanes([new (T().Vector4)(up.x, up.y, up.z, -(level.height + HEADROOM_IN))]);
  }

  // Deck levels from the model geometry itself: flat plates (less than 3 in thick along the up axis) of the hull
  // decks (SWBS 130) and the deckhouse (SWBS 150), grouped by height in 12 in bins; well-filled bins are decks.
  // Nothing is assumed about drawing names.
  let levels = null;
  function deckLevels() {
    if (levels) return levels;
    const up = viewer.navigation.getWorldUpVector();
    const hs = [];
    for (const [id, el] of elementsById) {
      if (!['130', '150'].includes(el.group) || el.type !== 'plate' || !idToDb.has(id)) continue;
      const box = boxOf(idToDb.get(id));
      if (!box) continue;
      const size = box.getSize(new (T().Vector3)());
      const thick = Math.abs(size.dot(up));
      const [, b, c] = [size.x, size.y, size.z].sort((p, q) => p - q); // flat face of at least 400 in²
      if (thick < 3 && b * c > 400) hs.push(box.getCenter(new (T().Vector3)()).dot(up));
    }
    const bins = new Map();
    for (const h of hs) { const k = Math.round(h / 12); bins.set(k, (bins.get(k) || []).concat(h)); }
    const min = Math.max(8, hs.length * 0.04);
    const peaks = [...bins].filter(([, v]) => v.length >= min).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [k, v] of peaks) {
      const last = merged.at(-1);
      if (last && k - last.k <= 2) { last.v.push(...v); last.k = k; } else merged.push({ k, v: [...v] });
    }
    const base = merged.length ? Math.min(...merged.map((g) => g.v.reduce((s, x) => s + x, 0) / g.v.length)) : 0;
    levels = merged.map((g, i) => {
      const height = g.v.reduce((s, x) => s + x, 0) / g.v.length;
      return { id: i, height, plates: g.v.length, name: `Deck level ${i + 1} (+${((height - base) * 0.0254).toFixed(1)} m, ${g.v.length} deck plates)` };
    });
    return levels;
  }

  let elementsById = new Map();
  return {
    load,
    build(norm, r) {
      idToDb = new Map(norm.elements.filter((e) => e.objectid != null).map((e) => [e.id, e.objectid]));
      dbToId = new Map([...idToDb].map(([id, db]) => [db, id]));
      elementsById = new Map(norm.elements.map((e) => [e.id, { group: e.props?.swbs_group?.value ?? null, type: e.type }]));
      context = new Set(norm.elements.filter((e) => CONTEXT_GROUPS.has(e.props?.swbs_group?.value) && e.objectid != null).map((e) => e.id));
      results = r;
      checked = [...idToDb].filter(([id]) => r.elements[id]?.worst).map(([, db]) => db);
      levels = null;
      override = null;
      filterDbs = null;
      selectedId = null;
      repaint();
      applyVisibility(true);
    },
    update(r, ids) {
      results = r;
      if (!ids) repaint(); else paint(ids);
    },
    paintNeutral() { viewer.clearThemingColors(viewer.model); },
    // Component view: isolate + frame one part, the rest ghosted; outline and label as overlays.
    select(id, { fly = true, label = null, status = null } = {}) {
      selectedId = id;
      const db = idToDb.get(id);
      if (db == null) { clearOutline(); showLabel(null); return; }
      const box = boxOf(db);
      if (fly) {
        viewer.setGhosting(false);
        isolate([db]);
        focus(db);
      }
      drawOutline(box);
      showLabel(box, label, status);
    },
    setLabel(id, label, status) { if (id === selectedId) showLabel(boxOf(idToDb.get(id)), label, status); },
    clearSelection() { const had = selectedId != null; selectedId = null; clearOutline(); showLabel(null); return had; },
    flyToElement(id) { this.select(id); },
    // Findings-list filter: remembered, and applied only while no part is open in the component view
    // (otherwise every list refresh, e.g. after a what-if edit, would replace the isolated part).
    setFilter(set) {
      filterDbs = set ? [...set].map((id) => idToDb.get(id)).filter((d) => d != null) : null;
      if (!override && selectedId == null) applyVisibility();
    },
    // Rule view: only the parts a rule applies to, coloured by that rule's result.
    highlight(statusById) {
      override = new Map(Object.entries(statusById));
      this.clearSelection();
      repaint();
      applyVisibility(true);
    },
    clearHighlight() { if (!override) return; override = null; repaint(); applyVisibility(); },
    setSimple(on) { simple = !!on; this.clearSelection(); repaint(); applyVisibility(true); },
    get simple() { return simple; },
    deckLevels,
    setDeckCut(levelId) {
      const lv = levelId == null || levelId === '' ? null : deckLevels().find((l) => String(l.id) === String(levelId));
      setCut(lv);
      if (lv) viewer.getExtension('Autodesk.ViewCubeUi')?.setViewCube?.('top');
      return lv;
    },
    overview() { this.clearSelection(); applyVisibility(true); },
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
  let images = [], reason = '';
  const head = document.createElement('div');
  head.className = 'fb-head';
  const gallery = document.createElement('div');
  container.append(head, gallery);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let selected = '';
  function renderHead() {
    head.innerHTML = `<b>3D viewer offline</b>: ${reason ? `the Autodesk APS viewer could not be loaded (${esc(reason)}).` : ''}
      The findings on the left are computed locally by the deterministic checker; the screenshots below show the same model.
      ${selected ? `<br>${selected}` : ''}`;
  }
  // The gallery is only rebuilt when the image list changes, so selecting parts does not reload the images.
  function renderGallery() {
    gallery.innerHTML = images.map((src) => `<figure><img src="${src}" alt="RCRV model screenshot" onerror="this.closest('figure').remove()"><figcaption>${esc(src.split('/').pop())}</figcaption></figure>`).join('');
  }
  const noop = () => {};
  return {
    setImages(list) { if (JSON.stringify(list) !== JSON.stringify(images)) { images = list; renderGallery(); } renderHead(); },
    setReason(r) { reason = r; renderHead(); },
    build() { renderHead(); }, update: noop, paintNeutral: noop,
    select(id, { label } = {}) { selected = `Selected: <b>${esc(id)}</b>${label ? ` · ${label}` : ''}`; renderHead(); },
    setLabel(id, label) { if (selected) { selected = `Selected: <b>${esc(id)}</b>${label ? ` · ${label}` : ''}`; renderHead(); } },
    clearSelection() { selected = ''; renderHead(); },
    highlight(statusById) {
      const n = Object.keys(statusById).length;
      selected = `Rule view: ${n} part${n === 1 ? '' : 's'} listed on the right (3D highlight needs the APS viewer).`;
      renderHead();
    },
    clearHighlight() { selected = ''; renderHead(); },
    setSimple: noop, deckLevels: () => [], setDeckCut: () => null,
    flyToElement: noop, setFilter: noop, overview: noop, setMode: noop, setPlan: noop,
    get mode() { return 'all'; }, get plan() { return false; }, get simple() { return false; },
  };
}
