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
    const r = await convertDrawing(sheet, data.overrides ?? {}, { onProgress: progress, geometry: !analyse });
    const { entries, transfer } = geometryForTransfer(r.geometry);
    self.postMessage({ type: 'done', id, model: r.model, geometry: analyse ? null : entries, recon: r.recon, views: r.views, report: r.report }, transfer);
  } catch (e) {
    // views: what findViews found before a later step failed, so the preview can still show them for correction.
    self.postMessage({ type: 'error', id, message: e?.message || String(e), stage: e?.stage ?? null, code: e?.code ?? null, views: e?.views ?? null });
  }
});
