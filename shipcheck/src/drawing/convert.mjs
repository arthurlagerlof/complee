// Drawing → 3D, the whole chain: file bytes → Sheet[] (readers) and Sheet → { model, geometry, recon, views, report }
// (views → interpret → mesh). Pure ES module without DOM or Node APIs: it runs in the browser's main thread (PDF,
// because pdf.js brings its own worker), in public/drawing-worker.js and in Node tests.
//
// The stage modules are imported lazily, for two reasons: a reader is loaded only for the format at hand (the worker
// does not parse pdf.js code for a DXF), and the format check below works on its own, so a wrong file gets its clear
// message even before the converter's other modules are loaded. Tests inject stub modules through `readers` /
// `modules`.

/** Conversion stages in order, with the labels the UI shows. */
export const STAGES = ['views', 'scale', 'decks', 'rooms', 'doors', 'hull', 'mesh'];
export const STAGE_LABEL = {
  views: 'Finding views', scale: 'Scale', decks: 'Deck levels', rooms: 'Walls and rooms',
  doors: 'Doors and stairs', hull: 'Hull', mesh: '3D geometry',
};
// The stages that interpret.mjs covers in one call; it may report them itself (4th argument { onProgress }).
const INTERPRET_STAGES = ['scale', 'decks', 'rooms', 'doors', 'hull'];

const MAX_BYTES = 300_000_000;
const now = () => (globalThis.performance?.now ? performance.now() : Date.now());
const ascii = (bytes, from, to) => {
  let s = '';
  for (let i = from; i < Math.min(to, bytes.length); i++) s += String.fromCharCode(bytes[i]);
  return s;
};
const ext = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] ?? '').toLowerCase();
const fail = (message, code) => Object.assign(new Error(message), { code });

/**
 * What kind of file this is, from its first bytes (the extension only when the content says nothing). Content wins
 * because drawings are often renamed or exported with a wrong extension.
 * @returns {'pdf'|'dxf'|'dxf-binary'|'svg'|'xml'|'dwg'|'raster'|'unknown'}
 */
export function detectFormat(name, bytes) {
  const b = toBytes(bytes);
  const head = ascii(b, 0, 4096);
  if (/^AC10\d\d/.test(head)) return 'dwg';
  if (b[0] === 0x89 && head.startsWith('\x89PNG')) return 'raster';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'raster'; // JPEG
  if (head.startsWith('II*\0') || head.startsWith('MM\0*')) return 'raster'; // TIFF
  if (head.startsWith('GIF8') || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP')) return 'raster';
  if (head.startsWith('BM') && /\.bmp$/i.test(name)) return 'raster'; // "BM" alone is too common a start of text
  // PDF: the header may follow a little junk (the PDF spec allows it within the first 1024 bytes).
  if (head.slice(0, 1024).includes('%PDF-')) return 'pdf';
  if (head.startsWith('AutoCAD Binary DXF')) return 'dxf-binary';
  // ASCII DXF: group code 0 / SECTION, optionally after 999 comment lines; whitespace around codes is allowed.
  const text = head.replace(/^﻿/, '');
  if (/^\s*(999\r?\n[^\n]*\r?\n\s*)*0\s*\r?\n\s*SECTION\s*\r?\n/.test(text)) return 'dxf';
  const trimmed = text.replace(/^\s+/, '');
  if (/^<svg[\s>]/i.test(trimmed)) return 'svg';
  if (/^<(\?xml|!DOCTYPE|!--)/i.test(trimmed)) return /<svg[\s>]/i.test(text) ? 'svg' : 'xml';
  // No signature: trust the extension for the text formats (a DXF without the usual first lines still parses).
  const e = ext(name);
  if (e === 'dxf') return 'dxf';
  if (e === 'svg') return 'svg';
  if (e === 'dwg') return 'dwg';
  if (['png', 'jpg', 'jpeg', 'tif', 'tiff', 'gif', 'bmp', 'webp'].includes(e)) return 'raster';
  return 'unknown';
}

/** The plain message for a file the converter cannot read, or null when it can. */
export function unsupportedMessage(format, name) {
  switch (format) {
    case 'dwg':
      return `${name} is an AutoCAD DWG file (AutoCAD's binary format), which cannot be read here. Save it as DXF in AutoCAD (SAVEAS, file type "AutoCAD DXF") or plot it to PDF, and give that file.`;
    case 'dxf-binary':
      return `${name} is a binary DXF. Save it as an ASCII DXF in AutoCAD (SAVEAS → DXF, without the "binary" option) and give that file.`;
    case 'raster':
      return `${name} is a raster image (a scan or picture of the drawing, made of pixels). The converter needs vector line work: lines, arcs and text as drawing objects, from which walls, doors and decks are measured. A picture has none of that. Export the drawing as PDF or DXF from the CAD program it was drawn in and give that file.`;
    case 'xml':
      return `${name} is an XML file but not an SVG drawing. Give the general arrangement as PDF, DXF or SVG.`;
    case 'unknown':
      return `${name} is not a drawing the converter can read. Give the general arrangement (profile and deck plans) as PDF, DXF or SVG, exported from the CAD program.`;
    default:
      return null;
  }
}

function toBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (typeof bytes === 'string') return new TextEncoder().encode(bytes);
  throw fail('No file content was given.', 'empty');
}

