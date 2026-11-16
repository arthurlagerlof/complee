// Interpretation: views of a GA sheet → a checkable ship/1 model, reconstruction data for the 3D mesh, and a report
// that separates what was measured from the drawing, read from its text, typed by the user, or assumed.
// Pure ES module (browser, Web Worker, Node); relative imports only. CONTRACT.md §3.
//
//   interpret(sheet, views, overrides = {}, { onProgress } = {}) -> { model, recon, report }
//
// Coordinates: model x forward (0 at frame 0 = the aft perpendicular when frame numbers are drawn, else at the aft
// end of the profile), y to port from the centre line, z above the baseline; millimetres.

import { UNIT_TO_MM } from '../checker.mjs';
import { deckOf, scaleOf, frameSpacingOf, principalOf, elevationOf, normText, shipTypeOf, numericText, roomOf } from './vocab.mjs';
import { frameRows, textCentre } from './views.mjs';
import { readPlan } from './plan-read.mjs';
import {
  segLen, area as ringArea, ringBox, crossingsAtX, crossingsAtY, pointInRing, pointSegment, mergeCollinear, planarGraph, simplifyRing, SegGrid, centroid, clipConvex,
} from './plan-graph.mjs';

const PAPER_MM = { pt: 25.4 / 72, px: 25.4 / 96, mm: 1, cm: 10, in: 25.4 };
const ABBR = { space: 'S', corridor: 'C', door: 'D', opening: 'O', stair: 'ST', ladder: 'L', machinery_space: 'MS', tank: 'T', fuel_tank: 'FT', muster_station: 'MUSTER', liferaft: 'LR', wall: 'W', window: 'WIN', equipment: 'EQ', hull: 'HULL' };
const ASSUMED = { deckHeight: 2800, doorHeight: 2000, plate: 10, equipment: 2000, liferaft: 1000, crane: 4000, rail: 1000 };
const AGREE = 0.05; // sources within 5 % confirm each other
const round = (v, d = 0) => Math.round(v * 10 ** d) / 10 ** d;
const fmt = (mm) => (Math.abs(mm) >= 1000 ? `${round(mm / 1000, 2)} m` : `${round(mm)} mm`);

/** interpret(sheet, views, overrides, { onProgress }) -> { model, recon, report } */
export function interpret(sheet, views, overrides = {}, { onProgress } = {}) {
  const progress = (stage, f) => { try { onProgress?.(stage, f); } catch { /* the UI's problem */ } };
  const ctx = makeContext(sheet, overrides);
  const vs = applyViewOverrides(views || [], overrides, ctx);
  // ---- scale ----
  progress('scale', 0);
  const scale = determineScale(sheet, vs, overrides, ctx);
  ctx.k = scale.mmPerUnit; ctx.scale = scale;
  // points closer than this are one point: three quarters of a point on paper (a PDF stores about 0.1 pt), 15 mm at 1:1
  ctx.snap = sheet.paper ? Math.max(15, 0.75 * (PAPER_MM.pt / (PAPER_MM[sheet.unit] || PAPER_MM.pt)) * scale.mmPerUnit) : 15;
  ctx.tol = sheet.paper ? 0.13 * (scale.mmPerUnit / (PAPER_MM[sheet.unit] || 1)) : 2 * (UNIT_TO_MM[sheet.unit] || 1);
  progress('scale', 1);
  // ---- orientation and registration ----
  const reg = register(vs, sheet, overrides, ctx);
  // ---- profile ----
  progress('decks', 0);
  const profile = reg.profile ? readProfile(reg.profile, sheet, ctx) : null;
  // ---- plans ----
  progress('rooms', 0);
  const plans = [];
  const planViews = reg.views.filter((r) => r.view.kind === 'plan');
  planViews.forEach((r, i) => {
    plans.push(readPlanView(r, sheet, ctx));
    progress('rooms', (i + 1) / planViews.length);
  });
  // ---- decks: names, ids, elevations, heights ----
  const decks = resolveDecks(plans, profile, overrides, ctx);
  progress('decks', 1);
  // ---- elements ----
  progress('doors', 0);
  const built = buildElements(plans, decks, profile, ctx);
  progress('doors', 1);
  // ---- hull ----
  progress('hull', 0);
  const hull = buildHull(decks, profile, plans, vs, ctx);
  progress('hull', 1);
  // ---- particulars, model, report ----
  const ship = particulars(sheet, decks, profile, hull, ctx);
  plausibility(scale, built, ship, ctx);
  return assemble({ sheet, vs, reg, scale, decks, built, hull, ship, profile, plans, ctx });
}

// ---------- context and overrides ----------

function makeContext(sheet, overrides) {
  return {
    sheet, overrides,
    paths: new Map(sheet.paths.map((p, i) => [p.id, { p, i }])),
    texts: new Map(sheet.texts.map((t) => [t.id, t])),
    measured: [], assumed: [], warnings: [], unresolved: [], check: [], typed: [],
    k: 1, tol: 1,
  };
}

function applyViewOverrides(views, overrides, ctx) {
  const ov = overrides.views || {};
  const out = [];
  for (const v of views) {
    const o = ov[v.id];
    if (o?.ignore) { ctx.typed.push(`view ${v.id} ignored (user)`); continue; }
    const w = { ...v };
    if (o?.kind) { w.kind = o.kind; ctx.typed.push(`view ${v.id} is a ${o.kind} (user)`); }
    if (o?.deckName) { w.deckName = o.deckName; w.title = w.title ?? o.deckName; w._typedDeck = true; ctx.typed.push(`view ${v.id} shows deck "${o.deckName}" (user)`); }
    if (o?.elevation != null) w._typedElevation = o.elevation;
    if (o?.height != null) w._typedHeight = o.height;
    out.push(w);
  }
  return out;
}

// ---------- scale ----------

/**
 * Model mm per sheet unit from every source on the sheet, cross-checked. Priority: user > drawn 1:1 in a stated unit
 * > "SCALE 1:n" > frame numbers × frame spacing > dimension annotations > assumed.
 */
function determineScale(sheet, views, overrides, ctx) {
  const paperMM = PAPER_MM[sheet.unit] ?? null;
  const paper = !!sheet.paper || !UNIT_TO_MM[sheet.unit];
  const sources = [];
  const nOf = (mpu) => (paper && paperMM ? mpu / paperMM : 1);
  if (overrides.mmPerUnit > 0) sources.push({ kind: 'typed', mmPerUnit: overrides.mmPerUnit, basis: 'typed', source: `typed by the user: ${overrides.mmPerUnit} mm per sheet unit`, prio: 0 });
  else if (overrides.scale > 0) sources.push({ kind: 'typed', mmPerUnit: paper ? overrides.scale * (paperMM || 1) : UNIT_TO_MM[sheet.unit] || 1, basis: 'typed', source: `typed by the user: scale 1:${overrides.scale}`, prio: 0 });
  if (!paper) sources.push({ kind: 'unit', mmPerUnit: UNIT_TO_MM[sheet.unit], basis: sheet.unitStated ? 'read' : 'assumed', prio: sheet.unitStated ? 1 : 6,
    source: sheet.unitStated ? `the drawing is drawn 1:1 and states its unit (${sheet.unit})` : `the drawing states no unit: read as ${sheet.unit}` });
  // scale texts
  const scaleTexts = sheet.texts.map((t) => ({ t, s: scaleOf(t.text) })).filter((x) => x.s);
  if (scaleTexts.length) {
    const titleIds = new Set(views.filter((v) => v.kind === 'title').flatMap((v) => v.texts));
    const pick = scaleTexts.slice().sort((a, b) => (titleIds.has(b.t.id) ? 2 : 0) + (b.s.labelled ? 1 : 0) - (titleIds.has(a.t.id) ? 2 : 0) - (a.s.labelled ? 1 : 0))[0];
    const others = [...new Set(scaleTexts.map((x) => x.s.n))].filter((n) => n !== pick.s.n);
    if (paper && paperMM) {
      sources.push({ kind: 'text', mmPerUnit: pick.s.n * paperMM, n: pick.s.n, basis: 'read', prio: 2, evidence: [pick.t.id], source: `text on the drawing "${pick.t.text.trim()}" (${pick.t.id})` });
      if (others.length) ctx.warnings.push(`The drawing states more than one scale (${[pick.s.n, ...others].map((n) => `1:${n}`).join(', ')}); 1:${pick.s.n} from "${pick.t.text.trim()}" is used for the whole sheet. Views drawn at another scale need the scale typed for them.`);
    } else ctx.measured.push(`"${pick.t.text.trim()}" (${pick.t.id}) is the plot scale; the coordinates of this drawing are 1:1 in ${sheet.unit}`);
  }
  // frame numbers × frame spacing
  const spacingText = sheet.texts.map((t) => ({ t, mm: frameSpacingOf(t.text) })).find((x) => x.mm);
  ctx.frameSpacing = spacingText ? { mm: spacingText.mm, text: spacingText.t } : null;
  if (spacingText) {
    const rows = views.filter((v) => v.frames && (v.kind === 'profile' || v.kind === 'plan')).map((v) => ({ v, upf: Math.abs(v.frames.unitsPerFrame) }));
    if (rows.length) {
      const med = rows.map((r) => r.upf).sort((a, b) => a - b)[Math.floor(rows.length / 2)];
      const v = rows.find((r) => r.upf === med).v;
      sources.push({ kind: 'frames', mmPerUnit: spacingText.mm / med, basis: 'measured', prio: 3, evidence: [spacingText.t.id, ...v.frames.texts],
        source: `measured from the drawing: frame numbers ${v.frames.n[0]}…${v.frames.n[1]} in view ${v.title ?? v.id} are ${round(med, 3)} units apart per frame, frame spacing ${spacingText.mm} mm from the text "${spacingText.t.text.trim()}" (${spacingText.t.id})` });
    }
  }
  // dimension annotations: a number centred on a line whose length it states
  const dims = dimensionScale(sheet);
  if (dims) sources.push({ kind: 'dimensions', mmPerUnit: dims.mmPerUnit, basis: 'measured', prio: 4, evidence: dims.evidence, source: `measured from the drawing: ${dims.count} dimension line${dims.count === 1 ? '' : 's'} (${dims.examples})` });
  // printed length overall against the profile length: only when nothing better exists (the profile view can include
  // masts and marks beyond the hull); with a scale from elsewhere the particulars are cross-checked on the hull itself
  const loaText = readPrincipals(sheet).length_overall;
  const prof = views.find((v) => v.kind === 'profile' && v.xRange);
  if (loaText && prof && !sources.length) {
    const len = Math.abs(prof.xRange[1] - prof.xRange[0]);
    if (len > 0) sources.push({ kind: 'principal', mmPerUnit: loaText.mm / len, basis: 'measured', prio: 5, evidence: [loaText.id], source: `printed length overall ${fmt(loaText.mm)} (${loaText.id}) over the length of view ${prof.title ?? prof.id}` });
  }
  sources.sort((a, b) => a.prio - b.prio);
  let chosen = sources[0];
  if (!chosen) {
    const n = 100;
    chosen = { kind: 'assumed', mmPerUnit: n * (paperMM || 1), basis: 'assumed', prio: 9, source: 'assumed 1:100: the drawing states no scale and nothing on it could be measured against a known length' };
    sources.push(chosen);
    ctx.assumed.push(`scale 1:100 (no scale on the drawing)`);
  }
  const rel = (s) => Math.abs(s.mmPerUnit / chosen.mmPerUnit - 1);
  const list = sources.map((s) => ({ value: round(nOf(s.mmPerUnit), 2), mmPerUnit: s.mmPerUnit, source: s.source, basis: s.basis, kind: s.kind, agrees: s === chosen ? true : rel(s) <= AGREE, evidence: s.evidence || [] }));
  const confirmed = list.filter((s, i) => sources[i] !== chosen && s.agrees && sources[i].kind !== 'principal');
  for (const [i, s] of sources.entries()) {
    if (s === chosen || list[i].agrees) continue;
    // the profile-length source is a coarse check: its disagreement is information, not an error
    const msg = `Scale sources disagree by ${round(rel(s) * 100, 1)} %: ${chosen.source} gives ${round(chosen.mmPerUnit, 4)} mm per unit, ${s.source} gives ${round(s.mmPerUnit, 4)}. The first is used${s.kind === 'principal' ? ' (the profile can include masts or marks beyond the hull)' : ''}.`;
    if (s.kind === 'principal') ctx.check.push(msg); else ctx.warnings.push(msg);
  }
  const status = chosen.kind === 'assumed' ? 'check' : confirmed.length ? 'confirmed' : chosen.kind === 'typed' || chosen.kind === 'unit' ? 'stated' : 'single';
  const uncertainty = { confirmed: 0.005, stated: 0.002, single: 0.015, check: 0.1 }[status];
  if (status === 'single') ctx.check.push(`The scale rests on one source only (${chosen.source}); no second source on the sheet confirms it.`);
  (chosen.basis === 'assumed' ? ctx.assumed : ctx.measured).push(`scale: ${round(chosen.mmPerUnit, 4)} mm per sheet unit${paper ? ` (1:${round(nOf(chosen.mmPerUnit), 1)})` : ''} — ${chosen.source}${confirmed.length ? `; confirmed by ${confirmed.map((c) => c.kind).join(', ')}` : ''}`);
  return { value: paper ? round(nOf(chosen.mmPerUnit), 2) : 1, mmPerUnit: chosen.mmPerUnit, source: chosen.source, basis: chosen.basis, status, uncertainty, sources: list };
}

