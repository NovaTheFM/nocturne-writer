import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort, killOwnedProcess } from './qa/runner.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/review-mode-ui');
const port = await availablePort(), url = `http://127.0.0.1:${port}`;
await mkdir(directory, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
const results = [];
let browser;
async function check(name, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    const measurements = await run(page);
    assert.deepEqual(errors, [], 'No uncaught application errors');
    results.push({ name, passed: true, measurements });
  } catch (error) {
    results.push({ name, passed: false, error: error.stack });
    await page.screenshot({ path: join(directory, `failure-${results.length}.png`) }).catch(() => {});
  } finally {
    await context.close();
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${name}${results.at(-1).error ? '\n' + results.at(-1).error : ''}`);
  }
}
async function createManuscript(page) {
  await page.evaluate(async () => {
    const a = window.nocturneApp;
    a.state.settings.automaticBackups = false;
    await a.createDoc(a.defaultFolderId(), 'Mode regression', '');
    const editor = a.nocturneEditor.get('primary');
    editor.commands.setContent('<p>Рукопись для проверки режимов и сохранения текста.</p>');
    await a.saveActiveDoc({ silent: true });
    window.modeOriginalEditor = editor;
  });
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  await check('all labels fit and both edge insets stay equal across modes, widths and themes', async page => {
    const samples = [];
    for (const theme of ['nocturne', 'paper']) {
      await page.evaluate(theme => { const a = window.nocturneApp; a.state.settings.theme = theme; a.applySettings(); }, theme);
      for (const width of [1024, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        for (const mode of ['write', 'editor', 'finalization']) {
          await page.evaluate(mode => window.nocturneApp.setReviewMode(mode), mode); await page.waitForTimeout(450);
          const sample = await page.evaluate(() => {
            const button = document.querySelector('.review-mode-trigger'), label = button.querySelector('span');
            const [icon, chevron] = button.querySelectorAll('i'), b = button.getBoundingClientRect(), text = label.getBoundingClientRect();
            const range = document.createRange(); range.selectNodeContents(label);
            return { left: icon.getBoundingClientRect().left - b.left, right: b.right - chevron.getBoundingClientRect().right, label: text.width, glyphs: range.getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > innerWidth + 1, height: document.querySelector('.toolbar').getBoundingClientRect().height };
          });
          assert.ok(sample.label >= sample.glyphs - .1, JSON.stringify(sample));
          assert.ok(Math.abs(sample.left - 14) < .1 && Math.abs(sample.right - 14) < .1, JSON.stringify(sample));
          assert.equal(sample.overflow, false); assert.equal(sample.height, 90);
          samples.push({ theme, width, mode, ...sample });
        }
      }
      await page.screenshot({ path: join(directory, `desktop-${theme}-finalization.png`) });
    }
    return samples;
  });
  await check('compact toolbar retains equal mode insets and its original height', async page => {
    await page.evaluate(() => document.body.classList.add('compact-toolbar'));
    const samples = [];
    for (const mode of ['editor', 'finalization', 'write']) {
      await page.evaluate(mode => window.nocturneApp.setReviewMode(mode), mode); await page.waitForTimeout(450);
      const result = await page.evaluate(() => {
        const trigger = document.querySelector('.review-mode-trigger'), rect = trigger.getBoundingClientRect(), icons = trigger.querySelectorAll('i');
        return { left: icons[0].getBoundingClientRect().left - rect.left, right: rect.right - icons[1].getBoundingClientRect().right, height: document.querySelector('.toolbar').offsetHeight };
      });
      assert.equal(result.left, 14); assert.equal(result.right, 14); assert.equal(result.height, 82); samples.push(result);
    }
    return samples;
  });
  await check('keyboard mode selection keeps editor identity and text, enforces readonly and restores focus', async page => {
    await createManuscript(page);
    const samples = [];
    for (const mode of ['editor', 'finalization', 'write']) {
      await page.locator('.review-mode-trigger').focus(); await page.keyboard.press('Enter');
      await page.locator(`#review-mode-menu [data-review-mode="${mode}"]`).focus(); await page.keyboard.press('Enter');
      await page.waitForTimeout(450);
      const result = await page.evaluate(() => {
        const a = window.nocturneApp, editor = a.nocturneEditor.get('primary');
        return { mode: a.state.reviewMode, same: editor === window.modeOriginalEditor, text: editor.getText(), editable: editor.isEditable, focus: document.activeElement === document.querySelector('.review-mode-trigger'), expanded: document.querySelector('.review-mode-trigger').getAttribute('aria-expanded'), hiddenInert: [...document.querySelectorAll('.toolbar-history,.toolbar-formatting')].every(el => el.inert), checked: document.querySelector('#review-mode-menu [aria-checked="true"]')?.dataset.reviewMode };
      });
      assert.equal(result.mode, mode); assert.equal(result.checked, mode); assert.equal(result.same, true);
      assert.equal(result.text, 'Рукопись для проверки режимов и сохранения текста.');
      assert.equal(result.editable, mode !== 'editor'); assert.equal(result.hiddenInert, mode === 'editor');
      assert.equal(result.focus, true); assert.equal(result.expanded, 'false'); samples.push(result);
      await page.screenshot({ path: join(directory, `desktop-${mode}.png`) });
    }
    return samples;
  });
  await check('adjacent search keeps its rendered position at the start of every mode change', async page => {
    await createManuscript(page);
    await page.waitForTimeout(450);
    await page.evaluate(() => window.nocturneApp.setReviewMode('editor'));
    await page.waitForTimeout(70);
    await page.screenshot({ path: join(directory, 'mode-motion-70ms.png'), clip: { x: 260, y: 0, width: 1180, height: 90 } });
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(directory, 'mode-motion-170ms.png'), clip: { x: 260, y: 0, width: 1180, height: 90 } });
    await page.evaluate(() => window.nocturneApp.setReviewMode('write')); await page.waitForTimeout(450);
    const samples = [];
    for (const mode of ['editor', 'finalization', 'write', 'finalization', 'editor', 'write']) {
      const sample = await page.evaluate(async mode => {
        const button = document.querySelector('#search-menu-wrap button'), a = window.nocturneApp;
        const start = button.getBoundingClientRect().left;
        a.setReviewMode(mode);
        const immediate = button.getBoundingClientRect().left, frames = [], time = performance.now();
        while (performance.now() - time < 400) { await new Promise(resolve => requestAnimationFrame(resolve)); frames.push(button.getBoundingClientRect().left); }
        return { start, immediate, end: button.getBoundingClientRect().left, frames, ghosts: document.querySelectorAll('.surface-exit-ghost').length };
      }, mode);
      assert.ok(Math.abs(sample.start - sample.immediate) < 2, `${mode}: ${JSON.stringify(sample)}`);
      assert.ok(sample.frames.some(x => Math.abs(x - sample.start) > 2 && Math.abs(x - sample.end) > 2), `${mode}: no interpolated search position`);
      assert.equal(sample.ghosts, 0); samples.push({ mode, ...sample });
    }
    return samples;
  });
  await check('rapid changes retarget without jumping and clear animation state', async page => {
    await createManuscript(page);
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, search = document.querySelector('#search-menu-wrap button'), jumps = [];
      for (const mode of ['editor', 'write', 'finalization', 'editor', 'finalization', 'write']) {
        const before = search.getBoundingClientRect().left; a.setReviewMode(mode);
        jumps.push(Math.abs(before - search.getBoundingClientRect().left));
        await new Promise(resolve => setTimeout(resolve, 70));
      }
      await new Promise(resolve => setTimeout(resolve, 500));
      const slot = document.getElementById('review-toolbar-slot'), trigger = document.querySelector('.review-mode-trigger');
      return { jumps, mode: a.state.reviewMode, ghosts: document.querySelectorAll('.surface-exit-ghost').length, flipping: document.querySelectorAll('.toolbar .is-flipping').length, width: trigger.style.width, height: trigger.style.height, empty: slot.children.length === 0 && slot.offsetWidth === 0, text: a.nocturneEditor.get('primary').getText(), same: a.nocturneEditor.get('primary') === window.modeOriginalEditor };
    });
    assert.ok(result.jumps.every(jump => jump < 2), JSON.stringify(result));
    assert.equal(result.mode, 'write'); assert.equal(result.ghosts, 0); assert.equal(result.flipping, 0);
    assert.equal(result.width, ''); assert.equal(result.height, ''); assert.equal(result.empty, true); assert.equal(result.same, true);
    assert.equal(result.text, 'Рукопись для проверки режимов и сохранения текста.'); return result;
  });
  await check('reduced motion applies correct modes without retained layout or ghost animations', async page => {
    const result = await page.evaluate(() => {
      const a = window.nocturneApp;
      for (const mode of ['editor', 'finalization', 'write', 'editor']) a.setReviewMode(mode);
      return { mode: a.state.reviewMode, ghosts: document.querySelectorAll('.surface-exit-ghost').length, flipping: document.querySelectorAll('.toolbar .is-flipping').length, width: document.querySelector('.review-mode-trigger').style.width, tools: document.querySelectorAll('#review-toolbar-slot button').length, format: getComputedStyle(document.querySelector('.toolbar-formatting')).display, motions: [...document.querySelectorAll('.toolbar,.toolbar *')].reduce((total, el) => total + (el.__nocturneMotions?.size || 0), 0) };
    });
    assert.equal(result.mode, 'editor'); assert.equal(result.ghosts, 0); assert.equal(result.flipping, 0); assert.equal(result.width, '');
    assert.equal(result.tools, 4); assert.equal(result.format, 'none'); assert.equal(result.motions, 0); return result;
  }, { reducedMotion: 'reduce' });
  await check('touch mode controls preserve the manuscript and mobile formatting after returning to writing', async page => {
    await createManuscript(page);
    for (const mode of ['editor', 'finalization', 'write']) {
      await page.locator('.mobile-topbar [data-action="mobile-open-actions"]').tap();
      await page.locator(`#mobile-panel [data-review-mode="${mode}"]`).tap(); await page.waitForTimeout(450);
      assert.equal(await page.evaluate(() => window.nocturneApp.state.reviewMode), mode);
      assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').isEditable), mode !== 'editor');
    }
    const result = await page.evaluate(() => ({ same: window.modeOriginalEditor === window.nocturneApp.nocturneEditor.get('primary'), text: window.modeOriginalEditor.getText(), overflow: document.documentElement.scrollWidth > innerWidth + 1, panelOpen: document.getElementById('mobile-panel').classList.contains('active') }));
    assert.equal(result.same, true); assert.equal(result.overflow, false); assert.equal(result.panelOpen, false);
    assert.equal(result.text, 'Рукопись для проверки режимов и сохранения текста.');
    await page.screenshot({ path: join(directory, 'mobile-write.png') }); return result;
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
} finally { await browser?.close(); killOwnedProcess(server); }
if (results.some(result => !result.passed)) process.exitCode = 1;
