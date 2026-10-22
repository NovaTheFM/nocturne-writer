import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = process.env.NOCTURNE_QA_DIR || 'release/qa/luna-startup';
await mkdir(output, { recursive: true });
const port = 5359, url = `http://localhost:${port}`, results = [];
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
let browser;
async function scenario(name, action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
  try {
    await action(page); assert.deepEqual(errors, []);
    results.push({ name, status: 'PASS' }); console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: `${output}/failure-${results.length}.png` }).catch(() => {});
    results.push({ name, status: 'FAIL', error: error.stack, errors }); console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}
async function welcome(page) {
  await page.goto(url); await page.locator('[data-confirm-language]').click();
  await page.locator('#luna-tutorial[data-step="welcome"] [data-luna-rig-ready="true"]').waitFor({ timeout: 20000 });
}
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-webgl', '--renderer-process-limit=1'] });
  const probe = await browser.newPage();
  const graphics = await probe.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl'), ext = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL); gl?.getExtension('WEBGL_lose_context')?.loseContext(); return renderer;
  });
  await probe.close(); assert.ok(graphics && !/swiftshader|software|llvmpipe|basic render/i.test(graphics));
  await writeFile(`${output}/graphics.json`, JSON.stringify({ renderer: graphics }));
  await scenario('first preloader waits for the real rig before language choice', async page => {
    let release; const pending = new Promise(resolve => { release = resolve; });
    await page.route('**/luna-rig/assets/manifest.json', async route => { await pending; await route.continue(); });
    try {
      await page.goto(url); await page.waitForFunction(() => window.nocturneApp?.interfaceLanguage);
      await page.waitForTimeout(3000);
      assert.equal(await page.locator('#preloader.hidden').count(), 0, 'The boot loader must remain until Luna finishes loading');
      assert.equal(await page.locator('#language-onboarding.active').count(), 0);
      assert.equal(await page.locator('#luna-tutorial').count(), 0);
      release(); await page.locator('#language-onboarding.active').waitFor({ timeout: 20000 });
      const before = await page.evaluate(() => {
        window.__preparedRig = window.nocturneApp.lunaTutorial.preparedMascot.rig;
        return window.__preparedRig.time;
      });
      await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => window.__preparedRig.time), before, 'A prepared, hidden rig does not keep animating');
      await page.locator('[data-choose-language="uk"]').click(); await page.locator('[data-confirm-language]').click();
      await page.locator('#luna-tutorial[data-step="welcome"]').waitFor();
      assert.equal(await page.locator('#luna-tutorial [data-luna-rig-ready="true"]').count(), 1);
      assert.equal(await page.evaluate(() => window.nocturneApp.lunaTutorial.mascot.rig === window.__preparedRig), true, 'The prepared WebGL rig is reused');
      assert.equal(await page.locator('.luna-mascot img').count(), 0);
      await page.keyboard.press('Escape');
    } finally { release(); }
  });
  await scenario('larger Luna uses a supersampled drawing buffer', async page => {
    await welcome(page);
    const size = await page.locator('#luna-tutorial canvas').evaluate(canvas => ({ width: canvas.getBoundingClientRect().width, height: canvas.getBoundingClientRect().height, bufferWidth: canvas.width, bufferHeight: canvas.height }));
    assert.ok(size.width >= 232, JSON.stringify(size));
    assert.ok(size.bufferWidth >= size.width * 2 - 1 && size.bufferHeight >= size.height * 2 - 1, JSON.stringify(size));
    await page.screenshot({ path: `${output}/quality-desktop.png` }); await page.keyboard.press('Escape');
  });
  await scenario('left shoe tip follows the left leg when legs move independently', async page => {
    await welcome(page);
    const distance = await page.evaluate(() => {
      const rig = window.nocturneApp.lunaTutorial.mascot.rig;
      rig.setPaused(true); rig.legAngles.left.reset(.025); rig.legAngles.right.reset(-.025); rig.render();
      const part = rig.sprites['boot-tip-left'] || rig.sprites['boot-right'], x = 623, y = 1170;
      const u = (x - part.rect[0]) / part.rect[2], v = (y - part.rect[1]) / part.rect[3], p = part.positions;
      const actual = [p[0] + u * (p[2] - p[0]) + v * (p[4] - p[0]), p[1] + u * (p[3] - p[1]) + v * (p[5] - p[1])];
      const expected = rig.legTransform(x, y, 'left').map((value, index) => value * rig.scale + rig.offset[index]);
      return Math.hypot(actual[0] - expected[0], actual[1] - expected[1]);
    });
    assert.ok(distance < .01, `Shoe fragment is attached to the wrong leg: ${distance}px`);
    await page.screenshot({ path: `${output}/shoe-left.png` }); await page.keyboard.press('Escape');
  });
  await scenario('completed startup does not load a rig again on the next visit', async page => {
    await welcome(page); await page.locator('[data-luna-choice="no"]').click();
    await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
    let requested = 0;
    page.on('request', request => { if (request.url().includes('/luna-rig/assets/manifest.json')) requested++; });
    await page.reload(); await page.waitForFunction(() => window.nocturneApp?.startupInteractionReady);
    assert.equal(requested, 0); assert.equal(await page.locator('.luna-preparation, #luna-tutorial, #language-onboarding').count(), 0);
  });
  await scenario('failed first load keeps the preloader and can be retried', async page => {
    await page.route('**/luna-rig/assets/manifest.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
    await page.goto(url); await page.locator('#preloader .luna-startup-retry:not([hidden])').waitFor();
    assert.equal(await page.locator('#preloader.hidden, #language-onboarding, #luna-tutorial').count(), 0);
    await page.unroute('**/luna-rig/assets/manifest.json'); await page.locator('.luna-startup-retry').click();
    await page.locator('[data-confirm-language]').click();
    await page.locator('#luna-tutorial [data-luna-rig-ready="true"]').waitFor();
    assert.equal(await page.locator('.luna-startup-retry').count(), 0); await page.keyboard.press('Escape');
  });
  await scenario('larger mobile Luna renders at retina resolution', async page => {
    await welcome(page);
    const size = await page.locator('#luna-tutorial canvas').evaluate(canvas => {
      const box = canvas.getBoundingClientRect(); return { width: box.width, right: box.right, bottom: box.bottom, buffer: canvas.width };
    });
    assert.ok(size.width >= 104 && size.right < 390 && size.bottom < 844, JSON.stringify(size));
    assert.ok(size.buffer >= size.width * 3 - 1, JSON.stringify(size));
    await page.screenshot({ path: `${output}/quality-mobile.png` }); await page.keyboard.press('Escape');
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
} finally {
  await browser?.close(); server.kill(); await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
