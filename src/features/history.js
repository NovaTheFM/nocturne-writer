import { buildSummary, countWords, docText, escapeHtml, uid } from '../core/utils.js';
import { tiptapJsonToLegacyAst } from '../editor/document-adapter.js';
import { diffText, textChange } from './manuscript-search.js';

const labels = { manual: 'Ручная версия', timer: 'По времени работы', growth: 'Рост текста', 'large-edit': 'Перед большой правкой', 'before-restore': 'Перед восстановлением', 'before-ai': 'Перед принятой правкой ИИ' };
const sentences = text => (text.match(/[.!?…]+(?:\s|$)/gu) || []).length;

export class HistoryController {
  constructor(app) {
    this.app = app;
    this.work = Promise.resolve();
    this.activity = new Map();
    this.growth = new Map();
    this.notified = new Set();
    this.suppressed = new Set();
  }

  start() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000);
    if (!this.bound) { this.bound = true; document.addEventListener('input', () => { this.lastInputAt = Date.now(); }); }
  }

  async records(docId) {
    return (await this.app.db.getAll('snapshots')).filter(item => item.docId === docId).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  }

  versionTitle(item) { return item.name || (item.reason === 'manual' ? 'Ручная версия' : new Date(item.createdAt).toLocaleString('ru-RU')); }

  async makeSnapshot(doc, options = {}) {
    const previous = (await this.records(doc.id)).find(item => !item.locked);
    const text = docText(doc.ast), delta = diffText(previous ? docText(previous.ast) : '', text);
    return {
      id: uid('snap'), docId: doc.id, title: doc.title, name: options.name || '', reason: options.reason || 'manual',
      pinned: options.reason === 'manual', createdAt: Date.now(), ast: structuredClone(doc.ast), pmJson: structuredClone(doc.pmJson),
      ...(this.app.state.settings.bookmarkSnapshots || ['before-restore', 'before-ai'].includes(options.reason) ? {
        bookmarks: structuredClone(doc.bookmarks || []), fieldBookmarks: structuredClone(doc.fieldBookmarks || {}), globalBookmarks: structuredClone(this.app.state.globalBookmarks || []),
      } : {}),
      notes: doc.notes || '', globalNotes: this.app.state.globalNotes || '',
      summary: buildSummary(doc.ast), wordCount: countWords(text), addedChars: delta.added, removedChars: delta.removed, approximateDelta: delta.approximate,
    };
  }

  capture(doc = this.app.getFocusedDoc(), options = {}) {
    if (!doc || doc.locked || this.app.resettingData || this.app.deletedDocIds?.has(doc.id)) return Promise.resolve(null);
    const captured = structuredClone(doc);
    const operation = this.work.catch(() => {}).then(async () => {
      if (this.app.deletedDocIds?.has(captured.id) || this.app.resettingData) return null;
      const snapshot = await this.makeSnapshot(captured, options);
      await this.app.db.put('snapshots', snapshot);
      await this.prune(captured.id);
      await this.checkSize(captured.id);
      return snapshot;
    });
    this.work = operation;
    return operation;
  }

  async prune(docId) {
    const keep = this.app.state.settings.historyTimerKeep;
    const old = (await this.records(docId)).filter(item => item.reason === 'timer' && !item.pinned && !item.locked).slice(keep);
    if (old.length) await this.app.db.atomicWrite({}, { deletes: { snapshots: old.map(item => item.id) } });
  }

  observe(doc, transaction, now = Date.now()) {
    if (!transaction?.docChanged || this.suppressed.has(doc.id) || doc.locked || this.app.resettingData) return;
    const settings = this.app.state.settings;
    const active = this.activity.get(doc.id) || { last: now, tick: now, elapsed: 0 };
    active.last = now; this.activity.set(doc.id, active);
    if (!settings.timeMachine) return;
    const before = transaction.before.textBetween(0, transaction.before.content.size, '\n\n');
    const after = transaction.doc.textBetween(0, transaction.doc.content.size, '\n\n');
    const delta = textChange(before, after);
    const large = [delta.added, delta.removed].some(part => part.length >= settings.historyBulkChars || sentences(part) >= settings.historyBulkSentences);
    if (settings.historyAutoLargeEdit && large) {
      const pmJson = transaction.before.toJSON();
      this.capture({ ...doc, ast: tiptapJsonToLegacyAst(pmJson), pmJson }, { reason: 'large-edit' }).catch(error => this.backgroundError(error));
    }
    const step = settings.historyGrowthPages * settings.historyPageChars;
    const last = this.growth.get(doc.id) ?? Math.floor(before.length / step) * step;
    if (settings.historyAutoGrowth && after.length >= last + step) {
      this.growth.set(doc.id, Math.floor(after.length / step) * step);
      const pmJson = transaction.doc.toJSON();
      this.capture({ ...doc, ast: tiptapJsonToLegacyAst(pmJson), pmJson }, { reason: 'growth' }).catch(error => this.backgroundError(error));
    }
  }

  tick(now = Date.now()) {
    const app = this.app, settings = app.state.settings;
    const doc = app.getFocusedDoc(), editor = app.nocturneEditor?.getByDocId(doc?.id);
    for (const [id, active] of this.activity) {
      const delta = Math.max(0, Math.min(1500, now - active.tick)); active.tick = now;
      if (!settings.timeMachine || !settings.historyAutoTimer || doc?.id !== id || document.visibilityState !== 'visible' || !document.hasFocus() || !editor?.isFocused || now - active.last > settings.historyIdleSeconds * 1000) continue;
      active.elapsed += delta;
      if (active.elapsed >= settings.historyTimerMinutes * 60_000 && !active.pending) {
        active.pending = true;
        app.nocturneEditor.syncDocFromEditorByDocId(id);
        this.capture(doc, { reason: 'timer' }).then(snapshot => { if (snapshot) active.elapsed = 0; }).catch(error => this.backgroundError(error)).finally(() => { active.pending = false; });
      }
    }
    if (this.pendingNotice && now - Math.max(this.lastInputAt || 0, this.activity.get(doc?.id)?.last || 0) > 1800 && !app.isComposing && !document.querySelector('.modal-overlay.active, .kb-modal.active, .command-palette-overlay.active') && document.visibilityState === 'visible') this.showSizeNotice();
  }

  backgroundError(error) {
    if (Date.now() - (this.lastError || 0) < 30_000) return;
    this.lastError = Date.now();
    this.app.toast(`Не удалось сохранить версию: ${error.message}`);
  }

  async checkSize(docId) {
    const records = (await this.app.db.getAllRaw('snapshots')).filter(item => item.docId === docId);
    const bytes = new TextEncoder().encode(JSON.stringify(records)).length;
    if (bytes <= this.app.state.settings.historyLimitMB * 1024 * 1024) { this.notified.delete(docId); return; }
    if (!this.notified.has(docId)) this.pendingNotice = { docId, bytes };
  }

  showSizeNotice() {
    const { docId, bytes } = this.pendingNotice; this.pendingNotice = null; this.notified.add(docId);
    const doc = this.app.state.docs.find(item => item.id === docId); if (!doc) return;
    const overlay = document.getElementById('form-overlay');
    this.app.presentFormModal(`<div class="form-modal utility-modal history-limit-modal"><div class="workflow-symbol"><i class="bx bx-history"></i></div><h2>История стала объёмной</h2><p>У главы «${escapeHtml(doc.title)}» сохранено ${(bytes / 1024 / 1024).toFixed(1)} МБ версий. Установленный лимит — ${this.app.state.settings.historyLimitMB} МБ. Все версии остаются на месте.</p><div class="form-actions"><button class="pill-btn" data-history-dismiss>Позже</button><button class="pill-btn ai-btn" data-history-manage>Открыть историю</button><button class="pill-btn" data-history-settings>Изменить лимит</button></div></div>`);
    overlay.querySelector('[data-history-dismiss]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('[data-history-manage]').onclick = () => this.open(docId);
    overlay.querySelector('[data-history-settings]').onclick = () => { overlay.classList.remove('active'); this.app.openSettingsTab('history'); };
  }

  manual() {
    const doc = this.app.getFocusedDoc();
    if (!doc || doc.locked) { this.app.toast('Откройте главу, чтобы сохранить версию.'); return; }
    const overlay = document.getElementById('form-overlay');
    this.app.presentFormModal(`<div class="form-modal utility-modal"><form novalidate><div class="modal-head-row"><div><h2>Сохранить версию</h2><p>${escapeHtml(doc.title)} · ручные версии хранятся до удаления</p></div><button type="button" class="btn-icon" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div><label class="form-field"><span>Название версии</span><input class="form-control" name="versionName" maxlength="160" placeholder="Например, до правки финала" aria-required="true" aria-describedby="history-name-error" autofocus></label><p class="form-error" id="history-name-error" role="alert"></p><div class="form-actions"><button class="pill-btn" type="button" data-close-form>Отмена</button><button class="pill-btn ai-btn" type="submit"><i class="bx bx-camera"></i> Сохранить версию</button></div></form></div>`);
    overlay.querySelectorAll('[data-close-form]').forEach(button => { button.onclick = () => overlay.classList.remove('active'); });
    overlay.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const button = event.target.querySelector('[type="submit"]');
      try {
        const input = event.target.elements.versionName;
        if (!input.value.trim()) { input.setAttribute('aria-invalid', 'true'); overlay.querySelector('#history-name-error').textContent = 'Назовите версию, чтобы легко найти её в истории.'; input.focus(); return; }
        input.removeAttribute('aria-invalid');
        await this.app.runSurfaceAction(button, 'Сохраняем…', async () => {
          if (!await this.app.createSnapshot(false, { doc, name: event.target.elements.versionName.value.trim() })) throw new Error('Сначала нужно успешно сохранить главу.');
          overlay.classList.remove('active'); this.app.toast('Именованная версия сохранена.');
        });
      } catch (error) { this.app.toast(error.message); }
    };
  }

  async open(docId = this.app.getFocusedDoc()?.id, selectedId = null, mode = this.app.state.settings.historyOpenMode) {
    const doc = this.app.state.docs.find(item => item.id === docId);
    if (!doc || doc.locked) { this.app.toast('Откройте доступную главу для просмотра истории.'); return; }
    const revision = this.viewRevision = (this.viewRevision || 0) + 1;
    const records = await this.records(docId);
    if (revision !== this.viewRevision) return;
    const selected = records.find(item => item.id === selectedId && !item.locked);
    const overlay = document.getElementById('form-overlay'), settings = this.app.state.settings;
    const currentText = docText(doc.ast), savedText = selected ? docText(selected.ast) : '';
    const change = diffText(savedText, currentText);
    const marked = side => change.segments.filter(part => part.type !== (side === 'saved' ? 'added' : 'removed')).map(part => part.type === 'equal' ? escapeHtml(part.text) : `<${side === 'saved' ? 'del' : 'ins'}>${escapeHtml(part.text)}</${side === 'saved' ? 'del' : 'ins'}>`).join('');
    this.app.presentFormModal(`<div class="form-modal utility-modal history-modal"><div class="modal-head-row"><div><span class="workflow-eyebrow">История и восстановление</span><h2>${escapeHtml(doc.title)}</h2><p>Просматривайте версии перед заменой текста. Текущий вариант будет сохранён.</p></div><button class="btn-icon" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div>
      <div class="workflow-toolbar"><button class="pill-btn ai-btn" data-history-save><i class="bx bx-camera"></i> Сохранить версию</button><button class="pill-btn" data-history-settings><i class="bx bx-slider-alt"></i> Настройки</button>${doc.historyUndoId ? '<button class="pill-btn" data-history-undo><i class="bx bx-undo"></i> Отменить восстановление</button>' : ''}</div>
      <div class="history-layout"><div class="history-versions utility-list">${records.map(item => `<div class="history-version ${item.id === selectedId ? 'active' : ''}" data-surface-key="history-${escapeHtml(item.id)}"><button class="history-item" data-history-preview="${escapeHtml(item.id)}" ${item.locked ? 'disabled' : ''}><strong>${escapeHtml(this.versionTitle(item) || 'Версия')}</strong><span>${new Date(item.createdAt).toLocaleString('ru-RU')}</span><small>${escapeHtml(labels[item.reason] || "")} &middot; ${item.wordCount ?? countWords(docText(item.ast))} слов · ${item.approximateDelta ? "&asymp;" : ""}+${item.addedChars || 0} / −${item.removedChars || 0} знаков${item.pinned ? ' · закреплена' : ''}</small></button></div>`).join('') || this.app.emptyStateMarkup('bx-history', 'История пока пуста', 'Ручная версия сохраняет важный этап. Автоматические версии появятся во время работы.')}</div>
      <section class="history-preview" data-surface-key="history-preview-${escapeHtml(selectedId || 'empty')}">${selected ? `<div class="workflow-toolbar history-view-modes">${[['text', 'Текст'], ['compare', 'Сравнить'], ['copy', 'Копия главы']].map(([value, label]) => `<button class="context-chip ${mode === value ? 'active' : ''}" aria-pressed="${mode === value}" data-history-mode="${value}">${label}</button>`).join('')}</div><h3>${escapeHtml(this.versionTitle(selected) || 'Сохранённая версия')}</h3>
      ${mode === 'compare' ? `<div class="history-compare"><section><h4>В этой версии</h4><div class="history-text">${marked('saved')}</div></section><section><h4>Сейчас</h4><div class="history-text">${marked('current')}</div></section></div>` : `<div class="history-text">${escapeHtml(savedText) || 'Пустой текст'}</div>`}
      ${mode === 'copy' ? '<p class="workflow-note">Откроем отдельную главу с текстом и заметками этой версии. Исходная глава останется на месте.</p>' : `<fieldset class="history-restore-options"><legend>Что восстановить</legend>${[['text', 'Текст главы', true], ['notes', 'Заметки главы', settings.historyRestoreNotes], ['bookmarks', 'Закладки главы', settings.historyRestoreBookmarks && !!selected.bookmarks], ['globalNotes', 'Общие заметки всего проекта', false]].map(([key, label, checked]) => `<label class="nocturne-check"><input type="checkbox" name="restore-${key}" ${checked ? 'checked' : ''}><span class="check-mark"></span><span>${label}</span></label>`).join('')}</fieldset>`}
      <div class="form-actions"><button class="pill-btn" data-history-rename><i class="bx bx-pencil"></i> Назвать</button><button class="pill-btn" data-history-pin>${selected.pinned ? 'Открепить' : 'Закрепить'}</button><button class="btn-icon danger-btn" data-history-delete aria-label="Удалить версию"><i class="bx bx-trash"></i></button><button class="pill-btn ai-btn" data-history-apply>${mode === 'copy' ? 'Открыть копию' : 'Восстановить выбранное'}</button></div>` : '<div class="history-no-selection"><i class="bx bx-time-five"></i><h3>Выберите версию</h3><p>Сначала покажем сохранённый текст.</p></div>'}</section></div></div>`);
    overlay.querySelector('[data-close-form]').onclick = () => overlay.classList.remove('active');
    overlay.querySelector('[data-history-save]').onclick = () => this.manual();
    overlay.querySelector('[data-history-settings]').onclick = () => { overlay.classList.remove('active'); this.app.openSettingsTab('history'); };
    overlay.querySelector('[data-history-undo]')?.addEventListener('click', () => this.undo(doc.id).then(() => this.open(doc.id)).catch(error => this.app.toast(error.message)));
    overlay.querySelectorAll('[data-history-preview]').forEach(button => { button.onclick = () => this.open(doc.id, button.dataset.historyPreview); });
    overlay.querySelectorAll('[data-history-mode]').forEach(button => { button.onclick = () => this.open(doc.id, selected.id, button.dataset.historyMode); });
    if (!selected) return;
    overlay.querySelector('[data-history-pin]').onclick = async () => { try { await this.app.db.put('snapshots', { ...selected, pinned: !selected.pinned }); await this.open(doc.id, selected.id, mode); } catch (error) { this.app.toast(error.message); } };
    overlay.querySelector('[data-history-rename]').onclick = () => this.editVersion(selected, mode);
    overlay.querySelector('[data-history-delete]').onclick = () => this.deleteVersion(selected);
    overlay.querySelector('[data-history-apply]').onclick = async event => {
      try { await this.app.runSurfaceAction(event.currentTarget, 'Восстанавливаем…', async () => {
        if (mode === 'copy') { await this.copy(selected); overlay.classList.remove('active'); }
        else { const fields = Object.fromEntries(['text', 'notes', 'bookmarks', 'globalNotes'].map(key => [key, !!overlay.querySelector(`[name="restore-${key}"]`)?.checked])); await this.restore(selected.id, fields); await this.open(doc.id, selected.id, mode); this.app.toast('Версия восстановлена. Прежний вариант сохранён в истории.'); }
      }); } catch (error) { this.app.toast(error.message); }
    };
  }

  editVersion(snapshot, mode) {
    const overlay = document.getElementById('form-overlay');
    this.app.presentFormModal(`<div class="form-modal utility-modal"><form novalidate><h2>Название версии</h2><label class="form-field"><span>Как узнавать эту версию</span><input class="form-control" name="name" maxlength="160" value="${escapeHtml(snapshot.name || '')}"></label><div class="form-actions"><button type="button" class="pill-btn" data-back>Отмена</button><button type="submit" class="pill-btn ai-btn">Сохранить</button></div></form></div>`);
    overlay.querySelector('[data-back]').onclick = () => this.open(snapshot.docId, snapshot.id, mode);
    overlay.querySelector('form').onsubmit = async event => { event.preventDefault(); try { await this.app.db.put('snapshots', { ...snapshot, name: event.target.elements.name.value.trim() }); await this.open(snapshot.docId, snapshot.id, mode); } catch (error) { this.app.toast(error.message); } };
  }

  deleteVersion(snapshot) {
    const overlay = document.getElementById('form-overlay');
    this.app.presentFormModal(`<div class="form-modal utility-modal"><h2>Удалить эту версию?</h2><p class="workflow-note">${escapeHtml(snapshot.name || new Date(snapshot.createdAt).toLocaleString('ru-RU'))}. Версию можно будет найти в корзине.</p><div class="form-actions"><button class="pill-btn" data-back>Оставить</button><button class="pill-btn danger-btn" data-delete>Удалить версию</button></div></div>`);
    overlay.querySelector('[data-back]').onclick = () => this.open(snapshot.docId, snapshot.id);
    overlay.querySelector('[data-delete]').onclick = async () => { try { await this.app.trash.store('snapshots', snapshot, 'documents'); await this.app.db.delete('snapshots', snapshot.id); await this.checkSize(snapshot.docId); await this.open(snapshot.docId); } catch (error) { this.app.toast(error.message); } };
  }

  async restore(id, fields = { text: true }, { undo = false } = {}) {
    if (!Object.values(fields).some(Boolean)) throw new Error('Выберите хотя бы один пункт для восстановления.');
    await this.work;
    const snapshot = await this.app.db.get('snapshots', id), doc = this.app.state.docs.find(item => item.id === snapshot?.docId);
    if (!snapshot || snapshot.locked || !doc || doc.locked) throw new Error('Эта версия сейчас недоступна.');
    if (!await this.app.saveDocById(doc.id, { silent: true })) throw new Error('Не удалось сохранить текущую главу. Восстановление не выполнено.');
    const safety = await this.makeSnapshot(doc, { reason: 'before-restore' }); safety.restoreFields = { ...fields };
    const restored = structuredClone(doc);
    if (fields.text) { restored.ast = structuredClone(snapshot.ast); restored.pmJson = structuredClone(snapshot.pmJson); restored.summary = buildSummary(restored.ast); }
    if (fields.notes) restored.notes = snapshot.notes || '';
    if (fields.bookmarks && snapshot.bookmarks) { restored.bookmarks = structuredClone(snapshot.bookmarks); restored.fieldBookmarks = structuredClone(snapshot.fieldBookmarks || {}); }
    restored.updatedAt = Date.now(); restored.historyUndoId = undo ? null : safety.id;
    const records = { docs: [restored], snapshots: [safety] };
    if (fields.globalNotes) records.settings = [{ id: 'global-notes', text: snapshot.globalNotes || '', bookmarks: structuredClone(snapshot.globalBookmarks || this.app.state.globalBookmarks || []), updatedAt: Date.now() }];
    const previous = this.app.db.documentVersions.get(doc.id);
    await this.app.db.atomicWrite(records, { expect: previous ? { docs: [{ id: doc.id, value: previous }] } : {} });
    Object.assign(doc, restored);
    if (fields.globalNotes) { this.app.state.globalNotes = records.settings[0].text; this.app.state.globalBookmarks = records.settings[0].bookmarks; }
    this.suppressed.add(doc.id);
    try { if (fields.text) this.app.nocturneEditor.applyDocumentContent(doc, { ast: restored.ast, pmJson: restored.pmJson, history: true }); } finally { this.suppressed.delete(doc.id); }
    this.app.bookmarks.resetPlainTextBaselines(); this.app.renderAll();
    return safety;
  }

  async undo(docId = this.app.getFocusedDoc()?.id) {
    const doc = this.app.state.docs.find(item => item.id === docId);
    const snapshot = doc?.historyUndoId ? await this.app.db.get('snapshots', doc.historyUndoId) : null;
    if (!snapshot) throw new Error('Нет последнего восстановления для отмены. Выберите прежнюю версию в истории.');
    return this.restore(snapshot.id, snapshot.restoreFields || { text: true, notes: true, bookmarks: true }, { undo: true });
  }

  async copy(snapshot) {
    const source = this.app.state.docs.find(item => item.id === snapshot.docId);
    const copy = { ...structuredClone(source), id: uid('doc'), title: `${source.title} — ${snapshot.name || 'копия версии'}`, ast: structuredClone(snapshot.ast), pmJson: structuredClone(snapshot.pmJson), notes: snapshot.notes || '', bookmarks: structuredClone(snapshot.bookmarks || []), fieldBookmarks: structuredClone(snapshot.fieldBookmarks || {}), historyUndoId: null, createdAt: Date.now(), updatedAt: Date.now() };
    this.app.bookmarks.cloneRecordBookmarks(copy);
    await this.app.db.put('docs', copy); this.app.state.docs.push(copy); this.app.selectDoc(copy.id); this.app.renderDocs();
    this.app.toast('Версия открыта как отдельная глава.');
    return copy;
  }
}
