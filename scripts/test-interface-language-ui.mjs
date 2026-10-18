import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5351, url = `http://localhost:${port}`;
const output = process.env.NOCTURNE_QA_OUTPUT || 'release/qa/interface-language';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const browser = await chromium.launch({ headless: true });
const results = [];

async function seedLegacyProfile() {
  const { Database, DATABASE_STORES } = await import('/src/core/db.js');
  const { encryptJson } = await import('/src/core/crypto.js');
  const { seedLore } = await import('/src/core/defaults.js');
  const db = new Database(); await db.open();
  const rows = [];
  for (const store of DATABASE_STORES.filter(name => !['docs', 'settings', 'folders', 'lore'].includes(name))) {
    const value = { id: `language-preserve-${store}`, title: 'Настройки', text: 'Закрыть / Українська / English', opaque: { original: [1, 'не менять', false] } };
    await db.put(store, value); rows.push([store, value.id, value]);
  }
  const protectedDoc = { id: 'language-encrypted', folderId: 'manuscript', order: 7, protectedStore: 'docs', encrypted: await encryptJson({ id: 'language-encrypted', title: 'Закрыть', ast: { type: 'doc', blocks: [{ id: 'keep-block', type: 'paragraph', html: 'Рукопис не змінюється.' }] } }, 'keep-password') };
  await db.put('docs', protectedDoc); rows.push(['docs', protectedDoc.id, protectedDoc]);
  const lore = { id: 'world', title: 'Настройки', ...structuredClone(seedLore), notes: [{ id: 'language-note', title: 'Закрыть', body: 'Український авторський текст / English', order: 0 }], rules: [{ id: 'language-rule', text: 'Авторское правило не переводится.' }] };
  await db.put('lore', lore); rows.push(['lore', lore.id, lore]);
  rows.push(['settings', 'app', await db.getRaw('settings', 'app')]);
  for (const folder of await db.getAllRaw('folders')) rows.push(['folders', folder.id, folder]);
  if (new Set(rows.map(([store]) => store)).size !== DATABASE_STORES.length) throw new Error('The upgrade fixture must cover every database store');
  db.db.close();
  return rows;
}

async function scenario(name, mobile, action, options = {}) {
  const { legacy = false, firstPaint = false, ...browserOptions } = options;
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, ...browserOptions });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    let legacyRows;
    if (legacy || firstPaint) {
      await page.route('**/src/main.js*', route => route.fulfill({ contentType: 'text/javascript', body: 'window.__legacyProfileSeed = true;' }));
      await page.goto(url);
      if (firstPaint) {
        assert.equal(await page.locator('#preloader .preloader-subtitle').textContent(), 'Inspiration and focus', 'The first paint must already be English before JavaScript starts');
        assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      }
      if (legacy) legacyRows = await page.evaluate(seedLegacyProfile);
      await page.unroute('**/src/main.js*');
    }
    await page.goto(url);
    await page.waitForSelector('#language-onboarding.active');
    await action(page, legacyRows);
    assert.deepEqual(errors, [], 'No uncaught application errors');
    results.push({ name, mobile, status: 'PASS' });
  } catch (error) {
    await page.screenshot({ path: `${output}/failure-${results.length}.png`, fullPage: true }).catch(() => {});
    results.push({ name, mobile, status: 'FAIL', error: error.stack, errors });
  } finally { await context.close(); }
}

async function choose(page, locale) {
  await page.locator(`[data-choose-language="${locale}"]`).click();
  await page.locator('[data-confirm-language]').click();
  await page.waitForSelector('#language-onboarding', { state: 'detached' });
}

