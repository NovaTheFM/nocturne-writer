import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = 5288, server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://localhost:${port}`); await page.waitForSelector('.app-shell.ready');
  await page.evaluate(() => window.nocturneApp.openDocForm(window.nocturneApp.defaultFolderId()));
  await page.locator('#form-overlay [name="title"]').fill('Mobile chapter without description');
  await page.locator('#form-overlay button[type="submit"]').click();
  await page.waitForFunction(() => window.nocturneApp.state.docs.length === 1);
  await page.evaluate(() => window.nocturneApp.openBookExport());
  await page.setViewportSize({ width: 390, height: 430 });
  const keyboard = await page.evaluate(() => {
    const modal = document.querySelector('#form-overlay .utility-modal').getBoundingClientRect();
    return { top: modal.top, bottom: modal.bottom, viewport: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
  });
  assert.ok(keyboard.top >= 0 && keyboard.bottom <= keyboard.viewport + 1, JSON.stringify(keyboard)); assert.equal(keyboard.overflow, false);
  assert.equal(await page.evaluate(() => window.nocturneApp.closeTopMobileOverlay()), true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.nocturneApp.switchMobileTab('lore'));
  await page.locator('[data-mobile-kb-tab="notes"]').click();
  assert.equal(await page.evaluate(() => window.nocturneApp.state.mobile.kbTab), 'notes');
  assert.equal(await page.evaluate(() => window.nocturneApp.closeTopMobileOverlay()), true);
  assert.equal(await page.evaluate(() => window.nocturneApp.state.mobile.activeTab), 'write');
  await page.setViewportSize({ width: 812, height: 390 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.evaluate(() => window.nocturneApp.openMobilePanel('sync', 'more'));
  assert.equal(await page.evaluate(() => window.nocturneApp.closeTopMobileOverlay()), true);
  assert.deepEqual(errors, []);
  console.log('Mobile: real chapter form without required description, keyboard-size viewport, landscape, world notes, modal/back navigation and reduced-motion context passed.');
} finally { await browser.close(); server.kill(); }
