import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5357, url = `http://localhost:${port}`;
const output = process.env.NOCTURNE_QA_OUTPUT || 'release/qa/luna-tutorial';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const results = [];
let browser;

async function choose(page, locale) {
  await page.locator('#language-onboarding.active').waitFor();
  assert.equal(await page.locator('#luna-tutorial').count(), 0, 'Language choice must come first');
  await page.locator(`[data-choose-language="${locale}"]`).click();
  await page.locator('[data-confirm-language]').click();
  await page.locator('#language-onboarding').waitFor({ state: 'detached' });
  await page.locator('#luna-tutorial[data-step="welcome"]').waitFor({ timeout: 8000 });
}

async function scenario(name, mobile, action, options = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, ...options });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await action(page);
    assert.deepEqual(errors, [], 'No uncaught application errors');
    results.push({ name, mobile, status: 'PASS' });
    console.log(`PASS ${name} (${mobile ? 'mobile' : 'desktop'})`);
  } catch (error) {
    await page.screenshot({ path: `${output}/failure-${results.length}.png` }).catch(() => {});
    results.push({ name, mobile, status: 'FAIL', error: error.stack, errors });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}

try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) for (const locale of ['ru', 'uk', 'en']) {
    await scenario(`localized greeting and persistent No: ${locale}`, mobile, async page => {
      await page.goto(url); await choose(page, locale);
      const title = await page.locator('#luna-tutorial-title').textContent();
      assert.match(title, { ru: /Я Луна/, uk: /Я Луна/, en: /I’m Luna/ }[locale]);
      assert.equal(await page.locator('[data-luna-mascot]').count(), 1);
      assert.equal(await page.locator('[data-luna-choice="yes"]').count(), 1);
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-${locale}-welcome.png` });
      await page.locator('[data-luna-choice="no"]').click();
      await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(async () => (await window.nocturneApp.db.get('settings', 'luna-tutorial')).status), 'skipped');
      assert.equal(await page.evaluate(() => window.nocturneApp.state.docs.length), 0, 'Declining must not create manuscripts');
      await page.reload(); await page.waitForFunction(() => window.nocturneApp?.startupInteractionReady);
      assert.equal(await page.locator('#luna-tutorial, #language-onboarding').count(), 0);
    });
  }
} finally {
  await browser?.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
