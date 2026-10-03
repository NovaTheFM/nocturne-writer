import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = 'http://localhost:5315';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5315', SYNC_PORT: '8915' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function check(name, run, options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage(), errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForSelector('#preloader.hidden', { state: 'attached' });
    await page.evaluate(async () => { const a = window.nocturneApp; a.state.settings.automaticBackups = false; await a.createDoc(a.defaultFolderId(), 'Pagination manuscript', ''); });
    const measurements = await run(page); assert.deepEqual(errors, []); results.push({ name, passed: true, measurements }); console.log(`PASS ${name}`);
  } catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  finally { await context.close(); }
}
async function enable(page, content) {
  await page.evaluate(content => { const a = window.nocturneApp, e = a.nocturneEditor.get('primary'); e.commands.setContent(content); a.state.settings.autoPaginate = true; a.applySettings(); a.nocturneEditor.scheduleVisualPages('primary'); }, content);
  await page.waitForTimeout(700);
}
async function geometry(page, paneId = 'primary') {
  return page.evaluate(async paneId => {
    const a = window.nocturneApp, instance = a.nocturneEditor.instances.get(paneId), e = instance.editor;
    const { paginationPluginKey } = await import('/src/editor/nocturne-editor.js');
    const page = instance.pageShell, style = getComputedStyle(page), shellTop = page.getBoundingClientRect().top;
    const height = Math.round(page.getBoundingClientRect().width * 1.4143577), gap = 60;
    const top = parseFloat(style.paddingTop), bottom = parseFloat(style.paddingBottom);
    const misses = [], blockCount = e.state.doc.childCount;
    e.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return;
      for (let offset = 0; offset <= node.content.size; offset += 9) {
        const coords = e.view.coordsAtPos(pos + 1 + offset), y = coords.top - shellTop;
        const within = y - Math.floor(y / (height + gap)) * (height + gap);
        if (within < top - 3 || within + coords.bottom - coords.top > height - bottom + 3) misses.push({ pos: pos + 1 + offset, y, within });
      }
      return false;
    });
    return { breaks: paginationPluginKey.getState(e.state).pageBreaks.map(({ pos, height, type }) => ({ pos, height, type })), pages: page.querySelectorAll('.page-sheet-bg:not(.motion-sheet-exiting)').length, misses: misses.slice(0, 8), blockCount, text: e.getText(), json: e.getJSON() };
  }, paneId);
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  await check('pagination is disabled for a new project', async page => {
    assert.equal(await page.evaluate(() => window.nocturneApp.state.settings.autoPaginate), false);
    const result = await geometry(page); assert.equal(result.breaks.length, 0); assert.equal(result.pages, 0); return { pages: result.pages };
  });
  await check('F20 a long single paragraph never crosses page margins and model stays intact', async page => {
    const text = Array.from({ length: 1400 }, (_, i) => `word${i}`).join(' ');
    await enable(page, `<p>${text}</p>`); const result = await geometry(page);
    assert.equal(result.text, text); assert.equal(result.blockCount, 1); assert.ok(result.breaks.length >= 2); assert.deepEqual(result.misses, []);
    const before = JSON.stringify(result.json);
    await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.autoPaginate = false; a.applySettings(); a.nocturneEditor.scheduleVisualPages('primary'); }); await page.waitForTimeout(350);
    const disabled = await geometry(page); assert.equal(JSON.stringify(disabled.json), before); assert.equal(disabled.breaks.length, 0); assert.equal(disabled.pages, 0);
    return { pages: result.pages, breaks: result.breaks.length };
  });
  await check('F20 headings quotes code and empty lines all remain inside page content', async page => {
    const words = Array.from({ length: 600 }, (_, i) => `value${i}`).join(' ');
    await enable(page, `<h1>First heading</h1><p>${words}</p><h3>Third heading</h3><blockquote><p>${words}</p><p>Second quoted paragraph</p></blockquote><pre><code>${Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')}</code></pre><hr><p></p><p>Final paragraph</p>`);
    const result = await geometry(page); assert.ok(result.pages >= 4); assert.deepEqual(result.misses, []); assert.match(result.text, /Final paragraph/); return { pages: result.pages, breaks: result.breaks.length };
  });
  await check('F21 active sheet follows the caret within a multi-page paragraph', async page => {
    await enable(page, `<p>${'paragraph words '.repeat(1600)}</p>`);
    const result = await page.evaluate(() => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), shell = a.nocturneEditor.instances.get('primary').pageShell;
      e.commands.setTextSelection(e.state.doc.content.size - 1);
      const y = e.view.coordsAtPos(e.state.selection.head).top - shell.getBoundingClientRect().top;
      return { expected: Math.floor(y / (Math.round(shell.getBoundingClientRect().width * 1.4143577) + 60)), actual: [...shell.querySelectorAll('.page-sheet-bg')].findIndex(sheet => sheet.classList.contains('active')) };
    });
    assert.equal(result.actual, result.expected); assert.ok(result.actual > 0); return result;
  });
  await check('hard breaks blank lines formatting and Unicode paginate without changing text', async page => {
    await enable(page, `<h2>Unicode heading</h2><p><strong>${'«Диалог 🙂» '.repeat(500)}</strong>${'<br>'.repeat(140)}<em>Последняя строка</em></p>`);
    const result = await geometry(page); assert.deepEqual(result.misses, []); assert.ok(result.pages > 4); assert.match(result.text, /Последняя строка/); return { pages: result.pages, breaks: result.breaks.length };
  });
  await check('typing and backspace at a page boundary never insert or delete a spacer from the model', async page => {
    await enable(page, `<p>${'Page boundary sentence. '.repeat(1000)}</p>`);
    const result = await geometry(page), boundary = result.breaks[0].pos;
    await page.evaluate(pos => window.nocturneApp.nocturneEditor.get('primary').commands.setTextSelection(pos), boundary);
    await page.locator('.page-content-prosemirror').focus(); await page.keyboard.type('Boundary!'); await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), result.text.slice(0, boundary - 1) + 'Boundary!' + result.text.slice(boundary - 1));
    for (let i = 0; i < 9; i++) await page.keyboard.press('Backspace'); await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), result.text);
    assert.deepEqual((await geometry(page)).misses, []);
  });
  await check('pagination preserves typing selection history saves and dump text', async page => {
    await enable(page, `<p>${'Boundary writing text '.repeat(650)}</p>`);
    await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').commands.focus('end')); await page.waitForTimeout(80);
    const before = await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()); await page.keyboard.type(' Added words.'); await page.waitForTimeout(600);
    const after = await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()); assert.equal(after, before + ' Added words.');
    await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').commands.undo()); await page.waitForTimeout(300); assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), before);
    await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').commands.redo()); await page.waitForTimeout(300);
    const saved = await page.evaluate(async () => { const a = window.nocturneApp; await a.saveActiveDoc({ silent: true }); const dump = await a.buildNocturneDump(); return { raw: await a.db.get('docs', a.getFocusedDoc().id), dump }; });
    assert.match(JSON.stringify(saved), /Added words/); assert.doesNotMatch(JSON.stringify(saved), /pm-page-break|pagination-measure/);
    const result = await geometry(page); assert.deepEqual(result.misses, []); return { pages: result.pages };
  });
  await check('pagination reflows after font and split width changes', async page => {
    await enable(page, `<p>${'Resize and split content '.repeat(1100)}</p>`);
    const before = await geometry(page);
    await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.fontSize = 21; a.applySettings(); a.nocturneEditor.scheduleVisualPages('primary'); }); await page.waitForTimeout(500);
    const large = await geometry(page); assert.deepEqual(large.misses, []); assert.ok(large.pages > before.pages);
    await page.evaluate(() => window.nocturneApp.toggleSplitMode()); await page.waitForTimeout(650);
    const split = await geometry(page); assert.deepEqual(split.misses, []); assert.ok(split.pages >= large.pages); return { before: before.pages, large: large.pages, split: split.pages };
  });
  await check('spellcheck underline follows its text after pagination and font reflow', async page => {
    await enable(page, `<p>${'Reflow underline sentence. '.repeat(650)}</p>`);
    await page.evaluate(() => {
      const a = window.nocturneApp, block = document.querySelector('.page-content-prosemirror p[data-block-id]');
      const text = block.firstChild, range = document.createRange(); range.setStart(text, 90); range.setEnd(text, 99);
      const blockId = block.dataset.blockId;
      a.state.settings.strictSpellcheck = true;
      a._typoHighlightRangesMap = new Map([[`${blockId}:90:99`, { range, blockId, startOffset: 90, endOffset: 99 }]]);
      a.renderTypoSvgOverlays();
      a.state.settings.fontSize = 23; a.applySettings();
    });
    await page.waitForTimeout(350);
    const result = await page.evaluate(() => {
      const a = window.nocturneApp, [key, item] = [...a._typoHighlightRangesMap][0];
      const svg = document.querySelector(`.typo-svg-overlay[data-key="${CSS.escape(key)}"]`);
      const rect = item.range.getBoundingClientRect(), overlay = svg.parentElement.getBoundingClientRect();
      return { top: parseFloat(svg.style.top), expectedTop: rect.bottom - overlay.top - 1.5, left: parseFloat(svg.style.left), expectedLeft: rect.left - overlay.left };
    });
    assert.ok(Math.abs(result.top - result.expectedTop) < 1, JSON.stringify(result));
    assert.ok(Math.abs(result.left - result.expectedLeft) < 1, JSON.stringify(result)); return result;
  });
  await check('mobile pagination uses current viewport width without horizontal overflow', async page => {
    await enable(page, `<p>${'Mobile paragraph content '.repeat(550)}</p>`);
    const result = await geometry(page); assert.deepEqual(result.misses, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: 'release/qa/pagination-mobile.png' }); return { pages: result.pages };
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
} finally { await browser.close(); server.kill(); await mkdir('release/qa', { recursive: true }); await writeFile('release/qa/pagination-regressions.json', JSON.stringify(results, null, 2)); }
if (results.some(result => !result.passed)) process.exitCode = 1;
