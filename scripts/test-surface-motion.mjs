import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const url = 'http://localhost:5292';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5292', SYNC_PORT: '8892' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function check(name, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await run(page); assert.deepEqual(errors, []);
    results.push({ name, passed: true });
  } catch (error) { results.push({ name, passed: false, error: error.message }); }
  finally { await context.close(); }
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  await check('connection disclosure preserves its dialog and focus, and interpolates the window height', async page => {
    await page.evaluate(() => window.nocturneApp.openSyncPanel());
    await page.waitForTimeout(400);
    const sample = await page.evaluate(async () => {
      const dialog = document.querySelector('.sync-center-modal'), button = dialog.querySelector('[data-action="sync-toggle-options"]');
      button.focus(); const start = dialog.getBoundingClientRect().height; button.click();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const during = document.querySelector('.sync-center-modal').getBoundingClientRect().height;
      const sameDialog = dialog === document.querySelector('.sync-center-modal');
      const sameFocus = button === document.activeElement;
      await new Promise(resolve => setTimeout(resolve, 450));
      return { start, during, end: dialog.getBoundingClientRect().height, sameDialog, sameFocus };
    });
    assert.equal(sample.sameDialog, true, 'Status changes must keep the original dialog');
    assert.equal(sample.sameFocus, true, 'Disclosure trigger must keep keyboard focus');
    assert.ok(sample.end > sample.start + 20, JSON.stringify(sample));
    assert.ok(sample.during < sample.end - 4 && sample.during >= sample.start - 1, `Window jumped to its final size: ${JSON.stringify(sample)}`);
  });
  await check('height transitions retarget from the current visible size and release styles after rapid input', async page => {
    const sample = await page.evaluate(async () => {
      const box = document.createElement('div'); box.style.cssText = 'position:fixed;top:10px;left:10px;width:200px;background:black';
      const content = document.createElement('div'); content.style.height = '90px'; box.append(content); document.body.append(box);
      window.nocturneApp.animateHeightTransition(box, () => { content.style.height = '330px'; });
      await new Promise(resolve => setTimeout(resolve, 55));
      const before = box.getBoundingClientRect().height;
      window.nocturneApp.animateHeightTransition(box, () => { content.style.height = '170px'; });
      const after = box.getBoundingClientRect().height;
      await new Promise(resolve => setTimeout(resolve, 450));
      const result = { before, after, end: box.getBoundingClientRect().height, inline: box.style.height, overflow: box.style.overflow };
      box.remove(); return result;
    });
    assert.ok(Math.abs(sample.before - sample.after) < 3, `Retargeting jumped: ${JSON.stringify(sample)}`);
    assert.equal(sample.end, 170); assert.equal(sample.inline, ''); assert.equal(sample.overflow, '');
  });
  await check('mobile status updates keep the input node, selection and scrolled content', async page => {
    await page.evaluate(() => { const a = window.nocturneApp; a.state.sync.discovery.manualOpen = true; a.state.sync.optionsOpen = true; a.openMobilePanel('sync', 'more'); });
    await page.locator('[data-sync-field="token"]').fill('CODE12345');
    const result = await page.evaluate(() => {
      const input = document.querySelector('[data-sync-field="token"]'), body = document.querySelector('.mobile-sync-body');
      input.setSelectionRange(2, 6); body.scrollTop = 100;
      const top = body.scrollTop;
      window.nocturneApp.state.sync.status = 'waiting'; window.nocturneApp.renderSyncSurfaces();
      return { same: input === document.querySelector('[data-sync-field="token"]'), focused: input === document.activeElement, selection: [input.selectionStart, input.selectionEnd], top, after: document.querySelector('.mobile-sync-body').scrollTop };
    });
    assert.equal(result.same, true, 'Refreshing sync must preserve the native keyboard input node');
    assert.equal(result.focused, true); assert.deepEqual(result.selection, [2, 6]); assert.equal(result.after, result.top);
  }, { viewport: { width: 390, height: 510 }, isMobile: true, hasTouch: true });
  await check('creating a backup has one operation, visible busy state and keeps the dialog and existing row', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Motion manuscript', ''); await a.backups.create(); await a.openBackups();
      window.originalCopyRow = document.querySelector('.utility-row'); window.originalCopyDialog = document.querySelector('.utility-modal');
      const create = a.backups.create.bind(a.backups); window.copyCalls = 0;
      a.backups.create = async (...args) => { window.copyCalls++; await new Promise(resolve => setTimeout(resolve, 180)); return create(...args); };
    });
    const busy = await page.locator('[data-backup-create]').evaluate(button => { button.click(); button.click(); return { disabled: button.disabled, busy: button.getAttribute('aria-busy') }; });
    assert.equal(busy.disabled, true); assert.equal(busy.busy, 'true');
    await page.waitForFunction(() => document.querySelectorAll('.utility-row').length === 2);
    assert.equal(await page.evaluate(() => window.copyCalls), 1);
    assert.equal(await page.evaluate(() => originalCopyDialog === document.querySelector('.utility-modal') && originalCopyRow.isConnected), true);
  });
  await check('conflict selection keeps the picker and smoothly updates the same window', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      for (const [id, title, text] of [['first-motion', 'First', 'Short'], ['second-motion', 'Second', 'Long line\n'.repeat(30)]]) {
        await a.db.put('syncConflicts', { id, type: 'database-record', store: 'notes', recordId: id, local: { value: { id, title, text } }, remote: { value: { id, title, text: `${text} other` } } });
      }
      await a.openSyncConflicts('first-motion'); window.conflictDialog = document.querySelector('.conflict-modal'); window.conflictPicker = document.querySelector('#conflict-selection');
    });
    await page.locator('.conflict-record-picker [data-form-select-toggle]').click();
    await page.locator('.conflict-record-picker [data-value="second-motion"]').click();
    await page.waitForFunction(() => document.querySelector('#conflict-selection')?.value === 'second-motion' && document.querySelector('.conflict-versions')?.textContent.includes('Long line'));
    assert.equal(await page.evaluate(() => conflictDialog === document.querySelector('.conflict-modal') && conflictPicker === document.querySelector('#conflict-selection')), true);
    assert.equal(await page.locator('.conflict-record-picker [data-form-select-toggle]').evaluate(button => button === document.activeElement), true);
  });
  await check('reduced motion updates size immediately without starting JavaScript transitions', async page => {
    const result = await page.evaluate(() => {
      const a = window.nocturneApp; a.openSyncPanel(); a.state.sync.optionsOpen = true; a.renderSyncSurfaces();
      const modal = document.querySelector('.sync-center-modal');
      return { inline: modal.style.height, transition: !!modal.__heightTransitionCleanup, animations: modal.getAnimations().filter(animation => animation.transitionProperty === 'height').length };
    });
    assert.equal(result.inline, ''); assert.equal(result.transition, false); assert.equal(result.animations, 0);
  }, { reducedMotion: 'reduce' });
  await mkdir('release/qa', { recursive: true });
  await writeFile('release/qa/surface-motion.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (results.some(result => !result.passed)) process.exitCode = 1;
} finally { await browser.close(); server.kill(); }
