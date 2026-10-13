import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort } from './qa/runner.mjs';
import { runCoreAudit, correctionMatches } from './qa/smart-dictionary-audit-core.mjs';
import { SMART_DICTIONARY_CORPUS, SMART_DICTIONARY_CONTRACT_VERSION, SMART_DICTIONARY_AUDIT_SEED } from './fixtures/smart-dictionary-corpus.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/smart-dictionary-adversarial');
const recording = JSON.parse(await readFile(new URL('./fixtures/smart-dictionary-provider.json', import.meta.url), 'utf8'));
const liveProvider = process.env.NOCTURNE_AUDIT_LANGUAGETOOL_URL || '';
if (liveProvider && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(liveProvider).hostname)) throw new Error('Live stress checks must use a self-hosted local endpoint; automated public LanguageTool calls are prohibited.');
const corpusSha256 = createHash('sha256').update(JSON.stringify(SMART_DICTIONARY_CORPUS)).digest('hex');
assert.equal(recording.corpusSha256, corpusSha256, 'Provider recording and the independent corpus must describe the same frozen inputs');
assert.equal(recording.contractVersion, SMART_DICTIONARY_CONTRACT_VERSION);
assert.equal(recording.fixtures.length, SMART_DICTIONARY_CORPUS.length);
const results = [], started = Date.now();
await mkdir(directory, { recursive: true });
async function record(name, gate, run) {
  const start = Date.now();
  try { const evidence = await run() || {}; results.push({ name, gate, passed: evidence.passed ?? true, durationMs: Date.now() - start, ...evidence }); }
  catch (error) { results.push({ name, gate, passed: false, durationMs: Date.now() - start, error: error.stack }); }
}
const core = await runCoreAudit(recording.fixtures, record);
console.log(`CORE: ${results.filter(result => result.passed).length}/${results.length} scenarios pass; seeded corpus ${corpusSha256}`);
await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));

