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
  await test('merge import is atomic and includes every world and global notes', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Existing chapter', '');
      const dump = await a.buildNocturneDump(); delete dump.checksum;
      dump.payload.docs[0].title = 'Imported chapter'; dump.payload.globalNotes = 'Imported global notes';
      dump.payload.lores.push({ id: 'imported-world', title: 'Imported world', characters: [{ id: 'imported-character', name: 'Imported person' }], locations: [], timeline: [], notes: [] });
      const write = a.db.atomicWrite.bind(a.db);
      a.db.atomicWrite = async () => { throw new Error('simulated merge failure'); };
      let failed = false; try { await a.importProjectDump(dump, { mode: 'merge' }); } catch { failed = true; }
      const unchanged = (await a.db.getAll('docs')).length === 1 && a.state.docs.length === 1;
      a.db.atomicWrite = write; await a.importProjectDump(dump, { mode: 'merge' });
      return { failed, unchanged, worlds: await a.db.getAll('lore'), notes: a.state.globalNotes, docs: await a.db.getAll('docs') };
    });
    assert.equal(result.failed, true); assert.equal(result.unchanged, true);
    assert.ok(result.worlds.some(world => world.id === 'imported-world' && world.characters.length === 1));
    assert.match(result.notes, /Imported global notes/); assert.equal(result.docs.length, 2);
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
  await test('DOCX preserves heading levels and separate quotation paragraphs', async page => {
    const xml = await page.evaluate(async () => {
      const a = window.nocturneApp;
      const blob = a.exportDocById(null, { returnBlob: true, docOverride: { title: 'Formatting', ast: { blocks: [
        { id: 'h3', type: 'heading', level: 3, html: 'Heading three' },
        { id: 'q', type: 'quote', html: '<p>First quoted paragraph</p><p>Second quoted paragraph</p>' },
        { id: 'divider', type: 'divider' },
      ] } } });
      const zip = await window.JSZip.loadAsync(await blob.arrayBuffer()); return zip.file('word/document.xml').async('string');
    });
    assert.match(xml, /Heading3/); assert.match(xml, /First quoted paragraph[\s\S]*<\/w:p>[\s\S]*Second quoted paragraph/); assert.match(xml, /w:pBdr/);
  });
  await test('failed DOCX write never reports successful export', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Failed export', '');
      const messages = []; a.toast = message => messages.push(message); a.downloadBlob = async () => { throw new Error('Storage unavailable'); };
      let failed = false; try { await a.exportDocById(a.state.docs[0].id); } catch { failed = true; }
      return { failed, messages };
    });
    assert.equal(result.failed, true); assert.equal(result.messages.some(message => /экспортирован/.test(message)), false);
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
