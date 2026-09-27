import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const port = 5276;
const url = `http://localhost:${port}`;
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function check(name, fn) {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(url);
    await page.waitForFunction(() => window.nocturneApp?.state.workspace);
    await fn(page);
    results.push({ name, ok: true });
  } catch (error) { results.push({ name, ok: false, error: error.message }); }
  finally { await context.close(); }
}
try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(url)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await check('replacement and AI update visible editor and persisted model', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Model regression', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>alpha beta gamma</p>');
      await a.saveActiveDoc({ silent: true });
      a.openReplaceWindow();
      a.replaceSession.find = 'beta'; a.replaceSession.replace = 'delta';
      a.confirmReplaceAll();
      await a.saveActiveDoc({ silent: true });
      const replaced = a.nocturneEditor.get('primary').getText();
      document.getElementById('form-overlay').classList.remove('active');
      const d = a.getFocusedDoc();
      a.applyAssistantSuggestionPatch({ docId: d.id, paneId: 'primary', mode: 'replace-block', text: 'AI changed text', target: { blockId: d.ast.blocks[0].id, mode: 'replace-block' } });
      await a.saveActiveDoc({ silent: true });
      return { replaced, ai: a.nocturneEditor.get('primary').getText(), stored: await a.db.get('docs', d.id) };
    });
    assert.equal(result.replaced, 'alpha delta gamma');
    assert.equal(result.ai, 'AI changed text');
    assert.match(JSON.stringify(result.stored), /AI changed text/);
  });
  await check('encrypted raw records and safe backup contain no manuscript or notes', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'SECRET TITLE', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>SECRET MANUSCRIPT</p>');
      a.state.sessionPassword = 'regression-password'; a.state.settings.e2e = true;
      a.state.globalNotes = 'SECRET GLOBAL NOTE'; a.state.settings.aiKey = 'SECRET API KEY';
      await a.saveActiveDoc({ silent: true });
      await a.createSnapshot(); await a.saveLore(); await a.persistSettings();
      const raw = await new Promise((resolve, reject) => {
        const request = a.db.db.transaction('docs').objectStore('docs').getAll();
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const dump = await a.buildNocturneDump();
      return { raw, dump };
    });
    assert.doesNotMatch(JSON.stringify(result), /SECRET MANUSCRIPT|SECRET GLOBAL NOTE|SECRET API KEY|SECRET TITLE/);
  });
  await check('invalid replace import leaves existing database intact', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Keep me', '');
      let rejected = false;
      try { await a.importProjectDump({ format: 'nocturnedump', schemaVersion: 3, payload: { docs: [null] } }, { mode: 'replace' }); } catch { rejected = true; }
      return { rejected, docs: await a.db.getAll('docs') };
    });
    assert.equal(result.rejected, true);
    assert.equal(result.docs.length, 1);
  });
  await check('unsafe imported IDs rejected before rendering', async page => {
    assert.equal(await page.evaluate(() => {
      try { window.nocturneApp.validateProjectDump({ format: 'nocturnedump', payload: { folders: [{ id: 'x\"><img src=x onerror=alert(1)>', title: 'x' }] } }); return false; } catch { return true; }
    }), true);
  });
  await check('all worlds and global notes survive replace import and reload', async page => {
    await page.evaluate(async () => {
      const a = window.nocturneApp;
      a.state.globalNotes = 'Global restored';
      await a.db.put('lore', { id: 'second-world', title: 'Second world', characters: [], locations: [], timeline: [], notes: [] });
      const dump = await a.buildNocturneDump();
      await a.importProjectDump(dump, { mode: 'replace' });
    });
    await page.reload(); await page.waitForFunction(() => window.nocturneApp?.state.workspace);
    const result = await page.evaluate(async () => ({ notes: window.nocturneApp.state.globalNotes, worlds: await window.nocturneApp.db.getAll('lore') }));
    assert.equal(result.notes, 'Global restored'); assert.equal(result.worlds.length, 2);
  });
  await check('large paragraphs and legacy recovery are preserved', async page => {
    const result = await page.evaluate(async () => {
      const { normalizeHtml } = await import('/src/core/utils.js');
      const key = 'nocturne-live-v3-large';
      localStorage.setItem(key, JSON.stringify({ ast: { blocks: [{ html: 'x'.repeat(760000) }] }, updatedAt: Date.now() }));
      window.nocturneApp.clearLegacyStorage();
      return { length: normalizeHtml('x'.repeat(220000)).length, kept: !!localStorage.getItem(key) };
    });
    assert.equal(result.length, 220000); assert.equal(result.kept, true);
  });
  await check('Escape resolves confirmation as cancelled', async page => {
    await page.evaluate(() => { window.__confirmed = null; window.nocturneApp.confirmDialog({ title: 'Cancel test' }).then(v => { window.__confirmed = v; }); });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__confirmed === false, null, { timeout: 1000 });
  });
  await check('enabling encryption migrates existing records immediately', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Migration secret', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>OLD SECRET TEXT</p>');
      await a.saveActiveDoc({ silent: true }); await a.createSnapshot();
      a.state.sessionPassword = 'migration-password'; a.state.settings.e2e = true;
      await a.migrateEncryption();
      return { docs: await a.db.getAllRaw('docs'), snapshots: await a.db.getAllRaw('snapshots'), lore: await a.db.getAllRaw('lore') };
    });
    assert.doesNotMatch(JSON.stringify(result), /OLD SECRET TEXT|Migration secret/);
    for (const record of [...result.docs, ...result.snapshots, ...result.lore]) assert.ok(record.encrypted);
  });
  await check('history restores visible text and notes', async page => {
    const result = await page.evaluate(async () => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), 'Snapshot', '');
      a.nocturneEditor.get('primary').commands.setContent('<p>Original snapshot text</p>');
      a.getFocusedDoc().notes = 'Original notes';
      await a.createSnapshot();
      a.nocturneEditor.get('primary').commands.setContent('<p>New version</p>'); a.getFocusedDoc().notes = 'New notes';
      await a.showHistory();
      document.querySelector('[data-restore]').click();
      await new Promise(resolve => setTimeout(resolve, 200));
      return { text: a.nocturneEditor.get('primary').getText(), notes: a.getFocusedDoc().notes };
    });
    assert.equal(result.text, 'Original snapshot text'); assert.equal(result.notes, 'Original notes');
  });
  await check('settings modal contains keyboard focus', async page => {
    await page.evaluate(() => window.nocturneApp.openSettingsTab('visual'));
    await page.waitForTimeout(100);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => !!document.activeElement.closest('#settings-overlay')), true);
  });
} finally { await browser.close(); server.kill(); }
console.log(JSON.stringify(results, null, 2));
if (results.some(r => !r.ok)) process.exitCode = 1;
