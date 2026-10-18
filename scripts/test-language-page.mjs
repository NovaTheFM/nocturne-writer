import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5353, url = `http://localhost:${port}`;
const output = process.env.NOCTURNE_QA_OUTPUT || 'release/qa/language-page';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
let browser;
const results = [];

async function inspectPage(page) {
  return page.evaluate(() => {
    const a = window.nocturneApp, instance = a.nocturneEditor.instances.get('primary');
    const paper = a.state.settings.autoPaginate ? instance.pageShell.querySelector('.page-sheet-bg:not(.motion-sheet-exiting)') : instance.pageShell;
    const style = paper && getComputedStyle(paper), bounds = paper?.getBoundingClientRect();
    return {
      classes: [...document.getElementById('app-shell').classList].sort(),
      connected: instance.editor.view.dom.isConnected && instance.pageShell.isConnected,
      sameEditor: instance.editor === window.__pageLanguageEditor,
      json: instance.editor.getJSON(), selection: instance.editor.state.selection.from,
      paper: paper ? { background: style.backgroundColor, border: style.borderTopWidth, width: bounds.width, height: bounds.height, opacity: Number(style.opacity) } : null,
    };
  });
}

try {
  for (let attempt = 0; attempt < 60; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const [mobile, paginate, theme] of [[false, false, 'nocturne'], [false, true, 'paper'], [true, false, 'lavender'], [true, true, 'nocturne']]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    const name = `${mobile ? 'mobile' : 'desktop'}-${paginate ? 'paginated' : 'flexible'}-${theme}`;
    try {
      await page.goto(url);
      await page.waitForFunction(() => window.nocturneApp?.interfaceLanguage.confirmed);
      await page.evaluate(async ({ paginate, theme }) => {
        const a = window.nocturneApp;
        Object.assign(a.state.settings, { autoPaginate: paginate, theme, compactPanels: true, paragraphIndent: true, showPageRulers: true, baselineGrid: true });
        a.applySettings();
        await a.createDoc(a.defaultFolderId(), 'Keep my page', 'Author description');
        const editor = a.nocturneEditor.get('primary');
        editor.commands.setContent('<p>Авторський текст. English. Русский.</p>');
        editor.commands.setTextSelection(2); editor.commands.insertContent('XYZ');
        window.__pageLanguageEditor = editor;
        await document.fonts.ready;
        a.nocturneEditor.flushVisualPages('primary');
      }, { paginate, theme });
      await page.waitForFunction(() => !window.nocturneApp.nocturneEditor.instances.get('primary').pageShell.getAnimations({ subtree: true }).some(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime)));
      const before = await inspectPage(page);
      assert.ok(before.paper && before.paper.background !== 'rgba(0, 0, 0, 0)' && before.paper.opacity > .99, JSON.stringify(before.paper));
      for (const locale of ['uk', 'en', 'ru']) {
        await page.evaluate(() => window.nocturneApp.openSettingsTab('visual'));
        const root = mobile ? '#mobile-panel' : '#settings-overlay';
        await page.locator(`${root} [data-setting-select="interfaceLanguage"] [data-setting-select-toggle]`).click();
        await page.locator(`${root} [data-setting-option="interfaceLanguage"][data-value="${locale}"]`).click();
        await page.waitForFunction(locale => document.documentElement.lang === locale && !window.nocturneApp.interfaceLanguage.busy, locale);
        const after = await inspectPage(page);
        assert.deepEqual(after.classes, before.classes, `${name}/${locale}: applied shell settings disappeared`);
        assert.equal(after.connected && after.sameEditor, true, `${name}/${locale}: editor DOM was replaced or detached`);
        assert.deepEqual(after.json, before.json); assert.equal(after.selection, before.selection);
        assert.deepEqual(after.paper, before.paper, `${name}/${locale}: visible paper changed or disappeared`);
        await page.keyboard.press('Escape');
      }
      const undo = await page.evaluate(() => { const editor = window.nocturneApp.nocturneEditor.get('primary'); editor.commands.undo(); return !editor.getText().includes('XYZ'); });
      assert.equal(undo, true, 'Language changes must preserve Undo');
      await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' });
      results.push({ name, status: 'PASS' }); console.log(`PASS ${name}: visible paper, shell appearance, editor, selection and Undo survive three language changes`);
    } catch (error) {
      await page.screenshot({ path: `${output}/${name}-failure.png`, fullPage: true }).catch(() => {});
      results.push({ name, status: 'FAIL', error: error.stack });
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser?.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
