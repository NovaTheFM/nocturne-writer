import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = 'http://localhost:5321';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5321', SYNC_PORT: '8921' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
await mkdir('release/qa/pagination-interaction', { recursive: true });

async function fixture(page) {
  await page.goto(url); await page.waitForSelector('#preloader.hidden', { state: 'attached' });
  await page.evaluate(async () => {
    const a = window.nocturneApp;
    a.state.settings.automaticBackups = false;
    await a.createDoc(a.defaultFolderId(), 'Pagination interaction', '');
    a.nocturneEditor.get('primary').commands.setContent(`<p>${'A long manuscript sentence for page boundary editing. '.repeat(700)}</p>`);
    a.state.settings.autoPaginate = true; a.applySettings();
  });
  await page.waitForTimeout(700);
  return page.evaluate(async () => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
    const { paginationPluginKey } = await import('/src/editor/pagination-state.js');
    const pos = paginationPluginKey.getState(e.state).pageBreaks[0].pos;
    const top = e.view.coordsAtPos(pos - 5);
    const scroll = e.view.dom.closest('.editor-scroll-area');
    scroll.style.scrollBehavior = 'auto'; scroll.scrollTop += top.top - scroll.getBoundingClientRect().top - 95;
    return { pos, text: e.getText(), json: e.getJSON() };
  });
}

async function boundary(page, pos) {
  return page.evaluate(pos => {
    const e = window.nocturneApp.nocturneEditor.get('primary'), a = e.view.coordsAtPos(pos - 5), b = e.view.coordsAtPos(pos + 5);
    return { before: { x: a.left, y: (a.top + a.bottom) / 2 }, after: { x: b.left, y: (b.top + b.bottom) / 2 }, gap: { x: (a.left + b.left) / 2, top: a.bottom + 5, bottom: b.top - 5 } };
  }, pos);
}

async function snapshot(page) {
  return page.evaluate(async () => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), selection = getSelection();
    const { paginationPluginKey } = await import('/src/editor/pagination-state.js');
    a.renderNocturneSelectionLayer(); a.updateCustomCaret();
    const rects = [...document.querySelectorAll('.nocturne-selection-rect')].filter(el => getComputedStyle(el).display !== 'none').map(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
    const caret = document.getElementById('custom-caret'), r = caret.getBoundingClientRect();
    const instance = a.nocturneEditor.instances.get('primary'), shell = instance.pageShell, style = getComputedStyle(shell);
    const shellTop = shell.getBoundingClientRect().top, height = Math.round(shell.getBoundingClientRect().width * 1123 / 794), stride = height + 60;
    const misses = [];
    e.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return;
      for (let offset = 0; offset <= node.content.size; offset += 37) {
        const c = e.view.coordsAtPos(pos + 1 + offset), within = (c.top - shellTop) % stride;
        if (within < parseFloat(style.paddingTop) - 3 || within + c.bottom - c.top > height - parseFloat(style.paddingBottom) + 3) misses.push(pos + 1 + offset);
      }
      return false;
    });
    return { text: e.getText(), json: e.getJSON(), from: e.state.selection.from, to: e.state.selection.to, nativeText: selection.toString(), focusNode: selection.focusNode?.nodeName, rects, caret: { visible: getComputedStyle(caret).display !== 'none', top: r.top, bottom: r.bottom, height: r.height }, breaks: paginationPluginKey.getState(e.state).pageBreaks, misses: misses.slice(0, 8) };
  });
}

function evidence(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(evidence);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['text', 'json'].includes(key)).map(([key, item]) => [key, evidence(item)]));
}

