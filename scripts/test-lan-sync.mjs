import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5277' }, stdio: 'ignore', windowsHide: true });
const broker = spawn(process.execPath, ['scripts/sync-server.mjs'], { env: { ...process.env, SYNC_PORT: '8880', SYNC_TOKEN: 'REGRESSION1234567890' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
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
  console.log('LAN broker: isolated PC and mobile databases reconciled both ways and delivered a later edit');
} finally { await browser.close(); server.kill(); broker.kill(); }
