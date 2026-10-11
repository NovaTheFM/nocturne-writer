import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { FRAME_CAMERA_ARGS, FrameCamera } from './qa/frame-camera.mjs';

const port = 5339;
const output = process.env.NOCTURNE_QA_DIR || 'release/qa/motion-corrections';
const phase = process.env.NOCTURNE_VISUAL_PHASE || 'after';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const browser = await chromium.launch({ args: FRAME_CAMERA_ARGS });
const results = [], evidence = [];
const configurations = [
  { id: 'desktop-dark', width: 1280, height: 900, theme: 'nocturne', video: true },
  { id: 'desktop-light', width: 1280, height: 900, theme: 'paper' },
  { id: 'mobile-dark', width: 390, height: 844, theme: 'nocturne', mobile: true, video: true },
  { id: 'mobile-light', width: 390, height: 844, theme: 'paper', mobile: true },
  { id: 'desktop-short', width: 1280, height: 600, theme: 'nocturne' },
];
const check = (config, name, ok, detail) => results.push({ name: `${config.id}: ${name}`, ok: !!ok, detail });
const ghostInspection = () => ({ ghosts: [...document.querySelectorAll('.surface-exit-ghost')].map(node => { const r = node.getBoundingClientRect(); return { y: Math.round(r.top), x: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), opacity: Number(getComputedStyle(node).opacity) }; }) });
async function reset(page, camera) {
  await page.evaluate(() => {
    const a = window.nocturneApp; a.closeSettingsSelects(); a.closeAllFloatingMenus(); a.closeSearchDock();
    for (const id of ['form-overlay', 'settings-overlay', 'kb-modal', 'floating-notes-modal', 'whats-new-overlay']) {
      const node = document.getElementById(id); if (!node) continue;
      clearTimeout(node.__motionCloseTimer); node.__motionGeneration = (node.__motionGeneration || 0) + 1;
      node.classList.remove('active', 'motion-exiting'); node.removeAttribute('aria-hidden');
    }
    document.getElementById('notes-panel')?.classList.remove('open');
    a.state.floatingNotesManagerOpen = false; a.macroRecordingState = false;
    if (a.isMobileLayout()) a.closeMobileToEditor();
    document.activeElement?.blur();
  });
  await camera.settle();
}
async function record(page, camera, config, name, options) {
  const result = await camera.record(`${config.id}-${name}`, { ...options, video: !!config.video });
  if (result.video) evidence.push({ config: config.id, name, video: result.video, fps: result.fps, frames: result.frames, seconds: result.seconds });
  return result.observations;
}
try {
  for (let attempt = 0; attempt < 80; attempt++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const config of configurations) {
    const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, isMobile: !!config.mobile, hasTouch: !!config.mobile });
    const page = await context.newPage(); const camera = new FrameCamera(page, output); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await camera.start(); await page.goto(`http://localhost:${port}`);
      await page.waitForFunction(() => window.nocturneApp?.backups && document.querySelector('.app-shell.ready') && getComputedStyle(document.getElementById('preloader')).visibility === 'hidden', null, { polling: 50 });
      await page.evaluate(async config => {
        const a = window.nocturneApp; a.state.settings.theme = config.theme; a.applySettings();
        a.state.settings.customInputRules = [{ trigger: '->', action: 'center', enabled: true }, { trigger: '...', action: 'separator', enabled: false }, { trigger: '--', action: 'custom-text', customText: '—', enabled: true }];
        a.state.settings.macros = [{ keys: 'Ctrl+Shift+1', value: '✦ ✦ ✦' }, { keys: 'Ctrl+Shift+2', value: '—' }, { keys: 'Ctrl+Shift+3', value: '« »' }];
        a.state.typoRules = [{ id: 'motion-rule-one', source: 'user', wrong: 'ашибка', correct: 'ошибка', label: 'Моё правило' }, { id: 'motion-rule-two', source: 'user', wrong: 'слофо', correct: 'слово', label: 'Моё правило' }];
        await a.createDoc(a.defaultFolderId(), 'Ночной город', '');
        a.nocturneEditor.get('primary').commands.setContent('<h2>Первая встреча</h2><p>Анна пришла в тихий город. Вечерний свет отражался в окнах. На площади её ждали друзья, с которыми она собиралась отправиться к реке.</p><p>Она остановилась у старого моста и перечитала письмо. Эта встреча должна была изменить всё.</p>');
        a.getFocusedDoc().notes = '- [ ] Проверить финал\n- [x] Сохранить первую сцену' + (config.id === 'desktop-short' ? '\n' + Array.from({ length: 40 }, (_, i) => `- [ ] Задача ${i + 1}`).join('\n') : '');
        a.state.floatingNotes = ['Первая заметка', 'Вторая заметка', 'Третья заметка', 'Четвёртая заметка'].map((title, index) => a.sanitizeFloatingNote({ id: `motion-floating-${index}`, title, body: 'Заметка о следующей сцене.', scope: 'global', hidden: true, createdAt: Date.now(), updatedAt: Date.now() - index }));
        await a.saveActiveDoc({ silent: true });
      }, config);
      await camera.pause(); await camera.settle();
      await page.evaluate(() => window.nocturneApp.openSettingsTab('dictionary')); await camera.settle();
      const filters = await record(page, camera, config, 'dictionary-filter', { frames: 150, events: [{ frame: 18, action: () => camera.click('[data-dictionary-filter="mine"]') }, { frame: 90, action: () => camera.click('[data-dictionary-filter="all"]') }], inspect: ghostInspection });
      const maxOverlap = Math.max(0, ...filters.map(sample => { const groups = new Map(); for (const ghost of sample.ghosts) { const key = `${ghost.x}:${ghost.y}:${ghost.width}:${ghost.height}`; groups.set(key, (groups.get(key) || 0) + 1); } return Math.max(0, ...groups.values()); }));
      check(config, 'exiting dictionary cards never stack into a white flash', maxOverlap <= 1, { maxOverlap });
      const search = await record(page, camera, config, 'dictionary-search', { frames: 150, events: [{ frame: 18, action: () => page.locator('[data-dictionary-search]').fill('слофо') }, { frame: 90, action: () => page.locator('[data-dictionary-search]').fill('') }], inspect: ghostInspection });
      check(config, 'dictionary creates only visible exit copies', Math.max(...search.map(sample => sample.ghosts.length)) < 30, { maximumGhosts: Math.max(...search.map(sample => sample.ghosts.length)) });
      await reset(page, camera); await page.evaluate(() => { const a = window.nocturneApp; a.openSettingsTab('formatting'); a.settingsSurfaceRoot().querySelector('.formatting-list').scrollIntoView({ block: 'center', behavior: 'instant' }); }); await camera.settle();
      const formatting = await record(page, camera, config, 'formatting-delete', { frames: 120, events: [{ frame: 18, action: () => camera.click('[data-action="formatting-delete"]') }], inspect: () => {
        const a = window.nocturneApp, list = a.settingsSurfaceRoot().querySelector('.formatting-list'), row = list.querySelector('.formatting-item'), toggle = row?.querySelector('.toggle'), l = list.getBoundingClientRect(), t = toggle?.getBoundingClientRect();
        return { overflow: getComputedStyle(list).overflowY, listBottom: l.bottom, toggleBottom: t?.bottom || 0, toggleTop: t?.top || 0, on: toggle?.classList.contains('on'), count: list.querySelectorAll('.formatting-item').length };
      } });
      const clipped = formatting.filter(sample => sample.frame > 18 && sample.frame < 70 && sample.overflow === 'hidden' && sample.toggleBottom > sample.listBottom + 1);
      check(config, 'remaining switch is never clipped during row removal', clipped.length === 0, { clippedFrames: clipped.length });
      check(config, 'remaining switch keeps its off state', formatting.filter(sample => sample.frame >= 19).every(sample => sample.on === false), {});
      await reset(page, camera);
      await page.evaluate(() => { const a = window.nocturneApp; a.openSettingsTab('macros'); a.settingsSurfaceRoot().querySelector('.macro-add-card').scrollIntoView({ block: 'start', behavior: 'instant' }); }); await camera.settle();
      const helper = await record(page, camera, config, 'macro-helper', { frames: 150, events: [{ frame: 18, action: () => camera.click('[data-action="macro-record-toggle"]') }, { frame: 90, action: () => camera.click('[data-action="macro-record-toggle"]') }], inspect: () => { const a = window.nocturneApp, card = a.settingsSurfaceRoot().querySelector('.macro-add-card'), helper = a.settingsControl('macro-record-instructions'); return { height: card?.getBoundingClientRect().height || 0, helperVisible: helper && getComputedStyle(helper).display !== 'none' && getComputedStyle(helper).visibility !== 'hidden' && helper.getBoundingClientRect().height > 1 && getComputedStyle(helper).opacity !== '0', text: helper?.textContent }; } });
      check(config, 'recording helper and card actually change in the clip', helper.some(sample => sample.helperVisible) && helper.some(sample => !sample.helperVisible) && new Set(helper.map(sample => Math.round(sample.height * 10))).size > 5, { heights: new Set(helper.map(sample => Math.round(sample.height * 10))).size });
      await camera.settle();
      await page.evaluate(() => window.nocturneApp.settingsSurfaceRoot().querySelector('.macros-list').scrollIntoView({ block: 'center', behavior: 'instant' })); await camera.settle();
      const macros = await record(page, camera, config, 'macro-delete', { frames: 210, events: [{ frame: 18, action: () => camera.click('[data-action="macro-delete"]') }, { frame: 48, action: () => camera.click('[data-confirm-delete-macro]') }], inspect: () => { const row = document.querySelector('.macro-item'), r = row?.getBoundingClientRect(); return { count: document.querySelectorAll('.macro-item').length, y: r?.top || 0 }; } });
      check(config, 'macro recording covers confirmation and completed reflow', macros[0].count === 3 && macros.at(-1).count === 2 && new Set(macros.filter(sample => sample.count === 2).map(sample => Math.round(sample.y * 10))).size > 5, { count: macros.at(-1).count });
      await reset(page, camera);
      await page.evaluate(() => { const a = window.nocturneApp; a.state.floatingNotesManagerOpen = true; a.renderFloatingNotesModal(); }); await camera.settle();
      const floating = await record(page, camera, config, 'floating-resize', { frames: config.mobile ? 270 : 180, events: [{ frame: 18, action: () => camera.click('[data-action="delete-floating-note"]') }, ...(config.mobile ? [{ frame: 80, action: () => camera.click('[data-action="delete-floating-note"]') }, { frame: 142, action: () => camera.click('[data-action="delete-floating-note"]') }] : [])], inspect: () => { const panel = document.querySelector('.floating-notes-modal-panel'); return { height: panel?.getBoundingClientRect().height || 0, top: panel?.getBoundingClientRect().top || 0, count: document.querySelectorAll('.floating-manager-card').length }; } });
      const heights = floating.filter(sample => sample.frame >= 18).map(sample => Math.round(sample.height * 10));
      if (!config.mobile) check(config, 'notes modal shrinks through intermediate sizes', new Set(heights).size > 5, { heights: new Set(heights).size, before: floating[0].height, after: floating.at(-1).height });
      await reset(page, camera);
      await page.evaluate(() => { const a = window.nocturneApp; if (a.isMobileLayout()) a.openMobilePanel('notes', 'more'); else a.togglePanel('notes-panel'); a.renderNotes(); }); await camera.settle();
      await camera.screenshot(`${config.id}-notes-panel`); evidence.push({ config: config.id, name: 'notes-panel', screenshot: `${config.id}-notes-panel.png` });
      if (!config.mobile) {
        const geometry = await page.evaluate(() => { const panel = document.getElementById('notes-panel'), header = panel.querySelector('.panel-header'), toolbar = document.querySelector('.main-workspace > .toolbar'); return { top: panel.getBoundingClientRect().top, toolbarBottom: toolbar.getBoundingClientRect().bottom, headerHeight: header.getBoundingClientRect().height, titleHeight: header.querySelector('.panel-title').getBoundingClientRect().height }; });
        check(config, 'notes starts below the entire toolbar', Math.abs(geometry.top - geometry.toolbarBottom) <= 1, geometry);
        check(config, 'notes header never shrinks under long content', geometry.headerHeight >= 60 && geometry.headerHeight >= geometry.titleHeight + 20, geometry);
      }
      await reset(page, camera);
      await page.evaluate(() => { const a = window.nocturneApp, editor = a.nocturneEditor.get('primary'); editor.commands.setTextSelection({ from: 18, to: 22 }); editor.view.focus(); a.renderNocturneSelectionLayer(); }); await camera.settle();
      const selection = await record(page, camera, config, 'selection-drag', { frames: 180, events: [{ frame: 18, action: () => page.evaluate(() => { const a = window.nocturneApp; document.body.classList.add('is-selecting-text'); a.nocturneEditor.get('primary').commands.setTextSelection({ from: 18, to: 30 }); a.renderNocturneSelectionLayer(); }) }, { frame: 55, action: () => page.evaluate(() => { const a = window.nocturneApp; a.nocturneEditor.get('primary').commands.setTextSelection({ from: 18, to: 42 }); a.renderNocturneSelectionLayer(); }) }, { frame: 92, action: () => page.evaluate(() => { const a = window.nocturneApp; a.nocturneEditor.get('primary').commands.setTextSelection({ from: 18, to: 24 }); a.renderNocturneSelectionLayer(); }) }, { frame: 130, action: () => page.evaluate(() => { const a = window.nocturneApp; document.body.classList.remove('is-selecting-text'); a.nocturneEditor.get('primary').commands.setTextSelection(18); a.renderNocturneSelectionLayer(); }) }], inspect: () => { const layer = document.getElementById('nocturne-selection-layer'), rect = layer.querySelector('.nocturne-selection-rect'), editor = window.nocturneApp.nocturneEditor.get('primary'); return { width: rect?.getBoundingClientRect().width || 0, target: parseFloat(rect?.style.width || '0'), from: editor.state.selection.from, to: editor.state.selection.to, native: getSelection().toString(), text: editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), active: layer.classList.contains('active') }; } });
      const moving = selection.filter(sample => sample.frame >= 18 && sample.frame <= 33);
      check(config, 'selection interpolates while the pointer is down', new Set(moving.map(sample => Math.round(sample.width * 10))).size > 3 && moving.some(sample => Math.abs(sample.width - sample.target) > 1), { intermediateWidths: new Set(moving.map(sample => Math.round(sample.width * 10))).size });
      check(config, 'smoothing preserves the selected text exactly', selection.every(sample => sample.native === sample.text), {});
      check(config, 'selection finishes clearing', !selection.at(-1).active, {});
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => { const a = window.nocturneApp; a.nocturneEditor.get('primary').commands.setTextSelection({ from: 18, to: 30 }); a.renderNocturneSelectionLayer(); }); await camera.advance();
      const reduced = await page.evaluate(() => { const rect = document.querySelector('.nocturne-selection-rect'); return Math.abs(rect.getBoundingClientRect().width - parseFloat(rect.style.width)) < 1; });
      check(config, 'reduced motion selection is immediate', reduced, {});
      check(config, 'runtime errors', errors.length === 0, errors);
    } catch (error) { check(config, 'journey', false, error.stack); }
    finally { await camera.close(); await context.close(); }
  }
} finally {
  await browser.close(); server.kill();
  await writeFile(`${output}/evidence.json`, JSON.stringify({ phase, configurations, evidence }, null, 2));
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
console.log(`${phase}: ${results.length} checks, ${results.filter(result => !result.ok).length} failures, ${evidence.length} captures`);
for (const failure of results.filter(result => !result.ok)) console.log(JSON.stringify(failure));
process.exitCode = results.some(result => !result.ok) ? 1 : 0;