async function check(name, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const data = await fixture(page); await page.waitForTimeout(150);
    const measurements = await run(page, data); assert.deepEqual(errors, []);
    results.push({ name, passed: true, measurements: evidence(measurements) }); console.log(`PASS ${name}`);
  } catch (error) {
    await page.screenshot({ path: `release/qa/pagination-interaction/${name.replace(/[^a-z0-9]+/gi, '-')}.png` });
    results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  await check('mouse selection across pages highlights text without filling the gap', async (page, data) => {
    const points = await boundary(page, data.pos);
    await page.mouse.move(points.before.x, points.before.y); await page.mouse.down(); await page.mouse.move(points.after.x, points.after.y, { steps: 15 }); await page.mouse.up(); await page.waitForTimeout(200);
    const result = await snapshot(page);
    assert.ok(result.to > result.from, JSON.stringify(result));
    assert.equal(result.text, data.text);
    assert.ok(result.rects.every(rect => rect.height < 50), JSON.stringify(result.rects));
    await page.screenshot({ path: 'release/qa/pagination-interaction/selection-across-pages-fixed.png' }); return result;
  });
  await check('clicking the middle of a page gap never creates a tall caret', async (page, data) => {
    const points = await boundary(page, data.pos);
    await page.mouse.click(points.gap.x, (points.gap.top + points.gap.bottom) / 2); await page.waitForTimeout(120);
    const result = await snapshot(page);
    assert.equal(result.from, data.pos); assert.equal(result.to, data.pos);
    assert.ok(result.caret.visible && result.caret.height < 50, JSON.stringify(result.caret));
    assert.ok(result.caret.bottom <= points.gap.top || result.caret.top >= points.gap.bottom, JSON.stringify(result.caret));
    assert.deepEqual(result.json, data.json); return result;
  });
  await check('a gap-only drag and Backspace cannot remove the page layout', async (page, data) => {
    const points = await boundary(page, data.pos);
    await page.mouse.move(points.gap.x, points.gap.top + 15); await page.mouse.down(); await page.mouse.move(points.gap.x, points.gap.bottom - 15, { steps: 12 }); await page.mouse.up(); await page.waitForTimeout(100);
    const before = await snapshot(page);
    assert.equal(before.from, before.to); assert.equal(before.nativeText, '');
    await page.keyboard.press('Backspace'); await page.waitForTimeout(200);
    const after = await snapshot(page);
    assert.deepEqual(after.misses, []);
    assert.ok(after.breaks.length > 0);
    assert.equal(after.text.length, data.text.length - 1);
    return { before, after };
  });
  await check('deleting the first character of a page restores layout without another input', async (page, data) => {
    const points = await boundary(page, data.pos);
    await page.mouse.click(points.gap.x, points.gap.bottom - 10); await page.waitForTimeout(80);
    const before = await snapshot(page); assert.equal(before.from, data.pos);
    await page.keyboard.press('Delete'); await page.waitForTimeout(180);
    const after = await snapshot(page);
    assert.equal(after.text, data.text.slice(0, data.pos - 1) + data.text.slice(data.pos)); assert.deepEqual(after.misses, []);
    await page.keyboard.press('Control+z'); await page.waitForTimeout(180);
    const undone = await snapshot(page); assert.equal(undone.text, data.text); assert.deepEqual(undone.misses, []);
    return { before, after, undone };
  });
  await check('native arrow keys cross the gap without extra caret positions', async (page, data) => {
    const points = await boundary(page, data.pos);
    await page.mouse.click(points.after.x, points.after.y); await page.waitForTimeout(100);
    const before = await snapshot(page); let expected = before.from;
    for (const key of [...Array(9).fill('ArrowLeft'), ...Array(9).fill('ArrowRight')]) {
      await page.keyboard.press(key); await page.waitForTimeout(30); expected += key === 'ArrowLeft' ? -1 : 1;
      const current = await snapshot(page); assert.equal(current.from, expected, `${key} expected ${expected}, got ${current.from}`);
      assert.ok(current.caret.visible && current.caret.height < 50, JSON.stringify(current.caret));
    }
    const after = await snapshot(page); assert.deepEqual(after.json, data.json); return { before, after };
  });
  await check('Shift selection and Backspace remove only the real text across a page gap', async (page, data) => {
    const points = await boundary(page, data.pos);
    await page.mouse.click(points.after.x, points.after.y); await page.waitForTimeout(100);
    for (let i = 0; i < 12; i++) await page.keyboard.press('Shift+ArrowLeft'); await page.waitForTimeout(100);
    const before = await snapshot(page); assert.equal(before.to - before.from, 12);
    assert.ok(before.rects.every(rect => rect.height < 50));
    assert.equal(before.nativeText, data.text.slice(before.from - 1, before.to - 1));
    await page.keyboard.press('Backspace'); await page.waitForTimeout(180);
    const after = await snapshot(page); assert.equal(after.text, data.text.slice(0, before.from - 1) + data.text.slice(before.to - 1)); assert.deepEqual(after.misses, []);
    await page.keyboard.press('Control+z'); await page.waitForTimeout(180); assert.equal((await snapshot(page)).text, data.text);
    await page.keyboard.press('Control+Shift+z'); await page.waitForTimeout(180); assert.equal((await snapshot(page)).text, after.text);
    const saved = await page.evaluate(async () => { const a = window.nocturneApp; await a.saveActiveDoc({ silent: true }); return a.db.get('docs', a.getFocusedDoc().id); });
    assert.doesNotMatch(JSON.stringify(saved), /data-pagination-break|pm-page-start|page-spacer-height/); return { before, after };
  });
  await check('Enter at a page gap splits actual paragraphs and Backspace joins them', async (page, data) => {
    const points = await boundary(page, data.pos);
    await page.mouse.click(points.gap.x, (points.gap.top + points.gap.bottom) / 2); await page.waitForTimeout(80);
    await page.keyboard.press('Enter'); await page.waitForTimeout(200);
    const split = await snapshot(page); assert.equal(split.json.content.length, 2); assert.equal(split.text.replace(/\n/g, ''), data.text); assert.deepEqual(split.misses, []);
    await page.keyboard.press('Backspace'); await page.waitForTimeout(200);
    const joined = await snapshot(page); assert.equal(joined.text, data.text); assert.equal(joined.json.content.length, 1); assert.deepEqual(joined.misses, []); return { split, joined };
  });
  await check('select all deletion and undo rebuild pages from the manuscript alone', async (page, data) => {
    const points = await boundary(page, data.pos); await page.mouse.click(points.after.x, points.after.y);
    await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace'); await page.waitForTimeout(200);
    const empty = await snapshot(page); assert.equal(empty.text, ''); assert.equal(empty.breaks.length, 0);
    await page.keyboard.press('Control+z'); await page.waitForTimeout(200);
    const restored = await snapshot(page); assert.equal(restored.text, data.text); assert.deepEqual(restored.misses, []); return { empty, restored };
  });
  await check('mobile touch on the gap places a normal text caret and deletion keeps pages', async (page, data) => {
    const points = await boundary(page, data.pos);
    await page.touchscreen.tap(points.gap.x, (points.gap.top + points.gap.bottom) / 2); await page.waitForTimeout(120);
    const before = await snapshot(page); assert.equal(before.from, data.pos); assert.equal(before.to, data.pos); assert.ok(before.caret.visible && before.caret.height < 50);
    await page.keyboard.press('Delete'); await page.waitForTimeout(180);
    const after = await snapshot(page); assert.equal(after.text.length, data.text.length - 1); assert.deepEqual(after.misses, []); return { before, after };
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await check('Android custom selection does not start a word selection on a long-pressed gap', async (page, data) => {
    await page.evaluate(() => { window.nocturneApp.isAndroidRuntime = () => true; });
    const points = await boundary(page, data.pos), touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: points.gap.x, y: (points.gap.top + points.gap.bottom) / 2 }] });
    await page.waitForTimeout(430); await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await touch.detach();
    const after = await snapshot(page);
    assert.equal(after.from, data.pos); assert.equal(after.to, data.pos); assert.equal(after.nativeText, '');
    assert.equal(await page.evaluate(() => !!window.nocturneApp.selectionController?.active), false);
    assert.deepEqual(after.json, data.json); return after;
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
} finally {
  await browser.close(); server.kill();
  await writeFile('release/qa/pagination-interaction.json', JSON.stringify(results, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
