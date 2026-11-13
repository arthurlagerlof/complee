// Rule verification page: every rule's versions, the quotes from official sources that back them, and the level 1
// (text check) and level 2 (engineering review) decisions. The backend stores everything immutably; this page never
// edits a stored record, it writes new versions and new decisions.
import { validateRule, validateRelations } from './src/checker.mjs';
import { LEVEL_LABEL } from './src/verify-status.mjs';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const API = 'api/rule-verification/';
const FIELDS = ['requirement', 'value', 'unit', 'values', 'rows', 'applies_to.ship', 'applies_to.where', 'constructed', 'exception'];
const LICENCE = { public: 'public', licensed_internal: 'licensed, internal use only', paraphrase_only: 'paraphrase only' };

const V = { catalog: [], status: {}, sources: [], selected: null, detail: null, draft: null, proposal: null, view: 'rule', msg: '' };

async function api(path, body) {
  const res = await fetch(API + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* reported below */ }
  if (!res.ok) throw new Error(data?.error || `The backend answered ${res.status}.`);
  return data;
}

const me = () => $('#me').value.trim();
try { $('#me').value = localStorage.getItem('complee.verify.name') || ''; } catch { /* private window */ }
$('#me').onchange = () => { try { localStorage.setItem('complee.verify.name', me()); } catch { /* ignore */ } };
const needName = () => { if (!me()) { alert('Enter your name at the top first: every version and decision is recorded with it.'); $('#me').focus(); return false; } return true; };

async function loadAll() {
  $('#importBtn').disabled = true; // until the catalog is loaded: an early click would import an empty list
  try {
    const [cat, st, src] = await Promise.all([fetch('api/catalog/rules').then((r) => r.json()), api('status'), api('sources')]);
    V.catalog = cat.rules ?? [];
    V.status = st.rules ?? {};
    V.sources = src.sources ?? [];
  } catch (e) {
    $('#main').innerHTML = `<div class="card"><b>Rule verification is not available.</b><p class="errs">${esc(e.message)}</p>
      <p class="muted">It needs the backend with its database (DATABASE_URL in backend/.env) and the migration applied: <code>cd backend; .venv\\Scripts\\alembic upgrade head</code>.</p></div>`;
    return;
  }
  $('#importBtn').disabled = !V.catalog.length;
  renderList();
  renderCounts();
  if (V.view === 'sources') renderSources(); else if (V.selected) await openRule(V.selected); else renderIntro();
}

function levelOf(id) {
  const s = V.status[id];
  return s ? s.label : 'not_imported';
}
function chip(label) {
  return label === 'not_imported' ? '<span class="lvl draft">not imported</span>' : `<span class="lvl ${esc(label)}">${esc({ draft: 'draft', text_checked: 'text checked', reviewed: 'reviewed', internal: 'internal' }[label] ?? label)}</span>`;
}

function renderCounts() {
  const c = { draft: 0, text_checked: 0, reviewed: 0, internal: 0 };
  for (const s of Object.values(V.status)) c[s.label] = (c[s.label] || 0) + 1;
  const missing = V.catalog.filter((r) => !V.status[r.id]).length;
  $('#counts').textContent = `${c.reviewed} reviewed · ${c.text_checked} text checked · ${c.draft} draft · ${c.internal} internal${missing ? ` · ${missing} not imported` : ''}`;
}

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const ids = [...new Set([...V.catalog.map((r) => r.id), ...Object.keys(V.status)])].filter((id) => !q || id.toLowerCase().includes(q));
  $('#list').innerHTML = ids.map((id) => `<div class="vrule ${V.selected === id ? 'sel' : ''}" data-id="${esc(id)}"><b>${esc(id)}</b>${chip(levelOf(id))}</div>`).join('') || '<p class="muted">No rules.</p>';
  $('#list').querySelectorAll('.vrule').forEach((n) => (n.onclick = () => openRule(n.dataset.id)));
}
$('#search').oninput = renderList;

