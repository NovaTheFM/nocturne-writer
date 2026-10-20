import { t, getLocale } from '../core/i18n.js';
import { escapeHtml } from '../core/utils.js';
import { lunaTutorialSteps, lunaTutorialCopy } from './luna-tutorial-steps.js';
import { LunaMascot } from './luna-mascot.js';

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
    this.highlight = { target: null, phase: 'hidden', opacity: 0, startedAt: 0 };
    this.placement = null; this.pendingForm = null; this.reservedSurface = null; this.settingsAside = false;
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
        <div class="luna-mascot" data-luna-mascot><canvas tabindex="0" role="button" aria-label="${escapeHtml(t('Луна'))}"></canvas><button type="button" class="luna-rig-retry" hidden></button></div>
        <section class="luna-dialog" role="dialog" aria-modal="false" aria-label="${escapeHtml(t('Луна'))}" aria-describedby="luna-tutorial-text" tabindex="-1">
          <div class="luna-dialog-body">
            <div class="luna-dialog-copy" aria-live="polite" aria-atomic="true"></div>
            <div class="luna-progress" role="progressbar" aria-label="${escapeHtml(t('Прогресс обучения'))}" aria-valuemin="1"><span></span></div>
            <footer class="luna-dialog-actions"></footer>
          </div>
        </section>
        <div class="luna-dialog-tail" aria-hidden="true"></div>
      </div>`;
    document.body.append(this.root);
    document.body.classList.add('luna-tutorial-active');
    this.dialog = this.root.querySelector('.luna-dialog');
    this.dialogBody = this.root.querySelector('.luna-dialog-body');
    this.companion = this.root.querySelector('.luna-companion');
    this.cutout = this.root.querySelector('.luna-cutout');
    this.spotlight = this.root.querySelector('.luna-spotlight');
    this.mascot = new LunaMascot(this);
    this.onClick = event => {
      const choice = event.target.closest('[data-luna-choice]')?.dataset.lunaChoice;
      if (!choice || this.finishing) return;
      if (choice === 'no' || choice === 'skip') { this.finish('skipped'); return; }
      if (choice === 'done') { this.finish('completed'); return; }
      if (choice === 'yes' && this.step === 'welcome') { this.begin(); return; }
      if (this.changing) return;
      if (choice === 'yes') this.begin();
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
    const islands = [this.description()?.interactive !== false ? this.target : null, ...(this.extraTargets || []), this.dialog, this.mascot?.host].filter(Boolean);
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

  canShowSettingsAside() { return !this.app.isMobileLayout() && innerWidth >= 1280; }

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
    this.mascot.stopSpeaking();
    const generation = this.generation = (this.generation || 0) + 1;
    if (step === 'settings' && this.step === 'settings-apology' && this.canShowSettingsAside() && !this.settingsAside) await this.moveSettingsAside();
    if (!this.active || this.finishing || generation !== this.generation) return;
    this.detachTarget();
    const outgoing = animate && this.app.runMotion(this.dialogBody, [{ opacity: 1 }, { opacity: 0 }], { channel: 'tutorial-copy', duration: 140, fill: 'forwards' });
    if (outgoing) await outgoing.finished;
    if (!this.active || this.finishing || generation !== this.generation) return;
    if (step === 'settings' && this.step !== 'settings-apology' && this.canShowSettingsAside() && !this.settingsAside) step = 'settings-apology';
    this.step = step;
    this.stepStartedAt = performance.now();
    if (step === 'focus' && this.app.isMobileLayout()) this.app.closeMobileToEditor();
    if (step === 'create-form') this.formCancelled = false;
    this.root.dataset.step = step;
    document.body.dataset.lunaStep = step;
    this.locale = getLocale();
    const description = this.description();
    this.dialog.setAttribute('aria-label', t('Луна'));
    if (description.topic && this.visitedTopics.at(-1) !== description.topic) this.visitedTopics.push(description.topic);
    this.app.animateHeightTransition(this.dialog, () => {
      const copy = t(this.copy());
      const letters = typeof Intl.Segmenter === 'function' ? [...new Intl.Segmenter(getLocale(), { granularity: 'grapheme' }).segment(copy)].map(item => item.segment) : Array.from(copy);
      const interval = Math.min(14, 700 / Math.max(1, letters.length - 1));
      this.mascot.speak(Math.max(700, (letters.length - 1) * interval + 220));
      this.root.querySelector('.luna-dialog-copy').innerHTML = `<p id="luna-tutorial-text"><span class="luna-screen-reader">${escapeHtml(copy)}</span><span aria-hidden="true">${letters.map((letter, index) => `<span class="luna-letter" style="--luna-letter-delay:${index * interval}ms">${escapeHtml(letter)}</span>`).join('')}</span></p>`;
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
    await this.app.runMotion(this.dialogBody, [{ opacity: 0 }, { opacity: 1 }], { channel: 'tutorial-copy', duration: 280 }).finished;
    await this.placementMotion?.finished;
    if (!this.active || this.finishing || generation !== this.generation) return;
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
    progress.hidden = ['welcome', 'create', 'create-form', 'open-docs', 'done'].includes(this.step);
    const value = this.step === 'done' ? topics.length : Math.max(1, topics.indexOf(current) + 1);
    progress.setAttribute('aria-valuemax', topics.length);
    progress.setAttribute('aria-valuenow', value);
    progress.innerHTML = `<span>${value}</span><span aria-hidden="true"> / </span><span>${topics.length}</span>`;
  }

  async prepareDocumentForm(form) {
    this.pendingForm = form;
    await this.show('create-form');
    await frame();
    await this.placementMotion?.finished;
    if (this.finishing) await this.completion;
    this.pendingForm = null;
    return form?.isConnected;
  }

  async moveSettingsAside() {
    const overlay = document.getElementById('settings-overlay'), panel = overlay?.querySelector('.settings-modal');
    if (!panel || !overlay.classList.contains('active')) return;
    this.settingsAside = true;
    this.app.animateLayoutTransition(overlay, () => {
      document.body.classList.add('luna-settings-aside');
    }, { targets: [panel], duration: .56 });
    await frame();
    while (this.active && !this.finishing && panel.classList.contains('is-flipping')) await frame();
  }

  modalSurface() {
    if (this.pendingForm?.isConnected) return this.pendingForm;
    const overlay = document.getElementById('form-overlay');
    if (overlay && (overlay.classList.contains('active') || Number(getComputedStyle(overlay).opacity) > .01)) return overlay.querySelector('.form-modal');
    return first('#floating-notes-modal.active .floating-notes-modal-panel') || (!this.canShowSettingsAside() ? first('#settings-overlay.active .settings-modal') : null);
  }

  surfaceRect(surface) {
    const parent = surface.offsetParent;
    const origin = parent?.getBoundingClientRect() || { left: 0, top: 0 };
    return { left: origin.left + surface.offsetLeft, top: origin.top + surface.offsetTop, right: origin.left + surface.offsetLeft + surface.offsetWidth, bottom: origin.top + surface.offsetTop + surface.offsetHeight };
  }

  placeCompanion(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (this.placement?.x === x && this.placement?.y === y) return;
    const previous = this.placement && this.companion.getBoundingClientRect();
    this.placement = { x, y };
    this.companion.style.left = `${x}px`; this.companion.style.top = `${y}px`;
    if (previous) this.placementMotion = this.app.runMotion(this.companion, [{ transform: `translate(${previous.left - x}px, ${previous.top - y}px)` }, { transform: 'translate(0, 0)' }], { channel: 'tutorial-placement', duration: 440, startFromCurrent: false });
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
    this.mascot.syncMotion();
    this.root.classList.toggle('luna-keyboard', mobile && height < innerHeight * .72);
    const rect = this.target?.getBoundingClientRect();
    const coachHeight = Math.max(this.root.querySelector('.luna-mascot').offsetHeight, this.dialog.__surfaceSizeTransition?.targetHeight || this.dialog.offsetHeight) + (parseFloat(getComputedStyle(this.companion).paddingBottom) || 0);
    const margin = mobile ? 24 : Math.max(56, Math.min(112, width * .08));
    const settingsLeft = `${margin + this.companion.offsetWidth + 32}px`;
    if (document.body.style.getPropertyValue('--luna-settings-left') !== settingsLeft) document.body.style.setProperty('--luna-settings-left', settingsLeft);
    let x = left + margin;
    let y = top + height * .48 - coachHeight / 2;
    const surface = this.modalSurface();
    if (this.reservedSurface !== surface) {
      this.reservedSurface?.classList.remove('luna-reserved-surface');
      this.reservedSurface?.style.removeProperty('--luna-surface-height');
      document.body.classList.remove('luna-stack-modal');
      this.reservedSurface = surface;
    }
    if (surface) {
      const coachWidth = this.companion.offsetWidth, gap = 24;
      const reserveHeight = () => {
        const available = height - 2 * (coachHeight + gap + 14);
        const stacked = available < 160;
        document.body.classList.toggle('luna-stack-modal', stacked);
        surface.classList.add('luna-reserved-surface');
        surface.style.setProperty('--luna-surface-height', `${Math.max(96, stacked ? height - coachHeight - gap - 28 : available)}px`);
        return stacked;
      };
      if (surface.classList.contains('luna-reserved-surface')) reserveHeight();
      const choose = box => {
        const clear = (px, py) => px + coachWidth <= box.left - gap || px >= box.right + gap || py + coachHeight <= box.top - gap || py >= box.bottom + gap;
        if (clear(x, y)) return { x, y };
        return [{ x: box.left - coachWidth - gap, y }, { x, y: box.top - coachHeight - gap }, { x: box.right + gap, y }, { x, y: box.bottom + gap }]
          .filter(point => point.x >= left + 24 && point.x + coachWidth <= left + width - 24 && point.y >= top + 14 && point.y + coachHeight <= top + height - 14)
          .sort((a, b) => Math.hypot(a.x - x, a.y - y) - Math.hypot(b.x - x, b.y - y))[0];
      };
      let position = choose(this.surfaceRect(surface));
      if (!position) {
        const stacked = reserveHeight();
        position = stacked ? { x, y: top + 14 } : choose(this.surfaceRect(surface));
      }
      if (position) { x = position.x; y = position.y; }
    } else if (mobile && this.root.classList.contains('luna-keyboard')) y = top + height - coachHeight - 12;
    if (!surface && rect && rect.height < 200 && x < rect.right + 12 && x + this.companion.offsetWidth > rect.left - 12 && y < rect.bottom + 12 && y + coachHeight > rect.top - 12) {
      const alternatives = [rect.top - coachHeight - 24, rect.bottom + 24].filter(value => value >= top + 14 && value + coachHeight <= top + height - 14);
      if (alternatives.length) y = alternatives.sort((a, b) => Math.abs(a - y) - Math.abs(b - y))[0];
    }
    const content = this.description()?.avoid?.()?.getBoundingClientRect();
    if (!surface && content && x < content.right + 24 && x + this.companion.offsetWidth > content.left - 24 && y < content.bottom + 24 && y + coachHeight > content.top - 24) {
      const below = content.bottom + 24, above = content.top - coachHeight - 24;
      if (below + coachHeight <= top + height - 14) y = below;
      else if (above >= top + 14) y = above;
      else if (content.right + 24 + this.companion.offsetWidth <= left + width - 24) x = content.right + 24;
    }
    this.placeCompanion(Math.max(left + 24, x), Math.max(top + 14, y));
    const reserve = `${coachHeight + (mobile ? 28 : 48)}px`;
    if (document.body.style.getPropertyValue('--luna-coach-space') !== reserve) document.body.style.setProperty('--luna-coach-space', reserve);
    this.updateSpotlight(rect, { top, left, width, height });
  }

  updateSpotlight(rect, viewport) {
    const state = this.highlight, now = performance.now();
    const action = this.description()?.then && rect?.height <= 128;
    const padding = action ? 3 : 6;
    const x = Math.max(viewport.left + 5, (rect?.left || 0) - padding), y = Math.max(viewport.top + 5, (rect?.top || 0) - padding);
    const width = Math.min(viewport.left + viewport.width - 5, (rect?.right || 0) + padding) - x;
    const height = Math.min(viewport.top + viewport.height - 5, (rect?.bottom || 0) + padding) - y;
    const desired = rect && width > 0 && height > 0 ? this.target : null;
    if (this.app.shouldReduceSurfaceMotion()) {
      state.target = desired; state.phase = desired ? 'visible' : 'hidden'; state.opacity = desired ? 1 : 0;
    } else {
      if (state.target !== desired && state.phase !== 'out') {
        state.startedAt = now;
        if (state.opacity > 0) { state.phase = 'out'; state.from = state.opacity; }
        else { state.target = desired; state.phase = desired ? 'in' : 'hidden'; }
      }
      const progress = Math.min(1, (now - state.startedAt) / (state.phase === 'out' ? 180 : 280));
      const eased = .5 - Math.cos(Math.PI * progress) / 2;
      if (state.phase === 'out') {
        state.opacity = state.from * (1 - eased);
        if (progress === 1) { state.target = desired; state.phase = desired ? 'in' : 'hidden'; state.opacity = 0; state.startedAt = now; }
      } else if (state.phase === 'in') {
        state.opacity = eased;
        if (progress === 1) state.phase = 'visible';
      }
    }
    // Keep the old aperture still until it has faded; never sweep it across unrelated controls.
    if (desired && state.target === desired && state.phase !== 'out') {
      state.bounds = { x, y, width, height };
      state.kind = action ? 'action' : 'panel';
      state.radius = Math.min((rect.height + padding * 2) / 2, Math.max(6, (parseFloat(getComputedStyle(desired).borderTopLeftRadius) || 8) + padding));
    }
    if (state.bounds) {
      for (const [key, value] of Object.entries(state.bounds)) this.cutout.setAttribute(key, value);
      this.cutout.setAttribute('rx', state.radius);
      Object.assign(this.spotlight.style, { left: `${state.bounds.x}px`, top: `${state.bounds.y}px`, width: `${state.bounds.width}px`, height: `${state.bounds.height}px`, borderRadius: `${state.radius}px` });
      this.spotlight.dataset.kind = state.kind;
    }
    this.spotlight.hidden = !state.bounds;
    this.spotlight.style.opacity = state.opacity;
    this.cutout.style.opacity = state.opacity;
    this.root.classList.toggle('luna-overview', !!desired && !this.description()?.then);
  }

  tick() {
    if (!this.active || this.finishing) return;
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
        this.updateTarget();
        const description = this.description();
        if (this.step === 'create-form' && this.formCancelled && !first('#form-overlay.active')) this.show('create');
        else if (description?.ready?.()) this.show(description.then);
        if (this.description()?.topic === 'split' && !this.canShowSplit()) this.reviewTopic('search').catch(error => { this.changing = false; this.app.toast(error.message); });
      }
    }
    this.layout();
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
      document.body.classList.remove('luna-stack-modal', 'luna-tutorial-active', 'luna-settings-aside');
      this.reservedSurface?.classList.remove('luna-reserved-surface');
      this.reservedSurface?.style.removeProperty('--luna-surface-height');
      delete document.body.dataset.lunaStep;
      document.body.style.removeProperty('--luna-preview-left');
      document.body.style.removeProperty('--luna-coach-space');
      document.body.style.removeProperty('--luna-settings-left');
    };
    const overlay = document.getElementById('form-overlay');
    const settings = document.getElementById('settings-overlay');
    if (settings?.classList.contains('active') && this.settingsAside) this.app.animateLayoutTransition(settings, update, { targets: [...settings.querySelectorAll('.settings-modal')], duration: .5 });
    else if (overlay?.classList.contains('active') && this.reservedSurface) this.app.animateLayoutTransition(overlay, update, { targets: [...overlay.querySelectorAll(':scope > .form-modal')], duration: .34 });
    else update();
  }

  async finish(status) {
    if (!this.active || this.finishing) return;
    this.finishing = true;
    this.mascot.stopSpeaking();
    cancelAnimationFrame(this.animationFrame);
    this.generation = (this.generation || 0) + 1;
    this.root.querySelectorAll('button').forEach(button => { button.disabled = true; });
    this.restoreView();
    try { await this.app.db.put('settings', { id: TUTORIAL_RECORD_ID, version: 1, status, updatedAt: Date.now() }); }
    catch (error) { console.warn('Luna tutorial preference:', error); this.app.toast(t('Не удалось запомнить прохождение обучения. При следующем запуске я могу появиться снова.')); }
    await this.app.runMotion(this.root, [{ opacity: 1 }, { opacity: 0 }], { channel: 'tutorial', duration: 280 }).finished;
    this.detachTarget();
    this.root.remove();
    this.mascot.destroy();
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
