// Views: split a drawing sheet into the separate drawings on it (profile, deck plans, sections, title block, tables)
// and say what each one is, with the evidence. Pure ES module (browser, Web Worker, Node); relative imports only.
//
// findViews(sheet) -> View[] (CONTRACT.md §2). Real sheets have 100k–1M segments: everything here is grid-based
// (linear in the number of segments) or works on per-view summaries.

import { viewTitleOf, deckOf, isTitleBlockWord, endWord, frameOf, numericText, principalOf, scaleOf } from './vocab.mjs';
import { groupSegments, mergeCollinear, boxContains, boxesOverlap, boxUnion, PointGrid } from './plan-graph.mjs';

// ---------- segments ----------

/** All straight pieces of all paths: [x1, y1, x2, y2, pathIndex]. Arcs are included as their tessellation. */
export function sheetSegments(sheet, filter = null) {
  const segs = [];
  sheet.paths.forEach((p, i) => {
    if (filter && !filter(p, i)) return;
    const pts = p.pts;
    for (let k = 1; k < pts.length; k++) segs.push([pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], i]);
    if (p.closed && pts.length > 2) segs.push([pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1], i]);
  });
  return segs;
}

const segBox = (s) => [Math.min(s[0], s[2]), Math.min(s[1], s[3]), Math.max(s[0], s[2]), Math.max(s[1], s[3])];
/**
 * Centre of a text. The box centre is the robust choice for DXF text (centred or right-aligned text has its insertion
 * point elsewhere), but some PDF writers give a text run a box far wider than its characters (a "0" 94 pt wide):
 * then the centre is estimated from the baseline start and the character count.
 */
export function textCentre(t) {
  const h = t.height || (t.box[3] - t.box[1]) || 0;
  const est = 0.6 * h * Math.max(1, String(t.text).trim().length);
  const a = ((t.angle || 0) * Math.PI) / 180, bw = Math.abs(Math.cos(a)) * (t.box[2] - t.box[0]) + Math.abs(Math.sin(a)) * (t.box[3] - t.box[1]);
  if (!t.at || !(bw > 1.6 * est + h)) return [(t.box[0] + t.box[2]) / 2, (t.box[1] + t.box[3]) / 2];
  const c = Math.cos(a), sn = Math.sin(a);
  return [t.at[0] + (c * est) / 2 - (sn * h) / 2, t.at[1] + (sn * est) / 2 + (c * h) / 2];
}

// ---------- frame-number rows ----------

/**
 * Rows of frame numbers among texts: "FR 10" labels or bare integers in one row at one height, whose positions grow
 * linearly with the number (a frame scale along the baseline or the centreline). Returns
 * [{ unitsPerFrame, x0 /* sheet x of frame 0 *\/, y, n: [min, max], ids, residual }] best first.
 */
export function frameRows(texts) {
  const cands = [];
  for (const t of texts) {
    if (Math.abs(t.angle || 0) > 5) continue;
    const fr = frameOf(t.text);
    const n = fr ?? numericText(t.text);
    if (n == null || !Number.isInteger(n) || Math.abs(n) > 400) continue;
    cands.push({ t, n, c: textCentre(t), labelled: fr != null });
  }
  cands.sort((a, b) => a.c[1] - b.c[1]);
  const rows = [];
  let i = 0;
  while (i < cands.length) {
    let j = i + 1;
    const h = cands[i].t.height || 1;
    while (j < cands.length && cands[j].c[1] - cands[j - 1].c[1] < 0.4 * h) j++;
    const row = cands.slice(i, j);
    i = j;
    // the same number twice in a row: two scales side by side (two views): split by x gaps
    for (const part of splitRow(row)) {
      const fit = fitRow(part);
      if (fit) rows.push(fit);
    }
  }
  return rows.sort((a, b) => b.ids.length - a.ids.length);
}

