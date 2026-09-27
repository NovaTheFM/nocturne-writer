import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function sources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['vendor', 'assets', 'node_modules'].includes(entry.name)) continue;
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(filename));
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(filename);
  }
  return files;
}
const files = ['server.mjs', ...await sources('src'), ...await sources('electron'), ...await sources('scripts')];
for (const filename of files) {
  const result = spawnSync(process.execPath, ['--check', filename], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) { console.error(result.stderr || result.error); process.exit(1); }
}
console.log(`Syntax verified: ${files.length} source files.`);
