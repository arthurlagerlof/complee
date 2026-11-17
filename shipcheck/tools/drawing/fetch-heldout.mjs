// A held-out test set of Swiss Dwellings plans the converter was never tuned on, fetched from the full Stoa dataset
// with HTTP range requests (only the zip directory, the answer key and the chosen plans; not the 9.8 GB archive).
// Selection is fixed and not hand-picked: every swiss_dwellings plan with a PDF and a DXF that is not in the
// development set (the 65 plans of junction-dataset-preview), ordered by SHA-1 of its name, the first N.
//   node tools/drawing/fetch-heldout.mjs [--n 200] [--out tools/drawing-samples/stoa-heldout]
// Writes <out>/data/swiss_dwellings/*.pdf|*.dxf, <out>/questions.jsonl and <out>/manifest.json (rule, files, SHA-256).
// The plans are CC BY 4.0 (Swiss Dwellings v3.0.0, Archilyse AG); the folder is git-ignored.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const URL_ZIP = 'https://fwjydgxpttajiqpfmqtj.supabase.co/storage/v1/object/public/stoa-junction-2026/junction-dataset.zip';
const here = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('n', 200));
const OUT = path.resolve(arg('out', path.join(here, '..', 'drawing-samples', 'stoa-heldout')));
const DEV = path.join(here, '..', 'drawing-samples', 'stoa-preview', 'junction-dataset-preview', 'data', 'swiss_dwellings');

async function range(from, to) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(URL_ZIP, { headers: { Range: `bytes=${from}-${to}`, 'User-Agent': 'drawing-heldout-fetch' } });
    if (r.status === 206) return Buffer.from(await r.arrayBuffer());
    await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
  }
  throw new Error(`range ${from}-${to} failed`);
}

const head = await fetch(URL_ZIP, { method: 'HEAD' });
const size = Number(head.headers.get('content-length'));
// end of central directory (and its zip64 locator) within the last 64 KiB + 22
const tail = await range(size - 65558, size - 1);
const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
if (eocd < 0) throw new Error('no end of central directory');
let cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16), total = tail.readUInt16LE(eocd + 10);
const loc = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x07]), eocd);
if (loc >= 0) { // zip64
  const z64 = Number(tail.readBigUInt64LE(loc + 8));
  const rec = await range(z64, z64 + 55);
  total = Number(rec.readBigUInt64LE(32)); cdSize = Number(rec.readBigUInt64LE(40)); cdOffset = Number(rec.readBigUInt64LE(48));
}
console.log(`archive ${(size / 1e9).toFixed(2)} GB, ${total} entries, directory ${(cdSize / 1e6).toFixed(1)} MB`);
const cd = await range(cdOffset, cdOffset + cdSize - 1);
const entries = [];
for (let p = 0; p < cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
  const method = cd.readUInt16LE(p + 10);
  let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
  const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
  let off = cd.readUInt32LE(p + 42);
  const name = cd.subarray(p + 46, p + 46 + nlen).toString('utf8');
  // zip64 extra field: the values that are 0xFFFFFFFF in the header follow in this order
  let x = p + 46 + nlen;
  const xend = x + xlen;
  while (x < xend) {
    const id = cd.readUInt16LE(x), len = cd.readUInt16LE(x + 2);
    if (id === 1) {
      let q = x + 4;
      if (usize === 0xffffffff) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
      if (csize === 0xffffffff) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
      if (off === 0xffffffff) { off = Number(cd.readBigUInt64LE(q)); q += 8; }
    }
    x += 4 + len;
  }
  entries.push({ name, method, csize, usize, off });
  p = xend + clen;
}
const byName = new Map(entries.map((e) => [e.name, e]));
async function extract(e) {
  const lh = await range(e.off, e.off + 29);
  const start = e.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
  const data = await range(start, start + e.csize - 1);
  return e.method === 0 ? data : zlib.inflateRawSync(data);
}

const dev = new Set(fs.existsSync(DEV) ? fs.readdirSync(DEV).map((f) => f.replace(/\.(pdf|dxf|png)$/i, '')) : []);
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const swiss = entries.filter((e) => /\/data\/swiss_dwellings\/[^/]+\.pdf$/i.test(e.name));
const candidates = swiss.map((e) => e.name.replace(/\.pdf$/i, ''))
  .filter((base) => byName.has(`${base}.dxf`) && !dev.has(path.basename(base)))
  .sort((a, b) => (sha1(path.basename(a)) < sha1(path.basename(b)) ? -1 : 1));
const chosen = candidates.slice(0, N);
console.log(`${swiss.length} Swiss plans in the archive, ${candidates.length} not in the development set; taking ${chosen.length}`);

const dir = path.join(OUT, 'data', 'swiss_dwellings');
fs.mkdirSync(dir, { recursive: true });
const files = [];
let bytes = 0, k = 0;
for (const base of chosen) {
  for (const ext of ['.pdf', '.dxf']) {
    const e = byName.get(base + ext);
    const target = path.join(dir, path.basename(base) + ext);
    if (!fs.existsSync(target)) { const buf = await extract(e); fs.writeFileSync(target, buf); bytes += e.csize; }
    files.push({ file: path.relative(OUT, target).replace(/\\/g, '/'), sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex') });
  }
  if (++k % 25 === 0) console.log(`  ${k}/${chosen.length} plans`);
}
const q = entries.find((e) => /(^|\/)questions\.jsonl$/.test(e.name));
const qTarget = path.join(OUT, 'questions.jsonl');
if (!fs.existsSync(qTarget)) { fs.writeFileSync(qTarget, await extract(q)); bytes += q.csize; }
// only the questions about the chosen plans are kept (the full key covers all 16,902 files)
const keep = new Set(chosen.map((b) => path.basename(b)));
const lines = fs.readFileSync(qTarget, 'utf8').split('\n').filter((l) => { if (!l) return false; try { return keep.has(path.basename(JSON.parse(l).path).replace(/\.(pdf|dxf|png)$/i, '')); } catch { return false; } });
fs.writeFileSync(qTarget, lines.join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({
  source: URL_ZIP, licence: 'Swiss Dwellings v3.0.0, Archilyse AG, doi:10.5281/zenodo.7788422, CC BY 4.0 (drawings rendered by the Stoa dataset authors)',
  rule: `swiss_dwellings plans with PDF and DXF, not in the development set (junction-dataset-preview), ordered by SHA-1 of the file name, first ${N}`,
  developmentSet: [...dev].sort(), plans: chosen.map((b) => path.basename(b)), questions: lines.length, files,
}, null, 1));
console.log(`done: ${chosen.length} plans, ${lines.length} questions, ${(bytes / 1e6).toFixed(1)} MB downloaded -> ${OUT}`);
