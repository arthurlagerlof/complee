// Escape-route analysis of a normalised ship model (deterministic graph search, no AI, no rule values).
//
// The walkable network is derived from the geometry of the model:
//   - corridors, stairs, ladders, escape trunks, ramps, doors, open decks and muster stations are circulation;
//   - two elements on the same deck are connected where they overlap or share a boundary of at least
//     MIN_OPENING_MM (a gap wider than TOLERANCE_MM is a closed bulkhead);
//   - a stair, ladder or escape trunk also connects its deck to the deck at its upper end;
//   - an ordinary room is a start point. It is only passed through on the way to a door, stair, ladder or
//     escape trunk that opens into it (never as a shortcut between two corridors).
// For every room the shortest route to a muster station is searched, then an alternative that shares nothing with
// it: no stair, ladder, escape trunk or door, and no corridor or room either (only the room itself, the muster
// stations and open deck areas may be common). A fire in a shared corridor would block both, so two ways through one
// corridor are reported as "shared", not as two independent routes. When the shortest route happens to block the
// only clean alternative, an exact search for two separate routes decides. This is an analysis aid: compliance
// statuses still come only from the rule checker (src/checker.mjs).
import { readValue, toMM } from './checker.mjs';

export const TOLERANCE_MM = 50;
export const MIN_OPENING_MM = 700;
// A modelled door connects wherever it overlaps or touches, down to this length: how wide it is clear is the rule
// checker's question (clear_width), not whether it is a door.
export const MIN_DOOR_OPENING_MM = 300;
export const VERTICAL_TYPES = new Set(['stair', 'ladder', 'escape_trunk']);
const CIRCULATION_TYPES = new Set(['corridor', 'stair', 'ladder', 'escape_trunk', 'ramp', 'door', 'muster_station']);
const ROOM_TYPES = new Set(['space', 'machinery_space']);
export const ESCAPE_LABEL = {
  two_routes: 'Two independent routes',
  shared_route: 'Two routes, but through the same corridor or space',
  single_route: 'Single route only',
  no_route: 'No route to a muster station',
  direct: 'Direct access to the muster station',
};

const isOpenDeck = (el) => el.props?.zone === 'open_deck';
export const isCirculation = (el) => CIRCULATION_TYPES.has(el.type) || (el.type === 'space' && isOpenDeck(el));
export const isRoom = (el) => ROOM_TYPES.has(el.type) && !isOpenDeck(el);
const isGate = (el) => el.type === 'door' || VERTICAL_TYPES.has(el.type);
// Elements two independent routes may have in common: the start room, the muster stations, open deck areas.
const shareable = (el, musterTypes) => !el || musterTypes.has(el.type) || isOpenDeck(el);

// Decks a stair, ladder or trunk serves above its own: every deck between its foot and its top (a stair tower through
// several tween decks opens on each of them), the top within 700 mm. Lowest first.
function decksAbove(el, decks, deckById) {
  const base = deckById[el.deck].elevation_mm, top = base + el.geom_mm.h;
  return decks.filter((d) => d.id !== el.deck && d.elevation_mm > base && d.elevation_mm <= top + 700)
    .sort((a, b) => a.elevation_mm - b.elevation_mm).map((d) => d.id);
}

// Overlap of two footprints, each grown by the tolerance. Returns the centre of the opening or null.
function opening(a, b, min = MIN_OPENING_MM) {
  const t = TOLERANCE_MM;
  const x0 = Math.max(a.x - t, b.x - t), x1 = Math.min(a.x + a.lx + t, b.x + b.lx + t);
  const y0 = Math.max(a.y - t, b.y - t), y1 = Math.min(a.y + a.ly + t, b.y + b.ly + t);
  if (x1 <= x0 || y1 <= y0) return null;
  if (Math.max(x1 - x0, y1 - y0) < min + 2 * t) return null;
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, width: Math.max(x1 - x0, y1 - y0) - 2 * t };
}
const usable = (g) => g && [g.x, g.y, g.lx, g.ly].every(Number.isFinite) && g.lx > 0 && g.ly > 0 && Number.isFinite(g.h) && g.h >= 0;

const centre = (g) => ({ x: g.x + g.lx / 2, y: g.y + g.ly / 2 });
const horizontal = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

