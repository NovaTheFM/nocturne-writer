import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const port = 5287, server = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, PORT: String(port) }, stdio: 'ignore', windowsHide: true });
const browser = await chromium.launch({ headless: true });
try {
  for (let i = 0; i < 70; i++) { try { if ((await fetch(`http://localhost:${port}`)).ok) break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  const page = await browser.newPage(); await page.goto(`http://localhost:${port}`); await page.waitForFunction(() => window.nocturneApp?.databaseSync);
  const result = await page.evaluate(async () => {
    const a = window.nocturneApp; await a.createDoc(a.defaultFolderId(), 'Spelling benchmark', '');
    a.state.settings.smartDictionary = false; a.state.settings.strictSpellcheck = true;
    const paragraph = 'Вечером город затихал, ветер касался деревьев, и свет окон отражался в мокрых камнях мостовой. Она продолжала писать новую историю о путешествиях и возвращении домой.';
    a.nocturneEditor.get('primary').commands.setContent(Array.from({ length: 300 }, (_, index) => `<p>${index % 15 === 0 ? 'сдесь ' : ''}${paragraph}</p>`).join(''));
    a.nocturneEditor.get('primary').commands.blur(); a.selectionSnapshot = null;
    const sample = cold => {
      if (cold) a.typoBlockCache = new WeakMap();
      const started = performance.now(); a.updateTypoHighlights(); return performance.now() - started;
    };
    const cold = [], warm = []; sample(true);
    for (let i = 0; i < 12; i++) { cold.push(sample(true)); warm.push(sample(false)); }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    return { paragraphs: 300, characters: a.nocturneEditor.get('primary').getText().length, coldMedianMs: median(cold), warmMedianMs: median(warm), speedup: median(cold) / median(warm), samples: { cold, warm } };
  });
  await mkdir('release/qa', { recursive: true }); await writeFile('release/qa/spelling-benchmark.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); server.kill(); }