function renderIntro() {
  $('#main').innerHTML = `<div class="card"><h3>How a rule gets verified</h3>
    <ol>
      <li><b>Sources:</b> add the official text (PDF, DOCX or TXT) of the edition you check against: instrument, edition, licence.</li>
      <li><b>Evidence:</b> open a rule and back each required field with a verbatim quote from the source. The page checks every quote against the stored text; a quote that is not found cannot be saved. ✦ <i>Propose from source</i> lets the AI find the quotes; you still check them.</li>
      <li><b>Save a new version</b> with the reason. Versions are never changed; a changed rule starts again as a draft.</li>
      <li><b>Level 1, text check:</b> confirm that every field matches its quote.</li>
      <li><b>Level 2, engineering review:</b> by a qualified engineer who is not the author or the text checker (interpretation, exceptions, measurement).</li>
    </ol>
    <p class="muted">${Object.keys(V.status).length ? 'Pick a rule on the left.' : 'Start with <b>Import catalog rules</b>: the bundled rules become draft version 1.'}</p></div>`;
}

// ---------- one rule ----------

async function openRule(id) {
  V.view = 'rule';
  V.selected = id;
  V.proposal = null;
  renderList();
  if (!V.status[id]) {
    $('#main').innerHTML = `<div class="card"><h3>${esc(id)}</h3><p class="muted">This rule is not in the verification database yet. Use <b>Import catalog rules</b>.</p></div>`;
    return;
  }
  $('#main').innerHTML = '<p class="muted">Loading…</p>';
  try { V.detail = await api(`rules/${encodeURIComponent(id)}`); } catch (e) { $('#main').innerHTML = `<p class="errs">${esc(e.message)}</p>`; return; }
  const latest = V.detail.versions[0];
  V.draft = { logic: JSON.stringify(latest.logic, null, 2), evidence: latest.evidence.map((e) => ({ field: e.field, source_id: e.source_id, quote: e.quote, check: { found: true, page: e.page } })), reason: '' };
  renderRule();
}

function renderRule() {
  const d = V.detail, v = d.versions[0];
  const ver = (x) => `<tr><td>L${x.level}</td><td>${x.decision === 'approved' ? '✓ approved' : '✗ rejected'}</td><td>${esc(x.reviewer)}</td><td class="muted">${esc((x.created_at || '').slice(0, 16).replace('T', ' '))}</td><td>${esc(x.note)}</td></tr>`;
  const required = v.required_fields.map((f) => `${v.missing_fields.includes(f) ? '✗' : '✓'} ${esc(f)}`).join(' · ');
  $('#main').innerHTML = `
    <div class="card"><h3>${esc(d.rule_id)} ${chip(v.internal ? 'internal' : ['draft', 'text_checked', 'reviewed'][v.level])}</h3>
      <div class="muted">${esc(d.instrument)} · version ${v.version} by ${esc(v.author)} (${esc(v.origin === 'catalog_import' ? 'imported from the catalog' : 'edited')}) · ${esc(v.change_reason)}</div>
      <p style="margin:6px 0">${esc(LEVEL_LABEL[v.internal ? 'internal' : ['draft', 'text_checked', 'reviewed'][v.level]])}.</p>
      ${v.internal ? '<p class="muted">A data-quality check of Complee itself: there is no official text to verify it against.</p>'
        : `<div class="muted">Fields that need a quote: ${required || '–'}</div>`}
      ${v.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('')}
      <h2>Evidence of version ${v.version}</h2>
      ${v.evidence.length ? v.evidence.map((e) => `<div class="ev ok"><b>${esc(e.field)}</b> · ${esc(e.source)}${e.page ? `, page ${e.page}` : ''}<br>“${esc(e.quote)}”</div>`).join('') : '<p class="muted">No quotes yet: this version is a paraphrase.</p>'}
      ${v.verifications.length ? `<h2>Decisions on version ${v.version}</h2><table class="hist">${v.verifications.map(ver).join('')}</table>` : ''}
      ${d.versions.length > 1 ? `<details><summary class="muted">Earlier versions (${d.versions.length - 1})</summary>${d.versions.slice(1).map((o) => `<div class="ev"><b>v${o.version}</b> by ${esc(o.author)}: ${esc(o.change_reason)} · ${o.evidence.length} quotes · ${o.verifications.length} decisions</div>`).join('')}</details>` : ''}
    </div>
    ${v.internal ? '' : decisionCard(v)}
    ${editCard(v)}`;
  wireRule();
}

