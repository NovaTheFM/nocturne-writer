import { uid, escapeHtml } from '../core/utils.js';
import { anchorAt, bookmarkBounds, bookmarkDefaults, bookmarkSignature, cloneBookmarks, editorIndex, jsonEditorIndex, makeBookmark, mapBookmarks, normalizeBookmarks, overlapsBookmark, resolveLegacyAnchor, textChangeMapping, textIndex } from './bookmark-model.js';
import { bookmarkPluginKey, bookmarkTransaction } from '../editor/bookmark-plugin.js';
import { revealViewportPosition } from '../editor/viewport-pagination.js';
import { clearBookmarkLayer, drawBookmarkLayer, flashBookmark, rangeInText, textRangeOffsets } from '../ui/bookmark-layer.js';

const labels = { point: 'Позиция', paragraph: 'Абзац', range: 'Фрагмент' };
const sourceKey = owner => [owner.kind, owner.worldId || '', owner.type || '', owner.id, owner.field || 'body'].map(encodeURIComponent).join('|');
const titleOf = bookmark => bookmark.parts.map(part => part.title).join(' · ');
const attached = bookmark => bookmark.parts.some(part => part.anchor.status === 'attached');
const sourceBlocks = (record, rich, text) => {
  if (!rich) return textIndex(text);
  if (record.pmJson) return jsonEditorIndex(record.pmJson);
  const blocks = record.ast?.blocks || [];
  if (blocks.some(block => !['paragraph', 'heading', 'code'].includes(block.type))) return [];
  let pos = 1;
  return blocks.map(block => {
    const element = document.createElement('div'); element.innerHTML = block.html || '';
    const text = element.textContent, size = text.length + element.querySelectorAll('br').length;
    const result = { id: block.id, from: pos, to: pos + size, text };
    pos += size + 2; return result;
  });
};

