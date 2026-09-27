import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5281, url = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
await mkdir('release/qa', { recursive: true });
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  for (const width of [1440, 1280, 1024, 768, 390, 360]) {
    const context = await browser.newContext({ viewport: { width, height: width < 800 ? 844 : 900 }, isMobile: width < 800, hasTouch: width < 800 });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForFunction(() => window.nocturneApp?.databaseSync);
    await page.waitForSelector('.app-shell.ready');
    await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Глава 1. Тихий город', 'Возвращение героини домой.');
      a.nocturneEditor.get('primary').commands.setContent('<h2>Тихий город</h2><p>Ночь пахла дождём. На площади ещё горели фонари, и в их свете медленно кружились первые листья.</p><p>Она остановилась у знакомой двери. За дверью кто-то играл на старом пианино.</p>');
      await a.saveActiveDoc({ silent: true });
    });
    await page.waitForTimeout(450);
    await page.screenshot({ path: `release/qa/writing-${width}.png` });
    const layout = await page.evaluate(() => {
      const toolbar = document.querySelector('.toolbar'), visible = element => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
      const buttons = [...toolbar.querySelectorAll('button')].filter(visible).map(element => ({ title: element.title || element.textContent.trim(), rect: element.getBoundingClientRect().toJSON() }));
      const overlaps = [];
      for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i].rect, b = buttons[j].rect;
        if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2) overlaps.push([buttons[i].title, buttons[j].title]);
      }
      return { horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, overlaps };
    });
    if (width < 800) {
      await page.evaluate(() => window.nocturneApp.switchMobileTab('docs')); await page.waitForTimeout(300);
      await page.screenshot({ path: `release/qa/library-${width}.png` });
      await page.evaluate(() => window.nocturneApp.switchMobileTab('lore')); await page.waitForTimeout(300);
      await page.screenshot({ path: `release/qa/knowledge-${width}.png` });
      await page.evaluate(() => window.nocturneApp.switchMobileTab('more'));
    }
    await page.evaluate(() => window.nocturneApp.openBookExport()); await page.waitForTimeout(250);
    await page.screenshot({ path: `release/qa/book-export-${width}.png` });
    const modal = await page.evaluate(() => { const rect = document.querySelector('.utility-modal').getBoundingClientRect(); return { width: rect.width, right: rect.right, bottom: rect.bottom, viewportHeight: innerHeight }; });
    results.push({ width, ...layout, modal, errors });
    await context.close();
  }
  await writeFile('release/qa/ui-results.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (!process.argv.includes('--capture-only')) {
    for (const result of results) { assert.equal(result.horizontalOverflow, false); assert.deepEqual(result.overlaps, []); assert.deepEqual(result.errors, []); assert.ok(result.modal.right <= result.width + 1); }
  }
} finally { await browser.close(); server.kill(); }
