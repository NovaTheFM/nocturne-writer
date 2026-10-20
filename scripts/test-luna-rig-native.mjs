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
  assert.equal(state.layers, 55); assert.equal(state.poseState, 'wave');
  const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
  await writeFile(`${output}/electron-wave.png`, Buffer.from(image, 'base64'));
  await page.keyboard.press('Escape'); await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
  await writeFile(`${output}/results.json`, JSON.stringify([{ name: 'real Electron loads the original rig from file origin', status: 'PASS' }], null, 2));
  console.log('PASS real Electron loads original rig from file origin');
} finally { await app?.close(); }
