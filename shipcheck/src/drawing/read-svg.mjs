// SVG -> Sheet (CONTRACT.md section 1) without DOMParser, so it runs in a Web Worker and in Node: a small tolerant
// XML tokenizer, the SVG painting model reduced to what a line drawing needs (geometry, stroke / fill, dashes,
// widths, text), simple <style> sheets, and <use> of <symbol> / <defs>. y is flipped so the sheet is y up.

import { makeSheet, addText, finishSheet, PathBuilder, mul, apply, scaleOf, isSimilarity, transformArc, tessellateSweep, arcSegments, IDENTITY, estimateTextWidth } from './sheet.mjs';

const DEG = Math.PI / 180;
const MAX_USE_DEPTH = 8;

// ---------- XML ----------

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENTITIES[e] ?? m;
});

/**
 * Tolerant XML -> element tree { name, attrs, children } with text nodes { text }. Comments, processing
 * instructions and DOCTYPE are skipped; CDATA becomes text; unclosed elements are closed at the end; a stray end tag
 * closes up to its matching open element (or is ignored).
 */
export function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const n = src.length;
  const attrRe = /([^\s=/>]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  while (i < n) {
    const lt = src.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) {
      const t = src.slice(i, textEnd);
      if (t.trim()) stack[stack.length - 1].children.push({ text: decode(t) });
      else if (t.length) stack[stack.length - 1].children.push({ text: ' ', ws: true });
    }
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt + 9);
      stack[stack.length - 1].children.push({ text: src.slice(lt + 9, e < 0 ? n : e) });
      i = e < 0 ? n : e + 3; continue;
    }
    if (src[lt + 1] === '?') { const e = src.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src[lt + 1] === '!') { // DOCTYPE, possibly with an internal subset [...]
      let j = lt + 2, depth = 0;
      for (; j < n; j++) { const ch = src[j]; if (ch === '[') depth++; else if (ch === ']') depth--; else if (ch === '>' && depth <= 0) break; }
      i = j + 1; continue;
    }
    // Tag end: the first '>' outside quotes.
    let j = lt + 1, q = null;
    for (; j < n; j++) { const ch = src[j]; if (q) { if (ch === q) q = null; } else if (ch === '"' || ch === "'") q = ch; else if (ch === '>') break; }
    const body = src.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === '/') {
      const name = localName(body.slice(1).trim());
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const selfClose = body.endsWith('/');
    const m = /^([^\s/>]+)/.exec(body);
    if (!m) continue;
    const el = { name: localName(m[1]), attrs: {}, children: [] };
    attrRe.lastIndex = m[1].length;
    const attrText = selfClose ? body.slice(0, -1) : body;
    let a;
    while ((a = attrRe.exec(attrText))) el.attrs[a[1]] = decode(a[2] ?? a[3] ?? a[4] ?? '');
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root;
}
const localName = (s) => { const k = s.indexOf(':'); return k >= 0 && s.slice(0, k) === 'svg' ? s.slice(k + 1) : s; };

// ---------- values ----------

const NUM_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;
const numbers = (s) => (String(s ?? '').match(NUM_RE) || []).map(Number);
// Lengths in user units (CSS px). Percentages and em are taken as plain numbers (rare in drawings).
const UNIT_PX = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96 };
function length(v, d = 0) {
  if (v == null || v === '') return d;
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-z%]*)/i.exec(String(v));
  if (!m) return d;
  return Number(m[1]) * (UNIT_PX[m[2].toLowerCase()] ?? 1);
}

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', lime: '#00ff00', blue: '#0000ff',
  yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080',
  grey: '#808080', silver: '#c0c0c0', maroon: '#800000', navy: '#000080', olive: '#808000', purple: '#800080',
  teal: '#008080', orange: '#ffa500', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
};
const hex2 = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
/** CSS colour -> '#rrggbb', 'none', or null when unknown (a gradient or pattern reference counts as painted). */
function color(v, current) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return 'none';
  if (s === 'currentcolor') return color(current ?? '#000000');
  if (s.startsWith('url(')) return '#808080';
  if (s[0] === '#') {
    const h = s.slice(1);
    if (h.length === 3 || h.length === 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (h.length >= 6) return `#${h.slice(0, 6)}`;
    return null;
  }
  const m = /^rgba?\(([^)]*)\)/.exec(s);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((p) => (p.endsWith('%') ? (parseFloat(p) * 255) / 100 : parseFloat(p)));
    return `#${parts.map(hex2).join('')}`;
  }
  return NAMED[s] ?? null;
}

