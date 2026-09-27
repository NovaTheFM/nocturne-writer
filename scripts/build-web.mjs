import { mkdir, cp, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const root = process.cwd();
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await copyFile(join(root, 'index.html'), join(dist, 'index.html'));
await cp(join(root, 'src'), join(dist, 'src'), { recursive: true });
await cp(join(root, 'reaper_photo'), join(dist, 'reaper_photo'), { recursive: true });

console.log('Nocturne web assets and canonical CSS copied to dist/');
