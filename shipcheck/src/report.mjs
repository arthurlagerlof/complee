// Findings report (HTML, printable to PDF) and CSV. Pure functions: used by the browser (Report / CSV
// buttons) and by the CLI (node check.mjs --report <scenario>), so both give the same output.
import { findingsOf, normalizeModel } from './checker.mjs';
import { scoreLine } from './score.mjs';
import { traceMatrix, cellLabel } from './trace.mjs';
import { DISPOSITION_LABEL } from './dispositions.mjs';

const LABEL = { compliant: 'Compliant', non_compliant: 'Non-compliant', not_enough_info: 'Not enough info' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function badgeText(score) {
  if (!score) return 'No ground truth for this scenario';
  if (score.bulk?.length) {
    return `${score.detected}/${score.expected} hand-checked findings + ${score.bulk.length - score.bulk_failed.length}/${score.bulk.length} counts, ${score.false_alarms.length} false alarm${score.false_alarms.length === 1 ? '' : 's'}`;
  }
  return `${score.detected}/${score.expected} expected findings, ${score.false_alarms.length} false alarm${score.false_alarms.length === 1 ? '' : 's'}`;
}

// One row per finding (non-compliant and not enough info), worst first.
export function reportRows(results, model, rules = [], { register = null } = {}) {
  const norm = model ? normalizeModel(model) : null;
  const els = new Map((norm?.elements || []).map((e) => [e.id, e]));
  const deckName = (id) => norm?.decks?.find((d) => d.id === id)?.name ?? id ?? '';
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  return findingsOf(results).map((f) => {
    const el = els.get(f.element);
    return {
      status: LABEL[f.status], element: f.element, objectid: el?.objectid ?? f.objectid ?? '', name: f.name, group: deckName(f.deck),
      rule: f.rule_id, source: f.source, clause: f.clause, measured: f.measured ?? 'missing', required: f.required,
      explanation: f.explanation,
      provenance: (f.inputs || []).map((i) => `${i.name}=${i.value} [${i.source}]`).join('; '),
      basis: f.basis ?? ruleById.get(f.rule_id)?.basis ?? 'explicit',
      text: f.text_status ?? ruleById.get(f.rule_id)?.text_status ?? 'paraphrase',
      verified: f.verified ? 'yes' : 'no',
      review: f.review_status ?? ruleById.get(f.rule_id)?.review_status ?? '',
      same_requirement_as: (f.same_requirement_as || []).join(' '),
      // Engineer's disposition (findings register); only present when a register is passed.
      ...(register ? (() => {
        const d = register[`${f.element}|${f.rule_id}`];
        return { disposition: DISPOSITION_LABEL[d?.disposition] ?? DISPOSITION_LABEL.open, responsible: d?.responsible ?? '', note: d?.note ?? '' };
      })() : {}),
    };
  });
}

// Traceability (parts x rules) from the same function as the UI panel. Large models: parts with findings only.
export function traceSection(results, rules) {
  const all = traceMatrix(results, rules);
  const m = all.rows.length > 500 ? traceMatrix(results, rules, { findingsOnly: true }) : all;
  const cls = { compliant: 'ok', non_compliant: 'nc', not_enough_info: 'ni' };
  return `<h2>Traceability: parts × rules (${m.rows.length.toLocaleString('en')} of ${all.total.toLocaleString('en')} parts${m === all ? '' : ', parts with findings'})</h2>
<table><tr><th>Part</th>${m.rules.map((r) => `<th>${esc(r.id)}</th>`).join('')}</tr>
${m.rows.map((r) => `<tr><td><b>${esc(r.id)}</b> ${esc(r.name)}</td>${m.rules.map((c) => `<td class="${cls[r.cells[c.id]] ?? ''}">${esc(cellLabel(r.cells[c.id]))}</td>`).join('')}</tr>`).join(String.fromCharCode(10))}
</table>`;
}

export function toCSV(rows) {
  const cols = Object.keys(rows[0] || { status: '' });
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n');
}

// Changes against an earlier revision (src/compare.mjs): { name, diff }.
export function comparisonSection(comparison) {
  if (!comparison?.diff) return '';
  const { findings: f, elements: e } = comparison.diff;
  const row = (x, extra = '') => `<tr><td><b>${esc(x.element)}</b> ${esc(x.name)}</td><td>${esc(x.rule_id)}</td><td>${esc(LABEL[x.status] ?? x.status)}</td><td>${esc(x.measured)}</td><td>${esc(x.required)}</td><td>${extra}</td></tr>`;
  const table = (title, cls, rows) => (rows.length ? `<h3 class="${cls}">${title} (${rows.length})</h3><table><tr><th>Element</th><th>Rule</th><th>Status</th><th>Measured</th><th>Required</th><th>Earlier revision</th></tr>${rows.join('')}</table>` : '');
  return `<h2>Changes since the earlier revision: ${esc(comparison.name)}</h2>
<p><b>${f.new.length}</b> new finding${f.new.length === 1 ? '' : 's'}, <b>${f.resolved.length}</b> resolved, <b>${f.changed.length}</b> changed, ${f.unchanged} unchanged.
Model: ${e.added.length} element${e.added.length === 1 ? '' : 's'} added, ${e.removed.length} removed, ${e.changed.length} with changed values.</p>
${table('New findings', 'nc', f.new.map((x) => row(x, 'no finding')))}
${table('Changed findings', 'ni', f.changed.map((x) => row(x, `${esc(LABEL[x.before_status] ?? x.before_status)}, ${esc(x.before_measured)}`)))}
${table('Resolved findings', 'ok', f.resolved.map((x) => row({ ...x, status: 'resolved' }, `${esc(LABEL[x.status] ?? x.status)}, ${esc(x.measured)}`)))}
${e.changed.length ? `<h3>Changed design values (${e.changed.length} elements)</h3><table><tr><th>Element</th><th>Field</th><th>Earlier</th><th>Now</th></tr>${e.changed.flatMap((c) => c.changes.map((ch) => `<tr><td><b>${esc(c.id)}</b> ${esc(c.name)}</td><td>${esc(ch.field)}</td><td>${esc(ch.before)}</td><td>${esc(ch.after)}</td></tr>`)).join('')}</table>` : ''}
${e.added.length ? `<p>Added: ${e.added.map((x) => esc(x.id)).join(', ')}.</p>` : ''}${e.removed.length ? `<p>Removed: ${e.removed.map((x) => esc(x.id)).join(', ')}.</p>` : ''}`;
}

// Rule hierarchy: conflicting limits and rules replaced by a higher-ranking one (with the stated basis).
export function hierarchySection(results) {
  const els = Object.values(results.elements || {});
  const conflicts = els.flatMap((e) => (e.conflicts || []).map((c) => ({ e, c })));
  const sup = els.flatMap((e) => (e.superseded || []).map((x) => ({ e, x })));
  if (!conflicts.length && !sup.length) return '';
  return `<h2>Rule hierarchy</h2>
${conflicts.length ? `<h3 class="nc">Rule conflicts (${conflicts.length}): no design can meet both limits, clarify with flag state or class</h3>
<table><tr><th>Element</th><th>Parameter</th><th>Lower limit</th><th>Upper limit</th></tr>
${conflicts.map(({ e, c }) => `<tr><td><b>${esc(e.id)}</b> ${esc(e.name)}</td><td>${esc(c.parameter)}</td><td>${esc(c.lower.required)} (${esc(c.lower.rule_id)})</td><td>${esc(c.upper.required)} (${esc(c.upper.rule_id)})</td></tr>`).join('')}</table>` : ''}
${sup.length ? `<h3>Replaced by a higher-ranking rule (${sup.length}): not counted as findings</h3>
<table><tr><th>Element</th><th>Rule</th><th>Replaced by</th><th>Basis</th><th>Result it would have had</th></tr>
${sup.map(({ e, x }) => `<tr><td><b>${esc(e.id)}</b> ${esc(e.name)}</td><td>${esc(x.rule_id)}</td><td>${esc(x.by)} (${x.type === 'exempts' ? 'exemption' : 'replaces'})</td><td>${esc(x.basis)}</td><td>${esc(LABEL[x.status] ?? x.status)}, required ${esc(x.required)}</td></tr>`).join('')}</table>` : ''}`;
}

// Escape-route analysis (src/escape.mjs) as a report section: one row per room.
export function escapeSection(escape, model) {
  if (!escape?.available) return '';
  const norm = normalizeModel(model);
  const els = new Map(norm.elements.map((e) => [e.id, e]));
  const label = { two_routes: 'Two independent routes', single_route: 'Single route only', no_route: 'No route', direct: 'Direct access' };
  const cls = { two_routes: 'ok', direct: 'ok', single_route: 'ni', no_route: 'nc' };
  const order = { no_route: 0, single_route: 1, two_routes: 2, direct: 3 };
  const rooms = Object.values(escape.origins).filter((o) => o.room).sort((a, b) => order[a.status] - order[b.status] || (b.primary?.length_mm ?? 0) - (a.primary?.length_mm ?? 0));
  const m = (r) => (r ? `${(r.length_mm / 1000).toFixed(1)} m` : '');
  const s = escape.summary;
  return `<h2>Escape routes (${rooms.length} rooms)</h2>
<p>${s.two_routes + s.direct} rooms with two independent routes, <b>${s.single_route}</b> with a single route, <b>${s.no_route}</b> without a route to ${escape.musters.map((id) => esc(els.get(id)?.name ?? id)).join(', ')}.
${escape.blocked.length ? `<b>What-if: ${escape.blocked.map(esc).join(', ')} blocked.</b>` : ''}
${escape.disconnected.length ? `Not connected: ${escape.disconnected.map((d) => `${esc(d.id)} (${esc(d.reason)})`).join('; ')}.` : ''}</p>
<table><tr><th>Room</th><th>Deck</th><th>Result</th><th>Shortest route</th><th>Length</th><th>Narrowest stated clear width</th><th>Independent alternative</th><th>Length</th></tr>
${rooms.map((o) => `<tr><td><b>${esc(o.id)}</b> ${esc(els.get(o.id)?.name ?? '')}</td><td>${esc(els.get(o.id)?.deck ?? '')}</td><td class="${cls[o.status]}">${label[o.status]}</td>
<td class="muted">${esc(o.primary?.via.join(' > ') ?? '')}</td><td>${m(o.primary)}</td><td>${o.primary?.narrowest ? `${o.primary.narrowest.width_mm} mm at ${esc(o.primary.narrowest.id)}` : ''}</td>
<td class="muted">${esc(o.secondary?.via.join(' > ') ?? '')}</td><td>${m(o.secondary)}</td></tr>`).join('\n')}
</table>
<p class="muted">Route analysis from the model geometry, not a rule result. ${escape.assumptions.map(esc).join(' ')}</p>`;
}

export function toHTML({ title, scenario, results, model, rules = [], score = null, edits = [], generated = new Date(), register = null, escape = null, comparison = null }) {
  const rows = reportRows(results, model, rules, { register });
  const openCount = register ? rows.filter((r) => r.disposition === DISPOSITION_LABEL.open).length : 0;
  const s = results.summary;
  const verified = rules.filter((r) => r.verified).length;
  const applied = new Set(rows.map((r) => r.rule));
  for (const e of Object.values(results.elements || {})) for (const r of e.results || []) applied.add(r.rule_id);
  const usedRules = rules.filter((r) => applied.has(r.id));
  const types = new Set((model ? normalizeModel(model).elements : []).map((e) => e.type));
  const drafts = (results.draft_rules || []).filter((d) => (rules.find((r) => r.id === d.id)?.applies_to?.types || []).some((t) => types.has(t)));
  const pass = score?.pass;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Compliance findings - ${esc(title)}</title>
<style>body{font:12px/1.4 system-ui,sans-serif;margin:24px;color:#1d2430}h1{font-size:18px;margin:0}h2{font-size:14px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%;margin-top:8px}th,td{border:1px solid #d5dae0;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#f3f5f8}.nc{color:#b42318;font-weight:600}.ok{color:#1d6b3d}.ni{color:#9a6700;font-weight:600}.muted{color:#5b6573}
.badge{display:inline-block;padding:3px 10px;border-radius:12px;font-weight:600;margin:8px 0}.ok{background:#e3f4ea;color:#1d6b3d}.bad{background:#fde8e8;color:#9b2c2c}
@media print{button{display:none}}</style></head><body>
<button onclick="print()">Print / save as PDF</button>
<h1>Compliance findings: ${esc(title)}</h1>
<div class="muted">Scenario ${esc(scenario)} · generated ${esc(generated.toLocaleString('en-GB'))} by Complee. Pass/fail is decided by the deterministic checker only (no AI).</div>
${score ? `<div class="badge ${pass ? 'ok' : 'bad'}">${pass ? '✓' : '✗'} Accuracy: ${esc(badgeText(score))}</div><div class="muted">${esc(scoreLine(score))} (ground truth of the unedited design, same as npm test)</div>` : ''}
<p>Result: <b>${s.non_compliant}</b> non-compliant, <b>${s.not_enough_info}</b> not enough info, <b>${s.compliant}</b> compliant rule checks.
${usedRules.length} rules applied, ${verified}/${rules.length} rule values verified against official text: every "no" must be checked before submission (VERIFY.md).</p>
${edits.length ? `<p><b>${edits.length} value(s) edited in this session:</b> ${edits.map((x) => `${esc(x.id)}.${esc(x.key)} ${esc(x.before)} → ${esc(x.after)}`).join('; ')}</p>` : ''}
${drafts.length ? `<p><b>Draft rules, not run (no official value):</b> ${drafts.map((d) => `${esc(d.id)}: ${esc(d.reason)}`).join(' ')}</p>` : ''}
<h2>Findings (${rows.length})</h2>
${register ? `<p>Findings register: <b>${openCount}</b> of ${rows.length} findings open, ${rows.length - openCount} with a disposition. A disposition records how a finding is handled; it never changes the checker status.</p>` : ''}
<table><tr><th>Status</th><th>Element</th><th>Group / deck</th><th>Rule</th><th>Source / clause</th><th>Measured</th><th>Required</th><th>Explanation</th><th>Input provenance (model text = mm)</th><th>Basis</th><th>Verified</th><th>Review</th>${register ? '<th>Disposition</th><th>Responsible</th><th>Justification / note</th>' : ''}</tr>
${rows.map((r) => `<tr><td class="${r.status === 'Non-compliant' ? 'nc' : 'ni'}">${esc(r.status)}</td><td><b>${esc(r.element)}</b>${r.objectid !== '' ? `<br><span class="muted">dbId ${esc(r.objectid)}</span>` : ''}<br>${esc(r.name)}</td>
<td>${esc(r.group)}</td><td>${esc(r.rule)}${r.same_requirement_as ? `<br><span class="muted">same requirement as ${esc(r.same_requirement_as)}</span>` : ''}</td><td>${esc(r.source)}<br><span class="muted">${esc(r.clause)}</span></td><td>${esc(r.measured)}</td><td>${esc(r.required)}</td>
<td>${esc(r.explanation)}</td><td class="muted">${esc(r.provenance)}</td><td>${esc(r.basis)}</td><td>${r.verified}</td><td>${esc(r.review)}</td>${register ? `<td>${esc(r.disposition)}</td><td>${esc(r.responsible)}</td><td>${esc(r.note)}</td>` : ''}</tr>`).join('\n')}
</table>
${hierarchySection(results)}
${comparisonSection(comparison)}
${escapeSection(escape, model)}
${traceSection(results, rules)}
<h2>Rules applied</h2>
<table><tr><th>Rule</th><th>Source</th><th>Clause</th><th>Text (${'verbatim or paraphrase'})</th><th>Basis</th><th>Verified</th><th>Review</th></tr>
${usedRules.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.source)}</td><td>${esc(r.clause)}</td><td>“${esc(r.text)}” <span class="muted">(${esc(r.text_status || 'paraphrase')})</span></td><td>${esc(r.basis || 'explicit')}${r.basis_note ? `<br><span class="muted">${esc(r.basis_note)}</span>` : ''}</td><td>${r.verified ? 'yes' : 'no'}</td><td>${esc(r.review_status || '')}</td></tr>`).join('\n')}
</table>
<p class="muted">Values with source "estimated", "planted test case" or "derived by Complee" are not design data. Inch values are shown as written in the model with their mm conversion (1 in = 25.4 mm).</p>
</body></html>`;
}
