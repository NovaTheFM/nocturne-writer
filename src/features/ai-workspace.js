import { blockText, buildSummary, docText, escapeHtml, uid } from '../core/utils.js';
import { aiContextCatalog, contextGroups } from './ai-context.js';

const kindLabels = { proofread: 'Исправление ошибок', style: 'Мягкая стилистика', rewrite: 'Альтернативный вариант', continue: 'Продолжение', 'lore-check': 'Проверка лора' };
const close = () => document.getElementById('form-overlay')?.classList.remove('active');
const check = (name, label, checked, disabled = false) => `<label class="nocturne-check"><input type="checkbox" ${name} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span class="check-mark" aria-hidden="true"></span><span>${escapeHtml(label)}</span></label>`;

function paragraphChanges(blocks, proposed, app) {
  const next = app.aiTextToBlocks(proposed), oldText = blocks.map(blockText), newText = next.map(blockText);
  // Unique unchanged paragraphs delimit independent changes without a quadratic chapter diff.
  const positions = new Map(); newText.forEach((text, index) => positions.set(text, positions.has(text) ? -1 : index));
  const anchors = []; let last = -1;
  oldText.forEach((text, index) => { const position = positions.get(text); if (position >= 0 && position > last) { anchors.push([index, position]); last = position; } });
  anchors.push([blocks.length, next.length]);
  let old = 0, fresh = 0;
  return anchors.flatMap(([a, b]) => {
    const before = blocks.slice(old, a), after = next.slice(fresh, b), previousId = blocks[old - 1]?.id || null, nextId = blocks[a]?.id || null;
    old = a + 1; fresh = b + 1;
    if (!before.length && !after.length) return [];
    return [{ id: uid('ai-part'), beforeIds: before.map(block => block.id), before: before.map(blockText).join('\n\n'), after: after.map(blockText).join('\n\n'), afterBlocks: after, previousId, nextId, status: 'open' }];
  });
}