export function buildEscapeGraph(model, { blocked = new Set() } = {}) {
  const deckById = Object.fromEntries(model.decks.map((d) => [d.id, d]));
  // Elements without usable geometry (missing or non-numeric size, size not above zero) cannot be placed: they are
  // listed in `unplaced` instead of being silently dropped.
  const candidates = model.elements.filter((e) => !e.virtual && (isCirculation(e) || isRoom(e)) && !blocked.has(e.id));
  const unplaced = candidates.filter((e) => !(usable(e.geom_mm) && deckById[e.deck])).map((e) => e.id);
  const els = candidates.filter((e) => usable(e.geom_mm) && deckById[e.deck]);
  const byId = Object.fromEntries(els.map((e) => [e.id, e]));
  const musterTypes = new Set(model.escape?.muster_types ?? ['muster_station']);

  // A presence is one element on one deck (vertical connectors have two).
  const presences = [];
  const upper = {}, spans = {};
  for (const el of els) {
    presences.push({ el, deck: el.deck });
    if (VERTICAL_TYPES.has(el.type)) {
      spans[el.id] = decksAbove(el, model.decks, deckById);
      upper[el.id] = spans[el.id].at(-1) ?? null;
      for (const d of spans[el.id]) presences.push({ el, deck: d });
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
      const door = A.el.type === 'door' || B.el.type === 'door';
      const o = opening(A.el.geom_mm, B.el.geom_mm, door ? MIN_DOOR_OPENING_MM : MIN_OPENING_MM);
      if (!o) continue;
      // A room that touches a corridor (or deck area, stair ...) without a modelled door: the opening is assumed. It is
      // used, but every route through it says so.
      const assumed = !door && (isRoom(A.el) || isRoom(B.el));
      const n = addNode({ x: o.x, y: o.y, z: deckById[deck].elevation_mm, deck, a: A.el.id, b: B.el.id, width: o.width, ...(assumed ? { assumed: true } : {}) });
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
  // Climbing a stair, ladder or trunk: from each deck where it opens to the next one up (a deck where it has no
  // opening is passed through, the flight continues).
  const disconnected = [];
  for (const el of els) {
    if (!VERTICAL_TYPES.has(el.type)) continue;
    const levels = [el.deck, ...spans[el.id]];
    const low = portalsOf.get(`${el.id}|${el.deck}`);
    if (!upper[el.id]) disconnected.push({ id: el.id, deck: null, reason: 'no deck at its upper end' });
    else if (!portalsOf.get(`${el.id}|${upper[el.id]}`).length) disconnected.push({ id: el.id, deck: upper[el.id], reason: 'its upper end opens to no corridor, room or deck area' });
    if (!low.length) disconnected.push({ id: el.id, deck: el.deck, reason: 'its lower end opens to no corridor, room or deck area' });
    const withOpenings = levels.filter((d) => portalsOf.get(`${el.id}|${d}`).length);
    for (let i = 0; i + 1 < withOpenings.length; i++) {
      for (const a of portalsOf.get(`${el.id}|${withOpenings[i]}`)) for (const b of portalsOf.get(`${el.id}|${withOpenings[i + 1]}`)) {
        const run = horizontal(nodes[a], nodes[b]), rise = Math.abs(nodes[a].z - nodes[b].z);
        const flight = el.geom_mm.lx * Math.min(1, rise / Math.max(el.geom_mm.h, 1)); // the stair's run for this rise
        link(a, b, el.type === 'stair' ? Math.hypot(Math.max(run, flight), rise) : run + rise, el.id, true);
      }
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
  return { nodes, adj, centreNode, goals, byId, disconnected, unplaced, upper, musterTypes, musters: els.filter((e) => musterTypes.has(e.type)).map((e) => e.id) };
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
  if (key === '#' && graph.toGoalFree) return graph.toGoalFree;
  // Rooms of one corridor ask the same few banned searches in turn: keep the most recent ones.
  graph.toGoalCache ??= new Map();
  const hit = graph.toGoalCache.get(key);
  if (hit) return hit;
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
  if (key === '#') graph.toGoalFree = result;
  else {
    graph.toGoalCache.set(key, result);
    if (graph.toGoalCache.size > 32) graph.toGoalCache.delete(graph.toGoalCache.keys().next().value);
  }
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
  const assumed = [...new Set(found.order.filter((n) => nodes[n].assumed).map((n) => `${nodes[n].a}/${nodes[n].b}`))];
  return {
    points: found.order.map((n) => ({ x: nodes[n].x, y: nodes[n].y, z: nodes[n].z, deck: nodes[n].deck })),
    via, verticals, doors, narrowest, assumed_openings: assumed,
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

const SHARED_SEARCH_FROM = 16; // rooms avoiding the same elements: from this many, one search of the ship serves them all
const gatesOf = (primary) => [...primary.verticals, ...primary.doors];
// Elements of a route that an independent alternative must avoid: everything except the start room, the muster
// stations and open deck areas.
const exclusiveOf = (graph, id, route) => route.via.filter((e) => e !== id && !shareable(graph.byId[e], graph.musterTypes));

// Element graph for the exact search: one node per element, an edge where two elements share an opening. Built once.
function elementGraph(graph) {
  if (graph.elementGraph) return graph.elementGraph;
  const { nodes, byId } = graph;
  const index = new Map(Object.keys(byId).map((id, i) => [id, i]));
  const ids = [...index.keys()];
  const edges = ids.map(() => new Map()); // i -> Map(j -> cost)
  const centreOf = (id) => { const g = byId[id].geom_mm; return { x: g.x + g.lx / 2, y: g.y + g.ly / 2 }; };
  for (const n of nodes) {
    if (n.a == null) continue;
    const i = index.get(n.a), j = index.get(n.b);
    const cost = horizontal(centreOf(n.a), n) + horizontal(n, centreOf(n.b)) + 1;
    if (!edges[i].has(j) || edges[i].get(j) > cost) { edges[i].set(j, cost); edges[j].set(i, cost); }
  }
  graph.elementGraph = { index, ids, edges };
  return graph.elementGraph;
}

// Two routes from the room that share no element except shareable ones: min-cost flow of two units on the element
// graph, each element split into in/out with capacity 1 (2 for the room, muster stations and open decks).
// Returns two element sets (each a route's elements) or null.
function disjointPair(graph, id) {
  const { index, ids, edges } = elementGraph(graph);
  const s = index.get(id);
  if (s == null || edges[s].size < 2) return null; // fewer than two different neighbours: no two separate ways out
  const V = ids.length, T = 2 * V, N = 2 * V + 1;
  const cap = (i) => (i === s || shareable(graph.byId[ids[i]], graph.musterTypes) ? 2 : 1);
  const to = [], capa = [], cost = [], nxt = [], head = new Int32Array(N).fill(-1);
  const addEdge = (u, v, c, w) => {
    to.push(v); capa.push(c); cost.push(w); nxt.push(head[u]); head[u] = to.length - 1;
    to.push(u); capa.push(0); cost.push(-w); nxt.push(head[v]); head[v] = to.length - 1;
  };
  for (let i = 0; i < V; i++) {
    addEdge(2 * i, 2 * i + 1, cap(i), 0); // in -> out
    for (const [j, w] of edges[i]) if (j !== s) addEdge(2 * i + 1, 2 * j, cap(i) === 2 && cap(j) === 2 ? 2 : 1, w);
    if (graph.musterTypes.has(graph.byId[ids[i]].type)) addEdge(2 * i + 1, T, 2, 0);
  }
  const source = 2 * s + 1;
  for (let flow = 0; flow < 2; flow++) { // two augmenting shortest paths (SPFA on the residual graph)
    const dist = new Float64Array(N).fill(Infinity), prevE = new Int32Array(N).fill(-1), inQ = new Uint8Array(N);
    dist[source] = 0;
    const queue = [source];
    inQ[source] = 1;
    for (let qi = 0; qi < queue.length; qi++) {
      if (qi > 60 * N) return null; // safety net
      const u = queue[qi];
      inQ[u] = 0;
      for (let e = head[u]; e !== -1; e = nxt[e]) {
        if (capa[e] <= 0) continue;
        const v = to[e], nd = dist[u] + cost[e];
        if (nd < dist[v] - 1e-9) { dist[v] = nd; prevE[v] = e; if (!inQ[v]) { inQ[v] = 1; queue.push(v); } }
      }
    }
    if (dist[T] === Infinity) return null;
    for (let v = T; v !== source; v = to[prevE[v] ^ 1]) { capa[prevE[v]] -= 1; capa[prevE[v] ^ 1] += 1; }
  }
  // Read the two element paths off the flow: a forward edge carries as much flow as its reverse edge has capacity.
  const out = new Map();
  for (let e = 0; e < to.length; e += 2) {
    const u = to[e ^ 1], v = to[e];
    for (let k = 0; k < capa[e ^ 1]; k++) { if (!out.has(u)) out.set(u, []); out.get(u).push(v); }
  }
  const paths = [];
  for (let k = 0; k < 2; k++) {
    const path = new Set([id]);
    let u = source;
    for (let guard = 0; u !== T && guard < 4 * N; guard++) {
      const list = out.get(u);
      if (!list?.length) return null;
      u = list.pop();
      if (u < T && u % 2 === 0) path.add(ids[u / 2]);
    }
    if (u !== T) return null;
    paths.push(path);
  }
  return paths;
}

// Shortest route from the room using only the allowed elements (the portal graph's own walking rules still apply).
function restricted(graph, start, allowed) {
  const { nodes, adj, goals } = graph;
  const ok = (n) => (nodes[n].a == null ? allowed.has(nodes[n].centre) : allowed.has(nodes[n].a) && allowed.has(nodes[n].b));
  const dist = new Map([[start, 0]]), prev = new Map(), via = new Map(), done = new Set(), queue = heap();
  queue.push(0, start);
  while (queue.size) {
    const [d, u] = queue.pop();
    if (done.has(u)) continue;
    done.add(u);
    if (goals.has(u)) {
      const order = [], edges = [];
      for (let n = u; n !== undefined; n = prev.get(n)) { order.unshift(n); if (via.has(n)) edges.unshift(via.get(n)); }
      return { order, edges, length_mm: d };
    }
    if (u !== start && nodes[u].centre) continue;
    for (const e of adj[u]) {
      if (done.has(e.to) || !allowed.has(e.el) || !ok(e.to)) continue;
      const nd = d + e.cost;
      if (nd < (dist.get(e.to) ?? Infinity)) { dist.set(e.to, nd); prev.set(e.to, u); via.set(e.to, e); queue.push(nd, e.to); }
    }
  }
  return null;
}

// The alternative to the shortest route, and what the two have in common:
//   two_routes    an alternative shares nothing but the room, muster stations and open deck areas
//   shared_route  every alternative uses a corridor or space of the shortest route (but none of its doors or stairs)
//   single_route  no alternative avoids the doors and stairs of the shortest route
// The way out of the room into its own corridor: the room's door(s) and the first corridor (or other circulation
// element) the shortest route reaches. Cabins open into a corridor that leads two ways; SOLAS counts the means of
// escape of such a group of spaces from that corridor. Both routes may therefore start through the room's door into
// this corridor, provided they leave the corridor in different directions (through different elements). Returns
// { prefix, exit } or null when the corridor's exit on the shortest route is a muster station or open deck.
function roomExit(graph, id, route) {
  for (let i = 1; i < route.via.length; i++) {
    const el = graph.byId[route.via[i]];
    if (!el || el.type === 'door') continue;
    if (!isCirculation(el) || VERTICAL_TYPES.has(el.type) || shareable(el, graph.musterTypes)) return null;
    const exit = route.via[i + 1];
    if (!exit || shareable(graph.byId[exit], graph.musterTypes)) return null;
    return { prefix: route.via.slice(1, i + 1), exit };
  }
  return null;
}

function withAlternative(graph, model, id, primary, shared = false) {
  const start = graph.centreNode[id];
  const exclusive = exclusiveOf(graph, id, primary);
  const search = (ban) => describe(graph, model, shared ? shortest(graph, start, { banElements: ban }) : detour(graph, start, ban));
  const exitOf = roomExit(graph, id, primary);
  if (exitOf) {
    // Through the same door into the same corridor, out of it the other way: everything after that is separate.
    const ban = new Set(exclusive.filter((e) => !exitOf.prefix.includes(e)));
    ban.add(exitOf.exit);
    const other = search(ban);
    if (other) {
      const common = exitOf.prefix.filter((e) => other.via.includes(e));
      return { id, status: 'two_routes', primary, secondary: other, shared: [], shared_gates: [], common_start: common };
    }
  } else {
    const clean = search(new Set(exclusive));
    if (clean) return { id, status: 'two_routes', primary, secondary: clean, shared: [], shared_gates: [], common_start: [] };
  }
  // The shortest route may block the only clean alternative (it zig-zags over both): exact search for two separate routes.
  const pair = disjointPair(graph, id);
  if (pair) {
    const routes = pair.map((allowed) => describe(graph, model, restricted(graph, start, allowed))).filter(Boolean)
      .sort((a, b) => a.length_mm - b.length_mm);
    if (routes.length === 2) {
      const first = new Set(exclusiveOf(graph, id, routes[0]));
      if (!exclusiveOf(graph, id, routes[1]).some((e) => first.has(e))) return { id, status: 'two_routes', primary: routes[0], secondary: routes[1], shared: [], shared_gates: [], common_start: [] };
    }
  }
  const gates = gatesOf(primary);
  const other = gates.length ? search(new Set(gates)) : null;
  if (other) {
    const mine = new Set(exclusive);
    return { id, status: 'shared_route', primary, secondary: other, shared: exclusiveOf(graph, id, other).filter((e) => mine.has(e)), shared_gates: [] };
  }
  return { id, status: 'single_route', primary, secondary: null, shared: [], shared_gates: gates.length ? gates : exclusive };
}

// Exported for tests: the exact two-route search on its own.
export { disjointPair as _disjointPair };

export function routesFrom(graph, model, id) {
  const start = graph.centreNode[id];
  if (start == null) return null;
  if (graph.goals.has(start)) return { id, status: 'direct', primary: null, secondary: null };
  const primary = describe(graph, model, shortest(graph, start));
  if (!primary) return { id, status: 'no_route', primary: null, secondary: null };
  if (!exclusiveOf(graph, id, primary).length) return { id, status: 'direct', primary, secondary: null };
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
    // Direct only when nothing but open deck lies between the room and the muster station (never a corridor).
    const exclusive = exclusiveOf(graph, el.id, primary);
    if (!exclusive.length) { found[el.id] = { id: el.id, status: 'direct', primary, secondary: null }; continue; }
    const key = [...exclusive].sort().join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: el.id, primary });
  }
  for (const members of groups.values()) for (const m of members) found[m.id] = withAlternative(graph, model, m.id, m.primary, members.length >= SHARED_SEARCH_FROM);
  const origins = {};
  const summary = { two_routes: 0, shared_route: 0, single_route: 0, no_route: 0, direct: 0 };
  let assumedRooms = 0;
  for (const el of Object.values(graph.byId)) { // model order, as before
    const r = found[el.id];
    const assumed = [...new Set([...(r.primary?.assumed_openings ?? []), ...(r.secondary?.assumed_openings ?? [])])];
    origins[el.id] = { ...r, room: isRoom(el), assumed_openings: assumed };
    if (isRoom(el)) { summary[r.status]++; if (assumed.length) assumedRooms++; }
  }
  return {
    available: graph.musters.length > 0,
    musters: graph.musters,
    origins, summary,
    disconnected: graph.disconnected,
    unplaced: graph.unplaced,
    rooms_with_assumed_openings: assumedRooms,
    blocked: [...blocked],
    assumptions: [
      `Openings are inferred from geometry: elements that overlap or share at least ${MIN_OPENING_MM} mm of boundary are connected (a modelled door from ${MIN_DOOR_OPENING_MM} mm); a gap over ${TOLERANCE_MM} mm is a closed bulkhead.`,
      'Where a room touches a corridor, stair or deck area without a modelled door, an opening is assumed; routes through it say so ("assumed opening").',
      'Rooms connect to circulation only; a room is crossed only to reach a door, stair, ladder or escape trunk inside it.',
      'Two independent routes share nothing but the room itself, the muster stations and open deck areas: no stair, ladder, escape trunk or door, and no corridor or room. Two ways through one corridor are reported as "shared".',
      'A stair, ladder or escape trunk serves every deck between its foot and its top.',
      'Lengths are walking distances from the room centre along the route, including the rise of stairs and ladders; no travel-distance limit is checked.',
    ],
  };
}
