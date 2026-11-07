// ShipCheck UI. The pass/fail decision always comes from the shared deterministic checker
// (/src/checker.mjs), which runs right here in the browser so edits re-check instantly.
import { checkModel, normalizeModel, findingsOf, readValue, UNIT_TO_MM, STATUS_RANK } from '/src/checker.mjs';
import { scoreResults, scoreLine, badgeText } from '/src/score.mjs';
import { partsToModel } from '/src/parts-model.mjs';
import { reportRows, toCSV, toHTML } from '/src/report.mjs';
import { createViewer } from './viewer3d.js';
import { createApsViewer, createFallbackViewer } from './viewer-aps.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fetchJSON = (u, opt) => fetch(u, { cache: 'no-store', ...opt }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${u}: ${r.status}`))));
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
  if (/derived by ShipCheck|not in the model/.test(src)) return 'der';
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
};
const allRules = () => S.coreRules;
const ruleById = (id) => allRules().find((r) => r.id === id);
const elById = (id) => S.model.elements.find((e) => e.id === id);
const deckName = (id) => S.norm.decks.find((d) => d.id === id)?.name ?? id;

// Two viewers share the centre pane: Three.js for deck models, the Autodesk APS viewer for the real
// production model (with a screenshot + findings fallback when APS cannot be reached).
const onPick = (id) => { if (S.results?.elements[id]) select(id, { fly: false }); };
const views = { three: createViewer($('#threeView'), { onPick }), aps: null, fallback: null };
let viewer = views.three;
const LIST_PAGE = 400;
let listLimit = LIST_PAGE;

// The findings render at once; the APS model (large, streamed from Autodesk) is coloured when it arrives.
// S.viewerReady resolves when the scenario's viewer is usable.
const NOOP_VIEWER = { build() {}, update() {}, paintNeutral() {}, select() {}, flyToElement() {}, setFilter() {}, overview() {}, setMode() {}, setPlan() {}, mode: 'all', plan: false };
function useViewer(sc) {
  const want = sc.viewer === 'aps' ? 'aps' : 'three';
  $('#threeView').hidden = want !== 'three';
  $('#apsView').hidden = want !== 'aps';
  $('#fallbackView').hidden = true;
  $('#planBtn').hidden = want !== 'three';
  $('#simpleBtn').hidden = $('#cutSel').hidden = true;
  $('#simpleBtn').classList.remove('on');
  if (want === 'three') { viewer = views.three; S.viewerReady = Promise.resolve('three'); return; }
  views.fallback ??= createFallbackViewer($('#fallbackView'));
  views.fallback.setImages(sc.fallback_images || []);
  viewer = NOOP_VIEWER;
  S.viewerReady = (async () => {
    try {
      // ?noaps forces the offline fallback (test without internet).
      if (new URLSearchParams(location.search).has('noaps')) throw new Error('disabled with ?noaps');
      // ?clearcache removes the Autodesk viewer's local model cache first (a corrupt cache can stall loading).
      if (new URLSearchParams(location.search).has('clearcache')) {
        const root = await navigator.storage?.getDirectory?.().catch(() => null);
        await root?.removeEntry('otg_cache', { recursive: true }).catch(() => null);
      }
      views.aps ??= await createApsViewer($('#apsView'), { onPick });
      await views.aps.load();
      if (S.sc !== sc) return 'stale';
      viewer = views.aps;
      viewer.build(S.norm, S.results);
      if (viewer.simple) viewer.setSimple(false);
      $('#simpleBtn').hidden = $('#cutSel').hidden = false;
      $('#cutSel').innerHTML = '<option value="">No deck cut</option>';
      renderList();
      if (S.selected) select(S.selected);
      return 'aps';
    } catch (e) {
      console.warn('APS viewer unavailable, using fallback:', e.message);
      if (S.sc !== sc) return 'stale';
      views.fallback.setReason(e.message);
      $('#apsView').hidden = true;
      $('#fallbackView').hidden = false;
      viewer = views.fallback;
      viewer.build();
      if (S.selected) select(S.selected);
      return 'fallback';
    }
  })();
}

// ---------- loading ----------

async function init() {
  const [scen, core] = await Promise.all([fetchJSON('/api/scenarios'), fetchJSON('/rules.json')]);
  S.scenarios = scen;
  S.coreRules = core.rules;
  $('#scenario').innerHTML = S.scenarios.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  const want = new URLSearchParams(location.search).get('scenario');
  await loadScenario(S.scenarios.find((s) => s.id === want)?.id ?? S.scenarios[0].id);
}