// A row split where the numbers stop growing monotonically along x (two frame scales on one line of the sheet).
function splitRow(row) {
  const s = row.slice().sort((a, b) => a.c[0] - b.c[0]);
  const parts = [];
  let cur = [];
  for (const c of s) {
    if (cur.length >= 2) {
      const dir = Math.sign(cur[cur.length - 1].n - cur[0].n);
      if (dir && Math.sign(c.n - cur[cur.length - 1].n) !== dir) { parts.push(cur); cur = []; }
    }
    if (cur.length && cur[cur.length - 1].n === c.n) { parts.push(cur); cur = []; }
    cur.push(c);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

function fitRow(part) {
  if (part.length < 3) return null;
  const ns = new Set(part.map((p) => p.n));
  if (ns.size < 3) return null;
  const m = part.length, mx = part.reduce((s, p) => s + p.n, 0) / m, my = part.reduce((s, p) => s + p.c[0], 0) / m;
  let sxx = 0, sxy = 0;
  for (const p of part) { sxx += (p.n - mx) ** 2; sxy += (p.n - mx) * (p.c[0] - my); }
  if (!sxx) return null;
  const b = sxy / sxx, a = my - b * mx;
  const span = Math.abs(b) * (Math.max(...ns) - Math.min(...ns));
  const residual = Math.sqrt(part.reduce((s, p) => s + (p.c[0] - (a + b * p.n)) ** 2, 0) / m);
  if (!(Math.abs(b) > 0) || residual > 0.01 * span + 0.3 * (part[0].t.height || 0)) return null;
  return { unitsPerFrame: b, x0: a, y: part.reduce((s, p) => s + p.c[1], 0) / m, n: [Math.min(...ns), Math.max(...ns)], ids: part.map((p) => p.t.id), residual, labelled: part.some((p) => p.labelled) };
}

// ---------- the sheet ----------

/**
 * findViews(sheet) -> View[]: the separate drawings on the sheet, classified.
 * xRange is [aft end, forward end] in sheet x (so it is descending when the bow points left).
 */
export function findViews(sheet) {
  const bbox = sheet.bbox && sheet.bbox[2] > sheet.bbox[0] ? sheet.bbox : bboxOf(sheet);
  const W = bbox[2] - bbox[0], H = bbox[3] - bbox[1], diag = Math.hypot(W, H) || 1;
  const segs = sheetSegments(sheet);
  const why0 = [];
  // 1. sheet border, frame lines and the full-width title strip lines
  const border = new Set();
  sheet.paths.forEach((p, i) => {
    const b = pathBox(p);
    if (b[2] - b[0] >= 0.9 * W && b[3] - b[1] >= 0.9 * H) border.add(i);
  });
  const keep = [];
  for (const s of segs) {
    if (border.has(s[4])) continue;
    const dx = Math.abs(s[2] - s[0]), dy = Math.abs(s[3] - s[1]);
    if ((dy < 1e-3 * dx && dx >= 0.85 * W) || (dx < 1e-3 * dy && dy >= 0.85 * H)) { border.add(s[4]); continue; }
    keep.push(s);
  }
  if (border.size) why0.push(`${border.size} border / frame line${border.size === 1 ? '' : 's'} dropped`);
  // 2. underlines of view titles (they would otherwise be views of their own)
  const titles = sheet.texts.filter((t) => viewTitleOf(t.text) || deckOf(t.text));
  const under = underlineSet(keep, titles);
  const work = keep.filter((s, k) => !under.has(k));
  // 3. connected drawings: segments within ~0.5 % of the sheet diagonal of each other, then overlapping boxes merged
  const gap = 0.005 * diag;
  const group = groupSegments(work, gap);
  let clusters = new Map();
  work.forEach((s, k) => {
    const g = group[k];
    let c = clusters.get(g);
    if (!c) clusters.set(g, c = { segs: [], box: segBox(s) });
    c.segs.push(s); c.box = boxUnion(c.box, segBox(s));
  });
  clusters = mergeOverlapping([...clusters.values()], gap);
  // tiny clusters (symbols, stray marks) lying near a big one belong to it
  clusters = absorbSmall(clusters, diag, gap);
  // 4. texts: inside a cluster, or a title just below / above one
  const assigned = assignTexts(sheet.texts, clusters, gap);
  // 5. classify
  const views = clusters.map((c, i) => describe(c, i, assigned.get(c) || { inside: [], title: null }, { bbox, diag, gap, sheet }));
  linkShipViews(views);
  floorPlans(views, diag);
  dropSymbolPlans(views);
  decideBow(views, sheet);
  return views
    .filter((v) => v.kind !== 'noise')
    .sort((a, b) => b.box[3] - a.box[3] || a.box[0] - b.box[0])
    .map((v, i) => finishView(v, i, why0, sheet));
}

function bboxOf(sheet) {
  let b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of sheet.paths) b = boxUnion(b, pathBox(p));
  return b;
}
function pathBox(p) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of p.pts) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

