import { Database, DATABASE_STORES } from './db.js';
import { defaultSettings, seedFolders } from './defaults.js';
import { t } from './i18n.js';
import { escapeHtml, localDateKey } from './utils.js';

// A separate app realm owns this database. It never opens the author's IndexedDB.
export class TutorialDatabase extends Database {
  constructor(context) {
    super(); this.context = context;
    this.records = new Map(DATABASE_STORES.map(name => [name, new Map()]));
  }

  async open() {
    if (this.db) return this.db;
    this.db = { objectStoreNames: DATABASE_STORES, close() {} };
    const settings = { ...structuredClone(defaultSettings), ...this.context.settings, e2e: false, automaticBackups: false, gitVersioning: false, activeLoreId: 'world', kbProjects: [{ id: 'world', title: t('Учебная история') }] };
    await this.atomicWrite({
      settings: [{ id: 'app', value: settings }, { id: 'interface-language', locale: this.context.locale, confirmed: true }],
      folders: seedFolders,
      lore: [{ id: 'world', characters: [], locations: [], timeline: [], notes: [], rules: [] }],
      stats: [{ id: localDateKey(), words: 0, completed: false }],
    });
    return this.db;
  }

  async prepareStory() {
    await this.atomicWrite({
      docs: [{ id: 'luna-practice-document', folderId: 'manuscript', title: t('Учебная глава'), loreId: 'world', order: 0, notes: '', createdAt: Date.now(), updatedAt: Date.now(), ast: { type: 'doc', blocks: [
        { id: 'practice-heading', type: 'heading', html: escapeHtml(t('Учебная глава')) },
        { id: 'practice-paragraph', type: 'paragraph', html: escapeHtml(t('Мира остановилась у окна. Сегодня начиналась её новая история.')) },
      ] } }],
      lore: [{ id: 'world', title: t('Учебная история'), characters: [{ id: 'luna-practice-character', name: t('Мира'), aliases: [t('Звёздочка')], role: t('Героиня учебной истории'), body: t('Она собирает истории и замечает то, что другие пропускают.'), documentIds: ['luna-practice-document'], order: 0 }], locations: [], timeline: [], notes: [], rules: [] }],
    });
  }

  store() { throw new Error('Tutorial records are held in memory.'); }
  async getAllRaw(name) { await this.open(); return structuredClone([...this.records.get(name).values()]); }
  getAll(name) { return this.getAllRaw(name); }
  async getRaw(name, id) { await this.open(); return structuredClone(this.records.get(name).get(id)); }
  get(name, id) { return this.getRaw(name, id); }
  async encodeRecord(name, value) { return structuredClone(value); }
  async decodeRecord(name, value) { return structuredClone(value); }
  async put(name, value) { await this.open(); this.records.get(name).set(value.id, structuredClone(value)); return value.id; }
  async delete(name, id) { await this.open(); this.records.get(name).delete(id); }
  async clear(name) { await this.open(); this.records.get(name).clear(); }
  async clearAll() { await this.open(); for (const store of this.records.values()) store.clear(); }
  async updateStats(id, update) { const next = update(await this.get('stats', id)); await this.put('stats', next); return next; }
  async atomicWrite(records, { replace = false, deletes = {}, expect = {} } = {}) {
    await this.open();
    for (const [name, guards] of Object.entries(expect)) for (const guard of guards) {
      if (JSON.stringify(this.records.get(name).get(guard.id)) !== JSON.stringify(guard.value)) throw Object.assign(new Error('Tutorial record changed'), { code: 'SYNC_RETRY' });
    }
    const prepared = structuredClone(records);
    for (const [name, values] of Object.entries(prepared)) {
      if (replace) this.records.get(name).clear();
      for (const value of values) this.records.get(name).set(value.id, value);
    }
    for (const [name, ids] of Object.entries(deletes)) for (const id of ids) this.records.get(name).delete(id);
  }
}
