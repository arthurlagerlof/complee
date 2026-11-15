// Apply AI escape-route suggestions to a copy of a model and verify them with the deterministic route analysis.
// An AI suggestion is only a list of actions; whether it helps is decided here, by recomputing the routes.
//
// Actions (model units mm, footprints axis-aligned like the rest of the model):
//   add_passage { deck, from_element, to_element, clear_width_mm }  a new corridor on one deck between two elements
//   add_door    { deck, from_element, to_element, clear_width_mm }  a new door where two elements touch
import { normalizeModel } from './checker.mjs';
import { analyzeEscape } from './escape.mjs';

const TOUCH_MM = 60;

function footprint(el, units) {
  const k = { mm: 1, cm: 10, m: 1000 }[units] ?? 1;
  const g = el.geom;
  return g ? { x: g.x * k, y: g.y * k, lx: g.lx * k, ly: g.ly * k } : null;
}

// Is the element present on the deck? A stair, ladder or trunk is also present on the deck at its upper end.
function onDeck(el, deck, model) {
  if (el.deck === deck) return true;
  if (!['stair', 'ladder', 'escape_trunk'].includes(el.type)) return false;
  const decks = [...model.decks].sort((a, b) => a.elevation - b.elevation);
  const i = decks.findIndex((d) => d.id === el.deck);
  return i >= 0 && decks[i + 1]?.id === deck;
}

