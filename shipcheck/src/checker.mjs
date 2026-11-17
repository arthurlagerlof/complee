// Deterministic rule checker. Pure functions, no I/O: the same module runs in Node (CLI, server, tests)
// and in the browser (instant re-check while editing). Same model + same rules = same result.
//
// Status per (element, rule):
//   compliant        the design value meets the rule
//   non_compliant    the design value violates the rule
//   not_enough_info  a value needed to decide is missing (never guessed)

export const UNIT_TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
export const STATUS_RANK = { non_compliant: 3, not_enough_info: 2, compliant: 1 };
export const CHECK_TYPES = ['min', 'max', 'not_adjacent_zone', 'distance_min_hull', 'count_min', 'requires', 'in_set', 'table_lookup', 'data_quality', 'manual'];
const ADJACENCY_TOLERANCE_MM = 50;
const DEFAULT_DECK_HEIGHT_MM = 2800;
const SHIP_LENGTH_KEYS = new Set(['length_overall', 'beam', 'draft', 'depth']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
// Ship dimensions outside this range are taken as a unit error (a beam of 30 mm, a length of 60 km), not as data.
const PLAUSIBLE_SHIP_MM = [1000, 600000];
// Ids that cannot be used as keys of the result object.
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype']);
// Vocabulary values (element type, ship type, zone, fuel) compared without case, spaces or hyphens:
// "Corridor", "corridor"; "Special purpose", "special_purpose"; "LNG", "lng".
export const normWord = (v) => String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
const looseEqual = (a, b) => (typeof a === 'string' && typeof b === 'string' ? normWord(a) === normWord(b) : a === b);
// Rectangle geometry the checks can compute with: finite numbers, positive plan size, height not negative.
export function usableGeometry(g) {
  return !!g && [g.x, g.y, g.z, g.lx, g.ly, g.h].every(finite) && g.lx > 0 && g.ly > 0 && g.h >= 0;
}

// ---------- values and units ----------

// A value in the model is either plain (`850`, in the model's units) or annotated
// (`{ "value": 850, "unit": "mm", "source": "GA drawing 101" }`). Returns null when missing.
export function readValue(v, defaultUnit, defaultSource) {
  if (v == null) return null;
  if (isObj(v) && 'value' in v) {
    if (v.value == null) return null;
    return { value: v.value, unit: v.unit ?? defaultUnit, source: v.source ?? defaultSource, note: v.note, original: v.original, basis: v.basis };
  }
  return { value: v, unit: defaultUnit, source: defaultSource };
}

export function toMM(value, unit) {
  const k = UNIT_TO_MM[unit];
  if (k == null) throw new Error(`Unsupported length unit "${unit}"`);
  return value * k;
}

// Whole mm for room-scale values; two decimals below 100 mm (plate thickness 5/16" = 7.94 mm).
export const fmtMM = (mm) => `${Math.abs(mm) < 100 ? round(mm, 2) : round(mm)} mm`;
export const fmtRatio = (v) => (v > 0 ? `1:${round(1 / v, 1)} (${round(v * 100, 1)}%)` : `${v}`);

// Shows the value as written in the source model and its mm conversion: 5/16" = 7.94 mm.
function fmtLengthInput(rv, mm) {
  if (rv.original != null) return `${rv.original} = ${fmtMM(mm)}`;
  return rv.unit === 'mm' ? fmtMM(mm) : `${rv.value} ${rv.unit} (${fmtMM(mm)})`;
}

// ---------- model normalisation ----------

// Accepts ship.json (multi-deck) and the older deck.json (one deck). Geometry is converted to mm;
// element props are kept as written so the original unit can be shown.
// An element without plan geometry whose deck is set (every part of a 3D production model) needs no change: it is
// used as it is instead of copied. On a cruise-ship model that is 2.3 million objects (about 170 MB) less. Nothing
// writes to normalised elements (what-if edits change props, which a copy would share anyway).
function normalizeElement(el, k, defaultDeck) {
  const g = el.geom;
  if (!g && el.deck != null) return el;
  return {
    ...el,
    deck: el.deck ?? defaultDeck,
    geom_mm: g ? { x: g.x * k, y: g.y * k, z: (g.z ?? 0) * k, lx: g.lx * k, ly: g.ly * k, h: (g.h ?? 0) * k } : null,
  };
}

export function normalizeModel(raw) {
  if (raw?.__normalized) return raw;
  const units = raw.units || 'mm';
  const k = UNIT_TO_MM[units];
  if (k == null) throw new Error(`Unsupported model unit "${units}"`);
  const legacy = !Array.isArray(raw.decks);

  const srcDecks = legacy
    ? [{
        id: raw.deck?.id || 'DECK',
        name: raw.deck?.name || raw.name || 'Deck',
        elevation: 0,
        height: raw.deck?.height,
        outline: raw.deck?.outline || [[0, 0], [raw.deck?.length ?? 0, 0], [raw.deck?.length ?? 0, raw.deck?.width ?? 0], [0, raw.deck?.width ?? 0]],
        side_lines: raw.deck?.side_lines,
        source: raw.deck?.source,
      }]
    : raw.decks;

  const scalePts = (pts) => pts.map(([x, y]) => [x * k, y * k]);
  const decks = srcDecks.map((d) => {
    const outline_mm = scalePts(d.outline || []);
    return {
      id: d.id,
      name: d.name || d.id,
      elevation_mm: (d.elevation ?? 0) * k,
      height_mm: d.height != null ? d.height * k : DEFAULT_DECK_HEIGHT_MM,
      outline_mm,
      // Lines that represent the ship's shell at this deck. Default: the closed outline.
      side_lines_mm: d.side_lines
        ? d.side_lines.map(scalePts)
        : outline_mm.length ? [[...outline_mm, outline_mm[0]]] : [],
      source: d.source,
    };
  });

  // Element ids are the keys of every result, register entry and comment link. An element that is not an object, or
  // whose id is missing, reserved or used twice, would silently disappear from the results (only the last element of
  // an id was kept). Such elements are checked under a new id and listed in `issues`, so nothing is hidden.
  const issues = [];
  const used = new Set();
  const elements = [], sources = [];
  (raw.elements || []).forEach((el, i) => {
    if (!isObj(el)) {
      issues.push({ kind: 'invalid_element', index: i, text: `Element ${i + 1} of the model is not an element (${JSON.stringify(el)}) and was not checked.` });
      return;
    }
    let id = el.id;
    if (id == null || id === '' || RESERVED_IDS.has(String(id))) {
      const next = `element-${i + 1}`;
      issues.push({ kind: 'missing_id', index: i, id: next, text: `Element ${i + 1} (${el.name || el.type || 'no name'}) has ${id == null || id === '' ? 'no id' : `the reserved id "${id}"`}; checked as "${next}".` });
      id = next;
    } else if (used.has(String(id))) {
      let n = 2;
      while (used.has(`${id}~${n}`)) n++;
      const next = `${id}~${n}`;
      issues.push({ kind: 'duplicate_id', index: i, id: next, original: id, text: `Id "${id}" is used by more than one element; element ${i + 1} (${el.name || el.type || 'no name'}) is checked as "${next}". Give every element its own id.` });
      id = next;
    }
    used.add(String(id));
    elements.push(normalizeElement(id === el.id ? el : { ...el, id }, k, decks[0]?.id));
    sources.push(el);
  });

  return {
    __normalized: true,
    name: raw.name,
    schema: legacy ? 'deck/1 (legacy)' : 'ship/1',
    units,
    source: raw.source,
    ship: raw.ship || {},
    decks,
    elements,
    issues,
    // The raw element of each normalised one (same order), so a result's details can be computed again on demand.
    sources,
    hull: raw.hull,
    demo: raw.demo,
  };
}

export function prop(el, key, model) {
  const v = readValue(el.props?.[key], model.units, el.source || model.source || 'not stated');
  if (v && v.basis == null && el.basis != null) v.basis = el.basis;
  return v;
}

function shipValue(model, key) {
  return readValue(model.ship?.[key], model.units, model.ship?.source || 'not stated');
}

// ---------- applicability ----------

// ok: true (applies) | false (does not apply, with the reason) | 'unknown' (a value the condition needs is missing:
// the rule may apply, so it is never dropped silently; see checkElement).
function elementCondition(rule, el, model) {
  const a = rule.applies_to || {};
  if (a.types && !a.types.some((t) => looseEqual(t, el.type))) return { ok: false, silent: true };
  let unknown = null;
  for (const [key, want] of Object.entries(a.where || {})) {
    const p = prop(el, key, model);
    // A missing value decides a condition only when the condition is about presence ({ exists }) or when every
    // value outside a list qualifies ({ not_in }); otherwise whether the rule applies is open.
    if (!p && !(isObj(want) && 'exists' in want) && !whereMatches(undefined, want)) {
      unknown ??= { missing: key, want: describeWhere(want) };
      continue;
    }
    if (!whereMatches(p?.value, want)) {
      return { ok: false, reason: `${key} is ${p ? JSON.stringify(p.value) : 'not set'}; rule applies when ${key} ${describeWhere(want)}` };
    }
  }
  return unknown ? { ok: 'unknown', ...unknown } : { ok: true };
}

// `where` values: a plain value (equality) or one operator object:
//   { "prefix": "1" }  { "in": [..] }  { "not_in": [..] }  { "exists": true|false }
// Text is compared without case, spaces or hyphens ("LNG" = "lng", "oil fuel" = "Oil-fuel").
export function whereMatches(have, want) {
  if (!isObj(want)) return looseEqual(have, want);
  if ('exists' in want) return (have != null) === want.exists;
  if ('prefix' in want) return have != null && [].concat(want.prefix).some((p) => String(have).toUpperCase().startsWith(String(p).toUpperCase()));
  if ('in' in want) return want.in.some((w) => looseEqual(have, w));
  if ('not_in' in want) return !want.not_in.some((w) => looseEqual(have, w));
  return false;
}
function describeWhere(want) {
  if (!isObj(want)) return `= ${JSON.stringify(want)}`;
  if ('exists' in want) return want.exists ? 'is set' : 'is not set';
  if ('prefix' in want) return `starts with ${[].concat(want.prefix).map((p) => `"${p}"`).join(' or ')}`;
  if ('in' in want) return `is one of ${want.in.map((v) => JSON.stringify(v)).join(', ')}`;
  return `is not one of ${want.not_in.map((v) => JSON.stringify(v)).join(', ')}`;
}

// A date as written in the model -> the interval it stands for: "2027-03-15" one day, "2027-03" a month, "2027" a year.
// Returns [first, last] as YYYY-MM-DD strings (comparable as text), or null when it is not a date.
export function dateRange(v) {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  if (mo && (+mo < 1 || +mo > 12)) return null;
  if (d) {
    const t = new Date(`${y}-${mo}-${d}T00:00:00Z`);
    if (Number.isNaN(t.getTime()) || t.getUTCDate() !== +d) return null;
    return [`${y}-${mo}-${d}`, `${y}-${mo}-${d}`];
  }
  if (mo) {
    const last = new Date(Date.UTC(+y, +mo, 0)).getUTCDate();
    return [`${y}-${mo}-01`, `${y}-${mo}-${String(last).padStart(2, '0')}`];
  }
  return [`${y}-01-01`, `${y}-12-31`];
}
const isDay = (v) => typeof v === 'string' && dateRange(v)?.[0] === v && v.length === 10;

// Ship types the rule set distinguishes (normalised), so an unknown spelling ("cruise", "ro-pax") is reported as
// undecided instead of switching every type-specific rule off. SOLAS divides every ship into passenger or cargo, so
// those two are always known, whatever rules are loaded.
export function shipTypesOf(rules) {
  const out = new Set(['passenger', 'cargo']);
  for (const r of rules || []) for (const t of r?.applies_to?.ship?.type_in || []) out.add(normWord(t));
  return out;
}

// A ship dimension in mm, or why it cannot be used: { mm, v } | { missing: true } | { bad: text, v }.
function shipDimension(model, key) {
  const v = shipValue(model, key);
  if (!v) return { missing: true };
  if (!finite(v.value) || !(v.unit in UNIT_TO_MM)) {
    return { bad: `ship.${key} "${v.value}"${v.unit ? ` ${v.unit}` : ''} is not a length the checker can use`, v };
  }
  const mm = toMM(v.value, v.unit);
  if (mm < PLAUSIBLE_SHIP_MM[0] || mm > PLAUSIBLE_SHIP_MM[1]) {
    return { bad: `ship.${key} = ${fmtMM(mm)} is not a plausible ship dimension (check the unit)`, v, mm };
  }
  return { v, mm };
}

// Ship-level conditions: ship type, operating area, minimum size, class society.
// Returns ok:true | ok:false (not applicable) | ok:'unknown' (ship data missing or unusable -> not_enough_info).
// Data that cannot be read (a length "abc", an unknown ship type, an unsupported unit) never makes a rule
// "not applicable": only data that clearly falls outside the rule's scope does.
function shipCondition(rule, model, ctx = {}) {
  const c = rule.applies_to?.ship;
  if (!c) return { ok: true, inputs: [] };
  const inputs = [];
  const need = (key) => {
    const v = shipValue(model, key);
    if (v) {
      const shown = Array.isArray(v.value) ? v.value.join(', ')
        : SHIP_LENGTH_KEYS.has(key) && v.unit in UNIT_TO_MM && finite(v.value) ? fmtLengthInput(v, toMM(v.value, v.unit)) : String(v.value);
      inputs.push({ name: `ship.${key}`, value: shown, source: v.source });
    }
    return v;
  };
  const unknown = (key, why) => ({ ok: 'unknown', missing: why ? `usable ship.${key} (${why})` : `ship.${key}`, inputs });

  if (c.type_in) {
    const t = need('type');
    if (!t) return unknown('type');
    const have = [].concat(t.value).map(normWord).filter(Boolean);
    const want = c.type_in.map(normWord);
    if (!have.some((h) => want.includes(h))) {
      const known = ctx.shipTypes?.size ? ctx.shipTypes : new Set(want);
      if (!have.length || have.some((h) => !known.has(h))) {
        return unknown('type', `"${[].concat(t.value).join(', ')}" is not a ship type of the rule set: ${[...known].join(', ')}`);
      }
      return { ok: false, reason: `ship type is "${t.value}"; rule applies to ${c.type_in.join(' / ')}` };
    }
  }
  if (c.operating_area_any) {
    const a = need('operating_area');
    if (!a) return unknown('operating_area');
    const areas = [].concat(a.value).filter((x) => x != null && x !== '');
    if (!areas.length) return unknown('operating_area');
    if (!areas.some((x) => c.operating_area_any.some((w) => looseEqual(String(x), String(w))))) {
      return { ok: false, reason: `operating area is ${areas.join(', ')}; rule applies in ${c.operating_area_any.join(' / ')}` };
    }
  }
  for (const [key, want] of Object.entries(c.equals || {})) {
    const v = need(key);
    if (!v || v.value === '') return unknown(key);
    if (!looseEqual(v.value, want)) return { ok: false, reason: `ship.${key} is "${v.value}"; rule applies when it is "${want}"` };
  }
  for (const [key, lim] of Object.entries(c.min || {})) {
    const limit = readValue(lim, null);
    let have, want = limit.value, shown = `${want}`, stated;
    if (limit.unit) {
      const d = shipDimension(model, key);
      need(key);
      if (d.missing) return unknown(key);
      if (d.bad) return unknown(key, d.bad);
      have = d.mm;
      want = toMM(limit.value, limit.unit);
      shown = `${limit.value} ${limit.unit}`;
      stated = fmtMM(have);
    } else {
      const v = need(key);
      if (!v) return unknown(key);
      if (!finite(v.value) || v.value < 0) return unknown(key, `"${v.value}" is not a number`);
      have = v.value;
      stated = String(v.value);
    }
    if (!(have >= want)) return { ok: false, reason: `ship.${key} is ${stated}; rule applies from ${shown}` };
  }
  // Date of construction: SOLAS applies most new requirements to ships "constructed" (keel laid or at a similar stage
  // of construction) on or after a date. The model gives ship.keel_laid; a date that does not decide (a year that
  // spans the boundary) leaves the rule undecided instead of guessing.
  if (c.constructed) {
    const v = need('keel_laid');
    if (!v) return unknown('keel_laid');
    const r = dateRange(v.value);
    if (!r) return { ok: 'unknown', missing: `ship.keel_laid as a date (YYYY-MM-DD; "${v.value}" is not one)`, inputs };
    const { on_or_after: from, before } = c.constructed;
    if (from && r[1] < from) return { ok: false, reason: `keel laid ${v.value}; rule applies to ships constructed on or after ${from}` };
    if (before && r[0] >= before) return { ok: false, reason: `keel laid ${v.value}; rule applies to ships constructed before ${before}` };
    if ((from && r[0] < from) || (before && r[1] >= before)) {
      return { ok: 'unknown', missing: `the exact ship.keel_laid date ("${v.value}" spans ${from && r[0] < from ? from : before})`, inputs };
    }
  }
  return { ok: true, inputs };
}

// ---------- geometry ----------

function rectOf(el) {
  const g = el.geom_mm;
  return g && { x0: g.x, y0: g.y, x1: g.x + g.lx, y1: g.y + g.ly };
}

// Vertical extent. An element without a height (h = 0) stands for a space on its deck: it takes the deck height,
// so two spaces side by side on one deck share a wall (with h = 0 they could never touch).
function zRange(el, deckById) {
  const g = el.geom_mm, deck = deckById[el.deck];
  const base = (deck?.elevation_mm ?? 0) + g.z;
  return [base, base + (g.h > 0 ? g.h : deck?.height_mm ?? DEFAULT_DECK_HEIGHT_MM)];
}

// Point in polygon (ray casting); points on the boundary count as inside.
function insidePolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (pointSegDist([px, py], poly[j], poly[i]) < 1e-6) return true;
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointSegDist([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function segsIntersect(p1, p2, p3, p4) {
  const d = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0));
}

// Shortest plan distance between an axis-aligned rectangle and a polyline (0 if they touch or cross).
export function rectToPolylineDistance(r, line) {
  const corners = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
  const edges = corners.map((c, i) => [c, corners[(i + 1) % 4]]);
  const inside = ([x, y]) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1];
    if (inside(a) || inside(b) || edges.some(([c, d]) => segsIntersect(a, b, c, d))) return 0;
    for (const c of corners) best = Math.min(best, pointSegDist(c, a, b));
    for (const [c, d] of edges) best = Math.min(best, pointSegDist(a, c, d), pointSegDist(b, c, d));
  }
  return best;
}

