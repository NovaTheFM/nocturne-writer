import { countWords, docText, escapeHtml, textFromHtml, uid } from '../core/utils.js';

const statuses = [['planned', 'Замысел'], ['writing', 'Пишется'], ['editing', 'На редактуре'], ['finished', 'Готова'], ['archived', 'В архиве']];
const groups = [['characters', 'Персонажи', 'bx-user-pin'], ['locations', 'Локации', 'bx-map-alt'], ['timeline', 'События', 'bx-git-commit'], ['notes', 'Записи', 'bx-note'], ['rules', 'Правила', 'bx-book-content']];
const unique = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string'))];
export function normalizeBook(value = {}) {
  return {
    ...value, id: value.id || uid('book'), title: String(value.title || '').trim().slice(0, 200),
    author: String(value.author || '').slice(0, 200), description: String(value.description || '').slice(0, 20000),
    status: statuses.some(([id]) => id === value.status) ? value.status : 'planned',
    targetWords: Math.max(0, Math.min(10_000_000, Number(value.targetWords) || 0)),
    documentIds: unique(value.documentIds), worldIds: unique(value.worldIds), notes: String(value.notes || ''),
    links: (Array.isArray(value.links) ? value.links : []).filter(link => link && typeof link.id === 'string' && typeof link.loreId === 'string' && groups.some(([type]) => type === link.type)),
    createdAt: Number(value.createdAt) || Date.now(), updatedAt: Number(value.updatedAt) || Date.now(),
  };
}

export function sortExportChapters(docs) {
  const collator = new Intl.Collator('ru', { numeric: true });
  return [...docs].sort((a, b) => collator.compare(String(a.volume || ''), String(b.volume || '')) || collator.compare(String(a.chapterNumber || ''), String(b.chapterNumber || '')) || (a.order || 0) - (b.order || 0));
}

export class BooksController {
  constructor(app) {
    this.app = app; this.items = []; this.presets = []; this.selectedId = null; this.tab = 'overview'; this.query = ''; this.filter = 'all'; this.work = Promise.resolve(); this.pendingNotes = new Map();
  }

  async load() {
    const stored = await this.app.db.get('settings', 'books-library');
    this.locked = !!stored?.locked;
    this.items = this.locked ? [] : (stored?.items || []).map(normalizeBook);
    this.presets = this.locked ? [] : stored?.presets || [];
  }

  bind() {
    if (this.bound) return; this.bound = true;
    document.addEventListener('click', event => {
      const target = event.target.closest('[data-book-action]');
      if (target) this.action(target.dataset.bookAction, target.dataset).catch(error => this.app.toast(error.message));
    });
    document.addEventListener('input', event => {
      if (event.target.matches('[data-books-query]')) { this.query = event.target.value; this.refreshList(); }
      if (event.target.matches('[data-book-notes]')) {
        const id = event.target.dataset.bookNotes, notes = event.target.value;
        this.pendingNotes.set(id, notes);
        clearTimeout(this.notesTimer);
        this.notesTimer = setTimeout(() => this.flush().then(() => { const badge = document.querySelector('[data-book-note-status]'); if (badge) badge.textContent = 'Сохранено на устройстве'; }).catch(error => this.app.toast(error.message)), 550);
        document.querySelector('[data-book-note-status]')?.replaceChildren(document.createTextNode('Сохраняем…'));
      }
    });
  }

  mutate(operation) {
    const work = this.work.catch(() => {}).then(async () => {
      if (this.app.resettingData) throw new Error('База сбрасывается.');
      const raw = await this.app.db.getRaw('settings', 'books-library');
      const stored = await this.app.db.decodeRecord('settings', raw);
      if (stored?.locked) throw new Error('Примените мастер-пароль, чтобы открыть книги.');
      const next = operation(structuredClone(stored || { id: 'books-library', items: [], presets: [] }));
      next.updatedAt = Date.now();
      await this.app.db.atomicWrite({ settings: [next] }, { expect: { settings: [{ id: 'books-library', value: raw }] } });
      this.items = next.items.map(normalizeBook); this.presets = next.presets || [];
      return next;
    });
    this.work = work;
    return work;
  }