/** SVG transform list -> matrix [a, b, c, d, e, f]. */
export function parseTransform(s) {
  let m = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(String(s ?? '')))) {
    const v = numbers(t[2]);
    let n;
    switch (t[1]) {
      case 'matrix': n = v.length >= 6 ? v.slice(0, 6) : IDENTITY; break;
      case 'translate': n = [1, 0, 0, 1, v[0] || 0, v[1] || 0]; break;
      case 'scale': n = [v[0] ?? 1, 0, 0, v[1] ?? v[0] ?? 1, 0, 0]; break;
      case 'rotate': {
        const a = (v[0] || 0) * DEG, c = Math.cos(a), sn = Math.sin(a), cx = v[1] || 0, cy = v[2] || 0;
        n = [c, sn, -sn, c, cx - c * cx + sn * cy, cy - sn * cx - c * cy];
        break;
      }
      case 'skewX': n = [1, 0, Math.tan((v[0] || 0) * DEG), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan((v[0] || 0) * DEG), 0, 1, 0, 0]; break;
    }
    m = mul(m, n);
  }
  return m;
}

// ---------- styles ----------

const INHERITED = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'font-size', 'visibility', 'color', 'text-anchor'];
const STYLE_PROPS = new Set([...INHERITED, 'display']);

function parseDecls(s, into = {}) {
  for (const part of String(s).split(';')) {
    const k = part.indexOf(':');
    if (k < 0) continue;
    const name = part.slice(0, k).trim().toLowerCase(), value = part.slice(k + 1).replace(/!important/i, '').trim();
    if (STYLE_PROPS.has(name)) into[name] = value;
  }
  return into;
}

// <style> sheets: only simple selectors (tag, .class, #id, tag.class), which is what drawing exporters write.
function collectCss(root) {
  const rules = [];
  const walk = (el) => {
    if (el.name === 'style') {
      const css = el.children.map((c) => c.text || '').join('').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
        const decls = parseDecls(m[2]);
        for (const sel of m[1].split(',')) {
          const s = sel.trim();
          const mm = /^([a-zA-Z][\w-]*)?(?:\.([\w-]+))?(?:#([\w-]+))?$/.exec(s);
          if (!s || !mm) continue;
          rules.push({ tag: mm[1] || null, cls: mm[2] || null, id: mm[3] || null, spec: (mm[3] ? 100 : 0) + (mm[2] ? 10 : 0) + (mm[1] ? 1 : 0), decls });
        }
      }
    }
    for (const c of el.children || []) if (c.name) walk(c);
  };
  walk(root);
  return rules.map((r, order) => ({ ...r, order })).sort((a, b) => a.spec - b.spec || a.order - b.order);
}

// ---------- the reader ----------

const TOL = { px: 0.05, pt: 0.05, mm: 0.02, cm: 0.002, in: 0.001 };

