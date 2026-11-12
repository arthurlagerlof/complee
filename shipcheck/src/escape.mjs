// Escape-route analysis of a normalised ship model (deterministic graph search, no AI, no rule values).
//
// The walkable network is derived from the geometry of the model:
//   - corridors, stairs, ladders, escape trunks, ramps, doors, open decks and muster stations are circulation;
//   - two elements on the same deck are connected where they overlap or share a boundary of at least
//     MIN_OPENING_MM (a gap wider than TOLERANCE_MM is a closed bulkhead);
//   - a stair, ladder or escape trunk also connects its deck to the deck at its upper end;
//   - an ordinary room is a start point. It is only passed through on the way to a door, stair, ladder or
//     escape trunk that opens into it (never as a shortcut between two corridors).
// For every room the shortest route to a muster station is searched, then an alternative that shares no
// stair, ladder, escape trunk or door with it. This is an analysis aid: compliance statuses still come only
// from the rule checker (src/checker.mjs).
import { readValue, toMM } from './checker.mjs';

export const TOLERANCE_MM = 50;
export const MIN_OPENING_MM = 700;
export const VERTICAL_TYPES = new Set(['stair', 'ladder', 'escape_trunk']);
const CIRCULATION_TYPES = new Set(['corridor', 'stair', 'ladder', 'escape_trunk', 'ramp', 'door', 'muster_station']);
const ROOM_TYPES = new Set(['space', 'machinery_space']);
export const ESCAPE_LABEL = {
  two_routes: 'Two independent routes',
  single_route: 'Single route only',
  no_route: 'No route to a muster station',
  direct: 'Direct access to the muster station',
};

const isOpenDeck = (el) => el.props?.zone === 'open_deck';
export const isCirculation = (el) => CIRCULATION_TYPES.has(el.type) || (el.type === 'space' && isOpenDeck(el));
export const isRoom = (el) => ROOM_TYPES.has(el.type) && !isOpenDeck(el);
const isGate = (el) => el.type === 'door' || VERTICAL_TYPES.has(el.type);

function upperDeck(el, decks, deckById) {
  const top = deckById[el.deck].elevation_mm + el.geom_mm.h;
  let best = null;
  for (const d of decks) {
    if (d.id === el.deck || d.elevation_mm <= deckById[el.deck].elevation_mm) continue;
    const miss = Math.abs(d.elevation_mm - top);
    if (miss <= 700 && (!best || miss < best.miss)) best = { id: d.id, miss };
  }
  return best?.id ?? null;
}

// Overlap of two footprints, each grown by the tolerance. Returns the centre of the opening or null.
function opening(a, b) {
  const t = TOLERANCE_MM;
  const x0 = Math.max(a.x - t, b.x - t), x1 = Math.min(a.x + a.lx + t, b.x + b.lx + t);
  const y0 = Math.max(a.y - t, b.y - t), y1 = Math.min(a.y + a.ly + t, b.y + b.ly + t);
  if (x1 <= x0 || y1 <= y0) return null;
  if (Math.max(x1 - x0, y1 - y0) < MIN_OPENING_MM + 2 * t) return null;
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: Math.max(x1 - x0, y1 - y0) - 2 * t };
}

const centre = (g) => ({ x: g.x + g.lx / 2, y: g.y + g.ly / 2 });
const horizontal = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