// DXF before AutoCAD 2007 and some SVG exports are in the Windows code page, not UTF-8: decode strictly first and
// fall back, so "Ø" or "°" in a room label stays readable instead of becoming "�".
function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('windows-1252').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

async function importStage(file, what) {
  try {
    return await import(file);
  } catch (e) {
    throw fail(`The drawing converter is incomplete: ${what} (${file.replace('./', 'src/drawing/')}) could not be loaded. ${e.message}`, 'module');
  }
}

/**
 * Reads a drawing file into sheets (one per PDF page; one for DXF and SVG).
 * @param {{ name: string, bytes: Uint8Array|ArrayBuffer }} file
 * @param {{ pdfjs?: object, onProgress?: Function, pages?: number[], readers?: { readDxf?, readPdf?, readSvg? } }} opts
 * @returns {Promise<object[]>} Sheet[]
 */
export async function readDrawingFile({ name, bytes }, { pdfjs, onProgress, pages, readers = {} } = {}) {
  const b = toBytes(bytes);
  if (!b.length) throw fail(`${name} is empty.`, 'empty');
  if (b.length > MAX_BYTES) throw fail(`${name} is larger than ${MAX_BYTES / 1e6} MB. Export only the general arrangement sheet.`, 'size');
  const format = detectFormat(name, b);
  const message = unsupportedMessage(format, name);
  if (message) throw fail(message, format);
  let sheets;
  if (format === 'pdf') {
    if (!pdfjs) throw fail('Reading a PDF needs pdf.js, which runs in the page, not here.', 'pdfjs');
    const readPdf = readers.readPdf ?? (await importStage('./read-pdf.mjs', 'the PDF reader')).readPdf;
    sheets = await readPdf(pdfjs, b, { file: name, pages, onProgress });
  } else if (format === 'dxf') {
    const readDxf = readers.readDxf ?? (await importStage('./read-dxf.mjs', 'the DXF reader')).readDxf;
    onProgress?.(0);
    sheets = [readDxf(decodeText(b), { file: name })];
    onProgress?.(1);
  } else {
    const readSvg = readers.readSvg ?? (await importStage('./read-svg.mjs', 'the SVG reader')).readSvg;
    onProgress?.(0);
    sheets = [readSvg(decodeText(b), { file: name })];
    onProgress?.(1);
  }
  sheets = (Array.isArray(sheets) ? sheets : [sheets]).filter(Boolean);
  if (!sheets.length) throw fail(`No drawing sheet was found in ${name}.`, 'empty');
  return sheets;
}

async function loadModules() {
  const [v, i, m] = await Promise.all([
    importStage('./views.mjs', 'the view finder'),
    importStage('./interpret.mjs', 'the interpretation'),
    importStage('./mesh.mjs', 'the 3D geometry builder'),
  ]);
  return { findViews: v.findViews, interpret: i.interpret, buildGeometry: m.buildGeometry, applyBoxes: m.applyBoxes, referee: await loadReferee() };
}

// The geometry referee (referee.mjs) is an extra check, not a step the conversion depends on: without the file, or
// when it fails, the model is still delivered and the report says the check did not run.
async function loadReferee() {
  try { return (await import('./referee.mjs')).referee ?? null; } catch { return null; }
}

/** Line count of a sheet: segments, the measure of "line work" (a page with many is likely the GA). */
export function lineWork(sheet) {
  let n = 0;
  for (const p of sheet?.paths ?? []) n += Math.max(0, (p.pts?.length ?? 0) - 1) + (p.closed ? 1 : 0);
  return n;
}

