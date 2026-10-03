import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = 'http://localhost:5311';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5311', SYNC_PORT: '8911' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function check(name, run) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(url); await page.waitForSelector('#preloader.hidden', { state: 'attached' });
    await page.evaluate(async () => { const a = window.nocturneApp; a.state.settings.automaticBackups = false; await a.createDoc(a.defaultFolderId(), 'Editor regression', ''); });
    await run(page); results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  finally { await context.close(); }
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  await check('F12 smart speller checks queued words in the active manuscript', async page => {
    await page.evaluate(() => { const a = window.nocturneApp; a.nocturneEditor.get('primary').commands.setContent('<p>teh</p>'); a.nocturneEditor.syncDocFromEditor('primary'); a.spellerQueue = new Set(['teh']); a.spellerPending = new Set(); a.spellerCache = new Map(); a.scheduleSpellerCheck(); });
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.nocturneApp.spellerCache.has('teh')), true);
  });
  await check('F13 analysis decorations span marked text and settings never alter manuscript JSON', async page => {
    const result = await page.evaluate(() => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary');
      e.commands.setContent('<p>Описание. «<strong>Диалог</strong> продолжается» (мысли героя) очень сильно</p>');
      const before = JSON.stringify(e.getJSON()); a.state.settings.writerSyntax = true; a.state.settings.showDontTell = true; a.applySettings();
      const enabled = ['syntax-dialogue', 'syntax-thought', 'weak-word'].map(cls => e.view.dom.querySelectorAll(`.${cls}`).length);
      a.state.settings.writerSyntax = false; a.state.settings.showDontTell = false; a.applySettings();
      return { enabled, disabled: e.view.dom.querySelectorAll('.syntax-dialogue,.syntax-thought,.weak-word').length, unchanged: before === JSON.stringify(e.getJSON()) };
    });
    assert.ok(result.enabled.every(count => count > 0), JSON.stringify(result)); assert.equal(result.disabled, 0); assert.equal(result.unchanged, true);
  });
  await check('F13 dialogue lens works independently from writer syntax', async page => {
    const result = await page.evaluate(() => {
      const a = window.nocturneApp, e = a.nocturneEditor.get('primary'); e.commands.setContent('<p>Description. «Dialogue» More.</p>');
      a.state.settings.writerSyntax = false; a.state.settings.dialogueLens = 'dialogues'; a.applySettings();
      const dialogue = e.view.dom.querySelector('.syntax-dialogue'), description = e.view.dom.querySelector('.syntax-description');
      return { dialogue: !!dialogue, description: !!description, opacity: description ? Number(getComputedStyle(description).opacity) : 1, paragraph: Number(getComputedStyle(e.view.dom.querySelector('p')).opacity) };
    });
    assert.equal(result.dialogue, true); assert.equal(result.description, true); assert.ok(result.opacity < 1); assert.equal(result.paragraph, 1);
  });
  await check('F14 punctuation converts typed quotes ellipsis and dash and respects disabling', async page => {
    await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.smartPunctuation = true; a.state.settings.autoReplaceDoubleDash = false; a.nocturneEditor.get('primary').commands.setContent('<p></p>'); a.nocturneEditor.get('primary').commands.focus('end'); });
    await page.keyboard.type('"Text" ... --', { delay: 5 });
    assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), '«Text» … —');
    await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.smartPunctuation = false; a.nocturneEditor.get('primary').commands.setContent('<p></p>'); a.nocturneEditor.get('primary').commands.focus('end'); });
    await page.keyboard.type('"Text" ... --', { delay: 5 });
    assert.equal(await page.evaluate(() => window.nocturneApp.nocturneEditor.get('primary').getText()), '"Text" ... --');
  });
  await check('F15 fifteen continuously typed words count as writing', async page => {
    await page.evaluate(async () => { const a = window.nocturneApp; const e = a.nocturneEditor.get('primary'); e.commands.setContent('<p></p>'); await a.db.clear('stats'); a.docWordBaselines.set(a.getFocusedDoc().id, 0); a.docHighWatermarks.set(a.getFocusedDoc().id, 0); e.commands.focus('end'); });
    await page.keyboard.type(Array.from({ length: 15 }, (_, i) => `word${i}`).join(' '));
    await page.evaluate(async () => { const a = window.nocturneApp; await a.saveActiveDoc({ silent: true }); });
    const words = await page.evaluate(async () => (await window.nocturneApp.db.getAll('stats')).reduce((sum, row) => sum + row.words, 0));
    assert.equal(words, 15);
  });
  await check('F16 concurrent manuscript statistics retain both increments', async page => {
    const words = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Second', ''); await a.db.clear('stats');
      const docs = a.state.docs; for (const d of docs) { d.ast = { blocks: [{ id: `b-${d.id}`, type: 'paragraph', html: 'one two three' }] }; d._needsModelSync = false; a.docWordBaselines.set(d.id, 0); a.docHighWatermarks.set(d.id, 0); }
      await Promise.all(docs.map(d => a.updateTodayStatsForDoc(d.id)));
      return (await a.db.getAll('stats')).reduce((sum, row) => sum + row.words, 0);
    });
    assert.equal(words, 6);
  });
  await check('F19 Enter executes the visibly selected grouped command', async page => {
    const result = await page.evaluate(() => {
      const p = window.nocturneApp.commandPalette; p.open(); const rows = [...document.querySelectorAll('[data-command-palette-run]')];
      const index = rows.findIndex((row, i) => row.dataset.commandPaletteRun !== p.visibleCommands()[i]?.id); p.selected = index; p.renderResults();
      let actual; p.run = id => { actual = id; }; p.handleKeydown(new KeyboardEvent('keydown', { key: 'Enter' }));
      return { actual, expected: rows[index]?.dataset.commandPaletteRun, index };
    });
    assert.ok(result.index >= 0); assert.equal(result.actual, result.expected);
  });
  await check('F22 hidden editor-mode formatting controls cannot receive focus', async page => {
    await page.evaluate(() => window.nocturneApp.setReviewMode('editor')); await page.waitForTimeout(450);
    const result = await page.evaluate(() => { const button = document.querySelector('.toolbar-formatting button'); button.focus(); return { focused: document.activeElement === button, inert: button.closest('[inert]') !== null }; });
    assert.equal(result.focused, false); assert.equal(result.inert, true);
    await page.evaluate(() => window.nocturneApp.setReviewMode('write')); await page.waitForTimeout(450);
    assert.equal(await page.evaluate(() => { const b = document.querySelector('.toolbar-formatting button'); b.focus(); return document.activeElement === b; }), true);
  });
  await check('F27 sprint completes and unlocks after its deadline', async page => {
    await page.clock.install();
    await page.evaluate(() => { const a = window.nocturneApp; a.state.settings.sprintMinutes = 1; a.state.settings.sprintLock = true; a.startSprint(); a.toggleZen(false); });
    assert.equal(await page.evaluate(() => window.nocturneApp.state.zenActive), true);
    await page.clock.fastForward(61000);
    assert.equal(await page.evaluate(() => !!window.nocturneApp.state.sprint), false);
    await page.evaluate(() => window.nocturneApp.toggleZen(false));
    assert.equal(await page.evaluate(() => window.nocturneApp.state.zenActive), false);
  });
} finally { await browser.close(); server.kill(); await mkdir('release/qa', { recursive: true }); await writeFile('release/qa/audit-editor-regressions.json', JSON.stringify(results, null, 2)); }
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
