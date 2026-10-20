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
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-webgl', '--renderer-process-limit=1'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.locator('[data-confirm-language]').click();
    await page.locator('#luna-tutorial[data-step="welcome"]').waitFor();
    await page.locator('[data-luna-rig-ready="true"]').waitFor({ timeout: 12000 });
    const state = await page.evaluate(() => window.nocturneApp.lunaTutorial.mascot.rig.getState());
    assert.equal(state.layers, 55); assert.equal(state.poseState, 'wave');
    results.push({ name: 'original layered rig greets with a raised hand', status: 'PASS' });
  } catch (error) {
    await page.screenshot({ path: `${output}/failure.png` });
    results.push({ name: 'original layered rig greets with a raised hand', status: 'FAIL', error: error.stack });
  } finally { await context.close(); }
} finally {
  await browser?.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
}
for (const result of results) console.log(`${result.status} ${result.name}`);
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
