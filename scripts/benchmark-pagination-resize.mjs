import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import path from 'node:path';
import { chooseDefaultInterfaceLanguage } from './qa/first-run-language.mjs';

const argument = (name, fallback) => process.argv.find(arg => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=') || fallback;
const label = argument('label', 'current').replace(/[^a-z0-9_-]/gi, '-');
const words = Number(argument('words', '50000'));
const targetPages = Number(argument('pages', '0'));
const pageMode = argument('page-mode', 'full');
const budgetMs = Number(argument('budget-ms', '100'));
const source = path.resolve(argument('source', '.'));
const shapeFilter = argument('shape', 'all');
assert.ok(Number.isInteger(words) && words >= 1000 && words <= 500000);
assert.ok(Number.isInteger(targetPages) && targetPages >= 0 && targetPages <= 1000);
assert.ok(['full', 'split'].includes(pageMode));
assert.ok(['all', 'single-paragraph', 'many-paragraphs'].includes(shapeFilter));
assert.ok(Number.isFinite(budgetMs) && budgetMs > 0);
const url = 'http://localhost:5322';
const server = spawn(process.execPath, ['server.mjs'], { cwd: source, env: { ...process.env, PORT: '5322', SYNC_PORT: '8922' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true, ...(process.env.NOCTURNE_QA_BROWSER_CHANNEL ? { channel: process.env.NOCTURNE_QA_BROWSER_CHANNEL } : {}) });
const results = [];
await mkdir('release/qa/pagination-performance', { recursive: true });
const filename = `release/qa/pagination-performance/${label}.json`;
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] || 0;
const metadata = { label, words, targetPages, pageMode, budgetMs, source, commit: argument('revision', execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()), animations: process.argv.includes('--animate'), browser: browser.version(), checkedAt: new Date().toISOString() };
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const shape of ['single-paragraph', 'many-paragraphs']) {
    if (shapeFilter !== 'all' && shape !== shapeFilter) continue;
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: process.argv.includes('--animate') ? 'no-preference' : 'reduce' });
    const page = await context.newPage(); const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(120000);
    try {
      await page.goto(url); await page.waitForSelector('#preloader.hidden', { state: 'attached' });
      await chooseDefaultInterfaceLanguage(page);
      await page.evaluate(async ({ shape, words }) => {
        const a = window.nocturneApp; a.state.settings.automaticBackups = false;
        await a.createDoc(a.defaultFolderId(), 'Large split benchmark', '');
        const sentence = 'The quiet writer watches the distant river and remembers every word. ';
        window.__benchmarkContent = count => {
          const body = sentence.repeat(Math.ceil(count / 12)).split(' ').slice(0, count).join(' ');
          const parts = shape === 'single-paragraph' ? [body] : body.split(' ').reduce((items, word, index) => {
            if (index % 50 === 0) items.push([]); items.at(-1).push(word); return items;
          }, []).map(words => words.join(' '));
          a.nocturneEditor.get('primary').commands.setContent(parts.map(part => `<p>${part}</p>`).join(''));
        };
        window.__benchmarkContent(words);
        a.state.settings.autoPaginate = true; a.applySettings();
        await document.fonts.ready;
      }, { shape, words });
      if (pageMode === 'split') await page.evaluate(() => window.nocturneApp.toggleSplitMode());
      await page.waitForTimeout(650);
      let actualWords = words, initialPages = 0;
      for (let attempt = 0; attempt < 12; attempt++) {
        await page.waitForFunction(() => !window.nocturneApp.nocturneEditor.visualPageRaf.has('primary'), null, { polling: 100 });
        await page.waitForTimeout(80);
        initialPages = await page.locator('.primary-pane .page-sheet-bg:not(.motion-sheet-exiting)').count();
        if (!targetPages || initialPages === targetPages) break;
        actualWords = Math.round(actualWords * (targetPages - .2) / initialPages);
        await page.evaluate(count => window.__benchmarkContent(count), actualWords);
      }
      if (targetPages) assert.equal(initialPages, targetPages, 'fixture must match the reported full-width page count');
      await page.evaluate(async pageMode => {
        const a = window.nocturneApp; await a.saveActiveDoc({ silent: true }); if (pageMode !== 'split') a.toggleSplitMode();
        window.__performanceDocument = JSON.stringify(a.nocturneEditor.get('primary').getJSON());
      }, pageMode);
      await page.waitForFunction(() => !window.nocturneApp.nocturneEditor.visualPageRaf.has('primary'), null, { polling: 100 });
      await page.waitForTimeout(300);
      const profiler = process.argv.includes('--profile') ? await context.newCDPSession(page) : null;
      if (profiler) { await profiler.send('Profiler.enable'); await profiler.send('Profiler.start'); }
      await page.evaluate(() => {
        const metrics = window.__resizeMetrics = { enabled: true, finishing: false, finishingLayouts: [], bounds: 0, fragments: 0, layouts: [], frames: [], previousFrame: 0 };
        const bounds = Range.prototype.getBoundingClientRect, fragments = Range.prototype.getClientRects, raf = window.requestAnimationFrame;
        Range.prototype.getBoundingClientRect = function () { metrics.bounds++; return bounds.call(this); };
        Range.prototype.getClientRects = function () { metrics.fragments++; return fragments.call(this); };
        window.requestAnimationFrame = callback => raf.call(window, time => {
          const start = performance.now(), before = metrics.bounds + metrics.fragments;
          callback(time);
          const calls = metrics.bounds + metrics.fragments - before;
          if (metrics.enabled && calls > 20) metrics.layouts.push({ durationMs: performance.now() - start, rangeReads: calls });
          if (metrics.finishing && calls > 20) metrics.finishingLayouts.push(performance.now() - start);
        });
        const tick = time => {
          if (metrics.enabled) {
            if (metrics.previousFrame) metrics.frames.push(time - metrics.previousFrame);
            metrics.previousFrame = time;
          } else metrics.previousFrame = 0;
          raf.call(window, tick);
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
          await page.evaluate(() => { window.__resizeMetrics.enabled = false; window.__resizeMetrics.previousFrame = 0; });
          const sample = await page.evaluate(async ratio => {
            const a = window.nocturneApp, instance = a.nocturneEditor.instances.get('primary'), e = instance.editor, shell = instance.pageShell;
            const { paginationPluginKey } = await import('/src/editor/pagination-state.js');
            const viewport = paginationPluginKey.getState(e.state)?.viewport;
            const style = getComputedStyle(shell), origin = shell.getBoundingClientRect().top, width = shell.getBoundingClientRect().width;
            const height = Math.round(width * 1123 / 794), stride = height + 60, positions = [], misses = []; let deferred = 0;
            e.state.doc.descendants((node, pos) => { if (node.isTextblock) { positions.push(pos + 1, pos + 1 + node.content.size); return false; } });
            const end = e.state.doc.content.size - 1;
            for (let index = 0; index < 100; index++) positions.push(Math.max(1, Math.round(end * index / 99)));
            for (const pos of positions.filter((_, index, rows) => index % Math.max(1, Math.floor(rows.length / 160)) === 0)) {
              if (viewport && (pos < viewport.from || (pos >= viewport.to && viewport.to < e.state.doc.content.size - 1))) { deferred++; continue; }
              const dom = e.view.domAtPos(pos).node;
              if ((dom.nodeType === Node.ELEMENT_NODE ? dom : dom.parentElement)?.closest('[data-viewport-hidden]')) { deferred++; continue; }
              const c = e.view.coordsAtPos(pos), within = ((c.top - origin) % stride + stride) % stride;
              if (within < parseFloat(style.paddingTop) - 3 || within + c.bottom - c.top > height - parseFloat(style.paddingBottom) + 3) misses.push(pos);
            }
            return { ratio, width, height, sheetHeight: shell.querySelector('.page-sheet-bg:not(.motion-sheet-exiting)').getBoundingClientRect().height, pages: shell.querySelectorAll('.page-sheet-bg:not(.motion-sheet-exiting)').length, held: document.body.classList.contains('resizing-workspace'), deferred, misses: misses.slice(0, 8), intact: JSON.stringify(e.getJSON()) === window.__performanceDocument };
          }, ratio);
          assert.equal(sample.held, true); assert.equal(sample.intact, true); assert.deepEqual(sample.misses, [], JSON.stringify(sample));
          assert.ok(Math.abs(sample.sheetHeight - sample.height) < 2);
          samples.push(sample);
          await page.evaluate(() => { window.__resizeMetrics.enabled = true; });
        }
      } finally { await page.evaluate(() => { window.__resizeMetrics.enabled = false; window.__resizeMetrics.finishing = true; }); await page.mouse.up(); }
      await page.waitForFunction(() => !window.nocturneApp.nocturneEditor.visualPageRaf.has('primary'));
      await page.evaluate(() => { window.__resizeMetrics.finishing = false; });
      const final = await page.evaluate(() => {
        const a = window.nocturneApp, instance = a.nocturneEditor.instances.get('primary'), e = instance.editor, shell = instance.pageShell, style = getComputedStyle(shell), origin = shell.getBoundingClientRect().top;
        const height = Math.round(shell.getBoundingClientRect().width * 1123 / 794), stride = height + 60, positions = [], misses = [];
        e.state.doc.descendants((node, pos) => { if (node.isTextblock) { positions.push(pos + 1, pos + 1 + node.content.size); return false; } });
        for (let index = 0; index < 150; index++) positions.push(Math.max(1, Math.round((e.state.doc.content.size - 1) * index / 149)));
        for (const pos of positions) {
          const c = e.view.coordsAtPos(pos), within = ((c.top - origin) % stride + stride) % stride;
          if (within < parseFloat(style.paddingTop) - 3 || within + c.bottom - c.top > height - parseFloat(style.paddingBottom) + 3) misses.push(pos);
        }
        return { misses: misses.slice(0, 8), intact: JSON.stringify(e.getJSON()) === window.__performanceDocument, hidden: e.view.dom.querySelectorAll('[data-viewport-hidden]').length };
      });
      assert.deepEqual(final.misses, []); assert.equal(final.intact, true); assert.equal(final.hidden, 0);
      const metrics = await page.evaluate(() => { window.__resizeMetrics.enabled = false; return window.__resizeMetrics; });
      if (profiler) {
        const { profile } = await profiler.send('Profiler.stop');
        await writeFile(`release/qa/pagination-performance/${label}-${shape}-cpu.json`, JSON.stringify(profile));
        const nodes = new Map(profile.nodes.map(node => [node.id, node])), totals = new Map();
        for (let index = 0; index < profile.samples.length; index++) {
          const frame = nodes.get(profile.samples[index]).callFrame, key = `${frame.functionName} (${frame.url.split('/').at(-1)}:${frame.lineNumber + 1})`;
          totals.set(key, (totals.get(key) || 0) + profile.timeDeltas[index] / 1000);
        }
        console.log(JSON.stringify([...totals].sort((a, b) => b[1] - a[1]).slice(0, 15))); await profiler.detach();
      }
      const result = { shape, actualWords, initialPages, characters: await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText().length), samples, final, finalLayoutMs: Math.max(0, ...metrics.finishingLayouts), layouts: metrics.layouts, layoutP95Ms: percentile(metrics.layouts.map(item => item.durationMs), .95), frameP95Ms: percentile(metrics.frames, .95), frameMaxMs: Math.max(0, ...metrics.frames), rangeReads: metrics.layouts.reduce((sum, item) => sum + item.rangeReads, 0), errors };
      results.push(result); assert.deepEqual(errors, []);
      console.log(`${shape}, ${actualWords} words, ${initialPages} initial pages: layout p95 ${result.layoutP95Ms.toFixed(1)} ms, frame p95 ${result.frameP95Ms.toFixed(1)} ms, ${result.rangeReads} Range reads; geometry and JSON intact.`);
      await writeFile(filename, JSON.stringify({ ...metadata, results }, null, 2));
    } finally { await context.close(); }
  }
  if (process.argv.includes('--assert')) {
    for (const result of results) {
      assert.ok(result.layouts.length > 0);
      assert.ok(result.layoutP95Ms < budgetMs, `${result.shape}: pagination p95 ${result.layoutP95Ms.toFixed(1)} ms exceeds the ${budgetMs} ms resize budget`);
    }
  }
} finally { await browser.close(); server.kill(); await writeFile(filename, JSON.stringify({ ...metadata, results }, null, 2)); }
