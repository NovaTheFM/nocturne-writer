import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { characterNameReplacement, renameCharacterReferences } from '../src/features/character-rename.js';
import { anchorAt, jsonEditorIndex, makeBookmark } from '../src/features/bookmark-model.js';
import { availablePort, killOwnedProcess } from './qa/runner.mjs';

const output = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/character-rename');
await mkdir(output, { recursive: true });
const results = [];
async function record(name, run) {
  try { results.push({ name, passed: true, measurements: await run() }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
  await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${name}${results.at(-1).error ? '\n' + results.at(-1).error : ''}`);
}
const before = { id: 'char-rename', firstName: 'Эрион', lastName: 'Вантас', displayName: 'Эрион Вантас', name: 'Эрион Вантас', aliases: ['Эрион', 'Сокол'] };
const after = { ...before, firstName: 'Александр', lastName: 'Северный', displayName: 'Александр Северный', name: 'Александр Северный' };
const replacement = characterNameReplacement(before, after);
await record('literal Unicode boundaries, case, separate name components, no cascades and regex punctuation', () => {
  assert.equal(replacement.text('Эрион Вантас; ЭРИОН ВАНТАС; эрион; Вантас; СверхЭрион; Эрион2.'), 'Александр Северный; АЛЕКСАНДР СЕВЕРНЫЙ; александр; Северный; СверхЭрион; Эрион2.');
  const punctuation = characterNameReplacement({ name: 'А[н]+а' }, { name: 'Мира $&' });
  assert.equal(punctuation.text('А[н]+а и А[н]+а'), 'Мира $& и Мира $&');
  const expand = characterNameReplacement({ name: 'Анна', firstName: 'Анна' }, { name: 'Анна Мария', firstName: 'Анна Мария' });
  assert.equal(expand.text('Анна и Анна Мария'), 'Анна Мария и Анна Мария');
  assert.equal(characterNameReplacement({ name: 'Анна' }, { name: 'Анна' }).text('Анна'), 'Анна');
  const forms = characterNameReplacement({ name: 'Анна', mentionForms: ['Анны', 'Анне'] }, { name: 'Мария', mentionForms: ['Марии', 'Марии'] });
  assert.equal(forms.text('Анна, Анны, Анне'), 'Мария, Марии, Марии');
  const removeSurname = characterNameReplacement(before, { ...before, lastName: '', name: 'Эрион', displayName: 'Эрион' });
  assert.equal(removeSurname.text('Эрион Вантас. Вантас.'), 'Эрион. Эрион.');
  return { literal: true, cases: 3, boundaries: true, noCascade: true };
});
await record('rich model preserves split formatting, IDs, namesakes and bookmarks through several replacements', () => {
  const pmJson = { type: 'doc', content: [{ type: 'paragraph', attrs: { blockId: 'block-Эрион' }, content: [{ type: 'text', text: 'Эри', marks: [{ type: 'bold' }] }, { type: 'text', text: 'он Вантас встречает Эрион.' }] }] };
  const blocks = jsonEditorIndex(pmJson);
  const bookmark = makeBookmark(anchorAt(blocks, 1, 13, 'range'));
  const next = renameCharacterReferences({ id: 'doc-Эрион', pmJson, bookmarks: [bookmark], documentIds: ['doc-Эрион'], href: 'https://Эрион.test', characters: [{ id: 'other', firstName: 'Эрион', name: 'Эрион', body: 'Эрион Вантас' }] }, replacement);
  assert.equal(next.pmJson.content[0].content.map(node => node.text).join(''), 'Александр Северный встречает Александр.');
  assert.equal(next.pmJson.content[0].content[0].marks[0].type, 'bold');
  assert.equal(next.pmJson.content[0].attrs.blockId, 'block-Эрион');
  assert.equal(next.bookmarks[0].parts[0].anchor.quote, 'Александр Северный');
  assert.equal(next.bookmarks[0].parts[0].anchor.to, 19);
  assert.equal(next.id, 'doc-Эрион'); assert.deepEqual(next.documentIds, ['doc-Эрион']);
  assert.equal(next.href, 'https://Эрион.test'); assert.equal(next.characters[0].name, 'Эрион');
  assert.equal(next.characters[0].body, 'Александр Северный');
  return { marks: true, identifiers: true, bookmark: true, namesake: true };
});

const port = await availablePort(), url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
let browser;
async function check(name, run, options = {}) {
  await record(name, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    const page = await context.newPage(), errors = [], dialogs = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
    try {
      await page.goto(url); await page.waitForSelector('.app-shell.ready');
      await page.waitForFunction(() => getComputedStyle(document.getElementById('preloader')).visibility === 'hidden');
      await page.evaluate(async before => {
        const a = window.nocturneApp;
        a.state.settings.automaticBackups = false; a.state.settings.timeMachine = false;
        await a.createDoc(a.defaultFolderId(), 'Эрион: глава', 'Описание: Эрион Вантас');
        const doc = a.getFocusedDoc(), editor = a.nocturneEditor.get('primary');
        editor.commands.setContent('<p><strong>Эри</strong>он Вантас встречает Эрион. СверхЭрион.</p><p>После Эрион — закладка.</p>');
        doc.notes = 'Эрион Вантас в заметках главы'; doc.workTitle = 'Эрион: книга';
        a.state.globalNotes = 'Общая записка: Эрион Вантас';
        a.state.lore.characters = [a.normalizeCharacter({ ...before, body: 'Эрион Вантас — герой', role: 'Друг Эрион' }), a.normalizeCharacter({ id: 'namesake', firstName: 'Эрион', lastName: 'Другой', body: 'Знаком с Эрион Вантас' })];
        a.state.lore.locations = [{ id: 'place', name: 'Мост Эрион', body: 'Эрион Вантас здесь', documentIds: [doc.id] }];
        a.state.lore.notes = [{ id: 'record', title: 'Запись Эрион', body: 'Эрион Вантас' }];
        a.state.lore.rules = [{ id: 'rule', text: 'Эрион Вантас хранит тайну' }];
        a.state.lore.timeline = [{ id: 'event', title: 'Эрион: встреча', body: 'Эрион Вантас пришёл', characterIds: [before.id], subEvents: [{ id: 'sub', title: 'Эрион: уход', body: 'Эрион Вантас ушёл' }] }];
        await a.saveLore(); await a.saveActiveDoc({ silent: true }); await a.persistGlobalNotes();
        await a.db.put('lore', { id: 'other-world', title: 'Другой мир', characters: [], locations: [], timeline: [], notes: [{ id: 'other-note', body: 'Эрион Вантас в другом мире' }], rules: [] });
        const note = a.sanitizeFloatingNote({ id: 'float', title: 'Эрион: записка', body: 'Эрион Вантас', scope: 'global', visible: true });
        a.state.floatingNotes = [note, a.sanitizeFloatingNote({ ...note, id: 'temporary', temporary: true })];
        await a.db.put('floatingNotes', note);
        await a.db.put('trash', { id: 'deleted', type: 'document', doc: { ...structuredClone(doc), id: 'deleted-doc' }, title: doc.title });
        await a.db.put('snapshots', { id: 'historical', docId: doc.id, ast: structuredClone(doc.ast) });
        a.renderAll();
      }, before);
      const measurements = await run(page);
      assert.deepEqual(errors, [], 'No uncaught application errors'); assert.deepEqual(dialogs, [], 'Uses Nocturne modals');
      return measurements;
    } catch (error) { await page.screenshot({ path: join(output, `failure-${results.length + 1}.png`) }).catch(() => {}); throw error; }
    finally { await context.close(); }
  });
}
async function propose(page, firstName = 'Александр', lastName = 'Северный') {
  await page.evaluate(() => window.nocturneApp.editLore('characters', 'char-rename'));
  await page.locator('#lore-form [name="firstName"]').fill(firstName);
  await page.locator('#lore-form [name="lastName"]').fill(lastName);
  await page.locator('#lore-form [type="submit"]').click();
  await page.waitForSelector('.character-rename-modal');
}
async function renamed(page) {
  await page.waitForFunction(() => window.nocturneApp.state.lore.characters.find(item => item.id === 'char-rename').firstName === 'Александр');
  await page.waitForSelector('#form-overlay.active', { state: 'hidden' });
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  await check('cancel and Escape preserve data, form edits and focus; unchanged names do not prompt', async page => {
    await propose(page);
    assert.equal(await page.locator('.character-rename-modal button').count(), 3);
    await page.locator('[data-rename-choice="cancel"]').click();
    assert.equal(await page.locator('#lore-form [name="firstName"]').inputValue(), 'Александр');
    assert.equal(await page.locator('#lore-form [name="firstName"]').evaluate(el => el === document.activeElement), true);
    assert.equal(await page.evaluate(() => window.nocturneApp.state.lore.characters[0].firstName), 'Эрион');
    await page.locator('#lore-form [type="submit"]').click(); await page.waitForSelector('.character-rename-modal');
    await page.keyboard.press('Escape'); await page.waitForSelector('#lore-form');
    assert.equal(await page.locator('#form-overlay').evaluate(el => el.classList.contains('active')), true);
    await page.locator('#lore-form [name="firstName"]').fill('Эрион'); await page.locator('#lore-form [name="lastName"]').fill('Вантас');
    await page.locator('#lore-form [name="body"]').fill('Новое описание');
    await page.locator('#lore-form [type="submit"]').click();
    await page.waitForFunction(() => window.nocturneApp.state.lore.characters[0].body === 'Новое описание');
    assert.equal(await page.locator('.character-rename-modal:visible').count(), 0);
    return { cancel: true, escape: true, draftRetained: true, unchanged: true };
  });
  for (const keepAlias of [false, true]) await check(`rename ${keepAlias ? 'with alias' : 'without alias'} updates every live text and survives reload`, async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp, { anchorAt, editorIndex, makeBookmark, textIndex } = await import('/src/features/bookmark-model.js');
      const doc = a.getFocusedDoc(), editor = a.nocturneEditor.get('primary');
      const rich = makeBookmark(anchorAt(editorIndex(editor.state.doc), 1, 13, 'range'));
      a.nocturneEditor.applyDocumentContent(doc, { pmJson: editor.getJSON(), bookmarks: [rich] });
      const note = a.state.lore.notes[0]; note.bookmarks = [makeBookmark(anchorAt(textIndex(note.body), 0, 12, 'range'))];
      await a.saveLore(); await a.saveActiveDoc({ silent: true });
      editor.commands.insertContent('<p>Несохранённый Эрион Вантас.</p>');
    });
    await propose(page);
    await page.waitForTimeout(380);
    await page.evaluate(async () => {
      const a = window.nocturneApp, doc = a.getFocusedDoc();
      await Promise.all([...(a.docSaves?.values() || []), ...a.draftWrites.values()]);
      const stale = structuredClone(doc); stale.pmJson.content = [{ type: 'paragraph', attrs: { blockId: 'stale' }, content: [{ type: 'text', text: 'Старый черновик: Эрион Вантас' }] }];
      stale.updatedAt -= 10000; await a.db.put('drafts', stale);
    });
    await page.screenshot({ path: join(output, `desktop-${keepAlias ? 'alias' : 'rename'}.png`) });
    await page.locator(`[data-rename-choice="${keepAlias ? 'alias' : 'rename'}"]`).click(); await renamed(page);
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, doc = a.getFocusedDoc();
      const global = await a.db.get('settings', 'global-notes');
      return { name: a.state.lore.characters[0].name, aliases: a.state.lore.characters[0].aliases,
        rich: doc.pmJson.content.map(node => (node.content || []).map(child => child.text || '').join('')).join('\n'),
        notes: doc.notes, global: global.text, lore: a.state.lore, floating: a.state.floatingNotes.map(note => note.body),
        other: (await a.db.get('lore', 'other-world')).notes[0].body,
        trash: (await a.db.get('trash', 'deleted')).title,
        bookmark: doc.bookmarks[0].parts[0].anchor,
        noteBookmark: a.state.lore.notes[0].bookmarks[0].parts[0].anchor,
        editor: a.nocturneEditor.get('primary').getText(),
        persisted: (await a.db.get('docs', doc.id)).notes,
        staleDraft: !!await a.db.get('drafts', doc.id),
        formatting: doc.pmJson.content[0].content.some(node => node.marks?.some(mark => mark.type === 'bold')) };
    });
    assert.equal(result.name, 'Александр Северный');
    assert.equal(result.aliases.includes('Эрион Вантас'), keepAlias); assert.equal(result.aliases.includes('Эрион'), keepAlias); assert.ok(result.aliases.includes('Сокол'));
    assert.match(result.rich, /Несохранённый Александр Северный/); assert.match(result.rich, /СверхЭрион/);
    assert.match(result.editor, /Александр Северный/); assert.equal(result.formatting, true);
    assert.equal(result.notes, 'Александр Северный в заметках главы'); assert.equal(result.notes, result.persisted);
    assert.equal(result.global, 'Общая записка: Александр Северный');
    assert.equal(result.lore.characters[1].name, 'Эрион Другой'); assert.equal(result.lore.characters[1].body, 'Знаком с Александр Северный');
    assert.equal(result.lore.timeline[0].subEvents[0].body, 'Александр Северный ушёл');
    assert.deepEqual(result.lore.timeline[0].characterIds, ['char-rename']);
    assert.equal(result.lore.rules[0].text, 'Александр Северный хранит тайну');
    assert.deepEqual(result.floating, ['Александр Северный', 'Александр Северный']);
    assert.equal(result.other, 'Александр Северный в другом мире'); assert.equal(result.trash, 'Александр: глава');
    assert.equal(result.bookmark.quote, 'Александр Северный'); assert.equal(result.bookmark.status, 'attached');
    assert.equal(result.noteBookmark.quote, 'Александр Северный');
    assert.equal(result.staleDraft, false);
    await page.reload(); await page.waitForSelector('.app-shell.ready');
    assert.equal(await page.evaluate(() => window.nocturneApp.state.lore.characters[0].name), 'Александр Северный');
    assert.match(await page.evaluate(() => JSON.stringify(window.nocturneApp.getFocusedDoc().pmJson)), /Несохранённый Александр/);
    return { alias: keepAlias, rich: true, unsaved: true, notes: true, timeline: true, otherWorld: true, persisted: true, bookmarks: true };
  });
  await check('write failure and concurrent database changes preserve originals and offer a retry', async page => {
    await propose(page);
    await page.evaluate(() => { const db = window.nocturneApp.db; window.renameAtomicWrite = db.atomicWrite; db.atomicWrite = async () => { throw new Error('Тестовая ошибка записи'); }; });
    await page.locator('[data-rename-choice="rename"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rename-status]').textContent.includes('Тестовая ошибка'));
    assert.equal(await page.evaluate(() => window.nocturneApp.state.lore.characters[0].name), 'Эрион Вантас');
    assert.equal(await page.evaluate(async () => (await window.nocturneApp.db.get('lore', 'world')).characters[0].name), 'Эрион Вантас');
    await page.evaluate(async () => {
      const a = window.nocturneApp; a.db.atomicWrite = window.renameAtomicWrite;
      const doc = a.getFocusedDoc(), raw = await a.db.getRaw('docs', doc.id);
      const tx = a.db.db.transaction('docs', 'readwrite'); tx.objectStore('docs').put({ ...raw, title: 'Изменено другой вкладкой' });
      await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
    });
    await page.locator('[data-rename-choice="rename"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rename-status]').textContent.includes('другой вкладке'));
    assert.equal(await page.evaluate(() => window.nocturneApp.state.lore.characters[0].name), 'Эрион Вантас');
    await page.locator('[data-rename-choice="cancel"]').click(); await page.waitForSelector('#lore-form');
    return { failureAtomic: true, concurrentProtected: true, cancellation: true };
  });
  await check('locked records prevent partial rename; unlocked E2E records stay encrypted', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.db.put('lore', { id: 'locked', protectedStore: 'lore', encrypted: { invalid: true } });
    });
    await propose(page); await page.locator('[data-rename-choice="alias"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rename-status]').textContent.includes('разблокируйте'));
    assert.equal(await page.evaluate(() => window.nocturneApp.state.lore.characters[0].name), 'Эрион Вантас');
    await page.locator('[data-rename-choice="cancel"]').click();
    await page.evaluate(async () => {
      const a = window.nocturneApp; await a.db.delete('lore', 'locked');
      a.state.settings.e2e = true; a.state.sessionPassword = 'rename-test-password';
      await a.saveActiveDoc({ silent: true }); await a.saveLore();
    });
    await page.locator('#lore-form [type="submit"]').click(); await page.waitForSelector('.character-rename-modal');
    await page.locator('[data-rename-choice="rename"]').click(); await renamed(page);
    const encryption = await page.evaluate(async () => {
      const a = window.nocturneApp, raw = await a.db.getRaw('docs', a.getFocusedDoc().id);
      return { protected: raw.protectedStore, plaintext: JSON.stringify(raw).includes('Александр'), decoded: (await a.db.get('docs', raw.id)).notes };
    });
    assert.equal(encryption.protected, 'docs'); assert.equal(encryption.plaintext, false); assert.match(encryption.decoded, /Александр Северный/);
    return { noPartialRename: true, encrypted: true };
  });
  await check('a knowledge-base edit from another tab is preserved instead of overwritten', async page => {
    await propose(page);
    await page.evaluate(async () => {
      const a = window.nocturneApp, world = await a.db.get('lore', 'world');
      world.notes.push({ id: 'other-tab', title: 'Новая запись другой вкладки', body: 'Сохранить этот текст' });
      await a.db.put('lore', world);
    });
    await page.locator('[data-rename-choice="rename"]').click();
    await page.waitForFunction(() => document.querySelector('[data-rename-status]').textContent.includes('другой вкладке'));
    const state = await page.evaluate(async () => {
      const world = await window.nocturneApp.db.get('lore', 'world');
      return { name: world.characters[0].name, newNote: world.notes.some(note => note.id === 'other-tab') };
    });
    assert.deepEqual(state, { name: 'Эрион Вантас', newNote: true });
    return { noLostUpdate: true };
  });
  for (const width of [390, 320]) await check(`touch confirmation ${width}px: full-width alias, keyboard focus, reduced motion and long names`, async page => {
    await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.theme = 'paper'; a.state.settings.reducedMotion = true; a.applySettings(); a.switchMobileTab('lore'); });
    await propose(page, 'Александр'.repeat(5), 'Северный'.repeat(4));
    await page.waitForTimeout(400);
    const geometry = await page.locator('.character-rename-actions').evaluate(root => {
      const boxes = [...root.children].map(button => { const r = button.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, bottom: r.bottom, right: r.right, height: r.height }; });
      return { boxes, viewport: innerWidth, overflow: document.documentElement.scrollWidth > innerWidth, focus: document.activeElement.dataset.renameChoice, described: root.parentElement.hasAttribute('aria-describedby') };
    });
    const [yes, no, alias] = geometry.boxes;
    assert.ok(alias.width >= yes.width + no.width); assert.ok(alias.y >= yes.bottom && alias.y >= no.bottom);
    assert.ok(geometry.boxes.every(box => box.x >= 0 && box.right <= geometry.viewport && box.height >= 44));
    assert.equal(geometry.overflow, false); assert.equal(geometry.described, true);
    await page.locator('[data-rename-choice="cancel"]').focus();
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.dataset.renameChoice), 'alias');
    await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement.dataset.renameChoice), 'rename');
    await page.screenshot({ path: join(output, `mobile-${width}-paper.png`) });
    await page.locator('[data-rename-choice="cancel"]').tap(); await page.waitForSelector('#lore-form');
    return geometry;
  }, { viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
} finally { await browser?.close(); await killOwnedProcess(server); }
if (results.some(result => !result.passed)) process.exitCode = 1;