// Elements that share a boundary (face contact within tolerance) in 3D.
export function geometricNeighbours(el, model, deckById) {
  if (!usableGeometry(el.geom_mm)) return [];
  const a = rectOf(el), [az0, az1] = zRange(el, deckById);
  const tol = ADJACENCY_TOLERANCE_MM;
  const out = [];
  for (const o of model.elements) {
    if (o === el || !usableGeometry(o.geom_mm) || o.virtual) continue;
    const b = rectOf(o), [bz0, bz1] = zRange(o, deckById);
    const ov = [
      Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0),
      Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0),
      Math.min(az1, bz1) - Math.max(az0, bz0),
    ];
    if (ov.every((v) => v >= -tol) && ov.filter((v) => v > tol).length >= 2) out.push(o);
  }
  return out;
}

// ---------- checks ----------

function result(rule, status, { measured = null, required = '-', explanation, inputs = [], limit = null }) {
  return {
    rule_id: rule.id,
    source: rule.source,
    clause: rule.clause,
    rule_text: rule.text,
    text_status: rule.text_status || 'paraphrase',
    basis: rule.basis || 'explicit',
    verified: rule.verified === true,
    review_status: rule.review_status || null,
    reference_url: rule.reference_url || null,
    related: rule.related || [],
    check: rule.check,
    parameter: rule.parameter ?? null,
    status,
    measured,
    required,
    explanation,
    inputs,
    limit,
  };
}

