// ShipCheck UI. The pass/fail decision always comes from the shared deterministic checker
// (src/checker.mjs), which runs right here in the browser so edits re-check instantly.
import { checkModel, recheckElements, normalizeModel, findingsOf, readValue, UNIT_TO_MM, STATUS_RANK, coverageOf, unconfirmedInputs, confirmedInputs } from './src/checker.mjs';
import { scoreResults, scoreLine, badgeText } from './src/score.mjs';
import { partsToModel } from './src/parts-model.mjs';
import { reportRows, toCSV, toHTML, readinessTitle } from './src/report.mjs';
import { csvCell } from './src/csv.mjs';
import { traceMatrix, traceCSV, cellLabel } from './src/trace.mjs';
import { createViewer, STATUS_HEX } from './viewer3d.js';
import { analyzeEscape, ESCAPE_LABEL } from './src/escape.mjs';
import { compareRevisions } from './src/compare.mjs';
import { verifySuggestion } from './src/escape-actions.mjs';
import { parsePartialJson } from './src/partial-json.mjs';
import { consistencyIssues, widthCheck } from './src/consistency.mjs';
import { readiness } from './src/readiness.mjs';
import { statusForRules, verificationCounts, LEVEL_LABEL } from './src/verify-status.mjs';
import { projectFile, readProjectFile } from './src/project-file.mjs';
import { COMMENT_STATUSES, COMMENT_STATUS_LABEL, EVIDENCE_LABEL, EVIDENCE_CLASS, parseComments, addComments, withComment, withoutComment, commentEvidence, commentSummary, commentsCSV, isContradicted } from './src/class-comments.mjs';
import { DISPOSITIONS, DISPOSITION_LABEL, needsNote, findingKey, registerRows, registerSummary, withDisposition, registerCSV, projectKey, manualRows, manualSummary, withManualCheck } from './src/dispositions.mjs';
import { SHIP as INPUT_SHIP, applyInputConfirmations, withInputConfirmation, withoutInputConfirmation } from './src/input-confirmations.mjs';
import { createFallbackViewer } from './viewer-fallback.js';
import { createLocalViewer } from './viewer-stream.js';
import { loadOfficialText } from './regulation-text.js';
import { dxfToModel, resultsToDxf } from './src/autocad.mjs';

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

const LABEL = { compliant: 'No deviation found', non_compliant: 'Non-compliant', not_enough_info: 'Not enough info', scope_open: 'Applicability open', null: 'No rule' };
// A "not enough info" result that is undecided only because the model does not say whether the rule applies. The
// list filters it on its own: on a real model it is thousands of checks that one answer per rule settles.
const scopeOpen = (r) => r.status === 'not_enough_info' && r.applicability === 'unknown';
const filterKey = (r) => (scopeOpen(r) ? 'scope_open' : r.status);
const STATUS_CHIPS = ['non_compliant', 'not_enough_info', 'scope_open', 'compliant', 'null'];
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
// A result resting on values a drawing converter measured, read or assumed: a pre-check until a person confirms them.
function unconfirmedTag(r) {
  const u = unconfirmedInputs(r);
  if (!u.length) return '';
  const what = u.map((i) => `${i.name} (${i.basis} from the drawing)`).join(', ');
  return `<span class="tag unconfirmed" title="${esc(`Rests on ${what}, not confirmed by a person. Confirm ${u.length > 1 ? 'these values' : 'this value'} before relying on this result.`)}">pre-check: input unconfirmed</span>`;
}
// The values from a drawing that a result rests on: each stored value can be confirmed, with the name of who checked
// it against the drawing; a value computed from the geometry has no single value to confirm.
const reviewerKey = 'complee.reviewer';
const reviewerName = () => { try { return localStorage.getItem(reviewerKey) ?? ''; } catch { return ''; } };
// A confirmation for another value (the drawing was converted again, or the value changed): to be checked again.
function staleNote(i) {
  const st = S.inputConfirm?.stale.find((x) => x.element === i.value_of.element && x.prop === i.value_of.prop);
  return st ? ` <span class="disp-warn">confirmed earlier as ${esc(String(st.confirmed))}; the value changed, check it again</span>` : '';
}
function inputConfirmHTML(r) {
  const once = (list) => [...new Map(list.map((i) => [i.value_of ? `${i.value_of.element}|${i.value_of.prop}` : i.name, i])).values()];
  const open = once(unconfirmedInputs(r)), done = once(confirmedInputs(r));
  if (!open.length && !done.length) return '';
  const attrs = (i) => `data-el="${esc(i.value_of.element)}" data-prop="${esc(i.value_of.prop)}"`;
  const openRow = (i) => (i.value_of
    ? `<div class="ic-row"><span><b>${esc(i.name)}</b> = ${esc(i.value)} <span class="muted">${esc(i.basis)} from the drawing</span>${staleNote(i)}</span><button class="tiny icConfirm" ${attrs(i)} title="I checked this value against the drawing">Confirm value</button></div>`
    : `<div class="ic-row muted"><span><b>${esc(i.name)}</b> = ${esc(i.value)}: computed from the drawing geometry; check it on the drawing</span></div>`);
  const doneRow = (i) => `<div class="ic-row ok"><span>✓ <b>${esc(i.name)}</b> = ${esc(i.value)} confirmed by ${esc(i.confirmed_by)}${i.confirmed_at ? `, ${esc(new Date(i.confirmed_at).toLocaleDateString('en-GB'))}` : ''}</span>${i.value_of ? `<button class="tiny icUndo" ${attrs(i)}>Undo</button>` : ''}</div>`;
  const canConfirm = open.some((i) => i.value_of);
  return `<div class="ic"><div class="ic-head">Values from the drawing</div>
    ${open.map(openRow).join('')}${done.map(doneRow).join('')}
    ${canConfirm ? `<div class="ic-who"><input class="icWho" placeholder="Checked by (required)" value="${esc(reviewerName())}" size="22"></div>` : ''}</div>`;
}
function setInputConfirmation(element, prop, who) {
  const p = element === INPUT_SHIP ? S.model.ship?.[prop] : elById(element)?.props?.[prop];
  if (!p || typeof p !== 'object') return;
  if (who) {
    S.register = withInputConfirmation(S.register, { element, prop, value: p.value, unit: p.unit, basis: p.basis }, { responsible: who, revision: revisionLabel(S.sc) });
    try { localStorage.setItem(reviewerKey, who); } catch { /* storage blocked: the name is asked again */ }
  } else S.register = withoutInputConfirmation(S.register, element, prop);
  saveRegister();
  S.inputConfirm = applyInputConfirmations(S.model, S.register);
  recheck(element === INPUT_SHIP ? undefined : [element]);
}
function wireInputConfirmations(root) {
  root.querySelectorAll('.icConfirm').forEach((b) => (b.onclick = () => {
    const who = b.closest('.ic')?.querySelector('.icWho');
    if (!who?.value.trim()) { who?.classList.add('need'); who?.focus(); return; }
    setInputConfirmation(b.dataset.el, b.dataset.prop, who.value.trim());
  }));
  root.querySelectorAll('.icUndo').forEach((b) => (b.onclick = () => setInputConfirmation(b.dataset.el, b.dataset.prop, null)));
}

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
  // "aps" is the legacy name of the real-model viewer (the review no longer contacts APS): same as "local".
  const want = sc.viewer === 'local' || sc.viewer === 'aps' ? 'local' : 'three';
  // Staying in the real-model viewer (real ship <-> corridor scene): keep its geometry and keep it on screen.
  const stayLocal = want === 'local' && !$('#localView').hidden;
  views.local?.setActive?.(false, { keepTiles: stayLocal });
  $('#threeView').hidden = want !== 'three';
  $('#apsView').hidden = true;
  if (!stayLocal) $('#localView').hidden = true;
  $('#fallbackView').hidden = true;
  $('#planBtn').hidden = want !== 'three';
  $('#viewTools').hidden = want !== 'three';
  $('#dxfBtn').hidden = want !== 'three'; // layout models have plan geometry to mark up; the parts model does not
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
  loadVerification(); // not awaited: the viewer works without the verification database
}

// Verification level of every rule from the rule-verification database (verify.html). Only when the loaded rule is
// exactly the verified version; without the backend the viewer keeps the catalog's own "verified" flag.
async function loadVerification() {
  try {
    const res = await fetch('api/rule-verification/status');
    if (!res.ok) return;
    S.verification = await statusForRules(allRules(), await res.json());
  } catch { return; }
  renderSummary();
  if (S.selected && !S.ruleView) renderResults(S.selected);
}

