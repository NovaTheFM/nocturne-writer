import assert from 'node:assert/strict';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, normalize } from 'node:path';
import asar from '../.electron_build/node_modules/@electron/asar/lib/asar.js';

const archive = '.electron_build/dist/win-unpacked/resources/app.asar';
const verified = [];
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename));
    else if (entry.isFile()) result.push(filename);
  }
  return result;
}
for (const filename of ['index.html', ...await files('src'), ...await files('reaper_photo')]) {
  assert.deepEqual(asar.extractFile(archive, join('app_src', filename)), await readFile(filename), `Outdated packaged file: ${filename}`); verified.push(filename);
}
for (const filename of ['electron/main.cjs', 'electron/preload.cjs']) { assert.deepEqual(asar.extractFile(archive, normalize(filename)), await readFile(filename)); verified.push(filename); }
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const filename = `release/electron/Nocturne Writer Setup ${version}.exe`;
const result = { artifact: filename, bytes: (await stat(filename)).size, sha256: createHash('sha256').update(await readFile(filename)).digest('hex'), verifiedPackagedFiles: verified };
await writeFile('release/qa/desktop-artifact.json', JSON.stringify(result, null, 2));
console.log(`Desktop installer verified: ${verified.length} packaged files, ${result.bytes} bytes, SHA256 ${result.sha256}`);