const missing = (rule, el, what, required, inputs = []) =>
  result(rule, 'not_enough_info', {
    required, inputs,
    explanation: `${what} is missing in the design data for ${el.name}. Add it to check this rule.`,
  });

function checkMinMax(rule, el, ctx) {
  const { model } = ctx;
  const p = prop(el, rule.parameter, model);
  const sym = rule.check === 'min' ? '≥' : '≤';
  const isLength = rule.unit in UNIT_TO_MM;
  const limitVal = isLength ? toMM(rule.value, rule.unit) : rule.value;
  const fmt = isLength ? fmtMM : rule.unit === 'ratio' ? fmtRatio : (v) => `${v} ${rule.unit || ''}`.trim();
  const required = `${sym} ${fmt(limitVal)}`;
  const limit = { kind: rule.check, parameter: rule.parameter, value: limitVal };
  if (!p) return { ...missing(rule, el, `"${rule.parameter}"`, required), limit };
  if (typeof p.value !== 'number' || !Number.isFinite(p.value)) {
    return result(rule, 'not_enough_info', { required, limit, explanation: `"${rule.parameter}" of ${el.name} is not a number (${JSON.stringify(p.value)}).` });
  }
  let v = p.value, shown;
  if (isLength) {
    if (!(p.unit in UNIT_TO_MM)) {
      return result(rule, 'not_enough_info', { required, limit, explanation: `"${rule.parameter}" of ${el.name} has unit "${p.unit}", which the checker cannot convert.` });
    }
    v = toMM(p.value, p.unit);
    shown = fmtLengthInput(p, v);
  } else shown = fmt(v);
  // A length or slope below zero is a data error, not a design that meets an upper limit.
  if ((isLength || rule.unit === 'ratio') && v < 0) {
    return result(rule, 'not_enough_info', { required, limit, inputs: [{ name: rule.parameter, value: shown, source: p.source }],
      explanation: `"${rule.parameter}" of ${el.name} is ${shown}, which is below zero: check the design data.` });
  }
  // A dimension longer than the ship (or than any ship) comes from a unit error (850 "m" for 850 mm), never a design.
  if (isLength) {
    const loa = shipDimension(model, 'length_overall');
    const cap = loa.mm ? Math.max(loa.mm * 1.5, 1000) : PLAUSIBLE_SHIP_MM[1];
    if (v > cap) {
      return result(rule, 'not_enough_info', { required, limit, inputs: [{ name: rule.parameter, value: shown, source: p.source }],
        explanation: `"${rule.parameter}" of ${el.name} is ${shown}, longer than ${loa.mm ? 'the ship' : 'any ship'}: the unit is probably wrong. Check the design data.` });
    }
  }
  // A value equal to the limit meets it, also when the limit is stored rounded or converted (1:12 as a ratio,
  // 36 in in mm): differences in the last digits of a floating-point number are not a finding.
  const eps = 1e-9 * Math.max(1, Math.abs(limitVal));
  const ok = rule.check === 'min' ? v >= limitVal - eps : v <= limitVal + eps;
  // Never say "900 mm, but must be ≥ 900 mm. Short by 0 mm": show the digits that decide.
  if (!ok && isLength && fmtMM(v) === fmtMM(limitVal)) shown = `${shown} (${+v.toFixed(3)} mm unrounded)`;
  const inputs = [{ name: rule.parameter, value: shown, source: p.source }];
  const diff = (d) => (isLength ? (fmtMM(d) === '0 mm' ? 'less than 0.01 mm' : fmtMM(d)) : round(d, 4) === 0 ? 'less than 0.0001' : round(d, 4));
  let explanation;
  if (ok) explanation = `${rule.parameter} is ${shown}; requirement ${required} is met.`;
  else if (rule.check === 'min') explanation = `${rule.parameter} is ${shown}, but must be ${required}. Short by ${diff(limitVal - v)}.`;
  else explanation = `${rule.parameter} is ${shown}, but must be ${required}. Exceeds the limit by ${rule.unit === 'ratio' ? `${round((v - limitVal) * 100, 2)} percentage points` : diff(v - limitVal)}.`;
  return result(rule, ok ? 'compliant' : 'non_compliant', { measured: shown, required, explanation, inputs, limit: { ...limit, measured: v } });
}

// Neighbours come from the declared list (props.adjacent) and from the geometry, both when both exist: a declared
// list cannot hide a space the geometry shows touching. The result is "no deviation" only when every neighbour is
// known and has a zone, and no space of a forbidden zone is left without usable geometry (it could be next door).
function checkNotAdjacentZone(rule, el, ctx) {
  const { model, byId, deckById } = ctx;
  const required = `not next to: ${rule.zones.join(', ')} spaces`;
  const forbidden = rule.zones.map(normWord);
  const declared = prop(el, 'adjacent', model);
  const placed = usableGeometry(el.geom_mm);
  if (!declared && !placed) {
    return missing(rule, el, el.geom_mm ? 'Usable geometry (x, y, lx, ly as numbers, size above zero)' : 'Adjacency (props.adjacent or geometry)', required);
  }
  const neighbours = new Map(), sources = [], open = [];
  if (declared) {
    const ids = [].concat(declared.value);
    const dangling = ids.filter((id) => !byId[id]);
    for (const id of ids) if (byId[id] && byId[id] !== el) neighbours.set(byId[id].id, byId[id]);
    sources.push(declared.source);
    if (dangling.length) open.push(`${dangling.join(', ')} ${dangling.length > 1 ? 'are' : 'is'} listed as adjacent but not in the model`);
  }
  if (placed) {
    for (const o of geometricNeighbours(el, model, deckById)) neighbours.set(o.id, o);
    sources.push(`derived from 3D geometry (shared boundary within ${ADJACENCY_TOLERANCE_MM} mm)`);
  }
  const zoneOf = (s) => { const z = prop(s, 'zone', model)?.value; return z == null || z === '' ? null : String(z); };
  const list = [...neighbours.values()];
  const listed = list.map((s) => `${s.name} [${zoneOf(s) ?? 'zone not set'}]`).join(', ') || 'none';
  const inputs = [{ name: 'adjacent spaces', value: listed, source: sources.join('; ') }];
  const bad = list.filter((s) => zoneOf(s) !== null && forbidden.includes(normWord(zoneOf(s))));
  if (bad.length) {
    return result(rule, 'non_compliant', { measured: `adjacent: ${listed}`, required, inputs,
      explanation: `${el.name} borders ${bad.map((s) => `${s.name} (${s.id})`).join(', ')}, which ${bad.length > 1 ? 'are' : 'is'} in the ${rule.zones.join('/')} zone. Move the tank or add a separating space (e.g. cofferdam or void).` });
  }
  const noZone = list.filter((s) => zoneOf(s) === null);
  if (noZone.length) open.push(`the zone of ${noZone.map((s) => `${s.name} (${s.id})`).join(', ')} is not set`);
  if (placed) {
    const unplaced = model.elements.filter((o) => o !== el && !o.virtual && !neighbours.has(o.id) && !usableGeometry(o.geom_mm)
      && zoneOf(o) !== null && forbidden.includes(normWord(zoneOf(o))));
    if (unplaced.length) open.push(`${unplaced.map((s) => `${s.name} (${s.id})`).slice(0, 5).join(', ')}${unplaced.length > 5 ? ` and ${unplaced.length - 5} more` : ''} in the ${rule.zones.join('/')} zone ${unplaced.length > 1 ? 'have' : 'has'} no usable geometry`);
  }
  if (open.length) {
    return result(rule, 'not_enough_info', { measured: `adjacent: ${listed}`, required, inputs,
      explanation: `Cannot rule out a ${rule.zones.join('/')} space next to ${el.name}: ${open.join('; ')}.` });
  }
  return result(rule, 'compliant', { measured: `adjacent: ${listed}`, required, inputs,
    explanation: `${el.name} does not border any ${rule.zones.join('/')} space.` });
}