try {
  for (let attempt = 0; attempt < 80; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const mobile of [false, true]) {
    await scenario('first choice is centered, blurred, keyboard accessible, and remembered', mobile, async page => {
      assert.equal(await page.locator('#preloader .preloader-subtitle').textContent(), 'Inspiration and focus', 'An unconfirmed preference must not switch the startup screen back to Russian');
      await page.waitForFunction(() => Math.abs(document.querySelector('.language-welcome').getBoundingClientRect().y + document.querySelector('.language-welcome').getBoundingClientRect().height / 2 - innerHeight / 2) < 1);
      const geometry = await page.locator('.language-welcome').evaluate(element => {
        const rect = element.getBoundingClientRect();
        return { centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2, width: innerWidth, height: innerHeight, blur: getComputedStyle(element.parentElement).backdropFilter, inert: document.getElementById('app').inert, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.ok(Math.abs(geometry.centerX - geometry.width / 2) < 2);
      assert.ok(Math.abs(geometry.centerY - geometry.height / 2) < 2);
      assert.match(geometry.blur, /blur\(28px\)/);
      assert.equal(geometry.inert, true); assert.equal(geometry.overflow, false);
      assert.equal(await page.locator('[data-choose-language="en"]').getAttribute('aria-checked'), 'true');
      assert.equal(await page.locator('.language-choice .language-flag').count(), 3);
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-welcome.png` });
      await page.locator('[data-choose-language="uk"]').click();
      assert.equal(await page.locator('[data-choose-language="uk"]').getAttribute('aria-checked'), 'true');
      assert.equal(await page.evaluate(async () => !!await window.nocturneApp.db.get('settings', 'interface-language')), false, 'Selection is not saved before Confirm');
      await page.locator('[data-choose-language="uk"]').focus();
      await page.keyboard.press('ArrowDown');
      assert.equal(await page.locator('[data-choose-language="ru"]').getAttribute('aria-checked'), 'true');
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('[data-confirm-language]').evaluate(element => element === document.activeElement), true);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('#language-onboarding.active').count(), 1);
      await choose(page, 'uk');
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'uk');
      assert.equal(await page.evaluate(() => document.getElementById('app').inert), false);
      await page.reload(); await page.waitForSelector('.app-shell.ready');
      assert.equal(await page.locator('#language-onboarding').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'uk');
      assert.equal(await page.evaluate(() => window.nocturneApp.state.settings.smartDictionaryLang), 'auto');
      assert.equal(await page.locator('#preloader .preloader-subtitle').textContent(), 'Натхнення й зосередженість');
    }, { firstPaint: true });

    await scenario('switching under an opaque preloader preserves live editor, text, selection and Undo', mobile, async page => {
      await choose(page, 'ru');
      await page.evaluate(async () => {
        const a = window.nocturneApp;
        await a.createDoc(a.defaultFolderId(), 'Настройки', 'Закрыть');
        const editor = a.nocturneEditor.get('primary');
        editor.commands.setContent('<p>Авторський текст. Настройки. Close.</p>');
        editor.commands.setTextSelection(2); editor.commands.insertContent('XYZ');
        window.__languageEditor = editor; window.__languageEditorJson = editor.getJSON(); window.__languageSelection = editor.state.selection.from;
        a.openSettingsTab('visual');
      });
      const root = mobile ? '#mobile-panel' : '#settings-overlay';
      await page.locator(`${root} [data-setting-select="interfaceLanguage"] [data-setting-select-toggle]`).click();
      assert.equal(await page.locator(`${root} [data-setting-option="interfaceLanguage"] .language-flag`).count(), 3);
      const cover = page.waitForSelector('#language-preloader');
      await page.locator(`${root} [data-setting-option="interfaceLanguage"][data-value="en"]`).click();
      await cover;
      assert.equal(await page.locator('#language-preloader').evaluate(element => getComputedStyle(element).backdropFilter), 'none');
      assert.equal(await page.locator('#language-preloader').getAttribute('lang'), 'en');
      assert.equal(await page.locator('#language-preloader .preloader-subtitle').textContent(), 'Applying interface language…');
      assert.equal(await page.locator('#language-preloader .preloader-logo-img').count(), 1, 'Reuse the application preloader design');
      await page.waitForSelector('#language-preloader', { state: 'detached' });
      const state = await page.evaluate(() => {
        const a = window.nocturneApp, editor = a.nocturneEditor.get('primary');
        const preserved = editor === window.__languageEditor && JSON.stringify(editor.getJSON()) === JSON.stringify(window.__languageEditorJson) && editor.state.selection.from === window.__languageSelection;
        editor.commands.undo();
        return { preserved, undone: !editor.getText().includes('XYZ'), title: a.getFocusedDoc().title, description: a.getFocusedDoc().description, language: document.documentElement.lang };
      });
      assert.deepEqual(state, { preserved: true, undone: true, title: 'Настройки', description: 'Закрыть', language: 'en' });
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-english-settings.png` });
    });

    await scenario('an existing encrypted profile and every store survive first choice, switching and restart', mobile, async (page, expected) => {
      await choose(page, 'en');
      await page.evaluate(() => window.nocturneApp.interfaceLanguage.change('uk'));
      await page.reload(); await page.waitForSelector('.app-shell.ready');
      const actual = await page.evaluate(async expected => {
        const a = window.nocturneApp;
        return Promise.all(expected.map(async ([store, id]) => [store, id, await a.db.getRaw(store, id)]));
      }, expected);
      assert.deepEqual(actual, expected);
      assert.equal(await page.locator('#language-onboarding').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'uk');
    }, { legacy: true });

    await scenario('all settings and both command interfaces have complete translations in each language', mobile, async page => {
      await choose(page, 'uk');
      for (const locale of ['uk', 'en', 'ru']) {
        await page.evaluate(value => window.nocturneApp.interfaceLanguage.change(value), locale);
        const report = await page.evaluate(async () => {
          const a = window.nocturneApp;
          const { getMissingTranslations } = await import('/src/core/i18n.js');
          for (const tab of ['visual','editor','focus','ai','data','export','misc','dictionary','review','macros','formatting','history','manuscript-search','bookmarks','search']) a.settingsContent(tab);
          a.getSettingsRegistry(); a.commandPalette.buildCommands();
          for (const method of ['renderMobileActionsPanel','renderMobileMorePanel','renderMobileSettings','renderMobileDocsPanel','renderMobileKb','renderMobileAi','renderMobileNotes','renderMobileExport']) a[method]();
          const englishProof = a.settingsContent('visual');
          return { missing: getMissingTranslations(), englishProof, locale: document.documentElement.lang };
        });
        assert.deepEqual(report.missing, [], `Missing translations for ${locale}`);
        if (locale === 'en') assert.ok(report.englishProof.includes('Interface language') && report.englishProof.includes('Theme'));
        await page.evaluate(() => window.nocturneApp.openSettingsTab('visual'));
        await page.waitForFunction(() => {
          const a = window.nocturneApp;
          const root = document.querySelector(a.isMobileLayout() ? '#mobile-panel .mobile-panel-body' : '#settings-overlay .settings-body');
          return root && [root, root.parentElement, root.parentElement.parentElement].every(element => Number(getComputedStyle(element).opacity) > .99);
        });
        await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-${locale}-settings.png`, animations: 'disabled' });
      }
      const aiChecks = await page.evaluate(() => {
        const a = window.nocturneApp;
        return {
          englishError: a.aiReviewThinkingClaimsIssues('Found a spelling error.'),
          englishClean: a.aiReviewThinkingClaimsIssues('No obvious errors found.'),
          ukrainianError: a.aiReviewThinkingClaimsIssues('Знайдено граматичну помилку.'),
          ukrainianClean: a.aiReviewThinkingClaimsIssues('Помилок немає.'),
          englishNonIssue: a.aiIssueLooksLikeNonIssue({ reason: 'No errors. This is correct.' }),
          ukrainianNonIssue: a.aiIssueLooksLikeNonIssue({ reason: 'Помилок немає, текст коректно написано.' }),
        };
      });
      assert.deepEqual(aiChecks, { englishError: true, englishClean: false, ukrainianError: true, ukrainianClean: false, englishNonIssue: true, ukrainianNonIssue: true });
    });

    await scenario('importing a backup and resetting settings preserve the local language choice', mobile, async page => {
      await choose(page, 'uk');
      const result = await page.evaluate(async () => {
        const a = window.nocturneApp;
        await a.createDoc(a.defaultFolderId(), 'Авторська назва', 'Зміст без перекладу');
        await a.flushOpenDocuments();
        const dump = await a.buildNocturneDump();
        const preference = dump.payload.settingsRecords?.find(record => record.id === 'interface-language');
        if (preference) preference.locale = 'en';
        dump.checksum = await a.checksumText(JSON.stringify(dump.payload));
        await a.importProjectDump(dump, { mode: 'replace' });
        return { locale: document.documentElement.lang, preference: (await a.db.get('settings', 'interface-language')).locale, title: a.state.docs[0].title, description: a.state.docs[0].description };
      });
      assert.deepEqual(result, { locale: 'uk', preference: 'uk', title: 'Авторська назва', description: 'Зміст без перекладу' });
      await page.evaluate(() => window.nocturneApp.resetSettings());
      await page.locator('[data-confirm-reset-settings]').click();
      await page.reload(); await page.waitForSelector('.app-shell.ready');
      assert.equal(await page.locator('#language-onboarding').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.lang), 'uk');
    });
  }
  await scenario('the standard preloader fades gradually and uses the destination language in both directions', false, async page => {
    await choose(page, 'en');
    await page.evaluate(() => {
      const a = window.nocturneApp, refresh = a.refreshLocalizedInterface.bind(a);
      window.__languageCoverAtRefresh = [];
      a.refreshLocalizedInterface = () => {
        window.__languageCoverAtRefresh.push(Number(getComputedStyle(document.getElementById('language-preloader')).opacity));
        return refresh();
      };
    });
    for (const [locale, text] of [['ru', 'Применяем язык интерфейса…'], ['uk', 'Застосовуємо мову інтерфейсу…']]) {
      const pending = page.evaluate(locale => window.nocturneApp.interfaceLanguage.change(locale), locale);
      pending.catch(() => {});
      await page.waitForSelector('#language-preloader');
      assert.equal(await page.locator('#language-preloader .preloader-subtitle').textContent(), text);
      const duration = await page.locator('#language-preloader').evaluate(element => element.getAnimations()[0]?.effect.getTiming().duration);
      assert.ok(duration >= 500, `Entrance is too abrupt: ${duration}ms`);
      await pending;
    }
    assert.deepEqual(await page.evaluate(() => window.__languageCoverAtRefresh), [1, 1], 'Layout changes only behind the fully opaque preloader');
  });
  await scenario('a failed first preference write keeps the choice open and allows retry', false, async page => {
    await page.evaluate(() => {
      const db = window.nocturneApp.db, original = db.put.bind(db);
      db.put = (store, value, ...rest) => value.id === 'interface-language' ? Promise.reject(new Error('Storage unavailable')) : original(store, value, ...rest);
      window.__restoreLanguageWrite = () => { db.put = original; };
    });
    await page.locator('[data-choose-language="en"]').click();
    await page.locator('[data-confirm-language]').click();
    await page.waitForSelector('.language-choice-error:not([hidden])');
    assert.equal(await page.locator('#language-onboarding.active').count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    await page.evaluate(() => window.__restoreLanguageWrite());
    await choose(page, 'en');
  }, { reducedMotion: 'reduce' });
} finally {
  await browser.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
for (const result of results) console.log(`${result.status}: ${result.name} (${result.mobile ? 'mobile' : 'desktop'})${result.error ? `\n${result.error}` : ''}`);
if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;
