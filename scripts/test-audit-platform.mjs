import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron, chromium } from 'playwright';
import { chooseDefaultInterfaceLanguage } from './qa/first-run-language.mjs';

const url = 'http://localhost:5314';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5314', SYNC_PORT: '8914' }, stdio: 'ignore', windowsHide: true });
const results = [];
async function check(name, run) { try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); } catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); } }
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  await mkdir('release/qa', { recursive: true });
  const character = resolve('release/qa/association-character.nocturnechar'), note = resolve('release/qa/association-note.nocturnenote');
  await writeFile(character, JSON.stringify({ type: 'nocturnechar', character: { id: 'association-character', name: 'Association character' } }));
  await writeFile(note, JSON.stringify({ type: 'nocturnenote', note: { id: 'association-note', title: 'Association note', body: 'Second launch body' } }));
  await check('F26 launch arguments and a second-instance request enter the existing import workflow', async () => {
    const env = { ...process.env, NOCTURNE_DEV_URL: url, NOCTURNE_TEST_PROFILE: resolve(`release/qa/association-profile-${Date.now()}`) }; delete env.ELECTRON_RUN_AS_NODE;
    const desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['electron/main.cjs', character], env });
    try {
      const page = await desktop.firstWindow(); await page.waitForSelector('#preloader.hidden', { state: 'attached' });
      await chooseDefaultInterfaceLanguage(page);
      await page.waitForFunction(() => window.nocturneApp.state.lore.characters.some(item => item.id === 'association-character'), null, { timeout: 7000 });
      await desktop.evaluate(({ app }, filename) => app.emit('second-instance', {}, [process.execPath, filename], process.cwd()), note);
      await page.waitForFunction(() => window.nocturneApp.state.lore.notes.some(item => item.id === 'association-note'), null, { timeout: 7000 });
      assert.equal(await page.evaluate(() => window.nocturneApp.state.lore.characters.length), 1);
    } finally { await desktop.close(); }
  });
  await check('C14 disposing modal focus removes its keyboard listener', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage(); await page.goto(`${url}/audit-empty`);
      const removed = await page.evaluate(async () => {
        document.body.innerHTML = '<button id="switch" role="switch">Switch</button>';
        const { manageModalFocus } = await import('/src/ui/modal-focus.js'); const dispose = manageModalFocus();
        let clicks = 0; const button = document.getElementById('switch'); button.onclick = () => clicks++;
        dispose(); button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return clicks === 0;
      });
      assert.equal(removed, true);
    } finally { await browser.close(); }
  });
} finally { server.kill(); await writeFile('release/qa/audit-platform-regressions.json', JSON.stringify(results, null, 2)); }
if (results.some(result => !result.passed)) process.exitCode = 1;