// Horizontal segments right under a title text, about as long as the text: underlines.
function underlineSet(segs, titles) {
  const out = new Set();
  if (!titles.length) return out;
  const grid = new PointGrid(Math.max(1, Math.max(...titles.map((t) => t.box[2] - t.box[0]))));
  titles.forEach((t) => grid.add(textCentre(t), t));
  segs.forEach((s, k) => {
    if (Math.abs(s[3] - s[1]) > 1e-3 * Math.abs(s[2] - s[0]) + 1e-9) return;
    const mid = [(s[0] + s[2]) / 2, s[1]], len = Math.abs(s[2] - s[0]);
    for (const [, t] of grid.near(mid, grid.cell * 1.5)) {
      const h = t.height || (t.box[3] - t.box[1]), w = t.box[2] - t.box[0];
      if (s[1] > t.box[1] + 0.3 * h || s[1] < t.box[1] - 1.2 * h) continue;
      const ov = Math.min(Math.max(s[0], s[2]), t.box[2]) - Math.max(Math.min(s[0], s[2]), t.box[0]);
      if (ov >= 0.6 * Math.min(w, len) && len <= 2.5 * w + h) { out.add(k); return; }
    }
  });
  return out;
}

function mergeOverlapping(list, gap) {
  let changed = true;
  while (changed) {
    changed = false;
    list.sort((a, b) => a.box[0] - b.box[0]);
    const out = [];
    for (const c of list) {
      // overlapping boxes, or one inside the other: one drawing
      const hit = out.find((o) => boxesOverlap(o.box, c.box, -gap * 0.1) && overlapShare(o.box, c.box) > 0.02);
      if (hit) { hit.segs.push(...c.segs); hit.box = boxUnion(hit.box, c.box); changed = true; } else out.push(c);
    }
    list = out;
  }
  return list;
}
// intersection area as a share of the smaller box
function overlapShare(a, b) {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (w <= 0 || h <= 0) return 0;
  const sa = Math.max((a[2] - a[0]) * (a[3] - a[1]), 1e-12), sb = Math.max((b[2] - b[0]) * (b[3] - b[1]), 1e-12);
  return (w * h) / Math.min(sa, sb);
}

function absorbSmall(list, diag, gap) {
  const big = list.filter((c) => Math.hypot(c.box[2] - c.box[0], c.box[3] - c.box[1]) >= 0.03 * diag || c.segs.length >= 200);
  const small = list.filter((c) => !big.includes(c));
  const rest = [];
  for (const c of small) {
    const host = big.find((b) => boxesOverlap(b.box, c.box, 2 * gap));
    if (host) { host.segs.push(...c.segs); host.box = boxUnion(host.box, c.box); } else rest.push(c);
  }
  return [...big, ...rest];
}

function assignTexts(texts, clusters, gap) {
  const out = new Map(clusters.map((c) => [c, { inside: [], title: null, titleDist: Infinity }]));
  // view titles are written larger than the labels inside the views
  const hs = texts.map((t) => t.height || 0).filter((h) => h > 0).sort((a, b) => a - b);
  const medianH = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  for (const t of texts) {
    const p = textCentre(t);
    const inside = clusters.filter((c) => boxContains(c.box, p)).sort((a, b) => area(a.box) - area(b.box))[0];
    const h = t.height || (t.box[3] - t.box[1]);
    const isTitle = !!(viewTitleOf(t.text) || deckOf(t.text)) && h >= 1.25 * medianH;
    if (inside && !(isTitle && h > 0 && onEdge(inside.box, p, h))) { out.get(inside).inside.push(t); continue; }
    if (isTitle) {
      // the view just above or below the title, overlapping it in x (titles are mostly under their view)
      let best = null, bestD = Infinity;
      for (const c of clusters) {
        if (p[0] < c.box[0] - 4 * gap || p[0] > c.box[2] + 4 * gap) continue;
        const below = c.box[1] - p[1], above = p[1] - c.box[3];
        const d = boxContains(c.box, p) ? 0 : below >= -h ? Math.max(0, below) * 1.2 : above >= -h ? Math.max(0, above) : Infinity;
        if (d < bestD && d <= Math.max(6 * gap, 8 * h)) { best = c; bestD = d; }
      }
      if (best) {
        const o = out.get(best);
        if (bestD < o.titleDist || (o.title && h > (o.title.height || 0) * 1.2 && bestD < o.titleDist + 2 * h)) { if (o.title) o.inside.push(o.title); o.title = t; o.titleDist = bestD; } else o.inside.push(t);
        continue;
      }
    }
    if (inside) { out.get(inside).inside.push(t); continue; }
    const near = clusters.find((c) => boxesOverlap(c.box, [p[0], p[1], p[0], p[1]], gap));
    if (near) out.get(near).inside.push(t);
  }
  return out;
}
// A title text inside a view's box but in its outer band (a box that took in the title of a neighbour)
const onEdge = (b, p, h) => p[1] - b[1] < 2.5 * h || b[3] - p[1] < 2.5 * h;