const overlap = (a0, a1, b0, b1) => Math.min(a1, b1) - Math.max(a0, b0);
// What a new passage or door may cross: other circulation (it joins it). Anything else (a cabin, a tank, the engine
// room) would be cut through, which is not a buildable proposal.
const PASSABLE = new Set(['corridor', 'stair', 'ladder', 'escape_trunk', 'ramp', 'door', 'muster_station', 'guard_rail', 'liferaft']);
const passable = (el) => PASSABLE.has(el.type) || el.props?.zone === 'open_deck' || el.props?.zone?.value === 'open_deck';
function insidePolygon([px, py], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Elements a new box (mm) cuts through on its deck, and whether it leaves the deck outline.
function collisions(model, units, deck, box, ends) {
  const hits = [];
  for (const el of model.elements) {
    if (ends.includes(el) || passable(el) || el.proposed || el.virtual || el.type === 'escape_zone') continue; // zones are areas, not walls
    const f = footprint(el, units);
    if (!f || !onDeck(el, deck, model)) continue;
    if (overlap(box.x, box.x + box.lx, f.x, f.x + f.lx) > TOUCH_MM && overlap(box.y, box.y + box.ly, f.y, f.y + f.ly) > TOUCH_MM) hits.push(el.id);
  }
  const k = { mm: 1, cm: 10, m: 1000 }[units] ?? 1;
  const outline = model.decks.find((d) => d.id === deck)?.outline?.map(([x, y]) => [x * k, y * k]);
  const corners = [[box.x, box.y], [box.x + box.lx, box.y], [box.x + box.lx, box.y + box.ly], [box.x, box.y + box.ly]];
  const outside = outline?.length >= 3 && corners.some((c) => !insidePolygon(c, outline));
  return { hits, outside };
}

/** Corridor boxes (one straight piece, or an L of two) joining the facing sides of two footprints. */
export function passageBoxes(a, b, w) {
  const ox = overlap(a.x, a.x + a.lx, b.x, b.x + b.lx);
  const oy = overlap(a.y, a.y + a.ly, b.y, b.y + b.ly);
  if (ox >= w) { // side by side in y: a straight piece along y
    const x = Math.max(a.x, b.x) + (ox - w) / 2;
    const [lo, hi] = a.y < b.y ? [a, b] : [b, a];
    const y0 = lo.y + lo.ly - 1, y1 = hi.y + 1; // 1 mm into each, so the analysis sees the openings
    return y1 > y0 ? [{ x, y: y0, lx: w, ly: y1 - y0 }] : [];
  }
  if (oy >= w) { // side by side in x: a straight piece along x
    const y = Math.max(a.y, b.y) + (oy - w) / 2;
    const [lo, hi] = a.x < b.x ? [a, b] : [b, a];
    const x0 = lo.x + lo.lx - 1, x1 = hi.x + 1;
    return x1 > x0 ? [{ x: x0, y, lx: x1 - x0, ly: w }] : [];
  }
  // Diagonal neighbours: an L from the middle of a to the middle of b (x leg at a's middle y, then y leg).
  const ac = { x: a.x + a.lx / 2, y: a.y + a.ly / 2 }, bc = { x: b.x + b.lx / 2, y: b.y + b.ly / 2 };
  const legX = { x: Math.min(ac.x, bc.x) - w / 2, y: ac.y - w / 2, lx: Math.abs(bc.x - ac.x) + w, ly: w };
  const legY = { x: bc.x - w / 2, y: Math.min(ac.y, bc.y) - w / 2, lx: w, ly: Math.abs(bc.y - ac.y) + w };
  return [legX, legY];
}

/** Door box at the middle of the shared boundary of two touching footprints, or null when they do not touch. */
export function doorBox(a, b, w) {
  const ox = overlap(a.x - TOUCH_MM, a.x + a.lx + TOUCH_MM, b.x, b.x + b.lx);
  const oy = overlap(a.y - TOUCH_MM, a.y + a.ly + TOUCH_MM, b.y, b.y + b.ly);
  if (ox <= 0 || oy <= 0) return null;
  const x0 = Math.max(a.x, b.x), x1 = Math.min(a.x + a.lx, b.x + b.lx);
  const y0 = Math.max(a.y, b.y), y1 = Math.min(a.y + a.ly, b.y + b.ly);
  if (x1 - x0 >= y1 - y0) { // boundary runs along x
    if (x1 - x0 < w) return null;
    const cx = (x0 + x1) / 2, cy = (Math.min(a.y + a.ly, b.y + b.ly) + Math.max(a.y, b.y)) / 2;
    return { x: cx - w / 2, y: cy - 150, lx: w, ly: 300 };
  }
  if (y1 - y0 < w) return null;
  const cy = (y0 + y1) / 2, cx = (Math.min(a.x + a.lx, b.x + b.lx) + Math.max(a.x, b.x)) / 2;
  return { x: cx - 150, y: cy - w / 2, lx: 300, ly: w };
}

/**
 * Apply one suggestion to a copy of the raw model. Returns { model, added, problems } where added are the new
 * elements (for drawing) and problems are actions that could not be applied (unknown ids, not on that deck ...).
 */
export function applySuggestion(raw, suggestion, tag = 'AI') {
  const model = structuredClone(raw);
  const units = model.units || 'mm';
  const k = { mm: 1, cm: 10, m: 1000 }[units] ?? 1;
  const byId = Object.fromEntries(model.elements.map((e) => [e.id, e]));
  const decks = new Set(model.decks.map((d) => d.id));
  const added = [], problems = [], conflicts = [], notes = [];
  let n = 0;
  for (const action of suggestion.actions ?? []) {
    const a = byId[action.from_element], b = byId[action.to_element];
    const w = Math.max(600, Math.min(3000, Number(action.clear_width_mm) || 1000));
    if (!decks.has(action.deck)) { problems.push(`unknown deck ${action.deck}`); continue; }
    if (!a || !b) { problems.push(`unknown element ${!a ? action.from_element : action.to_element}`); continue; }
    if (!onDeck(a, action.deck, model) || !onDeck(b, action.deck, model)) { problems.push(`${a.id} or ${b.id} is not on deck ${action.deck}`); continue; }
    const fa = footprint(a, units), fb = footprint(b, units);
    const boxes = action.type === 'add_door' ? [doorBox(fa, fb, w)].filter(Boolean) : passageBoxes(fa, fb, w);
    if (!boxes.length) { problems.push(`${action.type} ${a.id}–${b.id}: ${action.type === 'add_door' ? 'the elements do not touch' : 'no straight connection'}`); continue; }
    for (const box of boxes) {
      const { hits, outside } = collisions(model, units, action.deck, box, [a, b]);
      if (hits.length) conflicts.push(`${action.type} ${a.id}–${b.id} cuts through ${hits.join(', ')}`);
      // Outside the deck outline: an external walkway (e.g. to an outside stair). Possible, but it needs a structure.
      if (outside) notes.push(`${action.type} ${a.id}–${b.id} runs partly outside the outline of deck ${action.deck} (an external walkway: check it is supported)`);
      const el = {
        id: `${tag}-${++n}`, type: action.type === 'add_door' ? 'door' : 'corridor',
        name: `${action.type === 'add_door' ? 'Proposed door' : 'Proposed passage'} ${a.id} – ${b.id}`,
        deck: action.deck, source: 'AI suggestion (not in the design)', proposed: true,
        geom: { x: box.x / k, y: box.y / k, lx: box.lx / k, ly: box.ly / k, h: (action.type === 'add_door' ? 2100 : 150) / k },
        props: { clear_width: w / k, ...(action.type === 'add_door' ? {} : { dead_end_length: 0 }), zone: 'circulation' },
      };
      model.elements.push(el);
      added.push(el);
    }
  }
  return { model, added, problems, conflicts, notes: [...new Set(notes)] };
}

const RANK = { no_route: 0, single_route: 1, shared_route: 2, two_routes: 3, direct: 3 };

/** Recompute the routes with the suggestion applied and compare room by room. */
export function verifySuggestion(raw, suggestion, current = analyzeEscape(normalizeModel(structuredClone(raw)))) {
  const { model, added, problems, conflicts, notes } = applySuggestion(raw, suggestion);
  if (!added.length) return { ok: false, improved: [], worse: [], added, problems, conflicts, notes, model };
  const after = analyzeEscape(normalizeModel(structuredClone(model)));
  const improved = [], worse = [];
  for (const [id, o] of Object.entries(current.origins)) {
    if (!o.room) continue;
    const now = after.origins[id];
    if (!now) continue;
    if (RANK[now.status] > RANK[o.status]) improved.push(id);
    else if (RANK[now.status] < RANK[o.status]) worse.push(id);
  }
  // Better routes count only for a buildable proposal: nothing cut through, nothing outside the deck.
  return { ok: improved.length > 0 && !worse.length && !conflicts.length, improved, worse, added, problems, conflicts, notes, model, after };
}
