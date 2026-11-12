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
  for (const [deck, unsorted] of Object.entries(byDeck)) {
    // Sweep along x: only elements whose x ranges (grown by the tolerance) overlap can share an opening. The stable
    // sort keeps the model order among equal x, so the openings are found in a deterministic order.
    const list = unsorted.map((p, order) => ({ p, order })).sort((a, b) => a.p.el.geom_mm.x - b.p.el.geom_mm.x || a.order - b.order).map((x) => x.p);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const A = list[i], B = list[j];
      if (B.el.geom_mm.x - TOLERANCE_MM > A.el.geom_mm.x + A.el.geom_mm.lx + TOLERANCE_MM) break;
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

// Binary min-heap of [priority, node] pairs.
function heap() {
  const pri = [], val = [];
  return {
    get size() { return pri.length; },
    push(p, v) {
      let i = pri.length; pri.push(p); val.push(v);
      while (i > 0) { const up = (i - 1) >> 1; if (pri[up] <= pri[i]) break; [pri[up], pri[i]] = [pri[i], pri[up]]; [val[up], val[i]] = [val[i], val[up]]; i = up; }
    },
    pop() {
      const p = pri[0], v = val[0], lp = pri.pop(), lv = val.pop();
      if (pri.length) {
        pri[0] = lp; val[0] = lv;
        for (let i = 0; ;) {
          const l = 2 * i + 1, r = l + 1; let m = i;
          if (l < pri.length && pri[l] < pri[m]) m = l;
          if (r < pri.length && pri[r] < pri[m]) m = r;
          if (m === i) break;
          [pri[m], pri[i]] = [pri[i], pri[m]]; [val[m], val[i]] = [val[i], val[m]]; i = m;
        }
      }
      return [p, v];
    },
  };
}

// Distance of every node to the nearest muster station, from one search that starts at the muster stations and
// walks the network backwards (optionally without the banned elements). The centre of an element is a start point
// only, never a through point, so the search reaches centres but does not continue from them. One search answers
// every start: the shortest route of each room is read off directly, and all rooms whose shortest routes use the
// same stairs and doors share one search for their alternative.
function toGoal(graph, banElements, banVertical) {
  const key = `${[...banElements].sort().join('|')}#${[...banVertical].sort().join('|')}`;
  if (graph.toGoal?.key === key) return graph.toGoal;
  if (key === '#' && graph.toGoalFree) return graph.toGoalFree;
  const { nodes, adj, goals } = graph;
  const bannedNode = (n) => nodes[n].a != null && (banElements.has(nodes[n].a) || banElements.has(nodes[n].b));
  const dist = new Float64Array(nodes.length).fill(Infinity), next = new Int32Array(nodes.length).fill(-1), via = new Array(nodes.length);
  const done = new Uint8Array(nodes.length), queue = heap();
  for (const g of goals) { dist[g] = 0; queue.push(0, g); }
  while (queue.size) {
    const [d, u] = queue.pop();
    if (done[u] || d > dist[u]) continue;
    done[u] = 1;
    if (nodes[u].centre && !goals.has(u)) continue;
    for (const e of adj[u]) {
      if (done[e.to] || goals.has(e.to) || banElements.has(e.el) || (e.vertical && banVertical.has(e.el)) || bannedNode(e.to)) continue;
      const nd = d + e.cost;
      if (nd < dist[e.to]) { dist[e.to] = nd; next[e.to] = u; via[e.to] = e; queue.push(nd, e.to); }
    }
  }
  const result = { key, dist, next, via };
  if (key === '#') graph.toGoalFree = result; else graph.toGoal = result; // the last banned search is kept
  return result;
}

function shortest(graph, start, { banVertical = new Set(), banElements = new Set() } = {}) {
  const found = toGoal(graph, banElements, banVertical);
  if (found.dist[start] === Infinity) return null;
  const order = [start], edges = [];
  for (let n = start; !graph.goals.has(n);) { edges.push(found.via[n]); n = found.next[n]; order.push(n); }
  return { order, edges, length_mm: found.dist[start] };
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

// Alternative for one start, without the banned elements: A* guided by the unrestricted distance to the muster
// station (never an overestimate: banning can only lengthen a route). The search stops at the first node whose own
// unrestricted route does not touch a banned element, because from there that route is the best continuation. A ban
// on a room's own door or stair is therefore answered close to the room instead of with a search of the whole ship.
function detour(graph, start, banElements) {
  const { nodes, adj, goals } = graph;
  const free = toGoal(graph, new Set(), new Set());
  if (free.dist[start] === Infinity) return null;
  const bannedNode = (n) => nodes[n].a != null && (banElements.has(nodes[n].a) || banElements.has(nodes[n].b));
  const cleanMemo = new Map();
  const clean = (u) => {
    const walked = [];
    let ok = true;
    for (let n = u; !goals.has(n); n = free.next[n]) {
      const known = cleanMemo.get(n);
      if (known !== undefined) { ok = known; break; }
      walked.push(n);
      const e = free.via[n];
      if (banElements.has(e.el) || bannedNode(free.next[n])) { ok = false; break; }
    }
    for (const n of walked) cleanMemo.set(n, ok);
    return ok;
  };
  const dist = new Map([[start, 0]]), prev = new Map(), via = new Map(), done = new Set(), queue = heap();
  queue.push(free.dist[start], start);
  while (queue.size) {
    const [, u] = queue.pop();
    if (done.has(u)) continue;
    if (goals.has(u) || (u !== start && clean(u))) {
      const order = [], edges = [];
      for (let n = u; n !== undefined; n = prev.get(n)) { order.unshift(n); if (via.has(n)) edges.unshift(via.get(n)); }
      for (let n = u; !goals.has(n);) { edges.push(free.via[n]); n = free.next[n]; order.push(n); }
      return { order, edges, length_mm: dist.get(u) + free.dist[u] };
    }
    done.add(u);
    for (const e of adj[u]) {
      if (done.has(e.to) || banElements.has(e.el) || bannedNode(e.to)) continue;
      if (nodes[e.to].centre && !goals.has(e.to)) continue; // a centre is never a through point
      if (free.dist[e.to] === Infinity) continue;
      const d = dist.get(u) + e.cost;
      if (d < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, d); prev.set(e.to, u); via.set(e.to, e); queue.push(d + free.dist[e.to], e.to); }
    }
  }
  return null;
}

const SHARED_SEARCH_FROM = 16; // rooms avoiding the same gates: from this many, one search of the ship serves them all
const gatesOf = (primary) => [...primary.verticals, ...primary.doors];
// Independent means: the alternative may not use any stair, ladder, trunk or door of the shortest route at all, not even
// walk across a stair landing (a fire in that stairwell would block both routes).
function withAlternative(graph, model, id, primary, shared = false) {
  const gates = gatesOf(primary), ban = new Set(gates), start = graph.centreNode[id];
  const secondary = describe(graph, model, shared ? shortest(graph, start, { banElements: ban }) : detour(graph, start, ban));
  return { id, status: secondary ? 'two_routes' : 'single_route', primary, secondary, shared_gates: secondary ? [] : gates };
}

export function routesFrom(graph, model, id) {
  const start = graph.centreNode[id];
  if (start == null) return null;
  if (graph.goals.has(start)) return { id, status: 'direct', primary: null, secondary: null };
  const primary = describe(graph, model, shortest(graph, start));
  if (!primary) return { id, status: 'no_route', primary: null, secondary: null };
  if (!gatesOf(primary).length) return { id, status: 'direct', primary, secondary: null };
  return withAlternative(graph, model, id, primary);
}

export function analyzeEscape(model, { blocked = new Set() } = {}) {
  const graph = buildEscapeGraph(model, { blocked });
  const found = {};
  // Shortest routes first; then the alternatives, grouped by the gates they must avoid (one search per group).
  const groups = new Map();
  for (const el of Object.values(graph.byId)) {
    const start = graph.centreNode[el.id];
    if (graph.goals.has(start)) { found[el.id] = { id: el.id, status: 'direct', primary: null, secondary: null }; continue; }
    const primary = describe(graph, model, shortest(graph, start));
    if (!primary) { found[el.id] = { id: el.id, status: 'no_route', primary: null, secondary: null }; continue; }
    const gates = gatesOf(primary);
    if (!gates.length) { found[el.id] = { id: el.id, status: 'direct', primary, secondary: null }; continue; }
    const key = [...gates].sort().join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: el.id, primary });
  }
  for (const members of groups.values()) for (const m of members) found[m.id] = withAlternative(graph, model, m.id, m.primary, members.length >= SHARED_SEARCH_FROM);
  const origins = {};
  const summary = { two_routes: 0, single_route: 0, no_route: 0, direct: 0 };
  for (const el of Object.values(graph.byId)) { // model order, as before
    const r = found[el.id];
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
