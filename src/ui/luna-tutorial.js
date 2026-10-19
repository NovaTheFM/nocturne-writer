import { t, getLocale } from '../core/i18n.js';
import { escapeHtml } from '../core/utils.js';
import { lunaTutorialSteps, lunaTutorialCopy } from './luna-tutorial-steps.js';

export const TUTORIAL_RECORD_ID = 'luna-tutorial';
const focusable = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const terminal = record => record?.version === 1 && ['completed', 'skipped'].includes(record.status);
const visible = element => element?.isConnected && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[inert]') && (element.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true }) ?? true);
const first = (...selectors) => selectors.flatMap(selector => [...document.querySelectorAll(selector)]).find(visible);
const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

export class LunaTutorial {
  constructor(app) { this.app = app; this.active = false; }

  async welcomeIfNeeded() {
    try { if (terminal(await this.app.db.get('settings', TUTORIAL_RECORD_ID))) return; }
    catch (error) { console.warn('Luna tutorial preference:', error); }
    return this.start();
  }

  start() {
    if (this.active) return this.completion;
    this.active = true;
    this.finishing = false;
    this.visitedTopics = [];
    this.initialReviewMode = this.app.state.reviewMode;
    this.initialZen = !!this.app.state.zenActive;
    this.viewTouched = false;
    this.previousFocus = document.activeElement;
    this.locale = getLocale();
    this.mobileLayout = this.app.isMobileLayout();
    this.completion = new Promise(resolve => { this.resolve = resolve; });
    this.app.disposeModalFocus?.();
    this.root = document.createElement('div');
    this.root.id = 'luna-tutorial';
    this.root.innerHTML = `<svg class="luna-tutorial-shade" aria-hidden="true" focusable="false"><defs><mask id="luna-spotlight-mask" maskUnits="userSpaceOnUse"><rect width="100%" height="100%" fill="white"/><rect class="luna-cutout" rx="14" fill="black"/></mask></defs><rect width="100%" height="100%" mask="url(#luna-spotlight-mask)"/></svg>
      <div class="luna-spotlight" aria-hidden="true"></div>
      <div class="luna-companion">
        <div class="luna-mascot" data-luna-mascot aria-hidden="true"><svg viewBox="0 0 100 100" focusable="false"><path class="luna-moon" d="M70 12a38 38 0 1 0 17 62A40 40 0 0 1 70 12Z"/><path class="luna-star" d="m80 16 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z"/><path class="luna-face" d="M32 57q3-5 6 0m9-1q3-5 6 0m-14 9q5 5 10-1"/></svg></div>
        <section class="luna-dialog" role="dialog" aria-modal="false" aria-label="${escapeHtml(t('Луна'))}" aria-describedby="luna-tutorial-text" tabindex="-1">
          <div class="luna-dialog-copy" aria-live="polite" aria-atomic="true"></div>
          <div class="luna-progress" role="progressbar" aria-label="${escapeHtml(t('Прогресс обучения'))}" aria-valuemin="1"><span></span></div>
          <footer class="luna-dialog-actions"></footer>
        </section>
      </div>`;
    document.body.append(this.root);
    document.body.classList.add('luna-tutorial-active');
    this.dialog = this.root.querySelector('.luna-dialog');
    this.companion = this.root.querySelector('.luna-companion');
    this.cutout = this.root.querySelector('.luna-cutout');
    this.spotlight = this.root.querySelector('.luna-spotlight');
    this.onClick = event => {
      const choice = event.target.closest('[data-luna-choice]')?.dataset.lunaChoice;
      if (!choice || this.changing || this.finishing) return;
      if (choice === 'yes') this.begin();
      else if (choice === 'no' || choice === 'skip') this.finish('skipped');
      else if (choice === 'done') this.finish('completed');
      else if (choice === 'next') this.next();
      else if (choice === 'back') this.goBack()?.catch(error => { this.changing = false; this.app.toast(error.message); });
    };
    this.root.addEventListener('click', this.onClick);
    this.onPointer = event => {
      if (event.type === 'click' && this.step === 'create-form' && event.target.closest('[data-close-form]')) this.formCancelled = true;
      if (this.allowed(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    this.onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.finish('skipped'); return; }
      if (!this.changing && (event.ctrlKey || event.metaKey) && event.code === 'KeyK' && ['tools-commands', 'open-commands'].includes(this.step)) {
        event.preventDefault(); event.stopImmediatePropagation();
        this.app.closeAllFloatingMenus(); this.app.commandPalette.open({ focusInput: false }); this.show('commands'); return;
      }
      if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation();
        const nodes = this.focusTargets();
        const index = nodes.indexOf(document.activeElement);
        const next = index < 0 ? event.shiftKey ? nodes.length - 1 : 0 : (index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length;
        nodes[next]?.focus({ preventScroll: true });
        return;
      }
      if (this.description()?.then && this.target?.contains(event.target) && !this.target.matches('button, input, textarea, select') && ['Enter', ' '].includes(event.key)) {
        event.preventDefault(); event.stopImmediatePropagation(); this.target.click(); return;
      }
      const editingShortcut = ['a', 'c', 'v', 'x', 'z', 'y', 'b', 'i', 'u', 's', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'backspace', 'delete'].includes(event.key.toLowerCase());
      if (!this.allowed(event.target) || (event.ctrlKey || event.metaKey) && !editingShortcut) {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    };
    this.onFocus = event => { if (!this.allowed(event.target) && !this.finishing) this.dialog.focus({ preventScroll: true }); };
    for (const type of ['pointerdown', 'click', 'dblclick', 'contextmenu']) document.addEventListener(type, this.onPointer, true);
    document.addEventListener('keydown', this.onKey, true);
    document.addEventListener('focusin', this.onFocus, true);
    this.show('welcome', false);
    this.app.runMotion(this.root, [{ opacity: 0 }, { opacity: 1 }], { channel: 'tutorial', duration: 360 });
    this.tick();
    return this.completion;
  }

  allowed(node) {
    return this.root?.contains(node) || this.description()?.interactive !== false && this.target?.contains(node) || this.extraTargets?.some(target => target.contains(node));
  }

  focusTargets() {
    const islands = [this.description()?.interactive !== false ? this.target : null, ...(this.extraTargets || []), this.dialog].filter(Boolean);
    return [...new Set(islands.flatMap(island => [...(island.matches(focusable) ? [island] : []), ...island.querySelectorAll(focusable)]))].filter(element => visible(element) && element.tabIndex >= 0);
  }

  begin() {
    this.viewTouched = true;
    if (this.app.state.reviewMode !== 'write') this.app.setReviewMode('write');
    if (this.app.state.zenActive) this.app.toggleZen(false);
    this.app.closeAllFloatingMenus();
    document.getElementById('settings-overlay')?.classList.remove('active');
    if (this.app.isMobileLayout()) this.app.closeMobileToEditor();
    const focused = this.app.getFocusedDoc();
    const doc = focused && !focused.locked && !focused.encrypted ? focused : this.app.state.docs.find(item => !item.locked && !item.encrypted);
    if (doc && !doc.locked && !doc.encrypted) { this.app.selectDoc(doc.id); this.show('write'); }
    else this.show(this.app.isMobileLayout() && !this.newDocButton() ? 'open-docs' : 'create');
  }

  newDocButton() { return first('.workspace-empty [data-action="new-doc"]', '.empty-project-card [data-action="new-doc"]', '#mobile-tab-surface.active [data-action="new-doc"]', '.sidebar [data-action="new-doc"]'); }

  find(...selectors) { return first(...selectors); }

  editorTarget() { return first('.workspace-pane.active-pane .editor-scroll-area', '.editor-scroll-area', '.page-content-prosemirror'); }

  canShowSplit() { return !this.app.isMobileLayout() && innerWidth >= 1024; }

  topics() {
    return ['write', 'bookmarks', 'notes', 'kb', 'commands', 'history', 'review', 'focus', ...(this.canShowSplit() ? ['split'] : []), 'search', 'book', 'backups', 'settings', 'macros', 'formatting'];
  }

  description(step = this.step) {
    const key = `${this.app.isMobileLayout()}:${this.canShowSplit()}:${this.app.state.settings.showZenButton}`;
    if (this.stepsKey !== key) { this.stepsKey = key; this.steps = lunaTutorialSteps(this); }
    return this.steps[step];
  }

  paletteQueryReady() {
    const query = this.app.commandPalette.query.trim();
    if (query !== this.paletteQuery) { this.paletteQuery = query; this.paletteQueryChanged = performance.now(); }
    return query.length > 1 && performance.now() - this.paletteQueryChanged >= 500;
  }

  async show(step, animate = true) {
    if (!this.active || this.finishing) return;
    this.changing = true;
    const generation = this.generation = (this.generation || 0) + 1;
    this.detachTarget();
    const outgoing = animate && this.app.runMotion(this.dialog, [{ opacity: 1 }, { opacity: 0 }], { channel: 'tutorial-copy', duration: 110, fill: 'forwards' });
    if (outgoing) await outgoing.finished;
    if (!this.active || this.finishing || generation !== this.generation) return;
    this.step = step;
    if (step === 'focus' && this.app.isMobileLayout()) this.app.closeMobileToEditor();
    if (step === 'create-form') this.formCancelled = false;
    this.root.dataset.step = step;
    document.body.dataset.lunaStep = step;
    this.locale = getLocale();
    const description = this.description();
    this.dialog.setAttribute('aria-label', t('Луна'));
    if (description.topic && this.visitedTopics.at(-1) !== description.topic) this.visitedTopics.push(description.topic);
    this.app.animateHeightTransition(this.dialog, () => {
      this.root.querySelector('.luna-dialog-copy').innerHTML = `<p id="luna-tutorial-text">${escapeHtml(t(this.copy()))}</p>`;
      const primary = (choice, label) => `<button type="button" class="pill-btn ai-btn" data-luna-choice="${choice}">${escapeHtml(t(label))}<i class="bx bx-right-arrow-alt" aria-hidden="true"></i></button>`;
      const skip = `<button type="button" class="luna-skip" data-luna-choice="skip">${escapeHtml(t('Пропустить обучение'))}</button>`;
      const back = this.visitedTopics.filter(topic => this.topics().includes(topic)).length > 1 ? `<button type="button" class="pill-btn luna-back" data-luna-choice="back" aria-label="${escapeHtml(t('Вернуться к предыдущей теме'))}" title="${escapeHtml(t('Вернуться к предыдущей теме'))}"><i class="bx bx-left-arrow-alt" aria-hidden="true"></i></button>` : '';
      this.root.querySelector('.luna-dialog-actions').innerHTML = step === 'welcome'
        ? `<button type="button" class="pill-btn" data-luna-choice="no">${escapeHtml(t('Нет'))}</button>${primary('yes', 'Да')}`
        : step === 'done' ? `${skip}<div class="luna-forward">${back}${primary('done', 'Начать писать')}</div>`
          : `${skip}<div class="luna-forward">${back}${description.go ? primary('next', 'Дальше') : ''}</div>`;
    }, { duration: animate ? 300 : 0 });
    this.updateProgress();
    this.updateTarget(); this.layout();
    outgoing?.animation?.cancel();
    this.app.runMotion(this.dialog, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { channel: 'tutorial-copy', duration: 260 });
    this.changing = false;
    (step === 'commands' && !this.app.isMobileLayout() ? this.target : this.dialog)?.focus({ preventScroll: true });
  }

  detachTarget() {
    if (this.target) {
      this.target.removeAttribute('data-luna-target');
      if (this.targetDescription === null) this.target.removeAttribute('aria-describedby');
      else if (this.targetDescription !== undefined) this.target.setAttribute('aria-describedby', this.targetDescription);
      if (this.addedTabIndex) this.target.removeAttribute('tabindex');
      if (this.addedRole) this.target.removeAttribute('role');
    }
    this.target = null; this.extraTargets = []; this.addedTabIndex = false; this.addedRole = false;
  }

  copy() { return lunaTutorialCopy(this.step, this.app.isMobileLayout()); }

  updateProgress() {
    const topics = this.topics(), current = this.description()?.topic;
    const progress = this.root.querySelector('.luna-progress');
    progress.hidden = this.step === 'welcome' || this.step === 'create' || this.step === 'create-form' || this.step === 'open-docs';
    const value = this.step === 'done' ? topics.length : Math.max(1, topics.indexOf(current) + 1);
    progress.setAttribute('aria-valuemax', topics.length);
    progress.setAttribute('aria-valuenow', value);
    progress.querySelector('span').style.transform = `scaleX(${value / topics.length})`;
  }

  updateTarget() {
    const target = this.description()?.target?.() || null;
    if (target === this.target) return;
    this.detachTarget();
    this.target = target;
    if (!target) return;
    target.setAttribute('data-luna-target', '');
    this.targetDescription = target.getAttribute('aria-describedby');
    target.setAttribute('aria-describedby', `${this.targetDescription || ''} luna-tutorial-text`.trim());
    if (this.description().then) {
      if (!target.matches('button, input, textarea, select') && !target.hasAttribute('tabindex')) { target.tabIndex = 0; this.addedTabIndex = true; }
      if (!target.matches('button, input, textarea, select') && !target.hasAttribute('role')) { target.setAttribute('role', 'button'); this.addedRole = true; }
      target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
    if (this.step === 'write') this.extraTargets = [first('.toolbar-center')].filter(Boolean);
    if (this.step === 'book') this.extraTargets = [first('.chapter-selection'), first('.export-notes-option')].filter(Boolean);
    if (this.step === 'create-form') {
      target.setAttribute('role', 'dialog');
      const title = target.querySelector('h2');
      if (title && !title.id) title.id = 'luna-document-form-title';
      if (title) target.setAttribute('aria-labelledby', title.id);
    }
  }

  layout() {
    if (!this.root?.isConnected) return;
    const viewport = window.visualViewport;
    const top = viewport?.offsetTop || 0, left = viewport?.offsetLeft || 0;
    const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
    this.root.style.setProperty('--luna-viewport-top', `${top}px`);
    this.root.style.setProperty('--luna-viewport-height', `${height}px`);
    const mobile = this.app.isMobileLayout();
    this.root.classList.toggle('luna-mobile', mobile);
    this.root.classList.toggle('luna-reduced', this.app.shouldReduceSurfaceMotion());
    this.root.classList.toggle('luna-keyboard', mobile && height < innerHeight * .72);
    const rect = this.target?.getBoundingClientRect();
    const coachHeight = this.companion.offsetHeight;
    const margin = mobile ? 24 : Math.max(56, Math.min(112, width * .08));
    const reservedLeft = `${margin + this.companion.offsetWidth + 32}px`;
    if (document.body.style.getPropertyValue('--luna-preview-left') !== reservedLeft) document.body.style.setProperty('--luna-preview-left', reservedLeft);
    const x = left + margin;
    let y = top + height * .48 - coachHeight / 2;
    if (mobile && this.step === 'create-form') y = top + 14;
    const formPreview = document.body.classList.contains('luna-form-preview');
    if (formPreview && width < 1100) y = top + 14;
    if (mobile && !formPreview && this.root.classList.contains('luna-keyboard')) y = top + height - coachHeight - 12;
    if (rect && rect.height < 200 && x < rect.right + 12 && x + this.companion.offsetWidth > rect.left - 12 && y < rect.bottom + 12 && y + coachHeight > rect.top - 12) {
      const alternatives = [rect.top - coachHeight - 24, rect.bottom + 24].filter(value => value >= top + 14 && value + coachHeight <= top + height - 14);
      if (alternatives.length) y = alternatives.sort((a, b) => Math.abs(a - y) - Math.abs(b - y))[0];
    }
    this.companion.style.left = `${Math.max(left + 8, x)}px`;
    this.companion.style.top = `${Math.max(top + 8, y)}px`;
    const reserve = `${coachHeight + (mobile ? 28 : 48)}px`;
    if (document.body.style.getPropertyValue('--luna-coach-space') !== reserve) document.body.style.setProperty('--luna-coach-space', reserve);
    if (rect) {
      const x1 = Math.max(5, rect.left - 6), y1 = Math.max(top + 5, rect.top - 6);
      const x2 = Math.min(innerWidth - 5, rect.right + 6), y2 = Math.min(top + height - 5, rect.bottom + 6);
      for (const [key, value] of Object.entries({ x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) })) this.cutout.setAttribute(key, value);
      Object.assign(this.spotlight.style, { left: `${x1}px`, top: `${y1}px`, width: `${Math.max(0, x2 - x1)}px`, height: `${Math.max(0, y2 - y1)}px` });
    }
    this.spotlight.hidden = !rect;
    this.cutout.style.display = rect ? '' : 'none';
  }

  tick() {
    if (!this.active || this.finishing) return;
    const formOverlay = document.getElementById('form-overlay');
    const formVisible = formOverlay?.classList.contains('active') || formOverlay && Number(getComputedStyle(formOverlay).opacity) > .01;
    document.body.classList.toggle('luna-form-preview', !!formVisible && this.step !== 'create-form');
    for (const surface of document.querySelectorAll('#form-overlay, #settings-overlay, #kb-modal, #mobile-overlay, #floating-notes-modal, #command-palette-overlay')) {
      const closed = !surface.classList.contains('active');
      if (surface.inert !== closed) surface.inert = closed;
      if (surface.getAttribute('aria-hidden') !== String(closed)) surface.setAttribute('aria-hidden', String(closed));
      const dialog = surface.matches('#kb-modal') ? surface : surface.querySelector('[role="dialog"]');
      if (!closed && dialog?.getAttribute('aria-modal') === 'true') dialog.setAttribute('aria-modal', 'false');
    }
    if (!this.changing) {
      if (this.app.isMobileLayout() !== this.mobileLayout && !this.app.interfaceLanguage.busy) this.adaptLayout().catch(error => { this.changing = false; this.app.toast(error.message); });
      else if (getLocale() !== this.locale && !this.app.interfaceLanguage.busy) this.show(this.step);
      else {
        this.updateTarget(); this.layout();
        const description = this.description();
        if (this.step === 'create-form' && this.formCancelled && !first('#form-overlay.active')) this.show('create');
        else if (description?.ready?.()) this.show(description.then);
        if (this.description()?.topic === 'split' && !this.canShowSplit()) this.reviewTopic('search').catch(error => { this.changing = false; this.app.toast(error.message); });
      }
    }
    this.animationFrame = requestAnimationFrame(() => this.tick());
  }

  async adaptLayout() {
    this.mobileLayout = this.app.isMobileLayout();
    if (['welcome', 'create', 'create-form', 'open-docs', 'done', 'write'].includes(this.step)) {
      const step = this.step === 'open-docs' && !this.mobileLayout ? 'create' : this.step === 'create' && this.mobileLayout && !this.newDocButton() ? 'open-docs' : this.step;
      return this.show(step);
    }
    return this.reviewTopic(this.description().topic === 'split' && !this.canShowSplit() ? 'search' : this.description().topic);
  }

  cleanupPreview() {
    this.app.closeAllFloatingMenus();
    if (this.app.commandPalette.opened) this.app.commandPalette.close({ restoreFocus: false });
    for (const id of ['kb-modal', 'settings-overlay', 'form-overlay']) document.getElementById(id)?.classList.remove('active');
    document.getElementById('notes-panel')?.classList.remove('open');
    if (this.app.state.floatingNotesManagerOpen) { this.app.state.floatingNotesManagerOpen = false; this.app.renderFloatingNotesModal(); }
    if (this.app.isMobileLayout()) this.app.closeMobileToEditor();
    if (this.viewTouched) {
      if (this.app.state.reviewMode !== 'write') this.app.setReviewMode('write');
      if (this.app.state.zenActive) this.app.toggleZen(false);
    }
  }

  async reviewTopic(topic) {
    this.changing = true;
    this.cleanupPreview();
    const mobile = this.app.isMobileLayout();
    let step = topic;
    switch (topic) {
      case 'bookmarks':
        if (mobile) this.app.openMobilePanel('bookmarks', 'write');
        else {
          this.app.bookmarks.openPaneMenuId = this.app.state.workspace.focusedPaneId;
          this.app.openFloatingMenu('bookmarkPane');
        }
        break;
      case 'notes':
        if (mobile) this.app.openMobilePanel('notes', 'more');
        else document.getElementById('notes-panel')?.classList.add('open');
        break;
      case 'kb':
        if (mobile) { this.app.state.mobile.kbTab = 'search'; this.app.switchMobileTab('lore'); }
        else this.app.openKb('search');
        step = 'world-search'; break;
      case 'commands': this.app.commandPalette.open({ focusInput: false }); break;
      case 'history': await this.app.showHistory(); break;
      case 'review': this.app.setReviewMode('finalization'); step = 'finalization'; break;
      case 'focus': await this.app.toggleZen(true); break;
      case 'split': this.app.openFloatingMenu('split'); break;
      case 'search': this.app.openGlobalSearchWindow(); step = 'project-search'; break;
      case 'book': this.app.openBookExport(); break;
      case 'backups': await this.app.openBackups(); break;
      case 'settings': this.app.openSettingsTab('visual'); break;
      case 'macros': case 'formatting': this.app.openSettingsTab(topic); break;
    }
    return this.show(step);
  }

  goBack() {
    const visited = this.visitedTopics.filter(topic => this.topics().includes(topic));
    if (visited.length < 2) return;
    if (this.step === 'done') return this.reviewTopic(visited.at(-1));
    visited.pop();
    this.visitedTopics = visited;
    return this.reviewTopic(visited.at(-1));
  }

  next() {
    if (this.changing) return;
    const description = this.description(), next = description.go;
    if (!next) return;
    this.app.blurMobileEditorFocus();
    if (this.description(next)?.topic !== description.topic && !['open-macros', 'open-formatting'].includes(next)) this.cleanupPreview();
    if (this.app.isMobileLayout() && ['open-macros', 'open-formatting'].includes(next)) {
      this.app.state.mobile.settingsTab = null; this.app.renderMobileShell();
    }
    this.show(next);
  }

  restoreView() {
    if (!this.viewTouched) return;
    if (this.app.state.reviewMode !== this.initialReviewMode) this.app.setReviewMode(this.initialReviewMode);
    if (!!this.app.state.zenActive !== this.initialZen) this.app.toggleZen(this.initialZen);
    this.viewTouched = false;
  }

  clearPreviewLayout() {
    const update = () => {
      document.body.classList.remove('luna-form-preview', 'luna-tutorial-active');
      delete document.body.dataset.lunaStep;
      document.body.style.removeProperty('--luna-preview-left');
      document.body.style.removeProperty('--luna-coach-space');
    };
    const overlay = document.getElementById('form-overlay');
    if (overlay?.classList.contains('active') && (document.body.classList.contains('luna-form-preview') || this.step === 'create-form')) this.app.animateLayoutTransition(overlay, update, { targets: [...overlay.querySelectorAll(':scope > .form-modal')], duration: .34 });
    else update();
  }

  async finish(status) {
    if (!this.active || this.finishing) return;
    this.finishing = true;
    cancelAnimationFrame(this.animationFrame);
    this.generation = (this.generation || 0) + 1;
    this.root.querySelectorAll('button').forEach(button => { button.disabled = true; });
    this.restoreView();
    try { await this.app.db.put('settings', { id: TUTORIAL_RECORD_ID, version: 1, status, updatedAt: Date.now() }); }
    catch (error) { console.warn('Luna tutorial preference:', error); this.app.toast(t('Не удалось запомнить прохождение обучения. При следующем запуске я могу появиться снова.')); }
    await this.app.runMotion(this.root, [{ opacity: 1 }, { opacity: 0 }], { channel: 'tutorial', duration: 280 }).finished;
    this.detachTarget();
    this.root.remove();
    for (const type of ['pointerdown', 'click', 'dblclick', 'contextmenu']) document.removeEventListener(type, this.onPointer, true);
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('focusin', this.onFocus, true);
    this.clearPreviewLayout();
    this.active = false;
    this.app.installModalFocus();
    await frame();
    const form = first('#form-overlay.active input[name="title"]');
    const restore = form || (visible(this.previousFocus) ? this.previousFocus : first('.page-content-prosemirror', '.workspace-empty button', '[data-action="open-settings"]', '[data-action="mobile-open-more"]'));
    restore?.focus({ preventScroll: true });
    this.resolve(status);
    if (this.app.startupInteractionReady) this.app.openPendingNativeFiles().catch(error => console.warn('Pending native files:', error));
  }
}
