// Drawing → 3D in a module Web Worker, so a large sheet (up to a million line segments) does not freeze the page.
// Messages in:
//   { id, file: { name, bytes } }                    read a DXF or SVG (PDF is read in the page: pdf.js has its own
//                                                    worker) → { type: 'sheets', sheets, keys }
//   { id, sheet?, key?, overrides, mode? }           convert (mode 'analyse': views and interpretation only, no mesh)
//                                                    → { type: 'done', model, geometry, recon, views, report }
// Out, meanwhile: { type: 'progress', stage, fraction }; on failure { type: 'error', message, stage }.
// A sheet sent once is kept under its key: converting again after a correction sends only the key, not the sheet
// again (structured-cloning a million small arrays costs more than the conversion steps that follow).
import { readDrawingFile, convertDrawing, geometryForTransfer } from './src/drawing/convert.mjs';

const sheets = new Map(); // key -> sheet, the current file's pages only

// OCR for labels drawn as line work (src/drawing/ocr.mjs): tesseract.js with its engine and English data served by this
// server under /node_modules/; started on the first request and kept for the next conversion.
let ocrEngine = null;
function ocrRecognizer() {
  ocrEngine ??= (async () => {
    const mod = await import('/node_modules/tesseract.js/dist/tesseract.esm.min.js');
    const { createWorker, PSM } = mod.default ?? mod; // the ESM build exports the library as its default
    const w = await createWorker('eng', 1, {
      workerPath: '/node_modules/tesseract.js/dist/worker.min.js', corePath: '/node_modules/tesseract.js-core',
      langPath: '/node_modules/@tesseract.js-data/eng/4.0.0_best_int', gzip: true, workerBlobURL: false, cacheMethod: 'none', logger: () => {},
    });
    await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
    return async (img) => {
      // the engine reads encoded images in a worker (no DOM to draw ImageData on): PNG through an OffscreenCanvas
      const canvas = new OffscreenCanvas(img.width, img.height);
      canvas.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
      const png = await canvas.convertToBlob({ type: 'image/png' });
      const { data } = await w.recognize(png, {}, { blocks: true, text: false });
      const lines = [];
      for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) lines.push({ text: l.text, confidence: l.confidence, bbox: l.bbox });
      return lines;
    };
  })().catch((e) => { ocrEngine = null; throw Object.assign(new Error(`The OCR engine could not start: ${e?.message || e}`), { stage: 'ocr' }); });
  return ocrEngine;
}
const KEEP = 6;

function remember(key, sheet) {
  if (!key) return;
  sheets.delete(key);
  sheets.set(key, sheet);
  while (sheets.size > KEEP) sheets.delete(sheets.keys().next().value);
}

self.addEventListener('message', async ({ data }) => {
  const id = data?.id;
  const progress = (stage, fraction) => self.postMessage({ type: 'progress', id, stage, fraction });
  try {
    if (data.file) {
      const list = await readDrawingFile(data.file, { onProgress: (f) => progress('read', typeof f === 'number' ? f : 0) });
      sheets.clear();
      const keys = list.map((s, i) => `${data.file.name}#${s.source?.page ?? i + 1}`);
      list.forEach((s, i) => remember(keys[i], s));
      self.postMessage({ type: 'sheets', id, sheets: list, keys });
      return;
    }
    let sheet = data.sheet;
    if (sheet) remember(data.key, sheet);
    else sheet = sheets.get(data.key);
    if (!sheet) throw Object.assign(new Error('The drawing is no longer in the converter\'s memory. Open the file again.'), { code: 'missing' });
    const analyse = data.mode === 'analyse';
    const ocr = data.ocr ? await ocrRecognizer() : null;
    const r = await convertDrawing(sheet, data.overrides ?? {}, { onProgress: progress, geometry: !analyse, ocr });
    const { entries, transfer } = geometryForTransfer(r.geometry);
    self.postMessage({ type: 'done', id, model: r.model, geometry: analyse ? null : entries, recon: r.recon, views: r.views, report: r.report }, transfer);
  } catch (e) {
    // views: what findViews found before a later step failed, so the preview can still show them for correction.
    self.postMessage({ type: 'error', id, message: e?.message || String(e), stage: e?.stage ?? null, code: e?.code ?? null, views: e?.views ?? null });
  }
});
