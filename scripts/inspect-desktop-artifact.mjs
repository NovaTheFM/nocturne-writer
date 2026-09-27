import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, normalize } from 'node:path';
import asar from '../.electron_build/node_modules/@electron/asar/lib/asar.js';

const archive = '.electron_build/dist/win-unpacked/resources/app.asar';
const verified = [];
for (const filename of ['index.html', 'src/main.js', 'src/core/db.js', 'src/features/database-sync.js', 'src/features/local-sync.js', 'src/css/polish.css', 'src/css/fonts.css', 'src/vendor/pdfjs/pdf.min.mjs']) {
  assert.deepEqual(asar.extractFile(archive, join('app_src', filename)), await readFile(filename), `Outdated packaged file: ${filename}`); verified.push(filename);
}
for (const filename of ['electron/main.cjs', 'electron/preload.cjs']) { assert.deepEqual(asar.extractFile(archive, normalize(filename)), await readFile(filename)); verified.push(filename); }
const filename = 'release/electron/Nocturne Writer Setup 1.2.0.exe';
const result = { artifact: filename, bytes: (await stat(filename)).size, sha256: createHash('sha256').update(await readFile(filename)).digest('hex'), verifiedPackagedFiles: verified };
await writeFile('release/qa/desktop-artifact.json', JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
