import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { splitBootTip, bindHatOutline, cleanHairFringe } from '../src/ui/luna-rig.js';
import { rgbaPng } from '../src/vendor/luna-rig/src/png-rgba.js';

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
test('shoe ownership repair preserves every original RGBA byte', async () => {
  const manifest = JSON.parse(await readFile(`${root}/assets/manifest.json`, 'utf8'));
  const bytes = await readFile(`${root}/assets/${manifest.parts['boot-right'].file}`);
  const { pixels, width, height } = await rgbaPng(`data:image/png;base64,${bytes.toString('base64')}`);
  const { main, tip } = splitBootTip(pixels, width, height);
  let attached = 0, retained = 0;
  for (let i = 0; i < pixels.length; i++) assert.equal(main[i] + tip[i], pixels[i], `RGBA byte ${i}`);
  for (let i = 3; i < pixels.length; i += 4) { if (tip[i] >= 8) attached++; if (main[i] >= 8) retained++; }
  assert.equal(attached, 495); assert.equal(retained, 21918);
});

async function partImage(name) {
  const manifest = JSON.parse(await readFile(`${root}/assets/manifest.json`, 'utf8'));
  const bytes = await readFile(`${root}/assets/${manifest.parts[name].file}`);
  return rgbaPng(`data:image/png;base64,${bytes.toString('base64')}`);
}

test('hat contour repair leaves all other hair and hat pixels intact', async () => {
  const hair = await partImage('hair-rear'), hat = await partImage('hat');
  const bound = bindHatOutline(hair.pixels, hair.width, hat.pixels, hat.width);
  let moved = 0;
  for (let y = 0; y < hair.height; y++) for (let x = 0; x < hair.width; x++) {
    const offset = (y * hair.width + x) * 4, seam = x >= 460 && x < 505 && y < 90;
    if (seam && hair.pixels[offset + 3] >= 8) moved++;
    for (let c = 0; c < 4; c++) assert.equal(bound.hair[offset + c], seam ? 0 : hair.pixels[offset + c]);
  }
  assert.equal(moved, 41);
  for (let y = 0; y < hat.height; y++) for (let x = 0; x < hat.width; x++) {
    if (x >= 283 && x < 328 && y >= 47 && y < 137) continue;
    const offset = (y * hat.width + x) * 4;
    assert.deepEqual(bound.hat.slice(offset, offset + 4), hat.pixels.slice(offset, offset + 4));
  }
});

test('fringe cleanup preserves every crescent/star pixel and opaque purple paint', async () => {
  const { pixels, width, height } = await partImage('hair-crown'), clean = cleanHairFringe(pixels, width, height);
  const offset = (x, y) => (y * width + x) * 4;
  assert.equal(clean[offset(96, 116) + 3], 0);
  let removed = 0, painted = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = offset(x, y), protectedArt = x >= 26 && x <= 89 && y >= 61 && y <= 126 || x >= 29 && x <= 68 && y >= 121 && y <= 154;
    if (pixels[i + 3] >= 8) painted++;
    if (pixels[i + 3] && !clean[i + 3]) removed++;
    if (protectedArt || pixels[i + 2] - pixels[i] > 14) assert.deepEqual(clean.slice(i, i + 4), pixels.slice(i, i + 4));
  }
  assert.ok(removed > 0 && removed < painted * .02, `${removed} of ${painted} painted pixels removed`);
});
