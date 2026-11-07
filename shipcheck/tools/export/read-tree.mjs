// Parse a large JSON tree incrementally, without holding a second, file-sized JSON string.
// The object tree itself is retained because export classification needs parent/child traversal.
import fs from 'node:fs';

async function* tokens(file) {
  let quoted = null, escaped = false, bare = '';
  for await (const chunk of fs.createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 16 })) {
    for (const char of chunk) {
      if (quoted !== null) {
        quoted += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') { yield { value: JSON.parse(quoted) }; quoted = null; }
      } else if (char === '"') {
        if (bare) throw new Error('Invalid JSON token before string');
        quoted = '"';
      } else if ('{}[],:'.includes(char) || /\s/.test(char)) {
        if (bare) { yield { value: JSON.parse(bare) }; bare = ''; }
        if (!/\s/.test(char)) yield char;
      } else bare += char;
    }
  }
  if (quoted !== null) throw new Error('Unterminated JSON string');
  if (bare) yield { value: JSON.parse(bare) };
}

export async function readTree(file) {
  const stack = [];
  let root, hasRoot = false;
  function add(value) {
    const top = stack.at(-1);
    if (!top) {
      if (hasRoot) throw new Error('Multiple JSON roots');
      root = value; hasRoot = true;
    } else if (top.array) {
      if (top.state !== 'value') throw new Error('Missing array comma');
      top.value.push(value); top.state = 'comma';
    } else {
      if (top.state !== 'value') throw new Error('Missing object value');
      Object.defineProperty(top.value, top.key, { value, enumerable: true, writable: true, configurable: true });
      top.state = 'comma';
    }
  }
  for await (const token of tokens(file)) {
    const top = stack.at(-1);
    if (typeof token === 'object') {
      if (top && !top.array && top.state === 'key') {
        if (typeof token.value !== 'string') throw new Error('Object key must be a string');
        top.key = token.value; top.state = 'colon';
      } else add(token.value);
    } else if (token === '{' || token === '[') {
      const array = token === '[', value = array ? [] : {};
      add(value); stack.push({ value, array, state: array ? 'value' : 'key', empty: true });
    } else if (token === '}' || token === ']') {
      if (!top || top.array !== (token === ']')) throw new Error('Mismatched JSON close');
      const empty = top.array ? top.value.length === 0 : Object.keys(top.value).length === 0;
      if (top.state !== 'comma' && !(empty && top.state === (top.array ? 'value' : 'key'))) throw new Error('Incomplete JSON value');
      stack.pop();
    } else if (token === ':') {
      if (!top || top.array || top.state !== 'colon') throw new Error('Unexpected colon');
      top.state = 'value';
    } else if (token === ',') {
      if (!top || top.state !== 'comma') throw new Error('Unexpected comma');
      top.state = top.array ? 'value' : 'key';
    }
  }
  if (!hasRoot || stack.length) throw new Error('Incomplete JSON tree');
  return root;
}
