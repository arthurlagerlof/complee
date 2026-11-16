// Reading one deck plan in model millimetres: annotations out (centre lines, dimension lines, hatch, stairs, ladders,
// door swings, furniture), door and opening gaps closed, then the planar graph of the remaining line work gives the
// deck outline (its largest closed loop) and the rooms (its bounded faces, holes subtracted), named by the labels
// inside them. Walls come from pairs of parallel lines (or single lines), doors from swing arcs.
// Pure ES module. Everything measured carries the ids of the paths and texts it came from (`evidence`).

import { roomOf, areaOf, stairWord, numericText, isAnnotationWord, normText } from './vocab.mjs';
import {
  dist, segLen, area as ringArea, signedArea, centroid, ringBox, pointInRing, pointSegment, segIntersect, crossingsAtX, crossingsAtY,
  simplifyRing, mergeCollinear, planarGraph, nestFaces, pointInside, SegGrid, PointGrid, boxContains, UnionFind,
} from './plan-graph.mjs';

const DEG = Math.PI / 180;
export const PLAN = {
  snap: 15,                // mm: endpoints closer than this are one point
  minSeg: 8,               // mm: shorter pieces are noise (hatch dots, text strokes)
  door: { sweep: [60, 105], halfOpen: [30, 60], r: [500, 1600] },
  wall: { gap: [4, 400], overlap: 0.5, minLen: 300, singleMin: 500, singleAssumed: 50 },
  stair: { len: [600, 2200], pitch: [170, 340], min: 4 },
  ladder: { len: [250, 600], pitch: [200, 400], min: 3 },
  hatch: { pitch: [30, 800], min: 5 },
  room: { minArea: 1e6, minThick: 250, minUnlabelled: 2e6, minNamed: 0.2e6, minNamedThick: 150 },
  furniture: { maxDiag: 3500 },
  corridor: { aspect: 4, width: [700, 2500] },
  opening: { gap: [500, 2500] },
};

const unit = (v) => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dirOf = (s) => unit([s[2] - s[0], s[3] - s[1]]);

/**
 * readPlan(input) -> plan result (see the end of this function). input:
 *   segs: [[x1, y1, x2, y2, pathId]] straight pieces in model mm (dashed paths already left out)
 *   arcs: [{ c, r, sweep, p0, p1, ref }] circular arcs and circles (sweep 360) in model mm
 *   texts: [{ id, text, c: [x, y], h, angle }] in model mm
 *   strokeMM: pathId → stroke width in mm (0 = unknown)
 *   halfPlan: only one side of the centre line is drawn (port, y ≥ 0)
 */
export function readPlan(input) {
  // the snapping distance follows the drawing's precision (a PDF at 1:100 is exact to about half a point = 18 mm)
  const keep = PLAN.snap;
  PLAN.snap = Math.max(15, input.snap ?? 15);
  try { return readPlanAt(input); } finally { PLAN.snap = keep; }
}

function readPlanAt({ segs, arcs = [], texts = [], strokeMM = () => 0, halfPlan = false, closedRefs = new Set(), fillRefs = new Set() }) {
  const stats = { segments: segs.length };
  const evidence = new Set();
  // very short pieces are noise, except as steps of a long line (a hull curve written as many tiny pieces): dropping
  // those would open the line where snapping cannot join it again
  const pathLength = new Map();
  for (const s of segs) pathLength.set(s[4], (pathLength.get(s[4]) || 0) + segLen(s));
  let work = segs.filter((s) => segLen(s) >= PLAN.minSeg || (pathLength.get(s[4]) || 0) >= 1000);
  // 1. centre lines and other dash-dot lines drawn as rows of short pieces
  // a line drawn with a pen heavier than the walls, interrupted for symbols (gratings on the hull line), is not dashed:
  // hidden and centre lines are drawn with the wall pen or finer
  const pen0 = thinPen(work, strokeMM);
  const heavy = (ref) => pen0.ref > 0 && (strokeMM(ref) || 0) > 1.15 * pen0.ref;
  const dash = dashRows(work, heavy);
  work = work.filter((s, i) => !dash.has(i));
  stats.dashPieces = dash.size;
  stats.snap = PLAN.snap;
  // 2. dimension lines (a number centred on a line that it measures) with their ticks and extension lines
  const dims = dimensionLines(work, texts);
  work = work.filter((s, i) => !dims.remove.has(i));
  stats.dimensionLines = dims.found.length;
  // 3. doors from swing arcs (the arcs never become walls)
  // a swing of 60–105°, or a door drawn half open (30–60°) when its leaf runs from the arc centre to an arc end
  const leafGrid = new SegGrid(work, 1500);
  const doorSized = (a) => a.r >= PLAN.door.r[0] && a.r <= PLAN.door.r[1];
  const swingOk = (a) => (a.sweep >= PLAN.door.sweep[0] && a.sweep <= PLAN.door.sweep[1]) || (a.sweep >= PLAN.door.halfOpen[0] && a.sweep < PLAN.door.sweep[0] && leafOf(a, work, leafGrid, 0.1) >= 0);
  const doorArcs = arcs.filter((a) => doorSized(a) && swingOk(a) && !isFillet(a, work));
  stats.fillets = arcs.filter((a) => doorSized(a) && swingOk(a)).length - doorArcs.length;
  const doors = findDoors(doorArcs, work);
  const leafSegs = new Set(doors.flatMap((d) => d.leafIdx));
  work = work.filter((s, i) => !leafSegs.has(i));
  // 4. stairs, ladders and hatch: families of parallel, equally spaced lines
  const fam = parallelFamilies(work, texts);
  work = work.filter((s, i) => !fam.remove.has(i));
  stats.hatchLines = fam.hatchCount;
  // other arcs (hull curves, rounded corners) are line work; circles are portholes / furniture and stay out
  const curveSegs = [];
  for (const a of arcs) {
    if (doorArcs.includes(a) || a.sweep >= 350) continue;
    for (let k = 1; k < a.pts.length; k++) curveSegs.push([a.pts[k - 1][0], a.pts[k - 1][1], a.pts[k][0], a.pts[k][1], a.ref]);
  }
  work = work.concat(curveSegs);
  // 4b. small closed shapes (beds, tables, toilets, equipment) and what is drawn inside them are objects, not walls,
  // even where they touch a wall; detail drawn with a finer pen than the walls (machinery, fittings) is no wall either
  // labels first: a small closed shape with a room name in it (a day tank, a sea chest) is a room, not furniture;
  // a label outside the plan points at its space with a leader line
  const labels = labelGroups(texts);
  leaderTargets(labels, segs, strokeMM, fillRefs);
  // leader lines are annotation: they must not cut the spaces they point into
  const leaderSegs = new Set(labels.flatMap((g) => g.leaderSegs || []));
  work = work.filter((s) => !leaderSegs.has(s));
  stats.leaders = labels.filter((g) => g.target).length;
  const namePoints = labels.filter((g) => isRoomLabel(g)).flatMap((g) => (g.target ? [g.c, g.target] : [g.c]));
  const objects = smallClosedShapes(work, closedRefs).filter((o) => !namePoints.some((p) => boxContains(o.box, p)));
  const thin = thinPen(work, strokeMM);
  const inObject = insideObjects(work, objects, (ref) => thin.ref > 0 && (strokeMM(ref) || 0) > 1.5 * thin.ref);
  stats.objects = objects.length; stats.thinPenSegments = thin.count; stats.thinPenLimit = thin.limit; stats.detailPens = thin.detailPens;
  work = work.filter((s, i) => !inObject.has(i) && !thin.set.has(i));
  // tiny strokes of small drawn details (fittings, symbols) are noise; tiny steps of a long line (a hull curve
  // written as many short pieces) are kept so the line stays closed
  const pathLen = new Map();
  for (const sg of work) pathLen.set(sg[4], (pathLen.get(sg[4]) || 0) + segLen(sg));
  work = work.filter((sg) => segLen(sg) >= PLAN.snap * 0.5 || (pathLen.get(sg[4]) || 0) >= 1000);
  // 4c. lines that stop just short of another line (drawing inaccuracy) are extended to it
  const bridges = closeSmallGaps(work);
  // 4d. tanks marked only by their four corners (an L at each corner, a common way to draw tanks below a floor)
  const marked = cornerMarkBoxes(work);
  stats.cornerMarkedBoxes = marked.length / 4;
  stats.gapsBridged = bridges.length;
  // 5. walls: pairs of parallel lines; then gaps in walls (doors without arcs are openings)
  const lines = mergeCollinear(work, { angTol: 0.5, offTol: 3, gapTol: PLAN.snap });
  const wallInfo = pairWalls(lines, work);
  const openings = findOpenings(work, lines, wallInfo, doors);
  // 6. closing segments: door and opening gaps on both wall faces; the centre line of a half plan
  const virtual = [];
  for (const d of doors) for (const v of closeGap(d.hinge, d.closedEnd, work)) virtual.push([...v, `door:${d.index}`]);
  for (const o of openings) for (const v of o.closers) virtual.push([...v, `opening:${o.index}`]);
  if (halfPlan) {
    const xs = work.map((s) => [s[0], s[2]]).flat();
    virtual.push([Math.min(...xs) - 1, 0, Math.max(...xs) + 1, 0, 'centreline']);
  }
  // 7. planar graph and faces
  const graph = planarGraph(work.concat(virtual, bridges, marked), { tol: PLAN.snap });
  const pairedSegs = wallInfo.pairedSegs;
  const comps = classifyComponents(graph, work, pairedSegs, namePoints);
  const outlineComp = comps.filter((c) => c.outerArea > 0).sort((a, b) => b.outerArea - a.outerArea)[0];
  if (!outlineComp) return emptyPlan(stats, 'no closed loop in the line work of this plan');
  const outlineRing = simplifyRing(outlineComp.comp.outer.ring.slice().reverse(), 2);
  const furnitureComps = new Set(comps.filter((c) => c.furniture).map((c) => c.comp.id));
  stats.furniture = furnitureComps.size;
  const faces = nestFaces({ ...graph, comps: graph.comps.filter((c) => !furnitureComps.has(c.id)) })
    .filter((f) => !furnitureComps.has(f.comp));
  // 8. labels → rooms
  const rooms = buildRooms(faces, labels, outlineRing, graph);
  // 9. stairs inside stair-labelled rooms become one element; equipment from labelled furniture
  const stairs = settleStairs(fam.stairs, objects);
  const equipment = labelledFurniture(comps.filter((c) => c.furniture), labels).concat(labelledObjects(objects, labels), rooms.things);
  const ladders = fam.ladders.concat(ladderLabels(labels, fam.ladders, rooms));
  // 10. walls with their openings
  const furnitureRefs = new Set(comps.filter((c) => c.furniture).flatMap((c) => [...c.refs]));
  const built = buildWalls(wallInfo, lines, work, outlineRing, doors, openings, strokeMM, furnitureRefs);
  // What stands free is furniture: a wall separates two spaces (or a space from the outside), or it is a double line at
  // most 300 mm thick joined to the wall network at one end at least, and at least 1.5 m long. Counters, benches and
  // lockers drawn as double lines are fittings (900 mm high, assumed); other free-standing lines are dropped.
  const walls = [], fittings = [], dropped = [];
  for (const w of built) {
    const keep = w.openings.length || separates(w, rooms.list, outlineRing)
      || (!w.single && w.thickness <= 300 && dist(w.a, w.b) >= 1500 && joined(w, built, outlineRing));
    if (keep) { walls.push(w); continue; }
    dropped.push(w);
    if (!w.single && w.thickness > 300 && dist(w.a, w.b) >= 300) fittings.push(fittingOf(w));
  }
  equipment.push(...fittings);
  stats.walls = walls.length; stats.fittings = fittings.length; stats.freeStandingDropped = built.length - walls.length - fittings.length;
  // 11. doors: wall thickness, hinge on the wall centre line, rooms on both sides
  for (const d of doors) finishDoor(d, walls, rooms);
  for (const o of openings) finishOpening(o, rooms);
  const unresolved = rooms.unresolved;
  for (const d of doors) if (!d.gap) d.notes.push('no gap in the wall line work at this swing: the wall is drawn through the door, or the door stands in a single line');
  for (const s of segs) evidence.add(s[4]);
  const result = {
    outline: { ring: outlineRing, area: ringArea(outlineRing), evidence: [...new Set(outlineComp.comp.outer.edges.map((e) => graph.edges[e][2]).filter((r) => typeof r === 'string' && /^p/.test(r)))] },
    rooms: rooms.list, walls, doors, openings, stairs, ladders, equipment, unresolved, unlabelledSmall: rooms.unlabelledSmall,
    labels, stats: { ...stats, faces: faces.length, components: graph.comps.length, rooms: rooms.list.length, doors: doors.length, walls: walls.length, dimensions: dims.found },
  };
  // the graph and line work, for debugging; not enumerable, so it never ends up in a report
  Object.defineProperty(result, '_debug', { value: { graph, work, virtual, bridges, dropped }, enumerable: false });
  return result;
}

