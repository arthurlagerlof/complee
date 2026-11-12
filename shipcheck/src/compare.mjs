// Revision comparison: what changed between an earlier revision of a model (the baseline) and the current one.
// Pure functions over two models and their checker results. Answers the review question after a design change:
// which findings are new, which are gone, and which design values were touched.
import { findingsOf, normalizeModel } from './checker.mjs';

const key = (f) => `${f.element}|${f.rule_id}`;
const text = (v) => (v == null ? 'missing' : typeof v === 'object' ? JSON.stringify(v) : String(v));

function flat(el) {
  const out = { type: el.type, deck: el.deck, name: el.name };
  for (const [k, v] of Object.entries(el.geom_mm || {})) out[`geom.${k} (mm)`] = v;
  for (const [k, v] of Object.entries(el.props || {})) {
    // An annotated value ({ value, unit, source }) is compared by value and unit, not by its source note.
    out[`props.${k}`] = v && typeof v === 'object' && !Array.isArray(v) && 'value' in v ? `${text(v.value)}${v.unit ? ` ${v.unit}` : ''}` : text(v);
  }
  return out;
}

export function compareRevisions(baseModel, baseResults, model, results) {
  const before = new Map(findingsOf(baseResults).map((f) => [key(f), f]));
  const after = new Map(findingsOf(results).map((f) => [key(f), f]));
  const brief = (f) => ({ element: f.element, name: f.name, deck: f.deck, rule_id: f.rule_id, status: f.status, measured: text(f.measured), required: f.required });
  const findings = { new: [], resolved: [], changed: [], unchanged: 0 };
  for (const [k, f] of after) {
    const b = before.get(k);
    if (!b) findings.new.push(brief(f));
    else if (b.status !== f.status || text(b.measured) !== text(f.measured)) findings.changed.push({ ...brief(f), before_status: b.status, before_measured: text(b.measured) });
    else findings.unchanged++;
  }
  for (const [k, f] of before) if (!after.has(k)) findings.resolved.push(brief(f));

  const a = new Map(normalizeModel(structuredClone(baseModel)).elements.map((e) => [e.id, e]));
  const b = new Map(normalizeModel(structuredClone(model)).elements.map((e) => [e.id, e]));
  const elements = { added: [], removed: [], changed: [] };
  for (const [id, el] of b) {
    const old = a.get(id);
    if (!old) { elements.added.push({ id, name: el.name, type: el.type }); continue; }
    const x = flat(old), y = flat(el), changes = [];
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (text(x[k]) !== text(y[k])) changes.push({ field: k, before: k in x ? text(x[k]) : 'not set', after: k in y ? text(y[k]) : 'not set' });
    }
    if (changes.length) elements.changed.push({ id, name: el.name, changes });
  }
  for (const [id, el] of a) if (!b.has(id)) elements.removed.push({ id, name: el.name, type: el.type });
  return {
    findings, elements,
    identical: !findings.new.length && !findings.resolved.length && !findings.changed.length && !elements.added.length && !elements.removed.length && !elements.changed.length,
  };
}