// Numbers ≥ 500 centred on a straight line: mm per unit = number / line length; the largest group agreeing within 2 %.
function dimensionScale(sheet) {
  const nums = sheet.texts.map((t) => ({ t, v: numericText(t.text) })).filter((x) => x.v != null && x.v >= 500 && x.v <= 500000);
  if (!nums.length) return null;
  const segs = [];
  for (const p of sheet.paths) {
    if (p.arc || p.pts.length > 3) continue;
    for (let i = 1; i < p.pts.length; i++) segs.push([p.pts[i - 1][0], p.pts[i - 1][1], p.pts[i][0], p.pts[i][1], p.id]);
  }
  if (!segs.length) return null;
  const grid = new SegGrid(segs, Math.max(10, (sheet.bbox[2] - sheet.bbox[0]) / 100));
  const cands = [];
  for (const { t, v } of nums) {
    const c = textCentre(t), h = t.height || (t.box[3] - t.box[1]), r = 4 * h;
    let best = null;
    for (const i of grid.query([c[0] - r, c[1] - r, c[0] + r, c[1] + r])) {
      const s = segs[i], L = segLen(s);
      if (L < 3 * h) continue;
      const p = pointSegment(c, s);
      if (p.t < 0.3 || p.t > 0.7 || p.d > 2.5 * h) continue;
      // the text runs along the line
      const ang = Math.atan2(s[3] - s[1], s[2] - s[0]) * 180 / Math.PI, ta = t.angle || 0;
      const da = Math.abs(((ang - ta) % 180 + 180) % 180);
      if (Math.min(da, 180 - da) > 10) continue;
      if (!best || p.d < best.d) best = { s, d: p.d, L };
    }
    if (best) cands.push({ mpu: v / best.L, t, s: best.s, v });
  }
  if (!cands.length) return null;
  let bestGroup = [];
  for (const c of cands) {
    const g = cands.filter((d) => Math.abs(d.mpu / c.mpu - 1) <= 0.02);
    if (g.length > bestGroup.length) bestGroup = g;
  }
  if (bestGroup.length < 2) return null;
  const mpu = bestGroup.map((g) => g.mpu).sort((a, b) => a - b)[Math.floor(bestGroup.length / 2)];
  return { mmPerUnit: mpu, count: bestGroup.length, examples: bestGroup.slice(0, 3).map((g) => `"${g.v}" on ${g.s[4]} (${g.t.id})`).join(', '), evidence: bestGroup.flatMap((g) => [g.t.id, g.s[4]]) };
}

/** Principal dimensions printed on the sheet: { length_overall: { mm, id, text }, beam, depth, draft, length_bp }. */
export function readPrincipals(sheet) {
  const out = {};
  const texts = sheet.texts;
  for (const t of texts) {
    const p = principalOf(t.text);
    if (!p || out[p.key]) continue;
    if (p.mm != null) { out[p.key] = { mm: p.mm, id: t.id, text: t.text.trim(), guessedUnit: p.guessedUnit }; continue; }
    // the value is the number to the right on the same row ("Length o.a" … "28,00 m")
    const c = textCentre(t), h = t.height || 1;
    const row = texts.filter((u) => u !== t && Math.abs((u.box[1] + u.box[3]) / 2 - c[1]) < 0.6 * h && u.box[0] > t.box[0] && /\d/.test(u.text) && !principalOf(u.text))
      .sort((a, b) => a.box[0] - b.box[0]);
    const v = row.find((u) => /^\s*\d+(?:[.,]\d+)?\s*(mm|m)?\s*$/i.test(u.text));
    if (!v) continue;
    const m = /(\d+(?:[.,]\d+)?)\s*(mm|m)?/i.exec(v.text);
    const num = Number(m[1].replace(',', '.'));
    const mm = m[2]?.toLowerCase() === 'mm' ? num : m[2] ? num * 1000 : num < 500 ? num * 1000 : num;
    out[p.key] = { mm, id: `${t.id}+${v.id}`, text: `${t.text.trim()} ${v.text.trim()}`, guessedUnit: !m[2] };
  }
  return out;
}

// ---------- registration ----------

/**
 * Sheet → model maps for every ship view. x: frame 0 (when frame numbers and the frame spacing are on the sheet), else
 * the aft end of the profile; plans under the profile within its length use its x; otherwise their own frame numbers,
 * else their aft end aligned (assumed). y: from the centre line, port positive. z: above the baseline.
 */
function register(views, sheet, overrides, ctx) {
  const k = ctx.k;
  const shipViews = views.filter((v) => v.kind === 'profile' || v.kind === 'plan');
  const votes = shipViews.map((v) => v.bow).filter(Boolean);
  let bow = overrides.bow;
  if (bow) ctx.typed.push(`bow points ${bow} (user)`);
  else if (votes.length) { bow = votes.filter((b) => b === 'right').length >= votes.length / 2 ? 'right' : 'left'; ctx.measured.push(`bow points ${bow} on the sheet (${shipViews.find((v) => v.bow)?.why?.find((w) => w.startsWith('bow')) ?? 'views'})`); }
  else { bow = 'right'; ctx.assumed.push('bow to the right (the sheet does not show which end is forward)'); ctx.check.push('Bow direction assumed (right): check it.'); }
  const sx = bow === 'left' ? -1 : 1;
  const profiles = views.filter((v) => v.kind === 'profile');
  const deckLabels = (v) => v.texts.map((id) => ctx.texts.get(id)).filter((t) => t && deckOf(t.text)).length;
  const profile = profiles.slice().sort((a, b) => (b.profileKind === 'inboard') - (a.profileKind === 'inboard') || deckLabels(b) - deckLabels(a) || (b.box[2] - b.box[0]) - (a.box[2] - a.box[0]))[0] || null;
  const spacing = ctx.frameSpacing?.mm ?? null;
  const span = (v) => [Math.min(...(v.xRange || [v.box[0], v.box[2]])), Math.max(...(v.xRange || [v.box[0], v.box[2]]))];
  const ref = profile || shipViews.filter((v) => v.kind === 'plan').sort((a, b) => (span(b)[1] - span(b)[0]) - (span(a)[1] - span(a)[0]))[0] || null;
  const out = [];
  // frame 0 position from frame numbers, when the spacing is known (then x = 0 is the aft perpendicular)
  const frameU0 = (v) => (v.frames && spacing ? v.frames.x0 : null);
  const refAft = ref ? (bow === 'left' ? span(ref)[1] : span(ref)[0]) : 0;
  const refU0 = ref ? frameU0(ref) ?? refAft : 0;
  const origin = ref && frameU0(ref) != null ? 'frame 0 (taken as the aft perpendicular)' : ref ? `the aft end of view ${ref.title ?? ref.id}` : 'the sheet origin';
  ctx.origin = origin;
  ctx.measured.push(`x = 0 at ${origin}; x positive forward, y positive to port, z above the baseline`);
  const anyFrames = shipViews.some((v) => frameU0(v) != null);
  for (const v of shipViews) {
    let u0, how, basis;
    const [a, b] = span(v);
    const inRef = ref && v !== ref && a >= span(ref)[0] - 0.03 * (span(ref)[1] - span(ref)[0]) && b <= span(ref)[1] + 0.03 * (span(ref)[1] - span(ref)[0]);
    if (frameU0(v) != null && (anyFrames && (v === ref || frameU0(ref) != null || !inRef))) { u0 = frameU0(v); how = `its frame numbers ${v.frames.n[0]}…${v.frames.n[1]}`; basis = 'measured'; }
    else if (v === ref) { u0 = refU0; how = frameU0(ref) != null ? 'its frame numbers' : 'its aft end'; basis = 'measured'; }
    else if (inRef) { u0 = refU0; how = `the same x as view ${ref.title ?? ref.id} (drawn within its length on the sheet)`; basis = 'measured'; }
    else {
      const aft = bow === 'left' ? b : a;
      u0 = aft; how = `its aft end aligned with x = 0 (no frame numbers, not under the profile)`; basis = 'assumed';
      ctx.assumed.push(`view ${v.title ?? v.id}: x registered by aligning its aft end with x = 0`);
      ctx.check.push(`View ${v.title ?? v.id}: its position along the ship is assumed (aft ends aligned). Check it or give frame numbers.`);
    }
    let v0, vHow, vBasis = 'measured';
    if (v.kind === 'plan') {
      if (v.centreline) { v0 = v.centreline.y; vHow = `centre line at sheet y ${round(v0, 2)}`; }
      else { v0 = (v.box[1] + v.box[3]) / 2; vHow = 'middle of the view (no centre line found)'; vBasis = 'assumed'; ctx.assumed.push(`view ${v.title ?? v.id}: centre line taken at the middle of the view`); }
    } else {
      if (v.baseline) { v0 = v.baseline.y; vHow = `baseline at sheet y ${round(v0, 2)}`; }
      else { v0 = v.box[1]; vHow = 'bottom of the view (no baseline found)'; vBasis = 'assumed'; ctx.assumed.push(`view ${v.title ?? v.id}: baseline taken at the bottom of the view`); }
    }
    // plans: port is drawn above the centre line when the bow points right (a view from above)
    const sy = v.kind === 'plan' ? sx : 1;
    const toModel = (p) => [sx * (p[0] - u0) * k, sy * (p[1] - v0) * k];
    out.push({ view: v, u0, v0, sx, sy, toModel, toSheet: [sx / k, 0, 0, sy / k, u0, v0], how, basis, vHow, vBasis });
  }
  return { bow, sx, views: out, profile: profile ? out.find((r) => r.view === profile) : null };
}

