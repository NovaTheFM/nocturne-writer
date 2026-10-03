import { defaultSettings, seedFolders } from './defaults.js';
import { protectRecord, revealRecord } from './record-protection.js';
import { localDateKey } from './utils.js';

const DB_NAME = 'nocturne-writer-es6-v3-clean';
const DB_VERSION = 5;
export const DATABASE_STORES = [
  'settings',
  'folders',
  'docs',
  'lore',
  'snapshots',
  'stats',
  'floatingNotes',
  'typoRules',
  'reviewMarks',
  'syncDevices',
  'syncMappings',
  'syncQueue',
  'syncConflicts',
  'syncRevisions',
  'syncProfiles',
  'drafts',
  'trash',
  'backups',
  'syncJournal',
];

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export class Database {
  constructor() {
    this.documentVersions = new Map();
  }

  trackDocumentVersions(records) {
    this.documentVersions = new Map(records.map(record => [record.id, structuredClone(record)]));
  }

  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        DATABASE_STORES.forEach((store) => {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
        });
      };
      request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another open Nocturne tab.'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.db = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    });
    await this.seed();
    return this.db;
  }

  store(name, mode = 'readonly') {
    const tx = this.db.transaction(name, mode);
    return tx.objectStore(name);
  }

  async getAll(name) {
    const records = await this.getAllRaw(name);
    return Promise.all(records.map(record => revealRecord(name, record, this.protection?.().password)));
  }

  decodeRecord(name, record) {
    return revealRecord(name, record, this.protection?.().password);
  }

  async getAllRaw(name) {
    await this.open();
    return requestToPromise(this.store(name).getAll());
  }

  async get(name, id) {
    const record = await this.getRaw(name, id);
    return revealRecord(name, record, this.protection?.().password);
  }

  async getRaw(name, id) {
    await this.open();
    return requestToPromise(this.store(name).get(id));
  }

  encodeRecord(name, record) {
    return protectRecord(name, record, this.protection?.());
  }

  async updateStats(id, update) {
    await this.open();
    const tx = this.db.transaction('stats', 'readwrite');
    const done = transactionDone(tx), store = tx.objectStore('stats');
    let next, updateError;
    const request = store.get(id);
    request.onsuccess = () => {
      try { next = update(request.result); store.put(next); }
      catch (error) { updateError = error; tx.abort(); }
    };
    await done.catch(error => { throw updateError || error; });
    this.onMutation?.({ store: 'stats', id, action: 'put' });
    return next;
  }

  async put(name, value, { origin } = {}) {
    await this.open();
    value = await protectRecord(name, value, this.protection?.());
    if (name === 'docs' && origin !== 'sync' && this.documentVersions.has(value.id)) {
      await this.atomicWrite({ docs: [value] }, { raw: true, origin, expect: { docs: [{ id: value.id, value: this.documentVersions.get(value.id) }] } });
      return value.id;
    }
    const tx = this.db.transaction(name, 'readwrite');
    const done = transactionDone(tx);
    const result = await requestToPromise(tx.objectStore(name).put(value));
    await done;
    if (name === 'docs' && origin !== 'sync') this.documentVersions.set(value.id, structuredClone(value));
    this.onMutation?.({ store: name, id: value.id, action: 'put', origin });
    return result;
  }

  async delete(name, id, { origin } = {}) {
    await this.open();
    const tx = this.db.transaction(name, 'readwrite');
    const done = transactionDone(tx);
    const result = await requestToPromise(tx.objectStore(name).delete(id));
    await done;
    if (name === 'docs' && origin !== 'sync') this.documentVersions.delete(id);
    this.onMutation?.({ store: name, id, action: 'delete', origin });
    return result;
  }

  async clear(name) {
    await this.open();
    const tx = this.db.transaction(name, 'readwrite');
    const done = transactionDone(tx);
    const result = await requestToPromise(tx.objectStore(name).clear());
    await done;
    if (name === 'docs') this.documentVersions.clear();
    return result;
  }

  async clearAll() {
    await this.open();
    const tx = this.db.transaction(DATABASE_STORES, 'readwrite');
    const done = transactionDone(tx);
    for (const name of DATABASE_STORES) tx.objectStore(name).clear();
    await done;
    this.documentVersions.clear();
  }

  async atomicWrite(recordsByStore, { replace = false, raw = false, origin, deletes = {}, expect = {} } = {}) {
    await this.open();
    const entries = await Promise.all(Object.entries(recordsByStore).map(async ([name, records]) => [
      name, await Promise.all(records.map(record => raw ? record : protectRecord(name, record, this.protection?.())))
    ]));
    const tx = this.db.transaction([...new Set([...entries.map(([name]) => name), ...Object.keys(deletes), ...Object.keys(expect)])], 'readwrite');
    const done = transactionDone(tx);
    const removed = [], guards = Object.entries(expect).flatMap(([store, records]) => records.map(record => ({ store, ...record })));
    let concurrentWrite = false;
    const write = () => {
      for (const [name, records] of entries) {
        const store = tx.objectStore(name);
        if (replace) {
          const retained = new Set(records.map(record => record.id));
          const keys = store.getAllKeys();
          keys.onsuccess = () => keys.result.filter(id => !retained.has(id)).forEach(id => removed.push({ store: name, id }));
          store.clear();
        }
        for (const record of records) store.put(record);
      }
      for (const [name, ids] of Object.entries(deletes)) for (const id of ids) tx.objectStore(name).delete(id);
    };
    try {
      if (!guards.length) write();
      else {
        let remaining = guards.length;
        for (const guard of guards) {
          const request = tx.objectStore(guard.store).get(guard.id);
          request.onsuccess = () => {
            if (concurrentWrite) return;
            if (JSON.stringify(request.result) !== JSON.stringify(guard.value)) { concurrentWrite = true; tx.abort(); return; }
            if (--remaining === 0) write();
          };
        }
      }
    } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
    await done.catch(error => { if (concurrentWrite) error.code = 'SYNC_RETRY'; throw error; });
    if (origin !== 'sync') {
      if (replace && recordsByStore.docs) this.documentVersions.clear();
      for (const [name, records] of entries) if (name === 'docs') for (const record of records) this.documentVersions.set(record.id, structuredClone(record));
      for (const id of deletes.docs || []) this.documentVersions.delete(id);
    }
    for (const { store, id } of removed) this.onMutation?.({ store, id, action: 'delete', origin });
    for (const [store, records] of entries) for (const record of records) this.onMutation?.({ store, id: record.id, action: 'put', origin });
    for (const [store, ids] of Object.entries(deletes)) for (const id of ids) this.onMutation?.({ store, id, action: 'delete', origin });
  }

  async seed() {
    const seeded = await requestToPromise(this.store('settings').get('app'));
    if (!seeded) await this.put('settings', { id: 'app', value: defaultSettings });
    const folders = await requestToPromise(this.store('folders').getAll());
    if (!folders.length) await Promise.all(seedFolders.map((folder) => this.put('folders', folder)));
    const lore = await requestToPromise(this.store('lore').get('world'));
    if (!lore) await this.put('lore', { id: 'world', characters: [], locations: [], timeline: [], notes: [] });
    const today = localDateKey();
    const stats = await requestToPromise(this.store('stats').get(today));
    if (!stats) await this.put('stats', { id: today, words: 0, completed: false });
    const streakStats = await requestToPromise(this.store('settings').get('streak_stats'));
    if (!streakStats) {
      await this.put('settings', {
        id: 'streak_stats',
        streakCount: 0,
        lastGoalMetDate: null,
        streakModalShownDate: null,
        streakBrokenModalShownDate: null,
        lastCheckedDate: null
      });
    }
  }
}
