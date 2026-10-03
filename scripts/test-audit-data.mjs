import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const url = 'http://localhost:5310';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5310', SYNC_PORT: '8910' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function check(name, run) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.waitForSelector('#preloader.hidden', { state: 'attached' });
    await page.evaluate(() => { window.nocturneApp.state.settings.automaticBackups = false; });
    await run(page, context);
    results.push({ name, passed: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
    console.error(`FAIL ${name}: ${error.message}`);
  } finally { await context.close(); }
}

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  await check('F01 imported portraits and identifiers cannot execute markup', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.processImportedKbData({ type: 'nocturnechar', character: { id: 'safe-character', name: 'Audit character', image: 'missing-audit-image" onerror="window.__auditXss=true' } });
      await a.saveLore(); a.openKb('characters');
      await new Promise(resolve => setTimeout(resolve, 300));
      const holder = document.createElement('div');
      holder.innerHTML = a.characterCard({ id: 'x" data-injected="yes', name: 'Name', icon: 'bx-user" onmouseover="window.__auditXss=true' });
      return { executed: !!window.__auditXss, handlers: document.querySelectorAll('#kb-modal [onerror]').length, injected: !!holder.querySelector('[data-injected],[onmouseover]') };
    });
    assert.equal(result.executed, false); assert.equal(result.handlers, 0); assert.equal(result.injected, false);
  });
  await check('F02 malformed nested import cannot commit any records', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Keep original', '');
      const dump = await a.buildNocturneDump(); delete dump.checksum;
      dump.payload.lores = [{ id: 'world', characters: { broken: true }, locations: [], timeline: [], notes: [] }];
      const before = JSON.stringify(await a.db.getAllRaw('lore'));
      let rejected = false; try { await a.importProjectDump(dump, { mode: 'replace' }); } catch { rejected = true; }
      return { rejected, unchanged: before === JSON.stringify(await a.db.getAllRaw('lore')), titles: (await a.db.getAll('docs')).map(d => d.title) };
    });
    assert.equal(result.rejected, true); assert.equal(result.unchanged, true); assert.deepEqual(result.titles, ['Keep original']);
  });
  await check('F03 duplicate dump IDs are rejected before replacement', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'First chapter', '');
      const dump = await a.buildNocturneDump(); delete dump.checksum;
      dump.payload.docs.push({ ...structuredClone(dump.payload.docs[0]), title: 'Second chapter' });
      let rejected = false; try { await a.importProjectDump(dump, { mode: 'replace' }); } catch { rejected = true; }
      return { rejected, titles: (await a.db.getAll('docs')).map(d => d.title) };
    });
    assert.equal(result.rejected, true); assert.deepEqual(result.titles, ['First chapter']);
  });
  await check('F04 full local reset removes private records in every store', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Private old chapter', '');
      for (const store of a.db.db.objectStoreNames) await a.db.put(store, { id: 'audit-private-sentinel', body: 'PRIVATE SENTINEL' });
    });
    await Promise.all([page.waitForEvent('framenavigated'), page.evaluate(() => window.nocturneApp.performResetData())]);
    await page.waitForSelector('#preloader.hidden', { state: 'attached' });
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp, remaining = [];
      for (const store of a.db.db.objectStoreNames) if ((await a.db.getAllRaw(store)).some(record => record.id === 'audit-private-sentinel')) remaining.push(store);
      return { remaining, docs: a.state.docs.length };
    });
    assert.deepEqual(result.remaining, []); assert.equal(result.docs, 0);
  });
  await check('F05 settings reset keeps encryption and protected subsequent saves', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Private title', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>PRIVATE CONTENT</p>');
      a.state.sessionPassword = 'audit-password'; a.state.settings.e2e = true;
      await a.migrateEncryption(); await a.persistSettings(); await a.resetSettings();
      await document.querySelector('[data-confirm-reset-settings]').onclick();
      a.nocturneEditor.get('primary').commands.setContent('<p>PRIVATE CONTENT UPDATED</p>');
      await a.saveActiveDoc({ silent: true });
      return { e2e: a.state.settings.e2e, raw: await a.db.getAllRaw('docs') };
    });
    assert.equal(result.e2e, true); assert.ok(result.raw.every(d => d.protectedStore === 'docs'));
    assert.doesNotMatch(JSON.stringify(result.raw), /PRIVATE CONTENT|Private title/);
  });
  await check('F06 disabled AI context does not leak lore through fallback', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'AI context', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>Arin enters.</p>'); a.nocturneEditor.syncDocFromEditor('primary');
      a.state.lore.characters = [a.normalizeCharacter({ id: 'arin', name: 'Arin', body: 'PRIVATE-LORE-MARKER' })];
      a.state.settings.aiKnowledgeContext = false;
      return a.buildAiPrompt('proofread', a.getFocusedDoc(), null, a.buildCurrentAiContext());
    });
    assert.doesNotMatch(result, /PRIVATE-LORE-MARKER/);
  });
  await check('F07 stale AI block and continuation patches preserve author edits', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'AI patch', '');
      const e = a.nocturneEditor.get('primary'); e.commands.setContent('<p>Original paragraph.</p>');
      a.nocturneEditor.syncDocFromEditor('primary'); const d = a.getFocusedDoc(), block = d.ast.blocks[0];
      const target = { docId: d.id, blockId: block.id, targetBlockText: 'Original paragraph.', mode: 'rewrite-block', startOffset: 19 };
      e.commands.focus('end'); e.commands.insertContent(' New author edit.');
      const accepted = a.applyAssistantSuggestionPatch({ docId: d.id, paneId: 'primary', mode: 'replace-block', target, text: 'AI replacement.' });
      const continued = a.applyAssistantSuggestionPatch({ docId: d.id, paneId: 'primary', mode: 'inline-continuation', target, text: 'AI continuation.' });
      return { accepted, continued, text: a.nocturneEditor.get('primary').getText() };
    });
    assert.equal(result.accepted, false); assert.equal(result.continued, false);
    assert.equal(result.text, 'Original paragraph. New author edit.');
  });
  await check('F08 stale second tab cannot overwrite the first revision and both versions survive', async (page, context) => {
    await page.evaluate(async () => { const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Two tabs', ''); a.nocturneEditor.get('primary').commands.setContent('<p>Original</p>'); await a.saveActiveDoc({ silent: true }); });
    const other = await context.newPage(); await other.goto(url); await other.waitForSelector('#preloader.hidden', { state: 'attached' });
    await page.evaluate(async () => { const a = window.nocturneApp; a.nocturneEditor.get('primary').commands.setContent('<p>FIRST IMPORTANT REVISION</p>'); await a.saveActiveDoc({ silent: true }); });
    const result = await other.evaluate(async () => {
      const a = window.nocturneApp; a.nocturneEditor.get('primary').commands.setContent('<p>SECOND STALE REVISION</p>');
      const saved = await a.saveActiveDoc({ silent: true });
      return { saved, docs: await a.db.getAll('docs'), conflicts: await a.db.getAll('syncConflicts'), visible: a.nocturneEditor.get('primary').getText() };
    });
    assert.equal(result.saved, false); assert.match(JSON.stringify(result.docs), /FIRST IMPORTANT REVISION/);
    assert.doesNotMatch(JSON.stringify(result.docs), /SECOND STALE REVISION/);
    assert.equal(result.visible, 'SECOND STALE REVISION'); assert.match(JSON.stringify(result.conflicts), /SECOND STALE REVISION/);
  });
  await check('F10 merged timeline references and role keys follow imported entities', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Merged chapter', '');
      const oldDoc = a.getFocusedDoc().id;
      a.state.lore.characters = [a.normalizeCharacter({ id: 'same-character', name: 'Arin' })];
      a.state.lore.notes = [a.normalizeNote({ id: 'same-note', title: 'Note' })];
      a.state.lore.timeline = [a.normalizeTimelineEvent({ id: 'same-event', title: 'Event', characterIds: ['same-character'], chapterIds: [oldDoc], noteIds: ['same-note'], characterRoles: { 'same-character': 'death' } })];
      await a.saveLore(); const dump = await a.buildNocturneDump(); delete dump.checksum; await a.importProjectDump(dump, { mode: 'merge' });
      const world = (await a.db.getAll('lore')).find(w => w.id !== 'world');
      return { newDoc: a.state.docs.find(d => d.id !== oldDoc).id, character: world.characters[0].id, note: world.notes[0].id, event: world.timeline[0] };
    });
    assert.deepEqual(result.event.chapterIds, [result.newDoc]); assert.deepEqual(result.event.noteIds, [result.note]);
    assert.deepEqual(result.event.characterRoles, { [result.character]: 'death' });
  });
  await check('F11 complete knowledge import retains notes and world rules', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      const report = await a.processImportedKbData({ type: 'nocturnmemory', lore: { characters: [], locations: [], timeline: [], notes: [{ id: 'memory-note', title: 'Memory note', body: 'BODY' }], rules: [{ id: 'world-rule', text: 'No resurrection' }] } });
      return { report, notes: a.state.lore.notes, rules: a.state.lore.rules };
    });
    assert.equal(result.report.notes, 1); assert.equal(result.notes[0].body, 'BODY'); assert.equal(result.rules[0].text, 'No resurrection');
  });
  await check('F17 normal text cleanup preserves greater-than comparisons', async page => {
    const result = await page.evaluate(async () => { const { normalizeHtml, textFromHtml } = await import('/src/core/utils.js'); return { html: normalizeHtml('&gt; 10 килограммов'), text: textFromHtml('&gt; 10 килограммов') }; });
    assert.equal(result.html, '&gt; 10 килограммов'); assert.equal(result.text, '> 10 килограммов');
  });
  await check('F18 note-scoped floating note remains attached to the note', async page => {
    const result = await page.evaluate(() => {
      const a = window.nocturneApp, note = a.sanitizeFloatingNote({ id: 'floating', scope: 'note', linkedId: 'world-note' });
      a.state.workspace.panes.primary = { id: 'primary', type: 'note-detail', entityType: 'notes', entityId: 'world-note' };
      return { scope: note.scope, visible: a.floatingNoteVisible(note) };
    });
    assert.equal(result.scope, 'note'); assert.equal(result.visible, true);
  });
  await mkdir('release/qa', { recursive: true });
  await writeFile('release/qa/audit-data-regressions.json', JSON.stringify(results, null, 2));
  if (results.some(result => !result.passed)) process.exitCode = 1;
} finally { await browser.close(); server.kill(); }