function verificationTag(ruleId, verifiedFlag) {
  const v = S.verification?.[ruleId];
  if (!v) return verifiedFlag ? '<span class="tag blue">Value verified</span>' : '<span class="tag">Rule value not yet verified against official text</span>';
  if (!v.matches) return `<span class="tag" title="The verification database holds version ${v.version} of this rule, which differs from the rule loaded here">Other version in the verification database</span>`;
  const who = v.level === 2 ? ` by ${v.reviewed_by}, ${(v.reviewed_at || '').slice(0, 10)}` : v.level === 1 ? ` by ${v.text_checked_by}, ${(v.text_checked_at || '').slice(0, 10)}` : '';
  const cls = v.level === 2 ? 'tag blue' : v.level === 1 ? 'tag review' : 'tag';
  return `<span class="${cls}" title="${esc((v.sources || []).join('; '))}">${esc(LEVEL_LABEL[v.label] ?? v.label)}${esc(who)}</span>`;
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
    const e = (elements[f.element] ??= { id: f.element, name: f.name, type: 'part', deck: f.deck, worst: null, results: [], not_applicable: [], superseded: [], governing: {}, conflicts: [] });
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
    // One copy of the model in memory: the original of an element is kept only once it is edited (S.original).
    S.model = model;
    S.original = new Map();
    S.norm = normalizeModel(S.model);
    S.expected = expected;
    S.edits.clear();
    S.shipOriginal = null;
    S.keelNote = null;
    S.register = loadRegister(sc, model);
    // Values from a drawing that a person confirmed (stored with the register): marked before the check runs.
    S.inputConfirm = applyInputConfirmations(S.model, S.register);
    closeRegister();
    S.selected = null;
    S.ruleView = null;
    traceState = { findingsOnly: null, limit: TRACE_PAGE };
    closeTrace();
    listLimit = LIST_PAGE;
    // Start at the full overview; filtering by status hides the rest geometry.
    S.filter.status = new Set(STATUS_CHIPS);
    // Ground-truth score is computed on the unedited design with the core rule set only.
    // The model is unedited here, so this one check is also the ground-truth run (no second pass over the model).
    runCheck();
    S.baseline = precomputed ? precomputed.score : expected ? scoreResults(S.results, expected) : null;
    if (S.baseline && !S.baseline.line) S.baseline.line = scoreLine(S.baseline);
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
      decks.map((d) => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('');
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
    : ids && S.results ? recheckElements(S.results, S.model, allRules(), ids, { inPlace: true }) : checkModel(S.model, allRules());
  S.lastCheckMs = performance.now() - t0;
}

function recheck(ids) {
  runCheck(ids);
  computeEscape({ force: S.escapeOn });
  if (!S.escape) S.escapeOn = false;
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

// Ship particulars folded into one line, so the findings are on the first screen; open for every value and its source.
let shipOpen = false;
function shipLine(sh, len) {
  const v = (k) => readValue(sh[k], S.norm.units, sh.source);
  const parts = [v('type')?.value, v('length_overall') && `${len(v('length_overall'))} LOA`, v('class_society') && `class ${v('class_society').value}`].filter(Boolean);
  return `Ship particulars${parts.length ? `: ${parts.join(' · ')}` : ''}`;
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
    <details class="ship-more" id="shipMore" ${shipOpen || S.keelNote ? 'open' : ''}><summary>${esc(shipLine(sh, len))}</summary>
    <table class="kv" style="margin-top:6px">
      ${row('Ship type', 'type', (v) => v.value)}
      ${row('Operating area', 'operating_area', list)}
      ${row('Length overall', 'length_overall', len)}
      ${row('Beam', 'beam', len)}
      ${row('Draft', 'draft', len)}
      ${row('Berths', 'berths', (v) => v.value)}
      ${row('Gross tonnage', 'gross_tonnage', (v) => v.value)}
      ${row('Class society', 'class_society', (v) => v.value)}
      ${keelRow()}
      ${sh.propulsion ? row('Propulsion', 'propulsion', (v) => v.value) : ''}
    </table>
    ${S.model.kind === 'parts' ? '' : '<button class="tiny" id="dlModel" style="margin-top:6px" title="The model as a ship/1 JSON file: the format Open… reads">Download model (JSON)</button>'}
    </details>
    ${S.model.provenance_note ? `<div class="note">${esc(S.model.provenance_note)}</div>` : ''}
    ${S.model.scope_note ? `<div class="note scope">${esc(S.model.scope_note)}</div>` : ''}`;
  $('#shipMore').ontoggle = (e) => { shipOpen = e.target.open; };
  if ($('#dlModel')) $('#dlModel').onclick = () => download(`${S.sc.id}.json`, JSON.stringify(S.model, null, 1), 'application/json');
  if ($('#keelWhatIf')) $('#keelWhatIf').onchange = (e) => setKeelDate(e.target.value);
}

// Rules whose applicability depends on the date of construction (applies_to.ship.constructed).
const dateRules = () => allRules().filter((r) => !r.draft && r.applies_to?.ship?.constructed);

// Keel laying date: shown always (it decides which edition of a requirement applies); a what-if date when rules
// in the catalog depend on it, so the engineer sees what changes for a ship laid down before or after a date.
function keelRow() {
  const v = readValue(S.model.ship?.keel_laid, null, S.model.ship?.source);
  const n = dateRules().length;
  const editable = n && S.model.kind !== 'parts' && !S.precomputed;
  return `<tr><td title="SOLAS: keel laid or similar stage of construction">Keel laid</td><td>${v ? `${esc(v.value)}${prov(v.source)}` : '<span class="muted">not given</span>'}
    ${editable ? `<div class="keel-whatif"><input type="date" id="keelWhatIf" value="${esc(/^\d{4}-\d{2}-\d{2}$/.test(v?.value ?? '') ? v.value : '')}" title="What-if: another keel laying date"> <span class="muted">${n} rule${n === 1 ? '' : 's'} depend${n === 1 ? 's' : ''} on it</span></div>` : ''}
    ${S.keelNote ? `<div class="note">${esc(S.keelNote)}</div>` : ''}</td></tr>`;
}

function setKeelDate(value) {
  if (!value) return;
  if (!S.shipOriginal) S.shipOriginal = structuredClone(S.model.ship ?? {});
  // Per date-dependent rule: applies (somewhere), undecided (date missing or not exact) or does not apply.
  const states = () => {
    const out = new Map(dateRules().map((r) => [r.id, 'does not apply']));
    for (const e of Object.values(S.results.elements)) for (const r of e.results) {
      if (!out.has(r.rule_id)) continue;
      if (r.applicability === 'unknown') { if (out.get(r.rule_id) !== 'applies') out.set(r.rule_id, 'undecided'); } else out.set(r.rule_id, 'applies');
    }
    return out;
  };
  const before = { findings: findingsOf(S.results).length, states: states() };
  const was = display(S.shipOriginal.keel_laid, S.norm.units);
  S.model.ship = { ...(S.model.ship ?? {}), keel_laid: { value, source: EDIT_SOURCE } };
  S.edits.set('ship.keel_laid', { id: 'ship', key: 'keel_laid', before: was, after: value });
  recheck();
  const now = states();
  const changes = [...now].filter(([id, st]) => before.states.get(id) !== st).map(([id, st]) => `${id}: ${before.states.get(id)} → ${st}`);
  const after = findingsOf(S.results).length;
  S.keelNote = `Keel laid ${value}: ${after} finding${after === 1 ? '' : 's'} (${after - before.findings >= 0 ? '+' : ''}${after - before.findings}). `
    + (changes.length ? `${changes.join('; ')}.` : 'No date-dependent rule changes.');
  renderShip();
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

// What the automatic check covers and what is left to a person: shown next to the result, so "no deviation" is
// never read as full compliance.
function verifiedLine(c) {
  if (!S.verification) return `${c.automatic_verified} with verified values`;
  const applied = [...new Set(Object.values(S.results.elements).flatMap((e) => e.results.map((r) => r.rule_id)))];
  const v = verificationCounts(applied, S.verification);
  return `${v.reviewed} engineering-reviewed, ${v.text_checked} text-checked${v.other_version ? `, ${v.other_version} with another version in the database` : ''}; <a href="verify.html" target="_blank" rel="noopener">rule verification ↗</a>`;
}

function coverageHTML() {
  const c = coverageOf(S.results, allRules());
  const m = manualSummary(manualRows(S.results, S.register));
  const tip = c.by_source.map((x) => `${x.source}: ${x.automatic} automatic, ${x.manual} manual`).join('\n');
  return `<div class="coverage" title="${esc(tip)}">
    <b>Coverage:</b> ${c.automatic} rules checked automatically (${verifiedLine(c)}) · ${m.total ? `<b>${m.open} of ${m.total}</b> manual checks open` : 'no manual checks for this model'}.
    <span class="muted">Requirements that are not in the rule catalog are not checked at all. Approval stays with class and flag.</span></div>`;
}

// Submission readiness: the open work between this revision and a submission, one click from each item to the
// place where it is cleared. Plus the project file, so the register and comments are not tied to this browser.
const readinessOf = () => readiness({ results: S.results, register: S.register, comments: S.comments?.comments ?? [], rules: allRules(), edits: S.edits.size });
let readinessOpen = false;
function readinessHTML() {
  if (S.precomputed) return '';
  const r = readinessOf();
  const line = (i) => `<li class="${i.level}"><a href="#" class="readyGo" data-id="${esc(i.id)}"><b>${i.count}</b> ${esc(i.text)}</a></li>`;
  return `<details class="ready ${r.complete ? 'ok' : r.ready ? 'part' : 'bad'}" id="readyBox" ${readinessOpen ? 'open' : ''}>
    <summary>${readinessTitle(r)}${r.warnings ? ` · ${r.warnings} warning${r.warnings === 1 ? '' : 's'}` : ''}</summary>
    ${r.items.length ? `<ul>${r.items.map(line).join('')}</ul>` : '<p class="muted">No open work recorded for this revision.</p>'}
    <p class="muted">Counts open work only; compliance is decided by the rule check and, finally, by class and flag.</p>
    <div class="ready-actions"><button class="tiny" id="projSave" title="Findings register, manual-check confirmations and class comments as one file: back it up or hand it to a colleague">Save project file</button>
      <button class="tiny" id="projOpen" title="Open a project file saved here or by a colleague">Open project file…</button><input id="projFile" type="file" accept=".json,application/json" hidden></div>
  </details>`;
}

function wireReadiness() {
  const box = $('#readyBox');
  if (!box) return;
  box.ontoggle = () => { readinessOpen = box.open; };
  box.querySelectorAll('.readyGo').forEach((a) => (a.onclick = (e) => { e.preventDefault(); goReadiness(readinessOf().items.find((i) => i.id === a.dataset.id)); }));
  $('#projSave').onclick = () => {
    const file = projectFile({ project: S.registerProject, model: S.model.name, revision: revisionLabel(S.sc), register: S.register, comments: S.comments?.comments ?? [], revisions: S.registerMeta?.revisions ?? [] });
    const name = String(S.model.name || 'project').replace(/[^\w .()-]+/g, '_').slice(0, 60);
    download(`${name}.complee-project.json`, JSON.stringify(file, null, 1), 'application/json');
  };
  $('#projOpen').onclick = () => $('#projFile').click();
  $('#projFile').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const p = readProjectFile(await f.text(), S.registerProject);
      const here = Object.keys(S.register).length + (S.comments?.comments?.length ?? 0);
      const msg = `Open "${f.name}"${p.saved ? ` (saved ${new Date(p.saved).toLocaleString('en-GB')})` : ''}: ${Object.keys(p.register).length} register entries and ${p.comments.length} class comments.`
        + (p.problems.length ? `\n\nNot taken over: ${p.problems.join('; ')}.` : '')
        + (p.other_project ? `\n\nIt was saved for another project (${p.model ?? p.project}).` : '')
        + (here ? `\n\nThis replaces the ${here} entries saved in this browser for this project.` : '');
      if (!confirm(msg)) return;
      S.register = p.register; saveRegister();
      S.comments = { comments: p.comments }; saveComments();
      recheck();
      if (!$('#registerPanel').hidden) openRegister();
    } catch (err) {
      alert(err.message);
    }
  };
}

function goReadiness(item) {
  if (!item) return;
  const firstWith = (test) => Object.values(S.results.elements).find(test)?.id;
  switch (item.go) {
    case 'register': registerTab = 'findings'; registerOpenOnly = true; openRegister(); break;
    case 'comments': registerTab = 'comments'; commentsOpenOnly = true; openRegister(); break;
    case 'manual': { const id = firstWith((e) => manualRows({ elements: { [e.id]: e } }, S.register).some((m) => !m.done)); if (id) select(id); break; }
    case 'edits': $('#edits')?.scrollIntoView({ block: 'center', behavior: 'smooth' }); break;
    case 'rules': $('#rulesBox')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); break;
    // Applicability open: the list shows only those checks, and the first one is opened (its explanation says what
    // the rule's scope depends on).
    case 'scope': {
      S.filter.status = new Set(['scope_open']);
      renderFilters(); renderList();
      const id = firstWith((e) => e.results.some(scopeOpen));
      if (id) select(id);
      break;
    }
    default: {
      const id = item.id === 'conflicts' ? firstWith((e) => e.conflicts?.length) : firstWith((e) => e.results.some((r) => r.status === 'not_enough_info' && !scopeOpen(r)));
      if (id) select(id);
    }
  }
}

// Model elements the checker had to rename or skip, and rules it did not run: shown above the results, never hidden.
function dataIssuesHTML() {
  const m = S.results.model_issues || [], bad = S.results.invalid_rules || [];
  if (!m.length && !bad.length) return '';
  const list = (items) => `<ul>${items.slice(0, 8).map((t) => `<li>${esc(t)}</li>`).join('')}${items.length > 8 ? `<li>… ${items.length - 8} more</li>` : ''}</ul>`;
  return `<div class="note">${m.length ? `<b>${m.length} model data error${m.length === 1 ? '' : 's'}</b>${list(m.map((i) => i.text))}` : ''}${bad.length ? `<b>${bad.length} rule${bad.length === 1 ? '' : 's'} not run (invalid)</b>${list(bad.map((r) => `${r.id}: ${r.errors.join('; ')}`))}` : ''}</div>`;
}

// Number of applicability-open results, counted once per check (results are re-checked in place: the stamp is the
// time of the last check).
let scopeMemo = { results: null, stamp: null, n: 0 };
function scopeCount() {
  if (scopeMemo.results === S.results && scopeMemo.stamp === S.lastCheckMs) return scopeMemo.n;
  let n = 0;
  for (const id in S.results.elements) for (const r of S.results.elements[id].results) if (scopeOpen(r)) n++;
  scopeMemo = { results: S.results, stamp: S.lastCheckMs, n };
  return n;
}

function renderSummary() {
  const s = S.results.summary, e = S.results.element_summary;
  $('#summary').innerHTML = `
    <div class="pills" id="pills">
      <div class="pill st-non_compliant">${s.non_compliant}<small>non-compliant</small></div>
      <div class="pill st-not_enough_info" title="${scopeCount() ? `${scopeCount().toLocaleString('en')} of them only because the model does not say whether the rule applies` : ''}">${s.not_enough_info}<small>missing info${scopeCount() ? `, ${scopeCount().toLocaleString('en')} of them applicability open` : ''}</small></div>
      <div class="pill st-compliant" title="No deviation in the rules checked automatically. This is not a statement of full compliance: see the manual checks.">${s.compliant}<small>no deviation</small></div>
    </div>
    <div class="muted">Rule checks per element. Elements: ${e.non_compliant} red, ${e.not_enough_info} amber, ${e.compliant} green, ${e.no_rule} without a rule. Checked in ${S.lastCheckMs.toFixed(1)} ms.</div>
    ${dataIssuesHTML()}
    ${coverageHTML()}
    ${readinessHTML()}`;
  wireReadiness();
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
  const chips = STATUS_CHIPS
    .map((st) => `<span class="chip ${S.filter.status.has(st) ? 'on' : ''}" data-st="${st}"${st === 'scope_open' ? ' title="Not enough info only because the model does not say whether the rule applies"' : ''}>${LABEL[st]}</span>`).join('');
  $('#filters').innerHTML = `<div class="chips">${chips}</div>
    <div class="filters-row">
      <select id="fFam"><option value="">All rule sources</option>${fams.map((f) => `<option ${S.filter.family === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select>
      <select id="fDeck"><option value="">All decks</option>${S.norm.decks.map((d) => `<option value="${esc(d.id)}" ${S.filter.deck === d.id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select>
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
    return rs.some((r) => f.status.has(filterKey(r)));
  });
}

// A model converted from a drawing: its elements carry a basis (measured, read, typed, assumed). Design models do not,
// so the list does not look at the inputs of their (possibly many, lazily built) results.
const fromDrawing = () => (S.norm.__fromDrawing ??= S.norm.elements.some((e) => e.basis != null));
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
      ${bad.length ? `<span class="rules">${bad.map((r) => `<span class="rtag st-${r.status}">${esc(r.rule_id)}</span>`).join('')}${fromDrawing() && bad.some((r) => unconfirmedInputs(r).length) ? '<span class="rtag pre" title="Rests on a value from the drawing that no one has confirmed yet">pre-check</span>' : ''}</span>` : ''}
    </div>`;
  }).join('') + (items.length > shown.length ? `<button class="more" id="moreBtn">Show ${Math.min(LIST_PAGE, items.length - shown.length)} more (${(items.length - shown.length).toLocaleString('en')} hidden)</button>` : '');
  if (!items.length) $('#list').innerHTML = '<p class="muted">No element matches the filters.</p>';
  if ($('#moreBtn')) $('#moreBtn').onclick = () => { listLimit += LIST_PAGE; renderList(); };
  document.querySelectorAll('#list .item').forEach((n) => (n.onclick = () => select(n.dataset.id)));
  const all = S.filter.status.size === STATUS_CHIPS.length && !S.filter.family && !S.filter.deck && !(S.filter.text ?? '').trim();
  viewer.setFilter(all ? null : new Set(items.map((e) => e.id)));
}

// ---------- detail panel ----------

function select(id, { fly = true } = {}) {
  // Comments and register entries can name elements of another revision: say so instead of selecting nothing.
  if (!elById(id)) { alert(`${id} is not in this model (renamed, removed, or from another revision).`); return; }
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
    <div class="muted">${esc(el.type)} · ${esc(deckName(el.deck))}${el.objectid != null ? ` · viewer dbId ${esc(el.objectid)}` : ''} · source: ${prov(el.source || S.model.source || 'not stated')}</div>
    <div id="dStatus" style="margin-top:6px"></div>
    ${S.sc.viewer === 'local' ? '<button id="backOverview" class="tiny" style="margin-top:6px">← Back to the whole ship</button>' : ''}
    ${el.note ? `<div class="note"><b>Model note:</b> ${esc(el.note)}</div>` : ''}
    ${e?.results?.length
      // An element with rule results: why it passes or fails comes first. A room without rules: its escape routes.
      ? '<div id="dResults"></div><div id="dEscape"></div><div id="dComponent"></div><div id="dGeom"></div>'
      : '<div id="dEscape"></div><div id="dComponent"></div><div id="dGeom"></div><div id="dResults"></div>'}
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

const ESCAPE_CLASS = { two_routes: 'compliant', direct: 'compliant', shared_route: 'not_enough_info', single_route: 'not_enough_info', no_route: 'non_compliant' };
const ESCAPE_ORDER = { no_route: 0, single_route: 1, shared_route: 2, two_routes: 3, direct: 4 };
const metres = (mm) => `${(mm / 1000).toFixed(1)} m`;
const escapeRooms = () => Object.values(S.escape?.origins ?? {}).filter((o) => o.room);

// Large models: the route analysis takes seconds, so it runs when the escape plan is opened, not on every load and
// edit (S.escapePending: available on demand).
const ESCAPE_EAGER_MAX = 1500;
function computeEscape({ force = false } = {}) {
  S.escape = null;
  S.escapePending = false;
  if (S.model.kind === 'parts') return;
  if (!force && S.norm.elements.length > ESCAPE_EAGER_MAX) {
    const musters = new Set(S.model.escape?.muster_types ?? ['muster_station']);
    S.escapePending = S.norm.elements.some((e) => musters.has(e.type));
    return;
  }
  try {
    const analysis = analyzeEscape(S.norm, { blocked: S.blocked });
    if (analysis.available) S.escape = analysis;
  } catch (e) { console.warn('Escape analysis failed:', e); }
}

function syncEscapeView() {
  const three = viewer === views.three;
  $('#escapeBtn').hidden = (!S.escape && !S.escapePending) || !three;
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
  if (on && !S.escape && S.escapePending) {
    const btn = $('#escapeBtn');
    btn.textContent = 'Analysing routes…';
    btn.disabled = true;
    setTimeout(() => { // after the button has repainted
      try { computeEscape({ force: true }); } finally { btn.textContent = 'Escape plan'; btn.disabled = false; }
      setEscapeMode(true);
    }, 30);
    return;
  }
  S.escapeOn = on && !!S.escape;
  renderEscape();
  syncEscapeView();
  if (S.selected) renderEscapeDetail(S.selected);
  if (S.escapeOn && !S.selected) showOverview();
}

function toggleBlock(id) {
  if (S.blocked.has(id)) S.blocked.delete(id); else S.blocked.add(id);
  S.escapeOn = true;
  computeEscape({ force: true });
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
      <div class="pill st-not_enough_info" title="Single route, or two routes that meet in the same corridor or space">${s.single_route + s.shared_route}<small>single / shared</small></div>
      <div class="pill st-compliant" title="Two routes that share nothing but the room, the muster station and open deck">${s.two_routes + s.direct}<small>two independent</small></div>
    </div>
    <div class="muted">Walking routes from every room to ${a.musters.map((m) => `<a href="#" class="via" data-id="${esc(m)}">${esc(elById(m)?.name ?? m)}</a>`).join(', ')}.
      ${longest ? `Longest: <b>${metres(longest.primary.length_mm)}</b> from ${esc(longest.id)}.` : ''}
      Derived from the model geometry; rule results come only from the checker.</div>
    ${a.blocked.length ? `<div class="note"><b>What-if, blocked:</b> ${a.blocked.map((id) => `<code>${esc(id)}</code>`).join(' ')} <button class="tiny" id="escReset">clear</button></div>` : ''}
    ${a.rooms_with_assumed_openings ? `<div class="note"><b>${a.rooms_with_assumed_openings} room${a.rooms_with_assumed_openings === 1 ? '' : 's'}</b> leave${a.rooms_with_assumed_openings === 1 ? 's' : ''} through an opening that is not a modelled door (the room touches a corridor or deck area, so an opening is assumed). Model the doors to make the routes definite.</div>` : ''}
    ${a.unplaced?.length ? `<div class="note"><b>Not placed:</b> ${a.unplaced.slice(0, 8).map((id) => `<code>${esc(id)}</code>`).join(' ')}${a.unplaced.length > 8 ? ` and ${a.unplaced.length - 8} more` : ''}: no usable geometry, left out of the routes.</div>` : ''}
    ${a.disconnected.length ? `<div class="note"><b>Not connected:</b> ${a.disconnected.map((d) => `<a href="#" class="via" data-id="${esc(d.id)}">${esc(d.id)}</a>: ${esc(d.reason)}`).join('; ')}.</div>` : ''}
    <div class="esc-legend"><span><i class="swatch primary"></i>Shortest route</span><span><i class="swatch secondary"></i>Independent alternative</span></div>
    <div id="escList">${rooms.map((o) => {
      const el = elById(o.id);
      return `<div class="item esc ${S.selected === o.id ? 'sel' : ''}" data-id="${esc(o.id)}" title="${esc(ESCAPE_LABEL[o.status])}">
        <span class="dot st-${ESCAPE_CLASS[o.status]}"></span>
        <span><b>${esc(o.id)}</b> ${esc(el?.name ?? '')} <span class="deckTag">· ${esc(el?.deck ?? '')}</span><span class="len">${o.primary ? metres(o.primary.length_mm) : '–'}</span></span>
      </div>`;
    }).join('')}</div>
    <div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap"><button id="escAiBtn" class="ai-btn" ${s.single_route + s.shared_route + s.no_route ? '' : 'disabled'} title="AI proposes design changes; Complee recomputes every proposal and shows only those that give rooms a second independent route">✦ Suggest improvements</button><button id="escCsv">Export routes (CSV)</button></div>
    <div id="escAi" class="escAiSlot">${escAiHTML()}</div>
    <details class="assume"><summary>How the routes are derived</summary><ul>${a.assumptions.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></details>`;
  box.querySelectorAll('.item.esc').forEach((n) => (n.onclick = () => select(n.dataset.id)));
  box.querySelectorAll('a.via').forEach((n) => (n.onclick = (e) => { e.preventDefault(); select(n.dataset.id); }));
  if ($('#escReset')) $('#escReset').onclick = () => { S.blocked.clear(); toggleBlockRefresh(); };
  $('#escCsv').onclick = exportEscapeCSV;
  $('#escAiBtn').onclick = () => suggestEscapeImprovements();
  wireEscAi();
}

function toggleBlockRefresh() {
  computeEscape({ force: true });
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
    if (o.secondary) html += routeHTML(o.status === 'shared_route' ? 'Second route (not independent)' : 'Independent alternative', o.secondary, 'secondary');
    if (o.status === 'two_routes' && o.common_start?.length) html += `<div class="muted">Both routes leave the room into ${o.common_start.map((g) => `<code>${esc(g)}</code>`).join(', ')} and separate there: the corridor leads two ways.</div>`;
    if (o.status === 'shared_route') html += `<div class="na">Both routes pass ${o.shared.map((g) => `<code>${esc(g)}</code>`).join(', ')}: a fire there blocks both. Block ${o.shared.length > 1 ? 'one of them' : 'it'} to see what remains.</div>`;
    if (o.status === 'single_route') html += `<div class="na">Every route found passes ${o.shared_gates.map((g) => `<code>${esc(g)}</code>`).join(', ')}. No route avoids all of them.</div>`;
    if (o.assumed_openings?.length) html += `<div class="muted">Through ${o.assumed_openings.length === 1 ? 'an opening' : 'openings'} assumed where no door is modelled: ${o.assumed_openings.map((g) => `<code>${esc(g)}</code>`).join(', ')}.</div>`;
    if (o.status === 'no_route') html += '<div class="na">The model contains no connected way from here to a muster station.</div>';
  }
  for (const d of broken) html += `<div class="note"><b>Not connected:</b> ${esc(d.reason)}.</div>`;
  if (canBlock) html += `<button id="blockBtn" class="tiny" style="margin-top:6px" title="What-if: fire or obstruction. The model is not changed.">${isBlocked ? 'Unblock' : `Block this ${esc(el.type.replace('_', ' '))} (what-if)`}</button>`;
  if (!S.escapeOn) html += ' <button id="showEscape" class="tiny" style="margin-top:6px">Show in the model</button>';
  if (o?.room && (o.status === 'single_route' || o.status === 'shared_route' || o.status === 'no_route')) {
    const busy = S.escAi?.loading;
    html += `<div style="margin-top:8px"><button id="escAiRoomBtn" class="ai-btn" ${busy ? 'disabled' : ''} title="AI proposes design changes for this room; Complee recomputes every proposal and keeps only those that give it a second independent route">✦ ${S.escAi && !busy ? 'Ask the AI again for this room' : 'Find a second route with AI'}</button></div>
      <div class="escAiSlot" data-room="${esc(id)}">${escAiHTML(id)}</div>`;
  }
  box.innerHTML = html;
  box.querySelectorAll('a.via').forEach((n) => (n.onclick = (e) => { e.preventDefault(); select(n.dataset.id); }));
  if ($('#blockBtn')) $('#blockBtn').onclick = () => toggleBlock(id);
  if ($('#showEscape')) $('#showEscape').onclick = () => { setEscapeMode(true); select(id); };
  if ($('#escAiRoomBtn')) $('#escAiRoomBtn').onclick = () => suggestEscapeImprovements(id);
  wireEscAi();
}

function exportEscapeCSV() {
  const q = csvCell; // quotes, and neutralises text Excel would run as a formula
  // What-if blockings, the assumed openings and what both routes share are part of every row: the file must not read
  // as the design's result when it is a what-if, nor hide what the status rests on.
  const blocked = S.escape.blocked.join(' ');
  const rows = [['room', 'name', 'deck', 'status', 'shortest_m', 'shortest_via', 'muster_station', 'narrowest_clear_width_mm', 'narrowest_at', 'alternative_m', 'alternative_via',
    'both_routes_pass', 'assumed_openings', 'what_if_blocked', 'note']];
  for (const o of escapeRooms()) {
    const el = elById(o.id);
    rows.push([o.id, el?.name, el?.deck, ESCAPE_LABEL[o.status],
      o.primary ? (o.primary.length_mm / 1000).toFixed(1) : '', o.primary?.via.join(' > '), o.primary?.muster, o.primary?.narrowest?.width_mm, o.primary?.narrowest?.id,
      o.secondary ? (o.secondary.length_mm / 1000).toFixed(1) : '', o.secondary?.via.join(' > '),
      (o.status === 'shared_route' ? o.shared : o.status === 'single_route' ? o.shared_gates : [])?.join(' '), (o.assumed_openings ?? []).join(' '), blocked,
      'analysis aid derived from the model geometry; not a rule result']);
  }
  // BOM and CRLF like the other CSV exports, so Excel reads names with special characters correctly.
  download(`${S.sc.id}-escape-routes${blocked ? '-what-if' : ''}.csv`, '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n'), 'text/csv');
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
  if (id === 'ship') {
    const orig = S.shipOriginal?.[key];
    const ship = { ...(S.model.ship ?? {}) };
    if (orig === undefined) delete ship[key]; else ship[key] = structuredClone(orig);
    S.model.ship = ship;
    S.edits.delete(`ship.${key}`);
    S.keelNote = null;
    recheck();
    renderShip();
    return;
  }
  const el = elById(id);
  const orig = S.original.get(id)?.props?.[key];
  if (orig === undefined) delete el.props[key]; else el.props[key] = structuredClone(orig);
  S.edits.delete(`${id}.${key}`);
  recheck([id]);
  if (S.selected === id && !S.ruleView) renderEditor(id);
}

