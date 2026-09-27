import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5277' }, stdio: 'ignore', windowsHide: true });
const broker = spawn(process.execPath, ['scripts/sync-server.mjs'], { env: { ...process.env, SYNC_PORT: '8880', SYNC_TOKEN: 'REGRESSION1234567890' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
async function waitForDatabase(page, predicate, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await page.evaluate(predicate)) return; await page.waitForTimeout(100); }
  throw new Error(`Database condition timed out: ${await page.evaluate(async () => JSON.stringify({ docs: window.nocturneApp.state.docs.map(doc => ({ title: doc.title, ast: doc.ast })), conflicts: (await window.nocturneApp.db.getAll('syncConflicts')).map(conflict => ({ store: conflict.store, recordId: conflict.recordId, local: conflict.local, remote: conflict.remote })), queue: (await window.nocturneApp.db.getAll('syncQueue')).length, status: window.nocturneApp.state.sync.statusDetail }))}`);
}
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch('http://localhost:5277')).ok && (await fetch('http://localhost:8880/health')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const pc = await browser.newContext(), phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await pc.newPage(), m = await phone.newPage();
  for (const [page, name] of [[p, 'PC chapter'], [m, 'Phone chapter']]) {
    await page.goto('http://localhost:5277'); await page.waitForFunction(() => window.nocturneApp?.state.workspace);
    await page.evaluate(async title => {
      const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), title, '');
      a.nocturneEditor.get('primary').commands.setContent(`<p>${title} manuscript</p>`);
      await a.saveActiveDoc({ silent: true });
      if (a.isMobileLayout()) { a.state.sync.discovery.manualOpen = true; a.openMobilePanel('sync', 'more'); } else a.openSyncPanel();
      Object.assign(a.state.sync, { host: '127.0.0.1', port: '8880', token: 'REGRESSION1234567890' });
      const button = document.querySelector('[data-action="sync-connect"]');
      if (!button) throw new Error('Sync connection UI is missing');
      button.click();
    }, name);
  }
  for (const page of [p, m]) await page.waitForFunction(() => window.nocturneApp.syncClient.isOpen(), null, { timeout: 10000 });
  for (const page of [p, m]) {
    await page.waitForFunction(() => window.nocturneApp.state.docs.some(doc => doc.title === 'PC chapter') && window.nocturneApp.state.docs.some(doc => doc.title === 'Phone chapter'), null, { timeout: 8000 });
    assert.equal(await page.evaluate(() => window.nocturneApp.state.docs.length), 2);
  }
  await m.evaluate(async () => {
    const a = window.nocturneApp, d = a.state.docs.find(doc => doc.title === 'Phone chapter');
    a.nocturneEditor.applyDocumentContent(d, { ast: { type: 'doc', blocks: [{ id: 'edited-phone-block', type: 'paragraph', html: 'Phone revision reached PC' }] } });
    d.updatedAt = Date.now(); await a.saveDocById(d.id, { silent: true });
  });
  await p.waitForFunction(() => JSON.stringify(window.nocturneApp.state.docs).includes('Phone revision reached PC'), null, { timeout: 8000 });
  for (const page of [p, m]) await waitForDatabase(page, async () => !(await window.nocturneApp.db.getAll('syncQueue')).length);
  await m.evaluate(() => window.nocturneApp.syncClient.disconnect());
  await p.waitForFunction(() => window.nocturneApp.syncClient.peers.size === 0);
  for (const [page, source] of [[p, 'PC'], [m, 'Phone']]) {
    await page.evaluate(async source => {
      const a = window.nocturneApp;
      await a.createDoc(a.defaultFolderId(), `${source} offline chapter`, '');
      const shared = a.state.docs.find(doc => doc.title === 'Phone chapter');
      a.nocturneEditor.applyDocumentContent(shared, { ast: { type: 'doc', blocks: [{ id: 'shared-edit-block', type: 'paragraph', html: `${source} concurrent offline text` }] } });
      await a.saveDocById(shared.id, { silent: true });
      a.state.lore.characters.push(a.normalizeCharacter({ id: `${source.toLowerCase()}-offline-character`, name: `${source} offline character` }));
      await a.saveLore();
      if (source === 'PC') await a.deleteDoc(a.state.docs.find(doc => doc.title === 'PC chapter').id);
      await a.databaseSync.work;
    }, source);
  }
  await m.evaluate(() => {
    const a = window.nocturneApp; a.state.sync.discovery.manualOpen = true; a.openMobilePanel('sync', 'more');
    document.querySelector('[data-action="sync-connect"]').click();
  });
  for (const page of [p, m]) {
    await waitForDatabase(page, async () => {
      const a = window.nocturneApp;
      return a.state.docs.length === 3 && a.state.docs.some(doc => doc.title === 'PC offline chapter') && a.state.docs.some(doc => doc.title === 'Phone offline chapter') && !a.state.docs.some(doc => doc.title === 'PC chapter') && a.state.lore.characters.length === 2 && (await a.db.getAll('syncConflicts')).some(conflict => conflict.store === 'docs');
    });
  }
  await p.evaluate(async () => {
    const a = window.nocturneApp, conflict = (await a.db.getAll('syncConflicts')).find(conflict => conflict.store === 'docs');
    if (!conflict) throw new Error(JSON.stringify({ conflicts: await a.db.getAll('syncConflicts'), journal: await a.db.getAll('syncJournal'), docs: a.state.docs.map(doc => ({ id: doc.id, title: doc.title, ast: doc.ast })) }));
    await a.databaseSync.resolveConflict(conflict.id, 'remote');
  });
  for (const page of [p, m]) await waitForDatabase(page, async () => {
    const a = window.nocturneApp;
    return JSON.stringify(a.state.docs).includes('Phone concurrent offline text') && !(await a.db.getAll('syncConflicts')).length && !(await a.db.getAll('syncQueue')).length;
  });
  console.log('LAN UI: bidirectional chapters, later edits, offline reconnect, deletions, independent world additions, conflicts, resolution and ACK queue drain passed.');
} finally { await browser.close(); server.kill(); broker.kill(); }
