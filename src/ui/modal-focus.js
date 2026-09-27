export function manageModalFocus() {
  let active = null;
  let previousFocus = null;
  const focusables = modal => [...modal.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"], [contenteditable="true"]')].filter(element => !element.disabled && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const update = () => {
    const overlays = [...document.querySelectorAll('#form-overlay.active, #settings-overlay.active, #kb-modal.active, .command-palette-overlay.active')];
    const overlay = overlays.at(-1);
    if (overlay === active) return;
    if (active) {
      for (const element of document.querySelectorAll('[data-modal-inert]')) { element.inert = false; delete element.dataset.modalInert; }
    }
    active = overlay || null;
    if (!active) { previousFocus?.focus?.({ preventScroll: true }); previousFocus = null; return; }
    previousFocus ||= document.activeElement;
    const modal = active.querySelector('.form-modal, .settings-modal, .kb-modal-dialog, [role="dialog"]') || active.firstElementChild || active;
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const title = modal.querySelector('h1,h2,h3');
    if (title) { title.id ||= `modal-title-${active.id || 'command'}`; modal.setAttribute('aria-labelledby', title.id); }
    for (const button of modal.querySelectorAll('button')) {
      if (!button.textContent.trim() && !button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.title || (button.querySelector('.bx-x') ? 'Закрыть' : 'Действие'));
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
