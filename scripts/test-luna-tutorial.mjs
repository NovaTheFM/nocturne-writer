import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5357, url = `http://localhost:${port}`;
const output = process.env.NOCTURNE_QA_DIR || 'release/qa/luna-tutorial';
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
  if (process.env.NOCTURNE_TUTORIAL_CASE && !name.includes(process.env.NOCTURNE_TUTORIAL_CASE)) {
    results.push({ name, mobile, status: 'SKIP', reason: 'Filtered by NOCTURNE_TUTORIAL_CASE' }); return;
  }
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, ...options });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10_000);
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

async function step(page, name) {
  await page.locator(`#luna-tutorial[data-step="${name}"]`).waitFor();
  await page.waitForFunction(() => !window.nocturneApp.lunaTutorial.changing && getComputedStyle(document.querySelector('.luna-dialog')).opacity > .99);
  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector('.luna-dialog').getBoundingClientRect(), mascot = document.querySelector('[data-luna-mascot]').getBoundingClientRect();
    return { x: dialog.x, y: dialog.y, right: dialog.right, bottom: dialog.bottom, mascotX: mascot.x, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, titles: document.querySelectorAll('#luna-tutorial h1, #luna-tutorial h2, .luna-dialog-header').length };
  });
  assert.ok(geometry.x >= 20 && geometry.right <= geometry.width - 20 && geometry.y >= 0 && geometry.bottom <= geometry.height, JSON.stringify(geometry));
  assert.ok(geometry.mascotX > geometry.right, 'Luna must be to the right of her speech');
  assert.equal(geometry.overflow, false); assert.equal(geometry.titles, 0);
  return page.locator('[data-luna-target]');
}

async function reachForm(page) {
  await page.locator('[data-luna-choice="yes"]').click();
  if (await page.evaluate(() => window.nocturneApp.lunaTutorial.step === 'open-docs')) {
    await (await step(page, 'open-docs')).click();
  }
  await (await step(page, 'create')).click();
  await step(page, 'create-form');
}