// Segments, arcs and texts of a view in model coordinates.
function viewGeometry(r, sheet, ctx) {
  const segs = [], arcs = [], dashed = [], closedRefs = new Set(), fillRefs = new Set();
  for (const id of r.view.paths) {
    const hit = ctx.paths.get(id);
    if (!hit) continue;
    const p = hit.p;
    if (p.ocrText) continue; // strokes of writing read by OCR: a label now, not line work
    const pts = p.pts.map(r.toModel);
    if (p.arc) {
      const sweep = (((p.arc.a1 - p.arc.a0) % 360) + 360) % 360 || 360;
      arcs.push({ c: r.toModel(p.arc.c), r: p.arc.r * ctx.k, sweep, p0: pts[0], p1: pts[pts.length - 1], pts, ref: p.id });
      continue;
    }
    const target = p.dash ? dashed : segs;
    if (p.fill) fillRefs.add(p.id);
    if (pts.length > 3 && (p.closed || Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1)) closedRefs.add(p.id);
    for (let i = 1; i < pts.length; i++) target.push([pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], p.id]);
    if (p.closed && pts.length > 2) target.push([pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1], p.id]);
  }
  const texts = r.view.texts.map((id) => ctx.texts.get(id)).filter(Boolean).filter((t) => t.id !== r.view.titleText).map((t) => {
    const c = r.toModel(textCentre(t));
    const a = r.toModel([t.box[0], t.box[1]]), b = r.toModel([t.box[2], t.box[3]]);
    return { id: t.id, text: t.text, c, h: (t.height || (t.box[3] - t.box[1])) * ctx.k, angle: t.angle || 0, box: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] };
  });
  return { segs, arcs, dashed, texts, closedRefs, fillRefs };
}

// ---------- profile ----------

/**
 * The profile: deck lines (long horizontal lines) with their names and elevation texts, the hull silhouette (outer
 * boundary of the largest connected drawing), stem and stern contours, portholes.
 */
function readProfile(r, sheet, ctx) {
  const g = viewGeometry(r, sheet, ctx);
  const name = r.view.title ?? r.view.id;
  const solid = g.segs.filter((s) => segLen(s) >= 30);
  // silhouette: largest component's outer boundary (curves included)
  const curve = [];
  for (const a of g.arcs) if (a.sweep < 350) for (let i = 1; i < a.pts.length; i++) curve.push([a.pts[i - 1][0], a.pts[i - 1][1], a.pts[i][0], a.pts[i][1], a.ref]);
  const graph = planarGraph(solid.concat(curve), { tol: 20 });
  const main = graph.comps.filter((c) => c.outer).sort((a, b) => a.outer.area - b.outer.area)[0];
  const ring = main ? main.outer.ring.slice().reverse() : null;
  // horizontal lines
  const horiz = solid.filter((s) => Math.abs(s[3] - s[1]) <= 0.003 * Math.abs(s[2] - s[0]));
  const lines = mergeCollinear(horiz, { angTol: 0.3, offTol: 25, gapTol: 400 }).map((l) => ({ z: (l.a[1] + l.b[1]) / 2, x0: Math.min(l.a[0], l.b[0]), x1: Math.max(l.a[0], l.b[0]), len: l.len, evidence: [...new Set(l.members.map((k) => horiz[k][4]))] }));
  const box = ring ? ringBox(ring) : [0, 0, 0, 0];
  const L = box[2] - box[0];
  const deckLines = lines.filter((l) => l.len >= Math.max(1500, 0.08 * L) && l.z > 150 && l.z < box[3] + 1);
  // deck names and elevation texts
  const labels = [], elevTexts = [];
  for (const t of g.texts) {
    const d = deckOf(t.text);
    const e = elevationOf(t.text);
    const near = (maxAbove, maxBelow) => deckLines.filter((l) => t.c[0] >= l.x0 - 1500 && t.c[0] <= l.x1 + 1500 && t.c[1] - l.z <= maxAbove && t.c[1] - l.z >= -maxBelow)
      .sort((a, b) => Math.abs(t.c[1] - a.z) - Math.abs(t.c[1] - b.z))[0];
    if (d && !d.below) { const l = near(2500, 0.6 * t.h + 100); if (l) labels.push({ deck: d, line: l, text: t }); }
    if (e != null) { const l = near(1200, 1200); if (l) elevTexts.push({ mm: e, line: l, text: t }); }
  }
  // portholes: circles 100–350 mm radius
  const portholes = g.arcs.filter((a) => a.sweep >= 350 && a.r >= 100 && a.r <= 350).map((a) => ({ c: a.c, r: a.r, ref: a.ref }));
  const xAt = (z) => { if (!ring) return null; const xs = crossingsAtY(ring, z); return xs.length >= 2 ? [xs[0], xs[xs.length - 1]] : null; };
  const zAt = (x) => { if (!ring) return null; const zs = crossingsAtX(ring, x); return zs.length >= 2 ? [zs[0], zs[zs.length - 1]] : null; };
  ctx.measured.push(`profile: view ${name}, ${deckLines.length} long horizontal line${deckLines.length === 1 ? '' : 's'}, ${labels.length} deck name${labels.length === 1 ? '' : 's'}, ${elevTexts.length} elevation text${elevTexts.length === 1 ? '' : 's'}`);
  return { r, name, ring, box, lines, deckLines, labels, elevTexts, portholes, xAt, zAt, evidence: main ? [...new Set(main.outer.edges.map((e) => graph.edges[e][2]))] : [] };
}

// ---------- plans ----------

function readPlanView(r, sheet, ctx) {
  const g = viewGeometry(r, sheet, ctx);
  const stroke = (id) => (ctx.paths.get(id)?.p.width || 0) * ctx.k;
  const res = readPlan({ segs: g.segs, arcs: g.arcs, texts: g.texts, strokeMM: stroke, halfPlan: !!r.view.halfPlan, closedRefs: g.closedRefs, fillRefs: g.fillRefs, snap: ctx.snap });
  const name = r.view.title ?? r.view.id;
  if (!res.outline) ctx.unresolved.push({ view: r.view.id, what: `plan ${name}: ${res.unresolved[0]?.what ?? 'no outline'}`, at: null });
  for (const u of res.unresolved) if (res.outline) ctx.unresolved.push({ view: r.view.id, what: `${name}: ${u.what}`, at: u.at ? { model: u.at.map((v) => round(v)), sheet: modelToSheet(r, u.at) } : null, texts: u.texts });
  return { r, name, res, texts: g.texts };
}
const modelToSheet = (r, p) => [round(r.toSheet[0] * p[0] + r.toSheet[2] * p[1] + r.toSheet[4], 3), round(r.toSheet[1] * p[0] + r.toSheet[3] * p[1] + r.toSheet[5], 3)];

// ---------- decks ----------

/**
 * One deck per plan. Elevation, in order of preference: typed; the profile line carrying the deck's name (an
 * elevation text on that line overrides it when they agree within 2 %); for "below X" plans the line under X; the
 * profile line whose extent matches the plan outline; an elevation in the plan title; stacked by name (assumed).
 */
