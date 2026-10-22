import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = process.env.NOCTURNE_QA_DIR || 'release/qa/luna-rig';
await mkdir(output, { recursive: true });
const port = 5358, url = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const results = [];
let browser;
async function start(page, ready = true) {
  await page.goto(url); await page.locator('[data-confirm-language]').click();
  await page.locator('#luna-tutorial[data-step="welcome"]').waitFor();
  if (ready) await page.locator('[data-luna-rig-ready="true"]').waitFor({ timeout: 20000 });
}
async function idle(page) {
  await page.locator('[data-luna-choice="yes"]').click();
  await page.waitForFunction(() => !window.nocturneApp.lunaTutorial.changing && window.nocturneApp.lunaTutorial.step !== 'welcome');
  await page.waitForFunction(() => window.nocturneApp.lunaTutorial.mascot.rig.getState().poseState === 'idle');
  await page.waitForFunction(() => !document.querySelector('.luna-companion').getAnimations().some(animation => animation.playState === 'running'));
}
async function scenario(name, action, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  const page = await context.newPage(), errors = [], missing = [], external = [];
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400) missing.push(response.url()); });
  page.on('request', request => { if (!request.url().startsWith(url) && /^https?:/.test(request.url())) external.push(request.url()); });
  try {
    await action(page, missing); assert.deepEqual(errors, []); assert.deepEqual(external, []);
    results.push({ name, status: 'PASS' }); console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: `${output}/failure-${results.length}.png` }).catch(() => {});
    results.push({ name, status: 'FAIL', error: error.stack, errors, missing }); console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-webgl', '--renderer-process-limit=1'] });
  const probe = await browser.newPage();
  const graphics = await probe.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return { renderer: null };
    const debug = gl.getExtension('WEBGL_debug_renderer_info'), renderer = debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL);
    gl.getExtension('WEBGL_lose_context')?.loseContext(); return { renderer };
  });
  await probe.close(); await writeFile(`${output}/graphics.json`, JSON.stringify(graphics, null, 2));
  assert.ok(graphics.renderer && !/swiftshader|llvmpipe|software|basic render/i.test(graphics.renderer), `Hardware WebGL unavailable; rig was not loaded: ${graphics.renderer}`);
  await scenario('original rig greets, talks, returns to idle and disposes', async (page, missing) => {
    await start(page);
    assert.equal(await page.locator('.luna-mascot canvas').getAttribute('aria-label'), 'Luna');
    const state = await page.evaluate(() => window.nocturneApp.lunaTutorial.mascot.rig.getState());
    assert.equal(state.layers, 56); assert.equal(state.poseState, 'wave');
    const mouth = await page.evaluate(() => new Promise(resolve => {
      const values = [], rig = window.nocturneApp.lunaTutorial.mascot.rig, started = performance.now();
      const sample = () => { values.push(rig.mouthOpening.value); if (performance.now() - started >= 500) resolve(values); else requestAnimationFrame(sample); }; sample();
    }));
    assert.ok(Math.max(...mouth) - Math.min(...mouth) > .04, 'Original mouth articulation changes during speech');
    await page.waitForFunction(() => !window.nocturneApp.lunaTutorial.mascot.rig.talking);
    await page.screenshot({ path: `${output}/desktop-wave.png` }); await idle(page);
    await page.screenshot({ path: `${output}/desktop-idle.png` });
    await page.evaluate(() => { window.__retiredRig = window.nocturneApp.lunaTutorial.mascot.rig; });
    await page.keyboard.press('Escape'); await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
    assert.ok(await page.evaluate(() => window.__retiredRig.destroyed && window.__retiredRig.listeners.length === 0)); assert.deepEqual(missing, []);
  });
  await scenario('all seven native click zones and pompom drag remain functional', async page => {
    await start(page); await idle(page);
    for (const zone of ['hat', 'pompom', 'hair', 'face', 'chest', 'hand', 'legs']) {
      const point = await page.evaluate(async zone => {
        const rig = window.nocturneApp.lunaTutorial.mascot.rig;
        await rig.setPose(0, true); rig.reset(true); rig.setPaused(true);
        window.__reactions ||= []; rig.addEventListener('reaction', event => window.__reactions.push(event.detail.zone), { once: true });
        for (let y = 2; y < rig.height - 2; y += 2) for (let x = 2; x < rig.width - 2; x += 2) {
          if ([[-1, 0], [1, 0], [0, -1], [0, 1], [0, 0]].every(([dx, dy]) => rig.hitTest(x + dx, y + dy) === zone)) return [x, y];
        }
      }, zone);
      assert.ok(point, `No native hit area: ${zone}`);
      const box = await page.locator('.luna-mascot canvas').boundingBox();
      await page.mouse.click(box.x + point[0], box.y + point[1]);
      assert.equal(await page.evaluate(() => window.__reactions.at(-1)), zone);
    }
    const center = await page.evaluate(async () => {
      const rig = window.nocturneApp.lunaTutorial.mascot.rig;
      await rig.setPose(0, true); rig.reset(true); rig.setPaused(false);
      return rig.pompomPosition.map((value, i) => value * rig.scale + rig.offset[i]);
    });
    const box = await page.locator('.luna-mascot canvas').boundingBox();
    await page.mouse.move(box.x + center[0], box.y + center[1]); await page.mouse.down();
    await page.mouse.move(box.x + center[0] + 50, box.y + center[1] + 20, { steps: 8 });
    await page.waitForFunction(() => Math.hypot(window.nocturneApp.lunaTutorial.mascot.rig.pomX.value, window.nocturneApp.lunaTutorial.mascot.rig.pomY.value) > 10);
    assert.equal(await page.evaluate(() => window.nocturneApp.lunaTutorial.mascot.rig.getState().dragging), true);
    await page.screenshot({ path: `${output}/hat-drag.png` }); await page.mouse.up();
    await page.waitForFunction(() => { const rig = window.nocturneApp.lunaTutorial.mascot.rig; return !rig.drag && Math.hypot(rig.pomX.value, rig.pomY.value) < 5; });
    await page.keyboard.press('Escape');
  });
  await scenario('touch model stays usable on a phone', async page => {
    await start(page); await idle(page);
    const point = await page.evaluate(() => { const rig = window.nocturneApp.lunaTutorial.mascot.rig; return rig.pompomPosition.map((value, i) => value * rig.scale + rig.offset[i]); });
    const box = await page.locator('.luna-mascot canvas').boundingBox();
    await page.touchscreen.tap(box.x + point[0], box.y + point[1]);
    assert.equal(await page.evaluate(() => window.nocturneApp.lunaTutorial.mascot.rig.emotion), 'surprised');
    assert.ok(box.x > 0 && box.x + box.width < 390 && box.y > 0 && box.y + box.height < 844);
    await page.screenshot({ path: `${output}/mobile.png` }); await page.keyboard.press('Escape');
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await scenario('reduced motion holds greeting pose without a render loop', async page => {
    await start(page); const state = await page.evaluate(() => window.nocturneApp.lunaTutorial.mascot.rig.getState());
    assert.equal(state.paused, true); assert.equal(state.talking, false); assert.equal(state.poseState, 'wave');
    const before = state.time; await page.waitForTimeout(180);
    assert.equal(await page.evaluate(() => window.nocturneApp.lunaTutorial.mascot.rig.time), before); await page.keyboard.press('Escape');
  }, { reducedMotion: 'reduce' });
  await scenario('failed material load can be retried without blocking the tutorial', async page => {
    await page.route('**/luna-rig/assets/manifest.json', route => route.fulfill({ status: 503, body: 'unavailable' }));
    await page.goto(url); await page.locator('.luna-rig-retry:not([hidden])').waitFor();
    assert.equal(await page.locator('#preloader.hidden').count(), 0);
    await page.unroute('**/luna-rig/assets/manifest.json'); await page.locator('.luna-rig-retry').click();
    await page.locator('[data-confirm-language]').click();
    await page.locator('#luna-tutorial').waitFor();
    await page.locator('[data-luna-rig-ready="true"]').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('.luna-rig-retry').isVisible(), false); await page.keyboard.press('Escape');
  });
  await scenario('skipping during texture loading leaves no live rig', async page => {
    await start(page); await page.locator('[data-luna-choice="no"]').click();
    await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
    let release; const pending = new Promise(resolve => { release = resolve; });
    await page.route('**/luna-rig/assets/manifest.json', async route => { await pending; await route.continue(); });
    await page.evaluate(() => { void window.nocturneApp.lunaTutorial.start(); window.__pendingMascot = window.nocturneApp.lunaTutorial.mascot; });
    await page.locator('[data-luna-choice="no"]').click(); await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
    release(); await page.evaluate(async () => await window.__pendingMascot.ready);
    assert.ok(await page.evaluate(() => window.__pendingMascot.destroyed && !window.__pendingMascot.rig));
  });
  await scenario('first appearance uses only the live rig at a stable size', async page => {
    let release; const pending = new Promise(resolve => { release = resolve; });
    await page.route('**/luna-rig/assets/manifest.json', async route => { await pending; await route.continue(); });
    try {
      await page.goto(url);
      await page.waitForFunction(() => window.nocturneApp?.lunaTutorial.preparedMascot);
      assert.equal(await page.locator('.luna-mascot img').count(), 0);
      assert.equal(await page.locator('#luna-tutorial').count(), 0);
      release(); await page.locator('[data-confirm-language]').click();
      await page.locator('#luna-tutorial [data-luna-rig-ready="true"]').waitFor({ timeout: 20000 });
      assert.equal(await page.evaluate(() => window.nocturneApp.lunaTutorial.mascot.rig.getState().poseState), 'wave');
      const canvas = page.locator('#luna-tutorial .luna-mascot canvas'), before = await canvas.boundingBox();
      await page.waitForTimeout(320);
      const after = await canvas.boundingBox();
      assert.equal(before.width, after.width); assert.equal(before.height, after.height);
      await page.waitForFunction(() => getComputedStyle(document.querySelector('.luna-mascot canvas')).opacity === '1');
      await page.keyboard.press('Escape');
    } finally { release(); }
  });
} finally {
  await browser?.close(); server.kill(); await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