// ---------- one view ----------

function describe(c, i, texts, ctx) {
  const { diag } = ctx;
  const [x0, y0, x1, y1] = c.box, w = x1 - x0, h = y1 - y0;
  const v = { _c: c, box: c.box, kind: 'other', confidence: 0.3, title: null, titleText: null, deckName: null, deck: null, halfPlan: false,
    centreline: null, baseline: null, bow: null, xRange: null, paths: [...new Set(c.segs.map((s) => s[4]))], texts: texts.inside.map((t) => t.id), why: [], _texts: texts.inside, _scores: {} };
  if (texts.title) { v.title = texts.title.text.trim(); v.titleText = texts.title.id; v.texts.push(texts.title.id); v._texts.push(texts.title); }
  const size = Math.hypot(w, h);
  if (size < 0.02 * diag && c.segs.length < 20 && !v.title) { v.kind = 'noise'; return v; }
  // text evidence
  const titleInfo = v.title ? viewTitleOf(v.title) : null;
  // a big text inside the box can be the title as well (titles inside a frame)
  let inner = null;
  if (!titleInfo) {
    const hs = texts.inside.map((t) => t.height || 0).sort((a, b) => b - a);
    for (const t of texts.inside) if ((t.height || 0) >= (hs[Math.floor(hs.length / 2)] || 0) * 1.4 && viewTitleOf(t.text)) { inner = t; break; }
  }
  const tInfo = titleInfo || (inner ? viewTitleOf(inner.text) : null);
  if (!v.title && inner) { v.title = inner.text.trim(); v.titleText = inner.id; }
  const titleWords = texts.inside.filter((t) => isTitleBlockWord(t.text)).length + (texts.title && isTitleBlockWord(texts.title.text) ? 1 : 0);
  const principal = texts.inside.filter((t) => principalOf(t.text)).length;
  const scales = texts.inside.filter((t) => scaleOf(t.text)).length;
  // geometry evidence
  const g = geometry(c, ctx);
  v._g = g;
  const sc = { profile: 0, plan: 0, section: 0, title: 0, table: 0, other: 0.15 };
  const ev = { profile: [], plan: [], section: [], title: [], table: [] };
  const aspect = w / Math.max(h, 1e-9);
  if (tInfo) { sc[tInfo.kind] += 0.6; ev[tInfo.kind].push(`title "${(texts.title || inner).text.trim()}"`); }
  if (aspect >= 1.8 && g.longH >= 2 && g.symH < 0.55) { sc.profile += 0.35; ev.profile.push(`elongated (${aspect.toFixed(1)}:1) with ${g.longH} long horizontal lines and no mirror symmetry about a horizontal axis`); }
  const deckLabels = texts.inside.filter((t) => deckOf(t.text) && !/^(BELOW|UNDER)/i.test(t.text.trim())).length;
  if (deckLabels >= 2) { sc.profile += 0.15; ev.profile.push(`${deckLabels} deck names inside`); }
  // symmetry says something only about a drawing with some line work: any empty box or bar is symmetric
  const drawn = c.segs.length >= 20;
  if (drawn && g.symH >= 0.55 && aspect >= 1.2) { sc.plan += 0.25 + 0.2 * (g.symH - 0.55) / 0.45; ev.plan.push(`mirror-symmetric about a horizontal axis (${Math.round(g.symH * 100)} % of the line ends)`); }
  if (g.centreline && (g.centreline.dashed || drawn)) { sc.plan += 0.2; ev.plan.push(`centre line at sheet y ${g.centreline.y.toFixed(1)}${g.centreline.dashed ? ' (dash-dot)' : ''}`); }
  if (g.halfPlan) { sc.plan += 0.2; ev.plan.push('drawn on one side of a centre line at its edge (half plan)'); }
  if (drawn && g.symV >= 0.6 && aspect >= 0.35 && aspect <= 2.2 && g.symH < g.symV) { sc.section += 0.4; ev.section.push(`mirror-symmetric about a vertical axis (${Math.round(g.symV * 100)} %)`); }
  if (titleWords >= 2 || (scales && titleWords >= 1)) { sc.title += 0.35 + 0.08 * Math.min(titleWords, 5); ev.title.push(`${titleWords} title-block words`); }
  if (g.corner) { sc.title += titleWords ? 0.15 : 0; if (titleWords) ev.title.push('in a corner of the sheet'); }
  if (principal >= 2) { sc.table += 0.5; ev.table.push(`${principal} principal dimensions`); }
  if (texts.inside.length >= 8 && g.arcs === 0 && g.axisShare > 0.97 && !tInfo) { sc.table += 0.3; ev.table.push(`${texts.inside.length} texts in ruled lines`); }
  v._scores = sc; v._ev = ev;
  const best = Object.entries(sc).sort((a, b) => b[1] - a[1])[0];
  v.kind = best[0];
  v.confidence = Math.min(0.97, Math.max(0.2, best[1]));
  v.why.push(...(ev[v.kind] || []));
  if (v.kind === 'plan' || (tInfo && tInfo.kind === 'plan')) {
    const d = tInfo?.deck || (v.title ? deckOf(v.title) : null);
    if (d) { v.deckName = v.title; v.deck = d; v.why.push(`deck "${d.name}" from the title`); }
  }
  v.centreline = g.centreline ? { y: g.centreline.y } : null;
  v.halfPlan = g.halfPlan;
  v.baseline = g.baseline ? { y: g.baseline.y } : null;
  v.xRangeAbs = g.mainX;
  v.profileKind = tInfo?.profile ?? null;
  return v;
}