// ---------- rule view: requirement -> parts ----------

const PLURAL = { hatch: 'hatches', plate: 'plates', stiffener: 'stiffeners', structure_part: 'structural parts', pipe: 'oil fuel pipe items',
  corridor: 'corridors', door: 'doors', stair: 'stairs', ramp: 'ramps', fuel_tank: 'fuel tanks', guard_rail: 'guard rails',
  machinery_space: 'machinery spaces', escape_zone: 'escape zones', system_item: 'system items', manhole: 'manholes' };

// Hits of every rule, from one pass over the results; rebuilt when the results object changes.
let ruleHitsOf = null, ruleHitsIndex = new Map();
function ruleHits(ruleId) {
  if (ruleHitsOf !== S.results) {
    ruleHitsOf = S.results;
    ruleHitsIndex = new Map();
    for (const e of Object.values(S.results.elements)) {
      for (const r of e.results) {
        let hits = ruleHitsIndex.get(r.rule_id);
        if (!hits) ruleHitsIndex.set(r.rule_id, (hits = []));
        hits.push({ id: e.id, name: e.name, type: e.type, status: r.status, measured: r.measured });
      }
    }
    for (const hits of ruleHitsIndex.values()) { hits.sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0)); }
  }
  return ruleHitsIndex.get(ruleId) ?? [];
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
    <div class="tags">${verificationTag(rule.id, rule.verified)}
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
  const manual = manualRows({ elements: { [id]: e } }, S.register);
  const manualOpen = manual.filter((m) => !m.done).length;
  $('#dStatus').innerHTML = `<span class="badge st-${e.worst ?? 'none'}">${LABEL[e.worst]}</span>${manualOpen ? ` <span class="badge manual" title="Requirements a person has to confirm">${manualOpen} manual check${manualOpen === 1 ? '' : 's'} open</span>` : ''}`;
  const gov = (e.conflicts || []).map((c) =>
    `<div class="gov conflict"><b>Rule conflict on ${esc(c.parameter)}:</b> ${esc(c.lower.rule_id)} requires ${esc(c.lower.required)}, ${esc(c.upper.rule_id)} requires ${esc(c.upper.required)}. No design can meet both; clarify with the flag state or class which one applies.</div>`).join('')
    + Object.entries(e.governing).filter(([, g]) => g.count > 1).map(([p, g]) =>
    `<div class="gov"><b>${esc(g.parameter ?? p)}</b> has ${g.count} overlapping ${g.kind === 'max' ? 'upper' : 'lower'} limits here; all apply, so the strictest governs: <b>${esc(g.required)}</b> (${esc(g.rule_id)}).</div>`).join('');

  const cards = e.results.map((r) => `
    <div class="res st-${r.status}" data-rule="${esc(r.rule_id)}">
      <div class="head"><a href="#" class="ruleLink" data-rule="${esc(r.rule_id)}" title="Show every part this rule applies to">${esc(r.rule_id)}</a><span class="badge st-${r.status}">${LABEL[r.status]}</span></div>
      <div class="muted">${esc(r.source)} - ${esc(r.clause)}</div>
      <table class="kv" style="margin-top:4px"><tr><td>Measured</td><td>${esc(r.measured ?? 'missing')}</td></tr><tr><td>Required</td><td>${esc(r.required)}</td></tr></table>
      <div class="expl">${esc(r.explanation)}</div>
      ${r.inputs.length ? `<div class="inputs">Inputs: ${r.inputs.map((i) => `${esc(i.name)} = ${esc(i.value)}${prov(i.source)}`).join('; ')}</div>` : ''}
      <blockquote>“${esc(r.rule_text)}”</blockquote>
      <div class="tags">
        ${unconfirmedTag(r)}
        ${verificationTag(r.rule_id, r.verified)}
        ${r.review_status ? `<span class="tag review" title="How the value is shown was reviewed; this is not a verification against the official text">${esc(r.review_status)}</span>` : ''}
        <span class="tag grey">${r.text_status === 'verbatim' ? 'verbatim text' : 'paraphrased text'}</span>
        ${r.basis !== 'explicit' ? `<span class="tag grey" title="${esc(ruleById(r.rule_id)?.basis_note || '')}">basis: ${esc(r.basis)}</span>` : ''}
        ${r.same_requirement_as?.length ? `<span class="tag grey" title="Same limit on the same value from another instrument: one requirement, two sources">same requirement as ${esc(r.same_requirement_as.join(', '))}</span>` : ''}
        ${r.reference_url ? `<a class="tag grey" href="${esc(r.reference_url)}" target="_blank" rel="noopener">official source ↗</a>` : ''}
      </div>
      ${inputConfirmHTML(r)}
      ${r.status !== 'compliant' ? `<div class="ai-row"><button class="tiny ai-btn explainBtn" data-rule="${esc(r.rule_id)}" title="Plain-language explanation, exceptions to check and ways to resolve it (AI)">✦ Explain</button></div><div class="ai-out" data-explain="${esc(r.rule_id)}">${explainHTML(id, r)}</div>` : ''}
      ${r.status !== 'compliant' ? dispositionHTML(id, r) : ''}
      </div>`).join('') || '<p class="muted">No rule in the current rule set applies to this element.</p>';

  // "Also required": related rules not applied to this element, and where they are checked in the model.
  const applied = new Set([...e.results, ...(e.superseded || [])].map((r) => r.rule_id));
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
  const sup = (e.superseded || []).map((x) => `<div class="na">• <b>${esc(x.rule_id)}</b> ${x.type === 'exempts' ? 'is lifted by the exemption in' : 'is replaced by'} <b>${esc(x.by)}</b> (${esc(x.basis)}). It would have been ${esc(LABEL[x.status].toLowerCase())}${x.required && x.required !== '-' ? ` (required ${esc(x.required)})` : ''}.</div>`).join('');

  $('#dResults').innerHTML = `${gov}
    <h2>Rules applied (${e.results.length})</h2>${cards}
    <h2 id="alsoHead">Also required (${related.length})</h2>
    ${also || '<p class="muted">No related rules outside the ones applied above.</p>'}
    ${manual.length ? `<h2>Manual checks (${manual.length - manualOpen} of ${manual.length} confirmed)</h2>
      <p class="muted">Not decidable from the model data. Confirm each one with the evidence named; nothing here is confirmed automatically.</p>
      ${manual.map(manualHTML).join('')}` : ''}
    ${sup ? `<h2>Replaced by a higher-ranking rule (${e.superseded.length})</h2>${sup}` : ''}
    ${na ? `<h2>Considered, not applicable (${e.not_applicable.length})</h2>${na}` : ''}`;
  document.querySelectorAll('#dResults .goto').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); select(a.dataset.id); }));
  document.querySelectorAll('#dResults .ruleLink').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); showRule(a.dataset.rule); }));
  wireDispositions($('#dResults'));
  wireManualChecks($('#dResults'));
  wireInputConfirmations($('#dResults'));
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
    if (inp.dataset.kind === 'bool' || inp.tagName === 'SELECT') { inp.addEventListener('change', commit); return; }
    // Typing: re-check once the value rests (each re-check redraws the lists), at once when the field is left.
    let timer = 0;
    const flush = () => { if (!timer) return; clearTimeout(timer); timer = 0; commit(); };
    inp.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { timer = 0; commit(); }, S.model.elements.length > 5000 ? 250 : 0); });
    inp.addEventListener('change', flush);
    inp.addEventListener('blur', flush);
  });
  $('#dEditor').querySelectorAll('[data-unit-for]').forEach((sel) => (sel.onchange = () => {
    const inp = $('#dEditor').querySelector(`[data-key="${CSS.escape(sel.dataset.unitFor)}"]`);
    if (inp.value !== '') applyEdit(id, sel.dataset.unitFor, Number(inp.value), sel.value);
  }));
}

