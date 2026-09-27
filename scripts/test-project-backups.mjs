import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProjectBackups } from '../src/features/backups.js';

test('backup rotation keeps twenty entries and external copies omit duplicated project payloads', async () => {
  const records = new Map(Array.from({ length: 24 }, (_, i) => [`old-${i}`, { id: `old-${i}`, createdAt: i }]));
  const db = { put: async (_, record) => records.set(record.id, record), getAll: async () => [...records.values()], delete: async (_, id) => records.delete(id) };
  const files = { writeBackup: async () => ({ external: true, path: 'D:/Backups/copy' }), readBackup: async () => JSON.stringify({ format: 'nocturnedump' }) };
  const backups = new ProjectBackups({ db, files, buildDump: async () => ({ format: 'nocturnedump', payload: { docs: [{ id: 'chapter' }] } }) });
  const copy = await backups.create();
  assert.equal(records.size, 20); assert.equal(copy.dump, undefined); assert.equal(copy.external, true); assert.equal((await backups.read(copy)).format, 'nocturnedump');
});
test('a browser copy remains restorable without a selected directory and failed external writes are not labelled successful', async () => {
  const records = new Map(), dump = { format: 'nocturnedump', payload: { docs: [] } };
  const db = { put: async (_, record) => records.set(record.id, record), getAll: async () => [...records.values()], delete: async (_, id) => records.delete(id) };
  const files = { writeBackup: async () => ({ external: false }) };
  const backups = new ProjectBackups({ db, files, buildDump: async () => dump });
  const copy = await backups.create(); assert.deepEqual(await backups.read(copy), dump);
  files.writeBackup = async () => { throw new Error('disk full'); };
  await assert.rejects(backups.create(), /disk full/); assert.equal(records.size, 1);
});
