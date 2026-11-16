// Drawing → 3D: the engineer gives a general arrangement drawing (PDF, DXF or SVG); it is read, shown, corrected where
// needed, converted in a Web Worker (drawing-worker.js → src/drawing/convert.mjs) and added as a model that the
// viewer shows and the checker checks. The sheet preview covers the 3D view (#drawingPanel); the settings, the
// conversion steps and the report live in the right-hand panel (#detail), where the engineer reads everything else.
//
// app.js passes a small host object, so this module does not reach into the app's state:
//   host = { addScenario({ name, idHint, json, geometry, replace }) -> Promise<id|null>, results() -> S.results,
//            hasElement(id), select(id), download(name, text, type), closeOtherPanels() }
import { detectFormat, unsupportedMessage, readDrawingFile, lineWork, STAGES, STAGE_LABEL } from './src/drawing/convert.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, root = document) => root.querySelector(s);
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`);
const fmtM = (mm) => (Number.isFinite(mm) ? `${(mm / 1000).toFixed(2)} m` : '–');
const MB = (n) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
const LS_PREFIX = 'complee.drawing.v1:';
const UNIT_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8, pt: 25.4 / 72, px: 25.4 / 96 };
const KIND_COLOR = { profile: '#1f6feb', plan: '#2e9e5b', section: '#8b5cf6', title: '#9aa3ad', table: '#9aa3ad', other: '#9aa3ad', ignore: '#c4cad2' };
const ZONE_COLOR = {
  accommodation: '#5b9be6', lab: '#a78bfa', working: '#f59e0b', service: '#94a3b8', machinery: '#ef4444',
  control: '#10b981', tank: '#0ea5e9', open_deck: '#65a30d', circulation: '#fbbf24', passenger: '#f472b6',
  none: '#a8a29e', // a room without a zone (no label): grey, so it is seen but not mistaken for a zone
};
const STAGE_HINT = {
  read: 'Check that the file opens in a PDF viewer or CAD program, and export it again if not.',
  views: 'No separate drawings were told apart on the sheet. Check that this is the general arrangement page (profile and deck plans).',
  scale: 'Enter the drawing scale (1 : n) above and convert again.',
  decks: 'Mark the deck plans as "plan" with their deck names, enter the elevations above the baseline, and convert again.',
  rooms: 'Check the plan views: kind "plan" and the deck name. Views that are not plans can be set to "ignore".',
  doors: 'Check the plan views: kind "plan" and the deck name.',
  hull: 'Check that the profile view is marked "profile" and the bow direction is right.',
  mesh: 'This is a fault in the converter, not in the drawing. Please report it together with the drawing.',
};

let host = null;
let ui = null; // DOM and preview, made on first open
const st = {
  file: null, sheets: [], keys: [], page: 0, sheet: null,
  views: [], auto: null, overrides: blankOverrides(), result: null, scenarioId: null,
  overlay: false, busy: false, convertedAt: null, readError: null,
};

function blankOverrides() { return { views: {} }; }

// ---------- remembered corrections (per file name and page; the browser may refuse storage: then nothing is kept) ----------

function loadMemory(name) {
  try { return JSON.parse(localStorage.getItem(LS_PREFIX + name) || 'null') ?? { page: null, byPage: {} }; } catch { return { page: null, byPage: {} }; }
}
function saveMemory() {
  if (!st.file) return;
  try {
    const mem = loadMemory(st.file.name);
    mem.page = st.page;
    mem.byPage = { ...(mem.byPage ?? {}), [st.page + 1]: cleanOverrides(st.overrides) };
    localStorage.setItem(LS_PREFIX + st.file.name, JSON.stringify(mem));
  } catch { /* private mode or quota: the corrections live for this session only */ }
}

// Only what the engineer actually set goes to the converter: an empty field means "automatic".
function cleanOverrides(o) {
  const out = {};
  if (Number.isFinite(o.scale) && o.scale > 0) out.scale = o.scale;
  if (o.bow === 'left' || o.bow === 'right') out.bow = o.bow;
  if (o.shipName?.trim()) out.shipName = o.shipName.trim();
  const views = {};
  for (const [id, v] of Object.entries(o.views ?? {})) {
    const c = {};
    if (v.ignore) c.ignore = true;
    else if (v.kind) c.kind = v.kind;
    if (v.deckName?.trim()) c.deckName = v.deckName.trim();
    if (Number.isFinite(v.elevation)) c.elevation = v.elevation;
    if (Object.keys(c).length) views[id] = c;
  }
  if (Object.keys(views).length) out.views = views;
  return out;
}

// ---------- the worker: one at a time, one request at a time ----------

let worker = null, reqId = 0, pending = null;
const sentKeys = new Set(); // sheets the current worker already holds

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('./drawing-worker.js', import.meta.url), { type: 'module' });
    sentKeys.clear();
    worker.addEventListener('message', ({ data }) => {
      if (!pending || data?.id !== pending.id) return; // a reply to a request that was superseded
      if (data.type === 'progress') { pending.onProgress?.(data.stage, data.fraction); return; }
      const p = pending;
      pending = null;
      if (data.type === 'error') p.reject(Object.assign(new Error(data.message), { stage: data.stage, code: data.code, views: data.views }));
      else p.resolve(data);
    });
    // A module worker that fails to load reports only an "error" event, often without a message.
    worker.addEventListener('error', (e) => {
      e.preventDefault?.();
      const p = pending;
      pending = null;
      killWorker();
      p?.reject(new Error(`The converter could not start${e.message ? `: ${e.message}` : ' (one of its modules failed to load; see the browser console)'}.`));
    });
  }
  return worker;
}
function killWorker() { worker?.terminate(); worker = null; sentKeys.clear(); }
function callWorker(msg, transfer = [], onProgress) {
  pending?.reject(Object.assign(new Error('Superseded.'), { cancelled: true }));
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending = { id, resolve, reject, onProgress };
    try { getWorker().postMessage({ ...msg, id }, transfer); } catch (e) { pending = null; reject(e); }
  });
}
function cancelWorker() {
  const p = pending;
  pending = null;
  killWorker();
  p?.reject(Object.assign(new Error('Cancelled.'), { cancelled: true }));
}
// Convert or analyse the current sheet; the sheet itself is sent only when the worker does not hold it yet.
async function runOnSheet(mode, onProgress) {
  const overrides = cleanOverrides(st.overrides);
  const key = st.keys[st.page];
  const send = (withSheet) => callWorker(withSheet ? { key, sheet: st.sheet, overrides, mode } : { key, overrides, mode }, [], onProgress);
  const had = sentKeys.has(key);
  sentKeys.add(key);
  try {
    return await send(!had);
  } catch (e) {
    if (e.code !== 'missing') throw e;
    return send(true); // the worker dropped it (it keeps a few pages only)
  }
}

// ---------- pdf.js: loaded on first use, from the same server ----------

let pdfjsPromise = null;
function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const pdfjs = await import('./node_modules/pdfjs-dist/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;
    return pdfjs;
  })().catch((e) => {
    pdfjsPromise = null;
    throw new Error(`PDF reading is not available here: pdf.js could not be loaded (${e.message}). Give the drawing as DXF or SVG, or ask whoever runs this server to serve node_modules/pdfjs-dist.`);
  });
  return pdfjsPromise;
}

// ---------- open / close ----------

/** Opens the panel. With a file: reads it. Without: shows the current drawing, or the drop zone. */
export async function openDrawingImport(h, { file = null, pick = false } = {}) {
  host = h;
  ensureUi();
  host.closeOtherPanels?.();
  showPanel(true);
  ui.view.resize();
  if (file) return loadFile(file);
  if (!st.sheet && pick) ui.input.click();
  render();
}

// While the drawing is open the findings list on the left is folded away (body.dw-open): the sheet needs the width,
// and the list belongs to the 3D model, which the panel covers anyway. Closing restores it.
function showPanel(on) {
  ui.panel.hidden = !on;
  ui.btn?.classList.toggle('on', on);
  document.body.classList.toggle('dw-open', on);
}

export function closeDrawingImport() {
  if (!ui || ui.panel.hidden) return;
  showPanel(false);
  hideTip();
}

/** Shows the conversion report again in the right-hand panel (after the engineer looked at an element). */
export function showReport() {
  if (st.result) renderReport();
}

function ensureUi() {
  if (ui) return;
  const panel = document.getElementById('drawingPanel');
  panel.innerHTML = `
    <div class="trace-head dw-head">
      <b>Drawing → 3D</b><span class="muted" id="dwInfo"></span><span class="grow"></span>
      <button id="dwOverlayBtn" class="tiny" hidden title="Show what was recognised (rooms by zone, walls, doors, stairs) over the deck plans. Click an element to select it, double-click to see it in 3D.">Recognised</button>
      <button id="dwFormBtn" class="tiny" hidden title="Show the views table and the settings in the right-hand panel">Settings</button>
      <button id="dwReportBtn" class="tiny" hidden title="Show the conversion report in the right-hand panel">Report</button>
      <button id="dwFit" class="tiny" title="Fit the whole sheet in the window (F)">Fit</button>
      <button id="dwOpen" class="tiny" title="Open another drawing: PDF, DXF or SVG">Open drawing…</button>
      <button id="dwClose" class="tiny" title="Close the drawing and show the 3D model (Esc)" aria-label="Close">✕</button>
    </div>
    <div class="dw-body">
      <div class="dw-pages" id="dwPages" hidden></div>
      <div class="dw-stage" id="dwStage">
        <div class="dw-drop" id="dwDrop">
          <b>Drop a general arrangement drawing here</b>
          <span>PDF, DXF or SVG with the profile and the deck plans, as exported from the CAD program (vector line work; a scan cannot be measured).</span>
          <button id="dwPick" class="primary">Choose a file…</button>
        </div>
        <div class="dw-status" id="dwStatus" hidden></div>
        <div class="dw-legend" id="dwLegend" hidden></div>
        <div class="dw-tip" id="dwTip" hidden></div>
      </div>
    </div>`;
  ui = {
    panel, stage: $('#dwStage'), drop: $('#dwDrop'), status: $('#dwStatus'), pages: $('#dwPages'), tip: $('#dwTip'), legend: $('#dwLegend'),
    input: document.getElementById('drawingFile'), btn: document.getElementById('drawingBtn'),
  };
  ui.view = createSheetView(ui.stage, {
    onHover: (hit, x, y) => {
      if (hit) showTip(hit.tip, x, y); else hideTip();
      // The line work the hovered element was read from; without a hover, that of the selected one.
      if (st.overlay) ui.view.setEvidence(evidenceOf(hit?.item) ?? evidenceOf(st.picked));
    },
    onClick: (hit) => {
      if (!hit) return;
      if (hit.view) focusViewRow(hit.view);
      else if (hit.item) pickItem(hit.item, false);
    },
    onDblClick: (hit) => { if (hit?.item) pickItem(hit.item, true); },
  });
  $('#dwPick').addEventListener('click', () => ui.input.click());
  $('#dwOpen').addEventListener('click', () => ui.input.click());
  $('#dwClose').addEventListener('click', closeDrawingImport);
  $('#dwFit').addEventListener('click', () => ui.view.fit());
  $('#dwFormBtn').addEventListener('click', () => renderForm());
  $('#dwReportBtn').addEventListener('click', () => renderReport());
  $('#dwOverlayBtn').addEventListener('click', () => setOverlay(!st.overlay));
  // Drag and drop anywhere on the panel; the drop zone lights up while a file is over it.
  panel.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) { e.preventDefault(); panel.classList.add('dw-dragging'); } });
  panel.addEventListener('dragleave', (e) => { if (e.target === panel || !panel.contains(e.relatedTarget)) panel.classList.remove('dw-dragging'); });
  panel.addEventListener('drop', (e) => {
    e.preventDefault();
    panel.classList.remove('dw-dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
  // Report entries that name an element (geometry issues, measured values): select it in the 3D view. One listener
  // on the panel that outlives each report, so re-rendering the report does not add another.
  document.getElementById('detail').addEventListener('click', (e) => {
    const a = e.target.closest?.('a.dw-sel');
    if (!a) return;
    e.preventDefault();
    if (host.hasElement?.(a.dataset.id)) { closeDrawingImport(); host.select(a.dataset.id); }
    else alert(`${a.dataset.id} is not in the loaded model. Choose "Drawing: ${st.file?.name}" in the model list first.`);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || panel.hidden) return;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target?.tagName) && !panel.contains(e.target)) return; // Esc in a form field of the side panel
    closeDrawingImport();
  });
}

// ---------- a. reading the file ----------

async function loadFile(file) {
  if (st.busy) cancelWorker();
  ensureUi();
  showPanel(true);
  const sameFile = st.file?.name === file.name;
  Object.assign(st, {
    file: { name: file.name, size: file.size }, sheets: [], keys: [], page: 0, sheet: null, views: [], auto: null,
    result: sameFile ? st.result : null, scenarioId: sameFile ? st.scenarioId : null, overlay: false, readError: null, busy: true,
  });
  ui.view.setSheet(null);
  setOverlay(false); // no legend or recognised elements of the previous drawing
  ui.view.setItems(null);
  render();
  const label = `Reading ${file.name} (${MB(file.size)})…`;
  setStatus(label, 0);
  detailMessage(`<h1>Drawing → 3D</h1><p class="muted">${esc(label)}</p>`);
  try {
    if (!file.size) throw new Error(`${file.name} is empty.`);
    // Everything is read in this browser tab; a general arrangement is a few MB, a 200 MB file would only freeze it.
    if (file.size > 200e6) throw new Error(`${file.name} is ${MB(file.size)}: larger than 200 MB. Export only the general-arrangement sheet(s) as PDF or DXF.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const format = detectFormat(file.name, bytes);
    const message = unsupportedMessage(format, file.name);
    if (message) throw Object.assign(new Error(message), { code: format });
    let sheets, keys;
    if (format === 'pdf') {
      setStatus(`${label} Loading the PDF reader…`, null);
      const pdfjs = await loadPdfjs();
      sheets = await readDrawingFile({ name: file.name, bytes }, {
        pdfjs,
        onProgress: (a, b) => setStatus(label, progressFraction(a, b)),
      });
      keys = sheets.map((s, i) => `${file.name}#${s.source?.page ?? i + 1}`);
    } else {
      const r = await callWorker({ file: { name: file.name, bytes } }, [bytes.buffer], (_, f) => setStatus(label, f));
      sheets = r.sheets; keys = r.keys;
      keys.forEach((k) => sentKeys.add(k));
    }
    st.sheets = sheets; st.keys = keys;
    const mem = loadMemory(file.name);
    // Default page: the remembered one, else the one with the most line work (the GA, not the title or notes page).
    const work = sheets.map(lineWork);
    const best = work.indexOf(Math.max(...work));
    const remembered = Number.isInteger(mem.page) && mem.page < sheets.length ? mem.page : null;
    st.busy = false;
    await choosePage(remembered ?? best, { fromMemory: true });
  } catch (e) {
    st.busy = false;
    if (e.cancelled) return;
    st.readError = e;
    setStatus(null);
    render();
    detailMessage(`<h1>Drawing → 3D</h1><p class="check-bad"><b>Could not read ${esc(file.name)}.</b> ${esc(e.message)}</p>
      ${['raster', 'dwg', 'dxf-binary', 'unknown', 'xml'].includes(e.code) ? '' : `<p class="muted">${esc(STAGE_HINT.read)}</p>`}`);
  }
}

