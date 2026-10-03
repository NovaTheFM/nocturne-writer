import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseline = 'release/qa/pagination-performance/baseline-source';
const servers = [
  spawn(process.execPath, ['server.mjs'], { cwd: baseline, env: { ...process.env, PORT: '5323', SYNC_PORT: '8923' }, stdio: 'ignore', windowsHide: true }),
  spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5324', SYNC_PORT: '8924' }, stdio: 'ignore', windowsHide: true }),
];
const browser = await chromium.launch({ headless: true }), results = [];
const directory = 'release/qa/pagination-appearance'; await mkdir(directory, { recursive: true });
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch('http://localhost:5323')).ok && (await fetch('http://localhost:5324')).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  for (const fixture of [
    { name: 'desktop-pages' },
    { name: 'split-pages', split: true },
    { name: 'indented-pages', indent: true },
    { name: 'mobile-pages', mobile: true },
  ]) {
    const snapshots = [];
    for (const [label, port] of [['before', 5323], ['after', 5324]]) {
      const context = await browser.newContext({ viewport: fixture.mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: !!fixture.mobile, hasTouch: !!fixture.mobile, reducedMotion: 'reduce' });
      const page = await context.newPage();
      try {
        await page.goto(`http://localhost:${port}`); await page.waitForSelector('#preloader.hidden', { state: 'attached' });
        await page.evaluate(async fixture => {
          const a = window.nocturneApp; a.state.settings.automaticBackups = false;
          await a.createDoc(a.defaultFolderId(), 'Тихая глава', '');
          const e = a.nocturneEditor.get('primary');
          e.commands.setContent(`<h2>Тихая глава</h2><p>${'Ночной город слушал дождь, а писатель продолжал историю 🙂. '.repeat(260)}</p><p><strong>Последний абзац.</strong> Конец главы.</p>`);
          await a.saveActiveDoc({ silent: true });
          a.state.settings.autoPaginate = true; a.state.settings.cursorGlow = false;
          a.state.settings.paragraphIndent = !!fixture.indent; a.applySettings();
          if (fixture.split) a.toggleSplitMode();
          await document.fonts.ready;
        }, fixture);
        await page.waitForTimeout(1100);
        if (fixture.indent) assert.ok(await page.evaluate(() => parseFloat(getComputedStyle(window.nocturneApp.nocturneEditor.get('primary').view.dom.querySelector('p')).textIndent) > 0));
        await page.addStyleTag({ content: '* { transition: none !important; caret-color: transparent !important; } #custom-caret, .cursor-light, .toast { visibility: hidden !important; } .editor-scroll-area { scroll-behavior: auto !important; }' });
        const editor = page.locator('.primary-pane .editor-scroll-area'), shots = [], geometry = [];
        for (const location of ['start', 'gap', 'end']) {
          await page.evaluate(location => {
            const instance = window.nocturneApp.nocturneEditor.instances.get('primary');
            const scroll = instance.pageShell.closest('.editor-scroll-area');
            scroll.scrollTop = location === 'start' ? 0 : location === 'gap' ? Math.round(instance.pageShell.getBoundingClientRect().width * 1123 / 794) - 240 : scroll.scrollHeight;
          }, location);
          await page.waitForTimeout(80);
          geometry.push(await page.evaluate(() => {
            const instance = window.nocturneApp.nocturneEditor.instances.get('primary'), shell = instance.pageShell, e = instance.editor;
            const origin = shell.getBoundingClientRect();
            const sheets = [...shell.querySelectorAll('.page-sheet-bg:not(.motion-sheet-exiting)')].map(node => {
              const rect = node.getBoundingClientRect(); return { x: rect.left - origin.left, y: rect.top - origin.top, width: rect.width, height: rect.height };
            });
            const glyphs = [];
            e.state.doc.descendants((node, pos) => { if (!node.isTextblock) return; for (const offset of [0, Math.floor(node.content.size / 2), node.content.size]) { const rect = e.view.coordsAtPos(pos + 1 + offset); glyphs.push({ x: rect.left - origin.left, y: rect.top - origin.top, height: rect.bottom - rect.top }); } return false; });
            return { sheets, glyphs, text: e.getText() };
          }));
          shots.push(await editor.screenshot({ path: `${directory}/${fixture.name}-${location}-${label}.png`, animations: 'disabled' }));
        }
        snapshots.push({ shots, geometry });
      } finally { await context.close(); }
    }
    const sameGeometry = JSON.stringify(snapshots[0].geometry) === JSON.stringify(snapshots[1].geometry);
    const identical = snapshots[0].shots.every((shot, index) => shot.equals(snapshots[1].shots[index]));
    results.push({ name: fixture.name, sameGeometry, identical }); console.log(`${identical && sameGeometry ? 'PASS' : 'FAIL'} ${fixture.name}: PNG ${identical}, geometry ${sameGeometry}`);
  }
} finally { await browser.close(); servers.forEach(server => server.kill()); await writeFile(`${directory}/comparison.json`, JSON.stringify(results, null, 2)); }
assert.ok(results.every(result => result.identical && result.sameGeometry), 'Pagination appearance differs; inspect the saved screenshots.');
