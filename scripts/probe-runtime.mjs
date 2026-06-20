import { chromium } from 'playwright';

const BASE_URL = process.env.NOCTURNE_SMOKE_URL || 'http://localhost:5173';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') console.log(`[console.error] ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    console.log(`[pageerror] ${error.message}\n${error.stack || ''}`);
    errors.push(error.message);
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 30_000 });
    await page.waitForFunction(() => !!window.nocturneApp?.createDoc, { timeout: 25_000 });
    const result = await page.evaluate(async () => {
      const app = window.nocturneApp;
      try {
        const folderId = app.defaultFolderId();
        const doc = await app.createDoc(folderId, `Probe ${Date.now()}`, 'probe content');
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        return {
          ok: true,
          folderId,
          docId: doc?.id,
          workspaceMode: app.state.workspace?.mode,
          panes: Object.keys(app.state.workspace?.panes || {}),
          primaryPaneType: app.state.workspace?.panes?.primary?.type,
          pageContentExists: !!document.querySelector('.page-content'),
          prosemirrorExists: !!document.querySelector('.ProseMirror'),
          prosemirrorText: document.querySelector('.ProseMirror')?.textContent?.slice(0, 100),
        };
      } catch (e) {
        return { ok: false, error: String(e?.message || e), stack: e?.stack };
      }
    });
    console.log('RESULT:', JSON.stringify(result, null, 2));
    console.log('PAGE ERRORS:', JSON.stringify(errors, null, 2));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
