import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = 'http://localhost:5293';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5293' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const filter = process.argv.find(arg => arg.startsWith('--match='))?.slice(8);
await mkdir('release/qa/android-polish', { recursive: true });
async function check(name, run, viewport = { width: 390, height: 844 }) {
  if (filter && !name.includes(filter)) return;
  const started = Date.now();
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 1100, hasTouch: viewport.width < 1100, userAgent: viewport.width < 1100 ? 'Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' : undefined });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(() => window.nocturneApp.handleMobileViewportChange());
    await run(page, context);
    assert.deepEqual(errors, [], 'No uncaught JavaScript errors');
    results.push({ name, passed: true, durationMs: Date.now() - started });
  } catch (error) {
    results.push({ name, passed: false, durationMs: Date.now() - started, error: error.stack, uncaughtErrors: errors });
    await page.screenshot({ path: `release/qa/android-polish/failure-${results.length}.png` }).catch(() => {});
  } finally {
    console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'}: ${name}${results.at(-1).error ? '\n' + results.at(-1).error : ''}`);
    await writeFile('release/qa/android-polish/results.json', JSON.stringify(results, null, 2));
    await context.close();
  }
}
const app = (page, callback, arg) => page.evaluate(callback, arg);
async function chapter(page, title = 'Первая глава') {
  return app(page, async title => { const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), title, 'Описание'); return a.state.activeDocId; }, title);
}
const back = page => app(page, () => window.nocturneApp.closeTopMobileOverlay());
const tab = (page, action) => page.locator(`.mobile-bottom-nav [data-action="${action}"]`).tap();
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const width of [360, 390, 1440]) await check(`empty screen and shared dropdown at ${width}px`, async page => {
    const create = page.locator('.empty-project-create').first(), more = page.locator('.empty-project-more').first();
    assert.ok((await create.boundingBox()).height >= 52);
    assert.ok((await more.locator('span').boundingBox()).width > 20, 'Other label is visible');
    await more.click(); await page.waitForSelector('#empty-project-menu.active');
    assert.equal(await page.locator('#empty-project-menu [role="menuitem"]').count(), 2);
    await page.keyboard.press('End');
    assert.equal(await app(page, () => document.activeElement.dataset.action), 'import-project-dump');
    await page.keyboard.press('Escape');
    assert.equal(await more.getAttribute('aria-expanded'), 'false');
    assert.equal(await more.evaluate(e => e === document.activeElement), true);
    await more.click();
    const picker = page.waitForEvent('filechooser');
    await page.locator('#empty-project-menu [data-action="import-doc"]').click();
    await (await picker).setFiles({ name: 'Импорт.txt', mimeType: 'text/plain', buffer: Buffer.from('Текст из файла.\nВторой абзац.') });
    await page.waitForFunction(() => window.nocturneApp.state.docs.length === 1);
    await page.waitForFunction(() => !!window.nocturneApp.nocturneEditor.get('primary'));
    assert.match(await app(page, () => window.nocturneApp.nocturneEditor.get('primary').getText()), /Текст из файла/);
  }, { width, height: width > 1000 ? 900 : 844 });

  for (const width of [320, 360, 390, 768, 1024]) await check(`navigation, safe areas and geometry at ${width}px`, async page => {
    await app(page, () => { const root = document.documentElement; root.style.setProperty('--safe-area-inset-top', '28px'); root.style.setProperty('--safe-area-inset-bottom', '24px'); });
    for (const action of ['mobile-open-docs', 'mobile-open-lore', 'mobile-open-ai', 'mobile-open-more', 'mobile-tab-write']) {
      await tab(page, action); await page.waitForTimeout(300);
      const geometry = await app(page, () => {
        const nav = document.querySelector('.mobile-bottom-nav'), active = nav.querySelector('.active');
        const style = getComputedStyle(nav, '::before'), matrix = new DOMMatrix(style.transform);
        const button = active.getBoundingClientRect(), navRect = nav.getBoundingClientRect();
        const indicatorLeft = navRect.left + parseFloat(getComputedStyle(nav).borderLeftWidth) + parseFloat(style.left) + matrix.m41;
        const topbar = document.querySelector('.mobile-topbar'), surface = document.querySelector('.mobile-tab-surface.active');
        return { width: button.width, height: button.height, indicatorDelta: Math.abs(indicatorLeft + parseFloat(style.width) / 2 - (button.left + button.width / 2)), overflow: document.documentElement.scrollWidth > innerWidth + 1, navBottom: button.bottom, viewport: innerHeight, topPadding: parseFloat(getComputedStyle(surface || topbar).paddingTop) };
      });
      assert.ok(geometry.width >= 44 && geometry.height >= 44, JSON.stringify(geometry));
      assert.ok(geometry.indicatorDelta <= 2, JSON.stringify(geometry));
      assert.equal(geometry.overflow, false);
      assert.ok(geometry.navBottom <= geometry.viewport - 24);
      assert.ok(geometry.topPadding >= 28);
    }
  }, { width, height: 844 });

  await check('chapter touch selection, folder collapse and chapter menu actions', async page => {
    const first = await chapter(page), second = await chapter(page, 'Вторая глава');
    await tab(page, 'mobile-open-docs');
    const folder = page.locator('.mobile-folder').first(), head = folder.locator('.mobile-folder-head');
    await head.tap(); await page.waitForTimeout(380);
    assert.equal(await head.getAttribute('aria-expanded'), 'false');
    assert.ok((await folder.locator('.mobile-folder-docs').boundingBox()).height < 1);
    await head.tap(); await page.waitForTimeout(380);
    const menu = page.locator(`.mobile-doc-card [data-doc-menu="${first}"]`);
    assert.equal(await menu.evaluate(e => getComputedStyle(e).opacity), '1');
    await menu.tap(); await page.waitForSelector('.doc-context-menu.open');
    await page.locator('.doc-context-menu [data-action="pin-doc"]').tap();
    await page.waitForFunction(id => window.nocturneApp.state.docs.find(d => d.id === id).pinned, first);
    await page.locator(`.mobile-doc-card [data-doc-menu="${first}"]`).tap();
    await page.waitForSelector('.doc-context-menu.open');
    await page.locator('.doc-context-menu [data-action="duplicate-doc"]').tap();
    await page.waitForFunction(() => window.nocturneApp.state.docs.length === 3);
    await app(page, () => window.nocturneApp.switchMobileTab('docs'));
    await page.locator(`.mobile-doc-card[data-doc-id="${second}"] h3`).tap();
    await page.waitForFunction(id => window.nocturneApp.state.activeDocId === id && window.nocturneApp.state.mobile.activeTab === 'write', second);
  });

  await check('Android long press, formatting, undo and cancelled touch', async (page, context) => {
    await chapter(page);
    await app(page, () => { const a = window.nocturneApp; a.nocturneEditor.get('primary').commands.setContent('<p>Первое слово и второй абзац.</p><p>Ещё один абзац.</p>'); });
    const point = await app(page, () => { const node = document.querySelector('.ProseMirror p').firstChild, r = document.createRange(); r.setStart(node, 0); r.setEnd(node, 6); const b = r.getBoundingClientRect(); return {x:b.left+b.width/2,y:b.top+b.height/2}; });
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await page.waitForTimeout(430);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await app(page, () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await app(page, () => window.nocturneApp.nocturneEditor.get('primary').state.selection.empty), false);
    assert.equal(await app(page, () => {const a=window.nocturneApp,e=a.nocturneEditor.get('primary'),s=e.state.selection;return e.state.doc.textBetween(s.from,s.to)===a.selectionController.text;}), true, 'Native touch release preserves the same model and custom selection');
    const nextWord = await app(page, () => {const n=document.querySelector('.ProseMirror p').firstChild,r=document.createRange();r.setStart(n,8);r.setEnd(n,12);const b=r.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2};});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[nextWord]});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    await app(page, () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await app(page, () => window.nocturneApp.selectionController.active), false, 'A fresh tap clears the previous custom selection');
    assert.equal(await app(page, () => window.nocturneApp.nocturneEditor.get('primary').state.selection.empty), true);
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[point]});
    await page.waitForTimeout(430);
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    const handleRect = await page.locator('[data-selection-handle="start"]').boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type:'touchStart', touchPoints:[{x:handleRect.x+handleRect.width/2,y:handleRect.y+handleRect.height/2}] });
    for (const offset of [13, 10, 2]) {
      const target = await app(page, offset => { const node=document.querySelector('.ProseMirror p').firstChild,r=document.createRange();r.setStart(node,offset);r.collapse(true);const b=r.getBoundingClientRect();return{x:b.left,y:b.top+b.height/2}; }, offset);
      await cdp.send('Input.dispatchTouchEvent', { type:'touchMove', touchPoints:[target] });
      await page.waitForTimeout(70);
      assert.equal(await app(page, offset => { const r=window.nocturneApp.selectionController.range;return offset>6?r.startOffset:r.endOffset; }, offset), 6, 'The opposite endpoint stays fixed when handles cross and return');
    }
    await cdp.send('Input.dispatchTouchEvent', { type:'touchEnd', touchPoints:[] });
    await app(page, point => {const a=window.nocturneApp,editable=document.querySelector('.ProseMirror');a.setMobileEditorSelection(a.wordRangeFromPoint(point.x,point.y,editable),editable);}, point);
    const beforeFormat = await app(page, () => {const a=window.nocturneApp,e=a.nocturneEditor.get('primary'); return { selection:e.state.selection.toJSON(),custom:a.selectionController.text,html:e.getHTML() };});
    await page.locator('.mobile-format-bar [data-command="bold"]').tap();
    const afterFormat = await app(page, () => {const a=window.nocturneApp,e=a.nocturneEditor.get('primary'); return { selection:e.state.selection.toJSON(),custom:a.selectionController.text,html:e.getHTML(),marks:e.state.storedMarks?.map(m=>m.type.name) };});
    await writeFile('release/qa/android-polish/selection-debug.json',JSON.stringify({beforeFormat,afterFormat},null,2));
    assert.equal(await page.locator('.ProseMirror p strong').first().innerText(), 'Первое');
    await app(page, () => window.nocturneApp.clearMobileEditorSelection({keepNative:false}));
    await page.locator('[data-action="mobile-open-actions"]').tap();
    await page.locator('[data-mobile-command="undo"]').tap();
    assert.equal(await page.locator('.ProseMirror strong').count(), 0);
    await back(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await page.waitForTimeout(450);
    assert.equal(await app(page, () => window.nocturneApp.selectionController.active), false);
    await app(page, () => { const a=window.nocturneApp;a.nocturneEditor.get('primary').commands.setContent(Array.from({length:45},(_,i)=>`<p>Строка ${i+1}. Ночь пахла дождём и свежими листьями.</p>`).join(''));a.setMobileEditorSelection(a.wordRangeFromPoint(60,110,document.querySelector('.ProseMirror')),document.querySelector('.ProseMirror')); });
    const endHandle = await page.locator('[data-selection-handle="end"]').boundingBox();
    const bounds = await app(page, () => { const b=window.nocturneApp.mobileSelectionDragBounds();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom}; });
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[{x:endHandle.x+endHandle.width/2,y:endHandle.y+endHandle.height/2}]});
    await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:bounds.left+70,y:bounds.bottom-5}]});
    await page.waitForFunction(() => document.querySelector('.editor-scroll-area').scrollTop > 35, null, {timeout:3000}).catch(async error => {
      await writeFile('release/qa/android-polish/selection-scroll-debug.json', JSON.stringify(await app(page, () => {const a=window.nocturneApp,b=a.mobileSelectionDragBounds(),s=b.scroller;return{drag:a.mobileSelectionDrag&&{handle:a.mobileSelectionDrag.handle,point:a.mobileSelectionDrag.point},bounds:{top:b.top,bottom:b.bottom},scroller:{height:s.clientHeight,scrollHeight:s.scrollHeight,scrollTop:s.scrollTop,overflow:getComputedStyle(s).overflowY},ancestors:[...document.querySelectorAll('.workspace-pane-body,.workspace-stage')].map(e=>({class:e.className,height:e.clientHeight,scrollHeight:e.scrollHeight,scrollTop:e.scrollTop,overflow:getComputedStyle(e).overflowY}))};}),null,2));
      throw error;
    });
    await cdp.send('Input.dispatchTouchEvent', {type:'touchCancel',touchPoints:[]});
    assert.equal(await app(page, () => window.nocturneApp.mobileSelectionScrollFrame), null, 'Cancelled selection stops edge scrolling');
  });

  await check('format bar search opens without an exception', async page => {
    await chapter(page); await page.locator('.ProseMirror').tap();
    await page.locator('.mobile-format-bar [data-action="toggle-search-menu"]').tap();
    await page.waitForSelector('#search-menu.active');
    assert.equal(await back(page), true);
  });

  await check('custom Android selection copies, cuts, pastes and undoes', async (page, context) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await chapter(page);
    await app(page, () => window.nocturneApp.nocturneEditor.get('primary').commands.setContent('<p>Первое слово.</p>'));
    const point = await app(page, () => { const n=document.querySelector('.ProseMirror p').firstChild,r=document.createRange();r.setStart(n,0);r.setEnd(n,6);const b=r.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}; });
    const cdp = await context.newCDPSession(page);
    const menu = async () => {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});
      await page.waitForTimeout(430); await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await app(page, point => document.querySelector('.ProseMirror').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y})), point);
      await page.waitForSelector('#app-context-menu.active');
      assert.equal(await app(page, () => window.nocturneApp.state.contextMenu.selectedText), 'Первое');
    };
    await menu();
    await page.locator('#app-context-menu [data-action="context-copy"]').tap();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Первое');
    await menu(); await page.locator('#app-context-menu [data-action="context-cut"]').tap();
    await page.waitForFunction(() => window.nocturneApp.nocturneEditor.get('primary').getText() === ' слово.');
    await page.waitForTimeout(550);
    await app(page, () => {const a=window.nocturneApp;a.clearMobileEditorSelection({keepNative:false});a.nocturneEditor.get('primary').commands.focus('start');});
    await app(page, point => document.querySelector('.ProseMirror').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:point.x,clientY:point.y})), point);
    await page.locator('#app-context-menu [data-action="context-paste"]').tap();
    await page.waitForFunction(() => window.nocturneApp.nocturneEditor.get('primary').getText() === 'Первое слово.');
    await app(page, () => window.nocturneApp.runEditorCommand('undo'));
    assert.equal(await app(page, () => window.nocturneApp.nocturneEditor.get('primary').getText()), ' слово.');
    await app(page, () => window.nocturneApp.runEditorCommand('redo'));
    assert.equal(await app(page, () => window.nocturneApp.nocturneEditor.get('primary').getText()), 'Первое слово.');
    await app(page, () => { Object.defineProperty(navigator.clipboard, 'writeText', {configurable:true,value:async()=>{throw new DOMException('Denied','NotAllowedError');}}); });
    await menu(); await page.locator('#app-context-menu [data-action="context-cut"]').tap();
    assert.equal(await app(page, () => window.nocturneApp.nocturneEditor.get('primary').getText()), 'Первое слово.', 'A denied clipboard write cannot delete the manuscript');
  });

  await check('all settings pages, toggles, dropdown and navigation back', async page => {
    await tab(page, 'mobile-open-more');
    await page.locator('#mobile-tab-surface [data-action="mobile-open-settings"]').tap();
    for (const name of ['visual','editor','dictionary','review','focus','macros','formatting','ai','data','export','misc']) {
      await page.locator(`[data-mobile-settings-tab="${name}"]`).tap();
      assert.equal(await app(page, () => window.nocturneApp.state.mobile.settingsTab), name);
      assert.equal(await app(page, () => document.documentElement.scrollWidth > innerWidth + 1), false);
      await back(page);
    }
    await page.locator('[data-mobile-settings-tab="visual"]').tap();
    await page.locator('#mobile-panel .mobile-panel-body').evaluate(e=>{e.scrollTop=e.scrollHeight;});
    const visualScroll = await page.locator('#mobile-panel .mobile-panel-body').evaluate(e=>e.scrollTop);
    assert.ok(visualScroll > 100);
    await back(page);
    await page.locator('[data-mobile-settings-tab="editor"]').tap();
    assert.equal(await page.locator('#mobile-panel .mobile-panel-body').evaluate(e=>e.scrollTop), 0, 'A new settings section opens at its beginning');
    await back(page); await page.locator('[data-mobile-settings-tab="visual"]').tap();
    assert.ok(Math.abs(await page.locator('#mobile-panel .mobile-panel-body').evaluate(e=>e.scrollTop) - visualScroll) < 2, 'Returning to a section restores its own scroll');
    const toggle = page.locator('#mobile-panel [data-setting="cursorGlow"]');
    const before = await toggle.getAttribute('aria-checked'); await toggle.tap();
    assert.notEqual(await toggle.getAttribute('aria-checked'), before);
    const knob = await toggle.evaluate(e => { const s=getComputedStyle(e,'::after'); return { top:parseFloat(s.top), height:parseFloat(s.height), track:e.getBoundingClientRect().height }; });
    assert.ok(knob.top >= 0 && knob.top + knob.height <= knob.track);
    const select = page.locator('#mobile-panel .nocturne-select').first();
    await select.locator('.nocturne-select-trigger').tap();
    await back(page); assert.equal(await select.evaluate(e => e.classList.contains('open')), false);
    assert.equal(await app(page, () => window.nocturneApp.state.mobile.settingsTab), 'visual');
    await back(page); await back(page);
    assert.equal(await app(page, () => window.nocturneApp.state.mobile.activeTab), 'more');
    await tab(page, 'mobile-open-ai');
    await page.locator('[data-action="mobile-open-ai-settings"]').tap();
    assert.equal(await app(page, () => window.nocturneApp.state.mobile.settingsTab), 'ai');
    await back(page); await back(page);
    assert.equal(await app(page, () => window.nocturneApp.state.mobile.activeTab), 'ai');
  });

  await check('mobile settings create macros and custom input rules', async page => {
    await chapter(page);
    await tab(page, 'mobile-open-more');
    await page.locator('#mobile-tab-surface [data-action="mobile-open-settings"]').tap();
    await page.locator('[data-mobile-settings-tab="macros"]').tap();
    const macroCount = await app(page, () => window.nocturneApp.state.settings.macros.length);
    const keys = page.locator('#mobile-panel [data-settings-id="new-macro-keys"]');
    await keys.fill('Ctrl + Alt + G');
    await page.locator('#mobile-panel [data-settings-id="new-macro-value"]').fill('§');
    await page.locator('#mobile-panel [data-action="macro-save-new"]').tap();
    await page.waitForSelector('#mobile-panel .macro-item');
    assert.match(await page.locator('#mobile-panel .macro-item').last().innerText(), /§/);
    assert.equal(await app(page, () => window.nocturneApp.state.settings.macros.at(-1).keys), 'Ctrl + Alt + G');
    await page.locator('#mobile-panel [data-action="macro-delete"]').last().tap();
    await page.locator('#form-overlay.active [data-confirm-delete-macro]').tap();
    await page.waitForFunction(count => window.nocturneApp.state.settings.macros.length === count, macroCount);
    await page.locator('#mobile-panel [data-action="macro-record-toggle"]').tap();
    await page.locator('[data-action="mobile-settings-back"]').tap();
    assert.equal(await app(page, () => !!window.nocturneApp.macroRecordingState), false);
    await page.locator('[data-mobile-settings-tab="dictionary"]').tap();
    await page.locator('#mobile-panel [data-setting="smartDictionary"]').tap();
    await page.locator('#mobile-panel .smart-dictionary-subpanel.open').waitFor({state:'visible'});
    await page.locator('#mobile-panel [data-action="dictionary-add"]').tap();
    await page.locator('#form-overlay.active #typo-wrong').fill('ночуй');
    await page.locator('#form-overlay.active #typo-correct').fill('ночью');
    await page.locator('#save-typo-rule').tap();
    await page.waitForFunction(() => document.querySelector('#mobile-panel .dictionary-list').textContent.includes('ночуй'));
    await page.locator('#mobile-panel [data-dictionary-filter="mine"]').tap();
    await page.locator('#mobile-panel [data-action="dictionary-delete"]').tap();
    await page.waitForFunction(() => !document.querySelector('#mobile-panel .dictionary-list').textContent.includes('ночуй'));
    await page.locator('[data-action="mobile-settings-back"]').tap();
    await page.locator('[data-mobile-settings-tab="formatting"]').tap();
    await page.locator('#mobile-panel [data-settings-id="new-rule-trigger"]').fill('@@@');
    await page.locator('#mobile-panel [data-setting-select="newRuleAction"] .nocturne-select-trigger').tap();
    await page.locator('#mobile-panel [data-setting-option="newRuleAction"][data-value="custom-text"]').tap();
    await page.locator('#mobile-panel [data-settings-id="new-rule-custom-text"]').fill('✦ ✦ ✦');
    await page.locator('#mobile-panel [data-action="formatting-save-new"]').tap();
    await page.waitForSelector('#mobile-panel .formatting-item');
    assert.match(await page.locator('#mobile-panel .formatting-item').last().innerText(), /@@@/);
    await page.locator('#mobile-panel [data-action="mobile-close-all"]').tap();
    await app(page, () => window.nocturneApp.nocturneEditor.get('primary').commands.setContent('<p></p>'));
    await page.locator('.ProseMirror').tap(); await page.keyboard.type('@@@'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.nocturneApp.nocturneEditor.get('primary').getText().includes('✦ ✦ ✦'));
    assert.match(await page.locator('.ProseMirror').textContent(), /✦ ✦ ✦/);
    await app(page, () => window.nocturneApp.flushOpenDocuments());
    await page.reload(); await page.waitForSelector('.app-shell.ready');
    assert.equal(await app(page, () => window.nocturneApp.state.settings.customInputRules.at(-1).customText), '✦ ✦ ✦');
    await tab(page, 'mobile-open-more');
    await page.locator('#mobile-tab-surface [data-action="mobile-open-settings"]').tap();
    await page.locator('[data-mobile-settings-tab="editor"]').tap();
    const fontPicker = page.waitForEvent('filechooser');
    await page.locator('#mobile-panel label:has([data-settings-id="custom-font-uploader"])').tap();
    await (await fontPicker).setFiles({name:'Шрифт для рукописи.ttf',mimeType:'font/ttf',buffer:await readFile('src/assets/fonts/e9292e12f73f31cb3c5f.ttf')});
    await page.waitForFunction(() => window.nocturneApp.state.settings.customFonts?.some(font=>font.name==='Шрифт для рукописи'));
    await page.locator('#mobile-panel [data-setting-select="fontFamily"] .nocturne-select-trigger').tap();
    await page.locator('#mobile-panel [data-setting-option="fontFamily"][data-value="Шрифт для рукописи"]').tap();
    assert.match(await page.locator('.ProseMirror').evaluate(e=>getComputedStyle(e).fontFamily), /Шрифт для рукописи/);
    await page.locator('[data-action="mobile-settings-back"]').tap();
    await page.locator('[data-mobile-settings-tab="data"]').tap();
    await page.locator('#mobile-panel [data-settings-id="session-password"]').fill('isolated-mobile-fixture');
    await page.locator('#mobile-panel [data-action="save-password"]').tap();
    await page.waitForFunction(() => window.nocturneApp.state.sessionPassword === 'isolated-mobile-fixture');
    await page.locator('#mobile-panel [data-setting="e2e"]').tap();
    await page.waitForFunction(async () => { const a=window.nocturneApp;return a.state.settings.e2e && !!(await a.db.getRaw('docs',a.state.activeDocId)).protectedStore; });
    await page.reload(); await page.waitForSelector('.app-shell.ready');
    assert.match(await app(page, () => window.nocturneApp.nocturneEditor.get('primary').getText()), /✦ ✦ ✦/);
    assert.equal(await app(page, () => window.nocturneApp.state.docs.some(doc=>doc.locked)), false);
  });

  await check('keyboard resizing, chapter search, focus and landscape', async page => {
    await chapter(page); await tab(page, 'mobile-open-docs');
    const field = page.locator('[data-mobile-doc-search]');
    await field.tap(); await page.setViewportSize({width:390,height:430}); await page.waitForTimeout(180);
    assert.equal(await app(page, () => window.nocturneApp.state.mobile.keyboardOpen), true);
    await field.fill('нет такого');
    assert.equal(await field.evaluate(e=>e===document.activeElement), true);
    assert.equal(await page.locator('.mobile-empty-card [data-action="new-doc"]').count(), 0);
    const rect = await page.locator('#mobile-tab-surface').boundingBox(); assert.ok(rect.y+rect.height<=431);
    await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(180);
    await field.fill('Первая'); assert.equal(await page.locator('.mobile-doc-card').count(), 1);
    await page.locator('.mobile-doc-card h3').tap();
    await page.setViewportSize({width:844,height:390}); await page.waitForTimeout(180);
    await page.locator('.ProseMirror').tap();
    assert.equal(await app(page, () => window.nocturneApp.state.mobile.keyboardOpen), false, 'Rotation is not a keyboard');
    assert.equal(await app(page, () => document.documentElement.scrollWidth > innerWidth + 1), false);
  });

  await check('notes persist, nested modals sit above panels and back restores routes', async page => {
    const id = await chapter(page); await tab(page, 'mobile-open-more');
    await page.locator('#mobile-tab-surface [data-action="mobile-open-notes"]').tap();
    await page.locator('[data-mobile-notes-input]').fill('Заметки к главе');
    await page.locator('[data-mobile-notes-mode="global"]').tap();
    await page.locator('[data-mobile-notes-input]').fill('Общие записи');
    await page.locator('[data-mobile-notes-mode="document"]').tap();
    assert.equal(await page.locator('[data-mobile-notes-input]').inputValue(), 'Заметки к главе');
    await app(page, () => window.nocturneApp.flushOpenDocuments());
    assert.equal(await app(page, async id => (await window.nocturneApp.db.get('docs', id)).notes, id), 'Заметки к главе');
    await page.locator('#mobile-panel [data-action="open-floating-notes-manager"]').tap();
    if (await page.locator('.floating-notes-modal.active').count()) {
      assert.equal(await app(page, () => document.querySelector('.floating-notes-modal').getAttribute('aria-modal') || document.querySelector('.floating-notes-modal [aria-modal="true"]')?.getAttribute('aria-modal')), 'true');
      await back(page);
    }
    await app(page, () => window.nocturneApp.openBookExport());
    if (await page.locator('#form-overlay.active').count()) {
      const layers = await app(page, () => ({form:+getComputedStyle(document.querySelector('#form-overlay')).zIndex,panel:+getComputedStyle(document.querySelector('#mobile-overlay')).zIndex})); assert.ok(layers.form > layers.panel);
      await back(page);
    }
    await back(page); assert.equal(await app(page, () => window.nocturneApp.state.mobile.activeTab), 'more');
    await page.reload(); await page.waitForSelector('.app-shell.ready');
    assert.equal(await app(page, () => window.nocturneApp.state.docs.find(d=>d.id===window.nocturneApp.state.activeDocId)?.notes), 'Заметки к главе');
    assert.equal(await app(page, () => window.nocturneApp.state.globalNotes), 'Общие записи');
  });

  await check('paper theme follows all mobile surfaces', async page => {
    await chapter(page); await app(page, () => { const a=window.nocturneApp; a.state.settings.theme='paper'; a.applySettings(); });
    for (const name of ['write','docs','lore','ai','more']) {
      await app(page, name => window.nocturneApp.switchMobileTab(name), name);
      await page.waitForTimeout(260);
      const colors = await app(page, () => { const nav=getComputedStyle(document.querySelector('.mobile-bottom-nav')); return { background:nav.backgroundColor, color:nav.color, page:getComputedStyle(document.querySelector('.page')).backgroundColor }; });
      assert.notEqual(colors.background, 'rgb(18, 18, 22)', JSON.stringify(colors));
      if (name === 'lore') {
        const contrast = await app(page, () => ({world:getComputedStyle(document.querySelector('.kb-project-switcher > span')).color,title:getComputedStyle(document.querySelector('.mobile-tab-header h2')).color}));
        assert.equal(contrast.world, contrast.title, 'The world title remains readable in the paper theme');
      }
      await page.screenshot({path:`release/qa/android-polish/paper-${name}.png`});
    }
  });

  await check('Android IME composition, paragraphs, deletion and saved text', async (page, context) => {
    const id = await chapter(page);
    await app(page, () => window.nocturneApp.nocturneEditor.get('primary').commands.setContent('<p></p>'));
    await page.locator('.ProseMirror').tap();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'Прив', selectionStart: 4, selectionEnd: 4 });
    await cdp.send('Input.imeSetComposition', { text: 'Привет', selectionStart: 6, selectionEnd: 6 });
    await cdp.send('Input.insertText', { text: 'Привет' });
    await page.waitForFunction(() => !window.nocturneApp.nocturneEditor.get('primary').view.composing);
    await page.waitForTimeout(180);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(180);
    await page.keyboard.insertText('Вторая строка');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(250);
    assert.equal(await app(page, () => window.nocturneApp.nocturneEditor.get('primary').getText()), 'Привет\n\nВторая строк');
    await app(page, () => window.nocturneApp.flushOpenDocuments());
    await page.reload(); await page.waitForSelector('.app-shell.ready');
    assert.equal(await app(page, () => window.nocturneApp.nocturneEditor.get('primary').getText()), 'Привет\n\nВторая строк');
    assert.equal(await app(page, () => window.nocturneApp.state.activeDocId), id);
    await page.locator('.ProseMirror').tap();
    await app(page, () => window.nocturneApp.nocturneEditor.get('primary').commands.focus('end'));
    await page.keyboard.press('Shift+Enter'); await page.keyboard.insertText('Продолжение');
    assert.ok(await page.locator('.ProseMirror br').count());
    await app(page, () => window.nocturneApp.flushOpenDocuments());
  });

  await check('native bar color adapter handles mobile themes', async page => {
    const colors = await app(page, async () => {
      const { nativeBarColor } = await import('/src/platform/runtime.js');
      const a = window.nocturneApp, result = {};
      for (const theme of ['nocturne','paper','abyss','matrix','void','crimson','adaptive','blazing']) {
        a.state.settings.theme = theme; a.applySettings();
        result[theme] = nativeBarColor(getComputedStyle(document.querySelector('.mobile-topbar')).backgroundColor);
      }
      return result;
    });
    for (const color of Object.values(colors)) assert.match(color, /^#[\da-f]{6}$/i);
    assert.equal(colors.paper, '#f4ecdf');
    assert.notEqual(colors.adaptive, colors.paper);
  });

  await check('writing workflow, folder move, bookmarks, review and local analysis', async (page, context) => {
    assert.equal(await app(page, () => window.nocturneApp.state.settings.fontSize), 18);
    const docId = await app(page, async () => { const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Сцена', ''); a.nocturneEditor.get('primary').commands.setContent('<p>Ночь пахла дождём. Элиза вернулась домой.</p>'); return a.state.activeDocId; });
    await page.locator('.ProseMirror p').tap();
    const tray = page.locator('.mobile-format-scroll'), cdp = await context.newCDPSession(page);
    const rect = await tray.boundingBox(), origin = { x:rect.x+rect.width-20, y:rect.y+rect.height/2 };
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[origin]});
    for (let i = 1; i <= 8; i++) { await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:origin.x-180*i/8,y:origin.y}]}); await page.waitForTimeout(20); }
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    assert.ok(await tray.evaluate(element => element.scrollLeft) > 40, 'Formatting tools can be swiped horizontally');
    assert.equal(await page.locator('#search-menu.active').count(), 0, 'Swiping does not execute a tool');
    await page.locator('.mobile-format-bar [data-action="mobile-finish-editing"]').tap();
    await tab(page, 'mobile-open-docs');
    assert.match(await page.locator('.mobile-doc-card p').innerText(), /Ночь пахла дождём/);
    await page.locator('.mobile-folder-menu').first().tap();
    await page.locator('#mobile-folder-menu [data-folder-action="rename-folder"]').tap();
    await page.locator('#form-overlay.active [name="title"]').fill('Первая часть');
    await page.locator('#form-overlay.active [type="submit"]').tap();
    await page.waitForFunction(() => document.querySelector('.mobile-folder-head').textContent.includes('Первая часть'));
    const from = await page.locator('.mobile-doc-card h3').boundingBox(), target = page.locator('.mobile-folder').nth(1);
    const to = await target.locator('.mobile-folder-docs').boundingBox(), folderId = await target.getAttribute('data-folder-id');
    const drag = { x:from.x+from.width/2, y:from.y+from.height/2 };
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[drag]}); await page.waitForTimeout(430);
    for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:[{x:drag.x,y:drag.y+(to.y+to.height/2-drag.y)*i/10}]}); await page.waitForTimeout(40); }
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    await page.waitForFunction(({docId,folderId}) => window.nocturneApp.state.docs.find(d=>d.id===docId).folderId === folderId, {docId,folderId});
    await tab(page, 'mobile-tab-write');
    await page.locator('.mobile-topbar [data-action="mobile-open-actions"]').tap();
    await page.locator('#mobile-panel [data-action="mobile-open-bookmarks"]').tap();
    await page.locator('[data-action="mobile-add-bookmark"]').tap();
    await page.waitForSelector('.mobile-bookmark-row');
    await page.locator('[data-action="mobile-jump-bookmark"]').tap();
    await page.waitForFunction(() => !window.nocturneApp.state.mobile.panel);
    await page.locator('.mobile-topbar [data-action="mobile-open-actions"]').tap();
    await page.locator('#mobile-panel [data-review-mode="editor"]').tap();
    assert.equal(await page.locator('.ProseMirror').getAttribute('contenteditable'), 'false');
    const point = await app(page, () => { const n=document.querySelector('.ProseMirror p').firstChild,r=document.createRange();r.setStart(n,0);r.setEnd(n,4);const b=r.getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}; });
    await cdp.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:[point]}); await page.waitForTimeout(430);
    await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
    await page.locator('#mobile-review-toolbar [data-action="quick-review-comment"]').tap();
    await page.locator('#form-overlay.active #review-comment').fill('Начать с действия');
    await page.locator('#save-review-comment').tap();
    await page.waitForFunction(() => window.nocturneApp.state.reviewMarks.some(mark=>mark.quote==='Ночь'&&mark.comment==='Начать с действия'));
    await page.locator('.mobile-format-bar [data-action="mobile-finish-editing"]').tap();
    await page.locator('.mobile-topbar [data-action="mobile-open-actions"]').tap();
    await page.locator('#mobile-panel [data-review-mode="finalization"]').tap();
    await page.locator('#review-navigator [data-action="review-resolve"]').tap();
    await page.waitForFunction(() => window.nocturneApp.state.reviewMarks.every(mark=>mark.status!=='open'));
    await tab(page, 'mobile-open-ai');
    await page.locator('#mobile-tab-surface [data-ai="sentiment"]').tap();
    assert.match(await page.locator('.mobile-ai-output').innerText(), /График тональности обновлен/);
    assert.ok(await page.locator('[data-mobile-sentiment]').evaluate(c=>c.__sentimentValues.length>0));
    await app(page, async () => { const a=window.nocturneApp;a.state.settings.fontSize=16;await a.persistSettings(); });
    await page.reload(); await page.waitForSelector('.app-shell.ready');
    assert.equal(await app(page, () => window.nocturneApp.state.settings.fontSize), 16, 'Saved font preference is retained');
    const saved = await app(page, id=>window.nocturneApp.state.docs.find(d=>d.id===id), docId);
    assert.equal(saved.folderId, folderId);
    assert.equal(saved.description, '');
    assert.equal(saved.bookmarks.length, 1);
  });

  await check('lore forms, dossiers, related chapters and note reading', async page => {
    const docId = await chapter(page);
    await tab(page, 'mobile-open-lore');
    for (const type of ['characters','locations','timeline','notes']) {
      await page.locator(`[data-mobile-kb-tab="${type}"]`).tap();
      await page.locator('#mobile-tab-surface .mobile-panel-actions [data-action="new-lore"]').tap();
      await page.waitForSelector('#lore-form');
      await page.locator(`#lore-form [name="${type === 'characters' ? 'firstName' : type === 'locations' ? 'name' : 'title'}"]`).fill(`Запись ${type}`);
      await page.locator('#lore-form [name="body"]').fill('Описание для проверки мобильного досье');
      await page.locator('#lore-form [type="submit"]').tap();
      await page.waitForFunction(type => window.nocturneApp.state.lore[type].length === 1, type);
      const card = type === 'timeline' ? '#mobile-tab-surface .timeline-content h3' : '.mobile-lore-main';
      await page.waitForSelector(card);
      await page.waitForTimeout(350);
      await page.screenshot({path:`release/qa/android-polish/lore-${type}.png`});
      await page.locator(card).first().tap();
      await page.waitForSelector('#mobile-tab-surface .lore-detail');
      assert.match(await page.locator('#mobile-tab-surface .lore-detail').innerText(), /Описание для проверки/);
      if (type === 'characters') {
        await page.locator('.dossier-doc-list [data-doc-id]').tap();
        assert.equal(await app(page, () => window.nocturneApp.state.mobile.activeTab), 'write');
        assert.equal(await app(page, () => window.nocturneApp.getFocusedDoc().id), docId);
        await tab(page, 'mobile-open-lore');
      }
      if (type === 'notes') {
        await page.locator('#mobile-tab-surface [data-action="toggle-note-read-mode"]').tap();
        await page.waitForSelector('#mobile-tab-surface .note-read-mode');
        await page.locator('#mobile-tab-surface .mobile-panel-header [data-action="toggle-note-read-mode"]').tap();
        assert.equal(await page.locator('#mobile-tab-surface .note-read-mode').count(), 0);
        await page.locator('#mobile-tab-surface [data-action="toggle-note-read-mode"]').tap();
        await back(page);
        assert.equal(await app(page, () => window.nocturneApp.state.kbReadMode), false);
        assert.equal(await app(page, () => !!window.nocturneApp.state.activeLoreDetail), true);
      }
      if (await app(page, () => !!window.nocturneApp.state.activeLoreDetail)) await back(page);
    }
    const search = page.locator('[data-mobile-lore-search]');
    await search.fill('Совпадений не будет');
    assert.match(await page.locator('#mobile-tab-surface .empty-card').innerText(), /Совпадений нет/);
    await search.fill('');
    await page.reload(); await page.waitForSelector('.app-shell.ready');
    const counts = await app(page, () => ['characters','locations','timeline','notes'].map(type=>window.nocturneApp.state.lore[type].length));
    assert.deepEqual(counts, [1,1,1,1]);
    await tab(page, 'mobile-open-lore');
    await page.locator('[data-mobile-kb-tab="notes"]').tap();
    await page.locator('.mobile-lore-card [data-action="toggle-note-completed"]').tap();
    assert.equal(await page.locator('.mobile-lore-card [data-action="toggle-note-completed"]').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => window.nocturneApp.state.lore.notes[0].completed);
    await page.locator('.mobile-lore-card [data-action="edit-lore"]').tap();
    await app(page, () => window.nocturneApp.saveLore());
    await page.locator('#lore-form [name="title"]').fill('Изменённая запись');
    await page.locator('#lore-form [type="submit"]').tap();
    await page.waitForFunction(() => document.querySelector('.mobile-lore-main strong')?.textContent === 'Изменённая запись');
    await page.reload(); await page.waitForSelector('.app-shell.ready');
    assert.equal(await app(page, () => window.nocturneApp.state.lore.notes[0].title), 'Изменённая запись');
    await tab(page, 'mobile-open-lore'); await page.locator('[data-mobile-kb-tab="notes"]').tap();
    await page.locator('.mobile-lore-card [data-action="edit-lore"]').tap();
    await page.locator('#lore-form [data-delete-lore]').tap();
    await page.waitForFunction(() => window.nocturneApp.state.lore.notes.length === 0);
    await page.waitForSelector('#mobile-tab-surface .empty-card');
  });

  await check('both workspace panes remain reachable on a phone', async page => {
    const first = await chapter(page), second = await chapter(page, 'Вторая глава');
    await app(page, id => window.nocturneApp.selectDoc(id), first);
    await tab(page, 'mobile-open-docs');
    await page.locator(`.mobile-doc-card [data-doc-menu="${second}"]`).tap();
    await page.locator('.doc-context-menu [data-action="open-doc-right"]').tap();
    const secondary = page.locator('.workspace-pane[data-pane-id="secondary"]');
    await secondary.waitFor({state:'visible'});
    assert.equal(await app(page, () => window.nocturneApp.getFocusedDoc().id), second);
    assert.equal(await app(page, () => window.nocturneApp.state.mobile.activeTab), 'write');
    await page.locator('[data-action="mobile-open-actions"]').tap();
    await page.locator('[data-action="mobile-switch-pane"]').tap();
    assert.equal(await app(page, () => window.nocturneApp.getFocusedDoc().id), first);
    await page.locator('.workspace-pane[data-pane-id="primary"]').waitFor({state:'visible'});
    await tab(page, 'mobile-open-docs');
    await page.locator(`.mobile-doc-card[data-doc-id="${second}"] h3`).tap();
    await secondary.waitFor({state:'visible'});
    await page.locator('[data-action="mobile-open-actions"]').tap();
    await page.locator('#mobile-panel [data-action="close-secondary-pane"]').tap();
    assert.equal(await app(page, () => window.nocturneApp.state.workspace.mode), 'single');
    assert.equal(await app(page, () => window.nocturneApp.getFocusedDoc().id), first);
  });

  await check('empty screen restores a project through the file picker', async page => {
    const sourceContext = await browser.newContext();
    const source = await sourceContext.newPage(); await source.goto(url); await source.waitForSelector('.app-shell.ready');
    await chapter(source, 'Восстановленная глава');
    await app(source, () => window.nocturneApp.nocturneEditor.get('primary').commands.setContent('<p>Сохранённый текст</p>'));
    const dump = await app(source, () => window.nocturneApp.buildNocturneDump());
    await sourceContext.close();
    await page.locator('.empty-project-more').first().tap();
    const picker = page.waitForEvent('filechooser');
    await page.locator('#empty-project-menu [data-action="import-project-dump"]').tap();
    await (await picker).setFiles({name:'backup.nocturnedump',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(dump))});
    await page.waitForSelector('.project-dump-modal');
    await page.locator('[data-action="merge-project-dump"]').tap();
    await page.waitForFunction(() => window.nocturneApp.state.docs.some(doc => doc.title === 'Восстановленная глава'));
    const restored = await app(page, () => window.nocturneApp.state.docs.find(doc=>doc.title==='Восстановленная глава'));
    await app(page, id => window.nocturneApp.selectDoc(id), restored.id);
    assert.equal(await app(page, () => window.nocturneApp.nocturneEditor.get(window.nocturneApp.state.workspace.focusedPaneId).getText()), 'Сохранённый текст');
  });
} finally {
  await browser.close(); server.kill();
  await writeFile('release/qa/android-polish/results.json', JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
