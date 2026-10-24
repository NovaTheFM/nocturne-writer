import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = process.env.NOCTURNE_QA_DIR || 'release/qa/luna-docking';
await mkdir(output, { recursive: true });
const port = 5361, url = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const results = [];
let browser;
const windows = [
  ['document', 'create-form', '#doc-form', async a => a.openDocForm(a.defaultFolderId())],
  ['notes', 'notes', '#notes-panel.open', a => document.getElementById('notes-panel').classList.add('open')],
  ['all-notes', 'floating', '.floating-notes-modal-panel', a => { a.state.floatingNotesManagerOpen = true; a.renderFloatingNotesModal(); }],
  ['knowledge', 'kb', '#kb-modal.active', a => a.openKb('characters')],
  ['commands', 'commands', '.command-palette-panel', a => a.commandPalette.open({ focusInput: false })],
  ['history', 'history', '.history-modal', a => a.showHistory()],
  ['search', 'project-search', '.global-search-modal', a => a.openGlobalSearchWindow()],
  ['book', 'book', '.book-export-modal', a => a.openBookExport()],
  ['backups', 'backups', '.backups-modal', a => a.openBackups()],
  ['trash', 'trash', '.trash-manager', a => a.openTrash()],
  ['settings', 'settings', '.settings-modal', a => a.openSettingsTab('visual')],
];

