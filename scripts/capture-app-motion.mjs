import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const url = 'http://localhost:5296', directory = 'release/qa/app-motion';
await mkdir(directory, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5296', SYNC_PORT: '8896' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true }), results = [];
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, recordVideo: { dir: directory } });
    const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Глава 1. Дом у воды', ''); await a.createDoc(a.defaultFolderId(), 'Глава 2. Обратная дорога', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>Тихий дождь за окном. Здесь начинается рукопись.</p>'); await a.saveActiveDoc({ silent: true });
    });
    const shot = async name => {
      await page.screenshot({ path: `${directory}/${name}.png`, animations: 'allow' });
      const data = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, ghosts: document.querySelectorAll('.surface-exit-ghost').length }));
      assert.equal(data.overflow, false, name); results.push({ name, ...data });
    };
    if (mobile) {
      for (const tab of ['docs', 'lore', 'more', 'write', 'docs']) {
        await page.evaluate(tab => window.nocturneApp.switchMobileTab(tab), tab); await page.waitForTimeout(90); await shot(`mobile-${tab}-mid`); await page.waitForTimeout(350);
      }
      await page.locator('.mobile-folder-head').first().click(); await page.waitForTimeout(85); await shot('mobile-folder-collapse-mid'); await page.waitForTimeout(350);
      await page.locator('.mobile-folder-head').first().click(); await page.waitForTimeout(350);
      await page.evaluate(() => window.nocturneApp.openSettingsTab('dictionary')); await page.waitForTimeout(400); await shot('mobile-dictionary');
      await page.evaluate(() => window.nocturneApp.mobileBack()); await page.waitForTimeout(100); await shot('mobile-settings-back-mid');
    } else {
      await page.evaluate(() => window.nocturneApp.toggleSplitMode()); await page.waitForTimeout(100); await shot('desktop-split-mid'); await page.waitForTimeout(400);
      await page.evaluate(() => window.nocturneApp.closeSecondaryPane()); await page.waitForTimeout(400);
      await page.evaluate(() => window.nocturneApp.openSettingsTab('visual')); await page.waitForTimeout(400);
      for (const tab of ['editor', 'dictionary', 'review', 'focus', 'macros', 'formatting', 'ai', 'data', 'export', 'misc', 'visual']) {
        await page.locator(`[data-settings-tab="${tab}"]`).click(); await page.waitForTimeout(80); await shot(`desktop-settings-${tab}-mid`); await page.waitForTimeout(350);
      }
      await page.evaluate(() => document.getElementById('settings-overlay').classList.remove('active'));
      await page.evaluate(() => window.nocturneApp.openKb('characters')); await page.waitForTimeout(400);
      for (const tab of ['locations', 'timeline', 'notes', 'characters']) { await page.locator(`#kb-modal [data-kb-tab="${tab}"]`).click(); await page.waitForTimeout(85); await shot(`desktop-knowledge-${tab}-mid`); await page.waitForTimeout(350); }
      await page.evaluate(() => document.getElementById('kb-modal').classList.remove('active')); await page.waitForTimeout(350);
      await page.evaluate(() => window.nocturneApp.commandPalette.open()); await page.waitForTimeout(350); await shot('desktop-commands');
      await page.locator('[data-command-palette-input]').fill('несуществующая команда'); await page.waitForTimeout(90); await shot('desktop-command-filter-mid'); await page.waitForTimeout(350);
      await page.evaluate(() => window.nocturneApp.commandPalette.close()); await page.waitForTimeout(65); await shot('desktop-command-exit-mid'); await page.waitForTimeout(350);
      await page.evaluate(() => window.nocturneApp.openFolderForm()); await page.waitForTimeout(350); await page.evaluate(() => window.nocturneApp.openDocForm(window.nocturneApp.defaultFolderId())); await page.waitForTimeout(85); await shot('desktop-form-resize-mid'); await page.waitForTimeout(400);
      await page.evaluate(() => document.getElementById('form-overlay').classList.remove('active')); await page.waitForTimeout(350);
      await page.evaluate(() => { const a = window.nocturneApp; a.state.reviewMode = 'editor'; a.renderReviewToolbarSlot(); }); await page.waitForTimeout(90); await shot('desktop-review-tools-mid'); await page.waitForTimeout(350);
      await page.evaluate(() => { const a = window.nocturneApp; a.togglePanel('ai-panel'); a.getFocusedDoc().ast.blocks[0].html = 'Тихо. Спокойно.'; a.drawSentiment(true); }); await page.waitForTimeout(450);
      await page.evaluate(() => { const a = window.nocturneApp; a.getFocusedDoc().ast.blocks[0].html = 'Огонь. Страх.'; a.drawSentiment(true); }); await page.waitForTimeout(85); await shot('desktop-sentiment-mid'); await page.waitForTimeout(350);
      await page.evaluate(() => { const a = window.nocturneApp; a.togglePanel('ai-panel'); a.state.settings.autoPaginate = true; a.nocturneEditor.get('primary').commands.setContent('<p>Новая страница рукописи.</p>'.repeat(90)); a.nocturneEditor.scheduleVisualPages('primary'); }); await page.waitForTimeout(450); await shot('desktop-paper-pages');
    }
    assert.deepEqual(errors, []); const video = page.video(); await context.close(); await video.saveAs(`${directory}/${mobile ? 'mobile' : 'desktop'}-application.webm`);
  }
  await writeFile(`${directory}/frames.json`, JSON.stringify(results, null, 2));
  console.log(`Recorded application transitions and ${results.length} states without page errors or horizontal overflow.`);
} finally { await browser.close(); server.kill(); }
