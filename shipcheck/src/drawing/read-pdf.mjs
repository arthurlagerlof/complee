// PDF -> one Sheet per page (CONTRACT.md section 1), from the page's vector line work and its text layer.
// The pdf.js module is passed in (as ifc-convert.mjs takes web-ifc), so this file stays free of Node and DOM APIs:
//   Node:    readPdf(await import('pdfjs-dist/legacy/build/pdf.mjs'), bytes, { file })
//   browser: import * as pdfjs from '/node_modules/pdfjs-dist/build/pdf.mjs' (the worker is set below).
// Written against pdfjs-dist 4.10.38, whose operator list carries constructPath as [ops, flatCoords, minMax] and
// keeps the painting operator (stroke, fill, …) as the next, separate operation.
//
// Sheet coordinates are PDF points, y up, with the page rotation applied, so the sheet looks as printed:
// (0, 0) is the lower left corner of the page as displayed.

import { makeSheet, addText, finishSheet, PathBuilder, mul } from './sheet.mjs';

const BROWSER_BASE = '/node_modules/pdfjs-dist/';
// Operator codes of pdf.js 4.x (pdfjs.OPS). Read from the module when it is given, these are the fallback.
const OPS_FALLBACK = {
  setLineWidth: 2, setDash: 6, setGState: 9, save: 10, restore: 11, transform: 12,
  moveTo: 13, lineTo: 14, curveTo: 15, curveTo2: 16, curveTo3: 17, closePath: 18, rectangle: 19,
  stroke: 20, closeStroke: 21, fill: 22, eoFill: 23, fillStroke: 24, eoFillStroke: 25, closeFillStroke: 26,
  closeEOFillStroke: 27, endPath: 28, setStrokeGray: 56, setFillGray: 57, setStrokeRGBColor: 58, setFillRGBColor: 59,
  setStrokeCMYKColor: 60, setFillCMYKColor: 61, paintXObject: 66, beginMarkedContent: 69, beginMarkedContentProps: 70,
  endMarkedContent: 71, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75, beginGroup: 76, endGroup: 77,
  beginAnnotation: 80, endAnnotation: 81, paintImageMaskXObject: 83, paintImageMaskXObjectGroup: 84,
  paintImageXObject: 85, paintInlineImageXObject: 86, paintInlineImageXObjectGroup: 87, paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89, paintSolidColorImageMask: 90, constructPath: 91, setStrokeTransparent: 92,
  setFillTransparent: 93,
};

const inBrowser = () => typeof globalThis.document !== 'undefined' || typeof globalThis.WorkerGlobalScope !== 'undefined';
const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
const rgb = (a) => `#${hex2(a[0])}${hex2(a[1])}${hex2(a[2])}`;

/**
 * readPdf(pdfjs, bytes, { file, pages, onProgress, standardFontDataUrl }) -> Promise<Sheet[]>
 * pages: optional list of 1-based page numbers (default: all). onProgress({ page, pages, done }) after each page.
 * standardFontDataUrl: where pdf.js finds its standard fonts (default in the browser: /node_modules/pdfjs-dist/…;
 * in Node pass the folder path with a trailing slash, or leave it out: text positions do not depend on it).
 */