export function buildEscapeGraph(model, { blocked = new Set() } = {}) {
  const deckById = Object.fromEntries(model.decks.map((d) => [d.id, d]));
  const els = model.elements.filter((e) => e.geom_mm && !e.virtual && deckById[e.deck] && (isCirculation(e) || isRoom(e)) && !blocked.has(e.id));
  const byId = Object.fromEntries(els.map((e) => [e.id, e]));
  const musterTypes = new Set(model.escape?.muster_types ?? ['muster_station']);

  // A presence is one element on one deck (vertical connectors have two).
  const presences = [];
  const upper = {};
  for (const el of els) {
    presences.push({ el, deck: el.deck });
    if (VERTICAL_TYPES.has(el.type)) {
      upper[el.id] = upperDeck(el, model.decks, deckById);
      if (upper[el.id]) presences.push({ el, deck: upper[el.id] });
    }
  }
  const nodes = []; // portal: { x, y, z, deck, a, b }; centre: { x, y, z, deck, centre: id }
  const adj = []; // node index -> [{ to, cost, el, vertical }]
  const portalsOf = new Map(); // `${id}|${deck}` -> [node index]
  const addNode = (n) => { nodes.push(n); adj.push([]); return nodes.length - 1; };
  const link = (i, j, cost, el, vertical = false) => { adj[i].push({ to: j, cost, el, vertical }); adj[j].push({ to: i, cost, el, vertical }); };
  const key = (p) => `${p.el.id}|${p.deck}`;
  for (const p of presences) portalsOf.set(key(p), []);

  const byDeck = {};
  for (const p of presences) (byDeck[p.deck] ??= []).push(p);
  for (const [deck, list] of Object.entries(byDeck)) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j];
      if (A.el === B.el) continue;
      if (!isCirculation(A.el) && !isCirculation(B.el)) continue; // room to room: no opening assumed
      const o = opening(A.el.geom_mm, B.el.geom_mm);
      if (!o) continue;
      const n = addNode({ x: o.x, y: o.y, z: deckById[deck].elevation_mm, deck, a: A.el.id, b: B.el.id, width: o.width });
      portalsOf.get(key(A)).push(n);
      portalsOf.get(key(B)).push(n);
    }
  }

  const other = (n, id) => (nodes[n].a === id ? nodes[n].b : nodes[n].a);
  // Walking inside one element on one deck, from opening to opening.
  for (const p of presences) {
    const list = portalsOf.get(key(p));
    const room = !isCirculation(p.el);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      if (room && !isGate(byId[other(list[i], p.el.id)]) && !isGate(byId[other(list[j], p.el.id)])) continue;
      link(list[i], list[j], horizontal(nodes[list[i]], nodes[list[j]]), p.el.id);
    }
  }
  // Climbing a stair, ladder or trunk between its two decks.
  const disconnected = [];
  for (const el of els) {
    if (!VERTICAL_TYPES.has(el.type)) continue;
    const low = portalsOf.get(`${el.id}|${el.deck}`), up = upper[el.id] ? portalsOf.get(`${el.id}|${upper[el.id]}`) : [];
    if (!upper[el.id]) disconnected.push({ id: el.id, deck: null, reason: 'no deck at its upper end' });
    else if (!up.length) disconnected.push({ id: el.id, deck: upper[el.id], reason: 'its upper end opens to no corridor, room or deck area' });
    if (!low.length) disconnected.push({ id: el.id, deck: el.deck, reason: 'its lower end opens to no corridor, room or deck area' });
    for (const a of low) for (const b of up) {
      const run = horizontal(nodes[a], nodes[b]), rise = Math.abs(nodes[a].z - nodes[b].z);
      link(a, b, el.type === 'stair' ? Math.hypot(Math.max(run, el.geom_mm.lx), rise) : run + rise, el.id, true);
    }
  }
  // Centres: every element can be a start; muster stations are the goals.
  const centreNode = {};
  const goals = new Set();
  for (const el of els) {
    const c = centre(el.geom_mm);
    const n = addNode({ x: c.x, y: c.y, z: deckById[el.deck].elevation_mm, deck: el.deck, centre: el.id });
    centreNode[el.id] = n;
    for (const q of portalsOf.get(`${el.id}|${el.deck}`)) link(n, q, horizontal(nodes[n], nodes[q]), el.id);
    if (musterTypes.has(el.type)) goals.add(n);
  }
  return { nodes, adj, centreNode, goals, byId, disconnected, upper, musters: els.filter((e) => musterTypes.has(e.type)).map((e) => e.id) };
}

