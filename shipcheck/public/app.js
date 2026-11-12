// ShipCheck UI. The pass/fail decision always comes from the shared deterministic checker
// (src/checker.mjs), which runs right here in the browser so edits re-check instantly.
import { checkModel, recheckElements, normalizeModel, findingsOf, readValue, UNIT_TO_MM, STATUS_RANK } from './src/checker.mjs';
import { scoreResults, scoreLine, badgeText } from './src/score.mjs';
import { partsToModel } from './src/parts-model.mjs';
import { reportRows, toCSV, toHTML } from './src/report.mjs';
import { traceMatrix, traceCSV, cellLabel } from './src/trace.mjs';
import { createViewer, STATUS_HEX } from './viewer3d.js';
import { analyzeEscape, ESCAPE_LABEL } from './src/escape.mjs';
import { compareRevisions } from './src/compare.mjs';
import { verifySuggestion } from './src/escape-actions.mjs';
import { consistencyIssues, widthCheck } from './src/consistency.mjs';
import { DISPOSITIONS, DISPOSITION_LABEL, needsNote, findingKey, registerRows, registerSummary, withDisposition, registerCSV, projectKey } from './src/dispositions.mjs';
import { createFallbackViewer } from './viewer-fallback.js';
import { createLocalViewer } from './viewer-stream.js';
import { loadOfficialText } from './regulation-text.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 'no-cache' (not 'no-store'): the browser keeps catalogs and model data in its HTTP cache and revalidates them with
// the server's ETag, so an unchanged dataset costs one 304 round trip instead of a full download.
const fetchJSON = async (u, opt) => {
  const response = await fetch(u, { cache: 'no-cache', ...opt });
  if (!response.ok) {
    const body = await response.text();
    let detail = '';
    try {
      const error = JSON.parse(body);
      detail = error?.error?.message || error?.detail || (typeof error?.error === 'string' ? error.error : '');
    } catch { /* use the status when the server does not return JSON */ }
    throw new Error(`${u}: ${response.status}${detail ? ` (${detail})` : ''}`);
  }
  return response.json();
};
const CATALOG_BY_FILE = {
  'rules.json': 'rules',
  'scenarios.json': 'scenarios',
  'ships/rcrv/parts.json': 'model-rcrv-parts',
  'ships/rcrv/rcrv-3d.meta.json': 'model-rcrv-meta',
  'ships/rcrv/results-3d.json': 'model-rcrv-precomputed',
  'ships/rcrv/inside.json': 'model-rcrv-inside',
  'ships/cruise/deck.json': 'model-cruise-deck',
  'ships/rcrv/layout.json': 'model-rcrv-layout',
  'tests/expected/rcrv-3d.json': 'expected-rcrv-3d',
  'tests/expected/rcrv-inside.json': 'expected-rcrv-inside',
  'tests/expected/cruise.json': 'expected-cruise',
  'tests/expected/rcrv-layout.json': 'expected-rcrv-layout',
};
const fetchCatalog = (file, opt) => {
  const sourceKey = CATALOG_BY_FILE[file];
  if (!sourceKey) return Promise.reject(new Error(`No database catalog is configured for ${file}`));
  return fetchJSON(`api/catalog/${sourceKey}`, opt);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LABEL = { compliant: 'Compliant', non_compliant: 'Non-compliant', not_enough_info: 'Not enough info', null: 'No rule' };
const ORDER = { non_compliant: 0, not_enough_info: 1, compliant: 2, null: 3 };
const EDIT_SOURCE = 'what-if, not in model';

export function family(source = '') {
  if (/ADA|PVAG/.test(source)) return 'ADA / PVAG';
  if (/SOLAS|FSS/.test(source)) return 'SOLAS / FSS';
  if (/IGF/.test(source)) return 'IGF Code';
  if (/Load Lines/.test(source)) return 'Load Line';
  if (/MARPOL/.test(source)) return 'MARPOL';
  if (/IGC/.test(source)) return 'IGC Code';
  if (/IACS/.test(source)) return 'IACS unified requirements';
  if (/data quality/i.test(source)) return 'Data quality';
  if (/DNV|Lloyd|class/i.test(source)) return 'Class rules';
  return source;
}

function provClass(src = '') {
  if (/edited|what-if/.test(src)) return 'edit';
  if (/planted/.test(src)) return 'plant';
  if (/derived by (ShipCheck|Complee)|not in the model/.test(src)) return 'der';
  if (/public|GA drawing|ShipConstructor model|viewer dbId/.test(src)) return 'pub';
  if (/estimated|assumed/.test(src)) return 'est';
  return '';
}
const prov = (src) => (src ? `<span class="prov ${provClass(src)}" title="${esc(src)}">${esc(src.length > 34 ? src.slice(0, 32) + '…' : src)}</span>` : '');

const S = {
  scenarios: [], sc: null, pristine: null, model: null, norm: null,
  coreRules: [], expected: null, baseline: null, results: null,
  selected: null, edits: new Map(),
  filter: { status: new Set(['non_compliant', 'not_enough_info', 'compliant', 'null']), family: '', deck: '' },
  lastCheckMs: 0, demo: null, ruleView: null,
  escape: null, escapeOn: false, blocked: new Set(),
  register: {}, compare: null,
};
const allRules = () => S.coreRules;
const ruleById = (id) => allRules().find((r) => r.id === id);
// Element lookup by id: a Map rebuilt when the model changes (the parts model has ~70,000 elements).
let elementIndex = new Map(), elementIndexOf = null;
const elById = (id) => {
  if (elementIndexOf !== S.model) { elementIndexOf = S.model; elementIndex = new Map((S.model?.elements || []).map((e) => [e.id, e])); }
  return elementIndex.get(id);
};
const deckName = (id) => S.norm.decks.find((d) => d.id === id)?.name ?? id;

// Scenario requests and viewer ownership use monotonic generations: A -> B -> A is still a new load.
let scenarioGeneration = 0, scenarioController = null, scenarioPending = false;
let viewerGeneration = 0, activeViewerGeneration = 0;
let localInitialization = null;
const canPick = () => !scenarioPending && activeViewerGeneration === viewerGeneration;
const onPick = (id) => { if (canPick() && S.results?.elements[id]) select(id, { fly: viewer?.kind === 'local' }); };
const views = { three: createViewer($('#threeView'), { onPick: (id) => { if (viewer === views.three) onPick(id); } }), local: null, fallback: null };
let viewer = views.three;
const LIST_PAGE = 400;
let listLimit = LIST_PAGE;
let restRequest = 0;

// Share construction itself, rather than assigning only after an awaited constructor finishes.
function getLocalViewer() {
  if (views.local) return Promise.resolve(views.local);
  if (!localInitialization) {
    localInitialization = createLocalViewer($('#localView'), {
      onPick: (id) => { if (viewer === views.local) onPick(id); },
      onPickRest: (db) => { if (viewer === views.local && canPick()) onPickRest(db); },
    }).then((local) => {
      views.local = local;
      local.setActive?.(false); // no scenario owns a newly constructed viewer until its current continuation claims it
      return local;
    }).catch((e) => { localInitialization = null; throw e; });
  }
  return localInitialization;
}

function clearCutControl() { $('#cutSel').value = ''; }
function showOverview() { clearCutControl(); viewer.overview(); }

// Findings appear immediately. Only the current generation may activate a viewer or change fallback UI.
const NOOP_VIEWER = { build() {}, update() {}, paintNeutral() {}, select() {}, flyToElement() {}, setFilter() {}, overview() {}, setMode() {}, setPlan() {}, mode: 'all', plan: false };
function useViewer(sc) {
  const generation = ++viewerGeneration;
  const current = () => generation === viewerGeneration && !scenarioPending;
  const want = sc.viewer === 'local' ? 'local' : 'three';
  // Staying in the real-model viewer (real ship <-> corridor scene): keep its geometry and keep it on screen.
  const stayLocal = want === 'local' && !$('#localView').hidden;
  views.local?.setActive?.(false, { keepTiles: stayLocal });
  $('#threeView').hidden = want !== 'three';
  $('#apsView').hidden = true;
  if (!stayLocal) $('#localView').hidden = true;
  $('#fallbackView').hidden = true;
  $('#planBtn').hidden = want !== 'three';
  $('#viewTools').hidden = want !== 'three';
  // The real model uses its deck cut. SWBS groups are not decks, and it has no exploded-deck mode.
  $('#deck').disabled = want !== 'three';
  const deckControl = $('#deck').closest('label');
  deckControl.hidden = want !== 'three';
  deckControl.style.display = want === 'three' ? '' : 'none'; // header label CSS overrides the UA [hidden] display rule
  $('#simpleBtn').hidden = $('#cutSel').hidden = $('#fullBtn').hidden = true;
  $('#simpleBtn').classList.remove('on');
  clearCutControl();
  if (want === 'three') {
    viewer = views.three;
    activeViewerGeneration = generation;
    S.viewerReady = Promise.resolve('three');
    return;
  }
  views.fallback ??= createFallbackViewer($('#fallbackView'));
  views.fallback.setImages(sc.fallback_images || []);
  viewer = NOOP_VIEWER;
  // The RCRV uses the local model gateway; if it is unavailable, show saved screenshots with an explicit reason.
  const params = new URLSearchParams(location.search);
  const showControls = () => {
    $('#simpleBtn').classList.toggle('on', !!viewer.simple);
    $('#simpleBtn').hidden = $('#cutSel').hidden = false;
    $('#fullBtn').hidden = !viewer.hasRest;
    $('#fullBtn').classList.toggle('on', !!viewer.fullModel);
    // A scene inside the real ship (corridor example) has its own fixed cut-away view.
    if (sc.scene) $('#simpleBtn').hidden = $('#cutSel').hidden = $('#fullBtn').hidden = true;
    $('#cutSel').innerHTML = '<option value="">No deck cut</option>';
    clearCutControl();
  };
  S.viewerReady = (async () => {
    try {
      if (params.has('noaps')) throw new Error('3D model loading disabled by ?noaps');
      $('#localView').hidden = false;
      const local = await getLocalViewer();
      if (!current()) return 'stale';
      local.build(S.norm, S.results);
      await local.load();
      if (!current()) return 'stale';
      viewer = local;
      activeViewerGeneration = generation;
      viewer.build(S.norm, S.results);
      showControls();
      renderList();
      if (S.selected) select(S.selected);
      return 'local';
    } catch (e) {
      if (!current()) return 'stale'; // an old failure must not stop a viewer claimed by a newer load
      views.local?.setActive?.(false);
      console.warn('Model gateway unavailable; using saved screenshots:', e.message);
      views.fallback.setReason(e.message);
      $('#localView').hidden = true;
      $('#fallbackView').hidden = false;
      viewer = views.fallback;
      activeViewerGeneration = generation;
      viewer.build();
      if (S.selected) select(S.selected);
      return 'fallback';
    }
  })();
}

// ---------- loading ----------

async function init() {
  const [scenarioCatalog, core] = await Promise.all([fetchCatalog('scenarios.json'), fetchCatalog('rules.json')]);
  S.scenarios = scenarioCatalog.scenarios;
  S.coreRules = core.rules;
  $('#scenario').innerHTML = S.scenarios.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const want = new URLSearchParams(location.search).get('scenario');
  await loadScenario(S.scenarios.find((s) => s.id === want)?.id ?? S.scenarios[0].id);
}

// Real production models come as a parts file (kind "parts") and are turned into a checker model here,
// in the browser. If the parts file cannot be loaded, the precomputed results are shown read-only.
async function fetchModel(sc, { signal } = {}) {
  const options = { signal };
  if (sc.modelData) return { model: structuredClone(sc.modelData) }; // opened from a file
  if (sc.kind !== 'parts') return { model: await fetchCatalog(sc.model, options) };
  try {
    const [parts, meta] = await Promise.all([fetchCatalog(sc.model, options), sc.meta ? fetchCatalog(sc.meta, options) : {}]);
    return { model: partsToModel(parts, meta) };
  } catch (e) {
    if (signal?.aborted || e.name === 'AbortError' || !sc.precomputed) throw e;
    const [pre, meta] = await Promise.all([
      fetchCatalog(sc.precomputed, options),
      sc.meta ? fetchCatalog(sc.meta, options).catch((error) => { if (signal?.aborted) throw error; return {}; }) : {},
    ]);
    return { model: modelFromPrecomputed(pre, meta), precomputed: pre };
  }
}

function modelFromPrecomputed(pre, meta) {
  const els = new Map();
  for (const f of pre.findings) if (!els.has(f.element)) els.set(f.element, { id: f.element, objectid: f.objectid, type: 'part', name: f.name, deck: f.deck, props: {} });
  const decks = [...new Set(pre.findings.map((f) => f.deck))].map((d) => ({ id: d, name: d, outline: [] }));
  return { name: `${meta.name ?? pre.model} (precomputed, read-only)`, units: 'mm', kind: 'parts', ship: meta.ship ?? {}, decks, elements: [...els.values()],
    provenance_note: `Parts file not available: showing the precomputed results of ${pre.generated}. Editing is disabled.` };
}

function resultsFromPrecomputed(pre) {
  const rules = Object.fromEntries(allRules().map((r) => [r.id, r]));
  const elements = {};
  for (const f of pre.findings) {
    const e = (elements[f.element] ??= { id: f.element, name: f.name, type: 'part', deck: f.deck, worst: null, results: [], not_applicable: [], governing: {} });
    e.results.push({ ...f, rule_text: rules[f.rule_id]?.text ?? '', related: [] });
    if ((STATUS_RANK[f.status] ?? 0) > (STATUS_RANK[e.worst] ?? 0)) e.worst = f.status;
  }
  return { ...pre, elements };
}

async function loadScenario(id) {
  const sc = S.scenarios.find((s) => s.id === id);
  if (!sc) throw new Error(`Unknown scenario: ${id}`);
  const generation = ++scenarioGeneration;
  scenarioController?.abort();
  const controller = new AbortController();
  scenarioController = controller;
  scenarioPending = true;
  ++viewerGeneration; // invalidate pending viewer continuations immediately, including A -> B -> A
  restRequest++;
  $('#scenario').value = id;
  try {
    const [{ model, precomputed }, expected] = await Promise.all([
      fetchModel(sc, { signal: controller.signal }),
      sc.expected ? fetchCatalog(sc.expected, { signal: controller.signal }).catch((e) => {
        if (controller.signal.aborted) throw e;
        return null;
      }) : null,
    ]);
    loadingScreen.step('check', `${(model.elements?.length ?? 0).toLocaleString('en-GB')} design elements loaded`);
    if (generation !== scenarioGeneration || controller.signal.aborted) return false;
    S.sc = sc; // commit the scenario and its model together, after checking ownership
    S.precomputed = precomputed ?? null;
    S.pristine = model;
    S.model = structuredClone(model);
    S.norm = normalizeModel(S.model);
    S.expected = expected;
    S.edits.clear();
    S.register = loadRegister(sc, model);
    closeRegister();
    S.selected = null;
    S.ruleView = null;
    traceState = { findingsOnly: null, limit: TRACE_PAGE };
    closeTrace();
    listLimit = LIST_PAGE;
    // Start at the full overview; filtering by status hides the rest geometry.
    S.filter.status = new Set(['non_compliant', 'not_enough_info', 'compliant', 'null']);
    // Ground-truth score is computed on the unedited design with the core rule set only.
    S.baseline = precomputed ? precomputed.score : expected ? scoreResults(checkModel(S.pristine, S.coreRules), expected) : null;
    if (S.baseline && !S.baseline.line) S.baseline.line = scoreLine(S.baseline);
    runCheck();
    S.blocked = new Set();
    computeEscape();
    scenarioPending = false;
    useViewer(sc);
    views.three.setSource(sc.geometry ?? null);
    viewer.build(S.norm, S.results);
    viewer.setMode('all');
    syncEscapeView();
    const decks = S.norm.decks;
    $('#deck').innerHTML = `<option value="all">All decks</option>` +
      (decks.length > 1 ? `<option value="exploded">Exploded</option>` : '') +
      decks.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
    S.filter.deck = '';
    S.filter.text = '';
    S.compare = null;
    S.explain = new Map();
    S.escAi = null;
    setMeasureMode(false);
    renderAll();
    $('#detail').innerHTML = `<p class="muted">Click an element in the model or in the list to see every rule that applies, why it passes or fails, and where each value comes from.</p>`;
    return true;
  } catch (e) {
    if (generation !== scenarioGeneration || controller.signal.aborted || e.name === 'AbortError') return false;
    // A failed replacement leaves the previously committed scenario usable.
    if (S.sc && S.model) {
      scenarioPending = false;
      $('#scenario').value = S.sc.id;
      useViewer(S.sc);
      views.three.setSource(S.sc.geometry ?? null);
      viewer.build(S.norm, S.results);
      renderList();
    }
    throw e;
  } finally {
    if (generation === scenarioGeneration) {
      scenarioPending = false;
      scenarioController = null;
    }
  }
}

// ids: only these elements changed (what-if edit): re-check them alone where the rule set allows it.
function runCheck(ids) {
  const t0 = performance.now();
  S.results = S.precomputed ? resultsFromPrecomputed(S.precomputed)
    : ids && S.results ? recheckElements(S.results, S.model, allRules(), ids) : checkModel(S.model, allRules());
  S.lastCheckMs = performance.now() - t0;
}

function recheck(ids) {
  runCheck(ids);
  computeEscape();
  renderEscape();
  viewer.update(S.results, ids);
  syncEscapeView();
  renderSummary();
  renderRules();
  renderEdits();
  renderList();
  renderRegisterButton();
  if (S.compare?.diff) S.compare.diff = compareRevisions(S.compare.model, checkModel(structuredClone(S.compare.model), allRules()), S.model, S.results);
  if (!$('#registerPanel').hidden) openRegister();
  if (S.ruleView) { renderRuleView(S.ruleView); return; }
  if (S.selected) {
    renderResults(S.selected);
    renderComponent(S.selected);
    viewer.setLabel?.(S.selected, labelFor(S.selected), S.results.elements[S.selected]?.worst);
  }
}

// ---------- sidebar ----------

function renderAll() {
  renderShip();
  renderScore();
  renderSummary();
  renderRules();
  renderEdits();
  renderEscape();
  renderFilters();
  renderList();
  renderRegisterButton();
}

function renderShip() {
  const sh = S.model.ship || {};
  const row = (label, key, fmt = (v) => v) => {
    const v = readValue(sh[key], S.norm.units, sh.source);
    if (!v) return `<tr><td>${label}</td><td class="muted">not given</td></tr>`;
    return `<tr><td>${label}</td><td>${esc(fmt(v))}${prov(v.source)}</td></tr>`;
  };
  const len = (v) => (v.unit in UNIT_TO_MM ? `${(v.value * UNIT_TO_MM[v.unit] / 1000).toFixed(2)} m` : v.value);
  const list = (v) => [].concat(v.value).join(', ');
  $('#ship').innerHTML = `
    <h1>${esc(S.model.name)}</h1>
    <div class="muted">${S.model.kind === 'parts'
      ? `${S.norm.elements.length.toLocaleString('en')} parts checked${S.model.counts ? ` (of ${S.model.counts.kept.toLocaleString('en')} prepared from ${S.model.counts.objects.toLocaleString('en')} model objects)` : ''} · ${S.norm.decks.length} SWBS / system groups · source unit inch, shown in mm`
      : `${S.norm.decks.length} deck${S.norm.decks.length > 1 ? 's' : ''} · ${S.norm.elements.length} elements · model units ${esc(S.norm.units)} · schema ${esc(S.norm.schema)}`}</div>
    <table class="kv" style="margin-top:6px">
      ${row('Ship type', 'type', (v) => v.value)}
      ${row('Operating area', 'operating_area', list)}
      ${row('Length overall', 'length_overall', len)}
      ${row('Beam', 'beam', len)}
      ${row('Draft', 'draft', len)}
      ${row('Berths', 'berths', (v) => v.value)}
      ${row('Gross tonnage', 'gross_tonnage', (v) => v.value)}
      ${row('Class society', 'class_society', (v) => v.value)}
      ${sh.propulsion ? row('Propulsion', 'propulsion', (v) => v.value) : ''}
    </table>
    ${S.model.provenance_note ? `<div class="note">${esc(S.model.provenance_note)}</div>` : ''}
    ${S.model.scope_note ? `<div class="note scope">${esc(S.model.scope_note)}</div>` : ''}
    ${S.model.kind === 'parts' ? '' : '<button class="tiny" id="dlModel" style="margin-top:6px" title="The model as a ship/1 JSON file: the format Open… reads">Download model (JSON)</button>'}`;
  if ($('#dlModel')) $('#dlModel').onclick = () => download(`${S.sc.id}.json`, JSON.stringify(S.model, null, 1), 'application/json');
}

// Draft rules are only mentioned where the model has elements they would apply to.
function relevantDrafts() {
  const types = new Set(S.norm.elements.map((e) => e.type));
  return (S.results.draft_rules || []).filter((d) => (ruleById(d.id)?.applies_to?.types || []).some((t) => types.has(t)));
}

function renderScore() {
  const b = S.baseline;
  const badge = $('#accBadge');
  badge.hidden = !b;
  if (b) {
    badge.className = `accbadge ${b.pass ? '' : 'bad'}`;
    badge.textContent = `${b.pass ? '✓' : '✗'} ${badgeText(b)}`;
  }
  const verified = S.coreRules.filter((r) => r.verified).length;
  $('#score').innerHTML = (b ? `
    <div class="scorebox ${b.pass ? 'pass' : 'fail'}" id="scorebox" title="Computed on the unedited design against the hand-checked expected findings (also run by npm test)">
      <b>${b.pass ? '✓' : '✗'} ${esc(scoreLine(b))}</b>
      <span class="muted">Ground truth for the unedited design</span>
    </div>` : '') +
    `<div class="muted" style="margin-top:6px">${allRules().length} rules · ${verified}/${S.coreRules.length} values verified against official text <a href="#" id="verifyLink" title="See VERIFY.md">(why?)</a></div>` +
    (relevantDrafts().length ? `<div class="drafts note">${relevantDrafts().map((d) =>
      `<b>${esc(d.id)}</b>: draft, not run. ${esc(d.reason)}`).join('<br>')}</div>` : '');
  $('#verifyLink').onclick = (e) => { e.preventDefault(); alert('All rule values are marked verified:false until the team has checked them against the official text. VERIFY.md lists each value with the source to check against.'); };
}

function renderSummary() {
  const s = S.results.summary, e = S.results.element_summary;
  $('#summary').innerHTML = `
    <div class="pills" id="pills">
      <div class="pill st-non_compliant">${s.non_compliant}<small>non-compliant</small></div>
      <div class="pill st-not_enough_info">${s.not_enough_info}<small>missing info</small></div>
      <div class="pill st-compliant">${s.compliant}<small>compliant</small></div>
    </div>
    <div class="muted">Rule checks per element. Elements: ${e.non_compliant} red, ${e.not_enough_info} amber, ${e.compliant} green, ${e.no_rule} without a rule. Checked in ${S.lastCheckMs.toFixed(1)} ms.</div>`;
  const issues = S.model.kind === 'parts' ? [] : consistencyIssues(S.norm);
  if (issues.length) {
    $('#summary').insertAdjacentHTML('beforeend', `<div class="note"><b>Data consistency:</b> ${issues.length} declared clear width${issues.length === 1 ? ' is' : 's are'} larger than the modelled geometry: ${issues.map((c) => `<a href="#" class="via" data-id="${esc(c.id)}">${esc(c.id)}</a>`).join(', ')}. The rule check reads the declared value.</div>`);
    $('#summary').querySelectorAll('a.via').forEach((n) => (n.onclick = (ev) => { ev.preventDefault(); select(n.dataset.id); }));
  }
}

function renderEdits() {
  const box = $('#edits');
  if (!S.edits.size) { box.innerHTML = ''; return; }
  box.innerHTML = `<h2>What-if values, not in model (${S.edits.size})</h2>` +
    [...S.edits.values()].map((x) => `<div class="na whatif"><code>${esc(x.id)}.${esc(x.key)}</code>: ${esc(x.before)} → <b>${esc(x.after)}</b>
      <button class="tiny resetOne" data-id="${esc(x.id)}" data-key="${esc(x.key)}" title="Back to the model value">reset</button></div>`).join('') +
    `<div class="row" style="display:flex;gap:6px;margin-top:6px"><button id="resetEdits">Reset all</button><button id="exportModel">Export edited model</button></div>`;
  box.querySelectorAll('.resetOne').forEach((b) => (b.onclick = () => resetEdit(b.dataset.id, b.dataset.key)));
  $('#resetEdits').onclick = () => loadScenario(S.sc.id);
  $('#exportModel').onclick = () => download(`${S.sc.id}-edited.json`, JSON.stringify(S.model, null, 1), 'application/json');
}

function renderFilters() {
  const fams = [...new Set(allRules().map((r) => family(r.source)))].sort();
  const chips = ['non_compliant', 'not_enough_info', 'compliant', 'null']
    .map((st) => `<span class="chip ${S.filter.status.has(st) ? 'on' : ''}" data-st="${st}">${LABEL[st]}</span>`).join('');
  $('#filters').innerHTML = `<div class="chips">${chips}</div>
    <div class="filters-row">
      <select id="fFam"><option value="">All rule sources</option>${fams.map((f) => `<option ${S.filter.family === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
      <select id="fDeck"><option value="">All decks</option>${S.norm.decks.map((d) => `<option value="${d.id}" ${S.filter.deck === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
    </div>
    <input id="fText" type="search" placeholder="Search id, name or type" value="${esc(S.filter.text ?? '')}" style="width:100%;margin-bottom:6px">`;
  $('#fText').oninput = (e) => { S.filter.text = e.target.value; listLimit = LIST_PAGE; renderList(); };
  document.querySelectorAll('#filters .chip').forEach((c) => (c.onclick = () => {
    const st = c.dataset.st;
    S.filter.status.has(st) ? S.filter.status.delete(st) : S.filter.status.add(st);
    renderFilters(); renderList();
  }));
  $('#fFam').onchange = (e) => { S.filter.family = e.target.value; renderList(); };
  $('#fDeck').onchange = (e) => { S.filter.deck = e.target.value; renderList(); };
}

function visibleElements() {
  const f = S.filter;
  const words = (f.text ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return Object.values(S.results.elements).filter((e) => {
    if (f.deck && e.deck !== f.deck) return false;
    if (words.length) { const hay = `${e.id} ${e.name} ${e.type}`.toLowerCase(); if (!words.every((w) => hay.includes(w))) return false; }
    const rs = f.family ? e.results.filter((r) => family(r.source) === f.family) : e.results;
    if (f.family && !rs.length) return false;
    if (!rs.length) return f.status.has('null');
    return rs.some((r) => f.status.has(r.status));
  });
}

function renderList() {
  const deckOrder = Object.fromEntries(S.norm.decks.map((d, i) => [d.id, i]));
  const items = visibleElements().sort((a, b) => ORDER[a.worst] - ORDER[b.worst] || deckOrder[a.deck] - deckOrder[b.deck]);
  // Long lists (real models): render a page at a time.
  const shown = items.slice(0, Math.max(listLimit, items.findIndex((e) => e.id === S.selected) + 1));
  $('#list').innerHTML = `<div class="muted">${items.length.toLocaleString('en')} element${items.length === 1 ? '' : 's'} match the filters</div>` + shown.map((e) => {
    const bad = e.results.filter((r) => r.status !== 'compliant');
    return `<div class="item ${S.selected === e.id ? 'sel' : ''}" data-id="${esc(e.id)}">
      <span class="dot st-${e.worst ?? 'none'}"></span>
      <span><b>${esc(e.id)}</b> ${esc(e.name)} <span class="deckTag">· ${esc(S.norm.decks.length > 1 ? e.deck : '')}</span></span>
      ${bad.length ? `<span class="rules">${bad.map((r) => `<span class="rtag st-${r.status}">${esc(r.rule_id)}</span>`).join('')}</span>` : ''}
    </div>`;
  }).join('') + (items.length > shown.length ? `<button class="more" id="moreBtn">Show ${Math.min(LIST_PAGE, items.length - shown.length)} more (${(items.length - shown.length).toLocaleString('en')} hidden)</button>` : '');
  if (!items.length) $('#list').innerHTML = '<p class="muted">No element matches the filters.</p>';
  if ($('#moreBtn')) $('#moreBtn').onclick = () => { listLimit += LIST_PAGE; renderList(); };
  document.querySelectorAll('#list .item').forEach((n) => (n.onclick = () => select(n.dataset.id)));
  const all = S.filter.status.size === 4 && !S.filter.family && !S.filter.deck && !(S.filter.text ?? '').trim();
  viewer.setFilter(all ? null : new Set(items.map((e) => e.id)));
}

// ---------- detail panel ----------

function select(id, { fly = true } = {}) {
  clearCutControl();
  S.selected = id;
  const el = elById(id);
  if (el && viewer.mode !== 'all' && viewer.mode !== 'exploded' && viewer.mode !== el.deck) {
    $('#deck').value = el.deck;
    viewer.setMode(el.deck);
  }
  if (S.ruleView) { S.ruleView = null; viewer.clearHighlight?.(); }
  const route = S.escapeOn && S.escape?.origins[id]?.primary;
  viewer.select(id, { fly: fly && !route, label: labelFor(id), status: S.results.elements[id]?.worst });
  if (S.escape) syncEscapeView();
  if (route && fly) viewer.frameRoute?.(route.points);
  document.querySelectorAll('#list .item').forEach((n) => n.classList.toggle('sel', n.dataset.id === id));
  document.querySelector(`#list .item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  renderDetail(id);
}

function renderDetail(id) {
  restRequest++;
  const e = S.results.elements[id], el = elById(id);
  $('#detail').innerHTML = `
    <h1>${esc(id)} · ${esc(el.name)}</h1>
    <div class="muted">${esc(el.type)} · ${esc(deckName(el.deck))}${el.objectid != null ? ` · viewer dbId ${el.objectid}` : ''} · source: ${prov(el.source || S.model.source || 'not stated')}</div>
    <div id="dStatus" style="margin-top:6px"></div>
    ${S.sc.viewer === 'local' ? '<button id="backOverview" class="tiny" style="margin-top:6px">← Back to the whole ship</button>' : ''}
    ${el.note ? `<div class="note"><b>Model note:</b> ${esc(el.note)}</div>` : ''}
    <div id="dComponent"></div>
    <div id="dGeom"></div>
    <div id="dEscape"></div>
    <div id="dResults"></div>
    <h2>Design data (what-if editing)</h2>
    <div id="dEditor"></div>`;
  renderComponent(id);
  renderGeometry(id);
  renderEscapeDetail(id);
  renderResults(id);
  renderEditor(id);
  if ($('#backOverview')) $('#backOverview').onclick = () => {
    S.selected = null;
    showOverview();
    renderList();
    $('#detail').innerHTML = '<p class="muted">Click a part, a finding or a rule.</p>';
  };
}

// ---------- escape plan (route analysis from the model geometry; never a rule result) ----------

const ESCAPE_CLASS = { two_routes: 'compliant', direct: 'compliant', single_route: 'not_enough_info', no_route: 'non_compliant' };
const ESCAPE_ORDER = { no_route: 0, single_route: 1, two_routes: 2, direct: 3 };
const metres = (mm) => `${(mm / 1000).toFixed(1)} m`;
const escapeRooms = () => Object.values(S.escape?.origins ?? {}).filter((o) => o.room);

function computeEscape() {
  S.escape = null;
  if (S.model.kind === 'parts') return;
  try {
    const analysis = analyzeEscape(S.norm, { blocked: S.blocked });
    if (analysis.available) S.escape = analysis;
  } catch (e) { console.warn('Escape analysis failed:', e); }
}

function syncEscapeView() {
  const three = viewer === views.three;
  $('#escapeBtn').hidden = !S.escape || !three;
  $('#escapeBtn').classList.toggle('on', S.escapeOn && !!S.escape);
  $('#escapeBox').hidden = !(S.escapeOn && S.escape);
  if (!viewer.setEscape) return;
  if (!S.escapeOn || !S.escape) { viewer.setEscape(S.blocked.size ? { blocked: [...S.blocked] } : null); return; }
  const rooms = escapeRooms();
  const selected = S.escape.origins[S.selected];
  const routes = [];
  if (selected?.primary) routes.push({ kind: 'primary', points: selected.primary.points });
  if (selected?.secondary) routes.push({ kind: 'secondary', points: selected.secondary.points });
  viewer.setEscape({
    plan: true,
    tint: Object.fromEntries(rooms.map((o) => [o.id, STATUS_HEX[ESCAPE_CLASS[o.status]]])),
    blocked: [...S.blocked],
    network: routes.length ? [] : rooms.filter((o) => o.primary).map((o) => o.primary.points),
    routes,
  });
}

function setEscapeMode(on) {
  S.escapeOn = on && !!S.escape;
  renderEscape();
  syncEscapeView();
  if (S.selected) renderEscapeDetail(S.selected);
  if (S.escapeOn && !S.selected) showOverview();
}

function toggleBlock(id) {
  if (S.blocked.has(id)) S.blocked.delete(id); else S.blocked.add(id);
  S.escapeOn = true;
  computeEscape();
  renderEscape();
  syncEscapeView();
  if (S.selected) renderEscapeDetail(S.selected);
}

function renderEscape() {
  const box = $('#escapeBox');
  if (!S.escape) { box.innerHTML = ''; box.hidden = true; return; }
  const a = S.escape, s = a.summary;
  const rooms = escapeRooms().sort((x, y) => ESCAPE_ORDER[x.status] - ESCAPE_ORDER[y.status] || (y.primary?.length_mm ?? 0) - (x.primary?.length_mm ?? 0));
  const longest = rooms.filter((o) => o.primary).sort((x, y) => y.primary.length_mm - x.primary.length_mm)[0];
  box.innerHTML = `
    <h2>Escape plan</h2>
    <div class="pills">
      <div class="pill st-non_compliant">${s.no_route}<small>no route</small></div>
      <div class="pill st-not_enough_info">${s.single_route}<small>single route</small></div>
      <div class="pill st-compliant">${s.two_routes + s.direct}<small>two routes</small></div>
    </div>
    <div class="muted">Walking routes from every room to ${a.musters.map((m) => `<a href="#" class="via" data-id="${esc(m)}">${esc(elById(m)?.name ?? m)}</a>`).join(', ')}.
      ${longest ? `Longest: <b>${metres(longest.primary.length_mm)}</b> from ${esc(longest.id)}.` : ''}
      Derived from the model geometry; rule results come only from the checker.</div>
    ${a.blocked.length ? `<div class="note"><b>What-if, blocked:</b> ${a.blocked.map((id) => `<code>${esc(id)}</code>`).join(' ')} <button class="tiny" id="escReset">clear</button></div>` : ''}
    ${a.disconnected.length ? `<div class="note"><b>Not connected:</b> ${a.disconnected.map((d) => `<a href="#" class="via" data-id="${esc(d.id)}">${esc(d.id)}</a>: ${esc(d.reason)}`).join('; ')}.</div>` : ''}
    <div class="esc-legend"><span><i class="swatch primary"></i>Shortest route</span><span><i class="swatch secondary"></i>Independent alternative</span></div>
    <div id="escList">${rooms.map((o) => {
      const el = elById(o.id);
      return `<div class="item esc ${S.selected === o.id ? 'sel' : ''}" data-id="${esc(o.id)}" title="${esc(ESCAPE_LABEL[o.status])}">
        <span class="dot st-${ESCAPE_CLASS[o.status]}"></span>
        <span><b>${esc(o.id)}</b> ${esc(el?.name ?? '')} <span class="deckTag">· ${esc(el?.deck ?? '')}</span><span class="len">${o.primary ? metres(o.primary.length_mm) : '–'}</span></span>
      </div>`;
    }).join('')}</div>
    <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap"><button id="escAiBtn" class="ai-btn" ${s.single_route + s.no_route ? '' : 'disabled'} title="AI proposes design changes; Complee recomputes every proposal and shows only those that give rooms a second independent route">✦ Suggest improvements</button><button id="escCsv">Export routes (CSV)</button></div>
    <div id="escAi">${escAiHTML()}</div>
    <details class="assume"><summary>How the routes are derived</summary><ul>${a.assumptions.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>`;
  box.querySelectorAll('.item.esc').forEach((n) => (n.onclick = () => select(n.dataset.id)));
  box.querySelectorAll('a.via').forEach((n) => (n.onclick = (e) => { e.preventDefault(); select(n.dataset.id); }));
  if ($('#escReset')) $('#escReset').onclick = () => { S.blocked.clear(); toggleBlockRefresh(); };
  $('#escCsv').onclick = exportEscapeCSV;
  $('#escAiBtn').onclick = suggestEscapeImprovements;
  wireEscAi();
}

function toggleBlockRefresh() {
  computeEscape();
  renderEscape();
  syncEscapeView();
  if (S.selected) renderEscapeDetail(S.selected);
}

function routeHTML(title, r, kind) {
  const decks = [...new Set(r.points.map((p) => p.deck))];
  const bad = r.via.filter((v) => S.results.elements[v]?.worst === 'non_compliant');
  return `<div class="res route ${kind}">
    <div class="head"><span>${title}</span><span>${metres(r.length_mm)}</span></div>
    <div class="expl">${r.via.map((v) => `<a href="#" class="via${bad.includes(v) ? ' bad' : ''}" data-id="${esc(v)}" title="${esc(elById(v)?.name ?? '')}">${esc(v)}</a>`).join(' → ')}</div>
    <div class="muted">${decks.length} deck${decks.length > 1 ? 's' : ''} · ${r.verticals.length} stair / ladder · ${r.doors.length} door${r.doors.length === 1 ? '' : 's'}${r.narrowest ? ` · narrowest stated clear width ${r.narrowest.width_mm} mm at ${esc(r.narrowest.id)}` : ''}</div>
    ${bad.length ? `<div class="check-bad">Passes ${bad.map(esc).join(', ')}: non-compliant in the rule check.</div>` : ''}
  </div>`;
}

function renderEscapeDetail(id) {
  const box = $('#dEscape');
  if (!box) return;
  const o = S.escape?.origins[id], el = elById(id), isBlocked = S.blocked.has(id);
  if (!S.escape || (!o && !isBlocked)) { box.innerHTML = ''; return; }
  const canBlock = isBlocked || (o && !o.room && !S.escape.musters.includes(id));
  const broken = S.escape.disconnected.filter((d) => d.id === id);
  let html = '<h2>Escape routes</h2>';
  if (isBlocked) html += '<div class="note"><b>Blocked (what-if).</b> Routes are searched without this element.</div>';
  if (o) {
    html += `<span class="badge st-${ESCAPE_CLASS[o.status]}">${esc(ESCAPE_LABEL[o.status])}</span>`;
    if (o.primary) html += routeHTML('Shortest route to the muster station', o.primary, 'primary');
    if (o.secondary) html += routeHTML('Independent alternative', o.secondary, 'secondary');
    if (o.status === 'single_route') html += `<div class="na">Every route found passes ${o.shared_gates.map((g) => `<code>${esc(g)}</code>`).join(', ')}. No route avoids all of them.</div>`;
    if (o.status === 'no_route') html += '<div class="na">The model contains no connected way from here to a muster station.</div>';
  }
  for (const d of broken) html += `<div class="note"><b>Not connected:</b> ${esc(d.reason)}.</div>`;
  if (canBlock) html += `<button id="blockBtn" class="tiny" style="margin-top:6px" title="What-if: fire or obstruction. The model is not changed.">${isBlocked ? 'Unblock' : `Block this ${esc(el.type.replace('_', ' '))} (what-if)`}</button>`;
  if (!S.escapeOn) html += ' <button id="showEscape" class="tiny" style="margin-top:6px">Show in the model</button>';
  box.innerHTML = html;
  box.querySelectorAll('a.via').forEach((n) => (n.onclick = (e) => { e.preventDefault(); select(n.dataset.id); }));
  if ($('#blockBtn')) $('#blockBtn').onclick = () => toggleBlock(id);
  if ($('#showEscape')) $('#showEscape').onclick = () => { setEscapeMode(true); select(id); };
}

function exportEscapeCSV() {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['room', 'name', 'deck', 'status', 'shortest_m', 'shortest_via', 'narrowest_clear_width_mm', 'narrowest_at', 'alternative_m', 'alternative_via']];
  for (const o of escapeRooms()) {
    const el = elById(o.id);
    rows.push([o.id, el?.name, el?.deck, ESCAPE_LABEL[o.status],
      o.primary ? (o.primary.length_mm / 1000).toFixed(1) : '', o.primary?.via.join(' > '), o.primary?.narrowest?.width_mm, o.primary?.narrowest?.id,
      o.secondary ? (o.secondary.length_mm / 1000).toFixed(1) : '', o.secondary?.via.join(' > ')]);
  }
  download(`${S.sc.id}-escape-routes.csv`, rows.map((r) => r.map(q).join(',')).join('\n'), 'text/csv');
}

// ---------- rest part (full model, not checked by any rule) ----------

const restProps = new Map(); // props shard -> Promise of { dbId: record }
async function onPickRest(db) {
  const request = ++restRequest, scenario = S.sc, generation = viewerGeneration, source = viewer;
  S.selected = null;
  if (S.ruleView) { S.ruleView = null; viewer.clearHighlight?.(); }
  document.querySelectorAll('#list .item.sel').forEach((n) => n.classList.remove('sel'));
  const shard = Math.floor(db / 1000);
  if (!viewer.getProperties && !restProps.has(shard)) restProps.set(shard, fetchJSON(`model/props/${shard}.json`).catch(() => ({})));
  $('#detail').innerHTML = `<h1>dbId ${db}</h1><div class="muted">Not checked by any rule · loading the part data…</div>`;
  const rec = source.getProperties ? await source.getProperties(db) : (await restProps.get(shard))[db];
  if (request !== restRequest || generation !== viewerGeneration || source !== viewer || S.sc !== scenario || scenarioPending) return;
  const name = rec?.name || 'Model object';
  const table = (props) => Object.entries(props || {}).map(([group, kv]) => `<h2>${esc(group)}</h2><table class="kv">${
    Object.entries(kv || {}).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc([].concat(v).join(', '))}</td></tr>`).join('')}</table>`).join('');
  $('#detail').innerHTML = `
    <h1>dbId ${db} · ${esc(name)}</h1>
    <div class="muted">Not checked by any rule · full model (${esc(rec?.chunk || 'rest')})${rec?.path?.length ? ` · ${esc(rec.path.join(' › '))}` : ''}</div>
    <div class="note">This part is shown for context only. No rule in the rule set applies to it, so it has no pass/fail status and does not count in the findings.</div>
    ${rec ? table(rec.properties) : '<p class="muted">No properties found for this object.</p>'}
    ${rec?.part_of ? `<h2 style="margin-top:10px">Part: ${esc(rec.part_of.name)} (dbId ${rec.part_of.dbId})</h2>${table(rec.part_of.properties)}` : ''}`;
  clearCutControl();
  source.selectRest?.(db, { label: `<b>${esc(name)}</b> · dbId ${db}<br>not checked by any rule` });
}

// ---------- component view: part -> requirements ----------

const COMPONENT_FIELDS = [
  ['Drawing', 'drawing'], ['Part name', 'part_name'], ['Material', 'material'], ['Steel grade', 'steel_grade'],
  ['Thickness', 'thickness'], ['Clear opening', 'clear_opening'], ['Smaller side', 'clear_opening_min_side'],
  ['Pipe material', 'pipe_material'], ['System', 'system'], ['Size', 'size'], ['SWBS', 'swbs'], ['Design status', 'design_status'],
];

// A length as model text and mm: 5/8" = 15.88 mm; a what-if value shows its own unit.
function showValue(v) {
  if (!v) return null;
  if (typeof v.value === 'number' && v.unit in UNIT_TO_MM) {
    const mm = v.value * UNIT_TO_MM[v.unit];
    const mmTxt = `${Math.abs(mm) < 100 ? Math.round(mm * 100) / 100 : Math.round(mm)} mm`;
    if (v.original != null) return `${v.original} = ${mmTxt}`;
    return v.unit === 'mm' ? `${mmTxt} (${Math.round(mm / 25.4 * 100) / 100} in)` : `${v.value} ${v.unit} = ${mmTxt}`;
  }
  return Array.isArray(v.value) ? v.value.join(', ') : String(v.value);
}

function renderComponent(id) {
  const el = elById(id), e = S.results.elements[id];
  if (!el || !$('#dComponent')) return;
  // Fixed component fields, plus every value a rule on this part uses (e.g. clear_width on a corridor).
  const ruleParams = e.results.flatMap((r) => [r.parameter, ruleById(r.rule_id)?.key]).filter(Boolean)
    .filter((k) => !COMPONENT_FIELDS.some(([, f]) => f === k)).map((k) => [k.replace(/_/g, ' '), k]);
  const rows = [...COMPONENT_FIELDS, ...new Map(ruleParams.map((p) => [p[1], p])).values()].map(([label, k]) => {
    const v = readValue(el.props?.[k], S.norm.units, el.source || S.model.source || 'not stated');
    if (!v) return '';
    const whatIf = S.edits.has(`${id}.${k}`);
    // A what-if value's provenance already reads "what-if, not in model".
    return `<tr class="${whatIf ? 'changed' : ''}"><td>${label}</td><td>${esc(showValue(v))}${prov(v.source)}</td></tr>`;
  }).join('');
  // Missing data: inputs a rule needed but the model does not have (never guessed).
  const missing = e.results.filter((r) => r.status === 'not_enough_info').map((r) => {
    const m = r.explanation.match(/^"?([\w .]+?)"? is missing/) || r.explanation.match(/^(\S+) of .* is not/);
    const what = m ? m[1].replace(/"/g, '') : r.measured ? r.measured : 'value';
    return `<div class="na">• <b>${esc(what)}</b> for ${esc(r.rule_id)}: ${esc(r.explanation)}</div>`;
  }).join('');
  $('#dComponent').innerHTML = `<h2>Component</h2>
    <table class="kv comp">${rows || '<tr><td colspan="2" class="muted">No component data in the model.</td></tr>'}
    ${el.source ? `<tr><td>Source file</td><td>${prov(el.source)}</td></tr>` : ''}</table>
    ${missing ? `<h2>Missing data</h2>${missing}` : ''}`;
}

// The key value shown on the part in 3D, e.g. "762 mm (30 in) · required ≥ 600 mm".
function labelFor(id) {
  const e = S.results?.elements[id];
  if (!e || !e.results.length) return null;
  const r = [...e.results].sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0))[0];
  const el = elById(id);
  const p = r.parameter && readValue(el?.props?.[r.parameter], S.norm.units);
  let key;
  if (p && typeof p.value === 'number' && p.unit in UNIT_TO_MM) {
    const mm = p.value * UNIT_TO_MM[p.unit];
    key = `${Math.abs(mm) < 100 ? Math.round(mm * 100) / 100 : Math.round(mm)} mm (${Math.round(mm / 25.4 * 100) / 100} in)`;
  } else key = r.measured ?? 'value not in model';
  const whatIf = r.parameter && S.edits.has(`${id}.${r.parameter}`);
  return `${esc(key)}${whatIf ? ' · what-if' : ''}<small>required ${esc(r.required)} · ${esc(r.rule_id)}</small>`;
}

function resetEdit(id, key) {
  const el = elById(id);
  const orig = S.pristine.elements.find((x) => x.id === id)?.props?.[key];
  if (orig === undefined) delete el.props[key]; else el.props[key] = structuredClone(orig);
  S.edits.delete(`${id}.${key}`);
  recheck([id]);
  if (S.selected === id && !S.ruleView) renderEditor(id);
}

// ---------- rule view: requirement -> parts ----------

const PLURAL = { hatch: 'hatches', plate: 'plates', stiffener: 'stiffeners', structure_part: 'structural parts', pipe: 'oil fuel pipe items',
  corridor: 'corridors', door: 'doors', stair: 'stairs', ramp: 'ramps', fuel_tank: 'fuel tanks', guard_rail: 'guard rails',
  machinery_space: 'machinery spaces', escape_zone: 'escape zones', system_item: 'system items', manhole: 'manholes' };

function ruleHits(ruleId) {
  const hits = [];
  for (const e of Object.values(S.results.elements)) {
    const r = e.results.find((x) => x.rule_id === ruleId);
    if (r) hits.push({ id: e.id, name: e.name, type: e.type, status: r.status, measured: r.measured });
  }
  return hits.sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0));
}

function countLine(hits) {
  const types = [...new Set(hits.map((h) => h.type))];
  const noun = types.length === 1 ? (hits.length === 1 ? types[0].replace('_', ' ') : PLURAL[types[0]] ?? `${types[0]}s`) : 'parts';
  const n = (st) => hits.filter((h) => h.status === st).length;
  return `${hits.length.toLocaleString('en')} ${noun}: ${n('compliant').toLocaleString('en')} pass, ${n('non_compliant').toLocaleString('en')} fail, ${n('not_enough_info').toLocaleString('en')} not enough info`;
}

function renderRules() {
  const box = $('#rulesBox');
  if (!box) return;
  const used = allRules().filter((r) => !r.draft).map((r) => ({ r, hits: ruleHits(r.id) })).filter((x) => x.hits.length);
  box.innerHTML = `<h2>Rules (${used.length})</h2>` + used.map(({ r, hits }) => `<div class="ruleRow ${S.ruleView === r.id ? 'sel' : ''}" data-rule="${esc(r.id)}">
      <b>${esc(r.id)}</b><span class="muted">${esc(countLine(hits))}</span></div>`).join('');
  box.querySelectorAll('.ruleRow').forEach((n) => (n.onclick = () => showRule(n.dataset.rule)));
}

function showRule(ruleId) {
  S.ruleView = ruleId;
  S.selected = null;
  document.querySelectorAll('#list .item.sel').forEach((n) => n.classList.remove('sel'));
  const hits = ruleHits(ruleId);
  viewer.highlight?.(Object.fromEntries(hits.map((h) => [h.id, h.status])));
  if (!viewer.highlight) viewer.setFilter(new Set(hits.map((h) => h.id)));
  renderRules();
  renderRuleView(ruleId);
}

function renderRuleView(ruleId) {
  const rule = ruleById(ruleId), hits = ruleHits(ruleId);
  const shown = hits.slice(0, 300);
  $('#detail').innerHTML = `
    <div class="muted">Rule view · requirement → parts</div>
    <h1>${esc(rule.id)}</h1>
    <div class="muted">${esc(rule.source)} - ${esc(rule.clause)}</div>
    <blockquote>“${esc(rule.text)}”</blockquote>
    <div class="tags">${rule.verified ? '<span class="tag blue">Value verified</span>' : '<span class="tag">Rule value not yet verified against official text</span>'}
      ${rule.review_status ? `<span class="tag review">${esc(rule.review_status)}</span>` : ''}
      ${rule.basis && rule.basis !== 'explicit' ? `<span class="tag grey" title="${esc(rule.basis_note || '')}">basis: ${esc(rule.basis)}</span>` : ''}</div>
    <div id="ruleOfficial"></div>
    <div class="rulecount" id="ruleCount">${esc(countLine(hits))}</div>
    <div class="row" style="display:flex;gap:6px;margin:6px 0"><button id="ruleBack">Back to all findings</button></div>
    <div id="ruleParts">${shown.map((h) => `<div class="item" data-id="${esc(h.id)}"><span class="dot st-${h.status}"></span>
      <span><b>${esc(h.id)}</b> ${esc(h.name)}<br><span class="muted">${esc(h.measured ?? 'value missing')}</span></span></div>`).join('')}
      ${hits.length > shown.length ? `<p class="muted">${(hits.length - shown.length).toLocaleString('en')} more parts (use the traceability table or the report).</p>` : ''}</div>`;
  $('#ruleBack').onclick = () => { S.ruleView = null; viewer.clearHighlight?.(); showOverview(); renderRules(); renderList();
    $('#detail').innerHTML = '<p class="muted">Click a part, a finding or a rule.</p>'; };
  $('#ruleParts').querySelectorAll('.item').forEach((n) => (n.onclick = () => select(n.dataset.id)));
  loadOfficialText($('#ruleOfficial'), ruleId);
}

function renderResults(id) {
  const e = S.results.elements[id];
  $('#dStatus').innerHTML = `<span class="badge st-${e.worst ?? 'none'}">${LABEL[e.worst]}</span>`;
  const gov = Object.entries(e.governing).filter(([, g]) => g.count > 1).map(([p, g]) =>
    `<div class="gov"><b>${esc(p)}</b> is limited by ${g.count} overlapping rules here; the strictest governs: <b>${esc(g.required)}</b> (${esc(g.rule_id)}).</div>`).join('');

  const cards = e.results.map((r) => `
    <div class="res st-${r.status}" data-rule="${esc(r.rule_id)}">
      <div class="head"><a href="#" class="ruleLink" data-rule="${esc(r.rule_id)}" title="Show every part this rule applies to">${esc(r.rule_id)}</a><span class="badge st-${r.status}">${LABEL[r.status]}</span></div>
      <div class="muted">${esc(r.source)} - ${esc(r.clause)}</div>
      <table class="kv" style="margin-top:4px"><tr><td>Measured</td><td>${esc(r.measured ?? 'missing')}</td></tr><tr><td>Required</td><td>${esc(r.required)}</td></tr></table>
      <div class="expl">${esc(r.explanation)}</div>
      ${r.inputs.length ? `<div class="inputs">Inputs: ${r.inputs.map((i) => `${esc(i.name)} = ${esc(i.value)}${prov(i.source)}`).join('; ')}</div>` : ''}
      <blockquote>“${esc(r.rule_text)}”</blockquote>
      <div class="tags">
        ${r.verified ? '<span class="tag blue">Value verified</span>' : '<span class="tag">Rule value not yet verified against official text</span>'}
        ${r.review_status ? `<span class="tag review" title="How the value is shown was reviewed; this is not a verification against the official text">${esc(r.review_status)}</span>` : ''}
        <span class="tag grey">${r.text_status === 'verbatim' ? 'verbatim text' : 'paraphrased text'}</span>
        ${r.basis !== 'explicit' ? `<span class="tag grey" title="${esc(ruleById(r.rule_id)?.basis_note || '')}">basis: ${esc(r.basis)}</span>` : ''}
        ${r.reference_url ? `<a class="tag grey" href="${esc(r.reference_url)}" target="_blank" rel="noopener">official source ↗</a>` : ''}
      </div>
      ${r.status !== 'compliant' ? `<div class="ai-row"><button class="tiny ai-btn explainBtn" data-rule="${esc(r.rule_id)}" title="Plain-language explanation, exceptions to check and ways to resolve it (AI)">✦ Explain</button></div><div class="ai-out" data-explain="${esc(r.rule_id)}">${explainHTML(id, r)}</div>` : ''}
      ${r.status !== 'compliant' ? dispositionHTML(id, r) : ''}
      </div>`).join('') || '<p class="muted">No rule in the current rule set applies to this element.</p>';

  // "Also required": related rules not applied to this element, and where they are checked in the model.
  const applied = new Set(e.results.map((r) => r.rule_id));
  const related = [...new Set(e.results.flatMap((r) => r.related))].filter((rid) => !applied.has(rid));
  const also = related.map((rid) => {
    const rule = ruleById(rid);
    if (!rule) return '';
    const hits = Object.values(S.results.elements).flatMap((x) => x.results.filter((r) => r.rule_id === rid).map((r) => ({ id: x.id, status: r.status })));
    const na = Object.values(S.results.elements).flatMap((x) => x.not_applicable.filter((r) => r.rule_id === rid))[0];
    const bad = hits.filter((h) => h.status !== 'compliant');
    const where = hits.length
      ? `Checked on ${hits.length} element${hits.length > 1 ? 's' : ''} in this model${bad.length ? `: <b>${bad.length} with findings</b> (${bad.map((h) => `<a href="#" class="goto" data-id="${esc(h.id)}">${esc(h.id)}</a> ${LABEL[h.status].toLowerCase()}`).join(', ')})` : ', all compliant'}.`
      : na ? `Not applied in this model: ${esc(na.reason)}.` : `No element of type ${esc(rule.applies_to.types.join('/'))} in this model.`;
    return `<div class="also"><b>${esc(rid)}</b><span class="muted">${esc(rule.source)} - ${esc(rule.clause)}</span>
      <blockquote>“${esc(rule.text)}”</blockquote><div class="na">${where}</div></div>`;
  }).join('');

  const na = e.not_applicable.map((n) => `<div class="na">• <b>${esc(n.rule_id)}</b>: ${esc(n.reason)}</div>`).join('');

  $('#dResults').innerHTML = `${gov}
    <h2>Rules applied (${e.results.length})</h2>${cards}
    <h2 id="alsoHead">Also required (${related.length})</h2>
    ${also || '<p class="muted">No related rules outside the ones applied above.</p>'}
    ${na ? `<h2>Considered, not applicable (${e.not_applicable.length})</h2>${na}` : ''}`;
  document.querySelectorAll('#dResults .goto').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); select(a.dataset.id); }));
  document.querySelectorAll('#dResults .ruleLink').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); showRule(a.dataset.rule); }));
  wireDispositions($('#dResults'));
  document.querySelectorAll('#dResults .explainBtn').forEach((b) => (b.onclick = () => explainFinding(id, b.dataset.rule)));
}