function emptyPlan(stats, why) {
  return { outline: null, rooms: [], walls: [], doors: [], openings: [], stairs: [], ladders: [], equipment: [], labels: [], unresolved: [{ what: why }], stats };
}

// ---------- annotations ----------

// Rows of collinear short pieces with regular gaps: dash-dot centre lines and hidden lines drawn as separate dashes.
function dashRows(segs, heavy = () => false) {
  const out = new Set();
  const ends = new PointGrid(300);
  segs.forEach((s, i) => { ends.add([s[0], s[1]], i); ends.add([s[2], s[3]], i); });
  const lines = mergeCollinear(segs.map((s) => s), { angTol: 0.3, offTol: 2, gapTol: 600 });
  for (const l of lines) {
    if (l.members.every((k) => heavy(segs[k][4]))) continue;
    if (l.members.length < 6 || l.len < 3000) continue;
    const iv = l.members.map((k) => { const s = segs[k]; const a = dot([s[0], s[1]], l.dir), b = dot([s[2], s[3]], l.dir); return [Math.min(a, b), Math.max(a, b), k]; }).sort((a, b) => a[0] - b[0]);
    const pat = isDashPattern(iv);
    if (!pat) continue;
    // a line interrupted for symbols (gratings, inlets drawn in the gaps) is a solid line, not a dashed one
    const own = new Set(l.members);
    const filled = pat.gaps.filter(([t, len]) => {
      const p = add(mul(l.dir, t), mul(l.n, l.rho));
      return ends.near(p, Math.max(0.6 * len, 30)).some(([, i]) => !own.has(i));
    }).length;
    if (filled >= 0.5 * pat.gaps.length) continue;
    // only the dashes go: a wall drawn along the centre line (one long piece among the dashes) stays
    const dashLens = iv.map(([a, b]) => b - a).sort((x, y) => x - y), typical = dashLens[Math.floor(dashLens.length / 2)];
    for (const [a, b, k] of iv) if (b - a <= Math.max(3 * typical, 1500) && !heavy(segs[k][4])) out.add(k);
  }
  return out;
}

// Dash-dot: regular gaps, and either dots between the dashes or short equal dashes. A wall face broken by the
// partitions that join it also has regular gaps, but its pieces are long and of any length, with no dots.
function isDashPattern(iv) {
  const pieces = [], gaps = [], at = [];
  let end = iv[0][1], start = iv[0][0];
  for (const [a, b] of iv.slice(1)) {
    if (a > end + 20) { pieces.push(end - start); gaps.push(a - end); at.push([(a + end) / 2, a - end]); start = a; }
    end = Math.max(end, b);
  }
  pieces.push(end - start);
  if (gaps.length < 5) return null;
  const cv = (v) => { const m = v.reduce((x, y) => x + y, 0) / v.length; return Math.sqrt(v.reduce((x, y) => x + (y - m) ** 2, 0) / v.length) / (m || 1); };
  if (cv(gaps) > 0.35) return null;
  const max = Math.max(...pieces);
  // dots are tiny next to the dashes (a dash-dot line); equal short dashes are a hidden line
  const dots = pieces.filter((p) => p < 0.12 * max && p < 400).length;
  return dots >= 0.25 * pieces.length || (max <= 1000 && cv(pieces) < 0.25) ? { gaps: at } : null;
}

// A dimension: a number centred on a straight line whose length (in mm) it states, within 3 %.
function dimensionLines(segs, texts) {
  const remove = new Set(), found = [];
  const nums = texts.map((t) => ({ t, v: numericText(t.text) })).filter((x) => x.v != null && x.v >= 100);
  if (!nums.length) return { remove, found };
  const grid = new SegGrid(segs, 2000);
  for (const { t, v } of nums) {
    const r = Math.max(4 * t.h, 600);
    let best = null;
    for (const i of grid.query([t.c[0] - r, t.c[1] - r, t.c[0] + r, t.c[1] + r])) {
      const s = segs[i], L = segLen(s);
      if (Math.abs(L - v) > 0.03 * v) continue;
      const p = pointSegment(t.c, s);
      if (p.t < 0.3 || p.t > 0.7 || p.d > 3 * t.h + 100) continue;
      if (!best || p.d < best.d) best = { i, d: p.d };
    }
    if (!best) continue;
    const s = segs[best.i];
    remove.add(best.i);
    // ticks and extension lines at both ends
    for (const end of [[s[0], s[1]], [s[2], s[3]]]) {
      for (const j of grid.query([end[0] - 400, end[1] - 400, end[0] + 400, end[1] + 400])) {
        if (j === best.i) continue;
        const q = segs[j], Lq = segLen(q);
        if (pointSegment(end, q).d < 30 && (Lq < 600 || Math.abs(dot(dirOf(q), dirOf(s))) < 0.1)) remove.add(j);
      }
    }
    found.push({ value: v, text: t.id, length: segLen(s), ref: s[4] });
  }
  return { remove, found };
}

// A rounded corner, not a door swing: lines leave the arc tangentially at its ends (a door's wall and leaf meet
// its arc radially).
function isFillet(a, segs) {
  let tangent = 0;
  for (const e of [a.p0, a.p1]) {
    const radial = unit(sub(e, a.c));
    for (const s of segs) {
      const p = [s[0], s[1]], q = [s[2], s[3]];
      const touch = dist(p, e) < 20 ? p : dist(q, e) < 20 ? q : null;
      if (!touch || segLen(s) < 100) continue;
      if (Math.abs(dot(dirOf(s), radial)) < Math.sin(10 * DEG)) { tangent++; break; }
    }
  }
  return tangent >= 2;
}

// A straight leaf from the arc centre to one of its ends, as long as the radius within tol (share of r): its index.
function leafOf(a, segs, grid, tol) {
  const e = Math.max(30, 0.06 * a.r);
  for (const i of grid.query([a.c[0] - a.r * 1.2, a.c[1] - a.r * 1.2, a.c[0] + a.r * 1.2, a.c[1] + a.r * 1.2])) {
    const s = segs[i], L = segLen(s);
    if (Math.abs(L - a.r) > tol * a.r) continue;
    const p = [s[0], s[1]], q = [s[2], s[3]];
    const [h, o] = dist(p, a.c) < dist(q, a.c) ? [p, q] : [q, p];
    if (dist(h, a.c) <= e && (dist(o, a.p0) <= e || dist(o, a.p1) <= e)) return i;
  }
  return -1;
}