  async flush() {
    clearTimeout(this.notesTimer);
    for (const [id, notes] of this.pendingNotes) {
      await this.save({ id, notes }); if (this.pendingNotes.get(id) === notes) this.pendingNotes.delete(id);
    }
    await this.work;
  }

  async save(value) {
    const id = value.id || uid('book');
    let book;
    await this.mutate(record => {
      book = normalizeBook({ ...record.items.find(item => item.id === id), ...value, id, updatedAt: Date.now() });
      if (!book.title) throw new Error('Введите название книги.');
      record.items = record.items.filter(item => item.id !== id).concat(book);
      return record;
    });
    return book;
  }

  book(id = this.selectedId) { return this.items.find(item => item.id === id); }
  chapters(book) { return (book.documentIds || []).map(id => this.app.state.docs.find(doc => doc.id === id)).filter(Boolean); }
  stats(book) {
    const chapters = this.chapters(book), ids = new Set(chapters.map(doc => doc.id));
    const marks = this.app.state.reviewMarks.filter(mark => ids.has(mark.docId) && mark.status === 'open').length;
    const proposals = (this.app.aiWorkspace?.items || []).filter(item => ids.has(item.docId)).reduce((sum, item) => sum + item.parts.filter(part => part.status === 'open').length, 0);
    return { chapters: chapters.length, words: chapters.reduce((sum, doc) => sum + (doc.locked ? 0 : countWords(docText(doc.ast))), 0), reviews: marks + proposals, editing: chapters.filter(doc => /edit|review|редакт/iu.test(doc.bookStatus || '')).length };
  }

  render() {
    if (this.locked) return `<section class="books-library">${this.app.emptyStateMarkup('bx-lock-alt', 'Библиотека книг защищена', 'Примените мастер-пароль в настройках данных.', 'open-settings', 'Открыть настройки')}</section>`;
    const book = this.book();
    return `<section class="books-library" data-surface-key="books-${escapeHtml(book?.id || 'library')}">${book ? this.detail(book) : `<header class="kb-header"><div><span class="workflow-eyebrow">Вся библиотека · все произведения</span><h1>Книги</h1><p class="workflow-note">Соберите главы, миры и материалы в собственном порядке.</p></div><div class="kb-header-actions"><button class="pill-btn ai-btn" data-book-action="new"><i class="bx bx-plus"></i> Создать книгу</button><button class="btn-icon" data-action="close-kb" aria-label="Закрыть"><i class="bx bx-x"></i></button></div></header>
    <div class="books-tools"><label class="mobile-search-field"><i class="bx bx-search"></i><input class="form-control" type="search" data-books-query value="${escapeHtml(this.query)}" placeholder="Название, автор или замысел" aria-label="Поиск книг"></label><div class="workflow-toolbar books-status-filters knowledge-search-scope workflow-choice">${[['all', 'Все книги'], ['writing', 'Пишутся'], ['editing', 'Редактура'], ['finished', 'Готовы'], ['archived', 'Архив']].map(([id, label]) => `<button class="context-chip ${this.filter === id ? 'active' : ''}" data-book-action="filter" data-book-filter="${id}" aria-pressed="${this.filter === id}">${label}</button>`).join('')}</div></div><div class="books-grid" data-books-grid>${this.cards()}</div>`}</section>`;
  }

  cards() {
    const query = this.query.toLocaleLowerCase('ru-RU');
    const books = this.items.filter(book => (this.filter === 'all' || book.status === this.filter) && `${book.title} ${book.author} ${book.description}`.toLocaleLowerCase('ru-RU').includes(query));
    return books.map(book => {
      const stats = this.stats(book), progress = book.targetWords ? Math.min(100, stats.words / book.targetWords * 100) : 0;
      return `<button class="book-card" data-book-action="open" data-book-id="${escapeHtml(book.id)}" data-surface-key="book-${escapeHtml(book.id)}"><span class="book-card-cover"><i class="bx bx-book-open"></i><span>${escapeHtml(book.title.slice(0, 1).toLocaleUpperCase('ru-RU'))}</span></span><span class="book-card-copy"><span class="book-status">${statuses.find(([id]) => id === book.status)?.[1]}</span><strong>${escapeHtml(book.title)}</strong><span class="book-author">${escapeHtml(book.author || 'Автор не указан')}</span><span class="book-description">${escapeHtml(book.description || 'Замысел книги можно описать в её параметрах.')}</span><span class="book-card-stats">${stats.chapters} глав · ${stats.words.toLocaleString('ru-RU')} слов${stats.reviews ? ` · ${stats.reviews} правок` : ''}</span>${book.targetWords ? `<span class="book-progress-track"><span style="width:${progress}%"></span></span>` : ''}</span><i class="bx bx-chevron-right book-card-arrow"></i></button>`;
    }).join('') || this.app.emptyStateMarkup('bx-book-heart', query ? 'Книг с таким запросом нет' : 'Ваша библиотека начинается здесь', query ? 'Попробуйте другое название или снимите фильтр.' : 'Книга может объединять материалы из нескольких произведений.', 'new-book', 'Создать книгу');
  }

