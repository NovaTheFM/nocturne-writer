import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = process.env.NOCTURNE_QA_DIR || 'release/qa/luna-polish';
await mkdir(output, { recursive: true });
const port = 5360, url = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const results = [];
let browser;
async function greeting(page) {
  await page.goto(url); await page.locator('[data-confirm-language]').click();
  await page.locator('#luna-tutorial[data-step="welcome"] [data-luna-rig-ready="true"]').waitFor();
  await page.waitForFunction(() => !window.nocturneApp.lunaTutorial.changing);
}
async function scenario(name, action, options = {}) {
  if (process.env.NOCTURNE_LUNA_CASE && !name.includes(process.env.NOCTURNE_LUNA_CASE)) { results.push({ name, status: 'SKIP', reason: 'Filtered by NOCTURNE_LUNA_CASE' }); return; }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...options });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  try { await action(page); assert.deepEqual(errors, []); results.push({ name, status: 'PASS' }); console.log(`PASS ${name}`); }
  catch (error) { await page.screenshot({ path: `${output}/failure-${results.length}.png` }).catch(() => {}); results.push({ name, status: 'FAIL', error: error.stack, errors }); console.error(`FAIL ${name}: ${error.message}`); }
  finally { await context.close(); }
}
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-webgl', '--renderer-process-limit=1'] });
  const probe = await browser.newPage();
  const renderer = await probe.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl'), debug = gl?.getExtension('WEBGL_debug_renderer_info'); const name = debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL); gl?.getExtension('WEBGL_lose_context')?.loseContext(); return name; });
  await probe.close(); assert.ok(renderer && !/swiftshader|llvmpipe|software|basic render/i.test(renderer));
  await writeFile(`${output}/graphics.json`, JSON.stringify({ renderer }));
  await scenario('greeting actively waves the raised hand sideways', async page => {
    await greeting(page);
    const range = await page.evaluate(() => new Promise(resolve => {
      const rig = window.nocturneApp.lunaTutorial.mascot.rig, xs = [], started = performance.now();
      rig.options.breathing = false; rig.options.tracking = false; rig.options.wind = 0;
      const sample = () => {
        const sprite = rig.drawOrder.find(sprite => sprite.name === 'arm-right-hand');
        if (sprite) xs.push(sprite.positions.filter((_, i) => i % 2 === 0).reduce((a, b) => a + b, 0) / (sprite.positions.length / 2));
        if (performance.now() - started > 1500) resolve(Math.max(...xs) - Math.min(...xs)); else requestAnimationFrame(sample);
      }; sample();
    }));
    await page.screenshot({ path: `${output}/wave.png` });
    assert.ok(range > 5, `Raised hand only moves ${range.toFixed(3)} CSS pixels sideways`);
    await page.evaluate(() => {
      const tour = window.nocturneApp.lunaTutorial;
      tour.mascot.rig.setPaused(true);
      tour.companion.style.setProperty('--luna-mascot-width', '420px'); tour.companion.style.width = '420px';
      tour.dialog.style.display = 'none'; tour.root.querySelector('.luna-dialog-tail').style.display = 'none';
    });
    for (const phase of [0, .25, .5, .75]) {
      await page.evaluate(phase => { const rig = window.nocturneApp.lunaTutorial.mascot.rig; rig.resize(); rig.time = phase; rig.update(0); rig.render(); }, phase);
      await page.locator('.luna-mascot canvas').screenshot({ path: `${output}/model-wave-${phase}.png` });
    }
    await page.evaluate(async () => { const rig = window.nocturneApp.lunaTutorial.mascot.rig; await rig.setPose(0, true); rig.render(); });
    await page.locator('.luna-mascot canvas').screenshot({ path: `${output}/model-idle.png` });
  });
  await scenario('pose transition starts from the old frame and blends both silhouettes', async page => {
    await greeting(page);
    const evidence = await page.evaluate(async () => {
      const rig = window.nocturneApp.lunaTutorial.mascot.rig, gl = rig.renderer.gl;
      rig.setPaused(true); await rig.setPose(0, true); rig.render();
      const read = () => { const pixels = new Uint8Array(rig.canvas.width * rig.canvas.height * 4); gl.readPixels(0, 0, rig.canvas.width, rig.canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels); return pixels; };
      const old = read(); void rig.setPose(1); await Promise.resolve();
      rig.stateSprites.renderMix(0); const first = read();
      rig.stateSprites.renderMix(1); const next = read();
      rig.stateSprites.renderMix(.5); const middle = read();
      let startError = 0, middleError = 0, changing = 0;
      for (let i = 0; i < old.length; i++) {
        startError = Math.max(startError, Math.abs(first[i] - old[i]));
        if (Math.abs(old[i] - next[i]) > 20) { changing++; middleError = Math.max(middleError, Math.abs(middle[i] - (old[i] + next[i]) / 2)); }
      }
      rig.stateSprites.cancel(); return { startError, middleError, changing };
    });
    await writeFile(`${output}/pose-blend.json`, JSON.stringify(evidence));
    assert.ok(evidence.changing > 1000); assert.ok(evidence.startError <= 2, `New pose leaks into the first frame: ${JSON.stringify(evidence)}`);
    assert.ok(evidence.middleError <= 2, 'Both poses fade together like the Cleaner');
  });
  await scenario('hat outline follows the hat and hair has no white cutout remnants', async page => {
    await greeting(page);
    const evidence = await page.evaluate(() => {
      const rig = window.nocturneApp.lunaTutorial.mascot.rig, rear = rig.sprites['hair-rear'], crown = rig.sprites['hair-crown'];
      let detached = 0;
      for (let y = 0; y < 90; y++) for (let x = 460; x < 505; x++) if (rear.alpha[(y * rear.imageWidth + x) * 4 + 3] >= 8) detached++;
      const pixel = (x, y) => [...crown.alpha.slice((y * crown.imageWidth + x) * 4, (y * crown.imageWidth + x) * 4 + 4)];
      return { detached, remnant: pixel(96, 116), moon: pixel(46, 73) };
    });
    await writeFile(`${output}/materials.json`, JSON.stringify(evidence));
    assert.equal(evidence.detached, 0, 'A hat outline remains assigned to the hair mesh');
    assert.equal(evidence.remnant[3], 0, 'White eye/skin residue remains on the cutout');
    assert.deepEqual(evidence.moon, [255, 255, 255, 255], 'The moon accessory must retain its original highlights');
  });
  for (const mobile of [false, true]) await scenario(`existing project replay is isolated: ${mobile ? 'phone' : 'desktop'}`, async page => {
    await greeting(page); await page.locator('[data-luna-choice="no"]').click();
    await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
    const before = await page.evaluate(async () => {
      const app = window.nocturneApp;
      await app.createDoc(app.defaultFolderId(), 'Author manuscript');
      const editor = app.nocturneEditor.instances.get('primary').editor;
      editor.commands.insertContent('This must stay exactly as the author left it.'); await app.flushOpenDocuments();
      app.state.lore.characters.push({ id: 'author-character', name: 'Author character', role: 'Private' }); await app.saveLore();
      window.__authorEditor = editor;
      await app.databaseSync.work; await app.history.work;
      const { DATABASE_STORES } = await import('/src/core/db.js');
      const snapshot = async () => Object.fromEntries(await Promise.all(DATABASE_STORES.map(async store => [store, (await app.db.getAllRaw(store)).filter(record => store !== 'settings' || record.id !== 'luna-tutorial')])));
      window.__authorSnapshot = snapshot;
      return { data: await snapshot(), workspace: JSON.stringify(app.state.workspace), local: JSON.stringify({ ...localStorage }), session: JSON.stringify({ ...sessionStorage }) };
    });
    await page.evaluate(() => { void window.nocturneApp.lunaTutorial.start(); });
    await page.locator('iframe[data-luna-practice]').waitFor();
    const practice = page.frameLocator('iframe[data-luna-practice]');
    await practice.locator('[data-luna-choice="yes"]').click();
    await practice.locator('#luna-tutorial[data-step="write"]').waitFor();
    assert.match(await practice.locator('.page-content-prosemirror').first().textContent(), /Mira/, 'The practice story uses the chosen language');
    assert.equal(await practice.locator('.entity-link[data-entity-id="luna-practice-character"]').count(), 1, 'The example character is really linked to the manuscript');
    await practice.locator('.page-content-prosemirror').first().fill('Practicing a completely different story.');
    await practice.locator('.page-content-prosemirror').first().press('Control+a');
    await practice.locator('.page-content-prosemirror').first().press('Backspace');
    await page.waitForTimeout(900);
    assert.deepEqual(await page.evaluate(() => window.__authorSnapshot()), before.data);
    await practice.locator('[data-luna-choice="skip"]').click();
    await page.locator('iframe[data-luna-practice]').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.__authorSnapshot()), before.data);
    assert.equal(await page.evaluate(() => JSON.stringify(window.nocturneApp.state.workspace)), before.workspace);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...localStorage })), before.local);
    assert.equal(await page.evaluate(() => JSON.stringify({ ...sessionStorage })), before.session);
    assert.ok(await page.evaluate(() => window.nocturneApp.nocturneEditor.instances.get('primary').editor === window.__authorEditor && !window.__authorEditor.isDestroyed));
    await page.reload(); await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
    assert.equal(await page.locator('iframe[data-luna-practice]').count(), 0);
    assert.equal(await page.evaluate(() => window.nocturneApp.state.docs.length), 1);
  }, mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : {});
  await scenario('replay loading failure offers a retry and can still be skipped', async page => {
    await greeting(page); await page.locator('[data-luna-choice="no"]').click();
    await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
    await page.route('**/luna-rig/assets/manifest.json', route => route.fulfill({ status: 503, body: 'Unavailable' }));
    await page.evaluate(() => { void window.nocturneApp.lunaTutorial.start(); });
    await page.locator('.luna-practice-loading .luna-startup-retry').waitFor();
    await page.unroute('**/luna-rig/assets/manifest.json');
    await page.locator('.luna-practice-loading .luna-startup-retry').click();
    await page.locator('.luna-practice-host.is-ready').waitFor();
    await page.frameLocator('iframe[data-luna-practice]').locator('[data-luna-choice="no"]').click();
    await page.locator('iframe[data-luna-practice]').waitFor({ state: 'detached' });
  });
} finally {
  await browser?.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
