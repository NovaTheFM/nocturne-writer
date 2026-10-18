const pending = new WeakMap();

export function chooseDefaultInterfaceLanguage(page) {
  if (pending.has(page)) return pending.get(page);
  const preparation = (async () => {
    await page.waitForFunction(() => document.body.classList.contains('boot-error') || window.nocturneApp && (!window.nocturneApp.interfaceLanguage || window.nocturneApp.interfaceLanguage.confirmed) || document.querySelector('#language-onboarding.active'), null, { timeout: 20_000 });
    if (await page.locator('#language-onboarding.active').count()) {
      await page.locator('[data-choose-language="ru"]').click();
      await page.locator('[data-confirm-language]').click();
      await page.locator('#language-onboarding').waitFor({ state: 'detached' });
    }
  })().finally(() => pending.delete(page));
  pending.set(page, preparation);
  return preparation;
}