  detail(book) {
    const stats = this.stats(book), progress = book.targetWords ? Math.min(100, stats.words / book.targetWords * 100) : 0;
    const worlds = new Map(this.app.loreById || []); worlds.set(this.app.state.activeLoreId, this.app.state.lore);
    const linked = book.links.map(link => ({ ...link, world: worlds.get(link.loreId), item: worlds.get(link.loreId)?.[link.type]?.find(item => item.id === link.id) }));
    return `<header class="kb-header book-detail-heading"><div><button class="mini-text-btn" data-book-action="back"><i class="bx bx-arrow-back"></i> Все книги</button><span class="workflow-eyebrow">${statuses.find(([id]) => id === book.status)?.[1]} · ${escapeHtml(book.author || 'Вся библиотека')}</span><h1>${escapeHtml(book.title)}</h1></div><div class="kb-header-actions"><button class="pill-btn" data-book-action="edit"><i class="bx bx-pencil"></i> Параметры</button><button class="pill-btn ai-btn" data-book-action="export"><i class="bx bx-export"></i> Экспорт книги</button></div></header>
    <nav class="workflow-toolbar book-detail-tabs knowledge-search-scope workflow-choice" aria-label="Раздел книги">${[['overview', 'Обзор'], ['chapters', `Главы · ${stats.chapters}`], ['world', `Мир · ${linked.length}`], ['notes', 'Замысел и заметки']].map(([id, label]) => `<button class="context-chip ${this.tab === id ? 'active' : ''}" data-book-action="tab" data-book-tab="${id}" aria-pressed="${this.tab === id}">${label}</button>`).join('')}</nav>
    <div class="book-detail-content" data-surface-key="book-content" data-book-tab-view="${escapeHtml(this.tab)}">${this.tab === 'overview' ? `<div class="book-overview"><div class="book-cover-large"><i class="bx bx-book-open"></i><strong>${escapeHtml(book.title)}</strong><span>${escapeHtml(book.author)}</span></div><section><h2>Как движется книга</h2><div class="book-metrics"><div><strong>${stats.chapters}</strong><span>привязанных глав</span></div><div><strong>${stats.words.toLocaleString('ru-RU')}</strong><span>слов в книге</span></div><div><strong>${stats.reviews}</strong><span>открытых правок</span></div></div>${book.targetWords ? `<div class="book-progress-track"><span style="width:${progress}%"></span></div><p class="workflow-note">${Math.round(progress)}% от ориентира ${book.targetWords.toLocaleString('ru-RU')} слов</p>` : '<p class="workflow-note">Ориентир объёма можно указать в параметрах книги.</p>'}<p class="book-synopsis">${escapeHtml(book.description || 'Опишите замысел, главную линию и то, зачем пишете эту книгу.')}</p><div class="workflow-toolbar"><button class="pill-btn" data-book-action="link-chapters"><i class="bx bx-link"></i> Привязать главы</button><button class="pill-btn" data-book-action="link-world"><i class="bx bx-world"></i> Привязать материалы мира</button>${stats.reviews ? '<button class="pill-btn" data-book-action="reviews">Разобрать правки</button>' : ''}</div></section></div>` : this.tab === 'chapters' ? `<div class="selection-heading"><span>Порядок книги</span><button class="pill-btn ai-btn" data-book-action="link-chapters"><i class="bx bx-plus"></i> Привязать главы</button></div><p class="workflow-note">Порядок здесь влияет только на эту книгу. Нумерация и папки рукописи сохраняются.</p><div class="book-chapter-list utility-list">${book.documentIds.map((id, index) => {
      const doc = this.app.state.docs.find(item => item.id === id);
      return `<div class="utility-row book-chapter-row" data-surface-key="book-chapter-${escapeHtml(id)}"><span class="book-chapter-number">${index + 1}</span><button class="book-chapter-title" data-book-action="chapter" data-doc-id="${escapeHtml(id)}" ${!doc || doc.locked ? 'disabled' : ''}><strong>${escapeHtml(doc?.title || 'Глава недоступна')}</strong><small>${doc?.locked ? 'Введите пароль' : doc ? `${countWords(docText(doc.ast))} слов · ${escapeHtml(doc.bookStatus || 'Черновик')}` : 'Возможно, глава находится в корзине'}</small></button><div class="book-chapter-controls"><button class="btn-icon" data-book-action="move" data-doc-id="${escapeHtml(id)}" data-direction="-1" ${index === 0 ? 'disabled' : ''} aria-label="Выше: ${escapeHtml(doc?.title || 'глава')}"><i class="bx bx-chevron-up"></i></button><button class="btn-icon" data-book-action="move" data-doc-id="${escapeHtml(id)}" data-direction="1" ${index === book.documentIds.length - 1 ? 'disabled' : ''} aria-label="Ниже: ${escapeHtml(doc?.title || 'глава')}"><i class="bx bx-chevron-down"></i></button><button class="btn-icon" data-book-action="unlink" data-doc-id="${escapeHtml(id)}" aria-label="Отвязать главу"><i class="bx bx-unlink"></i></button></div></div>`;
    }).join('') || this.app.emptyStateMarkup('bx-book-content', 'Главы ещё не привязаны', 'Выберите существующие документы. Одна глава может входить в несколько книг.')}</div>` : this.tab === 'world' ? `<div class="selection-heading"><span>Связанные материалы</span><button class="pill-btn ai-btn" data-book-action="link-world"><i class="bx bx-plus"></i> Привязать</button></div><div class="book-world-tags">${book.worldIds.map(id => `<span class="context-chip active"><i class="bx bx-world"></i> ${escapeHtml(worlds.get(id)?.title || 'Произведение недоступно')}</span>`).join('')}</div><div class="utility-list">${linked.map(link => `<button class="utility-row" data-book-action="entity" data-entity-id="${escapeHtml(link.id)}" data-lore-id="${escapeHtml(link.loreId)}" data-type="${link.type}" ${!link.item || link.world?.locked ? 'disabled' : ''}><i class="bx ${groups.find(([type]) => type === link.type)[2]}"></i><div><strong>${escapeHtml(link.item?.displayName || link.item?.name || link.item?.title || link.item?.text || 'Материал недоступен')}</strong><small>${escapeHtml(link.world?.title || 'Произведение')} · ${groups.find(([type]) => type === link.type)[1]}</small></div><i class="bx bx-chevron-right"></i></button>`).join('') || this.app.emptyStateMarkup('bx-world', 'Здесь будут материалы книги', 'Персонажи, места, события, записи и правила из любых произведений.')}</div>` : `<label class="form-field"><span>Рабочие заметки книги</span><textarea class="form-control book-notes-editor" rows="14" data-book-notes="${escapeHtml(book.id)}" placeholder="Замысел, сюжетные линии, список дел…">${escapeHtml(book.notes)}</textarea></label><small class="workflow-note" data-book-note-status>Сохранено на устройстве</small>`}</div>`;
  }