function decisionCard(v) {
  const canL1 = !v.missing_fields.length;
  const l1ok = v.level >= 1;
  return `<div class="card"><h3>Decide on version ${v.version}</h3>
    <div class="row"><select id="decLevel"><option value="1">Level 1: text check (fields match the quoted official text)</option><option value="2" ${l1ok ? '' : 'disabled'}>Level 2: engineering review (other person than author and text checker)</option></select>
      <select id="decDecision"><option value="approved">approve</option><option value="rejected">reject</option></select></div>
    <textarea id="decNote" class="quote" placeholder="Note (required when rejecting; for level 2: interpretations, exceptions and measuring method checked)"></textarea>
    ${canL1 ? '' : `<div class="warn">Level 1 can be approved once every required field has a quote: ${esc(v.missing_fields.join(', '))}.</div>`}
    <div class="row"><button class="primary" id="decSave">Record decision</button><span id="decMsg"></span></div></div>`;
}

function editCard() {
  const dr = V.draft;
  let errors = [];
  try {
    const logic = JSON.parse(dr.logic);
    errors = validateRule(logic);
    if (logic.id !== V.selected) errors.push(`"id" must stay ${V.selected}`);
    errors.push(...validateRelations([...V.catalog.filter((r) => r.id !== V.selected), logic]).filter((m) => m.includes(V.selected)));
  } catch (e) { errors = [`Not valid JSON: ${e.message}`]; }
  const srcOpts = (sel) => V.sources.map((s) => `<option value="${esc(s.id)}" ${s.id === sel ? 'selected' : ''}>${esc(s.instrument)}, ${esc(s.edition)}</option>`).join('');
  const evRow = (e, i) => `<div class="ev ${e.check ? (e.check.found ? 'ok' : 'bad') : ''}" data-i="${i}">
      <div class="row"><select class="evField">${FIELDS.map((f) => `<option ${f === e.field ? 'selected' : ''}>${f}</option>`).join('')}</select>
        <select class="evSource">${srcOpts(e.source_id)}</select><button class="tiny evCheck">Check quote</button><button class="tiny evDel">remove</button></div>
      <textarea class="quote evQuote" placeholder="Verbatim quote from the source (at least 12 characters)">${esc(e.quote)}</textarea>
      ${e.check ? (e.check.found ? `<div class="okline">✓ Found${e.check.page ? ` on page ${e.check.page}` : ''}</div>` : `<div class="errs">✗ ${esc(e.check.reason || 'Not found in this source.')}</div>`) : ''}
    </div>`;
  const p = V.proposal;
  return `<div class="card"><h3>Change → new version</h3>
    <p class="muted">Edit the rule logic and its quotes, then save as a new version. A new version starts as a draft.</p>
    <textarea id="logic" class="logic" spellcheck="false">${esc(dr.logic)}</textarea>
    ${errors.length ? `<div class="errs">${errors.map(esc).join('<br>')}</div>` : '<div class="okline">✓ Rule logic is valid</div>'}
    <h2>Quotes</h2>
    ${V.sources.length ? '' : '<p class="warn">No source documents yet: add the official text under <b>Sources</b> first.</p>'}
    <div id="evList">${dr.evidence.map(evRow).join('')}</div>
    <div class="row"><button class="tiny" id="evAdd" ${V.sources.length ? '' : 'disabled'}>+ quote</button></div>
    <h2>✦ Propose from source (AI)</h2>
    <div class="row"><select id="propSource">${srcOpts(dr.evidence[0]?.source_id)}</select><input id="propHint" placeholder="Hint, e.g. clause 13.3.1 or 'corridor width'"><button class="ai-btn tiny" id="propBtn" ${V.sources.length ? '' : 'disabled'}>✦ Propose</button></div>
    <div id="propOut">${p ? proposalHTML(p) : ''}</div>
    <h2>Save</h2>
    <div class="row"><input id="reason" placeholder="Reason for the change (required)" value="${esc(dr.reason)}"><button class="primary" id="saveVer" ${errors.length ? 'disabled' : ''}>Save new version</button></div>
    <div id="saveMsg"></div></div>`;
}