function resolveDecks(plans, profile, overrides, ctx) {
  const decks = plans.map((p, i) => {
    const v = p.r.view;
    const d = (v.deckName && deckOf(v.deckName)) || (v.title && deckOf(v.title)) || null;
    const name = v.deckName || v.title || `Deck ${i + 1}`;
    if (!d) ctx.check.push(`Plan ${v.id}${v.title ? ` "${v.title}"` : ''}: no deck name recognised; give it one.`);
    return { plan: p, view: v, key: d?.key ?? `view_${v.id}`, id: d?.id ?? `D${i + 1}`, name: String(name).trim(), rank: d?.rank ?? null, below: d?.below ?? null, elevation: null, height: null, ev: null, hv: null };
  });
  // unique ids
  const seen = new Map();
  for (const d of decks) { const n = (seen.get(d.id) || 0) + 1; seen.set(d.id, n); if (n > 1) d.id = `${d.id}${n}`; }
  const L = profile ? profile.box[2] - profile.box[0] : 0;
  const labelOf = (key) => profile?.labels.find((l) => l.deck.key === key);
  // 1. typed and 2. labelled profile lines
  for (const d of decks) {
    if (d.view._typedElevation != null) { d.elevation = d.view._typedElevation; d.ev = { basis: 'typed', source: 'typed by the user' }; continue; }
    const lab = d.below ? null : labelOf(d.key);
    if (!lab) continue;
    const z = lab.line.z;
    d.elevation = z; d.line = lab.line;
    d.ev = { basis: 'measured', source: `measured from the drawing: deck line at ${fmt(z)} above the baseline in the profile, named "${lab.text.text.trim()}" (${lab.text.id}), line ${lab.line.evidence.slice(0, 3).join('/')}`, evidence: [lab.text.id, ...lab.line.evidence.slice(0, 5)] };
    const et = profile.elevTexts.find((e) => e.line === lab.line);
    if (et) {
      if (Math.abs(et.mm - z) <= 0.02 * Math.max(Math.abs(et.mm), 1000)) {
        d.elevation = et.mm;
        d.ev = { basis: 'read', source: `text on the drawing "${et.text.text.trim()}" (${et.text.id}), confirmed by the deck line measured at ${fmt(z)}`, evidence: [et.text.id, lab.text.id, ...lab.line.evidence.slice(0, 3)] };
      } else ctx.warnings.push(`Deck ${d.name}: the elevation text "${et.text.text.trim()}" (${et.text.id}) says ${fmt(et.mm)}, the line is drawn at ${fmt(z)} (more than 2 % apart). The measured value is used.`);
    }
  }
  // 3. extent matching for named decks without a label (rank order kept)
  if (profile) {
    const used = new Set(decks.filter((d) => d.line).map((d) => d.line));
    const pending = decks.filter((d) => d.elevation == null && !d.below && d.plan.res.outline).sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    let floor = -Infinity;
    for (const d of pending) {
      const ob = ringBox(d.plan.res.outline.ring);
      let best = null;
      for (const l of profile.deckLines) {
        if (used.has(l) || l.z <= floor) continue;
        // a plan often shows lower decks aft of it as well (a forecastle plan with the open main deck behind): the
        // outline reaching aft of the line costs little, the line reaching aft of the outline costs fully
        const aft = l.x0 > ob[0] ? 0.25 * (l.x0 - ob[0]) : ob[0] - l.x0;
        const cost = (aft + Math.abs(l.x1 - ob[2])) / Math.max(L, 1);
        if (!best || cost < best.cost) best = { l, cost };
      }
      if (best && best.cost <= 0.12) {
        used.add(best.l); floor = best.l.z;
        d.elevation = best.l.z; d.line = best.l;
        d.ev = { basis: 'measured', source: `measured from the drawing: the profile line at ${fmt(best.l.z)} spans x ${fmt(best.l.x0)}…${fmt(best.l.x1)}, matching the outline of plan "${d.name}" (${fmt(ob[0])}…${fmt(ob[2])}); the line carries no deck name`, evidence: best.l.evidence.slice(0, 5), matched: true };
        ctx.check.push(`Deck ${d.name}: elevation ${fmt(best.l.z)} from the profile line whose length matches the plan (no deck name on the line): check it.`);
      }
    }
  }
  // 4. "below X" plans: from the line under X (or the baseline) up to X
  for (const d of decks.filter((x) => x.below && x.elevation == null)) {
    const above = decks.find((x) => x.key === d.below && x.elevation != null);
    let ceiling = above?.elevation ?? labelOf(d.below)?.line.z ?? null;
    const longLines = profile ? profile.deckLines.filter((l) => l.len >= 0.25 * L) : [];
    if (ceiling == null && profile) {
      // X has no plan and no label: the lowest long line above the baseline when X is the lowest deck vocabulary
      const lowest = longLines.slice().sort((a, b) => a.z - b.z)[0];
      if (lowest && (deckOf(d.below.replace(/_/g, ' '))?.rank ?? 9) <= 1.5) { ceiling = lowest.z; d.ceilingLine = lowest; }
    }
    if (ceiling == null) continue;
    const under = longLines.filter((l) => l.z < ceiling - 300).sort((a, b) => b.z - a.z)[0];
    d.elevation = under ? under.z : 0;
    d.height = ceiling - d.elevation;
    d.ev = { basis: 'measured', source: `measured from the drawing: ${under ? `the profile line at ${fmt(under.z)}` : 'the baseline'} under ${above ? `deck ${above.name}` : `the line at ${fmt(ceiling)}`} (plan of the space below it)`, evidence: under ? under.evidence.slice(0, 3) : [] };
    d.hv = { basis: 'measured', source: `measured from the drawing: from ${fmt(d.elevation)} up to ${fmt(ceiling)}` };
  }
  // 5. elevation text in the plan title
  for (const d of decks.filter((x) => x.elevation == null)) {
    const near = [d.view.title, ...d.plan.texts.filter((t) => elevationOf(t.text) != null && !roomOf(t.text)).map((t) => t.text)].filter(Boolean);
    const e = near.map((t) => ({ t, mm: elevationOf(t) })).find((x) => x.mm != null);
    if (e) { d.elevation = e.mm; d.ev = { basis: 'read', source: `text on the drawing "${e.t}"` }; }
  }
  // 6. assumed: stacked by deck name, 2800 mm per level, from the lowest known elevation (or 0)
  const missing = decks.filter((d) => d.elevation == null);
  if (missing.length) {
    const known = decks.filter((d) => d.elevation != null);
    const ordered = decks.slice().sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (a.elevation ?? 0) - (b.elevation ?? 0));
    let z = known.length ? null : 0;
    for (const d of ordered) {
      if (d.elevation != null) { z = d.elevation + (d.height ?? ASSUMED.deckHeight); continue; }
      if (z == null) z = Math.min(...known.map((x) => x.elevation)) - ASSUMED.deckHeight * (ordered.indexOf(known[0]) - ordered.indexOf(d));
      d.elevation = z; z += ASSUMED.deckHeight;
      d.ev = { basis: 'assumed', source: `assumed: ${profile ? 'not found in the profile' : 'no profile on the sheet'}; stacked by the deck name with ${ASSUMED.deckHeight} mm per deck` };
      ctx.assumed.push(`deck ${d.name}: elevation ${fmt(d.elevation)} (${profile ? 'not in the profile' : 'no profile view'}; stacked by name, ${ASSUMED.deckHeight} mm deck height)`);
    }
  }
  // heights: to the next deck above; the top deck to the roof line over it in the profile
  const byZ = decks.slice().sort((a, b) => a.elevation - b.elevation);
  for (const d of byZ) {
    if (d.view._typedHeight != null) { d.height = d.view._typedHeight; d.hv = { basis: 'typed', source: 'typed by the user' }; continue; }
    if (d.height != null) continue;
    const ob = d.plan.res.outline ? ringBox(d.plan.res.outline.ring) : null;
    const next = byZ.find((x) => x.elevation > d.elevation + 500 && (!ob || !x.plan.res.outline || overlapX(ringBox(x.plan.res.outline.ring), ob) > 0.2 * (ob[2] - ob[0])));
    if (next) {
      d.height = next.elevation - d.elevation;
      d.hv = { basis: next.ev.basis === 'assumed' || d.ev.basis === 'assumed' ? 'assumed' : 'measured', source: `deck ${next.name} at ${fmt(next.elevation)} minus this deck at ${fmt(d.elevation)}` };
      continue;
    }
    // the top deck: the highest roof line above it over at least 30 % of its length
    const roof = profile && ob ? profile.lines.filter((l) => l.z > d.elevation + 1800 && l.z < d.elevation + 5000 && overlapX([l.x0, 0, l.x1, 0], ob) >= 0.3 * (ob[2] - ob[0])).sort((a, b) => b.len - a.len)[0] : null;
    if (roof) { d.height = roof.z - d.elevation; d.hv = { basis: 'measured', source: `measured from the drawing: roof line at ${fmt(roof.z)} in the profile over this deck`, evidence: roof.evidence.slice(0, 3) }; }
    else { d.height = ASSUMED.deckHeight; d.hv = { basis: 'assumed', source: `assumed ${ASSUMED.deckHeight} mm: no deck or roof line above it` }; d.heightAssumedNote = `deck ${d.name}: height ${ASSUMED.deckHeight} mm (nothing above it in the drawing)`; ctx.assumed.push(d.heightAssumedNote); }
  }
  for (const d of decks) if (d.ev.basis !== 'assumed') ctx.measured.push(`deck ${d.name} (${d.id}): elevation ${fmt(d.elevation)} — ${d.ev.source}`);
  return decks.sort((a, b) => a.elevation - b.elevation);
}
const overlapX = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));

// ---------- elements ----------

function measuredValue(v, ctx, source, evidence = [], extraTol = 0) {
  const u = ctx.scale.uncertainty, t = ctx.tol + extraTol;
  return { value: round(v), unit: 'mm', basis: 'measured', range: [round(v * (1 - u) - t), round(v * (1 + u) + t)], source: `measured from the drawing: ${source}`, evidence };
}

