import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5355, url = `http://localhost:${port}`;
const output = process.env.NOCTURNE_QA_OUTPUT || 'release/qa/interface-fonts';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const fontFile = await readFile('src/assets/fonts/a699af1dea30b799318e.ttf');
const customName = "Writer's UI";
let browser;
const results = [];

async function appearance(page) {
  return page.evaluate(() => {
    const a = window.nocturneApp, editor = a.nocturneEditor.get('primary');
    const family = selector => { const node = document.querySelector(selector); return node && getComputedStyle(node).fontFamily; };
    return {
      ui: a.state.settings.uiFontFamily, document: a.state.settings.fontFamily,
      body: family('body'), brand: family('.brand'), heading: family('.settings-header h2, .mobile-settings-content .mobile-panel-title'),
      notes: family('#notes-input'), preloader: family('.preloader-brand'),
      text: getComputedStyle(editor.view.dom.querySelector('p')).fontFamily,
      json: editor.getJSON(), selection: editor.state.selection.from, sameEditor: editor === window.__separateFontEditor,
      icon: family('.bx'),
    };
  });
}

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile });
    const page = await context.newPage();
    const root = mobile ? '#mobile-panel' : '#settings-overlay';
    const choose = async (key, value) => {
      await page.locator(`${root} [data-setting-select="${key}"] [data-setting-select-toggle]`).click();
      await page.locator(`${root} [data-setting-option="${key}"][data-value=${JSON.stringify(value)}]`).click();
      if (key === 'uiFontFamily') await page.waitForFunction(value => window.nocturneApp.state.settings.uiFontFamily === value && !window.nocturneApp.interfaceFontTransition, value);
      await page.evaluate(async value => { if (value) await document.fonts.load(`16px ${JSON.stringify(value)}`); await document.fonts.ready; }, value);
    };
    try {
      await page.goto(url); await page.waitForFunction(() => window.nocturneApp?.interfaceLanguage.confirmed);
      await page.evaluate(async () => {
        const a = window.nocturneApp;
        a.state.settings.fontFamily = 'Courier New'; delete a.state.settings.uiFontFamily;
        await a.persistSettings();
        await a.createDoc(a.defaultFolderId(), 'Independent fonts', '');
        const editor = a.nocturneEditor.get('primary');
        editor.commands.setContent('<h2>Авторський заголовок</h2><p>Текст рукописи. English text.</p>');
        await a.saveActiveDoc({ silent: true });
      });
      await page.reload(); await page.waitForSelector('.app-shell.ready');
      await page.evaluate(async () => {
        const a = window.nocturneApp, editor = a.nocturneEditor.get('primary');
        editor.commands.setTextSelection(2); editor.commands.insertContent('XYZ');
        await a.saveActiveDoc({ silent: true });
        window.__separateFontEditor = editor; a.openSettingsTab('editor');
      });
      assert.equal(await page.locator(`${root} [data-setting-select="uiFontFamily"]`).count(), 1, 'Interface and manuscript need independent font controls');
      const initial = await appearance(page);
      assert.equal(initial.ui, ''); assert.ok(initial.body.includes('Manrope') && initial.brand.includes('Lora') && initial.text.includes('Courier New'), JSON.stringify(initial));
      for (const [locale, font] of [['ru', 'Georgia'], ['uk', 'Inter'], ['en', 'Courier New']]) {
        await page.evaluate(locale => window.nocturneApp.interfaceLanguage.change(locale), locale);
        await choose('uiFontFamily', font);
        const current = await appearance(page);
        for (const key of ['body', 'brand', 'notes', 'preloader']) assert.ok(current[key]?.includes(font), `${locale}/${key} must use ${font}: ${JSON.stringify(current)}`);
        assert.ok(current.text.includes('Courier New')); assert.equal(current.document, 'Courier New');
        assert.deepEqual(current.json, initial.json); assert.equal(current.selection, initial.selection); assert.equal(current.sameEditor, true);
        assert.ok(current.icon.toLowerCase().includes('boxicons'), `Icon font must stay intact: ${current.icon}`);
        const bounds = await page.locator(`${root} [data-setting-select="uiFontFamily"]`).boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= (mobile ? 390 : 1440) + 1, JSON.stringify(bounds));
      }
      await choose('fontFamily', 'Lora');
      assert.ok((await appearance(page)).body.includes('Courier New'));
      assert.ok((await appearance(page)).text.includes('Lora'));
      assert.equal(await page.evaluate(() => { const editor = window.nocturneApp.nocturneEditor.get('primary'); editor.commands.undo(); const removed = !editor.getText().includes('XYZ'); editor.commands.redo(); return removed && editor.getText().includes('XYZ'); }), true, 'Font choices must preserve Undo/Redo');
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-courier-interface.png`, animations: 'disabled' });
      if (mobile) await page.evaluate(() => window.nocturneApp.switchMobileTab('write'));
      else await page.keyboard.press('Escape');
      await page.waitForFunction(selector => {
        const overlay = document.querySelector(selector);
        const style = getComputedStyle(overlay);
        return !overlay.classList.contains('active') && !overlay.classList.contains('motion-exiting') && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < .01);
      }, mobile ? '#mobile-overlay' : root);
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-separate-fonts.png`, animations: 'disabled' });
      await page.evaluate(() => window.nocturneApp.openSettingsTab('search'));
      await page.locator(`${root} #settings-search-field, ${root} [data-settings-id="settings-search-field"]`).fill('Interface font');
      await page.locator(`${root} [data-setting-select="uiFontFamily"] [data-setting-select-toggle]`).press('Enter');
      await page.locator(`${root} [data-setting-option="uiFontFamily"][data-value="Manrope"]`).press('Enter');
      await page.waitForFunction(() => window.nocturneApp.state.settings.uiFontFamily === 'Manrope' && !window.nocturneApp.interfaceFontTransition);
      assert.ok((await appearance(page)).body.includes('Manrope') && (await appearance(page)).text.includes('Lora'));
      await page.evaluate(() => window.nocturneApp.openSettingsTab('editor'));
      await page.locator(`${root} input[type="file"][id="custom-font-uploader"], ${root} input[type="file"][data-settings-id="custom-font-uploader"]`).setInputFiles({ name: `${customName}.ttf`, mimeType: 'font/ttf', buffer: fontFile });
      await page.waitForFunction(name => window.nocturneApp.state.settings.customFonts?.some(font => font.name === name), customName);
      await choose('uiFontFamily', customName);
      let custom = await appearance(page);
      assert.ok(custom.body.includes(customName) && custom.brand.includes(customName) && custom.text.includes('Lora'), JSON.stringify(custom));
      await page.reload(); await page.waitForSelector('.app-shell.ready');
      await page.evaluate(() => { const a = window.nocturneApp; window.__separateFontEditor = a.nocturneEditor.get('primary'); a.openSettingsTab('editor'); });
      custom = await appearance(page);
      assert.equal(custom.ui, customName); assert.ok(custom.body.includes(customName)); assert.ok(custom.text.includes('Lora'));
      await choose('fontFamily', customName);
      assert.ok((await appearance(page)).text.includes(customName));
      await page.locator(`${root} [data-action="delete-custom-font"]`).click();
      const deleted = await appearance(page);
      assert.equal(deleted.ui, ''); assert.equal(deleted.document, 'Lora');
      assert.ok(deleted.body.includes('Manrope') && deleted.brand.includes('Lora') && deleted.text.includes('Lora'), JSON.stringify(deleted));
      assert.deepEqual(deleted.json, initial.json);
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-font-settings.png`, animations: 'disabled' });
      results.push({ mobile, status: 'PASS' }); console.log(`PASS ${mobile ? 'mobile' : 'desktop'}: independent UI/manuscript fonts, legacy profile, three locales, custom font, restart, deletion and layout`);
    } catch (error) {
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-failure.png`, fullPage: true }).catch(() => {});
      results.push({ mobile, status: 'FAIL', error: error.stack }); throw error;
    } finally { await context.close(); }
  }
} finally { await browser?.close(); server.kill(); await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2)); }