  refreshList() {
    for (const grid of document.querySelectorAll('[data-books-grid]')) this.app.updateSurfaceHTML(grid, this.cards());
  }

  refresh() {
    for (const root of document.querySelectorAll('.books-library')) {
      const html = this.render().replace(/^<section[^>]*>|<\/section>$/gu, '');
      const key = `books-${this.selectedId || 'library'}`, changed = root.dataset.surfaceKey !== key;
      if (changed) this.app.animateViewChange(root, () => { this.app.updateSurfaceHTML(root, html, { animate: false }); root.dataset.surfaceKey = key; });
      else this.app.updateSurfaceHTML(root, html);
      this.app.updateWorkflowSelections(root);
    }
  }

  async action(action, data = {}) {
    if (action === 'new') return this.edit();
    if (action === 'filter') { this.filter = data.bookFilter; this.refresh(); return; }
    if (action === 'open') { this.selectedId = data.bookId; this.tab = 'overview'; this.refresh(); return; }
    if (action === 'back') { this.selectedId = null; this.refresh(); return; }
    if (action === 'tab') { this.tab = data.bookTab; this.refresh(); return; }
    const book = this.book(); if (!book) return;
    if (action === 'edit') return this.edit(book);
    if (action === 'export') return this.exportDialog({ book });
    if (action === 'link-chapters') return this.link(book, 'chapters');
    if (action === 'link-world') return this.link(book, 'world');
    if (action === 'chapter') {
      document.getElementById('kb-modal')?.classList.remove('active');
      if (this.app.isMobileLayout()) this.app.closeMobileToEditor();
      this.app.selectDoc(data.docId); return;
    }
    if (action === 'move' || action === 'unlink') {
      const documentIds = [...book.documentIds], index = documentIds.indexOf(data.docId);
      if (index < 0) return;
      if (action === 'unlink') documentIds.splice(index, 1);
      else { const target = index + Number(data.direction); if (target < 0 || target >= documentIds.length) return; [documentIds[index], documentIds[target]] = [documentIds[target], documentIds[index]]; }
      await this.save({ id: book.id, documentIds }); this.refresh(); return;
    }
    if (action === 'reviews') return this.app.openReviewQueue(book.documentIds);
    if (action === 'entity') {
      const world = await this.app.db.get('lore', data.loreId); if (!world || world.locked) throw new Error('Материал недоступен.');
      this.app.state.activeLoreId = data.loreId; this.app.state.lore = await this.app.loadLore();
      this.app.state.activeKbTab = data.type; this.app.state.mobile.kbTab = data.type;
      if (data.type === 'rules') this.app.editWorldRules();
      else this.app.openLoreDetail(data.type, data.entityId);
    }
  }

