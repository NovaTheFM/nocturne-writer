import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const url = 'http://localhost:5291';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5291', SYNC_PORT: '8891' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const directory = 'release/qa/interface-revision';
await mkdir(directory, { recursive: true });
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const shot = async name => { await page.waitForTimeout(250); await page.screenshot({ path: `${directory}/${name}.png` }); };
  await page.goto(url); await page.waitForSelector('.app-shell.ready');
  await shot('desktop-empty');
  await page.evaluate(async () => {
    const a = window.nocturneApp;
    for (const title of ['Пролог. Последнее письмо', 'Глава 1. Тихий город', 'Глава 2. Дом у воды']) await a.createDoc(a.defaultFolderId(), title, '');
    a.nocturneEditor.get('primary').commands.setContent('<h2>Дом у воды</h2><p>Она вернулась к реке на рассвете. В окнах старого дома ещё горел свет, и это было единственным знаком, что письмо дошло.</p><p>Над водой медленно поднимался туман. За дверью кто-то тихо играл на пианино.</p>'); await a.saveActiveDoc({ silent: true });
  });
  assert.equal(await page.locator('#library-menu').isVisible(), false);
  await shot('desktop-writing');
  await page.locator('[data-action="toggle-library-menu"]').click(); await shot('desktop-tools');
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.nocturneApp.openBookExport()); await shot('desktop-book');
  await page.evaluate(async () => { const a = window.nocturneApp; await a.backups.create(); await a.openBackups(); }); await shot('desktop-backups');
  await page.evaluate(() => window.nocturneApp.openSyncPanel()); await shot('desktop-sync-start');
  await page.locator('[data-action="sync-server-start"]').click();
  try {
    await page.waitForSelector('[data-sync-pairing-code]'); await shot('desktop-sync-code');
    await page.locator('[data-action="sync-toggle-options"]').click(); await shot('desktop-sync-options');
  } finally { await page.evaluate(() => window.nocturneApp.controlLanServer('stop')); }
  for (const mode of ['editor', 'finalization']) {
    await page.evaluate(mode => { const a = window.nocturneApp; document.getElementById('form-overlay').classList.remove('active'); a.setReviewMode(mode); }, mode);
    await shot(`desktop-${mode}`);
  }
  await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.theme = 'paper'; a.applySettings(); a.openBookExport(); }); await shot('paper-book');
  assert.deepEqual(errors, []);
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await mobileContext.newPage(), mobileErrors = [];
  mobile.on('pageerror', error => mobileErrors.push(error.message));
  await mobile.goto(url); await mobile.waitForSelector('.app-shell.ready');
  await mobile.evaluate(() => window.nocturneApp.openMobilePanel('sync', 'more'));
  await mobile.screenshot({ path: `${directory}/mobile-sync-search.png` });
  await mobile.locator('[data-action="sync-toggle-manual"]').click();
  await mobile.locator('[data-sync-field="host"]').fill('192.168.1.10');
  await mobile.screenshot({ path: `${directory}/mobile-sync-manual.png` });
  await mobile.setViewportSize({ width: 390, height: 430 });
  await mobile.waitForTimeout(300);
  await mobile.locator('[data-sync-field="token"]').fill('CODE1234');
  await mobile.screenshot({ path: `${directory}/mobile-sync-keyboard.png` });
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  assert.deepEqual(mobileErrors, []);
  console.log(`Interface captures saved in ${directory}; desktop, both review modes, paper theme and mobile connection checked.`);
} finally { await browser.close(); server.kill(); }
