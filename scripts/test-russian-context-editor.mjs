import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort, killOwnedProcess } from './qa/runner.mjs';
import { CONTEXT_PUNCTUATION_CASES } from './fixtures/russian-context-punctuation.mjs';
import { CONTEXT_HOLDOUT_CASES } from './fixtures/russian-context-holdout.mjs';
import { USER_PUNCTUATION_TEXT, USER_REQUIRED_CORRECTIONS } from './fixtures/russian-user-punctuation.mjs';
import { USER_EXTRA_CORRECTIONS } from './fixtures/russian-user-extra-corrections.mjs';
import { INFINITIVE_AMBIGUITY_CASES } from './fixtures/russian-infinitive-ambiguity.mjs';
import { anyCorrectionPlan } from './qa/language-quality-contract.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/russian-context-editor');
await mkdir(directory, { recursive: true });
const port = await availablePort(), url = `http://127.0.0.1:${port}`, results = [];
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let browser;
const escape = text => text.replace(/[&<>]/gu, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[value]));
async function record(name, run) {
  try { results.push({ name, passed: true, ...await run() }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
  await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
}
async function settle(page) {
  await page.waitForFunction(() => { const a = window.nocturneApp; return a.spellerContextChecked && !a.spellerTimer && !a.spellerRequest && !a.spellerQueue.size; }, null, { timeout: 25000 });
  await page.evaluate(() => window.nocturneApp.updateTypoHighlights());
}
async function setText(page, html) {
  await page.evaluate(html => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
    a.state.settings.smartDictionary = false; a.resetSmartSpeller(); a.closeContextMenu();
    e.commands.setContent(html); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary');
    a.state.settings.strictSpellcheck = false; a.state.settings.smartDictionary = true;
    a.state.settings.smartDictionaryMode = 'hybrid'; a.state.settings.smartDictionaryLang = 'ru';
    a.applySettingSideEffects('smartDictionaryMode'); a.updateTypoHighlights();
  }, html);
  await settle(page);
}
async function snapshot(page) {
  return page.evaluate(() => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary'), blocks = [];
    e.state.doc.descendants(node => { if (node.type.name === 'paragraph') { blocks.push({ id: node.attrs.blockId, text: node.textContent }); return false; } return true; });
    return { text: e.getText(), html: e.getHTML(), blocks, issues: a.typoMatchIndex.map(issue => ({ ...issue, start: issue.startOffset, end: issue.endOffset })) };
  });
}
async function apply(page, issue, suggestion, mobile, screenshotPath) {
  await page.evaluate(async issue => {
    const a = window.nocturneApp, item = a._typoHighlightRangesMap.get(`${issue.blockId}:${issue.start}:${issue.end}`);
    const area = item.range.startContainer.parentElement.closest('.editor-scroll-area'), rect = item.range.getBoundingClientRect();
    if (area) area.scrollBy({ top: rect.top - area.getBoundingClientRect().top - 160, behavior: 'instant' });
    await new Promise(requestAnimationFrame);
    a.renderTypoSvgOverlays();
  }, issue);
  const point = await page.evaluate(issue => {
    const a = window.nocturneApp, item = a._typoHighlightRangesMap.get(`${issue.blockId}:${issue.start}:${issue.end}`);
    const editable = item.range.startContainer.parentElement.closest('.page-content');
    for (const rect of item.range.getClientRects()) for (const ratio of [0.5, 0.25, 0.75]) {
      const x = rect.left + rect.width * ratio, y = rect.top + rect.height / 2;
      if (a.findTypoMatchAtPoint(x, y, editable)?.id === issue.id) return { x, y };
    }
    throw new Error('Visible underline cannot be hit');
  }, issue);
  const before = await snapshot(page);
  await page.mouse.click(point.x, point.y, { button: 'right' });
  const option = page.locator('#app-context-menu.active [data-typo-suggestion-index]').filter({ hasText: `«${suggestion}»` }).first();
  if (screenshotPath) { await option.waitFor({ state: 'visible' }); await page.screenshot({ path: screenshotPath }); }
  if (mobile) await option.tap(); else await option.click();
  await settle(page);
  const after = await snapshot(page), oldBlock = before.blocks.find(block => block.id === issue.blockId), newBlock = after.blocks.find(block => block.id === issue.blockId);
  assert.equal(newBlock.text, oldBlock.text.slice(0, issue.start) + suggestion + oldBlock.text.slice(issue.end));
  const history = await page.evaluate(() => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
    e.commands.undo(); const undone = e.getHTML(); e.commands.redo(); const redone = e.getHTML();
    a.nocturneEditor.syncDocFromEditor('primary'); a.updateTypoHighlights(); return { undone, redone };
  });
  assert.equal(history.undone, before.html); assert.equal(history.redone, after.html);
  await settle(page);
}
try {
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  const sample = [];
  for (const item of CONTEXT_PUNCTUATION_CASES) if (!sample.some(example => example.family === item.family)) sample.push(item);
  for (const profile of ['desktop', 'android'].filter(value => !process.env.NOCTURNE_QA_PLATFORM || process.env.NOCTURNE_QA_PLATFORM === 'all' || process.env.NOCTURNE_QA_PLATFORM === value)) {
    const mobile = profile === 'android', context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url); await page.waitForSelector('.app-shell.ready');
    await page.evaluate(async () => {
      const a = window.nocturneApp; a.state.settings.automaticBackups = false;
      await a.createDoc(a.defaultFolderId(), 'Контекстная пунктуация', '');
      const original = window.fetch.bind(window);
      window.fetch = async (url, options) => String(url).includes('api.languagetool.org')
        ? { ok: true, json: async () => ({ matches: [] }) } : original(url, options);
    });
    await setText(page, sample.flatMap(item => [item.text, item.gold]).map(text => `<p>${escape(text)}</p>`).join(''));
    const batch = await snapshot(page);
    for (const [index, item] of sample.entries()) {
      await record(`${profile}/highlight/${item.family}`, async () => {
        const block = batch.blocks[index * 2]; assert.equal(block.text, item.text);
        assert.ok(anyCorrectionPlan(batch.issues.filter(issue => issue.blockId === block.id), item.text, [item.gold]));
      });
      await record(`${profile}/clean/${item.family}`, async () => assert.equal(batch.issues.filter(issue => issue.blockId === batch.blocks[index * 2 + 1].id).length, 0));
    }
    for (const item of sample.slice(0, 7)) await record(`${profile}/apply-undo/${item.family}`, async () => {
      const split = item.text.indexOf(' ');
      await setText(page, `<p><strong>${escape(item.text.slice(0, split))}</strong>${escape(item.text.slice(split))}</p>`);
      for (let step = 0; step < 5; step++) {
        const state = await snapshot(page); if (state.text === item.gold) break;
        const plan = anyCorrectionPlan(state.issues, state.text, [item.gold]); assert.ok(plan?.plan.length);
        await apply(page, plan.plan[0], plan.plan[0].correct, mobile);
      }
      const state = await snapshot(page); assert.equal(state.text, item.gold); assert.ok(state.html.includes('<strong>'));
    });
    await setText(page, USER_PUNCTUATION_TEXT.split(/\n+/u).map(text => `<p>${escape(text)}</p>`).join(''));
    console.log(`${profile}: applying user punctuation corrections`);
    await page.screenshot({ path: join(directory, `${profile}-user-before.png`) });
    for (const [index, correction] of [...USER_REQUIRED_CORRECTIONS, ...USER_EXTRA_CORRECTIONS].entries()) await record(`${profile}/user-apply-${index}`, async () => {
      const state = await snapshot(page), anchorText = correction.anchor.toLowerCase();
      const block = state.blocks.find(block => block.text.toLowerCase().includes(anchorText)); assert.ok(block, correction.anchor);
      const anchor = block.text.toLowerCase().indexOf(anchorText), start = anchor + correction.anchor.indexOf(correction.from), end = start + correction.from.length;
      const issue = state.issues.find(issue => issue.blockId === block.id && issue.start >= start && issue.end <= end
        && issue.suggestions.some(value => block.text.slice(start, issue.start) + value + block.text.slice(issue.end, end) === correction.to));
      assert.ok(issue, JSON.stringify({ correction, issues: state.issues.filter(issue => issue.blockId === block.id) }));
      const suggestion = issue.suggestions.find(value => block.text.slice(start, issue.start) + value + block.text.slice(issue.end, end) === correction.to);
      await apply(page, issue, suggestion, mobile);
    });
    await page.screenshot({ path: join(directory, `${profile}-user-after.png`) });
    for (const item of CONTEXT_HOLDOUT_CASES.slice(0, 10)) await record(`${profile}/holdout/${item.id}`, async () => {
      await setText(page, `<p>${escape(item.text)}</p>`); const state = await snapshot(page);
      assert.ok(anyCorrectionPlan(state.issues, item.text, [item.gold]));
    });
    const providerResponses = [], endpoint = process.env.NOCTURNE_AUDIT_LANGUAGETOOL_URL;
    if (endpoint) {
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname));
      await page.exposeFunction('checkModalProvider', async body => {
        const response = await fetch(endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const data = await response.json(); providerResponses.push({ status: response.status, parameters: Object.fromEntries(new URLSearchParams(body)), data });
        return { ok: response.ok, status: response.status, data };
      });
      await page.evaluate(() => {
        const original = window.fetch.bind(window);
        window.fetch = async (url, options) => {
          if (!String(url).includes('api.languagetool.org')) return original(url, options);
          const response = await window.checkModalProvider(options.body);
          return { ok: response.ok, status: response.status, json: async () => response.data };
        };
      });
    }
    const modalCase = INFINITIVE_AMBIGUITY_CASES[0];
    for (const [choice, suggestion] of modalCase.alternatives.entries()) await record(`${profile}/ambiguous-choice-${choice}`, async () => {
      await setText(page, '<h2>Название главы</h2><p><strong>Казнить</strong> нельзя <em>помиловать</em>.</p>');
      const state = await snapshot(page), issue = state.issues.find(item => item.ruleId === 'ambiguous-infinitive-boundary');
      assert.ok(issue); assert.equal(issue.requiresChoice, true); assert.equal(issue.correct, undefined);
      assert.deepEqual(issue.suggestions, modalCase.alternatives);
      assert.ok(!state.issues.some(item => item.ruleId === 'DotOrCase'));
      assert.equal(await page.evaluate(issue => window.nocturneApp.applyTypoReplacement(issue), issue), false);
      await apply(page, issue, suggestion, mobile, choice === 0 ? join(directory, `${profile}-modal-menu.png`) : undefined);
      const after = await snapshot(page);
      assert.match(after.html, /<strong>Казнить(?:[,:])?<\/strong>/u); assert.match(after.html, /<em>помиловать<\/em>/u);
      return { provider: endpoint ? 'live' : 'empty replay' };
    });
    if (endpoint) await record(`${profile}/modal-provider-boundary-evidence`, async () => {
      assert.ok(providerResponses.some(item => item.data.matches.some(match => match.rule.id === 'DotOrCase')));
      assert.ok(providerResponses.every(item => item.status === 200 && item.data.software.version === '6.6'));
      await writeFile(join(directory, `${profile}-modal-provider.json`), JSON.stringify(providerResponses, null, 2));
    });
    await record(`${profile}/runtime`, async () => assert.deepEqual(errors, []));
    await context.close(); console.log(`${profile} context editor completed`);
  }
} finally { await browser?.close(); await killOwnedProcess(server); await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2)); }
const failures = results.filter(item => !item.passed);
for (const item of failures.slice(0, 5)) console.error(item.name, item.error);
console.log(`Context punctuation editor: ${results.length - failures.length}/${results.length}`);
if (failures.length) process.exitCode = 1;
