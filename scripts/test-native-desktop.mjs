import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron, chromium } from 'playwright';
import WebSocket from 'ws';

const port = 5285, syncPort = 8885, url = `http://localhost:${port}`;
const packaged = process.argv.includes('--packaged');
const profile = resolve(`release/qa/electron-profile-${Date.now()}`), backups = resolve('release/qa/native-backups');
await mkdir(profile, { recursive: true }); await mkdir(backups, { recursive: true });
await writeFile(`${profile}/backup-directory.json`, JSON.stringify({ path: backups }));
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let desktop, browser;
async function checkHeader(pc) {
  const directory = 'release/qa/electron-header';
  await mkdir(directory, { recursive: true });
  await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
  await pc.waitForSelector('#whats-new-overlay.active');
  assert.equal(await pc.locator('.whats-new-body > p').first().innerText(), `Версия ${JSON.parse(await readFile('package.json', 'utf8')).version}`);
  await pc.screenshot({ path: `${directory}/whats-new-${packaged ? 'packaged' : 'dev'}.png` });
  await pc.getByRole('button', { name: 'Спасибо, Луна' }).click();
  await pc.waitForSelector('#whats-new-overlay', { state: 'detached' });
  await pc.waitForSelector('#electron-titlebar', { state: 'visible' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const reference = await context.newPage();
  const results = [];
  try {
    await reference.goto(url); await reference.waitForSelector('.app-shell.ready');
    for (const theme of ['nocturne', 'paper']) for (const compact of [false, true]) {
      for (const page of [pc, reference]) {
        await page.evaluate(({ theme, compact }) => { const a = window.nocturneApp; Object.assign(a.state.settings, { theme, compactPanels: compact }); a.applySettings(); }, { theme, compact });
        await page.mouse.move(700, 200);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => !document.querySelector('.sidebar-header-actions').getAnimations({ subtree: true }).some(animation => animation.playState === 'running'));
      }
      const sample = page => page.locator('.sidebar-header-actions .btn-icon').evaluateAll(buttons => buttons.map(button => {
        const style = getComputedStyle(button), icon = button.querySelector('i'), bounds = button.getBoundingClientRect();
        return { action: button.dataset.action, icon: icon.className, width: bounds.width, height: bounds.height, color: style.color, background: style.backgroundColor, radius: style.borderRadius, border: style.border, padding: style.padding, fontSize: style.fontSize, transition: style.transition, iconFont: getComputedStyle(icon).fontFamily, glyph: getComputedStyle(icon, '::before').content };
      }));
      const actual = await sample(pc), expected = await sample(reference);
      assert.equal(actual.length, 2); assert.deepEqual(actual, expected, `${theme}/${compact}: native controls differ from browser controls`);
      assert.equal(await pc.locator('[data-action="toggle-library-menu"]').count(), 1);
      assert.equal(await pc.locator('#electron-titlebar [data-action="open-settings"]').count(), 1);
      assert.equal(await pc.locator('#electron-titlebar .titlebar-controls button').count(), 3);
      assert.equal(await pc.locator('.titlebar-header-actions').evaluate(element => getComputedStyle(element).webkitAppRegion), 'no-drag');
      const geometry = await pc.locator('.titlebar-header-actions').evaluate(element => {
        const box = element.getBoundingClientRect(), parent = element.closest('.titlebar-brand').getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, parentRight: parent.right, titlebarBottom: document.getElementById('electron-titlebar').getBoundingClientRect().bottom };
      });
      assert.ok(geometry.left > 0 && geometry.right <= geometry.parentRight && geometry.top >= 0 && geometry.bottom <= geometry.titlebarBottom, JSON.stringify(geometry));
      const trigger = pc.locator('[data-action="toggle-library-menu"]');
      await trigger.click(); await pc.waitForSelector('#library-menu.active');
      const menu = await pc.locator('#library-menu').boundingBox(), anchor = await trigger.boundingBox();
      assert.ok(Math.abs(menu.x - anchor.x) < 2 && Math.abs(menu.y - anchor.y - anchor.height - 10) < 2, JSON.stringify({ menu, anchor }));
      assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      await pc.screenshot({ path: `${directory}/${theme}-${compact ? 'compact' : 'regular'}-${packaged ? 'packaged' : 'dev'}.png` });
      await pc.keyboard.press('Escape'); await pc.waitForSelector('#library-menu', { state: 'hidden' });
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
      await pc.locator('#electron-titlebar [data-action="open-settings"]').click();
      await pc.waitForSelector('#settings-overlay.active');
      await pc.keyboard.press('Escape');
      await pc.waitForFunction(() => {
        const overlay = document.getElementById('settings-overlay'), style = getComputedStyle(overlay);
        return !overlay.classList.contains('active') && !overlay.classList.contains('motion-exiting') && style.opacity === '0' && style.pointerEvents === 'none';
      });
      results.push({ theme, compact, passed: true, geometry, styles: actual });
    }
    for (const page of [pc, reference]) await page.evaluate(() => { const a = window.nocturneApp; Object.assign(a.state.settings, { theme: 'nocturne', compactPanels: false }); a.applySettings(); });
    await writeFile(`${directory}/${packaged ? 'packaged' : 'development'}.json`, JSON.stringify(results, null, 2));
    console.log('Electron titlebar: shared browser controls, real clicks, anchored tools menu, Escape focus, no-drag and settings passed in both themes and toolbar sizes.');
  } finally { await context.close(); }
}
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const environment = { ...process.env, NOCTURNE_DEV_URL: url, NOCTURNE_TEST_PROFILE: profile, SYNC_PORT: String(syncPort) };
  delete environment.ELECTRON_RUN_AS_NODE;
  if (packaged) { delete environment.NOCTURNE_DEV_URL; delete environment.ELECTRON_DEV_URL; }
  desktop = await _electron.launch({ executablePath: resolve(packaged ? '.electron_build/dist/win-unpacked/Nocturne Writer.exe' : 'node_modules/electron/dist/electron.exe'), args: packaged ? [] : ['electron/main.cjs'], env: environment });
  const pc = await desktop.firstWindow(); await pc.waitForFunction(() => window.nocturneApp?.databaseSync);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  browser = await chromium.launch({ headless: true });
  await checkHeader(pc);
  await pc.evaluate(async () => {
    const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Native desktop manuscript', '');
    a.nocturneEditor.get('primary').commands.setContent('<p>Electron document persisted externally.</p>'); await a.saveActiveDoc({ silent: true });
    a.openSyncPanel(); document.querySelector('[data-action="sync-server-start"]').click();
  });
  await pc.waitForFunction(() => window.nocturneApp.state.sync.server.running && window.nocturneApp.syncClient.isOpen(), null, { timeout: 12000 });
  const connection = await pc.evaluate(() => ({ host: '127.0.0.1', port: String(window.nocturneApp.state.sync.server.port), token: window.nocturneApp.state.sync.server.token }));
  assert.equal(Number(connection.port), syncPort); assert.ok(connection.token);
  for (const payload of ['null', Buffer.alloc(33 * 1024 * 1024, 65)]) {
    const ws = new WebSocket(`ws://localhost:${syncPort}`); ws.on('error', () => {});
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(payload); await new Promise(resolve => setTimeout(resolve, 150)); ws.terminate();
    assert.equal((await fetch(`http://localhost:${syncPort}/health`)).ok, true, 'Malformed input stopped the native broker');
  }
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await context.newPage(); await phone.goto(url); await phone.waitForFunction(() => window.nocturneApp?.databaseSync);
  await phone.evaluate(async connection => {
    const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Phone to native desktop', '');
    a.state.sync.discovery.manualOpen = true; a.openMobilePanel('sync', 'more'); Object.assign(a.state.sync, connection);
    document.querySelector('[data-action="sync-connect"]').click();
  }, connection);
  for (const page of [pc, phone]) await page.waitForFunction(() => window.nocturneApp.state.docs.length === 2, null, { timeout: 12000 });
  const copy = await pc.evaluate(async () => { const a = window.nocturneApp; const copy = await a.backups.create(); const dump = await a.backups.read(copy); return { copy, chapters: dump.payload.docs.length }; });
  assert.equal(copy.copy.external, true); assert.equal(copy.chapters, 2);
  assert.match(await readFile(copy.copy.path, 'utf8'), /Electron document persisted externally/);
  if (packaged) {
    await mkdir('release/qa/pagination-interaction', { recursive: true });
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    const nativeInput = await pc.context().newCDPSession(pc);
    await nativeInput.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await pc.evaluate(async () => {
      const a = window.nocturneApp;
      document.querySelector('#form-overlay [data-close-form]')?.click();
      const { paginationPluginKey } = await import('./src/editor/pagination-state.js');
      window.__nativePaginationKey = paginationPluginKey;
      a.nocturneEditor.get('primary').commands.setContent(`<p>${'Native page boundary editing. '.repeat(900)}</p>`);
      a.state.settings.autoPaginate = true; a.applySettings();
      await a.saveActiveDoc({ silent: true });
      await a.persistSettings();
    });
    await pc.waitForFunction(() => window.__nativePaginationKey.getState(window.nocturneApp.nocturneEditor.get('primary').state).pageBreaks.length > 0);
    await pc.evaluate(() => document.fonts.ready); await pc.waitForTimeout(250);
    const points = await pc.evaluate(async () => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
      const { paginationPluginKey } = await import('./src/editor/pagination-state.js');
      const pages = paginationPluginKey.getState(e.state).pageBreaks;
      if (!pages.length) throw new Error(JSON.stringify({ pages: 0, textLength: e.getText().length, autoPaginate: a.state.settings.autoPaginate, width: e.view.dom.getBoundingClientRect().width }));
      const pos = pages[0].pos, scroll = e.view.dom.closest('.editor-scroll-area');
      scroll.style.scrollBehavior = 'auto'; scroll.scrollTop += e.view.coordsAtPos(pos - 5).top - scroll.getBoundingClientRect().top - 95;
      const before = e.view.coordsAtPos(pos - 5), after = e.view.coordsAtPos(pos + 5);
      return { before: { x: before.left, y: (before.top + before.bottom) / 2 }, after: { x: after.left, y: (after.top + after.bottom) / 2 }, text: e.getText(), viewport: { width: innerWidth, height: innerHeight }, scrollTop: scroll.scrollTop, inert: !!e.view.dom.closest('[inert]'), hit: document.elementFromPoint(before.left, (before.top + before.bottom) / 2)?.className };
    });
    await pc.screenshot({ path: 'release/qa/pagination-interaction/electron-before-input.png' });
    await pc.mouse.move(points.before.x, points.before.y); await pc.mouse.down(); await pc.mouse.move(points.after.x, points.after.y, { steps: 12 }); await pc.mouse.up(); await pc.waitForTimeout(120);
    const selected = await pc.evaluate(() => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary'); a.renderNocturneSelectionLayer();
      const native = getSelection();
      const editable = a.editableFromSelection(), range = native.rangeCount ? native.getRangeAt(0) : null;
      return { from: e.state.selection.from, to: e.state.selection.to, nativeLength: native.toString().length, nativeRangeCount: native.rangeCount, editable: editable?.className, rawRects: range ? range.getClientRects().length : 0, textRects: editable && range ? a.textSelectionRects(range, editable).length : 0, layer: a.nocturneSelectionLayer?.className, active: document.activeElement.className, autoPaginate: a.state.settings.autoPaginate, heights: [...document.querySelectorAll('.nocturne-selection-rect')].filter(node => getComputedStyle(node).display !== 'none').map(node => node.getBoundingClientRect().height) };
    });
    assert.ok(selected.to > selected.from, JSON.stringify({ selected, points: { ...points, text: undefined } })); assert.ok(selected.heights.length > 0 && selected.heights.every(height => height < 50), JSON.stringify(selected));
    await pc.keyboard.press('Backspace'); await pc.waitForTimeout(180);
    await pc.screenshot({ path: 'release/qa/pagination-interaction/electron-after-delete.png' });
    await pc.waitForFunction(() => !window.nocturneApp.nocturneEditor.visualPageRaf.has('primary'), null, { polling: 100, timeout: 3000 });
    assert.equal(await pc.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), points.text.slice(0, selected.from - 1) + points.text.slice(selected.to - 1));
    const measurePage = () => pc.evaluate(() => {
      const a = window.nocturneApp, instance = a.nocturneEditor.instances.get('primary'), e = instance.editor, shell = instance.pageShell, style = getComputedStyle(shell);
      const origin = shell.getBoundingClientRect().top, height = Math.round(shell.getBoundingClientRect().width * 1123 / 794), stride = height + 60, misses = [];
      e.state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return;
        for (let offset = 0; offset <= node.content.size; offset += 37) {
          const c = e.view.coordsAtPos(pos + 1 + offset), within = (c.top - origin) % stride;
          if (within < parseFloat(style.paddingTop) - 3 || within + c.bottom - c.top > height - parseFloat(style.paddingBottom) + 3) misses.push({ pos: pos + 1 + offset, within, height: c.bottom - c.top, top: c.top });
        }
        return false;
      }); return { misses: misses.slice(0, 8), origin, height, width: shell.getBoundingClientRect().width, sheetHeight: shell.querySelector('.page-sheet-bg:not(.motion-sheet-exiting)')?.getBoundingClientRect().height, padding: [style.paddingTop, style.paddingBottom], pendingFrame: a.nocturneEditor.visualPageRaf.has('primary'), breaks: window.__nativePaginationKey.getState(e.state).pageBreaks.slice(0, 3), decorations: [...e.view.dom.querySelectorAll('[data-pagination-break]')].slice(0, 3).map(el => ({ cls: el.className, height: el.style.getPropertyValue('--page-spacer-height'), top: el.getBoundingClientRect().top })) };
    });
    const misses = await measurePage();
    await writeFile('release/qa/native-pagination.json', JSON.stringify({ selected, geometry: misses }, null, 2));
    assert.deepEqual(misses.misses, [], JSON.stringify(misses));
    await pc.evaluate(async () => {
      const a = window.nocturneApp;
      a.nocturneEditor.get('primary').commands.setContent(`<p>${'Native live split resizing. '.repeat(120)}</p>`);
      await a.saveActiveDoc({ silent: true }); a.toggleSplitMode();
    });
    await pc.waitForTimeout(400);
    await pc.screenshot({ path: 'release/qa/pagination-interaction/electron-split-before-input.png' });
    const divider = await pc.locator('#workspace-divider').boundingBox(), stage = await pc.locator('#workspace-stage').boundingBox();
    const originalJson = await pc.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getJSON()), split = [];
    await pc.mouse.move(divider.x + divider.width / 2, divider.y + 40); await pc.mouse.down();
    try {
      for (const ratio of [.38, .65, .48]) {
        await pc.mouse.move(stage.x + stage.width * ratio, divider.y + 40, { steps: 6 });
        await pc.screenshot({ path: 'release/qa/pagination-interaction/electron-split-during-resize.png' });
        await pc.waitForFunction(() => !window.nocturneApp.nocturneEditor.visualPageRaf.has('primary'), null, { polling: 100, timeout: 3000 });
        assert.equal(await pc.evaluate(() => document.body.classList.contains('resizing-workspace')), true);
        const current = await measurePage();
        assert.deepEqual(current.misses, [], JSON.stringify({ ratio, ...current }));
        assert.ok(Math.abs(current.sheetHeight - current.height) < 2, JSON.stringify(current));
        assert.deepEqual(await pc.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getJSON()), originalJson);
        split.push({ ratio, ...current });
      }
    } finally { await pc.mouse.up(); }
    assert.ok(new Set(split.map(item => item.width)).size === 3, JSON.stringify(split));
    await writeFile('release/qa/native-pagination.json', JSON.stringify({ selected, geometry: misses, split }, null, 2));
    await nativeInput.detach();
    console.log('Packaged Electron pagination: native mouse selection excludes the gap; Backspace removes only selected text and pages recover without another input.');
    console.log('Packaged Electron split resizing: page margins and paper height follow three divider positions while the mouse remains held; document JSON stays intact.');
  }
  await pc.evaluate(async () => { const a = window.nocturneApp; a.openSyncPanel(); a.state.sync.optionsOpen = true; a.renderSyncSurfaces(); document.querySelector('[data-action="sync-server-stop"]').click(); });
  await pc.waitForFunction(() => !window.nocturneApp.state.sync.server.running);
  console.log(`Hidden Electron (${packaged ? 'packaged file origin' : 'development'}): real IPC broker start/stop, desktop-phone DB exchange and external backup/read passed.`);
} finally { if (browser) await browser.close(); if (desktop) await desktop.close(); server.kill(); }