export async function readPdf(pdfjs, bytes, { file = null, pages = null, onProgress = null, standardFontDataUrl } = {}) {
  const browser = inBrowser();
  if (browser && pdfjs.GlobalWorkerOptions && !pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = `${BROWSER_BASE}build/pdf.worker.mjs`;
  const params = {
    // A copy: pdf.js transfers (detaches) the buffer it is given to its worker; the caller keeps its bytes.
    data: bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes),
    isEvalSupported: false, // the site's Content-Security-Policy forbids eval
    verbosity: pdfjs.VerbosityLevel ? pdfjs.VerbosityLevel.ERRORS : 0,
    standardFontDataUrl: standardFontDataUrl ?? (browser ? `${BROWSER_BASE}standard_fonts/` : undefined),
  };
  const doc = await pdfjs.getDocument(params).promise;
  try {
    const ops = { ...OPS_FALLBACK, ...(pdfjs.OPS || {}) };
    let oc = null;
    try { oc = await doc.getOptionalContentConfig(); } catch { oc = null; }
    const list = (pages && pages.length ? pages : Array.from({ length: doc.numPages }, (_, i) => i + 1))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= doc.numPages);
    const sheets = [];
    for (const n of list) {
      let sheet;
      try {
        const page = await doc.getPage(n);
        sheet = await readPage(page, ops, oc, { file, page: n, pages: doc.numPages });
        page.cleanup();
      } catch (e) {
        sheet = makeSheet({ file, format: 'pdf', page: n, pages: doc.numPages, unit: 'pt', unitStated: true, paper: true });
        sheet.warnings.push(`Page ${n} could not be read: ${e?.message || e}`);
      }
      sheets.push(sheet);
      onProgress?.({ page: n, pages: doc.numPages, done: sheets.length, of: list.length });
    }
    return sheets;
  } finally {
    await doc.destroy();
  }
}

async function readPage(page, OPS, oc, src) {
  const viewport = page.getViewport({ scale: 1 });
  // viewport.transform maps PDF user space to a y-down device space with the page rotation applied; flipping y
  // back gives points on the page as displayed, y up.
  const M0 = mul([1, 0, 0, -1, 0, viewport.height], viewport.transform);
  const sheet = makeSheet({ file: src.file, format: 'pdf', page: src.page, pages: src.pages, unit: 'pt', unitStated: true, paper: true });
  sheet.paperSize = [viewport.width, viewport.height];
  const [opList, textContent] = await Promise.all([page.getOperatorList(), page.getTextContent()]);
  const stats = walkOperators(opList, OPS, oc, M0, sheet);
  readText(textContent, M0, sheet);

  const area = viewport.width * viewport.height;
  const w = sheet.warnings;
  if (stats.images) {
    // A scan: images cover most of the page and there is (almost) no line work. CAD PDFs that paint solid fills as
    // thin image strips have images too, but their line work dominates.
    if (stats.imageArea >= 0.5 * area && stats.segments < 1000) w.push('This page is a scanned image: no vector line work to read.');
    else w.push(`${stats.images} images on the page were not read (only vector line work and text are).`);
  }
  if (stats.hidden) w.push(`${stats.hidden} paths on hidden layers (optional content switched off) were skipped.`);
  if (!sheet.texts.length && stats.segments > 1000) w.push('No text layer on this page: the lettering is drawn as line work, so labels and titles cannot be read as text.');
  if (!stats.segments && !stats.images && !sheet.texts.length) w.push('This page is empty.');
  return finishSheet(sheet);
}

// ---------- operator walk ----------