/** readSvg(text, { file }) -> Sheet. */
export function readSvg(text, { file = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The file is empty.');
  const root = parseXml(text);
  const svg = findFirst(root, 'svg');
  if (!svg) throw new Error('No <svg> element found: this is not an SVG file.');

  // Units: width/height with a physical unit plus a viewBox give the size of a user unit.
  const vb = numbers(svg.attrs.viewBox);
  const wAttr = String(svg.attrs.width ?? ''), hAttr = String(svg.attrs.height ?? '');
  const wUnit = (/[a-z%]+\s*$/i.exec(wAttr)?.[0] || '').trim().toLowerCase();
  const PHYS = { mm: 'mm', cm: 'cm', in: 'in', pt: 'pt', pc: 'pt' };
  const unit = PHYS[wUnit] || 'px';
  const raw = (s) => parseFloat(s);
  let vx = 0, vy = 0, vw = NaN, vh = NaN;
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) [vx, vy, vw, vh] = vb;
  else if (raw(wAttr) > 0 && raw(hAttr) > 0) { vw = length(wAttr); vh = length(hAttr); }
  let kx = 1, ky = 1;
  if (raw(wAttr) > 0 && vw > 0) {
    const physW = wUnit === 'pc' ? raw(wAttr) * 12 : raw(wAttr);
    kx = PHYS[wUnit] ? physW / vw : length(wAttr) / vw;
    const physH = (/pc\s*$/i.test(hAttr) ? 12 : 1) * raw(hAttr);
    ky = raw(hAttr) > 0 && vh > 0 ? (PHYS[wUnit] ? physH / vh : length(hAttr) / vh) : kx;
  }
  // User space (y down) -> sheet (y up). Without a known height, y is just negated.
  const R = Number.isFinite(vh) ? [kx, 0, 0, -ky, -vx * kx, (vy + vh) * ky] : [kx, 0, 0, -ky, 0, 0];

  const sheet = makeSheet({ file, format: 'svg', unit, unitStated: unit !== 'px', paper: true });
  const r = {
    sheet, css: collectCss(root), ids: new Map(),
    b: new PathBuilder(sheet, { tol: TOL[unit] ?? 0.05, maxSeg: 16 }),
    images: 0, unsupported: new Map(), missingRefs: new Set(),
  };
  indexIds(root, r.ids);
  const style0 = { fill: '#000000', stroke: 'none', 'stroke-width': '1', 'stroke-dasharray': 'none', 'font-size': '16', visibility: 'visible', color: '#000000', 'text-anchor': 'start' };
  drawChildren(svg, R, style0, null, r, 0);
  if (r.images) sheet.warnings.push(`${r.images} embedded images were not read (only vector line work and text are).`);
  if (r.unsupported.size) sheet.warnings.push(`Not drawn: ${[...r.unsupported].map(([k, v]) => `<${k}> ×${v}`).join(', ')}.`);
  if (r.missingRefs.size) sheet.warnings.push(`<use> references to missing elements: ${[...r.missingRefs].slice(0, 10).join(', ')}.`);
  if (unit === 'px') sheet.warnings.push('The SVG does not state a physical size (width/height in mm, cm, in or pt): coordinates are in px.');
  return finishSheet(sheet);
}

function findFirst(el, name) {
  if (el.name === name) return el;
  for (const c of el.children || []) if (c.name) { const f = findFirst(c, name); if (f) return f; }
  return null;
}
function indexIds(el, ids) {
  if (el.attrs?.id) ids.set(el.attrs.id, el);
  for (const c of el.children || []) if (c.name) indexIds(c, ids);
}

// Computed style: inherited values < presentation attributes < <style> rules < style attribute.
function computeStyle(el, parent, r) {
  const s = { ...parent };
  delete s.display;
  for (const k of STYLE_PROPS) if (el.attrs[k] != null) s[k] = el.attrs[k];
  if (r.css.length) {
    const classes = String(el.attrs.class || '').split(/\s+/).filter(Boolean);
    for (const rule of r.css) {
      if (rule.tag && rule.tag !== el.name) continue;
      if (rule.cls && !classes.includes(rule.cls)) continue;
      if (rule.id && rule.id !== el.attrs.id) continue;
      Object.assign(s, rule.decls);
    }
  }
  if (el.attrs.style) parseDecls(el.attrs.style, s);
  for (const k of INHERITED) if (s[k] === 'inherit') s[k] = parent[k];
  return s;
}

const SKIP = new Set(['defs', 'symbol', 'clipPath', 'mask', 'pattern', 'marker', 'linearGradient', 'radialGradient', 'filter', 'style', 'title', 'desc', 'metadata', 'script', 'foreignObject']);

function drawChildren(el, m, style, layer, r, depth) {
  for (const c of el.children) if (c.name) drawElement(c, m, style, layer, r, depth);
}

