import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5337;
const output = process.env.NOCTURNE_QA_DIR || process.env.NOCTURNE_QA_OUTPUT || 'release/qa/visual-controls-audit';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const browser = await chromium.launch({ headless: true });
const observations = [], probes = [], results = [];
const settingsTabs = ['visual', 'editor', 'dictionary', 'review', 'bookmarks', 'focus', 'macros', 'formatting', 'ai', 'data', 'export', 'misc', 'history', 'manuscript-search', 'search'];

async function reset(page) {
  await page.evaluate(() => {
    const a = window.nocturneApp;
    a.closeSettingsSelects(); a.closeAllFloatingMenus(); a.closeSearchDock();
    for (const selector of ['#form-overlay', '#settings-overlay', '#kb-modal', '#floating-notes-modal', '#shortcuts-overlay', '#cleaner-overlay', '#whats-new-overlay']) {
      const overlay = document.querySelector(selector);
      if (!overlay) continue;
      clearTimeout(overlay.__motionCloseTimer);
      overlay.__motionGeneration = (overlay.__motionGeneration || 0) + 1;
      overlay.classList.remove('active', 'motion-exiting');
      overlay.removeAttribute('aria-hidden');
    }
    document.getElementById('ai-panel')?.classList.remove('open');
    document.getElementById('notes-panel')?.classList.remove('open');
    a.state.floatingNotesManagerOpen = false;
    if (a.isMobileLayout()) a.closeMobileToEditor();
    document.activeElement?.blur();
  });
  await page.waitForTimeout(400);
}

async function capture(page, configuration, surface) {
  await page.waitForTimeout(550);
  const filename = `${configuration.id}-${surface}.png`;
  await page.screenshot({ path: `${output}/${filename}` });
  const observation = await page.evaluate(() => {
    const visible = node => {
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      if (!window.nocturneApp.isSurfaceVisible(node) || r.width <= 0 || r.height <= 0 || s.display === 'none' || s.visibility === 'hidden' || node.closest('[inert], [aria-hidden="true"]')) return false;
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) if (Number(getComputedStyle(ancestor).opacity) === 0) return false;
      return true;
    };
    const controls = [...document.querySelectorAll('.toggle, input[type="range"], input[type="radio"], input[type="checkbox"], input[type="color"], .nocturne-select, .mobile-segmented, .assoc-tabs-header, .range-value-input')].filter(visible).map(node => {
      const r = node.getBoundingClientRect(), s = getComputedStyle(node);
      const label = node.getAttribute('aria-label') || node.closest('.setting-row')?.querySelector('.setting-info > span')?.textContent || node.closest('label')?.textContent || node.closest('.ai-context-head')?.textContent || '';
      return { tag: node.tagName, type: node.type, class: node.className, key: node.dataset.setting || node.dataset.settingSelect || node.dataset.action || node.name || node.id, label: label.trim().slice(0, 130), role: node.getAttribute('role'), tabIndex: node.tabIndex, checked: node.getAttribute('aria-checked'), rect: r.toJSON(), appearance: s.appearance, background: s.backgroundColor, color: s.color, transition: s.transition, animation: s.animationName, outline: s.outline, fontSize: s.fontSize, inputMode: node.inputMode, inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
    });
    const panels = [...document.querySelectorAll('.modal-overlay.active > *, .kb-modal.active > *, .mobile-overlay.active > *, .settings-body, .form-modal, .mobile-panel-body, .nocturne-select-menu:popover-open')].filter(visible).map(node => ({ class: node.className, rect: node.getBoundingClientRect().toJSON(), overflow: node.scrollWidth - node.clientWidth }));
    return { controls, panels, viewport: { width: innerWidth, height: innerHeight }, horizontalOverflow: document.documentElement.scrollWidth - innerWidth, activeAnimations: document.getAnimations().filter(animation => animation.playState === 'running').length };
  });
  observations.push({ configuration: configuration.id, surface, screenshot: filename, ...observation });
}