export class AiWorkspaceController {
  constructor(app) { this.app = app; this.items = []; this.presets = []; this.work = Promise.resolve(); this.queueFilter = { chapter: '', category: '', status: 'open' }; }
  async load() {
    const record = await this.app.db.get('settings', 'ai-results');
    this.locked = !!record?.locked; this.items = this.locked ? [] : record?.items || []; this.presets = this.locked ? [] : record?.presets || [];
  }
  mutate(operation) {
    const work = this.work.catch(() => {}).then(async () => {
      if (this.app.resettingData) throw new Error('База сбрасывается.');
      const raw = await this.app.db.getRaw('settings', 'ai-results'), record = await this.app.db.decodeRecord('settings', raw);
      if (record?.locked) throw new Error('Примените мастер-пароль для истории ИИ.');
      const next = operation(structuredClone(record || { id: 'ai-results', items: [], presets: [] })); next.updatedAt = Date.now();
      await this.app.db.atomicWrite({ settings: [next] }, { expect: { settings: [{ id: next.id, value: raw }] } });
      this.items = next.items; this.presets = next.presets; return next;
    });
    this.work = work; return work;
  }
  selection(doc) {
    const choice = doc.aiContextChoice || {}, mode = this.app.state.settings.aiContextMode;
    const preset = this.presets.find(item => item.id === choice.presetId && item.loreId === (doc.loreId || this.app.state.activeLoreId));
    return { ...choice, mode, selected: mode === 'preset' ? preset?.keys || [] : choice.selected || [] };
  }
  world(doc) { return doc.loreId && doc.loreId !== this.app.state.activeLoreId ? this.app.loreById?.get(doc.loreId) || {} : this.app.state.lore; }
  async saveChoice(doc, operation) {
    const previous = structuredClone(doc.aiContextChoice || {}); const previousScene = doc.sceneEventId;
    operation(doc);
    if (!await this.app.saveDocById(doc.id, { silent: true })) { doc.aiContextChoice = previous; doc.sceneEventId = previousScene; throw new Error('Выбор контекста не сохранён.'); }
  }
  openContext(doc = this.app.getFocusedDoc()) {
    if (!doc || doc.locked) { this.app.toast('Откройте доступную главу.'); return; }
    const app = this.app, overlay = document.getElementById('form-overlay'), target = app.captureAssistantTargetSnapshot('proofread', doc);
    const catalog = aiContextCatalog({ state: { ...app.state, lore: this.world(doc) }, doc }), context = app.buildCurrentAiContext(doc, target), choice = this.selection(doc);
    const included = new Set(contextGroups.flatMap(([group]) => (context?.[group] || []).map(item => `${group}:${item.id}`)));
    const scopedPresets = this.presets.filter(preset => preset.loreId === (doc.loreId || app.state.activeLoreId));
    app.presentFormModal(`<div class="form-modal utility-modal ai-context-preview-modal"><div class="modal-head-row"><div><span class="workflow-eyebrow">${escapeHtml(doc.title)}</span><h2>Что узнает ИИ</h2><p>Только отмеченные подтверждённые сведения, действующие во время сцены.</p></div><button class="btn-icon" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div>
      <div class="workflow-toolbar"><button class="pill-btn" data-ai-settings><i class="bx bx-cog"></i> Настройки ИИ</button><button class="pill-btn" data-ai-inbox><i class="bx bx-history"></i> История запросов</button></div>
      <div class="context-picker-fields"><div class="form-field"><span>Подбор сведений</span>${app.renderFormSelect('contextMode', [['automatic', 'Автоматически'], ['manual', 'Вручную'], ['preset', 'Сохранённый набор']], choice.mode, { id: 'ai-context-mode', label: 'Подбор сведений' })}</div><div class="form-field"><span>Момент сцены</span>${app.renderFormSelect('scene', [['', 'По связи главы с событием'], ...catalog.events.filter(item => item.canonStatus !== 'draft').map(item => [item.id, `${item.date || ''} · ${item.title || 'Событие'}`])], doc.sceneEventId || '', { id: 'ai-scene', label: 'Момент сцены' })}</div></div>
      ${choice.mode === 'preset' ? `<div class="form-field"><span>Набор для этого произведения</span>${app.renderFormSelect('preset', [['', 'Выберите набор'], ...scopedPresets.map(preset => [preset.id, preset.name])], doc.aiContextChoice?.presetId || '', { id: 'ai-context-preset', label: 'Набор контекста' })}</div>` : ''}
      <p class="workflow-note ${!catalog.scene ? 'context-warning' : ''}">${catalog.scene ? `Сцена: ${escapeHtml(catalog.scene.title)}. Будущие события исключены.` : 'Момент сцены не определён. События и сведения с ограниченным временем не отправятся.'}</p>
      <p class="workflow-note">Чтобы исключить будущие детали из биографии, задайте сроки или отдельные факты через «Сведения». Без таких отметок обычный текст карточки считается действующим всегда.</p>
      <div class="ai-context-stats" role="status">${context ? `${context.stats.size} / ${context.stats.budget} знаков · выбрано ${included.size} · пропущено ${context.stats.omitted}` : 'Передача контекста выключена в настройках ИИ.'}</div>
      <div class="context-records">${contextGroups.map(([group, label]) => `<section><h3>${label}</h3>${catalog.items.filter(entry => entry.group === group).map(entry => {
        const selected = included.has(entry.key), reason = entry.reason || (app.aiContextOptions()[group] === false ? 'Этот раздел выключен в настройках ИИ' : !context ? 'Передача контекста выключена' : !selected ? choice.excluded?.includes(entry.key) ? 'Исключено вами' : choice.mode !== 'automatic' && !choice.selected.includes(entry.key) ? 'Не выбрано' : 'Не подошло по связи с текстом или не поместилось в лимит' : 'Будет отправлено');
        return `<article class="context-record ${selected ? 'selected' : ''}" data-surface-key="context-${escapeHtml(entry.key)}"><div class="context-record-heading">${check(`data-context-key="${escapeHtml(entry.key)}"`, entry.item.displayName || entry.item.name || entry.item.title || 'Материал', selected, !!entry.reason || app.aiContextOptions()[group] === false || !context)}${!['document-notes', 'global-notes'].includes(entry.item.id) && group !== 'subtimelines' ? `<button class="mini-text-btn" data-context-facts="${escapeHtml(entry.key)}">Сведения</button>` : ''}</div><p>${escapeHtml(entry.item.body || 'Без описания')}</p><small class="${entry.reason ? 'context-warning' : 'workflow-note'}">${escapeHtml(reason)}</small></article>`;
      }).join('') || '<p class="workflow-note">Материалов пока нет.</p>'}</section>`).join('')}</div>
      <details class="workflow-details"><summary>Сохранить выбранные сведения как набор</summary><div class="workflow-toolbar"><input class="form-control" data-ai-preset-name maxlength="100" placeholder="Например, начало книги" aria-label="Название набора контекста"><button class="pill-btn" data-ai-preset-save>Сохранить набор</button></div></details><div class="form-actions"><button class="pill-btn ai-btn" data-close-form>Готово</button></div></div>`);
    overlay.querySelectorAll('[data-close-form]').forEach(button => { button.onclick = close; });
    const perform = async operation => { try { await operation(); if (overlay.querySelector('.ai-context-preview-modal')) this.openContext(doc); } catch (error) { app.toast(error.message); } };
    overlay.querySelector('#ai-context-mode').onchange = event => perform(async () => { app.state.settings.aiContextMode = event.target.value; await app.persistSettings(); });
    overlay.querySelector('#ai-scene').onchange = event => perform(() => this.saveChoice(doc, next => { next.sceneEventId = event.target.value; }));
    overlay.querySelector('#ai-context-preset')?.addEventListener('change', event => perform(() => this.saveChoice(doc, next => { next.aiContextChoice = { ...next.aiContextChoice, presetId: event.target.value }; })));
    overlay.querySelectorAll('[data-context-key]').forEach(input => { input.onchange = () => perform(() => this.saveChoice(doc, next => {
      const current = next.aiContextChoice || {}, key = input.dataset.contextKey;
      next.aiContextChoice = { ...current, selected: [...new Set([...(choice.mode === 'preset' ? choice.selected : current.selected || []).filter(item => item !== key), ...(input.checked ? [key] : [])])], pinned: [...new Set([...(current.pinned || []).filter(item => item !== key), ...(input.checked ? [key] : [])])], excluded: [...(current.excluded || []).filter(item => item !== key), ...(!input.checked ? [key] : [])] };
      if (choice.mode === 'preset') { app.state.settings.aiContextMode = 'manual'; app.persistSettings(); }
    })); });
    overlay.querySelectorAll('[data-context-facts]').forEach(button => { button.onclick = () => this.editFacts(doc, button.dataset.contextFacts); });
    overlay.querySelector('[data-ai-settings]').onclick = () => { close(); app.openSettingsTab('ai'); };
    overlay.querySelector('[data-ai-inbox]').onclick = () => this.openInbox();
    overlay.querySelector('[data-ai-preset-save]').onclick = () => perform(async () => {
      const name = overlay.querySelector('[data-ai-preset-name]').value.trim(); if (!name) throw new Error('Введите название набора.');
      const keys = [...overlay.querySelectorAll('[data-context-key]:checked')].map(input => input.dataset.contextKey);
      const loreId = doc.loreId || app.state.activeLoreId; const preset = { id: uid('ai-preset'), name, keys, loreId };
      await this.mutate(record => { record.presets = [...record.presets.filter(item => !(item.name === name && item.loreId === loreId)), preset]; return record; });
      app.toast('Набор контекста сохранён.');
    });
  }
  async editFacts(doc, key) {
    const app = this.app, loreId = doc.loreId || app.state.activeLoreId, raw = await app.db.getRaw('lore', loreId), world = structuredClone(await app.db.decodeRecord('lore', raw));
    const split = key.indexOf(':'), group = key.slice(0, split), id = key.slice(split + 1), item = world?.[group]?.find(entry => entry.id === id);
    if (!item || world.locked) { app.toast('Материал недоступен.'); return; }
    const events = [['', 'Без ограничения'], ...(world.timeline || []).map(event => [event.id, `${event.date || ''} · ${event.title}`])];
    const facts = structuredClone(item.aiFacts || []), overlay = document.getElementById('form-overlay');
    const render = () => {
      app.presentFormModal(`<div class="form-modal utility-modal context-facts-modal"><form novalidate><div class="modal-head-row"><div><h2>Сведения для ИИ</h2><p>${escapeHtml(item.displayName || item.name || item.title || 'Материал')}</p></div><button class="btn-icon" type="button" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div>${check('name="canonical"', 'Материал подтверждён и относится к канону', item.canonStatus !== 'draft' && item.confirmed !== false)}<div class="context-picker-fields"><div class="form-field"><span>Действует с события</span>${app.renderFormSelect('knownFromEventId', events, item.knownFromEventId || '', { label: 'Начало действия' })}</div><div class="form-field"><span>Перестаёт действовать с события</span>${app.renderFormSelect('knownUntilEventId', events, item.knownUntilEventId || '', { label: 'Конец действия' })}</div></div><p class="workflow-note">Отдельные факты заменяют описание карточки в контексте ИИ. Сама карточка сохраняется целиком.</p><div class="context-facts-list">${facts.map((fact, index) => `<section class="context-record"><label class="form-field"><span>Факт ${index + 1}</span><textarea class="form-control" data-fact-text="${index}" rows="3">${escapeHtml(fact.text || '')}</textarea></label><div class="context-picker-fields"><div class="form-field"><span>Действует с</span>${app.renderFormSelect(`fact-from-${index}`, events, fact.knownFromEventId || '', { label: `Начало действия факта ${index + 1}` })}</div><div class="form-field"><span>Действует до</span>${app.renderFormSelect(`fact-until-${index}`, events, fact.knownUntilEventId || '', { label: `Конец действия факта ${index + 1}` })}</div></div>${check(`data-fact-canon="${index}"`, 'Подтверждённый факт', fact.canonStatus !== 'draft')}<button class="mini-text-btn" type="button" data-fact-remove="${index}">Убрать факт</button></section>`).join('')}</div><button class="pill-btn" type="button" data-fact-add><i class="bx bx-plus"></i> Отдельный факт</button><div class="form-actions"><button class="pill-btn" type="button" data-close-form>Отмена</button><button class="pill-btn ai-btn" type="submit">Сохранить сведения</button></div></form></div>`);
      const read = () => { const data = new FormData(overlay.querySelector('form')); item.canonStatus = data.has('canonical') ? 'confirmed' : 'draft'; item.knownFromEventId = data.get('knownFromEventId'); item.knownUntilEventId = data.get('knownUntilEventId'); facts.forEach((fact, index) => { fact.text = overlay.querySelector(`[data-fact-text="${index}"]`).value; fact.knownFromEventId = data.get(`fact-from-${index}`); fact.knownUntilEventId = data.get(`fact-until-${index}`); fact.canonStatus = overlay.querySelector(`[data-fact-canon="${index}"]`).checked ? 'confirmed' : 'draft'; }); };
      overlay.querySelectorAll('[data-close-form]').forEach(button => { button.onclick = () => this.openContext(doc); });
      overlay.querySelector('[data-fact-add]').onclick = () => { read(); facts.push({ text: '', canonStatus: 'confirmed' }); render(); };
      overlay.querySelectorAll('[data-fact-remove]').forEach(button => { button.onclick = () => { read(); facts.splice(Number(button.dataset.factRemove), 1); render(); }; });
      overlay.querySelector('form').onsubmit = async event => {
        event.preventDefault();
        try { await app.runSurfaceAction(event.target.querySelector('[type="submit"]'), 'Сохраняем…', async () => {
          read(); item.confirmed = item.canonStatus === 'confirmed'; item.aiFacts = facts.filter(fact => fact.text.trim());
          await app.db.atomicWrite({ lore: [world] }, { expect: { lore: [{ id: loreId, value: raw }] } });
          app.loreById.set(loreId, structuredClone(world)); if (app.state.activeLoreId === loreId) app.state.lore = await app.loadLore();
          this.openContext(doc); app.toast('Подтверждённые сведения сохранены.');
        }); } catch (error) { app.toast(error.message); }
      };
    };
    render();
  }
  async record(request, parsed, doc, sourceAst) {
    const source = sourceAst || structuredClone(doc.ast);
    let parts = [];
    if (parsed.writing?.text) {
      if (request.target?.mode === 'whole-chapter') parts = paragraphChanges(source.blocks, parsed.writing.text, this.app);
      else {
        const target = request.target, block = source.blocks.find(item => item.id === target?.blockId);
        if (block) {
          const index = source.blocks.indexOf(block), after = structuredClone(block);
          if (target.mode === 'replace-selection' || parsed.writing.mode === 'inline-continuation') after.html = this.app.replaceInHtmlRange(block.html, target.startOffset, parsed.writing.mode === 'inline-continuation' ? target.startOffset : target.endOffset, parsed.writing.text);
          else after.html = escapeHtml(parsed.writing.text).replace(/\n/g, '<br>');
          const continuation = parsed.writing.mode === 'new-paragraph';
          parts = [{ id: uid('ai-part'), beforeIds: continuation ? [] : [block.id], before: continuation ? '' : blockText(block), after: parsed.writing.text, afterBlocks: continuation ? this.app.aiTextToBlocks(parsed.writing.text) : [after], previousId: continuation ? block.id : source.blocks[index - 1]?.id, nextId: source.blocks[index + 1]?.id || null, status: 'open' }];
        }
      }
    }
    const item = { id: uid('ai-result'), requestId: request.id, docId: doc.id, title: doc.title, kind: request.kind, createdAt: Date.now(), thinking: parsed.thinking || '', baselineText: docText(source), parts, issues: parsed.review || [], status: 'open' };
    await this.mutate(record => { record.items.unshift(item); return record; }); return item;
  }
  async updateResult(id, change) { await this.mutate(record => { record.items = record.items.map(item => item.id === id ? { ...item, ...change } : item); return record; }); }
  notify(item) {
    document.getElementById('ai-result-notice')?.remove();
    const notice = document.createElement('div'); notice.id = 'ai-result-notice'; notice.className = 'ai-result-notice'; notice.setAttribute('role', 'status');
    notice.innerHTML = `<i class="bx bx-brain" aria-hidden="true"></i><div><strong>Ответ ИИ сохранён</strong><span>${escapeHtml(item.title)}</span><button class="mini-text-btn" data-result-open>Посмотреть ответ</button></div><button class="btn-icon" data-result-close aria-label="Скрыть уведомление"><i class="bx bx-x"></i></button>`;
    document.body.append(notice); this.app.animateSurfaceContent(notice);
    const dismiss = () => { this.app.animateSurfaceContent(notice, true); notice.remove(); };
    notice.querySelector('[data-result-open]').onclick = () => { dismiss(); this.openInbox(item.id); };
    notice.querySelector('[data-result-close]').onclick = dismiss;
  }
  openInbox(selectedId = null) {
    const app = this.app, overlay = document.getElementById('form-overlay'), item = this.items.find(entry => entry.id === selectedId);
    app.presentFormModal(`<div class="form-modal utility-modal ai-inbox-modal"><div class="modal-head-row"><div><span class="workflow-eyebrow">Сохраняется на устройстве</span><h2>${item ? kindLabels[item.kind] || 'Ответ ИИ' : 'История ИИ'}</h2><p>${item ? `${escapeHtml(item.title)} · ${new Date(item.createdAt).toLocaleString()}` : 'Каждый готовый ответ остаётся здесь, даже после перехода в другую главу.'}</p></div><button class="btn-icon" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div>${item ? `<button class="mini-text-btn" data-ai-back><i class="bx bx-arrow-back"></i> Все запросы</button><p class="ai-result-thinking">${escapeHtml(item.thinking)}</p><div class="workflow-toolbar"><button class="pill-btn" data-ai-source>Исходная глава</button><button class="pill-btn" data-ai-later>${item.status === 'later' ? 'Вернуть в очередь' : 'Разобрать позже'}</button>${item.issues.length ? '<button class="pill-btn ai-btn" data-ai-reviews>Открыть отдельные правки</button>' : ''}</div><div class="ai-result-parts">${item.parts.map((part, index) => `<article class="context-record ai-result-part" data-surface-key="ai-part-${escapeHtml(part.id)}">${check(`data-ai-part="${escapeHtml(part.id)}"`, `Изменение ${index + 1}${part.status !== 'open' ? ` · ${part.status === 'accepted' ? 'принято' : 'отклонено'}` : ''}`, false, part.status !== 'open')}<div class="history-comparison"><section><h3>Было</h3><p>${escapeHtml(part.before || 'Новый абзац')}</p></section><section><h3>Предложение ИИ</h3><p>${escapeHtml(part.after || 'Удалить этот фрагмент')}</p></section></div></article>`).join('') || (item.issues.length ? `<div class="utility-list">${item.issues.map(issue => `<article class="context-record"><strong>${escapeHtml(issue.quote)}</strong><p>${escapeHtml(issue.reason)}</p><small>${escapeHtml(issue.replacement || 'Замена не предложена')}</small></article>`).join('')}</div>` : '<p class="workflow-note">Предложений по изменению текста нет.</p>')}</div>${item.parts.some(part => part.status === 'open') ? '<div class="form-actions"><button class="pill-btn" data-ai-reject>Отклонить выбранное</button><button class="pill-btn ai-btn" data-ai-accept>Принять выбранное</button></div><p class="form-error" data-ai-result-error role="alert"></p>' : ''}` : `<div class="workflow-toolbar">${[['all', 'Все'], ['open', 'К разбору'], ['later', 'Позже']].map(([id, label]) => `<button class="context-chip ${this.inboxFilter === id || (!this.inboxFilter && id === 'all') ? 'active' : ''}" data-inbox-filter="${id}">${label}</button>`).join('')}<button class="pill-btn" data-ai-queue>Все правки</button></div><div class="utility-list">${this.items.filter(entry => !this.inboxFilter || this.inboxFilter === 'all' || entry.status === this.inboxFilter).map(entry => `<button class="utility-row" data-ai-result="${escapeHtml(entry.id)}"><i class="bx bx-brain"></i><div><strong>${escapeHtml(entry.title)} · ${kindLabels[entry.kind] || 'Ответ ИИ'}</strong><small>${new Date(entry.createdAt).toLocaleString()} · ${entry.status === 'later' ? 'Отложено' : entry.status === 'resolved' ? 'Разобрано' : 'К разбору'}</small></div><i class="bx bx-chevron-right"></i></button>`).join('') || app.emptyStateMarkup('bx-brain', this.locked ? 'История защищена паролем' : 'Запросов пока нет', this.locked ? 'Примените мастер-пароль в настройках.' : 'Готовые ответы появятся здесь после работы с ассистентом.')}</div>`}</div>`);
    overlay.querySelector('[data-close-form]').onclick = close;
    overlay.querySelectorAll('[data-ai-result]').forEach(button => { button.onclick = () => this.openInbox(button.dataset.aiResult); });
    overlay.querySelectorAll('[data-inbox-filter]').forEach(button => { button.onclick = () => { this.inboxFilter = button.dataset.inboxFilter; this.openInbox(); }; });
    overlay.querySelector('[data-ai-queue]')?.addEventListener('click', () => this.openQueue());
    if (!item) return;
    overlay.querySelector('[data-ai-back]').onclick = () => this.openInbox();
    overlay.querySelector('[data-ai-source]').onclick = () => { const doc = app.state.docs.find(doc => doc.id === item.docId); if (!doc || doc.locked) { app.toast('Исходная глава недоступна.'); return; } close(); document.getElementById('kb-modal')?.classList.remove('active'); app.selectDoc(doc.id); if (app.isMobileLayout()) app.closeMobileToEditor(); };
    overlay.querySelector('[data-ai-reviews]')?.addEventListener('click', () => this.openQueue([item.docId]));
    overlay.querySelector('[data-ai-later]').onclick = async () => { try { await this.updateResult(item.id, { status: item.status === 'later' ? 'open' : 'later' }); this.openInbox(item.id); } catch (error) { app.toast(error.message); } };
    const selected = () => [...overlay.querySelectorAll('[data-ai-part]:checked')].map(input => input.dataset.aiPart);
    const perform = async operation => { try { if (!selected().length) throw new Error('Отметьте изменения, которые хотите разобрать.'); await operation(selected()); this.openInbox(item.id); } catch (error) { const errorBox = overlay.querySelector('[data-ai-result-error]'); if (errorBox) errorBox.textContent = error.message; else app.toast(error.message); } };
    overlay.querySelector('[data-ai-accept]')?.addEventListener('click', event => perform(ids => app.runSurfaceAction(event.currentTarget, 'Применяем…', () => this.accept(item.id, ids))));
    overlay.querySelector('[data-ai-reject]')?.addEventListener('click', () => perform(ids => this.mutate(record => { const entry = record.items.find(entry => entry.id === item.id); entry.parts.forEach(part => { if (ids.includes(part.id) && part.status === 'open') part.status = 'rejected'; }); entry.status = entry.parts.some(part => part.status === 'open') ? 'open' : 'resolved'; return record; })));
  }
  async accept(resultId, ids) {
    await this.work.catch(() => {});
    const app = this.app, raw = await app.db.getRaw('settings', 'ai-results'), record = structuredClone(await app.db.decodeRecord('settings', raw)), item = record?.items?.find(entry => entry.id === resultId);
    const doc = app.state.docs.find(doc => doc.id === item?.docId);
    if (!doc || doc.locked || record?.locked) throw new Error('Исходная глава недоступна.');
    if (!await app.saveDocById(doc.id, { silent: true })) throw new Error('Не удалось сохранить исходную главу.');
    if (docText(doc.ast) !== item.baselineText) throw new Error('Исходный текст изменился после запроса. Ответ сохранён для сравнения; автоматическая замена небезопасна.');
    const next = structuredClone(doc);
    const selected = item.parts.filter(part => ids.includes(part.id) && part.status === 'open');
    if (!selected.length) throw new Error('Выбранные изменения уже разобраны.');
    for (const part of selected) {
      const from = part.beforeIds.length ? next.ast.blocks.findIndex(block => block.id === part.beforeIds[0]) : part.previousId ? next.ast.blocks.findIndex(block => block.id === part.previousId) + 1 : 0;
      if (from < 0 || (part.previousId && !next.ast.blocks.some(block => block.id === part.previousId) && !part.beforeIds.length) || next.ast.blocks.slice(from, from + part.beforeIds.length).map(blockText).join('\n\n') !== part.before) throw new Error('Место изменения больше не совпадает с исходным текстом.');
      next.ast.blocks.splice(from, part.beforeIds.length, ...structuredClone(part.afterBlocks)); part.status = 'accepted';
    }
    delete next.pmJson; next.updatedAt = Date.now(); next.summary = buildSummary(next.ast);
    const safety = await app.history.makeSnapshot(doc, { reason: 'before-ai' }); safety.restoreFields = { text: true, bookmarks: true }; next.historyUndoId = safety.id;
    item.baselineText = docText(next.ast); item.status = item.parts.some(part => part.status === 'open') ? 'open' : 'resolved';
    const previous = app.db.documentVersions.get(doc.id);
    await app.db.atomicWrite({ docs: [next], snapshots: [safety], settings: [record] }, { expect: { docs: previous ? [{ id: doc.id, value: previous }] : [], settings: [{ id: 'ai-results', value: raw }] } });
    Object.assign(doc, next); delete doc.pmJson;
    app.history.suppressed.add(doc.id); try { app.nocturneEditor.applyDocumentContent(doc, { ast: doc.ast, history: true }); } finally { app.history.suppressed.delete(doc.id); }
    this.items = record.items; app.bumpDocRenderRevision(doc); app.renderWorkspace(); app.renderDocs(); app.toast(`Принято изменений: ${selected.length}. Можно отменить через историю главы.`);
  }
  openQueue(docIds = null) {
    const app = this.app, filter = this.queueFilter, overlay = document.getElementById('form-overlay');
    if (docIds) this.queueDocIds = docIds; else if (!this.queueDocIds) this.queueDocIds = null;
    const docs = app.state.docs.filter(doc => !this.queueDocIds || this.queueDocIds.includes(doc.id));
    const marks = app.state.reviewMarks.filter(mark => mark.status === 'open' && docs.some(doc => doc.id === mark.docId) && (!filter.chapter || mark.docId === filter.chapter) && (!filter.category || mark.category === filter.category) && (filter.status === 'all' || !!mark.deferred === (filter.status === 'later')));
    const writings = this.items.filter(item => item.parts.some(part => part.status === 'open') && docs.some(doc => doc.id === item.docId) && (!filter.chapter || item.docId === filter.chapter) && (!filter.category || filter.category === 'style') && (filter.status === 'all' || (item.status === 'later') === (filter.status === 'later')));
    const categories = [...new Set(app.state.reviewMarks.map(mark => mark.category))]; if (!categories.includes('style')) categories.push('style');
    app.presentFormModal(`<div class="form-modal utility-modal review-queue-modal"><div class="modal-head-row"><div><h2>Правки всей рукописи</h2><p>${marks.length + writings.length} записей в выбранной очереди. Каждое изменение требует вашего решения.</p></div><button class="btn-icon" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div><div class="context-picker-fields"><div class="form-field"><span>Глава</span>${app.renderFormSelect('chapter', [['', 'Все главы'], ...docs.map(doc => [doc.id, doc.title])], filter.chapter, { id: 'review-queue-chapter', label: 'Глава' })}</div><div class="form-field"><span>Тип правки</span>${app.renderFormSelect('category', [['', 'Все типы'], ...categories.map(category => [category, app.reviewCategoryLabel(category)])], filter.category, { id: 'review-queue-category', label: 'Тип правки' })}</div></div><div class="workflow-toolbar">${[['open', 'К разбору'], ['later', 'Отложенные'], ['all', 'Все']].map(([id, label]) => `<button class="context-chip ${filter.status === id ? 'active' : ''}" data-queue-status="${id}">${label}</button>`).join('')}<button class="pill-btn" data-queue-all>Вся рукопись</button><button class="pill-btn" data-ai-inbox>История ИИ</button></div><div class="utility-list">${marks.map(mark => `<div class="utility-row review-queue-row" data-surface-key="review-${escapeHtml(mark.id)}"><button class="review-queue-jump" data-review-jump="${escapeHtml(mark.id)}"><i class="bx bx-message-square-edit"></i><span><strong>${escapeHtml(app.state.docs.find(doc => doc.id === mark.docId)?.title)}</strong><small>${escapeHtml(app.reviewCategoryLabel(mark.category))} · ${escapeHtml(mark.quote || mark.comment || 'Пометка без цитаты')}</small></span></button><button class="btn-icon" data-review-defer="${escapeHtml(mark.id)}" aria-label="${mark.deferred ? 'Вернуть в очередь' : 'Разобрать позже'}"><i class="bx ${mark.deferred ? 'bx-undo' : 'bx-time-five'}"></i></button></div>`).join('')}${writings.map(item => `<button class="utility-row" data-ai-result="${escapeHtml(item.id)}"><i class="bx bx-brain"></i><div><strong>${escapeHtml(item.title)}</strong><small>${kindLabels[item.kind]} · сравнить и принять частично</small></div><i class="bx bx-chevron-right"></i></button>`).join('') || (!marks.length ? '<p class="utility-empty">В этой очереди нет нерешённых правок.</p>' : '')}</div></div>`);
    overlay.querySelector('[data-close-form]').onclick = close;
    for (const key of ['chapter', 'category']) overlay.querySelector(`#review-queue-${key}`).onchange = event => { filter[key] = event.target.value; this.openQueue(); };
    overlay.querySelectorAll('[data-queue-status]').forEach(button => { button.onclick = () => { filter.status = button.dataset.queueStatus; this.openQueue(); }; });
    overlay.querySelector('[data-queue-all]').onclick = () => { this.queueDocIds = null; filter.chapter = ''; this.openQueue(); };
    overlay.querySelector('[data-ai-inbox]').onclick = () => this.openInbox();
    overlay.querySelectorAll('[data-ai-result]').forEach(button => { button.onclick = () => this.openInbox(button.dataset.aiResult); });
    overlay.querySelectorAll('[data-review-defer]').forEach(button => { button.onclick = async () => { try { const mark = app.state.reviewMarks.find(mark => mark.id === button.dataset.reviewDefer); await app.saveReviewMark({ ...mark, deferred: !mark.deferred }); this.openQueue(); } catch (error) { app.toast(error.message); } }; });
    overlay.querySelectorAll('[data-review-jump]').forEach(button => { button.onclick = () => {
      const mark = marks.find(item => item.id === button.dataset.reviewJump); close(); document.getElementById('kb-modal')?.classList.remove('active');
      app.selectDoc(mark.docId); if (app.isMobileLayout()) app.closeMobileToEditor(); app.setReviewMode('finalization');
      app.state.currentReviewIndexByDoc[mark.docId] = app.reviewMarksForFocusedDoc().findIndex(item => item.id === mark.id); app.renderReviewNavigator(); app.resolveReviewRange(mark)?.block.scrollIntoView({ behavior: app.shouldReduceSurfaceMotion() ? 'instant' : 'smooth', block: 'center' });
    }; });
  }
}
