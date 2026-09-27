import assert from 'node:assert/strict';
import { test } from 'node:test';

const { DatabaseSync } = await import('../src/features/database-sync.js');
class MemoryDb {
  constructor() { this.stores = new Map(); }
  store(name) { if (!this.stores.has(name)) this.stores.set(name, new Map()); return this.stores.get(name); }
  async getAllRaw(name) { return structuredClone([...this.store(name).values()]); }
  async getAll(name) { return this.getAllRaw(name); }
  async get(name, id) { return structuredClone(this.store(name).get(id)); }
  async put(name, value) { this.store(name).set(value.id, structuredClone(value)); this.onMutation?.({ store: name, id: value.id, action: 'put' }); }
  async delete(name, id) { this.store(name).delete(id); this.onMutation?.({ store: name, id, action: 'delete' }); }
  async atomicWrite(entries) { for (const [name, records] of Object.entries(entries)) for (const record of records) await this.put(name, record); }
}
async function pair() {
  const left = new MemoryDb(), right = new MemoryDb();
  const a = new DatabaseSync({ db: left, deviceId: 'pc' });
  const b = new DatabaseSync({ db: right, deviceId: 'phone' });
  await a.start(); await b.start();
  return { a, b, left, right };
}
async function reconcile(a, b) { const sa = await a.buildState(), sb = await b.buildState(); await a.receiveState(sb); await b.receiveState(sa); }

test('missing chapters, notes and worlds move in both directions', async () => {
  const { a, b, left, right } = await pair();
  await left.put('docs', { id: 'chapter-pc', title: 'PC text', ast: { blocks: [] } });
  await right.put('docs', { id: 'chapter-phone', title: 'Phone text', ast: { blocks: [] } });
  await right.put('lore', { id: 'phone-world', characters: [{ id: 'char-a', name: 'A' }], locations: [], timeline: [], notes: [] });
  await right.put('settings', { id: 'global-notes', text: 'Phone note' });
  await reconcile(a, b);
  assert.deepEqual((await left.getAll('docs')).map(d => d.id).sort(), ['chapter-pc', 'chapter-phone']);
  assert.equal((await right.getAll('docs')).length, 2);
  assert.equal((await left.get('settings', 'global-notes')).text, 'Phone note');
  assert.ok(await left.get('lore', 'phone-world'));
});
test('offline edits reconcile and stale repeated states never overwrite newer edits', async () => {
  const { a, b, left, right } = await pair();
  await left.put('docs', { id: 'chapter', title: 'Original' }); await reconcile(a, b);
  const stale = await a.buildState();
  await right.put('docs', { id: 'chapter', title: 'Offline phone edit' }); await reconcile(a, b);
  await b.receiveState(stale);
  assert.equal((await left.get('docs', 'chapter')).title, 'Offline phone edit');
  assert.equal((await right.get('docs', 'chapter')).title, 'Offline phone edit');
});
test('concurrent edits preserve two variants until explicit resolution', async () => {
  const { a, b, left, right } = await pair();
  await left.put('docs', { id: 'chapter', title: 'Original' }); await reconcile(a, b);
  await left.put('docs', { id: 'chapter', title: 'PC edit' }); await right.put('docs', { id: 'chapter', title: 'Phone edit' });
  await reconcile(a, b);
  const conflicts = await left.getAll('syncConflicts');
  assert.equal(conflicts.length, 1);
  assert.match(JSON.stringify(conflicts), /PC edit/); assert.match(JSON.stringify(conflicts), /Phone edit/);
  await a.resolveConflict(conflicts[0].id, 'remote'); await reconcile(a, b);
  assert.equal((await left.get('docs', 'chapter')).title, 'Phone edit');
  assert.equal((await right.get('docs', 'chapter')).title, 'Phone edit');
});
test('deletions propagate as tombstones and reconnect does not resurrect records', async () => {
  const { a, b, left, right } = await pair();
  await left.put('docs', { id: 'chapter', title: 'Delete' }); await reconcile(a, b);
  const stale = await b.buildState();
  await left.delete('docs', 'chapter'); await reconcile(a, b); await a.receiveState(stale);
  assert.equal(await right.get('docs', 'chapter'), undefined);
  assert.equal(await left.get('docs', 'chapter'), undefined);
});
test('sync validates identifiers and never imports executable IDs or unknown stores', async () => {
  const { a, left } = await pair();
  await assert.rejects(a.receiveState({ protocol: 2, deviceId: 'phone', records: [{ store: 'docs', id: 'x\"><img>', value: { id: 'x\"><img>' }, clock: { phone: 1 }, hash: 'x' }] }));
  assert.equal((await left.getAll('docs')).length, 0);
});