/**
 * Sheet → checkable model and 3D geometry. Returns a Promise (the stage modules load lazily).
 * @param {object} sheet
 * @param {object} overrides user corrections (CONTRACT.md §3)
 * @param {{ onProgress?: (stage: string, fraction: number) => void, geometry?: boolean, modules?: object }} opts
 *   geometry: false stops after the interpretation (the preview uses it to prefill the form: no mesh, no model check).
 * @returns {Promise<{ model, geometry: Map|null, recon, views, report }>} report.timings: ms per stage
 */
export async function convertDrawing(sheet, overrides = {}, { onProgress, geometry: wantGeometry = true, modules } = {}) {
  if (!sheet || !Array.isArray(sheet.paths)) throw fail('No drawing sheet to convert.', 'empty');
  if (!sheet.paths.length) throw fail('The sheet has no line work: nothing to convert. A scanned drawing inside a PDF has none either; export the drawing as PDF or DXF from the CAD program.', 'empty');
  const m = modules ?? await loadModules();
  const timings = {};
  const timed = new Set(); // stages that reported themselves (others ran inside interpret without their own time)
  let current = null, since = now();
  const tick = (stage, fraction = 0) => {
    if (stage !== current) {
      if (current) timings[current] = (timings[current] ?? 0) + (now() - since);
      current = stage; since = now();
      timed.add(stage);
    }
    onProgress?.(stage, Math.max(0, Math.min(1, fraction)));
  };
  const close = () => { if (current) timings[current] = (timings[current] ?? 0) + (now() - since); current = null; };
  const t0 = now();
  let views = null;
  try {
    tick('views');
    views = m.findViews(sheet);
    tick('views', 1);
    close();
    // Not tick('scale'): if interpret does not report its steps, the first one would get the time of all of them.
    onProgress?.('scale', 0);
    const tInterpret = now();
    const out = await m.interpret(sheet, views, overrides ?? {}, {
      onProgress: (stage, fraction) => { if (INTERPRET_STAGES.includes(stage)) tick(stage, fraction ?? 0); },
    });
    const interpretMs = now() - tInterpret;
    // Stages interpret did not report on its own: shown as done, with the time of the interpretation as a whole.
    for (const s of INTERPRET_STAGES) if (!timed.has(s)) { onProgress?.(s, 1); }
    close();
    const { model, recon } = out ?? {};
    const report = out?.report ?? {};
    if (!model || !Array.isArray(model.elements)) throw fail('The interpretation returned no model.', 'interpret');
    report.timings = { ...(report.timings ?? {}), ...timings, interpret: interpretMs };
    report.timedStages = [...timed];
    let geometry = null;
    if (wantGeometry) {
      tick('mesh');
      const g = await m.buildGeometry(recon);
      geometry = g instanceof Map ? g : g?.elements instanceof Map ? g.elements : new Map();
      // Element boxes from the meshes: the checker measures the same solid the viewer draws.
      m.applyBoxes?.(model, geometry);
      tick('mesh', 1);
      close();
      report.timings.mesh = timings.mesh;
      // Geometry check on the finished model (rooms overlapping, doors not in a wall, …). It is timed as
      // timings.referee but is not a stage of its own: the UI shows it with "3D geometry".
      const referee = m.referee;
      if (typeof referee === 'function') {
        const tr = now();
        try {
          const r = await referee(model, recon);
          report.referee = { ok: !!r?.ok, issues: Array.isArray(r?.issues) ? r.issues : [] };
        } catch (e) {
          report.referee = { ok: false, issues: [], failed: `The geometry check could not run: ${e?.message || e}` };
        }
        report.timings.referee = now() - tr;
      } else {
        report.referee = null; // not available: the UI says the geometry was not checked
      }
    }
    report.timings.total = now() - t0;
    return { model, geometry, recon, views, report };
  } catch (e) {
    // Name the step that failed: the UI marks it and the engineer knows where to correct the drawing or the form.
    // The views found so far go with the error: the preview still shows them, so the engineer can correct them.
    if (e && typeof e === 'object') {
      if (!e.stage) e.stage = current ?? (views ? 'scale' : 'views');
      if (views && !e.views) e.views = views;
    }
    throw e;
  }
}

/**
 * Geometry Map → a list for postMessage plus the typed-array buffers to transfer (each buffer once: meshes may share
 * one buffer, and listing it twice makes postMessage throw).
 */
export function geometryForTransfer(geometry) {
  const entries = [], buffers = new Set();
  for (const [id, g] of geometry ?? []) {
    entries.push([id, g]);
    for (const a of [g.positions, g.normals, g.indices]) if (a?.buffer instanceof ArrayBuffer) buffers.add(a.buffer);
  }
  return { entries, transfer: [...buffers] };
}
