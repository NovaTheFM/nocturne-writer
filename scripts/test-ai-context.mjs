import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.route('http://nocturne.test/**', async route => {
    const filename = new URL(route.request().url()).pathname;
    await route.fulfill({ contentType: filename === '/' ? 'text/html' : 'text/javascript', body: filename === '/' ? '<!doctype html><html lang="ru"><body></body></html>' : await readFile(path.join(process.cwd(), filename), 'utf8') });
  });
  await page.goto('http://nocturne.test');
  const result = await page.evaluate(async () => {
    const { buildAiContext, collectRelevantLore, estimateContextSize } = await import('/src/features/ai-context.js');
    const state = { lore: { characters: [{ id: 'linked', name: 'Alice', documentIds: ['chapter'] }], locations: [], timeline: [], rules: [{ id: 'rule', title: 'Magic', body: 'Magic requires sunlight' }] } };
    const doc = { id: 'chapter', title: 'Test', ast: { blocks: [{ id: 'b', html: 'A scene.' }] } };
    return { characters: collectRelevantLore({ state, doc, query: 'A scene' }).characters.length, rules: buildAiContext({ state, doc }).rules.length, size: estimateContextSize(buildAiContext({ state, doc: { ...doc, title: 'x'.repeat(10000), description: 'y'.repeat(10000) }, budget: 1500 })) };
  });
  assert.equal(result.characters, 1); assert.equal(result.rules, 1); assert.ok(result.size <= 1500);
} finally { await browser.close(); }
console.log('AI context relevance rules and budget tests passed');
