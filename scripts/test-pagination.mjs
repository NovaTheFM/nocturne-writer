import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = 'http://localhost:5315';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5315', SYNC_PORT: '8915' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const match = process.argv.find(arg => arg.startsWith('--match='))?.slice(8);
async function check(name, run, options = {}) {
  if (match && !name.includes(match)) return;
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
    const sheets = [...page.querySelectorAll('.page-sheet-bg:not(.motion-sheet-exiting)')];
    return { breaks: paginationPluginKey.getState(e.state).pageBreaks.map(({ pos, height, type }) => ({ pos, height, type })), pages: sheets.length, width: page.getBoundingClientRect().width, expectedHeight: height, sheetHeights: sheets.map(sheet => sheet.getBoundingClientRect().height), misses: misses.slice(0, 8), blockCount, text: e.getText(), json: e.getJSON() };
  }, paneId);
}
async function splitDocuments(page, paginated) {
  await page.evaluate(async paginated => {
    const a = window.nocturneApp;
    a.nocturneEditor.get('primary').commands.setContent(`<p>${'Live resizing of the first manuscript. '.repeat(85)}</p>`);
    await a.saveActiveDoc({ silent: true }); const first = a.getFocusedDoc().id;
    await a.createDoc(a.defaultFolderId(), 'Second split manuscript', '');
    a.nocturneEditor.get('primary').commands.setContent(`<p>${'Second manuscript must also follow the divider. '.repeat(70)}</p>`);
    await a.saveActiveDoc({ silent: true }); const second = a.getFocusedDoc().id;
    a.state.settings.autoPaginate = paginated; a.applySettings();
    a.openInPane('primary', { type: 'document', docId: first });
    a.openSecondaryPane({ type: 'document', docId: second });
  }, paginated);
  await page.waitForTimeout(700);
}
async function dragSplit(page, inspect) {
  const divider = await page.locator('#workspace-divider').boundingBox(), stage = await page.locator('#workspace-stage').boundingBox();
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 40); await page.mouse.down();
  try {
    for (const ratio of [.37, .64, .43, .7, .5]) {
      await page.mouse.move(stage.x + stage.width * ratio, divider.y + 40, { steps: 6 });
      await page.waitForTimeout(120);
      assert.equal(await page.evaluate(() => document.body.classList.contains('resizing-workspace')), true);
      await inspect(ratio);
    }
  } finally { await page.mouse.up(); }
  assert.equal(await page.evaluate(() => document.body.classList.contains('resizing-workspace')), false);
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
    const large = await geometry(page); assert.deepEqual(large.misses, [], JSON.stringify({ phase: 'font', width: large.width, expectedHeight: large.expectedHeight })); assert.ok(large.pages > before.pages);
    await page.evaluate(() => window.nocturneApp.toggleSplitMode()); await page.waitForTimeout(650);
    const split = await geometry(page); assert.deepEqual(split.misses, [], JSON.stringify({ phase: 'split', width: split.width, expectedHeight: split.expectedHeight })); assert.ok(split.pages >= large.pages); return { before: before.pages, large: large.pages, split: split.pages };
  });
  await check('live split resizing keeps both paginated manuscripts inside their current sheets before mouseup', async page => {
    await splitDocuments(page, true);
    const before = Object.fromEntries(await Promise.all(['primary', 'secondary'].map(async id => [id, await geometry(page, id)]))), measurements = [];
    await dragSplit(page, async ratio => {
      for (const paneId of ['primary', 'secondary']) {
        const current = await geometry(page, paneId);
        assert.deepEqual(current.misses, [], JSON.stringify({ ratio, paneId, width: current.width, misses: current.misses }));
        assert.ok(current.pages > 1 && current.sheetHeights.every(height => Math.abs(height - current.expectedHeight) < 2), JSON.stringify({ ratio, paneId, expected: current.expectedHeight, heights: current.sheetHeights }));
        assert.deepEqual(current.json, before[paneId].json);
        measurements.push({ ratio, paneId, width: current.width, pages: current.pages });
      }
    });
    for (const paneId of ['primary', 'secondary']) assert.deepEqual((await geometry(page, paneId)).misses, []);
    assert.ok(new Set(measurements.map(item => item.width)).size > 4); return measurements;
  });
  await check('live split resizing leaves pagination disabled and both documents intact by default', async page => {
    assert.equal(await page.evaluate(() => window.nocturneApp.state.settings.autoPaginate), false);
    await splitDocuments(page, false);
    const before = Object.fromEntries(await Promise.all(['primary', 'secondary'].map(async id => [id, (await geometry(page, id)).json])));
    await dragSplit(page, async () => {
      for (const paneId of ['primary', 'secondary']) {
        const current = await geometry(page, paneId);
        assert.equal(current.pages, 0); assert.deepEqual(current.breaks, []); assert.deepEqual(current.json, before[paneId]);
      }
    });
    assert.equal(await page.evaluate(() => window.nocturneApp.state.settings.autoPaginate), false);
  });
  await check('divider consumes the latest pointer position during the next render before mouseup', async page => {
    await splitDocuments(page, false);
    const divider = await page.locator('#workspace-divider').boundingBox();
    await page.mouse.move(divider.x + divider.width / 2, divider.y + 40); await page.mouse.down();
    let result;
    try {
      result = await page.evaluate(() => new Promise(resolve => {
        const stage = document.getElementById('workspace-stage').getBoundingClientRect();
        const move = ratio => window.dispatchEvent(new PointerEvent('pointermove', { clientX: stage.left + stage.width * ratio, clientY: stage.top + 40, buttons: 1, pointerType: 'mouse' }));
        requestAnimationFrame(() => {
          move(.41);
          requestAnimationFrame(() => {
            move(.64);
            requestAnimationFrame(() => requestAnimationFrame(() => resolve({ ratio: window.nocturneApp.state.workspace.splitRatio, held: document.body.classList.contains('resizing-workspace') })));
          });
        });
      }));
      assert.equal(result.held, true); assert.ok(Math.abs(result.ratio - .64) < .001, JSON.stringify(result));
    } finally { await page.mouse.up(); }
    return result;
  });
  await check('cached pagination reflows edits undo and font changes while the divider is held', async page => {
    await enable(page, `<p>${'Пересчёт длинного абзаца 🙂 при изменении ширины. '.repeat(650)}</p>`);
    await page.evaluate(() => window.nocturneApp.toggleSplitMode()); await page.waitForTimeout(650);
    const original = (await geometry(page)).text, measurements = [];
    let step = 0;
    await dragSplit(page, async ratio => {
      if (step === 0) {
        await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').commands.focus('end'));
        await page.waitForTimeout(100);
        await page.keyboard.insertText(' Дополнение 🙂');
      } else if (step === 1) {
        await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.fontSize = 21; a.state.settings.paragraphIndent = true; a.applySettings(); });
      } else if (step === 2) await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').commands.undo());
      else if (step === 3) await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').commands.redo());
      await page.waitForTimeout(300);
      const result = await geometry(page);
      assert.deepEqual(result.misses, [], JSON.stringify({ ratio, step, misses: result.misses }));
      const expected = original + (step === 2 ? '' : ' Дополнение 🙂');
      assert.ok(result.text === expected, JSON.stringify({ step, actualLength: result.text.length, expectedLength: expected.length, tail: result.text.slice(-80) }));
      assert.equal(await page.locator('.primary-pane [contenteditable="true"]').count(), 1);
      measurements.push({ ratio, pages: result.pages, fontSize: await page.evaluate(() => window.nocturneApp.state.settings.fontSize) }); step++;
      if (step === 5) {
        await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.autoPaginate = false; a.applySettings(); }); await page.waitForTimeout(300);
        assert.equal((await geometry(page)).pages, 0);
        assert.equal(await page.locator('.pagination-measure').count(), 0);
      }
    });
    assert.equal(await page.locator('.pagination-measure').count(), 0); return measurements;
  });
  await check('a long unbroken Unicode string reflows during drag without splitting surrogate pairs', async page => {
    const text = 'абвгдеёж🙂'.repeat(1900);
    await enable(page, `<p>${text}</p>`); await page.evaluate(() => window.nocturneApp.toggleSplitMode()); await page.waitForTimeout(650);
    const measurements = [];
    await dragSplit(page, async ratio => {
      const result = await geometry(page);
      assert.deepEqual(result.misses, []); assert.equal(result.text, text); assert.ok(result.pages > 1);
      for (const boundary of result.breaks) assert.ok(!/[\uDC00-\uDFFF]/.test(text[boundary.pos - 1]), `break at the middle of an emoji: ${boundary.pos}`);
      measurements.push({ ratio, pages: result.pages });
    });
    await page.waitForFunction(() => !window.nocturneApp.nocturneEditor.visualPageRaf.has('primary'));
    assert.equal(await page.locator('.pagination-measure').count(), 0); return measurements;
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
  await check('a trailing blank line can start a new sheet without moving the whole paragraph', async page => {
    const measurements = await page.evaluate(() => {
      const a = window.nocturneApp, instance = a.nocturneEditor.instances.get('primary'), style = getComputedStyle(instance.pageShell);
      const height = Math.round(instance.pageShell.getBoundingClientRect().width * 1123 / 794), line = parseFloat(getComputedStyle(instance.editor.view.dom.querySelector('p')).lineHeight);
      return { lines: Math.floor((height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)) / line) };
    });
    await enable(page, `<p>${'<br>'.repeat(measurements.lines)}</p>`);
    const result = await page.evaluate(() => {
      const a = window.nocturneApp, instance = a.nocturneEditor.instances.get('primary'), e = instance.editor, shell = instance.pageShell;
      const style = getComputedStyle(shell), origin = shell.getBoundingClientRect().top;
      const height = Math.round(shell.getBoundingClientRect().width * 1123 / 794), stride = height + 60, misses = [];
      for (let pos = 1; pos <= e.state.doc.content.size - 1; pos++) {
        const c = e.view.coordsAtPos(pos), y = c.top - origin, within = y % stride;
        if (within < parseFloat(style.paddingTop) - 3 || within + c.bottom - c.top > height - parseFloat(style.paddingBottom) + 3) misses.push(pos);
      }
      return { firstPage: Math.floor((e.view.coordsAtPos(1).top - origin) / stride), misses };
    });
    assert.equal(result.firstPage, 0); assert.deepEqual(result.misses, []); return result;
  });
} finally { await browser.close(); server.kill(); await mkdir('release/qa', { recursive: true }); await writeFile('release/qa/pagination-regressions.json', JSON.stringify(results, null, 2)); }
if (results.some(result => !result.passed)) process.exitCode = 1;
