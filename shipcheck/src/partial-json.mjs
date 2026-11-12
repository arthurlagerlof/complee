// Read a JSON document that is still being written (a streamed AI answer): close what is open and return the
// value as far as it goes. Strings are cut where the text stops, so a sentence grows word by word on screen.
// Returns null while nothing usable has arrived.

function closeAt(text) {
  const stack = [];
  let inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') stack.pop();
  }
  let out = text;
  if (inString) {
    if (escaped) out = out.slice(0, -1); // a lone backslash at the very end
    out += '"';
  }
  // Drop what cannot stand on its own at the end: a dangling comma, colon, or a key without a value.
  out = out.replace(/,\s*$/, '').replace(/,?\s*"[^"]*"\s*:\s*$/, '').replace(/:\s*$/, ': null');
  return out + stack.reverse().join('');
}

export function parsePartialJson(text) {
  const start = text.search(/[{[]/);
  if (start < 0) return null;
  let body = text.slice(start);
  try { return JSON.parse(body); } catch { /* still being written */ }
  // Try the closed-up text, then shorter cuts at the last comma, until something parses.
  for (let attempt = 0; attempt < 8 && body.length; attempt++) {
    try { return JSON.parse(closeAt(body)); } catch { /* cut further */ }
    const cut = Math.max(body.lastIndexOf(','), body.lastIndexOf('{') + 1, body.lastIndexOf('[') + 1);
    if (cut <= 0 || cut >= body.length) break;
    body = body.slice(0, cut);
  }
  return null;
}
