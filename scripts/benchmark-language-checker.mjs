import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort, killOwnedProcess } from './qa/runner.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/language-performance');
await mkdir(directory, { recursive: true });
const port = await availablePort(), url = `http://127.0.0.1:${port}`, results = [];
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let browser;
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const profile of ['desktop', 'android'].filter(value => !process.env.NOCTURNE_QA_PLATFORM || process.env.NOCTURNE_QA_PLATFORM === 'all' || process.env.NOCTURNE_QA_PLATFORM === value)) {
    const mobile = profile === 'android', context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile }), page = await context.newPage();
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    const evidence = await page.evaluate(async () => {
      const { getSmartSpellerMatches } = await import('/src/core/smart-speller.js'), words = text => text.match(/\p{L}+/gu) || [];
      const dictionary = window.nocturneApp.getEffectiveTypoLookup();
      const cold = [], gaps = []; let previous = performance.now(), active = true;
      const frame = time => { gaps.push(time - previous); previous = time; if (active) requestAnimationFrame(frame); }; requestAnimationFrame(frame);
      await new Promise(resolve => setTimeout(resolve, 100));
      const texts = { ru: 'Она купил хлеб.', uk: 'Вона купив хліб.', en: 'She have a book.' };
      for (const [lang, text] of Object.entries(texts)) {
        const started = performance.now(), result = await getSmartSpellerMatches(words(text), { mode: 'local', lang, contextText: text, localLookup: dictionary });
        cold.push({ lang, durationMs: Math.round(performance.now() - started), issues: result.issues.length });
      }
      const text = 'Она увидела белый дом. Мы вернулись домой.\n'.repeat(2500) + 'Она купил хлеб.';
      const started = performance.now(), result = await getSmartSpellerMatches(words(text), { mode: 'local', lang: 'ru', contextText: text, localLookup: dictionary });
      const warmMs = Math.round(performance.now() - started), controller = new AbortController(), cancelStart = performance.now();
      const pending = getSmartSpellerMatches(words(text), { mode: 'local', lang: 'ru', contextText: text, signal: controller.signal, localLookup: dictionary });
      setTimeout(() => controller.abort(), 50);
      let cancelled = false;
      try { await pending; } catch (error) { cancelled = error.name === 'AbortError'; }
      const cancellationMs = Math.round(performance.now() - cancelStart);
      await new Promise(resolve => setTimeout(resolve, 100)); active = false;
      return { cold, characters: text.length, warmMs, issues: result.issues.length, maxFrameGapMs: Math.round(Math.max(...gaps)), frames: gaps.length, cancelled, cancellationMs };
    });
    let error;
    try {
      assert.ok(evidence.cold.every(item => item.issues > 0 && item.durationMs < 12000));
      assert.ok(evidence.warmMs < 15000, `100k manuscript took ${evidence.warmMs}ms`);
      assert.equal(evidence.issues, 1);
      assert.ok(evidence.frames > 10);
      assert.ok(evidence.maxFrameGapMs < 250, `Main-thread frame gap ${evidence.maxFrameGapMs}ms`);
      assert.ok(evidence.cancelled); assert.ok(evidence.cancellationMs < 500);
    } catch (failure) { error = failure.stack; }
    results.push({ name: `${profile}/language-performance-without-observer`, passed: !error, ...evidence, error });
    console.log(JSON.stringify(results.at(-1))); await context.close();
  }
} finally { await browser?.close(); killOwnedProcess(server); await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2)); }
if (results.some(item => !item.passed)) process.exitCode = 1;