function lengthParams() {
  return new Set(allRules().filter((r) => r.unit in UNIT_TO_MM && r.parameter).map((r) => r.parameter));
}

function display(raw, units) {
  const v = readValue(raw, units);
  if (!v) return 'missing';
  if (Array.isArray(v.value)) return v.value.join(', ');
  return typeof v.value === 'number' && v.unit in UNIT_TO_MM && raw?.unit ? `${v.value} ${v.unit}` : String(v.value);
}

function renderEditor(id) {
  const el = elById(id), e = S.results.elements[id];
  const lens = lengthParams();
  const needed = e.results.map((r) => r.parameter).filter((p) => p && !(p in (el.props || {})));
  const keys = [...new Set([...Object.keys(el.props || {}), ...needed])];
  const ro = S.precomputed ? 'disabled' : '';
  const rows = keys.map((k) => {
    const raw = el.props?.[k];
    const v = readValue(raw, S.norm.units, el.source || S.model.source || 'not stated');
    const changed = S.edits.has(`${id}.${k}`);
    let input;
    if (raw?.options) {
      input = `<select data-key="${esc(k)}" data-kind="text" ${ro}><option value="">${v ? '' : 'missing'}</option>${raw.options.map((o) =>
        `<option ${v?.value === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (v && typeof v.value === 'boolean') {
      input = `<input type="checkbox" data-key="${esc(k)}" data-kind="bool" ${v.value ? 'checked' : ''} ${ro}>`;
    } else if (v && Array.isArray(v.value)) {
      input = `<input type="text" data-key="${esc(k)}" data-kind="list" value="${esc(v.value.join(', '))}" ${ro}>`;
    } else if (!v || typeof v.value === 'number') {
      const isLen = lens.has(k);
      const unit = v?.unit ?? S.norm.units;
      input = `<div class="num"><input type="number" step="any" data-key="${esc(k)}" data-kind="num" value="${v ? v.value : ''}" placeholder="missing" ${ro}>` +
        (isLen ? `<select data-unit-for="${esc(k)}" ${ro}>${Object.keys(UNIT_TO_MM).map((u) => `<option ${u === unit ? 'selected' : ''}>${u}</option>`).join('')}</select>` : '') + `</div>`;
    } else {
      input = `<input type="text" data-key="${esc(k)}" data-kind="text" value="${esc(v.value)}" ${ro}>`;
    }
    const orig = v?.original != null && !changed ? `<div class="muted">model: ${esc(v.original)}</div>` : '';
    return `<tr class="${!v ? 'missing' : ''} ${changed ? 'changed' : ''}"><td>${esc(k)}${!v ? ' (missing)' : ''}</td><td>${input}${orig}</td><td>${v ? prov(v.source) : raw?.source ? prov(raw.source) : ''}</td></tr>`;
  }).join('');
  $('#dEditor').innerHTML = `<table class="editor">${rows}</table>
    <div class="muted" style="margin-top:4px">${S.precomputed ? 'Precomputed results: values are read-only.' : 'Change a value: the element is re-checked instantly. Edits stay in this session until you export the model.'}</div>`;
  $('#dEditor').querySelectorAll('[data-key]').forEach((inp) => {
    const commit = () => {
      const k = inp.dataset.key, kind = inp.dataset.kind;
      let value;
      if (kind === 'bool') value = inp.checked;
      else if (kind === 'list') value = inp.value.split(',').map((s) => s.trim()).filter(Boolean);
      else if (kind === 'num') { if (inp.value === '') return; value = Number(inp.value); }
      else value = inp.value;
      const unit = $('#dEditor').querySelector(`[data-unit-for="${CSS.escape(k)}"]`)?.value;
      applyEdit(id, k, value, unit);
    };
    inp.addEventListener(inp.dataset.kind === 'bool' ? 'change' : 'input', commit);
  });
  $('#dEditor').querySelectorAll('[data-unit-for]').forEach((sel) => (sel.onchange = () => {
    const inp = $('#dEditor').querySelector(`[data-key="${CSS.escape(sel.dataset.unitFor)}"]`);
    if (inp.value !== '') applyEdit(id, sel.dataset.unitFor, Number(inp.value), sel.value);
  }));
}

function applyEdit(id, key, value, unit) {
  if (S.precomputed) return;
  const el = elById(id);
  const pristineEl = S.pristine.elements.find((x) => x.id === id);
  const before = display(pristineEl?.props?.[key], S.norm.units);
  el.props = el.props || {};
  const opts = el.props[key]?.options;
  el.props[key] = { value, ...(unit ? { unit } : {}), ...(opts ? { options: opts } : {}), source: EDIT_SOURCE };
  S.edits.set(`${id}.${key}`, { id, key, before, after: unit ? `${value} ${unit}` : Array.isArray(value) ? value.join(', ') : String(value) });
  recheck([id]);
  const row = $('#dEditor').querySelector(`[data-key="${CSS.escape(key)}"]`)?.closest('tr');
  if (row) {
    row.classList.add('changed');
    row.cells[2].innerHTML = prov(EDIT_SOURCE);
  }
  $('#dStatus').classList.remove('flash'); void $('#dStatus').offsetWidth; $('#dStatus').classList.add('flash');
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- traceability: parts x rules (same data as the report) ----------

const TRACE_PAGE = 300;
let traceState = { findingsOnly: null, limit: TRACE_PAGE };

function openTrace() {
  closeRegister();
  const panel = $('#tracePanel');
  if (traceState.findingsOnly == null) traceState.findingsOnly = S.norm.elements.length > 2000;
  const m = traceMatrix(S.results, allRules(), { findingsOnly: traceState.findingsOnly });
  const rows = m.rows.slice(0, traceState.limit);
  panel.innerHTML = `<div class="trace-head">
      <b>Traceability: parts × rules</b>
      <span class="muted">${m.rows.length.toLocaleString('en')} of ${m.total.toLocaleString('en')} parts with rule results${S.edits.size ? ' · includes what-if values' : ''}</span>
      <label><input type="checkbox" id="traceFindings" ${traceState.findingsOnly ? 'checked' : ''}> findings only</label>
      <span class="grow"></span>
      <button id="traceCsv">Download CSV</button><button id="traceClose">Close</button>
    </div>
    <div class="trace-wrap"><table class="trace"><thead><tr><th>Part</th>${m.rules.map((r) => `<th title="${esc(r.source)}">${esc(r.id)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="part" data-id="${esc(r.id)}"><b>${esc(r.id)}</b> ${esc(r.name)}</td>${m.rules.map((c) => {
      const st = r.cells[c.id];
      return st ? `<td class="cell st-${st}" data-id="${esc(r.id)}" data-rule="${esc(c.id)}" title="${esc(r.id)} · ${esc(c.id)}: ${esc(cellLabel(st))}">${esc(cellLabel(st))}</td>` : '<td class="cell none"></td>';
    }).join('')}</tr>`).join('')}</tbody></table>
    ${m.rows.length > rows.length ? `<button class="more" id="traceMore">Show ${Math.min(TRACE_PAGE, m.rows.length - rows.length)} more (${(m.rows.length - rows.length).toLocaleString('en')} hidden)</button>` : ''}</div>`;
  panel.hidden = false;
  $('#traceBtn').classList.add('on');
  $('#traceClose').onclick = closeTrace;
  $('#traceCsv').onclick = () => download(`traceability-${S.sc.id}.csv`, traceCSV(traceMatrix(S.results, allRules(), { findingsOnly: traceState.findingsOnly })), 'text/csv');
  $('#traceFindings').onchange = (e) => { traceState.findingsOnly = e.target.checked; traceState.limit = TRACE_PAGE; openTrace(); };
  if ($('#traceMore')) $('#traceMore').onclick = () => { traceState.limit += TRACE_PAGE; openTrace(); };
  panel.querySelectorAll('[data-id]').forEach((n) => (n.onclick = () => {
    closeTrace();
    select(n.dataset.id);
    const card = n.dataset.rule && document.querySelector(`#dResults .res[data-rule="${CSS.escape(n.dataset.rule)}"]`);
    if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); pulse(card); }
  }));
}
function closeTrace() { $('#tracePanel').hidden = true; $('#traceBtn').classList.remove('on'); }

// ---------- modelled geometry of the selected element, and whether a declared width fits into it ----------

function renderGeometry(id) {
  const box = $('#dGeom');
  if (!box) return;
  const el = S.norm.elements.find((e) => e.id === id), g = el?.geom_mm;
  if (!g) { box.innerHTML = ''; return; }
  const m = (v) => (v / 1000).toFixed(2);
  const c = widthCheck(el, S.norm);
  box.innerHTML = `<div class="geom">Modelled: ${m(g.lx)} × ${m(g.ly)} m, height ${m(g.h)} m${c ? ` · declared clear width ${c.declared_mm} mm, modelled width ${c.modelled_mm} mm` : ''}</div>` +
    (c && !c.ok ? '<div class="note"><b>Data consistency:</b> the declared clear width is larger than the modelled geometry. One of the two is wrong; the rule check reads the declared value.</div>' : '');
}

function setMeasureMode(on) {
  views.three.setMeasure(on);
  document.querySelector('#viewTools [data-act="measure"]')?.classList.toggle('on', views.three.measuring);
  $('#viewHint').textContent = views.three.measuring
    ? 'Measure: click two points (snaps to the faces of the element) · Esc to finish'
    : 'Drag: rotate · right-drag: move · wheel: zoom to the pointer · double-click: focus';
}

// ---------- compare with an earlier revision of the model ----------

async function compareWithFile(file) {
  try {
    if (file.size > 30_000_000) throw new Error('The file is larger than 30 MB.');
    let json;
    try { json = JSON.parse(await file.text()); } catch { throw new Error('The file is not valid JSON.'); }
    if (!json || !Array.isArray(json.elements)) throw new Error('Not a ship model (no "elements" list).');
    const baseResults = checkModel(structuredClone(json), allRules());
    S.compare = { name: file.name, diff: compareRevisions(json, baseResults, S.model, S.results), model: json };
  } catch (e) {
    S.compare = { name: file.name, error: e.message };
  }
  openRegister();
}

function comparisonHTML() {
  const c = S.compare;
  if (!c) return '';
  if (c.error) return `<div class="note"><b>Could not compare with ${esc(c.name)}.</b> ${esc(c.error)} <button class="tiny" id="cmpClear">dismiss</button></div>`;
  const { findings: f, elements: e } = c.diff;
  const item = (x, extra) => `<div class="item cmp" data-id="${esc(x.element)}" data-rule="${esc(x.rule_id)}"><span class="dot st-${x.status}"></span><span><b>${esc(x.element)}</b> ${esc(x.name)} · ${esc(x.rule_id)} · ${esc(x.measured)} (required ${esc(x.required)})${extra ? ` <span class="muted">${extra}</span>` : ''}</span></div>`;
  const group = (title, rows) => (rows.length ? `<div class="cmp-group"><b>${title} (${rows.length})</b>${rows.join('')}</div>` : '');
  return `<div class="compare">
    <div class="cmp-head"><b>Changes since ${esc(c.name)}</b>
      <span class="muted">${c.diff.identical ? 'No difference in findings or design values.' : `${f.new.length} new · ${f.resolved.length} resolved · ${f.changed.length} changed · ${f.unchanged} unchanged findings · ${e.changed.length} elements with changed values, ${e.added.length} added, ${e.removed.length} removed`}</span>
      <button class="tiny" id="cmpClear">close comparison</button></div>
    ${group('New findings', f.new.map((x) => item(x)))}
    ${group('Changed findings', f.changed.map((x) => item(x, `earlier: ${esc(LABEL[x.before_status] ?? x.before_status)}, ${esc(x.before_measured)}`)))}
    ${group('Resolved findings', f.resolved.map((x) => `<div class="item cmp gone"><span class="dot st-compliant"></span><span><b>${esc(x.element)}</b> ${esc(x.name)} · ${esc(x.rule_id)} <span class="muted">earlier: ${esc(x.measured)} (required ${esc(x.required)})</span></span></div>`))}
    ${e.changed.length ? `<details class="assume"><summary>Changed design values (${e.changed.length} elements)</summary><table class="register"><tbody>${e.changed.flatMap((el) => el.changes.map((ch) => `<tr><td><b>${esc(el.id)}</b> ${esc(el.name)}</td><td>${esc(ch.field)}</td><td>${esc(ch.before)}</td><td>→ ${esc(ch.after)}</td></tr>`)).join('')}</tbody></table></details>` : ''}
    ${e.added.length ? `<div class="na">Added: ${e.added.map((x) => esc(x.id)).join(', ')}</div>` : ''}
    ${e.removed.length ? `<div class="na">Removed: ${e.removed.map((x) => esc(x.id)).join(', ')}</div>` : ''}
  </div>`;
}

// ---------- AI assistance (backend model chain; the rule checker keeps every decision) ----------

async function assist(name, payload) {
  const res = await fetch(`api/assist/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  let data = null;
  try { data = await res.json(); } catch { /* reported below */ }
  if (!res.ok) throw new Error(data?.error || `The AI service answered ${res.status}.`);
  return data;
}

const aiFooter = (r) => `<div class="ai-foot">AI-generated by ${esc(r.model)} in ${(r.duration_ms / 1000).toFixed(1)} s${r.attempts?.length > 1 ? ` (after ${r.attempts.length - 1} fallback${r.attempts.length > 2 ? 's' : ''})` : ''}. Check against the official rule text before relying on it.</div>`;

function explainKey(id, r) { return `${id}|${r.rule_id}|${r.measured ?? ''}|${r.status}`; }

function explainHTML(id, r) {
  const st = S.explain?.get(explainKey(id, r));
  if (!st) return '';
  if (st.loading) return '<div class="ai-wait"><span class="spin"></span>Asking the AI… (usually 3–6 s)</div>';
  if (st.error) return `<div class="check-bad">${esc(st.error)}</div>`;
  const x = st.data.result || {};
  const list = (title, items) => (items?.length ? `<div class="ai-h">${title}</div><ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
  return `<div class="ai-box">
    <p>${esc(x.summary || '')}</p>
    ${list('Why', x.reasons)}
    ${list('Exceptions and alternatives to check', x.exceptions_to_check)}
    ${x.options?.length ? `<div class="ai-h">Ways to resolve it</div><ol>${x.options.map((o) => `<li><b>${esc(o.change)}</b><br><span class="muted">${esc(o.effect)}</span></li>`).join('')}</ol>` : ''}
    ${list('Questions for the reviewer', x.questions)}
    ${aiFooter(st.data)}
  </div>`;
}

async function explainFinding(id, ruleId) {
  const e = S.results.elements[id], r = e?.results.find((x) => x.rule_id === ruleId);
  if (!r) return;
  const key = explainKey(id, r);
  if (S.explain.get(key)?.loading || S.explain.get(key)?.data) { if (S.explain.get(key)?.data) S.explain.delete(key); renderResults(id); return; }
  const rule = ruleById(ruleId) || {};
  const el = elById(id) || {};
  const ship = Object.fromEntries(Object.entries(S.model.ship || {}).map(([k, v]) => [k, v && typeof v === 'object' && 'value' in v ? `${v.value}${v.unit && v.unit !== 'mm' ? ` ${v.unit}` : ''}` : v]));
  S.explain.set(key, { loading: true });
  renderResults(id);
  try {
    const data = await assist('explain-finding', {
      rule: { id: rule.id, source: rule.source, clause: rule.clause, text: rule.text, text_status: rule.text_status, verified: rule.verified, check: rule.check, parameter: rule.parameter, value: rule.value, unit: rule.unit, applies_to: rule.applies_to },
      finding: { element: id, name: el.name, type: el.type, deck: deckName(el.deck), status: r.status, measured: r.measured, required: r.required, explanation: r.explanation, inputs: r.inputs },
      ship,
    });
    S.explain.set(key, { data });
  } catch (err) {
    S.explain.set(key, { error: err.message });
  }
  if (S.selected === id) renderResults(id);
}

// Escape-route suggestions: the AI proposes actions; every proposal is applied to a copy of the model and the routes
// are recomputed. Only proposals that give rooms a second independent route (and make none worse) are offered.
function escAiHTML() {
  const st = S.escAi;
  if (!st) return '';
  if (st.loading) return '<div class="ai-wait"><span class="spin"></span>The AI proposes changes; Complee recomputes each one…</div>';
  if (st.error) return `<div class="check-bad">${esc(st.error)}</div>`;
  const good = st.items.filter((i) => i.check.ok), dropped = st.items.filter((i) => !i.check.ok);
  return `<div class="ai-box">
    ${good.length ? good.map((i, n) => `<div class="esc-sug ${st.shown === i ? 'on' : ''}">
      <b>${esc(i.s.title)}</b>
      <div class="muted">${esc(i.s.rationale || '')}</div>
      <div class="ok-line">✓ Recomputed: ${i.check.improved.length === 1 ? '1 room gets' : `${i.check.improved.length} rooms get`} a second independent route (${i.check.improved.map((r) => `<a href="#" class="via" data-id="${esc(r)}">${esc(r)}</a>`).join(', ')})</div>
      ${i.ruleIssues.length ? `<div class="disp-warn">⚠ The rule check finds ${i.ruleIssues.length} issue${i.ruleIssues.length === 1 ? '' : 's'} in the proposed elements: ${i.ruleIssues.map((f) => `${esc(f.rule_id)} ${esc(f.measured ?? 'missing')} (required ${esc(f.required)})`).join('; ')}. Adjust before adopting it.</div>` : '<div class="ok-line">✓ The proposed elements pass the rule check.</div>'}
      <div class="esc-sug-actions"><button class="tiny escShow" data-n="${st.items.indexOf(i)}">${st.shown === i ? 'Hide' : 'Show in 3D'}</button><button class="tiny escOpen" data-n="${st.items.indexOf(i)}" title="Open the model with this change as a new revision (compare and register carry over)">Open as revision</button></div>
    </div>`).join('') : '<p class="muted">None of the proposals gave a room a second independent route.</p>'}
    ${dropped.length ? `<details class="assume"><summary>${dropped.length} proposal${dropped.length === 1 ? '' : 's'} dropped after recomputing</summary><ul>${dropped.map((i) => `<li><b>${esc(i.s.title)}</b>: ${esc(i.check.problems.join('; ') || (i.check.worse.length ? `makes ${i.check.worse.join(', ')} worse` : 'no room gains a second route'))}</li>`).join('')}</ul></details>` : ''}
    ${aiFooter(st.data)}
  </div>`;
}

function wireEscAi() {
  const box = $('#escAi');
  if (!box) return;
  box.querySelectorAll('a.via').forEach((n) => (n.onclick = (e) => { e.preventDefault(); select(n.dataset.id); }));
  box.querySelectorAll('.escShow').forEach((b) => (b.onclick = () => {
    const item = S.escAi.items[Number(b.dataset.n)];
    S.escAi.shown = S.escAi.shown === item ? null : item;
    const ghosts = S.escAi.shown ? normalizeModel(structuredClone({ ...S.model, elements: item.check.added })).elements : [];
    views.three.setGhosts(ghosts);
    renderEscape();
  }));
  box.querySelectorAll('.escOpen').forEach((b) => (b.onclick = () => {
    const item = S.escAi.items[Number(b.dataset.n)];
    const name = `${(S.sc.modelData ? S.sc.name.replace(/^File: /, '').replace(/\.json$/i, '') : S.model.name)} - ${item.s.title}`.slice(0, 80);
    openModelFile(new File([JSON.stringify(item.check.model)], `${name.replace(/[^\w .()-]+/g, '_')}.json`));
  }));
}

async function suggestEscapeImprovements() {
  const a = S.escape;
  if (!a) return;
  const rooms = Object.values(a.origins).filter((o) => o.room && o.status !== 'two_routes' && o.status !== 'direct');
  const analysis = {
    muster_stations: a.musters,
    rooms_needing_a_second_route: rooms.map((o) => ({ room: o.id, status: o.status, every_route_passes: o.shared_gates ?? [], shortest_route: o.primary?.via ?? [] })),
    not_connected: a.disconnected,
    blocked_what_if: a.blocked,
    method: 'Two routes are independent when the second uses no stair, ladder, escape trunk or door of the first.',
  };
  const elements = S.norm.elements.filter((e) => e.geom_mm && !e.virtual).map((e) => ({
    id: e.id, type: e.type, name: e.name, deck: e.deck,
    x: Math.round(e.geom_mm.x), y: Math.round(e.geom_mm.y), lx: Math.round(e.geom_mm.lx), ly: Math.round(e.geom_mm.ly),
    ...(['stair', 'ladder', 'escape_trunk'].includes(e.type) ? { leads_up_to_next_deck: true } : {}),
  }));
  const decks = S.norm.decks.map((d) => ({ id: d.id, name: d.name, elevation_mm: d.elevation_mm }));
  // Minimum clear widths of the rules that apply in this model, so proposals are sized to pass the check.
  const applied = new Set(Object.values(S.results.elements).flatMap((e) => e.results.map((r) => r.rule_id)));
  analysis.minimum_clear_width_mm = {};
  for (const r of allRules()) {
    if (!applied.has(r.id) || r.check !== 'min' || r.parameter !== 'clear_width' || typeof r.value !== 'number') continue;
    const mm = r.value * (UNIT_TO_MM[r.unit] ?? 1);
    for (const t of r.applies_to?.types ?? []) analysis.minimum_clear_width_mm[t] = Math.max(analysis.minimum_clear_width_mm[t] ?? 0, mm);
  }
  S.escAi = { loading: true };
  views.three.setGhosts([]);
  renderEscape();
  try {
    const data = await assist('escape-suggestions', { analysis, elements, decks });
    const current = S.escape;
    const items = (data.result?.suggestions ?? []).map((s) => {
      const check = verifySuggestion(S.model, s, current);
      // The rule check of the proposal itself: a new passage or door has to meet the same rules as the rest.
      const added = new Set(check.added.map((e) => e.id));
      const ruleIssues = check.added.length ? findingsOf(checkModel(structuredClone(check.model), allRules())).filter((f) => added.has(f.element)) : [];
      return { s, check, ruleIssues };
    }).sort((a, b) => (b.check.ok - a.check.ok) || (a.ruleIssues.length - b.ruleIssues.length) || (b.check.improved.length - a.check.improved.length));
    S.escAi = { data, items, shown: null };
  } catch (err) {
    S.escAi = { error: err.message };
  }
  renderEscape();
}

// ---------- findings register: how each finding is handled (never changes a rule result) ----------

// One register per project, shared by all its revisions: dispositions written for revision A are still there when
// revision B is opened. A disposition whose value changed since then is flagged "review again" (registerRows).
const registerKey = (key) => `complee.register.${key}`;
const readJSON = (key, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v === 'object' && !Array.isArray(v) ? v : fallback; } catch { return fallback; }
};
const revisionLabel = (sc) => (sc.modelData ? sc.name.replace(/^File: /, '') : sc.name);
function loadRegister(sc, model) {
  S.registerProject = projectKey(model);
  let store = readJSON(registerKey(S.registerProject), null);
  // Registers written before registers were per project were stored per scenario: take them over once.
  if (!store) {
    store = readJSON(registerKey(sc.id), {});
    if (Object.keys(store).length) { try { localStorage.removeItem(registerKey(sc.id)); } catch { /* keep it */ } }
  }
  const meta = readJSON(registerKey(`${S.registerProject}.meta`), { revisions: [] });
  const current = revisionLabel(sc);
  const previous = meta.last;
  S.registerCarried = previous && previous !== current && Object.keys(store).length ? { from: previous, count: Object.keys(store).length } : null;
  meta.last = current;
  if (!meta.revisions.includes(current)) meta.revisions.push(current);
  meta.revisions = meta.revisions.slice(-50);
  S.registerMeta = meta;
  try { localStorage.setItem(registerKey(`${S.registerProject}.meta`), JSON.stringify(meta)); } catch { /* storage full or blocked */ }
  return store;
}
function saveRegister() {
  try { localStorage.setItem(registerKey(S.registerProject), JSON.stringify(S.register)); } catch (e) { console.warn('The findings register could not be saved in this browser:', e.message); }
}
const currentFinding = (key) => findingsOf(S.results).find((f) => findingKey(f) === key);

function dispositionControls(row) {
  return `<select class="dispSel" data-key="${esc(row.key)}" title="How this finding is handled">${DISPOSITIONS.map((d) => `<option value="${d.id}" ${row.disposition === d.id ? 'selected' : ''}>${esc(d.label)}</option>`).join('')}</select>
    <input class="dispWho" data-key="${esc(row.key)}" value="${esc(row.responsible)}" placeholder="Responsible" maxlength="80">
    <input class="dispNote${row.missing_note ? ' missing' : ''}" data-key="${esc(row.key)}" value="${esc(row.note)}" placeholder="${needsNote(row.disposition) ? 'Justification (required)' : 'Note'}" maxlength="600">`;
}

function dispositionHTML(elementId, r) {
  const row = registerRows(S.results, S.register).find((x) => x.key === `${elementId}|${r.rule_id}`);
  if (!row) return '';
  return `<div class="disp">${dispositionControls(row)}
    ${row.stale ? '<div class="disp-warn">The value or result changed after this disposition was written. Review it again.</div>' : ''}
    ${row.missing_note ? '<div class="disp-warn">This disposition needs a written justification.</div>' : ''}</div>`;
}

function wireDispositions(root) {
  const commit = (n, patch) => {
    const finding = currentFinding(n.dataset.key);
    if (!finding) return;
    S.register = withDisposition(S.register, finding, { ...patch, revision: revisionLabel(S.sc) });
    saveRegister();
    renderRegisterButton();
    // Redraw both places a disposition is shown; focus is not lost because this runs on change, not on input.
    if (!$('#registerPanel').hidden) openRegister();
    if (S.selected && $('#dStatus')) renderResults(S.selected);
  };
  root.querySelectorAll('.dispSel').forEach((n) => (n.onchange = () => commit(n, { disposition: n.value })));
  root.querySelectorAll('.dispWho').forEach((n) => (n.onchange = () => commit(n, { responsible: n.value.trim() })));
  root.querySelectorAll('.dispNote').forEach((n) => (n.onchange = () => commit(n, { note: n.value.trim() })));
}

function renderRegisterButton() {
  const s = registerSummary(registerRows(S.results, S.register));
  const attention = s.open + s.stale + s.missing_note;
  $('#registerBtn').textContent = `Findings register${s.total ? ` (${s.open} open)` : ''}`;
  $('#registerBtn').classList.toggle('attention', attention > 0 && s.total > 0);
}

let registerOpenOnly = false;
function openRegister() {
  closeTrace();
  const panel = $('#registerPanel');
  const all = registerRows(S.results, S.register), s = registerSummary(all);
  const current = all.filter((r) => !r.resolved && (!registerOpenOnly || r.disposition === 'open' || r.stale || r.missing_note));
  const resolved = all.filter((r) => r.resolved);
  const row = (r) => `<tr class="${r.stale || r.missing_note ? 'warn' : ''}">
      <td><span class="badge st-${r.status}">${LABEL[r.status]}</span></td>
      <td class="part" data-id="${esc(r.element)}" data-rule="${esc(r.rule_id)}"><b>${esc(r.element)}</b> ${esc(r.name)}</td>
      <td>${esc(r.rule_id)}</td><td>${esc(r.measured)}</td><td>${esc(r.required)}</td>
      <td class="dispCell">${dispositionControls(r)}${r.stale ? '<div class="disp-warn">Value changed since the disposition: review again.</div>' : ''}${r.missing_note ? '<div class="disp-warn">Justification required.</div>' : ''}</td>
      <td class="muted">${r.updated ? esc(new Date(r.updated).toLocaleDateString('en-GB')) : ''}${r.revision ? `<br>${esc(r.revision)}` : ''}</td></tr>`;
  panel.innerHTML = `<div class="trace-head">
      <b>Findings register</b>
      <span class="muted">${s.total} finding${s.total === 1 ? '' : 's'} · ${s.open} open · ${s.total - s.open} with a disposition${s.stale ? ` · <b class="check-bad">${s.stale} to review again</b>` : ''}${s.missing_note ? ` · <b class="check-bad">${s.missing_note} without justification</b>` : ''}${S.edits.size ? ' · includes what-if values' : ''}</span>
      <label><input type="checkbox" id="regOpen" ${registerOpenOnly ? 'checked' : ''}> needs attention only</label>
      <span class="grow"></span>
      <button id="cmpBtn" title="Open an earlier revision of this model (ship/1 JSON) and list what changed">Compare with earlier revision…</button><input id="cmpFile" type="file" accept=".json,application/json" hidden>
      <button id="regCsv">Download CSV</button><button id="regClose">Close</button>
    </div>
    <div class="trace-wrap">
    ${comparisonHTML()}
    ${S.registerCarried ? `<div class="note"><b>Carried over from ${esc(S.registerCarried.from)}:</b> ${S.registerCarried.count} disposition${S.registerCarried.count === 1 ? '' : 's'} of the earlier revision${s.stale ? `; <b>${s.stale}</b> must be reviewed again because the value or result changed` : ''}${s.resolved ? `; ${s.resolved} no longer reported by the check` : ''}.</div>` : ''}
    <p class="muted" style="margin:8px 0">A disposition records how a finding is handled and by whom. It never changes the result of the rule check. One register per project, shared by all its revisions (${(S.registerMeta?.revisions ?? []).length} seen); saved in this browser. Export the CSV or the report to share it.</p>
    ${current.length ? `<table class="register"><thead><tr><th>Check result</th><th>Element</th><th>Rule</th><th>Measured</th><th>Required</th><th>Disposition · responsible · justification</th><th>Updated · revision</th></tr></thead><tbody>${current.map(row).join('')}</tbody></table>`
      : `<p class="muted">${s.total ? 'No finding needs attention.' : 'The rule check reports no findings for this model.'}</p>`}
    ${resolved.length ? `<h2>No longer reported by the check (${resolved.length})</h2>
      <table class="register"><tbody>${resolved.map((r) => `<tr><td><b>${esc(r.element)}</b> ${esc(r.name)}</td><td>${esc(r.rule_id)}</td><td>was: ${esc(r.measured)}</td><td>${esc(DISPOSITION_LABEL[r.disposition])}</td><td>${esc(r.responsible)}</td><td>${esc(r.note)}</td><td><button class="tiny regDrop" data-key="${esc(r.key)}">remove</button></td></tr>`).join('')}</tbody></table>` : ''}
    </div>`;
  panel.hidden = false;
  $('#registerBtn').classList.add('on');
  $('#regClose').onclick = closeRegister;
  $('#regOpen').onchange = (e) => { registerOpenOnly = e.target.checked; openRegister(); };
  $('#regCsv').onclick = () => download(`findings-register-${S.sc.id}.csv`, registerCSV(registerRows(S.results, S.register)), 'text/csv');
  $('#cmpBtn').onclick = () => $('#cmpFile').click();
  $('#cmpFile').onchange = (e) => { const f = e.target.files[0]; if (f) compareWithFile(f); };
  if ($('#cmpClear')) $('#cmpClear').onclick = () => { S.compare = null; openRegister(); };
  panel.querySelectorAll('.item.cmp[data-id]').forEach((n) => (n.onclick = () => { closeRegister(); select(n.dataset.id); }));
  panel.querySelectorAll('.regDrop').forEach((b) => (b.onclick = () => { const next = { ...S.register }; delete next[b.dataset.key]; S.register = next; saveRegister(); openRegister(); }));
  panel.querySelectorAll('td.part').forEach((n) => (n.onclick = () => {
    closeRegister();
    select(n.dataset.id);
    const card = document.querySelector(`#dResults .res[data-rule="${CSS.escape(n.dataset.rule)}"]`);
    if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); pulse(card); }
  }));
  wireDispositions(panel);
}
function closeRegister() { $('#registerPanel').hidden = true; $('#registerBtn').classList.remove('on'); }

