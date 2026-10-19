import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5357, url = `http://localhost:${port}`;
const output = process.env.NOCTURNE_QA_DIR || 'release/qa/luna-tutorial';
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const results = [];
let browser;

async function choose(page, locale) {
  await page.locator('#language-onboarding.active').waitFor();
  assert.equal(await page.locator('#luna-tutorial').count(), 0, 'Language choice must come first');
  await page.locator(`[data-choose-language="${locale}"]`).click();
  await page.locator('[data-confirm-language]').click();
  await page.locator('#language-onboarding').waitFor({ state: 'detached' });
  await page.locator('#luna-tutorial[data-step="welcome"]').waitFor({ timeout: 8000 });
}

async function scenario(name, mobile, action, options = {}) {
  if (process.env.NOCTURNE_TUTORIAL_CASE && !name.includes(process.env.NOCTURNE_TUTORIAL_CASE)) {
    results.push({ name, mobile, status: 'SKIP', reason: 'Filtered by NOCTURNE_TUTORIAL_CASE' }); return;
  }
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: mobile, hasTouch: mobile, ...options });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  try {
    await action(page);
    assert.deepEqual(errors, [], 'No uncaught application errors');
    results.push({ name, mobile, status: 'PASS' });
    console.log(`PASS ${name} (${mobile ? 'mobile' : 'desktop'})`);
  } catch (error) {
    await page.screenshot({ path: `${output}/failure-${results.length}.png` }).catch(() => {});
    results.push({ name, mobile, status: 'FAIL', error: error.stack, errors });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}

async function step(page, name) {
  await page.locator(`#luna-tutorial[data-step="${name}"]`).waitFor();
  await page.waitForFunction(() => !window.nocturneApp.lunaTutorial.changing && getComputedStyle(document.querySelector('.luna-dialog')).opacity > .99);
  await page.waitForFunction(() => !document.querySelector('.luna-companion').getAnimations().some(animation => animation.playState === 'running'));
  const geometry = await page.evaluate(() => {
    const dialog = document.querySelector('.luna-dialog').getBoundingClientRect(), mascot = document.querySelector('[data-luna-mascot]').getBoundingClientRect();
    return { x: dialog.x, y: dialog.y, right: dialog.right, bottom: dialog.bottom, mascotX: mascot.x, width: innerWidth, height: innerHeight, overflow: document.documentElement.scrollWidth > innerWidth, titles: document.querySelectorAll('#luna-tutorial h1, #luna-tutorial h2, .luna-dialog-header').length };
  });
  assert.ok(geometry.x >= 20 && geometry.right <= geometry.width - 20 && geometry.y >= 0 && geometry.bottom <= geometry.height, JSON.stringify(geometry));
  assert.ok(geometry.mascotX > geometry.right, 'Luna must be to the right of her speech');
  assert.equal(geometry.overflow, false); assert.equal(geometry.titles, 0);
  return page.locator('[data-luna-target]');
}

async function reachForm(page) {
  await page.locator('[data-luna-choice="yes"]').click();
  if (await page.evaluate(() => window.nocturneApp.lunaTutorial.step === 'open-docs')) {
    await (await step(page, 'open-docs')).click();
  }
  await (await step(page, 'create')).click();
  await step(page, 'create-form');
}

