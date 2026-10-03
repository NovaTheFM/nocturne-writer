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
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const environment = { ...process.env, NOCTURNE_DEV_URL: url, NOCTURNE_TEST_PROFILE: profile, SYNC_PORT: String(syncPort) };
  delete environment.ELECTRON_RUN_AS_NODE;
  if (packaged) { delete environment.NOCTURNE_DEV_URL; delete environment.ELECTRON_DEV_URL; }
  desktop = await _electron.launch({ executablePath: resolve(packaged ? '.electron_build/dist/win-unpacked/Nocturne Writer.exe' : 'node_modules/electron/dist/electron.exe'), args: packaged ? [] : ['electron/main.cjs'], env: environment });
  const pc = await desktop.firstWindow(); await pc.waitForFunction(() => window.nocturneApp?.databaseSync);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
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
  browser = await chromium.launch({ headless: true });
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
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setBackgroundThrottling(false));
    const nativeInput = await pc.context().newCDPSession(pc);
    await nativeInput.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await pc.getByRole('button', { name: 'Спасибо, Луна' }).click();
    await pc.waitForSelector('#whats-new-overlay', { state: 'detached' });
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
    assert.equal(await pc.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), points.text.slice(0, selected.from - 1) + points.text.slice(selected.to - 1));
    const misses = await pc.evaluate(() => {
      const a = window.nocturneApp, instance = a.nocturneEditor.instances.get('primary'), e = instance.editor, shell = instance.pageShell, style = getComputedStyle(shell);
      const origin = shell.getBoundingClientRect().top, height = Math.round(shell.getBoundingClientRect().width * 1123 / 794), stride = height + 60, misses = [];
      e.state.doc.descendants((node, pos) => {
        if (!node.isTextblock) return;
        for (let offset = 0; offset <= node.content.size; offset += 37) {
          const c = e.view.coordsAtPos(pos + 1 + offset), within = (c.top - origin) % stride;
          if (within < parseFloat(style.paddingTop) - 3 || within + c.bottom - c.top > height - parseFloat(style.paddingBottom) + 3) misses.push(pos + 1 + offset);
        }
        return false;
      }); return misses.slice(0, 8);
    });
    assert.deepEqual(misses, []);
    await nativeInput.detach();
    console.log('Packaged Electron pagination: native mouse selection excludes the gap; Backspace removes only selected text and pages recover without another input.');
  }
  await pc.evaluate(async () => { const a = window.nocturneApp; a.openSyncPanel(); a.state.sync.optionsOpen = true; a.renderSyncSurfaces(); document.querySelector('[data-action="sync-server-stop"]').click(); });
  await pc.waitForFunction(() => !window.nocturneApp.state.sync.server.running);
  console.log(`Hidden Electron (${packaged ? 'packaged file origin' : 'development'}): real IPC broker start/stop, desktop-phone DB exchange and external backup/read passed.`);
} finally { if (browser) await browser.close(); if (desktop) await desktop.close(); server.kill(); }
