import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const url = 'http://localhost:5293', directory = 'release/qa/surface-motion';
await mkdir(directory, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5293', SYNC_PORT: '8893' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const measurements = [];
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, recordVideo: { dir: directory, size: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 } } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    const shot = async name => {
      await page.screenshot({ path: `${directory}/${name}.png`, animations: 'allow' });
      measurements.push({ name, ...await page.evaluate(() => {
        const surface = document.querySelector('#form-overlay.active .form-modal') || document.querySelector('#mobile-overlay.active .mobile-panel');
        const rect = surface?.getBoundingClientRect();
        const body = document.querySelector('.mobile-sync-body');
        return { width: rect?.width, height: rect?.height, top: rect?.top, bottom: rect?.bottom, viewport: innerHeight, bodyHeight: body?.clientHeight, bodyScroll: body?.scrollHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1, ghosts: document.querySelectorAll('.surface-exit-ghost').length };
      }) });
    };
    if (mobile) {
      await page.evaluate(() => window.nocturneApp.openMobilePanel('sync', 'more'));
      await page.waitForTimeout(450); await shot('mobile-search');
      await page.locator('[data-action="sync-toggle-manual"]').click();
      await page.waitForTimeout(80); await shot('mobile-manual-mid');
      await page.waitForTimeout(400); await page.locator('[data-sync-field="token"]').fill('MYCODE1234');
      await page.locator('[data-action="sync-toggle-options"]').click(); await page.waitForTimeout(400);
      await shot('mobile-manual-options');
      await page.setViewportSize({ width: 390, height: 510 }); await page.waitForTimeout(300);
      await page.locator('[data-sync-field="token"]').focus(); await shot('mobile-small-viewport');
    } else {
      await page.evaluate(async () => {
        const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Глава 1. Дом у воды', ''); await a.openBackups();
        const create = a.backups.create.bind(a.backups);
        a.backups.create = async (...args) => { await new Promise(resolve => setTimeout(resolve, 350)); return create(...args); };
      });
      await page.waitForTimeout(450); await page.locator('[data-backup-create]').click(); await shot('desktop-backup-busy');
      await page.waitForFunction(() => document.querySelectorAll('[data-backup-restore]').length === 1);
      await page.waitForTimeout(80); await shot('desktop-backup-row-mid');
      await page.waitForTimeout(400);
      await page.evaluate(() => window.nocturneApp.openSyncPanel()); await page.waitForTimeout(80); await shot('desktop-modal-change-mid');
      await page.waitForTimeout(400); await page.locator('[data-action="sync-server-start"]').click();
      try {
        await page.waitForSelector('[data-sync-pairing-code]'); await page.waitForTimeout(90); await shot('desktop-pairing-mid');
        await page.waitForTimeout(450); await shot('desktop-pairing');
        await page.locator('[data-action="sync-toggle-options"]').evaluate(button => button.click());
        await page.waitForTimeout(80); await shot('desktop-options-mid');
        await page.waitForTimeout(400); await shot('desktop-options');
        await page.locator('[data-action="sync-toggle-options"]').evaluate(button => button.click());
        await page.waitForTimeout(65); await shot('desktop-options-close-mid');
        await page.waitForTimeout(400);
      } finally { await page.evaluate(() => window.nocturneApp.controlLanServer('stop')); }
      await page.evaluate(() => { const a = window.nocturneApp; document.getElementById('form-overlay').classList.remove('active'); a.state.settings.theme = 'paper'; a.applySettings(); a.openBookExport(); });
      await page.waitForTimeout(450); await shot('paper-book');
    }
    assert.deepEqual(errors, []);
    const video = page.video(); await context.close(); await video.saveAs(`${directory}/${mobile ? 'mobile' : 'desktop'}-transitions.webm`);
  }
  assert.equal(measurements.some(frame => frame.overflow), false);
  await writeFile(`${directory}/frames.json`, JSON.stringify(measurements, null, 2));
  console.log(`Motion screenshots, desktop/mobile recordings and geometry saved in ${directory}; no page errors or horizontal overflow.`);
} finally { await browser.close(); server.kill(); }
