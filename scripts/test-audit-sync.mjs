import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { chromium } from 'playwright';

const token = 'AUDIT-PAIRING-SECRET-1234567890';
const results = [];
async function run(name, test) {
  const process = spawn(globalThis.process.execPath, ['scripts/sync-server.mjs'], { env: { ...globalThis.process.env, SYNC_PORT: '8912', SYNC_TOKEN: token }, stdio: 'ignore', windowsHide: true });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch('http://localhost:8912/health')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    await test(); results.push({ name, passed: true }); console.log(`PASS ${name}`);
  } catch (error) { results.push({ name, passed: false, error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
  finally { process.kill(); await new Promise(resolve => process.exitCode !== null ? resolve() : process.once('exit', resolve)); }
}
async function attack(payload) {
  const ws = new WebSocket('ws://localhost:8912'); ws.on('error', () => {});
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(payload); await new Promise(resolve => setTimeout(resolve, 300)); ws.terminate();
  let alive = false; try { alive = (await fetch('http://localhost:8912/health')).ok; } catch {}
  assert.equal(alive, true, 'A malformed connection terminated the broker');
}
await run('F09 JSON null cannot terminate the broker', () => attack('null'));
await run('F09 oversized frames cannot terminate the broker', () => attack(Buffer.alloc(33 * 1024 * 1024, 65)));
await run('F24 pairing never exposes its secret and rejects an incorrect code', async () => {
  const server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5312', SYNC_PORT: '8913' }, stdio: 'ignore', windowsHide: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch('http://localhost:5312')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
    const page = await browser.newPage(); await page.goto('http://localhost:5312'); await page.waitForSelector('#preloader.hidden', { state: 'attached' });
    const result = await page.evaluate(async secret => {
      const frames = [], original = WebSocket.prototype.send; WebSocket.prototype.send = function(data) { frames.push(data); return original.call(this, data); };
      const a = window.nocturneApp; await a.syncClient.connect({ host: '127.0.0.1', port: '8912', token: secret });
      const exposed = frames.some(frame => String(frame).includes(secret)), connected = a.syncClient.isOpen();
      a.syncClient.disconnect(); let rejected = false; try { await a.syncClient.connect({ host: '127.0.0.1', port: '8912', token: 'INCORRECT-CODE' }); } catch { rejected = true; }
      a.syncClient.disconnect(); WebSocket.prototype.send = original;
      return { exposed, connected, rejected };
    }, token);
    assert.equal(result.connected, true); assert.equal(result.exposed, false); assert.equal(result.rejected, true);
  } finally { await browser.close(); server.kill(); }
});
await mkdir('release/qa', { recursive: true }); await writeFile('release/qa/audit-sync-regressions.json', JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
