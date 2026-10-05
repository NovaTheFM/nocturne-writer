import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { searchKnowledge, findTextMatches, highlightSearchText, queryTerms } from '../src/features/knowledge-search.js';
import { availablePort, killOwnedProcess } from './qa/runner.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/knowledge-search');
await mkdir(directory, { recursive: true });
const results = [];
async function record(name, run) {
  try { results.push({ name, passed: true, measurements: await run() }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
  await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${name}${results.at(-1).error ? '\n' + results.at(-1).error : ''}`);
}
const sampleWorld = {
  id: 'world', title: 'Архив северного мира',
  characters: [{ id: 'char-search', name: 'Анна', role: 'Хранительница', body: 'Живёт возле маяка.', aliases: ['Северная Искра'], mentionForms: ['Анне'], extra: { appearance: 'Сапфировый плащ' }, documentIds: ['doc-reference'] }],
  locations: [{ id: 'loc-search', name: 'Порт', body: 'Здесь растёт полынь.', aliases: ['Тихая гавань'] }],
  timeline: [{ id: 'time-search', title: 'Прибытие', date: 'День равноденствия', body: 'Корабль вошёл в гавань.', characterIds: ['char-search'], subEvents: [{ id: 'sub-search', title: 'Встреча', body: 'Найдена янтарная печать.', noteIds: ['note-search'] }] }],
  notes: [{ id: 'note-search', title: 'Набросок письма', body: 'Северный ветер.\nЁж сидит у окна.\nСеверный ветер возвращается.\nБуквально [a+b] и <img src=x onerror=alert(1)>.\n' + ('Длинный абзац для проверки прокрутки.\n'.repeat(70)) + '\nПоследний Северный ветер.', bookmarks: [{ id: 'bookmark-search', title: 'Лунная тропа', text: 'Серебряный ключ' }] }],
  rules: [{ id: 'rule-search', text: 'Лазурная магия действует только ночью.' }],
};

await record('search covers every text field, nested events, bookmarks, relations and linked floating notes', () => {
  const cases = [['ХРАНИТЕЛЬНИЦА', 'char-search'], ['Северная Искра', 'char-search'], ['Анне', 'char-search'], ['Сапфировый', 'char-search'], ['полынь', 'loc-search'], ['равноденствия', 'time-search'], ['янтарная', 'sub-search'], ['Лунная', 'note-search'], ['Серебряный', 'note-search'], ['Лазурная', 'rule-search']];
  for (const [query, id] of cases) assert.ok(searchKnowledge([sampleWorld], query).some(result => result.id === id), `${query}: ${id}`);
  assert.ok(searchKnowledge([sampleWorld], 'Анна').some(result => result.id === 'time-search'));
  assert.ok(searchKnowledge([sampleWorld], 'Оглавление', { docs: [{ id: 'doc-reference', title: 'Оглавление истории' }] }).some(result => result.id === 'char-search'));
  assert.ok(searchKnowledge([sampleWorld], 'Обсидиан', { floatingNotes: [{ id: 'f1', linkedId: 'char-search', scope: 'character', body: 'Обсидиан найден' }] }).some(result => result.id === 'char-search'));
  assert.ok(searchKnowledge([sampleWorld], 'Анна Сапфировый').some(result => result.id === 'char-search'));
  assert.equal(searchKnowledge([sampleWorld], 'янтарная').some(result => result.id === 'time-search'), false);
  return { fields: cases.length, relations: 3, separateSubevent: true };
});
await record('literal matching preserves offsets, ignores letter case and ё, escapes HTML and excludes locked records', () => {
  assert.deepEqual(findTextMatches('Ёж, еж, ЁЖ', 'еж'), [{ start: 0, end: 2 }, { start: 4, end: 6 }, { start: 8, end: 10 }]);
  assert.deepEqual(findTextMatches('Текст [a+b] и [a+b]', '[a+b]'), [{ start: 6, end: 11 }, { start: 14, end: 19 }]);
  assert.equal(findTextMatches('любой текст', '').length, 0);
  assert.equal(highlightSearchText('<img onerror=evil()> искра', queryTerms('искра')), '&lt;img onerror=evil()&gt; <mark>искра</mark>');
  assert.equal(searchKnowledge([{ ...sampleWorld, locked: true }], 'Анна').length, 0);
  assert.equal(searchKnowledge([{ ...sampleWorld, protectedStore: 'lore' }], 'Анна').length, 0);
  assert.equal(searchKnowledge([sampleWorld], 'char-search').length, 0);
  return { literalRegex: true, safeMarkup: true, encryptedExcluded: true };
});

const port = await availablePort(), url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let browser;
async function check(name, run, options = {}) {
  await record(name, async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.goto(url); await page.waitForSelector('.app-shell.ready');
      await page.evaluate(async world => {
        const a = window.nocturneApp; a.state.settings.automaticBackups = false; a.state.lore = world;
        await a.saveLore();
        await a.db.put('lore', { id: 'other-world', title: 'Другая история', characters: [], locations: [], timeline: [], notes: [{ id: 'other-note', title: 'Дальний берег', body: 'Неоновый кварц светится.' }], rules: [] });
        await a.db.put('lore', { id: 'locked-world', title: 'Защищённая история', locked: true, protectedStore: 'lore', encrypted: { secret: 'not-searchable' } });
        a.state.lore = await a.loadLore();
      }, sampleWorld);
      const measurements = await run(page);
      assert.deepEqual(errors, [], 'No uncaught application errors');
      return measurements;
    } catch (error) {
      await page.screenshot({ path: join(directory, `failure-${results.length + 1}.png`) }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  });
}
async function openSearch(page) {
  if (await page.evaluate(() => window.nocturneApp.isMobileLayout())) {
    await page.locator('.mobile-bottom-nav [data-action="mobile-open-lore"]').tap();
    await page.locator('[data-mobile-kb-tab="search"]').tap();
  } else await page.evaluate(() => window.nocturneApp.openKb('search'));
  await page.waitForSelector('[data-knowledge-query]:visible');
}
async function settleSearch(page) {
  await page.waitForTimeout(130);
  await page.waitForFunction(() => [...document.querySelectorAll('.knowledge-search-output')].filter(el => el.getClientRects().length).every(el => !el.__knowledgeTransition && !el.__surfaceSizeTransition));
}
async function query(page, value) { await page.locator('[data-knowledge-query]:visible').fill(value); await settleSearch(page); }
async function readNote(page) {
  await page.evaluate(() => window.nocturneApp.openLoreDetail('notes', 'note-search'));
  await page.locator('.lore-detail-actions [data-action="toggle-note-read-mode"]:visible').click();
  await page.waitForSelector('.note-read-mode:visible');
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  await check('desktop search finds hidden fields and nested records, filters categories, opens dossiers and returns to results', async page => {
    await openSearch(page);
    assert.equal(await page.locator('#kb-modal [data-kb-tab="search"]').count(), 1);
    await query(page, 'Искра');
    assert.equal(await page.locator('.knowledge-result mark').first().innerText(), 'Искра');
    assert.equal(await page.locator('.knowledge-result').count(), 1);
    assert.equal(await page.locator('[data-knowledge-query]').evaluate(input => input === document.activeElement), true);
    await page.locator('[data-result-id="char-search"]').click();
    await page.waitForSelector('.lore-detail[data-lore-id="char-search"]');
    await page.locator('.lore-detail [data-action="back-lore-list"]').click();
    await page.waitForSelector('[data-knowledge-query]:visible');
    assert.equal(await page.locator('[data-knowledge-query]').inputValue(), 'Искра');
    await query(page, 'янтарная');
    await page.locator('[data-result-id="sub-search"]').click();
    await page.waitForSelector('.lore-detail[data-lore-id="sub-search"]');
    await page.locator('.lore-detail [data-action="back-lore-list"]').click();
    await page.waitForSelector('[data-knowledge-query]:visible');
    await query(page, 'Север');
    await page.locator('[data-category="notes"]').click();
    await settleSearch(page);
    assert.equal(await page.locator('.knowledge-result').count(), 1);
    assert.equal(await page.locator('.knowledge-result [data-result-id]').getAttribute('data-result-id'), 'note-search');
    await page.screenshot({ path: join(directory, 'desktop-search-dark.png') });
    await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.theme = 'paper'; a.applySettings(); });
    await page.waitForTimeout(250); await page.screenshot({ path: join(directory, 'desktop-search-paper.png') });
    return { aliases: true, nested: true, retainedQuery: true, category: 'notes' };
  });
  await check('all-project search opens another world safely, reports locked worlds and previews rules', async page => {
    await openSearch(page); await query(page, 'Неоновый');
    assert.equal(await page.locator('.knowledge-result').count(), 0);
    await page.locator('[data-action="knowledge-search-scope"][data-scope="all"]').click();
    await settleSearch(page);
    assert.equal(await page.locator('.knowledge-result').count(), 1);
    assert.match(await page.locator('.knowledge-locked-notice').innerText(), /после разблокировки/);
    await page.locator('[data-result-id="other-note"]').click();
    await page.waitForSelector('.lore-detail[data-lore-id="other-note"]');
    assert.equal(await page.evaluate(() => window.nocturneApp.state.activeLoreId), 'other-world');
    await page.locator('[data-action="back-lore-list"]').click();
    await page.waitForSelector('[data-knowledge-query]:visible');
    await query(page, 'Лазурная');
    await page.locator('[data-result-id="rule-search"]').click();
    await page.waitForSelector('.knowledge-result-preview');
    assert.match(await page.locator('.knowledge-result-preview').innerText(), /Лазурная магия/);
    await page.locator('.knowledge-result-preview [data-close-form]').click();
    await query(page, '<img');
    assert.equal(await page.locator('.knowledge-result img').count(), 0);
    assert.ok(await page.locator('.knowledge-result mark').count() > 0);
    return { otherWorld: true, rulePreview: true, lockedNotice: true, noInjectedImage: true };
  });
  await check('search paginates large result sets and picks up edits without replacing the input', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      a.state.lore.notes = Array.from({ length: 123 }, (_, index) => ({ id: `many-${index}`, title: `Архив ${index}`, body: 'Маркер всех результатов', bookmarks: [], order: index }));
      await a.saveLore();
    });
    await openSearch(page); await query(page, 'Маркер');
    assert.equal(await page.locator('.knowledge-result').count(), 50);
    await page.locator('[data-action="knowledge-search-more"]').click(); await settleSearch(page); assert.equal(await page.locator('.knowledge-result').count(), 100);
    await page.locator('[data-action="knowledge-search-more"]').click(); await settleSearch(page); assert.equal(await page.locator('.knowledge-result').count(), 123);
    await page.evaluate(async () => { const a = window.nocturneApp; a.state.lore.notes[0].body = 'Новый уникальный фрагмент'; await a.saveLore(); });
    await query(page, 'уникальный'); assert.equal(await page.locator('.knowledge-result').count(), 1);
    await query(page, 'ничего-не-находится'); assert.match(await page.locator('.knowledge-search-empty h2').innerText(), /Совпадений нет/);
    return { total: 123, pageSize: 50, liveEdits: true };
  });
  await check('note card exposes only edit and more; menu keeps every action, keyboard focus and completion state', async page => {
    await page.evaluate(() => window.nocturneApp.openKb('notes'));
    const card = page.locator('#kb-sec-notes .note-card'), trigger = card.locator('[data-action="toggle-note-actions"]');
    assert.equal(await card.locator('.lore-card-actions > button').count(), 2);
    await trigger.focus(); await page.keyboard.press('Enter');
    await page.waitForSelector('#note-actions-menu.active');
    assert.equal(await page.locator('#note-actions-menu button').count(), 4);
    await page.keyboard.press('End'); assert.equal(await page.evaluate(() => document.activeElement.dataset.action), 'delete-lore');
    await page.keyboard.press('Escape'); assert.equal(await trigger.evaluate(el => el === document.activeElement), true);
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    await trigger.click(); await page.waitForTimeout(250); await page.screenshot({ path: join(directory, 'desktop-note-menu.png') });
    const appearance = await page.evaluate(() => {
      const note = getComputedStyle(document.getElementById('note-actions-menu')), common = getComputedStyle(document.getElementById('library-menu'));
      const icon = getComputedStyle(document.querySelector('#note-actions-menu .reaper-icon'));
      const card = document.querySelector('#kb-sec-notes .note-card').getBoundingClientRect(), menu = document.getElementById('note-actions-menu').getBoundingClientRect();
      return { shared: ['backgroundColor', 'borderRadius', 'borderColor', 'padding', 'backdropFilter'].every(key => note[key] === common[key]), mask: icon.maskImage, iconBackground: icon.backgroundColor, iconWidth: icon.width, cardRight: card.right, menuLeft: menu.left };
    });
    assert.equal(appearance.shared, true); assert.match(appearance.mask, /reaper_icon\.svg/); assert.notEqual(appearance.iconBackground, 'rgba(0, 0, 0, 0)'); assert.equal(appearance.iconWidth, '18px');
    assert.ok(appearance.menuLeft > appearance.cardRight, JSON.stringify(appearance));
    await page.keyboard.press('Escape');
    await trigger.click(); await page.locator('#note-actions-menu [data-action="toggle-note-completed"]').click();
    await page.waitForFunction(() => window.nocturneApp.state.lore.notes[0].completed);
    await trigger.click(); assert.match(await page.locator('#note-actions-menu button').first().innerText(), /Вернуть в работу/);
    await page.locator('#note-actions-menu [data-action="dump-single-entity"]').click(); await page.waitForSelector('#form-overlay.active');
    await page.evaluate(() => window.nocturneApp.closeOverlay(document.getElementById('form-overlay')));
    await trigger.click(); await page.locator('#note-actions-menu [data-action="clean-note"]').click(); await page.waitForSelector('#cleaner-overlay.active');
    await page.evaluate(() => document.getElementById('cleaner-overlay').classList.remove('active'));
    await trigger.click(); await page.locator('#note-actions-menu [data-action="delete-lore"]').click(); await page.waitForSelector('#form-overlay.active');
    assert.equal(await page.evaluate(() => window.nocturneApp.state.lore.notes.length), 1);
    await page.screenshot({ path: join(directory, 'note-delete-confirmation.png') });
    return { inlineButtons: 2, menuActions: 4, retainedConfirmation: true };
  });
  await check('reading search highlights and navigates literal matches, preserves all text and never searches another note', async page => {
    await readNote(page); await page.keyboard.press('Control+f');
    const input = page.locator('.note-read-mode [data-note-read-query]');
    await input.fill('Северный');
    assert.equal(await page.locator('[data-note-match]').count(), 3);
    assert.equal(await page.locator('.note-read-search-count').innerText(), '1 / 3');
    await page.keyboard.press('Enter'); assert.equal(await page.locator('.note-read-search-count').innerText(), '2 / 3');
    await page.keyboard.press('Shift+Enter'); assert.equal(await page.locator('.note-read-search-count').innerText(), '1 / 3');
    await page.locator('[data-action="note-read-match"][data-direction="-1"]').click();
    assert.equal(await page.locator('.note-read-search-count').innerText(), '3 / 3');
    await page.waitForTimeout(400); assert.ok(await page.locator('.note-read-container').evaluate(el => el.scrollTop) > 0);
    await input.fill('[a+b]'); assert.equal(await page.locator('[data-note-match]').count(), 1);
    await input.fill('письма'); assert.equal(await page.locator('.note-read-title [data-note-match]').count(), 1);
    await input.fill('еж'); assert.equal(await page.locator('[data-note-match]').count(), 1);
    await input.fill('Лазурная'); assert.equal(await page.locator('[data-note-match]').count(), 0);
    assert.equal(await page.locator('[data-action="note-read-match"]').first().isDisabled(), true);
    await input.fill('ветер'); assert.equal(await page.locator('[data-note-match]').count(), 3);
    assert.equal(await page.locator('.note-read-text').innerHTML().then(html => html.includes('<img')), false);
    assert.equal(await page.locator('.note-read-text').textContent(), sampleWorld.notes[0].body.trim());
    await page.screenshot({ path: join(directory, 'note-reading-search.png') });
    await input.press('Escape'); await page.waitForSelector('.note-read-search', { state: 'hidden' });
    assert.equal(await page.locator('[data-note-match]').count(), 0);
    assert.equal(await page.evaluate(() => window.nocturneApp.state.lore.notes[0].body), sampleWorld.notes[0].body.trim());
    await page.evaluate(async () => { const a = window.nocturneApp; a.state.lore.notes[0].body = 'Изменённый текст'; await a.saveLore(); });
    await page.locator('[data-action="toggle-note-read-search"]:visible').click(); await input.fill('Изменённый');
    assert.equal(await page.locator('.note-read-text').textContent(), 'Изменённый текст');
    return { matches: 3, keyboard: true, scrolled: true, unchangedText: true };
  });
  await check('split search opens results in its pane and note searches remain independent', async page => {
    await page.evaluate(() => {
      const a = window.nocturneApp; a.openInPane('primary', { type: 'note-detail', entityType: 'note', entityId: 'note-search', readMode: true });
      a.openSecondaryPane({ type: 'kb-tab', kbTab: 'search' });
    });
    await page.locator('.secondary-pane [data-knowledge-query]').fill('ветер'); await settleSearch(page);
    await page.locator('.secondary-pane [data-result-id="note-search"]').click();
    await page.locator('.secondary-pane [data-action="toggle-note-read-mode"]').click();
    for (const [pane, term] of [['.primary-pane', 'еж'], ['.secondary-pane', 'ветер']]) {
      await page.locator(`${pane} [data-action="toggle-note-read-search"]`).click(); await page.locator(`${pane} [data-note-read-query]`).fill(term);
    }
    assert.equal(await page.locator('.primary-pane [data-note-match]').count(), 1);
    assert.equal(await page.locator('.secondary-pane [data-note-match]').count(), 3);
    await page.screenshot({ path: join(directory, 'split-reading-search.png') });
    return { independentPanes: true };
  });
  await check('search preserves cards and focus, glides layout and filter selection, animates presence and handles rapid input', async page => {
    await openSearch(page);
    await query(page, 'Север');
    const layout = await page.evaluate(async () => {
      const a = window.nocturneApp, output = document.querySelector('.knowledge-search-output'), frames = [];
      const card = output.querySelector('[data-result-id="note-search"]').closest('.knowledge-result'), input = document.querySelector('[data-knowledge-query]');
      const filters = output.querySelector('.knowledge-search-filters'), selection = filters.querySelector('.knowledge-selection'), button = filters.querySelector('[data-category="notes"]');
      const before = { top: card.getBoundingClientRect().top, selection: selection.getBoundingClientRect().left, height: output.getBoundingClientRect().height };
      button.focus(); a.knowledgeSearch().category = 'notes'; a.refreshKnowledgeSearch();
      const started = performance.now();
      while (performance.now() - started < 580) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        frames.push({ time: performance.now() - started, top: card.getBoundingClientRect().top, transform: getComputedStyle(card).transform, flipping: !!card._isFlippingGrid, scroll: output.closest('.kb-main').scrollTop, alpha: Number(getComputedStyle(output).opacity), selection: selection.getBoundingClientRect().left, height: output.getBoundingClientRect().height, ghosts: document.querySelectorAll('.surface-exit-ghost.knowledge-result').length });
      }
      return { before, frames, retained: card === output.querySelector('[data-result-id="note-search"]').closest('.knowledge-result'), retainedFilters: filters === output.querySelector('.knowledge-search-filters'), retainedInput: input === document.querySelector('[data-knowledge-query]'), focused: document.activeElement === button, unlocked: !output.inert };
    });
    await writeFile(join(directory, 'layout-motion.json'), JSON.stringify(layout, null, 2));
    assert.ok(layout.retained && layout.retainedFilters && layout.retainedInput && layout.focused && layout.unlocked);
    const final = layout.frames.at(-1);
    assert.ok(Math.abs(layout.before.top - final.top) > 60, JSON.stringify(layout));
    assert.ok(layout.frames.some(frame => frame.top < layout.before.top - 2 && frame.top > final.top + 2), 'A surviving card travels through intermediate positions');
    assert.ok(layout.frames.every(frame => frame.alpha === 1), 'The result surface never fades away');
    assert.ok(layout.frames.some(frame => frame.selection > layout.before.selection + 2 && frame.selection < final.selection - 2), 'The filter highlight glides between buttons');
    assert.ok(layout.frames.some(frame => frame.height < layout.before.height - 2 && frame.height > final.height + 2), 'The result height changes smoothly');
    assert.ok(layout.frames.some(frame => frame.ghosts > 0), 'Removed cards retain an outgoing visual');
    const entrance = await page.evaluate(async () => {
      const a = window.nocturneApp, frames = [];
      a.knowledgeSearch().category = 'all'; a.refreshKnowledgeSearch();
      const card = document.querySelector('[data-result-id="char-search"]').closest('.knowledge-result'), started = performance.now();
      while (performance.now() - started < 440) { await new Promise(resolve => requestAnimationFrame(resolve)); frames.push({ alpha: Number(getComputedStyle(card).opacity), shift: new DOMMatrix(getComputedStyle(card).transform).m42 }); }
      return frames;
    });
    assert.ok(entrance.some(frame => frame.alpha > .01 && frame.alpha < .99 && frame.shift > .2), 'New cards move into place as they appear');
    const scopeMotion = await page.evaluate(async () => {
      const a = window.nocturneApp, selection = document.querySelector('.knowledge-search-scope .knowledge-selection');
      const before = selection.getBoundingClientRect().left, frames = [];
      a.knowledgeSearch().scope = 'all'; a.refreshKnowledgeSearch();
      const started = performance.now();
      while (performance.now() - started < 430) { await new Promise(resolve => requestAnimationFrame(resolve)); frames.push(selection.getBoundingClientRect().left); }
      return { before, frames };
    });
    assert.ok(scopeMotion.frames.some(left => left > scopeMotion.before + 2 && left < scopeMotion.frames.at(-1) - 2), 'The scope highlight glides between buttons');
    const retarget = await page.evaluate(async () => {
      const a = window.nocturneApp, jumps = [];
      for (const category of ['characters', 'notes', 'all']) {
        const selection = document.querySelector('.knowledge-search-filters .knowledge-selection'), before = selection.getBoundingClientRect();
        a.knowledgeSearch().category = category; a.refreshKnowledgeSearch();
        const after = selection.getBoundingClientRect(); jumps.push(Math.hypot(after.left - before.left, after.top - before.top));
        await new Promise(resolve => setTimeout(resolve, 45));
      }
      return jumps;
    });
    assert.ok(retarget.every(jump => jump < 1), `Rapid filter retargets keep their current visual position: ${retarget}`);
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      for (const term of ['Север', 'Сапфировый', 'полынь', 'Лунная']) { a.knowledgeSearch().query = term; a.refreshKnowledgeSearch(); await new Promise(resolve => setTimeout(resolve, 45)); }
    });
    await settleSearch(page); assert.equal(await page.locator('[data-result-id]').getAttribute('data-result-id'), 'note-search');
    await page.evaluate(async () => { const a = window.nocturneApp; Object.assign(a.state.lore.characters[0], { extra: { one: 'Ключ', two: 'Ключ', three: 'Ключ', four: 'Ключ', five: 'Ключ' } }); await a.saveLore(); });
    await query(page, 'Ключ');
    const details = page.locator('.knowledge-result-more').first(); await details.locator('summary').click();
    assert.equal(await details.evaluate(el => !!el.__surfaceSizeTransition), true);
    await page.waitForTimeout(400); assert.equal(await details.getAttribute('open'), '');
    await details.locator('summary').click(); assert.equal(await details.evaluate(el => !!el.__surfaceSizeTransition), true);
    await readNote(page); await page.locator('[data-action="toggle-note-read-search"]:visible').click();
    const bar = await page.locator('.note-read-search').evaluate(el => ({ content: el.getAnimations().length, height: !!el.parentElement.__surfaceSizeTransition }));
    assert.ok(bar.content > 0 && bar.height);
    await page.locator('[data-note-read-query]').fill('ветер');
    assert.ok(await page.locator('.note-read-text').evaluate(el => el.getAnimations().length) > 0);
    await page.waitForTimeout(350);
    assert.equal(await page.locator('.note-read-search-shell').evaluate(el => el.style.height), '');
    return { layout, entrance, scopeMotion, retarget, disclosure: true, readingPanel: bar, latestQuery: 'Лунная' };
  }, { recordVideo: { dir: join(directory, 'motion-video'), size: { width: 1440, height: 900 } } });
  await check('reduced motion keeps search and reading usable with no retained animated state', async page => {
    await openSearch(page); await query(page, 'янтарная'); assert.equal(await page.locator('.knowledge-result').count(), 1);
    await readNote(page); await page.locator('[data-action="toggle-note-read-search"]:visible').click();
    await page.locator('[data-note-read-query]').fill('ветер'); assert.equal(await page.locator('[data-note-match]').count(), 3);
    await page.locator('[data-action="close-note-read-search"]').click(); await page.waitForSelector('.note-read-search', { state: 'hidden' });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.knowledge-search *, .note-read-mode *')].reduce((count, el) => count + el.getAnimations().length, 0)), 0);
    return { noAnimations: true, correctMatches: true };
  }, { reducedMotion: 'reduce' });
  await check('mobile search and more menu work by touch, preserve keyboard focus and back closes note search first', async page => {
    await openSearch(page);
    assert.equal(await page.locator('[data-mobile-kb-tab]').count(), 5);
    await query(page, 'Лунная'); assert.equal(await page.locator('.knowledge-result').count(), 1);
    assert.equal(await page.locator('[data-knowledge-query]').evaluate(el => el === document.activeElement), true);
    await page.screenshot({ path: join(directory, 'mobile-search.png') });
    await page.locator('[data-result-id="note-search"]').tap();
    await page.locator('.lore-detail-actions [data-action="toggle-note-read-mode"]').tap();
    await page.locator('.note-read-mode [data-action="toggle-note-read-search"]').tap();
    await page.locator('[data-note-read-query]').fill('ветер'); assert.equal(await page.locator('[data-note-match]').count(), 3);
    await page.locator('[data-action="note-read-match"][data-direction="1"]').tap(); assert.equal(await page.locator('.note-read-search-count').innerText(), '2 / 3');
    await page.screenshot({ path: join(directory, 'mobile-reading-search.png') });
    await page.locator('[data-action="note-read-match"][data-direction="-1"]').tap();
    await page.locator('[data-action="note-read-match"][data-direction="-1"]').tap();
    await page.waitForFunction(() => {
      const scroller = document.querySelector('.note-read-container'), rect = scroller.getBoundingClientRect(), mark = scroller.querySelector('mark.current').getBoundingClientRect();
      return mark.top > rect.top && mark.bottom < rect.bottom;
    }, null, { timeout: 2000 });
    const reader = await page.locator('.note-read-container').evaluate(el => ({ height: el.clientHeight, scroll: el.scrollTop, top: el.getBoundingClientRect().top, matchTop: el.querySelector('mark.current').getBoundingClientRect().top }));
    assert.ok(reader.height > 100 && reader.scroll > 0 && reader.matchTop > reader.top && reader.matchTop < 774, JSON.stringify(reader));
    assert.equal(await page.evaluate(() => window.nocturneApp.closeTopMobileOverlay()), true);
    await page.waitForSelector('.note-read-search', { state: 'hidden' });
    assert.equal(await page.locator('.note-read-mode').count(), 1);
    await page.locator('.mobile-panel-header [data-action="toggle-note-read-mode"]').tap();
    await page.locator('[data-action="mobile-lore-back"]').tap();
    assert.equal(await page.locator('[data-knowledge-query]').inputValue(), 'Лунная');
    await page.locator('[data-mobile-kb-tab="notes"]').tap();
    await page.locator('.mobile-lore-card [data-action="toggle-note-actions"]').tap();
    await page.waitForTimeout(250);
    const bounds = await page.locator('#note-actions-menu').boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.y >= 0 && bounds.y + bounds.height <= 844);
    await page.screenshot({ path: join(directory, 'mobile-note-menu.png') });
    await page.locator('#note-actions-menu [data-action="toggle-note-completed"]').tap();
    await page.waitForFunction(() => window.nocturneApp.state.lore.notes[0].completed);
    await page.setViewportSize({ width: 320, height: 740 });
    await page.locator('[data-mobile-kb-tab="search"]').tap();
    await settleSearch(page); await page.waitForTimeout(350);
    await page.screenshot({ path: join(directory, 'mobile-search-320.png') });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    return { touch: true, fiveTabs: true, noOverflow: true, menuWithinViewport: bounds };
  }, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
} finally { await browser?.close(); killOwnedProcess(server); }
if (results.some(result => !result.passed)) process.exitCode = 1;