function drawElement(el, parentM, parentStyle, layer, r, depth) {
  if (SKIP.has(el.name) || el.name.includes(':')) return; // other namespaces (sodipodi:namedview, …)
  const st = computeStyle(el, parentStyle, r);
  if (st.display === 'none') return;
  let m = el.attrs.transform ? mul(parentM, parseTransform(el.attrs.transform)) : parentM;
  switch (el.name) {
    case 'g': case 'a': case 'switch': {
      const label = el.attrs['inkscape:label'] || el.attrs.id;
      return drawChildren(el, m, st, el.name === 'g' && label ? label : layer, r, depth);
    }
    case 'svg': { // nested viewport: its x/y place it; its own viewBox scaling is not applied
      m = mul(m, [1, 0, 0, 1, length(el.attrs.x), length(el.attrs.y)]);
      return drawChildren(el, m, st, layer, r, depth);
    }
    case 'use': {
      const ref = String(el.attrs.href ?? el.attrs['xlink:href'] ?? '').replace(/^#/, '');
      const target = r.ids.get(ref);
      if (!target) { if (ref) r.missingRefs.add(ref); return; }
      if (depth >= MAX_USE_DEPTH) return;
      m = mul(m, [1, 0, 0, 1, length(el.attrs.x), length(el.attrs.y)]);
      if (target.name === 'symbol' || target.name === 'svg') return drawChildren(target, m, computeStyle(target, st, r), layer, r, depth + 1);
      return drawElement(target, m, st, layer, r, depth + 1);
    }
    case 'path': return drawPath(el.attrs.d, m, st, layer, r);
    case 'line': {
      const b = r.b, a = el.attrs;
      b.moveTo(...apply(m, length(a.x1), length(a.y1)));
      b.lineTo(...apply(m, length(a.x2), length(a.y2)));
      return paint(r, m, { ...st, fill: 'none' }, layer);
    }
    case 'polyline': case 'polygon': {
      const v = numbers(el.attrs.points);
      if (v.length < 4) return;
      r.b.moveTo(...apply(m, v[0], v[1]));
      for (let i = 2; i + 1 < v.length; i += 2) r.b.lineTo(...apply(m, v[i], v[i + 1]));
      if (el.name === 'polygon') r.b.closePath();
      return paint(r, m, st, layer);
    }
    case 'rect': {
      const a = el.attrs, x = length(a.x), y = length(a.y), w = length(a.width), h = length(a.height);
      if (!(w > 0 && h > 0)) return;
      let rx = length(a.rx, NaN), ry = length(a.ry, NaN);
      if (!Number.isFinite(rx)) rx = Number.isFinite(ry) ? ry : 0;
      if (!Number.isFinite(ry)) ry = rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (rx > 0 && ry > 0) {
        return drawPath(`M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`, m, st, layer, r);
      }
      r.b.quad(apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h));
      return paint(r, m, st, layer);
    }
    case 'circle': case 'ellipse': {
      const a = el.attrs, cx = length(a.cx), cy = length(a.cy);
      const rx = el.name === 'circle' ? length(a.r) : length(a.rx), ry = el.name === 'circle' ? rx : length(a.ry, rx);
      if (!(rx > 0 && ry > 0)) return;
      const n = arcSegments(360);
      const pts = [];
      for (let i = 0; i <= n; i++) { const t = (2 * Math.PI * i) / n; pts.push(apply(m, cx + rx * Math.cos(t), cy + ry * Math.sin(t))); }
      const arc = Math.abs(rx - ry) <= 1e-9 * rx ? transformArc({ c: [cx, cy], r: rx, a0: 0, a1: 360 }, m) : null;
      r.b.moveTo(pts[0][0], pts[0][1]);
      r.b.arcRun(pts, arc);
      r.b.closePath();
      return paint(r, m, st, layer);
    }
    case 'text': return drawText(el, m, st, layer, r);
    case 'image': r.images++; return;
    default:
      r.unsupported.set(el.name, (r.unsupported.get(el.name) || 0) + 1);
  }
}

function paint(r, m, st, layer) {
  const fill = color(st.fill, st.color), stroke = color(st.stroke, st.color);
  const doFill = fill !== 'none', doStroke = stroke !== 'none';
  if (st.visibility === 'hidden' || st.visibility === 'collapse' || (!doFill && !doStroke)) { r.b.discard(); return; }
  const dash = st['stroke-dasharray'] && st['stroke-dasharray'] !== 'none' && numbers(st['stroke-dasharray']).some((v) => v > 0);
  r.b.paint({
    width: doStroke ? length(st['stroke-width'], 1) * scaleOf(m) : 0,
    color: doStroke ? stroke : fill,
    dash: doStroke && !!dash, fill: doFill, stroke: doStroke, layer, block: null,
  });
}

// ---------- path data ----------

// Tokens of a path's d attribute: command letters and numbers; arc flags may be written without separators
// ("a10 10 0 01 20 0"), so they are read as single characters where the grammar expects a flag.
function* pathTokens(d) {
  const s = String(d ?? '');
  let i = 0;
  const n = s.length;
  const numRe = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
  let arc = false, argi = 0; // inside an arc command: arguments 4 and 5 of every 7 are one-character flags
  while (i < n) {
    const ch = s[i];
    if (ch === ' ' || ch === ',' || ch === '\n' || ch === '\t' || ch === '\r') { i++; continue; }
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) { i++; arc = ch === 'A' || ch === 'a'; argi = 0; yield ch; continue; }
    if (arc && (argi % 7 === 3 || argi % 7 === 4) && (ch === '0' || ch === '1')) { i++; argi++; yield Number(ch); continue; }
    numRe.lastIndex = i;
    const m = numRe.exec(s);
    if (!m) { i++; continue; } // junk character: skip it
    i = numRe.lastIndex;
    argi++;
    yield Number(m[0]);
  }
}