function checkDistanceMinHull(rule, el, ctx) {
  const { model, deckById } = ctx;
  let limitVal = toMM(rule.value, rule.unit);
  let required = `≥ ${fmtMM(limitVal)} from the ship side`;
  const inputs = [];
  if (rule.beam_divisor) {
    const b = shipDimension(model, 'beam');
    const formula = `≥ min(B/${rule.beam_divisor}, ${fmtMM(limitVal)}) from the ship side`;
    if (b.missing) return missing(rule, el, 'Ship beam (ship.beam)', formula);
    if (b.bad) return result(rule, 'not_enough_info', { required: formula, explanation: `The ship beam cannot be used: ${b.bad}.` });
    inputs.push({ name: 'ship.beam', value: fmtLengthInput(b.v, b.mm), source: b.v.source });
    limitVal = Math.min(b.mm / rule.beam_divisor, limitVal);
    required = `≥ min(B/${rule.beam_divisor}, ${fmtMM(toMM(rule.value, rule.unit))}) = ${fmtMM(limitVal)} from the ship side`;
  }
  const limit = { kind: 'min', parameter: 'distance_to_side', value: limitVal };
  const deck = deckById[el.deck];
  if (!el.geom_mm) return { ...missing(rule, el, 'Geometry (geom)', required, inputs), limit };
  if (!usableGeometry(el.geom_mm)) {
    return { ...result(rule, 'not_enough_info', { required, inputs, explanation: `The geometry of ${el.name} is incomplete or not a number (x, y, lx, ly); its distance to the ship side cannot be measured.` }), limit };
  }
  if (!deck?.side_lines_mm?.length) return { ...missing(rule, el, `Ship side line of deck "${el.deck}"`, required, inputs), limit };
  // The distance to the side line has no sign: a tank outside the hull would be "inboard" by its distance. When the
  // deck outline is known, the tank must lie inside it.
  const r = rectOf(el);
  if (deck.outline_mm?.length >= 3 && ![[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]].some((c) => insidePolygon(c, deck.outline_mm))) {
    return { ...result(rule, 'not_enough_info', { required, inputs,
      explanation: `${el.name} lies outside the outline of deck ${deck.name}: its position or the deck outline is wrong, so its distance to the ship side cannot be judged.` }), limit };
  }
  const d = Math.min(...deck.side_lines_mm.map((line) => rectToPolylineDistance(r, line)));
  inputs.push({ name: 'distance to ship side', value: fmtMM(d), source: `computed from geometry of ${el.id} and the side line of deck ${deck.name}` });
  const ok = d >= limitVal;
  return result(rule, ok ? 'compliant' : 'non_compliant', {
    measured: `${fmtMM(d)} from the ship side`, required, inputs, limit: { ...limit, measured: d },
    explanation: ok
      ? `${el.name} is ${fmtMM(d)} inboard of the ship side; requirement ${required} is met.`
      : `${el.name} is only ${fmtMM(d)} from the ship side, but must be ${required}. Move it ${fmtMM(limitVal - d)} further inboard.`,
  });
}

function checkCountMin(rule, el, ctx) {
  const { model, byId } = ctx;
  const required = `≥ ${rule.value} ${rule.count_label || 'items'}`;
  const p = prop(el, rule.parameter, model);
  if (!p) return missing(rule, el, `"${rule.parameter}"`, required);
  const ids = [...new Set([].concat(p.value))];
  const dangling = ids.filter((id) => !byId[id]);
  const wrongType = ids.filter((id) => byId[id] && rule.count_types && !rule.count_types.includes(byId[id].type));
  const valid = ids.filter((id) => byId[id] && !wrongType.includes(id)).map((id) => byId[id]);
  const n = valid.length;
  const listed = valid.map((e) => `${e.id} (${e.name})`).join(', ') || 'none';
  const notes = [
    dangling.length ? `${dangling.join(', ')} not found in the model` : '',
    wrongType.length ? `${wrongType.join(', ')} not counted (type not in ${rule.count_types.join('/')})` : '',
  ].filter(Boolean).join('; ');
  const ok = n >= rule.value;
  // Too few counted, but some listed items are not in the model: they may exist in the design, so this is open
  // rather than a deviation.
  if (!ok && dangling.length) {
    return result(rule, 'not_enough_info', { measured: `${n}: ${listed}`, required,
      inputs: [{ name: rule.parameter, value: ids.join(', '), source: p.source }],
      explanation: `${el.name} has ${n} ${rule.count_label || 'items'} in the model (${listed}); ${dangling.join(', ')} ${dangling.length > 1 ? 'are' : 'is'} listed but not in the model. Add ${dangling.length > 1 ? 'them' : 'it'} to decide.` });
  }
  return result(rule, ok ? 'compliant' : 'non_compliant', {
    measured: `${n}: ${listed}`, required,
    inputs: [{ name: rule.parameter, value: ids.join(', ') || 'none', source: p.source }],
    limit: { kind: 'min', parameter: rule.parameter, value: rule.value, measured: n },
    explanation: (ok
      ? `${el.name} has ${n} ${rule.count_label || 'items'}: ${listed}.`
      : `${el.name} has ${n} ${rule.count_label || 'items'} (${listed}), but needs ${required}. Add an independent route, widely separated from the first.`) +
      (notes ? ` Note: ${notes}.` : ''),
  });
}

function checkRequires(rule, el, ctx) {
  const { model } = ctx;
  const req = rule.requires;
  const required = `ship has a ${req.label || req.type}`;
  const matches = model.elements.filter((e) =>
    looseEqual(e.type, req.type) && Object.entries(req.where || {}).every(([k, v]) => looseEqual(prop(e, k, model)?.value, v)));
  const ok = matches.length > 0;
  return result(rule, ok ? 'compliant' : 'non_compliant', {
    measured: ok ? `found: ${matches.map((e) => `${e.id} (${e.name})`).join(', ')}` : 'none found in the model',
    required,
    inputs: [{ name: `elements of type ${req.type}`, value: matches.map((e) => e.id).join(', ') || 'none', source: 'model element list' }],
    explanation: ok
      ? `${el.name} requires a ${req.label || req.type}; found ${matches.map((e) => e.id).join(', ')}.`
      : `${el.name} requires a ${req.label || req.type}, but the model has none. Add it, or check whether it is modelled under a different type.`,
  });
}

// in_set: a text value must be one of an allowed list (e.g. hull steel grades).
// rule.aliases maps other spellings to the listed value (e.g. "AH36" -> "A36").
// Outside the list -> rule.else_status (default non_compliant).
function checkInSet(rule, el, ctx) {
  const p = prop(el, rule.parameter, ctx.model);
  const required = `${rule.parameter} one of: ${rule.values.join(', ')}`;
  if (!p || p.value === '') return missing(rule, el, `"${rule.parameter}"`, required, extraInputs(rule, el, ctx));
  const canon = rule.aliases?.[p.value] ?? p.value;
  const inputs = [{ name: rule.parameter, value: canon === p.value ? String(p.value) : `${p.value} (= ${canon})`, source: p.source }, ...extraInputs(rule, el, ctx)];
  if (rule.values.includes(canon)) {
    return result(rule, 'compliant', { measured: String(p.value), required, inputs, explanation: `${rule.parameter} "${p.value}" is in the allowed list.` });
  }
  return result(rule, rule.else_status || 'non_compliant', {
    measured: String(p.value), required, inputs,
    explanation: `${rule.parameter} "${p.value}" is not in the allowed list (${rule.values.join(', ')}). ${rule.else_explanation || ''}`.trim(),
  });
}

function extraInputs(rule, el, ctx) {
  return (rule.show_inputs || []).map((k) => [k, prop(el, k, ctx.model)]).filter(([, x]) => x)
    .map(([k, x]) => ({ name: k, value: Array.isArray(x.value) ? x.value.join(', ') : String(x.value), source: x.source }));
}