async function discoverFeatures(page, mobile) {
  const click = async name => (await step(page, name)).click();
  const next = async name => { await step(page, name); await page.locator('[data-luna-choice="next"]').click(); };
  const shot = async name => page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-${name}.png` });
  await next('write');
  if (mobile) await click('bookmarks-actions');
  await click('open-bookmarks'); await step(page, 'bookmarks'); await shot('bookmarks');
  await page.locator('[data-luna-choice="back"]').click(); await step(page, 'write');
  await next('write');
  if (mobile) await click('bookmarks-actions');
  await click('open-bookmarks'); await next('bookmarks');
  if (mobile) await click('more-notes');
  await click('open-notes'); await next('notes');
  await click('open-floating'); await step(page, 'floating'); await shot('floating'); await next('floating');
  await click('open-kb');
  if (!mobile) { await (await step(page, 'kb-menu')).focus(); await page.keyboard.press('Enter'); }
  await next('kb'); await click('open-world-search'); await step(page, 'world-search');
  await page.locator('[data-knowledge-query]:visible').fill('A real story');
  await shot('world-search'); await next('world-search');
  if (!mobile) await click('tools-commands');
  await click('open-commands'); await step(page, 'commands');
  await page.locator('[data-command-palette-input]').fill('history');
  await click('command-history'); await step(page, 'history'); await shot('history'); await next('history');
  await click('open-modes'); await click('choose-editor'); await step(page, 'editor-mode');
  assert.equal(await page.locator('.page-content-prosemirror').first().getAttribute('contenteditable'), 'false');
  await next('editor-mode'); await click('open-finalization'); await click('choose-finalization');
  await step(page, 'finalization'); await shot('review'); await next('finalization');
  if (mobile) await click('focus-actions');
  await click('enter-focus'); await step(page, 'focus');
  assert.equal(await page.evaluate(() => window.nocturneApp.state.zenActive), true);
  await shot('focus'); await next('focus');
  if (!mobile) { await click('open-split'); await step(page, 'split'); await shot('split'); await next('split'); }
  if (mobile) await click('more-search'); else await click('open-search-menu');
  await click('open-search'); await click('choose-project-search'); await step(page, 'project-search');
  await page.locator('#global-search-query').fill('A real story');
  await page.waitForFunction(() => document.querySelector('#global-search-results')?.textContent.includes('A real story'));
  await shot('manuscript-search'); await next('project-search');
  await click(mobile ? 'more-book' : 'tools-book'); await click('open-book');
  await step(page, 'book'); assert.equal(await page.locator('[data-export-chapter]').count(), 1);
  await shot('book'); await next('book');
  await click(mobile ? 'more-backups' : 'tools-backups'); await click('open-backups');
  await step(page, 'backups'); await shot('backups'); await next('backups');
  if (mobile) await click('more-settings');
  await click('open-settings'); await step(page, 'settings');
  if (mobile) {
    await page.evaluate(async () => await window.nocturneApp.interfaceLanguage.change('en'));
    await page.waitForFunction(() => document.querySelector('#luna-tutorial-text')?.textContent.startsWith('Change your language'));
  }
  await next('settings'); await click('open-macros'); await step(page, 'macros'); await shot('macros');
  await next('macros'); await click('open-formatting'); await step(page, 'formatting'); await shot('formatting');
  await next('formatting');
  assert.equal(await page.evaluate(() => window.nocturneApp.state.reviewMode), 'write');
  assert.equal(await page.evaluate(() => window.nocturneApp.state.zenActive), false);
  assert.equal(await page.evaluate(() => window.nocturneApp.state.workspace.mode), 'single');
  assert.deepEqual(await page.evaluate(async () => (await import('/src/core/i18n.js')).getMissingTranslations()), []);
}

try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) for (const locale of ['ru', 'uk', 'en']) {
    await scenario(`localized greeting and persistent No: ${locale}`, mobile, async page => {
      await page.goto(url); await choose(page, locale);
      const title = await page.locator('#luna-tutorial-text').textContent();
      assert.match(title, { ru: /Я Луна/, uk: /Я Луна/, en: /I’m Luna/ }[locale]);
      assert.equal(await page.locator('[data-luna-mascot]').count(), 1);
      assert.equal(await page.locator('[data-luna-choice="yes"]').count(), 1);
      assert.equal((await page.locator('[data-luna-choice="yes"]').textContent()).trim(), { ru: 'Да', uk: 'Так', en: 'Yes' }[locale]);
      assert.equal((await page.locator('[data-luna-choice="no"]').textContent()).trim(), { ru: 'Нет', uk: 'Ні', en: 'No' }[locale]);
      await step(page, 'welcome');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.lunaChoice), 'yes', 'Reverse Tab starts at the last button');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.lunaChoice), 'no', 'Tab wraps from the last button to the first');
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-${locale}-welcome.png` });
      await page.locator('[data-luna-choice="no"]').click();
      await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(async () => (await window.nocturneApp.db.get('settings', 'luna-tutorial')).status), 'skipped');
      assert.equal(await page.evaluate(() => window.nocturneApp.state.docs.length), 0, 'Declining must not create manuscripts');
      await page.reload(); await page.waitForFunction(() => window.nocturneApp?.startupInteractionReady);
      assert.equal(await page.locator('#luna-tutorial, #language-onboarding').count(), 0);
    });
  }
  for (const mobile of [false, true]) {
    await scenario('complete tour uses real controls and preserves written text', mobile, async page => {
      await page.goto(url); await choose(page, mobile ? 'uk' : 'en');
      await reachForm(page);
      await page.locator('#doc-form input[name="title"]').fill('My story — Моя історія');
      await page.locator('#doc-form button[type="submit"]').click();
      await step(page, 'write');
      const editor = page.locator('.page-content-prosemirror').first();
      await editor.press('Control+Home'); await page.keyboard.type('A real story.');
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-writing.png` });
      await discoverFeatures(page, mobile);
      /* expanded tour replaces the earlier five-topic route */
      /*
      await page.locator('[data-luna-choice="next"]').click();
      if (mobile) await (await step(page, 'more-notes')).click();
      await (await step(page, 'open-notes')).click();
      await step(page, 'notes');
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-notes.png` });
      await page.locator('[data-luna-choice="next"]').click();
      await (await step(page, 'open-kb')).click();
      if (!mobile) {
        const characters = await step(page, 'kb-menu');
        await characters.focus(); await page.keyboard.press('Enter');
      }
      await step(page, 'kb');
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-knowledge.png` });
      await page.locator('[data-luna-choice="next"]').click();
      if (mobile) await (await step(page, 'more-settings')).click();
      await (await step(page, 'open-settings')).click();
      await step(page, 'settings');
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-settings.png` });
      await page.locator('[data-luna-choice="next"]').click();
      */
      await step(page, 'done');
      assert.equal(await page.locator('[data-luna-choice="skip"]').count(), 1);
      await page.locator('[data-luna-choice="done"]').click();
      await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
      assert.equal(await page.evaluate(async () => (await window.nocturneApp.db.get('settings', 'luna-tutorial')).status), 'completed');
      assert.equal(await page.evaluate(() => window.nocturneApp.state.docs.length), 1);
      assert.match(await editor.textContent(), /A real story\./);
      await page.evaluate(async () => { await window.nocturneApp.flushOpenDocuments(); });
      const before = await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs'));
      const dumped = await page.evaluate(async () => {
        const a = window.nocturneApp, dump = await a.buildNocturneDump();
        window.__tutorialDump = dump;
        return JSON.stringify(dump).includes('"id":"luna-tutorial"');
      });
      assert.equal(dumped, false, 'Tutorial state is local and must not travel with manuscripts');
      await page.evaluate(async () => {
        const a = window.nocturneApp;
        window.__tutorialPreference = await a.db.getRaw('settings', 'luna-tutorial');
        window.__tutorialDump.payload.settingsRecords.push({ id: 'luna-tutorial', version: 1, status: 'skipped', updatedAt: 1 });
        await a.persistImportedProject(window.__tutorialDump.payload);
      });
      assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getRaw('settings', 'luna-tutorial')), await page.evaluate(() => window.__tutorialPreference), 'Replacing a project must preserve this device’s tutorial preference');
      assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs')), before);
      await page.reload(); await page.waitForFunction(() => window.nocturneApp?.startupInteractionReady);
      assert.equal(await page.locator('#luna-tutorial').count(), 0);
      assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs')), before, 'Reload must preserve the document exactly');
      await page.evaluate(() => { const a = window.nocturneApp; if (a.isMobileLayout()) a.openMobilePanel('settings', 'more', { settingsTab: 'misc' }); else a.openSettingsTab('misc'); });
      await page.locator('[data-action="start-tutorial"]:visible').click();
      await step(page, 'welcome');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.closest('#luna-tutorial') !== null), true);
      await page.keyboard.press('Escape');
      await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs')), before, 'Replaying and skipping must preserve manuscripts');
    });
    await scenario('skip keeps an unfinished form and restores modal focus', mobile, async page => {
      await page.goto(url); await choose(page, 'ru'); await reachForm(page);
      await page.locator('#doc-form input[name="title"]').fill('Не потерять введённое');
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-form.png` });
      await page.locator('[data-luna-choice="skip"]').click();
      await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#doc-form input[name="title"]').inputValue(), 'Не потерять введённое');
      assert.equal(await page.evaluate(() => document.activeElement?.closest('#doc-form') !== null), true);
      assert.equal(await page.evaluate(() => window.nocturneApp.state.docs.length), 0);
      assert.equal(await page.locator('[data-luna-target]').count(), 0);
      await page.locator('#doc-form button[type="submit"]').click();
      await page.waitForFunction(() => window.nocturneApp.state.docs.length === 1);
    }, { reducedMotion: 'reduce' });
  }
  await scenario('existing profile, resizing, locale changes and Android Back leave manuscripts intact', false, async page => {
    await page.goto(url); await choose(page, 'ru');
    await page.locator('[data-luna-choice="no"]').click();
    await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Авторский документ', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>Existing manuscript. Авторский текст.</p>');
      await a.flushOpenDocuments();
      window.__existingRows = await a.db.getAllRaw('docs');
      await a.db.delete('settings', 'luna-tutorial');
    });
    const before = await page.evaluate(() => window.__existingRows);
    await page.reload(); await step(page, 'welcome');
    assert.equal(await page.locator('#language-onboarding').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await step(page, 'welcome');
    await page.locator('[data-luna-choice="yes"]').click(); await step(page, 'write');
    assert.equal(await page.locator('#doc-form').count(), 0, 'Use the existing document without creating a demo');
    await page.locator('[data-luna-choice="next"]').click();
    await (await step(page, 'more-notes')).click();
    await (await step(page, 'open-notes')).click(); await step(page, 'notes');
    await page.setViewportSize({ width: 1280, height: 900 }); await step(page, 'notes');
    await page.locator('[data-luna-choice="next"]').click();
    await (await step(page, 'open-kb')).click(); await step(page, 'kb-menu');
    await page.setViewportSize({ width: 390, height: 844 }); await step(page, 'kb');
    await page.locator('[data-luna-choice="next"]').click();
    await (await step(page, 'more-settings')).click();
    await (await step(page, 'open-settings')).click(); await step(page, 'settings');
    await page.evaluate(async () => await window.nocturneApp.interfaceLanguage.change('en'));
    await page.waitForFunction(() => document.querySelector('#luna-tutorial-text')?.textContent.startsWith('Change your language'));
    await step(page, 'settings');
    await page.evaluate(() => window.nocturneApp.closeTopMobileOverlay());
    await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs')), before);
    assert.equal(await page.locator('.luna-tutorial-active').count(), 0);
  });
  await scenario('preference write failure exits safely and offers the tutorial again', true, async page => {
    await page.goto(url); await choose(page, 'en');
    await page.evaluate(() => {
      const db = window.nocturneApp.db, put = db.put.bind(db);
      db.put = (store, record, ...args) => record.id === 'luna-tutorial' ? Promise.reject(new Error('Simulated quota failure')) : put(store, record, ...args);
    });
    await page.locator('[data-luna-choice="no"]').click();
    await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
    assert.equal(await page.evaluate(async () => !!await window.nocturneApp.db.get('settings', 'luna-tutorial')), false);
    assert.equal(await page.evaluate(() => document.getElementById('app').inert), false);
    await page.reload(); await step(page, 'welcome');
    await page.keyboard.press('Escape');
    await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
  }, { reducedMotion: 'reduce' });
} finally {
  await browser?.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