function shortest(graph, start, { banVertical = new Set(), banElements = new Set() } = {}) {
  const { nodes, adj, goals } = graph;
  const dist = new Float64Array(nodes.length).fill(Infinity), prev = new Int32Array(nodes.length).fill(-1), via = new Array(nodes.length);
  const done = new Uint8Array(nodes.length);
  const bannedNode = (n) => nodes[n].a != null && (banElements.has(nodes[n].a) || banElements.has(nodes[n].b));
  dist[start] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < nodes.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) return null;
    if (goals.has(u)) {
      const order = [];
      for (let n = u; n >= 0; n = prev[n]) order.unshift(n);
      return { order, edges: order.slice(1).map((n) => via[n]), length_mm: dist[u] };
    }
    done[u] = 1;
    for (const e of adj[u]) {
      if (done[e.to] || banElements.has(e.el) || (e.vertical && banVertical.has(e.el)) || bannedNode(e.to)) continue;
      // The centre of another element is never a through point; only a muster station is a goal.
      if (nodes[e.to].centre && !goals.has(e.to)) continue;
      const d = dist[u] + e.cost;
      if (d < dist[e.to]) { dist[e.to] = d; prev[e.to] = u; via[e.to] = e; }
    }
  }
}

function describe(graph, model, found) {
  if (!found) return null;
  const { nodes, byId } = graph;
  const via = [];
  for (const e of found.edges) if (via[via.length - 1] !== e.el) via.push(e.el);
  const verticals = [...new Set(found.edges.filter((e) => e.vertical).map((e) => e.el))];
  const doors = via.filter((id) => byId[id].type === 'door');
  let narrowest = null;
  for (const id of via) {
    const v = readValue(byId[id].props?.clear_width, model.units, byId[id].source);
    const mm = v && typeof v.value === 'number' ? toMM(v.value, v.unit) : null;
    if (mm != null && (!narrowest || mm < narrowest.width_mm)) narrowest = { id, width_mm: Math.round(mm) };
  }
  return {
    points: found.order.map((n) => ({ x: nodes[n].x, y: nodes[n].y, z: nodes[n].z, deck: nodes[n].deck })),
    via, verticals, doors, narrowest,
    length_mm: Math.round(found.length_mm),
    muster: nodes[found.order[found.order.length - 1]].centre,
  };
}

export function routesFrom(graph, model, id) {
  const start = graph.centreNode[id];
  if (start == null) return null;
  if (graph.goals.has(start)) return { id, status: 'direct', primary: null, secondary: null };
  const primary = describe(graph, model, shortest(graph, start));
  if (!primary) return { id, status: 'no_route', primary: null, secondary: null };
  const gates = [...primary.verticals, ...primary.doors];
  if (!gates.length) return { id, status: 'direct', primary, secondary: null };
  // Independent means: the alternative may not use any stair, ladder, trunk or door of the shortest route at all, not even
  // walk across a stair landing (a fire in that stairwell would block both routes).
  const secondary = describe(graph, model, shortest(graph, start, { banElements: new Set([...primary.verticals, ...primary.doors]) }));
  return { id, status: secondary ? 'two_routes' : 'single_route', primary, secondary, shared_gates: secondary ? [] : gates };
}

export function analyzeEscape(model, { blocked = new Set() } = {}) {
  const graph = buildEscapeGraph(model, { blocked });
  const origins = {};
  const summary = { two_routes: 0, single_route: 0, no_route: 0, direct: 0 };
  for (const el of Object.values(graph.byId)) {
    const r = routesFrom(graph, model, el.id);
    origins[el.id] = { ...r, room: isRoom(el) };
    if (isRoom(el)) summary[r.status]++;
  }
  return {
    available: graph.musters.length > 0,
    musters: graph.musters,
    origins, summary,
    disconnected: graph.disconnected,
    blocked: [...blocked],
    assumptions: [
      `Openings are inferred from geometry: elements that overlap or share at least ${MIN_OPENING_MM} mm of boundary are connected; a gap over ${TOLERANCE_MM} mm is a closed bulkhead.`,
      'Rooms connect to circulation only; a room is crossed only to reach a door, stair, ladder or escape trunk inside it.',
      'The alternative route does not use any stair, ladder, escape trunk or door of the shortest route, not even to cross a landing.',
      'Lengths are walking distances along the route centre line, including the rise of stairs and ladders.',
    ],
  };
}
