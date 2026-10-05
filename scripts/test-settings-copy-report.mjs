import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const folder = 'reports/settings-copy-2026-10-05';
const evidence = 'release/qa/settings-copy-report';
await mkdir(evidence, { recursive: true });
const inventory = JSON.parse(await readFile(`${folder}/inventory.json`, 'utf8'));
const capture = JSON.parse(await readFile(`${folder}/capture.json`, 'utf8'));
const markdown = await readFile('reports/SETTINGS_COPY_AUDIT_2026-10-05.md', 'utf8');
const html = await readFile(`${folder}/review.html`, 'utf8');
const url = pathToFileURL(resolve(`${folder}/review.html`)).href;
const browser = await chromium.launch({ headless: true });
const results = [];
let fixture;
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
  console.log((results.at(-1).passed ? 'PASS ' : 'FAIL ') + name + (results.at(-1).error ? '\n' + results.at(-1).error : ''));
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
}
async function pageContext(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, ...options });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => !document.getElementById('export-json').disabled);
  return { context, page, errors };
}
async function saved(page) {
  await page.waitForFunction(() => document.getElementById('storage').textContent === 'Ответы сохранены в этом браузере');
}
try {
  await check('inventory covers defaults, registry and every rendered setting row; exact current copy and source hashes', async () => {
    const keys = new Set(inventory.items.map(item => item.key));
    assert.equal(keys.size, inventory.items.length);
    assert.equal(new Set(inventory.items.map(item => item.id)).size, inventory.items.length);
    assert.equal(inventory.metadata.counts.total, inventory.items.length);
    for (const key of Object.keys(capture.defaults)) assert.ok(keys.has(key), `Missing default: ${key}`);
    for (const entry of capture.registry) assert.ok(keys.has(({ compactSettingsMenu: 'open-compact-settings', worldRules: 'edit-world-rules' })[entry.key] || entry.key), `Missing search entry: ${entry.key}`);
    for (const surface of capture.surfaces) for (const row of surface.rows) {
      if (row.title === 'Группы контекста') continue;
      const raw = (row.keys || [])[0] || (row.actions || [])[0] || row.controls.find(control => control.id)?.id;
      const key = ({ 'set-accent-preset': 'accent', 'toggle-card-view': 'cardView', 'toggle-nocturned-export': 'exportNocturned' })[raw] || raw;
      const item = inventory.items.find(item => item.key === key);
      assert.ok(item, `Missing rendered row: ${surface.tab}/${raw}`);
      assert.ok(item.variants.some(variant => variant.short === row.short && variant.long === row.long && (variant.title === row.title || !row.title)), `Current text changed in evidence: ${key}`);
    }
    for (const [file, hash] of Object.entries(capture.sources)) assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'), hash);
    assert.equal((markdown.match(/^#### S-\d+ · /gm) || []).length, inventory.items.length);
    assert.deepEqual(JSON.parse(html.match(/<script type="application\/json" id="inventory">([\s\S]+?)<\/script>/)[1]), inventory);
    for (const item of inventory.items) {
      for (const key of ['title', 'short', 'long']) assert.equal(typeof item.proposed[key], 'string');
      if (item.kind === 'setting' && item.proposed.short && item.proposed.long) assert.notEqual(item.proposed.short, item.proposed.long, item.key);
      assert.ok(item.sources.length);
    }
  });
  await check('offline desktop report, all cards, accessible labels, no native selects or horizontal overflow', async () => {
    const { context, page, errors } = await pageContext();
    try {
      assert.equal(await page.locator('.card').count(), inventory.items.length);
      assert.equal(await page.locator('select,input[type=color]').count(), 0);
      const orphan = await page.evaluate(() => [...document.querySelectorAll('textarea,input:not([hidden])')].filter(field => !document.querySelector(`label[for="${field.id}"]`) && !field.getAttribute('aria-label')).map(field => field.id));
      assert.deepEqual(orphan, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('[data-section=visual]').click();
      await page.locator('#S-001 > summary').click();
      await page.waitForFunction(() => !!document.querySelector('#S-001 [data-field=long]').style.height);
      await page.waitForFunction(() => document.querySelector('#S-001 .card-body').getAnimations().length === 0);
      await page.evaluate(() => window.scrollTo(0, document.getElementById('S-001').offsetTop - 230));
      await page.screenshot({ path: `${evidence}/desktop.png` });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await check('approval, own text, comments, IndexedDB reload and complete JSON/Markdown export', async () => {
    const { context, page, errors } = await pageContext();
    try {
      await page.locator('#S-001 > summary').click();
      await page.locator('#S-001 [data-decision=approved]').click();
      assert.equal(await page.locator('#S-001').getAttribute('data-decision'), 'approved');
      await page.locator('#S-002 > summary').click();
      await page.locator('#S-002-title').fill('Мой цвет — <текст>');
      await page.locator('#S-002-long').fill('Первая строка.\nВторая строка с собственным описанием.');
      await page.locator('#S-002-comment').fill('Согласовать это название.');
      assert.equal(await page.locator('#S-002').getAttribute('data-decision'), 'edited');
      await saved(page); await page.reload(); await saved(page);
      assert.equal(await page.locator('#S-001').getAttribute('data-decision'), 'approved');
      assert.equal(await page.locator('#S-002-title').inputValue(), 'Мой цвет — <текст>');
      const [jsonDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#export-json').click()]);
      await jsonDownload.saveAs(`${evidence}/review-fixture.json`);
      fixture = JSON.parse(await readFile(`${evidence}/review-fixture.json`, 'utf8'));
      assert.equal(fixture.decisions.length, inventory.items.length);
      assert.equal(fixture.decisions.find(decision => decision.id === 'S-002').texts.long, 'Первая строка.\nВторая строка с собственным описанием.');
      const [mdDownload] = await Promise.all([page.waitForEvent('download'), page.locator('#export-md').click()]);
      await mdDownload.saveAs(`${evidence}/answers-fixture.md`);
      const text = await readFile(`${evidence}/answers-fixture.md`, 'utf8');
      assert.equal((text.match(/^## S-\d+ · /gm) || []).length, inventory.items.length);
      assert.ok(text.includes('Мой цвет — <текст>') && text.includes('Ещё не решил'));
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await check('import to a fresh profile; malformed revision is rejected without losing current decisions', async () => {
    assert.ok(fixture);
    const { context, page, errors } = await pageContext();
    try {
      await page.locator('#import-file').setInputFiles({ name: 'review.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(fixture)) });
      await page.waitForFunction(() => document.getElementById('message').textContent.startsWith('Ответы загружены'));
      assert.equal(await page.locator('#S-001').getAttribute('data-decision'), 'approved');
      assert.equal(await page.locator('#S-002-title').inputValue(), 'Мой цвет — <текст>');
      await saved(page);
      await page.locator('#import-file').setInputFiles({ name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...fixture, revision: 'wrong' })) });
      await page.waitForFunction(() => document.getElementById('message').textContent.startsWith('Ответы не загружены'));
      assert.equal(await page.locator('#S-002-title').inputValue(), 'Мой цвет — <текст>');
      assert.equal(await page.locator('#S-001').getAttribute('data-decision'), 'approved');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await check('search, section/status filters, unchanged items and current-copy restoration preserve fields', async () => {
    const { context, page, errors } = await pageContext();
    try {
      await page.locator('#search').fill('bookmarkMode');
      await page.waitForFunction(() => [...document.querySelectorAll('.card')].filter(card => !card.hidden).length === 1);
      const item = inventory.items.find(item => item.key === 'bookmarkMode'), card = page.locator('#' + item.id);
      await card.locator(':scope > summary').click();
      await card.locator('[data-current]').click();
      assert.equal(await card.locator('[data-field=title]').inputValue(), item.current.title);
      assert.equal(await card.getAttribute('data-decision'), 'edited');
      await page.locator('#search').fill(''); await page.waitForTimeout(150);
      await page.locator('[data-filter=unchanged]').click();
      assert.equal(await page.locator('.card:not([hidden])').count(), inventory.metadata.counts.unchanged);
      await page.locator('[data-filter=pending]').click();
      assert.equal(await page.locator('.card:not([hidden])').count(), inventory.items.length - 1);
      await page.locator('[data-filter=blocked]').click();
      assert.equal(await page.locator('.card:not([hidden])').count(), inventory.metadata.counts.blocked);
      await page.locator('[data-filter=all]').click(); await page.locator('[data-section=bookmarks]').click();
      assert.equal(await page.locator('.card:not([hidden])').count(), inventory.items.filter(item => item.section === 'bookmarks').length);
      assert.equal(await card.locator('[data-field=title]').inputValue(), item.current.title);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
  await check('touch-width layout, full multiline descriptions and reduced motion', async () => {
    const { context, page, errors } = await pageContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    try {
      await page.locator('[data-section=bookmarks]').click();
      const id = inventory.items.find(item => item.key === 'bookmarkConfirmTextDeletion').id;
      await page.locator('#' + id + ' > summary').click();
      await page.waitForFunction(id => !!document.getElementById(id).querySelector('[data-field=long]').style.height, id);
      const layout = await page.evaluate(id => {
        const card = document.getElementById(id), field = card.querySelector('[data-field=long]');
        return { overflow: document.documentElement.scrollWidth > innerWidth, clipped: field.scrollHeight > field.clientHeight + 2, columns: getComputedStyle(card.querySelector('.comparison')).gridTemplateColumns.split(' ').length, animations: card.querySelector('.card-body').getAnimations().length };
      }, id);
      assert.equal(layout.overflow, false); assert.equal(layout.clipped, false); assert.equal(layout.columns, 1); assert.equal(layout.animations, 0);
      await page.locator('#' + id).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${evidence}/mobile.png` });
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  });
} finally {
  await browser.close();
  await writeFile(`${evidence}/results.json`, JSON.stringify(results, null, 2));
}
if (results.some(result => !result.passed)) process.exitCode = 1;
