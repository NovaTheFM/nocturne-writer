import { getLocale, setLocale, supportedLocales, loadLocalePreference, saveLocalePreference, t } from '../core/i18n.js';
import { platformFiles } from '../platform/file-adapter.js';

export const LANGUAGE_OPTIONS = [['en', 'English'], ['uk', 'Українська'], ['ru', 'Русский']];
export function languageFlag(locale) {
  const shapes = {
    ru: '<path fill="#fff" d="M0 0h28v7H0z"/><path fill="#2456a6" d="M0 7h28v6H0z"/><path fill="#df3c43" d="M0 13h28v7H0z"/>',
    uk: '<path fill="#1976d2" d="M0 0h28v10H0z"/><path fill="#ffda44" d="M0 10h28v10H0z"/>',
    en: '<path fill="#233c78" d="M0 0h28v20H0z"/><path stroke="#fff" stroke-width="5" d="m0 0 28 20M28 0 0 20"/><path stroke="#d94150" stroke-width="2" d="m0 0 28 20M28 0 0 20"/><path stroke="#fff" stroke-width="7" d="M14 0v20M0 10h28"/><path stroke="#d94150" stroke-width="4" d="M14 0v20M0 10h28"/>',
  };
  return `<svg class="language-flag" viewBox="0 0 28 20" aria-hidden="true" focusable="false">${shapes[locale] || ''}</svg>`;
}
const frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

export class InterfaceLanguage {
  constructor(app) { this.app = app; this.confirmed = false; this.busy = false; }

  async load() {
    const preference = await loadLocalePreference(this.app.db);
    setLocale(preference.locale);
    this.confirmed = preference.confirmed;
    await this.applyDocumentLocale(preference.locale);
  }

  async applyDocumentLocale(value) {
    document.documentElement.lang = value;
    for (const element of document.querySelectorAll('[data-i18n-title]')) { element.title = t(element.dataset.i18nTitle); element.setAttribute('aria-label', element.title); }
    for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
    await platformFiles.setInterfaceLanguage(value);
  }

