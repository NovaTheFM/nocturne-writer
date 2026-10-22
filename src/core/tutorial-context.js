export const tutorialContext = (() => {
  if (typeof window === 'undefined' || window.parent === window) return null;
  try {
    const value = JSON.parse(window.name);
    return value?.kind === 'nocturne-tutorial' && value.version === 1 && ['ru', 'uk', 'en'].includes(value.locale) ? value : null;
  } catch { return null; }
})();

export function notifyTutorialParent(type, detail = {}) {
  if (tutorialContext) window.parent.postMessage({ type, session: tutorialContext.session, ...detail }, '*');
}
