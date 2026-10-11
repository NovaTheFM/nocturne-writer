import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const directory = resolve(process.argv[2] || 'release/visual-comparison');
const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'));
const browser = await chromium.launch();
const results = [], errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', error => errors.push(error.message));
  const loaded = async () => page.waitForFunction(() => ['before-image', 'after-image'].every(id => { const image = document.getElementById(id); return image.complete && image.naturalWidth > 0; }));
  await page.goto(pathToFileURL(join(directory, 'index.html')).href);
  for (const entry of manifest.fixes) {
    await page.locator(`.fix-link[data-id="${entry.id}"]`).click(); await loaded();
    assert.equal(await page.locator('#title').textContent(), entry.title);
    if (entry.motion) assert.match(await page.locator('#after-image').getAttribute('src'), /\.gif/);
    for (const [configuration] of entry.configs) { await page.locator('#configuration').selectOption(configuration); await loaded(); }
    if (entry.extra) {
      await page.locator('#extra').click(); await loaded();
      assert.match(await page.locator('#after-image').getAttribute('src'), entry.extraStill ? /selection\.png/ : /macro-helper-motion/);
      if (entry.extraStill) for (const [configuration] of entry.styleConfigs) { await page.locator('#configuration').selectOption(configuration); await loaded(); }
    }
    results.push({ id: entry.id, comparisons: entry.configs.length, ok: true });
  }
  await page.locator('.fix-link[data-id="V17"]').click(); await loaded();
  await page.locator('#pause').click(); await loaded(); assert.match(await page.locator('#after-image').getAttribute('src'), /poster\.png/);
  await page.locator('#restart').click(); await loaded(); assert.match(await page.locator('#after-image').getAttribute('src'), /\.gif/);
  await page.locator('[data-phase="after"]').click(); assert.equal(await page.locator('#zoom').evaluate(node => node.open), true); await page.keyboard.press('Escape'); assert.equal(await page.locator('#zoom').evaluate(node => node.open), false);
  await page.locator('#next').click(); assert.equal(await page.locator('#fix-id').textContent(), 'V18'); await page.keyboard.press('ArrowLeft'); assert.equal(await page.locator('#fix-id').textContent(), 'V17');
  await page.keyboard.press('/'); await page.locator('#search').fill('V26'); assert.equal(await page.locator('.fix-link').count(), 1); assert.equal(await page.locator('#fix-id').textContent(), 'V26');
  await page.locator('#search').fill(''); await page.locator('#filters button').filter({ hasText: /^Движение$/ }).click(); assert.equal(await page.locator('.fix-link').count(), 9);
  await loaded();
  await page.screenshot({ path: join(directory, 'gallery-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: join(directory, 'gallery-mobile.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.setViewportSize({ width: 320, height: 740 }); await page.screenshot({ path: join(directory, 'gallery-narrow.png') });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.reload(); await loaded(); assert.match(await page.locator('#after-image').getAttribute('src'), /poster\.png/);
  assert.deepEqual(errors, []);
  await writeFile(join(directory, 'gallery-checks.json'), JSON.stringify({ results, controls: 'navigation, keyboard, search, filters, zoom, GIF pause/replay, reduced motion, 390px and 320px overflow', errors }, null, 2));
  console.log(`Gallery PASS: ${results.length} fixes, ${results.reduce((sum, result) => sum + result.comparisons, 0)} comparison configurations, controls and reduced motion.`);
} finally { await browser.close(); }
