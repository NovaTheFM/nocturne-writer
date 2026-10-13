import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort, killOwnedProcess } from './qa/runner.mjs';
import { RUSSIAN_PUNCTUATION_CASES } from './fixtures/russian-punctuation-corpus.mjs';
import { RUSSIAN_GERUND_SINGLE_CASES } from './fixtures/russian-gerund-single-corpus.mjs';
import { anyCorrectionPlan } from './qa/language-quality-contract.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/russian-punctuation-editor');
await mkdir(directory, { recursive: true });
const diagnostic = JSON.parse(await readFile(new URL('./fixtures/russian-punctuation-provider.json', import.meta.url), 'utf8'));
const provider = JSON.parse(await readFile(new URL('./fixtures/russian-rule-provider.json', import.meta.url), 'utf8'));
const corpus = JSON.parse(await readFile(new URL('./fixtures/russian-rule-contract.json', import.meta.url), 'utf8'));
const numericExamples = ['ru-xml-944', 'ru-xml-950'].map(id => ({ ...corpus.cases.find(item => item.id === id), data: provider.responses.find(item => item.id === id).data }));
assert.equal(createHash('sha256').update(JSON.stringify(diagnostic.data)).digest('hex'), diagnostic.sha256);
assert.equal(diagnostic.sha256, 'f2ded62595034aea2be4b7c861cbb7b8595ad64f1680e29bd40f80c57bb6e4b3');
const port = await availablePort(), url = `http://127.0.0.1:${port}`, results = [];
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let browser;
const escape = text => text.replace(/[&<>]/gu, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[value]));
async function record(name, run) {
  try { results.push({ name, passed: true, ...await run() }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
}
async function settle(page) {
  await page.waitForFunction(() => { const a = window.nocturneApp; return a.spellerContextChecked && !a.spellerTimer && !a.spellerRequest && !a.spellerQueue.size; }, null, { timeout: 25000 });
}
async function setText(page, html, mode = 'hybrid') {
  await page.evaluate(({ html, mode }) => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
    a.state.settings.smartDictionary = false; a.resetSmartSpeller(); a.closeContextMenu();
    e.commands.setContent(html); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary');
    a.state.settings.strictSpellcheck = false; a.state.settings.smartDictionary = true;
    a.state.settings.smartDictionaryMode = mode; a.state.settings.smartDictionaryLang = 'ru';
    a.applySettingSideEffects('smartDictionaryMode'); a.updateTypoHighlights();
  }, { html, mode });
  await settle(page);
}
async function snapshot(page) {
  return page.evaluate(() => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), blocks = [];
    e.state.doc.descendants(node => { if (node.type.name === 'paragraph') { blocks.push({ id: node.attrs.blockId, text: node.textContent }); return false; } return true; });
    return { blocks, text: e.getText(), html: e.getHTML(), issues: a.typoMatchIndex.map(issue => ({ ...issue, start: issue.startOffset, end: issue.endOffset })) };
  });
}
async function openAtHighlight(page, target) {
  const point = await page.evaluate(target => {
    const a = window.nocturneApp;
    const match = a.typoMatchIndex.find(issue => issue.startOffset === target.start && issue.endOffset === target.end && issue.blockId === target.blockId);
    const item = a._typoHighlightRangesMap.get(`${match.blockId}:${match.startOffset}:${match.endOffset}`);
    const rect = item.range.getBoundingClientRect(), editable = item.range.startContainer.parentElement.closest('.page-content');
    for (const ratio of [0.5, 0.25, 0.75, 0.1, 0.9]) {
      const x = rect.left + rect.width * ratio, y = rect.top + rect.height / 2;
      if (a.findTypoMatchAtPoint(x, y, editable)?.id === match.id) return { x, y };
    }
    throw new Error('Visible punctuation underline cannot be hit');
  }, target);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  await page.locator('#app-context-menu.active').waitFor();
}
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const profile of ['desktop', 'android'].filter(value => !process.env.NOCTURNE_QA_PLATFORM || process.env.NOCTURNE_QA_PLATFORM === 'all' || process.env.NOCTURNE_QA_PLATFORM === value)) {
    const mobile = profile === 'android', context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(async ({ diagnostic, numericExamples }) => {
      const a = window.nocturneApp; a.state.settings.automaticBackups = false;
      await a.createDoc(a.defaultFolderId(), 'Проверка русской пунктуации', '');
      const original = window.fetch.bind(window);
      window.fetch = async (url, options) => {
        if (!String(url).includes('api.languagetool.org')) return original(url, options);
        const parameters = new URLSearchParams(options.body);
        if (parameters.get('level') !== 'picky') throw new Error('Additional punctuation rules were not enabled');
        const data = parameters.get('text') === diagnostic.parameters.text ? diagnostic.data : numericExamples.find(item => item.text === parameters.get('text'))?.data || { matches: [] };
        return { ok: true, json: async () => structuredClone(data) };
      };
    }, { diagnostic, numericExamples });
    const cases = [...RUSSIAN_PUNCTUATION_CASES, ...RUSSIAN_GERUND_SINGLE_CASES];
    for (let start = 0; start < cases.length; start += 16) {
      const batch = cases.slice(start, start + 16);
      await setText(page, batch.flatMap(item => [item.text, item.gold]).map(text => `<p>${escape(text)}</p>`).join(''));
      const state = await snapshot(page);
      for (const [index, item] of batch.entries()) {
        await record(`${profile}/highlight/${item.id}`, async () => {
          const block = state.blocks[index * 2]; assert.equal(block.text, item.text);
          assert.ok(anyCorrectionPlan(state.issues.filter(issue => issue.blockId === block.id), item.text, [item.gold]), JSON.stringify({ text: item.text, issues: state.issues.filter(issue => issue.blockId === block.id) }));
        });
        await record(`${profile}/clean/${item.id}`, async () => {
          const block = state.blocks[index * 2 + 1]; assert.equal(block.text, item.gold);
          assert.equal(state.issues.filter(issue => issue.blockId === block.id).length, 0);
        });
      }
    }
    const selected = cases.filter((item, index) => index % 12 === 0 || index < 12);
    for (const item of selected) await record(`${profile}/menu-apply-undo/${item.id}`, async () => {
      const split = item.text.indexOf(' ');
      await setText(page, `<p><strong>${escape(item.text.slice(0, split))}</strong>${escape(item.text.slice(split))}</p>`);
      let applied = 0;
      while ((await snapshot(page)).text !== item.gold && applied < 3) {
        const state = await snapshot(page), plan = anyCorrectionPlan(state.issues, state.text, [item.gold]);
        assert.ok(plan?.plan.length);
        const issue = plan.plan[0];
        await openAtHighlight(page, issue);
        const option = page.locator('#app-context-menu [data-typo-suggestion-index]').filter({ hasText: `«${issue.correct}»` }).first();
        if (mobile) await option.tap(); else await option.click();
        await settle(page);
        const after = await snapshot(page);
        assert.equal(after.text, state.text.slice(0, issue.start) + issue.correct + state.text.slice(issue.end));
        assert.ok(after.html.includes('<strong>'));
        const history = await page.evaluate(() => {
          const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
          e.commands.undo();
          const undone = e.getHTML(); e.commands.redo(); const redone = e.getHTML();
          a.nocturneEditor.syncDocFromEditor('primary'); a.updateTypoHighlights();
          return { undone, redone };
        });
        assert.equal(history.undone, state.html); assert.equal(history.redone, after.html);
        await settle(page); applied++;
      }
      assert.equal((await snapshot(page)).text, item.gold);
      return { applied, mode: 'hybrid', mobileTouch: mobile };
    });
    await record(`${profile}/api/diagnostic-without-replacement-is-visible`, async () => {
      await setText(page, `<p>${escape(diagnostic.parameters.text)}</p>`, 'api');
      const state = await snapshot(page), issue = state.issues.find(item => item.message?.includes('запятая'));
      assert.ok(issue); assert.equal(issue.suggestions.length, 0);
      await openAtHighlight(page, issue);
      await page.screenshot({ path: join(directory, `${profile}-comma-diagnostic.png`) });
      const menu = await page.locator('#app-context-menu').textContent();
      const contextIssue = await page.evaluate(() => window.nocturneApp.state.contextMenu.typoMatch);
      assert.ok(menu.includes(issue.message), JSON.stringify({ menu, issue, contextIssue }));
      assert.equal(await page.locator('#app-context-menu [data-typo-suggestion-index]').count(), 0);
    });
    for (const item of numericExamples) await record(`${profile}/api/numeric/${item.id}`, async () => {
      await setText(page, `<p>${escape(item.text)}</p>`, 'api');
      const state = await snapshot(page), plan = anyCorrectionPlan(state.issues, item.text, item.gold);
      assert.ok(plan?.plan.length, JSON.stringify(state));
      await openAtHighlight(page, plan.plan[0]);
      const option = page.locator('#app-context-menu [data-typo-suggestion-index="0"]');
      if (mobile) await option.tap(); else await option.click();
      await settle(page);
      assert.ok(item.gold.includes((await snapshot(page)).text));
    });
    await record(`${profile}/runtime`, async () => assert.deepEqual(errors, []));
    await context.close();
    console.log(`${profile}: ${results.filter(item => item.name.startsWith(profile) && item.passed).length}/${results.filter(item => item.name.startsWith(profile)).length}`);
  }
} finally { await browser?.close(); await killOwnedProcess(server); await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2)); }
const failures = results.filter(item => !item.passed);
for (const item of failures.slice(0, 5)) console.error(item.name, item.error);
console.log(`Russian punctuation editor: ${results.length - failures.length}/${results.length}`);
if (failures.length) process.exitCode = 1;
