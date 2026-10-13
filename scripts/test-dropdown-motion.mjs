import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort } from './qa/runner.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/dropdown-motion');
const port = await availablePort(), url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
const results = [];
let browser;
await mkdir(directory, { recursive: true });

async function check(profile, name, run, options = {}) {
  const mobile = profile === 'android';
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, ...options });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(() => { window.nocturneApp.state.settings.automaticBackups = false; });
    await page.waitForTimeout(350);
    const evidence = await run(page);
    assert.deepEqual(errors, []);
    results.push({ name: `${profile}: ${name}`, passed: true, evidence });
  } catch (error) {
    results.push({ name: `${profile}: ${name}`, passed: false, error: error.stack, errors });
    await page.screenshot({ path: join(directory, `failure-${results.length}.png`) }).catch(() => {});
  } finally {
    console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${results.at(-1).name}${results.at(-1).error ? '\n' + results.at(-1).error : ''}`);
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
    await context.close();
  }
}

async function dictionary(page) {
  await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.smartDictionary = true; a.openSettingsTab('dictionary'); });
  await page.waitForTimeout(450);
}

function interpolates(frames, opening) {
  assert.ok(frames.some(frame => frame.opacity > .02 && frame.opacity < .98), 'A visible intermediate frame must exist');
  assert.ok(opening ? frames.at(-1).opacity > .99 : frames.at(-1).opacity < .01, 'Motion reaches its final state');
  for (let i = 1; i < frames.length; i++) assert.ok(opening ? frames[i].opacity >= frames[i - 1].opacity - .02 : frames[i].opacity <= frames[i - 1].opacity + .02, 'Opacity moves continuously in one direction');
}

try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const profile of ['desktop', 'android'].filter(value => !process.env.NOCTURNE_QA_PLATFORM || process.env.NOCTURNE_QA_PLATFORM === 'all' || process.env.NOCTURNE_QA_PLATFORM === value)) {
    await check(profile, 'select fades and moves on entry and exit with stable position', async page => {
      await dictionary(page);
      const evidence = await page.evaluate(async () => {
        const a = window.nocturneApp, select = a.settingsSurfaceRoot().querySelector('[data-setting-select="smartDictionaryMode"]'), menu = select.querySelector('.nocturne-select-menu');
        const sample = async duration => { const values = [], start = performance.now(); do { const style = getComputedStyle(menu); values.push({ opacity: Number(style.opacity), transform: style.transform, left: menu.style.left, top: menu.style.top }); await new Promise(requestAnimationFrame); } while (performance.now() - start < duration); values.push({ opacity: Number(getComputedStyle(menu).opacity), transform: getComputedStyle(menu).transform, left: menu.style.left, top: menu.style.top }); return values; };
        a.toggleSettingsSelect(select); const opening = await sample(320);
        const bounds = menu.getBoundingClientRect().toJSON();
        a.closeSettingsSelects(); const closing = await sample(220);
        return { opening, closing, bounds, hidden: menu.hidden, inert: menu.inert, open: select.classList.contains('open'), width: innerWidth, height: innerHeight };
      });
      interpolates(evidence.opening, true); interpolates(evidence.closing, false);
      assert.ok(evidence.opening.some(frame => frame.transform !== evidence.opening.at(-1).transform), 'The surface settles into place');
      assert.equal(new Set(evidence.opening.map(frame => `${frame.left}:${frame.top}`)).size, 1, 'Layout position stays fixed during entry');
      assert.ok(evidence.hidden && evidence.inert && !evidence.open);
      assert.ok(evidence.bounds.x >= 0 && evidence.bounds.right <= evidence.width && evidence.bounds.bottom <= evidence.height);
      await page.locator('[data-setting-select="smartDictionaryMode"]:visible .nocturne-select-trigger').click();
      await page.waitForTimeout(300);
      await page.locator('[data-setting-select="smartDictionaryMode"]:visible .nocturne-select-menu').screenshot({ path: join(directory, `${profile}-select.png`) });
      return evidence;
    });
    await check(profile, 'reopening interrupts closing without a jump or stale hide', async page => {
      await dictionary(page);
      const evidence = await page.evaluate(async () => {
        const a = window.nocturneApp, select = a.settingsSurfaceRoot().querySelector('[data-setting-select="smartDictionaryLang"]'), menu = select.querySelector('.nocturne-select-menu');
        a.toggleSettingsSelect(select); await new Promise(resolve => setTimeout(resolve, 70));
        const beforeClose = Number(getComputedStyle(menu).opacity);
        a.closeSettingsSelects(); const afterClose = Number(getComputedStyle(menu).opacity);
        await new Promise(resolve => setTimeout(resolve, 55));
        const beforeReopen = Number(getComputedStyle(menu).opacity);
        a.toggleSettingsSelect(select); const afterReopen = Number(getComputedStyle(menu).opacity);
        await new Promise(resolve => setTimeout(resolve, 400));
        return { beforeClose, afterClose, beforeReopen, afterReopen, opacity: Number(getComputedStyle(menu).opacity), hidden: menu.hidden, inert: menu.inert, open: select.classList.contains('open'), visibility: getComputedStyle(menu).visibility };
      });
      assert.ok(Math.abs(evidence.beforeClose - evidence.afterClose) < .04);
      assert.ok(Math.abs(evidence.beforeReopen - evidence.afterReopen) < .04);
      assert.ok(evidence.open && !evidence.hidden && !evidence.inert && evidence.opacity > .99 && evidence.visibility === 'visible');
      return evidence;
    });
    await check(profile, 'form options, Escape, focus return and outside click still work', async page => {
      await page.evaluate(() => window.nocturneApp.openTypoRuleForm('вообщем'));
      await page.waitForTimeout(450);
      const select = page.locator('.typo-rule-modal .form-select:has(input[name="mode"])');
      await select.locator('.nocturne-select-trigger').click();
      await select.locator('[data-form-option][data-value="phrase"]').click();
      assert.equal(await select.locator('input').inputValue(), 'phrase');
      await select.locator('.nocturne-select-trigger').click();
      await select.locator('[data-form-option]').first().focus();
      await page.keyboard.press('Escape');
      await page.waitForTimeout(220);
      assert.equal(await select.locator('.nocturne-select-trigger').evaluate(node => node === document.activeElement), true);
      assert.equal(await select.evaluate(node => node.classList.contains('open')), false);
      await select.locator('.nocturne-select-trigger').click();
      await page.locator('#typo-wrong').click();
      await page.waitForFunction(() => document.getElementById('form-select-typo-mode').hidden);
      assert.equal(await select.locator('.nocturne-select-menu').evaluate(node => node.hidden), true);
    });
    await check(profile, 'toolbar menus animate once and never change layout position while settling', async page => {
      await page.evaluate(async () => {
        const a = window.nocturneApp;
        await a.createDoc(a.defaultFolderId(), 'Проверка меню', '');
        if (a.isMobileLayout()) { a.nocturneEditor.get('primary').commands.setContent('<p>Проверка мобильных меню.</p>'); a.nocturneEditor.get('primary').commands.focus('end'); }
        else a.setReviewMode('editor');
      });
      await page.waitForTimeout(500);
      const evidence = await page.evaluate(async () => {
        const a = window.nocturneApp, values = [], unavailable = [];
        for (const key of ['library', 'kb', 'mode', 'format', 'search', 'split', 'notes', 'review', 'bookmarkPane']) {
          const anchor = a.floatingMenuAnchor(key), surface = a.floatingMenuSurface(key), rect = anchor?.getBoundingClientRect();
          if (!surface || !rect?.width || !rect.height) { unavailable.push(key); continue; }
          a.openFloatingMenu(key);
          const frames = [], start = performance.now();
          do { frames.push({ opacity: Number(getComputedStyle(surface).opacity), left: surface.style.left, top: surface.style.top }); await new Promise(requestAnimationFrame); } while (performance.now() - start < 320);
          const bounds = surface.getBoundingClientRect().toJSON();
          const keyframes = surface.getAnimations().filter(animation => animation.constructor.name === 'CSSAnimation').length;
          a.closeFloatingMenu(key);
          const closing = [], exit = performance.now();
          do { closing.push({ opacity: Number(getComputedStyle(surface).opacity) }); await new Promise(requestAnimationFrame); } while (performance.now() - exit < 220);
          values.push({ key, frames, closing, bounds, keyframes, width: innerWidth });
        }
        return { values, unavailable };
      });
      assert.ok(evidence.values.length > 0);
      for (const value of evidence.values) {
        interpolates(value.frames, true); interpolates(value.closing, false);
        assert.equal(new Set(value.frames.map(frame => `${frame.left}:${frame.top}`)).size, 1, `${value.key}: no position jump`);
        assert.equal(value.keyframes, 0, `${value.key}: no competing keyframe animation`);
        assert.ok(value.bounds.x >= -1 && value.bounds.right <= value.width + 1, `${value.key}: menu fits viewport`);
      }
      return evidence;
    });
    await check(profile, 'project switcher and contextual menus retain smooth entry and exit', async page => {
      await page.evaluate(async () => { const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Контекст меню', ''); });
      await page.waitForTimeout(400);
      const contextMotion = await page.evaluate(async () => {
        const a = window.nocturneApp, menu = document.getElementById('app-context-menu');
        a.state.contextMenu = { x: 30, y: 90, docId: a.getFocusedDoc().id, paneId: 'primary', reviewMode: 'write', selectedText: '' }; a.renderContextMenu();
        const opening = [], start = performance.now();
        do { opening.push({ opacity: Number(getComputedStyle(menu).opacity) }); await new Promise(requestAnimationFrame); } while (performance.now() - start < 320);
        a.closeContextMenu(); const closing = [], exit = performance.now();
        do { closing.push({ opacity: Number(getComputedStyle(menu).opacity) }); await new Promise(requestAnimationFrame); } while (performance.now() - exit < 220);
        return { opening, closing };
      });
      interpolates(contextMotion.opening, true); interpolates(contextMotion.closing, false);
      await page.evaluate(() => { const a = window.nocturneApp; if (a.isMobileLayout()) a.switchMobileTab('lore'); else a.openKb('characters'); });
      await page.waitForTimeout(500);
      const switcher = page.locator('.kb-project-switcher:visible').first();
      await switcher.locator(':scope > span').click();
      await page.waitForTimeout(300);
      assert.equal(await switcher.evaluate(node => node.classList.contains('open')), true);
      await switcher.locator(':scope > span').click();
      await page.waitForTimeout(220);
      assert.equal(await switcher.locator('.kb-project-switcher-dropdown').evaluate(node => getComputedStyle(node).visibility), 'hidden');
      return contextMotion;
    });
    await check(profile, 'reduced motion leaves usable menus without animated movement', async page => {
      await dictionary(page);
      const evidence = await page.evaluate(async () => {
        const a = window.nocturneApp, select = a.settingsSurfaceRoot().querySelector('[data-setting-select="smartDictionaryMode"]'), menu = select.querySelector('.nocturne-select-menu');
        a.toggleSettingsSelect(select); await new Promise(requestAnimationFrame);
        const open = { opacity: Number(getComputedStyle(menu).opacity), transform: getComputedStyle(menu).transform, animations: menu.getAnimations().filter(animation => animation.playState === 'running').length };
        a.closeSettingsSelects(); return { open, hidden: menu.hidden, inert: menu.inert };
      });
      assert.equal(evidence.open.opacity, 1); assert.equal(evidence.open.transform, 'none'); assert.equal(evidence.open.animations, 0); assert.ok(evidence.hidden && evidence.inert);
      return evidence;
    }, { reducedMotion: 'reduce' });
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
} finally { await browser?.close(); server.kill(); }
