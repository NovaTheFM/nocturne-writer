import { t, ui, msg } from '../core/i18n.js';
import { escapeHtml } from '../core/utils.js';

function normalize(value = '') {
  return String(value || '').toLocaleLowerCase('ru-RU');
}

function fuzzyScore(command, query = '') {
  const q = normalize(query).trim();
  if (!q) return 1;
  const haystack = normalize([
    command.title,
    command.subtitle,
    command.category,
    ...(command.aliases || []),
  ].join(' '));
  if (haystack.includes(q)) return 100 + q.length;
  let score = 0;
  let index = 0;
  for (const char of q) {
    const found = haystack.indexOf(char, index);
    if (found < 0) return 0;
    score += Math.max(1, 12 - (found - index));
    index = found + 1;
  }
  return score;
}

export class CommandPalette {
  constructor(app) {
    this.app = app;
    this.opened = false;
    this.query = '';
    this.selected = 0;
    this.lastFocus = null;
    this.recentIds = [];
  }

  open(options = {}) {
    this.lastFocus = document.activeElement;
    this.opened = true;
    this.query = '';
    this.selected = 0;
    this.render();
    const shouldFocus = options.focusInput ?? !this.app.isMobileLayout?.();
    if (shouldFocus) requestAnimationFrame(() => document.querySelector('[data-command-palette-input]')?.focus());
  }

  close({ restoreFocus = true } = {}) {
    this.opened = false;
    const overlay = document.getElementById('command-palette-overlay');
    this.app.closeOverlay(overlay, { clear: true, duration: 220 });
    document.body.classList.remove('command-palette-open');
    if (restoreFocus) this.lastFocus?.focus?.();
  }

  toggle() {
    if (this.opened) this.close();
    else this.open();
  }

  setQuery(value) {
    this.query = String(value || '');
    this.selected = 0;
    this.renderResults();
  }