// table_lookup: the required value of `rule.key` (a steel grade) depends on a length parameter
// (thickness) and a column (material class I/II/III). Grades are compared by toughness rank.
//   rule.rows: [{ min, max, cols: { I: { MS: "A", HT: "AH" }, ... } }]   (min exclusive, max inclusive, in rule.unit)
//   rule.column_param: prop that selects the column. If it is missing every column is evaluated:
//   pass in all -> compliant; fail in all -> non_compliant; mixed -> not_enough_info.
const GRADE_RANK = { A: 0, B: 1, D: 2, E: 3, F: 4 };
export function parseSteelGrade(g) {
  const s = String(g ?? '').toUpperCase().replace(/\s+/g, '');
  let m = s.match(/^([ABDE])$/);
  if (m) return { strength: 'MS', letter: m[1] };
  m = s.match(/^(?:H([ADEF])|([ADEF])H?)(32|36|40)$/);
  if (m) return { strength: 'HT', letter: m[1] || m[2], level: +m[3] };
  return null;
}

function checkTableLookup(rule, el, ctx) {
  const { model } = ctx;
  const t = prop(el, rule.parameter, model);
  const g = prop(el, rule.key, model);
  const cols = Object.keys(rule.rows[0].cols);
  const colP = rule.column_param ? prop(el, rule.column_param, model) : null;
  const useCols = colP && cols.includes(String(colP.value)) ? [String(colP.value)] : cols;
  const required = `${rule.key} per ${rule.table_name || 'table'}`;
  if (!t) return missing(rule, el, `"${rule.parameter}"`, required);
  if (!g) return missing(rule, el, `"${rule.key}"`, required);
  if (!finite(t.value) || !(t.unit in UNIT_TO_MM)) {
    return result(rule, 'not_enough_info', { required, explanation: `"${rule.parameter}" of ${el.name} is not a length the checker can convert.` });
  }
  if (t.value <= 0) {
    return result(rule, 'not_enough_info', { required, explanation: `"${rule.parameter}" of ${el.name} is ${t.value} ${t.unit}; a thickness must be above zero. Check the design data.` });
  }
  const mm = toMM(t.value, t.unit);
  const shownT = fmtLengthInput(t, mm);
  const inputs = [{ name: rule.parameter, value: shownT, source: t.source }, { name: rule.key, value: String(g.value), source: g.source }];
  if (colP) inputs.push({ name: rule.column_param, value: String(colP.value), source: colP.source });
  const measured = `grade ${g.value}, t = ${shownT}`;
  const grade = parseSteelGrade(g.value);
  if (!grade) {
    return result(rule, 'not_enough_info', { measured, required, inputs,
      explanation: `"${g.value}" is not a hull steel grade the table covers (A, B, D, E or AH/DH/EH/FH 32-40).` });
  }
  const row = rule.rows.find((r) => mm <= toMM(r.max, rule.unit));
  if (!row) {
    return result(rule, 'not_enough_info', { measured, required, inputs,
      explanation: `Thickness ${shownT} is above the largest band of the table (${rule.rows.at(-1).max} ${rule.unit}); the table gives no grade for it.` });
  }
  const verdicts = useCols.map((c) => {
    const need = row.cols[c][grade.strength];
    return { c, need, ok: GRADE_RANK[grade.letter] >= GRADE_RANK[need[0]] };
  });
  const band = `${row.min != null ? `${row.min} < ` : ''}t ≤ ${row.max} ${rule.unit}`;
  const list = verdicts.map((v) => `Class ${v.c} needs ${v.need}${v.ok ? ' ✓' : ' ✗'}`).join(', ');
  const allOk = verdicts.every((v) => v.ok), noneOk = verdicts.every((v) => !v.ok);
  // Without the column (material class) a failure in every column may still be acceptable when the rule
  // has an exception the model cannot evaluate (UR S6: Grade A/AH outside 0.4L amidships).
  const unknownCol = !(colP && cols.includes(String(colP.value)));
  const status = allOk ? 'compliant' : noneOk && !(unknownCol && rule.unknown_column_status) ? 'non_compliant' : 'not_enough_info';
  let explanation;
  if (allOk) explanation = `Grade ${g.value} at ${shownT} meets ${useCols.length > 1 ? 'every material class' : `Class ${useCols[0]}`} for ${band}.`;
  else if (noneOk && status === 'not_enough_info') {
    explanation = `Grade ${g.value} at ${shownT} is below the grade of every material class (${list}). ${rule.unknown_column_note || ''} Set "${rule.column_param}" to decide.`.replace(/\s+/g, ' ');
  } else if (noneOk) explanation = `Grade ${g.value} at ${shownT} is below the required grade (${list}). Use a tougher grade or a thinner plate.`;
  else {
    explanation = `Grade ${g.value} at ${shownT} meets ${verdicts.filter((v) => v.ok).map((v) => `Class ${v.c}`).join('/')} but not ` +
      `${verdicts.filter((v) => !v.ok).map((v) => `Class ${v.c} (needs ${v.need})`).join(', ')}. The material class depends on the member ` +
      `category and position (${rule.column_hint || 'see the rule'}); set "${rule.column_param}" to decide.`;
  }
  return result(rule, status, { measured, required: `${band}: ${list}`, inputs, explanation });
}

// data_quality: flags design data that is not final or not usable. It never passes or fails the design:
// the outcome is compliant (data usable) or not_enough_info.
//   status_param must equal final_value; error_param lists fields holding "Error"; require_params must exist.
function checkDataQuality(rule, el, ctx) {
  const { model } = ctx;
  const issues = [], inputs = [];
  if (rule.status_param) {
    const s = prop(el, rule.status_param, model);
    if (s) {
      inputs.push({ name: rule.status_param, value: String(s.value), source: s.source });
      if (s.value !== rule.final_value) issues.push(`${rule.status_param} is "${s.value}", not "${rule.final_value}" (values may still change)`);
    }
  }
  if (rule.error_param) {
    const e = prop(el, rule.error_param, model);
    const list = e ? [].concat(e.value) : [];
    if (list.length) {
      issues.push(`${list.join(', ')} hold${list.length === 1 ? 's' : ''} "Error"`);
      inputs.push({ name: rule.error_param, value: list.join(', '), source: e.source });
    }
  }
  for (const k of rule.require_params || []) if (!prop(el, k, model)) issues.push(`"${k}" is missing`);
  return result(rule, issues.length ? 'not_enough_info' : 'compliant', {
    measured: issues.length ? issues.join('; ') : 'final and complete', required: 'final, complete design data', inputs,
    explanation: issues.length ? `Design data of ${el.name} is not ready for a final check: ${issues.join('; ')}.` : `Design data of ${el.name} is final and complete.`,
  });
}

const CHECKS = {
  in_set: checkInSet,
  table_lookup: checkTableLookup,
  data_quality: checkDataQuality,
  min: checkMinMax,
  max: checkMinMax,
  not_adjacent_zone: checkNotAdjacentZone,
  distance_min_hull: checkDistanceMinHull,
  count_min: checkCountMin,
  requires: checkRequires,
};

// ---------- rule validation ----------

export function validateRule(rule) {
  const errors = [];
  for (const f of ['id', 'source', 'clause', 'text', 'check']) if (!rule[f]) errors.push(`missing "${f}"`);
  if (rule.check && !CHECK_TYPES.includes(rule.check)) errors.push(`unknown check "${rule.check}"`);
  if (['min', 'max', 'count_min'].includes(rule.check)) {
    if (!rule.parameter) errors.push('missing "parameter"');
    if (!finite(rule.value) && !(rule.draft && rule.value == null)) errors.push('"value" must be a number (null only in a draft rule)');
  }
  if (rule.check === 'distance_min_hull' && !finite(rule.value)) errors.push('"value" must be a number');
  if (rule.beam_divisor !== undefined && !(finite(rule.beam_divisor) && rule.beam_divisor > 0)) errors.push('"beam_divisor" must be a number above zero');
  if (rule.check === 'in_set' && (!rule.parameter || !Array.isArray(rule.values))) errors.push('in_set needs "parameter" and "values"');
  if (rule.check === 'table_lookup' && (!rule.parameter || !rule.key || !Array.isArray(rule.rows) || !rule.rows.length)) errors.push('table_lookup needs "parameter", "key" and "rows"');
  if (rule.draft && !rule.draft_reason) errors.push('a draft rule needs "draft_reason"');
  if (['min', 'max', 'distance_min_hull', 'table_lookup'].includes(rule.check) && !rule.unit) errors.push('missing "unit"');
  if (rule.unit && rule.check !== 'count_min' && !(rule.unit in UNIT_TO_MM) && rule.unit !== 'ratio') errors.push(`unit "${rule.unit}" not supported`);
  if (rule.check === 'not_adjacent_zone' && !Array.isArray(rule.zones)) errors.push('missing "zones"');
  if (rule.check === 'requires' && !rule.requires?.type) errors.push('missing "requires.type"');
  if (!rule.applies_to?.types?.length) errors.push('missing "applies_to.types"');
  if (typeof rule.verified !== 'boolean') errors.push('"verified" must be true or false');
  const built = rule.applies_to?.ship?.constructed;
  if (built !== undefined) {
    if (!isObj(built) || (!built.on_or_after && !built.before)) errors.push('"constructed" needs "on_or_after" and/or "before"');
    else for (const k of ['on_or_after', 'before']) if (built[k] !== undefined && !isDay(built[k])) errors.push(`constructed.${k} must be a date YYYY-MM-DD`);
    if (built?.on_or_after && built?.before && built.on_or_after >= built.before) errors.push('constructed.on_or_after must be before constructed.before');
  }
  if (rule.relations !== undefined) {
    if (!Array.isArray(rule.relations)) errors.push('"relations" must be a list');
    else for (const r of rule.relations) {
      if (!RELATION_TYPES.includes(r?.type)) errors.push(`relation type must be one of ${RELATION_TYPES.join(', ')}`);
      if (!r?.rule || r.rule === rule.id) errors.push('a relation needs "rule" (another rule id)');
      // No relation without a source: which rule takes precedence is a legal statement, never a guess.
      if (!r?.basis?.trim?.()) errors.push('a relation needs "basis" (where the precedence is stated)');
    }
  }
  return errors;
}

