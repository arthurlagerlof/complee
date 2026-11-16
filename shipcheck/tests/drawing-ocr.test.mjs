// OCR of labels drawn as line work (src/drawing/ocr.mjs): which strokes are writing, the picture handed to the engine,
// what is accepted, words of one line joined, and the provenance of a room name read this way. A fixed fake engine
// tests the logic; one test runs the real tesseract.js on a word drawn with straight strokes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeSheet, addPath, addText, finishSheet } from '../src/drawing/sheet.mjs';
import { glyphGroups, rasterGroup, plausibleLine, acceptLine, ocrSheet, needsOcr } from '../src/drawing/ocr.mjs';

// a word in a blocky single-stroke font: each letter is polylines in a 0..1 × 0..1 cell (y up)
const FONT = {
  H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
  A: [[[0, 0], [0.5, 1], [1, 0]], [[0.25, 0.5], [0.75, 0.5]]],
  L: [[[0, 1], [0, 0], [0.8, 0]]],
  E: [[[0.8, 1], [0, 1], [0, 0], [0.8, 0]], [[0, 0.5], [0.6, 0.5]]],
  R: [[[0, 0], [0, 1], [0.7, 1], [0.85, 0.85], [0.85, 0.65], [0.7, 0.5], [0, 0.5]], [[0.4, 0.5], [0.9, 0]]],
  V: [[[0, 1], [0.5, 0], [1, 1]]],
  N: [[[0, 0], [0, 1], [1, 0], [1, 1]]],
  T: [[[0, 1], [1, 1]], [[0.5, 1], [0.5, 0]]],
};
function drawWord(s, word, x, y, h, props = {}) {
  let cx = x;
  for (const ch of word) {
    if (ch === ' ') { cx += 0.9 * h; continue; }
    for (const stroke of FONT[ch]) addPath(s, stroke.map(([u, v]) => [cx + u * 0.7 * h, y + v * h]), { stroke: true, width: 0.3, color: '#000', ...props });
    cx += 0.95 * h;
  }
  return cx;
}
// a sheet as drawings come: A3-sized, with a frame (glyph sizes are judged against the sheet)
const sheetWith = (fn) => {
  const s = makeSheet({ format: 'pdf', unit: 'pt', paper: true });
  addPath(s, [[0, 0], [1190, 0], [1190, 842], [0, 842]], { stroke: true, width: 0.7, color: '#000' }, true);
  fn(s); finishSheet(s); return s;
};

test('glyph groups: a word drawn as strokes is one group; a grid and a long wall are not writing', () => {
  const s = sheetWith((s) => {
    addPath(s, [[0, 0], [1000, 0], [1000, 700], [0, 700]], { stroke: true, width: 0.7, color: '#000' }, true); // the frame of the drawing
    drawWord(s, 'HALL', 100, 300, 4);
    for (let i = 0; i <= 12; i++) { addPath(s, [[400 + 3 * i, 300], [400 + 3 * i, 336]], { stroke: true, width: 0.2, color: '#00f' }); addPath(s, [[400, 300 + 3 * i], [436, 300 + 3 * i]], { stroke: true, width: 0.2, color: '#00f' }); }
  });
  const g = glyphGroups(s);
  assert.equal(g.length, 1, `one group: ${g.map((x) => x.box.map(Math.round)).join(' | ')}`);
  assert.ok(g[0].box[0] >= 99 && g[0].box[2] <= 120 && g[0].h >= 3.9 && g[0].h <= 4.1, 'the word, with the glyph height');
  assert.equal(g[0].vertical, false);
});

test('raster: only the group strokes, glyphs about 24 px high, and the way back to the sheet', () => {
  const s = sheetWith((s) => drawWord(s, 'HALL', 100, 300, 4));
  const [g] = glyphGroups(s);
  const img = rasterGroup(s, g);
  assert.ok(img.width > 40 && img.height > 24 + 2 * 12 - 2 && img.height < 24 + 2 * 12 + 4, `${img.width}×${img.height}`);
  const dark = img.data.filter((v, i) => i % 4 === 0 && v === 0).length;
  assert.ok(dark > 100, 'ink drawn');
  const [x, y] = img.toSheet(12, 12); // the top left corner of the glyph box, after the white border
  assert.ok(Math.abs(x - g.box[0]) < 0.01 && Math.abs(y - g.box[3]) < 0.01, 'picture → sheet');
  const turned = rasterGroup(s, g, { rotate: 90 });
  assert.equal(turned.width, img.height, 'turned 90°: width and height swap');
});

