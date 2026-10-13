import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort, killOwnedProcess } from './qa/runner.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/dictionary-menu-interaction');
const port = await availablePort(), url = `http://127.0.0.1:${port}`, results = [];
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let browser;
await mkdir(directory, { recursive: true });

async function check(profile, name, run) {
  const mobile = profile === 'android';
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(async () => {
      const a = window.nocturneApp; a.state.settings.automaticBackups = false;
      await a.createDoc(a.defaultFolderId(), 'Проверка меню словаря', '');
      const original = window.fetch.bind(window);
      window.fetch = async (url, options) => {
        if (!String(url).includes('api.languagetool.org')) return original(url, options);
        const text = new URLSearchParams(options.body).get('text'), start = text.indexOf('adress');
        return { ok: true, json: async () => ({ matches: start < 0 ? [] : [{ offset: start, length: 6, replacements: [{ value: 'address' }, { value: 'dress' }], rule: { issueType: 'misspelling', category: { name: 'Spelling' } } }] }) };
      };
      a.state.settings.smartDictionary = true; a.state.settings.strictSpellcheck = false;
      a.state.settings.smartDictionaryMode = 'api'; a.state.settings.smartDictionaryLang = 'en';
      const editor = a.nocturneEditor.get('primary'); editor.commands.setContent('<p>The adress is wrong.</p>'); editor.commands.blur();
      a.nocturneEditor.syncDocFromEditor('primary'); a.applySettingSideEffects('smartDictionaryMode');
    });
    await page.waitForFunction(() => window.nocturneApp.typoMatchIndex.some(match => match.rawText === 'adress'));
    await run(page, mobile);
    assert.deepEqual(errors, []);
    results.push({ name: `${profile}: ${name}`, passed: true });
  } catch (error) {
    results.push({ name: `${profile}: ${name}`, passed: false, error: error.stack, errors });
    await page.screenshot({ path: join(directory, `failure-${results.length}.png`) }).catch(() => {});
  } finally {
    console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${results.at(-1).name}${results.at(-1).error ? '\n' + results.at(-1).error : ''}`);
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
    await context.close();
  }
}

async function openDictionary(page) {
  await page.evaluate(() => window.nocturneApp.openSettingsTab('dictionary'));
  await page.waitForTimeout(450);
  return page.locator('[data-setting-select="smartDictionaryMode"]:visible').last();
}

async function dismissDictionary(page, mobile, method = 'button') {
  if (method === 'escape' && !mobile) await page.keyboard.press('Escape');
  else if (method === 'direct') await page.evaluate(mobile => {
    const a = window.nocturneApp;
    if (mobile) a.closeMobilePanel({ restore: false });
    else a.closeOverlay(document.getElementById('settings-overlay'));
  }, mobile);
  else await page.locator(mobile ? '#mobile-overlay [data-action="mobile-close-all"]' : '#settings-overlay [data-action="close-settings"]').click();
  await page.waitForTimeout(450);
}

try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const profile of ['desktop', 'android'].filter(value => !process.env.NOCTURNE_QA_PLATFORM || process.env.NOCTURNE_QA_PLATFORM === 'all' || process.env.NOCTURNE_QA_PLATFORM === value)) {
    await check(profile, 'closed dictionary controls never intercept clicks or accept focus', async (page, mobile) => {
      for (const method of mobile ? ['button'] : ['button', 'escape']) {
        const select = await openDictionary(page), trigger = select.locator('.nocturne-select-trigger');
        const bounds = await trigger.boundingBox();
        await dismissDictionary(page, mobile, method);
        const hit = await page.evaluate(({ x, y, width, height }) => {
          const node = document.elementFromPoint(x + width / 2, y + height / 2);
          return { hiddenSettings: !!node?.closest('#settings-overlay, #mobile-overlay'), html: node?.outerHTML.slice(0, 300) };
        }, bounds);
        assert.equal(hit.hiddenSettings, false, JSON.stringify(hit));
        await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        assert.equal(await page.locator('.nocturne-select.open').count(), 0);
        if (!mobile) assert.equal(await trigger.evaluate(node => { node.focus(); return document.activeElement === node; }), false);
      }
    });
    await check(profile, 'closing the owner tears down its native popover and reopening still selects modes', async (page, mobile) => {
      const select = await openDictionary(page);
      await select.locator('.nocturne-select-trigger').click();
      await page.waitForTimeout(280);
      assert.equal(await select.locator('.nocturne-select-menu').evaluate(node => node.matches(':popover-open')), true);
      await dismissDictionary(page, mobile, 'direct');
      assert.equal(await page.locator('.nocturne-select-menu:popover-open, .nocturne-select.open').count(), 0);
      const reopened = await openDictionary(page);
      await reopened.locator('.nocturne-select-trigger').click();
      await reopened.locator('[data-setting-option][data-value="hybrid"]').click();
      assert.equal(await page.evaluate(() => window.nocturneApp.state.settings.smartDictionaryMode), 'hybrid');
      assert.equal(await reopened.locator('.nocturne-select-trigger').getAttribute('aria-expanded'), 'false');
    });
    await check(profile, 'Back closes the native select completely and returns focus', async page => {
      const select = await openDictionary(page);
      await select.locator('.nocturne-select-trigger').click();
      await select.locator('[data-setting-option]').first().focus();
      await page.evaluate(() => window.nocturneApp.closeTopMobileOverlay());
      await page.waitForTimeout(220);
      const state = await select.evaluate(node => ({ open: node.classList.contains('open'), popover: node.querySelector('.nocturne-select-menu').matches(':popover-open'), hidden: node.querySelector('.nocturne-select-menu').hidden, inert: node.querySelector('.nocturne-select-menu').inert, focused: node.querySelector('.nocturne-select-trigger') === document.activeElement }));
      assert.deepEqual(state, { open: false, popover: false, hidden: true, inert: true, focused: true });
    });
    await check(profile, 'selects remain usable without the native Popover API', async (page, mobile) => {
      await page.evaluate(() => { HTMLElement.prototype.showPopover = undefined; HTMLElement.prototype.hidePopover = undefined; });
      const select = await openDictionary(page);
      await select.locator('.nocturne-select-trigger').click();
      assert.equal(await select.locator('.nocturne-select-menu').getAttribute('aria-hidden'), 'false');
      await dismissDictionary(page, mobile, 'direct');
      assert.equal(await page.locator('.nocturne-select.open').count(), 0);
      const reopened = await openDictionary(page);
      await reopened.locator('.nocturne-select-trigger').click();
      await reopened.locator('[data-setting-option][data-value="local"]').click();
      assert.equal(await page.evaluate(() => window.nocturneApp.state.settings.smartDictionaryMode), 'local');
    });
    await check(profile, 'suggestions hover, focus and replace text where the closed mode button used to be', async (page, mobile) => {
      const select = await openDictionary(page), bounds = await select.locator('.nocturne-select-trigger').boundingBox();
      await dismissDictionary(page, mobile);
      await page.evaluate(({ x, y }) => {
        const a = window.nocturneApp, match = a.typoMatchIndex.find(match => match.rawText === 'adress');
        a.state.contextMenu = { x, y, docId: match.docId, paneId: match.paneId, reviewMode: 'write', selectedText: '', typoMatch: match }; a.renderContextMenu();
      }, bounds);
      await page.waitForTimeout(300);
      const option = page.locator('#app-context-menu [data-typo-suggestion-index="0"]');
      await option.evaluate((node, bounds) => {
        const menu = node.closest('#app-context-menu'), itemRect = node.getBoundingClientRect(), menuRect = menu.getBoundingClientRect();
        menu.style.top = `${bounds.y + bounds.height / 2 - (itemRect.y - menuRect.y + itemRect.height / 2)}px`;
      }, bounds);
      const optionBounds = await option.boundingBox(), point = { x: bounds.x + bounds.width / 2, y: optionBounds.y + optionBounds.height / 2 };
      await page.mouse.move(point.x, point.y); await page.waitForTimeout(180);
      assert.equal(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-typo-suggestion-index]')?.dataset.typoSuggestionIndex, point), '0');
      const hover = await option.evaluate(node => ({ hovered: node.matches(':hover'), background: getComputedStyle(node).backgroundColor }));
      assert.ok(hover.hovered && hover.background !== 'rgba(0, 0, 0, 0)', JSON.stringify(hover));
      await page.mouse.move(0, 0); await page.keyboard.press('Tab'); await option.focus();
      await page.waitForTimeout(180);
      assert.equal(await option.evaluate(node => getComputedStyle(node).backgroundColor), hover.background);
      await page.screenshot({ path: join(directory, `${profile}-suggestion-focus.png`) });
      if (mobile) await page.touchscreen.tap(point.x, point.y); else await page.mouse.click(point.x, point.y);
      await page.waitForFunction(() => window.nocturneApp.nocturneEditor.get('primary').getText().includes('The address is wrong.'));
      assert.equal(await page.locator('.nocturne-select.open').count(), 0);
      assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').commands.undo()), true);
      assert.ok((await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText())).includes('The adress is wrong.'));
    });
  }
  if (results.some(result => !result.passed)) process.exitCode = 1;
} finally { await browser?.close(); await killOwnedProcess(server); }
