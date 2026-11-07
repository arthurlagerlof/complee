import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTree } from '../tools/export/read-tree.mjs';

test('large model tree is parsed across stream boundaries with exact names and parent structure', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rcrv-tree-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tree.json');
  const value = { data: { objects: [{ objectid: 7, name: 'quoted " name with } ] and \\ and ' + 'x'.repeat(70000), objects: [{ objectid: 8, name: 'child', objects: [] }] }] }, ok: true, missing: null, n: -1.25e-3 };
  await fs.writeFile(file, JSON.stringify(value));
  assert.deepEqual(await readTree(file), value);
  for (const broken of ['{"data":[1,]}', '{"data":', '{"name":"unfinished', '{} {}']) {
    await fs.writeFile(file, broken);
    await assert.rejects(readTree(file));
  }
});
