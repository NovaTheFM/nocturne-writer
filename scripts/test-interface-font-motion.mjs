import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5356, url = `http://localhost:${port}`;
const output = process.env.NOCTURNE_QA_OUTPUT || 'release/qa/interface-font-motion';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
let browser;
const results = [];

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const [mobile, reduced] of [[false, false], [true, false], [false, true], [true, true]]) {
    const name = `${mobile ? 'mobile' : 'desktop'}-${reduced ? 'reduced' : 'animated'}`;
    const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, reducedMotion: reduced && !mobile ? 'reduce' : 'no-preference' });
    const page = await context.newPage();
    const root = mobile ? '#mobile-panel' : '#settings-overlay';
    const select = async (key, value) => {
      await page.locator(`${root} [data-setting-select="${key}"] [data-setting-select-toggle]`).click();
      await page.locator(`${root} [data-setting-option="${key}"][data-value=${JSON.stringify(value)}]`).click();
    };
    const settled = value => page.waitForFunction(value => window.nocturneApp.state.settings.uiFontFamily === value && !window.nocturneApp.interfaceFontTransition && !document.querySelector('.interface-font-transition'), value);
    try {
      await page.goto(url); await page.waitForFunction(() => window.nocturneApp?.interfaceLanguage.confirmed);
      await page.evaluate(async ({ reduced, mobile }) => {
        const a = window.nocturneApp;
        if (mobile) { a.state.settings.reduceMobileAnimations = reduced; a.applySettings(); }
        await a.createDoc(a.defaultFolderId(), 'Font motion', '');
        const editor = a.nocturneEditor.get('primary');
        editor.commands.setContent('<p>Незмінний текст. Unchanged manuscript.</p>');
        editor.commands.setTextSelection(2); editor.commands.insertContent('XYZ');
        window.__motionEditor = editor; window.__motionJson = editor.getJSON(); window.__motionSelection = editor.state.selection.from;
        a.openSettingsTab('editor');
        window.__fontMotion = { changes: [], frames: [], covers: 0 };
        let family = getComputedStyle(document.body).fontFamily;
        const coverState = () => {
          const covers = document.querySelectorAll('.interface-font-transition'), cover = covers[0], style = cover && getComputedStyle(cover);
          return { count: covers.length, opacity: Number(style?.opacity || 0), filter: style?.backdropFilter || '', position: style?.position, width: cover?.getBoundingClientRect().width, height: cover?.getBoundingClientRect().height };
        };
        new MutationObserver(() => {
          const current = getComputedStyle(document.body).fontFamily;
          if (current !== family) { window.__fontMotion.changes.push({ font: current, ...coverState() }); family = current; }
        }).observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });
        const sample = () => {
          const state = coverState();
          window.__fontMotion.covers = Math.max(window.__fontMotion.covers, state.count);
          if (state.count) window.__fontMotion.frames.push({ at: performance.now(), ...state });
          if (!window.__fontMotion.stop) requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { reduced, mobile });
      await select('uiFontFamily', 'Georgia'); await settled('Georgia');
      const first = await page.evaluate(() => window.__fontMotion);
      assert.equal(first.changes.length, 1);
      if (reduced) assert.equal(first.covers, 0, 'Reduced motion must not flash a blurred cover');
      else {
        assert.ok(first.changes[0].opacity >= .98 && /blur\((1[6-9]|[2-9]\d)px\)/.test(first.changes[0].filter), `Font reflow must happen under a fully visible blur: ${JSON.stringify(first.changes)}`);
        assert.ok(first.frames.some(frame => frame.opacity > .05 && frame.opacity < .95), 'Blur must fade, not appear instantly');
        assert.ok(first.frames.some((frame, i) => i && frame.opacity < first.frames[i - 1].opacity - .015), 'Blur must reveal the interface gradually');
        assert.ok(first.frames.every(frame => frame.position === 'fixed' && frame.width === (mobile ? 390 : 1440) && frame.height === (mobile ? 844 : 1000)), 'Cover must include settings and the complete viewport');
        assert.ok(first.frames.at(-1).at - first.frames[0].at < 1400, 'Cached font transition must stay quick');
      }
      await select('uiFontFamily', 'Inter'); await settled('Inter');
      const coverCount = await page.evaluate(() => window.__fontMotion.frames.length);
      await select('uiFontFamily', 'Inter'); await settled('Inter');
      assert.equal(await page.evaluate(() => window.__fontMotion.frames.length), coverCount, 'Selecting the current font must not blur again');
      await select('fontFamily', 'Courier New');
      assert.equal(await page.locator('.interface-font-transition').count(), 0, 'Document font selection must retain its existing behavior');
      await page.evaluate(() => {
        window.__fontLoad = document.fonts.load.bind(document.fonts);
        const gate = new Promise(resolve => { window.__releaseFont = resolve; });
        document.fonts.load = async (...args) => { if (args[0].includes('Manrope')) await gate; return window.__fontLoad(...args); };
      });
      await select('uiFontFamily', 'Manrope');
      assert.ok(await page.evaluate(() => getComputedStyle(document.body).fontFamily.includes('Inter')), 'Keep the current interface while the new family is loading');
      await select('uiFontFamily', 'Georgia');
      await page.evaluate(() => window.__releaseFont()); await settled('Georgia');
      assert.equal(await page.evaluate(() => window.__fontMotion.changes.some(change => change.font.includes('Manrope'))), false, 'A superseded font must never flash on screen');
      await page.evaluate(() => { document.fonts.load = () => Promise.reject(new Error('Font loading failure')); });
      await select('uiFontFamily', 'Lora'); await settled('Lora');
      await page.evaluate(() => { document.fonts.load = window.__fontLoad; });
      const final = await page.evaluate(() => {
        window.__fontMotion.stop = true;
        const a = window.nocturneApp, editor = a.nocturneEditor.get('primary');
        return { same: editor === window.__motionEditor, json: editor.getJSON(), original: window.__motionJson, selection: editor.state.selection.from, originalSelection: window.__motionSelection, inert: document.getElementById('app').inert, bodyFilter: getComputedStyle(document.body).filter, covers: window.__fontMotion.covers, focused: document.activeElement?.closest('[data-setting-select]')?.dataset.settingSelect, changes: window.__fontMotion.changes };
      });
      assert.equal(final.same, true); assert.deepEqual(final.json, final.original); assert.equal(final.selection, final.originalSelection);
      assert.equal(final.inert, false); assert.equal(final.bodyFilter, 'none'); assert.ok(final.covers <= 1); assert.equal(final.focused, 'uiFontFamily');
      if (!reduced) assert.ok(final.changes.every(change => change.opacity >= .98), JSON.stringify(final.changes));
      await page.screenshot({ path: `${output}/${name}.png`, animations: 'disabled' });
      results.push({ name, status: 'PASS', frames: first.frames, changes: final.changes });
      console.log(`PASS ${name}: blur hides reflow, loading/rapid choices/failure clean up, focus and editor survive`);
    } catch (error) {
      await page.screenshot({ path: `${output}/${name}-failure.png` }).catch(() => {});
      results.push({ name, status: 'FAIL', error: error.stack }); throw error;
    } finally { await context.close(); }
  }
} finally { await browser?.close(); server.kill(); await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2)); }
