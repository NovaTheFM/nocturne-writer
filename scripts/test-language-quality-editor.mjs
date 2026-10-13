import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort, killOwnedProcess } from './qa/runner.mjs';
import { LANGUAGE_QUALITY_CASES } from './fixtures/language-quality-corpus.mjs';
import { anyCorrectionPlan } from './qa/language-quality-contract.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/language-quality-editor');
await mkdir(directory, { recursive: true });
const port = await availablePort(), url = `http://127.0.0.1:${port}`, results = [];
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let browser;
const escape = value => value.replace(/[&<>]/gu, letter => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[letter]));
async function record(name, gate, run) {
  const started = Date.now();
  try { const evidence = await run() || {}; results.push({ name, gate, passed: true, durationMs: Date.now() - started, ...evidence }); }
  catch (error) { results.push({ name, gate, passed: false, durationMs: Date.now() - started, error: error.stack }); }
}
async function settle(page) {
  await page.waitForFunction(() => { const a = window.nocturneApp; return a.spellerContextChecked && !a.spellerTimer && !a.spellerRequest && !a.spellerQueue.size; }, null, { timeout: 25000 });
}
async function setText(page, html, lang, strict) {
  await page.evaluate(({ html, lang, strict }) => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
    a.state.settings.smartDictionary = false; a.resetSmartSpeller();
    e.commands.setContent(html); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary');
    a.state.settings.strictSpellcheck = strict; a.state.settings.smartDictionary = true;
    a.state.settings.smartDictionaryMode = 'hybrid'; a.state.settings.smartDictionaryLang = lang;
    a.applySettingSideEffects('smartDictionaryMode'); a.updateTypoHighlights();
  }, { html, lang, strict });
  await settle(page);
}
async function snapshot(page) {
  return page.evaluate(() => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), blocks = [];
    e.state.doc.descendants(node => { if (node.type.name === 'paragraph') { blocks.push({ id: node.attrs.blockId, text: node.textContent }); return false; } return true; });
    return { blocks, text: e.getText(), html: e.getHTML(), issues: a.typoMatchIndex.map(issue => ({ ...issue, start: issue.startOffset, end: issue.endOffset, suggestions: issue.suggestions || [issue.correct] })) };
  });
}
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const profile of ['desktop', 'android'].filter(value => !process.env.NOCTURNE_QA_PLATFORM || process.env.NOCTURNE_QA_PLATFORM === 'all' || process.env.NOCTURNE_QA_PLATFORM === value)) {
    const mobile = profile === 'android', context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(async () => {
      const a = window.nocturneApp; a.state.settings.automaticBackups = false;
      await a.createDoc(a.defaultFolderId(), 'Изолированный языковой стресс-тест', '');
      const original = window.fetch.bind(window);
      window.fetch = async (url, options) => String(url).includes('api.languagetool.org') ? { ok: true, json: async () => ({ matches: [] }) } : original(url, options);
      window.languageFrames = []; let before = performance.now();
      const frame = now => { window.languageFrames.push(now - before); before = now; requestAnimationFrame(frame); }; requestAnimationFrame(frame);
    });
    for (const lang of ['ru', 'uk', 'en']) {
      const cases = LANGUAGE_QUALITY_CASES.filter(item => item.lang === lang);
      for (let start = 0; start < cases.length; start += 20) {
        const batch = cases.slice(start, start + 20), texts = batch.flatMap(item => [item.text, item.gold[0]]);
        await setText(page, texts.map(text => `<p>${escape(text)}</p>`).join(''), lang, start % 40 === 0);
        const state = await snapshot(page);
        for (let index = 0; index < batch.length; index++) {
          const item = batch[index];
          await record(`${profile}/highlight/${item.id}`, 'all-600-in-editor', () => {
            const block = state.blocks[index * 2]; assert.equal(block?.text, item.text);
            const issues = state.issues.filter(issue => issue.blockId === block.id);
            assert.ok(anyCorrectionPlan(issues, block.text, item.gold), JSON.stringify({ text: item.text, issues }));
            return { lang, category: item.category };
          });
          await record(`${profile}/clean/${item.id}`, 'all-600-controls-in-editor', () => {
            const block = state.blocks[index * 2 + 1]; assert.equal(block?.text, item.gold[0]);
            assert.equal(state.issues.filter(issue => issue.blockId === block.id).length, 0, JSON.stringify({ text: block.text, issues: state.issues.filter(issue => issue.blockId === block.id) }));
            return { lang };
          });
        }
      }
      const selected = cases.filter((item, index) => cases.filter(other => other.category === item.category).indexOf(item) < 3 || index % 41 === 0);
      for (const item of selected) await record(`${profile}/apply-undo/${item.id}`, 'correction-history-and-formatting', async () => {
        const split = item.text.indexOf(' '), html = `<p><strong>${escape(item.text.slice(0, split))}</strong>${escape(item.text.slice(split))}</p>`;
        await setText(page, html, lang, false);
        let applied = 0;
        for (let iteration = 0; iteration < 5; iteration++) {
          const state = await snapshot(page);
          if (item.gold.includes(state.text)) break;
          const plan = anyCorrectionPlan(state.issues, state.text, item.gold); assert.ok(plan?.plan.length, JSON.stringify({ text: state.text, issues: state.issues }));
          const issue = plan.plan[0];
          const changed = await page.evaluate(match => {
            const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), before = e.getHTML();
            const accepted = a.applyTypoReplacement(match), text = e.getText(), after = e.getHTML();
            e.commands.undo(); const undone = e.getHTML(); e.commands.redo();
            a.nocturneEditor.syncDocFromEditor('primary'); a.updateTypoHighlights();
            return { before, accepted, text, after, undone, redone: e.getHTML() };
          }, issue);
          assert.ok(changed.accepted); assert.equal(changed.undone, changed.before); assert.equal(changed.redone, changed.after);
          assert.ok(changed.after.includes('<strong>'), 'Neighboring formatting must survive');
          assert.equal(changed.text, state.text.slice(0, issue.start) + issue.correct + state.text.slice(issue.end));
          applied++; await settle(page);
        }
        assert.ok(item.gold.includes((await snapshot(page)).text));
        return { lang, applied };
      });
    }
    await record(`${profile}/exact-dictionary/undo preserves case and formatting`, 'correction-history-and-formatting', async () => {
      await setText(page, '<p><strong>Вообщем</strong> текст.</p>', 'ru', true);
      const result = await page.evaluate(() => {
        const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), before = e.getHTML(), match = a.typoMatchIndex.find(item => item.rawText === 'Вообщем');
        const applied = a.applyTypoReplacement(match), text = e.getText(), after = e.getHTML(); e.commands.undo();
        return { before, applied, text, after, undone: e.getHTML() };
      });
      assert.ok(result.applied); assert.equal(result.text, 'В общем текст.'); assert.equal(result.undone, result.before); assert.ok(result.after.includes('<strong>'));
    });
    await record(`${profile}/ignore/one insertion does not suppress another`, 'author-controls', async () => {
      await setText(page, '<p>Я знаю что он вернётся. Я знаю что она придёт.</p>', 'ru', false);
      const before = await snapshot(page); assert.equal(before.issues.filter(issue => issue.correct === ',').length, 2);
      await page.evaluate(async () => {
        const a = window.nocturneApp, match = a.typoMatchIndex.find(item => item.correct === ',');
        a.state.contextMenu = { typoMatch: match, reviewMode: 'writer', selectedText: '', x: 50, y: 50 };
        a.renderContextMenu(); const button = document.querySelector('[data-action="context-ignore-typo-word"]');
        button.click();
      });
      await page.waitForFunction(() => window.nocturneApp.typoMatchIndex.filter(issue => issue.correct === ',').length === 1);
      const after = await snapshot(page); assert.equal(after.text, before.text); assert.equal(after.issues.filter(issue => issue.correct === ',').length, 1);
    });
    await record(`${profile}/responsive/frame sampling under observation`, 'observed-frames', async () => {
      const gaps = await page.evaluate(() => window.languageFrames);
      assert.ok(gaps.length > 100);
      return { frames: gaps.length, maxFrameGapMs: Math.round(Math.max(...gaps)), pageErrors: errors };
    });
    await record(`${profile}/uncaught-errors`, 'runtime', () => assert.deepEqual(errors, []));
    await page.screenshot({ path: join(directory, `${profile}.png`) });
    await context.close();
    console.log(`${profile}: ${results.filter(item => item.name.startsWith(profile) && item.passed).length}/${results.filter(item => item.name.startsWith(profile)).length}`);
  }
} finally {
  await browser?.close(); killOwnedProcess(server);
  await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
}
const failed = results.filter(item => !item.passed);
for (const item of failed.slice(0, 10)) console.error(item.name, item.error);
console.log(`Editor language quality: ${results.length - failed.length}/${results.length}`);
if (failed.length) process.exitCode = 1;