// ---------- rule hierarchy ----------
// Rules apply cumulatively by default: every applicable rule must be met, so the strictest limit governs.
// A catalog rule can state that it takes another rule's place where both apply:
//   replaces - a more specific or higher-ranking provision that applies instead (e.g. a national implementation)
//   exempts  - an exemption or accepted alternative arrangement that lifts the other requirement
// Each relation names its basis (the clause that says so). Without one, nothing is superseded.
export const RELATION_TYPES = ['replaces', 'exempts'];

// Catalog-level checks: relations must point to known rules and must not go in a circle.
export function validateRelations(rules) {
  const errors = [];
  const ids = new Set(rules.map((r) => r.id));
  const edges = new Map(rules.map((r) => [r.id, (r.relations || []).map((x) => x.rule)]));
  for (const r of rules) for (const x of r.relations || []) if (!ids.has(x.rule)) errors.push(`${r.id}: relation to unknown rule "${x.rule}"`);
  const state = new Map();
  const visit = (id, path) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') { errors.push(`circular precedence: ${[...path, id].join(' > ')}`); return; }
    state.set(id, 'open');
    for (const next of edges.get(id) || []) if (ids.has(next)) visit(next, [...path, id]);
    state.set(id, 'done');
  };
  for (const r of rules) visit(r.id, []);
  return errors;
}

// Relations by rule id, built once per rule list.
const relationCache = new WeakMap();
function relationsByRule(rules) {
  let hit = relationCache.get(rules);
  if (!hit) {
    const edges = new Map(rules.filter((r) => r.relations?.length).map((r) => [r.id, r.relations]));
    const reaches = (from, to, seen = new Set()) => from === to || (!seen.has(from) && (seen.add(from), (edges.get(from) || []).some((x) => reaches(x.rule, to, seen))));
    // A circular precedence (a catalog error, see validateRelations) would let rules cancel each other out: such
    // relations are ignored, so every rule in the circle stays in force.
    hit = new Map();
    for (const [id, rels] of edges) {
      const ok = rels.filter((x) => RELATION_TYPES.includes(x.type) && String(x.basis ?? '').trim() && !reaches(x.rule, id));
      if (ok.length) hit.set(id, ok);
    }
    relationCache.set(rules, hit);
  }
  return hit;
}

// Apply the hierarchy to one element's results. A rule replaces or exempts another only when it applies here
// for certain: if its own applicability is unknown (ship particulars missing), the other rule stays in force.
// Replaced results are kept under `superseded` with the reason, never dropped silently.
function applyHierarchy(results, rules, unknownApplicability) {
  const relations = relationsByRule(rules);
  if (!relations.size) return { results, superseded: [] };
  const byId = new Map(results.map((r) => [r.rule_id, r]));
  const out = new Map();
  for (const r of results) {
    if (unknownApplicability.has(r.rule_id)) continue;
    for (const rel of relations.get(r.rule_id) || []) {
      const target = byId.get(rel.rule);
      if (target && !out.has(rel.rule)) {
        out.set(rel.rule, { rule_id: target.rule_id, source: target.source, clause: target.clause, status: target.status,
          measured: target.measured, required: target.required, by: r.rule_id, by_source: r.source, type: rel.type, basis: rel.basis });
      }
    }
  }
  return { results: results.filter((r) => !out.has(r.rule_id)), superseded: [...out.values()] };
}

// Limits on the same parameter: the strictest lower and the strictest upper limit govern; when the lower limit is
// above the upper limit no design can meet both (a rule conflict to clear with flag state or class). Rules that set
// the very same limit are marked as the same requirement, so a reviewer sees one requirement from two sources.
function limitAnalysis(results) {
  const governing = {};
  for (const r of results) {
    const l = r.limit;
    if (!l || typeof l.value !== 'number' || (l.kind !== 'min' && l.kind !== 'max')) continue;
    const key = l.kind === 'min' ? l.parameter : `${l.parameter} (upper limit)`;
    const cur = governing[key];
    const stricter = !cur || (l.kind === 'min' ? l.value > cur.value : l.value < cur.value);
    if (stricter) governing[key] = { parameter: l.parameter, rule_id: r.rule_id, kind: l.kind, value: l.value, required: r.required, count: (cur?.count ?? 0) + 1 };
    else cur.count++;
  }
  const conflicts = [];
  for (const g of Object.values(governing)) {
    if (g.kind !== 'min') continue;
    const upper = governing[`${g.parameter} (upper limit)`];
    if (upper && g.value > upper.value) {
      conflicts.push({ parameter: g.parameter, lower: { rule_id: g.rule_id, required: g.required }, upper: { rule_id: upper.rule_id, required: upper.required } });
    }
  }
  const same = new Map();
  for (const r of results) {
    const l = r.limit;
    if (!l || typeof l.value !== 'number') continue;
    const key = `${l.parameter}|${l.kind}|${l.value}`;
    same.set(key, [...(same.get(key) || []), r]);
  }
  for (const group of same.values()) {
    if (group.length > 1) for (const r of group) r.same_requirement_as = group.filter((x) => x !== r).map((x) => x.rule_id);
  }
  return { governing, conflicts };
}

// ---------- main entry ----------

// ---------- compact results ----------
// A full result carries an explanation and its inputs with their sources: text that is different for every element.
// On a large model that text is most of the memory (a 360 m cruise-ship model with 415,000 checked parts: 778 of
// 804 MB). The list, the counts, the register and the 3D colours need only the status, the measured and the required
// value. So checkModel keeps those, and computes the explanation and the inputs of an element again when something
// reads them (one element's check takes well under a millisecond; the last few hundred are cached). Rule fields
// (source, clause, text, ...) are read from the rule itself. Reading, spreading into a finding or JSON.stringify give the
// same values as before.
// Empty lists are shared by all compact elements (most parts have no superseded rule, conflict or manual check);
// frozen, so a change by mistake fails loudly instead of reaching every element.
const NONE = Object.freeze([]), NO_LIMITS = Object.freeze({});
const shared = (v) => (Array.isArray(v) ? (v.length ? v : NONE) : v && typeof v === 'object' && !Object.keys(v).length ? NO_LIMITS : v);
const RULE_FIELDS = {
  source: (r) => r.source, clause: (r) => r.clause, rule_text: (r) => r.text, text_status: (r) => r.text_status || 'paraphrase',
  basis: (r) => r.basis || 'explicit', verified: (r) => r.verified === true, review_status: (r) => r.review_status || null,
  reference_url: (r) => r.reference_url || null, related: (r) => r.related || [], check: (r) => r.check, parameter: (r) => r.parameter ?? null,
};
const JSON_FIELDS = ['rule_id', 'source', 'clause', 'rule_text', 'text_status', 'basis', 'verified', 'review_status', 'reference_url', 'related', 'check',
  'parameter', 'status', 'measured', 'required', 'explanation', 'inputs', 'limit', 'applicability', 'same_requirement_as'];
