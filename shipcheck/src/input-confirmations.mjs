// Confirmation of values a drawing converter derived (basis measured, read or assumed). A rule result resting on
// such a value is a pre-check (see unconfirmedInputs in checker.mjs); a person who has checked the value against the
// drawing confirms it here, with their name. The confirmation is kept in the project's findings register store, so
// it travels with the project file, and it holds only for the value that was confirmed: when the value changes
// (a new conversion, a what-if, a revision) it is stale and the value is unconfirmed again.
//
// store entry: "<element>|input:<prop>" -> { kind: 'input', element, prop, value, unit, basis_was, responsible, note, updated, revision }
// Ship particulars use the element id SHIP ("(ship)|input:length_overall").
// A confirmation never changes a rule result's status: it only says whether the value it rests on was checked.

export const SHIP = '(ship)';
export const inputKey = (element, prop) => `${element}|input:${prop}`;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The stored confirmations, newest first. */
export function inputConfirmations(store = {}) {
  return Object.entries(store).filter(([, d]) => d?.kind === 'input').map(([key, d]) => ({ key, ...d }))
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

/**
 * Returns a new store with the value confirmed. `item`: { element, prop, value, unit, basis } of the value as it is
 * in the model now. Confirming needs the name of who checked it.
 */
export function withInputConfirmation(store, item, { responsible = '', note = '', revision = '' } = {}, now = new Date()) {
  if (!String(responsible).trim()) throw new Error('Enter who checked the value before confirming it.');
  if (item?.element == null || !item.prop) throw new Error('No value to confirm.');
  const next = { ...store };
  next[inputKey(item.element, item.prop)] = {
    kind: 'input', element: String(item.element), prop: String(item.prop), value: item.value, unit: item.unit ?? null,
    basis_was: item.basis ?? null, responsible: String(responsible).trim(), note: String(note).trim(), updated: now.toISOString(), revision: String(revision),
  };
  return next;
}

/** Returns a new store without the confirmation. */
export function withoutInputConfirmation(store, element, prop) {
  const next = { ...store };
  delete next[inputKey(element, prop)];
  return next;
}

/**
 * Marks the confirmed values of a model in place: a property whose value equals the confirmed one gets
 * basis "confirmed" with who and when (its earlier basis kept in basis_was); a property marked confirmed whose
 * confirmation is gone or no longer matches gets its earlier basis back. Works on a raw ship/1 model; only the
 * stored confirmations are looked at, so a large model is not walked.
 * Returns { confirmed: [keys], stale: [{ key, element, prop, confirmed, now }] }.
 */
export function applyInputConfirmations(model, store = {}) {
  const out = { confirmed: [], stale: [] };
  if (!isObj(model)) return out;
  const wanted = inputConfirmations(store);
  const byId = new Map();
  const elementOf = (id) => {
    if (id === SHIP) return { props: model.ship };
    if (!byId.size) for (const e of model.elements || []) if (isObj(e)) byId.set(String(e.id), e);
    return byId.get(String(id));
  };
  // Undo marks whose confirmation is gone (or was for another value): every element that carries one.
  const marked = [];
  const scan = (owner, props) => { for (const [k, p] of Object.entries(props || {})) if (isObj(p) && p.basis === 'confirmed') marked.push([owner, k, p]); };
  scan(SHIP, model.ship);
  if (wanted.length || model.__inputConfirmed) for (const e of model.elements || []) if (isObj(e)) scan(String(e.id), e.props);
  for (const [owner, k, p] of marked) {
    const c = store[inputKey(owner, k)];
    if (c?.kind === 'input' && sameValue(c.value, p.value) && (c.unit ?? null) === (p.unit ?? null)) continue;
    p.basis = p.basis_was ?? 'measured';
    delete p.basis_was; delete p.confirmed_by; delete p.confirmed_at;
  }
  for (const c of wanted) {
    const el = elementOf(c.element);
    const p = el?.props?.[c.prop];
    if (!isObj(p) || !('value' in p)) continue; // the element or the value is not in this model
    if (!sameValue(c.value, p.value) || (c.unit ?? null) !== (p.unit ?? null)) {
      out.stale.push({ key: c.key, element: c.element, prop: c.prop, confirmed: c.value, now: p.value });
      continue;
    }
    if (p.basis !== 'confirmed') { p.basis_was = p.basis ?? null; p.basis = 'confirmed'; }
    p.confirmed_by = c.responsible;
    p.confirmed_at = c.updated;
    out.confirmed.push(c.key);
  }
  if (out.confirmed.length) Object.defineProperty(model, '__inputConfirmed', { value: true, configurable: true, enumerable: false });
  return out;
}