// pdf.js readers report progress in different shapes: a fraction, (done, total) or { page, pages }.
function progressFraction(a, b) {
  if (typeof a === 'number' && typeof b === 'number' && b > 0) return a / b;
  if (typeof a === 'number') return a;
  if (a && typeof a === 'object') return a.fraction ?? (a.of ? a.done / a.of : a.pages ? a.page / a.pages : null);
  return null;
}

async function choosePage(index, { fromMemory = false } = {}) {
  st.page = index;
  st.sheet = st.sheets[index];
  st.views = []; st.auto = null; st.analyseError = null;
  setOverlay(false);
  // A result of another page cannot be laid over this one (its report stays reachable by converting again).
  if (st.result && st.result.page !== index) st.result = null;
  const mem = loadMemory(st.file.name);
  st.overrides = { ...blankOverrides(), ...(mem.byPage?.[index + 1] ?? {}) };
  st.overrides.views ??= {};
  if (!fromMemory || st.sheets.length > 1) saveMemory();
  render();
  setStatus('Preparing the preview…', 0);
  await ui.view.setSheet(st.sheet, (f) => setStatus('Preparing the preview…', f));
  setStatus(null);
  renderForm();
  analyse();
}

// ---------- b. preview, views and settings ----------

// Views and the converter's own reading of the sheet (scale, decks): they prefill the form as "automatic" values.
async function analyse() {
  st.busy = true;
  renderFormState('Finding the views on the sheet…');
  setStatus('Finding views…', null);
  try {
    const r = await runOnSheet('analyse', (stage) => setStatus(`${STAGE_LABEL[stage] ?? 'Reading'}…`, null));
    st.views = r.views ?? [];
    st.auto = r;
    st.analyseError = null;
  } catch (e) {
    if (e.cancelled) return;
    st.views = e.views ?? st.views;
    st.analyseError = e;
  } finally {
    st.busy = false;
    setStatus(null);
  }
  ui.view.setViews(effectiveViews());
  renderForm();
}

function effectiveViews() {
  return st.views.map((v) => {
    const o = st.overrides.views?.[v.id] ?? {};
    return { ...v, kind: o.ignore ? 'ignore' : o.kind ?? v.kind, deckName: o.deckName ?? v.deckName, edited: !!(o.ignore || o.kind || o.deckName || Number.isFinite(o.elevation)) };
  });
}

function autoReport() { return st.result?.report ?? st.auto?.report ?? null; }
function autoElevation(view) {
  const rep = autoReport();
  const rv = rep?.views?.find?.((x) => x.id === view.id);
  if (Number.isFinite(rv?.elevation)) return rv.elevation;
  const name = norm(view.deckName);
  const recon = st.result?.recon ?? st.auto?.recon;
  const d = name && (recon?.decks ?? rep?.decks ?? []).find((x) => norm(x.name) === name);
  const e = num(d?.elevation); // a number or { value, basis, range }
  return Number.isFinite(e) ? e : null;
}
const norm = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]+/g, '');

function renderForm() {
  if (!st.sheet) return;
  const sh = st.sheet, rep = autoReport();
  const scale = rep?.scale;
  const detectedBow = st.views.find((v) => v.bow)?.bow;
  const o = st.overrides;
  const work = lineWork(sh);
  const effViews = effectiveViews();
  const sparse = work < 40 && sh.source?.format === 'pdf'; // a PDF page of a scan has only a frame or a few lines
  const host$ = document.getElementById('detail');
  host$.innerHTML = `
    <h1>Drawing → 3D</h1>
    <div class="muted">${esc(st.file.name)}${st.sheets.length > 1 ? ` · page ${st.page + 1} of ${st.sheets.length}` : ''} · ${esc(sh.source?.format?.toUpperCase() ?? '')}
      · unit ${esc(sh.unit ?? '?')}${sh.unitStated ? '' : ' (assumed)'} · ${work.toLocaleString('en')} line segments · ${(sh.texts?.length ?? 0).toLocaleString('en')} texts</div>
    ${sparse ? '<div class="note"><b>Almost no line work on this page.</b> It is probably a scanned image inside the PDF. The converter needs vector line work: export the drawing as PDF or DXF from the CAD program.</div>' : ''}
    ${(sh.warnings ?? []).slice(0, 5).map((w) => `<div class="note">${esc(w)}</div>`).join('')}
    <h2>Ship</h2>
    <table class="kv dw-globals">
      <tr><td><label for="dwScale">Drawing scale</label></td><td>1 : <input id="dwScale" type="number" min="1" step="any" inputmode="decimal" value="${Number.isFinite(o.scale) ? o.scale : ''}" placeholder="${scale?.value ? esc(scale.value) : 'automatic'}" title="Empty: the scale found on the drawing">
        ${scale?.source ? `<div class="muted">${Number.isFinite(o.scale) ? 'Found' : 'Automatic'}: ${scale.value ? `1:${esc(scale.value)} · ` : ''}${esc(scale.source)}</div>` : sh.paper ? '<div class="muted">Not found yet: a paper drawing (PDF/SVG) needs it to give real sizes.</div>' : ''}</td></tr>
      <tr><td><label for="dwBow">Bow points</label></td><td><select id="dwBow">
        <option value="">automatic${detectedBow ? ` (${esc(detectedBow)})` : ''}</option>
        <option value="right"${o.bow === 'right' ? ' selected' : ''}>right</option>
        <option value="left"${o.bow === 'left' ? ' selected' : ''}>left</option></select></td></tr>
      <tr><td><label for="dwShip">Ship name</label></td><td><input id="dwShip" type="text" value="${esc(o.shipName ?? '')}" placeholder="${esc((st.result?.model ?? st.auto?.model)?.name ?? 'from the title block')}"></td></tr>
    </table>
    <h2>Views on the sheet (${effViews.length})</h2>
    ${effViews.length ? `<div class="dw-views-wrap"><table class="register dw-views">
      <thead><tr><th>View</th><th>Kind</th><th>Deck</th><th title="Deck elevation above the baseline in mm. Empty: from the drawing (profile, deck lines, text) or assumed.">Elevation mm</th><th title="How sure the view finder is; hover a row for its evidence">Sure</th></tr></thead>
      <tbody>${effViews.map((v) => viewRow(v)).join('')}</tbody></table></div>`
      : `<p class="muted">${st.busy ? 'Finding the views…' : 'No views found yet.'}</p>`}
    <div class="dw-actions">
      <button id="dwConvert" class="primary" title="Convert the drawing to a 3D model and check it"${st.busy ? ' disabled' : ''}>${st.result ? 'Convert again' : 'Convert to 3D'}</button>
      <button id="dwReset" title="Forget the corrections on this page and use the automatic values"${Object.keys(cleanOverrides(o)).length ? '' : ' disabled'}>Reset</button>
      <button id="dwCancel" hidden title="Stop the conversion">Cancel</button>
    </div>
    <div id="dwFormMsg">${st.analyseError ? errorHTML(st.analyseError, 'The automatic reading stopped') : ''}</div>
    <ol class="dw-steps" id="dwSteps" hidden></ol>
    <p class="muted">Empty fields are automatic. Corrections are remembered for this file in this browser. Hover a view for the evidence; click its box on the sheet to find it here.</p>`;
  wireForm();
  ui.view.setViews(effViews);
  render();
}

