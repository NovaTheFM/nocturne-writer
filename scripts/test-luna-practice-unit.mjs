import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TutorialDatabase } from '../src/core/tutorial-db.js';
import { DATABASE_STORES } from '../src/core/db.js';
import { setLocale } from '../src/core/i18n.js';

const context = () => ({ locale: 'en', settings: { theme: 'paper', e2e: true, automaticBackups: true, gitVersioning: true } });

test('practice persistence never opens IndexedDB and owns every store independently', async () => {
  const previous = globalThis.indexedDB;
  globalThis.indexedDB = { open() { throw new Error('Author database must never be opened'); } };
  try {
    const db = new TutorialDatabase(context()); await db.open();
    assert.deepEqual([...db.db.objectStoreNames], DATABASE_STORES);
    assert.throws(() => db.store('docs'), /held in memory/);
    assert.equal((await db.get('settings', 'app')).value.theme, 'paper');
    for (const key of ['e2e', 'automaticBackups', 'gitVersioning']) assert.equal((await db.get('settings', 'app')).value[key], false);
    const record = { id: 'practice', ast: { blocks: [{ html: 'Own copy' }] } };
    await db.put('docs', record); record.ast.blocks[0].html = 'Mutated caller';
    const read = await db.getRaw('docs', 'practice'); read.ast.blocks[0].html = 'Mutated reader';
    assert.equal((await db.get('docs', 'practice')).ast.blocks[0].html, 'Own copy');
    const second = new TutorialDatabase(context()); await second.open();
    assert.deepEqual(await second.getAll('docs'), []);
    await db.updateStats('test', old => ({ id: 'test', words: (old?.words || 0) + 10 }));
    assert.equal((await db.get('stats', 'test')).words, 10);
    await db.delete('docs', 'practice'); assert.equal(await db.get('docs', 'practice'), undefined);
    await db.clear('stats'); assert.deepEqual(await db.getAll('stats'), []);
    await db.clearAll(); for (const name of DATABASE_STORES) assert.deepEqual(await db.getAllRaw(name), []);
  } finally { if (previous === undefined) delete globalThis.indexedDB; else globalThis.indexedDB = previous; }
});

test('a failed atomic guard cannot partly change practice records', async () => {
  const db = new TutorialDatabase(context()); await db.open();
  const original = { id: 'draft', text: 'Keep' }; await db.put('drafts', original);
  await assert.rejects(db.atomicWrite({ docs: [{ id: 'new' }], drafts: [{ id: 'draft', text: 'Replace' }] }, { replace: true, expect: { drafts: [{ id: 'draft', value: { id: 'draft', text: 'Wrong version' } }] } }), { code: 'SYNC_RETRY' });
  assert.deepEqual(await db.get('drafts', 'draft'), original); assert.deepEqual(await db.getAll('docs'), []);
  await db.atomicWrite({ docs: [{ id: 'new' }] }, { deletes: { drafts: ['draft'] }, expect: { drafts: [{ id: 'draft', value: original }] } });
  assert.equal(await db.get('drafts', 'draft'), undefined); assert.deepEqual(await db.getAll('docs'), [{ id: 'new' }]);
  await db.atomicWrite({ docs: [{ id: 'replacement' }] }, { replace: true });
  assert.deepEqual(await db.getAllRaw('docs'), [{ id: 'replacement' }]);
  const cloned = await db.decodeRecord('docs', await db.encodeRecord('docs', original)); cloned.text = 'Different';
  assert.equal(original.text, 'Keep');
});

test('practice story and character are created in the confirmed language', async () => {
  try {
    for (const [locale, name, title] of [['ru', 'Мира', 'Учебная глава'], ['uk', 'Міра', 'Навчальний розділ'], ['en', 'Mira', 'Practice chapter']]) {
      const db = new TutorialDatabase({ ...context(), locale }); await db.open();
      assert.deepEqual(await db.getAll('docs'), [], 'No story is prepared before the language is known');
      setLocale(locale); await db.prepareStory();
      const [doc] = await db.getAll('docs'), world = await db.get('lore', 'world');
      assert.equal(doc.title, title); assert.equal(world.characters[0].name, name);
      assert.ok(doc.ast.blocks.some(block => block.html.includes(name)));
      assert.deepEqual(world.characters[0].documentIds, [doc.id]);
    }
  } finally { setLocale('ru'); }
});