// Door swings: arc centre = hinge; the closed position is the arc end along the wall (the end where wall line work
// continues on the far side of the opening or behind the hinge); a straight leaf from the hinge, if drawn, is noted.
function findDoors(doorArcs, segs) {
  const grid = new SegGrid(segs, 1500);
  const doors = [];
  for (const a of doorArcs) {
    const ends = [a.p0, a.p1];
    const tol = Math.max(30, 0.06 * a.r);
    const near = [...grid.query([a.c[0] - a.r * 1.6, a.c[1] - a.r * 1.6, a.c[0] + a.r * 1.6, a.c[1] + a.r * 1.6])];
    // leaf lines: from the hinge, length ≈ r, toward one of the ends
    const leafIdx = [];
    for (const i of near) {
      const s = segs[i], L = segLen(s);
      if (L < 0.8 * a.r || L > 1.2 * a.r) continue;
      const p = [s[0], s[1]], q = [s[2], s[3]];
      const [h, o] = dist(p, a.c) < dist(q, a.c) ? [p, q] : [q, p];
      if (dist(h, a.c) > tol) continue;
      if (ends.some((e) => dist(o, e) < tol)) leafIdx.push(i);
    }
    // wall continuation along each end direction (outside the swing): the closed position lies along the wall
    const score = ends.map((e) => {
      const d = unit(sub(e, a.c));
      let along = 0;
      for (const i of near) {
        if (leafIdx.includes(i)) continue;
        const s = segs[i], sd = dirOf(s);
        if (Math.abs(cross(sd, d)) > Math.sin(5 * DEG)) continue;
        const off = Math.abs(cross(d, sub([s[0], s[1]], a.c)));
        if (off > Math.max(120, 0.1 * a.r)) continue;
        const t0 = dot(sub([s[0], s[1]], a.c), d), t1 = dot(sub([s[2], s[3]], a.c), d);
        const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
        along += Math.max(0, Math.min(hi, -20) - Math.max(lo, -1500)) + Math.max(0, Math.min(hi, a.r + 1500) - Math.max(lo, a.r + 20));
      }
      return along;
    });
    const closedIdx = score[0] === score[1] ? null : score[0] > score[1] ? 0 : 1;
    const ci = closedIdx ?? 0;
    doors.push({ arc: a, hinge: a.c, r: a.r, closedEnd: ends[ci], openEnd: ends[1 - ci], leafIdx, closedSure: closedIdx != null,
      evidence: [a.ref, ...leafIdx.map((i) => segs[i][4])], notes: closedIdx == null ? ['which end of the swing is the closed position could not be told from the wall lines'] : [] });
  }
  // double doors: two swings whose closed ends meet in the middle of one opening
  const used = new Set(), out = [];
  doors.forEach((d, i) => {
    if (used.has(i)) return;
    const j = doors.findIndex((e, k) => k > i && !used.has(k) && dist(e.closedEnd, d.closedEnd) < 0.15 * Math.min(d.r, e.r) && Math.abs(cross(unit(sub(d.closedEnd, d.hinge)), unit(sub(e.closedEnd, e.hinge)))) < 0.1);
    if (j >= 0) {
      const e = doors[j]; used.add(j);
      out.push({ ...d, double: true, leaves: [d, e], width: d.r + e.r, closedEnd: e.hinge, evidence: [...d.evidence, ...e.evidence], notes: [...d.notes, ...e.notes] });
    } else out.push({ ...d, double: false, leaves: [d], width: d.r });
  });
  out.forEach((d, i) => { d.index = i; });
  return out;
}

// Families of parallel, equally spaced lines: stair treads (equal length, 170–340 mm apart), ladder rungs, hatch.
function parallelFamilies(segs, texts) {
  const remove = new Set(), stairs = [], ladders = [];
  let hatchCount = 0;
  const items = segs.map((s, i) => {
    const d = dirOf(s);
    const dd = d[0] < 0 || (d[0] === 0 && d[1] < 0) ? [-d[0], -d[1]] : d;
    const n = [-dd[1], dd[0]];
    const o = dot(n, [s[0], s[1]]), t0 = dot(dd, [s[0], s[1]]), t1 = dot(dd, [s[2], s[3]]);
    return { i, ang: Math.round(Math.atan2(dd[1], dd[0]) / (0.5 * DEG)), d: dd, n, o, t0: Math.min(t0, t1), t1: Math.max(t0, t1), L: segLen(s) };
  });
  const byAng = new Map();
  for (const it of items) { const a = byAng.get(it.ang) || []; a.push(it); byAng.set(it.ang, a); }
  const up = texts.filter((t) => stairWord(t.text));
  const ladderWords = texts.filter((t) => /\b(LADDER|LDR|VERT LADDER|LEITER)\b/.test(normText(t.text)));
  for (const group of byAng.values()) {
    if (group.length < 3) continue;
    group.sort((a, b) => a.o - b.o);
    const taken = new Set();
    for (const kind of ['stair', 'ladder', 'hatch']) {
      for (let k = 0; k < group.length; k++) {
        if (taken.has(k)) continue;
        const chain = chainFrom(group, k, kind, taken);
        const min = kind === 'stair' ? PLAN.stair.min : kind === 'ladder' ? PLAN.ladder.min : PLAN.hatch.min;
        if (chain.length < min) continue;
        // a ladder needs its word nearby unless it has rails; plain short equal lines are kept otherwise
        const members = chain.map((c) => group[c]);
        const box = familyBox(members, segs);
        if (kind === 'ladder' && !ladderWords.some((t) => boxContains(box, t.c, 1500))) continue;
        for (const c of chain) { taken.add(c); remove.add(group[c].i); }
        if (kind === 'stair') stairs.push(stairOf(members, segs, up, box));
        else if (kind === 'ladder') ladders.push(ladderOf(members, segs, box));
        else hatchCount += chain.length;
      }
    }
  }
  return { remove, stairs, ladders, hatchCount };
}

// Walk from group[k] to the next line at a regular spacing, overlapping along the lines.
function chainFrom(group, k, kind, taken) {
  const P = kind === 'stair' ? PLAN.stair : kind === 'ladder' ? PLAN.ladder : PLAN.hatch;
  const first = group[k];
  if (kind !== 'hatch' && (first.L < P.len[0] || first.L > P.len[1])) return [];
  const chain = [k];
  let pitch = null, cur = first;
  for (let j = k + 1; j < group.length; j++) {
    const g = group[j];
    if (taken.has(j)) continue;
    const gap = g.o - cur.o;
    if (gap < P.pitch[0] * 0.9) continue;
    if (gap > (pitch ? pitch * 1.12 : P.pitch[1])) { if (gap > P.pitch[1] * 1.2) break; continue; }
    const ov = Math.min(cur.t1, g.t1) - Math.max(cur.t0, g.t0);
    if (kind !== 'hatch') {
      if (Math.abs(g.L - first.L) > 0.08 * first.L || Math.abs(g.t0 - first.t0) > 0.1 * first.L) continue;
    } else if (ov < 0.5 * Math.min(cur.L, g.L) || Math.max(cur.L, g.L) > 2 * Math.min(cur.L, g.L)) continue; // hatch: neighbours of similar length (a bulkhead on a frame is no tick)
    if (pitch && Math.abs(gap - pitch) > 0.1 * pitch) continue;
    pitch = pitch ?? gap;
    chain.push(j); cur = g;
  }
  return chain;
}

function familyBox(members, segs) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const m of members) { const s = segs[m.i]; b = [Math.min(b[0], s[0], s[2]), Math.min(b[1], s[1], s[3]), Math.max(b[2], s[0], s[2]), Math.max(b[3], s[1], s[3])]; }
  return b;
}

/**
 * One stair per flight: tread families found twice (treads drawn with two lines) are one; a flight drawn inside its
 * own outline (a rectangle around the treads, often cut by a break line so that only some treads show) takes that
 * outline as its footprint.
 */
function settleStairs(list, objects) {
  const out = [];
  const share = (a, b) => { const ov = overlapArea(a, b); return ov / Math.min(boxArea(a), boxArea(b)); };
  for (const s of list.slice().sort((a, b) => b.treads - a.treads)) {
    const twin = out.find((o) => share(o.box, s.box) > 0.5 && Math.abs(dot(o.dir, s.dir)) > 0.9);
    if (twin) { twin.evidence.push(...s.evidence); continue; }
    out.push(s);
  }
  for (const s of out) {
    const c = centroid(s.polygon);
    const host = objects.filter((o) => boxContains(o.box, c) && boxArea(o.box) >= 0.9 * boxArea(s.box) && boxArea(o.box) <= 4 * boxArea(s.box))
      .sort((a, b) => boxArea(a.box) - boxArea(b.box))[0];
    if (!host) continue;
    const b = host.box;
    s.polygon = ensureCCW([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]);
    s.outline = host.ref;
    s.evidence.push(host.ref);
    // the clear width cannot exceed the outline across the direction of travel
    const across = Math.abs(s.dir[0]) > Math.abs(s.dir[1]) ? b[3] - b[1] : b[2] - b[0];
    if (s.width > across) s.width = across;
  }
  return out;
}
const boxArea = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const overlapArea = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));

function stairOf(members, segs, upTexts, box) {
  const f = members[0], l = members[members.length - 1];
  const dir = f.n; // across the treads: the direction of travel
  const t0 = Math.min(...members.map((m) => m.t0)), t1 = Math.max(...members.map((m) => m.t1));
  const corner = (o, t) => add(mul(f.d, t), mul(f.n, o));
  const polygon = [corner(f.o, t0), corner(f.o, t1), corner(l.o, t1), corner(l.o, t0)];
  const pitch = (l.o - f.o) / (members.length - 1);
  const word = upTexts.map((t) => ({ t, w: stairWord(t.text), d: dist(t.c, centroid(polygon)) })).filter((x) => x.d < 2500).sort((a, b) => a.d - b.d)[0];
  // UP is written at the foot of the flight: the stair runs from that end toward the other
  let travel = dir;
  if (word) {
    const along = dot(sub(word.t.c, centroid(polygon)), dir);
    travel = (word.w === 'up') === (along < 0) ? dir : mul(dir, -1);
  }
  const widths = members.map((m) => m.L);
  return { polygon: ensureCCW(polygon), dir: travel, treads: members.length, width: Math.min(...widths), going: pitch,
    upText: word ? { id: word.t.id, word: word.w } : null, box, evidence: members.map((m) => segs[m.i][4]).concat(word ? [word.t.id] : []) };
}

function ladderOf(members, segs, box) {
  const f = members[0], l = members[members.length - 1];
  const at = centroid([[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]]);
  return { at, width: f.L, dir: f.n, rungs: members.length, pitch: (l.o - f.o) / (members.length - 1), evidence: members.map((m) => segs[m.i][4]), basis: 'measured' };
}

function ladderLabels(labels, ladders, rooms) {
  const out = [];
  for (const g of labels) {
    if (!/\b(LADDER|LDR|VERT LADDER|LEITER)\b/.test(normText(g.text))) continue;
    if (ladders.some((l) => dist(l.at, g.c) < 2000)) continue;
    void rooms;
    out.push({ at: g.c, width: null, dir: [1, 0], rungs: null, evidence: g.ids, basis: 'read', note: `label "${g.text}" without drawn rungs: position from the text, width not measured` });
  }
  return out;
}

// ---------- objects, pens, small gaps ----------

/**
 * Boxes drawn by their corners only: four L-shaped marks (legs 80–600 mm, axis-parallel) at the corners of one
 * rectangle, each pointing inward. Returns the rectangle's four sides as virtual segments ('corner-marks').
 */
