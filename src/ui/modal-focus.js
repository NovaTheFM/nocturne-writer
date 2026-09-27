export function manageModalFocus() {
  let active = null;
  let activeModal = null;
  let previousFocus = null;
  const focusables = modal => [...modal.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"], [contenteditable="true"]')].filter(element => !element.disabled && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const update = () => {
    for (const button of document.querySelectorAll('[data-settings-tab], [data-kb-tab], .kb-close-btn, .kb-project-switcher, .kb-project-item, .kb-project-action')) {
      button.setAttribute('role', 'button'); button.tabIndex = 0;
      if (button.classList.contains('kb-close-btn')) button.setAttribute('aria-label', 'Вернуться к рукописи');
    }
    for (const toggle of document.querySelectorAll('[data-kind="toggle"]')) {
      toggle.setAttribute('role', 'switch'); toggle.tabIndex = 0; toggle.setAttribute('aria-checked', String(toggle.classList.contains('on')));
      toggle.setAttribute('aria-label', toggle.closest('.setting-row')?.querySelector('.setting-info strong, .setting-info > span')?.textContent || toggle.closest('.ai-context-head')?.querySelector('strong')?.textContent || 'Переключатель');
    }
    const overlays = [...document.querySelectorAll('#form-overlay.active, #settings-overlay.active, #kb-modal.active, .command-palette-overlay.active')];
    const overlay = overlays.sort((a, b) => (Number(getComputedStyle(a).zIndex) || 0) - (Number(getComputedStyle(b).zIndex) || 0)).at(-1);
    const modal = overlay?.id === 'kb-modal' ? overlay : overlay?.querySelector('.form-modal, .settings-modal, .kb-modal-dialog, [role="dialog"]') || overlay?.firstElementChild || overlay;
    if (overlay === active && modal === activeModal) return;
    if (active) {
      for (const element of document.querySelectorAll('[data-modal-inert]')) { element.inert = false; delete element.dataset.modalInert; }
    }
    active = overlay || null;
    activeModal = modal || null;
    if (!active) { previousFocus?.focus?.({ preventScroll: true }); previousFocus = null; return; }
    previousFocus ||= document.activeElement;
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const title = modal.querySelector('h1,h2,h3');
    if (title) { title.id ||= `modal-title-${active.id || 'command'}`; modal.setAttribute('aria-labelledby', title.id); }
    for (const button of modal.querySelectorAll('button')) {
      if (!button.textContent.trim() && !button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title || (button.querySelector('.bx-x') ? 'Закрыть' : 'Действие'));
    }
    for (const input of modal.querySelectorAll('input:not([type="hidden"]), textarea, select')) {
      if (!input.labels?.length && !input.hasAttribute('aria-label')) input.setAttribute('aria-label', input.closest('.setting-row')?.querySelector('.setting-info strong, .setting-info > span')?.textContent || input.placeholder || input.name || 'Поле ввода');
    }
    for (const element of document.querySelectorAll('#app, .mobile-bottom-nav, .mobile-topbar, .mobile-system-bar')) {
      if (!element.contains(active) && !active.contains(element)) { element.inert = true; element.dataset.modalInert = 'true'; }
    }
    modal.tabIndex = -1;
    (focusables(modal)[0] || modal).focus({ preventScroll: true });
  };
  const observer = new MutationObserver(update);
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
  document.addEventListener('keydown', event => {
    if ([' ', 'Enter'].includes(event.key) && event.target.matches('[role="switch"], [role="button"]:not(button)')) { event.preventDefault(); event.target.click(); return; }
    if (event.key !== 'Tab' || !active) return;
    const list = focusables(active);
    if (!list.length) { event.preventDefault(); return; }
    const index = list.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); list.at(-1).focus(); }
    else if (!event.shiftKey && (index < 0 || index === list.length - 1)) { event.preventDefault(); list[0].focus(); }
  }, true);
  update();
  return () => observer.disconnect();
}
