import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const directory = 'release/qa/bookmarks-design';
await mkdir(directory, { recursive: true });
const url = 'http://localhost:5334';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5334', SYNC_PORT: '8934' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true }), results = [];
async function check(name, run, { mobile = false, reduced = false } = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(async () => {
      const a = window.nocturneApp; a.state.settings.automaticBackups = false;
      await a.createDoc(a.defaultFolderId(), 'Визуал закладок', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>' + 'Абзац с длинной строкой, переносами и пространством от фигурной скобки. '.repeat(4) + '</p><p>Второй абзац с отдельной закладкой.</p><p>Третий фрагмент для поиска и палитры.</p>');
      await document.fonts.ready;
    });
    await page.waitForTimeout(600);
    await run(page); assert.deepEqual(errors, []);
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.stack, errors });
    await page.screenshot({ path: directory + '/failure-' + results.length + '.png' }).catch(() => {});
  } finally {
    console.log((results.at(-1).passed ? 'PASS ' : 'FAIL ') + name + (results.at(-1).error ? '\n' + results.at(-1).error : ''));
    await writeFile(directory + '/results.json', JSON.stringify(results, null, 2)); await context.close();
  }
}
async function seed(page) {
  await page.evaluate(async () => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
    a.state.settings.bookmarkMode = 'point'; e.commands.setTextSelection(5); await a.addBookmarkAtCurrentPosition('primary');
    a.bookmarks.filter = 'docs';
    if (a.isMobileLayout()) { a.state.mobile.kbTab = 'bookmarks'; a.state.activeKbTab = 'bookmarks'; a.switchMobileTab('lore'); }
    else a.openKb('bookmarks');
  });
  await page.waitForSelector('.bookmark-manager');
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  await check('curved paragraph fill, continuous pointer path, clickable icon and retained geometry', async page => {
    const before = await page.evaluate(async () => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
      a.state.settings.bookmarkMode = 'paragraph'; e.commands.setTextSelection(5); await a.addBookmarkAtCurrentPosition('primary');
      window.originalMarkerJSON = JSON.stringify(e.getJSON());
      return e.view.dom.querySelector('p').getBoundingClientRect().toJSON();
    });
    const brace = page.locator('.bookmark-paragraph-bracket'); await brace.waitFor();
    const b = await brace.boundingBox(); await page.mouse.move(b.x + 6, b.y + b.height / 2); await page.waitForTimeout(380);
    const geometry = await page.evaluate(() => {
      const fill = document.querySelector('.bookmark-paragraph-fill'), path = fill.querySelector('path'), height = fill.viewBox.baseVal.height;
      window.savedMarker = document.querySelector('.bookmark-position-mark');
      return { left: fill.getBoundingClientRect().left, opacity: getComputedStyle(fill).opacity,
        curve: [2, 12, 39, 50, 61, 88, 98].every(y => !path.isPointInFill(new DOMPoint(0, height * y / 100)) && path.isPointInFill(new DOMPoint(13, height * y / 100))) };
    });
    assert.equal(geometry.opacity, '1'); assert.ok(geometry.left < before.left - 12); assert.equal(geometry.curve, true);
    await page.mouse.move(before.left + before.width / 2, before.top + before.height / 2, { steps: 8 });
    await page.waitForTimeout(70); assert.equal(await page.locator('.bookmark-position-icon').evaluate(el => getComputedStyle(el).opacity), '1');
    await page.evaluate(() => window.nocturneApp.bookmarks.refresh()); await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => window.savedMarker === document.querySelector('.bookmark-position-mark')), true);
    const icon = await page.locator('.bookmark-position-icon').boundingBox();
    await page.mouse.move(icon.x + icon.width / 2, icon.y + icon.height / 2, { steps: 12 }); await page.waitForTimeout(60);
    assert.equal(await page.locator('.bookmark-paragraph-fill').evaluate(el => getComputedStyle(el).opacity), '1');
    await page.screenshot({ path: directory + '/paragraph-hover.png' });
    await page.evaluate(() => {
      const a = window.nocturneApp, jump = a.bookmarks.jump.bind(a.bookmarks);
      window.jumpClicks = 0; a.bookmarks.jump = (...args) => { window.jumpClicks++; return jump(...args); };
    });
    await page.mouse.click(icon.x + icon.width / 2, icon.y + icon.height / 2);
    assert.equal(await page.evaluate(() => window.jumpClicks), 1);
    assert.equal(await page.evaluate(() => JSON.stringify(window.nocturneApp.nocturneEditor.get('primary').getJSON()) === window.originalMarkerJSON), true);
    await page.mouse.move(1, 1); await page.waitForTimeout(2000);
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.bookmark-paragraph-fill')).opacity) < .001);
  });
  await check('scope uses the main mode selector, keyboard menu and cancellable label transition', async page => {
    await seed(page);
    const trigger = page.locator('.bookmark-scope-trigger'); await trigger.click();
    assert.equal(await page.locator('#bookmark-scope-menu [role="menuitemradio"]').count(), 3);
    await page.locator('#bookmark-scope-menu [data-value="lore"]').click(); await page.waitForTimeout(350); await trigger.click();
    await page.keyboard.press('Home'); await page.keyboard.press('Enter'); await page.waitForTimeout(40);
    await trigger.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.waitForTimeout(450);
    assert.equal(await trigger.getAttribute('aria-label'), 'Область закладок: Все закладки');
    assert.equal(await trigger.locator('.review-mode-trigger-label').innerText(), 'Все закладки');
    await trigger.click(); await page.waitForTimeout(220);
    assert.equal(await page.locator('#bookmark-scope-menu [data-value="docs"]').evaluate(el => { const r=el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); }),true);
    await page.screenshot({ path: directory + '/scope-menu.png' }); await page.keyboard.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await trigger.evaluate(el => document.activeElement === el), true);
    assert.equal(await trigger.evaluate(el => el.style.width), '');
    await page.screenshot({ path: directory + '/manager-desktop.png' });
  });
  await check('search and custom binding selector align, filter and preserve search focus', async page => {
    await seed(page);
    const input = page.locator('[data-bookmark-search]'), select = page.locator('.bookmark-status-control .nocturne-select-trigger');
    await page.waitForTimeout(500);
    const geometry = await page.evaluate(() => { const a=document.querySelector('[data-bookmark-search]').getBoundingClientRect(), b=document.querySelector('.bookmark-status-control .nocturne-select-trigger').getBoundingClientRect(); return { height:Math.abs(a.height-b.height), y:Math.abs(a.y-b.y) }; });
    assert.ok(geometry.height < 1 && geometry.y < 1, JSON.stringify(geometry));
    assert.equal(await page.locator('.bookmark-manager select, .bookmark-manager input[type="color"]').count(), 0);
    await select.click(); await page.keyboard.press('End'); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.nocturneApp.bookmarks.status), 'unresolved');
    assert.match(await page.locator('.bookmark-manager-list').innerText(), /Закладок пока нет/);
    await select.click(); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    await input.fill('не существует'); await input.fill('Закладка');
    assert.equal(await input.evaluate(el => document.activeElement === el), true);
    await page.waitForTimeout(650); assert.equal(await page.locator('.bookmark-manager-row').count(), 1);
    await page.locator('[data-bookmark-select]').check(); assert.match(await page.locator('[data-bookmark-selection-count]').innerText(), /Выбрано: 1/);
    assert.equal(await page.locator('[data-bookmark-action="delete-selected"]').isEnabled(), true);
  });
  for (const reduced of [false,true]) await check('knowledge tabs animate and cancel to the latest view (' + (reduced ? 'reduced' : 'normal') + ')', async page => {
    await page.evaluate(() => window.nocturneApp.openKb('characters'));
    await page.locator('#kb-modal [data-kb-tab="bookmarks"]').click();
    assert.equal(await page.locator('.bookmark-manager').evaluate(el => !!el.__nocturneMotions?.get('kb-tab')), !reduced);
    await page.locator('#kb-modal [data-kb-tab="search"]').click();
    assert.equal(await page.locator('.knowledge-search').evaluate(el => !!el.__nocturneMotions?.get('kb-tab')), !reduced);
    await page.evaluate(() => {
      for (const tab of ['bookmarks','search','notes','bookmarks','search','bookmarks']) document.querySelector('#kb-modal [data-kb-tab="' + tab + '"]').click();
    });
    await page.waitForTimeout(750);
    assert.equal(await page.locator('#kb-modal .bookmark-manager').count(),1); assert.equal(await page.locator('#kb-modal .knowledge-search').count(),0);
    assert.equal(await page.locator('#kb-modal').evaluate(el => el.getAnimations({subtree:true}).filter(a => a.playState === 'running').length),0);
    await page.locator('#kb-modal .kb-close-btn').click(); await page.waitForTimeout(400);
    assert.equal(await page.locator('#kb-modal').evaluate(el => el.classList.contains('active')), false);
  }, { reduced });
  for (const mobile of [false,true]) await check('existing color palette works without a native picker (' + (mobile ? 'touch' : 'desktop') + ')', async page => {
    await seed(page); await page.locator('.bookmark-manager-main').click();
    assert.equal(await page.locator('.bookmark-edit-modal input[type="color"], .bookmark-edit-modal select').count(), 0);
    const picker = page.locator('[data-bookmark-color-picker]');
    await picker.locator('[data-bookmark-color="#22C55E"]').click(); assert.equal(await picker.locator('[name="color-0"]').inputValue(), '#22C55E');
    await picker.locator('[data-bookmark-color-hex]').fill('ff7700');
    assert.equal(await picker.locator('[name="color-0"]').inputValue(), '#FF7700');
    await picker.locator('[data-bookmark-color-hex]').fill('xyz');
    assert.equal(await picker.locator('[data-bookmark-color-hex]').getAttribute('aria-invalid'), 'true');
    await picker.locator('[data-bookmark-color="#0EA5E9"]').click();
    await page.waitForTimeout(250);
    assert.equal(await picker.locator('.accent-swatch-orb').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(14, 165, 233)');
    await page.screenshot({ path: directory + '/edit-' + (mobile ? 'mobile' : 'desktop') + '.png' });
    await page.locator('.bookmark-edit-modal [type="submit"]').click(); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.nocturneApp.getFocusedDoc().bookmarks[0].parts[0].color), '#0EA5E9');
    await page.locator('.bookmark-manager-main').click(); await picker.locator('[data-bookmark-color=""]').click();
    await page.locator('.bookmark-edit-modal [type="submit"]').click();
    assert.equal(await page.evaluate(() => window.nocturneApp.getFocusedDoc().bookmarks[0].parts[0].color), '');
  }, { mobile });
  await check('manuscript popup retains trigger and popup during bookmark changes, with keyboard exit', async page => {
    const trigger = page.locator('.pane-bookmarks-btn');
    await page.evaluate(() => { window.savedTrigger = document.querySelector('.pane-bookmarks-btn'); window.savedPopup = window.nocturneApp.bookmarks.paneMenus.get('primary').dropdown; });
    await trigger.click();
    await page.waitForTimeout(220); await page.screenshot({ path: directory + '/manuscript-menu.png' });
    await page.evaluate(async () => { const a=window.nocturneApp; a.nocturneEditor.get('primary').commands.setTextSelection(5); await a.addBookmarkAtCurrentPosition('primary'); });
    assert.equal(await page.evaluate(() => window.savedTrigger === document.querySelector('.pane-bookmarks-btn') && window.savedPopup === window.nocturneApp.bookmarks.paneMenus.get('primary').dropdown), true);
    assert.equal(await trigger.getAttribute('aria-expanded'),'true'); assert.equal(await page.locator('.pane-bookmarks-dropdown.active').count(),1);
    await page.locator('.pane-bookmarks-item-text').focus(); await page.keyboard.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'),'false'); assert.equal(await trigger.evaluate(el => document.activeElement === el),true);
  });
  await check('mobile knowledge navigation persists on bookmark and search tabs; settings route works', async page => {
    await seed(page); assert.equal(await page.locator('.mobile-lore-tabs [data-mobile-kb-tab]').count(),6);
    await page.locator('[data-mobile-kb-tab="search"]').click(); await page.locator('[data-mobile-kb-tab="bookmarks"]').click();
    await page.locator('[data-mobile-kb-tab="characters"]').click(); await page.locator('[data-mobile-kb-tab="bookmarks"]').click();
    await page.waitForTimeout(600); assert.equal(await page.locator('.mobile-lore-tabs [data-mobile-kb-tab]').count(),6);
    assert.equal(await page.locator('.bookmark-manager').count(),1);
    assert.ok(await page.locator('.bookmark-scope-trigger').evaluate(el => el.getBoundingClientRect().height >= 44));
    await page.locator('.bookmark-scope-trigger').click();
    const menu = await page.locator('#bookmark-scope-menu').boundingBox(); assert.ok(menu.x >= 0 && menu.x + menu.width <= 390);
    await page.locator('#bookmark-scope-menu [data-value="all"]').click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: directory + '/manager-mobile.png' });
    await page.evaluate(() => window.nocturneApp.openSettingsTab('bookmarks'));
    await page.waitForSelector('[data-setting-select="bookmarkMode"]');
    assert.equal(await page.locator('[data-setting="bookmarkConfirmTextDeletion"]').count(),1);
  }, { mobile: true });
  await check('copies use the existing moving selection and keep separate editable values', async page => {
    await seed(page); await page.evaluate(async()=>{ const a=window.nocturneApp; await a.duplicateDoc(a.getFocusedDoc().id); });
    await page.locator('.bookmark-manager-main').click(); assert.equal(await page.locator('[data-bookmark-variant]').count(),2);
    await page.locator('[data-bookmark-variant="1"]').click(); await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-bookmark-variant="1"]').getAttribute('aria-pressed'),'true');
    assert.ok(await page.locator('.bookmark-variant-switch .knowledge-selection').evaluate(el=>el.getBoundingClientRect().width>0));
    await page.locator('[name="title-0"]').fill('Копия со своим названием');
    await page.locator('.bookmark-edit-modal [type="submit"]').click();
    await page.waitForSelector('#form-overlay.active', { state: 'hidden' });
    assert.equal(await page.locator('.bookmark-manager-row').count(),2);
  });
  await check('trash filters reuse animated selection and rapid filtering settles correctly', async page => {
    await seed(page); await page.evaluate(async()=>{ const a=window.nocturneApp,s=a.bookmarks.paneSource('primary');await a.bookmarks.remove(s.key,s.values[0].id,{confirm:false}); await a.trash.open(); });
    await page.locator('[data-trash-filter="bookmarks"]').click(); await page.waitForTimeout(350);
    assert.ok(await page.locator('.trash-category-tabs .knowledge-selection').evaluate(el=>el.getBoundingClientRect().width>0));
    await page.evaluate(()=>{ for(const id of ['documents','all','lore','bookmarks']) document.querySelector('[data-trash-filter="'+id+'"]').click(); });
    await page.waitForTimeout(700); assert.equal(await page.locator('[data-trash-filter="bookmarks"]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('.trash-manager .utility-row').count(),1);
    await page.screenshot({path:directory+'/trash.png'});
    await page.evaluate(()=>{
      const a=window.nocturneApp,read=a.db.getAll.bind(a.db);
      a.db.getAll=async(...args)=>{if(args[0]==='trash')await new Promise(resolve=>setTimeout(resolve,120));return read(...args);};
      document.querySelector('[data-trash-filter="all"]').click();document.querySelector('.trash-manager [data-close-form]').click();
    });
    await page.waitForTimeout(400); assert.equal(await page.locator('#form-overlay').evaluate(el=>el.classList.contains('active')),false);
    assert.equal(await page.locator('#form-overlay').evaluate(el=>el.classList.contains('motion-exiting')),false);
  });
  for (const mobile of [false, true]) await check('folded bookmark form scrolls, keeps actions visible and uses custom validation (' + (mobile ? 'touch' : 'desktop') + ')', async page => {
    await page.evaluate(async () => {
      const a=window.nocturneApp,e=a.nocturneEditor.get('primary');
      e.commands.setTextSelection({from:10,to:50}); await a.addBookmarkAtCurrentPosition('primary');
      e.commands.setTextSelection({from:20,to:80}); void a.addBookmarkAtCurrentPosition('primary');
    });
    await page.waitForSelector('[data-choice="create"]'); await page.waitForTimeout(350);
    await page.screenshot({path:directory+'/fold-choice-'+(mobile?'mobile':'desktop')+'.png'});
    await page.locator('[data-choice="create"]').click();
    await page.waitForFunction(()=>window.nocturneApp.getFocusedDoc().bookmarks[0]?.parts.length===2);
    await page.evaluate(()=>{ const a=window.nocturneApp;void a.bookmarks.edit(a.bookmarks.paneSource('primary').key,a.getFocusedDoc().bookmarks[0].id); });
    await page.waitForSelector('.bookmark-edit-modal'); await page.waitForTimeout(450);
    const box=await page.locator('.bookmark-edit-modal').boundingBox(); assert.ok(box.y>=0 && box.y+box.height<= (mobile?844:900));
    await page.locator('[name="title-0"]').fill(''); await page.locator('.bookmark-edit-modal [type="submit"]').click();
    assert.equal(await page.locator('.bookmark-edit-modal').evaluate(el=>el.noValidate),true);
    assert.equal(await page.locator('[name="title-0"]').getAttribute('aria-invalid'),'true');
    await page.locator('[name="title-0"]').fill('Первое имя'); await page.locator('[name="note-0"]').fill('Первая заметка');
    await page.locator('[name="note-1"]').fill('Вторая заметка');
    await page.locator('.bookmark-edit-modal').evaluate(el=>el.scrollTop=0); await page.waitForTimeout(80);
    const save=await page.locator('.bookmark-edit-modal [type="submit"]').boundingBox(); assert.ok(save.y>=0 && save.y+save.height<=(mobile?844:900));
    await page.screenshot({path:directory+'/fold-edit-'+(mobile?'mobile':'desktop')+'.png'});
    await page.locator('.bookmark-edit-modal [type="submit"]').click(); await page.waitForSelector('#form-overlay.active',{state:'hidden'});
    assert.deepEqual(await page.evaluate(()=>window.nocturneApp.getFocusedDoc().bookmarks[0].parts.map(part=>part.note)),['Первая заметка','Вторая заметка']);
  }, { mobile });
  await check('rapid copy changes cancel pending views and edit popovers close with their owner', async page => {
    await seed(page); await page.locator('.bookmark-scope-trigger').click(); await page.locator('.bookmark-manager-main').click();
    assert.equal(await page.locator('#bookmark-scope-menu').getAttribute('aria-hidden'),'true');
    await page.locator('.bookmark-edit-modal [data-close-form]').click();
    await page.evaluate(async()=>{const a=window.nocturneApp;await a.duplicateDoc(a.getFocusedDoc().id);}); await page.locator('.bookmark-manager-main').click();
    await page.locator('[name="note-0"]').fill('Сохранить перед переключением');
    await page.evaluate(()=>{
      const a=window.nocturneApp,change=a.bookmarks.change.bind(a.bookmarks);
      a.bookmarks.change=async(...args)=>{await change(...args);await new Promise(resolve=>setTimeout(resolve,120));};
      document.querySelector('[data-bookmark-variant="1"]').click();document.querySelector('[data-bookmark-variant="0"]').click();
    });
    await page.waitForTimeout(500); assert.equal(await page.locator('[data-bookmark-variant="0"]').getAttribute('aria-pressed'),'true');
    await page.locator('[name="note-0"]').fill('Сохранить и закрыть');
    await page.evaluate(()=>{document.querySelector('[data-bookmark-variant="1"]').click();document.querySelector('.bookmark-edit-modal [data-close-form]').click();});
    await page.waitForTimeout(500); assert.equal(await page.locator('#form-overlay').evaluate(el=>el.classList.contains('active')),false);
  });
  await check('repeated bookmark jumps cancel the previous pulse and finish without stale animations', async page => {
    await page.evaluate(async()=>{const a=window.nocturneApp;a.nocturneEditor.get('primary').commands.setTextSelection(5);await a.addBookmarkAtCurrentPosition('primary');const s=a.bookmarks.paneSource('primary');await a.bookmarks.jump(s.key,s.values[0].id);});
    await page.waitForFunction(()=>!!document.querySelector('.bookmark-position-tick').__nocturneMotions?.get('bookmark-flash'));
    await page.evaluate(async()=>{const a=window.nocturneApp,t=document.querySelector('.bookmark-position-tick');window.firstPulse=t.__nocturneMotions.get('bookmark-flash').animation;const s=a.bookmarks.paneSource('primary');await a.bookmarks.jump(s.key,s.values[0].id);});
    await page.waitForFunction(()=>window.firstPulse.playState==='idle');
    assert.equal(await page.evaluate(()=>window.firstPulse.playState),'idle');
    await page.evaluate(async()=>{
      const a=window.nocturneApp,t=document.querySelector('.bookmark-position-tick');window.secondPulse=t.__nocturneMotions.get('bookmark-flash').animation;
      a.nocturneEditor.get('primary').commands.setTextSelection(100);await a.addBookmarkAtCurrentPosition('primary');
      const s=a.bookmarks.paneSource('primary');await a.bookmarks.jump(s.key,s.values.at(-1).id);
    });
    await page.waitForFunction(()=>window.secondPulse.playState==='idle');
    assert.equal(await page.evaluate(()=>window.secondPulse.playState),'idle'); assert.equal(await page.locator('.bookmark-jump-flash').count(),1);
    await page.waitForTimeout(2100);
    assert.equal(await page.locator('.bookmark-jump-flash').count(),0);
    assert.equal(await page.locator('.bookmark-position-tick').evaluateAll(elements=>elements.flatMap(el=>el.getAnimations()).filter(a=>a.playState==='running').length),0);
  });
  await check('long trash lists stay within the screen and retain the close control while scrolling', async page => {
    await page.evaluate(async()=>{
      const a=window.nocturneApp,e=a.nocturneEditor.get('primary');
      for(let i=0;i<16;i++){e.commands.setTextSelection(i*10+2);await a.addBookmarkAtCurrentPosition('primary');const s=a.bookmarks.paneSource('primary');await a.bookmarks.remove(s.key,s.values.at(-1).id,{confirm:false});}
      await a.trash.open();
    });
    await page.waitForSelector('.trash-manager'); await page.waitForTimeout(400);
    const bounds=await page.locator('.trash-manager').boundingBox(); assert.ok(bounds.y>=0&&bounds.y+bounds.height<=900);
    await page.locator('.trash-manager').evaluate(el=>el.scrollTop=el.scrollHeight);
    const close=await page.locator('.trash-manager [data-close-form]').boundingBox(); assert.ok(close.y>=0&&close.y+close.height<=900);
    await page.screenshot({path:directory+'/trash-long.png'}); await page.locator('.trash-manager [data-close-form]').click();
  });
  await check('light theme retains readable surfaces and custom controls', async page => {
    await seed(page); await page.evaluate(()=>{const a=window.nocturneApp;a.state.settings.theme='paper';a.applySettings();});
    await page.waitForTimeout(500); await page.screenshot({path:directory+'/manager-paper.png'});
    await page.locator('.bookmark-manager-main').click(); await page.waitForTimeout(500); await page.screenshot({path:directory+'/edit-paper.png'});
    assert.equal(await page.locator('.bookmark-edit-modal input[type="color"], .bookmark-manager select').count(),0);
  });
  await check('mobile editing follows Nocturne keyboard viewport and safe area variables', async page => {
    await seed(page); await page.locator('.bookmark-manager-main').click(); await page.waitForTimeout(450);
    await page.evaluate(()=>{
      document.documentElement.style.setProperty('--mobile-viewport-height','470px');
      document.documentElement.style.setProperty('--mobile-viewport-top','0px');
      document.documentElement.style.setProperty('--app-safe-top','28px');document.documentElement.style.setProperty('--app-safe-bottom','36px');
      document.body.classList.add('mobile-keyboard-open');
    });
    await page.waitForTimeout(250);
    const form=await page.locator('.bookmark-edit-modal').boundingBox(); assert.ok(form.y>=28&&form.y+form.height<=434,JSON.stringify(form));
    const save=await page.locator('.bookmark-edit-modal [type="submit"]').boundingBox(); assert.ok(save.y>=28&&save.y+save.height<=434,JSON.stringify(save));
    await page.locator('.bookmark-edit-modal [data-close-form]').click();
  },{mobile:true});
} finally {
  await writeFile(directory + '/results.json', JSON.stringify(results,null,2));
  await browser.close(); server.kill(); process.exitCode = results.some(result => !result.passed) ? 1 : 0;
}
