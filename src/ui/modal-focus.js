import { t, ui, msg } from '../core/i18n.js';
export function manageModalFocus({ onOverlayClose } = {}) {
  let active = null;
  let activeModal = null;
  let previousFocus = null;
  let restoreFocus = true;
  const skipRestore = () => { if (active) restoreFocus = false; };
  document.addEventListener('nocturne:skip-modal-focus-restore', skipRestore);
  const focusables = modal => {
    const ownedMenus = [...document.querySelectorAll('.portal-floating-menu.active')].filter(menu => [...modal.querySelectorAll('[aria-controls]')].some(anchor => anchor.getAttribute('aria-controls') === menu.id));
    return [modal, ...ownedMenus].flatMap(root => [...root.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"], [contenteditable="true"]')]).filter(element => !element.disabled && !element.closest('[inert]') && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  };
  const update = () => {
    for (const button of document.querySelectorAll('[data-settings-tab], [data-kb-tab], .kb-close-btn, .kb-project-switcher, .kb-project-item, .kb-project-action')) {
      button.setAttribute('role', 'button'); button.tabIndex = 0;
      if (button.classList.contains('kb-close-btn')) button.setAttribute('aria-label', t('Вернуться к рукописи'));
    }
    for (const toggle of document.querySelectorAll('[data-kind="toggle"]')) {
      toggle.setAttribute('role', 'switch'); toggle.tabIndex = 0; toggle.setAttribute('aria-checked', String(toggle.classList.contains('on') || toggle.classList.contains('active')));
      if (!toggle.hasAttribute('aria-label')) toggle.setAttribute('aria-label', (toggle.tagName === 'BUTTON' ? toggle.textContent.trim() : '') || toggle.closest('.setting-row')?.querySelector('.setting-info strong, .setting-info > span')?.textContent || toggle.closest('.dictionary-toggle')?.querySelector('span')?.textContent || toggle.closest('.ai-context-head')?.querySelector('strong')?.textContent || t('Переключатель'));
    }
    const surfaces = [...document.querySelectorAll('#form-overlay, #settings-overlay, #kb-modal, #mobile-overlay, .floating-notes-modal, .command-palette-overlay')];
    const overlays = surfaces.filter(element => element.classList.contains('active'));
    const overlay = overlays.sort((a, b) => (Number(getComputedStyle(a).zIndex) || 0) - (Number(getComputedStyle(b).zIndex) || 0)).at(-1);
    const modal = overlay?.id === 'kb-modal' ? overlay : overlay?.querySelector('.form-modal, .settings-modal, .kb-modal-dialog, [role="dialog"]') || overlay?.firstElementChild || overlay;
    const changed = overlay !== active || modal !== activeModal;
    if (changed && active) {
      for (const element of document.querySelectorAll('[data-modal-inert]')) { element.inert = false; delete element.dataset.modalInert; }
    }
    for (const surface of surfaces) {
      const closed = !surface.classList.contains('active');
      surface.inert = closed || surface.hasAttribute('data-modal-inert');
      surface.setAttribute('aria-hidden', String(closed));
      if (closed) {
        const openSelect = surface.querySelector('.nocturne-select.open, .nocturne-select-menu.select-exiting');
        const nativePopover = [...surface.querySelectorAll('.nocturne-select-menu[popover]')].some(menu => typeof menu.hidePopover === 'function' && menu.matches(':popover-open'));
        if (openSelect || nativePopover) onOverlayClose?.(surface);
      }
    }
    if (!changed) return;
    const focusWithinModal = modal?.contains(document.activeElement);
    active = overlay || null;
    activeModal = modal || null;
    if (!active) { if (restoreFocus) previousFocus?.focus?.({ preventScroll: true }); previousFocus = null; restoreFocus = true; return; }
    previousFocus ||= document.activeElement;
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const title = modal.querySelector('h1,h2,h3');
    if (title) { title.id ||= `modal-title-${active.id || 'command'}`; modal.setAttribute('aria-labelledby', title.id); }
    for (const button of modal.querySelectorAll('button')) {
      if (!button.textContent.trim() && !button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title || (button.querySelector('.bx-x') ? t('Закрыть') : t('Действие')));
    }
    for (const input of modal.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
      if (!input.labels?.length && !input.hasAttribute('aria-label')) input.setAttribute('aria-label', input.closest('.setting-row')?.querySelector('.setting-info strong, .setting-info > span')?.textContent || input.placeholder || input.name || t('Поле ввода'));
    }
    for (const element of document.querySelectorAll('#app, .main-workspace, .sidebar, .toolbar, .mobile-bottom-nav, .mobile-topbar, .mobile-system-bar, .mobile-tab-surface, #mobile-overlay, .floating-notes-modal')) {
      if (!element.contains(active) && !active.contains(element)) { element.inert = true; element.dataset.modalInert = 'true'; }
    }
    modal.tabIndex = -1;
    const initial = overlay.id === 'mobile-overlay' ? null : modal.querySelector('[autofocus], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, .nocturne-select-trigger');
    (focusWithinModal ? document.activeElement : initial || modal).focus({ preventScroll: true });
  };
  const observer = new MutationObserver(update);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  const onKeydown = event => {
    if ([' ', 'Enter'].includes(event.key) && event.target.matches('[role="switch"], [role="button"]:not(button)')) { event.preventDefault(); event.target.click(); return; }
    if (event.key !== 'Tab' || !active) return;
    const list = focusables(active);
    if (!list.length) { event.preventDefault(); return; }
    const index = list.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); list.at(-1).focus(); }
    else if (!event.shiftKey && (index < 0 || index === list.length - 1)) { event.preventDefault(); list[0].focus(); }
  };
  document.addEventListener('keydown', onKeydown, true);
  update();
  return () => {
    observer.disconnect();
    document.removeEventListener('nocturne:skip-modal-focus-restore', skipRestore);
    document.removeEventListener('keydown', onKeydown, true);
    for (const element of document.querySelectorAll('[data-modal-inert]')) { element.inert = false; delete element.dataset.modalInert; }
  };
}
