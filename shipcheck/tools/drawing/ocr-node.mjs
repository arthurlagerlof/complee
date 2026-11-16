// tesseract.js in Node for the drawing OCR (src/drawing/ocr.mjs): local engine and English data from node_modules,
// nothing fetched. recognizer() -> { recognize(image), terminate() }; image = { width, height, data: RGBA }.
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// RGBA → PNG (the Node build of tesseract.js reads encoded images)
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (buf) => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
export function pngOf({ width, height, data }) {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width + 1)] = 0; for (let x = 0; x < width; x++) raw[y * (width + 1) + 1 + x] = data[4 * (y * width + x)]; }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0; // 8-bit grey
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export async function recognizer() {
  const { createWorker, PSM } = require('tesseract.js');
  const langPath = path.join(root, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');
  const worker = await createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none', logger: () => {} });
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' });
  return {
    async recognize(image) {
      const { data } = await worker.recognize(pngOf(image), {}, { blocks: true, text: false });
      const lines = [];
      for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) lines.push({ text: l.text, confidence: l.confidence, bbox: l.bbox });
      return lines;
    },
    terminate: () => worker.terminate(),
  };
}
