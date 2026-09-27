import { defaultSettings, seedFolders } from './defaults.js';
import { protectRecord, revealRecord } from './record-protection.js';

const DB_NAME = 'nocturne-writer-es6-v3-clean';
const DB_VERSION = 5;
const STORES = [
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
  async open() {
    if (this.db) return this.db;
    this.db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        STORES.forEach((store) => {
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
    await this.open();
    const record = await requestToPromise(this.store(name).get(id));
    return revealRecord(name, record, this.protection?.().password);
  }

  async put(name, value, { origin } = {}) {
    await this.open();
    value = await protectRecord(name, value, this.protection?.());
    const tx = this.db.transaction(name, 'readwrite');
    const done = transactionDone(tx);
    const result = await requestToPromise(tx.objectStore(name).put(value));
    await done;
    this.onMutation?.({ store: name, id: value.id, action: 'put', origin });
    return result;
  }

  async delete(name, id, { origin } = {}) {
    await this.open();
    const tx = this.db.transaction(name, 'readwrite');
    const done = transactionDone(tx);
    const result = await requestToPromise(tx.objectStore(name).delete(id));
    await done;
    this.onMutation?.({ store: name, id, action: 'delete', origin });
    return result;
  }

  async clear(name) {
    await this.open();
    const tx = this.db.transaction(name, 'readwrite');
    const done = transactionDone(tx);
    const result = await requestToPromise(tx.objectStore(name).clear());
    await done;
    return result;
  }

  async atomicWrite(recordsByStore, { replace = false, raw = false, origin, deletes = {} } = {}) {
    await this.open();
    const entries = await Promise.all(Object.entries(recordsByStore).map(async ([name, records]) => [
      name, await Promise.all(records.map(record => raw ? record : protectRecord(name, record, this.protection?.())))
    ]));
    const tx = this.db.transaction([...new Set([...entries.map(([name]) => name), ...Object.keys(deletes)])], 'readwrite');
    const done = transactionDone(tx);
    try {
      for (const [name, records] of entries) {
        const store = tx.objectStore(name);
        if (replace) store.clear();
        for (const record of records) store.put(record);
      }
      for (const [name, ids] of Object.entries(deletes)) for (const id of ids) tx.objectStore(name).delete(id);
    } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
    await done;
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
    const today = new Date().toISOString().slice(0, 10);
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
