import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = resolve('release/visual-comparison-v2');
const manifest = JSON.parse(await readFile(`${directory}/manifest.json`, 'utf8'));
const browser = await chromium.launch();
const results = [];
try {
  for (const width of [1440, 390, 320]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(`${directory}/index.html`).href);
    assert.equal(await page.locator('[data-case]').count(), 8);
    for (let index = 0; index < manifest.cases.length; index++) {
      const item = manifest.cases[index];
      await page.locator(`[data-case="${index}"]`).click();
      assert.equal(await page.locator('#title').textContent(), item.title);
      assert.equal(await page.locator('#configuration option').count(), item.configurations.length);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (item.kind === 'motion') {
        await page.waitForFunction(() => [...document.querySelectorAll('.media video')].length === 2 && [...document.querySelectorAll('.media video')].every(video => video.readyState >= 2));
        if ((await page.locator('#play').textContent()) === 'Пауза') await page.locator('#play').click();
        await page.locator('#timeline').evaluate(input => { input.value = '60'; input.dispatchEvent(new Event('input', { bubbles: true })); });
        await page.waitForFunction(() => document.getElementById('frame').textContent.startsWith('60 /'));
        const times = await page.locator('.media video').evaluateAll(videos => videos.map(video => video.currentTime));
        assert(times.every(time => Math.abs(time - 60.35 / 60) < .02));
        await page.locator('#next-frame').click(); await page.waitForFunction(() => document.getElementById('frame').textContent.startsWith('61 /'));
        await page.locator('#mode').selectOption('apng');
        await page.waitForFunction(() => [...document.querySelectorAll('.media img')].every(image => image.complete && image.naturalWidth > 0));
        assert.equal(await page.locator('.links a').filter({ hasText: 'GIF · 50 FPS' }).count(), 2);
        await page.locator('#mode').selectOption('video');
        await page.waitForFunction(() => [...document.querySelectorAll('.media video')].every(video => video.readyState >= 2));
      } else {
        for (const config of item.configurations) {
          await page.locator('#configuration').selectOption(String(item.configurations.indexOf(config)));
          await page.waitForFunction(() => [...document.querySelectorAll('.media img')].every(image => image.complete && image.naturalWidth > 0));
        }
      }
      await page.locator('#zoom').click(); assert(await page.locator('#zoom-dialog').evaluate(dialog => dialog.open));
      await page.keyboard.press('Escape'); assert(!(await page.locator('#zoom-dialog').evaluate(dialog => dialog.open)));
      results.push({ width, case: item.id, ok: true });
    }
    await page.locator('[data-case="0"]').click(); await page.locator('#next').click();
    assert.equal(await page.locator('#title').textContent(), manifest.cases[1].title);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${directory}/qa-${width}.png`, fullPage: true });
    await page.close();
  }
} finally {
  await browser.close();
  await writeFile(`${directory}/gallery-qa.json`, JSON.stringify({ results }, null, 2));
}
console.log(`Comparison: ${results.length} screen/case checks passed, native video seeking and APNG loading verified.`);
