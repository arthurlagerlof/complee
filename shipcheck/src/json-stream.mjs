// Streams the objects of one large JSON array without loading the whole file.
// Used for the APS property dump (model-properties.json, ~150 MB on one line):
//   {"data":{"type":"properties","collection":[ {...}, {...}, ... ]}}
// `arrayKey` names the array whose elements are yielded (here "collection").
// Node only (uses fs); not imported by the browser.
import fs from 'node:fs';

export async function* streamArray(file, arrayKey) {
  const marker = `"${arrayKey}":[`;
  let found = false;
  let buf = '';      // text not yet consumed
  let pos = 0;       // next character of buf to scan
  let start = -1;    // start of the current top-level object in buf
  let depth = 0, inStr = false, escNext = false;

  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 20 })) {
    buf += chunk;
    if (!found) {
      const at = buf.indexOf(marker);
      if (at < 0) { buf = buf.slice(-marker.length); continue; }
      found = true;
      buf = buf.slice(at + marker.length);
      pos = 0;
    }
    for (; pos < buf.length; pos++) {
      const c = buf[pos];
      if (inStr) {
        if (escNext) escNext = false;
        else if (c === '\\') escNext = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') { if (depth === 0) start = pos; depth++; }
      else if (c === '}') {
        if (--depth === 0) { yield JSON.parse(buf.slice(start, pos + 1)); start = -1; }
      } else if (c === ']' && depth === 0) return;
    }
    // Drop everything already consumed; keep an unfinished object.
    if (start >= 0) { buf = buf.slice(start); pos -= start; start = 0; }
    else { buf = ''; pos = 0; }
  }
  if (!found) throw new Error(`Array "${arrayKey}" not found in ${file}`);
}