function applyEdit(id, key, value, unit) {
  if (S.precomputed) return;
  const el = elById(id);
  if (!S.original.has(id)) S.original.set(id, structuredClone(el)); // before the first edit of this element
  const pristineEl = S.original.get(id);
  const before = display(pristineEl?.props?.[key], S.norm.units);
  el.props = el.props || {};
  const opts = el.props[key]?.options;
  // basis what-if: on a model from a drawing a typed what-if is neither measured from the drawing nor a confirmed value.
  el.props[key] = { value, ...(unit ? { unit } : {}), ...(opts ? { options: opts } : {}), source: EDIT_SOURCE, ...(el.basis != null ? { basis: 'what-if' } : {}) };
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

// The drawing panel (Drawing → 3D) lies over the 3D view like the other panels: one at a time.
function closeDrawingPanel() { $('#drawingPanel').hidden = true; $('#drawingBtn').classList.remove('on'); document.body.classList.remove('dw-open'); }

function openTrace() {
  closeRegister();
  closeAiPanel();
  closeDrawingPanel();
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

const AI_TASK = { 'explain-finding': 'Explain a finding', 'escape-suggestions': 'Escape-route proposals', 'comment-reply': 'Draft reply to a class comment' };
const aiState = { status: null, busy: 0, log: [] };
const cents = (usd) => (usd == null ? '–' : usd < 0.0005 ? '< 0.1 ct' : `${(usd * 100).toFixed(usd < 0.1 ? 1 : 0)} ct`);
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);
// 'claude-opus-5-5 (fast)' -> 'Claude Opus 5.5 fast', 'gpt-6.1-sol (ultrafast)' -> 'GPT-6.1 Sol ultrafast', 'gemini-3.8-flash' -> 'Gemini 3.8 Flash'
function modelLabel(m = '') {
  const [, base, mode] = /^(.*?)(?: \((\w+)\))?$/.exec(m) || [, m];
  const p = base.split('-');
  let out = base;
  if (p[0] === 'claude') out = `Claude ${cap(p[1])} ${p.slice(2).join('.')}`;
  else if (p[0] === 'gpt') out = `GPT-${p[1]} ${p.slice(2).map(cap).join(' ')}`;
  else if (p[0] === 'gemini') out = `Gemini ${p[1]} ${p.slice(2).map(cap).join(' ')}`;
  return mode ? `${out} ${mode}` : out;
}

async function assist(name, payload, subject = '') {
  const entry = { at: new Date(), task: AI_TASK[name] ?? name, subject, busy: true };
  aiState.log.unshift(entry);
  aiState.busy++;
  renderAiPill();
  try {
    const res = await fetch(`api/assist/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    let data = null;
    try { data = await res.json(); } catch { /* reported below */ }
    if (!res.ok) throw new Error(data?.error || `The AI service answered ${res.status}.`);
    Object.assign(entry, { model: data.model, seconds: data.duration_ms / 1000, cost: data.cost_usd, attempts: data.attempts });
    return data;
  } catch (e) {
    entry.error = e.message;
    throw e;
  } finally {
    entry.busy = false;
    aiState.busy--;
    renderAiPill();
    if (!$('#aiPanel').hidden) openAiPanel();
  }
}

// Streamed AI answer: onPartial(value, text) runs whenever more of the answer has arrived (value is the JSON as far as
// it goes), onSwitch(from, reason) when a model fails and the next one starts again. Resolves with the final answer.
async function assistStream(name, payload, subject, { onPartial, onSwitch } = {}) {
  const entry = { at: new Date(), task: AI_TASK[name] ?? name, subject, busy: true };
  aiState.log.unshift(entry);
  aiState.busy++;
  renderAiPill();
  try {
    const res = await fetch(`api/assist/${name}/stream`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!res.ok || !res.body) {
      let message = `The AI service answered ${res.status}.`;
      try { message = (await res.json()).error || message; } catch { /* keep the status text */ }
      throw new Error(message);
    }
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buffer = '', text = '', model = '', final = null, lastPaint = 0;
    const paint = (force) => {
      const now = performance.now();
      if (!force && now - lastPaint < 80) return; // at most ~12 repaints per second
      lastPaint = now;
      onPartial?.(parsePartialJson(text), text, model);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const line = block.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === 'model') { model = ev.model; entry.model = model; text = ''; paint(true); }
        else if (ev.type === 'delta') { text += ev.text; paint(false); }
        else if (ev.type === 'switch') { onSwitch?.(ev.from, ev.reason); text = ''; }
        else if (ev.type === 'done') final = ev;
        else if (ev.type === 'error') throw new Error(ev.message || 'The AI service failed.');
      }
    }
    if (!final) throw new Error('The AI answer stopped before it was complete.');
    Object.assign(entry, { model: final.model, seconds: final.duration_ms / 1000, cost: final.cost_usd, attempts: final.attempts });
    return final;
  } catch (e) {
    entry.error = e.message;
    throw e;
  } finally {
    entry.busy = false;
    aiState.busy--;
    renderAiPill();
    if (!$('#aiPanel').hidden) openAiPanel();
  }
}

async function loadAiStatus() {
  try {
    const res = await fetch('api/assist/status', { cache: 'no-store' });
    aiState.status = res.ok ? await res.json() : { available: false, error: (await res.json().catch(() => ({}))).error };
  } catch {
    aiState.status = { available: false };
  }
  renderAiPill();
}

function renderAiPill() {
  const pill = $('#aiPill');
  if (!pill) return;
  const st = aiState.status;
  const total = aiState.log.reduce((sum, e) => sum + (e.cost ?? 0), 0);
  pill.classList.toggle('busy', aiState.busy > 0);
  pill.classList.toggle('off', !st?.available);
  pill.innerHTML = aiState.busy > 0
    ? '<span class="spin"></span> AI working…'
    : !st ? '✦ AI …'
      : !st.available ? '✦ AI offline'
        : `✦ AI · ${esc(modelLabel(st.chain?.[0]))}${aiState.log.length ? ` · ${aiState.log.length} call${aiState.log.length === 1 ? '' : 's'}, ${cents(total)}` : ''}`;
  pill.title = st?.available
    ? `AI assistance is on (${st.profile === 'budget' ? 'budget profile, about 1–2 cents per answer' : st.profile === 'fast' ? 'fast profile' : 'custom chain'}). Order: ${st.chain.map(modelLabel).join(' → ')}. Click for where AI is used and what each call cost.`
    : 'AI assistance is not available: the Complee backend is not running or has no API key. Everything else works without it.';
}

function openAiPanel() {
  closeTrace(); closeRegister(); closeDrawingPanel();
  const st = aiState.status;
  const total = aiState.log.reduce((sum, e) => sum + (e.cost ?? 0), 0);
  const panel = $('#aiPanel');
  panel.innerHTML = `<div class="trace-head"><b>✦ AI assistance</b>
      <span class="muted">${st?.available ? `${st.profile === 'budget' ? 'Budget profile' : st.profile === 'fast' ? 'Fast profile' : 'Custom chain'} · ${aiState.log.length} call${aiState.log.length === 1 ? '' : 's'} this session · ${cents(total)} in total` : 'offline'}</span>
      <span class="grow"></span><button id="aiClose">Close</button></div>
    <div class="trace-wrap">
      <div class="ai-map">
        <div class="ai-map-col ai"><b>✦ Where AI works</b><ul>
          <li><b>Explain</b> on every finding card: reasons, exceptions to check, ways to resolve it.</li>
          <li><b>Suggest improvements</b> in the escape plan: design changes for rooms with a single route. Complee recomputes each proposal before it is shown.</li>
          <li><b>Document extraction</b> in the evidence intake (backend): values with their source passage, reviewed by an engineer before use.</li></ul></div>
        <div class="ai-map-col det"><b>Deterministic, no AI</b><ul>
          <li>Every compliant / non-compliant result (rule checker)</li>
          <li>Escape routes, measurements, data-consistency checks</li>
          <li>Findings register, revision comparison, report</li></ul></div>
      </div>
      ${st?.available ? `<p class="muted">Models in order (the next one answers when one fails, is too slow or answers badly): ${st.chain.map((m, i) => `<b>${esc(modelLabel(m))}</b>${st.prices_usd_per_million?.[i] ? ` <span class="muted">($${st.prices_usd_per_million[i][0]} / $${st.prices_usd_per_million[i][1]} per 1M tokens)</span>` : ''}`).join(' → ')}</p>`
        : `<div class="note">AI is offline: start the backend (<code>cd backend; .venv\\Scripts\\python -m uvicorn app.main:app --port 8000</code>) and reload. ${esc(st?.error || '')}</div>`}
      <h2>Calls this session</h2>
      ${aiState.log.length ? `<table class="register"><thead><tr><th>Time</th><th>Task</th><th>Subject</th><th>Model</th><th>Duration</th><th>Cost</th></tr></thead><tbody>${aiState.log.map((e) => `<tr>
        <td>${esc(e.at.toLocaleTimeString('en-GB'))}</td><td>${esc(e.task)}</td><td>${esc(e.subject)}</td>
        <td>${e.busy ? '<span class="spin"></span> running' : e.error ? `<span class="check-bad">failed: ${esc(e.error)}</span>` : `${esc(modelLabel(e.model))}${e.attempts?.length > 1 ? ` <span class="muted">(after ${e.attempts.length - 1} fallback${e.attempts.length > 2 ? 's' : ''})</span>` : ''}`}</td>
        <td>${e.seconds != null ? `${e.seconds.toFixed(1)} s` : ''}</td><td>${e.busy || e.error ? '' : cents(e.cost)}</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">No AI call yet. Try ✦ Explain on a finding or ✦ Suggest improvements in the escape plan.</p>'}
    </div>`;
  panel.hidden = false;
  $('#aiPill').classList.add('on');
  $('#aiClose').onclick = closeAiPanel;
}
function closeAiPanel() { $('#aiPanel').hidden = true; $('#aiPill')?.classList.remove('on'); }

const aiFooter = (r) => `<div class="ai-foot">✦ AI-generated by ${esc(modelLabel(r.model))} in ${(r.duration_ms / 1000).toFixed(1)} s · ${cents(r.cost_usd)}${r.attempts?.length > 1 ? ` (after ${r.attempts.length - 1} fallback${r.attempts.length > 2 ? 's' : ''})` : ''}. Check against the official rule text before relying on it.</div>`;

function explainKey(id, r) { return `${id}|${r.rule_id}|${r.measured ?? ''}|${r.status}`; }

function explainHTML(id, r) {
  const st = S.explain?.get(explainKey(id, r));
  if (!st) return '';
  if (st.loading && !st.partial) return `<div class="ai-wait"><span class="spin"></span>${st.model ? `${esc(modelLabel(st.model))} is thinking…` : 'Asking the AI…'}${st.switched ? ` <span class="muted">(${esc(st.switched)})</span>` : ''}</div>`;
  if (st.error) return `<div class="check-bad">${esc(st.error)}</div>`;
  const x = (st.loading ? st.partial : st.data.result) || {};
  // Short and scannable: summary and fixes always visible, background folded away; lists capped even if the model writes more.
  const cap = (items, n) => (Array.isArray(items) ? items.filter(Boolean).slice(0, n) : []);
  const list = (title, items) => (items.length ? `<div class="ai-h">${title}</div><ul>${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '');
  const options = cap(x.options, 3).filter((o) => o?.change);
  const details = list('Why', cap(x.reasons, 2)) + list('Exceptions to check', cap(x.exceptions_to_check, 2)) + list('Open questions', cap(x.questions, 2));
  return `<div class="ai-box"><div class="ai-tag">✦ AI explanation</div>
    <p>${esc(x.summary || '')}</p>
    ${options.length ? `<div class="ai-h">How to fix it</div><ol>${options.map((o) => `<li><b>${esc(o.change)}</b>${o.effect ? ` <span class="muted">→ ${esc(o.effect)}</span>` : ''}</li>`).join('')}</ol>` : ''}
    ${details ? `<details class="ai-more"><summary>Why, exceptions, open questions</summary>${details}</details>` : ''}
    ${st.loading ? `<div class="ai-foot writing"><span class="caret"></span> ${esc(modelLabel(st.model))} is writing…</div>` : aiFooter(st.data)}
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
    const state = S.explain.get(key);
    const data = await assistStream('explain-finding', {
      rule: { id: rule.id, source: rule.source, clause: rule.clause, text: rule.text, text_status: rule.text_status, verified: rule.verified, check: rule.check, parameter: rule.parameter, value: rule.value, unit: rule.unit, applies_to: rule.applies_to },
      finding: { element: id, name: el.name, type: el.type, deck: deckName(el.deck), status: r.status, measured: r.measured, required: r.required, explanation: r.explanation, inputs: r.inputs },
      ship,
    }, `${id} · ${ruleId}`, {
      onPartial: (value, _text, model) => { Object.assign(state, { partial: value, model }); paintExplain(id, r); },
      onSwitch: (from, reason) => { Object.assign(state, { partial: null, switched: `${modelLabel(from)} failed, next model` }); paintExplain(id, r); },
    });
    S.explain.set(key, { data });
  } catch (err) {
    S.explain.set(key, { error: err.message });
  }
  if (S.selected === id) renderResults(id);
}

// Repaint only the explanation box of one card while the answer streams in (the rest of the panel stays still).
function paintExplain(id, r) {
  if (S.selected !== id) return;
  const slot = document.querySelector(`#dResults .ai-out[data-explain="${CSS.escape(r.rule_id)}"]`);
  if (slot) slot.innerHTML = explainHTML(id, r);
}

// Escape-route suggestions: the AI proposes actions; every proposal is applied to a copy of the model and the routes
// are recomputed. Only proposals that give rooms a second independent route (and make none worse) are offered.
function escAiHTML(room = null) {
  const st = S.escAi;
  if (!st) return '';
  // In a room's panel: only the proposals that give this room a second route (the full list is in the escape plan).
  if (room && st.room && st.room !== room && !st.loading && !st.items?.some((i) => i.check.ok && i.check.improved.includes(room))) return '';
  if (st.loading) {
    const done = st.items ?? [], writing = st.writing;
    return `<div class="ai-box"><div class="ai-tag">✦ AI proposals · checked by Complee</div>
      ${done.map((i) => `<div class="esc-sug"><b>${esc(i.s.title)}</b><div class="${i.check.ok ? 'ok-line' : 'muted'}">${i.check.ok ? `✓ Recomputed: ${i.check.improved.length === 1 ? '1 room gets' : `${i.check.improved.length} rooms get`} a better route` : i.check.conflicts?.length ? `✗ ${esc(i.check.conflicts[0])}: will be dropped` : '✗ Recomputed: no improvement, will be dropped'}</div></div>`).join('')}
      ${writing ? `<div class="esc-sug writing"><b>${esc(writing.title || '…')}</b><div class="muted">${esc(writing.rationale || '')}<span class="caret"></span></div></div>` : ''}
      <div class="ai-wait"><span class="spin"></span>${st.model ? `${esc(modelLabel(st.model))} ${writing || done.length ? 'is writing' : 'is thinking'}…` : 'Asking the AI…'} Complee recomputes each proposal as soon as it is complete.${st.switched ? ` <span class="muted">(${esc(st.switched)})</span>` : ''}</div>
    </div>`;
  }
  if (st.error) return `<div class="check-bad">${esc(st.error)}</div>`;
  const allGood = st.items.filter((i) => i.check.ok);
  const good = room ? allGood.filter((i) => i.check.improved.includes(room)) : allGood;
  const dropped = room ? [] : st.items.filter((i) => !i.check.ok);
  const others = allGood.length - good.length;
  return `<div class="ai-box"><div class="ai-tag">✦ AI proposals · checked by Complee</div>
    ${good.length ? good.map((i, n) => `<div class="esc-sug ${st.shown === i ? 'on' : ''}">
      <b>${esc(i.s.title)}</b>
      <div class="muted">${esc(i.s.rationale || '')}</div>
      <div class="ok-line">✓ Recomputed: ${i.check.improved.length === 1 ? '1 room gets' : `${i.check.improved.length} rooms get`} a better route, nothing cut through (${i.check.improved.map((r) => `<a href="#" class="via" data-id="${esc(r)}">${esc(r)}</a>`).join(', ')})</div>
      ${i.check.notes?.length ? `<div class="disp-warn">⚠ ${i.check.notes.map(esc).join('; ')}.</div>` : ''}
      ${i.ruleIssues.length ? `<div class="disp-warn">⚠ The rule check finds ${i.ruleIssues.length} issue${i.ruleIssues.length === 1 ? '' : 's'} in the proposed elements: ${i.ruleIssues.map((f) => `${esc(f.rule_id)} ${esc(f.measured ?? 'missing')} (required ${esc(f.required)})`).join('; ')}. Adjust before adopting it.</div>` : '<div class="ok-line">✓ The proposed elements pass the rule check.</div>'}
      <div class="esc-sug-actions"><button class="tiny escShow" data-n="${st.items.indexOf(i)}">${st.shown === i ? 'Hide' : 'Show in 3D'}</button><button class="tiny escOpen" data-n="${st.items.indexOf(i)}" title="Open the model with this change as a new revision (compare and register carry over)">Open as revision</button></div>
    </div>`).join('') : `<p class="muted">${room ? `None of the proposals gives ${esc(room)} a second independent route.` : 'None of the proposals gave a room a second independent route.'}</p>`}
    ${room && others ? `<p class="muted">${others} more proposal${others === 1 ? '' : 's'} for other rooms in the escape plan list.</p>` : ''}
    ${dropped.length ? `<details class="assume"><summary>${dropped.length} proposal${dropped.length === 1 ? '' : 's'} dropped after recomputing</summary><ul>${dropped.map((i) => `<li><b>${esc(i.s.title)}</b>: ${esc([...(i.check.conflicts ?? []), ...i.check.problems].join('; ') || (i.check.worse.length ? `makes ${i.check.worse.join(', ')} worse` : 'no room gains a second route'))}</li>`).join('')}</ul></details>` : ''}
    ${aiFooter(st.data)}
  </div>`;
}

function paintEscAi() {
  document.querySelectorAll('.escAiSlot').forEach((slot) => (slot.innerHTML = escAiHTML(slot.dataset.room || null)));
  wireEscAi();
}

function wireEscAi() {
  document.querySelectorAll('.escAiSlot').forEach(wireEscAiSlot);
}

function wireEscAiSlot(box) {
  box.querySelectorAll('a.via').forEach((n) => (n.onclick = (e) => { e.preventDefault(); select(n.dataset.id); }));
  box.querySelectorAll('.escShow').forEach((b) => (b.onclick = () => {
    const item = S.escAi.items[Number(b.dataset.n)];
    S.escAi.shown = S.escAi.shown === item ? null : item;
    const ghosts = S.escAi.shown ? normalizeModel(structuredClone({ ...S.model, elements: item.check.added })).elements : [];
    views.three.setGhosts(ghosts);
    paintEscAi();
  }));
  box.querySelectorAll('.escOpen').forEach((b) => (b.onclick = () => {
    const item = S.escAi.items[Number(b.dataset.n)];
    const name = `${(S.sc.modelData ? S.sc.name.replace(/^File: /, '').replace(/\.json$/i, '') : S.model.name)} - ${item.s.title}`.slice(0, 80);
    openModelFile(new File([JSON.stringify(item.check.model)], `${name.replace(/[^\w .()-]+/g, '_')}.json`));
  }));
}

async function suggestEscapeImprovements(focusRoom = null) {
  const a = S.escape;
  if (!a || S.escAi?.loading) return;
  const rooms = Object.values(a.origins).filter((o) => o.room && o.status !== 'two_routes' && o.status !== 'direct');
  const analysis = {
    // First: the prompt shortens long input from the end.
    ...(focusRoom ? { focus_room: focusRoom, focus_note: `The engineer asked about ${focusRoom}: at least one proposal must give this room a second independent route.` } : {}),
    muster_stations: a.musters,
    rooms_needing_a_second_route: rooms.map((o) => ({ room: o.id, status: o.status, every_route_passes: (o.status === 'shared_route' ? o.shared : o.shared_gates) ?? [], shortest_route: o.primary?.via ?? [] })),
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
  S.escAi = { loading: true, items: [], room: focusRoom };
  const state = S.escAi;
  views.three.setGhosts([]);
  renderEscape();
  if (S.selected) renderEscapeDetail(S.selected);
  // Bring the answer into view where it was asked for.
  (focusRoom ? document.querySelector('#dEscape .escAiSlot') : $('#escAi'))?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  const current = S.escape;
  const verify = (s) => {
    const check = verifySuggestion(S.model, s, current);
    // The rule check of the proposal itself: a new passage or door has to meet the same rules as the rest.
    const added = new Set(check.added.map((e) => e.id));
    const ruleIssues = check.added.length ? findingsOf(checkModel(structuredClone(check.model), allRules())).filter((f) => added.has(f.element)) : [];
    return { s, check, ruleIssues };
  };
  const paint = () => { if (S.escAi === state) paintEscAi(); };
  try {
    const data = await assistStream('escape-suggestions', { analysis, elements, decks }, `${rooms.length} room${rooms.length === 1 ? '' : 's'} with a single route`, {
      onPartial: (value, _text, model) => {
        state.model = model;
        const list = Array.isArray(value?.suggestions) ? value.suggestions : [];
        // Every proposal before the last one is complete: recompute it now, while the AI still writes the next.
        while (state.items.length < list.length - 1) state.items.push(verify(list[state.items.length]));
        state.writing = list[list.length - 1] ?? null;
        paint();
      },
      onSwitch: (from) => { Object.assign(state, { items: [], writing: null, switched: `${modelLabel(from)} failed, next model` }); paint(); },
    });
    const items = (data.result?.suggestions ?? []).map(verify)
      .sort((a, b) => (b.check.ok - a.check.ok) || (a.ruleIssues.length - b.ruleIssues.length) || (b.check.improved.length - a.check.improved.length));
    S.escAi = { data, items, shown: null, room: focusRoom };
  } catch (err) {
    S.escAi = { error: err.message, room: focusRoom };
  }
  renderEscape();
  if (S.selected) renderEscapeDetail(S.selected);
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
  S.comments = readJSON(commentsKey(S.registerProject), { comments: [] });
  if (!Array.isArray(S.comments.comments)) S.comments = { comments: [] };
  try { localStorage.setItem(registerKey(`${S.registerProject}.meta`), JSON.stringify(meta)); } catch { /* storage full or blocked */ }
  return store;
}
const commentsKey = (project) => `complee.comments.${project}`;
// A save that fails (storage full, blocked, private window) is said once per session: the work is then only on screen.
let storageWarned = false;
function storageFailed(what, e) {
  console.warn(`The ${what} could not be saved in this browser:`, e.message);
  if (storageWarned) return;
  storageWarned = true;
  alert(`The ${what} could not be saved in this browser (${e.name === 'QuotaExceededError' ? 'storage full' : 'storage blocked'}). It stays on screen until you close the page: use "Save project file" to keep it.`);
}
function saveComments() {
  try { localStorage.setItem(commentsKey(S.registerProject), JSON.stringify(S.comments)); } catch (e) { storageFailed('class comments', e); }
}
function saveRegister() {
  try { localStorage.setItem(registerKey(S.registerProject), JSON.stringify(S.register)); } catch (e) { storageFailed('findings register', e); }
}
// The same project open in another tab: take over what that tab saved, instead of overwriting it with the next change.
window.addEventListener('storage', (e) => {
  if (!S.registerProject || !e.key) return;
  if (e.key === registerKey(S.registerProject)) S.register = readJSON(e.key, {});
  else if (e.key === commentsKey(S.registerProject)) { S.comments = readJSON(e.key, { comments: [] }); if (!Array.isArray(S.comments.comments)) S.comments = { comments: [] }; }
  else return;
  renderSummary();
  renderRegisterButton();
  if (!$('#registerPanel').hidden) openRegister();
});
// What-if values and a model opened from a file are not saved anywhere: ask before the page is left.
window.addEventListener('beforeunload', (e) => {
  if (S.edits?.size || S.sc?.modelData) { e.preventDefault(); e.returnValue = ''; }
});
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

function manualHTML(m) {
  return `<div class="manual-item${m.done ? ' done' : ''}">
    <div class="head"><b>${esc(m.rule_id)}</b><span class="muted">${esc(m.source)} - ${esc(m.clause)}</span></div>
    <blockquote>“${esc(m.rule_text)}”</blockquote>
    ${m.evidence ? `<div class="na">Evidence: ${esc(m.evidence)}</div>` : ''}
    ${m.applicability === 'unknown' ? `<div class="na">${esc(m.reason)}</div>` : ''}
    <div class="manual-ctl">
      <label><input type="checkbox" class="manDone" data-key="${esc(m.key)}" ${m.done ? 'checked' : ''}> Checked</label>
      <input class="manWho" data-key="${esc(m.key)}" value="${esc(m.responsible)}" placeholder="Checked by (required)" maxlength="80">
      <input class="manNote" data-key="${esc(m.key)}" value="${esc(m.note)}" placeholder="Evidence reference, e.g. drawing no." maxlength="600">
    </div>
    ${m.done && m.updated ? `<div class="na">Confirmed by ${esc(m.responsible)}, ${esc(new Date(m.updated).toLocaleDateString('en-GB'))}${m.revision ? ` (revision ${esc(m.revision)})` : ''}.</div>` : ''}
    ${m.stale ? `<div class="disp-warn">Confirmed by ${esc(m.responsible)}${m.revision ? ` for revision ${esc(m.revision)}` : ''}, but the element has changed since (or the confirmation does not record what it was): check it again.</div>` : ''}
    <div class="manual-err check-bad" hidden></div>
  </div>`;
}

function wireManualChecks(root) {
  const commit = (n, patch) => {
    const item = manualRows(S.results, S.register).find((m) => m.key === n.dataset.key);
    if (!item) return;
    const box = n.closest('.manual-item');
    // Take the name typed in the same row along, so "type name, tick box" works in one go.
    const who = box.querySelector('.manWho').value.trim();
    try {
      S.register = withManualCheck(S.register, item, { responsible: who, ...patch, revision: revisionLabel(S.sc) });
    } catch (err) {
      if (n.classList.contains('manDone')) n.checked = false;
      const msg = box.querySelector('.manual-err');
      msg.textContent = err.message; msg.hidden = false;
      return;
    }
    saveRegister();
    renderSummary();
    if (S.selected) renderResults(S.selected);
  };
  root.querySelectorAll('.manDone').forEach((n) => (n.onchange = () => commit(n, { done: n.checked })));
  root.querySelectorAll('.manWho').forEach((n) => (n.onchange = () => commit(n, { responsible: n.value.trim() })));
  root.querySelectorAll('.manNote').forEach((n) => (n.onchange = () => commit(n, { note: n.value.trim() })));
}

function renderRegisterButton() {
  if ($('#readyBox')) { $('#readyBox').outerHTML = readinessHTML(); wireReadiness(); }
  const s = registerSummary(registerRows(S.results, S.register));
  const attention = s.open + s.stale + s.missing_note;
  const c = commentSummary(S.comments?.comments, null);
  const parts = [s.total ? `${s.open} open` : '', c.open ? `${c.open} comment${c.open === 1 ? '' : 's'} open` : ''].filter(Boolean);
  $('#registerBtn').textContent = `Findings register${parts.length ? ` (${parts.join(' · ')})` : ''}`;
  $('#registerBtn').classList.toggle('attention', attention > 0 && s.total > 0);
}

let registerOpenOnly = false;
let registerTab = 'findings';
function registerTabs() {
  const c = commentSummary(S.comments?.comments, S.results, S.register);
  return `<span class="tabs"><button class="tab ${registerTab === 'findings' ? 'on' : ''}" data-tab="findings">Findings</button><button class="tab ${registerTab === 'comments' ? 'on' : ''}" data-tab="comments" title="Comments from class or flag on a submission, tracked to closure">Class comments${c.total ? ` (${c.open} open)` : ''}</button></span>`;
}
function wireRegisterTabs(panel) {
  panel.querySelectorAll('.tabs .tab').forEach((b) => (b.onclick = () => { registerTab = b.dataset.tab; openRegister(); }));
}

function openRegister() {
  closeTrace();
  closeAiPanel();
  closeDrawingPanel();
  if (registerTab === 'comments') return openComments();
  const panel = $('#registerPanel');
  const all = registerRows(S.results, S.register), s = registerSummary(all);
  const current = all.filter((r) => !r.resolved && !r.orphan && (!registerOpenOnly || r.disposition === 'open' || r.stale || r.missing_note));
  const resolved = all.filter((r) => r.resolved);
  const orphans = all.filter((r) => r.orphan);
  const row = (r) => `<tr class="${r.stale || r.missing_note ? 'warn' : ''}">
      <td><span class="badge st-${r.status}">${LABEL[r.status]}</span></td>
      <td class="part" data-id="${esc(r.element)}" data-rule="${esc(r.rule_id)}"><b>${esc(r.element)}</b> ${esc(r.name)}</td>
      <td>${esc(r.rule_id)}</td><td>${esc(r.measured)}</td><td>${esc(r.required)}</td>
      <td class="dispCell">${dispositionControls(r)}${r.stale ? '<div class="disp-warn">Value changed since the disposition: review again.</div>' : ''}${r.missing_note ? '<div class="disp-warn">Justification required.</div>' : ''}</td>
      <td class="muted">${r.updated ? esc(new Date(r.updated).toLocaleDateString('en-GB')) : ''}${r.revision ? `<br>${esc(r.revision)}` : ''}</td></tr>`;
  panel.innerHTML = `<div class="trace-head">
      ${registerTabs()}
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
    ${orphans.length ? `<h2>Not in this model (${orphans.length})</h2>
      <p class="muted">The element or the rule of these dispositions is not in this revision. That does not mean the deviation is resolved: if the element was renamed, move the disposition to its new id (it is then compared with the current value); otherwise remove it.</p>
      <table class="register"><tbody>${orphans.map((r) => `<tr class="warn"><td><b>${esc(r.element)}</b> ${esc(r.name)}</td><td>${esc(r.rule_id)}</td><td>${r.orphan === 'element' ? 'element not in this model' : 'rule no longer runs on it'}</td><td>was: ${esc(r.measured)}</td><td>${esc(DISPOSITION_LABEL[r.disposition])}</td><td>${esc(r.note)}</td>
        <td><input class="regMoveTo" data-key="${esc(r.key)}" placeholder="new element id" size="12"> <button class="tiny regMove" data-key="${esc(r.key)}">move</button> <button class="tiny regDrop" data-key="${esc(r.key)}">remove</button></td></tr>`).join('')}</tbody></table>` : ''}
    ${resolved.length ? `<h2>No longer reported by the check (${resolved.length})</h2>
      <table class="register"><tbody>${resolved.map((r) => `<tr><td><b>${esc(r.element)}</b> ${esc(r.name)}</td><td>${esc(r.rule_id)}</td><td>was: ${esc(r.measured)}</td><td>${esc(DISPOSITION_LABEL[r.disposition])}</td><td>${esc(r.responsible)}</td><td>${esc(r.note)}</td><td><button class="tiny regDrop" data-key="${esc(r.key)}">remove</button></td></tr>`).join('')}</tbody></table>` : ''}
    </div>`;
  panel.hidden = false;
  $('#registerBtn').classList.add('on');
  $('#regClose').onclick = closeRegister;
  wireRegisterTabs(panel);
  $('#regOpen').onchange = (e) => { registerOpenOnly = e.target.checked; openRegister(); };
  $('#regCsv').onclick = () => download(`findings-register-${S.sc.id}.csv`, registerCSV(registerRows(S.results, S.register)), 'text/csv');
  $('#cmpBtn').onclick = () => $('#cmpFile').click();
  $('#cmpFile').onchange = (e) => { const f = e.target.files[0]; if (f) compareWithFile(f); };
  if ($('#cmpClear')) $('#cmpClear').onclick = () => { S.compare = null; openRegister(); };
  panel.querySelectorAll('.item.cmp[data-id]').forEach((n) => (n.onclick = () => { closeRegister(); select(n.dataset.id); }));
  panel.querySelectorAll('.regDrop').forEach((b) => (b.onclick = () => { const next = { ...S.register }; delete next[b.dataset.key]; S.register = next; saveRegister(); openRegister(); }));
  // A renamed element: the disposition moves to the new id and is compared with that element's current result.
  panel.querySelectorAll('.regMove').forEach((b) => (b.onclick = () => {
    const input = panel.querySelector(`.regMoveTo[data-key="${CSS.escape(b.dataset.key)}"]`);
    const to = input?.value.trim();
    const rule = b.dataset.key.slice(b.dataset.key.lastIndexOf('|') + 1);
    if (!to || !elById(to)) { input?.classList.add('missing'); return; }
    const next = { ...S.register };
    if (next[`${to}|${rule}`] && !confirm(`${to} already has a disposition for ${rule}. Replace it?`)) return;
    next[`${to}|${rule}`] = { ...next[b.dataset.key], moved_from: b.dataset.key.slice(0, b.dataset.key.lastIndexOf('|')) };
    delete next[b.dataset.key];
    S.register = next; saveRegister(); renderRegisterButton(); openRegister();
  }));
  panel.querySelectorAll('td.part').forEach((n) => (n.onclick = () => {
    closeRegister();
    select(n.dataset.id);
    const card = document.querySelector(`#dResults .res[data-rule="${CSS.escape(n.dataset.rule)}"]`);
    if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); pulse(card); }
  }));
  wireDispositions(panel);
}
// ---------- class comments: what class asked, what the design does now, what was answered ----------

let commentsOpenOnly = false, commentImportOpen = false, commentImportMsg = '';
S.commentAi = new Map();

function evidenceHTML(ev) {
  const cls = `st-${EVIDENCE_CLASS[ev.state] ?? 'none'}`;
  // Deviations first, so the six shown include the ones that matter; manual checks say whether someone confirmed them.
  const rank = (i) => (i.status === 'non_compliant' ? 0 : i.missing_element || i.status === 'not_enough_info' || i.status === 'manual_open' ? 1 : 2);
  const items = [...ev.items].sort((a, b) => rank(a) - rank(b)).slice(0, 6).map((i) => i.missing_element ? `${esc(i.element)}: not in this model`
    : i.manual ? `${esc(i.element)} ${esc(i.rule_id)}: manual check ${i.status === 'compliant' ? 'confirmed' : 'open'}`
      : i.status ? `${esc(i.element)} ${esc(i.rule_id)}: ${esc(i.measured ?? 'missing')}, required ${esc(i.required)}` : `${esc(i.element)}: no rule applies`).join(' · ');
  return `<div class="cmt-ev"><span class="badge ${cls}">${esc(EVIDENCE_LABEL[ev.state])}</span> <span class="muted">${items}${ev.items.length > 6 ? ' …' : ''}</span></div>`;
}

function commentAiHTML(c) {
  const st = S.commentAi.get(c.id);
  if (!st) return '';
  if (st.loading && !st.partial) return `<div class="ai-wait"><span class="spin"></span>${st.model ? `${esc(modelLabel(st.model))} is writing…` : 'Asking the AI…'}</div>`;
  if (st.error) return `<div class="check-bad">${esc(st.error)}</div>`;
  const x = (st.loading ? st.partial : st.data.result) || {};
  const list = (t, a) => (Array.isArray(a) && a.length ? `<div class="ai-h">${t}</div><ul>${a.slice(0, 3).map((v) => `<li>${esc(v)}</li>`).join('')}</ul>` : '');
  return `<div class="ai-box"><div class="ai-tag">✦ AI draft reply · edit before sending</div>
    <p class="cmt-draft">${esc(x.reply || '')}${st.loading ? '<span class="caret"></span>' : ''}</p>
    ${list('Based on', x.based_on)}${list('Confirm before sending', x.to_confirm)}
    ${st.loading ? '' : `<button class="tiny cmtUse" data-id="${esc(c.id)}">Use as response</button>${aiFooter(st.data)}`}
  </div>`;
}

function commentCard(c) {
  const ev = commentEvidence(c, S.results, S.register);
  const warn = isContradicted(c, S.results, S.register);
  return `<div class="cmt ${warn ? 'warn' : ''}" data-id="${esc(c.id)}">
    <div class="cmt-head"><b>${esc(c.ref)}</b>${c.document ? ` <span class="muted">· ${esc(c.document)}</span>` : ''}${c.received ? ` <span class="muted">· received ${esc(c.received)}</span>` : ''}${c.revision ? ` <span class="muted">· on ${esc(c.revision)}</span>` : ''}
      <span class="grow"></span>
      <select class="cmtStatus" data-id="${esc(c.id)}">${COMMENT_STATUSES.map((x) => `<option value="${x.id}" ${c.status === x.id ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
      <button class="tiny cmtDel" data-id="${esc(c.id)}" title="Remove this comment from the list">remove</button></div>
    <div class="cmt-text">${esc(c.text)}</div>
    <div class="cmt-links">Linked: ${[...(c.links?.elements ?? []).map((id) => `<a href="#" class="via" data-id="${esc(id)}">${esc(id)}</a>`), ...(c.links?.rules ?? []).map((id) => `<code>${esc(id)}</code>`)].join(' ') || '<span class="muted">nothing yet</span>'}
      <input class="cmtLinks" data-id="${esc(c.id)}" value="${esc([...(c.links?.elements ?? []), ...(c.links?.rules ?? [])].join(', '))}" placeholder="Element or rule ids, comma separated" title="Element and rule ids this comment is about"></div>
    ${evidenceHTML(ev)}
    ${warn ? '<div class="disp-warn">Answered or closed, but the rule check still finds the deviation and the register has no justified deviation for it: the reply and the design disagree.</div>' : ''}
    <textarea class="cmtResp" data-id="${esc(c.id)}" rows="2" placeholder="Response to class" maxlength="2000">${esc(c.response)}</textarea>
    <div class="cmt-foot"><input class="cmtWho" data-id="${esc(c.id)}" value="${esc(c.responsible)}" placeholder="Responsible" maxlength="80">
      <button class="tiny ai-btn cmtAi" data-id="${esc(c.id)}" ${S.commentAi.get(c.id)?.loading ? 'disabled' : ''} title="AI drafts a reply from the comment and the current rule check; you edit and send it">✦ Draft reply</button>
      <span class="muted">${c.updated ? `updated ${esc(new Date(c.updated).toLocaleDateString('en-GB'))}` : ''}</span></div>
    <div class="cmt-err check-bad" hidden></div>
    <div class="cmt-ai">${commentAiHTML(c)}</div>
  </div>`;
}

function openComments() {
  const panel = $('#registerPanel');
  const all = S.comments?.comments ?? [];
  const sum = commentSummary(all, S.results, S.register);
  const shown = commentsOpenOnly ? all.filter((c) => c.status !== 'closed' || commentEvidence(c, S.results, S.register).state === 'finding') : all;
  panel.innerHTML = `<div class="trace-head">
      ${registerTabs()}
      <span class="muted">${sum.total} comment${sum.total === 1 ? '' : 's'} · ${sum.open} open · ${sum.answered} answered · ${sum.closed} closed${sum.contradicted ? ` · <b class="check-bad">${sum.contradicted} answered but still a finding</b>` : ''}</span>
      <label><input type="checkbox" id="cmtOpenOnly" ${commentsOpenOnly ? 'checked' : ''}> hide closed</label>
      <span class="grow"></span>
      <button id="cmtImportBtn">${commentImportOpen ? 'Hide import' : 'Import comments…'}</button>
      <button id="cmtCsv" ${all.length ? '' : 'disabled'}>Comment sheet (CSV)</button><button id="regClose">Close</button>
    </div>
    <div class="trace-wrap">
      ${commentImportOpen || !all.length ? `<div class="cmt-import">
        <p class="muted" style="margin:0 0 6px">Paste the class letter or comment list (numbered comments: "1.", "2)", "Comment 3:"), or a CSV/Excel export with a comment column. Element and rule ids written in a comment are linked automatically.</p>
        <textarea id="cmtPaste" rows="6" placeholder="1. Corridor MD-C1: clear width to be at least 900 mm.&#10;2. Door 01-D2: confirm self-closing device."></textarea>
        <div class="cmt-foot"><input id="cmtDoc" placeholder="Drawing / document no." maxlength="120"><input id="cmtDate" type="date" title="Received">
          <input id="cmtFile" type="file" accept=".csv,.txt,.tsv,text/csv,text/plain" title="Or load a CSV / text file"><button id="cmtAdd" class="primary">Add comments</button></div>
      </div>` : ''}
      ${commentImportMsg ? `<div class="note">${esc(commentImportMsg)}</div>` : ''}
      <p class="muted" style="margin:8px 0">Each comment shows what the current rule check says about the elements it names. Status and response are recorded by the engineer; nothing is sent to class from here. One list per project, saved in this browser; export the comment sheet to share it.</p>
      ${shown.length ? shown.map(commentCard).join('') : (all.length ? '<p class="muted">No open comments.</p>' : '')}
    </div>`;
  panel.hidden = false;
  $('#registerBtn').classList.add('on');
  $('#regClose').onclick = closeRegister;
  wireRegisterTabs(panel);
  $('#cmtOpenOnly').onchange = (e) => { commentsOpenOnly = e.target.checked; openComments(); };
  $('#cmtImportBtn').onclick = () => { commentImportOpen = !commentImportOpen; commentImportMsg = ''; openComments(); };
  $('#cmtCsv').onclick = () => download(`class-comments-${S.sc.id}.csv`, commentsCSV(S.comments.comments, S.results, S.register), 'text/csv');
  if ($('#cmtFile')) $('#cmtFile').onchange = async (e) => { const f = e.target.files[0]; if (f) $('#cmtPaste').value = await f.text(); };
  if ($('#cmtAdd')) $('#cmtAdd').onclick = () => {
    const drafts = parseComments($('#cmtPaste').value);
    if (!drafts.length) { commentImportMsg = 'No comment found in the text.'; openComments(); return; }
    const out = addComments(S.comments, drafts, {
      document: $('#cmtDoc').value.trim(), received: $('#cmtDate').value, revision: revisionLabel(S.sc),
      elementIds: S.norm.elements.map((e) => e.id), ruleIds: allRules().map((r) => r.id),
    });
    S.comments = out.store; saveComments();
    const linked = out.store.comments.slice(-out.added).filter((c) => c.links.elements.length || c.links.rules.length).length;
    commentImportMsg = `Added ${out.added} comment${out.added === 1 ? '' : 's'}, ${linked} linked to the model automatically${out.skipped ? `; ${out.skipped} already in the list (same document, number and text)` : ''}.`
      + (drafts.notes?.length ? ` Check: ${drafts.notes.join(' ')}` : '');
    commentImportOpen = false;
    openComments();
    renderRegisterButton();
  };
  wireComments(panel);
}

function wireComments(panel) {
  const save = (n, patch) => {
    try {
      S.comments = withComment(S.comments, n.dataset.id, patch);
    } catch (err) {
      const box = n.closest('.cmt').querySelector('.cmt-err');
      box.textContent = err.message; box.hidden = false;
      if (n.classList.contains('cmtStatus')) n.value = S.comments.comments.find((c) => c.id === n.dataset.id)?.status ?? 'open';
      return false;
    }
    saveComments();
    renderRegisterButton();
    return true;
  };
  const ids = () => ({ els: new Set(S.norm.elements.map((e) => e.id.toLowerCase())), rules: new Map(allRules().map((r) => [r.id.toLowerCase(), r.id])), byLower: new Map(S.norm.elements.map((e) => [e.id.toLowerCase(), e.id])) });
  panel.querySelectorAll('.cmtStatus').forEach((n) => (n.onchange = () => { if (save(n, { status: n.value })) openComments(); }));
  panel.querySelectorAll('.cmtResp').forEach((n) => (n.onchange = () => save(n, { response: n.value.trim() })));
  panel.querySelectorAll('.cmtWho').forEach((n) => (n.onchange = () => save(n, { responsible: n.value.trim() })));
  panel.querySelectorAll('.cmtLinks').forEach((n) => (n.onchange = () => {
    const { rules, byLower } = ids();
    const elements = [], ruleIds = [], unknown = [];
    for (const raw of n.value.split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean)) {
      const k = raw.toLowerCase();
      if (byLower.has(k)) elements.push(byLower.get(k)); else if (rules.has(k)) ruleIds.push(rules.get(k)); else unknown.push(raw);
    }
    if (save(n, { links: { elements: [...new Set(elements)], rules: [...new Set(ruleIds)] } })) openComments();
    if (unknown.length) {
      const box = panel.querySelector(`.cmt[data-id="${CSS.escape(n.dataset.id)}"] .cmt-err`);
      if (box) { box.textContent = `Not in this model or rule set: ${unknown.join(', ')}`; box.hidden = false; }
    }
  }));
  panel.querySelectorAll('.cmtDel').forEach((b) => (b.onclick = () => {
    if (!confirm('Remove this comment from the list?')) return;
    S.comments = withoutComment(S.comments, b.dataset.id); saveComments(); renderRegisterButton(); openComments();
  }));
  panel.querySelectorAll('.cmt-links a.via').forEach((a) => (a.onclick = (e) => { e.preventDefault(); closeRegister(); select(a.dataset.id); }));
  panel.querySelectorAll('.cmtAi').forEach((b) => (b.onclick = () => draftCommentReply(b.dataset.id)));
  panel.querySelectorAll('.cmtUse').forEach((b) => (b.onclick = () => {
    const reply = S.commentAi.get(b.dataset.id)?.data?.result?.reply;
    if (!reply) return;
    if (save(b, { response: reply })) openComments();
  }));
}

async function draftCommentReply(id) {
  const c = S.comments.comments.find((x) => x.id === id);
  if (!c) return;
  const ev = commentEvidence(c, S.results, S.register);
  const rules = [...new Set([...(c.links?.rules ?? []), ...ev.items.map((i) => i.rule_id).filter(Boolean)])].slice(0, 6)
    .map((rid) => { const r = ruleById(rid); return r ? { id: r.id, source: r.source, clause: r.clause, text: r.text } : null; }).filter(Boolean);
  const notes = Object.fromEntries(ev.items.filter((i) => i.rule_id).map((i) => [`${i.element}|${i.rule_id}`, S.register[`${i.element}|${i.rule_id}`]]).filter(([, d]) => d)
    .map(([k, d]) => [k, { disposition: DISPOSITION_LABEL[d.disposition] ?? d.disposition, note: d.note, responsible: d.responsible }]));
  const payload = {
    comment: { ref: c.ref, document: c.document, received: c.received, text: c.text, revision_commented: c.revision },
    evidence: { state: EVIDENCE_LABEL[ev.state], items: ev.items.slice(0, 20), rules },
    notes: { dispositions: notes, current_response_draft: c.response || null },
    revision: revisionLabel(S.sc),
  };
  const state = { loading: true };
  S.commentAi.set(id, state);
  const paint = () => {
    const box = document.querySelector(`#registerPanel .cmt[data-id="${CSS.escape(id)}"] .cmt-ai`);
    if (box) box.innerHTML = commentAiHTML(c);
    const btn = document.querySelector(`#registerPanel .cmtAi[data-id="${CSS.escape(id)}"]`);
    if (btn) btn.disabled = !!S.commentAi.get(id)?.loading;
  };
  paint();
  try {
    const data = await assistStream('comment-reply', payload, `class comment ${c.ref}`, {
      onPartial: (value, _text, model) => { state.partial = value; state.model = model; paint(); },
      onSwitch: () => { state.partial = null; paint(); },
    });
    S.commentAi.set(id, { data });
  } catch (err) {
    S.commentAi.set(id, { error: err.message });
  }
  if (!$('#registerPanel').hidden && registerTab === 'comments') { paint(); wireComments($('#registerPanel')); }
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
    let json, geometry = null, cad = null;
    if (!file.size) throw new Error('The file is empty.');
    if (!/\.(rvt|ifc|dxf|dwg|json|rfa|rte|nwd|nwc|step|stp|iges|igs|3dm|skp|obj|stl|fbx)$/i.test(file.name)) {
      throw new Error('Unsupported file type. Open a Revit model (.rvt), an IFC file (.ifc), an AutoCAD drawing (.dxf) or a ship/1 JSON model (.json).');
    }
    if (/\.rvt$/i.test(file.name)) file = await convertRevit(file);
    else if (/\.dwg$/i.test(file.name)) {
      throw new Error('DWG is AutoCAD\'s binary format and cannot be read here. In AutoCAD use SAVEAS and choose "AutoCAD DXF", then open that file.');
    } else if (/\.(rfa|rte|nwd|nwc|step|stp|iges|igs|3dm|skp|obj|stl|fbx)$/i.test(file.name)) {
      throw new Error('This format cannot be read directly. Export the model as IFC (.ifc) from the program it was made in, upload the Revit file (.rvt), or save an AutoCAD drawing as DXF.');
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
      const text = await file.text();
      if (/\.dxf$/i.test(file.name) || /^\s*0\s*\r?\n\s*SECTION\b/.test(text)) {
        ({ model: json, report: cad } = dxfToModel(text, { filename: file.name })); // AutoCAD: throws with a message for the engineer
      } else {
        try { json = JSON.parse(text); } catch { throw new Error('The file is not valid JSON (expected a ship/1 JSON model, an AutoCAD .dxf or an .ifc file).'); }
      }
    }
    // addScenario checks the model (checkModelJson) before it is listed.
    if (geometry && typeof json?.provenance_note === 'string') json.provenance_note =json.provenance_note.replace(/^Imported from /, `Imported from ${original.name !== file.name ? `${original.name} (converted to IFC by Autodesk) → ` : ''}`);
    if (await addScenario({ name: `File: ${file.name}`, idHint: file.name, json, geometry })) {
      if (cad) $('#detail').innerHTML = cadReportHTML(cad);
      else if (geometry) $('#detail').innerHTML = ifcReportHTML(original.name, file.name);
    }
  } catch (e) {
    $('#detail').innerHTML = `<p class="check-bad"><b>Could not open ${esc(file.name)}.</b> ${esc(e.message)}</p>` + (!/\.(dxf|dwg)$/i.test(original.name) ? '' : `
      <p class="muted">AutoCAD drawings are read as DXF with the layer convention &lt;DECK&gt;-&lt;TYPE&gt;:
      <a href="autocad.html" target="_blank" rel="noopener">AutoCAD guide</a> · <a href="demo/autocad-sample.dxf" download>sample drawing</a>.</p>`);
  }
}

// A model from outside (a file, a converted drawing) must be a ship/1 model the checker can use: throws with a message
// for the engineer otherwise.
function checkModelJson(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.elements)) throw new Error('A ship model needs an "elements" list (ship/1 format; "Download model (JSON)" in the left panel gives an example).');
  if (!Array.isArray(json.decks) && !json.deck) throw new Error('A ship model needs "decks" (or a single "deck").');
  const norm = normalizeModel(structuredClone(json)); // throws on an unsupported unit
  const ids = new Set();
  for (const e of norm.elements) {
    if (!e.id || !e.type) throw new Error('Every element needs an "id" and a "type".');
    if (ids.has(e.id)) throw new Error(`Element id "${e.id}" is used twice.`);
    ids.add(e.id);
  }
  if (!norm.elements.length) throw new Error('The model contains no elements, so there is nothing to check.');
}

