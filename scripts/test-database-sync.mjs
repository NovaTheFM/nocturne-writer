import assert from 'node:assert/strict';
import { test } from 'node:test';

const { DatabaseSync } = await import('../src/features/database-sync.js');
class MemoryDb {
  constructor() { this.stores = new Map(); }
  store(name) { if (!this.stores.has(name)) this.stores.set(name, new Map()); return this.stores.get(name); }
  async getAllRaw(name) { return structuredClone([...this.store(name).values()]); }
  async getAll(name) { return this.getAllRaw(name); }
  async get(name, id) { return structuredClone(this.store(name).get(id)); }
  async put(name, value, options = {}) { this.store(name).set(value.id, structuredClone(value)); this.onMutation?.({ store: name, id: value.id, action: 'put', origin: options.origin }); }
  async delete(name, id, options = {}) { this.store(name).delete(id); this.onMutation?.({ store: name, id, action: 'delete', origin: options.origin }); }
  async atomicWrite(entries, options = {}) {
    for (const [name, records] of Object.entries(entries)) for (const record of records) await this.put(name, record, options);
    for (const [name, ids] of Object.entries(options.deletes || {})) for (const id of ids) await this.delete(name, id, options);
  }
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

test('independent offline character additions in the same world reconcile without conflicts', async () => {
  const { a, b, left, right } = await pair();
  await left.put('lore', { id: 'world', characters: [{ id: 'shared', name: 'Shared' }], locations: [], timeline: [], notes: [] }); await reconcile(a, b);
  const local = await left.get('lore', 'world'), remote = await right.get('lore', 'world');
  local.characters.push({ id: 'pc-character', name: 'PC' }); remote.characters.push({ id: 'phone-character', name: 'Phone' });
  await left.put('lore', local); await right.put('lore', remote); await reconcile(a, b); await reconcile(a, b);
  assert.deepEqual((await left.get('lore', 'world')).characters.map(c => c.id).sort(), ['pc-character', 'phone-character', 'shared']);
  assert.deepEqual(await right.get('lore', 'world'), await left.get('lore', 'world'));
  assert.equal((await left.getAll('syncConflicts')).length, 0);
});

test('world member deletions survive another device adding a different character offline', async () => {
  const { a, b, left, right } = await pair();
  await left.put('lore', { id: 'world', characters: [{ id: 'remove', name: 'Remove' }], locations: [], timeline: [], notes: [] }); await reconcile(a, b);
  await left.put('lore', { id: 'world', characters: [], locations: [], timeline: [], notes: [] });
  const remote = await right.get('lore', 'world'); remote.characters.push({ id: 'new', name: 'New' }); await right.put('lore', remote);
  await reconcile(a, b); await reconcile(a, b);
  assert.deepEqual((await right.get('lore', 'world')).characters.map(c => c.id), ['new']);
});

test('local edits made while receiving another record still enter the outgoing journal', async () => {
  const { a, b, left, right } = await pair();
  await right.put('docs', { id: 'remote', title: 'Remote' });
  const original = left.atomicWrite.bind(left); let inserted = false;
  left.atomicWrite = async (...args) => { if (!inserted) { inserted = true; await left.put('docs', { id: 'local-during-sync', title: 'Local' }); } return original(...args); };
  await a.receiveState(await b.buildState());
  assert.ok((await a.buildState()).records.find(r => r.id === 'local-during-sync'));
});