function buildElements(plans, decks, profile, ctx) {
  const elements = [];
  const upFlights = []; // { box, z1 } of flights leading up, to recognise the same flight drawn DN on the deck above
  const recon = { rooms: [], doors: [], walls: [], stairs: [], ladders: [], windows: [], equipment: [], openings: [] };
  const lists = { rooms: [], doors: [] };
  const area = { printed: 0, agree: 0, agreeUnmerged: 0, list: [] };
  const deckAbove = (d) => decks.find((x) => x.elevation > d.elevation + 500);
  const deckBelow = (d) => decks.slice().reverse().find((x) => x.elevation < d.elevation - 500);
  for (const d of decks) {
    const res = d.plan.res;
    if (!res.outline) continue;
    const view = d.view, vname = view.title ?? view.id;
    clipToDeckLine(d, ctx);
    const open = openDeckOf(d, decks, profile);
    const RAIL = ASSUMED.rail;
    // a deck with nothing enclosed on it (a wheelhouse top, a roof) is open deck: its height is the rail height
    if (d.hv?.basis === 'assumed' && res.rooms.length && res.rooms.every((r) => r.type !== 'stair' && open.isOpen(r) && (!r.labelled || r.zone === 'open_deck'))) {
      d.height = RAIL;
      d.hv = { basis: 'assumed', source: `open deck (nothing above it encloses it): rail height ${RAIL} mm assumed` };
      const i = ctx.assumed.indexOf(d.heightAssumedNote);
      if (i >= 0) ctx.assumed.splice(i, 1, `deck ${d.name}: open deck, rail height ${RAIL} mm`);
    }
    const z0 = d.elevation, z1 = d.elevation + d.height;
    const pending = [];
    const push = (el, rec) => pending.push({ el, rec });
    // stairs from treads; a stair-labelled room around them gives its name
    const stairRooms = res.rooms.filter((r) => r.type === 'stair');
    const stairsUsed = new Set();
    for (const r of stairRooms) {
      const inside = res.stairs.filter((s) => pointInRing(centroid(s.polygon), r.ring));
      inside.forEach((s) => stairsUsed.add(s));
      push(...stairElement(d, inside[0] || null, r, decks, ctx, vname, deckAbove, deckBelow));
    }
    for (const s of res.stairs) {
      if (stairsUsed.has(s)) continue;
      if (s.upText?.word === 'down') {
        const b = ringBox(s.polygon);
        const same = upFlights.find((u) => Math.abs(u.z1 - d.elevation) < 300 && overlapX(u.box, b) > 0.3 * (b[2] - b[0]) && Math.min(u.box[3], b[3]) - Math.max(u.box[1], b[1]) > 0.3 * (b[3] - b[1]));
        if (same) { ctx.measured.push(`${d.name}: the stair marked DN at x ${fmt((b[0] + b[2]) / 2)} is the flight from the deck below (drawn on both plans)`); continue; }
      }
      push(...stairElement(d, s, null, decks, ctx, vname, deckAbove, deckBelow));
    }
    // rooms
    for (const r of res.rooms) {
      if (r.type === 'stair') continue;
      let type = r.type === 'ladder' ? 'space' : r.type;
      let zone = r.type === 'ladder' ? 'circulation' : r.zone;
      // not under the deck above: open deck (a name from its label, else "Open deck"); a named room keeps its name
      const isOpen = open.isOpen(r);
      if (isOpen && !r.labelled) { r.label = 'Open deck'; r.notes = [open.why]; zone = 'open_deck'; type = 'space'; r.openDeck = true; }
      else if (isOpen && zone === 'open_deck') { r.openDeck = true; r.notes.push(open.why); }
      else if (isOpen) r.notes.push(`${open.why}, but it is named "${r.label}": kept as that room; check whether it is open to the sky`);
      const b = ringBox(r.ring);
      const props = {};
      const ev = [...r.labelIds];
      if (zone) props.zone = r.openDeck && !r.labelled ? { value: zone, basis: 'measured', source: open.why } : { value: zone, basis: 'read', source: `label "${r.label}" (${r.labelIds.join('/')})`, evidence: r.labelIds };
      props.area = { value: round(r.area / 1e6, 2), unit: 'm2', basis: 'measured', range: [round((r.area / 1e6) * (1 - 2 * ctx.scale.uncertainty) - perim(r.ring) * ctx.tol / 1e6, 2), round((r.area / 1e6) * (1 + 2 * ctx.scale.uncertainty) + perim(r.ring) * ctx.tol / 1e6, 2)],
        source: `measured from the drawing: clear floor area inside the walls of this room in view ${vname}${r.holes.length ? `, minus ${r.holes.length} opening${r.holes.length === 1 ? '' : 's'} (stair trunk etc.)` : ''}` };
      if (r.printedArea != null) {
        props.area_printed = { value: r.printedArea, unit: 'm2', basis: 'read', source: `text on the drawing in the room (${r.labelIds.join('/')})`, evidence: r.labelIds };
        const ok = Math.abs(r.area / 1e6 - r.printedArea) <= 0.03 * r.printedArea;
        // a room joined from pieces using the printed area agrees by construction: counted apart
        const merged = (r.faces?.length ?? 1) > 1;
        area.printed++; if (ok) area.agree++; if (ok && !merged) area.agreeUnmerged++;
        area.list.push({ room: r.label, printed: r.printedArea, measured: round(r.area / 1e6, 2), agrees: ok, merged });
      }
      if (type === 'corridor' && r.width) props.clear_width = measuredValue(r.width.min, ctx, `smallest distance between the long walls of the corridor (${40 - 3} cross-sections) in view ${vname}`, ev);
      const confidence = r.openDeck ? 0.8 : r.recognised ? 0.9 : r.labelled ? 0.6 : 0.35;
      const roomH = r.openDeck ? RAIL : d.height;
      const notes = [...r.notes];
      if (r.sharedLabels.length) notes.push(`also labelled ${r.sharedLabels.map((s) => `"${s}"`).join(', ')}: the walls between them do not close`);
      if (r.contains?.length) notes.push(`labels of things in this room: ${r.contains.map((t) => `"${t}"`).join(', ')}`);
      if (r.openDeck) notes.push(`height: rail / bulwark ${RAIL} mm, assumed`);
      // a name read by OCR from line work (no text in the file) is a reading, not a fact: said so, and marked to check
      const ocrLabels = r.labelIds.map((id) => ctx.texts.get(id)).filter((t) => t?.ocr);
      if (r.label && ocrLabels.length) {
        const conf = Math.min(...ocrLabels.map((t) => t.ocr.confidence));
        notes.push(`name read by OCR from line work (the drawing has no text there; confidence ${conf} %): check the spelling.`);
        if (props.zone?.basis === 'read') props.zone.source += ' (read by OCR)';
      }
      const unnamed = !r.label;
      const el = { id: null, type, name: r.label ?? (type === 'corridor' ? 'Corridor' : 'Unnamed space'), deck: d.id, geom: { x: round(b[0]), y: round(b[1]), z: 0, lx: round(b[2] - b[0]), ly: round(b[3] - b[1]), h: round(roomH) },
        props, source: `drawing ${ctx.sheet.source?.file ?? ''} view ${vname}: room recognised from its walls${r.label ? ` and its label "${r.label}"` : ''}`.replace('  ', ' '), basis: 'measured', confidence, evidence: ev,
        ...(unnamed || (r.label && ocrLabels.length) ? { check: true } : {}), ...(r.openDeck ? { open_deck: true } : {}), ...(notes.length ? { note: notes.join(' ') } : {}) };
      push(el, { kind: 'rooms', item: { deck: d.id, polygon: r.ring.map((p) => p.map((v) => round(v))), holes: r.holes.map((h) => h.map((p) => p.map((v) => round(v)))), z0, z1: z0 + roomH, ...(r.openDeck ? { open: true } : {}), basis: 'measured', evidence: ev } });
      if (confidence < 0.6) ctx.check.push(`${d.name}: ${r.label ? `room "${r.label}"` : 'an unnamed closed area'} of ${round(r.area / 1e6, 1)} m² at x ${fmt(centroid(r.ring)[0])}: check what it is.`);
      el._room = r;
    }
    // doors
    for (const dr of res.doors) {
      const w = dr.width;
      const a = dr.hingeCL, wd = dr.wallDir, n = [-wd[1], wd[0]], t = Math.max(dr.thickness || 0, 50);
      const corners = [a, [a[0] + wd[0] * w, a[1] + wd[1] * w]].flatMap((p) => [[p[0] + n[0] * t / 2, p[1] + n[1] * t / 2], [p[0] - n[0] * t / 2, p[1] - n[1] * t / 2]]);
      const b = ringBox(corners);
      const radii = dr.leaves.map((l) => round(l.r));
      const props = {
        clear_width: measuredValue(w, ctx, `swing arc radius${dr.double ? 'es' : ''} ${radii.join(' + ')} mm in view ${vname}, entities ${dr.evidence.slice(0, 4).join('/')} (the clear opening is a little less than the leaf width)`, dr.evidence),
      };
      if (dr.double) props.double_leaf = { value: true, basis: 'measured', source: 'two swing arcs meeting in one opening' };
      const el = { id: null, type: 'door', name: dr.double ? 'Double door' : 'Door', deck: d.id, geom: { x: round(b[0]), y: round(b[1]), z: 0, lx: round(Math.max(b[2] - b[0], 1)), ly: round(Math.max(b[3] - b[1], 1)), h: ASSUMED.doorHeight },
        props, source: `drawing view ${vname}: door swing arc ${dr.evidence[0]}`, basis: 'measured', confidence: dr.closedSure ? 0.9 : 0.7, evidence: dr.evidence,
        note: [`door height ${ASSUMED.doorHeight} mm assumed.`, ...dr.notes].join(' ') };
      el._door = dr;
      push(el, { kind: 'doors', item: { deck: d.id, hinge: dr.hingeCL.map((v) => round(v)), width: round(w), wallDir: wd.map((v) => round(v, 4)), swing: dr.swing, z0, z1: z0 + ASSUMED.doorHeight,
        ...(dr.double ? { double: true, leaves: dr.leaves.map((l) => ({ hinge: l.hinge.map((v) => round(v)), width: round(l.r) })) } : {}), basis: 'measured', evidence: dr.evidence } });
    }
    // openings (gaps without a swing)
    for (const o of res.openings) {
      const b = ringBox(o.closers.flatMap((c) => [[c[0], c[1]], [c[2], c[3]]]));
      const el = { id: null, type: 'opening', name: 'Opening (no door drawn)', deck: d.id, geom: { x: round(b[0]), y: round(b[1]), z: 0, lx: round(Math.max(b[2] - b[0], 1)), ly: round(Math.max(b[3] - b[1], 1)), h: ASSUMED.doorHeight },
        props: { clear_width: measuredValue(o.width, ctx, `gap between the wall ends in view ${vname}`, o.evidence) }, source: `drawing view ${vname}: gap in a wall without a door swing`, basis: 'measured', confidence: 0.7, evidence: o.evidence,
        note: 'A gap in the wall with no door swing drawn: an opening, or a door the drawing does not show.' };
      el._opening = o;
      push(el, { kind: 'openings', item: { deck: d.id, a: o.a.map((v) => round(v)), b: o.b.map((v) => round(v)), width: round(o.width), z0, z1: z0 + ASSUMED.doorHeight, basis: 'measured', evidence: o.evidence } });
    }
    // walls
    for (const w of res.walls) {
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
      if (L < 200) continue;
      const dir = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L], n = [-dir[1], dir[0]];
      const b = ringBox([w.a, w.b].flatMap((p) => [[p[0] + n[0] * w.thickness / 2, p[1] + n[1] * w.thickness / 2], [p[0] - n[0] * w.thickness / 2, p[1] - n[1] * w.thickness / 2]]));
      const props = { thickness: w.thicknessBasis === 'assumed' ? { value: w.thickness, unit: 'mm', basis: 'assumed', source: `assumed ${w.thickness} mm: drawn as a single line without a stroke width` } : measuredValue(w.thickness, ctx, `distance between the two face lines in view ${vname}`, w.evidence.slice(0, 4)) };
      const el = { id: null, type: 'wall', name: `${w.kind[0].toUpperCase()}${w.kind.slice(1)}`, deck: d.id, geom: { x: round(b[0]), y: round(b[1]), z: 0, lx: round(Math.max(b[2] - b[0], 1)), ly: round(Math.max(b[3] - b[1], 1)), h: round(d.height) },
        props, source: `drawing view ${vname}: ${w.single ? 'single line' : 'pair of parallel lines'}`, basis: 'measured', confidence: w.single ? 0.5 : 0.85, evidence: w.evidence.slice(0, 20) };
      // a wall with open deck (or the outside) on both sides is a rail or bulwark, not a full-height wall
      const rail = open.railAt(w, res.rooms);
      if (rail === 'none') continue;
      if (rail) { el.geom.h = RAIL; el.note = `rail / bulwark between open deck areas: height ${RAIL} mm assumed`; }
      el._wall = w;
      push(el, { kind: 'walls', item: { deck: d.id, a: w.a.map((v) => round(v)), b: w.b.map((v) => round(v)), thickness: round(w.thickness), z0, z1: rail ? z0 + RAIL : z1, kind: w.kind, ...(rail ? { rail: true } : {}),
        openings: w.openings.map((o) => ({ from: round(o.from), to: round(o.to), z0, z1: z0 + ASSUMED.doorHeight, kind: o.kind, ref: o.ref })), basis: 'measured', evidence: w.evidence.slice(0, 20) } });
    }
    // ladders
    for (const l of res.ladders) {
      const width = l.width ?? 450;
      const b = [l.at[0] - width / 2, l.at[1] - width / 2, l.at[0] + width / 2, l.at[1] + width / 2];
      const above = deckAbove(d);
      const props = l.width ? { clear_width: measuredValue(l.width, ctx, `rung length in view ${vname}`, l.evidence) } : {};
      const el = { id: null, type: 'ladder', name: 'Ladder', deck: d.id, geom: { x: round(b[0]), y: round(b[1]), z: 0, lx: round(width), ly: round(width), h: round(above ? above.elevation - d.elevation : d.height) },
        props, source: `drawing view ${vname}: ${l.rungs ? `${l.rungs} rungs` : 'label'}`, basis: l.basis, confidence: l.rungs ? 0.8 : 0.5, evidence: l.evidence, ...(l.note ? { note: l.note } : {}) };
      push(el, { kind: 'ladders', item: { deck: d.id, at: l.at.map((v) => round(v)), width: round(width), dir: l.dir.map((v) => round(v, 4)), z0, z1: above ? above.elevation : z1, basis: l.basis, evidence: l.evidence } });
    }
    // equipment and liferafts
    for (const e of res.equipment) {
      const b = ringBox(e.polygon);
      const crane = /CRANE|KRAN|A ?FRAME|DAVIT/.test(normText(e.label));
      const h = e.height ?? (e.type === 'liferaft' ? ASSUMED.liferaft : crane ? ASSUMED.crane : ASSUMED.equipment);
      ctx.assumed.push(`${d.name}: "${e.label}" height ${h} mm`);
      const el = { id: null, type: e.type, name: e.label, deck: d.id, geom: { x: round(b[0]), y: round(b[1]), z: 0, lx: round(b[2] - b[0]), ly: round(b[3] - b[1]), h },
        props: e.type === 'liferaft' ? { zone: { value: 'open_deck', basis: 'read', source: `label "${e.label}"` } } : {}, source: `drawing view ${vname}: labelled shape "${e.label}"`, basis: 'measured', confidence: 0.8, evidence: e.evidence, note: `height ${h} mm assumed.` };
      push(el, { kind: 'equipment', item: { deck: d.id, polygon: e.polygon.map((p) => p.map((v) => round(v))), z0, z1: z0 + h, basis: 'measured', evidence: e.evidence } });
    }
    for (const p of pending) if (p.el.type === 'stair' && p.rec) upFlights.push({ box: ringBox(p.rec.item.polygon), z1: p.rec.item.z1 });
    // ids: per type, sorted by x then y
    const byType = new Map();
    for (const p of pending) { const t = p.el.type; if (!byType.has(t)) byType.set(t, []); byType.get(t).push(p); }
    for (const [type, list] of byType) {
      list.sort((a, b) => a.el.geom.x - b.el.geom.x || a.el.geom.y - b.el.geom.y);
      list.forEach((p, i) => {
        p.el.id = `${d.id}-${ABBR[type] ?? type.toUpperCase()}-${i + 1}`;
        if (p.rec) { p.rec.item.id = p.el.id; recon[p.rec.kind].push(p.rec.item); }
      });
    }
    // door → rooms (connects), and the report lists
    const roomId = new Map(pending.filter((p) => p.el._room).map((p) => [p.el._room, p.el.id]));
    for (const p of pending) {
      const dr = p.el._door ?? p.el._opening;
      if (dr && dr.connects?.length) p.el.props.connects = { value: dr.connects.map((r) => roomId.get(r)).filter(Boolean), basis: 'measured', source: 'rooms on both sides of the opening' };
      if (p.el._door) {
        const rec = recon.doors.find((x) => x.id === p.el.id);
        const wall = pending.find((q) => q.el._wall && q.el._wall._w === p.el._door.wall);
        if (rec && wall) { rec.wall = wall.el.id; for (const o of recon.walls.find((x) => x.id === wall.el.id)?.openings ?? []) if (o.kind === 'door' && o.ref === p.el._door.index) o.ref = p.el.id; }
      }
      if (p.el._opening) {
        const wall = pending.find((q) => q.el._wall && q.el._wall._w === p.el._opening.wall);
        if (wall) for (const o of recon.walls.find((x) => x.id === wall.el.id)?.openings ?? []) if (o.kind === 'opening' && o.ref === p.el._opening.index) o.ref = p.el.id;
      }
    }
    for (const w of recon.walls.filter((x) => x.deck === d.id)) for (const o of w.openings) if (typeof o.ref === 'number') o.ref = null;
    for (const p of pending) {
      if (p.el._room) lists.rooms.push({ id: p.el.id, deck: d.id, name: p.el.name, type: p.el.type, zone: p.el.props.zone?.value ?? null, area: p.el.props.area.value, area_printed: p.el.props.area_printed?.value ?? null,
        clear_width: p.el.props.clear_width?.value ?? null, basis: p.el.basis, confidence: p.el.confidence, evidence: p.el.evidence, polygon: p.el._room.ring.map((q) => q.map((v) => round(v))) });
      if (p.el._door) lists.doors.push({ id: p.el.id, deck: d.id, width: p.el.props.clear_width.value, double: !!p.el._door.double, connects: p.el.props.connects?.value ?? [], basis: 'measured', confidence: p.el.confidence, evidence: p.el.evidence });
      delete p.el._room; delete p.el._door; delete p.el._wall; delete p.el._opening;
      elements.push(p.el);
    }
  }
  // portholes / windows from the profile, on the port side of the deck they are on
  if (profile) {
    const wins = [];
    for (const ph of profile.portholes) {
      const z = ph.c[1];
      const d = decks.slice().reverse().find((x) => x.elevation <= z) || decks[0];
      if (!d) continue;
      const y = halfBreadth(d, ph.c[0]);
      if (y == null) continue;
      wins.push({ d, x: ph.c[0], y, z, r: ph.r, ref: ph.ref });
    }
    wins.sort((a, b) => a.x - b.x || a.z - b.z);
    const count = new Map();
    for (const w of wins) {
      const n = (count.get(w.d.id) || 0) + 1; count.set(w.d.id, n);
      const id = `${w.d.id}-WIN-${n}`;
      elements.push({ id, type: 'window', name: 'Porthole', deck: w.d.id, geom: { x: round(w.x - w.r), y: round(w.y - 50), z: round(w.z - w.r - w.d.elevation), lx: round(2 * w.r), ly: 100, h: round(2 * w.r) },
        props: { diameter: measuredValue(2 * w.r, ctx, `circle in the profile (${w.ref})`, [w.ref]) }, source: `drawing profile ${profile.name}: circle ${w.ref}`, basis: 'measured', confidence: 0.7, evidence: [w.ref],
        note: 'Position along the ship and height from the profile; the profile shows one side: placed on the port side.' });
      recon.windows.push({ id, deck: w.d.id, at: [round(w.x), round(w.y)], r: round(w.r), z: round(w.z), basis: 'measured', evidence: [w.ref] });
    }
    if (wins.length) ctx.assumed.push(`${wins.length} portholes from the profile placed on the port side (the profile shows one side)`);
  }
  return { elements, recon, lists, area };
}
/**
 * A plan can show lower decks around its own (a forecastle plan with the open main deck behind it, seen from above).
 * When the deck's line in the profile ends well inside the plan's outline, the outline is cut to the line and the
 * rooms beyond it are left out (listed).
 */