function cornerMarkBoxes(segs) {
  const axis = (s) => (Math.abs(s[1] - s[3]) < 1 ? 'h' : Math.abs(s[0] - s[2]) < 1 ? 'v' : null);
  const legs = segs.filter((s) => axis(s) && segLen(s) >= 80 && segLen(s) <= 600);
  const ends = new PointGrid(100);
  legs.forEach((s) => { ends.add([s[0], s[1]], [s, [s[2], s[3]]]); ends.add([s[2], s[3]], [s, [s[0], s[1]]]); });
  // L marks: a horizontal and a vertical leg meeting at a corner; the inward direction is where the legs go
  const marks = [];
  for (const s of legs) {
    if (axis(s) !== 'h') continue;
    for (const [c, other] of [[[s[0], s[1]], [s[2], s[3]]], [[s[2], s[3]], [s[0], s[1]]]]) {
      for (const [, [t, far]] of ends.near(c, 15)) {
        if (t === s || axis(t) !== 'v') continue;
        marks.push({ c, dx: Math.sign(other[0] - c[0]), dy: Math.sign(far[1] - c[1]) });
      }
    }
  }
  const out = [];
  const find = (x, y, dx, dy) => marks.find((m) => m.dx === dx && m.dy === dy && Math.abs(m.c[0] - x) < 30 && Math.abs(m.c[1] - y) < 30);
  for (const bl of marks.filter((m) => m.dx === 1 && m.dy === 1)) {
    for (const tr of marks.filter((m) => m.dx === -1 && m.dy === -1 && m.c[0] - bl.c[0] >= 300 && m.c[1] - bl.c[1] >= 300 && m.c[0] - bl.c[0] <= 15000 && m.c[1] - bl.c[1] <= 15000)) {
      if (!find(bl.c[0], tr.c[1], 1, -1) || !find(tr.c[0], bl.c[1], -1, 1)) continue;
      const [x0, y0] = bl.c, [x1, y1] = tr.c;
      out.push([x0, y0, x1, y0, 'corner-marks'], [x1, y0, x1, y1, 'corner-marks'], [x1, y1, x0, y1, 'corner-marks'], [x0, y1, x0, y0, 'corner-marks']);
      break; // the nearest matching opposite corner closes this box
    }
  }
  return out;
}

// Closed shapes 0.25–3 m across on both sides (a wall drawn as a closed outline is thinner than 250 mm).
function smallClosedShapes(segs, closedRefs) {
  const byRef = new Map();
  segs.forEach((s) => { if (closedRefs.has(s[4])) { const b = byRef.get(s[4]) || [Infinity, Infinity, -Infinity, -Infinity]; byRef.set(s[4], [Math.min(b[0], s[0], s[2]), Math.min(b[1], s[1], s[3]), Math.max(b[2], s[0], s[2]), Math.max(b[3], s[1], s[3])]); } });
  const out = [];
  for (const [ref, b] of byRef) {
    const w = b[2] - b[0], h = b[3] - b[1];
    if (Math.min(w, h) >= 250 && Math.max(w, h) <= 3000) out.push({ ref, box: b });
  }
  // a box with both diagonals drawn (bunks, stowage, equipment footprints) even when its sides are loose lines
  const diag = segs.map((s, i) => ({ s, i, L: segLen(s) })).filter(({ s, L }) => {
    if (L < 350 || L > 4000) return false;
    const a = Math.abs(Math.atan2(s[3] - s[1], s[2] - s[0])) % (Math.PI / 2);
    return a > 0.17 && a < Math.PI / 2 - 0.17;
  });
  const grid = new SegGrid(diag.map((d) => d.s), 1500);
  diag.forEach((d, k) => {
    for (const j of grid.query([Math.min(d.s[0], d.s[2]), Math.min(d.s[1], d.s[3]), Math.max(d.s[0], d.s[2]), Math.max(d.s[1], d.s[3])])) {
      if (j <= k) continue;
      const e = diag[j];
      if (Math.abs(e.L - d.L) > 0.1 * d.L) continue;
      const x = segIntersect(d.s, e.s);
      if (!x || x.t < 0.4 || x.t > 0.6 || x.u < 0.4 || x.u > 0.6) continue;
      const b = [Math.min(d.s[0], d.s[2], e.s[0], e.s[2]), Math.min(d.s[1], d.s[3], e.s[1], e.s[3]), Math.max(d.s[0], d.s[2], e.s[0], e.s[2]), Math.max(d.s[1], d.s[3], e.s[1], e.s[3])];
      if (Math.min(b[2] - b[0], b[3] - b[1]) >= 250 && Math.max(b[2] - b[0], b[3] - b[1]) <= 3000) out.push({ ref: d.s[4], box: b, crossed: true });
    }
  });
  return out;
}
// Whole drawn paths that lie inside an object's box (its sides, the cross on a bunk, a basin in a counter). A path
// that runs on far beyond the box (a hull line passing a bollard) keeps its pieces inside the box.
function insideObjects(segs, objects, heavyPen = () => false) {
  const out = new Set();
  if (!objects.length) return out;
  const pathBox = new Map();
  segs.forEach((s) => { const b = pathBox.get(s[4]) || [Infinity, Infinity, -Infinity, -Infinity]; pathBox.set(s[4], [Math.min(b[0], s[0], s[2]), Math.min(b[1], s[1], s[3]), Math.max(b[2], s[0], s[2]), Math.max(b[3], s[1], s[3])]); });
  const grid = new SegGrid(segs, 1500);
  for (const o of objects) {
    const b = [o.box[0] - 20, o.box[1] - 20, o.box[2] + 20, o.box[3] + 20];
    for (const i of grid.query(b)) {
      const pb = pathBox.get(segs[i][4]), sg = segs[i];
      if (heavyPen(sg[4])) continue; // drawn with the shell pen: hull, not furniture
      const whole = boxContains(b, [pb[0], pb[1]]) && boxContains(b, [pb[2], pb[3]]);
      const shortPath = Math.hypot(pb[2] - pb[0], pb[3] - pb[1]) < 4000;
      if (whole || (shortPath && boxContains(b, [sg[0], sg[1]]) && boxContains(b, [sg[2], sg[3]]))) out.add(i);
    }
  }
  return out;
}
// The pen of the walls: the length-weighted median width of lines longer than 1 m; a pen thinner than 60 % of it is
// detail. Nothing is dropped when the drawing has one pen or no widths.
function thinPen(segs, strokeMM) {
  const long = segs.map((s) => ({ w: strokeMM(s[4]) || 0, L: segLen(s) })).filter((x) => x.L >= 1000 && x.w > 0).sort((a, b) => a.w - b.w);
  const total = long.reduce((t, x) => t + x.L, 0);
  let acc = 0, ref = 0;
  for (const x of long) { acc += x.L; if (acc >= total / 2) { ref = x.w; break; } }
  const set = new Set();
  if (!ref) return { set, count: 0, limit: null, ref: 0 };
  // a finer pen is detail only when it draws dense short strokes (machinery drawn in detail: tens of thousands of
  // strokes, a few cm each on average); a fine pen that also draws lines (a hull line, a tank boundary) is line work
  const byPen = new Map();
  segs.forEach((s) => { const w = Math.round((strokeMM(s[4]) || 0) * 100) / 100; if (!byPen.has(w)) byPen.set(w, []); byPen.get(w).push(segLen(s)); });
  const detail = new Set();
  for (const [w, lens] of byPen) {
    if (!(w > 0 && w < 0.6 * ref)) continue;
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    if (mean < 60) detail.add(w);
  }
  segs.forEach((s, i) => { if (detail.has(Math.round((strokeMM(s[4]) || 0) * 100) / 100)) set.add(i); });
  return { set, count: set.size, limit: 0.6 * ref, ref, detailPens: [...detail] };
}
// A wall line ending within 300 mm of another line, pointing at it, is extended to meet it (an end left short, a line
// interrupted for a symbol); a free end within 120 mm of another line's end is joined to it.
function closeSmallGaps(segs) {
  const lineLen = new Map();
  for (const s of segs) lineLen.set(s[4], (lineLen.get(s[4]) || 0) + segLen(s));
  const grid = new SegGrid(segs, 1500), out = [];
  const touches = (p, self) => { for (const i of grid.query([p[0] - PLAN.snap, p[1] - PLAN.snap, p[0] + PLAN.snap, p[1] + PLAN.snap])) if (i !== self && pointSegment(p, segs[i]).d <= PLAN.snap) return true; return false; };
  segs.forEach((s, i) => {
    if ((lineLen.get(s[4]) || 0) < 300) return; // a wall-sized line, possibly drawn as many short steps
    for (const [p, q] of [[[s[0], s[1]], [s[2], s[3]]], [[s[2], s[3]], [s[0], s[1]]]]) {
      if (touches(p, i)) continue;
      const d = unit(sub(p, q)), far = add(p, mul(d, 300));
      let best = null;
      for (const j of grid.query([Math.min(p[0], far[0]) - 1, Math.min(p[1], far[1]) - 1, Math.max(p[0], far[0]) + 1, Math.max(p[1], far[1]) + 1])) {
        if (j === i) continue;
        const x = segIntersect([p[0], p[1], far[0], far[1]], segs[j]);
        if (x && x.t > 0 && x.t <= 1 && x.u >= 0 && x.u <= 1 && (!best || x.t < best)) best = x.t;
      }
      if (best != null) { out.push([p[0], p[1], p[0] + (far[0] - p[0]) * best, p[1] + (far[1] - p[1]) * best, 'gap-bridge']); continue; }
      // no line crossing ahead: the same line continuing after a gap (collinear, up to 300 mm on), else the nearest
      // end of another line within 120 mm (two lines that miss each other)
      let near = null;
      for (const j of grid.query([p[0] - 300, p[1] - 300, p[0] + 300, p[1] + 300])) {
        if (j === i) continue;
        for (const e of [[segs[j][0], segs[j][1]], [segs[j][2], segs[j][3]]]) {
          const v = sub(e, p), along = dot(v, d), off = Math.abs(cross(d, v)), dd = dist(e, p);
          // the gap continues the other line (p lies on its extension): judged on that line, as the last step of a
          // curve written in tiny pieces may point anywhere
          const dj = dirOf(segs[j]);
          const onItsLine = dd <= 300 && Math.abs(cross(dj, v)) <= PLAN.snap && segLen(segs[j]) >= 3 * dd;
          const straight = (along > PLAN.snap && along <= 300 && off <= PLAN.snap && Math.abs(cross(d, dj)) < Math.sin(3 * DEG)) || (onItsLine && dd > PLAN.snap);
          const close = dd > PLAN.snap && dd <= 120;
          if ((straight || close) && (!near || (straight && !near.straight) || (straight === near.straight && dd < near.d))) near = { e, d: dd, straight };
        }
      }
      if (near) out.push([p[0], p[1], near.e[0], near.e[1], 'gap-bridge']);
    }
  });
  return out;
}
function labelledObjects(objects, labels) {
  const out = [];
  for (const o of objects) {
    const g = labels.find((l) => l.room && (l.room.type === 'equipment' || l.room.type === 'liferaft') && boxContains(o.box, l.c));
    if (!g) continue;
    const b = o.box;
    out.push({ polygon: [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], label: g.text, type: g.room.type, labelIds: g.ids, evidence: [o.ref, ...g.ids] });
  }
  return out;
}

