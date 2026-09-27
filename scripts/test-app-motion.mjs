import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const url = 'http://localhost:5294';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5294', SYNC_PORT: '8894' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function check(name, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    const measurements = await run(page); assert.deepEqual(errors, []);
    results.push({ name, passed: true, measurements });
  } catch (error) { results.push({ name, passed: false, error: error.message }); }
  finally { await context.close(); }
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  await check('settings keep the window and sidebar while the body transitions between sections', async page => {
    await page.evaluate(() => window.nocturneApp.openSettingsTab('visual')); await page.waitForTimeout(450);
    const result = await page.evaluate(() => {
      const a = window.nocturneApp, modal = document.querySelector('.settings-modal'), tab = modal.querySelector('[data-settings-tab="editor"]');
      tab.focus(); tab.click();
      return { same: modal === document.querySelector('.settings-modal'), focus: tab === document.activeElement, moving: document.querySelector('.settings-body').getAnimations().length > 0 };
    });
    assert.equal(result.same, true); assert.equal(result.focus, true); assert.equal(result.moving, true); return result;
  });
  await check('legacy folder and document forms share continuous window sizing', async page => {
    await page.evaluate(() => window.nocturneApp.openFolderForm()); await page.waitForTimeout(450);
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, modal = document.querySelector('#form-overlay .form-modal'), start = modal.offsetHeight;
      a.openDocForm(a.defaultFolderId()); const same = modal === document.querySelector('#form-overlay .form-modal');
      const frames = [], time = performance.now();
      while (performance.now() - time < 420) { await new Promise(resolve => requestAnimationFrame(resolve)); frames.push(document.querySelector('#form-overlay .form-modal').offsetHeight); }
      return { same, start, frames, end: document.querySelector('#form-overlay .form-modal').offsetHeight };
    });
    assert.equal(result.same, true); assert.ok(result.frames.some(value => value > Math.min(result.start, result.end) + 2 && value < Math.max(result.start, result.end) - 2), JSON.stringify(result)); return result;
  });
  await check('shortcut closing retains its content until the exit has finished', async page => {
    await page.evaluate(() => window.nocturneApp.openShortcutsModal()); await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => { window.nocturneApp.closeShortcutsModal(); return !!document.querySelector('#shortcuts-overlay .shortcuts-modal'); }), true);
    await page.waitForTimeout(70); await page.evaluate(() => window.nocturneApp.openShortcutsModal()); await page.waitForTimeout(450);
    assert.equal(await page.locator('#shortcuts-overlay').evaluate(element => element.classList.contains('active') && !!element.firstElementChild), true);
  });
  await check('command palette exits visibly and a quick reopen cancels old removal', async page => {
    await page.evaluate(() => window.nocturneApp.commandPalette.open()); await page.waitForTimeout(350);
    const retained = await page.evaluate(() => { window.nocturneApp.commandPalette.close(); return !!document.querySelector('.command-palette-panel') && getComputedStyle(document.getElementById('command-palette-overlay')).display !== 'none'; });
    assert.equal(retained, true); await page.waitForTimeout(65); await page.evaluate(() => window.nocturneApp.commandPalette.open()); await page.waitForTimeout(400);
    assert.equal(await page.locator('[data-command-palette-input]').isVisible(), true);
  });
  await check('command filtering keeps matching rows and does not replace the search input', async page => {
    const result = await page.evaluate(() => {
      const p = window.nocturneApp.commandPalette; p.open(); const input = document.querySelector('[data-command-palette-input]'), row = document.querySelector('[data-command-palette-run]');
      p.setQuery(row.querySelector('strong').textContent);
      return { input: input === document.querySelector('[data-command-palette-input]'), row: row.isConnected };
    });
    assert.equal(result.input, true); assert.equal(result.row, true); return result;
  });
  await check('mobile list refresh preserves its surface and native search field', async page => {
    const result = await page.evaluate(() => {
      const a = window.nocturneApp; a.switchMobileTab('docs'); const surface = document.getElementById('mobile-tab-surface'), input = document.querySelector('[data-mobile-doc-search]');
      input.focus(); input.value = 'chapter'; input.setSelectionRange(1, 4); a.state.docSearch = 'chapter'; a.renderMobileShell();
      return { surface: surface === document.getElementById('mobile-tab-surface'), input: input === document.querySelector('[data-mobile-doc-search]'), focus: input === document.activeElement, selection: [input.selectionStart, input.selectionEnd] };
    });
    assert.equal(result.surface, true); assert.equal(result.input, true); assert.equal(result.focus, true); assert.deepEqual(result.selection, [1, 4]); return result;
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await check('mobile folder collapse interpolates size and quick reopening preserves its list', async page => {
    await page.evaluate(async () => { const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Mobile animation chapter', ''); a.switchMobileTab('docs'); }); await page.waitForTimeout(450);
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, list = document.querySelector('.mobile-folder-docs'), start = list.getBoundingClientRect().height;
      a.toggleFolder(a.defaultFolderId()); a.renderMobileShell(); const frames = [], time = performance.now();
      while (performance.now() - time < 380) { await new Promise(resolve => requestAnimationFrame(resolve)); frames.push(document.querySelector('.mobile-folder-docs').getBoundingClientRect().height); }
      a.toggleFolder(a.defaultFolderId()); a.renderMobileShell(); await new Promise(resolve => setTimeout(resolve, 450));
      return { start, frames, same: list === document.querySelector('.mobile-folder-docs'), end: document.querySelector('.mobile-folder-docs').getBoundingClientRect().height };
    });
    assert.ok(result.start > 20); assert.ok(result.frames.some(value => value > 2 && value < result.start - 2), JSON.stringify(result)); assert.equal(result.same, true); assert.ok(result.end > 20); return result;
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await check('document search moves matching cards rather than teleporting them', async page => {
    await page.evaluate(async () => { const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Hide this first card', ''); await a.createDoc(a.defaultFolderId(), 'Keep this second card', ''); }); await page.waitForTimeout(650);
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, card = [...document.querySelectorAll('#docs-container .doc-item')].find(node => node.textContent.includes('Keep this second')), start = card.getBoundingClientRect().top;
      a.applyDocSearch('Keep'); const frames = [], time = performance.now();
      while (performance.now() - time < 550) { await new Promise(resolve => requestAnimationFrame(resolve)); frames.push(card.getBoundingClientRect().top); }
      return { start, frames, end: card.getBoundingClientRect().top, connected: card.isConnected };
    });
    assert.equal(result.connected, true); assert.ok(Math.abs(result.start - result.end) > 10); assert.ok(result.frames.some(value => value > Math.min(result.start, result.end) + 2 && value < Math.max(result.start, result.end) - 2), JSON.stringify(result)); return result;
  });
  await check('replacing an interrupted knowledge transition runs only the latest callback', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; a.openKb('characters'); await new Promise(resolve => setTimeout(resolve, 400)); const calls = [];
      const first = a.transitionKbContent(() => calls.push('previous'));
      await new Promise(resolve => setTimeout(resolve, 35)); const last = a.transitionKbContent(() => calls.push('latest'));
      await Promise.all([first, last]); return calls;
    });
    assert.deepEqual(result, ['latest']); return result;
  });
  await check('cleaner content replacement cancels old size cleanup and reaches the latest layout', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, overlay = document.getElementById('form-overlay');
      a.presentFormModal('<div class="form-modal cleaner-modal"><div id="motion-cleaner-content"><div style="height:90px"></div></div></div>'); await new Promise(resolve => setTimeout(resolve, 400));
      const body = document.getElementById('motion-cleaner-content'), modal = body.closest('.form-modal'); a.updateModalContent(body, '<div style="height:330px"></div>');
      await new Promise(resolve => setTimeout(resolve, 60)); const before = modal.getBoundingClientRect().height; a.updateModalContent(body, '<div style="height:160px"></div>'); const after = modal.getBoundingClientRect().height;
      await new Promise(resolve => setTimeout(resolve, 480)); return { before, after, height: modal.style.height, transition: modal.style.transition };
    });
    assert.ok(Math.abs(result.before - result.after) < 3, JSON.stringify(result)); assert.equal(result.height, ''); assert.equal(result.transition, ''); return result;
  });
  await check('split workspace interpolates pane width and survives quick close and reopen', async page => {
    await page.evaluate(async () => { const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Split motion chapter', ''); }); await page.waitForTimeout(500);
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, pane = document.querySelector('[data-pane-id="primary"].workspace-pane'), start = pane.getBoundingClientRect().width;
      a.toggleSplitMode(); const frames = [], time = performance.now();
      while (performance.now() - time < 450) { await new Promise(resolve => requestAnimationFrame(resolve)); frames.push(pane.getBoundingClientRect().width); }
      const end = pane.getBoundingClientRect().width; a.closeSecondaryPane(); a.toggleSplitMode(); await new Promise(resolve => setTimeout(resolve, 500));
      return { start, frames, end, mode: a.state.workspace.mode, secondary: !!document.querySelector('.secondary-pane .workspace-pane-body') };
    });
    assert.ok(result.start > result.end + 20); assert.ok(result.frames.some(value => value > result.end + 2 && value < result.start - 2), JSON.stringify(result)); assert.equal(result.mode, 'split'); assert.equal(result.secondary, true); return result;
  });
  await mkdir('release/qa', { recursive: true }); await writeFile('release/qa/app-motion.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2)); if (results.some(result => !result.passed)) process.exitCode = 1;
} finally { await browser.close(); server.kill(); }
