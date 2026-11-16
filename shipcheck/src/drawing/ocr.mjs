// Labels drawn as line work instead of text (single-stroke CAD fonts, text exploded to outlines): find the groups of
// small strokes that look like writing, raster each group on its own (no other line work in the picture) and let an
// OCR engine read it. What it reads becomes a sheet text marked `ocr: { confidence }`, so every value derived from it
// says "read by OCR, check". Pure module: the engine comes in as `recognize(image) -> Promise<lines>` (tesseract.js in
// the browser worker or in Node); nothing here loads or runs it.
//
//   const stats = await ocrSheet(sheet, recognize, { onProgress });
//   recognize({ width, height, data /* Uint8ClampedArray, RGBA */, rotate }) ->
//     [{ text, confidence /* 0–100 */, bbox: { x0, y0, x1, y1 } /* image pixels, y down */ }]

const OCR = {
  maxGlyph: 0.008,     // a glyph stroke is at most this share of the sheet diagonal
  joinGap: 0.6,        // strokes closer than this × glyph height belong to one label
  maxLines: 4,         // a label group is at most about this many glyph heights tall (a hatch or grid is taller)
  minStrokes: 3,       // a group needs this many strokes to be writing
  targetPx: 24,        // glyph height in the picture handed to the engine (24: as good as 32 and a third faster)
  pad: 12,             // white border around the picture, px
  minConfidence: 60,   // lines read with less confidence are dropped
  maxGroups: 1500,     // a sheet with more candidate groups is read in part (and the report says so)
};

const boxOf = (pts) => {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of pts) { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
  return b;
};

/**
 * Groups of small strokes drawn with one pen that may be writing: [{ box, members: [path index], h, pen }], h = the
 * typical glyph height (75th percentile of the stroke heights).
 */
export function glyphGroups(sheet, opts = {}) {
  const o = { ...OCR, ...opts };
  const b = sheet.bbox;
  const diag = Math.hypot(b[2] - b[0], b[3] - b[1]) || 1;
  const maxG = o.maxGlyph * diag;
  const cand = [];
  sheet.paths.forEach((p, i) => {
    if (!p.pts?.length || p.dash) return;
    const bb = boxOf(p.pts);
    const w = bb[2] - bb[0], h = bb[3] - bb[1];
    if (Math.max(w, h) > maxG || Math.max(w, h) <= 0) return;
    cand.push({ i, bb, s: Math.max(w, h), pen: `${p.color ?? ''}|${Math.round((p.width || 0) * 100)}|${p.fill && !p.stroke ? 'f' : 's'}` });
  });
  // union of strokes of one pen that lie close together (grid index over the candidate boxes)
  const parent = cand.map((_, k) => k);
  const find = (k) => { while (parent[k] !== k) { parent[k] = parent[parent[k]]; k = parent[k]; } return k; };
  const cell = maxG;
  const grid = new Map();
  cand.forEach((c, k) => {
    for (let gx = Math.floor(c.bb[0] / cell); gx <= Math.floor(c.bb[2] / cell); gx++)
      for (let gy = Math.floor(c.bb[1] / cell); gy <= Math.floor(c.bb[3] / cell); gy++) {
        const key = `${gx},${gy}`;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(k);
      }
  });
  cand.forEach((c, k) => {
    const g = o.joinGap * Math.max(c.s, 1e-9);
    for (let gx = Math.floor((c.bb[0] - g) / cell); gx <= Math.floor((c.bb[2] + g) / cell); gx++)
      for (let gy = Math.floor((c.bb[1] - g) / cell); gy <= Math.floor((c.bb[3] + g) / cell); gy++) {
        for (const m of grid.get(`${gx},${gy}`) || []) {
          if (m <= k) continue;
          const d = cand[m];
          if (d.pen !== c.pen) continue;
          const gg = o.joinGap * Math.max(c.s, d.s);
          if (d.bb[0] - c.bb[2] > gg || c.bb[0] - d.bb[2] > gg || d.bb[1] - c.bb[3] > gg || c.bb[1] - d.bb[3] > gg) continue;
          parent[find(m)] = find(k);
        }
      }
  });
  const groups = new Map();
  cand.forEach((c, k) => {
    const r = find(k);
    if (!groups.has(r)) groups.set(r, { members: [], sizes: [], box: [Infinity, Infinity, -Infinity, -Infinity], pen: c.pen });
    const g = groups.get(r);
    g.members.push(c.i); g.sizes.push(c.bb[3] - c.bb[1]);
    g.box = [Math.min(g.box[0], c.bb[0]), Math.min(g.box[1], c.bb[1]), Math.max(g.box[2], c.bb[2]), Math.max(g.box[3], c.bb[3])];
  });
  const out = [];
  for (const g of groups.values()) {
    if (g.members.length < o.minStrokes) continue;
    const hs = g.sizes.slice().sort((a, b) => a - b);
    const h = hs[Math.floor(0.75 * (hs.length - 1))];
    if (!(h > 0)) continue;
    const W = g.box[2] - g.box[0], H = g.box[3] - g.box[1];
    // writing is a few glyph heights tall (one to a few lines) or, turned 90°, a few glyph heights wide
    if (Math.min(W, H) > o.maxLines * 1.6 * h) continue;
    out.push({ box: g.box, members: g.members, h, pen: g.pen, vertical: H > 1.5 * W });
  }
  return out;
}

