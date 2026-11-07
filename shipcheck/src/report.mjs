// Findings report (HTML, printable to PDF) and CSV. Pure functions: used by the browser (Report / CSV
// buttons) and by the CLI (node check.mjs --report <scenario>), so both give the same output.
import { findingsOf, normalizeModel } from './checker.mjs';
import { scoreLine } from './score.mjs';

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
export function reportRows(results, model, rules = []) {
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
    };
  });
}

export function toCSV(rows) {
  const cols = Object.keys(rows[0] || { status: '' });
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return '﻿' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n');
}

export function toHTML({ title, scenario, results, model, rules = [], score = null, edits = [], generated = new Date() }) {
  const rows = reportRows(results, model, rules);
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
th{background:#f3f5f8}.nc{color:#b42318;font-weight:600}.ni{color:#9a6700;font-weight:600}.muted{color:#5b6573}
.badge{display:inline-block;padding:3px 10px;border-radius:12px;font-weight:600;margin:8px 0}.ok{background:#e3f4ea;color:#1d6b3d}.bad{background:#fde8e8;color:#9b2c2c}
@media print{button{display:none}}</style></head><body>
<button onclick="print()">Print / save as PDF</button>
<h1>Compliance findings: ${esc(title)}</h1>
<div class="muted">Scenario ${esc(scenario)} · generated ${esc(generated.toLocaleString('en-GB'))} by ShipCheck. Pass/fail is decided by the deterministic checker only (no AI).</div>
${score ? `<div class="badge ${pass ? 'ok' : 'bad'}">${pass ? '✓' : '✗'} Accuracy: ${esc(badgeText(score))}</div><div class="muted">${esc(scoreLine(score))} (ground truth of the unedited design, same as npm test)</div>` : ''}
<p>Result: <b>${s.non_compliant}</b> non-compliant, <b>${s.not_enough_info}</b> not enough info, <b>${s.compliant}</b> compliant rule checks.
${usedRules.length} rules applied, ${verified}/${rules.length} rule values verified against official text: every "no" must be checked before submission (VERIFY.md).</p>
${edits.length ? `<p><b>${edits.length} value(s) edited in this session:</b> ${edits.map((x) => `${esc(x.id)}.${esc(x.key)} ${esc(x.before)} → ${esc(x.after)}`).join('; ')}</p>` : ''}
${drafts.length ? `<p><b>Draft rules, not run (no official value):</b> ${drafts.map((d) => `${esc(d.id)}: ${esc(d.reason)}`).join(' ')}</p>` : ''}
<h2>Findings (${rows.length})</h2>
<table><tr><th>Status</th><th>Element</th><th>Group / deck</th><th>Rule</th><th>Source / clause</th><th>Measured</th><th>Required</th><th>Explanation</th><th>Input provenance (model text = mm)</th><th>Basis</th><th>Verified</th></tr>
${rows.map((r) => `<tr><td class="${r.status === 'Non-compliant' ? 'nc' : 'ni'}">${esc(r.status)}</td><td><b>${esc(r.element)}</b>${r.objectid !== '' ? `<br><span class="muted">dbId ${esc(r.objectid)}</span>` : ''}<br>${esc(r.name)}</td>
<td>${esc(r.group)}</td><td>${esc(r.rule)}</td><td>${esc(r.source)}<br><span class="muted">${esc(r.clause)}</span></td><td>${esc(r.measured)}</td><td>${esc(r.required)}</td>
<td>${esc(r.explanation)}</td><td class="muted">${esc(r.provenance)}</td><td>${esc(r.basis)}</td><td>${r.verified}</td></tr>`).join('\n')}
</table>
<h2>Rules applied</h2>
<table><tr><th>Rule</th><th>Source</th><th>Clause</th><th>Text (${'verbatim or paraphrase'})</th><th>Basis</th><th>Verified</th></tr>
${usedRules.map((r) => `<tr><td>${esc(r.id)}</td><td>${esc(r.source)}</td><td>${esc(r.clause)}</td><td>“${esc(r.text)}” <span class="muted">(${esc(r.text_status || 'paraphrase')})</span></td><td>${esc(r.basis || 'explicit')}${r.basis_note ? `<br><span class="muted">${esc(r.basis_note)}</span>` : ''}</td><td>${r.verified ? 'yes' : 'no'}</td></tr>`).join('\n')}
</table>
<p class="muted">Values with source "estimated", "planted test case" or "derived by ShipCheck" are not design data. Inch values are shown as written in the model with their mm conversion (1 in = 25.4 mm).</p>
</body></html>`;
}