async function discoverFeatures(page, mobile, { stopAt, keyboardPalette = false } = {}) {
  const click = async name => (await step(page, name)).click();
  const next = async name => { await step(page, name); await page.locator('[data-luna-choice="next"]').click(); };
  const shot = async name => page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-${name}.png` });
  await next('write');
  if (mobile) await click('bookmarks-actions');
  await click('open-bookmarks'); await step(page, 'bookmarks'); await shot('bookmarks');
  await page.locator('[data-luna-choice="back"]').click(); await step(page, 'write');
  await next('write');
  if (mobile) await click('bookmarks-actions');
  await click('open-bookmarks'); await next('bookmarks');
  if (mobile) await click('more-notes');
  await step(page, 'open-notes');
  const notesCue = await page.evaluate(() => {
    const target = document.querySelector('[data-luna-target]').getBoundingClientRect();
    const ring = document.querySelector('.luna-spotlight').getBoundingClientRect();
    return { target: { x: target.x, y: target.y, right: target.right, bottom: target.bottom }, ring: { x: ring.x, y: ring.y, right: ring.right, bottom: ring.bottom }, width: innerWidth };
  });
  await page.waitForTimeout(320);
  await shot('notes-button');
  assert.ok(notesCue.ring.x <= notesCue.target.x && notesCue.ring.right >= Math.min(notesCue.width - 5, notesCue.target.right));
  assert.ok(notesCue.ring.y <= notesCue.target.y && notesCue.ring.bottom >= notesCue.target.bottom);
  await click('open-notes'); await next('notes');
  await click('open-floating'); await step(page, 'floating');
  const floatingLayout = await page.evaluate(() => {
    const coach = document.querySelector('.luna-companion').getBoundingClientRect(), panel = document.querySelector('.floating-notes-modal-panel').getBoundingClientRect();
    return { clear: coach.right <= panel.left - 8 || coach.left >= panel.right + 8 || coach.bottom <= panel.top - 8 || coach.top >= panel.bottom + 8, center: (panel.left + panel.right) / 2, width: innerWidth };
  });
  assert.equal(floatingLayout.clear, true, 'Luna leaves the whole All Notes window clear');
  assert.ok(Math.abs(floatingLayout.center - floatingLayout.width / 2) < 2);
  await shot('floating'); await next('floating');
  await click('open-kb');
  if (!mobile) { await (await step(page, 'kb-menu')).focus(); await page.keyboard.press('Enter'); }
  await next('kb'); await click('open-world-search'); await step(page, 'world-search');
  await page.locator('[data-knowledge-query]:visible').fill('A real story');
  await shot('world-search'); await next('world-search');
  if (!mobile) await click('tools-commands');
  if (keyboardPalette && !mobile) { await step(page, 'open-commands'); await page.keyboard.press('Control+k'); }
  else await click('open-commands');
  await step(page, 'commands');
  await page.locator('[data-command-palette-input]').fill('history');
  await click('command-history'); await step(page, 'history');
  if (!mobile) assert.ok(await page.locator('.history-modal').evaluate(element => Math.abs(innerWidth - element.getBoundingClientRect().right - 32) < 2));
  await shot('history'); await next('history');
  await click('open-modes'); await click('choose-editor'); await step(page, 'editor-mode');
  assert.equal(await page.locator('.page-content-prosemirror').first().getAttribute('contenteditable'), 'false');
  await next('editor-mode'); await click('open-finalization'); await click('choose-finalization');
  await step(page, 'finalization'); await shot('review'); await next('finalization');
  if (mobile) await click('focus-actions');
  const zenButton = mobile || await page.locator('[data-action="toggle-zen"]:visible').count();
  if (zenButton) {
    await click('enter-focus'); await step(page, 'focus');
    assert.equal(await page.evaluate(() => window.nocturneApp.state.zenActive), true);
  } else {
    await click('focus-settings'); await click('focus-tab'); await step(page, 'focus-options');
  }
  await shot('focus');
  if (stopAt === 'focus') return;
  await next(zenButton ? 'focus' : 'focus-options');
  if (!mobile) { await click('open-split'); await step(page, 'split'); await shot('split'); await next('split'); }
  if (mobile) await click('more-search'); else await click('open-search-menu');
  await click('open-search'); await click('choose-project-search'); await step(page, 'project-search');
  await page.locator('#global-search-query').fill('A real story');
  await page.waitForFunction(() => document.querySelector('#global-search-results')?.textContent.includes('A real story'));
  await shot('manuscript-search'); await next('project-search');
  await click(mobile ? 'more-book' : 'tools-book'); await click('open-book');
  await step(page, 'book'); assert.equal(await page.locator('[data-export-chapter]').count(), 1);
  assert.ok(await page.locator('.book-export-modal').evaluate(element => Math.abs((element.getBoundingClientRect().left + element.getBoundingClientRect().right) / 2 - innerWidth / 2) < 2));
  await page.locator('label:has([data-export-chapter])').click();
  assert.equal(await page.locator('[data-export-chapter]').isChecked(), false);
  assert.equal(await page.locator('[data-export-selected-book]').isDisabled(), true);
  await page.locator('label:has([data-export-chapter])').click();
  assert.equal(await page.locator('[data-export-chapter]').isChecked(), true);
  await shot('book'); await next('book');
  await click(mobile ? 'more-backups' : 'tools-backups'); await click('open-backups');
  await step(page, 'backups'); await shot('backups'); await next('backups');
  if (mobile) await click('more-settings');
  await click('open-settings'); await step(page, 'settings');
  if (mobile) {
    await page.evaluate(async () => await window.nocturneApp.interfaceLanguage.change('en'));
    await page.waitForFunction(() => document.querySelector('#luna-tutorial-text')?.textContent.startsWith('Change your language'));
  }
  await next('settings'); await click('open-macros'); await step(page, 'macros'); await shot('macros');
  await next('macros'); await click('open-formatting'); await step(page, 'formatting'); await shot('formatting');
  await next('formatting'); await step(page, 'done');
  await page.locator('[data-luna-choice="back"]').click(); await next('formatting');
  assert.equal(await page.evaluate(() => window.nocturneApp.state.reviewMode), 'write');
  assert.equal(await page.evaluate(() => window.nocturneApp.state.zenActive), false);
  assert.equal(await page.evaluate(() => window.nocturneApp.state.workspace.mode), 'single');
  assert.deepEqual(await page.evaluate(async () => (await import('/src/core/i18n.js')).getMissingTranslations()), []);
}

try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 1919, height: 950 }, { width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const mobile = viewport.width < 768;
    await scenario(`knowledge overview leaves character cards visible: ${viewport.width}`, mobile, async page => {
      await page.goto(url); await choose(page, 'ru'); await step(page, 'welcome');
      await page.locator('[data-luna-choice="yes"]').click(); await step(page, 'create');
      await page.evaluate(async () => {
        const app = window.nocturneApp;
        if (app.isMobileLayout()) { app.state.mobile.kbTab = 'characters'; app.switchMobileTab('lore'); }
        else app.openKb('characters');
        await app.lunaTutorial.show('kb');
      });
      await step(page, 'kb');
      const card = page.locator(mobile ? '#mobile-tab-surface.active .mobile-kb-list > .empty-card' : '#kb-modal.active .kb-section.active .character-grid > .empty-card').first();
      await card.waitFor();
      const geometry = await page.evaluate(selector => {
        const c = document.querySelector('.luna-companion').getBoundingClientRect(), content = document.querySelector(selector).getBoundingClientRect();
        return { coach: { x: c.x, y: c.y, right: c.right, bottom: c.bottom }, content: { x: content.x, y: content.y, right: content.right, bottom: content.bottom }, height: innerHeight };
      }, mobile ? '#mobile-tab-surface.active .mobile-kb-list > .empty-card' : '#kb-modal.active .kb-section.active .character-grid > .empty-card');
      assert.ok(geometry.coach.y >= geometry.content.bottom + 20, `Luna must move below the character card: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.coach.bottom <= geometry.height - 12);
      await page.screenshot({ path: `${output}/knowledge-clear-${viewport.width}.png` });
      await page.locator('[data-luna-choice="next"]').click(); await step(page, 'open-world-search');
      const stillClear = await page.evaluate(selector => {
        const c = document.querySelector('.luna-companion').getBoundingClientRect(), content = document.querySelector(selector).getBoundingClientRect();
        return c.bottom <= content.top - 16 || c.top >= content.bottom + 16 || c.right <= content.left - 16 || c.left >= content.right + 16;
      }, mobile ? '#mobile-tab-surface.active .mobile-kb-list > .empty-card' : '#kb-modal.active .kb-section.active .character-grid > .empty-card');
      assert.ok(stillClear, 'The following action keeps the character card clear');
      await page.keyboard.press('Escape'); await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => window.nocturneApp.state.lore.characters.length), 0);
    }, { viewport });
  }
  for (const mobile of [false, true]) await scenario('quick refusal works during the welcome animation', mobile, async page => {
    await page.addInitScript(() => {
      const observer = new MutationObserver(() => {
        const button = document.querySelector('[data-luna-choice="no"]');
        if (!button || !window.nocturneApp?.lunaTutorial?.active) return;
        window.__quickRefusal = { changing: window.nocturneApp.lunaTutorial.changing };
        observer.disconnect(); button.click();
      });
      observer.observe(document, { childList: true, subtree: true });
    });
    await page.goto(url); await page.locator('#language-onboarding.active').waitFor();
    await page.locator('[data-choose-language="en"]').click(); await page.locator('[data-confirm-language]').click();
    await page.waitForFunction(() => window.nocturneApp?.startupInteractionReady);
    assert.equal(await page.evaluate(() => window.__quickRefusal.changing), true);
    assert.equal(await page.locator('#luna-tutorial').count(), 0);
    assert.equal(await page.evaluate(async () => (await window.nocturneApp.db.get('settings', 'luna-tutorial')).status), 'skipped');
  });
  for (const fixture of [
    { width: 1440, height: 1000 }, { width: 1920, height: 1080 },
    { width: 1280, height: 720 }, { width: 390, height: 844, mobile: true },
    { width: 1440, height: 1000, reduced: true },
  ]) await scenario(`centered creation form waits for Luna: ${fixture.width}x${fixture.height}${fixture.reduced ? ' reduced' : ''}`, !!fixture.mobile, async page => {
    await page.goto(url); await choose(page, 'en'); await page.locator('[data-luna-choice="yes"]').click();
    if (await page.evaluate(() => window.nocturneApp.lunaTutorial.step === 'open-docs')) await (await step(page, 'open-docs')).click();
    await step(page, 'create');
    await page.evaluate(() => {
      window.__creationFrames = [];
      const until = performance.now() + 1500;
      const sample = () => {
        const companion = document.querySelector('.luna-companion');
        if (!companion) return;
        const coach = companion.getBoundingClientRect();
        const overlay = document.getElementById('form-overlay'), form = document.getElementById('doc-form');
        window.__creationFrames.push({ active: overlay.classList.contains('active'), x: coach.x, y: coach.y, right: coach.right, bottom: coach.bottom, form: form ? { x: overlay.offsetLeft + form.offsetLeft, y: overlay.offsetTop + form.offsetTop, right: overlay.offsetLeft + form.offsetLeft + form.offsetWidth, bottom: overlay.offsetTop + form.offsetTop + form.offsetHeight } : null });
        if (performance.now() < until) requestAnimationFrame(sample);
      };
      sample();
    });
    const target = await step(page, 'create');
    if (fixture.width === 1920) { await target.focus(); await page.keyboard.press('Enter'); } else await target.click();
    await page.locator('#form-overlay.active #doc-form').waitFor(); await step(page, 'create-form');
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => {
      const form = document.querySelector('#doc-form').getBoundingClientRect();
      return { form: { x: form.x, y: form.y, right: form.right, bottom: form.bottom }, width: innerWidth, height: innerHeight, frames: window.__creationFrames };
    });
    assert.ok(Math.abs((state.form.x + state.form.right) / 2 - state.width / 2) < 2, 'The document form keeps its normal horizontal center');
    if (fixture.mobile) assert.ok(await page.locator('#doc-form button[type="submit"]').evaluate(button => button.getBoundingClientRect().bottom <= button.closest('form').getBoundingClientRect().bottom - 4), 'The mobile form shows Create without unnecessary scrolling');
    if (fixture.height >= 900) assert.ok(Math.abs((state.form.y + state.form.bottom) / 2 - state.height / 2) < 2, 'A normal desktop form keeps its vertical center');
    const opened = state.frames.find(sample => sample.active);
    assert.ok(opened?.form, 'Opening the real native form was observed');
    assert.ok(opened.right <= opened.form.x - 8 || opened.x >= opened.form.right + 8 || opened.bottom <= opened.form.y - 8 || opened.y >= opened.form.bottom + 8, `Luna must clear the form before it opens: ${JSON.stringify(opened)}`);
    if (fixture.width === 1440 && !fixture.reduced) {
      const initial = state.frames[0];
      assert.ok(state.frames.filter(sample => !sample.active && Math.abs(sample.y - initial.y) > 3 && Math.abs(sample.y - opened.y) > 3).length > 2, 'Luna visibly moves before the form opens');
    }
    await page.locator('#doc-form input[name="title"]').fill('Centered without losing input');
    await page.screenshot({ path: `${output}/centered-form-${fixture.width}-${fixture.height}${fixture.reduced ? '-reduced' : ''}.png` });
    await page.locator('#doc-form [data-close-form]').click(); await step(page, 'create');
    await (await step(page, 'create')).click(); await page.locator('#form-overlay.active #doc-form').waitFor(); await step(page, 'create-form');
    await page.locator('#doc-form input[name="title"]').fill('Second opening survives skip');
    await page.keyboard.press('Escape'); await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
    assert.equal(await page.locator('#doc-form input[name="title"]').inputValue(), 'Second opening survives skip');
    await page.locator('#doc-form button[type="submit"]').click(); await page.waitForFunction(() => window.nocturneApp.state.docs.length === 1);
  }, { viewport: { width: fixture.width, height: fixture.height }, reducedMotion: fixture.reduced ? 'reduce' : 'no-preference' });
  for (const mobile of [false, true]) for (const motion of ['normal', 'reduced', ...(mobile ? ['application'] : [])]) {
    await scenario(`spotlight motion remains aligned and usable: ${motion}`, mobile, async page => {
      await page.goto(url); await choose(page, 'en'); await step(page, 'welcome');
      const letters = await page.locator('.luna-letter').evaluateAll(nodes => nodes.map(node => Number(getComputedStyle(node).opacity)));
      assert.ok(letters.length > 10);
      if (motion === 'normal') assert.ok(Math.max(...letters) - Math.min(...letters) > .2, 'Text gently reveals one letter after another');
      await page.evaluate(reduce => { window.nocturneApp.state.settings.reduceMobileAnimations = reduce; }, motion === 'application');
      if (!mobile) await page.evaluate(() => { document.body.classList.add('theme-paper'); });
      await page.locator('[data-luna-choice="yes"]').click();
      if (await page.evaluate(() => window.nocturneApp.lunaTutorial.step === 'open-docs')) await (await step(page, 'open-docs')).click();
      await step(page, 'create');
      await page.waitForFunction(() => {
        const spot = document.querySelector('.luna-spotlight');
        return spot.dataset.kind === 'action' && Number(getComputedStyle(spot).opacity) > .99;
      });
      await page.evaluate(() => {
        window.__spotlightFrames = [];
        const until = performance.now() + 800;
        const sample = () => {
          const ring = document.querySelector('.luna-spotlight'), hole = document.querySelector('.luna-cutout');
          const r = ring.getBoundingClientRect(), d = document.querySelector('.luna-dialog');
          window.__spotlightFrames.push({ x: r.x, y: r.y, width: r.width, height: r.height, opacity: Number(getComputedStyle(ring).opacity), holeOpacity: Number(getComputedStyle(hole).opacity), hole: ['x', 'y', 'width', 'height'].map(key => Number(hole.getAttribute(key))), shellOpacity: Number(getComputedStyle(d).opacity), tailVisible: document.querySelector('.luna-dialog-tail').checkVisibility() });
          if (performance.now() < until) requestAnimationFrame(sample);
        };
        sample();
      });
      await (await step(page, 'create')).click(); await step(page, 'create-form');
      await page.locator('#doc-form input[name="title"]').fill('Motion preserves this title');
      await page.waitForTimeout(850);
      const state = await page.evaluate(() => {
        const spot = document.querySelector('.luna-spotlight'), hole = document.querySelector('.luna-cutout');
        const ring = spot.getBoundingClientRect(), target = document.querySelector('[data-luna-target]').getBoundingClientRect();
        return { kind: spot.dataset.kind, ring: { x: ring.x, y: ring.y, width: ring.width, height: ring.height }, target: { x: target.x, y: target.y, right: target.right, bottom: target.bottom }, hole: ['x', 'y', 'width', 'height'].map(key => Number(hole.getAttribute(key))), samples: window.__spotlightFrames, animations: document.querySelector('#luna-tutorial').getAnimations({ subtree: true }).filter(a => a.playState === 'running').length, reduced: document.querySelector('#luna-tutorial').classList.contains('luna-reduced'), pointerEvents: getComputedStyle(spot).pointerEvents, width: innerWidth, height: innerHeight };
      });
      assert.equal(state.kind, 'panel');
      assert.equal(state.pointerEvents, 'none');
      assert.ok(state.samples.length > 3);
      for (const sample of state.samples) {
        for (const [index, key] of ['x', 'y', 'width', 'height'].entries()) assert.ok(Math.abs(sample[key] - sample.hole[index]) < 1, `Mask and ring diverged: ${JSON.stringify(sample)}`);
        assert.ok(Math.abs(sample.opacity - sample.holeOpacity) < .01, 'The mask and border fade together');
        assert.equal(sample.shellOpacity, 1, 'The speech surface stays present between messages');
        assert.equal(sample.tailVisible, true, 'The speech tail remains visible during resizing');
      }
      assert.ok(Math.abs(state.ring.x - Math.max(5, state.target.x - 6)) < 2);
      assert.ok(Math.abs(state.ring.y - Math.max(5, state.target.y - 6)) < 2);
      assert.ok(state.ring.x + state.ring.width <= state.width && state.ring.y + state.ring.height <= state.height);
      assert.equal(state.animations, 0, 'The guide settles instead of pulsing forever');
      assert.equal(state.reduced, motion !== 'normal');
      if (motion === 'normal') {
        assert.ok(state.samples.some(sample => sample.opacity > .15 && sample.opacity < .85), 'The highlight fades through intermediate opacity');
        const fromWidth = state.samples[0].width, toWidth = state.ring.width;
        assert.ok(state.samples.filter(sample => sample.opacity > .1).every(sample => Math.abs(sample.width - fromWidth) < 12 || Math.abs(sample.width - toWidth) < 25), 'The highlight fades at its targets instead of travelling across the screen');
      }
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-spotlight-${motion}.png` });
      await page.keyboard.press('Escape'); await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#doc-form input[name="title"]').inputValue(), 'Motion preserves this title');
      assert.equal(await page.locator('[data-luna-target]').count(), 0);
    }, { reducedMotion: motion === 'reduced' ? 'reduce' : 'no-preference' });
  }
  for (const mobile of [false, true]) await scenario('spotlight motion can be interrupted without stale overlays', mobile, async page => {
    await page.goto(url); await choose(page, 'en'); await page.locator('[data-luna-choice="yes"]').click();
    if (await page.evaluate(() => window.nocturneApp.lunaTutorial.step === 'open-docs')) await (await step(page, 'open-docs')).click();
    await (await step(page, 'create')).click();
    await page.waitForFunction(() => window.nocturneApp.lunaTutorial.changing);
    await page.keyboard.press('Escape'); await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
    assert.equal(await page.locator('[data-luna-target], .luna-tutorial-active, .luna-form-preview').count(), 0);
    await page.locator('#doc-form input[name="title"]').fill('Continue after skipping');
    await page.locator('#doc-form button[type="submit"]').click();
    await page.waitForFunction(() => window.nocturneApp.nocturneEditor?.get('primary'));
    await page.locator('.page-content-prosemirror').first().fill('Typing still works.');
    assert.match(await page.locator('.page-content-prosemirror').first().textContent(), /Typing still works\./);
  });
  for (const mobile of [false, true]) for (const locale of ['ru', 'uk', 'en']) {
    await scenario(`localized greeting and persistent No: ${locale}`, mobile, async page => {
      await page.goto(url); await choose(page, locale);
      const title = await page.locator('#luna-tutorial-text').textContent();
      assert.match(title, { ru: /Я Луна/, uk: /Я Луна/, en: /I’m Luna/ }[locale]);
      assert.equal(await page.locator('[data-luna-mascot]').count(), 1);
      assert.equal(await page.locator('[data-luna-choice="yes"]').count(), 1);
      assert.equal((await page.locator('[data-luna-choice="yes"]').textContent()).trim(), { ru: 'Да', uk: 'Так', en: 'Yes' }[locale]);
      assert.equal((await page.locator('[data-luna-choice="no"]').textContent()).trim(), { ru: 'Нет', uk: 'Ні', en: 'No' }[locale]);
      await step(page, 'welcome');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.lunaChoice), 'yes', 'Reverse Tab starts at the last button');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.lunaChoice), 'no', 'Tab wraps from the last button to the first');
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-${locale}-welcome.png` });
      await page.locator('[data-luna-choice="no"]').click();
      await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(async () => (await window.nocturneApp.db.get('settings', 'luna-tutorial')).status), 'skipped');
      assert.equal(await page.evaluate(() => window.nocturneApp.state.docs.length), 0, 'Declining must not create manuscripts');
      await page.reload(); await page.waitForFunction(() => window.nocturneApp?.startupInteractionReady);
      assert.equal(await page.locator('#luna-tutorial, #language-onboarding').count(), 0);
    });
  }
  for (const mobile of [false, true]) {
    await scenario('complete tour uses real controls and preserves written text', mobile, async page => {
      await page.goto(url); await choose(page, mobile ? 'uk' : 'en');
      await reachForm(page);
      await page.locator('#doc-form input[name="title"]').fill('My story — Моя історія');
      await page.locator('#doc-form button[type="submit"]').click();
      await step(page, 'write');
      const editor = page.locator('.page-content-prosemirror').first();
      await editor.press('Control+Home'); await page.keyboard.type('A real story.');
      await page.evaluate(() => {
        const a = window.nocturneApp;
        window.__tutorialEditor = a.nocturneEditor.get('primary');
        window.__tutorialJson = window.__tutorialEditor.getJSON();
      });
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-writing.png` });
      await discoverFeatures(page, mobile);
      assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary') === window.__tutorialEditor), true, 'Tour must retain the live editor');
      assert.deepEqual(await page.evaluate(() => window.__tutorialEditor.getJSON()), await page.evaluate(() => window.__tutorialJson));
      await page.evaluate(() => window.__tutorialEditor.commands.undo());
      assert.notDeepEqual(await page.evaluate(() => window.__tutorialEditor.getJSON()), await page.evaluate(() => window.__tutorialJson), 'Undo must survive every preview');
      await page.evaluate(() => window.__tutorialEditor.commands.redo());
      assert.deepEqual(await page.evaluate(() => window.__tutorialEditor.getJSON()), await page.evaluate(() => window.__tutorialJson));
      await step(page, 'done');
      assert.equal(await page.locator('[data-luna-choice="skip"]').count(), 1);
      await page.locator('[data-luna-choice="done"]').click();
      await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
      if (!mobile) {
        await page.evaluate(async () => await window.nocturneApp.showHistory());
        await page.waitForTimeout(350);
        assert.ok(await page.locator('.history-modal').evaluate(element => Math.abs(innerWidth - element.getBoundingClientRect().right - 32) < 2), 'History keeps its right-hand position outside the tour');
        await page.evaluate(() => document.getElementById('form-overlay').classList.remove('active'));
      }
      assert.equal(await page.evaluate(async () => (await window.nocturneApp.db.get('settings', 'luna-tutorial')).status), 'completed');
      assert.equal(await page.evaluate(() => window.nocturneApp.state.docs.length), 1);
      assert.match(await editor.textContent(), /A real story\./);
      await page.evaluate(async () => { await window.nocturneApp.flushOpenDocuments(); });
      const before = await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs'));
      const dumped = await page.evaluate(async () => {
        const a = window.nocturneApp, dump = await a.buildNocturneDump();
        window.__tutorialDump = dump;
        return JSON.stringify(dump).includes('"id":"luna-tutorial"');
      });
      assert.equal(dumped, false, 'Tutorial state is local and must not travel with manuscripts');
      await page.evaluate(async () => {
        const a = window.nocturneApp;
        window.__tutorialPreference = await a.db.getRaw('settings', 'luna-tutorial');
        window.__tutorialDump.payload.settingsRecords.push({ id: 'luna-tutorial', version: 1, status: 'skipped', updatedAt: 1 });
        await a.persistImportedProject(window.__tutorialDump.payload);
      });
      assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getRaw('settings', 'luna-tutorial')), await page.evaluate(() => window.__tutorialPreference), 'Replacing a project must preserve this device’s tutorial preference');
      assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs')), before);
      await page.reload(); await page.waitForFunction(() => window.nocturneApp?.startupInteractionReady);
      assert.equal(await page.locator('#luna-tutorial').count(), 0);
      assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs')), before, 'Reload must preserve the document exactly');
      await page.evaluate(() => { const a = window.nocturneApp; if (a.isMobileLayout()) a.openMobilePanel('settings', 'more', { settingsTab: 'misc' }); else a.openSettingsTab('misc'); });
      await page.locator('[data-action="start-tutorial"]:visible').click();
      await step(page, 'welcome');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.closest('#luna-tutorial') !== null), true);
      await page.keyboard.press('Escape');
      await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs')), before, 'Replaying and skipping must preserve manuscripts');
    });
    await scenario('skip keeps an unfinished form and restores modal focus', mobile, async page => {
      await page.goto(url); await choose(page, 'ru'); await reachForm(page);
      await page.locator('#doc-form input[name="title"]').fill('Не потерять введённое');
      await page.screenshot({ path: `${output}/${mobile ? 'mobile' : 'desktop'}-form.png` });
      await page.locator('[data-luna-choice="skip"]').click();
      await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
      assert.equal(await page.locator('#doc-form input[name="title"]').inputValue(), 'Не потерять введённое');
      assert.equal(await page.evaluate(() => document.activeElement?.closest('#doc-form') !== null), true);
      assert.equal(await page.evaluate(() => window.nocturneApp.state.docs.length), 0);
      assert.equal(await page.locator('[data-luna-target]').count(), 0);
      await page.locator('#doc-form button[type="submit"]').click();
      await page.waitForFunction(() => window.nocturneApp.state.docs.length === 1);
    }, { reducedMotion: mobile ? 'reduce' : 'no-preference' });
  }
  for (const mobile of [false, true]) await scenario('skip restores the original mode and hidden focus controls stay reachable', mobile, async page => {
    await page.goto(url); await choose(page, 'en');
    await page.locator('[data-luna-choice="no"]').click();
    await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
    const before = await page.evaluate(async mobile => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Existing chapter', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>A real story.</p>');
      await a.flushOpenDocuments();
      a.state.settings.showZenButton = false; a.applySettings();
      a.setReviewMode('finalization'); await a.toggleZen(mobile);
      a.openSettingsTab('misc');
      return await a.db.getAllRaw('docs');
    }, mobile);
    await page.locator('[data-action="start-tutorial"]:visible').click();
    await step(page, 'welcome'); await page.locator('[data-luna-choice="yes"]').click();
    await discoverFeatures(page, mobile, { stopAt: 'focus', keyboardPalette: true });
    await page.keyboard.press('Escape'); await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.nocturneApp.state.reviewMode), 'finalization');
    assert.equal(await page.evaluate(() => !!window.nocturneApp.state.zenActive), mobile);
    assert.equal(await page.evaluate(() => window.nocturneApp.state.settings.showZenButton), false);
    assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs')), before);
  }, { reducedMotion: 'reduce' });
  await scenario('existing profile, resizing, locale changes and Android Back leave manuscripts intact', false, async page => {
    await page.goto(url); await choose(page, 'ru');
    await page.locator('[data-luna-choice="no"]').click();
    await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Авторский документ', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>Existing manuscript. Авторский текст.</p>');
      await a.flushOpenDocuments();
      window.__existingRows = await a.db.getAllRaw('docs');
      await a.db.delete('settings', 'luna-tutorial');
    });
    const before = await page.evaluate(() => window.__existingRows);
    await page.reload(); await step(page, 'welcome');
    assert.equal(await page.locator('#language-onboarding').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await step(page, 'welcome');
    await page.locator('[data-luna-choice="yes"]').click(); await step(page, 'write');
    assert.equal(await page.locator('#doc-form').count(), 0, 'Use the existing document without creating a demo');
    await page.locator('[data-luna-choice="next"]').click();
    await (await step(page, 'bookmarks-actions')).click();
    await (await step(page, 'open-bookmarks')).click(); await step(page, 'bookmarks');
    await page.locator('[data-luna-choice="next"]').click();
    await (await step(page, 'more-notes')).click();
    await (await step(page, 'open-notes')).click(); await step(page, 'notes');
    await page.setViewportSize({ width: 1280, height: 900 }); await step(page, 'notes');
    await page.locator('[data-luna-choice="next"]').click();
    await (await step(page, 'open-floating')).click(); await step(page, 'floating');
    await page.locator('[data-luna-choice="next"]').click();
    await (await step(page, 'open-kb')).click(); await step(page, 'kb-menu');
    await page.setViewportSize({ width: 390, height: 844 }); await step(page, 'world-search');
    await page.evaluate(async () => await window.nocturneApp.interfaceLanguage.change('en'));
    await page.waitForFunction(() => document.querySelector('#luna-tutorial-text')?.textContent.startsWith('Find characters'));
    await step(page, 'world-search');
    await page.evaluate(() => window.nocturneApp.closeTopMobileOverlay());
    await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(async () => await window.nocturneApp.db.getAllRaw('docs')), before);
    assert.equal(await page.locator('.luna-tutorial-active').count(), 0);
  });
  await scenario('preference write failure exits safely and offers the tutorial again', true, async page => {
    await page.goto(url); await choose(page, 'en');
    await page.evaluate(() => {
      const db = window.nocturneApp.db, put = db.put.bind(db);
      db.put = (store, record, ...args) => record.id === 'luna-tutorial' ? Promise.reject(new Error('Simulated quota failure')) : put(store, record, ...args);
    });
    await page.locator('[data-luna-choice="no"]').click();
    await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
    await page.waitForFunction(() => window.nocturneApp.startupInteractionReady);
    assert.equal(await page.evaluate(async () => !!await window.nocturneApp.db.get('settings', 'luna-tutorial')), false);
    assert.equal(await page.evaluate(() => document.getElementById('app').inert), false);
    await page.reload(); await step(page, 'welcome');
    await page.keyboard.press('Escape');
    await page.locator('#luna-tutorial').waitFor({ state: 'detached' });
  }, { reducedMotion: 'reduce' });
} finally {
  await browser?.close(); server.kill();
  await writeFile(`${output}/results.json`, JSON.stringify({ results }, null, 2));
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