// Geometry summary of a cluster: long horizontal lines, centre line, symmetry, baseline, main component extent.
function geometry(c, { bbox, diag, sheet }) {
  const [x0, y0, x1, y1] = c.box, w = x1 - x0, h = y1 - y0;
  const horiz = c.segs.filter((s) => Math.abs(s[3] - s[1]) <= 0.002 * Math.abs(s[2] - s[0]) && Math.abs(s[2] - s[0]) > 0);
  const lines = mergeCollinear(horiz, { angTol: 0.2, offTol: 0.0006 * w + 1e-9, gapTol: 0.012 * w });
  const long = lines.filter((l) => l.len >= 0.5 * w);
  const yOf = (l) => (l.a[1] + l.b[1]) / 2;
  // dash-dot: many short members covering a fraction of the line
  const cover = (l) => l.members.reduce((s, k) => s + Math.abs(horiz[k][2] - horiz[k][0]), 0) / l.len;
  // dashed: flagged by the reader (DXF linetype, PDF dash array) or drawn as a row of short pieces with gaps
  const isDashed = (l) => l.members.every((k) => sheet.paths[horiz[k][4]]?.dash) || gapsOf(l) >= 6;
  // gaps in the union of a line's pieces: a dash-dot line has one per dash, a solid line none
  const gapsOf = (l) => {
    const iv = l.members.map((k) => { const s = horiz[k]; return [Math.min(s[0], s[2]), Math.max(s[0], s[2])]; }).sort((a, b) => a[0] - b[0]);
    let n = 0, end = iv.length ? iv[0][1] : 0;
    for (const [a, b] of iv) { if (a > end + 1e-6 * w) n++; end = Math.max(end, b); }
    return n;
  };
  // main connected drawing (hull and decks), without the dash-dot lines that run past its ends
  const dashMembers = new Set();
  for (const l of lines) if (isDashed(l)) for (const k of l.members) dashMembers.add(horiz[k]);
  const solid = c.segs.filter((s) => !dashMembers.has(s));
  let mainX = [x0, x1], mainBox = c.box;
  if (solid.length) {
    const grp = groupSegments(solid, Math.max(0.0015 * Math.hypot(w, h), 1e-6));
    const boxes = new Map();
    solid.forEach((s, k) => { const b = boxes.get(grp[k]); boxes.set(grp[k], b ? boxUnion(b, segBox(s)) : segBox(s)); });
    let best = null;
    for (const b of boxes.values()) if (!best || (b[2] - b[0]) * (b[3] - b[1]) > (best[2] - best[0]) * (best[3] - best[1])) best = b;
    mainX = [best[0], best[2]]; mainBox = best;
  }
  // the middle of the main drawing (dimension lines and notes around it do not count)
  const midY = (mainBox[1] + mainBox[3]) / 2, mh = Math.max(mainBox[3] - mainBox[1], 1e-9);
  let centreline = null;
  for (const l of lines) {
    if (l.len < 0.45 * w) continue;
    const dashed = isDashed(l);
    if (!dashed) continue;
    const y = yOf(l);
    if (!centreline || Math.abs(y - midY) < Math.abs(centreline.y - midY)) centreline = { y, dashed: true, len: l.len };
  }
  // symmetry about a horizontal axis (centre line or box middle) and about a vertical axis (box middle)
  const pts = [];
  const stride = Math.max(1, Math.floor(c.segs.length / 4000));
  for (let k = 0; k < c.segs.length; k += stride) { const s = c.segs[k]; pts.push([s[0], s[1]], [s[2], s[3]]); }
  const q = 0.006 * Math.max(w, h);
  const keyset = new Set(pts.map(([x, y]) => `${Math.round(x / q)},${Math.round(y / q)}`));
  const has = (x, y) => { const i = Math.round(x / q), j = Math.round(y / q); for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) if (keyset.has(`${i + a},${j + b}`)) return true; return false; };
  const symAbout = (fn) => pts.length ? pts.filter(([x, y]) => has(...fn(x, y))).length / pts.length : 0;
  let symH = 0, axisY = null;
  for (const cy of [centreline?.y, (y0 + y1) / 2].filter((v) => v != null)) {
    const s = symAbout((x, y) => [x, 2 * cy - y]);
    if (s > symH) { symH = s; axisY = cy; }
  }
  if (!centreline && symH >= 0.6) centreline = { y: axisY, dashed: false };
  const symV = symAbout((x, y) => [x0 + x1 - x, y]);
  // half plan: a long centre line along the top or bottom edge, the drawing on one side of it
  let halfPlan = false;
  const centralCL = centreline && centreline.dashed && Math.abs(centreline.y - midY) < 0.3 * mh;
  for (const l of lines) {
    if (centralCL || l.len < 0.6 * w) continue;
    const y = yOf(l);
    if ((Math.abs(y - mainBox[1]) < 0.08 * mh || Math.abs(mainBox[3] - y) < 0.08 * mh) && isDashed(l)) { halfPlan = true; centreline = { y, dashed: true, len: l.len }; }
  }
  // baseline: the long horizontal line carrying frame ticks, else the lowest long line
  let baseline = null;
  const ticks = c.segs.filter((s) => Math.abs(s[2] - s[0]) <= 0.002 * Math.abs(s[3] - s[1]) && Math.abs(s[3] - s[1]) < 0.04 * h && Math.abs(s[3] - s[1]) > 0);
  // the lowest one with frame ticks (a deck drawn as a band of short strokes also crosses many verticals)
  for (const l of long.slice().sort((p, q) => yOf(p) - yOf(q))) {
    const y = yOf(l);
    const n = ticks.filter((s) => Math.min(s[1], s[3]) <= y + 0.01 * h && Math.max(s[1], s[3]) >= y - 0.01 * h && s[0] >= l.t0 - 1 && s[0] <= l.t1 + 1).length;
    if (n >= 8) { baseline = { y, ticks: n }; break; }
  }
  if (!baseline && long.length) { const l = long.slice().sort((a, b) => yOf(a) - yOf(b))[0]; baseline = { y: yOf(l), ticks: 0 }; }
  const arcs = 0;
  // door swings: open arcs of about a quarter turn, small against the drawing (a door against a deck or a floor)
  const size = Math.hypot(w, h);
  let doorArcs = 0;
  for (const k of new Set(c.segs.map((s) => s[4]))) {
    const a = sheet.paths[k]?.arc;
    if (!a || !(a.r > 0.002 * size && a.r < 0.08 * size)) continue;
    const sweep = (((a.a1 - a.a0) % 360) + 360) % 360;
    if (sweep >= 60 && sweep <= 100) doorArcs++;
  }
  const axisShare = c.segs.filter((s) => Math.abs(s[2] - s[0]) < 1e-6 * diag || Math.abs(s[3] - s[1]) < 1e-6 * diag).length / Math.max(1, c.segs.length);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const corner = (cx - bbox[0] < 0.3 * (bbox[2] - bbox[0]) || bbox[2] - cx < 0.3 * (bbox[2] - bbox[0])) && (cy - bbox[1] < 0.3 * (bbox[3] - bbox[1]) || bbox[3] - cy < 0.3 * (bbox[3] - bbox[1]));
  return { longH: long.length, symH, symV, centreline, halfPlan, baseline, mainX, arcs, doorArcs, axisShare, corner };
}

