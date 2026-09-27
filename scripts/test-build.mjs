import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['scripts/build-web.mjs'], { encoding: 'utf8' });
assert.equal(result.status, 0, result.stderr);
const html = await readFile('dist/index.html', 'utf8');
for (const match of html.matchAll(/(?:href|src)="((?:\.\/)?src\/[^"?]+)(?:\?[^" ]*)?"/g)) {
  await access(`dist/${match[1]}`);
}
console.log('production HTML references resolve');
