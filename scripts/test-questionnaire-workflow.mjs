import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5335, url = `http://localhost:${port}`;
const output = process.env.NOCTURNE_QA_OUTPUT || 'release/qa/questionnaire-workflow';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const browser = await chromium.launch({ headless: true });
const results = [];
async function test(name, action, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage(), errors = [], dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.nocturneApp?.backups);
    await page.waitForSelector('.app-shell.ready');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('preloader')).visibility === 'hidden');
    await action(page);
    assert.deepEqual(dialogs, [], 'No native browser dialogs');
    assert.deepEqual(errors, [], 'No page errors');
    results.push({ name, ok: true, mobile });
  } catch (error) { results.push({ name, ok: false, mobile, error: error.stack, errors, dialogs }); }
  finally { await context.close(); }
}
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const mobile of [false, true]) await test('removed workflows leave legacy AI, export, review and restored workspace usable', async page => {
    const state = await page.evaluate(mobile => {
      const a = window.nocturneApp;
      const normalized = a.normalizePaneDescriptor({ type: 'kb-tab', kbTab: 'books' }, 'secondary');
      const settings = a.validateSettings({ ...a.state.settings, aiContextMode: 'manual', aiResultLocation: 'history' });
      if (mobile) a.switchMobileTab('ai'); else a.togglePanel('ai-panel');
      return { tab: normalized.kbTab, obsoleteSetting: Object.hasOwn(settings, 'aiContextMode') || Object.hasOwn(settings, 'aiResultLocation'), writing: a.expectedAiProtocolForKind('style'), review: a.expectedAiProtocolForKind('proofread'), active: !!a.aiWorkspace || !!a.books };
    }, mobile);
    assert.deepEqual(state, { tab: 'characters', obsoleteSetting: false, writing: 'writing', review: 'review', active: false });
    assert.equal(await page.locator('[data-ai="rewrite"], [data-action="open-ai-history"], [data-kb-open="books"], [data-mobile-kb-tab="books"]').count(), 0);
    assert.ok(await page.locator('[data-ai="style"]').count() > 0);
    await page.evaluate(() => window.nocturneApp.openAiContextPreview());
    assert.equal(await page.locator('[data-context-key], [data-context-facts], [data-ai-preset-save]').count(), 0);
    await page.evaluate(() => { document.getElementById('form-overlay').classList.remove('active'); window.nocturneApp.openBookExport(); });
    assert.equal(await page.locator('[data-export-selected-book]').count(), 1);
    assert.equal(await page.locator('[data-export-move], [data-export-save-preset], [data-book-action]').count(), 0);
    await page.evaluate(() => { document.getElementById('form-overlay').classList.remove('active'); window.nocturneApp.openReviewQueue(); });
    assert.equal(await page.locator('[data-queue-status], [data-ai-result]').count(), 0);
    await page.locator('[data-close-form]').click();
    await page.evaluate(() => window.nocturneApp.openSettingsTab('ai'));
    assert.equal(await page.locator('[data-setting-select="aiContextMode"], [data-setting-select="aiResultLocation"]').count(), 0);
  }, mobile);
  await test('restoration previews and preserves current chapter, selected fields, and one-step undo', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'История', '');
      const doc = a.getFocusedDoc(), editor = a.nocturneEditor.get('primary');
      editor.commands.setContent('<p>Первоначальный текст.</p>'); doc.notes = 'Старые заметки'; a.state.globalNotes = 'Старые общие';
      const snapshot = await a.history.capture(doc, { reason: 'manual', name: 'Первый вариант' });
      editor.commands.setContent('<p>Новый текст автора.</p>'); doc.notes = 'Новые заметки'; a.state.globalNotes = 'Новые общие';
      await a.saveActiveDoc({ silent: true });
      await a.showHistory(); document.querySelector('[data-history-preview]').click();
      const previewOnly = doc.ast.blocks.some(block => block.html.includes('Новый текст автора'));
      await a.history.restore(snapshot.id, { text: true, notes: false, bookmarks: false, globalNotes: false });
      const restored = doc.ast.blocks.some(block => block.html.includes('Первоначальный текст'));
      const notes = doc.notes, global = a.state.globalNotes;
      const safety = (await a.db.getAll('snapshots')).some(item => item.reason === 'before-restore');
      await a.history.undo(doc.id);
      return { previewOnly, restored, notes, global, safety, undone: doc.ast.blocks.some(block => block.html.includes('Новый текст автора')) };
    });
    assert.deepEqual(result, { previewOnly: true, restored: true, notes: 'Новые заметки', global: 'Новые общие', safety: true, undone: true });
  });
  await test('timer retention preserves manual and large-edit versions', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Ротация', ''); const doc = a.getFocusedDoc();
      for (let index = 0; index < 7; index++) await a.db.put('snapshots', { id: `timer-${index}`, docId: doc.id, reason: 'timer', createdAt: index, ast: structuredClone(doc.ast) });
      await a.db.put('snapshots', { id: 'manual-keep', docId: doc.id, reason: 'manual', createdAt: 0, ast: structuredClone(doc.ast) });
      await a.db.put('snapshots', { id: 'bulk-keep', docId: doc.id, reason: 'large-edit', createdAt: 0, ast: structuredClone(doc.ast) });
      await a.history.prune(doc.id);
      const records = await a.db.getAll('snapshots');
      return { timer: records.filter(item => item.reason === 'timer').length, manual: records.some(item => item.id === 'manual-keep'), bulk: records.some(item => item.id === 'bulk-keep'), old: records.some(item => item.id === 'timer-0') };
    });
    assert.deepEqual(result, { timer: 5, manual: true, bulk: true, old: false });
  });
  await test('search keeps chooser, configurable matching and all results', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Поиск', ''); const doc = a.getFocusedDoc();
      a.nocturneEditor.get('primary').commands.setContent(Array.from({ length: 16 }, () => '<p>Анна видит маяк и ёлку.</p>').join(''));
      a.state.settings.manuscriptSearchMode = 'all'; a.state.settings.searchFoldYo = true; a.state.settings.searchShowAll = true;
      const allWords = a.collectDocMatches(doc, 'Анна маяк').length > 0;
      const yo = a.collectDocMatches(doc, 'елку').length;
      a.openSearchChooser(); const chooser = document.querySelector('[data-action="search-mode-current"]') && document.querySelector('[data-action="search-mode-global"]');
      a.openGlobalSearchWindow('маяк');
      return { allWords, yo, chooser: !!chooser, visible: document.querySelectorAll('.search-snippet').length };
    });
    assert.equal(result.allWords, true); assert.equal(result.yo, 16); assert.equal(result.chooser, true); assert.equal(result.visible, 16);
  });
  await test('dedicated settings are custom Nocturne controls on mobile and persist after reload', async page => {
    await page.evaluate(() => window.nocturneApp.openSettingsTab('history'));
    await page.getByRole('button', { name: /Открывать версию/ }).click();
    await page.getByRole('option', { name: 'Сравнение' }).click();
    await page.waitForFunction(() => window.nocturneApp.state.settings.historyOpenMode === 'compare');
    await page.waitForFunction(async () => (await window.nocturneApp.db.get('settings', 'app')).value.historyOpenMode === 'compare');
    await page.reload(); await page.waitForFunction(() => window.nocturneApp?.backups);
    assert.equal(await page.evaluate(() => window.nocturneApp.state.settings.historyOpenMode), 'compare');
  }, true);
  await test('automatic history captures original large edits, page growth and only active timer work', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      clearInterval(a.history.timer);
      await a.createDoc(a.defaultFolderId(), 'Автоматическая история', '');
      const doc = a.getFocusedDoc(), editor = a.nocturneEditor.get('primary');
      editor.commands.setContent('<p>Исходный текст.</p>'); editor.commands.focus();
      const large = Array.from({ length: 6 }, () => 'Большое новое предложение.').join(' ');
      editor.commands.setContent(`<p>${large}</p>`); await a.history.work;
      const original = (await a.history.records(doc.id)).find(item => item.reason === 'large-edit');
      editor.commands.setContent(`<p>${'Текст '.repeat(1900)}</p>`); await a.history.work;
      const records = await a.history.records(doc.id);
      const active = a.history.activity.get(doc.id); a.state.settings.historyTimerMinutes = 1;
      active.elapsed = 59_900; active.last = Date.now(); active.tick = active.last - 1000;
      editor.commands.blur(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); a.history.tick(active.last); const paused = active.elapsed;
      editor.commands.focus(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); active.tick = active.last - 1000; a.history.tick(active.last); await a.history.work;
      return { original: original.ast.blocks.map(block => block.html).join('').includes('Исходный текст'), growth: records.some(item => item.reason === 'growth'), paused, timer: (await a.history.records(doc.id)).some(item => item.reason === 'timer') };
    });
    assert.deepEqual(result, { original: true, growth: true, paused: 59_900, timer: true });
  });
  await test('failed restore transaction never changes the live chapter or creates a false safety copy', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Сбой восстановления', '');
      const doc = a.getFocusedDoc(), editor = a.nocturneEditor.get('primary'); editor.commands.setContent('<p>Старая версия.</p>');
      const snap = await a.history.capture(doc); editor.commands.setContent('<p>Новая версия.</p>'); await a.saveActiveDoc({ silent: true });
      const atomic = a.db.atomicWrite; a.db.atomicWrite = async () => { throw new Error('simulated transaction failure'); };
      let failed = false; try { await a.history.restore(snap.id, { text: true }); } catch { failed = true; } finally { a.db.atomicWrite = atomic; }
      return { failed, text: editor.getText(), safety: (await a.history.records(doc.id)).some(item => item.reason === 'before-restore') };
    });
    assert.deepEqual(result, { failed: true, text: 'Новая версия.', safety: false });
  });
  await test('global search dock permits editing and returns to preserved results without native controls', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Панель поиска', '');
      a.nocturneEditor.get('primary').commands.setContent(Array.from({ length: 18 }, (_, index) => `<p>Маяк ${index}.</p>`).join(''));
      a.state.settings.searchResultsMode = 'side'; a.openGlobalSearchWindow('Маяк');
    });
    await page.locator('[data-search-more]').click(); assert.equal(await page.locator('.search-snippet').count(), 18);
    await page.locator('.search-snippet').first().click(); await page.waitForSelector('#nocturne-search-dock');
    await page.locator('.primary-pane .tiptap').click(); await page.keyboard.type('Новый текст ');
    assert.equal(await page.locator('#form-overlay.active').count(), 0);
    assert.equal(await page.locator('#nocturne-search-dock select').count(), 0);
    await page.locator('#doc-search-panel [data-action="return-global-search"]').click();
    assert.equal(await page.locator('#nocturne-search-dock').count(), 0); assert.equal(await page.locator('#global-search-query').inputValue(), 'Маяк');
    await page.screenshot({ path: `${output}/search-desktop.png`, fullPage: true });
  });
  await test('history change counts do not count unchanged text between separate small edits', async page => {
    const counts = await page.evaluate(async () => {
      const a = window.nocturneApp; a.state.settings.timeMachine = false;
      await a.createDoc(a.defaultFolderId(), 'Счётчик изменений', ''); const doc = a.getFocusedDoc(), editor = a.nocturneEditor.get('primary');
      const middle = 'Неизменный текст. '.repeat(200);
      editor.commands.setContent(`<p>А ${middle} Я</p>`); await a.history.capture(doc);
      editor.commands.setContent(`<p>Б ${middle} Ю</p>`); const snapshot = await a.history.capture(doc);
      return { added: snapshot.addedChars, removed: snapshot.removedChars };
    });
    assert.deepEqual(counts, { added: 2, removed: 2 });
  });
  for (const mobile of [false, true]) await test('history comparison fits viewport and retains keyboard focus', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Сравнение главы', ''); const doc = a.getFocusedDoc();
      a.nocturneEditor.get('primary').commands.setContent('<p>Тихая первая строка.</p><p>Старый финал.</p>'); const snapshot = await a.history.capture(doc, { name: 'До изменения финала' });
      a.nocturneEditor.get('primary').commands.setContent('<p>Тихая первая строка.</p><p>Новый финал.</p>'); await a.history.open(doc.id, snapshot.id, 'compare');
    });
    await page.locator('[data-history-apply]').scrollIntoViewIfNeeded();
    const box = await page.locator('[data-history-apply]').boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= (mobile ? 844 : 1000));
    for (let index = 0; index < 20; index++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement.closest('#form-overlay')), true); }
    assert.equal(await page.locator('.history-modal select').count(), 0);
    await page.waitForTimeout(350); await page.screenshot({ path: `${output}/history-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  }, mobile);
  await test('manual version requires its name through a custom error and remains pinned', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp, { platformFiles } = await import('/src/platform/file-adapter.js');
      window.manualGitCalls = 0; platformFiles.saveGitSnapshot = async () => { window.manualGitCalls++; };
      a.state.settings.gitVersioning = true;
      await a.createDoc(a.defaultFolderId(), 'Именованная история', ''); a.history.manual();
    });
    await page.locator('button[type="submit"]').click(); await page.waitForSelector('#history-name-error:not(:empty)');
    await page.getByRole('textbox', { name: 'Название версии' }).fill('До правки финала'); await page.keyboard.press('Enter');
    await page.waitForFunction(async () => (await window.nocturneApp.db.getAll('snapshots')).some(item => item.name === 'До правки финала' && item.reason === 'manual' && item.pinned));
    await page.waitForFunction(() => window.manualGitCalls === 1);
  }, true);

} finally {
  await browser.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : `\n${result.error}`}`);
if (results.some(result => !result.ok)) process.exitCode = 1;
