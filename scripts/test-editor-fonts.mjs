import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5354, url = `http://localhost:${port}`;
const output = process.env.NOCTURNE_QA_OUTPUT || 'release/qa/editor-fonts';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
let browser;
const results = [];
const fontFile = await readFile('src/assets/fonts/a699af1dea30b799318e.ttf');

try {
  for (let attempt = 0; attempt < 60; attempt++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const executablePath = process.env.NOCTURNE_QA_BROWSER_EXECUTABLE;
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath, ...(/vivaldi\.exe$/i.test(executablePath) ? { args: ['--disable-vivaldi'] } : {}) } : {}) });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    const devtools = await context.newCDPSession(page);
    await devtools.send('DOM.enable'); await devtools.send('CSS.enable');
    try {
      await page.goto(url); await page.waitForFunction(() => window.nocturneApp?.interfaceLanguage.confirmed);
      await page.evaluate(async () => {
        const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Font manuscript', '');
        const editor = a.nocturneEditor.get('primary');
        editor.commands.setContent('<h2>Заголовок рукописи</h2><p>Живий український текст. Русский текст.</p><blockquote><p>Цитата: ніч, світло, ґанок, їжак.</p></blockquote><p>Hamburgefontsiv 0123456789.</p>');
        editor.commands.setTextSelection(editor.state.doc.content.size - 2); editor.commands.insertContent('XYZ');
        window.__fontEditor = editor; window.__fontJson = editor.getJSON();
        a.openSettingsTab('editor');
      });
      const root = mobile ? '#mobile-panel' : '#settings-overlay';
      for (const locale of ['ru', 'uk', 'en']) {
        await page.evaluate(async locale => {
          await window.nocturneApp.interfaceLanguage.change(locale);
          window.nocturneApp.openSettingsTab('editor');
        }, locale);
        for (const font of ['Georgia', 'Courier New', 'Manrope', 'Inter', 'Playfair Display', 'Merriweather', 'Lora']) {
          await page.locator(`${root} [data-setting-select="fontFamily"] [data-setting-select-toggle]`).click();
          await page.locator(`${root} [data-setting-option="fontFamily"][data-value="${font}"]`).click();
          const actual = await page.evaluate(async font => {
            const a = window.nocturneApp;
            await document.fonts.load(`16px "${font}"`); await document.fonts.ready;
            const editor = a.nocturneEditor.get('primary'), text = editor.view.dom.querySelector('p');
            return { setting: a.state.settings.fontFamily, variable: getComputedStyle(document.documentElement).getPropertyValue('--font-editor'), editor: getComputedStyle(editor.view.dom).fontFamily, text: getComputedStyle(text).fontFamily, sameEditor: editor === window.__fontEditor, unchanged: JSON.stringify(editor.getJSON()) === JSON.stringify(window.__fontJson) };
          }, font);
          assert.equal(actual.setting, font, JSON.stringify(actual));
          assert.ok(actual.editor.includes(font) && actual.text.includes(font), `Selecting ${font} must change the visible manuscript font: ${JSON.stringify(actual)}`);
          const { root: documentNode } = await devtools.send('DOM.getDocument');
          for (const selector of ['h2', ':scope > p', 'blockquote p']) {
            const { nodeId: editorNode } = await devtools.send('DOM.querySelector', { nodeId: documentNode.nodeId, selector: '.page-content-prosemirror[data-pane-id="primary"]' });
            const { nodeId } = await devtools.send('DOM.querySelector', { nodeId: editorNode, selector });
            assert.ok(nodeId, `Missing manuscript node: ${selector}`);
            const { fonts } = await devtools.send('CSS.getPlatformFontsForNode', { nodeId });
            assert.ok(fonts.some(actual => actual.familyName.replace(/\s/g, '').toLowerCase().includes(font.replace(/\s/g, '').toLowerCase())), `${font} must render Cyrillic ${selector} glyphs, not just change a CSS name: ${JSON.stringify(fonts)}`);
          }
          assert.equal(actual.sameEditor && actual.unchanged, true);
        }
      }
      await page.locator(`${root} input[type="file"][id="custom-font-uploader"], ${root} input[type="file"][data-settings-id="custom-font-uploader"]`).setInputFiles({ name: 'Uploaded writer.ttf', mimeType: 'font/ttf', buffer: fontFile });
      await page.waitForFunction(() => window.nocturneApp.state.settings.customFonts?.some(font => font.name === 'Uploaded writer'));
      await page.locator(`${root} [data-setting-select="fontFamily"] [data-setting-select-toggle]`).click();
      await page.locator(`${root} [data-setting-option="fontFamily"][data-value="Uploaded writer"]`).click();
      await page.evaluate(() => document.fonts.load('16px "Uploaded writer"'));
      const custom = await page.evaluate(() => ({ font: getComputedStyle(window.nocturneApp.nocturneEditor.get('primary').view.dom.querySelector('p')).fontFamily, loaded: [...document.fonts].some(font => font.family.replaceAll('"', '') === 'Uploaded writer' && font.status === 'loaded') }));
      assert.ok(custom.font.includes('Uploaded writer') && custom.loaded, JSON.stringify(custom));
      await page.evaluate(() => window.nocturneApp.interfaceLanguage.change('uk'));
      assert.ok(await page.evaluate(() => getComputedStyle(window.nocturneApp.nocturneEditor.get('primary').view.dom.querySelector('p')).fontFamily.includes('Uploaded writer')));
      assert.equal(await page.evaluate(() => { const editor = window.nocturneApp.nocturneEditor.get('primary'); editor.commands.undo(); return !editor.getText().includes('XYZ'); }), true);
      await page.reload(); await page.waitForSelector('.app-shell.ready');
      await page.evaluate(() => document.fonts.ready);
      assert.ok(await page.evaluate(() => getComputedStyle(window.nocturneApp.nocturneEditor.get('primary').view.dom.querySelector('p')).fontFamily.includes('Uploaded writer')));
      results.push({ mobile, locales: ['ru', 'uk', 'en'], status: 'PASS' }); console.log(`PASS ${mobile ? 'mobile' : 'desktop'}: seven built-in fonts in three interface languages, Cyrillic headings/paragraphs/quotes, uploaded font, restart and Undo`);
    } catch (error) {
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-failure.png` }).catch(() => {});
      results.push({ mobile, status: 'FAIL', error: error.stack }); throw error;
    } finally { await context.close(); }
  }
} finally { await browser?.close(); server.kill(); await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2)); }
