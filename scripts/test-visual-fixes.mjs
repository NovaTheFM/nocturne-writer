import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5338;
const output = process.env.NOCTURNE_QA_DIR || 'release/qa/visual-fixes';
const phase = process.env.NOCTURNE_VISUAL_PHASE || 'after';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const browser = await chromium.launch();
const results = [], evidence = [];
const configurations = [
  { id: 'desktop-light', width: 1440, height: 1000, theme: 'paper' },
  { id: 'desktop-dark', width: 1440, height: 1000, theme: 'nocturne', video: true },
  { id: 'mobile-dark', width: 390, height: 844, theme: 'nocturne', mobile: true, video: true },
  { id: 'mobile-light', width: 390, height: 844, theme: 'paper', mobile: true },
  { id: 'mobile-narrow', width: 320, height: 740, theme: 'nocturne', mobile: true },
];
async function reset(page) {
  await page.evaluate(() => {
    const a = window.nocturneApp;
    a.closeSettingsSelects(); a.closeAllFloatingMenus(); a.closeSearchDock();
    for (const id of ['form-overlay', 'settings-overlay', 'kb-modal', 'floating-notes-modal', 'whats-new-overlay']) {
      const node = document.getElementById(id); if (!node) continue;
      clearTimeout(node.__motionCloseTimer); node.__motionGeneration = (node.__motionGeneration || 0) + 1;
      node.classList.remove('active', 'motion-exiting'); node.removeAttribute('aria-hidden');
    }
    document.getElementById('notes-panel')?.classList.remove('open');
    a.state.floatingNotesManagerOpen = false;
    if (a.isMobileLayout()) a.closeMobileToEditor();
    document.activeElement?.blur();
  });
  await page.waitForTimeout(350);
}
async function shot(page, config, name) {
  await page.waitForTimeout(380);
  const file = `${config.id}-${name}.png`;
  await page.screenshot({ path: `${output}/${file}` });
  evidence.push({ config: config.id, name, screenshot: file });
}
async function check(page, config, name, predicate) {
  try {
    const detail = await page.evaluate(predicate);
    results.push({ name: `${config.id}: ${name}`, ok: detail === true || detail?.ok === true, detail });
  } catch (error) { results.push({ name: `${config.id}: ${name}`, ok: false, error: error.stack }); }
}
async function scene(page, config, name, action) {
  await reset(page); await action(); await shot(page, config, name);
}
async function motion(page, config, name, prepare, action) {
  await reset(page); await prepare(); await page.waitForTimeout(450);
  const start = Date.now() - page.__videoStart;
  await page.waitForTimeout(250); await action(); await page.waitForTimeout(950);
  evidence.push({ config: config.id, name, video: `${config.id}-motion.webm`, start: start / 1000, end: (Date.now() - page.__videoStart) / 1000 });
}
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const config of configurations) {
    const context = await browser.newContext({ viewport: { width: config.width, height: config.height }, isMobile: !!config.mobile, hasTouch: !!config.mobile, ...(config.video ? { recordVideo: { dir: `${output}/recordings`, size: { width: config.width, height: config.height } } } : {}) });
    const page = await context.newPage(); page.__videoStart = Date.now();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    try {
      await page.goto(`http://localhost:${port}`);
      await page.waitForFunction(() => window.nocturneApp?.backups && document.querySelector('.app-shell.ready') && getComputedStyle(document.getElementById('preloader')).visibility === 'hidden');
      await page.evaluate(async config => {
        const a = window.nocturneApp; a.state.settings.theme = config.theme; a.applySettings();
        a.state.settings.customInputRules = [{ trigger: '->', action: 'custom-text', customText: '→', enabled: true }, { trigger: '...', action: 'custom-text', customText: '…', enabled: false }];
        a.state.settings.macros = [{ keys: 'Ctrl+Shift+1', value: '✦ ✦ ✦' }, { keys: 'Ctrl+Shift+2', value: '—' }];
        a.state.typoRules = [{ id: 'visual-rule-one', source: 'user', wrong: 'ашибка', correct: 'ошибка', label: 'Моё правило' }, { id: 'visual-rule-two', source: 'user', wrong: 'слофо', correct: 'слово', label: 'Моё правило' }];
        await a.createDoc(a.defaultFolderId(), 'Ночной город', '');
        a.nocturneEditor.get('primary').commands.setContent('<h2>Первая встреча</h2><p>Анна пришла в тихий город. Вечерний свет отражался в окнах. На площади её ждали друзья, с которыми она собиралась отправиться к реке.</p><p>Она остановилась у старого моста и перечитала письмо. Эта встреча должна была изменить всё.</p>');
        const doc = a.getFocusedDoc(); doc.docType = 'book-chapter'; doc.workTitle = 'Ночной город'; doc.chapterNumber = '1'; doc.notes = '- [ ] Проверить финал\n- [x] Сохранить первую сцену';
        await a.saveActiveDoc({ silent: true });
        a.state.floatingNotes = ['Первая заметка', 'Вторая заметка', 'Третья заметка', 'Четвёртая заметка'].map((title, i) => a.sanitizeFloatingNote({ id: `visual-floating-${i}`, title, body: 'Заметка о следующей сцене.', scope: 'global', hidden: true, createdAt: Date.now(), updatedAt: Date.now() - i }));
        a.state.lore.characters.push(a.normalizeCharacter({ id: 'visual-character', name: 'Анна', body: 'Путешественница, ищущая дорогу домой.' }));
        a.state.lore.locations.push(a.normalizeLocation({ id: 'visual-location', name: 'Тихий город', body: 'Город на берегу реки.' }));
        a.state.lore.notes.push(a.normalizeNote({ id: 'visual-note', title: 'Сюжетные линии', body: 'Встреча на площади.' }));
        a.state.lore.timeline.push(a.normalizeTimelineEvent({ id: 'visual-event', title: 'Первая встреча', date: 'Год 1', body: 'Анна приходит в город.', characterIds: ['visual-character'] }));
        await a.saveLore();
      }, config);
      await scene(page, config, 'document-edit', () => page.evaluate(() => { const a = window.nocturneApp; a.editDocForm(a.getFocusedDoc().id); }));
      await check(page, config, 'form text follows theme', () => {
        const field = document.querySelector('#form-overlay .form-control');
        return { ok: getComputedStyle(field).color === getComputedStyle(document.body).color, color: getComputedStyle(field).color };
      });
      await page.keyboard.press('Tab'); await page.locator('.doc-type-radio input').first().focus();
      await check(page, config, 'radio has visible keyboard focus', () => { const s = getComputedStyle(document.activeElement.nextElementSibling); return { ok: s.outlineStyle !== 'none' || s.boxShadow !== 'none', outline: s.outline, shadow: s.boxShadow }; });
      await shot(page, config, 'document-type-focus');
      await scene(page, config, 'replace', () => page.evaluate(() => window.nocturneApp.openReplaceWindow()));
      await check(page, config, 'replace fields and actions fit', () => { const node = document.querySelector('.replace-modal'); return { ok: node.scrollWidth <= node.clientWidth + 1, overflow: node.scrollWidth - node.clientWidth }; });
      for (const tab of ['review', 'formatting', 'dictionary', 'export', 'visual', 'macros']) {
        await scene(page, config, `settings-${tab}`, () => page.evaluate(tab => window.nocturneApp.openSettingsTab(tab), tab));
        if (tab === 'review') await check(page, config, 'review cards contain text', () => [...document.querySelectorAll('.review-mode-card')].every(node => node.scrollWidth <= node.clientWidth + 1));
        if (tab === 'formatting') {
          await page.locator('[data-action="formatting-save-new"]').scrollIntoViewIfNeeded(); await shot(page, config, 'formatting-form-bottom');
          await check(page, config, 'formatting labels and cards fit', () => [...document.querySelectorAll('.formatting-item, .formatting-form-flex .nocturne-select-trigger')].every(node => node.scrollWidth <= node.clientWidth + 1));
        }
        if (tab === 'dictionary') {
          await page.keyboard.press('Tab'); await page.locator('.dictionary-toggle .toggle').first().focus(); await shot(page, config, 'dictionary-focus');
          await check(page, config, 'dictionary switch named and focused', () => { const node = document.activeElement, s = getComputedStyle(node); return { ok: node.getAttribute('aria-label') !== 'Переключатель' && s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2, label: node.getAttribute('aria-label'), outline: s.outline }; });
        }
        if (tab === 'export') {
          await check(page, config, 'export switch keyboard accessible', () => { const node = document.querySelector('[data-action="toggle-nocturned-export"]'); return { ok: node?.getAttribute('role') === 'switch' && node?.tabIndex === 0, role: node?.getAttribute('role') }; });
          const toggle = page.locator('[data-action="toggle-nocturned-export"]');
          if (await toggle.getAttribute('role') === 'switch') { await toggle.focus(); const before = await toggle.getAttribute('aria-checked'); await page.keyboard.press('Space'); results.push({ name: `${config.id}: export switch space toggles once`, ok: (await toggle.getAttribute('aria-checked')) !== before }); }
        }
        if (tab === 'visual') {
          await page.locator('.range-value-input').first().focus(); await shot(page, config, 'range-value-focus');
          await check(page, config, 'numeric companions request numeric keyboard', () => [...document.querySelectorAll('.range-value-input')].every(node => ['numeric', 'decimal'].includes(node.inputMode)));
          await page.locator('[data-setting-select="theme"] .nocturne-select-trigger').click(); await page.waitForTimeout(350); await shot(page, config, 'theme-menu');
          await page.locator('[data-setting-select="theme"] .nocturne-select-trigger').click();
          await check(page, config, 'select closes with an exit', () => { const menu = document.querySelector('[data-setting-select="theme"] .nocturne-select-menu'); return { ok: getComputedStyle(menu).display !== 'none' && menu.getAnimations().length > 0, display: getComputedStyle(menu).display, animations: menu.getAnimations().length }; });
          await page.waitForTimeout(300);
          await check(page, config, 'select finishes closing', () => getComputedStyle(document.querySelector('[data-setting-select="theme"] .nocturne-select-menu')).display === 'none');
        }
      }
      await scene(page, config, 'associations-characters', async () => {
        await page.evaluate(() => window.nocturneApp.editLore('timeline', 'visual-event'));
        await page.locator('[data-action="toggle-associations"]').click();
      });
      await check(page, config, 'association cards have keyboard selection', () => { const node = document.querySelector('.char-assoc-card'); return { ok: !!node?.querySelector('input[type="checkbox"]')?.getClientRects().length && getComputedStyle(node.querySelector('input[type="checkbox"]')).display !== 'none' }; });
      await page.locator('[data-assoc-tab="loc"]').click(); await shot(page, config, 'associations-locations');
      await scene(page, config, 'notes', () => page.evaluate(() => { const a = window.nocturneApp; if (a.isMobileLayout()) a.openMobilePanel('notes', 'more'); else { a.state.noteMode = 'document'; a.togglePanel('notes-panel'); a.renderNotes(); } }));
      if (config.mobile) await check(page, config, 'notes segment uses both columns', () => { const group = document.querySelector('#mobile-overlay .mobile-segmented'), last = group?.querySelector('button:last-of-type'); return { ok: !!last && Math.abs(group.getBoundingClientRect().right - last.getBoundingClientRect().right) < 12 }; });
      else await check(page, config, 'note task text inside its label', () => [...document.querySelectorAll('.interactive-cb')].every(node => node.textContent.trim().length > 0));
      await scene(page, config, 'floating-notes', () => page.evaluate(() => { const a = window.nocturneApp; a.state.floatingNotesManagerOpen = true; a.renderFloatingNotesModal(); }));
      await reset(page); await page.evaluate(() => { const a = window.nocturneApp, editor = a.nocturneEditor.get('primary'); editor.commands.focus(); editor.commands.setTextSelection({ from: 18, to: 145 }); a.renderNocturneSelectionLayer(); }); await shot(page, config, 'selection');
      await check(page, config, 'selection tint preserves light and dark text', () => getComputedStyle(document.querySelector('.nocturne-selection-rect')).mixBlendMode === 'normal');
      await page.evaluate(() => { window.nocturneApp.nocturneEditor.get('primary').commands.setTextSelection(18); window.nocturneApp.renderNocturneSelectionLayer(); });
      await check(page, config, 'selection disappears smoothly', () => document.getElementById('nocturne-selection-layer').classList.contains('active'));
      await page.waitForTimeout(250);
      await check(page, config, 'collapsed selection leaves no overlay', () => !document.getElementById('nocturne-selection-layer').classList.contains('active'));
      if (config.video) {
        await motion(page, config, 'select-motion', () => page.evaluate(() => window.nocturneApp.openSettingsTab('visual')), async () => { const trigger = page.locator('[data-setting-select="theme"] .nocturne-select-trigger'); await trigger.click(); await page.waitForTimeout(400); await trigger.click(); });
        await motion(page, config, 'dictionary-motion', () => page.evaluate(() => window.nocturneApp.openSettingsTab('dictionary')), () => page.locator('[data-dictionary-filter="mine"]').click());
        await motion(page, config, 'review-motion', () => page.evaluate(() => window.nocturneApp.openSettingsTab('review')), async () => { await page.locator('.review-mode-card[data-review-mode="editor"]').click(); await page.waitForTimeout(450); await page.locator('.review-mode-card[data-review-mode="write"]').click(); });
        await motion(page, config, 'formatting-motion', async () => { await page.evaluate(() => window.nocturneApp.openSettingsTab('formatting')); await page.locator('.formatting-list').scrollIntoViewIfNeeded(); }, () => page.locator('[data-action="formatting-delete"]').first().click());
        await motion(page, config, 'macros-motion', () => page.evaluate(() => window.nocturneApp.openSettingsTab('macros')), async () => { await page.locator('[data-action="macro-delete"]').first().click(); await page.waitForTimeout(350); await page.locator('[data-confirm-delete-macro]').click(); });
        await motion(page, config, 'macro-helper-motion', () => page.evaluate(() => window.nocturneApp.openSettingsTab('macros')), async () => { await page.locator('[data-action="macro-record-toggle"]').click(); await page.waitForTimeout(400); await page.locator('[data-action="macro-record-toggle"]').click(); });
        await motion(page, config, 'floating-motion', () => page.evaluate(() => { const a = window.nocturneApp; a.state.floatingNotesManagerOpen = true; a.renderFloatingNotesModal(); }), () => page.locator('[data-action="delete-floating-note"]').first().click());
        await motion(page, config, 'association-motion', async () => { await page.evaluate(() => window.nocturneApp.editLore('timeline', 'visual-event')); await page.locator('[data-action="toggle-associations"]').click(); }, async () => { await page.locator('[data-assoc-tab="loc"]').click(); await page.waitForTimeout(400); await page.locator('[data-assoc-tab="note"]').click(); });
        if (config.mobile) await motion(page, config, 'segment-motion', () => page.evaluate(() => window.nocturneApp.openMobilePanel('notes', 'more')), async () => { await page.locator('[data-mobile-notes-mode]').last().click(); await page.waitForTimeout(400); await page.locator('[data-mobile-notes-mode]').first().click(); });
        await motion(page, config, 'selection-motion', () => page.evaluate(() => { const editor = window.nocturneApp.nocturneEditor.get('primary'); editor.commands.focus(); editor.commands.setTextSelection(18); }), async () => {
          for (const to of [32, 56, 85, 116, 145, 180, 220, 56, 18]) { await page.evaluate(to => { const a = window.nocturneApp; a.nocturneEditor.get('primary').commands.setTextSelection({ from: 18, to }); a.renderNocturneSelectionLayer(); }, to); await page.waitForTimeout(160); }
        });
      }
      await reset(page); await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.evaluate(() => window.nocturneApp.openSettingsTab('visual')); await page.waitForTimeout(100);
      await page.locator('[data-setting-select="theme"] .nocturne-select-trigger').click(); await page.locator('[data-setting-select="theme"] .nocturne-select-trigger').click(); await page.waitForTimeout(30);
      await check(page, config, 'reduced motion select closes immediately', () => getComputedStyle(document.querySelector('[data-setting-select="theme"] .nocturne-select-menu')).display === 'none');
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      const themeTrigger = page.locator('[data-setting-select="theme"] .nocturne-select-trigger');
      await themeTrigger.click(); await page.waitForTimeout(200); await themeTrigger.click(); await page.waitForTimeout(30); await themeTrigger.click(); await page.waitForTimeout(250);
      await check(page, config, 'reopening menu cancels pending close', () => { const select = document.querySelector('[data-setting-select="theme"]'); return select.classList.contains('open') && !select.querySelector('.nocturne-select-menu').inert && select.querySelector('.nocturne-select-menu').matches(':popover-open'); });
      await scene(page, config, 'association-focus', async () => { await page.evaluate(() => window.nocturneApp.editLore('timeline', 'visual-event')); await page.locator('[data-action="toggle-associations"]').click(); await page.waitForTimeout(350); const checkbox = page.locator('.char-assoc-card input[type="checkbox"]'); await checkbox.focus(); const before = await checkbox.isChecked(); await page.keyboard.press('Space'); results.push({ name: `${config.id}: association space toggles once`, ok: (await checkbox.isChecked()) !== before }); });
      await check(page, config, 'association keyboard focus decorates card', () => parseFloat(getComputedStyle(document.querySelector('.char-assoc-card')).outlineWidth) >= 2);
      await page.locator('[data-action="toggle-associations"]').click();
      await check(page, config, 'collapsed association controls inert', () => document.querySelector('.assoc-collapsible-content').inert);
      await reset(page); await page.evaluate(() => window.nocturneApp.openSettingsTab('formatting')); await page.waitForTimeout(350);
      await check(page, config, 'formatting action fully readable', () => { const node = document.querySelector('.formatting-field-group .nocturne-select-trigger > span'); return node.scrollWidth <= node.clientWidth + 1; });
      await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.customInputRules = [{ trigger: 'first', action: 'center', enabled: true }, { trigger: 'second', action: 'separator', enabled: true }]; a.renderFormattingListOnly(); window.__visualSurvivor = a.settingsSurfaceRoot().querySelectorAll('.formatting-item')[1]; });
      await page.waitForTimeout(350); await page.locator('[data-action="formatting-delete"]').first().click();
      await check(page, config, 'formatting survivor keeps identity', () => window.__visualSurvivor.isConnected && window.__visualSurvivor.textContent.includes('second'));
      await reset(page); await page.evaluate(() => window.nocturneApp.openSettingsTab('dictionary')); await page.waitForTimeout(350);
      await page.evaluate(() => { const a = window.nocturneApp; a.state.dictionaryFilter = 'mine'; a.state.dictionarySearch = ''; a.updateDictionaryList(); window.__visualSurvivor = a.settingsSurfaceRoot().querySelectorAll('.dictionary-card')[1]; }); await page.waitForTimeout(350);
      await page.locator('[data-dictionary-search]').fill('слофо'); await page.waitForTimeout(250);
      await check(page, config, 'dictionary survivor keeps identity', () => window.__visualSurvivor.isConnected && window.__visualSurvivor.textContent.includes('слофо'));
      await reset(page); await page.evaluate(() => window.nocturneApp.openSettingsTab('editor')); await page.waitForTimeout(350);
      const decimalField = page.locator('.range-value-input[data-setting-input="lineHeight"]');
      await decimalField.fill('1,75');
      await check(page, config, 'decimal keyboard comma preserves value while typing', () => window.nocturneApp.state.settings.lineHeight === 1.75);
      await decimalField.blur();
      await check(page, config, 'decimal keyboard comma commits correctly', () => window.nocturneApp.state.settings.lineHeight === 1.75 && document.querySelector('.range-value-input[data-setting-input="lineHeight"]').value === '1.75');
      await reset(page); await page.evaluate(() => { const editor = window.nocturneApp.nocturneEditor.get('primary'); editor.commands.setTextSelection(18); editor.view.focus(); });
      await page.waitForFunction(() => window.nocturneApp.nocturneEditor.get('primary').view.hasFocus());
      await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowRight'); await page.waitForTimeout(180);
      await check(page, config, 'keyboard selection stays native and exact', () => { const editor = window.nocturneApp.nocturneEditor.get('primary'), selection = editor.state.selection, native = getSelection(); return { ok: selection.to - selection.from === 2 && native.toString() === editor.state.doc.textBetween(selection.from, selection.to), from: selection.from, to: selection.to, text: native.toString() }; });
      await page.evaluate(() => { const a = window.nocturneApp, editor = a.nocturneEditor.get('primary'); editor.commands.setTextSelection({ from: 18, to: 80 }); a.renderNocturneSelectionLayer(); }); await page.waitForTimeout(180);
      await page.emulateMedia({ reducedMotion: 'reduce' }); await page.evaluate(() => { const a = window.nocturneApp; a.nocturneEditor.get('primary').commands.setTextSelection(18); a.renderNocturneSelectionLayer(); });
      await check(page, config, 'reduced motion selection clears immediately', () => !document.getElementById('nocturne-selection-layer').classList.contains('active'));
      results.push({ name: `${config.id}: runtime errors`, ok: errors.length === 0, errors });
    } catch (error) { results.push({ name: `${config.id}: journey`, ok: false, error: error.stack }); }
    finally { const video = page.video(); await context.close(); if (video) await video.saveAs(`${output}/${config.id}-motion.webm`); }
  }
} finally {
  await browser.close(); server.kill();
  await writeFile(`${output}/evidence.json`, JSON.stringify({ phase, evidence }, null, 2));
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
console.log(`${phase}: ${evidence.length} captures, ${results.length} checks, ${results.filter(result => !result.ok).length} failures`);
for (const result of results.filter(result => !result.ok)) console.log(JSON.stringify(result));
process.exitCode = results.some(result => !result.ok) ? 1 : 0;