function drawPath(d, m, st, layer, r) {
  const b = r.b;
  const toks = [...pathTokens(d)];
  let k = 0, cmd = null;
  let x = 0, y = 0, sx = 0, sy = 0;       // current point, subpath start (user space)
  let lcx = null, lcy = null, lq = null;  // last cubic / quadratic control point for S / T
  const P = (px, py) => apply(m, px, py);
  const isNum = () => typeof toks[k] === 'number';
  const nx = () => (isNum() ? toks[k++] : 0);
  while (k < toks.length) {
    if (!isNum()) cmd = toks[k++];
    else if (!cmd) { k++; continue; }
    const rel = cmd === cmd.toLowerCase() && cmd !== 'z' ? 1 : 0;
    const C = cmd.toUpperCase();
    if (C !== 'Z' && !isNum()) continue; // a command without its numbers: read the next command
    switch (C) {
      case 'M': {
        x = nx() + (rel ? x : 0); y = nx() + (rel ? y : 0); sx = x; sy = y;
        b.moveTo(...P(x, y));
        cmd = rel ? 'l' : 'L'; lcx = lq = null; break;
      }
      case 'L': x = nx() + (rel ? x : 0); y = nx() + (rel ? y : 0); b.lineTo(...P(x, y)); lcx = lq = null; break;
      case 'H': x = nx() + (rel ? x : 0); b.lineTo(...P(x, y)); lcx = lq = null; break;
      case 'V': y = nx() + (rel ? y : 0); b.lineTo(...P(x, y)); lcx = lq = null; break;
      case 'C': case 'S': {
        let x1, y1;
        if (C === 'C') { x1 = nx() + (rel ? x : 0); y1 = nx() + (rel ? y : 0); }
        else if (lcx !== null) { x1 = 2 * x - lcx; y1 = 2 * y - lcy; } else { x1 = x; y1 = y; }
        const x2 = nx() + (rel ? x : 0), y2 = nx() + (rel ? y : 0), x3 = nx() + (rel ? x : 0), y3 = nx() + (rel ? y : 0);
        b.curveTo(...P(x1, y1), ...P(x2, y2), ...P(x3, y3));
        lcx = x2; lcy = y2; lq = null; x = x3; y = y3; break;
      }
      case 'Q': case 'T': {
        let qx, qy;
        if (C === 'Q') { qx = nx() + (rel ? x : 0); qy = nx() + (rel ? y : 0); }
        else if (lq) { qx = 2 * x - lq[0]; qy = 2 * y - lq[1]; } else { qx = x; qy = y; }
        const x3 = nx() + (rel ? x : 0), y3 = nx() + (rel ? y : 0);
        // Quadratic -> cubic: control points at 2/3 towards the quadratic control point.
        b.curveTo(...P(x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y)), ...P(x3 + (2 / 3) * (qx - x3), y3 + (2 / 3) * (qy - y3)), ...P(x3, y3));
        lq = [qx, qy]; lcx = null; x = x3; y = y3; break;
      }
      case 'A': {
        const rx = Math.abs(nx()), ry = Math.abs(nx()), phi = nx(), fa = nx(), fs = nx();
        const x2 = nx() + (rel ? x : 0), y2 = nx() + (rel ? y : 0);
        svgArc(b, m, x, y, rx, ry, phi, fa, fs, x2, y2);
        x = x2; y = y2; lcx = lq = null; break;
      }
      case 'Z': b.closePath(); x = sx; y = sy; lcx = lq = null; cmd = null; break;
      default: k++;
    }
  }
  paint(r, m, st, layer);
}

/**
 * SVG elliptical arc (endpoint form, SVG 1.1 appendix F.6) -> points through the builder. A circular arc under a
 * similarity transform keeps its circle as `arc`, so door swings drawn with `A` are recognised directly.
 */