const JSON_KEYS = new Set(JSON_FIELDS);
class CompactResult {
  // Private: never copied, compared or written out. A finding inherits from its result (Object.create), so the
  // getters look the links up on the result itself.
  #rule;
  #element;
  constructor(full, rule, element) {
    this.rule_id = full.rule_id;
    this.status = full.status;
    this.measured = full.measured;
    this.required = full.required;
    if (full.applicability !== undefined) this.applicability = full.applicability;
    if (full.same_requirement_as !== undefined) this.same_requirement_as = full.same_requirement_as;
    this.#rule = rule;
    this.#element = element;
  }
  static #base(o) { while (o && !(#rule in o)) o = Object.getPrototypeOf(o); return o; }
  static ruleOf(o) { return CompactResult.#base(o)?.#rule; }
  static elementOf(o) { return CompactResult.#base(o)?.#element; }
  get explanation() { return detailOf(CompactResult.elementOf(this))?.get(this.rule_id)?.explanation ?? ''; }
  get inputs() { return detailOf(CompactResult.elementOf(this))?.get(this.rule_id)?.inputs ?? []; }
  get limit() { return detailOf(CompactResult.elementOf(this))?.get(this.rule_id)?.limit ?? null; }
  toJSON() {
    const out = {};
    for (const k of Object.keys(this)) if (!JSON_KEYS.has(k)) out[k] = this[k]; // a finding's element, name and deck first
    for (const k of JSON_FIELDS) { const v = this[k]; if (v !== undefined) out[k] = v; } // then as a full result
    return out;
  }
}
for (const [k, read] of Object.entries(RULE_FIELDS)) Object.defineProperty(CompactResult.prototype, k, { get() { return read(CompactResult.ruleOf(this)); }, enumerable: false });

// Context to compute details again: the raw model, the rules, and (for small models, or rules that look at other
// elements) the whole normalised model, built only when needed.
const KEEP_FULL_MODEL = 20000;
function detailContext(rawModel, model, rules, ctx) {
  const header = { ...model, elements: [] };
  const dctx = {
    rules, shipTypes: ctx.shipTypes, header, k: UNIT_TO_MM[model.units], defaultDeck: model.decks[0]?.id,
    deckById: ctx.deckById, cache: new Map(),
    full: model.elements.length <= KEEP_FULL_MODEL ? ctx : null,
    fullModel() {
      if (!this.full) {
        const m = normalizeModel(rawModel);
        this.full = { model: m, byId: Object.fromEntries(m.elements.map((e) => [e.id, e])), deckById: Object.fromEntries(m.decks.map((d) => [d.id, d])), shipTypes: this.shipTypes };
      }
      return this.full;
    },
  };
  return dctx;
}
const DETAIL_CACHE = 256;
function detailOf(e) {
  const src = e instanceof CompactElement ? CompactElement.sourceOf(e) : null;
  if (!src) return null;
  const dctx = src.ctx;
  const hit = dctx.cache.get(e.id);
  if (hit) return hit.byRule;
  const local = e.results.every((r) => LOCAL_CHECKS.has(r.check));
  let el, c;
  if (local) {
    const raw = src.raw;
    el = normalizeElement(raw.id === e.id ? raw : { ...raw, id: e.id }, dctx.k, dctx.defaultDeck);
    c = { model: { ...dctx.header, elements: [el] }, byId: { [el.id]: el }, deckById: dctx.deckById, shipTypes: dctx.shipTypes };
  } else {
    c = dctx.fullModel();
    el = c.byId[e.id];
  }
  const full = el ? checkElement(el, dctx.rules, c) : { results: [], governing: {} };
  const entry = { full, byRule: new Map(full.results.map((r) => [r.rule_id, r])) };
  dctx.cache.set(e.id, entry);
  if (dctx.cache.size > DETAIL_CACHE) dctx.cache.delete(dctx.cache.keys().next().value);
  return entry.byRule;
}
const fullDetailOf = (e) => (detailOf(e), CompactElement.sourceOf(e).ctx.cache.get(e.id)?.full ?? null);
// Full element result -> compact one (the element's own lists stay: superseded rules, limits, manual checks; empty
// ones are shared). The raw element and the detail context are private: never copied, compared or written out.
class CompactElement {
  #raw;
  #ctx;
  constructor(full, raw, ctx, ruleById) {
    this.id = full.id;
    this.name = full.name;
    this.type = full.type;
    this.deck = full.deck;
    this.worst = full.worst;
    this.results = NONE;
    this.not_applicable = shared(full.not_applicable);
    this.superseded = shared(full.superseded);
    this.conflicts = shared(full.conflicts);
    this.manual = shared(full.manual);
    this.#raw = raw;
    this.#ctx = ctx;
    if (full.results.length) this.results = full.results.map((r) => new CompactResult(r, ruleById.get(r.rule_id), this));
  }
  static sourceOf(e) { return { raw: e.#raw, ctx: e.#ctx }; }
  // Strictest limits per parameter (the element's detail view): from the element's details, computed when read.
  get governing() { return fullDetailOf(this)?.governing ?? {}; }
  toJSON() {
    return { id: this.id, name: this.name, type: this.type, deck: this.deck, worst: this.worst, results: this.results, not_applicable: this.not_applicable,
      superseded: this.superseded, governing: this.governing, conflicts: this.conflicts, manual: this.manual };
  }
}
const compactElement = (full, raw, dctx, ruleById) => new CompactElement(full, raw, dctx, ruleById);

// Checks that read only the element itself (plus the ship particulars): an edit to one element can be re-checked
// alone. The others look at neighbours, zones or counts and need the whole model again.
const LOCAL_CHECKS = new Set(['in_set', 'table_lookup', 'data_quality', 'min', 'max', 'manual']);

// Short hash of what an element is (type, deck, data, geometry): equal for an unchanged element in every revision.
export function elementFingerprint(el) {
  const text = JSON.stringify([el.type, el.deck, el.props ?? null, el.geom ?? null]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36) + text.length.toString(36);
}

// Values a drawing converter derived (basis measured, read or assumed) are not design data a person entered or
// confirmed. Every input of a result names its basis, so a result resting on such a value shows as a pre-check:
// pass or finding, it holds only once the value is confirmed. Inputs without a basis (design model data) stay as they are.
const UNCONFIRMED_BASIS = new Set(['measured', 'read', 'assumed']);
// An input that is a stored value (an element property or a ship particular) also names where it is stored
// (value_of: { element, prop }), so a person can confirm it (src/input-confirmations.mjs); a value computed from the
// geometry has no such place and is confirmed by checking the drawing itself.
function withBasis(inputs, el, model) {
  return inputs.map((i) => {
    const ship = /^ship\.(.+)$/.exec(i.name ?? '');
    const raw = ship ? model.ship?.[ship[1]] : el.props?.[i.name];
    const basis = i.basis ?? (ship ? raw?.basis : raw != null ? raw.basis ?? el.basis : el.basis) ?? null;
    if (!basis || i.basis) return i;
    const out = { ...i, basis };
    if (raw != null && (UNCONFIRMED_BASIS.has(basis) || basis === 'confirmed')) out.value_of = { element: ship ? '(ship)' : el.id, prop: ship ? ship[1] : i.name };
    if (basis === 'confirmed') { out.confirmed_by = raw.confirmed_by ?? ''; out.confirmed_at = raw.confirmed_at ?? ''; }
    return out;
  });
}
export const unconfirmedInputs = (r) => (r?.inputs || []).filter((i) => UNCONFIRMED_BASIS.has(i.basis));
export const confirmedInputs = (r) => (r?.inputs || []).filter((i) => i.basis === 'confirmed');

function checkElement(el, rules, ctx) {
  const { model } = ctx;
  const all = [], not_applicable = [], manual = [];
  let fp = null;
  const unknownApplicability = new Set();
  for (const rule of rules) {
    const ec = elementCondition(rule, el, model);
    if (ec.ok === false) {
      if (!ec.silent) not_applicable.push({ rule_id: rule.id, source: rule.source, reason: ec.reason });
      continue;
    }
    const sc = shipCondition(rule, model, ctx);
    if (sc.ok === false) { not_applicable.push({ rule_id: rule.id, source: rule.source, reason: sc.reason }); continue; }
    if (rule.check === 'manual') {
      // A requirement no algorithm can decide (qualitative, "to the satisfaction of the Administration", ...):
      // listed for a person to confirm, never counted as a pass. The fingerprint of the element's data lets a
      // confirmation go stale when the element changes.
      const base = { rule_id: rule.id, source: rule.source, clause: rule.clause, rule_text: rule.text, text_status: rule.text_status || 'paraphrase',
        verified: rule.verified === true, reference_url: rule.reference_url || null, evidence: rule.evidence || null, fingerprint: (fp ??= elementFingerprint(el)) };
      if (ec.ok === 'unknown') manual.push({ ...base, applicability: 'unknown', reason: `Applies only if ${rule.applies_note ?? `${ec.missing} ${ec.want}`}: ${ec.missing} is not set in the model.` });
      else if (sc.ok === 'unknown') manual.push({ ...base, applicability: 'unknown', reason: `Applies only if confirmed: ${sc.missing} is missing in the ship particulars.` });
      else manual.push({ ...base, applicability: 'applies' });
      continue;
    }
    const fn = CHECKS[rule.check];
    let r = fn
      ? fn(rule, el, ctx)
      : result(rule, 'not_enough_info', { explanation: `Unknown check type "${rule.check}".` });
    if (sc.inputs.length) r.inputs = [...r.inputs, ...sc.inputs];
    if (r.inputs.length) r.inputs = withBasis(r.inputs, el, model);
    // Whether the rule applies is open (a value its scope depends on is missing or unusable). It is never dropped:
    // when the design meets it anyway the result says so; otherwise it is "not enough info", with what the check
    // would find if the rule applies.
    if (ec.ok === 'unknown' || sc.ok === 'unknown') {
      unknownApplicability.add(rule.id);
      const why = ec.ok === 'unknown'
        ? `${ec.missing} is not set for ${el.name} (the rule applies when ${ec.missing} ${ec.want})`
        : `${sc.missing} is missing in the ship particulars`;
      r = r.status === 'compliant'
        ? { ...r, applicability: 'unknown', explanation: `${r.explanation} Whether the rule applies is open (${why}); it is met either way.` }
        : { ...r, status: 'not_enough_info', applicability: 'unknown', explanation: `Cannot decide whether this rule applies: ${why}. If it applies: ${r.explanation}` };
    }
    all.push(r);
  }

  const { results, superseded } = applyHierarchy(all, rules, unknownApplicability);
  // A rule that may not apply does not govern a limit and cannot cause a rule conflict.
  const { governing, conflicts } = limitAnalysis(results.filter((r) => r.applicability !== 'unknown'));
  const worst = results.reduce((w, r) => (STATUS_RANK[r.status] > (STATUS_RANK[w] || 0) ? r.status : w), null);
  return { id: el.id, name: el.name, type: el.type, deck: el.deck, worst, results, not_applicable, superseded, governing, conflicts, manual };
}

// Draft rules (value not known yet) are listed, never run: no value is guessed. Rules that fail validation (a missing
// or non-numeric limit, an unknown check) are not run either: a rule set brought by a user must not pass designs
// through a broken rule. Both are reported with the results.
function ruleSet(allRules) {
  const drafts = [], rules = [], invalid = [];
  for (const r of allRules) {
    if (!isObj(r)) { invalid.push({ id: '(not a rule)', errors: ['not an object'] }); continue; }
    if (r.draft) { drafts.push(r); continue; }
    const errors = validateRule(r);
    if (errors.length) invalid.push({ id: r.id || '(no id)', source: r.source ?? null, errors });
    else rules.push(r);
  }
  return { drafts, rules, invalid, shipTypes: shipTypesOf(allRules) };
}

function checkContext(rawModel, allRules) {
  const model = normalizeModel(rawModel);
  const { drafts, rules, invalid, shipTypes } = ruleSet(allRules);
  const byId = Object.fromEntries(model.elements.map((e) => [e.id, e]));
  const deckById = Object.fromEntries(model.decks.map((d) => [d.id, d]));
  return { model, drafts, rules, invalid, ctx: { model, byId, deckById, shipTypes } };
}

// details: 'lazy' (default) keeps compact results and computes explanations and inputs when they are read;
// 'eager' builds every full result at once (server responses, the command line, files written to disk).
export function checkModel(rawModel, allRules, { details = 'lazy' } = {}) {
  const { model, drafts, rules, invalid, ctx } = checkContext(rawModel, allRules);
  const elements = {};
  const summary = { compliant: 0, non_compliant: 0, not_enough_info: 0 };
  const elementSummary = { compliant: 0, non_compliant: 0, not_enough_info: 0, no_rule: 0 };
  const lazy = details !== 'eager';
  const dctx = lazy ? detailContext(rawModel, model, rules, ctx) : null;
  const ruleById = new Map(rules.map((r) => [r.id, r]));

  model.elements.forEach((el, i) => {
    const full = checkElement(el, rules, ctx);
    const e = lazy ? compactElement(full, model.sources?.[i] ?? el, dctx, ruleById) : full;
    e.results.forEach((r) => summary[r.status]++);
    elementSummary[e.worst ?? 'no_rule']++;
    elements[el.id] = e;
  });

  return {
    model: model.name,
    schema: model.schema,
    rule_count: rules.length,
    rules_verified: rules.filter((r) => r.verified === true).length,
    draft_rules: drafts.map((r) => ({ id: r.id, source: r.source, clause: r.clause, reason: r.draft_reason })),
    invalid_rules: invalid,
    model_issues: model.issues || [],
    summary,
    element_summary: elementSummary,
    elements,
  };
}

// Re-check only the elements in `ids` after an edit (what-if editing on a model with tens of thousands of parts):
// same output as checkModel on the edited model. Falls back to a full check when a rule in the set looks beyond
// the element itself, when an element is new or gone, or when there is no previous result to start from.
// Raw elements by id, per elements array (rebuilt when the array is replaced or changes length).
const rawIndex = new WeakMap();
function rawElementsById(elements) {
  let hit = rawIndex.get(elements);
  if (!hit || hit.length !== elements.length) {
    hit = { length: elements.length, byId: new Map(elements.map((e) => [e.id, e])) };
    rawIndex.set(elements, hit);
  }
  return hit.byId;
}

// inPlace: update previous.elements itself instead of copying it (copying 100,000 entries costs more than the
// re-check); the returned object is still a new one, so callers can tell that the results changed.
export function recheckElements(previous, rawModel, allRules, ids, { inPlace = false } = {}) {
  const { rules, drafts, invalid, shipTypes } = ruleSet(allRules);
  const local = rules.every((r) => LOCAL_CHECKS.has(r.check));
  const elementsRaw = rawModel?.__normalized ? null : rawModel?.elements;
  // Elements renamed or skipped by normalizeModel (duplicate or missing ids): only a full check keeps them apart.
  if (!previous?.elements || !local || !Array.isArray(elementsRaw) || previous.model_issues?.length) return checkModel(rawModel, allRules);
  const wanted = [...new Set(ids)];
  const byRaw = rawElementsById(elementsRaw);
  if (wanted.some((id) => !previous.elements[id] || !byRaw.has(id))) return checkModel(rawModel, allRules);
  // Local rules read one element and the ship particulars: normalise the model header and only the edited elements,
  // so an edit costs the same on 100 elements and on 100,000.
  const header = normalizeModel({ ...rawModel, elements: [] });
  const k = UNIT_TO_MM[header.units];
  const edited = wanted.map((id) => normalizeElement(byRaw.get(id), k, header.decks[0]?.id));
  const model = { ...header, elements: edited };
  const ctx = { model, byId: Object.fromEntries(edited.map((e) => [e.id, e])), deckById: Object.fromEntries(header.decks.map((d) => [d.id, d])), shipTypes };
  const summary = { ...previous.summary };
  const elementSummary = { ...previous.element_summary };
  const elements = inPlace ? previous.elements : { ...previous.elements };
  // Same form as the previous results: compact when they were compact.
  let lazy = false;
  for (const id in previous.elements) { lazy = previous.elements[id] instanceof CompactElement; break; }
  const dctx = lazy ? detailContext(rawModel, model, rules, ctx) : null;
  const ruleById = new Map(rules.map((r) => [r.id, r]));
  for (const el of edited) {
    const before = elements[el.id];
    before.results.forEach((r) => summary[r.status]--);
    elementSummary[before.worst ?? 'no_rule']--;
    const full = checkElement(el, rules, ctx);
    const after = lazy ? compactElement(full, byRaw.get(el.id), dctx, ruleById) : full;
    after.results.forEach((r) => summary[r.status]++);
    elementSummary[after.worst ?? 'no_rule']++;
    elements[el.id] = after;
  }
  return {
    ...previous,
    model: header.name,
    schema: header.schema,
    rule_count: rules.length,
    rules_verified: rules.filter((r) => r.verified === true).length,
    draft_rules: drafts.map((r) => ({ id: r.id, source: r.source, clause: r.clause, reason: r.draft_reason })),
    invalid_rules: invalid,
    summary,
    element_summary: elementSummary,
    elements,
  };
}

// Manual checks of all elements (requirements a person has to confirm), in model order.
export function manualChecksOf(results) {
  const out = [];
  for (const e of Object.values(results.elements)) for (const m of e.manual || []) out.push({ element: e.id, name: e.name, deck: e.deck, ...m });
  return out;
}

// What the automatic check covers, per instrument: rules run automatically vs. requirements left to a person, counted
// over the rules that apply to at least one element of this model. Requirements that are not in the catalog at all
// are not covered by either and are not counted here.
export function coverageOf(results, rules) {
  const auto = new Map(), manual = new Map();
  const add = (map, source, id) => { if (!map.has(source)) map.set(source, new Set()); map.get(source).add(id); };
  for (const e of Object.values(results.elements)) {
    for (const r of [...e.results, ...(e.superseded || [])]) add(auto, r.source, r.rule_id);
    for (const m of e.manual || []) add(manual, m.source, m.rule_id);
  }
  const sources = [...new Set([...auto.keys(), ...manual.keys()])].sort();
  const bySource = sources.map((source) => ({ source, automatic: auto.get(source)?.size ?? 0, manual: manual.get(source)?.size ?? 0 }));
  const verified = new Set(rules.filter((r) => r.verified === true).map((r) => r.id));
  const autoIds = new Set([...auto.values()].flatMap((x) => [...x]));
  return {
    by_source: bySource,
    automatic: autoIds.size,
    manual: new Set([...manual.values()].flatMap((x) => [...x])).size,
    automatic_verified: [...autoIds].filter((id) => verified.has(id)).length,
  };
}

// Flat list of findings (everything that is not compliant), worst first, in model order.
export function findingsOf(results) {
  const out = [];
  for (const e of Object.values(results.elements)) {
    for (const r of e.results) {
      if (r.status === 'compliant') continue;
      // A compact result is not copied: the finding inherits from it, so its explanation is computed only if read.
      out.push(r instanceof CompactResult ? Object.assign(Object.create(r), { element: e.id, name: e.name, deck: e.deck }) : { element: e.id, name: e.name, deck: e.deck, ...r });
    }
  }
  return out.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
}
