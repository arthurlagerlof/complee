import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readZipEntry } from '../src/zip-entry.mjs';
import { extractDocxText, reviewDocumentEvidence } from '../src/document-review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEMO_DOCX = path.join(ROOT, 'demo', 'ShipCheck_Fictional_RCRV_Fire_Safety_Design_Brief.docx');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// Minimal ZIP writer for the tests. `descriptor` writes zero sizes in the local
// header (as streaming writers do), so the reader must use the central directory.
function makeZip(files, { comment = '' } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const raw = Buffer.from(f.content);
    const data = f.method === 0 ? raw : zlib.deflateRawSync(raw);
    const flags = (f.encrypted ? 0x1 : 0) | (f.descriptor ? 0x8 : 0);
    const size = f.declaredSize ?? raw.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(f.method ?? 8, 8);
    local.writeUInt32LE(f.descriptor ? 0 : crc32(raw), 14);
    local.writeUInt32LE(f.descriptor ? 0 : data.length, 18);
    local.writeUInt32LE(f.descriptor ? 0 : size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(f.method ?? 8, 10);
    central.writeUInt32LE(crc32(raw), 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    const parts = [local, name, data];
    locals.push(...parts);
    offset += parts.reduce((n, b) => n + b.length, 0);
    centrals.push(central, name);
  }
  const dir = Buffer.concat(centrals);
  const note = Buffer.from(comment);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(note.length, 20);
  return Buffer.concat([...locals, dir, eocd, note]);
}

const documentXml = (...paragraphs) =>
  `<?xml version="1.0"?><w:document><w:body>${paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`;

test('readZipEntry reads stored and deflated entries and skips other entries', async () => {
  const zip = makeZip([
    { name: '[Content_Types].xml', content: '<Types/>' },
    { name: 'stored.txt', content: 'plain text', method: 0 },
    { name: 'word/document.xml', content: documentXml('Hello &amp; welcome') },
  ], { comment: 'archive comment' });
  assert.equal((await readZipEntry(zip, 'stored.txt')).toString(), 'plain text');
  assert.match((await readZipEntry(zip, 'word/document.xml')).toString(), /Hello &amp; welcome/);
});

test('readZipEntry uses central directory sizes when the local header has a data descriptor', async () => {
  const zip = makeZip([{ name: 'word/document.xml', content: documentXml('Streamed entry'), descriptor: true }]);
  assert.match((await readZipEntry(zip, 'word/document.xml')).toString(), /Streamed entry/);
});

test('readZipEntry rejects missing, encrypted, oversized, mis-sized and damaged input', async () => {
  const ok = makeZip([{ name: 'a.txt', content: 'abc' }]);
  await assert.rejects(readZipEntry(ok, 'word/document.xml'), /not found/);
  await assert.rejects(readZipEntry(Buffer.from('not a zip at all, just some text bytes'), 'a.txt'), /Not a ZIP/);
  await assert.rejects(readZipEntry(ok.subarray(0, ok.length - 5), 'a.txt'), /Not a ZIP/);
  await assert.rejects(readZipEntry(makeZip([{ name: 'a.txt', content: 'abc', encrypted: true }]), 'a.txt'), /Encrypted/);
  const zeros = '\0'.repeat(2 * 1024 * 1024);
  await assert.rejects(readZipEntry(makeZip([{ name: 'big.xml', content: zeros }]), 'big.xml', { maxBytes: 1024 * 1024 }), /larger than the allowed size/);
  // A header that under-reports the size must not let the inflated data exceed the limit.
  await assert.rejects(readZipEntry(makeZip([{ name: 'big.xml', content: zeros, declaredSize: 10 }]), 'big.xml', { maxBytes: 1024 * 1024 }), /could not be decompressed/);
  await assert.rejects(readZipEntry(makeZip([{ name: 'a.txt', content: 'abc', declaredSize: 4 }]), 'a.txt'), /size does not match/);
});

test('extractDocxText needs no external unzip and maps failures to 422', async () => {
  const docx = makeZip([{ name: 'word/document.xml', content: documentXml('First   paragraph', 'Second &lt;b&gt;') }]);
  assert.equal(await extractDocxText(docx), 'First paragraph\nSecond <b>');
  await assert.rejects(extractDocxText(Buffer.from('plain text pretending to be a docx')), (e) => e.status === 422 && /Could not read this DOCX/.test(e.message));
  await assert.rejects(extractDocxText(makeZip([{ name: 'word/document.xml', content: documentXml() }])), (e) => e.status === 422 && /No readable text/.test(e.message));
});

test('reviewDocumentEvidence reads the demo DOCX and keeps the product name server-side', async () => {
  const queries = [];
  const provider = { id: 'stub', async search(q) { queries.push(q); return { results: [] }; } };
  const dataBase64 = fs.readFileSync(DEMO_DOCX).toString('base64');
  const result = await reviewDocumentEvidence({ filename: 'brief.docx', dataBase64, provider, productName: 'Injected' });
  assert.equal(result.status, 'source_candidates_found');
  assert.ok(result.extracted_characters > 1000);
  assert.deepEqual(result.findings.map((f) => f.topic), ['Fixed fire suppression', 'Oil-fuel piping', 'Fire alarms and controls']);
  assert.equal(queries.length, 3);
  assert.match(result.message, /Complee has not decided/);
  const complee = await reviewDocumentEvidence({ filename: 'brief.docx', dataBase64, provider }, { productName: 'Complee' });
  assert.match(complee.message, /Complee has not decided/);
});