/**
 * The group's strokes as an RGBA picture (black on white), glyph height about targetPx; also the mapping back to the
 * sheet. rotate: 0, 90 (turned clockwise: text written bottom-to-top reads left-to-right) or -90.
 */
export function rasterGroup(sheet, group, opts = {}) {
  const o = { ...OCR, ...opts };
  const rot = opts.rotate || 0;
  const k = o.targetPx / group.h;
  const [x0, y0, x1, y1] = group.box;
  const W0 = (x1 - x0) * k, H0 = (y1 - y0) * k;
  const width = Math.ceil((rot ? H0 : W0) + 2 * o.pad), height = Math.ceil((rot ? W0 : H0) + 2 * o.pad);
  if (width * height > 40e6) return null; // a group this large is no label
  const gray = new Uint8Array(width * height).fill(255);
  // sheet → picture (y down), with the rotation
  const toPx = (x, y) => {
    const u = (x - x0) * k, v = (y1 - y) * k; // unrotated, y down
    if (rot === 90) return [o.pad + (H0 - v), o.pad + u];
    if (rot === -90) return [o.pad + v, o.pad + (W0 - u)];
    return [o.pad + u, o.pad + v];
  };
  const r = Math.max(1, 0.06 * o.targetPx); // pen radius in px: legible strokes whatever the drawing's pen
  const stamp = (cx, cy) => {
    const xa = Math.max(0, Math.floor(cx - r)), xb = Math.min(width - 1, Math.ceil(cx + r));
    const ya = Math.max(0, Math.floor(cy - r)), yb = Math.min(height - 1, Math.ceil(cy + r));
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) gray[y * width + x] = 0;
  };
  for (const i of group.members) {
    const p = sheet.paths[i];
    const pts = p.pts.map(([x, y]) => toPx(x, y));
    const n = pts.length;
    const segs = n === 1 ? [[pts[0], pts[0]]] : pts.slice(1).map((q, j) => [pts[j], q]);
    if (p.closed && n > 2) segs.push([pts[n - 1], pts[0]]);
    for (const [a, b] of segs) {
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(L / (0.5 * r)));
      for (let s = 0; s <= steps; s++) stamp(a[0] + ((b[0] - a[0]) * s) / steps, a[1] + ((b[1] - a[1]) * s) / steps);
    }
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let j = 0; j < gray.length; j++) { const g = gray[j]; data[4 * j] = g; data[4 * j + 1] = g; data[4 * j + 2] = g; data[4 * j + 3] = 255; }
  // picture → sheet, for the line boxes the engine returns
  const toSheet = (px, py) => {
    let u, v;
    if (rot === 90) { u = py - o.pad; v = H0 - (px - o.pad); }
    else if (rot === -90) { u = W0 - (py - o.pad); v = px - o.pad; }
    else { u = px - o.pad; v = py - o.pad; }
    return [x0 + u / k, y1 - v / k];
  };
  return { width, height, data, toSheet, scale: k, rotate: rot };
}