function walkOperators(opList, OPS, oc, M0, sheet) {
  const { fnArray, argsArray } = opList;
  const b = new PathBuilder(sheet, { tol: 0.05, maxSeg: 16 });
  // Graphics state. ctm includes M0, so every point lands in sheet coordinates directly.
  let st = { ctm: M0, lw: 1, dash: false, stroke: '#000000', fill: '#000000' };
  const stack = [];
  const marked = []; // optional content: { visible, name } per marked-content level
  let hiddenDepth = 0;
  const stats = { images: 0, imageArea: 0, hidden: 0, segments: 0 };
  const layerName = () => { for (let i = marked.length - 1; i >= 0; i--) if (marked[i].name) return marked[i].name; return null; };
  // The state is changed in place and copied on save: CAD PDFs set a transform per line, but save far less often.
  const push = () => stack.push({ ...st });
  const pop = () => { if (stack.length) st = stack.pop(); };
  const set = (k, v) => { st[k] = v; };
  const paint = (fill, stroke) => {
    if (hiddenDepth) { stats.hidden += b.subs.length + (b.cur ? 1 : 0); b.discard(); return; }
    const m = st.ctm;
    const scale = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
    b.paint({
      width: stroke ? st.lw * scale : 0,
      color: stroke ? st.stroke : st.fill,
      dash: stroke && st.dash, fill, stroke, layer: layerName(), block: null,
    });
  };
  const image = (count = 1) => {
    const m = st.ctm;
    stats.images += count;
    stats.imageArea += count * Math.abs(m[0] * m[3] - m[1] * m[2]); // images fill the unit square of their CTM
  };

  for (let i = 0, n = fnArray.length; i < n; i++) {
    const fn = fnArray[i], args = argsArray[i];
    switch (fn) {
      case OPS.constructPath: buildPath(b, args, st.ctm, OPS); break;
      case OPS.stroke: paint(false, true); break;
      case OPS.closeStroke: b.closePath(); paint(false, true); break;
      case OPS.fill: case OPS.eoFill: paint(true, false); break;
      case OPS.fillStroke: case OPS.eoFillStroke: paint(true, true); break;
      case OPS.closeFillStroke: case OPS.closeEOFillStroke: b.closePath(); paint(true, true); break;
      case OPS.endPath: b.discard(); break; // clipping paths and paths that are not painted
      case OPS.save: push(); break;
      case OPS.restore: pop(); break;
      case OPS.transform: set('ctm', mul(st.ctm, args)); break;
      case OPS.setLineWidth: set('lw', args[0]); break;
      case OPS.setDash: set('dash', isDashed(args[0])); break;
      case OPS.setGState:
        for (const [k, v] of args[0] || []) {
          if (k === 'LW') set('lw', v);
          else if (k === 'D') set('dash', isDashed(v?.[0]));
        }
        break;
      case OPS.setStrokeRGBColor: set('stroke', rgb(args)); break;
      case OPS.setFillRGBColor: set('fill', rgb(args)); break;
      // pdf.js converts these to RGB in the worker; kept for other builds.
      case OPS.setStrokeGray: set('stroke', rgb([args[0] * 255, args[0] * 255, args[0] * 255])); break;
      case OPS.setFillGray: set('fill', rgb([args[0] * 255, args[0] * 255, args[0] * 255])); break;
      case OPS.setStrokeCMYKColor: set('stroke', cmyk(args)); break;
      case OPS.setFillCMYKColor: set('fill', cmyk(args)); break;
      case OPS.setStrokeTransparent: set('stroke', null); break;
      case OPS.setFillTransparent: set('fill', null); break;
      case OPS.paintFormXObjectBegin: push(); if (args?.[0]) set('ctm', mul(st.ctm, args[0])); break;
      case OPS.paintFormXObjectEnd: pop(); break;
      case OPS.beginGroup: push(); break; // the group's matrix is applied by the paintFormXObjectBegin that follows
      case OPS.endGroup: pop(); break;
      case OPS.beginAnnotation: push(); set('ctm', mul(M0, mul(args[2] || [1, 0, 0, 1, 0, 0], args[3] || [1, 0, 0, 1, 0, 0]))); break;
      case OPS.endAnnotation: pop(); break;
      case OPS.beginMarkedContentProps: {
        let entry = { visible: true, name: null };
        if (args[0] === 'OC' && args[1] && oc) {
          let visible = true;
          try { visible = oc.isVisible(args[1]); } catch { visible = true; }
          entry = { visible, name: args[1].type === 'OCG' ? oc.getGroup?.(args[1].id)?.name ?? null : null };
        }
        marked.push(entry);
        if (!entry.visible) hiddenDepth++;
        break;
      }
      case OPS.beginMarkedContent: marked.push({ visible: true, name: null }); break;
      case OPS.endMarkedContent: { const e = marked.pop(); if (e && !e.visible) hiddenDepth--; break; }
      case OPS.paintImageXObject: case OPS.paintInlineImageXObject: case OPS.paintImageMaskXObject:
      case OPS.paintSolidColorImageMask: image(); break;
      case OPS.paintImageXObjectRepeat: case OPS.paintImageMaskXObjectRepeat:
        image(Math.max(1, ((fn === OPS.paintImageXObjectRepeat ? args[3] : args[4])?.length || 2) / 2)); break;
      case OPS.paintInlineImageXObjectGroup: case OPS.paintImageMaskXObjectGroup:
        image(Math.max(1, (fn === OPS.paintImageMaskXObjectGroup ? args[0]?.length : args[1]?.length) || 1)); break;
      default: break;
    }
  }
  stats.segments = b.segments;
  return stats;
}