// Real production models come as a parts file (kind "parts") and are turned into a checker model here,
// in the browser. If the parts file cannot be loaded, the precomputed results are shown read-only.
async function fetchModel(sc) {
  if (sc.kind !== 'parts') return { model: await fetchJSON('/' + sc.model) };
  try {
    const [parts, meta] = await Promise.all([fetchJSON('/' + sc.model), sc.meta ? fetchJSON('/' + sc.meta) : {}]);
    return { model: partsToModel(parts, meta) };
  } catch (e) {
    if (!sc.precomputed) throw e;
    const [pre, meta] = await Promise.all([fetchJSON('/' + sc.precomputed), sc.meta ? fetchJSON('/' + sc.meta).catch(() => ({})) : {}]);
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
  S.sc = S.scenarios.find((s) => s.id === id);
  $('#scenario').value = id;
  const [{ model, precomputed }, expected] = await Promise.all([
    fetchModel(S.sc),
    S.sc.expected ? fetchJSON('/' + S.sc.expected).catch(() => null) : null,
  ]);
  S.precomputed = precomputed ?? null;
  S.pristine = model;
  S.model = structuredClone(model);
  S.norm = normalizeModel(S.model);
  S.expected = expected;
  S.edits.clear();
  S.selected = null;
  S.ruleView = null;
  listLimit = LIST_PAGE;
  // Large real models start with the findings only (thousands of compliant parts otherwise).
  S.filter.status = new Set(S.norm.elements.length > 2000 ? ['non_compliant', 'not_enough_info'] : ['non_compliant', 'not_enough_info', 'compliant', 'null']);
  // Ground-truth score is computed on the unedited design with the core rule set only.
  S.baseline = precomputed ? precomputed.score : expected ? scoreResults(checkModel(S.pristine, S.coreRules), expected) : null;
  if (S.baseline && !S.baseline.line) S.baseline.line = scoreLine(S.baseline);
  runCheck();
  useViewer(S.sc);
  viewer.build(S.norm, S.results);
  viewer.setMode('all');
  const decks = S.norm.decks;
  $('#deck').innerHTML = `<option value="all">All decks</option>` +
    (decks.length > 1 ? `<option value="exploded">Exploded</option>` : '') +
    decks.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
  S.filter.deck = '';
  renderAll();
  $('#detail').innerHTML = `<p class="muted">Click an element in the model or in the list to see every rule that applies, why it passes or fails, and where each value comes from.</p>`;
}

function runCheck() {
  const t0 = performance.now();
  S.results = S.precomputed ? resultsFromPrecomputed(S.precomputed) : checkModel(S.model, allRules());
  S.lastCheckMs = performance.now() - t0;
}

function recheck(ids) {
  runCheck();
  viewer.update(S.results, ids);
  renderSummary();
  renderRules();
  renderEdits();
  renderList();
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
  renderFilters();
  renderList();
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
    ${S.model.scope_note ? `<div class="note scope">${esc(S.model.scope_note)}</div>` : ''}`;
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
    <div class="scorebox ${b.pass ? 'pass' : 'fail'}" id="scorebox" title="Computed on the unedited design against tests/expected/${esc(S.sc.id)}.json (also run by npm test)">
      <b>${b.pass ? '✓' : '✗'} ${esc(scoreLine(b))}</b>
      <span class="muted">Ground truth for the unedited design (tests/expected/${esc(S.sc.id)}.json)</span>
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
    </div>`;
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
  return Object.values(S.results.elements).filter((e) => {
    if (f.deck && e.deck !== f.deck) return false;
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
  const all = S.filter.status.size === 4 && !S.filter.family && !S.filter.deck;
  viewer.setFilter(all ? null : new Set(items.map((e) => e.id)));
}

// ---------- detail panel ----------

function select(id, { fly = true } = {}) {
  S.selected = id;
  const el = elById(id);
  if (el && viewer.mode !== 'all' && viewer.mode !== 'exploded' && viewer.mode !== el.deck) {
    $('#deck').value = el.deck;
    viewer.setMode(el.deck);
  }
  if (S.ruleView) { S.ruleView = null; viewer.clearHighlight?.(); }
  viewer.select(id, { fly, label: labelFor(id), status: S.results.elements[id]?.worst });
  document.querySelectorAll('#list .item').forEach((n) => n.classList.toggle('sel', n.dataset.id === id));
  document.querySelector(`#list .item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' });
  renderDetail(id);
}

function renderDetail(id) {
  const e = S.results.elements[id], el = elById(id);
  $('#detail').innerHTML = `
    <h1>${esc(id)} · ${esc(el.name)}</h1>
    <div class="muted">${esc(el.type)} · ${esc(deckName(el.deck))}${el.objectid != null ? ` · viewer dbId ${el.objectid}` : ''} · source: ${prov(el.source || S.model.source || 'not stated')}</div>
    <div id="dStatus" style="margin-top:6px"></div>
    ${el.note ? `<div class="note"><b>Model note:</b> ${esc(el.note)}</div>` : ''}
    <div id="dComponent"></div>
    <div id="dResults"></div>
    <h2>Design data (what-if editing)</h2>
    <div id="dEditor"></div>`;
  renderComponent(id);
  renderResults(id);
  renderEditor(id);
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
    <div class="rulecount" id="ruleCount">${esc(countLine(hits))}</div>
    <div class="row" style="display:flex;gap:6px;margin:6px 0"><button id="ruleBack">Back to all findings</button></div>
    <div id="ruleParts">${shown.map((h) => `<div class="item" data-id="${esc(h.id)}"><span class="dot st-${h.status}"></span>
      <span><b>${esc(h.id)}</b> ${esc(h.name)}<br><span class="muted">${esc(h.measured ?? 'value missing')}</span></span></div>`).join('')}
      ${hits.length > shown.length ? `<p class="muted">${(hits.length - shown.length).toLocaleString('en')} more parts (use the traceability table or the report).</p>` : ''}</div>`;
  $('#ruleBack').onclick = () => { S.ruleView = null; viewer.clearHighlight?.(); viewer.overview(); renderRules(); renderList();
    $('#detail').innerHTML = '<p class="muted">Click a part, a finding or a rule.</p>'; };
  $('#ruleParts').querySelectorAll('.item').forEach((n) => (n.onclick = () => select(n.dataset.id)));
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

// ---------- report export (shared with the CLI: src/report.mjs) ----------

function exportCSV() {
  download(`findings-${S.sc.id}.csv`, toCSV(reportRows(S.results, S.model, allRules())), 'text/csv');
}

function exportReport() {
  const html = toHTML({ title: S.model.name, scenario: S.sc.id, results: S.results, model: S.model, rules: allRules(),
    score: S.baseline, edits: [...S.edits.values()] });
  const w = window.open('', '_blank');
  if (w) { w.document.write(html); w.document.close(); } else download(`report-${S.sc.id}.html`, html, 'text/html');
}

// ---------- demo run-through (about 28 s after the 3D model is loaded) ----------

function caption(text, sub = '') {
  const c = $('#caption');
  c.hidden = !text;
  c.innerHTML = `${esc(text)}${sub ? `<small>${esc(sub)}</small>` : ''}`;
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
  if (!done) caption('Loading the real 3D model from Autodesk APS…', 'Streamed once per session; the check itself already ran locally');
  while (!done) { await step(250); if (token.stop) return; }
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

async function demoTypeFix(step, focus, fix) {
  const inp = fix.prop && $('#dEditor').querySelector(`[data-key="${CSS.escape(fix.prop)}"]`);
  if (!inp) return false;
  inp.closest('tr').scrollIntoView({ block: 'center', behavior: 'smooth' });
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
  const token = (S.demo = { stop: false });
  const step = async (ms) => { await sleep(ms); if (token.stop) throw new Error('stopped'); };
  $('#demoBtn').textContent = '■ Stop demo';
  const real = S.scenarios.find((s) => s.kind === 'parts');
  const cruise = S.scenarios.find((s) => s.id === 'cruise');
  try {
    if (views.three.plan) { views.three.setPlan(false); $('#planBtn').classList.remove('on'); }
    // 1. Open the real RCRV model (reuse it if it is already open and unedited).
    if (real) {
      if (S.sc.id !== real.id || S.edits.size) await loadScenario(real.id);
      await waitViewer(step, token);
      const c = S.model.counts;
      caption('OSU RCRV: real ShipConstructor production model', `${c ? `${c.objects.toLocaleString('en')} objects in the model · ` : ''}${S.norm.elements.length.toLocaleString('en')} parts checked · inches converted to mm`);
      viewer.overview();
      viewer.paintNeutral();
      await step(2800);

      // 2. Run the check: colours appear group by group.
      const run = allRules().filter((r) => !r.draft && Object.values(S.results.elements).some((e) => e.results.some((x) => x.rule_id === r.id)));
      caption(`Checking ${run.length} rules on real design data`, [...new Set(run.map((r) => family(r.source)))].join(' · '));
      await paintProgressively(step);
      const s = S.results.summary;
      caption(`${s.non_compliant} non-compliant · ${s.not_enough_info.toLocaleString('en')} not enough info · ${s.compliant.toLocaleString('en')} compliant`,
        S.baseline ? `Ground truth: ${S.baseline.line ?? scoreLine(S.baseline)}` : 'Deterministic checker: same input, same result');
      pulse('#pills'); pulse('#scorebox'); pulse('#accBadge');
      await step(3000);

      // 3. Fly to the first red part, with the rule quote.
      const d = S.model.demo || {};
      const first = findingsOf(S.results).find((f) => f.status === 'non_compliant' && (!d.focus_rule || f.rule_id === d.focus_rule)) ?? findingsOf(S.results)[0];
      if (first) {
        select(first.element);
        const r = S.results.elements[first.element].results.find((x) => x.rule_id === first.rule_id);
        caption(`${first.element}: ${r.measured} in hull structure (SWBS ${elById(first.element)?.props?.swbs_group?.value ?? '1xx'})`,
          `“${ruleQuote(r, d.quote_match)}” (${r.source.split(':')[0]})`);
        document.querySelectorAll('#dResults .res.st-non_compliant').forEach(pulse);
        await step(4800);
      }
    }

    // 4. Switch to the cruise deck: C2 fails two overlapping rules.
    if (cruise) {
      caption('Cruise passenger deck: same checker, passenger rules', 'SOLAS/FSS means of escape + ADA/PVAG accessibility');
      await loadScenario(cruise.id);
      await step(1600);
      const d = S.model.demo || {};
      const focus = d.focus;
      select(focus);
      const fe = S.results.elements[focus];
      const bad = fe.results.filter((r) => r.status === 'non_compliant');
      const gov = fe.governing[d.fix?.prop];
      caption(`${focus} fails ${bad.length} overlapping rules: ${bad.map((r) => `${r.rule_id} (${r.required})`).join(' + ')}`,
        gov ? `The strictest governs: ${gov.required} (${gov.rule_id}). Measured: ${bad[0]?.measured}` : '');
      document.querySelectorAll('#dResults .res.st-non_compliant').forEach(pulse);
      pulse('#dResults .gov');
      await step(4200);

      // 5. Fix it live and watch it turn green.
      const fix = d.fix || {};
      caption(`Engineer sets ${fix.prop} to ${fix.value} ${fix.unit || 'mm'}`, 'Every edit is re-checked instantly by the deterministic checker');
      if (await demoTypeFix(step, focus, fix)) {
        await step(500);
        const now = S.results.elements[focus].worst;
        caption(now === 'compliant' ? `${focus} is now compliant with both rules` : `${focus}: ${LABEL[now]}`,
          `Re-checked in ${S.lastCheckMs.toFixed(1)} ms · logged as a session edit for the class submission report`);
        $('#detail').scrollTo({ top: 0, behavior: 'smooth' });
        pulse('#dStatus');
        await step(3000);
      }
    }
    caption('Export the findings: HTML report and CSV', 'Rule references, measured vs required, value provenance, inch → mm conversions');
    pulse('#reportBtn'); pulse('#csvBtn');
    await step(2600);
  } catch (e) {
    if (e.message !== 'stopped') console.error(e);
  } finally {
    caption('');
    S.demo = null;
    $('#demoBtn').innerHTML = '&#9654; Demo run-through';
  }
}
// ---------- wiring ----------

$('#scenario').onchange = (e) => loadScenario(e.target.value);
$('#deck').onchange = (e) => {
  viewer.setMode(e.target.value);
  if (S.selected) viewer.select(S.selected, { fly: false });
};
$('#demoBtn').onclick = runDemo;
$('#reportBtn').onclick = exportReport;
$('#csvBtn').onclick = exportCSV;
addEventListener('keydown', (e) => { if (e.key === 'Escape' && S.demo) S.demo.stop = true; });
// Simple view (real model): context (shell + decks) and checked parts only; deck cut from the deck plating.
$('#simpleBtn').onclick = () => {
  const on = !viewer.simple;
  viewer.setSimple?.(on);
  $('#simpleBtn').classList.toggle('on', on);
};
$('#cutSel').onfocus = () => {
  if ($('#cutSel').options.length > 1 || !viewer.deckLevels) return;
  const lv = viewer.deckLevels();
  $('#cutSel').innerHTML = '<option value="">No deck cut</option>' + lv.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
};
$('#cutSel').onchange = (e) => viewer.setDeckCut?.(e.target.value);
$('#planBtn').onclick = () => { viewer.setPlan(!viewer.plan); $('#planBtn').classList.toggle('on', viewer.plan); };

window.__shipcheck = S; // for debugging in the console
init().then(() => { if (new URLSearchParams(location.search).has('demo')) runDemo(); })
  .catch((e) => { $('#detail').innerHTML = `<p class="check-bad">Failed to load: ${esc(e.message)}</p>`; console.error(e); });
