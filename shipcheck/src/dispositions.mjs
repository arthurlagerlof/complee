// Findings register: the engineer's disposition of each finding (who handles it, how, and why).
// Pure functions over the checker results and a plain store object. A disposition never changes a rule
// result: the status column always comes from the deterministic checker.
//
// store: { "<element>|<rule>": { disposition, responsible, note, updated, measured, status } }
// Manual checks share the store: { kind: 'manual', done, responsible, note, updated } under the same key form,
// and so do confirmed values from a drawing: { kind: 'input', ... } under "<element>|input:<prop>" (input-confirmations.mjs).
import { findingsOf, manualChecksOf } from './checker.mjs';
import { csvCell } from './csv.mjs';

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
// Element and rule of a stored key: rule ids never contain "|", element ids may ("MD|D1"), so split at the last one.
const splitKey = (key) => { const i = key.lastIndexOf('|'); return [key.slice(0, i), key.slice(i + 1)]; };

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
  // Revision markers: "rev B", "rev. 3", "revision 2", "version 4", "v3" / "_v12" (a v followed by a number only, so
  // "Project Vega" and "Stena Vita" keep their names). Every model file type the viewer opens is stripped.
  const name = String(model?.name ?? 'model')
    .replace(/\.(json|ifc|rvt|dxf|dwg)$/i, '')
    .replace(/[\s_-]+\(?(precomputed|edited|copy)[^)]*\)?$/i, '')
    // ("rev" needs a separator or a digit after it: "Deck review" is a name, "rev B", "rev.3", "rev3" are markers.)
    .replace(/(?:[\s_-]+|[\s_-]*[([])(?:(?:rev(?:ision)?|version)(?:\.?[\s._-]+[a-z0-9]{1,3}|\.?\d{1,3}[a-z]?)|v[\s._-]?\d{1,3}[a-z]?)[)\]]?\s*$/i, '')
    .trim().toLowerCase();
  return `model:${name || 'model'}`;
}
const measuredText = (f) => String(f.measured ?? 'missing');

/**
 * One row per current finding, plus the stored dispositions whose finding no longer exists:
 *   resolved: true  - the element is still in the model and the rule now finds no deviation (status 'compliant')
 *   orphan: 'element' - the element is not in this model (renamed or removed: nothing says the deviation is gone)
 *   orphan: 'rule'    - the element is there but the rule no longer runs on it (rule set or applicability changed)
 */
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
      // A changed requirement (rule value or rule text edited) also makes it stale: an acceptance for 380 mm does not cover 600 mm.
      stale: !!d && disposition !== 'open' && (d.measured !== measuredText(f) || d.status !== f.status || (d.required != null && d.required !== f.required)),
      missing_note: needsNote(disposition) && !String(d?.note ?? '').trim(),
      resolved: false,
    });
  }
  for (const [key, d] of Object.entries(store)) {
    if (seen.has(key) || !d || typeof d !== 'object' || d.kind === 'manual' || d.kind === 'input') continue; // input: a confirmed drawing value (input-confirmations.mjs)
    const [element, rule_id] = splitKey(key);
    const e = results.elements?.[element];
    const nowCompliant = !!e?.results?.some((r) => r.rule_id === rule_id && r.status === 'compliant');
    const orphan = !e ? 'element' : nowCompliant ? null : 'rule';
    rows.push({
      key, element, name: d.name ?? '', deck: d.deck ?? '', rule_id, status: orphan ? `orphan_${orphan}` : 'compliant',
      measured: d.measured ?? '', required: d.required ?? '',
      disposition: DISPOSITION_LABEL[d.disposition] ? d.disposition : 'open', responsible: d.responsible ?? '', note: d.note ?? '', updated: d.updated ?? '',
      revision: d.revision ?? '', stale: false, missing_note: false, resolved: !orphan, ...(orphan ? { orphan } : {}),
    });
  }
  return rows;
}

export function registerSummary(rows) {
  const current = rows.filter((r) => !r.resolved && !r.orphan);
  return {
    total: current.length,
    open: current.filter((r) => r.disposition === 'open').length,
    stale: current.filter((r) => r.stale).length,
    missing_note: current.filter((r) => r.missing_note).length,
    resolved: rows.filter((r) => r.resolved).length,
    orphaned: rows.filter((r) => r.orphan).length,
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

const STATUS_LABEL = { non_compliant: 'Non-compliant', not_enough_info: 'Not enough info', compliant: 'Resolved (no finding now)',
  orphan_element: 'Element not in this model (renamed or removed?)', orphan_rule: 'Rule no longer runs on this element' };
export const REGISTER_STATUS_LABEL = STATUS_LABEL;

export function registerCSV(rows) {
  const q = csvCell; // quotes, and neutralises text Excel would run as a formula
  const head = ['status', 'element', 'name', 'deck', 'rule', 'measured', 'required', 'disposition', 'responsible', 'note', 'updated', 'revision', 'review_again'];
  const lines = rows.map((r) => [STATUS_LABEL[r.status], r.element, r.name, r.deck, r.rule_id, r.measured, r.required,
    DISPOSITION_LABEL[r.disposition], r.responsible, r.note, r.updated, r.revision,
    r.stale ? 'yes: value, result or requirement changed since the disposition' : r.orphan ? 'yes: find the element or rule it belongs to' : ''].map(q).join(','));
  return '﻿' + [head.join(','), ...lines].join('\r\n');
}

// ---------- manual checks ----------
// Requirements the checker cannot decide: a person confirms each one per element, with name and a note on the
// evidence (drawing, certificate, inspection). Unconfirmed items stay open; nothing is confirmed automatically.

/**
 * One row per manual check of the current model, with its confirmation from the store. A confirmation counts only
 * with the name of who checked it, and only for the element as it was then: when the element's data changed (a new
 * revision, an edit) or the confirmation does not say what the element was, it is to be checked again (stale).
 */
export function manualRows(results, store = {}) {
  return manualChecksOf(results).map((m) => {
    const key = findingKey(m);
    const d = store[key]?.kind === 'manual' ? store[key] : null;
    const confirmed = !!d?.done && !!String(d.responsible ?? '').trim();
    const stale = confirmed && (!d.fingerprint || (m.fingerprint && d.fingerprint !== m.fingerprint));
    return { ...m, key, done: confirmed && !stale, stale, responsible: d?.responsible ?? '', note: d?.note ?? '', updated: d?.updated ?? '', revision: d?.revision ?? '' };
  });
}

export function manualSummary(rows) {
  return { total: rows.length, done: rows.filter((r) => r.done).length, open: rows.filter((r) => !r.done).length };
}

/** Returns a new store with the manual check updated. Confirming needs the name of the person who checked it. */
export function withManualCheck(store, item, patch, now = new Date()) {
  const key = findingKey(item);
  const prev = store[key]?.kind === 'manual' ? store[key] : {};
  const entry = { done: false, responsible: '', note: '', ...prev, ...patch, kind: 'manual' };
  const next = { ...store };
  if (!entry.done && !entry.responsible.trim() && !entry.note.trim()) { delete next[key]; return next; }
  if (entry.done && !entry.responsible.trim()) throw new Error('Enter who checked it before confirming a manual check.');
  // The element's data as confirmed: a later change of the element makes the confirmation stale.
  next[key] = { ...entry, updated: now.toISOString(), name: item.name, deck: item.deck, ...(item.fingerprint ? { fingerprint: item.fingerprint } : {}) };
  return next;
}