function clipToDeckLine(d, ctx) {
  const res = d.plan.res, l = d.line;
  if (!l || !res.outline) return;
  const ob = ringBox(res.outline.ring);
  const lo = ob[0] < l.x0 - 1000 ? l.x0 - 200 : -Infinity, hi = ob[2] > l.x1 + 1000 ? l.x1 + 200 : Infinity;
  if (lo === -Infinity && hi === Infinity) return;
  const box = [[Math.max(lo, ob[0] - 1), ob[1] - 1], [Math.min(hi, ob[2] + 1), ob[1] - 1], [Math.min(hi, ob[2] + 1), ob[3] + 1], [Math.max(lo, ob[0] - 1), ob[3] + 1]];
  const ring = clipConvex(res.outline.ring, box);
  if (ring.length < 3) return;
  const before = res.rooms.length;
  res.rooms = res.rooms.filter((r) => { const c = centroid(r.ring); return c[0] >= lo && c[0] <= hi; });
  // walls, doors, stairs and the rest drawn there belong to the lower deck too
  const inX = (x) => x >= lo && x <= hi;
  res.walls = res.walls.filter((w) => inX((w.a[0] + w.b[0]) / 2)).map((w) => {
    // a wall running past the cut ends at it (when it has no opening that would shift)
    if (w.openings.length || (inX(w.a[0]) && inX(w.b[0]))) return w;
    const cl = (p, q) => { const x = Math.min(hi, Math.max(lo, p[0])); const t = (x - q[0]) / ((p[0] - q[0]) || 1); return [x, q[1] + (p[1] - q[1]) * t]; };
    return { ...w, a: inX(w.a[0]) ? w.a : cl(w.a, w.b), b: inX(w.b[0]) ? w.b : cl(w.b, w.a) };
  });
  res.doors = res.doors.filter((dr) => inX(dr.hinge[0]));
  res.openings = res.openings.filter((o) => inX((o.a[0] + o.b[0]) / 2));
  res.stairs = res.stairs.filter((st) => inX(centroid(st.polygon)[0]));
  res.ladders = res.ladders.filter((l) => inX(l.at[0]));
  res.equipment = res.equipment.filter((e) => inX(centroid(e.polygon)[0]));
  res.outline = { ...res.outline, ring, area: ringArea(ring), clipped: [lo, hi] };
  const n = before - res.rooms.length;
  ctx.measured.push(`deck ${d.name}: the plan also shows ${n} area${n === 1 ? '' : 's'} beyond the deck's line in the profile (x ${fmt(l.x0)}…${fmt(l.x1)}), a lower deck seen from above: left out of this deck`);
}

/**
 * Open deck: the part of a deck plan not under the deck above (the outline of the next plan up). For the top plan
 * the profile decides: a roof line 1.8–4.5 m above the deck over the area makes it enclosed.
 */