// ---------- Revit -> IFC through the server (Autodesk Platform Services); the browser then reads the IFC ----------

function conversionStatus(title, detail, percent = null) {
  $('#detail').innerHTML = `<div class="convert">
    <h1>${esc(title)}</h1>
    ${percent == null ? '<div class="convert-bar indeterminate"><i></i></div>' : `<div class="convert-bar"><i style="width:${Math.max(2, Math.min(100, percent))}%"></i></div>`}
    <p class="muted">${esc(detail)}</p>
    <p class="muted">The Revit file is sent to Autodesk Platform Services for the conversion and kept there for at most 24 hours. The same file is converted only once.</p>
  </div>`;
}

async function convertRevit(file) {
  const status = await fetchJSON('api/convert/status');
  if (!status.allowed) throw new Error('Revit conversion is only available on the computer that runs Complee.');
  if (!status.rvt) throw new Error('Revit conversion needs Autodesk Platform Services keys (APS_CLIENT_ID and APS_CLIENT_SECRET in shipcheck/.env). Without them, export the model from Revit as IFC (File > Export > IFC) and open the .ifc file.');
  if (file.size > status.max_bytes) throw new Error('The file is larger than 1 GB.');
  // Upload with progress (fetch cannot report upload progress).
  const job = await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `api/convert/rvt?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) conversionStatus(`Uploading ${file.name}`, `${(e.loaded / 1e6).toFixed(1)} of ${(e.total / 1e6).toFixed(1)} MB to the Complee server`, (e.loaded / e.total) * 100); };
    xhr.onload = () => {
      let body = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* reported below */ }
      if (xhr.status >= 200 && xhr.status < 300 && body?.id) resolve(body);
      else reject(new Error(body?.error || `The upload failed (${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('The upload failed: the Complee server could not be reached.'));
    conversionStatus(`Uploading ${file.name}`, 'Starting…', 0);
    xhr.send(file);
  });
  const STAGE = { queued: 'Waiting', uploading: 'Sending the model to Autodesk', converting: 'Autodesk converts the model to IFC (a few minutes for a large model)', downloading: 'Downloading the IFC file' };
  const t0 = Date.now();
  let state = job;
  while (state.state !== 'done') {
    if (state.state === 'failed') throw new Error(state.error || 'The conversion failed.');
    const min = Math.floor((Date.now() - t0) / 60000), sec = Math.floor(((Date.now() - t0) % 60000) / 1000);
    conversionStatus(`Converting ${file.name}`, `${STAGE[state.state] ?? state.message}${state.progress ? ` · ${state.progress} %` : ''} · ${min}:${String(sec).padStart(2, '0')}`, state.state === 'converting' && !state.progress ? null : state.progress);
    await sleep(2000);
    state = await fetchJSON(`api/convert/jobs/${job.id}`);
  }
  conversionStatus(`Reading ${file.name}`, state.cached ? 'Converted earlier: using the cached IFC file' : 'Converted. Reading the IFC file…', null);
  const res = await fetch(`api/convert/jobs/${job.id}/ifc`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`The converted file could not be loaded (${res.status}).`);
  return new File([await res.blob()], file.name.replace(/\.rvt$/i, '.ifc'));
}

