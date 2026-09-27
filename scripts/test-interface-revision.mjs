import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const url = 'http://localhost:5290';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5290', SYNC_PORT: '8890' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function check(name, run, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  try { await page.goto(url); await page.waitForSelector('.app-shell.ready'); await run(page); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.message }); }
  finally { await context.close(); }
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  await check('chapter world selector uses the app dropdown and keyboard selection persists', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.db.put('lore', { ...structuredClone(a.state.lore), id: 'revision-world', title: 'Второй мир' });
      a.state.kbProjects.push({ id: 'revision-world', title: 'Второй мир' });
      a.openDocForm(a.defaultFolderId());
    });
    const dropdown = page.locator('#form-overlay .nocturne-select').filter({ has: page.locator('input[name="loreId"]') });
    assert.equal(await dropdown.count(), 1, 'World picker must reuse Nocturne select');
    await dropdown.locator('button[data-form-select-toggle]').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    assert.equal(await dropdown.locator('input[name="loreId"]').inputValue(), 'revision-world');
    await page.locator('#form-overlay input[name="title"]').fill('Связанная глава');
    await page.locator('#form-overlay button[type="submit"]').click();
    await page.waitForFunction(() => window.nocturneApp.state.docs.length === 1);
    assert.equal(await page.evaluate(() => window.nocturneApp.state.docs[0].loreId), 'revision-world');
  });
  await check('library tools share the app menu and Escape returns to its trigger', async page => {
    const trigger = page.locator('[data-action="toggle-library-menu"]');
    assert.equal(await trigger.count(), 1, 'One labelled tools menu is required');
    assert.equal(await page.locator('#library-menu').isVisible(), false, 'Closed tools must not cover the library');
    await trigger.focus(); await page.keyboard.press('Enter');
    await page.waitForSelector('#library-menu.active');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape');
    await page.waitForSelector('#library-menu', { state: 'hidden' });
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
    await trigger.click();
    await page.locator('#library-menu [data-action="open-backups"]').click();
    await page.waitForSelector('#form-overlay.active');
    assert.match(await page.locator('#form-overlay h2').innerText(), /Резервные копии/);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  });
  await check('connection starts from one action; detailed controls appear on request', async page => {
    await page.evaluate(() => window.nocturneApp.openSyncPanel());
    const options = page.locator('[data-action="sync-toggle-options"]');
    assert.equal(await options.count(), 1, 'Connection options must be disclosed separately');
    assert.equal(await options.getAttribute('aria-expanded'), 'false');
    await page.locator('[data-action="sync-server-start"]').click();
    try {
      await page.waitForFunction(() => window.nocturneApp.state.sync.server.running);
      await page.waitForSelector('[data-sync-pairing-code]');
      assert.equal(await page.locator('[data-sync-pairing-code]').count(), 1);
      await options.click();
      await page.locator('[data-action="sync-server-stop"]').click();
      await page.waitForFunction(() => !window.nocturneApp.state.sync.server.running);
    } finally { await page.evaluate(() => window.nocturneApp.controlLanServer('stop')); }
  });
  await check('book selection uses app checks and keyboard can exclude a chapter', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Первая глава', '');
      await a.createDoc(a.defaultFolderId(), 'Вторая глава', ''); a.openBookExport();
    });
    const checks = page.locator('.chapter-selection .nocturne-check');
    assert.equal(await checks.count(), 2, 'Chapter picker must reuse Nocturne checks');
    const input = checks.first().locator('input');
    await input.focus(); await page.keyboard.press('Space');
    assert.equal(await input.isChecked(), false);
    assert.equal(await checks.last().locator('input').isChecked(), true);
  });
  await check('mobile connection status refresh preserves the code input and keyboard focus', async page => {
    await page.evaluate(() => { const a = window.nocturneApp; a.state.sync.discovery.manualOpen = true; a.openMobilePanel('sync', 'more'); });
    await page.locator('[data-sync-field="token"]').fill('MYCODE');
    await page.evaluate(() => { const a = window.nocturneApp; a.state.sync.status = 'waiting'; a.renderSyncSurfaces(); });
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.syncField), 'token');
    await page.keyboard.type('123');
    assert.equal(await page.locator('[data-sync-field="token"]').inputValue(), 'MYCODE123');
  }, true);
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.passed)) process.exitCode = 1;
} finally { await browser.close(); server.kill(); }