// Views of one GA: a cluster under or over a profile, inside its x range, elongated and symmetric, is a plan even
// without a title; a "profile" that is not elongated next to a real one is something else.
function linkShipViews(views) {
  const profiles = views.filter((v) => v.kind === 'profile');
  for (const v of views) {
    if (v.kind !== 'other' && v.kind !== 'section') continue;
    if (v._scores?.section >= 0.6) continue;
    const g = v._g;
    if (!g) continue;
    const host = profiles.find((p) => v.box[0] >= p.box[0] - 0.05 * (p.box[2] - p.box[0]) && v.box[2] <= p.box[2] + 0.05 * (p.box[2] - p.box[0]));
    if (host && g.symH >= 0.45 && (v.box[2] - v.box[0]) >= 1.2 * (v.box[3] - v.box[1])) {
      v.kind = 'plan'; v.confidence = 0.55;
      v.why.push(`below/above the profile within its length and symmetric about a horizontal axis: a deck plan (no deck name found)`);
    }
  }
}

// A floor plan without ship cues (no centre line, not symmetric: a building floor, an accommodation block drawn on its
// own): a large drawing that nothing else claimed, with door swings and several labels in it. A profile, section or
// title block guessed from the shape alone (no title says so) gives way to a row of door swings: those views have none.
const FLOOR = { minSize: 0.15, minDoors: 3, minDoorsOverShape: 5, minLabels: 3 };
function floorPlans(views, diag) {
  for (const v of views) {
    if (!v._g) continue;
    const shapeOnly = ['profile', 'section', 'title'].includes(v.kind) && !v._ev?.[v.kind]?.some((e) => e.startsWith('title "'));
    if (v.kind !== 'other' && !(shapeOnly && v._g.doorArcs >= FLOOR.minDoorsOverShape)) continue;
    const size = Math.hypot(v.box[2] - v.box[0], v.box[3] - v.box[1]);
    const labels = v._texts.filter((t) => /\p{L}{2,}/u.test(String(t.text)) && !isTitleBlockWord(t.text)).length;
    if (size < FLOOR.minSize * diag || v._g.doorArcs < FLOOR.minDoors || labels < FLOOR.minLabels) continue;
    const was = v.kind;
    v.kind = 'plan'; v.confidence = 0.5;
    v.why = [`${v._g.doorArcs} door swings and ${labels} labels in a large drawing without a centre line: a floor plan${was !== 'other' ? ` (its shape alone suggested a ${was})` : ''}`];
    if (!v.deck && v.title && deckOf(v.title)) { v.deckName = v.title; v.deck = deckOf(v.title); }
  }
}

