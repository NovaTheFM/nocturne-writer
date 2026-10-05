import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { defaultSettings } from '../src/core/defaults.js';

const output = 'reports/settings-copy-2026-10-05';
const port = 5397;
const base = `http://127.0.0.1:${port}`;
try {
  await fetch(base);
  throw new Error(`Port ${port} is occupied; existing server will be preserved.`);
} catch (error) {
  if (!error.cause) throw error;
}
await mkdir(output, { recursive: true });
const server = spawn(process.execPath, ['server.mjs'], {
  env: { ...process.env, PORT: String(port), SYNC_PORT: '8997' },
  windowsHide: true, stdio: 'ignore',
});
let browser;
const capture = { version: '1.2.1', capturedAt: new Date().toISOString(), defaults: defaultSettings, surfaces: [], sources: {} };
try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(base);
  await page.waitForSelector('.app-shell.ready');
  const result = await page.evaluate(() => {
    const a = window.nocturneApp;
    a.state.settings.automaticBackups = false;
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const text = element => clean(element?.textContent);
    function inspect(html) {
      const t = document.createElement('template'); t.innerHTML = html;
      const root = t.content;
      const rows = [...root.querySelectorAll('.setting-row')].map(element => {
        const span = element.querySelector('.setting-info > span');
        const copy = span?.cloneNode(true); copy?.querySelectorAll('i').forEach(i => i.remove());
        return {
          title: text(copy), short: text(element.querySelector('.setting-info > small')),
          long: clean(element.querySelector('[data-tip]')?.dataset.tip),
          keys: [...element.querySelectorAll('[data-setting], [data-setting-select]')].map(el => el.dataset.setting || el.dataset.settingSelect).filter((key, i, all) => all.indexOf(key) === i),
          actions: [...element.querySelectorAll('[data-action]')].map(el => el.dataset.action),
          options: [...element.querySelectorAll('[data-setting-option]')].map(el => ({ key: el.dataset.settingOption, value: el.dataset.value, label: text(el) })),
          controls: [...element.querySelectorAll('input')].map(el => ({ id: el.id, type: el.type, key: el.dataset.setting, min: el.min, max: el.max, step: el.step, accept: el.accept })),
        };
      });
      const extra = [...root.querySelectorAll('[data-setting], [data-setting-select], [data-action], [data-dictionary-search], [data-dictionary-filter], input, textarea')]
        .filter(el => !el.closest('.setting-row') && !el.closest('[data-setting-select]')?.contains(el.parentElement))
        .map(el => {
          const field = el.closest('label, .form-group, .form-field, .macro-form-field, .formatting-field-group, .smart-dictionary-field, .export-format-card, .ai-preset-card, .misc-card, .dictionary-card');
          const heading = field?.querySelector('label, .smart-dictionary-label, h4, h3, strong, span');
          const labelCopy = field?.matches('label') ? field.cloneNode(true) : null;
          labelCopy?.querySelectorAll('input, textarea, .nocturne-select').forEach(control => control.remove());
          return { key: el.dataset.setting || el.dataset.settingSelect || el.name || el.id || (el.hasAttribute('data-dictionary-search') ? 'dictionarySearch' : ''), action: el.dataset.action,
            filter: el.dataset.dictionaryFilter, preset: el.dataset.aiPreset,
            title: text(el.matches('input, textarea, [data-setting-select], .toggle') ? labelCopy || heading : el) || el.title || el.getAttribute('aria-label') || '',
            short: text(field?.querySelector('p, small')), long: clean(field?.querySelector('[data-tip]')?.dataset.tip),
            type: el.type || el.className, placeholder: el.getAttribute('placeholder'), maxLength: el.getAttribute('maxlength'),
            options: [...el.querySelectorAll('[data-setting-option], [data-form-option]')].map(o => ({ value: o.dataset.value, label: text(o) })),
          };
        }).filter((item, i, all) => all.findIndex(other => other.key === item.key && other.action === item.action && other.title === item.title && other.preset === item.preset && other.filter === item.filter) === i);
      return {
        rows, extra,
        headings: [...root.querySelectorAll('.setting-group-title, h3, h4')].map(text),
        introductions: [...root.querySelectorAll('.settings-tab-desc, .settings-section-note, .bookmark-settings-footnote, .smart-dictionary-notice')].map(text),
        modes: [...root.querySelectorAll('[data-review-mode]')].map(el => ({ value: el.dataset.reviewMode, title: text(el.querySelector('strong')), short: text(el.querySelector('span')) })),
      };
    }
    const surfaces = [];
    const tabs = ['visual', 'editor', 'dictionary', 'review', 'bookmarks', 'focus', 'macros', 'formatting', 'ai', 'data', 'export', 'misc', 'search'];
    const originalMobile = a.isMobileLayout;
    const originalAndroid = a.isAndroidRuntime;
    const originalCapacitor = a.isCapacitorRuntime;
    const originalElectron = a.runtime.isElectron;
    for (const platform of ['browser', 'electron', 'android']) {
      a.isMobileLayout = () => platform === 'android';
      a.isAndroidRuntime = () => platform === 'android';
      a.isCapacitorRuntime = () => platform === 'android';
      a.runtime.isElectron = platform === 'electron';
      for (const tab of tabs) surfaces.push({ platform, tab, ...inspect(a.settingsContent(tab)) });
    }
    a.isMobileLayout = originalMobile; a.isAndroidRuntime = originalAndroid; a.isCapacitorRuntime = originalCapacitor; a.runtime.isElectron = originalElectron;
    const registry = a.getSettingsRegistry();
    const uiDefaults = { reviewMode: a.state.reviewMode, exportNocturned: a.state.exportNocturned };
    a.openCompactSettings();
    surfaces.push({ platform: 'all', tab: 'compact', ...inspect(document.querySelector('#form-overlay').innerHTML) });
    const extras = ['new-custom-provider', 'new-custom-persona'];
    for (const action of extras) {
      const button = document.createElement('button'); button.dataset.action = action; document.body.appendChild(button); button.click(); button.remove();
      surfaces.push({ platform: 'all', tab: action, ...inspect(document.querySelector('#form-overlay').innerHTML) });
    }
    a.openTypoRuleForm('', null, { allowBlank: true });
    surfaces.push({ platform: 'all', tab: 'dictionary-rule', ...inspect(document.querySelector('#form-overlay').innerHTML) });
    a.editWorldRules();
    surfaces.push({ platform: 'all', tab: 'world-rules', ...inspect(document.querySelector('#form-overlay').innerHTML) });
    const builtinKeys = (() => { const t = document.createElement('template'); t.innerHTML = a.dictionarySettingsContent(); return [...new Set([...t.content.querySelectorAll('[data-builtin-key]')].map(el => el.dataset.builtinKey))]; })();
    a.state.typoRules = [
      { id: 'audit-user', source: 'user', wrong: 'auditwrong', correct: 'auditcorrect', label: 'Audit' },
      { id: 'audit-disabled', source: 'disabled-builtin', builtinKey: builtinKeys[0] },
      { id: 'audit-override', source: 'override', builtinKey: builtinKeys[1], wrong: 'audit', correct: 'audit', label: 'Audit' },
    ];
    surfaces.push({ platform: 'all', tab: 'dictionary-variants', ...inspect(a.dictionarySettingsContent()) });
    a.state.settings.customFonts = [{ name: 'AuditFont', data: '' }];
    a.state.settings.customAiProviders = [{ id: 'prov_audit', name: 'Audit provider', endpoint: '', key: '', model: 'audit', apiFormat: 'openai' }];
    a.state.settings.customAiPersonas = [{ id: 'custom_audit', name: 'Audit persona', prompt: 'Audit prompt' }];
    a.state.settings.aiProvider = 'prov_audit';
    surfaces.push({ platform: 'all', tab: 'ai-custom', ...inspect(a.settingsContent('ai')) });
    surfaces.push({ platform: 'all', tab: 'editor-custom-font', ...inspect(a.settingsContent('editor')) });
    for (const action of ['edit-custom-provider', 'edit-custom-persona']) {
      const button = document.createElement('button'); button.dataset.action = action; button.dataset.providerId = 'prov_audit'; button.dataset.personaId = 'custom_audit'; document.body.appendChild(button); button.click(); button.remove();
      surfaces.push({ platform: 'all', tab: action, ...inspect(document.querySelector('#form-overlay').innerHTML) });
    }
    return { surfaces, registry, uiDefaults };
  });
  Object.assign(capture, result);
  for (const path of ['src/main.js', 'src/core/defaults.js', 'src/features/bookmark-controller.js', 'src/features/bookmark-model.js']) {
    capture.sources[path] = createHash('sha256').update(await readFile(path)).digest('hex');
  }
  await writeFile(`${output}/capture.json`, JSON.stringify(capture, null, 2) + '\n');
  console.log(JSON.stringify({ surfaces: capture.surfaces.length, registry: capture.registry.length, rows: capture.surfaces[0].rows.length, path: `${output}/capture.json` }));
} finally {
  await browser?.close();
  server.kill();
}
