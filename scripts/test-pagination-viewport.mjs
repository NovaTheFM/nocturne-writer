import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5326', SYNC_PORT: '8926' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true }), results = [], coverage = [];
const shape = process.argv.find(arg => arg.startsWith('--shape='))?.slice(8);
try {
  for (let attempt = 0; attempt < 60; attempt++) { try { if ((await fetch('http://localhost:5326')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const kind of ['single-paragraph', 'many-paragraphs', 'formatted-paragraph']) {
    if (shape && kind !== shape) continue;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }), page = await context.newPage(), errors = [];
    const profiler = await context.newCDPSession(page); await profiler.send('Profiler.enable'); await profiler.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto('http://localhost:5326'); await page.waitForSelector('#preloader.hidden', { state: 'attached' });
      await page.evaluate(async kind => {
        const a = window.nocturneApp; a.state.settings.automaticBackups = false;
        await a.createDoc(a.defaultFolderId(), 'Viewport pagination', '');
        const sentence = 'Ночной писатель продолжает очень длинную рукопись 🙂 и проверяет переносы страниц. ';
        const paragraphs = kind === 'formatted-paragraph' ? [`<strong>${sentence.repeat(600)}</strong><em>${'абвгдеёж🙂'.repeat(2200)}</em><br>${sentence.repeat(350)}`] : kind === 'single-paragraph' ? [sentence.repeat(2200)] : Array.from({ length: 500 }, (_, index) => `${index} ${sentence.repeat(4)}`);
        a.nocturneEditor.get('primary').commands.setContent(paragraphs.map(text => `<p>${text}</p>`).join(''));
        await a.saveActiveDoc({ silent: true }); a.state.settings.autoPaginate = true; a.applySettings(); a.toggleSplitMode(); await document.fonts.ready;
      }, kind);
      await page.waitForTimeout(850);
      const original = await page.evaluate(() => JSON.stringify(window.nocturneApp.nocturneEditor.get('primary').getJSON()));
      const samples = [];
      for (const location of [0, .5, 1]) {
        await page.evaluate(location => { const scroll = document.querySelector('.primary-pane .editor-scroll-area'), behavior = scroll.style.scrollBehavior; scroll.style.scrollBehavior = 'auto'; scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * location; scroll.style.scrollBehavior = behavior; }, location);
        await page.waitForTimeout(100);
        const divider = await page.locator('#workspace-divider').boundingBox(), stage = await page.locator('#workspace-stage').boundingBox();
        await page.mouse.move(divider.x + divider.width / 2, divider.y + 40); await page.mouse.down();
        await page.evaluate(() => {
          const metrics = window.__viewportResize = { active: true, longestRange: 0, frames: 0, misses: [] };
          const rects = Range.prototype.getClientRects;
          Range.prototype.getClientRects = function () {
            const element = this.startContainer.nodeType === Node.TEXT_NODE ? this.startContainer.parentElement : this.startContainer;
            if (metrics.active && element.closest?.('.pagination-measure')) metrics.longestRange = Math.max(metrics.longestRange, this.startContainer === this.endContainer && this.startContainer.nodeType === Node.TEXT_NODE ? this.endOffset - this.startOffset : this.toString().length);
            return rects.call(this);
          };
          const tick = () => {
            if (!metrics.active) return;
            queueMicrotask(() => {
              const instance = window.nocturneApp.nocturneEditor.instances.get('primary'), e = instance.editor, shell = instance.pageShell;
              const scroll = shell.closest('.editor-scroll-area').getBoundingClientRect(), paper = shell.getBoundingClientRect(), style = getComputedStyle(shell);
              const height = Math.round(paper.width * 1123 / 794), stride = height + 60;
              for (let y = scroll.top + 15; y < scroll.bottom - 10; y += 19) {
                const pos = e.view.posAtCoords({ left: e.view.dom.getBoundingClientRect().left + 12, top: y })?.pos;
                if (pos == null) continue;
                const rect = e.view.coordsAtPos(pos), within = ((rect.top - paper.top) % stride + stride) % stride;
                if (rect.top < scroll.top || rect.bottom > scroll.bottom) continue;
                if (within < parseFloat(style.paddingTop) - 3 || within + rect.bottom - rect.top > height - parseFloat(style.paddingBottom) + 3) metrics.misses.push({ width: paper.width, pos, within, lineHeight: rect.bottom - rect.top });
              }
              metrics.frames++;
            });
            requestAnimationFrame(tick);
          }; requestAnimationFrame(tick);
        });
        for (const ratio of [.38, .65, .44, .7, .5]) await page.mouse.move(stage.x + stage.width * ratio, divider.y + 40, { steps: 5 });
        await page.waitForTimeout(70);
        const held = await page.evaluate(() => { window.__viewportResize.active = false; return { ...window.__viewportResize, held: document.body.classList.contains('resizing-workspace'), virtual: document.querySelectorAll('.primary-pane [data-viewport-hidden]').length, json: JSON.stringify(window.nocturneApp.nocturneEditor.get('primary').getJSON()) }; });
        if (kind === 'single-paragraph' && location === 0) {
          await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').chain().focus().selectAll().run()); await page.waitForTimeout(100);
          const copied = await page.evaluate(() => {
            const e = window.nocturneApp.nocturneEditor.get('primary'), clipboard = new DataTransfer();
            e.view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true }));
            return { actual: clipboard.getData('text/plain'), expected: e.getText() };
          }); assert.equal(copied.actual, copied.expected);
          await page.keyboard.press('Backspace'); await page.waitForTimeout(120);
          assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), '');
          await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').commands.undo()); await page.waitForTimeout(180);
        }
        await page.mouse.up();
        await page.waitForFunction(() => !window.nocturneApp.nocturneEditor.visualPageRaf.has('primary') && !document.querySelector('.primary-pane [data-viewport-hidden]'));
        const final = await page.evaluate(() => {
          const instance = window.nocturneApp.nocturneEditor.instances.get('primary'), e = instance.editor, shell = instance.pageShell, style = getComputedStyle(shell), bounds = shell.getBoundingClientRect();
          const height = Math.round(bounds.width * 1123 / 794), stride = height + 60, misses = [];
          e.state.doc.descendants((node, pos) => {
            if (!node.isTextblock) return;
            const step = Math.max(1, Math.floor(node.content.size / 150));
            for (let offset = 0; offset <= node.content.size; offset += step) {
              const c = e.view.coordsAtPos(pos + 1 + offset), within = ((c.top - bounds.top) % stride + stride) % stride;
              if (within < parseFloat(style.paddingTop) - 3 || within + c.bottom - c.top > height - parseFloat(style.paddingBottom) + 3) misses.push(pos + 1 + offset);
            } return false;
          });
          return { misses: misses.slice(0, 8), json: JSON.stringify(e.getJSON()) };
        });
        assert.equal(held.held, true); assert.equal(held.json, original); assert.equal(final.json, original); assert.deepEqual(final.misses, []);
        assert.ok(held.frames > 5); assert.deepEqual(held.misses.slice(0, 8), [], `Text crossed page margins before paint at scroll ${location}: ${JSON.stringify(held.misses.slice(0, 8))}`);
        assert.ok(held.virtual > 0, 'Offscreen manuscript must skip rendering during divider drag');
        assert.ok(held.longestRange < 15000, `Measured ${held.longestRange} characters at once instead of a viewport-sized range`);
        samples.push({ location, frames: held.frames, longestRange: held.longestRange, virtual: held.virtual });
      }
      const divider = await page.locator('#workspace-divider').boundingBox(); await page.mouse.move(divider.x + 2, divider.y + 40); await page.mouse.down();
      await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.autoPaginate = false; a.applySettings(); }); await page.waitForTimeout(100);
      assert.equal(await page.locator('[data-viewport-hidden], .pm-viewport-placeholder, .pagination-measure').count(), 0); await page.mouse.up();
      const { result } = await profiler.send('Profiler.takePreciseCoverage'); coverage.push(...result.filter(script => script.url.endsWith('/src/editor/viewport-pagination.js')));
      assert.deepEqual(errors, []); results.push({ kind, passed: true, samples }); console.log(`PASS ${kind}: viewport-only measurement, no frame with text in page gaps, full layout restored after drag.`);
    } catch (error) { results.push({ kind, passed: false, error: error.message }); console.error(`FAIL ${kind}: ${error.message}`); }
    finally { await context.close(); }
  }
} finally {
  await browser.close(); server.kill(); await mkdir('release/qa', { recursive: true });
  const size = Math.max(0, ...coverage.flatMap(script => script.functions.flatMap(fn => fn.ranges.map(range => range.endOffset)))), covered = new Uint8Array(size);
  for (const script of coverage) {
    const run = new Uint8Array(size);
    for (const range of script.functions.flatMap(fn => fn.ranges).sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset))) run.fill(range.count > 0 ? 1 : 0, range.startOffset, range.endOffset);
    for (let index = 0; index < size; index++) covered[index] |= run[index];
  }
  const percent = size ? covered.reduce((sum, byte) => sum + byte, 0) / size * 100 : 0;
  await writeFile('release/qa/pagination-viewport.json', JSON.stringify({ results, coverage: { module: 'src/editor/viewport-pagination.js', v8BytePercent: percent } }, null, 2));
  console.log(`Viewport pagination V8 byte coverage: ${percent.toFixed(1)}%`);
}
if (results.some(result => !result.passed)) process.exitCode = 1;