  edit(book = null) {
    const overlay = document.getElementById('form-overlay');
    this.app.presentFormModal(`<div class="form-modal utility-modal book-edit-modal"><form class="book-edit-form" novalidate><div class="modal-head-row"><div><span class="workflow-eyebrow">Вся библиотека</span><h2>${book ? 'Параметры книги' : 'Новая книга'}</h2></div><button class="btn-icon" type="button" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div><label class="form-field"><span>Название</span><input class="form-control" name="title" maxlength="200" aria-required="true" aria-describedby="book-edit-error" value="${escapeHtml(book?.title || '')}" autofocus></label><label class="form-field"><span>Автор</span><input class="form-control" name="author" maxlength="200" value="${escapeHtml(book?.author || this.app.state.settings.authorName || '')}"></label><div class="book-edit-columns"><div class="form-field"><span>Этап работы</span>${this.app.renderFormSelect('status', statuses, book?.status || 'planned', { label: 'Этап работы' })}</div><label class="form-field"><span>Ориентир в словах</span><input class="form-control" name="targetWords" inputmode="numeric" aria-describedby="book-edit-error" value="${book?.targetWords || ''}" placeholder="Необязательно"></label></div><label class="form-field"><span>Замысел и описание</span><textarea class="form-control" name="description" rows="5">${escapeHtml(book?.description || '')}</textarea></label><p class="form-error" id="book-edit-error" data-book-error role="alert"></p><div class="form-actions"><button type="button" class="pill-btn" data-close-form>Отмена</button><button type="submit" class="pill-btn ai-btn"><i class="bx bx-check"></i> ${book ? 'Сохранить' : 'Создать книгу'}</button></div></form></div>`);
    overlay.querySelectorAll('[data-close-form]').forEach(button => { button.onclick = () => overlay.classList.remove('active'); });
    overlay.querySelector('form').oninput = event => {
      if (!event.target.hasAttribute('aria-invalid')) return;
      event.target.removeAttribute('aria-invalid');
      this.app.animateHeightTransition(overlay.firstElementChild, () => overlay.querySelector('[data-book-error]').textContent = '');
    };
    overlay.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const form = event.target, fields = Object.fromEntries(new FormData(form));
      try {
        form.querySelectorAll('[aria-invalid]').forEach(input => input.removeAttribute('aria-invalid'));
        if (!fields.title.trim()) { form.elements.title.setAttribute('aria-invalid', 'true'); form.elements.title.focus(); throw new Error('Введите название книги.'); }
        if (fields.targetWords && (!/^\d+$/u.test(fields.targetWords) || Number(fields.targetWords) > 10_000_000)) { form.elements.targetWords.setAttribute('aria-invalid', 'true'); form.elements.targetWords.focus(); throw new Error('Ориентир — целое число от 0 до 10 000 000.'); }
        await this.app.runSurfaceAction(form.querySelector('[type="submit"]'), 'Сохраняем…', async () => {
          const saved = await this.save({ id: book?.id, ...fields }); this.selectedId = saved.id; this.tab = 'overview'; overlay.classList.remove('active'); this.refresh(); this.app.toast(book ? 'Параметры книги сохранены.' : 'Книга создана.');
        });
      } catch (error) {
        const message = form.querySelector('[data-book-error]');
        this.app.animateHeightTransition(overlay.firstElementChild, () => message.textContent = error.message);
        this.app.runMotion(message, [{ opacity: 0, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 220 });
      }
    };
  }

