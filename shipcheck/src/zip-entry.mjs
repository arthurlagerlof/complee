// Reads one file out of a ZIP archive (DOCX, XLSX, ...) with Node's zlib only,
// so document review works the same on Windows, macOS, Linux and Alpine without
// an external `unzip` program. Supports stored and deflated entries; rejects
// encrypted entries, ZIP64 archives and anything that inflates past maxBytes.
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const inflateRaw = promisify(zlib.inflateRaw);

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

function fail(message) {
  return Object.assign(new Error(message), { code: 'ZIP_INVALID' });
}

function need(buffer, offset, length) {
  if (offset < 0 || offset + length > buffer.length) throw fail('ZIP structure points outside the file.');
}

function findEndOfCentralDirectory(buffer) {
  const stop = Math.max(0, buffer.length - EOCD_MIN - MAX_COMMENT);
  for (let i = buffer.length - EOCD_MIN; i >= stop; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG && i + EOCD_MIN + buffer.readUInt16LE(i + 20) <= buffer.length) return i;
  }
  throw fail('Not a ZIP archive.');
}

export async function readZipEntry(buffer, entryName, { maxBytes = 16 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < EOCD_MIN) throw fail('Not a ZIP archive.');
  const eocd = findEndOfCentralDirectory(buffer);
  const entries = buffer.readUInt16LE(eocd + 10);
  const dirSize = buffer.readUInt32LE(eocd + 12);
  const dirOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) throw fail('ZIP64 archives are not supported.');
  need(buffer, dirOffset, dirSize);

  let p = dirOffset;
  for (let n = 0; n < entries; n += 1) {
    need(buffer, p, 46);
    if (buffer.readUInt32LE(p) !== CENTRAL_SIG) throw fail('Damaged ZIP central directory.');
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const size = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    need(buffer, p + 46, nameLength);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    if (name !== entryName) continue;

    if (flags & 0x1) throw fail('Encrypted ZIP entries are not supported.');
    if (size > maxBytes) throw fail('ZIP entry is larger than the allowed size.');
    need(buffer, localOffset, 30);
    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIG) throw fail('Damaged ZIP entry header.');
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    need(buffer, dataStart, compressedSize);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);

    let out;
    if (method === 0) out = Buffer.from(data);
    else if (method === 8) {
      try {
        out = await inflateRaw(data, { maxOutputLength: maxBytes });
      } catch {
        throw fail('ZIP entry could not be decompressed.');
      }
    } else throw fail(`ZIP compression method ${method} is not supported.`);
    if (out.length !== size) throw fail('ZIP entry size does not match its header.');
    return out;
  }
  throw fail(`ZIP entry ${entryName} not found.`);
}
