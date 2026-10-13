import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { availablePort, killOwnedProcess } from './qa/runner.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/dictionary-underline');
await mkdir(directory, { recursive: true });
const port = await availablePort(), url = `http://127.0.0.1:${port}`, results = [];
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let browser;
async function record(name, run) {
  try { results.push({ name, passed: true, ...await run() }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
}
async function setText(page, html, selected, replacement) {
  await page.evaluate(({ html, selected, replacement }) => {
    const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
    a.state.settings.smartDictionary = false; a.resetSmartSpeller(); a.closeContextMenu();
    window.underlineResponse = { selected, replacement };
    e.commands.setContent(html); e.commands.blur(); a.nocturneEditor.syncDocFromEditor('primary');
    a.state.settings.strictSpellcheck = false; a.state.settings.smartDictionary = true;
    a.state.settings.smartDictionaryMode = 'api'; a.state.settings.smartDictionaryLang = 'ru';
    a.applySettingSideEffects('smartDictionaryMode'); a.updateTypoHighlights();
  }, { html, selected, replacement });
  await page.waitForFunction(() => {
    const a = window.nocturneApp;
    return a.spellerContextChecked && !a.spellerTimer && !a.spellerRequest && !a.spellerQueue.size;
  });
  await page.waitForTimeout(300);
}
async function geometry(page) {
  return page.evaluate(() => {
    const a = window.nocturneApp;
    a.updateTypoHighlights();
    const match = a.typoMatchIndex[0];
    if (!match) throw new Error('Provider issue was not displayed');
    const key = `${match.blockId}:${match.startOffset}:${match.endOffset}`;
    const item = a._typoHighlightRangesMap.get(key), block = item.range.startContainer.parentElement.closest('[data-block-id]');
    a.renderTypoSvgOverlays();
    const bounds = rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width });
    const rects = Array.from(item.range.getClientRects()).filter(rect => rect.width && rect.height).map(bounds);
    const svg = document.querySelector(`.typo-svg-overlay[data-key="${CSS.escape(key)}"]`);
    const paths = Array.from(svg.querySelectorAll('.typo-svg-path-base')).map(path => bounds(path.getBoundingClientRect()));
    const editable = block.closest('.page-content');
    const hits = rects.map(rect => {
      for (const ratio of [0.5, 0.25, 0.75]) {
        const x = rect.left + rect.width * ratio, y = (rect.top + rect.bottom) / 2;
        if (a.findTypoMatchAtPoint(x, y, editable)?.id === match.id) return { x, y };
      }
      return null;
    });
    const last = rects.at(-1), right = Math.max(...rects.map(rect => rect.right));
    const gap = last.right + 15 < right
      ? a.findTypoMatchAtPoint(last.right + 15, (last.top + last.bottom) / 2, editable)?.id || null : null;
    return { rects, paths, hits, gap, key, text: a.nocturneEditor.get('primary').getText() };
  });
}
function assertGeometry(state) {
  assert.ok(state.paths.length);
  for (const path of state.paths) {
    const line = state.rects.filter(rect => Math.abs(path.top - rect.bottom) < 4);
    assert.ok(line.length && path.left >= Math.min(...line.map(rect => rect.left)) - 1
      && path.right <= Math.max(...line.map(rect => rect.right)) + 1, JSON.stringify(state));
  }
  for (const rect of state.rects) {
    assert.ok(state.paths.some(path => Math.abs(path.top - rect.bottom) < 4
      && path.left <= rect.left + 1 && path.right >= rect.right - 1), JSON.stringify(state));
  }
    assert.ok(state.hits.every(Boolean), JSON.stringify(state));
  assert.equal(state.gap, null);
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
      await a.createDoc(a.defaultFolderId(), 'Подчёркивание ошибок', '');
      const original = window.fetch.bind(window);
      window.fetch = async (url, options) => {
        if (!String(url).includes('api.languagetool.org')) return original(url, options);
        const text = new URLSearchParams(options.body).get('text'), response = window.underlineResponse;
        const offset = response ? text.indexOf(response.selected) : -1;
        return { ok: true, json: async () => ({ matches: offset >= 0 ? [{ offset, length: response.selected.length,
          replacements: [{ value: response.replacement }], message: 'Проверка геометрии подчёркивания', rule: { issueType: 'grammar' } }] : [] }) };
      };
    });
    const selected = 'очень огромную но трудную работу по проверке длинных замечаний в тексте и рассказал об обнаруженных ошибках, замеченных во время чтения';
    const replacement = selected.replace('огромную но', 'огромную, но');
    const text = `Автор проделал ${selected} рассказа.`;
    await record(`${profile}/wrapped-phrase`, async () => {
      await setText(page, `<p>${text}</p>`, selected, replacement);
      const state = await geometry(page);
      assert.ok(state.paths.length >= 2, JSON.stringify(state)); assertGeometry(state);
      await page.screenshot({ path: join(directory, `${profile}-wrapped.png`) });
      return { fragments: state.paths.length };
    });
    await record(`${profile}/hover-apply-undo`, async () => {
      const state = await geometry(page), point = state.hits[0];
      const before = await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getHTML());
      await page.mouse.move(point.x, point.y);
      assert.ok(await page.locator(`.typo-svg-overlay[data-key="${state.key}"].hovered`).count());
      await page.mouse.click(point.x, point.y, { button: 'right' });
      const option = page.locator('#app-context-menu.active [data-typo-suggestion-index="0"]');
      if (mobile) await option.tap(); else await option.click();
      const history = await page.evaluate(() => {
        const e = window.nocturneApp.nocturneEditor.get('primary'), after = e.getText();
        e.commands.undo(); const undone = e.getHTML(); e.commands.redo();
        return { after, undone, redone: e.getText() };
      });
      assert.equal(history.after, text.replace(selected, replacement)); assert.equal(history.undone, before); assert.equal(history.redone, history.after);
    });
    await record(`${profile}/formatting-resize-and-gap`, async () => {
      const long = 'Начало длинного замечания про несколько строк текста и последнюю короткую строку. Мы проверяем подсветку длинного фрагмента и соседние слова с разным форматированием, чтобы линии не растягивались через пустое место.';
      await setText(page, `<p>Начало <strong>длинного</strong>${long.slice('Начало длинного'.length)}</p>`, long, long + '!');
      for (const width of mobile ? [390, 320, 430, 390] : [1440, 900, 1100, 1440]) {
        await page.setViewportSize({ width, height: mobile ? 844 : 900 });
        await page.waitForTimeout(450);
        const state = await geometry(page);
        assertGeometry(state);
        assert.equal(state.paths.length, new Set(state.rects.map(rect => Math.round(rect.bottom))).size);
      }
      await page.screenshot({ path: join(directory, `${profile}-formatted.png`) });
    });
    await record(`${profile}/single-line`, async () => {
      await setText(page, '<p>Очень огромную работу.</p>', 'огромную', 'большую');
      const state = await geometry(page); assert.equal(state.paths.length, 1); assertGeometry(state);
    });
    await record(`${profile}/runtime`, async () => assert.deepEqual(errors, []));
    await context.close();
  }
} finally { await browser?.close(); await killOwnedProcess(server); await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2)); }
const failures = results.filter(item => !item.passed);
for (const item of failures) console.error(item.name, item.error);
console.log(`Dictionary underline: ${results.length - failures.length}/${results.length}`);
if (failures.length) process.exitCode = 1;
