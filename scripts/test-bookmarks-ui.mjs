import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const directory = 'release/qa/bookmarks-ui';
await mkdir(directory, { recursive: true });
const url = 'http://localhost:5333';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5333', SYNC_PORT: '8933' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true }), results = [];
async function check(name, run, mobile = false) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(async () => { const a = window.nocturneApp; a.state.settings.automaticBackups = false; await a.createDoc(a.defaultFolderId(), 'Закладки: оригинал', ''); a.nocturneEditor.get('primary').commands.setContent('<p>Первая строка с текстом для закладок.</p><p>Второй абзац для выделенного фрагмента.</p><p>Третий отдельный абзац.</p>'); await document.fonts.ready; });
    await page.waitForTimeout(250);
    const layout = await page.evaluate(() => {
      const root = document.querySelector('.ProseMirror'), rect = root?.getBoundingClientRect(), pane = document.getElementById('notes-panel');
      return { visible: !!rect && rect.width > 150 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth, notesPosition: pane ? getComputedStyle(pane).position : null };
    });
    assert.equal(layout.visible, true, 'Manuscript must be visible in the viewport');
    if (!mobile) assert.equal(layout.notesPosition, 'absolute', 'Bookmark layer must preserve the notes panel layout');
    await run(page); assert.deepEqual(errors, [], 'No uncaught errors');
    results.push({ name, passed: true });
  } catch (error) { results.push({ name, passed: false, error: error.stack, errors }); await page.screenshot({ path: `${directory}/failure-${results.length}.png` }).catch(() => {}); }
  finally { console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${name}${results.at(-1).error ? '\n' + results.at(-1).error : ''}`); await writeFile(`${directory}/results.json`, JSON.stringify(results, null, 2)); await context.close(); }
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const mobile of [false, true]) await check(`point is outside text and keeps layout and selection (${mobile ? 'touch' : 'desktop'})`, async page => {
    const before = await page.evaluate(() => { const a=window.nocturneApp,e=a.nocturneEditor.get('primary'); e.commands.setTextSelection(8); const range=document.createRange();range.selectNodeContents(e.view.dom.querySelector('p'));return{json:JSON.stringify(e.getJSON()),text:e.getText(),rects:[...range.getClientRects()].map(r=>[r.x,r.y,r.width,r.height]),from:e.state.selection.from}; });
    await page.evaluate(() => window.nocturneApp.addBookmarkAtCurrentPosition('primary')); await page.waitForTimeout(100);
    const after = await page.evaluate(() => { const a=window.nocturneApp,e=a.nocturneEditor.get('primary'),range=document.createRange();range.selectNodeContents(e.view.dom.querySelector('p'));return{json:JSON.stringify(e.getJSON()),text:e.getText(),rects:[...range.getClientRects()].map(r=>[r.x,r.y,r.width,r.height]),from:e.state.selection.from,title:a.getFocusedDoc().bookmarks[0].parts[0].title,inline:e.view.dom.querySelectorAll('[data-bookmark-id]').length,marks:document.querySelectorAll('.bookmark-position-mark').length}; });
    assert.equal(after.json,before.json); assert.equal(after.text,before.text); assert.equal(after.from,before.from); assert.equal(after.rects.length,before.rects.length); assert.ok(after.rects.every((rect,index)=>rect.every((value,axis)=>Math.abs(value-before.rects[index][axis])<.5)),JSON.stringify({before:before.rects,after:after.rects})); assert.equal(after.inline,0); assert.equal(after.marks,1); assert.equal(after.title,'Закладка 1');
    await page.screenshot({path:`${directory}/point-${mobile?'mobile':'desktop'}.png`});
  }, mobile);
  await check('bookmark creation and text changes share undo and redo', async page => {
    const value = await page.evaluate(async () => {
      const a=window.nocturneApp,e=a.nocturneEditor.get('primary'); e.commands.setTextSelection(8); await a.addBookmarkAtCurrentPosition('primary');
      const created=a.getFocusedDoc().bookmarks.length; e.commands.undo(); const undone=a.getFocusedDoc().bookmarks.length; e.commands.redo(); const redone=a.getFocusedDoc().bookmarks.length;
      e.commands.insertContentAt(1,'Добавлено '); const shifted=a.getFocusedDoc().bookmarks[0]?.parts[0].anchor.from; e.commands.undo(); const restored=a.getFocusedDoc().bookmarks[0]?.parts[0].anchor.from;
      return {created,undone,redone,shifted,restored};
    });
    assert.deepEqual(value,{created:1,undone:0,redone:1,shifted:18,restored:8});
  });
  await check('a multi-paragraph selection retains its real end and paragraph marker is outside', async page => {
    const values = await page.evaluate(async () => {
      const a=window.nocturneApp,e=a.nocturneEditor.get('primary');e.commands.setTextSelection({from:8,to:55});await a.addBookmarkAtCurrentPosition('primary');
      const range=structuredClone(a.getFocusedDoc().bookmarks[0]); a.state.settings.bookmarkMode='paragraph'; e.commands.setTextSelection(e.state.doc.content.size-5); await a.addBookmarkAtCurrentPosition('primary');
      return { range:range.parts[0].anchor, paragraph:a.getFocusedDoc().bookmarks[1]?.parts[0].anchor, inline:e.view.dom.querySelectorAll('[data-bookmark-id]').length };
    });
    assert.equal(values.range.kind,'range');assert.equal(values.range.from,8);assert.equal(values.range.to,55);assert.notEqual(values.range.start.blockId,values.range.end.blockId);assert.equal(values.paragraph?.kind,'paragraph');assert.equal(values.inline,0);
  });
  await check('deleting bookmarked text asks, cancellation preserves text and acceptance is undoable', async page => {
    await page.evaluate(async () => { const a=window.nocturneApp,e=a.nocturneEditor.get('primary');e.commands.setTextSelection({from:5,to:10});await a.addBookmarkAtCurrentPosition('primary');e.commands.deleteRange({from:4,to:12}); });
    await page.waitForSelector('[data-confirm-dialog]');assert.match(await page.locator('#form-overlay h2').innerText(),/Удалить закладку/);
    await page.locator('[data-close-form]').click();
    assert.equal(await page.evaluate(()=>window.nocturneApp.getFocusedDoc().bookmarks.length),1);
    await page.evaluate(()=>window.nocturneApp.nocturneEditor.get('primary').commands.deleteRange({from:4,to:12}));
    await page.waitForSelector('[data-confirm-dialog]');await page.locator('[data-confirm-dialog]').click();
    await page.waitForFunction(()=>window.nocturneApp.getFocusedDoc().bookmarks.length===0);
    assert.ok(await page.evaluate(async()=> (await window.nocturneApp.db.getAll('trash')).some(value=>value.type==='bookmark')));
    await page.evaluate(()=>window.nocturneApp.nocturneEditor.get('primary').commands.undo());
    assert.equal(await page.evaluate(()=>window.nocturneApp.getFocusedDoc().bookmarks.length),1);
  });
  await check('duplicated documents have independent bookmarks grouped until an edit', async page => {
    const result = await page.evaluate(async () => {
      const a=window.nocturneApp,e=a.nocturneEditor.get('primary');e.commands.setTextSelection(8);await a.addBookmarkAtCurrentPosition('primary');
      const original=a.getFocusedDoc(),id=original.bookmarks[0].id;await a.duplicateDoc(original.id);const copy=a.getFocusedDoc();
      a.bookmarks.filter='docs'; const groups=a.bookmarks.groups().map(values=>values.length);const independent=id!==copy.bookmarks[0].id;
      await a.bookmarks.remove(a.bookmarks.paneSource('primary').key,copy.bookmarks[0].id,{confirm:false});return{independent,groups,originalCount:original.bookmarks.length,copyCount:copy.bookmarks.length};
    });
    assert.equal(result.independent,true);assert.deepEqual(result.groups,[2]);assert.equal(result.originalCount,1);assert.equal(result.copyCount,0);
  });
  await check('bookmark management and settings expose requested controls safely', async page => {
    await page.evaluate(async()=>{const a=window.nocturneApp,e=a.nocturneEditor.get('primary');e.commands.setTextSelection(8);await a.addBookmarkAtCurrentPosition('primary');a.bookmarks.filter='docs';a.openKb('bookmarks');});
    await page.waitForSelector('.bookmark-manager'); await page.locator('.bookmark-scope-trigger').click(); assert.equal(await page.locator('#bookmark-scope-menu [role="menuitemradio"]').count(),3); await page.keyboard.press('Escape');
    await page.locator('.bookmark-manager-main').click(); await page.locator('[name="title-0"]').fill('<img src=x onerror=alert(1)>'); await page.locator('[name="note-0"]').fill('Собственная заметка'); await page.locator('.bookmark-edit-modal [type="submit"]').click();
    await page.waitForSelector('#form-overlay.active', { state: 'hidden' });
    assert.equal(await page.locator('.bookmark-manager-row img').count(),0);assert.match(await page.locator('.bookmark-manager-row').innerText(),/Собственная заметка/);
    await page.screenshot({path:`${directory}/manager-desktop.png`});
    await page.evaluate(()=>{const a=window.nocturneApp;document.getElementById('kb-modal').classList.remove('active');a.openSettingsTab('bookmarks');});
    await page.waitForSelector('[data-setting-select="bookmarkMode"]');assert.equal(await page.locator('[data-setting="bookmarkConfirmTextDeletion"]').count(),1);assert.equal(await page.locator('[data-setting="bookmarkCopyWithText"]').count(),1);
  });
  await check('notes work in reading mode and their deleted owner stays recoverable', async page => {
    await page.evaluate(async()=>{const a=window.nocturneApp;a.upsertNote({id:'note-bookmarks',title:'Запись с закладкой',body:'Текст записи\nВторая строка'});await a.saveLore();a.openKb('notes');a.state.activeLoreDetail={type:'notes',id:'note-bookmarks'};a.state.kbReadMode=true;a.renderKb();const source=a.bookmarks.sources().find(source=>source.owner.id==='note-bookmarks');await a.bookmarks.addContext({sourceKey:source.key,from:3,to:8});a.bookmarks.refresh();});
    await page.waitForSelector('.note-read-text');await page.waitForTimeout(80);assert.ok(await page.locator('.bookmark-position-mark').count());
    const count=await page.evaluate(async()=>{const a=window.nocturneApp;await a.deleteLore('notes','note-bookmarks');return(await a.db.getAll('trash')).filter(item=>item.type==='lore-entity'&&item.item?.id==='note-bookmarks').length;});assert.equal(count,1);
  });
  for (const mobile of [false, true]) await check(`jump centers the last bookmark without moving selection or focusing (${mobile ? 'touch' : 'desktop'})`, async page => {
    await page.evaluate(async () => {
      const a=window.nocturneApp,e=a.nocturneEditor.get('primary');e.commands.setContent(Array.from({length:40},(_,i)=>`<p>Строка ${i}: длинный текст для проверки прокрутки и сохранения позиции.</p>`).join(''));a.nocturneEditor.flushVisualPages('primary');
      e.commands.setTextSelection(e.state.doc.content.size-8);await a.addBookmarkAtCurrentPosition('primary');e.commands.setTextSelection(1);e.view.dom.blur();document.activeElement?.blur();
      await a.bookmarks.jump(a.bookmarks.paneSource('primary').key,a.getFocusedDoc().bookmarks[0].id,'primary');
    });
    await page.waitForTimeout(350);
    const result=await page.evaluate(()=>{const a=window.nocturneApp,e=a.nocturneEditor.get('primary'),pos=a.getFocusedDoc().bookmarks[0].parts[0].anchor.from,r=e.view.coordsAtPos(pos),v=e.view.dom.closest('.editor-scroll-area').getBoundingClientRect();return{selection:e.state.selection.from,focused:document.activeElement===e.view.dom,delta:Math.abs((r.top+r.bottom)/2-(v.top+v.height/2)),scroll:e.view.dom.closest('.editor-scroll-area').scrollTop};});
    assert.equal(result.selection,1);assert.equal(result.focused,false);assert.ok(result.delta<4,JSON.stringify(result));assert.ok(result.scroll>0);
    await page.screenshot({path:`${directory}/jump-${mobile?'mobile':'desktop'}.png`});
  },mobile);
  await check('touch jump from the edit dialog closes it without reopening the keyboard', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
      e.commands.setTextSelection(8); await a.addBookmarkAtCurrentPosition('primary'); e.commands.focus();
      void a.bookmarks.edit(a.bookmarks.paneSource('primary').key, a.getFocusedDoc().bookmarks[0].id);
    });
    await page.waitForSelector('[data-jump-edit]'); await page.locator('[data-jump-edit]').click();
    await page.waitForSelector('#form-overlay.active', { state: 'hidden' }); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.ProseMirror, textarea, [contenteditable="true"]')), false);
  }, true);
  await check('the first bookmark can be centered and a later dialog restores focus normally', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
      e.commands.setTextSelection(1); await a.addBookmarkAtCurrentPosition('primary');
      await a.bookmarks.jump(a.bookmarks.paneSource('primary').key, a.getFocusedDoc().bookmarks[0].id, 'primary');
    });
    await page.waitForTimeout(100);
    assert.ok(await page.evaluate(() => { const e = window.nocturneApp.nocturneEditor.get('primary'), r = e.view.coordsAtPos(1), v = e.view.dom.closest('.editor-scroll-area').getBoundingClientRect(); return Math.abs((r.top + r.bottom) / 2 - (v.top + v.height / 2)) < 4; }));
    await page.evaluate(() => { const button = document.querySelector('.pane-bookmarks-btn'); button.focus(); window.nocturneApp.openSettingsTab('bookmarks'); });
    await page.waitForSelector('#settings-overlay.active');
    await page.evaluate(() => document.getElementById('settings-overlay').classList.remove('active')); await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => document.activeElement?.matches('.pane-bookmarks-btn')), true);
  });
  await check('custom touch selection is saved whole even when the native selection is collapsed', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), range = document.createRange();
      const start = e.view.domAtPos(8), end = e.view.domAtPos(e.state.doc.child(0).nodeSize + 7);
      range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
      const expected = range.toString(); a.setMobileEditorSelection(range, e.view.dom); await a.addBookmarkAtCurrentPosition('primary');
      const anchor = a.getFocusedDoc().bookmarks[0].parts[0].anchor;
      return { expected, actual: e.state.doc.textBetween(anchor.from, anchor.to), differentBlocks: anchor.start.blockId !== anchor.end.blockId };
    });
    assert.equal(result.actual, result.expected); assert.equal(result.differentBlocks, true);
  }, true);
  await check('stack prompt keeps both names, intersections and per-part notes',async page=>{
    await page.evaluate(async()=>{const a=window.nocturneApp,e=a.nocturneEditor.get('primary');e.commands.setTextSelection({from:5,to:15});await a.addBookmarkAtCurrentPosition('primary');e.commands.setTextSelection({from:10,to:22});void a.addBookmarkAtCurrentPosition('primary');});
    await page.waitForSelector('[data-choice="create"]');assert.match(await page.locator('#form-overlay h2').innerText(),/Создать сложенную закладку/);await page.locator('[data-choice="create"]').click();
    await page.waitForFunction(()=>window.nocturneApp.getFocusedDoc().bookmarks[0]?.parts.length===2);await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.nocturneApp.getFocusedDoc().bookmarks.length),1);assert.ok(await page.locator('.bookmark-range-line.overlap').count());
    await page.evaluate(()=>{const a=window.nocturneApp;void a.bookmarks.edit(a.bookmarks.paneSource('primary').key,a.getFocusedDoc().bookmarks[0].id);});await page.waitForSelector('[name="note-1"]');await page.locator('[name="note-0"]').fill('Первое описание');await page.locator('[name="note-1"]').fill('Второе описание');await page.locator('.bookmark-edit-modal [type="submit"]').click();await page.waitForSelector('#form-overlay.active',{state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.nocturneApp.getFocusedDoc().bookmarks[0].parts.map(part=>part.note)),['Первое описание','Второе описание']);
    await page.evaluate(()=>window.nocturneApp.nocturneEditor.get('primary').commands.undo());assert.deepEqual(await page.evaluate(()=>window.nocturneApp.getFocusedDoc().bookmarks[0].parts.map(part=>part.note)),['','']);
  });
  await check('clipboard keeps plain text clean and transfers metadata only when enabled',async page=>{
    const result=await page.evaluate(async()=>{
      const a=window.nocturneApp,e=a.nocturneEditor.get('primary');e.commands.setTextSelection(8);await a.addBookmarkAtCurrentPosition('primary');e.commands.setTextSelection({from:1,to:20});
      const copy=()=>{const data=new DataTransfer();e.view.dom.dispatchEvent(new ClipboardEvent('copy',{clipboardData:data,bubbles:true,cancelable:true}));return data;};
      const clean=copy();a.state.settings.bookmarkCopyWithText=true;const data=copy(),metadata=data.getData('application/x-nocturne-bookmarks'),text=data.getData('text/plain'),html=data.getData('text/html');
      await a.createDoc(a.defaultFolderId(),'Получатель','');const next=a.nocturneEditor.get('primary');next.view.dom.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));await a.saveActiveDoc({silent:true});
      return{defaultMeta:clean.getData('application/x-nocturne-bookmarks'),metadata:JSON.parse(metadata).bookmarks.length,text,html,bookmarks:a.getFocusedDoc().bookmarks.length,json:JSON.stringify(next.getJSON())};
    });
    assert.equal(result.defaultMeta,'');assert.equal(result.metadata,1);assert.equal(result.bookmarks,1);assert.doesNotMatch(result.html,/bookmark/);assert.doesNotMatch(result.json,/bookmark/);assert.equal(result.text,'Первая строка с тек');
  });
  await check('touch context clipboard transfers bookmarks and cutting still asks before deletion', async page => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.evaluate(async () => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary'); a.state.settings.bookmarkCopyWithText = true;
      e.commands.setTextSelection(8); await a.addBookmarkAtCurrentPosition('primary'); e.commands.setTextSelection({ from: 1, to: 20 });
      const range = a.nocturneEditor.selectionRange('primary'); a.contextSelectionRange = range.cloneRange(); a.state.contextMenu = { x: 50, y: 200, paneId: 'primary', docId: a.getFocusedDoc().id, range, selectedText: range.toString(), reviewMode: 'write' }; a.renderContextMenu();
    });
    await page.locator('#app-context-menu [data-action="context-copy"]').tap();
    await page.waitForFunction(() => !!window.nocturneApp.bookmarks.clipboard);
    await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Вставка через меню', ''); const e = a.nocturneEditor.get('primary'); e.commands.setTextSelection(1);
      const range = a.nocturneEditor.selectionRange('primary'); a.contextSelectionRange = range.cloneRange(); a.state.contextMenu = { x: 50, y: 200, paneId: 'primary', docId: a.getFocusedDoc().id, range, selectedText: '', reviewMode: 'write' }; a.renderContextMenu();
    });
    await page.locator('#app-context-menu [data-action="context-paste"]').tap();
    await page.waitForFunction(() => window.nocturneApp.getFocusedDoc().bookmarks.length === 1);
    const beforeCut = await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText());
    assert.ok(beforeCut.startsWith('Первая строка с тек'));
    await page.evaluate(() => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary'); e.commands.setTextSelection({ from: 1, to: 20 });
      const range = a.nocturneEditor.selectionRange('primary'); a.contextSelectionRange = range.cloneRange(); a.state.contextMenu = { x: 50, y: 200, paneId: 'primary', docId: a.getFocusedDoc().id, range, selectedText: range.toString(), reviewMode: 'write' }; a.renderContextMenu();
    });
    await page.locator('#app-context-menu [data-action="context-cut"]').tap(); await page.waitForSelector('[data-confirm-dialog]');
    await page.locator('[data-close-form]').tap();
    assert.equal(await page.evaluate(() => window.nocturneApp.getFocusedDoc().bookmarks.length), 1);
    assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), beforeCut);
  }, true);
  await check('snapshots restore bookmarks together with text and preserve undo',async page=>{
    await page.evaluate(async()=>{const a=window.nocturneApp,e=a.nocturneEditor.get('primary');e.commands.setTextSelection(8);await a.addBookmarkAtCurrentPosition('primary');await a.createSnapshot();await a.bookmarks.remove(a.bookmarks.paneSource('primary').key,a.getFocusedDoc().bookmarks[0].id,{confirm:false});a.showHistory();});
    await page.waitForSelector('[data-restore]');await page.locator('[data-restore]').first().click();await page.waitForSelector('#form-overlay.active',{state:'hidden'});assert.equal(await page.evaluate(()=>window.nocturneApp.getFocusedDoc().bookmarks.length),1);
    const result=await page.evaluate(async()=>{const a=window.nocturneApp,e=a.nocturneEditor.get('primary');e.commands.undo();const count=a.getFocusedDoc().bookmarks.length;a.state.settings.bookmarkSnapshots=false;const previous=new Set((await a.db.getAll('snapshots')).map(snap=>snap.id));await a.createSnapshot();const snap=(await a.db.getAll('snapshots')).find(snap=>!previous.has(snap.id));return{count,disabled:snap.bookmarks===undefined};});assert.equal(result.count,0);assert.equal(result.disabled,true);
  });
  await check('legacy migration survives reload and unresolved records can be rebound',async page=>{
    const id=await page.evaluate(async()=>{const a=window.nocturneApp,e=a.nocturneEditor.get('primary');a.nocturneEditor.syncDocFromEditor('primary');const doc=a.getFocusedDoc();doc.bookmarks=[{id:'legacy-ok',start:{blockId:e.getJSON().content[0].attrs.blockId,offset:7},end:{blockId:e.getJSON().content[0].attrs.blockId,offset:8},quote:'с'},{id:'legacy-lost',quote:'Текст которого уже нет'}];await a.db.put('docs',doc);return doc.id;});
    await page.reload();await page.waitForSelector('.app-shell.ready');
    const result=await page.evaluate(async id=>{const a=window.nocturneApp,doc=a.state.docs.find(doc=>doc.id===id),stored=await a.db.get('docs',id);const source=a.bookmarks.sources().find(source=>source.rich&&source.owner.id===id);a.selectDoc(id);a.bookmarks.rebinding={sourceKey:source.key,id:'legacy-lost',partIndex:0};await a.bookmarks.addContext({sourceKey:source.key,paneId:'primary',from:15,to:15});return{version:stored.bookmarks[0].version,oldStatus:stored.bookmarks[1].parts[0].anchor.status,newStatus:doc.bookmarks[1].parts[0].anchor.status};},id);assert.deepEqual(result,{version:2,oldStatus:'unresolved',newStatus:'attached'});
  });
  await check('backup replace and merge retain global and chapter bookmarks without ID collisions',async page=>{
    const result=await page.evaluate(async()=>{
      const a=window.nocturneApp,e=a.nocturneEditor.get('primary');e.commands.setTextSelection(8);await a.addBookmarkAtCurrentPosition('primary');a.state.globalNotes='Общие заметки для резервной копии';a.renderNotes();const source=a.bookmarks.sources().find(source=>source.owner.kind==='global');await a.bookmarks.addContext({sourceKey:source.key,from:4,to:10});const dump=await a.buildNocturneDump();await a.importProjectDump(dump,{mode:'replace'});const restored=a.bookmarks.sources().reduce((sum,source)=>sum+source.values.length,0);await a.importProjectDump(dump,{mode:'merge'});const all=a.bookmarks.sources().flatMap(source=>source.values);return{dumpGlobal:dump.payload.globalBookmarks.length,restored,total:all.length,unique:new Set(all.map(value=>value.id)).size,global:a.state.globalBookmarks.length};
    });assert.deepEqual(result,{dumpGlobal:1,restored:2,total:4,unique:4,global:2});
  });
  await check('trash restores deleted lore with bookmarks, links and other user records',async page=>{
    const result=await page.evaluate(async()=>{
      const a=window.nocturneApp;a.upsertNote({id:'recover-note',title:'Восстановимая запись',body:'Содержание записи'});a.state.lore.timeline.push(a.normalizeTimelineEvent({id:'recover-event',title:'Событие',body:'Описание',noteIds:['recover-note']}));await a.saveLore();const source=a.bookmarks.sources().find(source=>source.owner.id==='recover-note');await a.bookmarks.addContext({sourceKey:source.key,from:3,to:8});await a.deleteLore('notes','recover-note');const item=(await a.db.getAll('trash')).find(item=>item.type==='lore-entity'&&item.item.id==='recover-note');await a.trash.restore(item.id);a.state.settings.macros.push({keys:'Ctrl+F9',value:'Удаляемый макрос'});await a.persistSettings();a.state.settings.macros.pop();await a.persistSettings();const macro=(await a.db.getAll('trash')).find(item=>item.type==='preference'&&item.key==='macros');await a.trash.restore(macro.id);return{bookmarks:a.state.lore.notes.find(note=>note.id==='recover-note').bookmarks.length,link:a.state.lore.timeline.find(event=>event.id==='recover-event').noteIds.includes('recover-note'),macro:a.state.settings.macros.some(macro=>macro.keys==='Ctrl+F9')};
    });assert.deepEqual(result,{bookmarks:1,link:true,macro:true});
  });
  await check('bookmark-only sync preserves the manuscript selection', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
      e.commands.setTextSelection(8); await a.addBookmarkAtCurrentPosition('primary'); await a.saveActiveDoc({ silent: true });
      e.commands.setTextSelection({ from: 15, to: 22 });
      const stored = await a.db.get('docs', a.getFocusedDoc().id); stored.bookmarks[0].parts[0].note = 'Изменено на телефоне'; await a.db.put('docs', stored);
      await a.refreshAfterDatabaseSync();
      return { from: e.state.selection.from, to: e.state.selection.to, note: a.getFocusedDoc().bookmarks[0].parts[0].note };
    });
    assert.deepEqual(result, { from: 15, to: 22, note: 'Изменено на телефоне' });
  });
  await check('jump to document notes opens their hidden panel', async page => {
    const key = await page.evaluate(async () => {
      const a = window.nocturneApp; a.getFocusedDoc().notes = 'Заметка к документу с точной закладкой'; a.renderNotes();
      const source = a.bookmarks.sources().find(source => source.owner.kind === 'doc' && source.owner.id === a.getFocusedDoc().id && source.owner.field === 'notes');
      await a.bookmarks.addContext({ sourceKey: source.key, from: 8, to: 8 });
      document.getElementById('notes-panel').classList.remove('open'); return source.key;
    });
    await page.evaluate(async key => { const a = window.nocturneApp; await a.bookmarks.jump(key, a.bookmarks.source(key).values[0].id); }, key);
    assert.equal(await page.locator('#notes-panel.open').count(), 1);
    await page.locator('#notes-panel .bookmark-position-mark').waitFor();
    assert.equal(await page.locator('#notes-panel .bookmark-position-mark').count(), 1);
  });
  await check('touch navigation opens the bookmarked knowledge note and returns to a manuscript', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary'); e.commands.setTextSelection(8); await a.addBookmarkAtCurrentPosition('primary');
      a.upsertNote({ id: 'mobile-bookmarked-note', title: 'Заметка для перехода', body: 'Текст заметки с закладкой' }); await a.saveLore();
      const source = a.bookmarks.sources().find(source => source.owner.id === 'mobile-bookmarked-note'); await a.bookmarks.addContext({ sourceKey: source.key, from: 8, to: 8 }); await a.bookmarks.jump(source.key, source.values[0].id);
    });
    await page.waitForSelector('#mobile-tab-surface .note-read-text');
    assert.equal(await page.evaluate(() => window.nocturneApp.state.mobile.activeTab), 'lore');
    await page.evaluate(async () => { const a = window.nocturneApp, source = a.bookmarks.sources().find(source => source.rich && source.owner.id === a.getFocusedDoc().id); await a.bookmarks.jump(source.key, source.values[0].id); });
    assert.equal(await page.evaluate(() => window.nocturneApp.state.mobile.activeTab), 'write');
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.ProseMirror, textarea, [contenteditable="true"]')), false);
  }, true);
  await check('world rule edits keep unique owners, bookmarks and recoverable removed rules', async page => {
    await page.evaluate(async () => { const a = window.nocturneApp; a.state.lore.rules = [{ id: 'rule-first', text: 'Первое правило' }, { id: 'rule-second', text: 'Второе правило' }]; await a.saveLore(); const source = a.bookmarks.sources().find(source => source.owner.id === 'rule-second'); await a.bookmarks.addContext({ sourceKey: source.key, from: 3, to: 3 }); a.editWorldRules(); });
    await page.locator('[name="rules"]').fill('Второе правило\nНовое правило'); await page.locator('.utility-form [type="submit"]').click();
    await page.waitForSelector('#form-overlay.active', { state: 'hidden' });
    const result = await page.evaluate(async () => { const a = window.nocturneApp; return { ids: a.state.lore.rules.map(rule => rule.id), count: a.state.lore.rules[0].fieldBookmarks.text.length, deleted: (await a.db.getAll('trash')).some(item => item.type === 'lore-entity' && item.item.id === 'rule-first') }; });
    assert.equal(new Set(result.ids).size, 2); assert.equal(result.ids[0], 'rule-second'); assert.equal(result.count, 1); assert.equal(result.deleted, true);
  });
  await check('plain editing fields keep their native context menu and do not bookmark unsaved draft text', async page => {
    await page.evaluate(() => { const a = window.nocturneApp; a.getFocusedDoc().description = 'Сохранённое описание'; a.editDocForm(a.getFocusedDoc().id); });
    const field = page.locator('textarea[data-bookmark-source]'); await field.fill('Изменённое описание'); await field.focus();
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, field = document.querySelector('textarea[data-bookmark-source]'), source = a.bookmarks.source(field.dataset.bookmarkSource);
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true }); field.dispatchEvent(event);
      await a.bookmarks.addCurrent('primary'); return { prevented: event.defaultPrevented, count: source.values.length, original: a.getFocusedDoc().description };
    });
    assert.deepEqual(result, { prevented: false, count: 0, original: 'Сохранённое описание' });
  });
  await check('global notes preserve panel geometry when adding bookmarks',async page=>{
    const result=await page.evaluate(async()=>{const a=window.nocturneApp;a.state.globalNotes='Первая строка\nВторая строка';a.state.noteMode='global';a.renderNotes();document.getElementById('notes-panel').classList.add('open');const source=a.bookmarks.sources().find(source=>source.owner.kind==='global');await a.bookmarks.addContext({sourceKey:source.key,from:15,to:19});a.bookmarks.refresh();return{position:getComputedStyle(document.getElementById('notes-panel')).position,bookmarks:(await a.db.get('settings','global-notes')).bookmarks.length};});assert.equal(result.position,'absolute');assert.equal(result.bookmarks,1);await page.waitForTimeout(100);assert.ok(await page.locator('#notes-panel .bookmark-position-mark').count());
  });
} finally { await browser.close(); server.kill(); }
if(results.some(result=>!result.passed)) process.exitCode=1;