// ---------- open a model from a file (ship/1 JSON, the format "Export edited model" writes) ----------

let fileCounter = 0;
async function openModelFile(file) {
  const original = file;
  try {
    let json, geometry = null;
    if (/\.rvt$/i.test(file.name)) file = await convertRevit(file);
    else if (/\.(rfa|rte|nwd|nwc|dwg|dxf|step|stp|iges|igs|3dm|skp|obj|stl|fbx)$/i.test(file.name)) {
      throw new Error('This format cannot be read directly. Export the model as IFC (.ifc) from the program it was made in, or upload the Revit file (.rvt).');
    }
    if (/\.ifc$/i.test(file.name)) {
      if (file.size > 400_000_000) throw new Error('The file is larger than 400 MB.');
      $('#detail').innerHTML = `<p class="muted">Reading ${esc(file.name)} (${(file.size / 1e6).toFixed(1)} MB)…</p>`;
      await new Promise((r) => setTimeout(r, 30)); // let the message paint before the parser blocks the page
      const { importIfc } = await import('./ifc-import.js');
      const result = await importIfc(file);
      json = result.model; geometry = result.geometry;
    } else {
      if (file.size > 30_000_000) throw new Error('The file is larger than 30 MB.');
      try { json = JSON.parse(await file.text()); } catch { throw new Error('The file is not valid JSON (expected a ship/1 JSON model or an .ifc file).'); }
    }
    if (!json || typeof json !== 'object' || !Array.isArray(json.elements)) throw new Error('A ship model needs an "elements" list (ship/1 format; "Download model (JSON)" in the left panel gives an example).');
    if (!Array.isArray(json.decks) && !json.deck) throw new Error('A ship model needs "decks" (or a single "deck").');
    const norm = normalizeModel(structuredClone(json)); // throws on an unsupported unit
    const ids = new Set();
    for (const e of norm.elements) {
      if (!e.id || !e.type) throw new Error('Every element needs an "id" and a "type".');
      if (ids.has(e.id)) throw new Error(`Element id "${e.id}" is used twice.`);
      ids.add(e.id);
    }
    const id = `file-${++fileCounter}-${file.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}`;
    if (geometry) json.provenance_note = json.provenance_note.replace(/^Imported from /, `Imported from ${original.name !== file.name ? `${original.name} (converted to IFC by Autodesk) → ` : ''}`);
    S.scenarios.push({ id, name: `File: ${file.name}`, viewer: 'three', modelData: json, geometry });
    $('#scenario').insertAdjacentHTML('beforeend', `<option value="${esc(id)}">${esc(`File: ${file.name}`)}</option>`);
    await loadScenario(id);
  } catch (e) {
    $('#detail').innerHTML = `<p class="check-bad"><b>Could not open ${esc(file.name)}.</b> ${esc(e.message)}</p>`;
  }
}