  visibleCommands() {
    return this.buildCommands()
      .filter((command) => command.enabled !== false)
      .map((command) => ({ command, score: fuzzyScore(command, this.query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || String(a.command.title).localeCompare(String(b.command.title), 'ru'))
      .map((entry) => entry.command)
      .slice(0, 80);
  }

  groupedCommands() {
    const groups = new Map();
    this.visibleCommands().forEach((command) => {
      const key = command.category || t('Команды');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(command);
    });
    return groups;
  }

  render() {
    const overlay = document.getElementById('command-palette-overlay');
    if (!overlay) return;
    const mobile = !!this.app.isMobileLayout?.();
    this.app.presentOverlay(overlay, ui`
      <section class="command-palette-panel" role="dialog" aria-modal="true" aria-label="Палитра команд">
        <div class="command-palette-mobile-head">
          <button class="mobile-icon-btn" data-action="close-command-palette" aria-label="Назад"><i class="bx bx-left-arrow-alt"></i></button>
          <strong>Палитра команд</strong>
          <button class="mobile-icon-btn" data-action="close-command-palette" aria-label="Закрыть"><i class="bx bx-x"></i></button>
        </div>
        <div class="command-palette-search">
          <i class="bx bx-command"></i>
          <input data-command-palette-input value="${escapeHtml(this.query)}" placeholder="Команда, глава, персонаж, локация...">
          ${mobile ? '' : '<span class="command-hotkey-hint">Ctrl K</span>'}
        </div>
        <div class="command-palette-results" data-command-palette-results></div>
      </section>`);
    overlay.classList.add('active');
    overlay.setAttribute('aria-hidden', 'false');
    document.body.classList.add('command-palette-open');
    this.renderResults();
  }

  renderResults() {
    const box = document.querySelector('[data-command-palette-results]');
    if (!box) return;
    const mobile = !!this.app.isMobileLayout?.();
    const groups = this.groupedCommands();
    const flat = [...groups.values()].flat();
    this.selected = Math.min(this.selected, Math.max(0, flat.length - 1));
    if (!flat.length) {
      this.app.updateSurfaceHTML(box, ui('<div class="command-empty"><i class="bx bx-search-alt"></i><strong>Ничего не найдено</strong><span>Попробуйте: настройки, экспорт, персонаж, глава или таймлайн.</span></div>'), { resize: true });
      return;
    }
    let index = 0;
    this.app.updateSurfaceHTML(box, [...groups.entries()].map(([group, commands]) => `
      <div class="command-group" data-surface-key="${escapeHtml(group)}">
        <div class="command-group-title">${escapeHtml(group)}</div>
        ${commands.map((command) => {
          const active = index === this.selected;
          const currentIndex = index;
          const icon = this.app.commandPaletteIconHtml?.(command.icon) || `<i class="bx ${escapeHtml(command.icon || 'bx-command')}"></i>`;
          index += 1;
          return `<button class="command-item ${active ? 'active' : ''}" data-command-palette-run="${escapeHtml(command.id)}" data-command-index="${currentIndex}">
            ${icon}
            <span><strong>${escapeHtml(command.title)}</strong><small>${escapeHtml(command.subtitle || '')}</small></span>
            ${mobile ? '' : '<kbd class="command-key-hint">Enter</kbd>'}
          </button>`;
        }).join('')}
      </div>`).join(''), { resize: true });
  }

  handleKeydown(event) {
    if (!this.opened) return false;
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return true;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const count = this.visibleCommands().length;
      if (!count) return true;
      this.selected = (this.selected + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      this.renderResults();
      document.querySelector(`.command-item[data-command-index="${this.selected}"]`)?.scrollIntoView({ block: 'nearest' });
      return true;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      this.runSelected();
      return true;
    }
    return false;
  }

  runSelected() {
    const command = [...this.groupedCommands().values()].flat()[this.selected];
    if (command) this.run(command.id);
  }

  run(id) {
    const command = this.buildCommands().find((item) => item.id === id);
    if (!command || command.enabled === false) return;
    this.recentIds = [id, ...this.recentIds.filter((item) => item !== id)].slice(0, 6);
    this.close({ restoreFocus: false });
    command.run();
  }

  buildCommands() {
    const app = this.app;
    const doc = app.getFocusedDoc?.();
    const timeline = app.state.lore.timeline || [];
    const base = [
      ...[
        ['export-book', t('Экспорт книги'), t('Выбранные главы в одном DOCX'), 'bx-book-open', () => app.openBookExport()],
        ['open-trash', t('Корзина'), t('Восстановить удалённые главы'), 'bx-trash', () => app.openTrash()],
        ['open-backups', t('Резервные копии'), t('Копии и восстановление проекта'), 'bx-archive', () => app.openBackups()],
        ['show-history', t('История текста'), t('Снимки текущей главы'), 'bx-history', () => app.showHistory()],
        ['open-review-queue', t('Правки всей рукописи'), t('Нерешённые пометки во всех главах'), 'bx-message-square-edit', () => app.openReviewQueue()],
        ['open-sync-conflicts', t('Разные версии'), t('Сравнить конфликты синхронизации'), 'bx-git-compare', () => app.openSyncConflicts()],
        ['return-to-manuscript', t('Вернуться к рукописи'), t('Продолжить с прежней позиции'), 'bx-arrow-back', () => app.returnToManuscript()],
        ['edit-world-rules', t('Правила мира'), t('Ограничения для проверки лора'), 'bx-list-check', () => app.editWorldRules()],
        ['toggle-card-view', t('Вид карточек'), t('Переключить карточки и компактный список'), 'bx-list-ul', () => app.runAction('toggle-card-view')],
      ].map(([id, title, subtitle, icon, run]) => ({ id, title, subtitle, icon, run, category: t('Работа с проектом'), aliases: [title, id] })),
      { id: 'new-doc', title: t('Новая глава'), subtitle: t('Создать документ'), icon: 'bx-file-plus', category: t('Команды'), aliases: ['chapter', t('глава'), 'document'], run: () => app.openDocForm(app.defaultFolderId()) },
      { id: 'new-character', title: t('Новый персонаж'), subtitle: t('Создать карточку персонажа'), icon: 'bx-user-plus', category: t('Команды'), aliases: ['character', t('персонаж')], run: () => app.editLore('characters') },
      { id: 'new-location', title: t('Новая локация'), subtitle: t('Создать место'), icon: 'bx-map-pin', category: t('Команды'), aliases: ['location', t('локация')], run: () => app.editLore('locations') },
      { id: 'new-timeline', title: t('Новое событие таймлайна'), subtitle: t('Создать событие'), icon: 'bx-git-commit', category: t('Команды'), aliases: ['timeline', t('таймлайн'), 'event'], run: () => app.editLore('timeline') },
      { id: 'new-note', title: t('Новая плавающая заметка'), subtitle: t('Создать заметку'), icon: 'bx-note', category: t('Команды'), aliases: ['note', t('заметка')], run: () => app.createFloatingNote() },
      { id: 'open-docs', title: t('Открыть главы'), subtitle: t('Мобильная библиотека документов'), icon: 'bx-file', category: t('Команды'), aliases: ['docs', t('главы'), 'chapter'], run: () => (app.isMobileLayout?.() ? app.switchMobileTab?.('docs') : app.toast(t('Список глав открыт слева.'))) },
      { id: 'open-lore', title: t('Открыть базу знаний'), subtitle: t('Персонажи, локации и таймлайн'), icon: 'bx-book-bookmark', category: t('Команды'), aliases: ['lore', t('база'), 'knowledge'], run: () => (app.isMobileLayout?.() ? app.switchMobileTab?.('lore') : app.openKb('characters')) },
      { id: 'settings', title: t('Настройки'), subtitle: t('Открыть настройки'), icon: 'bx-cog', category: t('Команды'), aliases: ['settings', t('настройки'), 'prefs'], run: () => app.openSettingsTab('visual') },
      { id: 'ai-settings', title: t('Настройки AI'), subtitle: t('Провайдер, модель и контекст'), icon: 'bx-bot', category: 'AI', aliases: ['ai settings', t('ии настройки')], run: () => app.openSettingsTab('ai') },
      { id: 'export-project', title: t('Экспорт проекта .nocturnedump'), subtitle: t('Резервная копия всего проекта'), icon: 'bx-archive-out', category: t('Экспорт / импорт'), aliases: ['export', 'dump', 'backup', t('экспорт')], run: () => (app.isMobileLayout?.() ? app.openMobilePanel('export', 'more') : app.openProjectExportModal()) },
      { id: 'import-project', title: t('Импорт проекта .nocturnedump'), subtitle: t('Загрузить резервную копию'), icon: 'bx-archive-in', category: t('Экспорт / импорт'), aliases: ['import', 'dump', 'backup', t('импорт')], run: () => app.startProjectDumpImport() },
      { id: 'export-docx', title: t('Экспорт текущей главы DOCX'), subtitle: doc?.title || t('Нет активного документа'), icon: 'bx-file-export', category: t('Экспорт / импорт'), enabled: !!doc, aliases: ['docx', 'export chapter'], run: () => app.exportDocx() },
      { id: 'open-export-settings', title: t('Настройки экспорта'), subtitle: t('PDF, DOCX и резервные копии'), icon: 'bx-export', category: t('Экспорт / импорт'), aliases: ['export modal'], run: () => (app.isMobileLayout?.() ? app.openMobilePanel('export', 'more') : app.openSettingsTab('export')) },
      { id: 'ai-panel', title: t('Открыть AI-панель'), subtitle: t('Ассистент Nocturne'), icon: 'bx-bot', category: 'AI', aliases: ['ai', 'assistant'], run: () => (app.isMobileLayout?.() ? app.switchMobileTab?.('ai') : app.togglePanel('ai-panel')) },
      { id: 'notes-panel', title: t('Открыть заметки'), subtitle: t('Заметки документа'), icon: 'bx-notepad', category: t('Команды'), aliases: ['notes', t('заметки')], run: () => (app.isMobileLayout?.() ? app.openMobilePanel('notes', 'more') : app.togglePanel('notes-panel')) },
      { id: 'sync-panel', title: t('Связь с компьютером'), subtitle: t('Локальная синхронизация по Wi-Fi'), icon: 'bx-wifi', category: t('Команды'), aliases: ['sync', 'wifi', t('связь'), t('синхронизация')], run: () => (app.isMobileLayout?.() ? app.openMobilePanel('sync', 'more') : app.openSyncPanel?.()) },
      { id: 'about-app', title: t('О приложении'), subtitle: t('Версия, runtime и состояние проекта'), icon: 'bx-info-circle', category: t('Команды'), aliases: ['about', t('инфо'), t('версия')], run: () => app.openAboutModal?.() },
      { id: 'ai-review', title: t('AI-проверка текущего документа'), subtitle: doc?.title || t('Нет активного документа'), icon: 'bx-check-shield', category: 'AI', enabled: !!doc, aliases: ['review', t('проверка'), 'proofread'], run: () => app.runAi('proofread') },
      { id: 'ai-proofread', title: t('Корректура'), subtitle: t('Проверить текст'), icon: 'bx-spell-check', category: 'AI', enabled: !!doc, aliases: ['proofread', t('орфография')], run: () => app.runAi('proofread') },
      { id: 'ai-continue', title: t('Продолжить сцену'), subtitle: t('AI-продолжение'), icon: 'bx-brain', category: 'AI', enabled: !!doc, aliases: ['continue', t('продолжить')], run: () => app.runAi('continue') },
      { id: 'ai-style', title: t('Улучшить выделенный фрагмент'), subtitle: t('AI-редактура стиля'), icon: 'bx-brush', category: 'AI', enabled: !!doc, aliases: ['style', 'improve'], run: () => app.runAi('style') },
      { id: 'ai-context-preview', title: t('Предпросмотр Knowledge Context'), subtitle: t('Показать AI-контекст'), icon: 'bx-network-chart', category: 'AI', enabled: !!doc, aliases: ['context', 'knowledge', t('лор')], run: () => app.openAiContextPreview() },
    ];
    const docs = app.state.docs.map((item) => ({
      id: `doc:${item.id}`,
      title: item.title || t('Документ'),
      subtitle: item.description || item.summary || t('Открыть главу'),
      icon: 'bx-file',
      category: t('Главы'),
      aliases: ['chapter', t('глава'), item.title, item.description],
      run: () => { app.selectDoc(item.id); if (app.isMobileLayout?.()) app.closeMobileToEditor?.(); },
    }));
    const characters = app.state.lore.characters.map((item) => ({
      id: `character:${item.id}`,
      title: app.entityDisplayName(item) || t('Персонаж'),
      subtitle: item.role || t('Открыть персонажа'),
      icon: item.icon || 'bx-user',
      category: t('Персонажи'),
      aliases: ['character', t('персонаж'), ...(item.aliases || []), ...(item.mentionForms || [])],
      run: () => { if (app.isMobileLayout?.()) app.switchMobileTab?.('lore'); else app.openKb('characters'); app.openLoreDetail('characters', item.id); },
    }));
    const locations = app.state.lore.locations.map((item) => ({
      id: `location:${item.id}`,
      title: app.entityDisplayName(item) || t('Локация'),
      subtitle: item.role || t('Открыть локацию'),
      icon: item.icon || 'bx-map-alt',
      category: t('Локации'),
      aliases: ['location', t('локация'), ...(item.aliases || []), ...(item.mentionForms || [])],
      run: () => { if (app.isMobileLayout?.()) app.switchMobileTab?.('lore'); else app.openKb('locations'); app.openLoreDetail('locations', item.id); },
    }));
    const events = timeline.map((item) => ({
      id: `timeline:${item.id}`,
      title: item.title || t('Событие'),
      subtitle: item.date || t('Открыть событие'),
      icon: 'bx-git-commit',
      category: t('Таймлайн'),
      aliases: ['timeline', t('таймлайн'), item.body],
      run: () => { if (app.isMobileLayout?.()) app.switchMobileTab?.('lore'); else app.openKb('timeline'); app.editLore('timeline', item.id); },
    }));
    const subtimelines = timeline
      .filter((item) => item.subEvents?.length)
      .map((item) => ({
        id: `subtimeline:${item.id}`,
        title: msg`Сабтаймлайн: ${item.title || t('Событие')}`,
        subtitle: msg`${item.subEvents.length} влож. событий`,
        icon: 'bx-git-branch',
        category: t('Сабтаймлайны'),
        aliases: ['subtimeline', t('сабтаймлайн'), item.title],
        run: () => { if (app.isMobileLayout?.()) app.switchMobileTab?.('lore'); else app.openKb('timeline'); app.openSubtimeline(item.id); },
      }));
    return [...base, ...docs, ...characters, ...locations, ...events, ...subtimelines];
  }
}
