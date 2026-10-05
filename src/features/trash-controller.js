import { escapeHtml, uid } from '../core/utils.js';

const categories = [['all', 'Все'], ['lore', 'База знаний'], ['documents', 'Документы'], ['bookmarks', 'Закладки'], ['other', 'Другое']];
const collections = ['characters', 'locations', 'notes', 'timeline', 'rules'];
const settingCollections = ['macros', 'customInputRules', 'customAiPersonas', 'customAiProviders', 'customFonts', 'userLexicon'];
const identity = value => value?.id || (value && typeof value === 'object' ? value.name || value.trigger || value.keys || value.family : null) || JSON.stringify(value);

export class TrashController {
  constructor(app) { this.app = app; this.filter = 'all'; this.worlds = new Map(); this.settings = null; this.work = Promise.resolve(); }
  async init() {
    for (const world of await this.app.db.getAll('lore')) if (!world.locked) this.worlds.set(world.id, structuredClone(world));
    this.settings = structuredClone(this.app.state.settings);
  }
  async capture(type, title, payload, category = 'other') {
    const item = { id: uid('trash'), type, title: String(title || 'Удалённый объект'), deletedAt: Date.now(), category, ...structuredClone(payload) };
    await this.app.db.put('trash', item); return item;
  }
  async store(store, record, category = 'other') {
    if (record && !record.locked) return this.capture('record', record.title || record.name || record.word || record.quote || 'Удалённый объект', { store, record }, category);
  }
  captureSettings(next) {
    const snapshot = structuredClone(next);
    this.work = this.work.catch(() => {}).then(() => this.captureSettingsNow(snapshot));
    return this.work;
  }
  async captureSettingsNow(next) {
    if (!this.settings) { this.settings = structuredClone(next); return; }
    for (const key of settingCollections) {
      const present = new Set((next[key] || []).map(identity));
      for (const value of this.settings[key] || []) if (!present.has(identity(value))) {
        const restored = key === 'customAiProviders' ? { ...value, key: '' } : value;
        await this.capture('preference', value?.name || value?.keys || value?.trigger || String(value), { key, value: restored });
      }
    }
    this.settings = structuredClone(next);
  }
  captureWorld(next, worldId) {
    const snapshot = structuredClone(next);
    this.work = this.work.catch(() => {}).then(() => this.captureWorldNow(snapshot, worldId));
    return this.work;
  }
  async captureWorldNow(next, worldId) {
    const before = this.worlds.get(worldId);
    if (before) for (const collection of collections) {
      const present = new Set((next[collection] || []).map(identity));
      for (const item of before[collection] || []) {
        if (!present.has(identity(item))) {
          const references = (before.timeline || []).flatMap(event => [event, ...event.subEvents || []]).flatMap(event => {
            const key = collection === 'notes' ? 'noteIds' : collection === 'characters' ? 'characterIds' : collection === 'locations' ? 'locationIds' : '';
            return key && event[key]?.includes(item.id) ? [{ id: event.id, key, role: event.characterRoles?.[item.id] }] : [];
          });
          await this.capture('lore-entity', item.title || item.displayName || item.name || item.text, { worldId, collection, item, references }, 'lore');
        }
        if (collection === 'timeline') {
          const current = next.timeline?.find(entry => entry.id === item.id);
          if (current) for (const sub of item.subEvents || []) if (!current.subEvents?.some(entry => entry.id === sub.id)) await this.capture('lore-entity', sub.title, { worldId, collection: 'subtimeline', parentId: item.id, item: sub }, 'lore');
        }
      }
    }
    this.worlds.set(worldId, structuredClone(next));
  }
  category(item) { return item.type === 'bookmark' ? 'bookmarks' : item.category || (item.type === 'document' ? 'documents' : 'other'); }
  async restore(id) {
    const item = await this.app.db.get('trash', id);
    if (!item || item.locked) throw new Error('Введите мастер-пароль для восстановления.');
    if (item.type === 'document') return this.app.restoreTrashItem(id);
    if (item.type === 'bookmark') {
      const source = this.app.bookmarks.sources().find(source => Object.entries(item.owner).every(([key, value]) => source.owner[key] === value));
      if (!source) throw new Error('Сначала восстановите документ или объект базы знаний этой закладки.');
      const bookmark = this.app.bookmarks.recoverAnchors(source, structuredClone(item.bookmark)), values = structuredClone(source.values), existing = values.find(value => value.id === bookmark.id);
      if (existing) {
        const known = new Set(existing.parts.map(part => part.id));
        existing.parts.push(...bookmark.parts.filter(part => !known.has(part.id)));
        await this.app.bookmarks.change(source.key, values);
      } else await this.app.bookmarks.change(source.key, [...values, bookmark]);
    } else if (item.type === 'record') {
      const record = structuredClone(item.record);
      if (await this.app.db.get(item.store, record.id)) throw new Error('Этот объект уже существует. Восстановление не заменит текущую версию.');
      await this.app.db.put(item.store, record);
      if (item.store === 'folders') this.app.state.folders.push(record);
      if (item.store === 'floatingNotes') await this.app.loadFloatingNotes();
      if (item.store === 'typoRules') await this.app.loadTypoRules();
      if (item.store === 'reviewMarks') await this.app.loadReviewMarks();
      if (item.store === 'lore') {
        this.app.bookmarks.worldRecords.push(record); this.worlds.set(record.id, structuredClone(record));
        this.app.state.kbProjects.push({ id: record.id, title: record.title }); this.app.state.settings.kbProjects = this.app.state.kbProjects; await this.app.persistSettings();
      }
    } else if (item.type === 'preference') {
      if (!settingCollections.includes(item.key)) throw new Error('Неизвестный тип настройки.');
      const values = this.app.state.settings[item.key] ||= [];
      if (!values.some(value => identity(value) === identity(item.value))) values.push(structuredClone(item.value));
      await this.app.persistSettings(); this.app.applySettings();
    } else if (item.type === 'lore-entity') {
      const active = item.worldId === this.app.state.activeLoreId;
      const world = active ? this.app.state.lore : await this.app.db.get('lore', item.worldId);
      if (!world || world.locked) throw new Error('Сначала восстановите произведение этой записи.');
      let collection;
      if (item.collection === 'subtimeline') {
        const parent = world.timeline?.find(entry => entry.id === item.parentId);
        if (!parent) throw new Error('Сначала восстановите родительское событие.');
        collection = parent.subEvents ||= [];
      } else { if (!collections.includes(item.collection)) throw new Error('Неизвестный тип объекта.'); collection = world[item.collection] ||= []; }
      if (collection.some(value => identity(value) === identity(item.item))) throw new Error('Этот объект уже существует.');
      collection.push(structuredClone(item.item));
      for (const reference of item.references || []) {
        const event = (world.timeline || []).flatMap(event => [event, ...event.subEvents || []]).find(event => event.id === reference.id);
        if (event) { event[reference.key] ||= []; if (!event[reference.key].includes(item.item.id)) event[reference.key].push(item.item.id); if (reference.role) { event.characterRoles ||= {}; event.characterRoles[item.item.id] = reference.role; } }
      }
      if (active) await this.app.saveLore(); else { await this.app.db.put('lore', world); this.app.bookmarks.worldRecords = this.app.bookmarks.worldRecords.filter(value => value.id !== item.worldId).concat(world); }
    } else throw new Error('Этот объект нельзя восстановить автоматически.');
    await this.app.db.delete('trash', id); this.app.renderAll(); this.app.bookmarks.refresh(); this.app.toast('Объект восстановлен.');
  }
  async open() {
    const overlay = document.getElementById('form-overlay'), wasOpen = overlay.classList.contains('active') && !!overlay.querySelector('.trash-manager');
    const generation = this.renderGeneration = (this.renderGeneration || 0) + 1;
    const items = (await this.app.db.getAll('trash')).sort((a, b) => b.deletedAt - a.deletedAt);
    if (generation !== this.renderGeneration || wasOpen && (!overlay.classList.contains('active') || !overlay.querySelector('.trash-manager'))) return;
    const shown = items.filter(item => this.filter === 'all' || this.category(item) === this.filter);
    this.app.presentFormModal(`<div class="form-modal utility-modal trash-manager"><div class="modal-head-row"><div><h2>Корзина</h2><p>Восстановите удалённый объект или удалите его окончательно.</p></div><button type="button" class="btn-icon" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div><div class="trash-category-tabs knowledge-search-filters" role="group" aria-label="Тип удалённых объектов"><span class="knowledge-selection" aria-hidden="true"></span>${categories.map(([id, title]) => `<button type="button" class="pill-btn" data-trash-filter="${id}" aria-pressed="${this.filter === id}">${title}<span>${items.filter(item => id === 'all' || this.category(item) === id).length}</span></button>`).join('')}</div><div class="utility-list">${shown.length ? shown.map(item => `<div class="utility-row" data-surface-key="trash-${escapeHtml(item.id)}"><i class="bx ${item.type === 'bookmark' ? 'bx-bookmark' : this.category(item) === 'lore' ? 'bx-book-content' : 'bx-file'}" aria-hidden="true"></i><div><strong>${escapeHtml(item.title || 'Зашифрованный объект')}</strong><small>${new Date(item.deletedAt || item.createdAt || 0).toLocaleDateString()} · ${escapeHtml(categories.find(([id]) => id === this.category(item))?.[1] || 'Другое')}</small></div><button type="button" class="pill-btn" data-trash-restore="${escapeHtml(item.id)}"${item.locked ? ' disabled' : ''}>Восстановить</button><button type="button" class="btn-icon" data-trash-delete="${escapeHtml(item.id)}" aria-label="Удалить навсегда"><i class="bx bx-trash"></i></button></div>`).join('') : '<div class="utility-empty"><i class="bx bx-trash"></i><p>Здесь пока пусто</p></div>'}</div></div>`);
    requestAnimationFrame(() => this.app.positionKnowledgeSelection(overlay.querySelector('.trash-category-tabs')));
    overlay.classList.add('active'); overlay.querySelector('[data-close-form]').onclick = () => { this.renderGeneration++; this.app.closeOverlay(overlay); };
    overlay.querySelectorAll('[data-trash-filter]').forEach(button => button.onclick = () => { this.filter = button.dataset.trashFilter; this.open(); });
    overlay.querySelectorAll('[data-trash-restore]').forEach(button => button.onclick = async () => { try { await this.restore(button.dataset.trashRestore); await this.open(); } catch (error) { this.app.toast(error.message); } });
    overlay.querySelectorAll('[data-trash-delete]').forEach(button => button.onclick = async () => { if (!await this.app.confirmDialog({ title: 'Удалить навсегда?', message: 'Объект будет окончательно удалён из корзины.', confirmText: 'Удалить навсегда' })) return this.open(); await this.app.db.delete('trash', button.dataset.trashDelete); await this.open(); });
  }
}