function openDeckOf(d, decks, profile) {
  const ringOf = (x) => (x.view.halfPlan ? mirrorHalf(x.plan.res.outline.ring) : x.plan.res.outline.ring);
  const above = decks.filter((x) => x !== d && x.plan.res.outline && x.elevation > d.elevation + 500 && x.elevation <= d.elevation + 5000);
  const roofs = !above.length && profile ? profile.lines.filter((l) => l.z >= d.elevation + 1800 && l.z <= d.elevation + 4500 && l.len >= 1500) : [];
  const covered = above.length
    ? (p) => above.some((x) => pointInRing([p[0], d.view.halfPlan ? Math.abs(p[1]) : p[1]], ringOf(x)))
    : (p) => roofs.some((l) => p[0] >= l.x0 && p[0] <= l.x1);
  const why = above.length ? `not under deck ${above.map((x) => x.name).join(' / ')} (outside its outline): open deck`
    : profile ? 'no roof over it in the profile and no deck plan above: open deck' : 'no deck above it in the drawing: open deck';
  const share = (r) => {
    const b = ringBox(r.ring);
    let n = 0, c = 0;
    for (let i = 1; i < 8; i++) for (let j = 1; j < 8; j++) {
      const p = [b[0] + ((b[2] - b[0]) * i) / 8, b[1] + ((b[3] - b[1]) * j) / 8];
      if (!pointInRing(p, r.ring) || r.holes.some((h) => pointInRing(p, h))) continue;
      n++; if (covered(p)) c++;
    }
    if (!n) return covered(centroid(r.ring)) ? 1 : 0;
    return c / n;
  };
  const isOpen = (r) => share(r) < 0.5;
  // a wall with open deck or the outside on both sides is a rail or bulwark
  const railAt = (w, rooms) => {
    const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
    if (L < 1) return false;
    const n = [-(w.b[1] - w.a[1]) / L, (w.b[0] - w.a[0]) / L], m = [(w.a[0] + w.b[0]) / 2, (w.a[1] + w.b[1]) / 2], off = w.thickness / 2 + 250;
    const sides = [1, -1].map((k) => {
      const p = [m[0] + n[0] * off * k, m[1] + n[1] * off * k];
      const r = rooms.find((x) => pointInRing(p, x.ring));
      return r ? (r.openDeck ? 'open' : 'room') : 'outside';
    });
    if (sides.includes('room')) return false;
    // open deck on both sides: a line drawn on the deck (a crane's reach, a hatch, a container's place), no wall
    return sides.every((x) => x === 'open') ? 'none' : true;
  };
  return { isOpen, railAt, why, anyAbove: above.length > 0 || roofs.length > 0 };
}

const perim = (ring) => { let s = 0; for (let i = 0; i < ring.length; i++) { const q = ring[(i + 1) % ring.length]; s += Math.hypot(q[0] - ring[i][0], q[1] - ring[i][1]); } return s; };

function stairElement(d, s, room, decks, ctx, vname, deckAbove, deckBelow) {
  const up = !s?.upText || s.upText.word === 'up';
  const above = deckAbove(d), below = deckBelow(d);
  const [z0, z1] = up ? [d.elevation, above ? above.elevation : d.elevation + d.height] : [below ? below.elevation : d.elevation - ASSUMED.deckHeight, d.elevation];
  const poly = s ? s.polygon : room.ring;
  const b = ringBox(poly);
  const props = { zone: { value: 'circulation', basis: room ? 'read' : 'assumed', source: room ? `label "${room.label}"` : 'a stair is circulation' } };
  const ev = [...(s?.evidence ?? []), ...(room?.labelIds ?? [])];
  if (s) {
    props.clear_width = measuredValue(s.width, ctx, `tread length of ${s.treads} treads in view ${vname}`, s.evidence);
    props.treads = { value: s.treads, basis: 'measured', source: `counted: ${s.treads} parallel treads ${round(s.going)} mm apart` };
    props.going = measuredValue(s.going, ctx, 'distance between the treads', s.evidence);
  }
  const notes = [];
  if (!s) notes.push('stair named on the plan, no treads found: width not measured.');
  if (!(up ? above : below)) notes.push(`no deck ${up ? 'above' : 'below'} in the drawing: the stair height is the deck height.`);
  if (s && !s.upText) notes.push('no UP/DN text at the stair: assumed to lead up.');
  const el = { id: null, type: 'stair', name: room?.label ?? 'Stair', deck: d.id, geom: { x: round(b[0]), y: round(b[1]), z: round(z0 - d.elevation), lx: round(b[2] - b[0]), ly: round(b[3] - b[1]), h: round(z1 - z0) },
    props, source: `drawing view ${vname}: ${s ? `${s.treads} treads` : 'stair label'}`, basis: 'measured', confidence: s ? 0.85 : 0.5, evidence: ev, ...(notes.length ? { note: notes.join(' ') } : {}) };
  return [el, { kind: 'stairs', item: { deck: d.id, polygon: poly.map((p) => p.map((v) => round(v))), dir: (s?.dir ?? [1, 0]).map((v) => round(v, 4)), z0, z1, treads: s?.treads ?? null, basis: 'measured', evidence: ev } }];
}

// Port half-breadth of a deck outline at x (largest y of the outline there), or null outside it.
function halfBreadth(d, x) {
  const ring = d.outlineFull ?? d.plan.res.outline?.ring;
  if (!ring) return null;
  const ys = crossingsAtX(ring, x);
  return ys.length >= 2 ? Math.max(ys[ys.length - 1], -ys[0]) : null;
}

// ---------- hull ----------

/**
 * Hull stations every L/40: half-breadth at each hull deck from the deck outlines, the keel from the profile's lower
 * contour, a bilge below the lowest deck (sections are not read yet: flat keel and bilge radius 0.12 B, assumed).
 */
function buildHull(decks, profile, plans, views, ctx) {
  // full-breadth outlines (half plans mirrored)
  for (const d of decks) {
    const o = d.plan.res.outline?.ring;
    if (!o) continue;
    d.outlineFull = d.view.halfPlan ? mirrorHalf(o) : o;
    if (d.view.halfPlan) ctx.assumed.push(`deck ${d.name}: half plan mirrored to the full breadth`);
  }
  const withOutline = decks.filter((d) => d.outlineFull);
  if (!withOutline.length) return null;
  const xs = withOutline.flatMap((d) => ringBox(d.outlineFull).filter((_, i) => i % 2 === 0));
  let xAft = Math.min(...xs), xFwd = Math.max(...xs);
  if (profile?.ring) { xAft = Math.min(xAft, profile.box[0]); xFwd = Math.max(xFwd, profile.box[2]); }
  const L = xFwd - xAft;
  const longDecks = withOutline.filter((d) => { const b = ringBox(d.outlineFull); return b[2] - b[0] >= 0.5 * L; });
  const main = withOutline.find((d) => d.key === 'main_deck') || longDecks[longDecks.length - 1] || withOutline[withOutline.length - 1];
  const hullDecks = withOutline.filter((d) => d.elevation <= main.elevation + 1);
  const B = 2 * Math.max(...hullDecks.map((d) => ringBox(d.outlineFull)[3]));
  const assumed = [];
  const stations = [];
  let keelZ = Infinity;
  const usedBilge = { n: 0 };
  for (let i = 0; i <= 40; i++) {
    const x = xAft + (L * i) / 40;
    const pts = hullDecks.map((d) => ({ d, y: halfBreadth(d, x) })).filter((p) => p.y != null && p.y > 0).sort((a, b) => a.d.elevation - b.d.elevation);
    if (!pts.length) continue;
    let zb = 0;
    if (profile?.ring) { const zz = profile.zAt(x); if (zz) zb = Math.max(zz[0], 0 - 1e9); }
    // stem / stern: no hull below the profile contour at this x
    const low = pts[0];
    if (zb >= low.d.elevation) continue;
    keelZ = Math.min(keelZ, zb);
    const half = [[0, round(zb)]];
    const R = Math.max(0, Math.min(0.12 * B, low.y, low.d.elevation - zb));
    if (R > 0) {
      half.push([round(low.y - R), round(zb)]);
      for (let k = 1; k <= 4; k++) { const a = (-Math.PI / 2) + (k * Math.PI) / 8; half.push([round(low.y - R + R * Math.cos(a)), round(zb + R + R * Math.sin(a))]); }
      usedBilge.n++;
    } else half.push([round(low.y), round(zb)]);
    for (const p of pts) half.push([round(p.y), round(p.d.elevation)]);
    stations.push({ x: round(x), half });
  }
  if (usedBilge.n) assumed.push(`below the lowest deck: flat keel and a bilge radius of 0.12 × B (${fmt(0.12 * B)}); no sections were read`);
  if (!profile) assumed.push('no profile: keel at the baseline (z = 0) over the whole length, ends from the deck outlines');
  for (const a of assumed) ctx.assumed.push(`hull: ${a}`);
  const contour = (pick) => {
    if (!profile?.ring) return [];
    const out = [];
    const z0 = Math.max(0, profile.box[1]), z1 = main.elevation;
    for (let k = 0; k <= 12; k++) { const z = z0 + ((z1 - z0) * k) / 12; const xx = profile.xAt(z); if (xx) out.push([round(pick(xx)), round(z)]); }
    return out;
  };
  return { id: null, stations, stem: contour((x) => x[1]), stern: contour((x) => x[0]), keelZ: round(Number.isFinite(keelZ) ? keelZ : 0), assumed, B, L, xAft, xFwd, main,
    evidence: profile?.evidence?.slice(0, 50) ?? [] };
}

// A half outline (port side, closed along the centre line) and its mirror image as one full-breadth outline.
// Walking the port half counter-clockwise, the centre-line run goes aft → forward; the rest runs forward → aft.
function mirrorHalf(ring) {
  const n = ring.length, onCL = ring.map((p) => Math.abs(p[1]) < 20);
  const s = onCL.findIndex((z, i) => z && !onCL[(i + 1) % n]);
  if (s < 0) return ring;
  const port = [ring[s]];
  for (let k = 1; k < n; k++) { const p = ring[(s + k) % n]; port.push(p); if (onCL[(s + k) % n]) break; }
  const fwd = port[0], aft = port[port.length - 1];
  const stbd = port.slice().reverse().map(([x, y]) => [x, -y]);
  return simplifyRing([[aft[0], 0], ...stbd.slice(1, -1), [fwd[0], 0], ...port.slice(1, -1)], 1);
}

// ---------- ship particulars ----------

