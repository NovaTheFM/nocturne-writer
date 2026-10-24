import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron } from 'playwright';

const output = process.env.NOCTURNE_QA_DIR || 'release/qa/luna-rig-native';
await mkdir(`${output}/profile`, { recursive: true });
const env = { ...process.env, NOCTURNE_TEST_PROFILE: resolve(output, 'profile') };
delete env.NOCTURNE_DEV_URL; delete env.ELECTRON_DEV_URL; delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['electron/main.cjs'], env });
  const page = await app.firstWindow(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  assert.match(page.url(), /^file:/);
  await page.locator('[data-confirm-language]').click();
  await page.locator('[data-luna-rig-ready="true"]').waitFor({ timeout: 25000 });
  const state = await page.evaluate(() => window.nocturneApp.lunaTutorial.mascot.rig.getState());
  assert.equal(state.layers, 56); assert.equal(state.poseState, 'wave');
  const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(`${output}/electron-wave.png`, Buffer.from(image, 'base64'));
  await page.keyboard.press('Escape'); await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
  await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
  const before = await page.evaluate(async () => {
    const a = window.nocturneApp;
    await a.createDoc(a.defaultFolderId(), 'Native manuscript');
    a.nocturneEditor.get('primary').commands.setContent('<p>Keep the native author’s work.</p>'); await a.flushOpenDocuments();
    return a.db.getAllRaw('docs');
  });
  await page.evaluate(() => { void window.nocturneApp.lunaTutorial.start(); });
  await page.locator('.luna-practice-host.is-ready').waitFor({ timeout: 25000 });
  assert.ok(await page.locator('#electron-titlebar .titlebar-controls').evaluate(element => !element.closest('[inert]')));
  assert.ok(await page.locator('iframe[data-luna-practice]').evaluate(frame => frame.getBoundingClientRect().top >= document.getElementById('electron-titlebar').getBoundingClientRect().bottom));
  const practice = page.frameLocator('iframe[data-luna-practice]');
  await practice.locator('[data-luna-choice="yes"]').click();
  await practice.locator('#luna-tutorial[data-step="write"]').waitFor();
  await practice.locator('.page-content-prosemirror').first().fill('Native tutorial practice');
  await page.waitForTimeout(700);
  await practice.locator('[data-luna-choice="skip"]').click(); await page.locator('iframe[data-luna-practice]').waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.nocturneApp.db.getAllRaw('docs')), before);
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify([{ name: 'real Electron loads the original rig from file origin', status: 'PASS' }, { name: 'file-origin tutorial replay edits only its in-memory manuscript', status: 'PASS' }], null, 2));
  console.log('PASS real Electron loads original rig from file origin');
} finally { await app?.close(); }