// Adds a checked model to the model list and loads it: shared by "Open…" and "Drawing → 3D". `replace` names a
// scenario to update in place (a drawing converted again after a correction keeps its one entry in the list).
// geometry: { elements: Map(id -> mesh) } for the 3D viewer, or null for boxes. Returns the scenario id, or null when
// another model was chosen while this one loaded.
async function addScenario({ name, idHint = name, json, geometry = null, replace = null }) {
  checkModelJson(json);
  const existing = replace ? S.scenarios.find((s) => s.id === replace) : null;
  const id = existing?.id ?? `file-${++fileCounter}-${idHint.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40)}`;
  const sc = { id, name, viewer: 'three', modelData: json, geometry };
  if (existing) {
    S.scenarios[S.scenarios.indexOf(existing)] = sc;
    const option = [...$('#scenario').options].find((o) => o.value === id);
    if (option) option.textContent = name;
  } else {
    S.scenarios.push(sc);
    $('#scenario').insertAdjacentHTML('beforeend', `<option value="${esc(id)}">${esc(name)}</option>`);
  }
  return (await loadScenario(id)) ? id : null;
}

// What an IFC import gave: elements by type, which of them the rules cover, and what data the checks still need.
function ifcReportHTML(originalName, ifcName) {
  const els = S.norm.elements;
  const byType = Object.entries(els.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const ruleTypes = new Set(allRules().filter((r) => !r.draft).flatMap((r) => r.applies_to?.types ?? []));
  const covered = byType.filter(([t]) => ruleTypes.has(t));
  const f = S.results.element_summary;
  const missing = Object.entries(findingsOf(S.results).filter((x) => x.status === 'not_enough_info')
    .reduce((m, x) => ((m[x.parameter || x.rule_id] = (m[x.parameter || x.rule_id] || 0) + 1), m), {})).sort((a, b) => b[1] - a[1]);
  const fire = els.filter((e) => e.props?.fire_rating).length;
  return `<h1>IFC model imported</h1>
    <div class="muted">${esc(originalName)}${originalName !== ifcName ? ' (converted to IFC by Autodesk)' : ''} · ${els.length.toLocaleString('en')} elements on ${S.norm.decks.length} storey${S.norm.decks.length === 1 ? '' : 's'}</div>
    <p><span class="badge st-non_compliant">${f.non_compliant} non-compliant</span> <span class="badge st-not_enough_info">${f.not_enough_info} not enough info</span> <span class="badge st-compliant">${f.compliant} no deviation</span> <span class="muted">${f.no_rule.toLocaleString('en')} elements without a rule</span></p>
    ${covered.length ? `<p>The rules cover ${covered.map(([t, n]) => `${n} ${esc(t.replace(/_/g, ' '))}`).join(', ')} in this model.</p>`
      : `<div class="note">No rule in the catalog applies to the element types in this model (${byType.slice(0, 5).map(([t]) => esc(t.replace(/_/g, ' '))).join(', ')}…). The rules cover: ${[...ruleTypes].sort().map((t) => esc(t.replace(/_/g, ' '))).join(', ')}.</div>`}
    ${missing.length ? `<h2>Data the checks still need</h2><div class="na">A plain IFC export has geometry and names, not the values the rules read. Missing: ${missing.slice(0, 6).map(([p, n]) => `<code>${esc(p)}</code> (${n})`).join(', ')}. Add them in the authoring tool's properties or as what-if values here.</div>` : ''}
    ${fire ? `<div class="na">Fire ratings read from the IFC property sets: ${fire} element${fire === 1 ? '' : 's'}.</div>` : ''}
    <h2>Element types</h2>
    <table class="kv">${byType.slice(0, 12).map(([t, n]) => `<tr><td>${esc(t.replace(/_/g, ' '))}</td><td>${n.toLocaleString('en')}${ruleTypes.has(t) ? ' · checked by rules' : ''}</td></tr>`).join('')}</table>
    <p class="muted">Click an element in the model or in the list to see every rule that applies, why it passes or fails, and where each value comes from.</p>`;
}

// What was read from an AutoCAD drawing, and what was not: shown after the import.
function cadReportHTML(r) {
  const f = S.results.element_summary;
  return `<h1>AutoCAD drawing imported</h1>
    <div class="muted">${esc(r.file)}${r.version ? ` · DXF ${esc(r.version)}` : ''} · drawing unit ${esc(r.units)}${r.units_stated ? '' : ' (not stated in the file)'}</div>
    <p><b>${r.elements}</b> elements on <b>${r.decks}</b> deck${r.decks === 1 ? '' : 's'} checked:
      <span class="badge st-non_compliant">${f.non_compliant} non-compliant</span>
      <span class="badge st-not_enough_info">${f.not_enough_info} not enough info</span>
      <span class="badge st-compliant">${f.compliant} no deviation</span></p>
    ${r.warnings.length ? `<h2>To check in the drawing (${r.warnings.length})</h2>${r.warnings.map((w) => `<div class="note">${esc(w)}</div>`).join('')}` : ''}
    <h2>Layers read</h2>
    <table class="kv">${r.layers.map((l) => `<tr><td>${esc(l.layer)}</td><td>${esc(l.type.replace(/_/g, ' '))} · deck ${esc(l.deck)}${l.type === 'outline' ? '' : ` · ${l.elements} element${l.elements === 1 ? '' : 's'}`}</td></tr>`).join('')}</table>
    ${r.skipped_layers.length ? `<h2>Not imported</h2><div class="na">Layers outside the naming convention &lt;DECK&gt;-&lt;TYPE&gt;: ${r.skipped_layers.map((l) => `<code>${esc(l.layer)}</code> (${l.entities})`).join(', ')}.</div>` : ''}
    ${r.ignored_entities.length ? `<div class="na">Entity types not read: ${esc(r.ignored_entities.join(', '))}.</div>` : ''}
    <p class="muted" style="margin-top:8px">Every value shows its layer and entity handle. Widths without a written value are measured from the geometry and labelled so.
      <b>AutoCAD markup</b> (top bar) writes the results back as a DXF in the drawing's coordinates. <a href="autocad.html" target="_blank" rel="noopener">AutoCAD guide</a></p>`;
}

function exportDXF() {
  const { dxf, frames, findings } = resultsToDxf(S.model, S.results);
  if (!frames) { alert('No checked element with geometry to mark up.'); return; }
  download(`${S.sc.id}-complee-markup.dxf`, dxf, 'application/dxf');
  void findings;
}

// ---------- report export (shared with the CLI: src/report.mjs) ----------

function exportCSV() {
  download(`findings-${S.sc.id}.csv`, toCSV(reportRows(S.results, S.model, allRules(), { register: S.register })), 'text/csv');
}

function exportReport() {
  const html = toHTML({ title: S.model.name, scenario: S.sc.id, results: S.results, model: S.model, rules: allRules(), comments: S.comments?.comments, verification: S.verification,
    score: S.baseline, edits: [...S.edits.values()], register: S.register, escape: S.escape, comparison: S.compare?.diff ? S.compare : null });
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); } else download(`report-${S.sc.id}.html`, html, 'text/html');
}