function svgArc(b, m, x1, y1, rx, ry, phiDeg, fa, fs, x2, y2) {
  if ((x1 === x2 && y1 === y2)) return;
  if (!(rx > 0 && ry > 0)) { b.lineTo(...apply(m, x2, y2)); return; }
  const phi = phiDeg * DEG, cp = Math.cos(phi), sp = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) { const s = Math.sqrt(lam); rx *= s; ry *= s; }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = (fa !== fs ? 1 : -1) * Math.sqrt(Math.max(0, num / den));
  const cxp = (coef * rx * y1p) / ry, cyp = (-coef * ry * x1p) / rx;
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!fs && dt > 0) dt -= 2 * Math.PI; else if (fs && dt < 0) dt += 2 * Math.PI;
  const circular = Math.abs(rx - ry) <= 1e-9 * rx;
  let pts;
  if (circular) pts = tessellateSweep([cx, cy], rx, (t1 + phi) / DEG, dt / DEG);
  else {
    const n = arcSegments(dt / DEG);
    pts = [];
    for (let i = 0; i <= n; i++) {
      const t = t1 + (dt * i) / n, ct = Math.cos(t), st = Math.sin(t);
      pts.push([cx + rx * cp * ct - ry * sp * st, cy + rx * sp * ct + ry * cp * st]);
    }
  }
  pts[0] = [x1, y1]; pts[pts.length - 1] = [x2, y2]; // exact end points
  const tp = pts.map((p) => apply(m, p[0], p[1]));
  let arc = null;
  if (circular && isSimilarity(m)) {
    const s = (t1 + phi) / DEG, e = s + dt / DEG;
    const ccw = dt > 0 ? { a0: s, a1: e } : { a0: e, a1: s };
    arc = Math.abs(dt) >= 2 * Math.PI - 1e-9 ? { c: [cx, cy], r: rx, a0: 0, a1: 360 } : { c: [cx, cy], r: rx, a0: ((ccw.a0 % 360) + 360) % 360, a1: ((ccw.a1 % 360) + 360) % 360 };
    arc = transformArc(arc, m);
  }
  b.arcRun(tp, arc);
}

// ---------- text ----------

// <text> with <tspan> children: every tspan with its own x or y starts a new text on the sheet; other runs append.
function drawText(el, m, st, layer, r) {
  const runs = [];
  let cur = null;
  let px = length(el.attrs.x), py = length(el.attrs.y); // a list of x values: the first one places the text
  const start = (x, y, style, tm) => { cur = { x, y, style, m: tm, text: '' }; runs.push(cur); };
  start(px, py, st, m);
  const visit = (node, style, tm) => {
    for (const c of node.children) {
      if (!c.name) { cur.text += c.ws ? ' ' : c.text; continue; }
      if (c.name !== 'tspan' && c.name !== 'textPath') continue;
      const cs = computeStyle(c, style, r);
      if (cs.display === 'none') continue;
      const ctm = c.attrs.transform ? mul(tm, parseTransform(c.attrs.transform)) : tm;
      const hasX = c.attrs.x != null, hasY = c.attrs.y != null;
      const ddx = length(c.attrs.dx), ddy = length(c.attrs.dy);
      if (hasX || hasY || ddy) {
        px = hasX ? length(c.attrs.x) : px + ddx;
        py = (hasY ? length(c.attrs.y) : py) + ddy;
        start(px, py, cs, ctm);
      }
      visit(c, cs, ctm);
    }
  };
  visit(el, st, m);
  for (const run of runs) {
    const str = run.text.replace(/\s+/g, ' ').trim();
    if (!str || run.style.visibility === 'hidden') continue;
    const fs = length(run.style['font-size'], 16);
    const tm = run.m;
    const [x, y] = apply(tm, run.x, run.y);
    const dirx = tm[0], diry = tm[1];               // x axis of the text after the transform
    const upx = -tm[2], upy = -tm[3];                // SVG "up" is −y
    const h = fs * Math.hypot(upx, upy), sxl = Math.hypot(dirx, diry);
    const w = estimateTextWidth(str, fs) * sxl;
    const angle = ((Math.atan2(diry, dirx) / DEG) + 360) % 360;
    const anchor = run.style['text-anchor'];
    const shift = anchor === 'middle' ? w / 2 : anchor === 'end' ? w : 0;
    const ux = dirx / (sxl || 1), uy = diry / (sxl || 1);
    addText(r.sheet, { text: str, at: [x - ux * shift, y - uy * shift], height: h, angle, width: w, layer });
  }
}
