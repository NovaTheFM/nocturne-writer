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
    await action(page);
    assert.deepEqual(dialogs, [], 'No native browser dialogs');
    assert.deepEqual(errors, [], 'No page errors');
    results.push({ name, ok: true, mobile });
  } catch (error) { results.push({ name, ok: false, mobile, error: error.stack }); }
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
    await page.screenshot({ path: `${output}/books-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
  }, mobile);
  await test('dedicated settings are custom Nocturne controls on mobile and persist after reload', async page => {
    await page.evaluate(() => window.nocturneApp.openSettingsTab('history'));
    await page.getByRole('button', { name: /Открывать версию/ }).click();
    await page.getByRole('option', { name: 'Сравнение' }).click();
    await page.waitForFunction(() => window.nocturneApp.state.settings.historyOpenMode === 'compare');
    await page.reload(); await page.waitForFunction(() => window.nocturneApp?.backups);
    assert.equal(await page.evaluate(() => window.nocturneApp.state.settings.historyOpenMode), 'compare');
  }, true);
} finally {
  await browser.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}${result.ok ? '' : `\n${result.error}`}`);
if (results.some(result => !result.ok)) process.exitCode = 1;
