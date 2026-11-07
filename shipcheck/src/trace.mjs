// Traceability matrix: parts x rules, one status per cell. Pure function, shared by the UI panel,
// the HTML report and the CSV export, so all three show the same data.
import { STATUS_RANK } from './checker.mjs';

const ORDER = { non_compliant: 0, not_enough_info: 1, compliant: 2 };

// results: checkModel output. rules: rule list (sets the column order).
// findingsOnly: keep only parts with at least one non-compliant / not-enough-info cell.
export function traceMatrix(results, rules = [], { findingsOnly = false } = {}) {
  const used = new Set();
  const rows = [];
  for (const e of Object.values(results.elements)) {
    if (!e.results.length) continue;
    const cells = {};
    for (const r of e.results) { cells[r.rule_id] = r.status; used.add(r.rule_id); }
    const worst = e.results.reduce((w, r) => ((STATUS_RANK[r.status] ?? 0) > (STATUS_RANK[w] ?? 0) ? r.status : w), null);
    if (findingsOnly && worst === 'compliant') continue;
    rows.push({ id: e.id, name: e.name, deck: e.deck, worst, cells });
  }
  rows.sort((a, b) => ORDER[a.worst] - ORDER[b.worst] || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }));
  const order = rules.map((r) => r.id);
  const cols = [...used].sort((a, b) => (order.indexOf(a) + 1 || 1e9) - (order.indexOf(b) + 1 || 1e9));
  const byId = Object.fromEntries(rules.map((r) => [r.id, r]));
  return {
    rules: cols.map((id) => ({ id, source: byId[id]?.source ?? '', review_status: byId[id]?.review_status ?? null })),
    rows,
    total: Object.values(results.elements).filter((e) => e.results.length).length,
  };
}

const LABEL = { compliant: 'pass', non_compliant: 'fail', not_enough_info: 'not enough info' };
export const cellLabel = (st) => (st ? LABEL[st] : '');

export function traceCSV(matrix) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['part', 'name', 'group', ...matrix.rules.map((r) => r.id)];
  const lines = matrix.rows.map((r) => [r.id, r.name, r.deck, ...matrix.rules.map((c) => cellLabel(r.cells[c.id]))].map(q).join(','));
  return '﻿' + [head.map(q).join(','), ...lines].join('\r\n');
}