const isDashed = (arr) => !!arr && arr.length > 0 && Array.prototype.some.call(arr, (v) => v > 0);
function cmyk(a) {
  const k = a[3];
  return rgb([255 * (1 - a[0]) * (1 - k), 255 * (1 - a[1]) * (1 - k), 255 * (1 - a[2]) * (1 - k)]);
}

// One constructPath operation: pdf.js 4.x packs [ops, flatCoords, minMax]. Points are transformed by the CTM here
// (Béziers are affine-invariant, so transforming control points is exact).
function buildPath(b, args, m, OPS) {
  const ops = args[0], c = args[1];
  const a = m[0], bb = m[1], cc = m[2], d = m[3], e = m[4], f = m[5];
  let k = 0, cx = 0, cy = 0; // current point, sheet coordinates
  for (let i = 0, n = ops.length; i < n; i++) {
    switch (ops[i]) {
      case OPS.moveTo: { const x = c[k++], y = c[k++]; cx = a * x + cc * y + e; cy = bb * x + d * y + f; b.moveTo(cx, cy); break; }
      case OPS.lineTo: { const x = c[k++], y = c[k++]; cx = a * x + cc * y + e; cy = bb * x + d * y + f; b.lineTo(cx, cy); break; }
      case OPS.curveTo: {
        const x1 = c[k++], y1 = c[k++], x2 = c[k++], y2 = c[k++], x3 = c[k++], y3 = c[k++];
        const X3 = a * x3 + cc * y3 + e, Y3 = bb * x3 + d * y3 + f;
        b.curveTo(a * x1 + cc * y1 + e, bb * x1 + d * y1 + f, a * x2 + cc * y2 + e, bb * x2 + d * y2 + f, X3, Y3);
        cx = X3; cy = Y3; break;
      }
      case OPS.curveTo2: { // `v`: the first control point is the current point
        const x2 = c[k++], y2 = c[k++], x3 = c[k++], y3 = c[k++];
        const X3 = a * x3 + cc * y3 + e, Y3 = bb * x3 + d * y3 + f;
        b.curveTo(cx, cy, a * x2 + cc * y2 + e, bb * x2 + d * y2 + f, X3, Y3);
        cx = X3; cy = Y3; break;
      }
      case OPS.curveTo3: { // `y`: the second control point is the end point
        const x1 = c[k++], y1 = c[k++], x3 = c[k++], y3 = c[k++];
        const X3 = a * x3 + cc * y3 + e, Y3 = bb * x3 + d * y3 + f;
        b.curveTo(a * x1 + cc * y1 + e, bb * x1 + d * y1 + f, X3, Y3, X3, Y3);
        cx = X3; cy = Y3; break;
      }
      case OPS.closePath: {
        b.closePath();
        const s = b.cur?.pts[0];
        if (s) { cx = s[0]; cy = s[1]; }
        break;
      }
      case OPS.rectangle: {
        const x = c[k++], y = c[k++], w = c[k++], h = c[k++];
        const P = (u, v) => [a * u + cc * v + e, bb * u + d * v + f];
        b.quad(P(x, y), P(x + w, y), P(x + w, y + h), P(x, y + h));
        [cx, cy] = P(x, y);
        break;
      }
      default: break;
    }
  }
}

// ---------- text ----------

const SUPER = { 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };

/**
 * Text items -> Sheet texts. pdf.js gives runs of glyphs; a word or a line is often split into several runs, so runs
 * on the same baseline whose gap is under 0.3 × height are merged ("MAIN" + "DECK" -> "MAIN DECK"), and a small
 * raised run of digits right after a run becomes superscript ("m" + "2" -> "m²").
 */