// The decks of one drawing are drawn at one scale, so they are of a size. A "plan" without a deck title that is a
// small fraction of the largest plan is a symbol (a legend entry, a north arrow, a door or fitting symbol drawn
// symmetric), not another deck; so is one far flatter than the largest plan (a scale bar: a half plan still has half
// the breadth).
function dropSymbolPlans(views) {
  const plans = views.filter((v) => v.kind === 'plan');
  if (plans.length < 2) return;
  const sizeOf = (v) => Math.hypot(v.box[2] - v.box[0], v.box[3] - v.box[1]);
  const minorOf = (v) => Math.min(v.box[2] - v.box[0], v.box[3] - v.box[1]);
  const big = plans.reduce((a, b) => (sizeOf(b) > sizeOf(a) ? b : a));
  for (const v of plans) {
    if (v === big || v.deck) continue;
    const small = sizeOf(v) < 0.2 * sizeOf(big), flat = minorOf(v) < 0.1 * minorOf(big);
    if (!small && !flat) continue;
    v.kind = 'other'; v.confidence = 0.3;
    v.why.push(small ? 'less than a fifth of the size of the largest plan and no deck name: a symbol, not a deck'
      : 'less than a tenth of the breadth of the largest plan and no deck name: a bar or a symbol, not a deck');
  }
}

