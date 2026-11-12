// Findings register: the engineer's disposition of each finding (who handles it, how, and why).
// Pure functions over the checker results and a plain store object. A disposition never changes a rule
// result: the status column always comes from the deterministic checker.
//
// store: { "<element>|<rule>": { disposition, responsible, note, updated, measured, status } }
import { findingsOf } from './checker.mjs';

export const DISPOSITIONS = [
  { id: 'open', label: 'Open' },
  { id: 'fix', label: 'Design change planned' },
  { id: 'deviation', label: 'Deviation / equivalence requested' },
  { id: 'accepted', label: 'Accepted by class / flag' },
  { id: 'not_applicable', label: 'Not applicable (justified)' },
];
export const DISPOSITION_LABEL = Object.fromEntries(DISPOSITIONS.map((d) => [d.id, d.label]));
// Closing a finding without changing the design needs a written reason.
export const needsNote = (disposition) => ['deviation', 'accepted', 'not_applicable'].includes(disposition);
export const findingKey = (f) => `${f.element}|${f.rule_id ?? f.rule}`;

/**
 * The project a model belongs to: every revision of the same design shares one findings register.
 * An explicit project_id wins; otherwise the ship's name; otherwise the model name without revision markers
 * ("Tower rev B", "tower_v3", "Tower (revision 2)" -> "tower").
 */
export function projectKey(model) {
  const id = model?.project_id ?? model?.project?.id;
  if (id != null && String(id).trim()) return `project:${String(id).trim()}`;
  const ship = model?.ship?.name;
  const shipName = typeof ship === 'object' ? ship?.value : ship;
  if (shipName && String(shipName).trim()) return `ship:${String(shipName).trim().toLowerCase()}`;
  const name = String(model?.name ?? 'model')
    .replace(/\.(json|ifc|rvt)$/i, '')
    .replace(/(?:[\s_-]+|[\s_-]*[([])(?:rev(?:ision)?|version|v)[\s._-]*[a-z0-9]{1,3}[)\]]?\s*$/i, '')
    .replace(/[\s_-]+\(?(precomputed|edited|copy)[^)]*\)?$/i, '')
    .trim().toLowerCase();
  return `model:${name || 'model'}`;
}
const measuredText = (f) => String(f.measured ?? 'missing');

/** One row per current finding, plus the stored dispositions whose finding no longer exists (resolved). */
export function registerRows(results, store = {}) {
  const rows = [];
  const seen = new Set();
  for (const f of findingsOf(results)) {
    const key = findingKey(f);
    seen.add(key);
    const d = store[key];
    const disposition = DISPOSITION_LABEL[d?.disposition] ? d.disposition : 'open';
    rows.push({
      revision: d?.revision ?? '',
      key, element: f.element, name: f.name, deck: f.deck, rule_id: f.rule_id, status: f.status,
      measured: measuredText(f), required: f.required,
      disposition, responsible: d?.responsible ?? '', note: d?.note ?? '', updated: d?.updated ?? '',
      // The design value or the result changed after the disposition was written: it must be looked at again.
      stale: !!d && disposition !== 'open' && (d.measured !== measuredText(f) || d.status !== f.status),
      missing_note: needsNote(disposition) && !String(d?.note ?? '').trim(),
      resolved: false,
    });
  }
  for (const [key, d] of Object.entries(store)) {
    if (seen.has(key)) continue;
    const [element, rule_id] = key.split('|');
    rows.push({
      key, element, name: d.name ?? '', deck: d.deck ?? '', rule_id, status: 'compliant',
      measured: d.measured ?? '', required: d.required ?? '',
      disposition: DISPOSITION_LABEL[d.disposition] ? d.disposition : 'open', responsible: d.responsible ?? '', note: d.note ?? '', updated: d.updated ?? '',
      revision: d.revision ?? '', stale: false, missing_note: false, resolved: true,
    });
  }
  return rows;
}

export function registerSummary(rows) {
  const current = rows.filter((r) => !r.resolved);
  return {
    total: current.length,
    open: current.filter((r) => r.disposition === 'open').length,
    stale: current.filter((r) => r.stale).length,
    missing_note: current.filter((r) => r.missing_note).length,
    resolved: rows.length - current.length,
  };
}

/** Returns a new store with the finding's disposition updated. An untouched open entry is not stored. */
// patch may carry revision: the model revision the disposition was written for (kept for the audit trail).
export function withDisposition(store, finding, patch, now = new Date()) {
  const key = findingKey(finding);
  const next = { ...store };
  const entry = { disposition: 'open', responsible: '', note: '', ...store[key], ...patch };
  if (entry.disposition === 'open' && !entry.responsible.trim() && !entry.note.trim()) { delete next[key]; return next; }
  next[key] = {
    ...entry, updated: now.toISOString(), measured: measuredText(finding), status: finding.status,
    name: finding.name, deck: finding.deck, required: finding.required,
  };
  return next;
}

const STATUS_LABEL = { non_compliant: 'Non-compliant', not_enough_info: 'Not enough info', compliant: 'Resolved (no finding now)' };

export function registerCSV(rows) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['status', 'element', 'name', 'deck', 'rule', 'measured', 'required', 'disposition', 'responsible', 'note', 'updated', 'revision', 'review_again'];
  const lines = rows.map((r) => [STATUS_LABEL[r.status], r.element, r.name, r.deck, r.rule_id, r.measured, r.required,
    DISPOSITION_LABEL[r.disposition], r.responsible, r.note, r.updated, r.revision, r.stale ? 'yes: value changed since the disposition' : ''].map(q).join(','));
  return '﻿' + [head.join(','), ...lines].join('\r\n');
}