const port = await availablePort(), url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let browser;
const selectedIds = ['ru-spelling-01', 'ru-spelling-18', 'ru-grammar-04', 'ru-punctuation-01', 'ru-punctuation-10', 'ru-capitalization-01', 'ru-repetition-01', 'uk-spelling-01', 'uk-punctuation-01', 'en-spelling-01', 'en-grammar-01', 'en-grammar-04', 'en-punctuation-01', 'en-capitalization-01', 'en-repetition-01', 'auto-spelling-01', 'auto-spelling-02', 'auto-spelling-03'];
const selected = SMART_DICTIONARY_CORPUS.filter(item => selectedIds.includes(item.id) || selectedIds.slice(0, 4).some(id => item.id === `${id}-clean`));
async function setText(page, text, { lang = 'ru', strict = true, html = null } = {}) {
  await page.evaluate(({ text, lang, strict, html }) => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
    a.state.settings.smartDictionary = false; a.resetSmartSpeller();
    const escaped = text.replace(/[&<>]/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[value]));
    e.commands.setContent(html || `<p>${escaped}</p>`); e.commands.blur();
    a.nocturneEditor.syncDocFromEditor('primary');
    a.state.settings.strictSpellcheck = strict; a.state.settings.smartDictionary = true; a.state.settings.smartDictionaryMode = 'hybrid'; a.state.settings.smartDictionaryLang = lang;
    a.applySettingSideEffects('smartDictionaryMode');
    a.updateTypoHighlights();
  }, { text, lang, strict, html });
}
async function settle(page) { await page.waitForFunction(() => { const a = window.nocturneApp; return !a.spellerTimer && !a.spellerRequest && !a.spellerQueue?.size && !a.spellerPending?.size; }, null, { timeout: 12000 }); }
async function snapshot(page) {
  return page.evaluate(() => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
    return { text: e.getText(), html: e.getHTML(), generation: a.spellerGeneration, matches: a.typoMatchIndex.map(item => ({ ...item, start: item.startOffset, end: item.endOffset, suggestions: item.suggestions || (typeof item.correct === 'string' ? [item.correct] : []) })), requests: window.auditRequests.map(({ signal, ...item }) => ({ ...item, aborted: !!signal?.aborted })), errors: window.auditConsoleErrors };
  });
}
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const profile of ['desktop', 'android'].filter(value => !process.env.NOCTURNE_QA_PLATFORM || process.env.NOCTURNE_QA_PLATFORM === 'all' || process.env.NOCTURNE_QA_PLATFORM === value)) {
    const mobile = profile === 'android', context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(async fixtures => {
      const a = window.nocturneApp; a.state.settings.automaticBackups = false;
      await a.createDoc(a.defaultFolderId(), 'Изолированная проверка Smart-словаря', '');
      window.auditRequests = []; window.auditFault = null; window.auditDelay = 0; window.auditConsoleErrors = []; window.auditDynamic = false; window.auditLiveProvider = '';
      const originalFetch = window.fetch.bind(window), originalError = console.error.bind(console);
      console.error = (...values) => { window.auditConsoleErrors.push(values.map(value => String(value)).join(' ')); originalError(...values); };
      window.fetch = async (endpoint, options) => {
        if (!String(endpoint).includes('api.languagetool.org')) return originalFetch(endpoint, options);
        const params = new URLSearchParams(options.body), text = params.get('text'), language = params.get('language');
        const request = { text, language, time: performance.now(), signal: options.signal }; window.auditRequests.push(request);
        if (window.auditDelay) await new Promise(resolve => setTimeout(resolve, window.auditDelay));
        if (window.auditLiveProvider) {
          const response = await originalFetch(new URL('/v2/check', window.auditLiveProvider), options);
          request.transport = 'live HTTP'; request.status = response.status;
          return response;
        }
        if (window.auditFault) return { ok: false, status: window.auditFault, headers: new Headers({ 'Retry-After': '2' }) };
        if (window.auditDynamic) return { ok: true, json: async () => ({ matches: [...text.matchAll(/adress/giu)].map(match => ({ offset: match.index, length: match[0].length, replacements: [{ value: match[0] === match[0].toUpperCase() ? 'ADDRESS' : 'address' }], rule: { issueType: 'misspelling', category: { id: 'TYPOS', name: 'Spelling' } } })) }) };
        const lang = language === 'auto' ? 'auto' : language.startsWith('ru') ? 'ru' : language.startsWith('uk') ? 'uk' : 'en';
        const fixture = fixtures.find(item => item.lang === lang && item.text === text) || fixtures.find(item => item.lang === 'auto' && item.text === text && item.response.language?.code?.startsWith(lang));
        if (!fixture) throw new Error(`No frozen provider response for ${lang}: ${text}`);
        return { ok: true, json: async () => structuredClone(fixture.response) };
      };
    }, recording.fixtures);
    for (const item of selected) await record(`${profile}/editor/${item.id}`, 'editor-quality', async () => {
      await page.evaluate(() => { window.auditRequests = []; window.auditFault = null; window.auditDelay = 0; window.auditDynamic = false; });
      await setText(page, item.text, { lang: item.lang }); await settle(page);
      const evidence = await snapshot(page);
      assert.equal(evidence.text, item.text, 'Checking must never silently change the manuscript');
      const found = item.expected === 'no-error' ? evidence.matches.length === 0 : correctionMatches(evidence.matches, item.text, item.gold);
      return { passed: found, lang: item.lang, category: item.category, text: item.text, gold: item.gold, matches: evidence.matches, requests: evidence.requests, error: found ? undefined : item.expected === 'no-error' ? 'The editor marks a correct control sentence' : 'Expected issue is missing from the editor highlight/correction index' };
    });
    await record(`${profile}/replacement/missing-comma insertion is offered and undoable`, 'editor-quality', async () => {
      await setText(page, 'Я знаю что он вернётся.'); await settle(page);
      const changed = await page.evaluate(() => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), before = e.getText();
        const match = a.typoMatchIndex.find(item => before.slice(0, item.startOffset) + item.correct + before.slice(item.endOffset) === 'Я знаю, что он вернётся.');
        if (!match) return { offered: false, before };
        const applied = a.applyTypoReplacement(match), after = e.getText(); e.commands.undo(); return { offered: true, applied, before, after, undone: e.getText() };
      });
      assert.ok(changed.offered, 'A comma correction must reach the editor'); assert.ok(changed.applied); assert.equal(changed.after, 'Я знаю, что он вернётся.'); assert.equal(changed.undone, changed.before); return changed;
    });
    await record(`${profile}/replacement/duplicate-word deletion is offered and undoable`, 'editor-quality', async () => {
      await setText(page, 'She opened the the door.', { lang: 'en' }); await settle(page);
      const changed = await page.evaluate(() => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), before = e.getText();
        const match = a.typoMatchIndex.find(item => before.slice(0, item.startOffset) + item.correct + before.slice(item.endOffset) === 'She opened the door.');
        if (!match) return { offered: false, before };
        const applied = a.applyTypoReplacement(match), after = e.getText(); e.commands.undo(); return { offered: true, applied, before, after, undone: e.getText() };
      });
      assert.ok(changed.offered, 'A deletion correction must reach the editor'); assert.ok(changed.applied); assert.equal(changed.after, 'She opened the door.'); assert.equal(changed.undone, changed.before); return changed;
    });
    await record(`${profile}/replacement/split formatting survives a spelling correction and undo`, 'editor-safety', async () => {
      await setText(page, 'I wrote the wrong adress.', { lang: 'en', html: '<p><strong>I wrote</strong> the wrong ad<em>re</em>ss.</p>' }); await settle(page);
      const changed = await page.evaluate(() => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), before = e.getHTML(), match = a.typoMatchIndex.find(item => item.rawText === 'adress');
        const applied = a.applyTypoReplacement(match), after = e.getText(), html = e.getHTML(); e.commands.undo(); return { applied, after, html, before, undone: e.getHTML() };
      });
      assert.ok(changed.applied); assert.equal(changed.after, 'I wrote the wrong address.'); assert.ok(changed.html.includes('<strong>I wrote</strong>')); assert.equal(changed.undone, changed.before); return changed;
    });
    for (const strict of [false, true]) await record(`${profile}/offline/hybrid retains dictionary correction strict=${strict}`, 'editor-reliability', async () => {
      await page.evaluate(() => { window.auditDynamic = true; window.auditFault = 503; });
      const text = `Мы вообщем согласны. Offline marker ${strict ? 'beta' : 'alpha'}.`;
      await setText(page, text, { strict }); await settle(page);
      const evidence = await snapshot(page);
      assert.ok(evidence.requests.some(request => request.text === text), 'The fault must be reached instead of served from a previous successful cache entry');
      const found = correctionMatches(evidence.matches, evidence.text, [text.replace('вообщем', 'в общем')]);
      return { passed: found, strict, matches: evidence.matches, errors: evidence.errors, requests: evidence.requests, error: found ? undefined : 'The local layer loses its correction when an uncached remote request fails' };
    });
    await record(`${profile}/network/429 respects Retry-After instead of repeated requests`, 'editor-reliability', async () => {
      await page.evaluate(() => { window.auditDynamic = true; window.auditFault = 429; window.auditRequests = []; });
      await setText(page, 'Rate limit scenario. The adress is wrong.', { lang: 'en' }); await settle(page);
      await page.evaluate(async () => { for (let i = 0; i < 10; i++) { window.nocturneApp.updateTypoHighlights(); await new Promise(resolve => setTimeout(resolve, 80)); } });
      const evidence = await snapshot(page);
      assert.ok(evidence.requests.length >= 1, 'The rate-limit fault must be reached');
      return { ...evidence, passed: evidence.requests.length <= 1, error: evidence.requests.length > 1 ? `Retry-After=2 was ignored: ${evidence.requests.length} immediate requests` : undefined };
    });
    await record(`${profile}/network/provider failure has visible user feedback`, 'editor-reliability', async () => {
      await page.evaluate(() => { window.auditDynamic = true; window.auditFault = 503; });
      await setText(page, 'Failure feedback scenario. The adress is wrong.', { lang: 'en' }); await settle(page);
      const messages = await page.locator('[role="status"], [role="alert"], .toast, .smart-dictionary-notice.active').allTextContents();
      assert.ok(messages.some(text => /недоступ|не удалось|сбой|повторить.*проверк|проверк.*не выполн|offline|unavailable/iu.test(text)), 'Console-only logging does not tell the writer that checking failed'); return { messages };
    });
    await record(`${profile}/race/50 edits reject obsolete responses and old replacement handles`, 'editor-safety', async () => {
      await page.evaluate(() => { window.auditDynamic = true; window.auditFault = null; window.auditDelay = 400; window.auditRequests = []; });
      await setText(page, 'The adress is wrong.', { lang: 'en' }); await settle(page);
      const old = await page.evaluate(() => window.nocturneApp.typoMatchIndex.find(item => item.rawText === 'adress'));
      await page.evaluate(async () => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
        for (let i = 0; i < 50; i++) { e.commands.setContent(`<p>Revision ${i}. The adress is wrong.</p>`); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary'); a.updateTypoHighlights(); await new Promise(resolve => setTimeout(resolve, i % 5 === 0 ? 270 : 12)); }
        window.auditDelay = 0; e.commands.setContent('<p>Final revision. The adress is wrong.</p>'); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary'); a.updateTypoHighlights();
      });
      await settle(page); await page.waitForTimeout(450);
      const evidence = await snapshot(page), applied = await page.evaluate(match => window.nocturneApp.applyTypoReplacement(match), old);
      assert.equal(applied, false); assert.equal(evidence.text, 'Final revision. The adress is wrong.'); assert.equal(evidence.matches.length, 1); assert.equal(evidence.matches[0].start, evidence.text.indexOf('adress'));
      assert.ok(evidence.requests.some(item => item.aborted), 'At least one in-flight request was cancelled'); return { edits: 50, requests: evidence.requests.length, cancelled: evidence.requests.filter(item => item.aborted).length, matches: evidence.matches };
    });
    await record(`${profile}/safety/whitelisted words remain protected in hybrid mode`, 'editor-safety', async () => {
      await page.evaluate(() => { window.auditDynamic = true; window.auditFault = null; window.auditDelay = 0; window.nocturneApp.state.settings.userLexicon = ['adress']; });
      await setText(page, 'The adress is wrong.', { lang: 'en' }); await settle(page);
      const evidence = await snapshot(page); assert.equal(evidence.matches.length, 0);
      await page.evaluate(() => { window.nocturneApp.state.settings.userLexicon = []; }); return { matches: evidence.matches };
    });
    if (liveProvider) await record(`${profile}/live/real HTTP combines author dictionary and LanguageTool`, 'live-integration', async () => {
      await page.evaluate(async endpoint => {
        const a = window.nocturneApp;
        window.auditLiveProvider = endpoint; window.auditFault = null; window.auditDelay = 0; window.auditRequests = []; window.auditDynamic = false;
        await a.saveTypoRule({ id: 'audit-author-rule', wrong: 'auditlocal', normalizedWrong: 'auditlocal', correct: 'story', source: 'user', matchMode: 'token', label: 'Author audit rule' });
      }, liveProvider);
      await setText(page, 'The auditlocal has the wrong adress.', { lang: 'en' }); await settle(page);
      const evidence = await snapshot(page);
      assert.ok(evidence.requests.some(request => request.transport === 'live HTTP' && request.status === 200), 'The editor must receive a real HTTP response from the pinned LanguageTool server');
      assert.ok(evidence.matches.some(match => match.rawText === 'auditlocal' && match.correct === 'story'));
      assert.ok(evidence.matches.some(match => match.rawText === 'adress' && match.suggestions.includes('address')));
      assert.equal(evidence.text, 'The auditlocal has the wrong adress.');
      await page.evaluate(() => { window.auditLiveProvider = ''; });
      return { requests: evidence.requests, matches: evidence.matches, manuscriptUnchanged: true };
    });
    await record(`${profile}/safety/no uncaught application errors`, 'editor-safety', async () => { assert.deepEqual(pageErrors, []); });
    await page.screenshot({ path: join(directory, `${profile}-audit.png`) });
    await context.close();
    await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
    console.log(`EDITOR ${profile}: ${results.filter(result => result.name.startsWith(profile) && result.passed).length}/${results.filter(result => result.name.startsWith(profile)).length} scenarios pass`);
  }
} finally { await browser?.close(); server.kill(); }

