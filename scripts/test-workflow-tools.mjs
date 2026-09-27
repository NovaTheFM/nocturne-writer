import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const port = 5282, url = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, windowsHide: true, stdio: 'ignore' });
const browser = await chromium.launch({ headless: true });
const results = [];
async function test(name, fn) {
  const context = await browser.newContext(), page = await context.newPage();
  try { await page.goto(url); await page.waitForFunction(() => window.nocturneApp?.backups); await fn(page); results.push({ name, ok: true }); }
  catch (error) { results.push({ name, ok: false, error: error.message }); }
  finally { await context.close(); }
}
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  await test('replacement import rolls back UI and database when its transaction fails', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Original survives', '');
      const dump = await a.buildNocturneDump(); dump.payload.docs[0].title = 'Failed replacement'; delete dump.checksum;
      a.db.atomicWrite = async () => { throw new Error('simulated disk failure'); };
      let failed = false; try { await a.importProjectDump(dump, { mode: 'replace' }); } catch { failed = true; }
      return { failed, ui: a.state.docs[0].title, db: (await a.db.getAll('docs'))[0].title };
    });
    assert.equal(result.failed, true); assert.equal(result.ui, 'Original survives'); assert.equal(result.db, 'Original survives');
  });
  await test('safe encrypted dump restores protected notes history credentials and all worlds', async page => {
    assert.equal(await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Protected title', '');
      a.state.sessionPassword = 'test-password'; a.state.settings.e2e = true; a.state.settings.aiKey = 'protected-key';
      a.getFocusedDoc().notes = 'protected-note'; a.state.globalNotes = 'protected-global';
      await a.migrateEncryption(); await a.createSnapshot();
      const dump = await a.buildNocturneDump();
      await a.importProjectDump(dump, { mode: 'replace' });
      return a.state.docs[0].title === 'Protected title' && a.state.docs[0].notes === 'protected-note' && a.state.globalNotes === 'protected-global' && (await a.db.get('settings', 'app')).value.aiKey === 'protected-key';
    }), true);
  });
  await test('rules and manuscript caret survive world navigation', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Position test', '');
      const editor = a.nocturneEditor.get('primary'); editor.commands.setContent('<p>Text to return to</p>'); editor.commands.setTextSelection(7);
      a.state.lore.rules = [{ id: 'rule-one', text: 'Magic cannot resurrect people' }]; await a.saveLore();
      a.openKb('characters'); a.returnToManuscript(); await new Promise(r => requestAnimationFrame(r));
      a.state.lore = await a.loadLore(); a.validateLoadedState();
      return { position: a.nocturneEditor.get('primary').state.selection.from, rules: a.state.lore.rules };
    });
    assert.equal(result.position, 7); assert.equal(result.rules[0].text, 'Magic cannot resurrect people');
  });
  await test('cross-document review queue opens the selected document and mark', async page => {
    assert.equal(await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Review chapter', ''); const doc = a.getFocusedDoc();
      a.state.reviewMarks.push({ id: 'review-tool-test', docId: doc.id, status: 'open', kind: 'comment', category: 'style', quote: 'Review', start: { blockId: doc.ast.blocks[0].id, offset: 0 }, end: { blockId: doc.ast.blocks[0].id, offset: 6 } });
      await a.createDoc(a.defaultFolderId(), 'Another chapter', '');
      a.openReviewQueue(); document.querySelector('[data-review-jump]').click();
      return a.state.activeDocId === doc.id && a.state.activeReviewMarkId === 'review-tool-test';
    }), true);
  });
  await test('conflict comparison preserves both manuscripts on explicit keep-both', async page => {
    assert.equal(await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Concurrent chapter', ''); const doc = structuredClone(a.getFocusedDoc());
      await a.databaseSync.buildState();
      const meta = await a.db.get('syncJournal', `docs:${doc.id}`);
      await a.db.put('syncConflicts', { id: 'conflict-test', type: 'database-record', store: 'docs', recordId: doc.id, local: { ...meta, value: doc }, remote: { clock: { phone: 1 }, hash: 'f'.repeat(64), value: { ...doc, title: 'Phone variant' } } });
      await a.openSyncConflicts(); document.querySelector('[data-resolve-conflict="both"]').click();
      for (let i = 0; i < 30 && (await a.db.getAll('syncConflicts')).length; i++) await new Promise(r => setTimeout(r, 30));
      return (await a.db.getAll('docs')).length === 2 && !(await a.db.getAll('syncConflicts')).length;
    }), true);
  });
  await test('browser backup can restore actual manuscript data', async page => {
    assert.equal(await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Backup chapter', '');
      const copy = await a.backups.create(), dump = await a.backups.read(copy);
      return copy.bytes > 0 && !copy.external && dump.payload.docs[0].title === 'Backup chapter';
    }), true);
  });
} finally { await browser.close(); server.kill(); }
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.ok)) process.exitCode = 1;