// ---------- report export (shared with the CLI: src/report.mjs) ----------

function exportCSV() {
  download(`findings-${S.sc.id}.csv`, toCSV(reportRows(S.results, S.model, allRules(), { register: S.register })), 'text/csv');
}

function exportReport() {
  const html = toHTML({ title: S.model.name, scenario: S.sc.id, results: S.results, model: S.model, rules: allRules(),
    score: S.baseline, edits: [...S.edits.values()], register: S.register, escape: S.escape, comparison: S.compare?.diff ? S.compare : null });
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); } else download(`report-${S.sc.id}.html`, html, 'text/html');
}

// ---------- demo run-through (about 28 s after the 3D model is loaded) ----------

function caption(text, sub = '') {
  const c = $('#caption');
  c.hidden = !text;
  const keys = S.demo ? (S.demo.manual ? 'Space / → next · Esc stop' : 'Space / → takes over step by step · Esc stop') : '';
  c.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}${keys ? `<small class="keys">${keys}</small>` : ''}`;
}
function pulse(sel) {
  const n = typeof sel === 'string' ? document.querySelector(sel) : sel;
  if (!n) return;
  n.classList.remove('pulse'); void n.offsetWidth; n.classList.add('pulse');
}

// Scenario-independent pieces of the run-through.
async function waitViewer(step, token) {
  const ready = S.viewerReady ?? Promise.resolve();
  let done = false;
  ready.finally(() => { done = true; });
  // A model that is already on screen settles within a moment: only say "loading" if it really is.
  await Promise.race([ready.catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
  if (!done) caption('Loading the real 3D model…', 'The check itself already ran locally');
  while (!done) { await step(250); if (token.stop) return; }
  // Start only when the ship is fully on screen (streamed viewer): no parts popping in during the story. At most 90 s.
  const st = viewer.stats;
  if (viewer.kind !== 'local' || !st || !('pending' in st)) return;
  for (let waited = 0; waited < 90000 && (st.pending || !(st.viewComplete || st.coverageComplete)); waited += 250) {
    if (waited < 750) { await step(250); continue; } // brief top-ups after the first picture need no caption
    caption('Loading the real 3D model…', `${viewer.residentTiles ?? st.residentTiles ?? ''} parts of the view loaded · the check itself already ran locally`.replace(/^ parts/, 'Parts'));
    await step(250);
  }
}

function ruleQuote(r, match) {
  const t = r.rule_text || '';
  const sentences = t.split(/(?<=\.)\s+(?=\d|[A-Z])/);
  const s = (match && sentences.find((x) => x.toLowerCase().includes(match.toLowerCase()))) || sentences[0] || t;
  return s.length > 230 ? `${s.slice(0, 228)}…` : s;
}

async function paintProgressively(step, chunks = 8) {
  viewer.paintNeutral();
  const ids = S.norm.elements.map((e) => e.id);
  const per = Math.ceil(ids.length / chunks);
  for (let i = 0; i < ids.length; i += per) { viewer.update(S.results, ids.slice(i, i + per)); await step(Math.round(2400 / chunks)); }
  viewer.update(S.results);
}

// Demo pointer: a visible mouse pointer moves to the real control and clicks it, so the audience sees how the app is
// used (the click itself is the control's own handler).
let demoPointer = null;
function pointerEl() {
  if (!demoPointer) {
    demoPointer = document.createElement('div');
    demoPointer.id = 'demoPointer';
    demoPointer.innerHTML = '<svg width="26" height="28" viewBox="0 0 26 28" aria-hidden="true"><path d="M3 2 L3 22 L8.6 16.8 L12.6 25.5 L16.3 23.9 L12.3 15.4 L19.8 15.4 Z" fill="#1d2430" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg><span class="ring"></span>';
    document.body.appendChild(demoPointer);
    const r = $('#view').getBoundingClientRect();
    demoPointer.style.transform = `translate(${r.left + r.width / 2}px, ${r.top + r.height / 2}px)`;
    void demoPointer.offsetWidth;
    demoPointer.classList.add('ready');
  }
  demoPointer.hidden = false;
  return demoPointer;
}
async function pointAt(target, step, { click = true, x = null } = {}) {
  const el = typeof target === 'string' ? document.querySelector(target) : target;
  if (!el) return null;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  await step(320);
  const r = el.getBoundingClientRect(), p = pointerEl();
  p.style.transform = `translate(${r.left + (x ?? Math.min(r.width / 2, 46))}px, ${r.top + r.height / 2}px)`;
  await step(760);
  if (click) { p.classList.remove('click'); void p.offsetWidth; p.classList.add('click'); await step(230); }
  return el;
}
function hidePointer() { if (demoPointer) demoPointer.hidden = true; }
// The report as the Report button produces it, shown inside the page (the button opens it in a new tab).
// The report of a large model takes about a second to build and parse, so the demo prepares it hidden while the
// screen is still (the traceability table) and only reveals it when the Report button is clicked.
let preparedReport = null;
const toHTMLKey = () => `${S.sc?.id}|${[...S.edits.keys()].join(',')}|${S.lastCheckMs}`;
function prepareReportPreview() {
  const html = toHTML({ title: S.model.name, scenario: S.sc.id, results: S.results, model: S.model, rules: allRules(),
    score: S.baseline, edits: [...S.edits.values()] });
  let d = $('#reportPreview');
  if (!d) { d = document.createElement('div'); d.id = 'reportPreview'; $('#view').appendChild(d); }
  d.hidden = true;
  d.innerHTML = '<div class="rp-head"><b>Report</b><span class="muted">the HTML file the Report button opens · for the class review</span></div><iframe title="Report preview"></iframe>';
  d.querySelector('iframe').srcdoc = html;
  preparedReport = { key: toHTMLKey() };
  return d;
}
function showReportPreview() {
  const current = toHTMLKey();
  const d = preparedReport && preparedReport.key === current && $('#reportPreview') ? $('#reportPreview') : prepareReportPreview();
  d.hidden = false;
  return d.querySelector('iframe');
}
function hideReportPreview() { const d = $('#reportPreview'); if (d) d.hidden = true; }

async function demoTypeFix(step, focus, fix) {
  const inp = fix.prop && $('#dEditor').querySelector(`[data-key="${CSS.escape(fix.prop)}"]`);
  if (!inp) return false;
  inp.closest('tr').scrollIntoView({ block: 'center', behavior: 'smooth' });
  await step(400);
  await pointAt(inp, step);
  const unitSel = $('#dEditor').querySelector(`[data-unit-for="${CSS.escape(fix.prop)}"]`);
  if (unitSel && fix.unit) unitSel.value = fix.unit;
  inp.focus();
  inp.value = '';
  for (const ch of String(fix.value)) { inp.value += ch; await step(150); }
  inp.dispatchEvent(new Event('input'));
  return true;
}

// Demo run-through, about 28 s once the 3D model is loaded:
// RCRV real model -> check -> first red part with the rule quote -> cruise deck -> C2 overlap -> live fix -> green -> export.
async function runDemo() {
  if (S.demo) { S.demo.stop = true; return; }
  const token = (S.demo = { stop: false, manual: new URLSearchParams(location.search).has('present'), next: null });
  const step = async (ms) => { await sleep(ms); if (token.stop) throw new Error('stopped'); };
  // A beat is a pause in the story. Autoplay waits ms; Space / → / Page Down skips ahead and switches to presenter
  // mode, where every beat waits for the next key press (presentation clickers send → or Page Down).
  const beat = async (ms) => {
    const key = new Promise((resolve) => { token.next = resolve; });
    await (token.manual ? key : Promise.race([sleep(ms), key]));
    token.next = null;
    if (token.stop) throw new Error('stopped');
  };
  document.body.classList.add('demo-running');
  $('#demoBtn').textContent = '■ Stop demo';
  const real = S.scenarios.find((s) => s.kind === 'parts');
  const inside = S.scenarios.find((s) => s.scene);
  try {
    if (views.three.plan) { views.three.setPlan(false); $('#planBtn').classList.remove('on'); }
    // 1. Open the real RCRV model (reuse it if it is already open and unedited).
    if (real) {
      if (S.sc.id !== real.id || S.edits.size) await loadScenario(real.id);
      await waitViewer(step, token);
      const c = S.model.counts;
      caption('OSU RCRV: real ShipConstructor production model', `${c ? `${c.objects.toLocaleString('en')} objects in the model · ` : ''}${S.norm.elements.length.toLocaleString('en')} parts checked · inches converted to mm`);
      showOverview();
      viewer.paintNeutral();
      await beat(2800);

      // 2. Run the check: colours appear group by group.
      const run = allRules().filter((r) => !r.draft && Object.values(S.results.elements).some((e) => e.results.some((x) => x.rule_id === r.id)));
      caption(`Checking ${run.length} rules on real design data`, [...new Set(run.map((r) => family(r.source)))].join(' · '));
      await paintProgressively(step);
      const s = S.results.summary;
      caption(`${s.non_compliant} non-compliant · ${s.not_enough_info.toLocaleString('en')} not enough info · ${s.compliant.toLocaleString('en')} compliant`,
        S.baseline ? `Ground truth: ${S.baseline.line ?? scoreLine(S.baseline)}` : 'Deterministic checker: same input, same result');
      pulse('#pills'); pulse('#scorebox'); pulse('#accBadge');
      await beat(3000);

      // 3. Fly to the first red part, with the rule quote.
      const d = S.model.demo || {};
      const first = findingsOf(S.results).find((f) => f.status === 'non_compliant' && (!d.focus_rule || f.rule_id === d.focus_rule)) ?? findingsOf(S.results)[0];
      if (first) {
        const item = await pointAt(`#list .item[data-id="${CSS.escape(first.element)}"]`, step);
        if (item) item.click(); else select(first.element);
        const r = S.results.elements[first.element].results.find((x) => x.rule_id === first.rule_id);
        caption(`${first.element}: ${r.measured} in hull structure (SWBS ${elById(first.element)?.props?.swbs_group?.value ?? '1xx'})`,
          `“${ruleQuote(r, d.quote_match)}” (${r.source.split(':')[0]})`);
        document.querySelectorAll('#dResults .res.st-non_compliant').forEach(pulse);
        await beat(4800);
      }

      // 3b. Rule view on the real model: every hatch the opening rule applies to, coloured by that rule.
      const h = d.hatch;
      if (h && ruleById(h.rule)) {
        const row = await pointAt(`#rulesBox .ruleRow[data-rule="${CSS.escape(h.rule)}"]`, step);
        if (row) row.click(); else showRule(h.rule);
        caption(`Rule view: ${countLine(ruleHits(h.rule))}`, 'Every part the rule applies to, coloured by that rule, in the real ship');
        pulse('#ruleCount');
        await beat(4200);
      }
    }

    // 4. Into the ship: one corridor with a few components, placed in the real deckhouse (simplified example).
    if (inside) {
      // Back to the whole ship first (as a user would), then into it.
      const back = document.querySelector('#ruleBack');
      if (back) { await pointAt(back, step); back.click(); await step(1300); }
      caption('Inside the ship: one corridor on deck level 4', 'Simplified example placed in the real deckhouse · the ship is cut open just above the deck');
      await pointAt('#scenario', step);
      $('#scenario').value = inside.id;
      await loadScenario(inside.id);
      await S.viewerReady;
      await step(3300); // the ship is cut open above the deck, then the camera flies in
      const d = S.model.demo || {};
      const s2 = S.results.summary;
      caption(`${S.norm.elements.length} components checked: ${s2.non_compliant} non-compliant, ${s2.compliant} compliant`,
        S.baseline ? `Ground truth: ${S.baseline.line ?? scoreLine(S.baseline)}` : 'Deterministic checker: same input, same result');
      pulse('#pills'); pulse('#scorebox');
      await beat(3400);

      // 5. The corridor is too narrow: component view, rule quote, rule card.
      const focus = d.focus;
      if (focus && S.results.elements[focus]) {
        const item = await pointAt(`#list .item[data-id="${CSS.escape(focus)}"]`, step);
        if (item) item.click(); else select(focus);
        const fe = S.results.elements[focus];
        const bad = fe.results.find((r) => r.status === 'non_compliant');
        if (bad) {
          caption(`${elById(focus).name}: ${bad.parameter.replace(/_/g, ' ')} ${bad.measured}, required ${bad.required}`,
            `“${ruleQuote(bad)}” (${bad.source.split(':')[0]})`);
          document.querySelectorAll('#dResults .res.st-non_compliant').forEach(pulse);
          await beat(4600);
          caption('The card shows the rule, its source and review status', `${bad.source.split(';')[0]} · ${bad.review_status ?? ''}`);
          const card = document.querySelector(`#dResults .res[data-rule="${CSS.escape(bad.rule_id)}"]`);
          card?.scrollIntoView({ block: 'center', behavior: 'smooth' });
          if (card) { pulse(card); await pointAt(card.querySelector('.st-badge, .badge, h3, b') || card, step, { click: false }); }
          await beat(3600);
        }
        // 6. What-if: the engineer widens the corridor; re-checked and recoloured instantly.
        const fix = d.fix;
        if (fix) {
          caption(`What-if: ${fix.prop.replace(/_/g, ' ')} = ${fix.value} ${fix.unit || 'mm'}`, 'Labelled "what-if, not in model"; re-checked and recoloured instantly');
          await step(800);
          if (await demoTypeFix(step, focus, fix)) {
            await step(500);
            const now = S.results.elements[focus].worst;
            caption(`${focus} is now ${LABEL[now].toLowerCase()} (what-if, not in model)`, `Re-checked in ${S.lastCheckMs.toFixed(1)} ms · reset restores the model value; the model itself is never changed`);
            $('#detail').scrollTo({ top: 0, behavior: 'smooth' });
            pulse('#dStatus');
            await beat(3400);
          }
        }
      }

      // 7. A second finding: the guard rail, drawn in inches, fails two overlapping rules.
      if (d.second && S.results.elements[d.second]) {
        const item = await pointAt(`#list .item[data-id="${CSS.escape(d.second)}"]`, step);
        if (item) item.click(); else select(d.second);
        const fe = S.results.elements[d.second];
        const bad = fe.results.filter((r) => r.status === 'non_compliant');
        if (bad.length) {
          caption(`${elById(d.second).name}: ${bad[0].measured} fails ${bad.length} overlapping rule${bad.length > 1 ? 's' : ''}`,
            `${bad.map((r) => `${r.rule_id} (${r.required})`).join(' + ')} · inch values converted to mm`);
          document.querySelectorAll('#dResults .res.st-non_compliant').forEach(pulse);
          await beat(4400);
        }
      }
    }
    // 8. Traceability: every part against every rule; a cell opens that part and its rule card.
    caption('Traceability: every part against every rule', 'One click on a cell opens the part and the rule card behind the result');
    const tb = await pointAt('#traceBtn', step);
    if (tb) {
      openTrace();
      await step(400);
      prepareReportPreview(); // built now, while the table is on screen and nothing moves
      await beat(3400);
      const focus = S.model.demo?.focus;
      const cell = focus && await pointAt(`#tracePanel td.cell[data-id="${CSS.escape(focus)}"]`, step);
      if (cell) {
        cell.click();
        caption(`${focus}: compliant with the what-if value`, 'From the table straight to the part, its rule card and the value that decided it');
        await beat(3000);
      } else closeTrace();
    }

    // 9. Report: the HTML report for the class review (shown in the page; the button opens it in a new tab).
    caption('Export the findings: HTML report and CSV', 'Rule references, measured vs required, value provenance, inch → mm conversions');
    await pointAt('#reportBtn', step);
    const frame = showReportPreview();
    await step(1200);
    for (let i = 1; i <= 6; i++) { frame.contentWindow?.scrollTo({ top: i * 260, behavior: 'smooth' }); await step(650); }
    await beat(1800);
    hideReportPreview();

    // 10. Closing frame: the whole scene with every result coloured.
    hidePointer();
    showOverview();
    caption('Complee: deterministic rule checks on the real design model', 'Every result traceable to its rule, its source and the design value · what-ifs never change the model');
    await beat(4200);
  } catch (e) {
    if (e.message !== 'stopped') console.error(e);
  } finally {
    hidePointer();
    hideReportPreview();
    document.body.classList.remove('demo-running');
    S.demo = null;
    caption('');
    $('#demoBtn').innerHTML = '&#9654; Demo run-through';
  }
}
// ---------- wiring ----------