const grouped = group => Object.fromEntries([...new Set(results.map(result => result[group]).filter(Boolean))].map(key => { const values = results.filter(result => result[group] === key); return [key, { passed: values.filter(result => result.passed).length, total: values.length }]; }));
const corpusCases = results.filter(result => result.name.startsWith('corpus/'));
const corrections = corpusCases.filter(result => result.expected === 'correction'), controls = corpusCases.filter(result => result.expected === 'no-error');
const qualityByCategory = Object.fromEntries([...new Set(corrections.map(result => result.category))].map(category => {
  const values = corrections.filter(result => result.category === category);
  return [category, { errors: values.length, providerGoldAvailable: values.filter(result => result.providerFound).length, nocturneGoldAvailable: values.filter(result => result.passed).length, lostProviderCorrections: values.filter(result => result.providerFound && !result.passed).length, localDictionaryGains: values.filter(result => !result.providerFound && result.passed).length }];
}));
const summary = { status: results.every(result => result.passed) ? 'PASS' : 'FAIL', contractVersion: SMART_DICTIONARY_CONTRACT_VERSION, seed: SMART_DICTIONARY_AUDIT_SEED, corpusSha256, corpusSentences: SMART_DICTIONARY_CORPUS.length, generatedOffsetCases: 1000, generatedEditorEdits: 100, total: results.length, passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, durationMs: Date.now() - started, byGate: grouped('gate'), byCategory: grouped('category'), byLanguage: grouped('lang'), provider: { ...core, source: recording.provider, software: recording.software, capturedAt: recording.capturedAt, corpusCorrectionsFound: results.filter(result => result.name.startsWith('corpus/') && result.expected === 'correction' && result.providerFound).length, corpusCorrectionsTotal: SMART_DICTIONARY_CORPUS.filter(item => item.expected === 'correction').length } };
await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
summary.quality = { erroneousSentences: corrections.length, correctControls: controls.length, nocturneGoldAvailable: corrections.filter(result => result.passed).length, lostProviderCorrections: corrections.filter(result => result.providerFound && !result.passed).length, falsePositiveControls: controls.filter(result => !result.passed).length, byCategory: qualityByCategory };
summary.liveIntegration = { selected: Boolean(liveProvider), testedProfiles: results.filter(result => result.gate === 'live-integration').map(result => ({ name: result.name, passed: result.passed })) };
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (summary.failed) process.exitCode = 1;
