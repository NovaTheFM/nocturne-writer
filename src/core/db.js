import { defaultSettings, seedFolders } from './defaults.js';

const DB_NAME = 'nocturne-writer-es6-v3-clean';
const DB_VERSION = 4;
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
    await this.open();
    return requestToPromise(this.store(name).getAll());
  }

  async get(name, id) {
    await this.open();
    return requestToPromise(this.store(name).get(id));
  }

  async put(name, value) {
    await this.open();
    const tx = this.db.transaction(name, 'readwrite');
    const result = await requestToPromise(tx.objectStore(name).put(value));
    await transactionDone(tx);
    return result;
  }

  async delete(name, id) {
    await this.open();
    const tx = this.db.transaction(name, 'readwrite');
    const result = await requestToPromise(tx.objectStore(name).delete(id));
    await transactionDone(tx);
    return result;
  }

  async clear(name) {
    await this.open();
    const tx = this.db.transaction(name, 'readwrite');
    const result = await requestToPromise(tx.objectStore(name).clear());
    await transactionDone(tx);
    return result;
  }

  async seed() {
    const seeded = await requestToPromise(this.store('settings').get('app'));
    if (!seeded) await this.put('settings', { id: 'app', value: defaultSettings });
    const folders = await requestToPromise(this.store('folders').getAll());
    if (!folders.length) await Promise.all(seedFolders.map((folder) => this.put('folders', folder)));
    const lore = await requestToPromise(this.store('lore').get('world'));
    if (!lore) await this.put('lore', { id: 'world', characters: [], locations: [], timeline: [] });
    const today = new Date().toISOString().slice(0, 10);
    const stats = await requestToPromise(this.store('stats').get(today));
    if (!stats) await this.put('stats', { id: today, words: 0, completed: false });
  }
}