$('#scenario').onchange = (e) => loadScenario(e.target.value).catch((error) => {
  $('#detail').innerHTML = `<p class="check-bad">Failed to load: ${esc(error.message)}</p>`;
  console.error(error);
});
$('#deck').onchange = (e) => {
  viewer.setMode(e.target.value);
  if (S.selected) viewer.select(S.selected, { fly: false });
};
$('#demoBtn').onclick = runDemo;
$('#reportBtn').onclick = exportReport;
$('#traceBtn').onclick = () => ($('#tracePanel').hidden ? openTrace() : closeTrace());
$('#csvBtn').onclick = exportCSV;
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && views.three.measuring) { setMeasureMode(false); return; }
  if (!S.demo) return;
  if (e.key === 'Escape') { S.demo.stop = true; S.demo.next?.(); return; }
  if ([' ', 'ArrowRight', 'PageDown', 'Enter'].includes(e.key) && !/^(INPUT|SELECT|TEXTAREA|BUTTON)$/.test(e.target.tagName)) {
    e.preventDefault();
    if (!S.demo.manual) { S.demo.manual = true; const c = $('#caption'); c.querySelector('.keys')?.replaceChildren('Space / → next · Esc stop'); }
    S.demo.next?.();
  }
});
// Simple view (real model): context (shell + decks) and checked parts only; deck cut from the deck plating.
$('#simpleBtn').onclick = () => {
  const on = !viewer.simple;
  viewer.setSimple?.(on);
  $('#simpleBtn').classList.toggle('on', !!viewer.simple);
  $('#fullBtn').classList.toggle('on', !!viewer.fullModel);
  $('#cutSel').value = ''; // the viewer drops the deck cut on this switch; keep the selector in step
};
$('#cutSel').onfocus = () => {
  if ($('#cutSel').options.length > 1 || !viewer.deckLevels) return;
  const lv = viewer.deckLevels();
  $('#cutSel').innerHTML = '<option value="">No deck cut</option>' + lv.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
};
$('#cutSel').onchange = (e) => viewer.setDeckCut?.(e.target.value);
// Full model (local viewer): the parts no rule looks at, in grey, in the overview.
$('#fullBtn').onclick = () => {
  const on = !viewer.fullModel;
  viewer.setFullModel?.(on);
  $('#fullBtn').classList.toggle('on', !!viewer.fullModel);
  $('#simpleBtn').classList.toggle('on', !!viewer.simple);
  $('#cutSel').value = ''; // the viewer drops the deck cut on this switch; keep the selector in step
};
$('#planBtn').onclick = () => { viewer.setPlan(!viewer.plan); $('#planBtn').classList.toggle('on', viewer.plan); };
$('#escapeBtn').onclick = () => setEscapeMode(!S.escapeOn);
$('#registerBtn').onclick = () => ($('#registerPanel').hidden ? openRegister() : closeRegister());
$('#manageLink').onclick = (e) => { e.preventDefault(); openRegister(); };
$('#openBtn').onclick = () => $('#openFile').click();
$('#openFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openModelFile(f); };
$('#viewTools').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b || viewer !== views.three) return;
  if (b.dataset.view) { $('#planBtn').classList.remove('on'); viewer.setView(b.dataset.view); }
  else if (b.dataset.act === 'fit') { if (S.selected) viewer.flyToElement(S.selected, 600); else viewer.overview(600); }
  else if (b.dataset.act === 'all') { S.selected = null; viewer.select(null); syncEscapeView(); renderList(); viewer.overview(600); }
  else if (b.dataset.act === 'labels') { viewer.setLabels(!viewer.labels); b.classList.toggle('on', viewer.labels); }
  else if (b.dataset.act === 'shell') { viewer.setShell(!viewer.shell); b.classList.toggle('on', viewer.shell); }
  else if (b.dataset.act === 'measure') setMeasureMode(!viewer.measuring);
};