function proposalHTML(p) {
  if (p.loading) return '<div class="ai-wait"><span class="spin"></span>Asking the AI… it reads the matching passage of the source.</div>';
  if (p.error) return `<div class="errs">${esc(p.error)}</div>`;
  return `<div class="ai-box"><div class="ai-tag">✦ AI proposal · every quote checked against the source</div>
    ${p.fields.map((f, i) => `<div class="prop"><b>${esc(f.field)}</b>: ${esc(f.proposed)} ${f.found ? `<span class="okline">✓ quote found${f.page ? `, page ${f.page}` : ''}</span>` : '<span class="errs">✗ quote not in the source: not usable</span>'}<br>“${esc(f.quote)}”
      ${f.found ? `<br><button class="tiny propUse" data-i="${i}">Use as quote</button>` : ''}</div>`).join('') || '<p class="muted">The AI found nothing in this passage. Give a hint (clause number) and try again.</p>'}
    ${p.differences?.length ? `<div class="ai-h">Differences to the rule</div><ul>${p.differences.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${p.notes?.length ? `<div class="ai-h">Check</div><ul>${p.notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    <div class="ai-foot">✦ ${esc(p.model)} · ${(p.duration_ms / 1000).toFixed(1)} s${p.cost_usd != null ? ` · ${(p.cost_usd * 100).toFixed(1)} ct` : ''}. The AI proposes; you decide.</div></div>`;
}

function syncDraft() {
  const dr = V.draft;
  if ($('#logic')) dr.logic = $('#logic').value;
  if ($('#reason')) dr.reason = $('#reason').value;
  document.querySelectorAll('#evList .ev').forEach((n) => {
    const e = dr.evidence[Number(n.dataset.i)];
    const q = n.querySelector('.evQuote').value, f = n.querySelector('.evField').value, s = n.querySelector('.evSource').value;
    if (e.quote !== q || e.source_id !== s) e.check = null;
    Object.assign(e, { quote: q, field: f, source_id: s });
  });
}

function wireRule() {
  const v = V.detail.versions[0];
  if ($('#decSave')) $('#decSave').onclick = async () => {
    if (!needName()) return;
    try {
      await api(`versions/${v.id}/verifications`, { level: Number($('#decLevel').value), reviewer: me(), decision: $('#decDecision').value, note: $('#decNote').value });
      await reload();
    } catch (e) { $('#decMsg').innerHTML = `<span class="errs">${esc(e.message)}</span>`; }
  };
  $('#logic').onchange = () => { syncDraft(); renderRule(); };
  document.querySelectorAll('#evList .ev').forEach((n) => {
    const i = Number(n.dataset.i);
    n.querySelector('.evDel').onclick = () => { syncDraft(); V.draft.evidence.splice(i, 1); renderRule(); };
    n.querySelector('.evCheck').onclick = async () => {
      syncDraft();
      const e = V.draft.evidence[i];
      try { e.check = await api('quote-check', { source_id: e.source_id, quote: e.quote }); } catch (err) { e.check = { found: false, reason: err.message }; }
      if (e.check.found) e.quote = e.check.text; // keep the exact wording of the source
      renderRule();
    };
    n.querySelectorAll('select, textarea').forEach((x) => (x.onchange = syncDraft));
  });
  $('#evAdd').onclick = () => { syncDraft(); V.draft.evidence.push({ field: 'requirement', source_id: V.sources[0]?.id, quote: '', check: null }); renderRule(); };
  $('#propBtn').onclick = async () => {
    syncDraft();
    const sourceId = $('#propSource').value, hint = $('#propHint').value;
    V.proposal = { loading: true };
    $('#propOut').innerHTML = proposalHTML(V.proposal);
    try { V.proposal = await api(`rules/${encodeURIComponent(V.selected)}/propose`, { source_id: sourceId, hint }); } catch (e) { V.proposal = { error: e.message }; }
    renderRule();
  };
  document.querySelectorAll('.propUse').forEach((b) => (b.onclick = () => {
    syncDraft();
    const f = V.proposal.fields[Number(b.dataset.i)];
    const field = FIELDS.includes(f.field) ? f.field : 'requirement';
    V.draft.evidence = V.draft.evidence.filter((e) => !(e.field === field && !e.quote.trim()));
    V.draft.evidence.push({ field, source_id: V.proposal.source_id, quote: f.quote, check: { found: true, page: f.page } });
    renderRule();
  }));
  $('#saveVer').onclick = async () => {
    if (!needName()) return;
    syncDraft();
    let logic;
    try { logic = JSON.parse(V.draft.logic); } catch (e) { $('#saveMsg').innerHTML = `<div class="errs">${esc(e.message)}</div>`; return; }
    try {
      const out = await api(`rules/${encodeURIComponent(V.selected)}/versions`, {
        logic, author: me(), change_reason: V.draft.reason,
        evidence: V.draft.evidence.filter((e) => e.quote.trim()).map((e) => ({ field: e.field, source_id: e.source_id, quote: e.quote })),
      });
      V.msg = `Saved as version ${out.version}.`;
      await reload();
    } catch (e) { $('#saveMsg').innerHTML = `<div class="errs">${esc(e.message)}</div>`; }
  };
}

async function reload() {
  const st = await api('status');
  V.status = st.rules ?? {};
  renderCounts();
  await openRule(V.selected);
}

// ---------- sources ----------

function renderSources() {
  V.view = 'sources';
  V.selected = null;
  renderList();
  $('#main').innerHTML = `<div class="card"><h3>Official sources (${V.sources.length})</h3>
    ${V.sources.length ? `<table class="hist">${V.sources.map((s) => `<tr><td><b>${esc(s.instrument)}</b></td><td>${esc(s.edition)}</td><td>${esc(LICENCE[s.licence] ?? s.licence)}</td><td class="muted">${esc(s.filename)} · ${s.pages} page${s.pages === 1 ? '' : 's'} · SHA-256 ${esc(s.file_sha256.slice(0, 12))}… · added by ${esc(s.acquired_by)}</td></tr>`).join('')}</table>` : '<p class="muted">No sources yet.</p>'}
    <p class="muted">A source is stored once (by its SHA-256) and never changed. Licensed texts stay in this database for internal checking; customers see the paraphrase, the clause and the source name, not the text.</p></div>
    <div class="card"><h3>Add an official source</h3>
      <div class="row"><input id="sInstr" placeholder="Instrument, e.g. SOLAS Chapter II-2"><input id="sEd" placeholder="Edition, e.g. Consolidated edition 2024"></div>
      <div class="row"><input id="sPub" placeholder="Published (YYYY-MM-DD)"><input id="sEff" placeholder="In force from (YYYY-MM-DD)"><input id="sPubl" placeholder="Publisher, e.g. IMO"></div>
      <div class="row"><select id="sLic"><option value="public">Public (e.g. class rules, IACS)</option><option value="licensed_internal">Licensed, internal use only (e.g. IMO publication)</option><option value="paraphrase_only">Paraphrase only</option></select>
        <input id="sFile" type="file" accept=".pdf,.docx,.txt"></div>
      <div class="row"><button class="primary" id="sAdd">Add source</button><span id="sMsg"></span></div></div>`;
  $('#sAdd').onclick = async () => {
    if (!needName()) return;
    const f = $('#sFile').files[0];
    if (!f) { $('#sMsg').innerHTML = '<span class="errs">Choose the file.</span>'; return; }
    $('#sMsg').innerHTML = '<span class="muted">Reading and storing…</span>';
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try {
      const out = await api('sources', { filename: f.name, content_base64: btoa(bin), instrument: $('#sInstr').value, edition: $('#sEd').value,
        published: $('#sPub').value, effective: $('#sEff').value, publisher: $('#sPubl').value, licence: $('#sLic').value, actor: me() });
      V.sources = (await api('sources')).sources;
      renderSources();
      $('#sMsg').innerHTML = `<span class="okline">${out.created ? 'Added' : 'Already stored (same file)'}: ${esc(out.source.instrument)}, ${esc(out.source.edition)}.</span>`;
    } catch (e) { $('#sMsg').innerHTML = `<span class="errs">${esc(e.message)}</span>`; }
  };
}

$('#sourcesBtn').onclick = renderSources;
$('#importBtn').onclick = async () => {
  if (!needName()) return;
  if (!V.catalog.length) { alert('The rule catalog is not loaded yet.'); return; }
  try {
    const out = await api('import', { rules: V.catalog, actor: me() });
    alert(`Imported ${out.created.length} rule${out.created.length === 1 ? '' : 's'} as draft version 1.${out.unchanged.length ? ` ${out.unchanged.length} already in the database.` : ''}${out.differs.length ? `\n\nDifferent from the database (not changed): ${out.differs.join(', ')}. Save a new version on the rule if the catalog is right.` : ''}`);
    await loadAll();
  } catch (e) { alert(e.message); }
};
$('#catalogBtn').onclick = async () => {
  try {
    const out = await api('catalog');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ note: 'Exported from the rule verification database: latest version of every rule.', rules: out.rules }, null, 2)], { type: 'application/json' }));
    a.download = 'rules.json';
    a.click();
  } catch (e) { alert(e.message); }
};

loadAll();
