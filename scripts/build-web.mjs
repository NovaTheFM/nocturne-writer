import { mkdir, cp, copyFile, rm, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyFile(join(root, 'index.html'), join(dist, 'index.html'));
await cp(join(root, 'src'), join(dist, 'src'), { recursive: true });
await cp(join(root, 'reaper_photo'), join(dist, 'reaper_photo'), { recursive: true });

// Bundle CSS
const stylesPath = join(dist, 'src', 'styles.css');
let stylesContent = await readFile(stylesPath, 'utf8');
const importRegex = /@import\s+url\(['"](.+?)['"]\);?/g;
let match;
const imports = [];
while ((match = importRegex.exec(stylesContent)) !== null) {
  imports.push({ match: match[0], path: match[1] });
}

for (const imp of imports) {
  const impContent = await readFile(join(dist, 'src', imp.path), 'utf8');
  stylesContent = stylesContent.replace(imp.match, impContent);
}
await writeFile(stylesPath, stylesContent, 'utf8');
// Clean up src/css from dist
await rm(join(dist, 'src', 'css'), { recursive: true, force: true });

console.log('Nocturne web assets copied to dist/ and CSS bundled');