function particulars(sheet, decks, profile, hull, ctx) {
  const printed = readPrincipals(sheet);
  const ship = {};
  const measuredLOA = (() => {
    if (profile?.ring && hull?.main) {
      const D = hull.main.elevation;
      const ext = [0.4, 0.6, 0.8, 0.95].map((f) => profile.xAt(f * D)).filter(Boolean).map((x) => x[1] - x[0]);
      if (ext.length) return { mm: Math.max(...ext), source: `length of the hull in the profile ${profile.name} between the baseline and the main deck`, evidence: profile.evidence.slice(0, 10) };
    }
    if (hull) return { mm: hull.L, source: 'length of the longest deck outline', evidence: [] };
    return null;
  })();
  const set = (key, meas, label) => {
    const p = printed[key];
    if (p) {
      ship[key] = { value: round(p.mm), unit: 'mm', basis: 'read', source: `text on the drawing "${p.text}" (${p.id})`, evidence: String(p.id).split('+') };
      if (meas) {
        const dev = Math.abs(meas.mm / p.mm - 1);
        ship[key].measured = round(meas.mm);
        if (dev > 0.05) ctx.warnings.push(`${label}: printed ${fmt(p.mm)}, measured ${fmt(meas.mm)} (${meas.source}) — ${round(dev * 100, 1)} % apart. The printed value is used.`);
        else ctx.measured.push(`${label} ${fmt(meas.mm)} measured, printed ${fmt(p.mm)}: agree within ${round(dev * 100, 1)} %`);
      }
    } else if (meas) ship[key] = { ...measuredValue(meas.mm, ctx, meas.source, meas.evidence) };
  };
  set('length_overall', measuredLOA, 'Length overall');
  const beam = hull ? { mm: hull.B, source: 'widest deck outline', evidence: [] } : null;
  set('beam', beam, 'Breadth');
  const md = decks.find((d) => d.key === 'main_deck');
  set('depth', md && md.ev.basis !== 'assumed' ? { mm: md.elevation, source: 'main deck elevation above the baseline', evidence: md.ev.evidence || [] } : null, 'Depth');
  if (printed.draft) set('draft', null, 'Draught');
  if (printed.length_bp) set('length_bp', null, 'Length between perpendiculars');
  // name and type from the title block
  const titleTexts = sheet.texts.filter((t) => shipTypeOf(t.text));
  if (ctx.overrides.shipName) ship.name = { value: ctx.overrides.shipName, basis: 'typed', source: 'typed by the user' };
  if (titleTexts.length) {
    const t = titleTexts.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
    ship.type = { value: shipTypeOf(t.text), basis: 'read', source: `text on the drawing "${t.text.trim()}" (${t.id})`, evidence: [t.id] };
    if (!ship.name) {
      const m = /(?:VESSEL|SHIP|R\/?V|M\/?V)\s+["'“]?([A-Z][A-Z0-9 \-]{1,30})["'”]?\s*$/i.exec(t.text.trim());
      if (m) ship.name = { value: m[1].trim(), basis: 'read', source: `text on the drawing "${t.text.trim()}" (${t.id})` };
    }
  }
  return ship;
}

function plausibility(scale, built, ship, ctx) {
  const loa = ship.length_overall?.value;
  if (loa != null && (loa < 5000 || loa > 400000)) {
    ctx.warnings.push(`With this scale the ship is ${fmt(loa)} long (plausible: 5–400 m). The scale is probably wrong: check it.`);
    scale.status = 'check';
  }
  const widths = built.lists.doors.map((d) => d.width).sort((a, b) => a - b);
  if (widths.length) {
    const med = widths[Math.floor(widths.length / 2)];
    if (med < 500 || med > 2000) { ctx.warnings.push(`With this scale the doors are ${fmt(med)} wide (median; plausible 0.5–2.0 m). Check the scale.`); scale.status = 'check'; }
  }
}

// ---------- model, recon, report ----------

// Rooms per zone, as plain strings (a room without a zone counts as "none").
const zoneCounts = (rooms) => rooms.reduce((o, r) => { const z = typeof r.zone === 'string' ? r.zone : 'none'; o[z] = (o[z] || 0) + 1; return o; }, {});

function assemble({ sheet, vs, reg, scale, decks, built, hull, ship, profile, plans, ctx }) {
  const file = sheet.source?.file ?? 'drawing';
  const lowest = decks[0];
  const elements = built.elements.slice();
  let reconHull = null;
  if (hull && lowest) {
    const id = `${lowest.id}-HULL-1`;
    hull.id = id;
    const top = hull.main.elevation;
    elements.push({ id, type: 'hull', name: 'Hull', deck: lowest.id, geom: { x: round(hull.xAft), y: round(-hull.B / 2), z: round(hull.keelZ - lowest.elevation), lx: round(hull.L), ly: round(hull.B), h: round(top - hull.keelZ) },
      props: {}, source: `drawing ${file}: deck outlines${profile ? ' and profile' : ''}`, basis: hull.assumed.length ? 'measured' : 'measured', confidence: 0.7, evidence: hull.evidence,
      ...(hull.assumed.length ? { note: `Assumed: ${hull.assumed.join('; ')}.` } : {}) });
    reconHull = { id, stations: hull.stations, stem: hull.stem, stern: hull.stern, keelZ: hull.keelZ, assumed: hull.assumed, basis: 'measured', evidence: hull.evidence };
  }
  const modelDecks = decks.filter((d) => d.outlineFull || d.plan.res.outline).map((d) => {
    const outline = (d.outlineFull ?? d.plan.res.outline.ring).map((p) => p.map((v) => round(v)));
    return { id: d.id, name: d.name, elevation: round(d.elevation), height: round(d.height), outline,
      source: `drawing ${file}, view ${d.view.title ?? d.view.id}: outline = largest closed loop of the plan; elevation: ${d.ev.source}; height: ${d.hv?.source ?? ''}`,
      basis: d.ev.basis, elevation_basis: d.ev.basis, height_basis: d.hv?.basis ?? 'assumed', evidence: [...(d.plan.res.outline?.evidence ?? []).slice(0, 30), ...(d.ev.evidence ?? [])] };
  });
  const model = {
    name: ship.name?.value ? `${ship.name.value} (${file})` : `${file}`,
    units: 'mm',
    source: `technical drawing ${file}${sheet.source?.page ? `, page ${sheet.source.page}` : ''}`,
    provenance_note: `Interpreted from the drawing ${file}: ${modelDecks.length} deck${modelDecks.length === 1 ? '' : 's'}, ${elements.length} elements. Scale ${scale.value ? `1:${scale.value}` : ''} (${round(scale.mmPerUnit, 4)} mm per sheet unit, ${scale.status}). Every value says whether it was measured from the drawing, read from its text, typed by the user or assumed.`,
    ship, decks: modelDecks, elements,
    drawing: { file, scale: { value: scale.value, mmPerUnit: scale.mmPerUnit, status: scale.status }, origin: ctx.origin },
  };
  const recon = {
    decks: modelDecks.map((d) => ({ id: d.id, name: d.name, elevation: d.elevation, height: d.height, outline: d.outline, plateThickness: ASSUMED.plate, basis: d.basis })),
    hull: reconHull, walls: built.recon.walls, rooms: built.recon.rooms, doors: built.recon.doors, stairs: built.recon.stairs, ladders: built.recon.ladders,
    windows: built.recon.windows, equipment: built.recon.equipment, openings: built.recon.openings,
  };
  if (recon.decks.length) ctx.assumed.push(`deck plate thickness ${ASSUMED.plate} mm (for the 3D view only)`);
  const counts = {};
  for (const e of elements) counts[e.type] = (counts[e.type] || 0) + 1;
  const viewList = vs.map((v) => {
    const r = reg.views.find((x) => x.view === v);
    const d = decks.find((x) => x.view === v);
    return { id: v.id, kind: v.kind, confidence: v.confidence, title: v.title, deckName: v.deckName ?? null, deck: d?.id ?? null, elevation: d ? round(d.elevation) : null,
      toSheet: r ? r.toSheet.map((x) => round(x, 8)) : null, registration: r ? { x: r.how, y: r.vHow, basis: r.basis === 'assumed' || r.vBasis === 'assumed' ? 'assumed' : 'measured' } : null, why: v.why };
  });
  const report = {
    scale: { value: scale.value, mmPerUnit: scale.mmPerUnit, source: scale.source, basis: scale.basis, status: scale.status, uncertainty: scale.uncertainty, sources: scale.sources },
    bow: reg.bow, origin: ctx.origin,
    views: viewList,
    decks: decks.map((d) => ({ id: d.id, name: d.name, view: d.view.id, elevation: round(d.elevation), height: round(d.height), basis: d.ev.basis, source: `elevation: ${d.ev.source}; height: ${d.hv?.source ?? 'not stated'}`, elevation_basis: d.ev.basis, elevation_source: d.ev.source, height_basis: d.hv?.basis ?? null, height_source: d.hv?.source ?? null,
      outline_area: d.plan.res.outline ? round(ringArea(d.outlineFull ?? d.plan.res.outline.ring) / 1e6, 2) : null, rooms: d.plan.res.rooms.length, evidence: d.ev.evidence ?? [] })),
    counts: { zones: zoneCounts(built.lists.rooms), unlabelled_areas: plans.reduce((t, p) => t + (p.res.unlabelledSmall || 0), 0), open_deck: built.lists.rooms.filter((r) => r.zone === 'open_deck').length, rooms: built.lists.rooms.length, doors: built.lists.doors.length, openings: counts.opening || 0, stairs: counts.stair || 0, ladders: counts.ladder || 0, walls: counts.wall || 0, windows: counts.window || 0, equipment: (counts.equipment || 0) + (counts.liferaft || 0), elements: elements.length },
    rooms: built.lists.rooms, doors: built.lists.doors,
    areas: { printed: built.area.printed, agree: built.area.agree, agree_without_merge: built.area.agreeUnmerged, list: built.area.list },
    ship: Object.fromEntries(Object.entries(ship).map(([k, v]) => [k, { value: v.value, basis: v.basis, source: v.source, ...(v.measured != null ? { measured: v.measured } : {}) }])),
    measured: ctx.measured, assumed: [...new Set(ctx.assumed)], typed: ctx.typed, warnings: ctx.warnings, check: [...new Set(ctx.check)], unresolved: ctx.unresolved,
    plans: plans.map((p) => ({ view: p.r.view.id, name: p.name, stats: { ...p.res.stats, dimensions: undefined } })),
  };
  if (built.area.printed) ctx.measured.push(`${built.area.agree} of ${built.area.printed} printed room areas agree with the measured areas within 3 % (${built.area.agreeUnmerged} without joining pieces by the printed area)`);
  return { model, recon, report };
}