window.__shipcheck = S; // for debugging in the console
Object.defineProperty(window, '__shipcheckViewer', { get: () => viewer }); // read-only: the active viewer (tests, console)
// ---------- loading screen: until the first part of the 3D model is on screen ----------
const loadingScreen = {
  el: $('#loadingScreen'),
  step(name, detail = '') {
    if (!this.el || this.el.classList.contains('is-done')) return;
    let reached = false;
    for (const li of this.el.querySelectorAll('[data-step]')) {
      const current = li.dataset.step === name;
      li.classList.toggle('active', current);
      li.classList.toggle('done', !current && !reached);
      if (current) reached = true;
    }
    $('#loadingDetail').textContent = detail;
  },
  hide() {
    if (!this.el || this.el.classList.contains('is-done')) return;
    for (const li of this.el.querySelectorAll('[data-step]')) { li.classList.remove('active'); li.classList.add('done'); }
    this.el.classList.add('is-done');
    setTimeout(() => this.el.remove(), 600);
  },
  fail(message) {
    if (!this.el) return;
    this.el.classList.add('is-error');
    $('#loadingDetail').innerHTML = `Could not load: ${esc(message)} <button type="button" onclick="location.reload()">Reload</button>`;
  },
};

async function showWhenReady() {
  loadingScreen.step('model', 'Preparing the 3D view…');
  const progress = setInterval(() => {
    const st = views.local?.stats;
    if (st?.residentTiles || st?.pending) loadingScreen.step('model', `${st.residentTiles} parts of the view streamed in`);
  }, 400);
  // The first picture of the model resolves viewerReady; never keep the page covered for more than 90 s.
  await Promise.race([Promise.resolve(S.viewerReady).catch(() => {}), new Promise((r) => setTimeout(r, 90000))]);
  clearInterval(progress);
  loadingScreen.hide();
}

init().then(async () => {
  await showWhenReady();
  if (new URLSearchParams(location.search).has('escape')) setEscapeMode(true);
  if (location.hash === '#manage') openRegister();
  if (new URLSearchParams(location.search).has('demo')) runDemo();
}).catch((e) => {
  loadingScreen.fail(e.message);
  $('#detail').innerHTML = `<p class="check-bad">Failed to load: ${esc(e.message)}</p>`;
  console.error(e);
});
