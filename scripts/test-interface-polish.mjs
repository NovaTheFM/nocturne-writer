import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5336, output = process.env.NOCTURNE_QA_OUTPUT || 'release/qa/interface-polish';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const browser = await chromium.launch({ headless: true });
const results = [];
async function test(name, action, mobile = false, options = {}) {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, ...options });
  const page = await context.newPage(), errors = [], dialogs = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  try {
    await page.goto(`http://localhost:${port}`);
    await page.waitForFunction(() => window.nocturneApp?.history && document.querySelector('.app-shell.ready') && getComputedStyle(document.getElementById('preloader')).visibility === 'hidden');
    await action(page);
    assert.deepEqual(errors, []); assert.deepEqual(dialogs, []);
    results.push({ name, ok: true, mobile });
  } catch (error) { results.push({ name, ok: false, mobile, error: error.stack, errors }); await page.screenshot({ path: `${output}/failure-${results.length}.png` }); }
  finally { await context.close(); }
}
const settle = page => page.waitForTimeout(600);
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const mobile of [false, true]) {
    await test('settings aligned controls, Nocturne switches and uninterrupted tab transition', async page => {
      await page.evaluate(() => window.nocturneApp.openSettingsTab('ai')); await settle(page);
      await page.screenshot({ path: `${output}/settings-ai-${mobile ? 'mobile' : 'desktop'}.png` });
      const geometry = await page.evaluate(() => {
        const a = window.nocturneApp, root = a.settingsSurfaceRoot();
        return [...root.querySelectorAll('.setting-row')].filter(row => row.querySelector('.nocturne-select')).map(row => ({ text: row.querySelector('.setting-info').textContent, info: row.querySelector('.setting-info').getBoundingClientRect().toJSON(), control: row.querySelector('.nocturne-select').getBoundingClientRect().toJSON() }));
      });
      await writeFile(`${output}/select-alignment-${mobile ? 'mobile' : 'desktop'}.json`, JSON.stringify(geometry, null, 2));
      for (const row of geometry) { assert.ok(row.control.x >= 0); assert.ok(row.control.right <= (mobile ? 390 : 1440)); if (!mobile) assert.ok(row.control.left >= row.info.right + 10, JSON.stringify(row)); }
      const provider = page.locator('[data-setting-select="aiProvider"] .nocturne-select-trigger');
      await provider.click(); await page.waitForTimeout(240);
      await page.screenshot({ path: `${output}/provider-menu-${mobile ? 'mobile' : 'desktop'}.png` });
      const menuGeometry = await page.evaluate(() => {
        const menu = document.querySelector('[data-setting-select="aiProvider"] .nocturne-select-menu'), bounds = menu.getBoundingClientRect();
        return { bounds: bounds.toJSON(), labels: [...menu.querySelectorAll('.nocturne-select-option > span')].map(node => node.getBoundingClientRect().left) };
      });
      assert.ok(menuGeometry.bounds.left >= 10); assert.ok(menuGeometry.bounds.right <= (mobile ? 390 : 1440) - 10); assert.ok(menuGeometry.bounds.bottom <= (mobile ? 844 : 1000) - 10);
      assert.ok(Math.max(...menuGeometry.labels) - Math.min(...menuGeometry.labels) < 1, 'First option must align with all the others');
      await page.keyboard.press('Escape');
      await page.evaluate(() => window.nocturneApp.openSettingsTab('history')); await settle(page);
      const toggle = page.locator('[data-setting="historyAutoGrowth"]');
      assert.equal(await toggle.evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
      const before = await toggle.getAttribute('aria-checked'); await toggle.focus(); await page.keyboard.press('Space'); assert.notEqual(await toggle.getAttribute('aria-checked'), before);
      await page.screenshot({ path: `${output}/settings-history-${mobile ? 'mobile' : 'desktop'}.png` });
      await page.evaluate(() => { const a = window.nocturneApp; a.openSettingsTab('manuscript-search'); });
      const motion = await page.evaluate(() => ({ active: document.getAnimations().filter(animation => animation.playState === 'running').length, ghosts: document.querySelectorAll('.surface-exit-ghost .settings-header').length }));
      assert.ok(motion.active > 0); assert.equal(motion.ghosts, 0, 'Settings header must stay fixed across tab transitions');
      await settle(page); await page.evaluate(() => window.nocturneApp.openSettingsTab('history')); await settle(page);
      assert.equal(await page.locator('[data-setting="historyAutoGrowth"]').getAttribute('aria-checked'), before === 'true' ? 'false' : 'true');
    }, mobile);
  }
  for (const mobile of [false, true]) {
    await test('rich recovery comparison, truthful save phases and safe undo', async page => {
      await page.evaluate(async () => {
        const a = window.nocturneApp;
        await a.createDoc(a.defaultFolderId(), 'Ночная глава', '');
        const editor = a.nocturneEditor.get('primary'), doc = a.getFocusedDoc();
        editor.commands.setContent('<h2 style="text-align:center">Письмо</h2><p>Она <strong>помнила</strong> тихий берег.</p><blockquote><p><em>Город ещё спал.</em></p></blockquote>');
        const snapshot = await a.history.capture(doc, { reason: 'manual', name: 'До новой концовки' });
        editor.commands.setContent('<h2 style="text-align:center">Письмо</h2><p>Она <strong>помнила</strong> ночной город.</p><blockquote><p><em>Город ещё спал.</em></p></blockquote>'); await a.saveActiveDoc({ silent: true });
        window.__polishSnapshot = snapshot.id; await a.history.open(doc.id, snapshot.id, 'compare');
      }); await settle(page);
      assert.equal(await page.locator('.history-paper-content strong').count(), 2);
      assert.ok(await page.locator('.history-paper-content ins').count() > 0); assert.ok(await page.locator('.history-paper-content del').count() > 0);
      assert.equal(await page.locator('.history-paper-content h2').first().evaluate(node => getComputedStyle(node).textAlign), 'center');
      const option = name => page.locator('.history-restore-options .nocturne-check').filter({ has: page.locator(`[name="restore-${name}"]`) });
      const lastOption = option('globalNotes');
      if (mobile) await lastOption.tap(); else await lastOption.click();
      assert.equal(await page.locator('[name="restore-globalNotes"]').isChecked(), true);
      const optionBounds = await lastOption.boundingBox(), footerBounds = await page.locator('.history-preview > .form-actions').boundingBox();
      assert.ok(optionBounds.y + optionBounds.height <= footerBounds.y);
      if (mobile) await lastOption.tap(); else await lastOption.click();
      if (mobile) await option('notes').tap(); else await option('notes').click();
      const notes = page.locator('[name="restore-notes"]');
      assert.equal(await notes.isChecked(), true);
      await notes.focus(); await page.keyboard.press('Space'); assert.equal(await notes.isChecked(), false);
      await page.keyboard.press('Space'); assert.equal(await notes.isChecked(), true);
      await page.locator('[data-history-mode="text"]').click(); await settle(page);
      await page.locator('[data-history-mode="compare"]').click(); await settle(page);
      assert.equal(await page.locator('[name="restore-notes"]').isChecked(), true);
      const applyBounds = await page.locator('[data-history-apply]').boundingBox(), modalBounds = await page.locator('.history-modal').boundingBox();
      assert.ok(applyBounds.y + applyBounds.height <= modalBounds.y + modalBounds.height - 8);
      await page.screenshot({ path: `${output}/history-compare-${mobile ? 'mobile' : 'desktop'}.png` });
      await page.evaluate(() => {
        const a = window.nocturneApp, save = a.saveDocById.bind(a);
        a.saveDocById = async (...args) => { await new Promise(resolve => window.__releaseSave = resolve); a.saveDocById = save; return save(...args); };
      });
      await page.locator('[data-history-apply]').click();
      await page.waitForFunction(() => document.querySelector('[data-history-restore-flow]').dataset.phase === 'saving');
      await page.waitForFunction(() => {
        const flow = document.querySelector('[data-history-restore-flow]'), bounds = flow.getBoundingClientRect(), viewport = flow.closest('.history-preview-scroll').getBoundingClientRect();
        return bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1;
      }, null, { timeout: 2000 });
      assert.equal(await page.locator('[data-restore-step="safety"]').evaluate(node => node.classList.contains('complete')), false);
      await page.screenshot({ path: `${output}/history-restoring-${mobile ? 'mobile' : 'desktop'}.png` });
      await page.evaluate(() => window.__releaseSave());
      await page.waitForFunction(() => document.querySelector('[data-history-restore-flow]').dataset.phase === 'complete'); await settle(page);
      assert.ok(await page.evaluate(() => window.nocturneApp.getFocusedDoc().ast.blocks.some(block => block.html.includes('тихий берег'))));
      await page.screenshot({ path: `${output}/history-restored-${mobile ? 'mobile' : 'desktop'}.png` });
      await page.locator('[data-history-undo]').click(); await settle(page);
      assert.ok(await page.evaluate(() => window.nocturneApp.getFocusedDoc().ast.blocks.some(block => block.html.includes('ночной город'))));
    }, mobile);
  }
  await test('stepped sliders interpolate visible thumb, retarget and preserve keyboard value', async page => {
    await page.evaluate(() => window.nocturneApp.openSettingsTab('history')); await settle(page);
    const range = page.locator('[data-setting="historyTimerMinutes"]'); await range.scrollIntoViewIfNeeded();
    const samples = await range.evaluate(async control => {
      const a = window.nocturneApp, field = control.closest('[data-range-field]'), values = [];
      const read = () => field.__rangeMotion.displayed;
      values.push(read()); control.value = control.max; a.updateSettingFromControl(control); values.push(read());
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); values.push(read());
      control.value = control.min; a.updateSettingFromControl(control); values.push(read());
      return { values, value: Number(control.value), stored: a.state.settings.historyTimerMinutes, target: field.__rangeMotion.target };
    });
    assert.equal(samples.values[0], samples.values[1]); assert.ok(samples.values[2] > samples.values[1] && samples.values[2] < 100); assert.equal(samples.values[2], samples.values[3]); assert.equal(samples.value, samples.stored);
    await page.waitForFunction(() => document.querySelector('[data-setting="historyTimerMinutes"]').closest('[data-range-field]').__rangeMotion.frame === null, null, { timeout: 2000 });
    assert.equal(await range.evaluate(control => control.closest('[data-range-field]').__rangeMotion.displayed), 0);
    await range.focus(); await page.keyboard.press('ArrowRight'); await settle(page);
    assert.equal(Number(await range.inputValue()), samples.value + 1);
    await page.screenshot({ path: `${output}/slider-settled.png` });
  });
  await test('backup busy state preserves sibling geometry and button dimensions', async page => {
    await page.evaluate(async () => { const a = window.nocturneApp; await a.openBackups(); a.backups.create = async () => new Promise(resolve => window.__releaseBackup = resolve); }); await settle(page);
    const button = page.locator('[data-backup-create]'), sibling = page.locator('[data-action="choose-backup-directory"]');
    const before = await button.boundingBox(), siblingBefore = await sibling.boundingBox(); await button.click();
    const during = await button.boundingBox(), siblingDuring = await sibling.boundingBox();
    await page.screenshot({ path: `${output}/backup-busy.png` });
    assert.ok(Math.abs(before.width - during.width) <= 1); assert.ok(Math.abs(before.height - during.height) <= 1); assert.ok(Math.abs(siblingBefore.x - siblingDuring.x) <= 1); assert.ok(Math.abs(siblingBefore.y - siblingDuring.y) <= 1);
    await page.evaluate(() => window.__releaseBackup()); await settle(page);
  });
  await test('actual backup creation keeps the controls still while the list grows', async page => {
    await page.evaluate(async () => window.nocturneApp.openBackups()); await settle(page);
    const button = page.locator('[data-backup-create]'), sibling = page.locator('[data-action="choose-backup-directory"]');
    await button.hover(); await page.waitForTimeout(250);
    const before = await button.boundingBox(), siblingBefore = await sibling.boundingBox(), count = await page.locator('[data-backup-restore]').count();
    const modalBefore = await page.locator('.backups-modal').boundingBox();
    await page.screenshot({ path: `${output}/backup-before-create.png` });
    await button.click(); await page.waitForFunction(count => document.querySelectorAll('[data-backup-restore]').length > count, count); await settle(page);
    const after = await button.boundingBox(), siblingAfter = await sibling.boundingBox();
    await writeFile(`${output}/backup-layout.json`, JSON.stringify({ before, after, siblingBefore, siblingAfter, modalBefore, modalAfter: await page.locator('.backups-modal').boundingBox(), html: await page.locator('.backups-modal').evaluate(node => node.outerHTML) }, null, 2));
    await page.screenshot({ path: `${output}/backup-created.png` });
    for (const key of ['x', 'y', 'width', 'height']) { assert.ok(Math.abs(before[key] - after[key]) < 1, key); assert.ok(Math.abs(siblingBefore[key] - siblingAfter[key]) < 1, key); }
    await page.screenshot({ path: `${output}/backup-created.png` });
  });
  await test('touch slider drag remains smooth and scales correctly after a viewport change', async page => {
    await page.evaluate(() => window.nocturneApp.openSettingsTab('history')); await settle(page);
    const range = page.locator('[data-setting="historyGrowthPages"]'); await range.scrollIntoViewIfNeeded();
    const bounds = await range.boundingBox(), session = await page.context().newCDPSession(page), y = bounds.y + bounds.height / 2;
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + 9, y }] });
    for (let step = 1; step <= 8; step++) { await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds.x + 9 + (bounds.width - 18) * step / 8, y }] }); await page.waitForTimeout(16); }
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await settle(page);
    assert.equal(await range.inputValue(), await range.getAttribute('max'));
    await page.setViewportSize({ width: 460, height: 600 }); await settle(page);
    const geometry = await range.evaluate(node => ({ native: node.getBoundingClientRect().width, visible: node.closest('[data-range-field]').querySelector('.range-motion-rail').getBoundingClientRect().width }));
    assert.ok(Math.abs(geometry.native - geometry.visible) < 1); await page.screenshot({ path: `${output}/slider-touch.png` });
  }, true);
  await test('reduced motion makes range changes immediate and suppresses workflow entrance motion', async page => {
    await page.evaluate(() => window.nocturneApp.openSettingsTab('history')); await settle(page);
    const range = page.locator('[data-setting="historyTimerMinutes"]');
    const result = await range.evaluate(control => { control.value = control.max; window.nocturneApp.updateSettingFromControl(control); const motion = control.closest('[data-range-field]').__rangeMotion; return { displayed: motion.displayed, target: motion.target, frame: motion.frame }; });
    assert.equal(result.displayed, result.target); assert.equal(result.frame, null);
    await page.evaluate(() => window.nocturneApp.openSettingsTab('manuscript-search'));
    assert.equal(await page.locator('.settings-body > .tab-content').evaluate(node => node.getAnimations().length), 0);
  }, false, { reducedMotion: 'reduce' });
  await test('custom select remains operable without the Popover API', async page => {
    await page.evaluate(() => {
      HTMLElement.prototype.showPopover = undefined; HTMLElement.prototype.hidePopover = undefined;
      const matches = Element.prototype.matches;
      Element.prototype.matches = function (selector) {
        if (selector === ':popover-open') throw new DOMException('Unsupported pseudo-class', 'SyntaxError');
        return matches.call(this, selector);
      };
      window.nocturneApp.openSettingsTab('ai');
    }); await settle(page);
    const trigger = page.locator('[data-setting-select="aiProvider"] .nocturne-select-trigger');
    await trigger.click(); assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.locator('[data-setting-select="aiProvider"] [role="option"]').first().evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Enter'); await settle(page);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.click(); await page.keyboard.press('Escape');
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
  });
} finally {
  await browser.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.ok)) process.exitCode = 1;