async function scenario(page, configuration, name, action) {
  try { await reset(page); await action(); await capture(page, configuration, name); results.push({ name: `${configuration.id}: ${name}`, ok: true }); }
  catch (error) { results.push({ name: `${configuration.id}: ${name}`, ok: false, error: error.stack }); }
}

try {
  for (let attempt = 0; attempt < 80; attempt++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const configuration of [
    { id: 'desktop-dark', width: 1440, height: 1000, mobile: false, theme: 'nocturne' },
    { id: 'mobile-dark', width: 390, height: 844, mobile: true, theme: 'nocturne' },
    { id: 'desktop-light', width: 1440, height: 1000, mobile: false, theme: 'paper' },
    { id: 'mobile-light', width: 390, height: 844, mobile: true, theme: 'paper' },
    { id: 'mobile-narrow', width: 320, height: 740, mobile: true, theme: 'nocturne' },
  ]) {
    const context = await browser.newContext({ viewport: { width: configuration.width, height: configuration.height }, isMobile: configuration.mobile, hasTouch: configuration.mobile });
    const page = await context.newPage();
    const pageErrors = []; page.on('pageerror', error => pageErrors.push(error.message));
    page.setDefaultTimeout(5000);
    try {
      await page.goto(`http://localhost:${port}`);
      await page.waitForFunction(() => window.nocturneApp?.backups && document.querySelector('.app-shell.ready') && getComputedStyle(document.getElementById('preloader')).visibility === 'hidden');
      await page.evaluate(async theme => {
        const a = window.nocturneApp; a.state.settings.theme = theme; a.applySettings();
        a.state.settings.customInputRules = [{ trigger: '->', action: 'custom-text', customText: '→', enabled: true }, { trigger: '...', action: 'custom-text', customText: '…', enabled: false }];
        a.state.settings.macros = [{ keys: 'Ctrl+Shift+1', value: '✦ ✦ ✦' }, { keys: 'Ctrl+Shift+2', value: '—' }];
        await a.createDoc(a.defaultFolderId(), 'Ночной город', '');
        a.nocturneEditor.get('primary').commands.setContent('<h2>Первая встреча</h2><p>Анна пришла в тихий город. Вечерний свет отражался в окнах.</p><p>На площади её ждали друзья.</p>');
        const doc = a.getFocusedDoc(); doc.docType = 'book-chapter'; doc.workTitle = 'Ночной город'; doc.chapterNumber = '1'; await a.saveActiveDoc({ silent: true });
        doc.notes = '- [ ] Проверить финал\n- [x] Сохранить первую сцену';
        a.state.floatingNotes = ['Первая заметка', 'Вторая заметка'].map((title, index) => a.sanitizeFloatingNote({ id: `audit-floating-${index}`, title, body: 'Заметка о следующей сцене.', scope: 'global', hidden: true, createdAt: Date.now(), updatedAt: Date.now() - index }));
        a.state.lore.characters.push(a.normalizeCharacter({ id: 'audit-character', name: 'Анна', body: 'Путешественница, ищущая дорогу домой.' }));
        a.state.lore.locations.push(a.normalizeLocation({ id: 'audit-location', name: 'Тихий город', body: 'Город на берегу реки.' }));
        a.state.lore.notes.push(a.normalizeNote({ id: 'audit-note', title: 'Сюжетные линии', body: 'Встреча на площади.' }));
        a.state.lore.timeline.push(a.normalizeTimelineEvent({ id: 'audit-event', title: 'Первая встреча', date: 'Год 1', body: 'Анна приходит в город.' }));
        await a.saveLore(); await a.history.capture(doc, { reason: 'manual', name: 'Первый вариант' });
      }, configuration.theme);
      const tabs = configuration.id === 'mobile-narrow' ? ['visual', 'formatting', 'export', 'history'] : settingsTabs;
      for (const tab of tabs) await scenario(page, configuration, `settings-${tab}`, () => page.evaluate(tab => window.nocturneApp.openSettingsTab(tab), tab));
      for (const [name, action] of [
        ['compact-settings', () => page.evaluate(() => window.nocturneApp.openCompactSettings())],
        ['ai-panel', () => page.evaluate(() => { const a = window.nocturneApp; if (a.isMobileLayout()) a.switchMobileTab('ai'); else a.togglePanel('ai-panel'); })],
        ['export', () => page.evaluate(() => window.nocturneApp.openBookExport())],
        ['document-new', () => page.evaluate(() => window.nocturneApp.openDocForm(window.nocturneApp.defaultFolderId()))],
        ['document-edit', () => page.evaluate(() => window.nocturneApp.editDocForm(window.nocturneApp.getFocusedDoc().id))],
        ['lore-character', () => page.evaluate(() => window.nocturneApp.editLore('characters', 'audit-character'))],
        ['lore-timeline', () => page.evaluate(() => window.nocturneApp.editLore('timeline', 'audit-event'))],
        ['global-search', () => page.evaluate(() => window.nocturneApp.openGlobalSearchWindow('город'))],
        ['replace', () => page.evaluate(() => window.nocturneApp.openReplaceWindow())],
        ['history', () => page.evaluate(() => window.nocturneApp.showHistory())],
        ['backups', () => page.evaluate(() => window.nocturneApp.openBackups())],
        ['review-queue', () => page.evaluate(() => window.nocturneApp.openReviewQueue())],
        ['world-rules', () => page.evaluate(() => window.nocturneApp.editWorldRules())],
        ...['characters', 'bookmarks', 'search'].map(tab => [`kb-${tab}`, () => page.evaluate(tab => { const a = window.nocturneApp; if (a.isMobileLayout()) { a.state.mobile.kbTab = tab; a.state.activeKbTab = tab; a.switchMobileTab('lore'); } else a.openKb(tab); }, tab)]),
        ['sync', () => page.evaluate(() => window.nocturneApp.openSyncPanel())],
        ['shortcuts', () => page.evaluate(() => window.nocturneApp.openShortcutsModal())],
        ['floating-notes', () => page.evaluate(() => { const a = window.nocturneApp; a.state.floatingNotesManagerOpen = true; a.renderFloatingNotesModal(); })],
        ['notes', () => page.evaluate(() => { const a = window.nocturneApp; if (a.isMobileLayout()) a.openMobilePanel('notes', 'more'); else { a.state.noteMode = 'document'; a.togglePanel('notes-panel'); a.renderNotes(); } })],
      ]) await scenario(page, configuration, name, action);
      await scenario(page, configuration, 'formatting-form-bottom', async () => {
        await page.evaluate(() => window.nocturneApp.openSettingsTab('formatting'));
        await page.locator('[data-action="formatting-save-new"]').scrollIntoViewIfNeeded();
      });
      for (const [name, tab, selector] of [
        ['dictionary-focus', 'dictionary', '.dictionary-toggle .toggle'],
        ['range-value-focus', 'visual', '.range-value-input'],
        ['document-type-focus', null, '.doc-type-radio input'],
      ]) await scenario(page, configuration, name, async () => {
        await page.evaluate(tab => { const a = window.nocturneApp; if (tab) a.openSettingsTab(tab); else a.openDocForm(a.defaultFolderId()); }, tab);
        await page.waitForTimeout(600);
        const control = page.locator(selector).first();
        await control.scrollIntoViewIfNeeded(); await page.keyboard.press('Tab'); await control.focus();
        probes.push({ configuration: configuration.id, kind: name, state: await page.evaluate(() => {
          const node = document.activeElement, style = getComputedStyle(node), decorated = node.closest('.doc-type-radio')?.querySelector('span'), decoratedStyle = decorated && getComputedStyle(decorated);
          return { tag: node.tagName, role: node.getAttribute('role'), label: node.getAttribute('aria-label'), focusVisible: node.matches(':focus-visible'), outline: style.outline, shadow: style.boxShadow, inputMode: node.inputMode, decoration: decoratedStyle && { outline: decoratedStyle.outline, shadow: decoratedStyle.boxShadow, color: decoratedStyle.color } };
        }) });
      });
      await scenario(page, configuration, 'mobile-export-panel', () => page.evaluate(() => { const a = window.nocturneApp; if (a.isMobileLayout()) a.openMobilePanel('export', 'more'); else a.openSettingsTab('export'); }));
      await reset(page); await page.evaluate(() => window.nocturneApp.openSettingsTab('visual')); await page.waitForTimeout(600);
      const select = page.locator('[data-setting-select="theme"] .nocturne-select-trigger').first();
      if (await select.count()) {
        await select.click();
        const frames = [];
        for (const wait of [0, 50, 130]) { if (wait) await page.waitForTimeout(wait); frames.push(await page.evaluate(() => { const node = document.querySelector('[data-setting-select="theme"] .nocturne-select-menu'), s = getComputedStyle(node); return { time: performance.now(), opacity: s.opacity, transform: s.transform, display: s.display, animations: node.getAnimations().map(animation => ({ state: animation.playState, currentTime: animation.currentTime })) }; })); }
        await capture(page, configuration, 'theme-menu');
        await select.click();
        const closed = await page.evaluate(() => { const node = document.querySelector('[data-setting-select="theme"] .nocturne-select-menu'), s = getComputedStyle(node); return { opacity: s.opacity, display: s.display, height: node.getBoundingClientRect().height, animations: node.getAnimations().length }; });
        probes.push({ configuration: configuration.id, kind: 'select-open-close', frames, closed });
      }
      await reset(page); await page.evaluate(() => window.nocturneApp.editLore('timeline', 'audit-event')); await page.waitForTimeout(600);
      await page.locator('[data-action="toggle-associations"]').click(); await page.waitForTimeout(550);
      await capture(page, configuration, 'associations-characters');
      await page.locator('[data-assoc-tab="loc"]').click();
      probes.push({ configuration: configuration.id, kind: 'association-tab-motion', state: await page.evaluate(() => ({ activeAnimations: document.querySelector('[data-assoc-content="loc"]').getAnimations({ subtree: true }).length, selection: document.querySelectorAll('.assoc-tabs-header .knowledge-selection').length })) });
      await capture(page, configuration, 'associations-locations');
      await reset(page); await page.evaluate(() => window.nocturneApp.openDocForm(window.nocturneApp.defaultFolderId())); await page.waitForTimeout(600);
      await page.locator('.doc-type-radio').last().click();
      probes.push({ configuration: configuration.id, kind: 'document-type-motion', state: await page.evaluate(() => ({ activeAnimations: document.getAnimations().filter(animation => animation.playState === 'running').length, fields: document.querySelector('.book-chapter-fields-wrapper')?.getBoundingClientRect().toJSON() })) });
      await capture(page, configuration, 'document-type-chapter');
      results.push({ name: `${configuration.id}: page errors`, ok: pageErrors.length === 0, errors: pageErrors });
    } catch (error) { results.push({ name: configuration.id, ok: false, error: error.stack }); }
    finally { await context.close(); }
  }
} finally {
  await browser.close(); server.kill();
  await writeFile(`${output}/observations.json`, JSON.stringify({ observations, probes }, null, 2));
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
console.log(`Visual audit captured ${observations.length} surfaces; ${results.filter(result => !result.ok).length} observation failures. Visual defects are reported separately, not represented as passing product checks.`);
for (const result of results.filter(result => !result.ok)) console.log(JSON.stringify(result));
process.exitCode = results.some(result => !result.ok) ? 1 : 0;