export class BookmarkController {
  constructor(app) {
    this.app = app; this.filter = 'lore'; this.query = ''; this.status = 'all'; this.selected = new Set(); this.worldRecords = [];
    this.trashIds = new Map(); this.plainUndo = []; this.plainRedo = []; this.refreshFrame = 0; this.trashWork = Promise.resolve();
    this.plainTexts = new Map(); this.textHistory = new Map();
    this.textareaMirrors = new Map();
    this.resizeObserver = new ResizeObserver(() => this.refresh());
    document.addEventListener('scroll', () => this.refresh(), { capture: true, passive: true });
    window.addEventListener('resize', () => this.refresh(), { passive: true });
    document.fonts?.addEventListener('loadingdone', () => this.refresh());
    document.addEventListener('keydown', event => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (event.shiftKey && (event.code === 'KeyB' || event.key.toLowerCase() === 'b') && !event.target.closest('.floating-note')) {
        event.preventDefault(); this.addCurrent(this.app.state.workspace.focusedPaneId); return;
      }
      const plainSource = this.sourceForElement(event.target);
      if (!event.target.closest('.ProseMirror') && (!event.target.closest('input, textarea, [contenteditable="true"]') || plainSource && !plainSource.rich && this.lastPlainChange > (this.lastPlainInput || 0)) && event.key.toLowerCase() === 'z') {
        const source = event.shiftKey ? this.plainRedo : this.plainUndo;
        const target = event.shiftKey ? this.plainUndo : this.plainRedo;
        const entry = source.pop();
        if (entry) { event.preventDefault(); target.push(entry); this.change(entry.ownerKey, event.shiftKey ? entry.after : entry.before, { history: false }); }
      }
    });
  }
  get settings() { return { ...bookmarkDefaults, ...this.app.state.settings }; }
  resetPlainTextBaselines() { for (const source of this.sources()) if (!source.rich) this.plainTexts.set(source.key, source.text); }
  recoverAnchors(source, bookmark) {
    const instance = source.rich && [...this.app.nocturneEditor.instances.values()].find(instance => instance.docId === source.owner.id);
    const blocks = instance ? editorIndex(instance.editor.state.doc) : source.rich && source.record.pmJson ? jsonEditorIndex(source.record.pmJson) : textIndex(source.text);
    for (const part of bookmark.parts) {
      const anchor = part.anchor;
      if (anchor.kind === 'point') {
        const matches = [];
        for (const block of blocks) for (let offset = 0; offset <= block.text.length; offset++) {
          if ((anchor.prefix || anchor.suffix) && (!anchor.prefix || block.text.slice(0, offset).endsWith(anchor.prefix)) && (!anchor.suffix || block.text.slice(offset).startsWith(anchor.suffix))) matches.push(block.from + offset);
        }
        part.anchor = matches.length === 1 ? anchorAt(blocks, matches[0], matches[0], 'point') : { ...anchor, status: 'unresolved' };
      } else part.anchor = resolveLegacyAnchor({ ...anchor, offset: anchor.from }, blocks, !source.rich);
    }
    return bookmark;
  }
  cloneRecordBookmarks(record) {
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value.bookmarks)) value.bookmarks = cloneBookmarks(normalizeBookmarks(value.bookmarks, value.pmJson ? jsonEditorIndex(value.pmJson) : textIndex(value.body || value.text || '')), '');
      if (value.fieldBookmarks) for (const [field, values] of Object.entries(value.fieldBookmarks)) value.fieldBookmarks[field] = cloneBookmarks(normalizeBookmarks(values, textIndex(value[field] || ''), { plain: true }), '');
      for (const [key, child] of Object.entries(value)) if (!['bookmarks', 'fieldBookmarks', 'pmJson', 'ast'].includes(key)) { if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child); }
    };
    visit(record);
  }
  async init() {
    this.worldRecords = (await this.app.db.getAll('lore')).filter(world => !world.locked);
    const global = await this.app.db.get('settings', 'global-notes');
    this.app.state.globalBookmarks = global?.bookmarks || [];
    const ids = new Set(), docs = new Map(), worlds = new Set(); let globalChanged = false;
    for (const source of this.sources()) {
      this.plainTexts.set(source.key, source.text);
      if (!source.values.length) continue;
      const blocks = sourceBlocks(source.record, source.rich, source.text);
      let values = normalizeBookmarks(source.values, blocks, { plain: !source.rich, ownerKey: source.key });
      values = structuredClone(values).map(value => {
        if (ids.has(value.id)) { value.groupId ||= value.id; value.id = uid('bookmark'); }
        ids.add(value.id); return value;
      });
      if (source.migrated || JSON.stringify(source.values) !== JSON.stringify(values)) {
        source.set(values);
        if (source.owner.kind === 'doc') docs.set(source.owner.id, source.record);
        else if (source.owner.kind === 'lore') worlds.add(source.owner.worldId);
        else globalChanged = true;
      }
    }
    for (const doc of docs.values()) { const record = structuredClone(doc); delete record.encrypted; await this.app.db.put('docs', record); }
    for (const id of worlds) { const world = this.worlds().find(value => value.id === id); if (world) await this.app.db.put('lore', world); }
    if (globalChanged && !global?.locked) await this.app.db.put('settings', { ...global, id: 'global-notes', text: this.app.state.globalNotes || '', bookmarks: this.app.state.globalBookmarks, updatedAt: Date.now() });
    this.refreshMenus(); this.refresh();
  }
  worlds() {
    return [...this.worldRecords.filter(world => world.id !== this.app.state.activeLoreId), { ...this.app.state.lore, id: this.app.state.activeLoreId || 'world' }];
  }
  sources() {
    const sources = [];
    const add = (record, owner, title, rich = false) => {
      const key = sourceKey(owner), field = owner.field || 'body';
      const getter = () => owner.kind === 'global' ? this.app.state.globalBookmarks || [] : field === 'body' ? record.bookmarks || [] : record.fieldBookmarks?.[field] || [];
      sources.push({ key, owner, title, record, rich, text: owner.kind === 'global' ? this.app.state.globalNotes || '' : String(record[field] || ''),
        get values() {
          const values = getter();
          if (!Array.isArray(values) || values.some(value => !value || value.version !== 2 || !Array.isArray(value.parts) || value.parts.some(part => !part?.anchor || typeof part.anchor !== 'object'))) {
            const blocks = sourceBlocks(record, rich, this.text);
            const normalized = normalizeBookmarks(values, blocks, { plain: !rich, ownerKey: key }); this.set(normalized); this.migrated = true; return normalized;
          }
          return values;
        },
        set: values => {
          values = values.map(value => ({ ...value, ownerKey: key }));
          if (owner.kind === 'global') this.app.state.globalBookmarks = values;
          else if (field === 'body') record.bookmarks = values;
          else { record.fieldBookmarks ||= {}; record.fieldBookmarks[field] = values; }
        },
      });
    };
    for (const doc of this.app.state.docs || []) {
      if (doc.locked) continue;
      add(doc, { kind: 'doc', id: doc.id, field: 'body' }, doc.title, true);
      for (const field of ['notes', 'description']) add(doc, { kind: 'doc', id: doc.id, field }, `${doc.title} · ${field === 'notes' ? 'Заметки' : 'Описание'}`);
    }
    for (const world of this.worlds()) {
      for (const type of ['characters', 'locations', 'notes', 'timeline', 'rules']) for (const item of world[type] || []) {
        if (!item || typeof item !== 'object') continue;
        const field = type === 'rules' ? 'text' : 'body';
        add(item, { kind: 'lore', worldId: world.id, type, id: item.id, field }, item.title || item.displayName || item.name || 'Правило мира');
        if (type === 'timeline') for (const sub of item.subEvents || []) add(sub, { kind: 'lore', worldId: world.id, type: 'subtimeline', id: sub.id, parentId: item.id, field: 'body' }, sub.title);
      }
    }
    add({}, { kind: 'global', id: 'global-notes', field: 'body' }, 'Общие заметки');
    return sources;
  }
  source(key) { return this.sources().find(source => source.key === key); }
  paneSource(paneId) {
    const pane = this.app.getPane(paneId);
    if (pane?.type === 'document') return this.sources().find(source => source.rich && source.owner.id === pane.docId);
    if (pane?.entityId) return this.sources().find(source => source.owner.kind === 'lore' && source.owner.worldId === this.app.state.activeLoreId && source.owner.id === pane.entityId && (source.owner.field || 'body') === 'body');
    return null;
  }
  sourceForElement(element) {
    if (!element || element.closest('.floating-note, .floating-notes-modal')) return null;
    const marked = element.closest('[data-bookmark-source]');
    if (marked) return this.source(marked.dataset.bookmarkSource);
    if (element.closest('#notes-input, [data-mobile-notes-input]')) {
      const global = element.closest('[data-mobile-notes-input]') ? this.app.state.mobile.notesMode === 'global' : this.app.state.noteMode === 'global';
      return this.sources().find(source => global ? source.owner.kind === 'global' : source.owner.kind === 'doc' && source.owner.id === this.app.getFocusedDoc()?.id && source.owner.field === 'notes');
    }
    const article = element.closest('.lore-detail');
    if (article) return this.sources().find(source => source.owner.kind === 'lore' && source.owner.worldId === this.app.state.activeLoreId && source.owner.id === article.dataset.loreId);
    return element.closest('.ProseMirror, .page-content') ? this.paneSource(element.closest('.workspace-pane')?.dataset.paneId) : null;
  }
  async persist(source) {
    if (source.owner.kind === 'doc') {
      source.record.updatedAt = Date.now(); await this.app.saveDocById(source.owner.id, { silent: true });
    } else if (source.owner.kind === 'global') await this.app.persistGlobalNotes();
    else if (source.owner.worldId === this.app.state.activeLoreId) await this.app.saveLore();
    else {
      const world = this.worldRecords.find(world => world.id === source.owner.worldId);
      if (world) await this.app.db.put('lore', world);
    }
  }
  async preparePlain(source) {
    if (source.rich) return true;
    this.plainWork ||= new Map();
    const work = (this.plainWork.get(source.key) || Promise.resolve()).catch(() => {}).then(() => this.preparePlainNow(this.source(source.key) || source));
    this.plainWork.set(source.key, work);
    try { return await work; } finally { if (this.plainWork.get(source.key) === work) this.plainWork.delete(source.key); }
  }
  async preparePlainNow(source) {
    if (source.rich) return true;
    const beforeText = this.plainTexts.get(source.key) ?? source.text;
    if (beforeText === source.text) return true;
    const before = structuredClone(source.values), history = this.textHistory.get(source.key) || [];
    const previous = [...history].reverse().find(entry => entry.beforeText === source.text && entry.afterText === beforeText || entry.afterText === source.text && entry.beforeText === beforeText);
    let values;
    if (previous) values = structuredClone(previous.beforeText === source.text ? previous.before : previous.after);
    else {
      const projection = mapBookmarks(normalizeBookmarks(before, textIndex(beforeText), { plain: true, ownerKey: source.key }), textChangeMapping(beforeText, source.text), textIndex(source.text), this.settings);
      if (projection.deleted.length && this.settings.bookmarkConfirmTextDeletion && this.settings.bookmarkDeletedText === 'delete' && !await this.confirmTextDeletion(projection.deleted)) {
        if (source.owner.kind === 'global') this.app.state.globalNotes = beforeText;
        else source.record[source.owner.field || 'body'] = beforeText;
        const input = document.querySelector('#notes-input');
        if (input && this.sourceForElement(input)?.key === source.key) input.textContent = beforeText;
        for (const field of document.querySelectorAll('[data-mobile-notes-input]')) if (this.sourceForElement(field)?.key === source.key) field.value = beforeText;
        this.app.renderKb(); this.refresh(); return false;
      }
      values = projection.bookmarks;
      history.push({ beforeText, afterText: source.text, before, after: structuredClone(values) });
      this.textHistory.set(source.key, history.slice(-100));
    }
    source.set(values); this.plainTexts.set(source.key, source.text); await this.reconcileTrash(source, before, values); this.refresh(); return true;
  }
  async prepareOwner(kind, id = null) {
    for (const source of this.sources()) if (!source.rich && source.owner.kind === kind && (id === null || source.owner.id === id)) if (!await this.preparePlain(source)) return false;
    return true;
  }
  async archive(source, bookmark) {
    const key = `${source.key}:${bookmark.id}`;
    if (this.trashIds.has(key)) {
      const existing = await this.app.db.get('trash', this.trashIds.get(key));
      if (existing) { const ids = new Set(existing.bookmark.parts.map(part => part.id)); existing.bookmark.parts.push(...bookmark.parts.filter(part => !ids.has(part.id))); await this.app.db.put('trash', existing); return; }
      this.trashIds.delete(key);
    }
    const id = uid('trash'); this.trashIds.set(key, id);
    try { await this.app.db.put('trash', { id, type: 'bookmark', category: source.owner.kind === 'doc' ? 'documents' : source.owner.kind === 'lore' ? 'lore' : 'other', title: titleOf(bookmark), deletedAt: Date.now(), owner: source.owner, bookmark: structuredClone(bookmark) }); }
    catch (error) { this.trashIds.delete(key); throw error; }
  }
  async reconcileTrash(source, before, after) {
    for (const bookmark of before) {
      const next = after.find(value => value.id === bookmark.id);
      const lost = bookmark.parts.filter(part => !after.some(value => value.parts.some(candidate => candidate.id === part.id)));
      if (lost.length) await this.archive(source, { ...bookmark, parts: lost });
    }
    for (const bookmark of after) {
      const key = `${source.key}:${bookmark.id}`, trashId = this.trashIds.get(key);
      if (trashId) {
        const item = await this.app.db.get('trash', trashId);
        if (!item) { this.trashIds.delete(key); continue; }
        item.bookmark.parts = item.bookmark.parts.filter(part => !bookmark.parts.some(value => value.id === part.id));
        if (item.bookmark.parts.length) await this.app.db.put('trash', item);
        else { await this.app.db.delete('trash', trashId); this.trashIds.delete(key); }
      }
    }
  }
  editorValues(paneId, doc, values) {
    const source = this.sources().find(source => source.rich && source.owner.id === doc.id);
    if (!source) return;
    const before = doc.bookmarks || [];
    source.set(values);
    if (before.every(value => value.version === 2) && JSON.stringify(before) !== JSON.stringify(doc.bookmarks)) {
      const after = structuredClone(doc.bookmarks);
      this.trashWork = this.trashWork.catch(() => {}).then(() => this.reconcileTrash(source, before, after));
      this.trashWork.catch(error => this.app.toast(error.message));
    }
  }
  async change(key, values, { history = true } = {}) {
    const source = this.source(key);
    if (!source) throw new Error('Текст закладки не найден. Сначала восстановите его из корзины.');
    const before = structuredClone(source.values), after = structuredClone(values).map(value => ({ ...value, ownerKey: key }));
    const pane = [...this.app.nocturneEditor.instances.values()].find(instance => instance.docId === source.owner.id);
    if (source.rich && pane) {
      pane.editor.view.dispatch(bookmarkTransaction(pane.editor, after));
    } else {
      source.set(after);
      if (history) { this.plainUndo.push({ ownerKey: key, before, after }); this.plainUndo = this.plainUndo.slice(-100); this.plainRedo = []; this.lastPlainChange = performance.now(); }
      await this.reconcileTrash(source, before, after);
    }
    await this.trashWork; await this.persist(this.source(key)); this.refresh(); this.refreshMenus(); this.refreshManager();
  }
  async confirmTextDeletion(deleted) {
    return this.app.confirmDialog({ title: 'Удалить закладку?', message: deleted.length === 1 ? `Удаляемый текст содержит «${deleted[0].part.title}». Закладка попадёт в корзину. Отмена сохранит текст.` : `Удаляемый текст содержит ${deleted.length} закладок. Они попадут в корзину. Отмена сохранит текст.`, confirmText: 'Удалить' });
  }
  capture(paneId) {
    const source = this.paneSource(paneId), editor = this.app.nocturneEditor.get(paneId);
    const selection = window.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const element = range?.startContainer?.parentElement;
    const plainSource = this.sourceForElement(document.activeElement) || this.sourceForElement(element) || source;
    const field = document.activeElement;
    if ((!plainSource || plainSource.rich) && source?.rich && editor) {
      const selected = this.app.selectionController?.active ? this.app.selectionController.range : range;
      if (selected && editor.view.dom.contains(selected.startContainer) && editor.view.dom.contains(selected.endContainer)) return { sourceKey: source.key, paneId, from: editor.view.posAtDOM(selected.startContainer, selected.startOffset), to: editor.view.posAtDOM(selected.endContainer, selected.endOffset) };
      return { sourceKey: source.key, paneId, from: editor.state.selection.from, to: editor.state.selection.to };
    }
    if (plainSource && field?.tagName === 'TEXTAREA') return { sourceKey: plainSource.key, paneId, from: field.selectionStart, to: field.selectionEnd };
    return plainSource && range ? { sourceKey: plainSource.key, paneId, range, selectedText: range.toString() } : null;
  }
  async addCurrent(paneId) { return this.addContext(this.capture(paneId)); }
  captureClipboard(context) {
    const editor = this.app.nocturneEditor.get(context?.paneId), range = this.app.restoreContextRange();
    if (!editor || !range || !editor.view.dom.contains(range.startContainer) || !editor.view.dom.contains(range.endContainer)) return null;
    editor.commands.setTextSelection({ from: editor.view.posAtDOM(range.startContainer, range.startOffset), to: editor.view.posAtDOM(range.endContainer, range.endOffset) });
    const data = new DataTransfer();
    editor.view.dom.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true, cancelable: true }));
    return { data, editor };
  }
  async addContext(context = null) {
    context ||= this.app.state.contextMenu;
    if (!context) return;
    let source = context.sourceKey ? this.source(context.sourceKey) : this.paneSource(context.paneId);
    if (!source && context.noteId) source = this.sources().find(entry => entry.owner.id === context.noteId);
    if (!source) return this.app.toast('Откройте текст, в котором нужно поставить закладку.');
    const field = document.activeElement;
    if (field?.matches('textarea[data-bookmark-source]') && field.dataset.bookmarkSource === source.key && field.closest('form') && field.value !== source.text) return this.app.toast('Сохраните изменения текста перед созданием закладки.');
    if (!source.rich && !await this.preparePlain(source)) return;
    let blocks, from, to, readText;
    if (source.rich) {
      const editor = this.app.nocturneEditor.get(context.paneId);
      if (!editor) return;
      blocks = editorIndex(editor.state.doc); readText = (start, end) => editor.state.doc.textBetween(start, end, '\n');
      from = context.from ?? editor.state.selection.from; to = context.to ?? editor.state.selection.to;
      const range = context.range || (context.selectedText ? this.app.restoreContextRange() : null);
      if (range && editor.view.dom.contains(range.startContainer)) {
        from = editor.view.posAtDOM(range.startContainer, range.startOffset); to = editor.view.posAtDOM(range.endContainer, range.endOffset);
      } else if (context.x !== undefined && !context.selectedText) {
        const position = editor.view.posAtCoords({ left: context.x, top: context.y });
        if (position) from = to = position.pos;
      }
    } else {
      blocks = textIndex(source.text);
      let range = context.range || this.app.restoreContextRange();
      if (context.x !== undefined && !context.selectedText) {
        if (document.caretRangeFromPoint) range = document.caretRangeFromPoint(context.x, context.y);
        else { const caret = document.caretPositionFromPoint?.(context.x, context.y); if (caret) { range = document.createRange(); range.setStart(caret.offsetNode, caret.offset); range.collapse(true); } }
      }
      const root = this.textRoots().find(({ source: candidate, element }) => candidate.key === source.key && range && element.contains(range.startContainer))?.element;
      if (context.from !== undefined) { from = context.from; to = context.to ?? from; }
      else if (root && range) {
        ({ from, to } = textRangeOffsets(root, range, source.text));
      } else return this.app.toast('Выберите место в тексте.');
    }
    const kind = from !== to ? 'range' : this.settings.bookmarkMode;
    if (kind === 'range' && from === to) { const block = blocks.find(block => from >= block.from && from <= block.to); if (block) { from = block.from; to = block.to; } }
    const anchor = anchorAt(blocks, Math.min(from, to), Math.max(from, to), kind, readText);
    if (!anchor) return this.app.toast('Сначала добавьте текст.');
    if (this.rebinding) {
      const pending = this.rebinding;
      if (pending.sourceKey !== source.key) return this.app.toast('Выберите место в исходном документе закладки.');
      const values = structuredClone(source.values), bookmark = values.find(value => value.id === pending.id);
      if (!bookmark) return;
      bookmark.parts[pending.partIndex].anchor = anchor; this.rebinding = null;
      await this.change(source.key, values); this.app.toast('Привязка обновлена.'); return;
    }
    const normalized = source.rich ? source.values : normalizeBookmarks(source.values, blocks, { plain: true, ownerKey: source.key });
    const number = Math.max(0, ...normalized.flatMap(bookmark => bookmark.parts.map(part => Number(part.title.match(/^Закладка (\d+)$/u)?.[1]) || 0))) + 1;
    const bookmark = makeBookmark(anchor, { number, titleLength: this.settings.bookmarkTitleLength, ownerKey: source.key });
    const overlapping = normalized.filter(value => overlapsBookmark(value, bookmark));
    if (overlapping.length) {
      const choice = await this.stackChoice(overlapping[0]);
      if (choice === 'edit') return this.edit(source.key, overlapping[0].id);
      if (choice !== 'create') return;
      const merged = { ...overlapping[0], parts: [...overlapping.flatMap(value => value.parts), ...bookmark.parts] };
      await this.change(source.key, [...normalized.filter(value => !overlapping.some(other => other.id === value.id)), merged], { folding: true });
      this.app.toast('Создана сложенная закладка.');
    } else { await this.change(source.key, [...normalized, bookmark]); this.app.toast('Закладка установлена.'); }
  }
  stackChoice(bookmark) {
    return new Promise(resolve => {
      const overlay = document.getElementById('form-overlay');
      this.app.presentFormModal(`<div class="form-modal bookmark-choice"><h2>Создать сложенную закладку?</h2><p>В этом месте уже есть «${escapeHtml(titleOf(bookmark))}». У каждой части останутся своё название и заметка.</p><div class="form-actions"><button type="button" class="pill-btn" data-choice="edit">Редактировать текущую</button><button type="button" class="pill-btn ai-btn" data-choice="create">Создать</button><button type="button" class="btn-icon" data-choice="cancel" aria-label="Отмена"><i class="bx bx-x"></i></button></div></div>`);
      overlay.classList.add('active');
      let settled = false;
      const finish = value => { if (settled) return; settled = true; observer.disconnect(); document.removeEventListener('keydown', onKey); overlay.classList.remove('active'); resolve(value); };
      const onKey = event => { if (event.key === 'Escape') finish('cancel'); };
      const observer = new MutationObserver(() => { if (!overlay.classList.contains('active')) finish('cancel'); }); observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
      document.addEventListener('keydown', onKey);
      overlay.querySelectorAll('[data-choice]').forEach(button => button.onclick = () => finish(button.dataset.choice));
    });
  }
  textRoots() {
    const roots = [...document.querySelectorAll('.lore-detail-main:not(.timeline-associations-panel) > p, .note-read-text, #notes-input, [data-bookmark-text]')].flatMap(element => {
      const source = this.sourceForElement(element);
      return source && !source.rich ? [{ source, element }] : [];
    });
    for (const [field, mirror] of this.textareaMirrors) if (!field.isConnected) { clearBookmarkLayer(mirror); mirror.remove(); this.textareaMirrors.delete(field); }
    for (const field of document.querySelectorAll('textarea[data-bookmark-source], textarea[data-mobile-notes-input]')) {
      const source = this.sourceForElement(field);
      if (!source || !source.values.length || !field.getClientRects().length) continue;
      let mirror = this.textareaMirrors.get(field);
      if (!mirror) { mirror = document.createElement('div'); mirror.className = 'bookmark-textarea-mirror'; mirror.setAttribute('aria-hidden', 'true'); field.parentElement.append(mirror); this.textareaMirrors.set(field, mirror); }
      const style = getComputedStyle(field), rect = field.getBoundingClientRect(), host = field.parentElement;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const parent = host.getBoundingClientRect();
      for (const name of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'textAlign', 'wordBreak', 'overflowWrap', 'textIndent']) mirror.style[name] = style[name];
      Object.assign(mirror.style, { left: `${rect.left - parent.left + field.clientLeft}px`, top: `${rect.top - parent.top + field.clientTop - field.scrollTop}px`, width: `${field.clientWidth}px` });
      if (mirror.textContent !== source.text) mirror.textContent = source.text || '\u200b';
      roots.push({ source, element: mirror, clipElement: field });
    }
    return roots;
  }
  drawEditor(paneId, view) {
    const source = this.paneSource(paneId);
    if (!source) return;
    drawBookmarkLayer(view.dom, bookmarkPluginKey.getState(view.state) || [], {
      rangeAt: (from, to) => { const start = view.domAtPos(from), end = view.domAtPos(to); const range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset); return range; },
      paragraphAt: pos => { const resolved = view.state.doc.resolve(pos); return resolved.depth ? view.nodeDOM(resolved.before(resolved.depth)) : null; },
      onJump: id => this.jump(source.key, id, paneId), onEdit: id => this.edit(source.key, id), activeId: this.app.state.activeBookmarkIdByPane?.[paneId], settings: this.settings, ownerKey: source.key,
    });
    this.resizeObserver.observe(view.dom);
  }
  refresh() {
    cancelAnimationFrame(this.refreshFrame);
    this.refreshFrame = requestAnimationFrame(() => {
      for (const [paneId, instance] of this.app.nocturneEditor.instances) this.drawEditor(paneId, instance.editor.view);
      for (const { source, element, clipElement } of this.textRoots()) drawBookmarkLayer(element, source.values, {
        clipRect: clipElement ? () => clipElement.getBoundingClientRect() : null,
        rangeAt: (from, to) => rangeInText(element, from, to, source.text), paragraphAt: pos => {
          const block = textIndex(source.text).find(block => pos >= block.from && pos <= block.to);
          return block ? { getBoundingClientRect: () => rangeInText(element, block.from, block.to, source.text)?.getBoundingClientRect() || element.getBoundingClientRect() } : element;
        },
        onJump: id => this.jump(source.key, id), onEdit: id => this.edit(source.key, id), activeId: this.activePlainId, settings: this.settings, ownerKey: source.key,
      });
    });
  }
  clearEditor(view) { if (view?.dom) { this.resizeObserver.unobserve(view.dom); clearBookmarkLayer(view.dom); } }
  async openOwner(source) {
    if (source.rich) { this.app.selectDoc(source.owner.id); if (this.app.isMobileLayout()) this.app.closeMobileToEditor(); }
    else if (source.owner.kind === 'doc' && source.owner.field === 'description') {
      this.app.selectDoc(source.owner.id); this.app.editDocForm(source.owner.id);
    } else if (source.owner.kind === 'doc' || source.owner.kind === 'global') {
      if (source.owner.kind === 'doc') this.app.selectDoc(source.owner.id);
      this.app.state.noteMode = source.owner.kind === 'global' ? 'global' : 'document'; this.app.renderNotes();
      if (this.app.isMobileLayout()) { this.app.state.mobile.notesMode = source.owner.kind === 'global' ? 'global' : 'document'; this.app.state.mobile.panel = 'notes'; this.app.renderMobileShell(); }
      else document.getElementById('notes-panel')?.classList.add('open');
    } else {
      if (source.owner.worldId !== this.app.state.activeLoreId) { this.app.state.activeLoreId = source.owner.worldId; this.app.state.settings.activeLoreId = source.owner.worldId; this.app.state.lore = await this.app.loadLore(); await this.app.persistSettings(); }
      if (source.owner.type === 'rules') {
        this.app.presentFormModal(`<div class="form-modal utility-modal"><div class="modal-head-row"><h2>Правило мира</h2><button type="button" class="btn-icon" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div><p class="bookmark-plain-preview" data-bookmark-text data-bookmark-source="${escapeHtml(source.key)}">${escapeHtml(source.text)}</p><button type="button" class="pill-btn" data-bookmark-action="add" data-owner="${escapeHtml(source.key)}">Поставить закладку</button></div>`);
        document.querySelector('#form-overlay [data-close-form]').onclick = () => document.getElementById('form-overlay').classList.remove('active');
        await new Promise(resolve => requestAnimationFrame(resolve)); this.refresh(); return;
      }
      this.app.state.activeLoreDetail = { type: source.owner.type, id: source.owner.id };
      this.app.state.activeKbTab = source.owner.type === 'subtimeline' ? 'timeline' : source.owner.type;
      this.app.state.mobile.kbTab = this.app.state.activeKbTab;
      this.app.state.kbReadMode = source.owner.type === 'notes';
      if (this.app.isMobileLayout()) this.app.switchMobileTab('lore');
      else { document.getElementById('kb-modal')?.classList.add('active'); this.app.renderKb(); }
    }
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    this.refresh();
  }
  async jump(key, id, paneId = null) {
    document.dispatchEvent(new Event('nocturne:skip-modal-focus-restore'));
    let source = this.source(key), bookmark = source?.values.find(value => value.id === id);
    if (!bookmark) return;
    if (!attached(bookmark)) { this.app.toast('Привязка потеряна. Выберите новое место.'); return this.edit(key, id); }
    if (source.rich && this.app.isMobileLayout() && (this.app.state.mobile.activeTab !== 'write' || this.app.state.mobile.panel)) {
      this.app.closeMobileToEditor(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }
    let instance = source.rich ? [...this.app.nocturneEditor.instances.values()].find(instance => instance.docId === source.owner.id && (!paneId || instance.paneId === paneId)) : null;
    const visiblePlainRoot = () => this.textRoots().find(entry => entry.source.key === key && entry.element.getClientRects().length && getComputedStyle(entry.element).visibility !== 'hidden' && (!entry.element.closest('#notes-panel') || entry.element.closest('#notes-panel').classList.contains('open')))?.element;
    let root = source.rich ? instance?.editor.view.dom : visiblePlainRoot();
    if (!root) { await this.openOwner(source); source = this.source(key); instance = [...this.app.nocturneEditor.instances.values()].find(instance => instance.docId === source.owner.id); root = source.rich ? instance?.editor.view.dom : visiblePlainRoot(); }
    if (!root) return this.app.toast('Откройте текст закладки, чтобы перейти к месту.');
    const bound = bookmarkBounds(bookmark); let rect;
    const focused = document.activeElement;
    if (this.app.isMobileLayout() && focused?.closest('.ProseMirror, textarea, [contenteditable="true"]')) focused.blur();
    if (source.rich) {
      if (revealViewportPosition(instance.editor.view, instance.pageShell, bound.to)) this.app.nocturneEditor.flushVisualPages(instance.paneId);
      const coordinates = instance.editor.view.coordsAtPos(bound.to); rect = { top: coordinates.top, bottom: coordinates.bottom };
      const targetPane = instance.paneId; this.app.state.activeBookmarkIdByPane ||= {}; this.app.state.activeBookmarkIdByPane[targetPane] = id;
    } else { const range = rangeInText(root, bound.to, bound.to, source.text); rect = range?.getBoundingClientRect(); this.activePlainId = id; }
    let scroller = root.parentElement;
    while (scroller.parentElement && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (scroller === document.body) scroller = document.scrollingElement;
    if (rect) {
      const viewport = scroller.getBoundingClientRect();
      const host = source.rich ? instance.pageShell : root;
      if (host) host.style.paddingBottom = `${Math.max(parseFloat(getComputedStyle(host).paddingBottom) || 0, viewport.height / 2)}px`;
      let target = scroller.scrollTop + (rect.top + rect.bottom) / 2 - (viewport.top + viewport.height / 2);
      if (target < 0) { scroller.style.paddingTop = `${(parseFloat(getComputedStyle(scroller).paddingTop) || 0) - target}px`; target = 0; }
      scroller.scrollTo({ top: target, behavior: this.app.shouldReduceSurfaceMotion() ? 'auto' : 'smooth' });
    }
    source.record.lastBookmarkId = id;
    this.refresh(); this.refreshMenus();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (this.app.isMobileLayout() && document.activeElement?.closest('.ProseMirror, textarea, [contenteditable="true"]')) document.activeElement.blur();
      flashBookmark(root, id, this.app.shouldReduceSurfaceMotion());
    }));
    this.persist(source).catch(error => this.app.toast(error.message));
  }
  async remove(key, id, { confirm = true } = {}) {
    const source = this.source(key), bookmark = source?.values.find(value => value.id === id);
    if (!bookmark) return;
    if (confirm && this.settings.bookmarkConfirmDeletion && !await this.app.confirmDialog({ title: 'Удалить закладку?', message: `«${titleOf(bookmark)}» попадёт в корзину.`, confirmText: 'Удалить' })) return false;
    await this.change(key, source.values.filter(value => value.id !== id)); this.app.toast('Закладка перемещена в корзину.'); return true;
  }
  find(id, paneId = null) {
    const preferred = this.paneSource(paneId || this.app.state.workspace.focusedPaneId);
    return preferred?.values.some(value => value.id === id) ? preferred : this.sources().find(source => source.values.some(value => value.id === id));
  }
  groups() {
    const groups = new Map();
    for (const source of this.sources()) {
      if (this.filter === 'lore' && source.owner.kind !== 'lore' || this.filter === 'docs' && source.owner.kind !== 'doc') continue;
      for (const bookmark of source.values) {
        if (!bookmark.parts) continue;
        if (this.status === 'unresolved' && !bookmark.parts.some(part => part.anchor.status === 'unresolved') || this.status === 'attached' && !attached(bookmark)) continue;
        const haystack = `${source.title} ${titleOf(bookmark)} ${bookmark.parts.map(part => `${part.note} ${part.tags.join(' ')}`).join(' ')}`.toLocaleLowerCase('ru');
        if (this.query && !haystack.includes(this.query.toLocaleLowerCase('ru'))) continue;
        const key = `${bookmark.groupId || bookmark.id}:${bookmarkSignature(bookmark)}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ source, bookmark });
      }
    }
    return [...groups.values()].sort((a, b) => this.settings.bookmarkBehavior === 'time' ? a[0].bookmark.createdAt - b[0].bookmark.createdAt : this.settings.bookmarkBehavior === 'manual' ? a[0].bookmark.order - b[0].bookmark.order : a[0].source.title.localeCompare(b[0].source.title, 'ru') || bookmarkBounds(a[0].bookmark).from - bookmarkBounds(b[0].bookmark).from);
  }
  scopeSwitcher() {
    const tabs = [['lore', 'Закладки Базы знаний'], ['docs', 'Закладки рукописей'], ['all', 'Все закладки']];
    return `<div class="bookmark-scope-switch" role="group" aria-label="Область закладок" style="--bookmark-tab-index:${tabs.findIndex(([id]) => id === this.filter)}"><span class="bookmark-scope-indicator" aria-hidden="true"></span>${tabs.map(([id, label]) => `<button type="button" data-bookmark-action="scope" data-value="${id}" aria-pressed="${id === this.filter}">${label}</button>`).join('')}</div>`;
  }
  manager() {
    return `<section class="bookmark-manager"><div class="kb-header"><div><h1>Закладки</h1><p class="bookmark-manager-subtitle">Сохранённые места и фрагменты</p></div><button type="button" class="pill-btn" data-action="open-trash"><i class="bx bx-trash"></i> Корзина</button></div>${this.scopeSwitcher()}<div class="bookmark-manager-tools"><label class="bookmark-search"><i class="bx bx-search" aria-hidden="true"></i><input class="form-control" data-bookmark-search aria-label="Поиск закладок" placeholder="Название, заметка, метка…" value="${escapeHtml(this.query)}"></label><label class="bookmark-status-label">Привязка<select class="form-control" data-bookmark-status><option value="all"${this.status === 'all' ? ' selected' : ''}>Все</option><option value="attached"${this.status === 'attached' ? ' selected' : ''}>На месте</option><option value="unresolved"${this.status === 'unresolved' ? ' selected' : ''}>Нужно выбрать место</option></select></label></div><div class="bookmark-bulk-actions"><button type="button" class="pill-btn" data-bookmark-action="select-all">Выбрать все</button><button type="button" class="pill-btn danger-btn" data-bookmark-action="delete-selected">В корзину выбранные</button><span data-bookmark-selection-count aria-live="polite">${this.selected.size ? `Выбрано: ${this.selected.size}` : ''}</span></div><div class="bookmark-manager-list">${this.managerRows()}</div></section>`;
  }
  managerRows() {
    const groups = this.groups();
    if (!groups.length) return this.app.emptyStateMarkup('bx-bookmark', this.query ? 'Закладки не найдены' : 'Закладок пока нет', 'Выберите место в тексте и нажмите Ctrl+Shift+B или «Поставить закладку» в меню.');
    return groups.map(variants => {
      const { source, bookmark } = variants[0], color = bookmark.parts[0].color;
      return `<article class="bookmark-manager-row" data-surface-key="bookmark-${escapeHtml(bookmark.id)}"${color ? ` style="--bookmark-color:${escapeHtml(color)}"` : ''}><label class="bookmark-select"><input type="checkbox" data-bookmark-select="${escapeHtml(source.key)}" data-bookmark-id="${escapeHtml(bookmark.id)}" aria-label="Выбрать ${escapeHtml(titleOf(bookmark))}"${this.selected.has(`${source.key}~${bookmark.id}`) ? ' checked' : ''}></label><button type="button" class="bookmark-manager-main" data-bookmark-action="edit" data-owner="${escapeHtml(source.key)}" data-bookmark-id="${escapeHtml(bookmark.id)}"><span class="bookmark-row-icon"><i class="bx ${bookmark.parts.length > 1 ? 'bx-layer' : 'bxs-bookmark'}" aria-hidden="true"></i></span><span class="bookmark-row-copy"><strong>${escapeHtml(titleOf(bookmark))}${variants.length > 1 ? `<span class="bookmark-copies-count">+${variants.length - 1}</span>` : ''}</strong><small>${escapeHtml(source.title)} · ${escapeHtml(labels[bookmark.parts[0].anchor.kind])}${!attached(bookmark) ? ' · Требуется привязка' : ''}</small>${bookmark.parts.some(part => part.note) ? `<span class="bookmark-row-note">${escapeHtml(bookmark.parts.map(part => part.note).filter(Boolean).join(' · '))}</span>` : ''}${bookmark.parts.some(part => part.tags.length) ? `<span class="bookmark-row-tags">${bookmark.parts.flatMap(part => part.tags).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</span>` : ''}</span></button><div class="bookmark-row-actions"><button type="button" class="btn-icon" data-bookmark-action="jump" data-owner="${escapeHtml(source.key)}" data-bookmark-id="${escapeHtml(bookmark.id)}" aria-label="Перейти к закладке"><i class="bx bx-navigation"></i></button>${this.settings.bookmarkBehavior === 'manual' ? `<button type="button" class="btn-icon" data-bookmark-action="up" data-owner="${escapeHtml(source.key)}" data-bookmark-id="${escapeHtml(bookmark.id)}" aria-label="Выше в списке"><i class="bx bx-up-arrow-alt"></i></button><button type="button" class="btn-icon" data-bookmark-action="down" data-owner="${escapeHtml(source.key)}" data-bookmark-id="${escapeHtml(bookmark.id)}" aria-label="Ниже в списке"><i class="bx bx-down-arrow-alt"></i></button>` : ''}<button type="button" class="btn-icon" data-bookmark-action="delete" data-owner="${escapeHtml(source.key)}" data-bookmark-id="${escapeHtml(bookmark.id)}" aria-label="Удалить закладку"><i class="bx bx-trash"></i></button></div></article>`;
    }).join('');
  }
  refreshManager() {
    for (const list of document.querySelectorAll('.bookmark-manager-list')) this.app.updateSurfaceHTML(list, this.managerRows());
    document.querySelectorAll('[data-bookmark-selection-count]').forEach(element => { element.textContent = this.selected.size ? `Выбрано: ${this.selected.size}` : ''; });
  }
  async edit(key, id, variants = null) {
    const source = this.source(key), bookmark = source?.values.find(value => value.id === id);
    if (!bookmark) return;
    variants ||= this.sources().flatMap(candidate => candidate.values.filter(value => value.groupId === bookmark.groupId && bookmarkSignature(value) === bookmarkSignature(bookmark)).map(value => ({ source: candidate, bookmark: value })));
    const overlay = document.getElementById('form-overlay');
    this.app.presentFormModal(`<form class="form-modal bookmark-edit-modal"><div class="modal-head-row"><div><h2>${bookmark.parts.length > 1 ? 'Сложенная закладка' : 'Закладка'}</h2><p>${escapeHtml(source.title)}</p></div><button type="button" class="btn-icon" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div>${variants.length > 1 ? `<div class="bookmark-variant-switch" role="group" aria-label="Оригинал и копии">${variants.map((variant, index) => `<button type="button" class="pill-btn ${variant.bookmark.id === id ? 'ai-btn' : ''}" data-bookmark-variant="${index}" aria-pressed="${variant.bookmark.id === id}">${index === 0 ? 'Оригинал' : `Копия ${index}`}</button>`).join('')}</div>` : ''}<div class="bookmark-edit-parts">${bookmark.parts.map((part, index) => `<fieldset class="bookmark-part-fields"><legend>${bookmark.parts.length > 1 ? `Часть ${index + 1} · ` : ''}${labels[part.anchor.kind]}</legend><label>Название<input class="form-control" name="title-${index}" value="${escapeHtml(part.title)}" maxlength="160" required></label><label>Заметка<textarea class="form-control" name="note-${index}" maxlength="4000" rows="3">${escapeHtml(part.note)}</textarea></label><div class="bookmark-edit-extras"><label>Цвет<input type="color" name="color-${index}" value="${part.color || this.app.state.settings.accent}"></label><label>Метки через запятую<input class="form-control" name="tags-${index}" value="${escapeHtml(part.tags.join(', '))}" maxlength="800"></label></div><p class="bookmark-anchor-preview">${part.anchor.status === 'unresolved' ? 'Место потеряно. Выберите его вручную.' : escapeHtml(part.anchor.quote || 'Точная позиция в тексте')}</p><button type="button" class="pill-btn" data-rebind-part="${index}"><i class="bx bx-map-pin"></i> Выбрать новое место</button></fieldset>`).join('')}</div><div class="form-actions"><button type="button" class="pill-btn" data-jump-edit>Перейти</button><button type="button" class="pill-btn danger-btn" data-delete-edit>В корзину</button><button class="pill-btn ai-btn" type="submit">Сохранить</button></div></form>`);
    overlay.classList.add('active');
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    const readValues = () => {
      const form = overlay.querySelector('form'), values = structuredClone(this.source(key).values), value = values.find(value => value.id === id);
      for (const [index, part] of value.parts.entries()) {
        part.title = form.elements[`title-${index}`].value.trim().slice(0, 160) || part.title;
        part.note = form.elements[`note-${index}`].value.slice(0, 4000);
        const color = form.elements[`color-${index}`].value;
        part.color = !part.color && color.toLowerCase() === String(this.app.state.settings.accent).toLowerCase() ? '' : color;
        part.tags = [...new Set(form.elements[`tags-${index}`].value.split(',').map(tag => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
      }
      return values;
    };
    overlay.querySelectorAll('[data-bookmark-variant]').forEach(button => button.onclick = async () => {
      try { const values = readValues(); if (JSON.stringify(values) !== JSON.stringify(this.source(key).values)) await this.change(key, values); const variant = variants[Number(button.dataset.bookmarkVariant)]; await this.edit(variant.source.key, variant.bookmark.id, variants); } catch (error) { this.app.toast(error.message); }
    });
    overlay.querySelector('[data-jump-edit]').onclick = () => { overlay.classList.remove('active'); document.getElementById('kb-modal')?.classList.remove('active'); this.jump(key, id); };
    overlay.querySelector('[data-delete-edit]').onclick = () => this.remove(key, id).then(deleted => { if (deleted) overlay.classList.remove('active'); else this.edit(key, id, variants); });
    overlay.querySelectorAll('[data-rebind-part]').forEach(button => button.onclick = async () => { this.rebinding = { sourceKey: key, id, partIndex: Number(button.dataset.rebindPart) }; overlay.classList.remove('active'); document.getElementById('kb-modal')?.classList.remove('active'); await this.openOwner(source); this.app.toast('Выберите новое место и нажмите «Поставить закладку» или Ctrl+Shift+B.'); });
    overlay.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      try { await this.change(key, readValues()); overlay.classList.remove('active'); this.app.toast('Закладка сохранена.'); } catch (error) { this.app.toast(error.message); }
    };
  }
  refreshMenus() { for (const paneId of Object.keys(this.app.state.workspace?.panes || {})) this.menu(paneId); }
  sorted(source) {
    return [...source.values].sort(this.settings.bookmarkBehavior === 'time' ? (a, b) => a.createdAt - b.createdAt : this.settings.bookmarkBehavior === 'manual' ? (a, b) => a.order - b.order : (a, b) => bookmarkBounds(a).from - bookmarkBounds(b).from);
  }
  menu(paneId) {
    const pane = document.querySelector(`.workspace-pane[data-pane-id="${CSS.escape(paneId)}"]`), source = this.paneSource(paneId), actions = pane?.querySelector('.pane-header-actions');
    if (!actions) return;
    const open = !!pane.querySelector('.pane-bookmarks-dropdown.active');
    pane.querySelector('.pane-bookmarks-widget')?.remove(); pane.querySelector('.pane-bookmarks-dropdown')?.remove();
    if (!source) return;
    const values = this.sorted(source), activeId = this.app.state.activeBookmarkIdByPane?.[paneId], index = values.findIndex(value => value.id === activeId);
    const widget = document.createElement('div'); widget.className = 'pane-bookmarks-widget';
    widget.innerHTML = `<button type="button" class="pane-bookmarks-btn" aria-expanded="${open}" aria-controls="pane-bookmarks-${paneId}" aria-label="Закладки: ${values.length}"><i class="bx bx-bookmark" aria-hidden="true"></i><span>Закладки</span><span class="bookmarks-count">${values.length}</span><i class="bx bx-chevron-down" aria-hidden="true"></i></button>`;
    const dropdown = document.createElement('div'); dropdown.id = `pane-bookmarks-${paneId}`; dropdown.className = `pane-bookmarks-dropdown${open ? ' active' : ''}`; dropdown.setAttribute('aria-hidden', String(!open));
    dropdown.innerHTML = `<div class="pane-bookmarks-header"><strong>Закладки</strong><span class="pane-bookmarks-position">${index < 0 ? '—' : index + 1} / ${values.length}</span><div class="pane-bookmarks-nav"><button type="button" class="pane-bookmarks-nav-btn" data-direction="-1" aria-label="Предыдущая закладка"${values.length ? '' : ' disabled'}><i class="bx bx-chevron-left"></i></button><button type="button" class="pane-bookmarks-nav-btn" data-direction="1" aria-label="Следующая закладка"${values.length ? '' : ' disabled'}><i class="bx bx-chevron-right"></i></button></div></div><div class="pane-bookmarks-list">${values.length ? values.map(value => `<div class="pane-bookmarks-item${value.id === activeId ? ' active' : ''}"><button type="button" class="pane-bookmarks-item-text" data-jump="${escapeHtml(value.id)}">${escapeHtml(titleOf(value))}</button><button type="button" class="pane-bookmarks-item-delete btn-icon" data-edit="${escapeHtml(value.id)}" aria-label="Изменить закладку"><i class="bx bx-pencil"></i></button><button type="button" class="pane-bookmarks-item-delete btn-icon" data-delete="${escapeHtml(value.id)}" aria-label="Удалить закладку"><i class="bx bx-trash"></i></button></div>`).join('') : '<p class="pane-bookmarks-empty">Выберите место в тексте, чтобы установить закладку.</p>'}</div><button type="button" class="pane-bookmarks-add"><i class="bx bx-plus"></i> Добавить в текущем месте</button>`;
    const close = () => { dropdown.classList.remove('active'); dropdown.setAttribute('aria-hidden', 'true'); widget.querySelector('button').setAttribute('aria-expanded', 'false'); };
    widget.querySelector('button').onclick = event => { event.stopPropagation(); const isOpen = dropdown.classList.toggle('active'); dropdown.setAttribute('aria-hidden', String(!isOpen)); widget.querySelector('button').setAttribute('aria-expanded', String(isOpen)); };
    dropdown.querySelector('.pane-bookmarks-add').onpointerdown = event => event.preventDefault();
    dropdown.querySelector('.pane-bookmarks-add').onclick = () => this.addCurrent(paneId);
    dropdown.querySelectorAll('[data-jump]').forEach(button => button.onclick = () => { close(); this.jump(source.key, button.dataset.jump, paneId); });
    dropdown.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => { close(); this.edit(source.key, button.dataset.edit); });
    dropdown.querySelectorAll('[data-delete]').forEach(button => button.onclick = () => this.remove(source.key, button.dataset.delete));
    dropdown.querySelectorAll('[data-direction]').forEach(button => button.onclick = () => {
      const direction = Number(button.dataset.direction), editor = this.app.nocturneEditor.get(paneId);
      const cursor = this.settings.bookmarkNavigation === 'caret' && editor ? editor.state.selection.from : null;
      let target = cursor === null ? index + direction : direction > 0 ? values.findIndex(value => bookmarkBounds(value).from > cursor) : values.findLastIndex(value => bookmarkBounds(value).from < cursor);
      if (index < 0 && cursor === null) target = direction > 0 ? 0 : values.length - 1;
      if (target < 0 || target >= values.length) { if (!this.settings.bookmarkWrap) return; target = direction > 0 ? 0 : values.length - 1; }
      this.jump(source.key, values[target].id, paneId);
    });
    const outside = event => { if (!widget.contains(event.target) && !dropdown.contains(event.target)) close(); };
    const key = event => { if (event.key === 'Escape' && dropdown.classList.contains('active')) { close(); widget.querySelector('button').focus(); } };
    document.addEventListener('click', outside); document.addEventListener('keydown', key);
    const observer = new MutationObserver(() => { if (!widget.isConnected) { observer.disconnect(); document.removeEventListener('click', outside); document.removeEventListener('keydown', key); } }); observer.observe(pane, { childList: true });
    actions.prepend(widget); pane.append(dropdown);
  }
  mobileList() {
    const paneId = this.app.state.workspace.focusedPaneId, source = this.paneSource(paneId), values = source ? this.sorted(source) : [];
    return `${this.app.mobilePanelHeader('Закладки', source?.title || 'Текущий текст')}<div class="mobile-panel-body"><button class="pill-btn ai-btn" data-action="mobile-add-bookmark"${source ? '' : ' disabled'}><i class="bx bx-plus"></i> В текущем месте</button><div class="mobile-bookmarks-list">${values.length ? values.map((bookmark, index) => `<div class="mobile-bookmark-row"><button data-action="mobile-jump-bookmark" data-bookmark-id="${escapeHtml(bookmark.id)}" data-bookmark-pane="${paneId}"><i class="bx bx-bookmark"></i><span><small>Закладка ${index + 1}</small><strong>${escapeHtml(titleOf(bookmark))}</strong></span></button><button type="button" class="mini-icon-btn" data-bookmark-action="edit" data-owner="${escapeHtml(source.key)}" data-bookmark-id="${escapeHtml(bookmark.id)}" aria-label="Изменить закладку"><i class="bx bx-pencil"></i></button><button class="mini-icon-btn" data-action="mobile-delete-bookmark" data-bookmark-id="${escapeHtml(bookmark.id)}" aria-label="Удалить закладку"><i class="bx bx-trash"></i></button></div>`).join('') : this.app.emptyStateMarkup('bx-bookmark', 'Сохраните место в тексте', 'Закладка поможет вернуться к нужной сцене.')}</div><button type="button" class="pill-btn" data-bookmark-action="manager">Все закладки</button></div>`;
  }
  handleClick(event) {
    const button = event.target.closest('[data-bookmark-action]');
    if (!button) return false;
    const action = button.dataset.bookmarkAction, key = button.dataset.owner, id = button.dataset.bookmarkId;
    const run = async () => {
      if (action === 'add-notes') {
        const field = document.querySelector(this.app.isMobileLayout() ? '[data-mobile-notes-input]' : '#notes-input'), source = this.sourceForElement(field);
        if (!source) return;
        const selection = getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        const context = field.tagName === 'TEXTAREA' ? { sourceKey: source.key, from: field.selectionStart, to: field.selectionEnd } : { sourceKey: source.key, range };
        await this.addContext(context);
      }
      if (action === 'add') await this.addContext({ ...this.capture(this.app.state.workspace.focusedPaneId), sourceKey: key });
      if (action === 'scope') { this.filter = button.dataset.value; const switcher = button.closest('.bookmark-scope-switch'); switcher.style.setProperty('--bookmark-tab-index', ['lore', 'docs', 'all'].indexOf(this.filter)); switcher.querySelectorAll('button').forEach(element => element.setAttribute('aria-pressed', String(element === button))); this.refreshManager(); }
      if (action === 'edit') await this.edit(key, id);
      if (action === 'delete') await this.remove(key, id);
      if (action === 'jump') { document.getElementById('kb-modal')?.classList.remove('active'); await this.jump(key, id); }
      if (action === 'manager') { this.app.state.activeLoreDetail = null; this.app.state.activeKbTab = 'bookmarks'; this.app.state.mobile.kbTab = 'bookmarks'; if (this.app.isMobileLayout()) this.app.switchMobileTab('lore'); else this.app.openKb('bookmarks'); }
      if (action === 'select-all') { for (const group of this.groups()) for (const variant of group) this.selected.add(`${variant.source.key}~${variant.bookmark.id}`); this.refreshManager(); }
      if (action === 'delete-selected') {
        if (!this.selected.size) return;
        if (this.settings.bookmarkConfirmDeletion && !await this.app.confirmDialog({ title: 'Удалить выбранные закладки?', message: `${this.selected.size} закладок попадут в корзину.`, confirmText: 'В корзину' })) return;
        for (const source of this.sources()) { const next = source.values.filter(value => !this.selected.has(`${source.key}~${value.id}`)); if (next.length !== source.values.length) await this.change(source.key, next); }
        this.selected.clear(); this.refreshManager();
      }
      if (action === 'up' || action === 'down') {
        const groups = this.groups(), index = groups.findIndex(group => group.some(variant => variant.bookmark.id === id)), target = index + (action === 'up' ? -1 : 1);
        if (!groups[target]) return;
        [groups[index], groups[target]] = [groups[target], groups[index]];
        const updates = new Map();
        groups.forEach((group, order) => group.forEach(({ source, bookmark }) => { if (!updates.has(source.key)) updates.set(source.key, structuredClone(source.values)); updates.get(source.key).find(value => value.id === bookmark.id).order = order; }));
        for (const [owner, values] of updates) await this.change(owner, values);
      }
    };
    run().catch(error => this.app.toast(error.message)); return true;
  }
  handleInput(event) {
    if (this.sourceForElement(event.target)) { this.lastPlainInput = performance.now(); this.refresh(); }
    if (event.target.matches('[data-bookmark-search]')) { this.query = event.target.value; this.refreshManager(); return true; }
    if (event.target.matches('[data-bookmark-status]')) { this.status = event.target.value; this.refreshManager(); return true; }
    if (event.target.matches('[data-bookmark-select]')) { const key = `${event.target.dataset.bookmarkSelect}~${event.target.dataset.bookmarkId}`; if (event.target.checked) this.selected.add(key); else this.selected.delete(key); return true; }
    return false;
  }
  settingsContent(row, toggle, select, range) {
    return `<div class="tab-content active"><div class="setting-group-title">Создание и привязка</div>${row('Тип новой закладки', 'Без выделения. Выделенный текст сохраняется целиком как фрагмент.', select('bookmarkMode', [['point', 'Точная позиция'], ['paragraph', 'Абзац'], ['range', 'Фрагмент']]))}${row('Длина автоматического названия', 'Первые слова фрагмента или абзаца. Название можно изменить.', range('bookmarkTitleLength', 20, 100, 1))}${row('Следовать за текстом', 'Сдвигать привязку при вставке и удалении текста перед закладкой.', toggle('bookmarkFollowText'))}${row('Копирование закладки вместе с текстом', 'Передавать метаданные в буфере приложения вместе с выделением. Сам текст остаётся чистым.', toggle('bookmarkCopyWithText'))}<div class="setting-group-title">Удаление</div>${row('Подтверждение удаления закладки при удалении текста с ней', 'Отмена сохраняет текст. Частичное удаление фрагмента или абзаца оставляет закладку.', toggle('bookmarkConfirmTextDeletion'))}${row('Если весь отмеченный текст удалён', 'Для точной позиции — если удалён её участок.', select('bookmarkDeletedText', [['delete', 'В корзину'], ['detach', 'Сохранить без привязки'], ['nearest', 'К ближайшему месту']]))}${row('Подтверждение удаления закладки', 'Перед переносом закладки в корзину вручную.', toggle('bookmarkConfirmDeletion'))}<div class="setting-group-title">Вид и навигация</div>${row('Большой значок', 'Маленькая метка остаётся видна под текстом.', select('bookmarkVisibility', [['hover', 'При наведении или касании'], ['active', 'У активной закладки'], ['always', 'Всегда']]))}${row('Подсветка текста', 'Постоянная метка сохраняется при любом выборе.', select('bookmarkHighlight', [['jump', 'При переходе и наведении'], ['always', 'Всегда'], ['off', 'Только метка']]))}${row('Порядок закладок', 'Применяется к спискам и навигации.', select('bookmarkBehavior', [['text', 'По тексту'], ['time', 'По времени добавления'], ['manual', 'Вручную']]))}${row('Предыдущая и следующая', 'От выбранной закладки или текущего места редактирования.', select('bookmarkNavigation', [['list', 'По списку'], ['caret', 'От каретки']]))}${row('Переход по кругу', 'После последней закладки вернуться к первой.', toggle('bookmarkWrap'))}${row('При открытии документа', 'Переход к закладке не перемещает каретку и не открывает клавиатуру.', select('bookmarkReopen', [['position', 'Последняя позиция'], ['bookmark', 'Последняя выбранная закладка'], ['start', 'Начало документа']]))}<div class="setting-group-title">История</div>${row('Сохранение закладок снапшотами', 'Восстанавливать закладки вместе с текстом снимка.', toggle('bookmarkSnapshots'))}<p class="bookmark-settings-footnote">Ctrl+Shift+B — поставить закладку. Изменение и удаление можно отменить. Удалённые закладки доступны в корзине.</p></div>`;
  }
  searchSettings() {
    const options = {
      bookmarkMode: ['Тип новой закладки', [['point', 'Точная позиция'], ['paragraph', 'Абзац'], ['range', 'Фрагмент']]],
      bookmarkBehavior: ['Порядок закладок', [['text', 'По тексту'], ['time', 'По времени добавления'], ['manual', 'Вручную']]],
      bookmarkNavigation: ['Предыдущая и следующая закладка', [['list', 'По списку'], ['caret', 'От каретки']]],
      bookmarkDeletedText: ['Если весь отмеченный текст удалён', [['delete', 'В корзину'], ['detach', 'Сохранить без привязки'], ['nearest', 'К ближайшему месту']]],
      bookmarkVisibility: ['Большой значок закладки', [['hover', 'При наведении или касании'], ['active', 'У активной закладки'], ['always', 'Всегда']]],
      bookmarkHighlight: ['Подсветка текста закладки', [['jump', 'При переходе и наведении'], ['always', 'Всегда'], ['off', 'Только метка']]],
      bookmarkReopen: ['При открытии документа', [['position', 'Последняя позиция'], ['bookmark', 'Последняя выбранная закладка'], ['start', 'Начало документа']]],
    };
    const toggles = { bookmarkFollowText: 'Следовать за текстом', bookmarkCopyWithText: 'Копирование закладки вместе с текстом', bookmarkConfirmTextDeletion: 'Подтверждение удаления закладки при удалении текста с ней', bookmarkConfirmDeletion: 'Подтверждение удаления закладки', bookmarkWrap: 'Переход по кругу', bookmarkSnapshots: 'Сохранение закладок снапшотами' };
    return [...Object.entries(options).map(([key, [label, choices]]) => ({ key, label, options: choices, tab: 'bookmarks', type: 'select', note: 'Настройка закладок.' })), ...Object.entries(toggles).map(([key, label]) => ({ key, label, tab: 'bookmarks', type: 'toggle', note: 'Настройка закладок.' })), { key: 'bookmarkTitleLength', label: 'Длина автоматического названия закладки', tab: 'bookmarks', type: 'range', min: 20, max: 100, step: 1 }];
  }
}
