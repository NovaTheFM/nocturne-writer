import { t, getLocale } from '../core/i18n.js';
import { escapeHtml } from '../core/utils.js';

export const TUTORIAL_RECORD_ID = 'luna-tutorial';
const focusable = 'button:not(:disabled), a[href], input:not(:disabled):not([type="hidden"]), textarea:not(:disabled), select:not(:disabled), [contenteditable="true"], [tabindex]:not([tabindex="-1"])';
const terminal = record => record?.version === 1 && ['completed', 'skipped'].includes(record.status);
const visible = element => element?.isConnected && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && !element.closest('[inert]') && getComputedStyle(element).display !== 'none';
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
    };
    this.root.addEventListener('click', this.onClick);
    this.onPointer = event => {
      if (event.type === 'click' && this.step === 'create-form' && event.target.closest('[data-close-form]')) this.formCancelled = true;
      if (this.allowed(event.target)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    this.onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.finish('skipped'); return; }
      if (event.key === 'Tab') {
        event.preventDefault(); event.stopImmediatePropagation();
        const nodes = this.focusTargets();
        const index = nodes.indexOf(document.activeElement);
        const next = index < 0 ? event.shiftKey ? nodes.length - 1 : 0 : (index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length;
        nodes[next]?.focus({ preventScroll: true });
        return;
      }
      if (this.step === 'kb-menu' && this.target?.contains(event.target) && ['Enter', ' '].includes(event.key)) {
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
    return this.root?.contains(node) || this.target?.contains(node) || this.extraTargets?.some(target => target.contains(node));
  }

  focusTargets() {
    const islands = [this.target, ...(this.extraTargets || []), this.dialog].filter(Boolean);
    return [...new Set(islands.flatMap(island => [...(island.matches(focusable) ? [island] : []), ...island.querySelectorAll(focusable)]))].filter(element => visible(element) && element.tabIndex >= 0);
  }

  begin() {
    this.app.closeAllFloatingMenus();
    document.getElementById('settings-overlay')?.classList.remove('active');
    if (this.app.isMobileLayout()) this.app.closeMobileToEditor();
    const focused = this.app.getFocusedDoc();
    const doc = focused && !focused.locked && !focused.encrypted ? focused : this.app.state.docs.find(item => !item.locked && !item.encrypted);
    if (doc && !doc.locked && !doc.encrypted) { this.app.selectDoc(doc.id); this.show('write'); }
    else this.show(this.app.isMobileLayout() && !this.newDocButton() ? 'open-docs' : 'create');
  }

  newDocButton() { return first('.workspace-empty [data-action="new-doc"]', '.empty-project-card [data-action="new-doc"]', '#mobile-tab-surface.active [data-action="new-doc"]', '.sidebar [data-action="new-doc"]'); }

  description() {
    const mobile = this.app.isMobileLayout();
    const button = action => first(`button[data-action="${action}"]`);
    const steps = {
      welcome: {},
      'open-docs': { target: () => button('mobile-open-docs'), ready: () => this.app.state.mobile.activeTab === 'docs', then: 'create' },
      create: { target: () => this.newDocButton(), ready: () => !!first('#form-overlay.active #doc-form'), then: 'create-form' },
      'create-form': { target: () => first('#form-overlay.active #doc-form'), ready: () => !first('#form-overlay.active') && !!first('.page-content-prosemirror'), then: 'write' },
      write: { target: () => first('.workspace-pane.active-pane .editor-scroll-area', '.editor-scroll-area', '.page-content-prosemirror'), next: 'К заметкам' },
      'more-notes': { target: () => button('mobile-open-more'), ready: () => this.app.state.mobile.activeTab === 'more', then: 'open-notes' },
      'open-notes': { target: () => button(mobile ? 'mobile-open-notes' : 'toggle-notes'), ready: () => mobile ? this.app.state.mobile.panel === 'notes' : !!first('#notes-panel.open'), then: 'notes' },
      notes: { target: () => mobile ? first('#mobile-panel .mobile-notes-body') : first('#notes-panel.open'), next: 'К базе знаний' },
      'open-kb': { target: () => button(mobile ? 'mobile-open-lore' : 'toggle-kb-menu'), ready: () => mobile ? this.app.state.mobile.activeTab === 'lore' : this.app.isFloatingMenuOpen('kb'), then: mobile ? 'kb' : 'kb-menu' },
      'kb-menu': { target: () => first('#kb-menu.active [data-kb-open="characters"]'), ready: () => !!first('#kb-modal.active'), then: 'kb' },
      kb: { target: () => mobile ? first('#mobile-tab-surface.active', '#mobile-panel') : first('#kb-modal.active .kb-main'), next: 'К настройкам' },
      'more-settings': { target: () => button('mobile-open-more'), ready: () => this.app.state.mobile.activeTab === 'more', then: 'open-settings' },
      'open-settings': { target: () => button(mobile ? 'mobile-open-settings' : 'open-settings'), ready: () => mobile ? this.app.state.mobile.panel === 'settings' : !!first('#settings-overlay.active'), then: 'settings' },
      settings: { target: () => mobile ? first('#mobile-panel') : first('#settings-overlay.active .settings-modal'), next: 'Всё понятно' },
      done: {},
    };
    return steps[this.step];
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
    if (step === 'create-form') this.formCancelled = false;
    this.root.dataset.step = step;
    document.body.dataset.lunaStep = step;
    this.locale = getLocale();
    const description = this.description();
    this.app.animateHeightTransition(this.dialog, () => {
      this.root.querySelector('.luna-dialog-copy').innerHTML = `<p id="luna-tutorial-text">${escapeHtml(t(this.copy()))}</p>`;
      const primary = (choice, label) => `<button type="button" class="pill-btn ai-btn" data-luna-choice="${choice}">${escapeHtml(t(label))}<i class="bx bx-right-arrow-alt" aria-hidden="true"></i></button>`;
      const skip = `<button type="button" class="luna-skip" data-luna-choice="skip">${escapeHtml(t('Пропустить обучение'))}</button>`;
      this.root.querySelector('.luna-dialog-actions').innerHTML = step === 'welcome'
        ? `<button type="button" class="pill-btn" data-luna-choice="no">${escapeHtml(t('Нет'))}</button>${primary('yes', 'Да')}`
        : step === 'done' ? `${skip}${primary('done', 'Начать писать')}`
          : `${skip}${description.next ? primary('next', description.next) : ''}`;
    }, { duration: animate ? 300 : 0 });
    this.updateTarget(); this.layout();
    outgoing?.animation?.cancel();
    this.app.runMotion(this.dialog, [{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'translateY(0)' }], { channel: 'tutorial-copy', duration: 260 });
    this.changing = false;
    this.dialog.focus({ preventScroll: true });
  }

  detachTarget() {
    if (this.target) {
      this.target.removeAttribute('data-luna-target');
      if (this.targetDescription === null) this.target.removeAttribute('aria-describedby');
      else if (this.targetDescription !== undefined) this.target.setAttribute('aria-describedby', this.targetDescription);
      if (this.addedTabIndex) this.target.removeAttribute('tabindex');
    }
    this.target = null; this.extraTargets = []; this.addedTabIndex = false;
  }

  copy() {
    const mobile = this.app.isMobileLayout();
    return {
      welcome: 'Привет! Я Луна. Ты здесь впервые?',
      'open-docs': 'Нажми «Главы» внизу — там живут твои документы.',
      create: 'Нажми подсвеченную кнопку — создадим твою первую главу.',
      'create-form': 'Дай главе название и нажми «Создать». Остальное оставим на потом.',
      write: 'Это твой редактор. Просто пиши: текст сохраняется автоматически. Инструменты оформления — над страницей.',
      'more-notes': 'Нажми «Ещё» внизу — заглянем в заметки.',
      'open-notes': mobile ? 'Нажми «Заметки» — покажу, где хранить идеи.' : 'Нажми подсвеченную кнопку справа вверху — заглянем в заметки.',
      notes: 'Здесь заметки к главе и общие записи. Удобно набросать план сцены.',
      'open-kb': mobile ? 'Нажми «База» внизу — посмотрим, где хранить детали твоего мира.' : 'Нажми «База знаний» слева вверху — посмотрим, где хранить детали твоего мира.',
      'kb-menu': 'Нажми «Персонажи». Рядом — локации, таймлайн и записи о мире.',
      kb: 'Здесь живут персонажи, места и события. Добавляй их по мере работы над историей.',
      'more-settings': 'Снова нажми «Ещё» — осталось заглянуть в настройки.',
      'open-settings': mobile ? 'Нажми «Настройки» — устроим всё по твоему вкусу.' : 'Нажми шестерёнку слева вверху — устроим всё по твоему вкусу.',
      settings: 'Здесь меняются язык, тема и шрифты. А снова найти меня можно в разделе «Прочее».',
      done: 'Вот и всё. Начни с пары строк, а остальное освоишь по пути. Приятного письма!',
    }[this.step];
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
    if (this.step === 'kb-menu' && !target.hasAttribute('tabindex')) { target.tabIndex = 0; this.addedTabIndex = true; }
    if (['create', 'open-notes', 'open-settings'].includes(this.step)) target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    if (this.step === 'write') this.extraTargets = [first('.toolbar-center')].filter(Boolean);
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
    this.root.classList.toggle('luna-keyboard', mobile && height < innerHeight * .72);
    const rect = this.target?.getBoundingClientRect();
    const coachHeight = this.companion.offsetHeight;
    const margin = mobile ? 24 : Math.max(56, Math.min(112, width * .08));
    const x = left + margin;
    let y = top + height * .48 - coachHeight / 2;
    if (mobile && this.step === 'create-form') y = top + 14;
    if (mobile && this.root.classList.contains('luna-keyboard')) y = top + height - coachHeight - 12;
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
    for (const surface of document.querySelectorAll('#form-overlay, #settings-overlay, #kb-modal, #mobile-overlay')) {
      const closed = !surface.classList.contains('active');
      if (surface.inert !== closed) surface.inert = closed;
      if (surface.getAttribute('aria-hidden') !== String(closed)) surface.setAttribute('aria-hidden', String(closed));
      const dialog = surface.matches('#kb-modal') ? surface : surface.querySelector('[role="dialog"]');
      if (!closed && dialog?.getAttribute('aria-modal') === 'true') dialog.setAttribute('aria-modal', 'false');
    }
    if (!this.changing) {
      if (this.app.isMobileLayout() !== this.mobileLayout) this.adaptLayout();
      else if (getLocale() !== this.locale && !this.app.interfaceLanguage.busy) this.show(this.step);
      else {
        this.updateTarget(); this.layout();
        const description = this.description();
        if (this.step === 'create-form' && this.formCancelled && !first('#form-overlay.active')) this.show('create');
        else if (description?.ready?.()) this.show(description.then);
        if (this.step === 'open-docs' && !this.app.isMobileLayout()) this.show('create');
        if (this.step.startsWith('more-') && !this.app.isMobileLayout()) this.show(this.step === 'more-notes' ? 'open-notes' : 'open-settings');
      }
    }
    this.animationFrame = requestAnimationFrame(() => this.tick());
  }

  adaptLayout() {
    const mobile = this.mobileLayout = this.app.isMobileLayout();
    if (this.step === 'notes') {
      if (mobile) this.app.openMobilePanel('notes', 'more');
      else document.getElementById('notes-panel')?.classList.add('open');
    } else if (this.step === 'kb' || this.step === 'kb-menu') {
      if (mobile) { document.getElementById('kb-modal')?.classList.remove('active'); this.app.switchMobileTab('lore'); }
      else this.app.openKb('characters');
      this.show('kb'); return;
    } else if (this.step === 'settings') {
      if (mobile) this.app.openMobilePanel('settings', 'more');
      else this.app.openSettingsTab(this.app.state.activeSettingsTab);
    }
    const route = this.step === 'open-docs' ? 'create'
      : this.step.startsWith('more-') && !mobile ? this.step === 'more-notes' ? 'open-notes' : 'open-settings'
        : mobile && this.step === 'open-notes' ? 'more-notes'
          : mobile && this.step === 'open-settings' ? 'more-settings'
            : mobile && this.step === 'create' && !this.newDocButton() ? 'open-docs' : this.step;
    this.show(route);
  }

  next() {
    if (this.changing) return;
    this.app.blurMobileEditorFocus();
    if (this.step === 'write') this.show(this.app.isMobileLayout() ? 'more-notes' : 'open-notes');
    else if (this.step === 'notes') {
      document.getElementById('notes-panel')?.classList.remove('open');
      if (this.app.isMobileLayout()) this.app.closeMobileToEditor();
      this.show('open-kb');
    } else if (this.step === 'kb') {
      document.getElementById('kb-modal')?.classList.remove('active');
      if (this.app.isMobileLayout()) this.app.closeMobileToEditor();
      this.show(this.app.isMobileLayout() ? 'more-settings' : 'open-settings');
    } else if (this.step === 'settings') {
      document.getElementById('settings-overlay')?.classList.remove('active');
      if (this.app.isMobileLayout()) this.app.closeMobileToEditor();
      this.show('done');
    }
  }

  async finish(status) {
    if (!this.active || this.finishing) return;
    this.finishing = true;
    cancelAnimationFrame(this.animationFrame);
    this.generation = (this.generation || 0) + 1;
    this.root.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try { await this.app.db.put('settings', { id: TUTORIAL_RECORD_ID, version: 1, status, updatedAt: Date.now() }); }
    catch (error) { console.warn('Luna tutorial preference:', error); this.app.toast(t('Не удалось запомнить прохождение обучения. При следующем запуске я могу появиться снова.')); }
    await this.app.runMotion(this.root, [{ opacity: 1 }, { opacity: 0 }], { channel: 'tutorial', duration: 280 }).finished;
    this.detachTarget();
    this.root.remove();
    for (const type of ['pointerdown', 'click', 'dblclick', 'contextmenu']) document.removeEventListener(type, this.onPointer, true);
    document.removeEventListener('keydown', this.onKey, true);
    document.removeEventListener('focusin', this.onFocus, true);
    document.body.classList.remove('luna-tutorial-active');
    delete document.body.dataset.lunaStep;
    document.body.style.removeProperty('--luna-coach-space');
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
