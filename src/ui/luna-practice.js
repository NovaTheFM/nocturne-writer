import { getLocale, t } from '../core/i18n.js';
import { tutorialContext, notifyTutorialParent } from '../core/tutorial-context.js';

const visualSettings = ['theme', 'accent', 'fontFamily', 'uiFontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent', 'customFonts', 'compactPanels', 'compactKbSidebar', 'compactToolbar', 'compactSettings', 'compactNotes', 'cardView', 'cursorGlow', 'reduceMobileAnimations', 'autoPaginate', 'showPageRulers', 'showZenButton', 'caretStyle', 'caretBlink', 'caretBreath', 'textContrast', 'writingAnimation'];

export class LunaPractice {
  constructor(tour) { this.tour = tour; this.app = tour.app; }

  needed() {
    return !tutorialContext && (this.app.startupInteractionReady || this.app.state.docs.length > 0 || ['characters', 'locations', 'timeline', 'notes'].some(key => this.app.state.lore[key]?.length));
  }

  prepare() {
    if (this.ready) return this.ready;
    this.ready = new Promise(resolve => { this.resolveReady = resolve; });
    this.session = crypto.randomUUID();
    this.host = document.createElement('div'); this.host.className = 'luna-practice-host';
    this.frame = document.createElement('iframe');
    this.frame.setAttribute('data-luna-practice', ''); this.frame.title = t('Обучение с Луной');
    this.frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    this.frame.name = JSON.stringify({ kind: 'nocturne-tutorial', version: 1, session: this.session, locale: getLocale(), settings: Object.fromEntries(visualSettings.filter(key => key in this.app.state.settings).map(key => [key, this.app.state.settings[key]])) });
    this.frame.src = new URL('index.html', document.baseURI).href;
    const loading = document.getElementById('preloader').cloneNode(true);
    loading.removeAttribute('id'); loading.className = 'luna-practice-loading';
    loading.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    loading.querySelector('.preloader-progress-fill').style.width = '65%';
    const close = document.createElement('button'); close.type = 'button'; close.className = 'pill-btn luna-practice-close'; close.setAttribute('aria-label', t('Пропустить обучение')); close.innerHTML = '<i class="bx bx-x" aria-hidden="true"></i>';
    close.onclick = () => this.finish('skipped');
    this.host.append(this.frame, loading, close);
    this.onMessage = async event => {
      if (event.source !== this.frame?.contentWindow || event.data?.session !== this.session) return;
      if (event.data.type === 'luna-practice-ready') { this.loaded = true; this.resolveReady(); this.retry?.remove(); }
      else if (event.data.type === 'luna-practice-visible') {
        this.host.classList.add('is-ready');
        this.frame.contentWindow?.focus();
      } else if (event.data.type === 'luna-practice-finished') await this.finish(event.data.status);
      else if (event.data.type === 'luna-practice-load-error' && !this.opened) {
        this.retry ||= document.createElement('button'); this.retry.className = 'luna-startup-retry pill-btn'; this.retry.textContent = t('Повторить загрузку Луны');
        this.retry.onclick = () => this.send('luna-practice-retry');
        document.querySelector('#preloader .preloader-content')?.append(this.retry);
      }
    };
    window.addEventListener('message', this.onMessage);
    document.body.append(this.host);
    return this.ready;
  }

  send(type, detail = {}) { this.frame?.contentWindow?.postMessage({ type, session: this.session, ...detail }, '*'); }

  start() {
    const tour = this.tour;
    tour.active = true; tour.finishing = false;
    tour.completion = new Promise(resolve => { tour.resolve = resolve; });
    tour.previousFocus = document.activeElement;
    this.app.disposeModalFocus?.();
    const ready = this.prepare();
    this.previousInert = [...document.body.children].filter(element => element !== this.host && !['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName)).map(element => [element, element.inert]);
    for (const [element] of this.previousInert) element.inert = true;
    this.host.classList.add('is-open'); this.opened = true;
    this.app.runMotion(this.host, [{ opacity: 0 }, { opacity: 1 }], { channel: 'tutorial', duration: 420 });
    this.onKey = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.finish('skipped'); } };
    document.addEventListener('keydown', this.onKey, true);
    ready.then(() => { if (this.opened) this.send('luna-practice-show', { locale: getLocale() }); });
    return tour.completion;
  }

  async finish(status) {
    const tour = this.tour;
    if (!this.opened || tour.finishing) return;
    tour.finishing = true; this.opened = false;
    this.send('luna-practice-stop');
    await this.app.runMotion(this.host, [{ opacity: 1 }, { opacity: 0 }], { channel: 'tutorial', duration: 360, fill: 'forwards' }).finished;
    this.host.remove(); this.retry?.remove();
    window.removeEventListener('message', this.onMessage); document.removeEventListener('keydown', this.onKey, true);
    for (const [element, inert] of this.previousInert || []) if (element.isConnected) element.inert = inert;
    this.ready = null; this.host = null; this.frame = null; this.loaded = false;
    try { await this.app.db.put('settings', { id: 'luna-tutorial', version: 1, status, updatedAt: Date.now() }); }
    catch (error) { console.warn('Luna tutorial preference:', error); }
    tour.active = false; tour.finishing = false;
    this.app.installModalFocus();
    if (tour.previousFocus?.isConnected) tour.previousFocus.focus({ preventScroll: true });
    tour.resolve(status);
    if (this.app.startupInteractionReady) this.app.openPendingNativeFiles().catch(error => console.warn('Pending native files:', error));
  }
}

export function bindPracticeChild(tour) {
  if (!tutorialContext) return;
  window.addEventListener('message', async event => {
    if (event.source !== window.parent || event.data?.session !== tutorialContext.session) return;
    const { type } = event.data;
    if (type === 'luna-practice-show') {
      await tour.app.interfaceLanguage.change(event.data.locale, { welcome: true });
      await tour.show(tour.step);
      tour.mascot.rig?.setSuspended('practice-hidden', false);
      notifyTutorialParent('luna-practice-visible');
    } else if (type === 'luna-practice-retry') tour.preparedMascot?.enqueue();
    else if (type === 'luna-practice-stop') tour.mascot?.destroy();
  });
}