function viewRow(v) {
  const o = st.overrides.views?.[v.id] ?? {};
  const kinds = ['profile', 'plan', 'section', 'ignore'];
  if (!kinds.includes(v.kind)) kinds.splice(3, 0, v.kind);
  const elevAuto = autoElevation(v);
  const why = (v.why ?? []).join('\n');
  return `<tr data-view="${esc(v.id)}" class="${v.kind === 'ignore' ? 'dw-ignored' : ''}" title="${esc(why || 'No evidence recorded')}">
    <td><i class="dw-swatch" style="background:${KIND_COLOR[v.kind] ?? KIND_COLOR.other}"></i>${esc(v.title || v.id)}</td>
    <td><select data-f="kind" aria-label="Kind of view ${esc(v.id)}">${kinds.map((k) => `<option value="${esc(k)}"${k === v.kind ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select></td>
    <td><input data-f="deckName" type="text" value="${esc(o.deckName ?? '')}" placeholder="${esc(st.views.find((x) => x.id === v.id)?.deckName ?? (v.kind === 'plan' ? 'deck name' : ''))}" aria-label="Deck of view ${esc(v.id)}"></td>
    <td><input data-f="elevation" type="number" step="1" value="${Number.isFinite(o.elevation) ? o.elevation : ''}" placeholder="${elevAuto != null ? Math.round(elevAuto) : v.kind === 'plan' ? 'auto' : ''}" aria-label="Elevation of view ${esc(v.id)} in mm"></td>
    <td class="muted">${Number.isFinite(v.confidence) ? `${Math.round(v.confidence * 100)} %` : ''}</td></tr>`;
}

function wireForm() {
  const d = document.getElementById('detail');
  const changed = () => { saveMemory(); ui.view.setViews(effectiveViews()); $('#dwReset', d).disabled = !Object.keys(cleanOverrides(st.overrides)).length; };
  $('#dwScale', d).addEventListener('input', (e) => { const n = parseFloat(e.target.value); st.overrides.scale = Number.isFinite(n) && n > 0 ? n : undefined; changed(); });
  $('#dwBow', d).addEventListener('change', (e) => { st.overrides.bow = e.target.value || undefined; changed(); });
  $('#dwShip', d).addEventListener('input', (e) => { st.overrides.shipName = e.target.value; changed(); });
  for (const row of d.querySelectorAll('tr[data-view]')) {
    const id = row.dataset.view;
    const found = st.views.find((v) => v.id === id);
    row.addEventListener('mouseenter', () => ui.view.highlightView(id));
    row.addEventListener('mouseleave', () => ui.view.highlightView(null));
    row.addEventListener('focusin', () => ui.view.highlightView(id, { reveal: true }));
    row.addEventListener('input', (e) => {
      const f = e.target.dataset.f;
      const o = (st.overrides.views[id] ??= {});
      if (f === 'kind') {
        const k = e.target.value;
        delete o.ignore; delete o.kind;
        if (k === 'ignore') o.ignore = true;
        else if (k !== found?.kind) o.kind = k;
        row.classList.toggle('dw-ignored', k === 'ignore');
        row.querySelector('.dw-swatch').style.background = KIND_COLOR[k] ?? KIND_COLOR.other;
      } else if (f === 'deckName') {
        o.deckName = e.target.value.trim() || undefined;
      } else if (f === 'elevation') {
        const n = parseFloat(e.target.value);
        o.elevation = Number.isFinite(n) ? n : undefined;
      }
      changed();
    });
  }
  $('#dwConvert', d).addEventListener('click', convert);
  $('#dwReset', d).addEventListener('click', () => { st.overrides = blankOverrides(); saveMemory(); renderForm(); });
  $('#dwCancel', d).addEventListener('click', () => cancelWorker());
}

function renderFormState(text) {
  const msg = document.querySelector('#detail #dwFormMsg');
  if (msg) msg.innerHTML = text ? `<p class="muted">${esc(text)}</p>` : '';
  const btn = document.querySelector('#detail #dwConvert');
  if (btn) btn.disabled = st.busy;
}

function focusViewRow(view) {
  if (!document.querySelector('#detail .dw-views')) renderForm();
  const row = document.querySelector(`#detail tr[data-view="${CSS.escape(view.id)}"]`);
  if (!row) return;
  row.scrollIntoView({ block: 'nearest' });
  row.classList.add('dw-flash');
  setTimeout(() => row.classList.remove('dw-flash'), 900);
  row.querySelector('select')?.focus({ preventScroll: true });
}

// ---------- c. conversion ----------

async function convert() {
  if (st.busy || !st.sheet) return;
  st.busy = true;
  const d = document.getElementById('detail');
  const steps = $('#dwSteps', d);
  steps.hidden = false;
  steps.innerHTML = STAGES.map((s) => `<li data-s="${s}"><span class="dw-tick" aria-hidden="true"></span>${esc(STAGE_LABEL[s])}<span class="dw-time"></span></li>`).join('');
  $('#dwConvert', d).disabled = true;
  $('#dwCancel', d).hidden = false;
  $('#dwFormMsg', d).innerHTML = '';
  const t0 = performance.now();
  const state = {};
  const mark = (stage, fraction) => {
    const i = STAGES.indexOf(stage);
    if (i < 0) return;
    // Every earlier stage is done once a later one reports (interpret may run several steps in one call).
    STAGES.slice(0, i).forEach((s) => { if (state[s] !== 'done') state[s] = 'done'; });
    state[stage] = fraction >= 1 ? 'done' : 'active';
    for (const li of steps.children) {
      const s = li.dataset.s;
      li.className = state[s] ?? '';
      if (s === stage && state[s] === 'active' && fraction > 0) li.querySelector('.dw-time').textContent = `${Math.round(fraction * 100)} %`;
    }
  };
  try {
    const r = await runOnSheet('convert', mark);
    STAGES.forEach((s) => mark(s, 1));
    const t = r.report?.timings ?? {};
    for (const li of steps.children) {
      const s = li.dataset.s;
      li.querySelector('.dw-time').textContent = t[s] != null ? fmtMs(t[s]) : '';
    }
    if (!(r.report?.timedStages ?? []).some((s) => ['scale', 'decks', 'rooms', 'doors', 'hull'].includes(s)) && t.interpret != null) {
      steps.querySelector('li[data-s="hull"] .dw-time').textContent = `${fmtMs(t.interpret)} for scale to hull`;
    }
    st.busy = false;
    await addResult(r, performance.now() - t0);
  } catch (e) {
    st.busy = false;
    if (!d.contains(steps)) return; // the panel was replaced meanwhile (another file, another element)
    $('#dwCancel', d).hidden = true;
    $('#dwConvert', d).disabled = false;
    if (e.cancelled) { steps.hidden = true; return; }
    if (e.stage) for (const li of steps.children) if (li.dataset.s === e.stage) li.className = 'failed';
    if (e.views?.length && !st.views.length) { st.views = e.views; ui.view.setViews(effectiveViews()); }
    $('#dwFormMsg', d).innerHTML = errorHTML(e, `Conversion stopped${e.stage ? ` at "${STAGE_LABEL[e.stage] ?? e.stage}"` : ''}`);
  }
}

function errorHTML(e, title) {
  const hint = e.code === 'module' ? '' : STAGE_HINT[e.stage] ?? '';
  return `<div class="dw-error"><b>${esc(title)}.</b> ${esc(e.message)}${hint ? `<div class="muted">${esc(hint)}</div>` : ''}</div>`;
}

// ---------- d. result: a model in the viewer and the checker, and the report ----------

async function addResult(r, ms) {
  const geometry = new Map(r.geometry ?? []);
  const name = `Drawing: ${st.file.name}`;
  let id;
  try {
    id = await host.addScenario({ name, idHint: `drawing-${st.file.name}`, json: r.model, geometry: { elements: geometry }, replace: st.scenarioId });
  } catch (e) {
    // The checker refused the model (e.g. duplicate ids): a converter fault, said plainly.
    const d = document.getElementById('detail');
    const cancel = $('#dwCancel', d), btn = $('#dwConvert', d), msg = $('#dwFormMsg', d);
    if (cancel) cancel.hidden = true;
    if (btn) btn.disabled = false;
    const html = errorHTML({ message: e.message, stage: 'mesh' }, 'The converted model could not be loaded');
    if (msg) msg.innerHTML = html; else detailMessage(html);
    return;
  }
  if (!id) return; // the engineer switched to another model meanwhile
  st.scenarioId = id;
  st.result = { model: r.model, recon: r.recon, views: r.views ?? st.views, report: r.report ?? {}, ms, page: st.page };
  st.convertedAt = new Date();
  if (r.views?.length) st.views = r.views;
  ui.view.setItems(null);
  st.overlay = false;
  st.picked = null;
  closeDrawingImport();
  renderReport();
}

// Where a value comes from, as a small tag. The converter states it as `basis` (measured / read / typed / assumed);
// older report entries only have a `source` sentence, from which the same is inferred.
const BASIS = { measured: ['measured', 'pub'], read: ['read on drawing', 'pub'], typed: ['typed', 'edit'], assumed: ['assumed', 'est'] };
function sourceKind(s, basis) {
  if (BASIS[basis]) return BASIS[basis];
  const t = String(s ?? '').toLowerCase();
  if (/assum|default|typical/.test(t)) return BASIS.assumed;
  if (/user|given|entered|override|typed/.test(t)) return BASIS.typed;
  if (/text|read|label|note|title/.test(t)) return BASIS.read;
  if (/measur|profile|line|drawing/.test(t)) return BASIS.measured;
  return [t || 'not stated', ''];
}
const basisTag = (source, basis) => { const [k, c] = sourceKind(source, basis); return `<span class="prov ${c}" title="${esc(source ?? k)}">${esc(k)}</span>`; };

// A value in the report: a number, or { value, unit, basis, range: [lo, hi], source } → "812 mm (795–829)".
function valueText(v, unit = 'mm') {
  if (v == null) return '–';
  if (typeof v !== 'object') return Number.isFinite(v) ? `${Math.round(v).toLocaleString('en')} ${unit}` : String(v);
  const u = v.unit ?? unit;
  const n = (x) => (Number.isFinite(x) ? Math.round(x).toLocaleString('en') : esc(x));
  return `${n(v.value)}${u ? ` ${esc(u)}` : ''}${Array.isArray(v.range) && v.range.length === 2 ? ` (${n(v.range[0])}–${n(v.range[1])})` : ''}`;
}
const num = (v) => (v && typeof v === 'object' ? v.value : v);

// One entry of the measured / assumed lists: a sentence, or an object with what it is, its value and its basis.
function entryHTML(x) {
  if (typeof x === 'string') return esc(x);
  const what = x.what ?? x.text ?? x.name ?? x.label ?? '';
  const hasValue = x.value != null;
  const ids = x.ids ?? (x.id ? [x.id] : []);
  return `${ids.length ? `<a href="#" class="dw-sel" data-id="${esc(ids[0])}">${esc(what || ids[0])}</a>` : esc(what)}${hasValue ? `${what ? ': ' : ''}<b>${valueText(x)}</b>` : ''}
    ${x.basis || x.source ? basisTag(x.source, x.basis) : ''}${x.source ? ` <span class="muted">${esc(x.source)}</span>` : ''}`;
}

// The interpreter annotates element properties: { value, unit, basis, range, source }. Plain values pass through.
const val = (v) => (v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? v.value : v);
const nice = (key) => { const t = String(key).replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
// Kind of room for counts and colours: the zone of a space, else what its type says.
function roomKind(e) {
  if (!e) return null;
  if (e.type === 'space') return val(e.props?.zone) ?? null;
  return { corridor: 'circulation', machinery_space: 'machinery', tank: 'tank', fuel_tank: 'tank' }[e.type] ?? null;
}
const ROOM_TYPES = new Set(['space', 'corridor', 'machinery_space', 'tank', 'fuel_tank']);
const ROOM_TYPE_LABEL = { corridor: 'corridor', machinery_space: 'machinery space', tank: 'tank', fuel_tank: 'fuel tank' };
// unresolved[i].at is { model: [x, y], sheet: [u, v] } (or a plain sheet point in older reports).
const sheetAt = (u) => (Array.isArray(u?.at) ? u.at : Array.isArray(u?.at?.sheet) ? u.at.sheet : null);
const fmtLen = (mm) => (Number.isFinite(mm) ? `${(mm / 1000).toFixed(2)} m` : '–');

function renderReport() {
  const res = st.result;
  if (!res) return;
  const rep = res.report ?? {}, model = res.model;
  const f = host.results?.()?.element_summary;
  const els = model.elements ?? [];
  const count = (pred) => els.filter(pred).length;
  // Rooms by what they are: spaces by zone, the other room types by type.
  const kinds = Object.entries(els.filter((e) => ROOM_TYPES.has(e.type)).reduce((m, e) => {
    const k = e.type === 'space' ? val(e.props?.zone) ?? 'no zone' : ROOM_TYPE_LABEL[e.type];
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {})).sort((a, b) => b[1] - a[1]);
  const counts = rep.counts ?? {};
  const scale = rep.scale ?? {};
  const scaleValue = num(scale.value);
  const sources = Array.isArray(scale.sources) ? scale.sources : [];
  // Does each source agree with the scale used? The interpreter says so (agrees); otherwise compare within 1 %.
  const agrees = (s) => (typeof s.agrees === 'boolean' ? s.agrees
    : Number.isFinite(num(s.value)) && Number.isFinite(scaleValue) ? Math.abs(num(s.value) / scaleValue - 1) < 0.01 : null);
  const disagreeing = sources.filter((s) => agrees(s) === false);
  const modelDeck = new Map((model.decks ?? []).map((d) => [d.id, d]));
  const decks = rep.decks?.length ? rep.decks : res.recon?.decks ?? [];
  const assumed = rep.assumed ?? [], measured = rep.measured ?? [], typed = rep.typed ?? [], warnings = rep.warnings ?? [];
  const toCheck = rep.check ?? [], unresolved = rep.unresolved ?? [];
  const list = (items) => items.map((x) => `<li>${entryHTML(x)}</li>`).join('');
  const doorCount = counts.doors ?? count((e) => e.type === 'door');
  const ref = rep.referee;
  const issues = ref?.issues ?? [];
  const errors = issues.filter((i) => i.level === 'error'), warns = issues.filter((i) => i.level !== 'error');
  const issueHTML = (i) => `<li class="dw-issue ${i.level === 'error' ? 'err' : 'warn'}">${i.ids?.length
    ? `<a href="#" class="dw-sel" data-id="${esc(i.ids[0])}" title="Select ${esc(i.ids[0])} in the 3D view">${esc(i.message ?? i.what)}</a>`
    : esc(i.message ?? i.what)}${i.ids?.length > 1 ? ` <span class="muted">(${i.ids.length} elements)</span>` : ''}</li>`;
  const geometryCheck = ref === undefined ? '' : ref === null
    ? '<h2>Geometry check</h2><p class="muted">The geometry check is not available in this version: the model was not checked for overlapping rooms or misplaced doors.</p>'
    : `<h2>Geometry check</h2>${ref.failed ? `<div class="dw-error">${esc(ref.failed)}</div>` : ''}
      ${!issues.length && !ref.failed ? '<div class="check-ok">No geometry issues found.</div>' : ''}
      ${issues.length ? `<p class="muted">${errors.length} error${errors.length === 1 ? '' : 's'}, ${warns.length} warning${warns.length === 1 ? '' : 's'}. Click one to select the element in 3D.</p>
        <ul class="dw-issues">${[...errors, ...warns].slice(0, 60).map(issueHTML).join('')}</ul>${issues.length > 60 ? `<p class="muted">… and ${issues.length - 60} more.</p>` : ''}` : ''}`;
  // Decks: elevation and height each with their own basis (elevation_basis / height_basis), else the deck's.
  const deckRow = (d) => {
    const md = modelDeck.get(d.id) ?? {};
    const deckBasis = d.basis ?? md.basis, deckSource = d.source ?? md.source;
    const cell = (key) => {
      const v = d[key];
      const basis = d[`${key}_basis`] ?? v?.basis ?? deckBasis, source = d[`${key}_source`] ?? v?.source ?? deckSource;
      const range = v?.range ?? d[`${key}_range`];
      return { basis, html: `${fmtM(num(v))}${Array.isArray(range) ? ` <span class="muted">(${fmtM(range[0])}–${fmtM(range[1])})</span>` : ''} ${basis || source ? basisTag(source, basis) : ''}` };
    };
    const e = cell('elevation'), h = cell('height');
    const weak = [e.basis, h.basis].includes('assumed');
    return `<tr${weak ? ' class="warn"' : ''}><td>${esc(d.name ?? d.id)}</td><td>${e.html}</td><td>${h.html}</td></tr>`;
  };
  const ship = rep.ship && typeof rep.ship === 'object' ? Object.entries(rep.ship).filter(([, v]) => v != null) : [];
  const areas = rep.areas;
  const areaOff = (areas?.list ?? []).filter((a) => a.agrees === false);
  document.getElementById('detail').innerHTML = `
    <h1>Drawing converted to 3D</h1>
    <div class="muted">${esc(st.file.name)}${st.sheets.length > 1 ? ` · page ${st.page + 1}` : ''} · ${els.length.toLocaleString('en')} elements on ${(model.decks ?? []).length} deck${(model.decks ?? []).length === 1 ? '' : 's'} · converted in ${fmtMs(res.ms)}</div>
    ${f ? `<p><span class="badge st-non_compliant">${f.non_compliant} non-compliant</span> <span class="badge st-not_enough_info">${f.not_enough_info} not enough info</span> <span class="badge st-compliant">${f.compliant} no deviation</span> <span class="muted">${(f.no_rule ?? 0).toLocaleString('en')} elements without a rule</span></p>` : ''}
    <div class="dw-actions">
      <button id="dwBack" title="Back to the drawing to correct views, scale or decks; converting again replaces this model">Back to drawing</button>
      <button id="dwShowOverlay" title="Draw what was recognised over the deck plans: rooms by zone, walls, doors, stairs">Overlay on drawing</button>
      <button id="dwDownload" title="The converted model as ship/1 JSON (opens again with Open…)">Download model (ship/1 JSON)</button>
    </div>
    ${disagreeing.length ? `<div class="dw-error"><b>Check the scale.</b> The model uses 1:${esc(scaleValue)} (${esc(scale.source ?? '')}), but the drawing gives ${disagreeing.map((s) => `1:${esc(+Number(num(s.value)).toPrecision(4))} (${esc(sourceKind(s.source, s.basis)[0])})`).join(' and ')}. A wrong scale changes every size in the model.</div>` : ''}
    ${assumed.length ? `<h2>Assumed — check these (${assumed.length})</h2><ul class="dw-assumed">${list(assumed)}</ul>` : ''}
    ${toCheck.length ? `<h2>To check on the drawing (${toCheck.length})</h2>${toCheck.length > 6
      ? `<ul class="dw-check">${list(toCheck.slice(0, 5))}</ul><details class="assume"><summary>${toCheck.length - 5} more</summary><ul class="dw-check">${list(toCheck.slice(5))}</ul></details>`
      : `<ul class="dw-check">${list(toCheck)}</ul>`}` : ''}
    <h2>Scale</h2>
    <table class="kv">
      <tr><td>Drawing scale</td><td>${scaleValue ? `1 : ${esc(scaleValue)}` : 'not needed (drawn 1:1)'} ${scale.basis || scale.source ? basisTag(scale.source, scale.basis) : ''}${scale.mmPerUnit ? ` <span class="muted">· ${esc(+Number(scale.mmPerUnit).toPrecision(4))} mm per drawing unit</span>` : ''}</td></tr>
      <tr><td>Source</td><td>${esc(scale.source ?? 'not stated')}</td></tr>
      ${sources.length ? `<tr><td>Found on the drawing</td><td>${sources.map((s) => `<div class="dw-src${agrees(s) === false ? ' off' : ''}">${num(s.value) ? `1:${esc(+Number(num(s.value)).toPrecision(5))} ` : ''}${s.basis || s.source ? basisTag(s.source, s.basis) : ''} <span class="muted">${esc(s.source ?? s.text ?? '')}</span></div>`).join('')}
        ${disagreeing.length ? `<div class="check-bad">${disagreeing.length === sources.length ? 'The drawing' : `${disagreeing.length} of ${sources.length} sources`} ${disagreeing.length === 1 ? 'gives' : 'give'} another scale than 1:${esc(scaleValue)}: check the scale.</div>`
          : sources.length > 1 ? `<div class="check-ok">${sources.length} sources agree</div>` : ''}</td></tr>` : ''}
    </table>
    ${ship.length ? `<h2>Ship</h2><table class="kv">${ship.map(([k, v]) => `<tr><td>${esc(nice(k))}</td><td>${typeof v === 'object' && Number.isFinite(v.value)
      ? `${fmtLen(v.value)}${Number.isFinite(v.measured) ? ` <span class="muted">(measured ${fmtLen(v.measured)})</span>` : ''} ${basisTag(v.source, v.basis)}`
      : esc(val(v))}</td></tr>`).join('')}</table>` : ''}
    <h2>Decks (${decks.length})</h2>
    ${decks.length ? `<table class="register dw-decks"><thead><tr><th>Deck</th><th>Elevation</th><th>Height</th></tr></thead><tbody>${decks.map(deckRow).join('')}</tbody></table>` : '<p class="muted">No decks.</p>'}
    ${geometryCheck}
    <h2>Recognised</h2>
    <table class="kv">
      <tr><td>Rooms</td><td>${kinds.length ? kinds.map(([z, n]) => `${n} ${esc(String(z).replace(/_/g, ' '))}`).join(', ') : 'none'}</td></tr>
      <tr><td>Doors</td><td>${doorCount} <span class="tag" title="Door symbols are the least reliable part of a drawing to read: a missed arc is a missing door, a stray arc an extra one">check doors against the drawing</span>
        ${doorCount ? '<button id="dwShowDoors" class="tiny" title="Show only the recognised doors and openings (with the walls) over the deck plans">Show doors on the drawing</button>' : ''}</td></tr>
      <tr><td>Stairs and ladders</td><td>${(counts.stairs ?? count((e) => e.type === 'stair')) + (counts.ladders ?? 0)}</td></tr>
      <tr><td>Walls</td><td>${counts.walls ?? count((e) => e.type === 'wall')}</td></tr>
      ${Object.entries(counts).filter(([k, v]) => !['rooms', 'doors', 'stairs', 'ladders', 'walls', 'elements'].includes(k) && typeof v === 'number' && v > 0)
        .map(([k, v]) => `<tr><td>${esc(nice(k))}</td><td>${v}</td></tr>`).join('')}
      ${areas?.printed ? `<tr><td>Printed room areas</td><td>${areas.agree} of ${areas.printed} agree with the measured area${areaOff.length ? `<div class="muted">${areaOff.slice(0, 6).map((a) => `${esc(a.room)}: measured ${esc(a.measured)} m²`).join('<br>')}</div>` : ''}</td></tr>` : ''}
    </table>
    ${warnings.length ? `<h2>Warnings (${warnings.length})</h2>${warnings.map((w) => `<div class="note">${entryHTML(w)}</div>`).join('')}` : ''}
    ${unresolved.length ? `<h2>Seen but not converted (${unresolved.length})</h2><ul class="dw-unresolved">${unresolved.map((u, i) => `<li>${esc(typeof u === 'string' ? u : u.what ?? '')}${u.view ? ` <span class="muted">· ${esc(viewLabel(u.view))}</span>` : ''}${sheetAt(u) ? ` <button class="tiny" data-at="${i}" title="Zoom the drawing to this place">Show</button>` : ''}</li>`).join('')}</ul>` : ''}
    ${typed.length ? `<h2>Typed by you (${typed.length})</h2><ul class="dw-measured">${list(typed)}</ul>` : ''}
    ${measured.length ? `<h2>Measured from the drawing (${measured.length})</h2>${measured.length > 8
      ? `<details class="assume"><summary>${measured.length} values, each with the place it was measured</summary><ul>${list(measured)}</ul></details>` : `<ul class="dw-measured">${list(measured)}</ul>`}` : ''}
    <p class="muted" style="margin-top:8px">Every converted element shows where it comes from (view and line work) in its details. Values marked "assumed" are not on the drawing: check them or enter them in the drawing settings.</p>`;
  const d = document.getElementById('detail');
  $('#dwBack', d).addEventListener('click', () => { openPanel(); setOverlay(false); renderForm(); });
  $('#dwShowOverlay', d).addEventListener('click', () => { openPanel(); setOverlay(true); });
  $('#dwShowDoors', d)?.addEventListener('click', () => { openPanel(); setOverlay(true, 'door'); });
  $('#dwDownload', d).addEventListener('click', () => {
    const base = st.file.name.replace(/\.[^.]+$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    host.download(`${base}-ship1.json`, JSON.stringify(res.model, null, 1), 'application/json');
  });
  for (const b of d.querySelectorAll('button[data-at]')) {
    b.addEventListener('click', () => {
      const u = unresolved[+b.dataset.at];
      openPanel();
      setOverlay(true); // everything, with the '?' markers (not the doors-only view)
      ui.view.reveal(sheetAt(u), null, { marker: true });
    });
  }
  render();
}

function viewLabel(id) {
  const v = effectiveViews().find((x) => x.id === id);
  return v ? `${v.kind}${v.deckName ? ` ${v.deckName}` : ''}` : id;
}

function openPanel() {
  host.closeOtherPanels?.();
  showPanel(true);
  ui.view.resize();
  render();
}

// ---------- 2D check: what was recognised, drawn over the deck plans ----------

// filter 'door': only doors and openings (with the walls they sit in), for checking the least reliable part of the
// reading against the drawing's own door symbols.
function setOverlay(on, filter = null) {
  st.overlay = !!on && !!st.result;
  if (st.overlay) {
    const { items: all, missing } = overlayItems();
    const items = filter === 'door' ? all.filter((it) => ['door', 'opening', 'wall'].includes(it.kind)) : all;
    ui.view.setItems(items);
    ui.legend.hidden = false;
    const n = (k) => all.filter((it) => it.kind === k).length;
    const sym = (cls, label) => `<span><i class="dw-sym ${cls}"></i>${label}</span>`;
    const zones = [...new Set(all.filter((it) => it.kind === 'room').map((it) => it.zone ?? 'none'))]
      .sort((a, b) => Object.keys(ZONE_COLOR).indexOf(a) - Object.keys(ZONE_COLOR).indexOf(b));
    ui.legend.innerHTML = `${filter === 'door'
      ? `<span><b>${n('door')} door${n('door') === 1 ? '' : 's'}</b>${n('opening') ? ` and ${n('opening')} opening${n('opening') === 1 ? '' : 's'}` : ''} recognised: compare with the door symbols on the drawing</span> <button class="tiny" id="dwAllItems">Show everything</button>`
      : zones.map((z) => `<span><i style="background:${ZONE_COLOR[z] ?? ZONE_COLOR.none}"></i>${esc(z === 'none' ? 'no zone' : z.replace(/_/g, ' '))}</span>`).join('')}
      ${sym('door', `door (${n('door')})`)}${n('opening') ? sym('opening', `opening (${n('opening')})`) : ''}${filter === 'door' ? '' : `${n('stair') ? sym('stair', `stair (${n('stair')})`) : ''}${n('marker') ? sym('marker', `not converted (${n('marker')})`) : ''}`}
      <div class="muted">Hover: the line work it was read from (orange) · click: select · double-click: show in 3D</div>
      ${missing.length ? `<div class="muted">Not placed on the sheet: ${esc(missing.join('; '))}</div>` : ''}`;
    $('#dwAllItems', ui.legend)?.addEventListener('click', () => setOverlay(true));
  } else {
    ui.view.setItems(null);
    ui.legend.hidden = true;
  }
  // A fitted sheet moves up above the legend instead of lying under it.
  ui.view.setInsetBottom(ui.legend.hidden ? 0 : ui.legend.offsetHeight + 12);
  render();
}

// The paths and texts an element was read from: recon items carry `evidence`, the model element may too.
function evidenceOf(item) {
  if (!item) return null;
  if (Array.isArray(item.evidence) && item.evidence.length) return item.evidence;
  const el = st.result?.model.elements?.find((e) => e.id === item.id);
  return Array.isArray(el?.evidence) && el.evidence.length ? el.evidence : null;
}

// Model mm → sheet units for each deck plan. The interpretation may give the exact transform (report.views[i]
// .toSheet = [a, b, c, d, e, f]: u = a·x + c·y + e, v = b·x + d·y + f); otherwise it is rebuilt from the view's
// ship ends and centreline, which places the deck's aft end at the view's aft end.
function deckTransforms() {
  const res = st.result, rep = res.report ?? {}, sheet = st.sheet;
  const mmPerUnit = rep.scale?.mmPerUnit ?? (UNIT_MM[sheet.unit] ?? 1) * (sheet.paper ? rep.scale?.value ?? 1 : 1);
  const views = effectiveViews();
  const decks = res.recon?.decks ?? res.model.decks ?? [];
  const out = new Map(), missing = [];
  for (const deck of decks) {
    const exact = (rep.views ?? []).find((v) => (v.deck === deck.id || norm(v.deckName) === norm(deck.name)) && Array.isArray(v.toSheet));
    if (exact) {
      const [a, b, c, d, e, f] = exact.toSheet;
      out.set(deck.id, { exact: true, f: ([x, y]) => [a * x + c * y + e, b * x + d * y + f] });
      continue;
    }
    const view = views.find((v) => v.kind === 'plan' && (norm(v.deckName) === norm(deck.name) || norm(v.deckName) === norm(deck.id)));
    if (!view || !view.xRange || !view.centreline) { missing.push(`${deck.name ?? deck.id} (${view ? 'the view has no ship ends or centreline' : 'no plan view with this deck name'})`); continue; }
    const sgn = view.xRange[1] >= view.xRange[0] ? 1 : -1;
    const xs = (deck.outline ?? []).map((p) => p[0]);
    const x0 = xs.length ? Math.min(...xs) : 0;
    const uAft = view.xRange[0], cl = view.centreline.y;
    out.set(deck.id, { exact: false, f: ([x, y]) => [uAft + sgn * (x - x0) / mmPerUnit, cl + sgn * y / mmPerUnit] });
  }
  return { out, missing, mmPerUnit };
}

// Everything recognised, in sheet units, in drawing order: rooms, walls, stairs, openings, doors, and a "?" where
// something was seen but not converted.
function overlayItems() {
  const res = st.result, recon = res.recon ?? {};
  const { out: T, missing, mmPerUnit } = deckTransforms();
  const byId = new Map((res.model.elements ?? []).map((e) => [e.id, e]));
  const items = [];
  const label = (id) => {
    const e = byId.get(id);
    if (!e) return id;
    const kind = roomKind(e);
    return `${val(e.name) || id} · ${String(e.type).replace(/_/g, ' ')}${kind && e.type === 'space' ? ` · ${String(kind).replace(/_/g, ' ')}` : ''}`;
  };
  for (const r of recon.rooms ?? []) {
    const t = T.get(r.deck);
    if (!t || !r.polygon?.length) continue;
    const zone = roomKind(byId.get(r.id));
    items.push({ id: r.id, kind: 'room', zone: ZONE_COLOR[zone] ? zone : 'none', poly: r.polygon.map(t.f), holes: (r.holes ?? []).map((h) => h.map(t.f)),
      color: ZONE_COLOR[zone] ?? ZONE_COLOR.none, tip: label(r.id), evidence: r.evidence });
  }
  for (const w of recon.walls ?? []) {
    const t = T.get(w.deck);
    if (!t || !w.a || !w.b) continue;
    items.push({ id: w.id, kind: 'wall', line: [t.f(w.a), t.f(w.b)], width: Math.max(w.thickness ?? 0, 1) / mmPerUnit, color: w.kind === 'shell' ? '#1d2430' : '#334155', tip: label(w.id), evidence: w.evidence });
  }
  for (const s of recon.stairs ?? []) {
    const t = T.get(s.deck);
    if (!t || !s.polygon?.length) continue;
    items.push({ id: s.id, kind: 'stair', poly: s.polygon.map(t.f), color: '#7c3aed', tip: label(s.id), treads: stairTreads(s).map((l) => l.map(t.f)), evidence: s.evidence });
  }
  for (const o of recon.openings ?? []) {
    const t = T.get(o.deck);
    if (!t || !o.a || !o.b) continue;
    items.push({ id: o.id, kind: 'opening', line: [t.f(o.a), t.f(o.b)], width: 0, color: '#0f9d58', tip: `${label(o.id)}${o.width ? ` · ${Math.round(o.width)} mm` : ''}`, evidence: o.evidence });
  }
  for (const d of recon.doors ?? []) {
    const t = T.get(d.deck);
    if (!t || !d.hinge || !d.width) continue;
    const { arc, leaf } = doorShape(d);
    items.push({ id: d.id, kind: 'door', arc: arc.map(t.f), leaf: leaf.map(t.f), poly: [t.f(d.hinge), ...arc.map(t.f)], color: '#d64545', tip: `${label(d.id)} · ${Math.round(d.width)} mm`, evidence: d.evidence });
  }
  (res.report?.unresolved ?? []).forEach((u, i) => {
    const at = sheetAt(u);
    if (at) items.push({ id: `unresolved-${i}`, kind: 'marker', at, color: '#b45309', tip: `Not converted: ${u.what ?? ''}`, evidence: u.texts ?? u.evidence });
  });
  return { items, missing };
}

// The door leaf swings a quarter circle from along the wall to across it; the drawing's own symbol looks the same.
function doorShape(d) {
  const len = Math.hypot(d.wallDir?.[0] ?? 1, d.wallDir?.[1] ?? 0) || 1;
  const ax = (d.wallDir?.[0] ?? 1) / len, ay = (d.wallDir?.[1] ?? 0) / len;
  const sw = d.swing === -1 ? -1 : 1;
  const nx = -ay * sw, ny = ax * sw;
  const arc = [];
  for (let i = 0; i <= 12; i++) {
    const t = (i / 12) * Math.PI / 2;
    arc.push([d.hinge[0] + d.width * (ax * Math.cos(t) + nx * Math.sin(t)), d.hinge[1] + d.width * (ay * Math.cos(t) + ny * Math.sin(t))]);
  }
  return { arc, leaf: [d.hinge, [d.hinge[0] + nx * d.width, d.hinge[1] + ny * d.width]] };
}

// Tread lines across the stair's bounding box, perpendicular to its direction: enough to tell a stair at a glance.
function stairTreads(s) {
  const n = Math.min(Math.max(s.treads ?? 8, 2), 30);
  const xs = s.polygon.map((p) => p[0]), ys = s.polygon.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const alongX = Math.abs(s.dir?.[0] ?? 1) >= Math.abs(s.dir?.[1] ?? 0);
  const lines = [];
  for (let i = 1; i < n; i++) {
    const k = i / n;
    lines.push(alongX ? [[x0 + (x1 - x0) * k, y0], [x0 + (x1 - x0) * k, y1]] : [[x0, y0 + (y1 - y0) * k], [x1, y0 + (y1 - y0) * k]]);
  }
  return lines;
}

function pickItem(item, show3d) {
  if (item.kind === 'marker') { // not an element: zoom to it and show the label it is about
    ui.view.setEvidence(evidenceOf(item));
    ui.view.reveal(item.at, null, { marker: true });
    return;
  }
  if (!host.hasElement?.(item.id)) {
    showTip(`${item.tip}: open the converted model ("Drawing: ${st.file.name}") to select it`, null, null);
    return;
  }
  st.picked = item;
  ui.view.selectItem(item.id);
  ui.view.setEvidence(evidenceOf(item));
  host.select(item.id);
  if (show3d) closeDrawingImport();
}

// ---------- panel chrome ----------

function render() {
  if (!ui) return;
  const has = !!st.sheet;
  ui.drop.hidden = has || st.busy;
  $('#dwInfo').textContent = st.file ? `${st.file.name}${st.sheets.length > 1 ? ` · page ${st.page + 1} of ${st.sheets.length}` : ''}` : '';
  $('#dwFit').hidden = !has;
  $('#dwFormBtn').hidden = !has;
  $('#dwReportBtn').hidden = !st.result;
  const ob = $('#dwOverlayBtn');
  ob.hidden = !st.result;
  ob.classList.toggle('on', st.overlay);
  renderPages();
}

function renderPages() {
  const n = st.sheets.length;
  ui.pages.hidden = n < 2;
  if (n < 2) { ui.pages.innerHTML = ''; return; }
  if (ui.pages.dataset.file !== st.file.name || ui.pages.children.length !== n) {
    ui.pages.dataset.file = st.file.name;
    const work = st.sheets.map(lineWork), best = work.indexOf(Math.max(...work));
    ui.pages.innerHTML = st.sheets.map((s, i) => `<button class="dw-page" data-i="${i}" title="Page ${i + 1}: ${work[i].toLocaleString('en')} line segments${i === best ? ' (most line work: likely the general arrangement)' : ''}">
      <canvas width="132" height="92"></canvas><span>${i + 1}${i === best ? ' · GA?' : ''}</span><small>${work[i] >= 1000 ? `${Math.round(work[i] / 1000)}k` : work[i]} lines</small></button>`).join('');
    ui.pages.querySelectorAll('.dw-page').forEach((b, i) => {
      drawThumb(b.querySelector('canvas'), st.sheets[i]);
      b.addEventListener('click', () => { if (!st.busy && i !== st.page) choosePage(i); });
    });
  }
  ui.pages.querySelectorAll('.dw-page').forEach((b, i) => b.classList.toggle('on', i === st.page));
}

function setStatus(text, fraction) {
  if (!ui) return;
  ui.status.hidden = !text;
  if (!text) return;
  const pct = Number.isFinite(fraction) ? Math.round(Math.max(0, Math.min(1, fraction)) * 100) : null;
  ui.status.innerHTML = `<b>${esc(text)}</b><div class="convert-bar${pct == null ? ' indeterminate' : ''}"><i${pct == null ? '' : ` style="width:${pct}%"`}></i></div>${pct != null ? `<span class="muted">${pct} %</span>` : ''}`;
}

function detailMessage(html) { document.getElementById('detail').innerHTML = html; }

function showTip(text, x, y) {
  ui.tip.textContent = text;
  ui.tip.hidden = false;
  if (x == null) { ui.tip.style.left = '50%'; ui.tip.style.top = '12px'; ui.tip.style.transform = 'translateX(-50%)'; return; }
  ui.tip.style.transform = '';
  ui.tip.style.left = `${Math.min(x + 14, ui.stage.clientWidth - 260)}px`;
  ui.tip.style.top = `${y + 14}px`;
}
function hideTip() { if (ui) ui.tip.hidden = true; }

// ---------- sheet preview: fast enough for a million line segments ----------
//
// The line work is grouped once into Path2D objects per style (colour, width, dash, fill) and per cell of a 16 × 16
// grid over the sheet, so a zoomed-in redraw skips the cells off screen. The lines are drawn into an offscreen bitmap
// for the current zoom that covers the view and a margin around it; panning moves that bitmap and zooming scales it
// at once, and the sharp redraw follows when the wheel stops. Views and recognised elements are drawn on top every
// frame (a few hundred shapes).

function sheetBox(sheet) {
  if (Array.isArray(sheet.bbox) && sheet.bbox.every(Number.isFinite) && sheet.bbox[2] > sheet.bbox[0]) return sheet.bbox;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of sheet.paths) for (const [x, y] of p.pts ?? []) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return Number.isFinite(x0) ? [x0, y0, Math.max(x1, x0 + 1), Math.max(y1, y0 + 1)] : [0, 0, 1, 1];
}

// White or near-white lines (the default colour on a black CAD screen) would vanish on paper: draw them in ink.
function inkColor(c) {
  if (!c || !/^#[0-9a-f]{6}$/i.test(c)) return '#1d2430';
  const r = parseInt(c.slice(1, 3), 16), g = parseInt(c.slice(3, 5), 16), b = parseInt(c.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 200 ? '#1d2430' : c;
}

function createSheetView(stage, { onHover, onClick, onDblClick }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'dw-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Drawing sheet. Drag to pan, wheel or + and − to zoom, arrow keys to move, F to fit.');
  stage.prepend(canvas);
  const ctx = canvas.getContext('2d');
  let sheet = null, groups = [], texts = [], box = [0, 0, 1, 1], prepToken = 0;
  let s = 1, vx = 0, vy = 1, W = 1, H = 1, dpr = 1; // s: device px per sheet unit; (vx, vy): sheet point at the top-left
  let cache = null, cacheTimer = 0, frame = 0;
  let views = [], hiView = null, items = null, hiItem = null, selId = null;
  let byId = null, evidence = null; // id -> path/text (built on first use); the evidence shown now
  let fitted = true, pulse = null; // fitted: no pan or zoom since the last fit (a resize then fits again)
  let insetBottom = 0; // CSS px covered by the legend at the bottom

  const toScreen = (u, v) => [(u - vx) * s, (vy - v) * s];
  const toSheet = (X, Y) => [vx + X / s, vy - Y / s];

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(stage.clientWidth * dpr)), h = Math.max(1, Math.round(stage.clientHeight * dpr));
    if (w === W && h === H) return;
    // Still fitted (the engineer has not panned or zoomed since): fit again, so the sheet stays whole and centred.
    // Otherwise keep the centre of the view where it was. A sheet laid out while the panel was hidden is fitted.
    const wasEmpty = W <= 1 || H <= 1;
    const [cu, cv] = toSheet(W / 2, H / 2);
    W = w; H = h;
    canvas.width = W; canvas.height = H;
    if (sheet && (wasEmpty || fitted)) { fit(); return; }
    if (sheet) { vx = cu - W / 2 / s; vy = cv + H / 2 / s; }
    invalidate(true);
  }
  new ResizeObserver(() => resize()).observe(stage);

  async function setSheet(next, onProgress) {
    const token = ++prepToken;
    sheet = next; groups = []; texts = []; cache = null; items = null; views = []; selId = null; byId = null; evidence = null;
    if (!sheet) { requestDraw(); return; }
    box = sheetBox(sheet);
    const G = 16, gw = (box[2] - box[0]) / G || 1, gh = (box[3] - box[1]) / G || 1;
    const byStyle = new Map();
    const paths = sheet.paths;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i], pts = p.pts;
      if (!pts?.length) continue;
      const stroke = p.stroke !== false, fill = !!p.fill;
      const color = inkColor(p.color);
      const width = p.width > 0 ? +p.width.toPrecision(2) : 0;
      const key = `${color}|${width}|${p.dash ? 1 : 0}|${fill ? 1 : 0}|${stroke ? 1 : 0}`;
      let g = byStyle.get(key);
      if (!g) byStyle.set(key, (g = { color, width, dash: !!p.dash, fill, stroke, cells: new Map() }));
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      const cx = Math.min(G - 1, Math.max(0, Math.floor(((x0 + x1) / 2 - box[0]) / gw)));
      const cy = Math.min(G - 1, Math.max(0, Math.floor(((y0 + y1) / 2 - box[1]) / gh)));
      let cell = g.cells.get(cy * G + cx);
      if (!cell) g.cells.set(cy * G + cx, (cell = { path: new Path2D(), bb: [Infinity, Infinity, -Infinity, -Infinity] }));
      cell.path.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) cell.path.lineTo(pts[k][0], pts[k][1]);
      if (pts.length === 1) cell.path.lineTo(pts[0][0] + 1e-6, pts[0][1]);
      if (p.closed) cell.path.closePath();
      const bb = cell.bb;
      if (x0 < bb[0]) bb[0] = x0; if (y0 < bb[1]) bb[1] = y0; if (x1 > bb[2]) bb[2] = x1; if (y1 > bb[3]) bb[3] = y1;
      if ((i & 32767) === 32767) {
        onProgress?.(i / paths.length);
        await nextFrame();
        if (token !== prepToken) return; // another sheet was chosen meanwhile
      }
    }
    groups = [...byStyle.values()].map((g) => ({ ...g, cells: [...g.cells.values()] }));
    // Fills first, dashed (centre and hidden) lines next, solid lines on top.
    groups.sort((a, b) => (b.fill - a.fill) || (b.dash - a.dash) || (a.width - b.width));
    texts = (sheet.texts ?? []).filter((t) => t.text && Array.isArray(t.at) && t.height > 0);
    onProgress?.(1);
    resize();
    fit();
  }

  // Fit the sheet into the part of the canvas the legend leaves free (inset at the bottom, in CSS px).
  function fit() {
    if (!sheet) return;
    const h = Math.max(H * 0.5, H - insetBottom * dpr);
    const m = 0.04, bw = (box[2] - box[0]) * (1 + 2 * m), bh = (box[3] - box[1]) * (1 + 2 * m);
    s = Math.min(W / bw, h / bh);
    vx = (box[0] + box[2]) / 2 - W / 2 / s;
    vy = (box[1] + box[3]) / 2 + h / 2 / s;
    fitted = true;
    invalidate(true);
  }

  // Centre a sheet point at a closer zoom (an unresolved item, a view chosen in the table); with marker: true a ring
  // pulses there for a moment, so the eye finds the place.
  function reveal(at, span, { marker = false } = {}) {
    if (!sheet || !Array.isArray(at)) return;
    const fitS = Math.min(W / (box[2] - box[0]), H / (box[3] - box[1]));
    s = span ? Math.min(W / span[0], H / span[1]) * 0.8 : Math.max(s, fitS * 6); // about a sixth of the sheet across
    vx = at[0] - W / 2 / s; vy = at[1] + H / 2 / s;
    fitted = false;
    if (marker) { pulse = { at, until: performance.now() + 1600 }; animatePulse(); }
    invalidate(true);
  }
  function animatePulse() {
    requestDraw();
    if (pulse && performance.now() < pulse.until) requestAnimationFrame(animatePulse);
    else { pulse = null; requestDraw(); }
  }

  function invalidate(now = false) {
    requestDraw();
    clearTimeout(cacheTimer);
    if (now) cacheTimer = setTimeout(renderCache, 0);
    else cacheTimer = setTimeout(renderCache, 160);
  }

  function cacheCovers() {
    if (!cache || cache.s !== s) return false;
    const [u0, v1] = toSheet(0, 0), [u1, v0] = toSheet(W, H);
    if (u1 < box[0] || u0 > box[2] || v1 < box[1] || v0 > box[3]) return true; // the view is off the sheet: nothing to draw
    const c = cache;
    const cu1 = c.x0 + c.w / s, cv0 = c.y1 - c.h / s;
    const clip = (a, lo, hi) => Math.min(Math.max(a, lo), hi);
    // Outside the sheet there is nothing to draw: only the part of the view on the sheet must be covered.
    return clip(u0, box[0], box[2]) >= c.x0 - 1e-9 && clip(u1, box[0], box[2]) <= cu1 + 1e-9 && clip(v1, box[1], box[3]) <= c.y1 + 1e-9 && clip(v0, box[1], box[3]) >= cv0 - 1e-9;
  }

  function renderCache() {
    if (!sheet) return;
    if (cacheCovers()) return;
    const vw = W / s, vh = H / s;
    let x0 = Math.max(vx - vw / 2, box[0]), x1 = Math.min(vx + vw * 1.5, box[2]);
    let y1 = Math.min(vy + vh / 2, box[3]), y0 = Math.max(vy - vh * 1.5, box[1]);
    if (x1 <= x0 || y1 <= y0) { cache = { canvas: null, s, x0: vx, y1: vy, w: W, h: H }; requestDraw(); return; }
    let w = Math.ceil((x1 - x0) * s), h = Math.ceil((y1 - y0) * s);
    // Memory: at most ~24 million pixels (≈ 96 MB); a larger margin is not worth it.
    if (w * h > 24e6) {
      x0 = Math.max(vx, box[0]); x1 = Math.min(vx + vw, box[2]); y1 = Math.min(vy, box[3]); y0 = Math.max(vy - vh, box[1]);
      w = Math.ceil((x1 - x0) * s); h = Math.ceil((y1 - y0) * s);
    }
    const c = cache?.canvas ?? document.createElement('canvas');
    c.width = Math.max(1, w); c.height = Math.max(1, h);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.setTransform(s, 0, 0, -s, -x0 * s, y1 * s);
    g.lineJoin = 'round'; g.lineCap = 'round';
    const hair = 0.8 * dpr / s;
    for (const gr of groups) {
      g.strokeStyle = gr.color;
      g.fillStyle = gr.color;
      g.lineWidth = Math.max(gr.width, hair);
      g.globalAlpha = gr.dash ? 0.55 : 1;
      g.setLineDash(gr.dash ? [6 * dpr / s, 4 * dpr / s] : []);
      for (const cell of gr.cells) {
        const b = cell.bb;
        if (b[2] < x0 || b[0] > x1 || b[3] < y0 || b[1] > y1) continue;
        if (gr.fill) { g.globalAlpha = 0.18; g.fill(cell.path, 'evenodd'); g.globalAlpha = gr.dash ? 0.55 : 1; }
        if (gr.stroke) g.stroke(cell.path);
      }
    }
    g.setLineDash([]);
    g.globalAlpha = 1;
    // Text where it is big enough to read; drawn upright in screen space (the sheet transform flips y).
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#1d2430';
    g.textBaseline = 'alphabetic';
    let drawn = 0;
    for (const t of texts) {
      const px = t.height * s;
      if (px < 3.5 * dpr || px > 400 * dpr) continue;
      const [u, v] = t.at;
      if (u < x0 - t.height * 20 || u > x1 || v < y0 || v > y1 + t.height) continue;
      g.setTransform(1, 0, 0, 1, (u - x0) * s, (y1 - v) * s);
      if (t.angle) g.rotate(-t.angle * Math.PI / 180);
      g.font = `${px.toFixed(1)}px system-ui, sans-serif`;
      g.fillText(t.text, 0, 0);
      if (++drawn > 40000) break;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    cache = { canvas: c, s, x0, y1, w: c.width, h: c.height };
    requestDraw();
  }

  function requestDraw() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }

  function draw() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#e9edf2';
    ctx.fillRect(0, 0, W, H);
    if (!sheet) return;
    // The paper, then the cached line work (scaled while a zoom is in progress).
    const [px0, py0] = toScreen(box[0], box[3]), [px1, py1] = toScreen(box[2], box[1]);
    ctx.fillStyle = '#fff';
    ctx.fillRect(px0, py0, px1 - px0, py1 - py0);
    if (cache?.canvas) {
      const k = s / cache.s;
      const [dx, dy] = toScreen(cache.x0, cache.y1);
      ctx.imageSmoothingEnabled = k !== 1;
      ctx.drawImage(cache.canvas, dx, dy, cache.w * k, cache.h * k);
    }
    // No invalidate() here: every change of the view schedules the sharp redraw itself, and doing it from the frame
    // would restart its timer on every frame, so it would never run.
    drawViews();
    if (items) drawItems();
    if (evidence) drawEvidence();
    if (pulse) {
      const [X, Y] = toScreen(pulse.at[0], pulse.at[1]);
      const k = 1 - Math.max(0, pulse.until - performance.now()) / 1600;
      ctx.save();
      ctx.strokeStyle = '#f97316'; ctx.globalAlpha = 1 - k; ctx.lineWidth = 3 * dpr;
      ctx.beginPath(); ctx.arc(X, Y, (14 + 40 * k) * dpr, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }

  // Evidence on top of everything, in orange: the exact paths and texts an element was read from.
  function drawEvidence() {
    ctx.save();
    ctx.strokeStyle = '#f97316';
    ctx.lineWidth = 3 * dpr;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const e of evidence) {
      if (e.pts) { const p = pathOf(e.pts); if (e.closed) p.closePath(); ctx.stroke(p); }
      else if (e.text) {
        const b = e.box ?? [e.at[0], e.at[1], e.at[0] + e.height * 0.6 * String(e.text).length, e.at[1] + e.height];
        const [x0, y0] = toScreen(b[0], b[3]), [x1, y1] = toScreen(b[2], b[1]);
        ctx.strokeRect(x0 - 2 * dpr, y0 - 2 * dpr, x1 - x0 + 4 * dpr, y1 - y0 + 4 * dpr);
      }
    }
    ctx.restore();
  }

  function drawViews() {
    ctx.save();
    ctx.font = `${12 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = 'top';
    for (const v of views) {
      if (!Array.isArray(v.box)) continue;
      const [x0, y0] = toScreen(v.box[0], v.box[3]), [x1, y1] = toScreen(v.box[2], v.box[1]);
      const color = KIND_COLOR[v.kind] ?? KIND_COLOR.other;
      const hi = hiView === v.id;
      ctx.globalAlpha = items ? 0.35 : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = (hi ? 3 : 1.5) * dpr;
      ctx.setLineDash(v.kind === 'ignore' ? [5 * dpr, 4 * dpr] : []);
      if (hi) { ctx.fillStyle = color; ctx.globalAlpha = 0.08; ctx.fillRect(x0, y0, x1 - x0, y1 - y0); ctx.globalAlpha = 1; }
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
      const text = `${v.kind}${v.deckName ? ` · ${v.deckName}` : ''}${Number.isFinite(v.confidence) ? ` · ${Math.round(v.confidence * 100)} %` : ''}${v.edited ? ' · edited' : ''}`;
      const tw = ctx.measureText(text).width + 10 * dpr;
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0 - 18 * dpr, tw, 18 * dpr);
      ctx.fillStyle = '#fff';
      ctx.fillText(text, x0 + 5 * dpr, y0 - 15 * dpr);
    }
    ctx.restore();
  }

  function pathOf(pts) {
    const p = new Path2D();
    pts.forEach(([u, v], i) => { const [X, Y] = toScreen(u, v); if (i) p.lineTo(X, Y); else p.moveTo(X, Y); });
    return p;
  }

  // Recognised elements over the sheet. Rooms are filled clearly (about a third opaque, with an outline), so they read
  // at full-sheet zoom too; doors are red arcs with their leaf, openings green, stairs violet with treads, and a "?"
  // marks a label that was seen but not converted.
  function drawItems() {
    ctx.save();
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (const it of items) {
      const hi = it.id === hiItem || it.id === selId;
      if (it.kind === 'room' || it.kind === 'stair') {
        const p = pathOf(it.poly);
        p.closePath();
        for (const h of it.holes ?? []) { const hp = pathOf(h); hp.closePath(); p.addPath(hp); }
        ctx.fillStyle = it.color;
        ctx.globalAlpha = hi ? 0.62 : 0.38;
        ctx.fill(p, 'evenodd');
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = hi ? '#1f6feb' : it.color;
        ctx.lineWidth = (hi ? 3 : 1.5) * dpr;
        ctx.stroke(p);
        ctx.globalAlpha = 1;
        if (it.treads) { ctx.lineWidth = 1 * dpr; ctx.strokeStyle = it.color; for (const l of it.treads) ctx.stroke(pathOf(l)); }
      } else if (it.kind === 'wall') {
        ctx.strokeStyle = hi ? '#1f6feb' : it.color;
        ctx.globalAlpha = 0.8;
        ctx.lineWidth = Math.max(it.width * s, 1.5 * dpr);
        ctx.stroke(pathOf(it.line));
        ctx.globalAlpha = 1;
      } else if (it.kind === 'opening') {
        ctx.strokeStyle = hi ? '#1f6feb' : it.color;
        ctx.lineWidth = (hi ? 5 : 3.5) * dpr;
        ctx.setLineDash([4 * dpr, 3 * dpr]);
        ctx.stroke(pathOf(it.line));
        ctx.setLineDash([]);
      } else if (it.kind === 'door') {
        ctx.strokeStyle = hi ? '#1f6feb' : it.color;
        ctx.lineWidth = (hi ? 3.5 : 2.5) * dpr;
        ctx.stroke(pathOf(it.arc));
        ctx.stroke(pathOf(it.leaf));
      }
    }
    // Markers last, on top, at a fixed screen size.
    ctx.font = `bold ${12 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const it of items) {
      if (it.kind !== 'marker') continue;
      const [X, Y] = markerXY(it);
      const r = (it.id === hiItem ? 11 : 9) * dpr;
      ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2);
      ctx.fillStyle = it.color; ctx.fill();
      ctx.lineWidth = 2 * dpr; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.fillText('?', X, Y + 0.5 * dpr);
    }
    ctx.restore();
  }

  // A marker sits just above and right of its label's position, so the label itself stays readable.
  function markerXY(it) { const [X, Y] = toScreen(it.at[0], it.at[1]); return [X + 12 * dpr, Y - 14 * dpr]; }

  // Hit test, in sheet units: markers and doors first (small, on top), then openings, stairs and rooms (smallest
  // first), walls; without the overlay, the views.
  function hitAt(X, Y) {
    const [u, v] = toSheet(X, Y);
    if (items) {
      const order = { marker: -1, door: 0, opening: 0.5, stair: 1, room: 2, wall: 3 };
      const tol = 4 * dpr / s;
      let best = null, bestKey = Infinity;
      for (const it of items) {
        let inside = false, area = 0;
        if (it.kind === 'marker') { const [mx, my] = markerXY(it); inside = Math.hypot(mx - X, my - Y) <= 11 * dpr; }
        else if (it.poly) { inside = pointInPolygon(u, v, it.poly); area = Math.abs(polygonArea(it.poly)); }
        else if (it.line) inside = distToSegment(u, v, it.line[0], it.line[1]) <= Math.max(it.width / 2, tol);
        if (!inside) continue;
        const key = order[it.kind] * 1e30 + area;
        if (key < bestKey) { bestKey = key; best = it; }
      }
      if (best) return { item: best, tip: best.tip };
      return null;
    }
    let best = null;
    for (const vw of views) {
      const b = vw.box;
      if (!b || u < b[0] || u > b[2] || v < b[1] || v > b[3]) continue;
      if (!best || (b[2] - b[0]) * (b[3] - b[1]) < (best.box[2] - best.box[0]) * (best.box[3] - best.box[1])) best = vw;
    }
    return best ? { view: best, tip: `${best.kind}${best.deckName ? ` · ${best.deckName}` : ''}${best.title ? ` (“${best.title}”)` : ''}: ${(best.why ?? []).slice(0, 3).join('; ') || 'no evidence recorded'}` } : null;
  }

  // ---- input ----
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !sheet) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, vx, vy, moved: false };
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!sheet) return;
    if (drag) {
      const dx = (e.clientX - drag.x) * dpr, dy = (e.clientY - drag.y) * dpr;
      if (Math.abs(dx) + Math.abs(dy) > 3 * dpr) { drag.moved = true; fitted = false; }
      vx = drag.vx - dx / s; vy = drag.vy + dy / s;
      invalidate(false); // the bitmap moves at once; the part that comes into view is drawn when the drag pauses
      return;
    }
    const r = canvas.getBoundingClientRect();
    const hit = hitAt((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr);
    const id = hit?.item?.id ?? null, vid = items ? null : hit?.view?.id ?? null;
    if (id !== hiItem || (!items && vid !== hiView)) { hiItem = id; if (!items) hiView = vid; requestDraw(); }
    canvas.style.cursor = hit ? 'pointer' : 'grab';
    onHover?.(hit, e.clientX - r.left, e.clientY - r.top);
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) { invalidate(false); return; }
    const r = canvas.getBoundingClientRect();
    onClick?.(hitAt((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr));
  });
  canvas.addEventListener('pointerleave', () => { if (!drag) { hiItem = null; requestDraw(); onHover?.(null); } });
  canvas.addEventListener('dblclick', (e) => {
    const r = canvas.getBoundingClientRect();
    onDblClick?.(hitAt((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr));
  });
  const zoomAt = (X, Y, factor) => {
    const [u, v] = toSheet(X, Y);
    const fitS = Math.min(W / (box[2] - box[0]), H / (box[3] - box[1]));
    s = Math.min(Math.max(s * factor, fitS / 4), fitS * 4000);
    vx = u - X / s; vy = v + Y / s;
    fitted = false;
    invalidate(false);
  };
  canvas.addEventListener('wheel', (e) => {
    if (!sheet) return;
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    const d = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
    zoomAt((e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr, Math.exp(-d * 0.0015));
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    if (!sheet) return;
    const step = 80 * dpr / s;
    const keys = {
      '+': () => zoomAt(W / 2, H / 2, 1.4), '=': () => zoomAt(W / 2, H / 2, 1.4), '-': () => zoomAt(W / 2, H / 2, 1 / 1.4),
      ArrowLeft: () => { vx -= step; fitted = false; invalidate(false); }, ArrowRight: () => { vx += step; fitted = false; invalidate(false); },
      ArrowUp: () => { vy += step; fitted = false; invalidate(false); }, ArrowDown: () => { vy -= step; fitted = false; invalidate(false); },
      f: fit, F: fit,
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  });

  return {
    setSheet, fit, resize, reveal,
    setInsetBottom(px) { if (px === insetBottom) return; insetBottom = px; if (fitted) fit(); },
    setViews(v) { views = v ?? []; requestDraw(); },
    highlightView(id, { reveal: show = false } = {}) {
      hiView = id;
      const v = show && views.find((x) => x.id === id);
      // Bring the view into sight when it is off screen (keyboard navigation through the table).
      if (v?.box) {
        const [X0, Y0] = toScreen(v.box[0], v.box[3]), [X1, Y1] = toScreen(v.box[2], v.box[1]);
        if (X1 < 0 || X0 > W || Y1 < 0 || Y0 > H) reveal([(v.box[0] + v.box[2]) / 2, (v.box[1] + v.box[3]) / 2], [v.box[2] - v.box[0], v.box[3] - v.box[1]]);
      }
      requestDraw();
    },
    setItems(list) { items = list; hiItem = null; if (!list) evidence = null; requestDraw(); },
    setEvidence(ids) {
      if (!sheet || !ids?.length) { if (evidence) { evidence = null; requestDraw(); } return; }
      if (!byId) {
        byId = new Map();
        for (const p of sheet.paths) if (p.id != null) byId.set(p.id, p);
        for (const t of sheet.texts ?? []) if (t.id != null) byId.set(t.id, t);
      }
      evidence = ids.map((id) => byId.get(id)).filter((x) => x && (x.pts?.length || (x.text && Array.isArray(x.at))));
      requestDraw();
    },
    selectItem(id) { selId = id; requestDraw(); },
  };
}

function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polygonArea(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]);
  return a / 2;
}
function distToSegment(x, y, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
  return Math.hypot(x - ax - t * dx, y - ay - t * dy);
}

// Page thumbnails: a sample of the paths straight onto a small canvas (no Path2D cache for a picture this size).
function drawThumb(canvas, sheet) {
  const g = canvas.getContext('2d');
  const b = sheetBox(sheet);
  const k = Math.min(canvas.width / (b[2] - b[0]), canvas.height / (b[3] - b[1])) * 0.94;
  const ox = (canvas.width - (b[2] - b[0]) * k) / 2, oy = (canvas.height - (b[3] - b[1]) * k) / 2;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = '#1d2430';
  g.lineWidth = 0.5;
  g.beginPath();
  const paths = sheet.paths, step = Math.max(1, Math.floor(paths.length / 40000));
  for (let i = 0; i < paths.length; i += step) {
    const pts = paths[i].pts;
    if (!pts?.length) continue;
    g.moveTo(ox + (pts[0][0] - b[0]) * k, oy + (b[3] - pts[0][1]) * k);
    for (let j = 1; j < pts.length; j++) g.lineTo(ox + (pts[j][0] - b[0]) * k, oy + (b[3] - pts[j][1]) * k);
  }
  g.stroke();
}