  async welcomeIfNeeded() {
    if (this.confirmed) return;
    const overlay = document.createElement('div');
    overlay.id = 'language-onboarding';
    overlay.className = 'language-onboarding';
    overlay.lang = 'en';
    overlay.innerHTML = `<section class="language-welcome" role="dialog" aria-modal="true" aria-labelledby="language-welcome-title" tabindex="-1">
      <div class="language-brand" aria-hidden="true"><span class="brand-logo-img"></span> NOCTURNE</div>
      <h1 id="language-welcome-title">Choose your language</h1>
      <div class="language-choices" role="radiogroup" aria-labelledby="language-welcome-title">${LANGUAGE_OPTIONS.map(([code, name]) => `<button type="button" class="language-choice ${code === 'en' ? 'selected' : ''}" role="radio" aria-checked="${code === 'en'}" tabindex="${code === 'en' ? '0' : '-1'}" data-choose-language="${code}" lang="${code}">${languageFlag(code)}<span>${name}</span><span class="language-choice-check" aria-hidden="true"><i class="bx bx-check"></i></span></button>`).join('')}</div>
      <div class="form-actions"><button type="button" class="pill-btn ai-btn language-confirm" data-confirm-language>Confirm<i class="bx bx-right-arrow-alt" aria-hidden="true"></i></button></div>
      <p class="language-choice-error" role="alert" hidden></p>
    </section>`;
    const roots = [...document.body.children].filter(element => !['SCRIPT', 'STYLE', 'LINK'].includes(element.tagName));
    const previous = roots.map(element => [element, element.inert]);
    for (const [element] of previous) element.inert = true;
    document.body.appendChild(overlay);
    await frame(); overlay.classList.add('active');
    overlay.querySelector('.language-welcome')?.focus({ preventScroll: true });
    let selected = 'en';
    const select = (code, focus = false) => {
      selected = code;
      for (const button of overlay.querySelectorAll('[data-choose-language]')) {
        const active = button.dataset.chooseLanguage === code;
        button.classList.toggle('selected', active);
        button.setAttribute('aria-checked', String(active));
        button.tabIndex = active ? 0 : -1;
        if (active && focus) button.focus();
      }
    };
    const trap = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); }
      if (event.target.matches('[data-choose-language]') && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) && !this.busy) {
        event.preventDefault();
        const index = LANGUAGE_OPTIONS.findIndex(([code]) => code === selected);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (['ArrowUp', 'ArrowLeft'].includes(event.key) ? 2 : 1)) % 3;
        select(LANGUAGE_OPTIONS[next][0], true);
      }
      if (event.key !== 'Tab') return;
      const buttons = [...overlay.querySelectorAll('button:not(:disabled):not([tabindex="-1"])')];
      if (!buttons.length) { event.preventDefault(); return; }
      const index = buttons.indexOf(document.activeElement);
      if (event.shiftKey && index <= 0) { event.preventDefault(); buttons.at(-1).focus(); }
      else if (!event.shiftKey && (index < 0 || index === buttons.length - 1)) { event.preventDefault(); buttons[0].focus(); }
    };
    document.addEventListener('keydown', trap, true);
    await new Promise(resolve => {
      overlay.addEventListener('click', async event => {
        const button = event.target.closest('[data-choose-language]');
        if (this.busy) return;
        if (button) { select(button.dataset.chooseLanguage); return; }
        if (!event.target.closest('[data-confirm-language]')) return;
        overlay.querySelectorAll('button').forEach(item => { item.disabled = true; });
        overlay.querySelector('[role="alert"]').hidden = true;
        try {
          await this.change(selected, { welcome: true });
          overlay.classList.add('leaving');
          await this.animate(overlay, [{ backdropFilter: 'blur(28px) saturate(.55)', backgroundColor: getComputedStyle(overlay).backgroundColor }, { backdropFilter: 'blur(0px) saturate(1)', backgroundColor: 'rgba(6,6,9,0)' }], 750);
          overlay.remove(); document.removeEventListener('keydown', trap, true);
          for (const [element, inert] of previous) if (element.isConnected) element.inert = inert;
          this.app.disposeModalFocus?.();
          this.app.installModalFocus();
          resolve();
        } catch (error) {
          const alert = overlay.querySelector('[role="alert"]');
          alert.hidden = false; alert.textContent = t('Не удалось сохранить выбор языка. Попробуйте ещё раз.', 'en');
          overlay.querySelectorAll('button').forEach(item => { item.disabled = false; });
          overlay.querySelector('[data-confirm-language]').focus();
        }
      });
    });
  }

  async animate(element, frames, duration) {
    const motion = this.app.runMotion(element, frames, { channel: 'language', duration, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: 'forwards' });
    await motion?.finished?.catch(() => {});
    Object.assign(element.style, frames.at(-1));
    motion?.animation?.cancel();
  }

  async change(value, { welcome = false } = {}) {
    if (!supportedLocales.includes(value) || this.busy) return false;
    if (value === getLocale() && this.confirmed) return true;
    this.busy = true;
    let cover;
    const before = getLocale();
    const wasConfirmed = this.confirmed;
    const appRoot = document.getElementById('app'), wasInert = appRoot.inert;
    let preferenceSaved = false;
    try {
      if (!welcome) {
        cover = document.getElementById('preloader').cloneNode(true);
        cover.id = 'language-preloader';
        cover.className = 'language-preloader';
        cover.lang = value;
        cover.setAttribute('role', 'status');
        cover.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
        const subtitle = cover.querySelector('.preloader-subtitle');
        subtitle.removeAttribute('data-i18n');
        subtitle.textContent = t('Применяем язык интерфейса…', value);
        const progress = cover.querySelector('.preloader-progress-fill');
        progress.style.width = '0%'; progress.style.transition = 'none';
        document.body.appendChild(cover);
        appRoot.inert = true;
        await Promise.all([
          this.animate(cover, [{ opacity: 0 }, { opacity: 1 }], 600),
          this.animate(progress, [{ width: '0%' }, { width: '65%' }], 600),
        ]);
      }
      // The editor stays mounted: no reload, schema migration or manuscript rewrite is involved.
      await saveLocalePreference(this.app.db, value);
      preferenceSaved = true;
      setLocale(value);
      await this.applyDocumentLocale(value);
      this.confirmed = true;
      this.app.refreshLocalizedInterface();
      await document.fonts.ready;
      await frame();
      const transitions = appRoot.getAnimations({ subtree: true }).filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime));
      let timeout;
      const settle = Promise.race([Promise.allSettled(transitions.map(animation => animation.finished)), new Promise(resolve => { timeout = setTimeout(resolve, 1000); })]);
      await Promise.all([settle, cover ? this.animate(cover.querySelector('.preloader-progress-fill'), [{ width: '65%' }, { width: '100%' }], 350) : Promise.resolve()]);
      clearTimeout(timeout);
      if (cover) await this.animate(cover, [{ opacity: 1 }, { opacity: 0 }], 750);
      return true;
    } catch (error) {
      setLocale(before); document.documentElement.lang = before;
      this.confirmed = wasConfirmed;
      if (preferenceSaved) {
        await this.app.db.put('settings', { id: 'interface-language', locale: before, confirmed: wasConfirmed }).catch(() => {});
        await this.applyDocumentLocale(before).catch(() => {});
      }
      throw error;
    } finally {
      cover?.remove(); this.busy = false;
      if (!welcome) {
        appRoot.inert = wasInert;
        const root = this.app.isMobileLayout() ? document.getElementById('mobile-panel') : document.getElementById('settings-overlay');
        root?.querySelector('[data-setting-select="interfaceLanguage"] button')?.focus({ preventScroll: true });
      }
    }
  }
}
