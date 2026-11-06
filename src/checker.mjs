// Deterministic rule checker. Pure functions, no I/O: the same module runs in Node (CLI, server, tests)
// and in the browser (instant re-check while editing). Same model + same rules = same result.
//
// Status per (element, rule):
//   compliant        the design value meets the rule
//   non_compliant    the design value violates the rule
//   not_enough_info  a value needed to decide is missing (never guessed)

export const UNIT_TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, ft: 304.8 };
export const STATUS_RANK = { non_compliant: 3, not_enough_info: 2, compliant: 1 };
export const CHECK_TYPES = ['min', 'max', 'not_adjacent_zone', 'distance_min_hull', 'count_min', 'requires'];
const ADJACENCY_TOLERANCE_MM = 50;
const DEFAULT_DECK_HEIGHT_MM = 2800;
const SHIP_LENGTH_KEYS = new Set(['length_overall', 'beam', 'draft', 'depth']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;

// ---------- values and units ----------

// A value in the model is either plain (`850`, in the model's units) or annotated
// (`{ "value": 850, "unit": "mm", "source": "GA drawing 101" }`). Returns null when missing.
export function readValue(v, defaultUnit, defaultSource) {
  if (v == null) return null;
  if (isObj(v) && 'value' in v) {
    if (v.value == null) return null;
    return { value: v.value, unit: v.unit ?? defaultUnit, source: v.source ?? defaultSource, note: v.note };
  }
  return { value: v, unit: defaultUnit, source: defaultSource };
}

export function toMM(value, unit) {
  const k = UNIT_TO_MM[unit];
  if (k == null) throw new Error(`Unsupported length unit "${unit}"`);
  return value * k;
}

export const fmtMM = (mm) => `${round(mm)} mm`;
export const fmtRatio = (v) => (v > 0 ? `1:${round(1 / v, 1)} (${round(v * 100, 1)}%)` : `${v}`);

function fmtLengthInput(rv, mm) {
  return rv.unit === 'mm' ? fmtMM(mm) : `${rv.value} ${rv.unit} (${fmtMM(mm)})`;
}

// ---------- model normalisation ----------

// Accepts ship.json (multi-deck) and the older deck.json (one deck). Geometry is converted to mm;
// element props are kept as written so the original unit can be shown.
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

  const elements = (raw.elements || []).map((el) => {
    const g = el.geom;
    return {
      ...el,
      deck: el.deck ?? decks[0]?.id,
      geom_mm: g ? { x: g.x * k, y: g.y * k, z: (g.z ?? 0) * k, lx: g.lx * k, ly: g.ly * k, h: (g.h ?? 0) * k } : null,
    };
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
    hull: raw.hull,
    demo: raw.demo,
  };
}

export function prop(el, key, model) {
  return readValue(el.props?.[key], model.units, el.source || model.source || 'not stated');
}

function shipValue(model, key) {
  return readValue(model.ship?.[key], model.units, model.ship?.source || 'not stated');
}

// ---------- applicability ----------

function elementCondition(rule, el, model) {
  const a = rule.applies_to || {};
  if (a.types && !a.types.includes(el.type)) return { ok: false, silent: true };
  for (const [key, want] of Object.entries(a.where || {})) {
    const p = prop(el, key, model);
    if (!p || p.value !== want) {
      return { ok: false, reason: `${key} is ${p ? JSON.stringify(p.value) : 'not set'}; rule applies when ${key} = ${JSON.stringify(want)}` };
    }
  }
  return { ok: true };
}

// Ship-level conditions: ship type, operating area, minimum size, class society.
// Returns ok:true | ok:false (not applicable) | ok:'unknown' (ship data missing -> not_enough_info).
function shipCondition(rule, model) {
  const c = rule.applies_to?.ship;
  if (!c) return { ok: true, inputs: [] };
  const inputs = [];
  const need = (key) => {
    const v = shipValue(model, key);
    if (v) {
      const shown = Array.isArray(v.value) ? v.value.join(', ')
        : SHIP_LENGTH_KEYS.has(key) && v.unit in UNIT_TO_MM ? fmtLengthInput(v, toMM(v.value, v.unit)) : String(v.value);
      inputs.push({ name: `ship.${key}`, value: shown, source: v.source });
    }
    return v;
  };
  const unknown = (key) => ({ ok: 'unknown', missing: `ship.${key}`, inputs });

  if (c.type_in) {
    const t = need('type');
    if (!t) return unknown('type');
    if (!c.type_in.includes(t.value)) return { ok: false, reason: `ship type is "${t.value}"; rule applies to ${c.type_in.join(' / ')}` };
  }
  if (c.operating_area_any) {
    const a = need('operating_area');
    if (!a) return unknown('operating_area');
    const areas = [].concat(a.value);
    if (!areas.some((x) => c.operating_area_any.includes(x))) {
      return { ok: false, reason: `operating area is ${areas.join(', ')}; rule applies in ${c.operating_area_any.join(' / ')}` };
    }
  }
  for (const [key, want] of Object.entries(c.equals || {})) {
    const v = need(key);
    if (!v) return unknown(key);
    if (v.value !== want) return { ok: false, reason: `ship.${key} is "${v.value}"; rule applies when it is "${want}"` };
  }
  for (const [key, lim] of Object.entries(c.min || {})) {
    const v = need(key);
    if (!v) return unknown(key);
    const limit = readValue(lim, null);
    let have = v.value, want = limit.value, shown = `${want}`;
    if (limit.unit) {
      have = toMM(v.value, v.unit);
      want = toMM(limit.value, limit.unit);
      shown = `${limit.value} ${limit.unit}`;
    }
    if (!(have >= want)) return { ok: false, reason: `ship.${key} is ${v.value}${v.unit && limit.unit ? ' ' + v.unit : ''}; rule applies from ${shown}` };
  }
  return { ok: true, inputs };
}

// ---------- geometry ----------

function rectOf(el) {
  const g = el.geom_mm;
  return g && { x0: g.x, y0: g.y, x1: g.x + g.lx, y1: g.y + g.ly };
}

function zRange(el, deckById) {
  const g = el.geom_mm;
  const base = (deckById[el.deck]?.elevation_mm ?? 0) + g.z;
  return [base, base + g.h];
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
  if (!el.geom_mm) return [];
  const a = rectOf(el), [az0, az1] = zRange(el, deckById);
  const tol = ADJACENCY_TOLERANCE_MM;
  const out = [];
  for (const o of model.elements) {
    if (o === el || !o.geom_mm || o.virtual) continue;
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
  const inputs = [{ name: rule.parameter, value: shown, source: p.source }];
  const ok = rule.check === 'min' ? v >= limitVal : v <= limitVal;
  let explanation;
  if (ok) explanation = `${rule.parameter} is ${shown}; requirement ${required} is met.`;
  else if (rule.check === 'min') explanation = `${rule.parameter} is ${shown}, but must be ${required}. Short by ${isLength ? fmtMM(limitVal - v) : round(limitVal - v, 4)}.`;
  else explanation = `${rule.parameter} is ${shown}, but must be ${required}. Exceeds the limit by ${isLength ? fmtMM(v - limitVal) : rule.unit === 'ratio' ? `${round((v - limitVal) * 100, 1)} percentage points` : round(v - limitVal, 4)}.`;
  return result(rule, ok ? 'compliant' : 'non_compliant', { measured: shown, required, explanation, inputs, limit: { ...limit, measured: v } });
}

function checkNotAdjacentZone(rule, el, ctx) {
  const { model, byId, deckById } = ctx;
  const required = `not next to: ${rule.zones.join(', ')} spaces`;
  const declared = prop(el, 'adjacent', model);
  let neighbours, source;
  if (declared) {
    neighbours = [].concat(declared.value).map((id) => byId[id]).filter(Boolean);
    source = declared.source;
  } else if (el.geom_mm) {
    neighbours = geometricNeighbours(el, model, deckById);
    source = `derived from 3D geometry (shared boundary within ${ADJACENCY_TOLERANCE_MM} mm)`;
  } else {
    return missing(rule, el, 'Adjacency (props.adjacent or geometry)', required);
  }
  const zoneOf = (s) => prop(s, 'zone', model)?.value ?? 'unknown';
  const listed = neighbours.map((s) => `${s.name} [${zoneOf(s)}]`).join(', ') || 'none';
  const inputs = [{ name: 'adjacent spaces', value: listed, source }];
  const bad = neighbours.filter((s) => rule.zones.includes(zoneOf(s)));
  return result(rule, bad.length ? 'non_compliant' : 'compliant', {
    measured: `adjacent: ${listed}`, required, inputs,
    explanation: bad.length
      ? `${el.name} borders ${bad.map((s) => `${s.name} (${s.id})`).join(', ')}, which ${bad.length > 1 ? 'are' : 'is'} in the ${rule.zones.join('/')} zone. Move the tank or add a separating space (e.g. cofferdam or void).`
      : `${el.name} does not border any ${rule.zones.join('/')} space.`,
  });
}

function checkDistanceMinHull(rule, el, ctx) {
  const { model, deckById } = ctx;
  let limitVal = toMM(rule.value, rule.unit);
  let required = `≥ ${fmtMM(limitVal)} from the ship side`;
  const inputs = [];
  if (rule.beam_divisor) {
    const b = shipValue(model, 'beam');
    if (!b) return missing(rule, el, 'Ship beam (ship.beam)', `≥ min(B/${rule.beam_divisor}, ${fmtMM(limitVal)}) from the ship side`);
    const bmm = toMM(b.value, b.unit);
    inputs.push({ name: 'ship.beam', value: fmtLengthInput(b, bmm), source: b.source });
    limitVal = Math.min(bmm / rule.beam_divisor, limitVal);
    required = `≥ min(B/${rule.beam_divisor}, ${fmtMM(toMM(rule.value, rule.unit))}) = ${fmtMM(limitVal)} from the ship side`;
  }
  const limit = { kind: 'min', parameter: 'distance_to_side', value: limitVal };
  const deck = deckById[el.deck];
  if (!el.geom_mm) return { ...missing(rule, el, 'Geometry (geom)', required, inputs), limit };
  if (!deck?.side_lines_mm?.length) return { ...missing(rule, el, `Ship side line of deck "${el.deck}"`, required, inputs), limit };
  const d = Math.min(...deck.side_lines_mm.map((line) => rectToPolylineDistance(rectOf(el), line)));
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
    e.type === req.type && Object.entries(req.where || {}).every(([k, v]) => prop(e, k, model)?.value === v));
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

const CHECKS = {
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
    if (typeof rule.value !== 'number') errors.push('"value" must be a number');
  }
  if (['min', 'max', 'distance_min_hull'].includes(rule.check) && !rule.unit) errors.push('missing "unit"');
  if (rule.unit && rule.check !== 'count_min' && !(rule.unit in UNIT_TO_MM) && rule.unit !== 'ratio') errors.push(`unit "${rule.unit}" not supported`);
  if (rule.check === 'not_adjacent_zone' && !Array.isArray(rule.zones)) errors.push('missing "zones"');
  if (rule.check === 'requires' && !rule.requires?.type) errors.push('missing "requires.type"');
  if (!rule.applies_to?.types?.length) errors.push('missing "applies_to.types"');
  if (typeof rule.verified !== 'boolean') errors.push('"verified" must be true or false');
  return errors;
}

// ---------- main entry ----------

export function checkModel(rawModel, rules) {
  const model = normalizeModel(rawModel);
  const byId = Object.fromEntries(model.elements.map((e) => [e.id, e]));
  const deckById = Object.fromEntries(model.decks.map((d) => [d.id, d]));
  const ctx = { model, byId, deckById };

  const elements = {};
  const summary = { compliant: 0, non_compliant: 0, not_enough_info: 0 };
  const elementSummary = { compliant: 0, non_compliant: 0, not_enough_info: 0, no_rule: 0 };

  for (const el of model.elements) {
    const results = [], not_applicable = [];
    for (const rule of rules) {
      const ec = elementCondition(rule, el, model);
      if (!ec.ok) {
        if (!ec.silent) not_applicable.push({ rule_id: rule.id, source: rule.source, reason: ec.reason });
        continue;
      }
      const sc = shipCondition(rule, model);
      if (sc.ok === false) { not_applicable.push({ rule_id: rule.id, source: rule.source, reason: sc.reason }); continue; }
      if (sc.ok === 'unknown') {
        results.push(result(rule, 'not_enough_info', {
          inputs: sc.inputs,
          explanation: `Cannot decide whether this rule applies: ${sc.missing} is missing in the ship particulars.`,
        }));
        continue;
      }
      const fn = CHECKS[rule.check];
      const r = fn
        ? fn(rule, el, ctx)
        : result(rule, 'not_enough_info', { explanation: `Unknown check type "${rule.check}".` });
      if (sc.inputs.length) r.inputs = [...r.inputs, ...sc.inputs];
      results.push(r);
    }

    // Overlap: several rules limiting the same parameter -> the strictest one governs.
    const governing = {};
    for (const r of results) {
      const l = r.limit;
      if (!l || typeof l.value !== 'number') continue;
      const cur = governing[l.parameter];
      const stricter = !cur || (l.kind === 'min' ? l.value > cur.value : l.value < cur.value);
      if (stricter) governing[l.parameter] = { rule_id: r.rule_id, kind: l.kind, value: l.value, required: r.required, count: (cur?.count ?? 0) + 1 };
      else cur.count++;
    }

    results.forEach((r) => summary[r.status]++);
    const worst = results.reduce((w, r) => (STATUS_RANK[r.status] > (STATUS_RANK[w] || 0) ? r.status : w), null);
    elementSummary[worst ?? 'no_rule']++;
    elements[el.id] = { id: el.id, name: el.name, type: el.type, deck: el.deck, worst, results, not_applicable, governing };
  }

  return {
    model: model.name,
    schema: model.schema,
    rule_count: rules.length,
    rules_verified: rules.filter((r) => r.verified === true).length,
    summary,
    element_summary: elementSummary,
    elements,
  };
}

// Flat list of findings (everything that is not compliant), worst first, in model order.
export function findingsOf(results) {
  const out = [];
  for (const e of Object.values(results.elements)) {
    for (const r of e.results) if (r.status !== 'compliant') out.push({ element: e.id, name: e.name, deck: e.deck, ...r });
  }
  return out.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status]);
}
