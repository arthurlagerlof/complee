import test from 'node:test';
import assert from 'node:assert/strict';
import { validateKeys } from '../scripts/download-vultr.mjs';

const object = (Key, Size = 0) => ({ Key, Size, ETag: '"etag"' });

test('bucket paths can include files and directory markers', () => {
  assert.doesNotThrow(() => validateKeys([object('model/'), object('model/file.glb', 5), object('other.txt', 1)]));
});

test('bucket paths that cannot be represented safely on Windows are rejected', () => {
  for (const key of ['../secret', 'a\\b', 'folder/CON.txt', 'x.', '/absolute', 'x//y']) {
    assert.throws(() => validateKeys([object(key)]));
  }
  assert.throws(() => validateKeys([object('A/file'), object('a/FILE')]), /conflict/);
  assert.throws(() => validateKeys([object('folder'), object('folder/file')]), /conflicts/);
  assert.throws(() => validateKeys([object('folder/', 1)]), /Non-empty/);
});