// A line the engine read that can be a label: letters in it, not a row of strokes read as I, l, 1 and |.
export function plausibleLine(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  const letters = (t.match(/\p{L}/gu) || []).length;
  if (letters < 2) return false;
  if (/^[IiLl1|!/\\\-_.,:;'"`~^ ]+$/.test(t)) return false; // hatching and grids come back as rows of strokes
  const words = t.split(' ');
  // mostly letters and digits, few symbols
  const odd = (t.match(/[^\p{L}\p{N}\s.,&/()#'+\-:]/gu) || []).length;
  return odd <= Math.max(1, 0.15 * t.length) && words.some((w) => (w.match(/\p{L}/gu) || []).length >= 2);
}

// A line accepted as writing: confident, plausible, and short words only when very sure (symbols come back as two or
// three letters: "LJ", "AN", "he"); an abbreviation without a vowel needs even more ("SCR" yes, "LJ" no).
export function acceptLine(l, minConfidence = OCR.minConfidence) {
  if (!(l.confidence >= minConfidence) || !plausibleLine(l.text)) return false;
  const t = String(l.text).replace(/\s+/g, ' ').trim();
  const longest = Math.max(...t.split(' ').map((w) => (w.match(/\p{L}/gu) || []).length));
  // abbreviations written with a slash or an ampersand (W/C, A/S, R&D) are labels, not symbols
  if (longest <= 3) return /\p{L}[/&]\p{L}/u.test(t) ? l.confidence >= 80 : l.confidence >= 85 && (/[AEIOUYaeiouy]/.test(t) || l.confidence >= 92);
  return true;
}

/**
 * Read the writing drawn as line work on a sheet and add it as texts (id `o1`, `o2`, …, `ocr: { confidence }`). The
 * strokes it read are marked `p.ocrText = id` so the plan reader can leave them out of the line work. Groups are
 * stacked into pictures of up to `batch` rows (one engine call per picture, not per label).
 */
export async function ocrSheet(sheet, recognize, { onProgress, batch = 40, ...opts } = {}) {
  const o = { ...OCR, ...opts };
  const groups = glyphGroups(sheet, o);
  // with real text on the sheet, a group lying on a real text is that text drawn twice (a shadow or a bold copy)
  const real = sheet.texts.filter((t) => t.box);
  const covered = (b) => real.some((t) => t.box[0] <= b[2] && b[0] <= t.box[2] && t.box[1] <= b[3] && b[1] <= t.box[3]);
  const todo = groups.filter((g) => !covered(g.box)).sort((a, b) => b.members.length - a.members.length);
  const run = todo.slice(0, o.maxGroups);
  const stats = { candidates: groups.length, read: 0, lines: 0, dropped: 0, skipped: todo.length - run.length, calls: 0, ms: 0 };
  const t0 = Date.now();
  // one picture per group and reading direction (writing turned 90° is tried both ways)
  const items = [];
  for (const g of run) for (const rot of g.vertical ? [90, -90] : [0]) {
    const img = rasterGroup(sheet, g, { ...o, rotate: rot });
    if (img) items.push({ g, img, lines: [] });
  }
  // stack the pictures into rows of a few tall pictures; the white border of each keeps the rows apart
  const MAXW = 3000, MAXH = 5000;
  const packs = [];
  for (const it of items) {
    const p = packs[packs.length - 1];
    if (p && p.items.length < batch && p.h + it.img.height <= MAXH && it.img.width <= MAXW && p.w <= MAXW) { it.y = p.h; p.items.push(it); p.h += it.img.height; p.w = Math.max(p.w, it.img.width); }
    else { it.y = 0; packs.push({ items: [it], h: it.img.height, w: it.img.width }); }
  }
  let done = 0;
  for (const p of packs) {
    onProgress?.({ done, total: items.length });
    const data = new Uint8ClampedArray(p.w * p.h * 4).fill(255);
    for (const it of p.items) for (let y = 0; y < it.img.height; y++) data.set(it.img.data.subarray(y * it.img.width * 4, (y + 1) * it.img.width * 4), ((it.y + y) * p.w) * 4);
    const lines = (await recognize({ width: p.w, height: p.h, data })) || [];
    stats.calls++;
    for (const l of lines) {
      const cy = (l.bbox.y0 + l.bbox.y1) / 2;
      const it = p.items.find((x) => cy >= x.y && cy < x.y + x.img.height);
      if (it) it.lines.push({ ...l, bbox: { x0: l.bbox.x0, x1: l.bbox.x1, y0: l.bbox.y0 - it.y, y1: l.bbox.y1 - it.y } });
    }
    done += p.items.length;
  }
  // per group: the reading direction with the better result
  const byGroup = new Map();
  for (const it of items) {
    const good = it.lines.filter((l) => acceptLine(l, o.minConfidence));
    const score = good.reduce((s, l) => s + l.confidence * l.text.length, 0);
    const best = byGroup.get(it.g);
    if (!best || score > best.score) byGroup.set(it.g, { img: it.img, good, score, all: it.lines.length });
  }
  const found = [];
  for (const [g, best] of byGroup) {
    stats.read++;
    stats.dropped += best.all - best.good.length;
    for (const l of best.good) {
      const a = best.img.toSheet(l.bbox.x0, l.bbox.y0), b = best.img.toSheet(l.bbox.x1, l.bbox.y1);
      const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
      found.push({ text: l.text.replace(/\s+/g, ' ').trim(), box, conf: l.confidence, rot: best.img.rotate, groups: [g] });
    }
  }
  // words of one line read apart ("ER" and "Vent": the gap between words splits the strokes into two groups) are one
  // label: same reading direction, heights overlapping, a gap of at most about one glyph height
  found.sort((p, q) => p.box[0] - q.box[0]);
  for (let i = 0; i < found.length; i++) {
    const p = found[i];
    if (!p || p.rot !== 0) continue;
    for (let j = i + 1; j < found.length; j++) {
      const q = found[j];
      if (!q || q.rot !== 0) continue;
      const h = Math.min(p.box[3] - p.box[1], q.box[3] - q.box[1]);
      const overlap = Math.min(p.box[3], q.box[3]) - Math.max(p.box[1], q.box[1]);
      const gap = q.box[0] - p.box[2];
      if (overlap < 0.6 * h || gap < -0.2 * h || gap > 1.3 * h) continue;
      p.text = `${p.text} ${q.text}`; p.conf = Math.min(p.conf, q.conf); p.groups.push(...q.groups);
      p.box = [Math.min(p.box[0], q.box[0]), Math.min(p.box[1], q.box[1]), Math.max(p.box[2], q.box[2]), Math.max(p.box[3], q.box[3])];
      found[j] = null;
    }
  }
  for (const f of found.filter(Boolean)) {
    const id = `o${sheet.texts.length + 1}`;
    const vertical = f.rot !== 0, box = f.box;
    sheet.texts.push({ id, text: f.text, box, height: vertical ? box[2] - box[0] : box[3] - box[1], angle: f.rot,
      ocr: { confidence: Math.round(f.conf) }, layer: null, block: null });
    stats.lines++;
    for (const g of f.groups) for (const i of g.members) {
      const pb = boxOf(sheet.paths[i].pts);
      if (pb[0] >= box[0] - g.h && pb[2] <= box[2] + g.h && pb[1] >= box[1] - g.h && pb[3] <= box[3] + g.h) sheet.paths[i].ocrText = id;
    }
  }
  stats.ms = Date.now() - t0;
  onProgress?.({ done: items.length, total: items.length });
  return stats;
}

/** Whether a sheet looks like it has its writing drawn as line work: many glyph-like groups, few real texts. */
export function needsOcr(sheet) {
  const groups = glyphGroups(sheet);
  return { groups: groups.length, texts: sheet.texts.length, suggest: groups.length >= 20 && sheet.texts.length < 0.25 * groups.length };
}
