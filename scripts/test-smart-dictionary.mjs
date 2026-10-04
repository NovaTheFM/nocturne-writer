import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort, killOwnedProcess } from './qa/runner.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/smart-dictionary');
const platform = process.env.NOCTURNE_QA_PLATFORM || 'all';
const port = await availablePort(), url = `http://127.0.0.1:${port}`;
await mkdir(directory, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true, detached: process.platform !== 'win32' });
const results = [];
let browser;
async function check(profile, name, run) {
  const started = Date.now(), mobile = profile === 'android';
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 15; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36' : undefined });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      a.state.settings.automaticBackups = false;
      await a.createDoc(a.defaultFolderId(), 'Smart regression', '');
      a.state.settings.strictSpellcheck = true; a.state.settings.smartDictionary = true;
      const original = window.fetch.bind(window);
      window.smartRequests = [];
      window.fetch = async (url, options) => {
        if (!String(url).includes('api.languagetool.org')) return original(url, options);
        const body = new URLSearchParams(options.body), text = body.get('text'), language = body.get('language');
        window.smartRequests.push({ text, language, signal: options.signal });
        const matches = [...text.matchAll(/вообщем|smartmistype|waitingmistype/gu)].map(match => ({ offset: match.index, length: match[0].length, replacements: [{ value: language === 'en-US' ? 'english' : 'replacement' }], rule: { category: { name: 'Spelling' } } }));
        if (text.includes('waitingmistype') && language === 'ru-RU') await new Promise(resolve => { window.releaseOldSmart = resolve; });
        return { ok: true, json: async () => ({ matches }) };
      };
    });
    await run(page);
    assert.deepEqual(errors, [], 'No uncaught application errors');
    results.push({ name: `${profile}: ${name}`, passed: true, durationMs: Date.now() - started });
  } catch (error) {
    results.push({ name: `${profile}: ${name}`, passed: false, durationMs: Date.now() - started, error: error.stack });
    await page.screenshot({ path: join(directory, `failure-${results.length}.png`) }).catch(() => {});
  } finally {
    console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${results.at(-1).name}${results.at(-1).error ? '\n' + results.at(-1).error : ''}`);
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
    await context.close();
  }
}
try {
  browser = await chromium.launch({ headless: true });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const profile of ['desktop', 'android'].filter(value => platform === 'all' || platform === value)) {
    await check(profile, 'disabled builtin stays disabled in all modes and survives reload', async page => {
      await page.evaluate(async () => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
        await a.saveTypoRule({ id: 'disabled-smart', wrong: 'вообщем', correct: 'в общем', source: 'disabled-builtin', builtinKey: 'вообщем' });
        e.commands.setContent('<p>вообщем smartmistype.</p>'); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary');
      });
      for (const mode of ['local', 'hybrid', 'api']) {
        await page.evaluate(mode => { const a = window.nocturneApp; a.state.settings.smartDictionaryMode = mode; a.applySettingSideEffects('smartDictionaryMode'); }, mode);
        if (mode !== 'local') await page.waitForFunction(() => window.nocturneApp.typoMatchIndex.some(match => match.rawText === 'smartmistype'));
        else await page.waitForFunction(() => window.nocturneApp.spellerCache?.has('smartmistype'));
        assert.equal(await page.evaluate(() => window.nocturneApp.typoMatchIndex.some(match => match.rawText === 'вообщем')), false);
      }
      await page.evaluate(async () => { const a = window.nocturneApp; a.state.settings.smartDictionaryMode = 'local'; await a.persistSettings(); await a.saveActiveDoc({ silent: true }); });
      await page.reload(); await page.waitForSelector('.app-shell.ready');
      await page.evaluate(() => window.nocturneApp.updateTypoHighlights()); await page.waitForTimeout(200);
      assert.equal(await page.evaluate(() => window.nocturneApp.typoMatchIndex.some(match => match.rawText === 'вообщем')), false);
      await page.evaluate(() => window.nocturneApp.deleteTypoRule('disabled-smart'));
      await page.waitForFunction(() => window.nocturneApp.typoMatchIndex.some(match => match.rawText === 'вообщем' && match.correct === 'в общем'));
    });
    await check(profile, 'user replacements and lexicon take priority over online suggestions', async page => {
      await page.evaluate(async () => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
        a.state.settings.smartDictionaryMode = 'api';
        e.commands.setContent('<p>вообщем smartmistype.</p>'); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary'); a.applySettingSideEffects('smartDictionaryMode');
      });
      await page.waitForFunction(() => window.nocturneApp.typoMatchIndex.some(match => match.rawText === 'smartmistype'));
      await page.evaluate(async () => {
        const a = window.nocturneApp;
        await a.saveTypoRule({ id: 'smart-override', wrong: 'вообщем', correct: 'в целом', source: 'override', builtinKey: 'вообщем' });
        a.state.settings.userLexicon = ['smartmistype']; a.updateTypoHighlights();
      });
      assert.deepEqual(await page.evaluate(() => window.nocturneApp.typoMatchIndex.map(match => ({ word: match.rawText, correct: match.correct }))), [{ word: 'вообщем', correct: 'в целом' }]);
      await page.evaluate(() => { window.nocturneApp.state.settings.userLexicon = []; window.nocturneApp.updateTypoHighlights(); });
      await page.waitForFunction(() => window.nocturneApp.typoMatchIndex.some(match => match.rawText === 'smartmistype'));
    });
    await check(profile, 'late answers cannot restore an old language or a disabled Smart mode', async page => {
      await page.evaluate(() => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
        a.state.settings.smartDictionaryMode = 'api'; a.state.settings.smartDictionaryLang = 'ru';
        e.commands.setContent('<p>waitingmistype.</p>'); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary'); a.applySettingSideEffects('smartDictionaryMode');
      });
      await page.waitForFunction(() => typeof window.releaseOldSmart === 'function');
      await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.smartDictionaryLang = 'en'; a.applySettingSideEffects('smartDictionaryLang'); });
      await page.waitForFunction(() => window.nocturneApp.typoMatchIndex.some(match => match.correct === 'english'));
      await page.evaluate(() => window.releaseOldSmart()); await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.nocturneApp.spellerCache.get('waitingmistype')?.correct), 'english');
      assert.equal(await page.evaluate(() => window.smartRequests.find(request => request.language === 'ru-RU').signal.aborted), true);
      await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.smartDictionaryLang = 'ru'; a.applySettingSideEffects('smartDictionaryLang'); });
      await page.waitForFunction(() => window.smartRequests.filter(request => request.language === 'ru-RU').length === 2);
      await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.smartDictionary = false; a.applySettingSideEffects('smartDictionary'); window.releaseOldSmart(); });
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate(() => window.nocturneApp.typoMatchIndex.some(match => match.source === 'smart')), false);
      assert.equal(await page.evaluate(() => window.nocturneApp.spellerCache.size), 0);
    });
    await check(profile, 'long paragraphs and edits receive current context', async page => {
      await page.evaluate(() => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
        a.state.settings.smartDictionaryMode = 'api';
        e.commands.setContent(`<p>${'ordinary text. '.repeat(350)}smartmistype.</p>`); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary'); a.applySettingSideEffects('smartDictionaryMode');
      });
      await page.waitForFunction(() => window.nocturneApp.typoMatchIndex.some(match => match.rawText === 'smartmistype'));
      assert.ok(await page.evaluate(() => window.smartRequests.some(request => request.text.includes('smartmistype'))));
      await page.evaluate(() => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
        e.commands.setContent('<p>A changed smartmistype sentence.</p>'); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary'); a.updateTypoHighlights();
      });
      await page.waitForFunction(() => window.smartRequests.some(request => request.text === 'A changed smartmistype sentence.'));
      await page.waitForFunction(() => window.nocturneApp.typoMatchIndex.some(match => match.rawText === 'smartmistype'));
      assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), 'A changed smartmistype sentence.');
      const lastWord = await page.evaluate(() => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
        const words = Array.from({ length: 55 }, (_, i) => `batchword${String.fromCharCode(97 + Math.floor(i / 26), 97 + i % 26)}`);
        e.commands.setContent(`<p>${words.join(' ')}.</p>`); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary'); a.updateTypoHighlights();
        return words.at(-1);
      });
      await page.waitForFunction(word => window.nocturneApp.spellerCache.has(word), lastWord);
      assert.ok(await page.evaluate(() => window.nocturneApp.spellerCache.size >= 55), 'Queued words beyond the first batch are checked');
    });
    await check(profile, 'a failed online request can be retried without editing the manuscript', async page => {
      await page.evaluate(() => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), original = window.fetch;
        window.smartFailures = 0;
        window.fetch = async (url, options) => {
          if (String(url).includes('api.languagetool.org') && window.smartFailures++ === 0) return { ok: false, status: 503 };
          return original(url, options);
        };
        a.state.settings.smartDictionaryMode = 'api';
        e.commands.setContent('<p>smartmistype.</p>'); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary'); a.applySettingSideEffects('smartDictionaryMode');
      });
      await page.waitForFunction(() => window.smartFailures >= 1 && !window.nocturneApp.spellerRequest);
      await page.evaluate(() => window.nocturneApp.updateTypoHighlights());
      await page.waitForFunction(() => window.nocturneApp.typoMatchIndex.some(match => match.rawText === 'smartmistype'));
      assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), 'smartmistype.');
    });
  }
} finally { await browser?.close(); killOwnedProcess(server); }
if (results.some(result => !result.passed)) process.exitCode = 1;
