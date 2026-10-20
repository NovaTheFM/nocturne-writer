import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve('src/vendor/luna-rig');
const provenance = JSON.parse(await readFile(`${root}/PROVENANCE.json`, 'utf8'));
test('imported Luna runtime and textures retain their exact original bytes', async () => {
  assert.equal(provenance.layers, 55); assert.equal(provenance.files.length, 204);
  for (const file of provenance.files) {
    const bytes = await readFile(`${root}/${file.path}`);
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
    if (file.path.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', `${root}/${file.path}`], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
  }
});
test('all original manifest texture references are included for offline use', async () => {
  const manifest = JSON.parse(await readFile(`${root}/assets/manifest.json`, 'utf8'));
  assert.equal(Object.keys(manifest.parts).length, 55);
  const visit = async value => {
    if (Array.isArray(value)) for (const item of value) await visit(item);
    else if (value && typeof value === 'object') for (const item of Object.values(value)) await visit(item);
    else if (typeof value === 'string' && value.endsWith('.png')) await access(`${root}/assets/${value}`);
  };
  await visit(manifest.parts);
});