try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true, channel: 'chrome', args: ['--enable-webgl', '--renderer-process-limit=1'] });
  const probe = await browser.newPage();
  const renderer = await probe.evaluate(() => { const gl = document.createElement('canvas').getContext('webgl'), debug = gl?.getExtension('WEBGL_debug_renderer_info'), value = debug && gl.getParameter(debug.UNMASKED_RENDERER_WEBGL); gl?.getExtension('WEBGL_lose_context')?.loseContext(); return value; });
  await probe.close(); assert.ok(renderer && !/swiftshader|software|llvmpipe|basic render/i.test(renderer));
  await writeFile(`${output}/graphics.json`, JSON.stringify({ renderer }));
  for (const width of [1180, 1440, 1920]) {
    if (process.env.NOCTURNE_DOCK_WIDTH && width !== Number(process.env.NOCTURNE_DOCK_WIDTH)) continue;
    const context = await browser.newContext({ viewport: { width, height: 1000 } }), page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000); page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(url); await page.locator('[data-confirm-language]').click();
      await page.locator('#luna-tutorial [data-luna-rig-ready="true"]').waitFor();
      await page.waitForFunction(() => !window.nocturneApp.lunaTutorial.changing);
      await page.evaluate(async () => { const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Docking practice'); await a.lunaTutorial.show('write'); });
      for (const [name, step, selector, open] of windows) {
        if (process.env.NOCTURNE_DOCK_CASE && !process.env.NOCTURNE_DOCK_CASE.split(',').includes(name)) continue;
        try {
          await page.evaluate(() => window.nocturneApp.lunaTutorial.cleanupPreview());
          await page.waitForTimeout(420);
          await page.evaluate(selector => {
            window.__dockFrames = [];
            const until = performance.now() + 6500;
            const sample = () => {
              const panel = document.querySelector(selector);
              if (panel?.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) {
                const rect = panel.getBoundingClientRect();
                window.__dockFrames.push({ x: rect.x, y: rect.y, width: rect.width, phase: panel.dataset.lunaDock });
              }
              if (performance.now() < until) window.__dockSampler = requestAnimationFrame(sample);
            }; sample();
          }, selector);
          await page.evaluate(`(async () => { const a=window.nocturneApp; await (${open.toString()})(a); if(a.lunaTutorial.step!==${JSON.stringify(step)}) await a.lunaTutorial.show(${JSON.stringify(step)}); })()`);
          await page.waitForFunction(() => !window.nocturneApp.lunaTutorial.changing && !document.querySelector('.luna-companion').getAnimations().some(animation => animation.playState === 'running'));
          await page.locator(selector).waitFor();
          if (name !== 'notes') await page.waitForFunction(selector => document.querySelector(selector)?.dataset.lunaDock === 'settled', selector);
          await page.waitForTimeout(80);
          const geometry = await page.evaluate(selector => {
            const panel = document.querySelector(selector), p = panel.getBoundingClientRect(), c = document.querySelector('.luna-companion').getBoundingClientRect();
            return { panel: p.toJSON(), coach: c.toJSON(), width: innerWidth, height: innerHeight, overflow: panel.scrollWidth - panel.clientWidth, stacked: document.body.classList.contains('luna-stack-modal') };
          }, selector);
          await page.screenshot({ path: `${output}/${width}-${name}.png` });
          assert.ok(geometry.panel.left >= geometry.coach.right + 20, `The window rests to Luna’s right: ${JSON.stringify(geometry)}`);
          assert.ok(Math.min(geometry.panel.bottom, geometry.coach.bottom) - Math.max(geometry.panel.top, geometry.coach.top) > 80, 'The window stays beside Luna');
          assert.ok(geometry.panel.right <= width - (name === 'notes' ? 0 : 14) && geometry.panel.top >= 10 && geometry.panel.bottom <= (name === 'notes' ? 1000 : 990));
          assert.ok(geometry.overflow <= 2, `Panel content has no horizontal clipping: ${JSON.stringify(geometry)}`);
          assert.equal(geometry.stacked, false);
          const frames = await page.evaluate(() => { cancelAnimationFrame(window.__dockSampler); return window.__dockFrames; });
          await writeFile(`${output}/${width}-${name}-motion.json`, JSON.stringify(frames));
          if (!['notes', 'history'].includes(name)) {
            const opening = frames.filter(frame => frame.phase === 'opening').at(-1);
            assert.ok(opening, 'The ordinary opening position is actually visible');
            assert.ok(Math.abs(opening.x + opening.width / 2 - width / 2) < 3, 'The window first appears at its normal horizontal center');
            assert.ok(geometry.panel.left - opening.x > (width >= 1900 ? 20 : 60), 'The window moves right after appearing');
            const intermediate = frames.filter(frame => frame.phase === 'moving' && frame.x > opening.x + 5 && frame.x < geometry.panel.left - 5);
            assert.ok(intermediate.length >= 4, 'The glide has several visible intermediate positions');
            assert.ok(intermediate.every(frame => Math.abs(frame.y - geometry.panel.y) < 3), 'The glide remains horizontal');
            const moving = frames.filter(frame => frame.phase === 'moving');
            assert.ok(moving.every(frame => frame.x <= geometry.panel.left + 2 && frame.x >= opening.x - 2), 'The glide never overshoots its destination');
            assert.ok(moving.every((frame, i) => i === 0 || frame.x >= moving[i - 1].x - 2), 'The glide never reverses direction');
          }
          results.push({ name: `${width}: ${name}`, status: 'PASS' }); console.log(`PASS ${width}: ${name}`);
          if (name === 'settings') {
            await page.evaluate(async () => { const a = window.nocturneApp; a.openSettingsTab('macros'); await a.lunaTutorial.show('macros'); });
            assert.ok(await page.locator('.settings-modal').evaluate(panel => panel.dataset.lunaDock === 'settled' && panel.getBoundingClientRect().left >= document.querySelector('.luna-companion').getBoundingClientRect().right + 20), 'Updating a settings tab preserves its resting position');
          }
        } catch (error) {
          results.push({ name: `${width}: ${name}`, status: 'FAIL', error: error.stack }); console.error(`FAIL ${width}: ${name}: ${error.message}`);
        }
      }
      assert.deepEqual(errors, []);
      await page.keyboard.press('Escape'); await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      assert.equal(await page.locator('body.luna-dock-surfaces').count(), 0);
    } finally { await context.close(); }
  }
} finally {
  await browser?.close(); server.kill(); await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