// ---------- walls ----------

// Pairs of parallel lines 4–400 mm apart overlapping by half the shorter: one wall on the mid-line.
export function pairWalls(lines, segs) {
  const long = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.len >= PLAN.wall.minLen);
  const grid = new SegGrid(long.map(({ l }) => [l.a[0], l.a[1], l.b[0], l.b[1]]), 2000);
  const best = new Map();
  const cand = [];
  long.forEach(({ l }, a) => {
    const m = PLAN.wall.gap[1];
    const b = [Math.min(l.a[0], l.b[0]) - m, Math.min(l.a[1], l.b[1]) - m, Math.max(l.a[0], l.b[0]) + m, Math.max(l.a[1], l.b[1]) + m];
    for (const bi of grid.query(b)) {
      if (bi <= a) continue;
      const o = long[bi].l;
      if (Math.abs(cross(l.dir, o.dir)) > Math.sin(1 * DEG)) continue;
      const off = Math.abs(dot(l.n, sub(o.a, l.a)));
      if (off < PLAN.wall.gap[0] || off > PLAN.wall.gap[1]) continue;
      const s0 = dot(l.dir, o.a), s1 = dot(l.dir, o.b);
      const ov = Math.min(l.t1, Math.max(s0, s1)) - Math.max(l.t0, Math.min(s0, s1));
      if (ov < PLAN.wall.overlap * Math.min(l.len, o.len)) continue;
      cand.push({ a, b: bi, off, ov: [Math.max(l.t0, Math.min(s0, s1)), Math.min(l.t1, Math.max(s0, s1))] });
      best.set(a, Math.min(best.get(a) ?? Infinity, off));
      best.set(bi, Math.min(best.get(bi) ?? Infinity, off));
    }
  });
  const walls = [], pairedSegs = new Set(), pairedLines = new Set();
  for (const c of cand) {
    if (c.off > best.get(c.a) + 1 || c.off > best.get(c.b) + 1) continue;
    const A = long[c.a].l, B = long[c.b].l;
    const rhoB = dot(A.n, B.a);
    const mid = (A.rho + rhoB) / 2;
    const p = (t) => add(mul(A.dir, t), mul(A.n, mid));
    walls.push({ a: p(c.ov[0]), b: p(c.ov[1]), thickness: c.off, dir: A.dir, n: A.n, rho: mid, t0: c.ov[0], t1: c.ov[1], lines: [long[c.a].i, long[c.b].i],
      evidence: [...new Set([...A.members, ...B.members].map((k) => segs[k][4]))] });
    pairedLines.add(long[c.a].i); pairedLines.add(long[c.b].i);
    for (const k of [...A.members, ...B.members]) pairedSegs.add(k);
  }
  return { walls, pairedSegs, pairedLines };
}

