import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseline = resolve('release/qa/baseline-c35ff0c'); await access(`${baseline}/index.html`);
const before = spawn(process.execPath, ['server.mjs'], { cwd: baseline, env: { ...process.env, PORT: '5316', SYNC_PORT: '8916' }, stdio: 'ignore', windowsHide: true });
const after = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: '5317', SYNC_PORT: '8917' }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
const results = [];
await mkdir('release/qa/visual-comparison', { recursive: true });
try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch('http://localhost:5316')).ok && (await fetch('http://localhost:5317')).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  for (const [name, mobile, surface] of [['desktop-empty', false, 'empty'], ['desktop-manuscript', false, 'manuscript'], ['desktop-characters', false, 'characters'], ['desktop-settings', false, 'settings'], ['mobile-manuscript', true, 'manuscript'], ['mobile-characters', true, 'characters']]) {
    const shots = [], geometry = [];
    for (const [label, port] of [['before', 5316], ['after', 5317]]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
      const page = await context.newPage();
      try {
        await page.goto(`http://localhost:${port}`); await page.waitForSelector('#preloader.hidden', { state: 'attached' });
        await page.evaluate(async ({ surface, mobile }) => {
          const a = window.nocturneApp; a.state.settings.automaticBackups = false; a.state.settings.cursorGlow = false;
          if (surface !== 'empty') {
            await a.createDoc(a.defaultFolderId(), 'A quiet chapter', 'The manuscript visual fixture.');
            a.nocturneEditor.get('primary').commands.setContent('<h2>A quiet chapter</h2><p>A <strong>quiet</strong> evening beside the river.</p><p>The city was waiting for the next morning.</p>');
            await a.saveActiveDoc({ silent: true });
          }
          if (surface === 'characters') {
            a.state.lore.characters = [a.normalizeCharacter({ id: 'visual-character-one', name: 'Arin', firstName: 'Arin', role: 'Traveller', body: 'A quiet traveller from the coast.' }), a.normalizeCharacter({ id: 'visual-character-two', name: 'Mira', firstName: 'Mira', role: 'Writer', body: 'The author of a new story.' })];
            await a.saveLore(); if (mobile) { a.switchMobileTab('lore'); } else a.openKb('characters');
          }
          if (surface === 'settings') a.openSettingsTab('visual');
          a.applySettings(); await document.fonts.ready;
        }, { surface, mobile });
        await page.waitForTimeout(1600);
        await page.addStyleTag({ content: '* { animation: none !important; transition: none !important; caret-color: transparent !important; } #custom-caret, .toast, .toast-container, .typing-particle, .letter-particle { opacity: 0 !important; }' });
        await page.evaluate(() => { document.querySelectorAll('[data-mobile-system-time]').forEach(node => { node.textContent = '12:34'; }); });
        geometry.push(await page.evaluate(() => [...document.querySelectorAll('.toolbar,.sidebar,.page,.settings-modal,.character-grid,.mobile-bottom-nav')].filter(node => node.getClientRects().length).map(node => { const rect = node.getBoundingClientRect(); return { cls: node.className, x: rect.x, y: rect.y, width: rect.width, height: rect.height }; })));
        shots.push(await page.screenshot({ path: `release/qa/visual-comparison/${name}-${label}.png`, animations: 'disabled' }));
      } finally { await context.close(); }
    }
    const identical = shots[0].equals(shots[1]), sameGeometry = JSON.stringify(geometry[0]) === JSON.stringify(geometry[1]);
    results.push({ name, identical, sameGeometry }); console.log(`${identical && sameGeometry ? 'PASS' : 'FAIL'} ${name}: identical PNG ${identical}, geometry ${sameGeometry}`);
  }
} finally { await browser.close(); before.kill(); after.kill(); await writeFile('release/qa/visual-comparison.json', JSON.stringify(results, null, 2)); }
assert.ok(results.every(result => result.identical && result.sameGeometry), 'Visual comparison differs; inspect saved screenshots before accepting.');