test('accepted readings: labels yes; strokes read as letters, short symbol readings and unsure lines no', () => {
  for (const t of ['Galley', '2x Bunks', 'W/C &', 'Hanging Space', 'ER Vent']) assert.ok(plausibleLine(t), t);
  for (const t of ['IIIl||', '1 | 1', '', '#', 'a']) assert.ok(!plausibleLine(t), t);
  assert.ok(acceptLine({ text: 'Galley', confidence: 70 }));
  assert.ok(!acceptLine({ text: 'Galley', confidence: 50 }), 'below the confidence limit');
  assert.ok(acceptLine({ text: 'ER', confidence: 95 }) && acceptLine({ text: 'Up', confidence: 90 }));
  assert.ok(!acceptLine({ text: 'LJ', confidence: 91 }), 'two letters, no vowel, not sure enough');
  assert.ok(acceptLine({ text: 'SCR', confidence: 96 }), 'an abbreviation without a vowel when very sure');
  assert.ok(acceptLine({ text: 'W/C', confidence: 82 }), 'an abbreviation with a slash');
});

test('ocrSheet: readings become texts with their confidence, words of one line are joined, the strokes are marked', async () => {
  // "ER" and "VENT" one word space apart (0.85 glyph heights), as a CAD font writes them
  const s = sheetWith((s) => { drawWord(s, 'ER', 100, 300, 4); drawWord(s, 'VENT', 110, 300, 4); drawWord(s, 'HALL', 300, 500, 4); });
  // a fake engine: the groups come stacked in one picture, largest first (HALL 7 strokes, VENT 6, ER 4), each 24 px
  // glyphs plus a 12 px white border (48 px a row); it "reads" each row across the glyph box
  const calls = [];
  const recognize = async (img) => {
    calls.push(img);
    const row = (k, text, widthPx) => ({ text, confidence: 95, bbox: { x0: 12, x1: 12 + widthPx, y0: 48 * k + 12, y1: 48 * k + 36 } });
    // glyph box widths: 4 letters (3 × 0.95 + 0.7) × 4 = 14.2 units, 2 letters 6.6 units; 6 px per unit
    return [row(0, 'HALL', 85), row(1, 'VENT', 85), row(2, 'ER', 40)];
  };
  const stats = await ocrSheet(s, recognize);
  assert.equal(calls.length, 1, 'all groups in one picture');
  const read = s.texts.filter((t) => t.ocr);
  assert.ok(read.length >= 2, read.map((t) => t.text).join(' | '));
  assert.ok(read.every((t) => t.ocr.confidence >= 95 && t.id.startsWith('o')), 'confidence and an id of their own');
  assert.ok(read.some((t) => t.text === 'ER VENT'), `"ER" and "VENT" on one line become one label: ${read.map((t) => t.text).join(' | ')}`);
  assert.ok(s.paths.some((p) => p.ocrText), 'strokes that were read are marked');
  assert.equal(stats.calls, 1);
});

test('OCR is suggested only for sheets with many letter-like strokes and little text', () => {
  const lines = sheetWith((s) => { for (let i = 0; i < 30; i++) drawWord(s, 'HALL', 100 + (i % 6) * 60, 100 + Math.floor(i / 6) * 40, 4); });
  assert.equal(needsOcr(lines).suggest, true);
  const text = sheetWith((s) => { for (let i = 0; i < 30; i++) { drawWord(s, 'HALL', 100 + (i % 6) * 60, 100 + Math.floor(i / 6) * 40, 4); addText(s, { text: 'Hall', at: [100 + (i % 6) * 60, 110 + Math.floor(i / 6) * 40], height: 4 }); } });
  assert.equal(needsOcr(text).suggest, false, 'the drawing has its labels as text');
});

const haveEngine = fs.existsSync(new URL('../node_modules/tesseract.js/package.json', import.meta.url));
test('the real engine reads a word drawn with straight strokes', { skip: !haveEngine && 'tesseract.js not installed' }, async () => {
  const { recognizer } = await import('../tools/drawing/ocr-node.mjs');
  const s = sheetWith((s) => drawWord(s, 'HALL', 100, 300, 4));
  const R = await recognizer();
  try {
    await ocrSheet(s, R.recognize);
  } finally { await R.terminate(); }
  const read = s.texts.filter((t) => t.ocr);
  assert.ok(read.some((t) => /HALL/i.test(t.text)), `read: ${read.map((t) => `${t.text} (${t.ocr.confidence})`).join(' | ') || 'nothing'}`);
});