// Gaps between wall ends facing each other along one line, 0.5–2.5 m apart, with no door swing: openings.
export function findOpenings(segs, lines, wallInfo, doors) {
  const ends = [];
  const grid = new SegGrid(segs, 1500);
  // wall ends: a paired wall's end where nothing continues beyond it (a jamb, or a free end). A wall meeting another
  // wall at a corner or a T has that wall's faces right beyond its end.
  for (const w of wallInfo.walls) {
    for (const [p, out] of [[w.a, mul(w.dir, -1)], [w.b, w.dir]]) {
      const probe = [...add(p, mul(out, 5)), ...add(p, mul(out, 150))];
      let attached = false;
      for (const i of grid.query([Math.min(probe[0], probe[2]) - 1, Math.min(probe[1], probe[3]) - 1, Math.max(probe[0], probe[2]) + 1, Math.max(probe[1], probe[3]) + 1])) {
        const x = segIntersect(probe, segs[i]);
        if (x && x.t >= 0 && x.t <= 1 && x.u >= -0.001 && x.u <= 1.001) { attached = true; break; }
      }
      if (!attached) ends.push({ p, out, w });
    }
  }
  // every facing pair 0.5–2.5 m apart with nothing across the gap; the nearest pairs first
  const pairs = [];
  for (let i = 0; i < ends.length; i++) {
    const e = ends[i];
    for (let j = i + 1; j < ends.length; j++) {
      const f = ends[j];
      if (dot(e.out, f.out) > -0.999) continue;
      const v = sub(f.p, e.p), d = dot(v, e.out);
      if (d < PLAN.opening.gap[0] || d > PLAN.opening.gap[1]) continue;
      if (Math.abs(cross(e.out, v)) > 15 || Math.abs(f.w.thickness - e.w.thickness) > 0.25 * e.w.thickness + 5) continue;
      const across = [e.p[0], e.p[1], f.p[0], f.p[1]];
      // something crossing the gap (a jamb, another wall) makes it a passage between two walls, not one opening
      if (segs.some((s) => { const x = segIntersect(across, s); return x && x.t > 0.02 && x.t < 0.98 && x.u > 0.01 && x.u < 0.99; })) continue;
      pairs.push({ i, j, d });
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const openings = [];
  const used = new Set();
  for (const { i, j, d } of pairs) {
    if (used.has(i) || used.has(j)) continue;
    used.add(i); used.add(j);
    const e = ends[i], f = ends[j];
    const m = mul(add(e.p, f.p), 0.5);
    // a door swing at this gap makes it a door, not an opening
    const swing = doors.filter((dr) => dist(mul(add(dr.hinge, dr.closedEnd), 0.5), m) < Math.max(400, 0.3 * d) && Math.abs(dr.width - d) < 0.25 * d);
    if (swing.length) { for (const dr of swing) dr.gap = { width: d, thickness: e.w.thickness }; continue; }
    const t = e.w.thickness;
    const closers = [-1, 1].map((k) => [...add(e.p, mul(e.w.n, (k * t) / 2)), ...add(f.p, mul(e.w.n, (k * t) / 2))]);
    openings.push({ index: openings.length, a: e.p, b: f.p, width: d, thickness: t, dir: e.out, closers, walls: [e.w, f.w], evidence: [...new Set([...e.w.evidence, ...f.w.evidence])] });
  }
  return openings;
}

// Virtual segments closing a door gap: the hinge line, plus the opposite wall face when the wall is drawn double
// (two segment ends across the gap, parallel to it and as far apart as the swing is wide).
function closeGap(h, c, segs) {
  const out = [[h[0], h[1], c[0], c[1]]];
  const d = unit(sub(c, h)), n = [-d[1], d[0]], w = dist(h, c);
  const nearH = [], nearC = [];
  for (const s of segs) {
    for (const p of [[s[0], s[1]], [s[2], s[3]]]) {
      const v = sub(p, h), along = dot(v, d), off = dot(v, n);
      if (Math.abs(off) < 20 || Math.abs(off) > 420) continue;
      if (Math.abs(along) < 0.08 * w + 20) nearH.push({ p, off });
      else if (Math.abs(along - w) < 0.08 * w + 20) nearC.push({ p, off });
    }
  }
  const seen = new Set();
  for (const a of nearH) for (const b of nearC) {
    if (Math.abs(a.off - b.off) > 8) continue;
    const key = Math.round(a.off / 10);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([a.p[0], a.p[1], b.p[0], b.p[1]]);
  }
  return out;
}

// ---------- components ----------

// Furniture: a small component (≤ 3.5 m across) with no wall in it, not touching anything else. It is not a hole.
function classifyComponents(graph, segs, pairedSegs, namePoints = []) {
  const pairedRefs = new Set([...pairedSegs].map((k) => segs[k][4]));
  return graph.comps.map((comp) => {
    const ring = comp.outer?.ring || [];
    const box = ringBox(ring.length ? ring : [[0, 0]]);
    const diag = Math.hypot(box[2] - box[0], box[3] - box[1]);
    const refs = new Set();
    for (const f of comp.faces) for (const e of f.edges) refs.add(graph.edges[e][2]);
    const hasWall = [...refs].some((r) => pairedRefs.has(r));
    const virtual = [...refs].some((r) => typeof r === 'string' && /^(door|opening|centreline)/.test(r));
    const outerArea = comp.outer ? -comp.outer.area : 0;
    // a small closed shape with a room name in it is that room (a tank drawn as a box), not furniture
    const named = ring.length > 2 && namePoints.some((p) => boxContains(box, p) && pointInRing(p, ring));
    return { comp, box, diag, outerArea, furniture: diag <= PLAN.furniture.maxDiag && !hasWall && !virtual && !named, refs };
  });
}

function labelledFurniture(furn, labels) {
  const out = [];
  for (const c of furn) {
    const ring = c.comp.outer?.ring;
    if (!ring || ring.length < 3) continue;
    const g = labels.find((l) => l.room && (l.room.type === 'equipment' || l.room.type === 'liferaft') && pointInRing(l.c, ring));
    if (!g) continue;
    out.push({ polygon: ensureCCW(simplifyRing(ring.slice(), 1)), label: g.text, type: g.room.type, labelIds: g.ids, evidence: [...c.refs].filter((r) => typeof r === 'string').concat(g.ids) });
  }
  return out;
}

// ---------- labels ----------

/**
 * Texts → label groups: lines of one label written under each other ("Galley" / "stores", "2 students" / "3,2 m²")
 * are joined. Each group: { text, c, h, ids, room: roomOf(text) | null, area: printed m² | null }.
 */
export function labelGroups(texts) {
  const ts = texts.filter((t) => String(t.text).trim()).map((t) => ({ ...t }));
  const uf = new UnionFind(ts.length);
  const byY = ts.map((t, i) => i).sort((a, b) => ts[b].c[1] - ts[a].c[1]);
  for (let x = 0; x < byY.length; x++) {
    const a = ts[byY[x]];
    for (let y = x + 1; y < byY.length; y++) {
      const b = ts[byY[y]];
      const dy = a.c[1] - b.c[1];
      if (dy > 1.9 * Math.max(a.h, b.h)) break;
      if (Math.abs(a.angle || 0) > 5 || Math.abs(b.angle || 0) > 5) continue;
      if (Math.abs(a.h - b.h) > 0.25 * Math.max(a.h, b.h) || dy < 0.6 * a.h) continue;
      // a bare number (a frame number, a dimension) is not a line of a room label
      if (isBareNumber(a.text) || isBareNumber(b.text)) continue;
      // extents from the centre and the character count (some PDF text boxes are far wider than their text)
      const ax = spanOf(a), bx = spanOf(b);
      const sameStart = Math.abs(ax[0] - bx[0]) < 1.2 * a.h, sameMid = Math.abs((ax[0] + ax[1]) / 2 - (bx[0] + bx[1]) / 2) < 1.2 * a.h;
      if (!(sameStart || sameMid)) continue;
      // lines this close and aligned are one label ("Roll Damp" / "Tank", "Steering gear" / "Winch room," / "Cargo
      // Hold"); an annotation ("Vent", "Emg exit") next to a name stays apart
      if (isAnnotationWord(a.text) !== isAnnotationWord(b.text)) continue;
      uf.union(byY[x], byY[y]);
    }
  }
  const groups = new Map();
  ts.forEach((t, i) => { const r = uf.find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(t); });
  return [...groups.values()].map((g) => {
    g.sort((a, b) => b.c[1] - a.c[1]);
    const text = g.map((t) => String(t.text).trim()).join(' ').replace(/\/ /g, '/');
    const c = [g.reduce((s, t) => s + t.c[0], 0) / g.length, g.reduce((s, t) => s + t.c[1], 0) / g.length];
    const printed = g.map((t) => areaOf(t.text)).find((v) => v != null) ?? null;
    return { text, c, h: Math.max(...g.map((t) => t.h)), ids: g.map((t) => t.id), room: roomOf(text), area: printed, annotation: isAnnotationWord(text), number: numericText(text) != null };
  });
}

// A label that names a space (not an annotation, a number or a thing standing in the room).
const isRoomLabel = (g) => !g.annotation && !g.number && /[A-Za-z]{2,}/.test(g.text) && !['equipment', 'liferaft', 'ladder'].includes(g.room?.type);

/**
 * Leader lines: a label written outside its space, underlined, with a line running from the underline to the space
 * (often ending in an arrow). The far end of the line chain starting next to the label becomes g.target.
 */
function leaderTargets(labels, segs, strokeMM = () => 0, fillRefs = new Set()) {
  // the arrowheads: small filled shapes
  const heads = new PointGrid(300);
  segs.forEach((s) => { if (fillRefs.has(s[4])) { heads.add([s[0], s[1]], 1); heads.add([s[2], s[3]], 1); } });
  // leaders are short drawn paths; pieces of long lines (walls, the shell) are never part of one
  const pathLen = new Map();
  for (const s of segs) pathLen.set(s[4], (pathLen.get(s[4]) || 0) + segLen(s));
  const short = (j) => (pathLen.get(segs[j][4]) || 0) <= 4000;
  const grid = new PointGrid(500);
  segs.forEach((s, i) => { grid.add([s[0], s[1]], [i, 0]); grid.add([s[2], s[3]], [i, 1]); });
  for (const g of labels) {
    if (!isRoomLabel(g)) continue;
    const w = 0.6 * g.h * Math.max(1, g.text.length);
    let best = null;
    // the underline or the leader starts at the label: an end within half a text height of its box
    for (const [p, [i, end]] of grid.near(g.c, w / 2 + 1.5 * g.h)) {
      if (Math.abs(p[1] - g.c[1]) > 3.6 * g.h || Math.abs(p[0] - g.c[0]) > w / 2 + 1.2 * g.h) continue;
      if (!short(i) || !isUnderline(segs[i], g, w)) continue; // a leader starts with the label's underline
      const chain = followChain(i, end, segs, grid, g.h, strokeMM, short, (p) => heads.near(p, 0.8 * g.h).length > 0);
      // after the underline the leader runs off at a slant (a wall next to a label runs square)
      const slanted = chain.segs.slice(1).some((q) => { const a = Math.abs(Math.atan2(q[3] - q[1], q[2] - q[0])) % (Math.PI / 2); return a > 0.17 && a < Math.PI / 2 - 0.17; });
      // and ends in an arrowhead (a door leaf or a furniture line next to a label does not)
      const arrow = heads.near(chain.end, 0.8 * g.h).length > 0;
      // the label's own underline is the nearest one under it (labels stacked above each other each have theirs)
      const under = g.c[1] - (segs[i][1] + segs[i][3]) / 2;
      if (slanted && arrow && chain.length >= 4 * g.h && (!best || under < best.under)) best = { ...chain, under };
    }
    if (best && dist(best.end, g.c) > 3 * g.h) { g.target = best.end; g.leaderSegs = best.segs; }
  }
}
// The leader: pieces of one pen, none longer than 4 m, joined end to end.
// A horizontal line just under the label, about as long as the text.
function isUnderline(s, g, w) {
  const L = segLen(s);
  if (Math.abs(s[3] - s[1]) > 0.03 * L || L < 0.6 * w || L > 2 * w + 2 * g.h) return false;
  const below = g.c[1] - (s[1] + s[3]) / 2;
  const overlap = Math.min(Math.max(s[0], s[2]), g.c[0] + w / 2) - Math.max(Math.min(s[0], s[2]), g.c[0] - w / 2);
  return below >= 0.3 * g.h && below <= 3.5 * g.h && overlap >= 0.5 * w;
}

function followChain(i, startEnd, segs, grid, h, strokeMM = () => 0, short = () => true, atArrow = () => false) {
  const pen = strokeMM(segs[i][4]) || 0;
  let s = segs[i], at = startEnd === 0 ? [s[2], s[3]] : [s[0], s[1]];
  let length = segLen(s);
  const used = new Set([i]);
  const chainSegs = [s];
  for (let hop = 0; hop < 4 && !atArrow(at); hop++) { // the arrowhead ends the leader
    const next = grid.near(at, 0.3 * h).find(([, [j]]) => !used.has(j) && short(j) && Math.abs((strokeMM(segs[j][4]) || 0) - pen) <= 0.05 * Math.max(pen, 1));
    if (!next) break;
    const [, [j, e]] = next;
    used.add(j); s = segs[j]; chainSegs.push(s);
    at = e === 0 ? [s[2], s[3]] : [s[0], s[1]];
    length += segLen(s);
  }
  return { end: at, length, segs: chainSegs };
}

const isBareNumber = (t) => /^\s*[+-]?\d+(?:[.,]\d+)?\s*$/.test(String(t));
const spanOf = (t) => { const w = 0.6 * t.h * Math.max(1, String(t.text).trim().length); return [t.c[0] - w / 2, t.c[0] + w / 2]; };

// ---------- rooms ----------

function buildRooms(faces, labels, outlineRing, graph) {
  const inside = (f) => pointInRing(pointInside(f.ring, f.holes.map((h) => h.ring)), outlineRing);
  // mean width: area over half the boundary length (holes included), small for the strip between two wall faces
  // (spikes of lines ending inside the face, such as a leader, do not count)
  const thick = (f) => f.area / ((perimeterOf(simplifyRing(f.ring, 5)) + f.holes.reduce((t, h) => t + perimeterOf(h.ring), 0)) / 2);
  const cand = faces.filter((f) => f.area > 0 && inside(f));
  const roomSized = (f) => f.area >= PLAN.room.minArea && thick(f) >= PLAN.room.minThick;
  // a named space may be small (a day tank, a sea chest): its label is the evidence
  const namedSized = (f) => f.area >= PLAN.room.minNamed && thick(f) >= PLAN.room.minNamedThick;
  // equipment, liferafts and ladders are objects in a room, not room names
  const roomish = isRoomLabel;
  const smallest = (p) => cand.filter((x) => pointInRing(p, x.ring)).sort((a, b) => a.gross - b.gross)[0];
  const smallestNamed = (p) => cand.filter((x) => namedSized(x) && pointInRing(p, x.ring)).sort((a, b) => a.gross - b.gross)[0];
  const byFace = new Map();
  const unresolved = [];
  for (const g of labels) {
    if (!roomish(g)) continue;
    // smallest face containing the label (a label on a table still names the room around the table)
    // the smallest closed area around the label that can be a space (a label written over a sliver or an arrowhead
    // names the space around it); outside every such area: follow its leader line, if it has one
    let f = smallestNamed(g.c) || smallest(g.c);
    // a label with a leader line names the space the leader points into, wherever the text itself stands
    if (g.target) { const t = smallestNamed(g.target); if (t && t !== f) { f = t; g.viaLeader = true; } }
    if (!f) {
      if (g.room) unresolved.push({ what: `label "${g.text}" is not inside a closed area of the plan (the walls around it do not form a loop)`, at: g.c, texts: g.ids });
      continue;
    }
    if (!namedSized(f)) {
      if (g.room) unresolved.push({ what: `label "${g.text}" lies in an area of ${(f.area / 1e6).toFixed(2)} m² that is too small or narrow for a room (inside a wall or furniture)`, at: g.c, texts: g.ids });
      continue;
    }
    if (!byFace.has(f)) byFace.set(f, []);
    byFace.get(f).push(g);
  }
  // a printed area on a line of its own, kept apart from the name by a room number ("Stanza" / "5.02" / "15.84 m²",
  // "Cabin" / "201" / "9,6 m²"), belongs to the named space it stands in; only when that space has no printed area yet
  const areaText = new Map(); // face → the label group holding its printed area
  for (const g of labels) {
    if (g.area == null || isRoomLabel(g)) continue;
    const f = smallestNamed(g.c);
    const ls = f && byFace.get(f);
    if (!ls || ls.some((x) => x.area != null) || areaText.has(f)) continue;
    areaText.set(f, g);
  }
  const printedOf = (f, ls) => ls.map((g) => g.area).find((v) => v != null) ?? areaText.get(f)?.area ?? null;
  // a printed area is evidence: a cabin split by its bunks is joined with the unlabelled pieces next to it, when that
  // brings its area to the printed value (within 3 %)
  const absorbed = new Map(); // face → the labelled face that took it in
  const merges = mergeByPrintedArea(cand, byFace, graph, absorbed, printedOf);
  const list = [], things = [];
  let small = 0;
  for (const f of cand) {
    const ls = byFace.get(f) || [];
    if (absorbed.has(f) || !(ls.length ? namedSized(f) : roomSized(f))) continue;
    // unlabelled faces under 2 m² (wall cavities, ducts, furniture left-overs) are not rooms; only counted
    if (!ls.length && f.area < PLAN.room.minUnlabelled) { small++; continue; }
    // an unnamed closed shape with an object's name in it (a container, a winch) is that object, not a room
    const thing = !ls.length && f.area <= 20e6 && labels.find((g) => g.room?.type === 'equipment' && pointInRing(g.c, f.ring) && !f.holes.some((h) => pointInRing(g.c, h.ring)));
    if (thing) { things.push({ polygon: ensureCCW(simplifyRing(f.ring, 1)), label: thing.text, type: 'equipment', labelIds: thing.ids, evidence: thing.ids }); continue; }
    const m = merges.get(f);
    const ring = ensureCCW(simplifyRing(m?.ring ?? f.ring, 1));
    const holes = [...f.holes.map((h) => h.ring), ...(m?.holes ?? [])].map((h) => simplifyRing(h, 1));
    const c = pointInside(ring, holes);
    // the best label: a known room word first, then the most central
    const ranked = ls.slice().sort((a, b) => (b.room ? 1 : 0) - (a.room ? 1 : 0) || dist(a.c, c) - dist(b.c, c));
    const main = ranked[0] || null;
    const others = ranked.slice(1).filter((g) => g.room && !sameRoomWords(g, main));
    for (const o of others) unresolved.push({ what: `label "${o.text}" shares one closed area with "${main.text}": the walls between them do not close (a gap or a missing line); kept as one room named "${nameOf(main)}"`, at: o.c, texts: o.ids });
    const printed = printedOf(f, ls);
    const room = { ring, holes, area: m ? m.area : f.area, gross: f.gross, centre: c, label: main ? nameOf(main) : null, labelIds: [...ls.flatMap((g) => g.ids), ...(ls.length && areaText.has(f) ? areaText.get(f).ids : [])], type: main?.room?.type ?? 'space',
      zone: main?.room?.zone ?? null, printedArea: printed, recognised: !!main?.room, labelled: !!main, sharedLabels: others.map((o) => o.text), contains: [], faces: m ? m.faces : [f], evidence: [], notes: [] };
    if (main?.viaLeader) room.notes.push(`label "${main.text}" is outside the space and points to it with a leader line`);
    if (main && !main.room) room.notes.push(`label "${main.text}" is not in the room vocabulary: type space, zone not set`);
    if (!main) room.notes.push('no label inside: unnamed space');
    if (m) room.notes.push(`joined with ${m.faces.length - 1} unlabelled area${m.faces.length === 2 ? '' : 's'} next to it (separated only by furniture lines) using the printed area ${printed} m²: ${(m.before / 1e6).toFixed(2)} → ${(m.area / 1e6).toFixed(2)} m²`);
    const cw = clearWidth(ring);
    room.width = cw;
    if (room.type === 'corridor' || (!main && cw && cw.aspect >= PLAN.corridor.aspect && cw.min >= PLAN.corridor.width[0] && cw.min <= PLAN.corridor.width[1])) {
      if (room.type !== 'corridor') { room.type = 'corridor'; room.zone = 'circulation'; room.notes.push(`long and narrow (${cw.aspect.toFixed(1)}:1, ${Math.round(cw.min)} mm wide): taken as a corridor`); }
    }
    list.push(room);
  }
  // labels of things in a room (a fridge, a server rack): a note on the room, not a problem
  for (const g of labels) {
    if (g.room?.type !== 'equipment') continue;
    const r = list.find((x) => pointInRing(g.c, x.ring));
    if (r) r.contains.push(g.text);
  }
  return { list, unresolved, unlabelledSmall: small, things };
}
// A room's name: its label without the printed area ("2 crew 6,4 m²" → "2 crew").
const nameOf = (g) => g.text.replace(/\s*\d+(?:[.,]\d+)?\s*m\s*[²2³3?�]\s*/gi, ' ').trim() || g.text;

// Faces next to each other share an edge of the planar graph; a door or opening closure between them is a real
// boundary and is never crossed.
function mergeByPrintedArea(cand, byFace, graph, absorbed, printedOf = (f, ls) => ls.map((g) => g.area).find((v) => v != null) ?? null) {
  const out = new Map();
  if (!graph) return out;
  const faceOfHalf = new Map();
  for (const f of cand) for (const h of f.face.halves) faceOfHalf.set(h, f);
  const virtualEdge = (e) => { const r = graph.edges[e][2]; return typeof r === 'string' && /^(door|opening|centreline)/.test(r); };
  const neighbours = (f) => {
    const set = new Set();
    for (const h of f.face.halves) { if (virtualEdge(h >> 1)) continue; const g = faceOfHalf.get(h ^ 1); if (g && g !== f) set.add(g); }
    return set;
  };
  for (const [f, ls] of byFace) {
    const P = printedOf(f, ls);
    if (P == null) continue;
    const target = P * 1e6;
    if (f.area >= 0.97 * target) continue;
    const set = new Set([f]);
    let A = f.area;
    for (let step = 0; step < 24 && A < 0.97 * target; step++) {
      let best = null;
      for (const g of set) for (const n of neighbours(g)) {
        if (set.has(n) || absorbed.has(n) || byFace.has(n) || out.has(n)) continue;
        if (A + n.area > 1.03 * target) continue;
        if (!best || Math.abs(A + n.area - target) < Math.abs(A + best.area - target)) best = n;
      }
      if (!best) break;
      set.add(best); A += best.area;
    }
    const log = () => {}; // (reasons a merge is refused; kept as hooks for debugging)
    if (set.size < 2 || Math.abs(A / target - 1) > 0.03) { log('pieces do not add up'); continue; }
    const ring = unionRing([...set], graph);
    if (!ring) { log('no single outline'); continue; }
    // the joined outline may close around small unlabelled pieces (the footprint of a bunk, a locker): they become
    // holes of the room, as its printed area is the free floor; no named space and no larger area may be inside
    if ([...byFace.keys()].some((o) => o !== f && pointInRing(pointInside(o.ring), ring))) { log('another named space inside'); continue; }
    const enclosed = cand.filter((o) => !set.has(o) && !byFace.has(o) && !absorbed.has(o) && pointInRing(pointInside(o.ring), ring));
    if (enclosed.some((o) => o.area > 1.5e6)) { log(`outline closes around ${(enclosed.reduce((t, o) => t + o.area, 0) / 1e6).toFixed(2)} m² more`); continue; }
    for (const g of [...set, ...enclosed]) if (g !== f) absorbed.set(g, f);
    out.set(f, { faces: [...set], area: A, before: f.area, ring, holes: enclosed.map((o) => o.ring) });
  }
  return out;
}

// Outline of a set of adjacent faces: their half-edges whose twin is not in the set, chained into one loop.
function unionRing(set, graph) {
  const inSet = new Set(set.flatMap((f) => f.face.halves));
  const from = (h) => (h & 1 ? graph.edges[h >> 1][1] : graph.edges[h >> 1][0]);
  const to = (h) => (h & 1 ? graph.edges[h >> 1][0] : graph.edges[h >> 1][1]);
  const ang = (h) => { const p = graph.verts[from(h)], q = graph.verts[to(h)]; return Math.atan2(q[1] - p[1], q[0] - p[0]); };
  const boundary = [...inSet].filter((h) => !inSet.has(h ^ 1));
  const byFrom = new Map();
  for (const h of boundary) { const v = from(h); if (!byFrom.has(v)) byFrom.set(v, []); byFrom.get(v).push(h); }
  // where the outline touches itself (several ways on from one point), turn as the face walk does: the first way
  // clockwise from the way back
  const nextOf = (h) => {
    const outs = byFrom.get(to(h)) || [];
    if (outs.length <= 1) return outs[0];
    const back = ang(h) + Math.PI;
    let best = null, bestTurn = Infinity;
    for (const o of outs) { let t = back - ang(o); t = ((t % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI); if (t === 0) t = 2 * Math.PI; if (t < bestTurn) { bestTurn = t; best = o; } }
    return best;
  };
  const used = new Set();
  let bestRing = null;
  for (const h0 of boundary) {
    if (used.has(h0)) continue;
    const ring = [];
    let h = h0, guard = 0;
    while (h !== undefined && !used.has(h) && guard++ <= boundary.length) { used.add(h); ring.push(graph.verts[from(h)]); h = nextOf(h); }
    if (h !== h0 || ring.length < 3) continue;
    if (!bestRing || signedArea(ring) > signedArea(bestRing)) bestRing = ring;
  }
  return bestRing && signedArea(bestRing) > 0 ? bestRing : null;
}
const sameRoomWords = (a, b) => b && normText(a.text) === normText(b.text);
function perimeterOf(ring) { let s = 0; for (let i = 0; i < ring.length; i++) s += dist(ring[i], ring[(i + 1) % ring.length]); return s; }
function ensureCCW(r) { return signedArea(r) < 0 ? r.slice().reverse() : r; }

/**
 * Clear width of a long room: chords across its longer axis at 40 stations (ends left out); the smallest is the
 * clear width (the narrowest place between its long walls), the median gives the aspect ratio.
 */
export function clearWidth(ring) {
  const b = ringBox(ring), lx = b[2] - b[0], ly = b[3] - b[1];
  const alongX = lx >= ly;
  const L = alongX ? lx : ly;
  const chords = [];
  for (let k = 1; k < 40; k++) {
    const s = (alongX ? b[0] : b[1]) + (L * k) / 40;
    if (k < 2 || k > 38) continue;
    const xs = alongX ? crossingsAtX(ring, s) : crossingsAtY(ring, s);
    let best = null;
    for (let i = 0; i + 1 < xs.length; i += 2) { const w = xs[i + 1] - xs[i]; if (w > 100 && (best == null || w > best)) best = w; }
    if (best != null) chords.push(best);
  }
  if (!chords.length) return null;
  chords.sort((a, b2) => a - b2);
  const med = chords[Math.floor(chords.length / 2)];
  return { min: chords[0], median: med, aspect: ringArea(ring) / med / med, along: alongX ? [1, 0] : [0, 1] };
}

// ---------- walls with openings ----------

function buildWalls(wallInfo, lines, segs, outlineRing, doors, openings, strokeMM, furnitureRefs = new Set()) {
  // merge collinear wall pieces of one thickness through T-junction gaps (≤ 450 mm)
  const ws = wallInfo.walls.slice().sort((a, b) => a.rho - b.rho || a.t0 - b.t0);
  const merged = [];
  for (const w of ws) {
    const m = merged.find((o) => Math.abs(cross(o.dir, w.dir)) < Math.sin(0.5 * DEG) && Math.abs(dot(o.n, w.a) - o.rho) < 10 && Math.abs(o.thickness - w.thickness) <= 0.2 * o.thickness + 3 && dot(o.dir, w.a) <= o.t1 + 450 && dot(o.dir, w.b) >= o.t0 - 450);
    if (m) {
      const s0 = dot(m.dir, w.a), s1 = dot(m.dir, w.b);
      m.t0 = Math.min(m.t0, s0, s1); m.t1 = Math.max(m.t1, s0, s1); m.evidence = [...new Set([...m.evidence, ...w.evidence])];
    } else merged.push({ ...w, rho: dot(w.n, w.a), openings: [] });
  }
  // single lines: interior lines with no partner, at least 0.5 m long
  const singles = [];
  lines.forEach((l, i) => {
    if (wallInfo.pairedLines.has(i) || l.len < PLAN.wall.singleMin) return;
    if (l.members.some((k) => furnitureRefs.has(segs[k][4]))) return; // furniture, not a wall
    const mid = mul(add(l.a, l.b), 0.5);
    if (!pointInRing(mid, outlineRing)) return;
    if (distToRing(mid, outlineRing) < 30) return; // the deck edge is the outline, not a wall
    const sw = Math.max(...l.members.map((k) => strokeMM(segs[k][4]) || 0));
    singles.push({ a: l.a, b: l.b, dir: l.dir, n: l.n, rho: dot(l.n, l.a), t0: dot(l.dir, l.a), t1: dot(l.dir, l.b), thickness: sw >= 20 ? sw : PLAN.wall.singleAssumed,
      thicknessBasis: sw >= 20 ? 'measured' : 'assumed', single: true, openings: [], evidence: [...new Set(l.members.map((k) => segs[k][4]))] });
  });
  const all = merged.concat(singles);
  // doors and openings cut into the wall they stand in; pieces on both sides of a gap become one wall
  const cut = (a, b, kind, ref) => {
    const d = unit(sub(b, a)), mid = mul(add(a, b), 0.5);
    const hosts = all.filter((w) => Math.abs(cross(w.dir, d)) < Math.sin(3 * DEG) && Math.abs(dot(w.n, mid) - w.rho) <= w.thickness / 2 + 40);
    if (!hosts.length) return null;
    const ta = dot(hosts[0].dir, a), tb = dot(hosts[0].dir, b);
    const lo = Math.min(ta, tb), hi = Math.max(ta, tb);
    const touching = hosts.filter((w) => w.t1 >= lo - 120 && w.t0 <= hi + 120);
    if (!touching.length) return null;
    const host = touching[0];
    for (const o of touching.slice(1)) { host.t0 = Math.min(host.t0, o.t0); host.t1 = Math.max(host.t1, o.t1); host.evidence = [...new Set([...host.evidence, ...o.evidence])]; host.openings.push(...o.openings); o.dead = true; }
    host.t0 = Math.min(host.t0, lo); host.t1 = Math.max(host.t1, hi);
    host.openings.push({ lo, hi, kind, ref });
    return host;
  };
  for (const d of doors) {
    d.wall = cut(d.hinge, d.closedEnd, 'door', d.index);
    // a door stands in a wall: when none was found, the line the swing is hinged on is that wall (a single line,
    // also the deck edge or a short piece next to the door)
    if (!d.wall) {
      const dd = unit(sub(d.closedEnd, d.hinge));
      const line = lines.filter((l) => Math.abs(cross(l.dir, dd)) < Math.sin(5 * DEG) && Math.abs(dot(l.n, d.hinge) - l.rho) <= 60 && l.len >= 200)
        .sort((p, q) => q.len - p.len)[0];
      if (line) {
        all.push({ a: line.a, b: line.b, dir: line.dir, n: line.n, rho: dot(line.n, line.a), t0: dot(line.dir, line.a), t1: dot(line.dir, line.b), thickness: PLAN.wall.singleAssumed,
          thicknessBasis: 'assumed', single: true, openings: [], evidence: [...new Set(line.members.map((k) => segs[k][4]))] });
        d.wall = cut(d.hinge, d.closedEnd, 'door', d.index);
      }
    }
    if (!d.wall) {
      // no line to stand in was recognised (the jambs only): a short wall piece across the opening, so the door is
      // cut into something; its thickness is assumed
      const dd = unit(sub(d.closedEnd, d.hinge)), n = [-dd[1], dd[0]];
      const a = sub(d.hinge, mul(dd, 100)), b = add(d.closedEnd, mul(dd, 100));
      all.push({ a, b, dir: dd, n, rho: dot(n, a), t0: dot(dd, a), t1: dot(dd, b), thickness: PLAN.wall.singleAssumed, thicknessBasis: 'assumed', single: true,
        openings: [], evidence: d.evidence.slice(0, 2), atDoor: true });
      d.wall = cut(d.hinge, d.closedEnd, 'door', d.index);
    }
  }
  for (const o of openings) o.wall = cut(o.a, o.b, 'opening', o.index);
  // what lies outside the deck outline is not a wall of this deck (rails and lines of other levels drawn around it)
  const inDeck = (p, t) => pointInRing(p, outlineRing) || distToRing(p, outlineRing) <= t + 100;
  for (const w of all) {
    const a = add(mul(w.dir, w.t0), mul(w.n, w.rho)), b = add(mul(w.dir, w.t1), mul(w.n, w.rho));
    if (!w.dead && (!inDeck(a, w.thickness) || !inDeck(b, w.thickness)) && !w.openings.length) w.dead = true;
  }
  return all.filter((w) => !w.dead).map((w) => {
    const a = add(mul(w.dir, w.t0), mul(w.n, w.rho)), b = add(mul(w.dir, w.t1), mul(w.n, w.rho));
    const kind = distToRing(mul(add(a, b), 0.5), outlineRing) <= w.thickness + 80 && nearlyParallelToRing(a, b, outlineRing) ? 'shell' : w.thickness >= 80 ? 'bulkhead' : 'partition';
    return { a, b, thickness: w.thickness, thicknessBasis: w.thicknessBasis || 'measured', kind, single: !!w.single, openings: w.openings.map((o) => ({ from: o.lo - w.t0, to: o.hi - w.t0, kind: o.kind, ref: o.ref })), evidence: w.evidence, _w: w };
  });
}

// A wall end touches another wall or the deck edge.
function joined(w, all, outlineRing) {
  return [w.a, w.b].some((p) => distToRing(p, outlineRing) <= w.thickness / 2 + 60 || all.some((o) => {
    if (o === w) return false;
    return pointSegment(p, [o.a[0], o.a[1], o.b[0], o.b[1]]).d <= (o.thickness + w.thickness) / 2 + 60;
  }));
}
// A counter or bench drawn as a double line: its footprint.
function fittingOf(w) {
  const d = unit(sub(w.b, w.a)), n = [-d[1], d[0]], t = w.thickness / 2;
  return { polygon: ensureCCW([add(w.a, mul(n, -t)), add(w.b, mul(n, -t)), add(w.b, mul(n, t)), add(w.a, mul(n, t))]), label: 'Fitting (counter / bench)', type: 'equipment', height: 900,
    note: `a free-standing double line ${Math.round(w.thickness)} mm deep: a counter, bench or locker, not a wall; height 900 mm assumed`, evidence: w.evidence.slice(0, 10) };
}

// The two sides of a wall lie in different spaces (or one side is outside the deck).
function separates(w, rooms, outlineRing) {
  const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  if (L < 1) return false;
  const n = [-(w.b[1] - w.a[1]) / L, (w.b[0] - w.a[0]) / L];
  const sides = [0.25, 0.5, 0.75].map((t) => {
    const m = [w.a[0] + (w.b[0] - w.a[0]) * t, w.a[1] + (w.b[1] - w.a[1]) * t];
    // step out until a space is met: the strip between the two faces of a wall, or a lining, is no space
    return [1, -1].map((k) => {
      for (const off of [150, 400, 700]) {
        const p = [m[0] + n[0] * off * k, m[1] + n[1] * off * k];
        if (!pointInRing(p, outlineRing)) return 'outside';
        const r = roomAt(rooms, p);
        if (r) return r;
      }
      return null;
    });
  });
  // a side in no space at all (inside furniture, a cavity) separates nothing
  return sides.some(([a, b]) => a !== b && a !== null && b !== null);
}

function distToRing(p, ring) {
  let d = Infinity;
  for (let i = 0; i < ring.length; i++) { const q = ring[(i + 1) % ring.length]; d = Math.min(d, pointSegment(p, [ring[i][0], ring[i][1], q[0], q[1]]).d); }
  return d;
}
function nearlyParallelToRing(a, b, ring) {
  const d = unit(sub(b, a)), mid = mul(add(a, b), 0.5);
  let best = Infinity, par = false;
  for (let i = 0; i < ring.length; i++) {
    const q = ring[(i + 1) % ring.length], s = [ring[i][0], ring[i][1], q[0], q[1]];
    const r = pointSegment(mid, s).d;
    if (r < best) { best = r; par = Math.abs(cross(d, dirOf(s))) < Math.sin(10 * DEG); }
  }
  return par;
}

// ---------- doors and openings: finishing ----------

function finishDoor(d, walls, rooms) {
  const wallDir = unit(sub(d.closedEnd, d.hinge));
  const leaf = unit(sub(d.leaves[0].openEnd, d.leaves[0].hinge));
  d.swing = cross(wallDir, leaf) >= 0 ? 1 : -1;
  const w = d.wall;
  d.thickness = w ? w.thickness : 0;
  // hinge on the wall centre line: the swing is drawn from the face on the leaf's side
  const shift = w ? Math.abs(dot(w.n, d.hinge) - w.rho) : 0;
  const toCentre = w ? mul(w.n, Math.sign(w.rho - dot(w.n, d.hinge)) * shift) : [0, 0];
  d.hingeCL = add(d.hinge, toCentre);
  d.wallDir = wallDir;
  const mid = add(d.hingeCL, mul(wallDir, d.width / 2));
  const n = [-wallDir[1], wallDir[0]], off = (d.thickness || 0) / 2 + 300;
  d.connects = [...new Set([add(mid, mul(n, off)), add(mid, mul(n, -off))].map((p) => roomAt(rooms.list, p)).filter(Boolean))];
}
function finishOpening(o, rooms) {
  const d = unit(sub(o.b, o.a)), n = [-d[1], d[0]], mid = mul(add(o.a, o.b), 0.5), off = o.thickness / 2 + 300;
  o.connects = [...new Set([add(mid, mul(n, off)), add(mid, mul(n, -off))].map((p) => roomAt(rooms.list, p)).filter(Boolean))];
}
function roomAt(list, p) {
  return list.find((r) => pointInRing(p, r.ring) && !r.holes.some((h) => pointInRing(p, h))) || null;
}
