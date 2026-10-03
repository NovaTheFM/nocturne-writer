import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const argument = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || fallback;
const label = argument('label', 'current').replace(/[^a-z0-9_-]/gi, '-');
const words = Number(argument('words', '50000'));
assert.ok(Number.isInteger(words) && words >= 1000 && words <= 500000);
const url = 'http://localhost:5322';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5322', SYNC_PORT: '8922' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
await mkdir('release/qa/pagination-performance', { recursive: true });
const filename = `release/qa/pagination-performance/${label}.json`;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] || 0;
const metadata = { label, words, commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), checkedAt: new Date().toISOString() };
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const shape of ['single-paragraph', 'many-paragraphs']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(120000);
    try {
      await page.goto(url); await page.waitForSelector('#preloader.hidden', { state: 'attached' });
      await page.evaluate(async ({ shape, words }) => {
        const a = window.nocturneApp; a.state.settings.automaticBackups = false;
        await a.createDoc(a.defaultFolderId(), 'Large split benchmark', '');
        const sentence = 'The quiet writer watches the distant river and remembers every word. ';
        const text = sentence.repeat(Math.ceil(words / 12)).split(' ').slice(0, words).join(' ');
        const parts = shape === 'single-paragraph' ? [text] : text.split(' ').reduce((items, word, index) => {
          if (index % 50 === 0) items.push([]); items.at(-1).push(word); return items;
        }, []).map(words => words.join(' '));
        a.nocturneEditor.get('primary').commands.setContent(parts.map(part => `<p>${part}</p>`).join(''));
        await a.saveActiveDoc({ silent: true }); a.state.settings.autoPaginate = true; a.applySettings(); a.toggleSplitMode();
        await document.fonts.ready;
        window.__performanceDocument = JSON.stringify(a.nocturneEditor.get('primary').getJSON());
      }, { shape, words });
      await page.waitForFunction(() => !window.nocturneApp.nocturneEditor.visualPageRaf.has('primary'), null, { polling: 100 });
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const metrics = window.__resizeMetrics = { enabled: true, bounds: 0, fragments: 0, layouts: [], frames: [], previousFrame: 0 };
        const bounds = Range.prototype.getBoundingClientRect, fragments = Range.prototype.getClientRects, raf = window.requestAnimationFrame;
        Range.prototype.getBoundingClientRect = function () { metrics.bounds++; return bounds.call(this); };
        Range.prototype.getClientRects = function () { metrics.fragments++; return fragments.call(this); };
        window.requestAnimationFrame = callback => raf.call(window, time => {
          const start = performance.now(), before = metrics.bounds + metrics.fragments;
          callback(time);
          const calls = metrics.bounds + metrics.fragments - before;
          if (metrics.enabled && calls > 20) metrics.layouts.push({ durationMs: performance.now() - start, rangeReads: calls });
        });
        const tick = time => {
          if (!metrics.enabled) return;
          if (metrics.previousFrame) metrics.frames.push(time - metrics.previousFrame);
          metrics.previousFrame = time; raf.call(window, tick);
        };
        raf.call(window, tick);
      });
      const divider = await page.locator('#workspace-divider').boundingBox(), stage = await page.locator('#workspace-stage').boundingBox();
      await page.mouse.move(divider.x + divider.width / 2, divider.y + 40); await page.mouse.down();
      const samples = [];
      try {
        for (const ratio of [.42, .60, .48]) {
          await page.mouse.move(stage.x + stage.width * ratio, divider.y + 40, { steps: 4 });
          await page.waitForFunction(() => !window.nocturneApp.nocturneEditor.visualPageRaf.has('primary'), null, { polling: 100 });
          await page.waitForTimeout(80);
          const sample = await page.evaluate(ratio => {
            const a = window.nocturneApp, instance = a.nocturneEditor.instances.get('primary'), e = instance.editor, shell = instance.pageShell;
            const style = getComputedStyle(shell), origin = shell.getBoundingClientRect().top, width = shell.getBoundingClientRect().width;
            const height = Math.round(width * 1123 / 794), stride = height + 60, positions = [], misses = [];
            e.state.doc.descendants((node, pos) => { if (node.isTextblock) { positions.push(pos + 1, pos + 1 + node.content.size); return false; } });
            const end = e.state.doc.content.size - 1;
            for (let index = 0; index < 100; index++) positions.push(Math.max(1, Math.round(end * index / 99)));
            for (const pos of positions.filter((_, index, rows) => index % Math.max(1, Math.floor(rows.length / 160)) === 0)) {
              const c = e.view.coordsAtPos(pos), within = ((c.top - origin) % stride + stride) % stride;
              if (within < parseFloat(style.paddingTop) - 3 || within + c.bottom - c.top > height - parseFloat(style.paddingBottom) + 3) misses.push(pos);
            }
            return { ratio, width, height, sheetHeight: shell.querySelector('.page-sheet-bg:not(.motion-sheet-exiting)').getBoundingClientRect().height, pages: shell.querySelectorAll('.page-sheet-bg:not(.motion-sheet-exiting)').length, held: document.body.classList.contains('resizing-workspace'), misses: misses.slice(0, 8), intact: JSON.stringify(e.getJSON()) === window.__performanceDocument };
          }, ratio);
          assert.equal(sample.held, true); assert.equal(sample.intact, true); assert.deepEqual(sample.misses, []);
          assert.ok(Math.abs(sample.sheetHeight - sample.height) < 2);
          samples.push(sample);
        }
      } finally { await page.mouse.up(); }
      const metrics = await page.evaluate(() => { window.__resizeMetrics.enabled = false; return window.__resizeMetrics; });
      const result = { shape, characters: await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText().length), samples, layouts: metrics.layouts, layoutP95Ms: percentile(metrics.layouts.map(item => item.durationMs), .95), frameP95Ms: percentile(metrics.frames, .95), frameMaxMs: Math.max(0, ...metrics.frames), rangeReads: metrics.layouts.reduce((sum, item) => sum + item.rangeReads, 0), errors };
      results.push(result); assert.deepEqual(errors, []);
      console.log(`${shape}, ${words} words: layout p95 ${result.layoutP95Ms.toFixed(1)} ms, frame p95 ${result.frameP95Ms.toFixed(1)} ms, ${result.rangeReads} Range reads; geometry and JSON intact.`);
      await writeFile(filename, JSON.stringify({ ...metadata, results }, null, 2));
    } finally { await context.close(); }
  }
  if (process.argv.includes('--assert')) {
    for (const result of results) {
      assert.ok(result.layouts.length > 0);
      assert.ok(result.layoutP95Ms < 100, `${result.shape}: pagination p95 ${result.layoutP95Ms.toFixed(1)} ms exceeds the 100 ms resize budget`);
    }
  }
} finally { await browser.close(); server.kill(); await writeFile(filename, JSON.stringify({ ...metadata, results }, null, 2)); }