  async link(book, kind) {
    const worlds = (await this.app.db.getAll('lore')).filter(world => !world.locked);
    const overlay = document.getElementById('form-overlay');
    const key = link => `${link.loreId}:${link.type}:${link.id}`, current = new Set(book.links.map(key));
    const option = (id, title, note, checked, attributes) => `<label class="utility-row nocturne-check book-link-option" data-link-label="${escapeHtml(`${title} ${note}`.toLocaleLowerCase('ru-RU'))}"><input type="checkbox" value="${escapeHtml(id)}" ${checked ? 'checked' : ''} ${attributes}><span class="check-mark"></span><div><strong>${escapeHtml(title)}</strong><small>${escapeHtml(note)}</small></div></label>`;
    const candidates = worlds.flatMap(world => groups.flatMap(([type]) => (world[type] || []).map(item => ({ id: item.id, type, loreId: world.id, item, world }))));
    this.app.presentFormModal(`<div class="form-modal utility-modal book-links-modal"><div class="modal-head-row"><div><h2>${kind === 'chapters' ? 'Привязать главы' : 'Материалы из любых произведений'}</h2><p>${escapeHtml(book.title)} · существующие материалы останутся на месте</p></div><button class="btn-icon" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div><label class="mobile-search-field"><i class="bx bx-search"></i><input class="form-control" data-link-search type="search" placeholder="Найти материал" aria-label="Найти материал для книги"></label><form novalidate><div class="utility-list book-link-list">${kind === 'chapters' ? this.app.state.docs.filter(doc => !doc.locked).map(doc => option(doc.id, doc.title, doc.workTitle || this.app.state.kbProjects.find(world => world.id === doc.loreId)?.title || 'Рукопись', book.documentIds.includes(doc.id), 'name="chapters"')).join('') : worlds.map(world => `<section class="book-link-world"><h3>${escapeHtml(world.title || 'Произведение')}</h3>${option(world.id, 'Связать произведение целиком', 'В книге появится ссылка на этот мир', book.worldIds.includes(world.id), 'name="worlds"')}${groups.map(([type, label]) => `<h4>${label}</h4>${candidates.filter(link => link.loreId === world.id && link.type === type).map(link => option(key(link), link.item.displayName || link.item.name || link.item.title || link.item.text || 'Без названия', textFromHtml(link.item.body || '').slice(0, 90), current.has(key(link)), 'name="materials"')).join('')}`).join('')}</section>`).join('')}</div><div class="form-actions"><button type="button" class="pill-btn" data-close-form>Отмена</button><button type="submit" class="pill-btn ai-btn">Сохранить связи</button></div></form></div>`);
    overlay.querySelectorAll('[data-close-form]').forEach(button => { button.onclick = () => overlay.classList.remove('active'); });
    overlay.querySelector('[data-link-search]').oninput = event => this.app.animateLayoutTransition(overlay.querySelector('.book-link-list'), () => { const query = event.target.value.toLocaleLowerCase('ru-RU'); overlay.querySelectorAll('[data-link-label]').forEach(row => { row.hidden = !row.dataset.linkLabel.includes(query); }); });
    overlay.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      try {
        await this.app.runSurfaceAction(event.target.querySelector('[type="submit"]'), 'Сохраняем…', async () => {
          const data = new FormData(event.target);
          const available = new Set(this.app.state.docs.filter(doc => !doc.locked).map(doc => doc.id));
          const documentIds = kind === 'chapters' ? [...book.documentIds.filter(id => !available.has(id) || data.getAll('chapters').includes(id)), ...data.getAll('chapters').filter(id => !book.documentIds.includes(id))] : book.documentIds;
          const keys = new Set(data.getAll('materials'));
          await this.save({ id: book.id, documentIds, ...(kind === 'world' ? { worldIds: [...book.worldIds.filter(id => !worlds.some(world => world.id === id)), ...data.getAll('worlds')], links: [...book.links.filter(link => !candidates.some(candidate => key(candidate) === key(link))), ...candidates.filter(link => keys.has(key(link))).map(({ id, type, loreId }) => ({ id, type, loreId }))] } : {}) });
          overlay.classList.remove('active'); this.refresh(); this.app.toast('Связи книги сохранены.');
        });
      } catch (error) { this.app.toast(error.message); }
    };
  }

  exportDialog({ book = null } = {}) {
    this.exportState = { bookId: book?.id, title: book?.title || '', order: book ? [...book.documentIds] : sortExportChapters(this.app.state.docs).map(doc => doc.id), selected: new Set(book ? book.documentIds : this.app.state.docs.filter(doc => !doc.locked).map(doc => doc.id)), notes: false };
    this.renderExport();
  }

  renderExport() {
    const state = this.exportState, overlay = document.getElementById('form-overlay');
    const docs = state.order.map(id => this.app.state.docs.find(doc => doc.id === id)).filter(Boolean);
    const selected = docs.filter(doc => state.selected.has(doc.id));
    const worlds = new Set(selected.map(doc => doc.workTitle || doc.loreId || 'Рукопись'));
    this.app.presentFormModal(`<div class="form-modal utility-modal book-export-modal"><div class="modal-head-row"><div><h2>Экспорт книги</h2><p>${escapeHtml(state.title || 'Рукопись')} · оглавление в точном порядке выгрузки</p></div><button class="btn-icon" data-close-form aria-label="Закрыть"><i class="bx bx-x"></i></button></div><div class="workflow-toolbar"><button class="context-chip ${!state.notes ? 'active' : ''}" data-export-reader>Для чтения</button><button class="context-chip ${state.notes ? 'active' : ''}" data-export-editor>Редактору</button>${this.presets.map(preset => `<button class="context-chip" data-export-preset="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</button>`).join('')}</div><div class="selection-heading"><span>Главы <small id="book-export-count">${selected.length} из ${docs.length}</small></span><button class="mini-text-btn" data-export-select-all>${selected.length === docs.filter(doc => !doc.locked).length ? 'Снять выбор' : 'Выбрать все'}</button></div><div class="utility-list chapter-selection">${docs.map((doc, index) => `<div class="utility-row export-order-row" data-surface-key="export-${escapeHtml(doc.id)}"><label class="nocturne-check"><input type="checkbox" data-export-chapter="${escapeHtml(doc.id)}" ${state.selected.has(doc.id) ? 'checked' : ''} ${doc.locked ? 'disabled' : ''}><span class="check-mark"></span><span><strong>${escapeHtml(doc.title)}</strong><small>${escapeHtml([doc.workTitle, doc.volume && `Том ${doc.volume}`, doc.chapterNumber && `Глава ${doc.chapterNumber}`, doc.locked && 'Введите пароль'].filter(Boolean).join(' · '))}</small></span></label><div class="book-chapter-controls"><button class="btn-icon" data-export-move="${escapeHtml(doc.id)}" data-direction="-1" ${index === 0 ? 'disabled' : ''} aria-label="Поднять главу"><i class="bx bx-chevron-up"></i></button><button class="btn-icon" data-export-move="${escapeHtml(doc.id)}" data-direction="1" ${index === docs.length - 1 ? 'disabled' : ''} aria-label="Опустить главу"><i class="bx bx-chevron-down"></i></button></div></div>`).join('') || '<p class="utility-empty">Сначала создайте или привяжите главы.</p>'}</div><p class="workflow-note export-mixed-warning" ${worlds.size > 1 ? '' : 'hidden'}><i class="bx bx-info-circle"></i> Выбраны главы из ${worlds.size} произведений. Проверьте оглавление перед выгрузкой.</p><label class="nocturne-check export-notes-option"><input type="checkbox" id="book-export-notes" ${state.notes ? 'checked' : ''}><span class="check-mark"></span><span>Добавить личные заметки к главам</span></label><details class="workflow-details"><summary>Сохранить набор для следующего экспорта</summary><div class="workflow-toolbar"><input class="form-control" data-export-preset-name maxlength="100" placeholder="Название набора" aria-label="Название набора экспорта"><button class="pill-btn" data-export-save-preset>Сохранить набор</button></div></details><div class="form-actions"><button class="pill-btn" data-close-form>Отмена</button><button class="pill-btn ai-btn" data-export-book ${selected.length ? '' : 'disabled'}><i class="bx bx-export"></i> Экспортировать DOCX</button></div></div>`);
    overlay.querySelectorAll('[data-close-form]').forEach(button => { button.onclick = () => overlay.classList.remove('active'); });
    overlay.querySelector('[data-export-reader]').onclick = () => { state.notes = false; this.renderExport(); };
    overlay.querySelector('[data-export-editor]').onclick = () => { state.notes = true; this.renderExport(); };
    overlay.querySelector('#book-export-notes').onchange = event => { state.notes = event.target.checked; };
    overlay.querySelector('[data-export-select-all]').onclick = () => { state.selected = state.selected.size === docs.filter(doc => !doc.locked).length ? new Set() : new Set(docs.filter(doc => !doc.locked).map(doc => doc.id)); this.renderExport(); };
    overlay.querySelectorAll('[data-export-chapter]').forEach(input => { input.onchange = () => { if (input.checked) state.selected.add(input.dataset.exportChapter); else state.selected.delete(input.dataset.exportChapter); this.renderExport(); }; });
    overlay.querySelectorAll('[data-export-move]').forEach(button => { button.onclick = () => { const from = state.order.indexOf(button.dataset.exportMove), to = from + Number(button.dataset.direction); if (to >= 0 && to < state.order.length) { [state.order[from], state.order[to]] = [state.order[to], state.order[from]]; this.renderExport(); } }; });
    overlay.querySelectorAll('[data-export-preset]').forEach(button => { button.onclick = () => { const preset = this.presets.find(item => item.id === button.dataset.exportPreset); if (!preset) return; state.order = [...preset.documentIds.filter(id => this.app.state.docs.some(doc => doc.id === id)), ...state.order.filter(id => !preset.documentIds.includes(id))]; state.selected = new Set(preset.documentIds); state.notes = !!preset.notes; this.renderExport(); }; });
    overlay.querySelector('[data-export-save-preset]').onclick = async () => {
      const name = overlay.querySelector('[data-export-preset-name]').value.trim(); if (!name) { this.app.toast('Введите название набора.'); return; }
      try { await this.mutate(record => { const preset = { id: uid('export-preset'), name, documentIds: state.order.filter(id => state.selected.has(id)), notes: state.notes }; record.presets = [...(record.presets || []).filter(item => item.name !== name), preset]; return record; }); this.renderExport(); this.app.toast('Набор экспорта сохранён.'); } catch (error) { this.app.toast(error.message); }
    };
    const button = overlay.querySelector('[data-export-book]');
    button.onclick = async () => {
      try { await this.app.runSurfaceAction(button, 'Собираем DOCX…', async () => {
        const ids = state.order.filter(id => state.selected.has(id));
        const blob = await this.app.buildBookDocx(ids, { includeNotes: state.notes, title: state.title, preserveOrder: true });
        if (await this.app.downloadBlob(blob, `${this.app.safeFileName(state.title || this.app.state.docs.find(doc => ids.includes(doc.id))?.workTitle || 'Рукопись')}.docx`)) { overlay.classList.remove('active'); this.app.toast('Рукопись экспортирована.'); }
      }); } catch (error) { this.app.toast(error.message); }
    };
  }
}
