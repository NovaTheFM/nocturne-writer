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
    overlay?.classList.remove('active');
    overlay?.setAttribute('aria-hidden', 'true');
    if (overlay) overlay.innerHTML = '';
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
      const key = command.category || 'Команды';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(command);
    });
    return groups;
  }

  render() {
    const overlay = document.getElementById('command-palette-overlay');
    if (!overlay) return;
    const mobile = !!this.app.isMobileLayout?.();
    overlay.innerHTML = `
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
      </section>`;
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
      box.innerHTML = '<div class="command-empty"><i class="bx bx-search-alt"></i><strong>Ничего не найдено</strong><span>Попробуйте: настройки, экспорт, персонаж, глава или таймлайн.</span></div>';
      return;
    }
    let index = 0;
    box.innerHTML = [...groups.entries()].map(([group, commands]) => `
      <div class="command-group">
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
      </div>`).join('');
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
    if (event.key === 'Tab') {
      event.preventDefault();
      return true;
    }
    return false;
  }

  runSelected() {
    const command = this.visibleCommands()[this.selected];
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
      { id: 'new-doc', title: 'Новая глава', subtitle: 'Создать документ', icon: 'bx-file-plus', category: 'Команды', aliases: ['chapter', 'глава', 'document'], run: () => app.openDocForm(app.defaultFolderId()) },
      { id: 'new-character', title: 'Новый персонаж', subtitle: 'Создать карточку персонажа', icon: 'bx-user-plus', category: 'Команды', aliases: ['character', 'персонаж'], run: () => app.editLore('characters') },
      { id: 'new-location', title: 'Новая локация', subtitle: 'Создать место', icon: 'bx-map-pin', category: 'Команды', aliases: ['location', 'локация'], run: () => app.editLore('locations') },
      { id: 'new-timeline', title: 'Новое событие таймлайна', subtitle: 'Создать событие', icon: 'bx-git-commit', category: 'Команды', aliases: ['timeline', 'таймлайн', 'event'], run: () => app.editLore('timeline') },
      { id: 'new-note', title: 'Новая плавающая заметка', subtitle: 'Создать заметку', icon: 'bx-note', category: 'Команды', aliases: ['note', 'заметка'], run: () => app.createFloatingNote() },
      { id: 'open-docs', title: 'Открыть главы', subtitle: 'Мобильная библиотека документов', icon: 'bx-file', category: 'Команды', aliases: ['docs', 'главы', 'chapter'], run: () => (app.isMobileLayout?.() ? app.switchMobileTab?.('docs') : app.toast('Список глав открыт слева.')) },
      { id: 'open-lore', title: 'Открыть базу знаний', subtitle: 'Персонажи, локации и таймлайн', icon: 'bx-book-bookmark', category: 'Команды', aliases: ['lore', 'база', 'knowledge'], run: () => (app.isMobileLayout?.() ? app.switchMobileTab?.('lore') : app.openKb('characters')) },
      { id: 'settings', title: 'Настройки', subtitle: 'Открыть настройки', icon: 'bx-cog', category: 'Команды', aliases: ['settings', 'настройки', 'prefs'], run: () => app.openSettingsTab('visual') },
      { id: 'ai-settings', title: 'Настройки AI', subtitle: 'Провайдер, модель и контекст', icon: 'bx-bot', category: 'AI', aliases: ['ai settings', 'ии настройки'], run: () => app.openSettingsTab('ai') },
      { id: 'export-project', title: 'Экспорт проекта .nocturnedump', subtitle: 'Резервная копия всего проекта', icon: 'bx-archive-out', category: 'Экспорт / импорт', aliases: ['export', 'dump', 'backup', 'экспорт'], run: () => (app.isMobileLayout?.() ? app.openMobilePanel('export', 'more') : app.openProjectExportModal()) },
      { id: 'import-project', title: 'Импорт проекта .nocturnedump', subtitle: 'Загрузить резервную копию', icon: 'bx-archive-in', category: 'Экспорт / импорт', aliases: ['import', 'dump', 'backup', 'импорт'], run: () => app.startProjectDumpImport() },
      { id: 'export-docx', title: 'Экспорт текущей главы DOCX', subtitle: doc?.title || 'Нет активного документа', icon: 'bx-file-export', category: 'Экспорт / импорт', enabled: !!doc, aliases: ['docx', 'export chapter'], run: () => app.exportDocx() },
      { id: 'open-export-settings', title: 'Настройки экспорта', subtitle: 'PDF, DOCX и резервные копии', icon: 'bx-export', category: 'Экспорт / импорт', aliases: ['export modal'], run: () => (app.isMobileLayout?.() ? app.openMobilePanel('export', 'more') : app.openSettingsTab('export')) },
      { id: 'ai-panel', title: 'Открыть AI-панель', subtitle: 'Ассистент Nocturne', icon: 'bx-bot', category: 'AI', aliases: ['ai', 'assistant'], run: () => (app.isMobileLayout?.() ? app.switchMobileTab?.('ai') : app.togglePanel('ai-panel')) },
      { id: 'notes-panel', title: 'Открыть заметки', subtitle: 'Заметки документа', icon: 'bx-notepad', category: 'Команды', aliases: ['notes', 'заметки'], run: () => (app.isMobileLayout?.() ? app.openMobilePanel('notes', 'more') : app.togglePanel('notes-panel')) },
      { id: 'sync-panel', title: 'Связь с компьютером', subtitle: 'Локальная синхронизация по Wi-Fi', icon: 'bx-wifi', category: 'Команды', aliases: ['sync', 'wifi', 'связь', 'синхронизация'], run: () => (app.isMobileLayout?.() ? app.openMobilePanel('sync', 'more') : app.openSyncPanel?.()) },
      { id: 'about-app', title: 'О приложении', subtitle: 'Версия, runtime и состояние проекта', icon: 'bx-info-circle', category: 'Команды', aliases: ['about', 'инфо', 'версия'], run: () => app.openAboutModal?.() },
      { id: 'ai-review', title: 'AI-проверка текущего документа', subtitle: doc?.title || 'Нет активного документа', icon: 'bx-check-shield', category: 'AI', enabled: !!doc, aliases: ['review', 'проверка', 'proofread'], run: () => app.runAi('proofread') },
      { id: 'ai-proofread', title: 'Корректура', subtitle: 'Проверить текст', icon: 'bx-spell-check', category: 'AI', enabled: !!doc, aliases: ['proofread', 'орфография'], run: () => app.runAi('proofread') },
      { id: 'ai-continue', title: 'Продолжить сцену', subtitle: 'AI-продолжение', icon: 'bx-brain', category: 'AI', enabled: !!doc, aliases: ['continue', 'продолжить'], run: () => app.runAi('continue') },
      { id: 'ai-style', title: 'Улучшить выделенный фрагмент', subtitle: 'AI-редактура стиля', icon: 'bx-brush', category: 'AI', enabled: !!doc, aliases: ['style', 'improve'], run: () => app.runAi('style') },
      { id: 'ai-context-preview', title: 'Предпросмотр Knowledge Context', subtitle: 'Показать AI-контекст', icon: 'bx-network-chart', category: 'AI', enabled: !!doc, aliases: ['context', 'knowledge', 'лор'], run: () => app.openAiContextPreview() },
    ];
    const docs = app.state.docs.map((item) => ({
      id: `doc:${item.id}`,
      title: item.title || 'Документ',
      subtitle: item.description || item.summary || 'Открыть главу',
      icon: 'bx-file',
      category: 'Главы',
      aliases: ['chapter', 'глава', item.title, item.description],
      run: () => { app.selectDoc(item.id); if (app.isMobileLayout?.()) app.closeMobileToEditor?.(); },
    }));
    const characters = app.state.lore.characters.map((item) => ({
      id: `character:${item.id}`,
      title: app.entityDisplayName(item) || 'Персонаж',
      subtitle: item.role || 'Открыть персонажа',
      icon: item.icon || 'bx-user',
      category: 'Персонажи',
      aliases: ['character', 'персонаж', ...(item.aliases || []), ...(item.mentionForms || [])],
      run: () => { if (app.isMobileLayout?.()) app.switchMobileTab?.('lore'); else app.openKb('characters'); app.openLoreDetail('characters', item.id); },
    }));
    const locations = app.state.lore.locations.map((item) => ({
      id: `location:${item.id}`,
      title: app.entityDisplayName(item) || 'Локация',
      subtitle: item.role || 'Открыть локацию',
      icon: item.icon || 'bx-map-alt',
      category: 'Локации',
      aliases: ['location', 'локация', ...(item.aliases || []), ...(item.mentionForms || [])],
      run: () => { if (app.isMobileLayout?.()) app.switchMobileTab?.('lore'); else app.openKb('locations'); app.openLoreDetail('locations', item.id); },
    }));
    const events = timeline.map((item) => ({
      id: `timeline:${item.id}`,
      title: item.title || 'Событие',
      subtitle: item.date || 'Открыть событие',
      icon: 'bx-git-commit',
      category: 'Таймлайн',
      aliases: ['timeline', 'таймлайн', item.body],
      run: () => { if (app.isMobileLayout?.()) app.switchMobileTab?.('lore'); else app.openKb('timeline'); app.editLore('timeline', item.id); },
    }));
    const subtimelines = timeline
      .filter((item) => item.subEvents?.length)
      .map((item) => ({
        id: `subtimeline:${item.id}`,
        title: `Сабтаймлайн: ${item.title || 'Событие'}`,
        subtitle: `${item.subEvents.length} влож. событий`,
        icon: 'bx-git-branch',
        category: 'Сабтаймлайны',
        aliases: ['subtimeline', 'сабтаймлайн', item.title],
        run: () => { if (app.isMobileLayout?.()) app.switchMobileTab?.('lore'); else app.openKb('timeline'); app.openSubtimeline(item.id); },
      }));
    return [...base, ...docs, ...characters, ...locations, ...events, ...subtimelines];
  }
}