function readText(textContent, M0, sheet) {
  const open = []; // recent texts that later runs may join
  const done = [];
  const flush = (t) => done.push(t);
  for (const item of textContent.items) {
    const str = item.str;
    if (typeof str !== 'string' || !str.length) continue;
    const tr = item.transform;
    const h = Math.hypot(tr[2], tr[3]) || item.height || 0;
    if (!(h > 0)) continue;
    // Direction and position in sheet space (M0 is a rotation + translation: lengths are kept).
    const dx0 = M0[0] * tr[0] + M0[2] * tr[1], dy0 = M0[1] * tr[0] + M0[3] * tr[1];
    const len = Math.hypot(dx0, dy0) || 1;
    const dir = [dx0 / len, dy0 / len];
    const at = [M0[0] * tr[4] + M0[2] * tr[5] + M0[4], M0[1] * tr[4] + M0[3] * tr[5] + M0[5]];
    // Whitespace-only items are skipped: pdf.js inserts " " items whose width spans the whole gap to the next run
    // on the line (150 pt between two room labels). Taking them in made far-apart labels look adjacent and made boxes
    // far wider than their characters. Word spaces come back from the measured gap between real glyph runs.
    if (!str.trim()) continue;
    const width = plausibleWidth(item.width, str, h);
    let merged = false;
    for (let j = open.length - 1; j >= 0 && !merged; j--) merged = tryMerge(open[j], str, at, dir, h, width);
    if (merged) continue;
    open.push({ text: str, at, dir, height: h, width });
    if (open.length > 8) flush(open.shift());
  }
  for (const t of open) flush(t);
  for (const t of done) {
    const text = t.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    addText(sheet, { text, at: t.at, height: t.height, angle: ((Math.atan2(t.dir[1], t.dir[0]) * 180) / Math.PI + 360) % 360, width: t.width, layer: null });
  }
}

/**
 * The advance width of a run in sheet units. pdf.js measures it from the font's widths; when that is missing (0) or
 * implausible for the characters (wider than 1.5 em or narrower than 0.15 em per character on average, e.g. a font
 * without /Widths or a run padded with spacing), it is estimated from the character count (0.6 em per character).
 */
export function plausibleWidth(width, str, height) {
  const n = str.replace(/\s+$/, '').length || 1;
  if (width > 0.15 * height * n && width < 1.5 * height * n) return width;
  return 0.6 * height * n;
}

// Join run `str` onto text `t` when it continues t's line: same direction and baseline, similar size, and the gap
// from the end of t's last glyph to the start of the run under 0.3 × height (a word space is ≈ 0.28 em).
function tryMerge(t, str, at, dir, h, width) {
  if (Math.abs(t.dir[0] * dir[1] - t.dir[1] * dir[0]) > 0.02 || t.dir[0] * dir[0] + t.dir[1] * dir[1] < 0) return false;
  const rx = at[0] - t.at[0], ry = at[1] - t.at[1];
  const along = rx * t.dir[0] + ry * t.dir[1];   // distance along t's baseline
  const across = -rx * t.dir[1] + ry * t.dir[0]; // distance above t's baseline
  const gap = along - t.width;
  const H = t.height;
  if (gap < -0.3 * H || gap >= 0.3 * H) return false;
  const ratio = h / H;
  if (Math.abs(across) < 0.2 * H && ratio > 0.7 && ratio < 1.43) {
    const space = gap > 0.15 * H && !/\s$/.test(t.text) && !/^\s/.test(str) ? ' ' : '';
    t.text += space + str;
    t.width = Math.max(t.width, along + width);
    return true;
  }
  // Superscript digits: smaller, raised, right after the run (m², m³).
  if (/^\d+$/.test(str) && ratio >= 0.4 && ratio <= 0.85 && across > 0.15 * H && across < 0.8 * H && gap < 0.2 * H) {
    t.text += str.replace(/\d/g, (ch) => SUPER[ch]);
    t.width = Math.max(t.width, along + width);
    return true;
  }
  return false;
}