// ---------- demo run-through (about 4 minutes, every main function once) ----------

function caption(text, sub = '') {
  const c = $('#caption');
  c.hidden = !text;
  const keys = S.demo ? (S.demo.manual ? 'Space / → next · Esc stop' : 'Space / → takes over step by step · Esc stop') : '';
  const chap = S.demo?.chapter ? `<small class="chap">${esc(S.demo.chapter)}</small>` : '';
  c.innerHTML = `${chap}${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}${keys ? `<small class="keys">${keys}</small>` : ''}`;
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
  const html = toHTML({ title: S.model.name, scenario: S.sc.id, results: S.results, model: S.model, rules: allRules(), comments: S.comments?.comments, verification: S.verification,
    score: S.baseline, edits: [...S.edits.values()] });
  let d = $('#reportPreview');
  if (!d) { d = document.createElement('div'); d.id = 'reportPreview'; $('#view').appendChild(d); }
  d.hidden = true;
  d.innerHTML = '<div class="rp-head"><b>Report</b><span class="muted">the HTML file the Report button opens · for the class review</span></div><iframe title="Report preview"></iframe>';
  d.querySelector('iframe').srcdoc = html.replace(/<button on[a-z]+="print\(\)">[^<]*<\/button>/, ''); // no inline handler under the page's CSP
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

// Demo run-through, about 3 minutes, every main function once, each on screen long enough to read, in the order of
// the real process: 1 Drawing → 3D (a PDF general arrangement becomes a checked 3D model; a value from the drawing
// to confirm)   2 design review   3 a finding with its rule   4 AI explanation   5 what-if fix   6 escape plan
// 7 findings register   8 traceability   9 report   10 real 3D production model   11 rule view   12 closing frame.
// Space / → takes over step by step (presenter mode), Esc stops. A chapter whose data is missing here is skipped.
const DEMO_DRAWING = 'demo/aurora-ga.pdf'; // local only (third-party drawing, internal use): not in Git; without it chapter 1 is skipped
const DEMO_CHAPTERS = 12;
async function runDemo() {
  if (S.demo) { S.demo.stop = true; return; }
  const token = (S.demo = { stop: false, manual: new URLSearchParams(location.search).has('present'), next: null, chapter: '' });
  const step = async (ms) => { await sleep(ms); if (token.stop) throw new Error('stopped'); };
  // A beat is a pause in the story. Autoplay waits ms; Space / → / Page Down skips ahead and switches to presenter
  // mode, where every beat waits for the next key press (presentation clickers send → or Page Down).
  // Narration (optional): a page that records the demo as a video may set window.__demoVoice(key) → a promise that
  // resolves when the spoken line for that caption has ended. A caption waits for the line before it, and a beat
  // lasts at least as long as the line it stands under, so voice and screen never drift apart. Without it: silent.
  token.speaking = null;
  const show = async (text, sub = '') => {
    if (token.speaking) await token.speaking;
    if (token.stop) throw new Error('stopped');
    caption(text, sub);
    token.speaking = typeof window.__demoVoice === 'function'
      ? Promise.resolve(window.__demoVoice(`${token.chapter}|${text}`)).catch(() => {}) : null;
  };
  const beat = async (ms) => {
    const key = new Promise((resolve) => { token.next = resolve; });
    await (token.manual ? key : Promise.race([Promise.all([sleep(ms), token.speaking]), key]));
    token.next = null;
    if (token.stop) throw new Error('stopped');
  };
  // Waits until cond() is true (checked every 250 ms), at most maxMs; returns whether it became true.
  const until = async (cond, maxMs) => {
    for (let t = 0; t < maxMs; t += 250) { if (cond()) return true; await step(250); }
    return !!cond();
  };
  let n = 0;
  const chapter = (title) => { token.chapter = `${++n} / ${DEMO_CHAPTERS} · ${title}`; };
  const openItem = async (id) => {
    const item = await pointAt(`#list .item[data-id="${CSS.escape(id)}"]`, step);
    if (item) item.click(); else select(id);
    await step(500);
  };
  document.body.classList.add('demo-running');
  $('#demoBtn').textContent = '■ Stop demo';
  const layout = S.scenarios.find((s) => s.id === 'rcrv-layout') ?? S.scenarios.find((s) => !s.kind && !s.scene);
  const real = S.scenarios.find((s) => s.kind === 'parts');
  try {
    closeTrace(); closeRegister(); closeAiPanel(); closeDrawingPanel();
    if (views.three.plan) { views.three.setPlan(false); $('#planBtn').classList.remove('on'); }

    // 1. Drawing → 3D: where a project starts. A PDF general arrangement becomes a checked 3D model, without AI.
    const pdf = await fetch(DEMO_DRAWING, { cache: 'no-store' }).then((res) => (res.ok ? res.blob() : null)).catch(() => null);
    if (pdf) {
      chapter('Drawing → 3D');
      await show('It starts with a drawing: a PDF general arrangement', 'Drawing → 3D reads its line work and text in the browser: no AI, nothing uploaded');
      await pointAt('#drawingBtn', step, { click: false });
      await beat(2500); // a moment on the opening line (in presenter mode: wait for the presenter)
      const m = await drawingImport();
      await m.openDrawingImport(drawingHost, { file: new File([pdf], 'aurora_1230-01-01_A_GA.pdf', { type: 'application/pdf' }) });
      const viewsReady = () => document.querySelectorAll('#detail tr[data-view]').length > 0 && !document.querySelector('#detail #dwConvert')?.disabled;
      if (await until(viewsReady, 90000)) {
        const kinds = [...document.querySelectorAll('#detail tr[data-view] select')].map((s) => s.value);
        const k = (x) => kinds.filter((v) => v === x).length;
        const scale = $('#dwScale')?.getAttribute('placeholder');
        await show(`${kinds.length} views found on the sheet: ${k('profile')} profiles, ${k('section')} section, ${k('plan')} deck plans`,
          `${scale ? `Scale 1:${scale} found on the drawing · ` : ''}every view can be corrected before converting`);
        await beat(6500);
        const convert = await pointAt('#dwConvert', step);
        await show('Converting: rooms from the walls, doors from the swing arcs, decks from the profile', 'Every value says whether it was measured, read from the text, typed or assumed');
        convert?.click();
        if (await until(() => document.querySelector('#detail h1')?.textContent === 'Drawing converted to 3D', 120000)) {
          await step(1200);
          const f = findingsOf(S.results).find((x) => x.status === 'non_compliant' && unconfirmedInputs(x).length);
          const deckName = f ? m.demoSteps.deckOf(f.element) : null;
          // The reading in 2D: what was recognised, drawn in colour over the drawing, on the deck plan of the finding.
          if (m.demoSteps.overlay()) {
            hidePointer();
            $('#caption').classList.add('top'); // the legend of the overlay is at the bottom of the sheet
            const plan = m.demoSteps.showPlan(deckName);
            const c = m.demoSteps.counts();
            await show(`Recognised on the drawing: ${c.room ?? 0} rooms, ${c.door ?? 0} doors, ${c.stair ?? 0} stairs`,
              `Rooms from closed walls, coloured by use · doors from the swing arcs · stairs from the treads${plan ? ` · here: ${plan}` : ''}`);
            await beat(7500);
            if (f && m.demoSteps.evidence(f.element, { zoom: 5 })) {
              await show('Every element keeps the line work it was read from', `${elById(f.element)?.name ?? 'Element'} ${f.element}: its lines on the drawing in orange · hover any element to see its own`);
              await beat(6000);
            }
          }
          // …and in 3D: the deck plans become decks (pulled apart first, then at their heights).
          $('#caption').classList.remove('top');
          closeDrawingPanel();
          const deckSel = $('#deck');
          if (S.norm.decks.length > 1 && deckSel.querySelector('option[value="exploded"]')) {
            deckSel.value = 'exploded';
            deckSel.dispatchEvent(new Event('change'));
            showOverview();
            await show(`From 2D to 3D: the ${S.norm.decks.length} deck plans become decks`, 'Pulled apart here to show each deck · walls raised to the deck heights measured in the profile view');
            await beat(6000);
            deckSel.value = 'all';
            deckSel.dispatchEvent(new Event('change'));
          }
          showOverview();
          await show(`Converted to 3D: ${S.norm.elements.length} elements on ${S.norm.decks.length} decks, checked at once`,
            `${S.results.summary.non_compliant} non-compliant · ${S.results.summary.not_enough_info} not enough info · the conversion report lists what was measured and what was assumed`);
          await beat(6000);
          if (f) {
            await openItem(f.element);
            const r = S.results.elements[f.element].results.find((x) => x.rule_id === f.rule_id);
            await show(`${elById(f.element)?.name ?? f.element}: ${r.measured} measured from the drawing, required ${r.required}`,
              'Marked “pre-check: input unconfirmed”: a value from a drawing holds only once a person confirms it');
            document.querySelectorAll('#dResults .tag.unconfirmed').forEach(pulse);
            await beat(6500);
            const confirm = document.querySelector('#dResults .icConfirm');
            if (confirm) {
              confirm.closest('.ic')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
              await pointAt(confirm, step, { click: false }); // shown, not clicked: the demo writes nothing into the register
              await show('The engineer checks the value on the drawing and confirms it', 'With their name and the date · it holds only for this value · the result itself never changes');
              pulse(confirm.closest('.ic'));
              await beat(5500);
            }
          }
        } else {
          await show('The conversion did not finish in time', 'The demo continues');
          await beat(2500);
        }
      }
      closeDrawingPanel();
    }

    // 2. Design review on a prepared design model of a research vessel, checked against the rule catalog.
    if (layout) {
      closeDrawingPanel();
      chapter('Design review');
      if (S.sc.id !== layout.id || S.edits.size) await loadScenario(layout.id);
      await waitViewer(step, token);
      if (S.escapeOn) setEscapeMode(false);
      showOverview();
      viewer.paintNeutral();
      await show(`The full review on a design model: ${S.model.name}`, `${S.norm.decks.length} decks · ${S.norm.elements.length} rooms, doors, stairs, rails and openings · ship/1 design model`);
      await beat(3500);
      const run = allRules().filter((r) => !r.draft && Object.values(S.results.elements).some((e) => e.results.some((x) => x.rule_id === r.id)));
      await show(`Checking ${run.length} rules: deterministic, in the browser`, [...new Set(run.map((r) => family(r.source)))].join(' · '));
      await paintProgressively(step);
      const s = S.results.summary;
      await show(`${s.non_compliant} non-compliant · ${s.not_enough_info} not enough info · ${s.compliant} compliant`,
        `Checked in ${S.lastCheckMs.toFixed(1)} ms · same input, same result · pass/fail never comes from AI`);
      pulse('#pills'); pulse('#scorebox'); pulse('#readyBox');
      await beat(5000);

      // 3. One finding: measured against required, with the rule text and its source.
      const door = findingsOf(S.results).find((f) => f.status === 'non_compliant' && f.element === 'MD-D1')
        ?? findingsOf(S.results).find((f) => f.status === 'non_compliant');
      if (door) {
        chapter('A finding and its rule');
        await openItem(door.element);
        const r = S.results.elements[door.element].results.find((x) => x.rule_id === door.rule_id);
        await show(`${elById(door.element)?.name ?? door.element}: ${r.measured}, required ${r.required}`, `“${ruleQuote(r)}” (${r.source.split(':')[0]})`);
        document.querySelectorAll('#dResults .res.st-non_compliant').forEach(pulse);
        await beat(6500);

        // 4. AI explanation of that finding: plain language, exceptions to check, ways to fix it.
        chapter('AI explanation');
        const btn = document.querySelector(`#dResults .explainBtn[data-rule="${CSS.escape(r.rule_id)}"]`);
        if (!aiState.status?.available || !btn) {
          await show('AI explanation: not available here', 'It needs the Complee backend with an API key; everything else works without it');
          await beat(3500);
        } else {
          await show('✦ Explain: the AI explains the finding in plain language', 'Exceptions to check and ways to fix it · the result itself stays with the checker');
          const key = explainKey(door.element, r);
          if (!S.explain.get(key)?.data) { await pointAt(btn, step); btn.click(); } // a second click would fold it away
          const card = () => document.querySelector(`#dResults .res[data-rule="${CSS.escape(r.rule_id)}"]`);
          card()?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          await until(() => S.explain.get(key)?.data || S.explain.get(key)?.error, 60000);
          const st = S.explain.get(key);
          if (st?.data) {
            const box = card()?.querySelector('.ai-box');
            hidePointer(); // the answer grows under the Explain button: keep the pointer off the text
            box?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            if (box) pulse(box);
            await show('AI answer: summary and concrete fixes', `${modelLabel(st.data.model)} · ${((st.data.duration_ms ?? 0) / 1000).toFixed(1)} s · ${cents(st.data.cost_usd)} · the finding stays non-compliant until the design changes`);
            await beat(11000);
          } else {
            await show('The AI did not answer in time', st?.error ?? 'The check results are not affected');
            await beat(3000);
          }
        }
      }

      // 5. What-if: the engineer types a new value; re-checked and recoloured at once, the model is not changed.
      const d = S.model.demo || {};
      if (d.focus && S.results.elements[d.focus] && d.fix) {
        chapter('What-if fix');
        await openItem(d.focus);
        const fe = S.results.elements[d.focus];
        const bad = fe.results.filter((r) => r.status === 'non_compliant');
        if (bad.length) {
          await show(`${elById(d.focus).name}: ${bad[0].measured} fails ${bad.length} overlapping rule${bad.length > 1 ? 's' : ''}`,
            `${bad.map((r) => `${r.rule_id} (${r.required})`).join(' + ')} · inch values converted to mm`);
          document.querySelectorAll('#dResults .res.st-non_compliant').forEach(pulse);
          await beat(5500);
        }
        await show(`What-if: ${d.fix.prop.replace(/_/g, ' ')} = ${d.fix.value} ${d.fix.unit || 'mm'}`, 'Labelled "what-if, not in model"; re-checked and recoloured instantly');
        await step(800);
        if (await demoTypeFix(step, d.focus, d.fix)) {
          await step(600);
          const now = S.results.elements[d.focus].worst;
          await show(`${d.focus} is now ${LABEL[now].toLowerCase()} (what-if, not in model)`, `Re-checked in ${S.lastCheckMs.toFixed(1)} ms · reset restores the model value; the model itself is never changed`);
          $('#detail').scrollTo({ top: 0, behavior: 'smooth' });
          pulse('#dStatus');
          await beat(5000);
        }
      }

      // 6. Escape plan: routes from every room to a muster station, from the same model.
      if (S.escape || S.escapePending) {
        chapter('Escape plan');
        const eb = await pointAt('#escapeBtn', step);
        if (eb) eb.click(); else setEscapeMode(true);
        await until(() => S.escapeOn && S.escape, 10000);
        if (S.escape) {
          const rooms = escapeRooms();
          const count = (st) => rooms.filter((o) => o.status === st).length;
          await show('Escape plan: every room to a muster station, computed from the layout',
            `${count('two_routes') + count('direct')} rooms with two independent routes · ${count('shared_route')} share a corridor · ${count('single_route')} with a single route only`);
          pulse('#escapeBox');
          await beat(6000);
          const one = rooms.filter((o) => o.status === 'single_route' && o.primary).sort((a, b) => (b.primary.length_mm ?? 0) - (a.primary.length_mm ?? 0))[0];
          if (one) {
            select(one.id);
            await step(600);
            await show(`${elById(one.id)?.name ?? one.id}: single route only`, `${one.primary.length_mm ? `${(one.primary.length_mm / 1000).toFixed(1)} m to the muster station · ` : ''}a route analysis next to the rule check, not a pass/fail`);
            await beat(6000);
          }
          setEscapeMode(false);
          showOverview();
          await step(600);
        }
      }

      // 7. Findings register: how each finding is handled and by whom; never changes the check result.
      chapter('Findings register');
      const rb = await pointAt('#registerBtn', step);
      if (rb) {
        openRegister();
        const s2 = registerSummary(registerRows(S.results, S.register));
        await show(`Findings register: ${s2.total} findings, ${s2.open} open`, 'Disposition, responsible person and justification per finding · carried over to the next revision · CSV and report');
        await beat(6500);
        closeRegister();
      }

      // 8. Traceability: every part against every rule; a cell opens that part and its rule card.
      chapter('Traceability');
      await show('Traceability: every part against every rule', 'One click on a cell opens the part and the rule card behind the result');
      const tb = await pointAt('#traceBtn', step);
      if (tb) {
        openTrace();
        await step(400);
        prepareReportPreview(); // built now, while the table is on screen and nothing moves
        await beat(5000);
        const cell = d.focus && await pointAt(`#tracePanel td.cell[data-id="${CSS.escape(d.focus)}"]`, step);
        if (cell) {
          cell.click();
          await show(`${d.focus}: compliant with the what-if value`, 'From the table straight to the part, its rule card and the value that decided it');
          await beat(4000);
        }
        closeTrace();
      }

      // 9. Report: the HTML report for the class review (shown in the page; the button opens it in a new tab).
      chapter('Report');
      await show('Export the findings: HTML report and CSV', 'Rule references, measured vs required, value provenance, what-if values, readiness');
      await pointAt('#reportBtn', step);
      const frame = showReportPreview();
      await step(1400);
      for (let i = 1; i <= 8; i++) { frame.contentWindow?.scrollTo({ top: i * 280, behavior: 'smooth' }); await step(900); }
      await beat(2500);
      hideReportPreview();
    }

    // 10. The real production model (ShipConstructor, 35 000+ parts), checked with the same rules.
    if (real) {
      chapter('Real 3D production model');
      await show('Now the real ship: the ShipConstructor production model', 'Loaded from the exported model tiles; the check already ran');
      await pointAt('#scenario', step, { click: false });
      await loadScenario(real.id);
      await waitViewer(step, token);
      const c = S.model.counts;
      await show('OSU RCRV: real ShipConstructor production model', `${c ? `${c.objects.toLocaleString('en')} objects in the model · ` : ''}${S.norm.elements.length.toLocaleString('en')} parts checked · inches converted to mm`);
      showOverview();
      viewer.paintNeutral();
      await beat(3500);
      await paintProgressively(step);
      const s = S.results.summary;
      await show(`${s.non_compliant} non-compliant · ${s.not_enough_info.toLocaleString('en')} not enough info · ${s.compliant.toLocaleString('en')} compliant`,
        S.baseline ? `Ground truth: ${S.baseline.line ?? scoreLine(S.baseline)}` : 'Deterministic checker: same input, same result');
      pulse('#pills'); pulse('#scorebox'); pulse('#accBadge');
      await beat(4500);
      const d = S.model.demo || {};
      const first = findingsOf(S.results).find((f) => f.status === 'non_compliant' && (!d.focus_rule || f.rule_id === d.focus_rule)) ?? findingsOf(S.results)[0];
      if (first) {
        await openItem(first.element);
        const r = S.results.elements[first.element].results.find((x) => x.rule_id === first.rule_id);
        await show(`${first.element}: ${r.measured} in hull structure (SWBS ${elById(first.element)?.props?.swbs_group?.value ?? '1xx'})`,
          `“${ruleQuote(r, d.quote_match)}” (${r.source.split(':')[0]})`);
        document.querySelectorAll('#dResults .res.st-non_compliant').forEach(pulse);
        await beat(6000);
      }

      // 11. Rule view: every part one rule applies to, coloured by that rule, in the real ship.
      const h = d.hatch;
      if (h && ruleById(h.rule)) {
        chapter('Rule view');
        const row = await pointAt(`#rulesBox .ruleRow[data-rule="${CSS.escape(h.rule)}"]`, step);
        if (row) row.click(); else showRule(h.rule);
        await show(`Rule view: ${countLine(ruleHits(h.rule))}`, 'Every part the rule applies to, coloured by that rule, in the real ship');
        pulse('#ruleCount');
        await beat(5500);
        const back = document.querySelector('#ruleBack');
        if (back) { await pointAt(back, step); back.click(); await step(800); }
      }
    }

    // 12. Closing frame: back to the general arrangement (unedited), every result coloured.
    chapter('Summary');
    hidePointer();
    if (layout && (S.sc.id !== layout.id || S.edits.size)) { await loadScenario(layout.id); await waitViewer(step, token); }
    showOverview();
    await show('Complee: deterministic rule checks, traceable to rule, source and design value',
      'AI explains, never decides · what-ifs never change the model · drawings become checkable 3D models');
    await beat(6000);
  } catch (e) {
    if (e.message !== 'stopped') console.error(e);
  } finally {
    hidePointer();
    hideReportPreview();
    document.body.classList.remove('demo-running');
    S.demo = null;
    caption('');
    $('#caption').classList.remove('top');
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
  // The findings list follows the deck shown in 3D (the list's own deck filter can still change it).
  S.filter.deck = S.norm.decks.some((d) => d.id === e.target.value) ? e.target.value : '';
  renderFilters();
  renderList();
};
$('#demoBtn').onclick = runDemo;
$('#reportBtn').onclick = exportReport;
$('#traceBtn').onclick = () => ($('#tracePanel').hidden ? openTrace() : closeTrace());
$('#csvBtn').onclick = exportCSV;
$('#dxfBtn').onclick = exportDXF;
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
$('#aiPill').onclick = () => ($('#aiPanel').hidden ? openAiPanel() : closeAiPanel());
loadAiStatus();
$('#manageLink').onclick = (e) => { e.preventDefault(); openRegister(); };
$('#openBtn').onclick = () => $('#openFile').click();
$('#openFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) openModelFile(f); };
// Drawing → 3D (drawing-import.js, loaded on first use). The module gets what it needs through this host object.
const drawingHost = {
  addScenario: (args) => addScenario(args),
  results: () => S.results,
  hasElement: (id) => !!S.results?.elements[id] && !!elById(id),
  select: (id) => select(id),
  download,
  closeOtherPanels: () => { closeRegister(); closeTrace(); closeAiPanel(); },
};
let drawingModule = null;
const drawingImport = () => (drawingModule ??= import('./drawing-import.js').catch((e) => { drawingModule = null; throw e; }));
const drawingFailed = (e) => { $('#detail').innerHTML = `<p class="check-bad"><b>Drawing → 3D could not start.</b> ${esc(e.message)}</p>`; console.error(e); };
$('#drawingBtn').onclick = () => {
  // The file dialog must open within the click (browsers allow it only then), so on the first click before the module
  // has loaded; later the module opens it itself when no drawing is loaded yet.
  const first = !drawingModule;
  if (first) $('#drawingFile').click();
  drawingImport().then((m) => m.openDrawingImport(drawingHost, { pick: !first })).catch(drawingFailed);
};
$('#drawingFile').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (f) drawingImport().then((m) => m.openDrawingImport(drawingHost, { file: f })).catch(drawingFailed);
};
$('#viewTools').onclick = (e) => {
  const b = e.target.closest('button');
  if (!b || viewer !== views.three) return;
  if (b.dataset.view) { $('#planBtn').classList.remove('on'); viewer.setView(b.dataset.view); }
  else if (b.dataset.act === 'fit') { if (S.selected) viewer.flyToElement(S.selected, 600); else viewer.overview(600); }
  else if (b.dataset.act === 'all') {
    S.selected = null; viewer.select(null); syncEscapeView(); renderList(); viewer.overview(600);
    $('#detail').innerHTML = '<p class="muted">Click an element in the model or in the list to see every rule that applies, why it passes or fails, and where each value comes from.</p>';
  }
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
    $('#loadingDetail').innerHTML = `Could not load: ${esc(message)} <button type="button" id="loadingReload">Reload</button>`;
    $('#loadingReload').onclick = () => location.reload(); // no inline handler: the page's CSP would block it
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
