import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { _electron, chromium } from 'playwright';

const port = 5285, syncPort = 8885, url = `http://localhost:${port}`;
const profile = resolve(`release/qa/electron-profile-${Date.now()}`), backups = resolve('release/qa/native-backups');
await mkdir(profile, { recursive: true }); await mkdir(backups, { recursive: true });
await writeFile(`${profile}/backup-directory.json`, JSON.stringify({ path: backups }));
const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
let desktop, browser;
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(url)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const environment = { ...process.env, NOCTURNE_DEV_URL: url, NOCTURNE_TEST_PROFILE: profile, SYNC_PORT: String(syncPort) };
  delete environment.ELECTRON_RUN_AS_NODE;
  desktop = await _electron.launch({ executablePath: resolve('node_modules/electron/dist/electron.exe'), args: ['electron/main.cjs'], env: environment });
  const pc = await desktop.firstWindow(); await pc.waitForFunction(() => window.nocturneApp?.databaseSync);
  assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await pc.evaluate(async () => {
    const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Native desktop manuscript', '');
    a.nocturneEditor.get('primary').commands.setContent('<p>Electron document persisted externally.</p>'); await a.saveActiveDoc({ silent: true });
    a.openSyncPanel(); document.querySelector('[data-action="sync-server-start"]').click();
  });
  await pc.waitForFunction(() => window.nocturneApp.state.sync.server.running && window.nocturneApp.syncClient.isOpen(), null, { timeout: 12000 });
  const connection = await pc.evaluate(() => ({ host: '127.0.0.1', port: String(window.nocturneApp.state.sync.server.port), token: window.nocturneApp.state.sync.server.token }));
  assert.equal(Number(connection.port), syncPort); assert.ok(connection.token);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const phone = await context.newPage(); await phone.goto(url); await phone.waitForFunction(() => window.nocturneApp?.databaseSync);
  await phone.evaluate(async connection => {
    const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Phone to native desktop', '');
    a.state.sync.discovery.manualOpen = true; a.openMobilePanel('sync', 'more'); Object.assign(a.state.sync, connection);
    document.querySelector('[data-action="sync-connect"]').click();
  }, connection);
  for (const page of [pc, phone]) await page.waitForFunction(() => window.nocturneApp.state.docs.length === 2, null, { timeout: 12000 });
  const copy = await pc.evaluate(async () => { const a = window.nocturneApp; const copy = await a.backups.create(); const dump = await a.backups.read(copy); return { copy, chapters: dump.payload.docs.length }; });
  assert.equal(copy.copy.external, true); assert.equal(copy.chapters, 2);
  assert.match(await readFile(copy.copy.path, 'utf8'), /Electron document persisted externally/);
  await pc.evaluate(async () => { const a = window.nocturneApp; a.openSyncPanel(); document.querySelector('[data-action="sync-server-stop"]').click(); });
  await pc.waitForFunction(() => !window.nocturneApp.state.sync.server.running);
  console.log('Hidden Electron: real IPC broker start/stop, desktop-phone DB exchange and external backup/read passed.');
} finally { if (browser) await browser.close(); if (desktop) await desktop.close(); server.kill(); }
