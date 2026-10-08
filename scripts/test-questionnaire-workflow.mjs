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
  await test('AI without selection targets entire chapter and excludes future and draft facts', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Глава ИИ', ''); const doc = a.getFocusedDoc();
      a.nocturneEditor.get('primary').commands.setContent('<p>Начало истории.</p><p>Конец главы.</p>');
      a.selectionSnapshot = null; window.getSelection()?.removeAllRanges();
      const target = a.captureAssistantTargetSnapshot('proofread', doc, 'primary');
      doc.sceneEventId = 'present';
      a.state.lore.timeline = [{ id: 'present', title: 'Настоящее', date: '10', documentIds: [doc.id], order: 0 }, { id: 'future', title: 'Будущее', date: '20', documentIds: [doc.id], order: 1 }];
      a.state.lore.rules = [{ id: 'canon', text: 'Настоящий факт' }, { id: 'draft', text: 'Черновая идея', canonStatus: 'draft' }];
      const context = a.buildCurrentAiContext(doc, target);
      return { mode: target.mode, text: target.targetBlockText, timeline: context.timeline.map(item => item.title), rules: context.rules.map(item => item.text) };
    });
    assert.equal(result.mode, 'whole-chapter'); assert.match(result.text, /Начало истории[\s\S]*Конец главы/);
    assert.deepEqual(result.timeline, ['Настоящее']); assert.deepEqual(result.rules, ['Настоящий факт']);
  });
  await test('finished AI response survives chapter switch and never edits manuscript automatically', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Исходная глава', ''); const doc = a.getFocusedDoc();
      a.nocturneEditor.get('primary').commands.setContent('<p>Исходный текст.</p>');
      a.state.settings.aiProvider = 'ollama';
      a.streamAi = async (_prompt, onChunk) => { await a.createDoc(a.defaultFolderId(), 'Другая глава', ''); onChunk(JSON.stringify({ type: 'writing', thinking: 'Вариант', mode: 'replace-block', text: 'Предложение ИИ.' })); };
      await a.runAi('style');
      const inbox = await a.db.get('settings', 'ai-results');
      return { source: doc.ast.blocks.map(block => block.html).join(''), other: a.getFocusedDoc().title, results: inbox?.items?.length || 0, sourceId: inbox?.items?.[0]?.docId };
    });
    assert.match(result.source, /Исходный текст/); assert.doesNotMatch(result.source, /Предложение ИИ/);
    assert.equal(result.other, 'Другая глава'); assert.equal(result.results, 1); assert.ok(result.sourceId);
  });
  for (const mobile of [false, true]) await test('global books link chapters and multiple worlds, persist and export in explicit order', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Первая глава', ''); const first = a.getFocusedDoc();
      await a.createDoc(a.defaultFolderId(), 'Вторая глава', ''); const second = a.getFocusedDoc();
      const book = await a.books.save({ title: 'Моя книга', documentIds: [second.id, first.id], worldIds: ['world'], links: [], targetWords: 50000, notes: 'Идея книги' });
      await a.db.put('lore', { id: 'other-world', title: 'Другой мир', characters: [], locations: [], timeline: [], notes: [] });
      a.state.activeLoreId = 'other-world'; a.state.lore = await a.loadLore();
      await a.books.load();
      if (a.isMobileLayout()) { a.state.mobile.kbTab = 'books'; a.switchMobileTab('lore'); } else a.openKb('books');
      const visible = document.body.textContent.includes('Моя книга');
      const blob = await a.buildBookDocx(book.documentIds, { title: book.title, preserveOrder: true });
      const zip = await window.JSZip.loadAsync(await blob.arrayBuffer()), xml = await zip.file('word/document.xml').async('string');
      const dump = await a.buildNocturneDump();
      return { visible, count: a.books.items.length, backup: dump.payload.settingsRecords.some(record => record.id === 'books-library'), order: xml.indexOf('Вторая глава') < xml.indexOf('Первая глава') };
    });
    assert.deepEqual(result, { visible: true, count: 1, backup: true, order: true });
    assert.equal(await page.locator('.books-library select').count(), 0);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${output}/books-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
  }, mobile);
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
  await test('AI permits partial acceptance, guards newer writing and keeps original formatting in untouched paragraphs', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Частичное принятие', '');
      const doc = a.getFocusedDoc(), editor = a.nocturneEditor.get('primary');
      editor.commands.setContent('<p>Первый вариант.</p><p><strong>Неприкосновенный абзац.</strong></p><p>Последний вариант.</p>');
      a.state.settings.aiProvider = 'ollama'; a.selectionSnapshot = null; window.getSelection()?.removeAllRanges();
      a.streamAi = async (_prompt, chunk) => chunk(JSON.stringify({ type: 'writing', mode: 'replace-block', thinking: 'Две правки', text: 'Первый улучшенный вариант.\n\nНеприкосновенный абзац.\n\nПоследний улучшенный вариант.' }));
      await a.runAi('rewrite'); const item = a.aiWorkspace.items[0];
      try { await a.aiWorkspace.accept(item.id, [item.parts[0].id]); } catch (error) { throw new Error(`${error.message}; code=${error.code}; result=${item.id}; versions=${JSON.stringify(await a.db.getRaw('docs', doc.id)) === JSON.stringify(a.db.documentVersions.get(doc.id))}`); }
      const first = editor.getText(), format = JSON.stringify(doc.ast).includes('<strong>Неприкосновенный');
      editor.commands.insertContent('Свежая авторская правка.'); await a.saveActiveDoc({ silent: true });
      let stale = false; try { await a.aiWorkspace.accept(item.id, [item.parts[1].id]); } catch { stale = true; }
      return { parts: item.parts.length, first, format, stale, last: editor.getText() };
    });
    assert.equal(result.parts, 2); assert.match(result.first, /Первый улучшенный вариант/); assert.match(result.first, /Последний вариант/); assert.doesNotMatch(result.first, /Последний улучшенный/);
    assert.equal(result.format, true); assert.equal(result.stale, true); assert.match(result.last, /Свежая авторская правка/);
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
  await test('book form links worlds, saves notes and limits its review queue to linked chapters', async page => {
    const ids = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Глава книги', ''); const first = a.getFocusedDoc();
      await a.createDoc(a.defaultFolderId(), 'Посторонняя глава', ''); const other = a.getFocusedDoc();
      for (const doc of [first, other]) await a.saveReviewMark({ id: `mark-${doc.id}`, docId: doc.id, kind: 'comment', status: 'open', category: 'style', quote: 'Цитата', start: { blockId: doc.ast.blocks[0].id, offset: 0 }, end: { blockId: doc.ast.blocks[0].id, offset: 0 } });
      a.openKb('books'); return { first: first.id, other: other.id };
    });
    await page.locator('[data-book-action="new"]').click(); await page.locator('input[name="title"]').fill('Книга из формы'); await page.locator('button[type="submit"]').click();
    await page.locator('[data-book-action="link-chapters"]').click(); await page.locator(`label:has(input[value="${ids.first}"])`).click(); await page.getByRole('button', { name: 'Сохранить связи' }).click();
    await page.locator('[data-book-action="link-world"]').click(); await page.locator('label:has(input[name="worlds"])').first().click(); await page.getByRole('button', { name: 'Сохранить связи' }).click();
    await page.locator('[data-book-tab="notes"]').click(); await page.locator('[data-book-notes]').fill('Новые заметки о книге');
    await page.waitForFunction(() => window.nocturneApp.books.items.some(book => book.notes === 'Новые заметки о книге'));
    await page.locator('[data-book-tab="overview"]').click(); await page.locator('[data-book-action="reviews"]').click();
    assert.equal(await page.locator('[data-review-jump]').count(), 1);
    assert.match(await page.locator('.review-queue-row').innerText(), /Глава книги/);
  });
  await test('book review counter includes pending AI proposals and all-books filter includes archives', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Глава с вариантом ИИ', ''); const doc = a.getFocusedDoc();
      a.nocturneEditor.get('primary').commands.setContent('<p>Исходная строка.</p>'); a.nocturneEditor.syncDocFromEditor('primary');
      await a.aiWorkspace.record({ id: 'book-pending-ai', kind: 'rewrite', target: { mode: 'whole-chapter' } }, { writing: { text: 'Предложенная строка.' } }, doc, structuredClone(doc.ast));
      const book = await a.books.save({ title: 'Книга с предложением', documentIds: [doc.id] });
      a.books.selectedId = book.id; a.openKb('books');
    });
    assert.equal(await page.evaluate(() => window.nocturneApp.books.stats(window.nocturneApp.books.book()).reviews), 1);
    await page.locator('[data-book-action="reviews"]').click();
    assert.equal(await page.locator('[data-review-jump]').count(), 0);
    assert.equal(await page.locator('[data-ai-result]').count(), 1);
    await page.locator('#form-overlay [data-close-form]').click();
    await page.evaluate(async () => { const a = window.nocturneApp; await a.books.save({ id: a.books.selectedId, status: 'archived' }); a.books.refresh(); });
    await page.locator('[data-book-action="back"]').click(); assert.equal(await page.getByRole('button', { name: /Книга с предложением/ }).count(), 1);
    await page.getByRole('button', { name: 'Пишутся', exact: true }).click(); assert.equal(await page.getByRole('button', { name: /Книга с предложением/ }).count(), 0);
    await page.getByRole('button', { name: 'Архив', exact: true }).click(); assert.equal(await page.getByRole('button', { name: /Книга с предложением/ }).count(), 1);
  });
  await test('books and AI results are encrypted, restored and remapped on merge imports', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Глава с защитой', ''); const doc = a.getFocusedDoc();
      const book = await a.books.save({ title: 'Закрытая книга', documentIds: [doc.id], worldIds: ['world'], notes: 'Секрет' });
      await a.aiWorkspace.mutate(record => { record.items.push({ id: 'private-result', docId: doc.id, title: doc.title, parts: [], issues: [], thinking: 'Личный ответ', createdAt: Date.now() }); return record; });
      a.state.sessionPassword = 'questionnaire-password'; a.state.settings.e2e = true; await a.migrateEncryption();
      const rawBook = await a.db.getRaw('settings', 'books-library'), rawAi = await a.db.getRaw('settings', 'ai-results');
      const encrypted = !!rawBook.encrypted && !!rawAi.encrypted && !JSON.stringify([rawBook, rawAi]).includes('Секрет');
      const dump = await a.buildNocturneDump(); await a.importProjectDump(dump, { mode: 'replace' });
      const restored = a.books.items.some(item => item.title === book.title && item.documentIds.includes(doc.id));
      await a.importProjectDump(dump, { mode: 'merge' });
      const imported = a.books.items.find(item => item.id !== book.id && item.title === book.title);
      return { encrypted, restored, count: a.books.items.length, remapped: imported.documentIds[0] !== doc.id && a.state.docs.some(doc => doc.id === imported.documentIds[0]), ai: a.aiWorkspace.items.length };
    });
    assert.deepEqual(result, { encrypted: true, restored: true, count: 2, remapped: true, ai: 2 });
  });
  await test('context facts, time boundaries and saved manual sets persist through custom controls', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Контекст сцены', ''); const doc = a.getFocusedDoc();
      a.state.lore.characters = [{ id: 'time-character', name: 'Героиня', body: 'Биография со всеми событиями', documentIds: [doc.id] }];
      a.state.lore.timeline = [{ id: 'now', title: 'Начало истории', date: '10', order: 0 }, { id: 'later', title: 'Будущее', date: '20', order: 1 }];
      await a.saveLore(); doc.sceneEventId = 'now'; await a.saveActiveDoc({ silent: true }); a.openAiContextPreview();
    });
    await page.locator('[data-context-facts="characters:time-character"]').click();
    await page.locator('[data-fact-add]').click(); await page.locator('[data-fact-text="0"]').fill('Сейчас жива');
    await page.locator('[data-fact-add]').click(); await page.locator('[data-fact-text="1"]').fill('Умрёт в будущем');
    await page.getByRole('button', { name: 'Начало действия факта 2', exact: true }).click(); await page.getByRole('option', { name: '20 · Будущее', exact: true }).click();
    await page.getByRole('button', { name: 'Сохранить сведения', exact: true }).click();
    await page.waitForSelector('.ai-context-preview-modal');
    const context = await page.evaluate(() => window.nocturneApp.buildCurrentAiContext());
    assert.equal(context.characters[0].notes, 'Сейчас жива'); assert.doesNotMatch(JSON.stringify(context), /Умрёт в будущем/);
    await page.getByRole('button', { name: 'Подбор сведений', exact: true }).click(); await page.getByRole('option', { name: 'Вручную', exact: true }).click();
    await page.locator('.context-record-heading label:has(input[data-context-key="characters:time-character"])').click();
    await page.locator('.workflow-details summary').click(); await page.locator('[data-ai-preset-name]').fill('Начальная сцена'); await page.locator('[data-ai-preset-save]').click();
    await page.waitForFunction(() => window.nocturneApp.aiWorkspace.presets.some(preset => preset.name === 'Начальная сцена'));
    await page.screenshot({ path: `${output}/ai-context-desktop.png`, fullPage: true });
    await page.reload(); await page.waitForFunction(() => window.nocturneApp?.backups);
    const restored = await page.evaluate(() => ({ mode: window.nocturneApp.state.settings.aiContextMode, facts: window.nocturneApp.state.lore.characters.find(item => item.id === 'time-character').aiFacts.length, preset: window.nocturneApp.aiWorkspace.presets.some(preset => preset.name === 'Начальная сцена') }));
    assert.deepEqual(restored, { mode: 'manual', facts: 2, preset: true });
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
  for (const mobile of [false, true]) await test('history comparison and AI inbox fit viewport and retain keyboard focus', async page => {
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
    await page.evaluate(async () => {
      const a = window.nocturneApp; document.getElementById('form-overlay').classList.remove('active'); a.state.settings.aiProvider = 'ollama'; a.selectionSnapshot = null; window.getSelection()?.removeAllRanges();
      a.streamAi = async (_prompt, chunk) => chunk(JSON.stringify({ type: 'writing', mode: 'replace-block', thinking: 'Вариант для сравнения', text: 'Тихая первая строка.\n\nИной финал.' })); await a.runAi('rewrite');
    });
    await page.locator('[data-ai-accept]').scrollIntoViewIfNeeded();
    const accept = await page.locator('[data-ai-accept]').boundingBox(); assert.ok(accept.y >= 0 && accept.y + accept.height <= (mobile ? 844 : 1000));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.waitForTimeout(350); await page.screenshot({ path: `${output}/ai-result-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
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
  await test('legacy world rules retain stable links and saved AI selections after reload', async page => {
    const ids = await page.evaluate(async () => {
      const a = window.nocturneApp;
      const world = await a.db.get('lore', 'world'); await a.db.put('lore', { ...world, rules: ['Солнце питает магию.'] });
      await a.db.put('lore', { id: 'legacy-other-world', title: 'Другой мир', rules: ['Время нельзя вернуть.'] });
      a.state.lore = await a.loadLore();
      await a.createDoc(a.defaultFolderId(), 'Стабильный контекст', ''); const doc = a.getFocusedDoc();
      const primaryRule = a.state.lore.rules[0].id, otherRule = a.loreById.get('legacy-other-world').rules[0].id;
      await a.books.save({ title: 'Связанные правила', links: [{ loreId: 'world', type: 'rules', id: primaryRule }, { loreId: 'legacy-other-world', type: 'rules', id: otherRule }] });
      await a.aiWorkspace.mutate(record => { record.presets.push({ id: 'stable-preset', name: 'Правила начала', loreId: 'world', keys: [`rules:${primaryRule}`] }); return record; });
      doc.aiContextChoice = { presetId: 'stable-preset' }; await a.saveDocById(doc.id, { silent: true });
      a.state.settings.aiContextMode = 'preset'; await a.persistSettings();
      return { primaryRule, otherRule, docId: doc.id };
    });
    await page.reload(); await page.waitForSelector('.app-shell.ready');
    const result = await page.evaluate(async ids => {
      const a = window.nocturneApp, primary = await a.db.get('lore', 'world'), other = await a.db.get('lore', 'legacy-other-world');
      const context = a.buildCurrentAiContext(a.state.docs.find(doc => doc.id === ids.docId));
      return { stable: primary.rules[0].id === ids.primaryRule && other.rules[0].id === ids.otherRule, links: a.books.items.find(book => book.title === 'Связанные правила').links.length, selected: context.rules[0]?.id === ids.primaryRule };
    }, ids);
    assert.deepEqual(result, { stable: true, links: 2, selected: true });
  });
} finally {
  await browser.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : `\n${result.error}`}`);
if (results.some(result => !result.ok)) process.exitCode = 1;