// Bow direction: text (FP/AP, FWD/AFT), frame numbers growing toward the bow, plan outlines pointed at the bow and
// square at the transom. A GA draws all its ship views the same way, so the evidence is pooled.
function decideBow(views, sheet) {
  const ship = views.filter((v) => v.kind === 'profile' || v.kind === 'plan');
  let vote = 0;
  const why = [];
  for (const v of ship) {
    const [x0, , x1] = v.box, cx = (x0 + x1) / 2;
    for (const t of v._texts) {
      const e = endWord(t.text);
      if (!e) continue;
      const p = textCentre(t);
      const s = (p[0] > cx ? 1 : -1) * (e === 'fwd' ? 1 : -1);
      vote += 0.6 * s; why.push(`"${t.text.trim()}" at the ${p[0] > cx ? 'right' : 'left'} end of view ${v.title ?? ''}`.trim());
    }
    const rows = frameRows(v._texts);
    if (rows.length) {
      const r = rows[0];
      vote += Math.sign(r.unitsPerFrame) * 0.8;
      why.push(`frame numbers ${r.n[0]}…${r.n[1]} grow to the ${r.unitsPerFrame > 0 ? 'right' : 'left'}${v.title ? ` (${v.title})` : ''}`);
      v._frames = r;
    }
    if (v.kind === 'plan') {
      const s = pointedEnd(v);
      if (s) { vote += s.vote; why.push(s.why); }
    }
  }
  const bow = vote > 0.2 ? 'right' : vote < -0.2 ? 'left' : null;
  for (const v of ship) {
    v.bow = bow;
    v._bowWhy = bow ? `bow ${bow}: ${why.slice(0, 4).join('; ')}${why.length > 4 ? ` (+${why.length - 4} more)` : ''}` : 'bow direction not found on the sheet (no FP/AP text, frame numbers or pointed plan outline)';
    v.why.push(v._bowWhy);
    const [a, b] = v.xRangeAbs || [v.box[0], v.box[2]];
    v.xRange = bow === 'left' ? [b, a] : [a, b];
  }
  void sheet;
}

// A plan outline narrowing to a point at one end (the bow) and wide at the other (the transom).
function pointedEnd(v) {
  const g = v._g, segs = v._c.segs;
  if (!g || !g.mainX) return null;
  const [a, b] = g.mainX, w = b - a, band = 0.05 * w;
  const extent = (lo, hi) => {
    let y0 = Infinity, y1 = -Infinity;
    for (const s of segs) for (const [x, y] of [[s[0], s[1]], [s[2], s[3]]]) if (x >= lo && x <= hi) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return y1 > y0 ? y1 - y0 : 0;
  };
  const left = extent(a, a + band), right = extent(b - band, b);
  const big = Math.max(left, right);
  if (!big) return null;
  const ratio = Math.min(left, right) / big;
  if (ratio > 0.7) return null;
  const s = right < left ? 1 : -1;
  return { vote: 0.5 * (1 - ratio), why: `plan ${v.title ?? ''} narrows to the ${s > 0 ? 'right' : 'left'} (${Math.round(ratio * 100)} % of its breadth at that end)`.replace('  ', ' ') };
}

function finishView(v, i, why0, sheet) {
  const out = {
    id: `v${i + 1}`, kind: v.kind, confidence: Math.round(v.confidence * 100) / 100, box: v.box, title: v.title, titleText: v.titleText,
    deckName: v.deckName, halfPlan: !!v.halfPlan, centreline: v.kind === 'plan' ? v.centreline : null,
    baseline: v.kind === 'profile' || v.kind === 'section' ? v.baseline : null, bow: v.kind === 'profile' || v.kind === 'plan' ? v.bow : null,
    xRange: v.kind === 'profile' || v.kind === 'plan' ? v.xRange : null, paths: v.paths.map((k) => sheet.paths[k].id), texts: v.texts,
    why: [...v.why, ...(i === 0 ? why0 : [])],
  };
  if (v.profileKind) out.profileKind = v.profileKind;
  if (v._frames) out.frames = { unitsPerFrame: v._frames.unitsPerFrame, x0: v._frames.x0, n: v._frames.n, texts: v._frames.ids };
  return out;
}

