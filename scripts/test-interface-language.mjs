import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOCALE_RECORD_ID, getLocale, setLocale, t, ui, formatCount,
  loadLocalePreference, saveLocalePreference,
} from '../src/core/i18n.js';

test('all supported languages have natural interface translations', () => {
  for (const [locale, close, settings] of [['ru', 'Закрыть', 'Настройки'], ['uk', 'Закрити', 'Налаштування'], ['en', 'Close', 'Settings']]) {
    setLocale(locale);
    assert.equal(getLocale(), locale);
    assert.equal(t('Закрыть'), close);
    assert.equal(t('Настройки'), settings);
  }
  assert.throws(() => setLocale('unknown'), /locale/i);
  setLocale('ru');
});

test('UI templates translate static copy while preserving author text and markup exactly', () => {
  const author = 'Настройки <em>Закрыть</em> ${private} Український текст & English';
  const render = () => ui`<section title="Настройки"><h2>Настройки</h2><p>${author}</p><button aria-label="Закрыть">Закрыть</button></section>`;
  setLocale('en');
  assert.equal(render(), `<section title="Settings"><h2>Settings</h2><p>${author}</p><button aria-label="Close">Close</button></section>`);
  setLocale('uk');
  assert.ok(render().includes('<h2>Налаштування</h2>'));
  assert.ok(render().includes(author));
  setLocale('ru');
  assert.ok(render().includes('<h2>Настройки</h2>'));
});

test('UI templates preserve data values, URLs, identifiers, classes and user-controlled attributes', () => {
  setLocale('en');
  const title = 'Закрыть', text = 'Настройки';
  assert.equal(ui`<input value="Настройки" data-value="Закрыть" title="${title}" class="Настройки" placeholder="Настройки"><p>${text}</p>`, '<input value="Настройки" data-value="Закрыть" title="Закрыть" class="Настройки" placeholder="Settings"><p>Настройки</p>');
  assert.equal(t('Unknown author text'), 'Unknown author text');
  setLocale('ru');
});

test('word counts use the language’s plural rules', () => {
  const cases = {
    ru: ['1 слово', '2 слова', '5 слов', '21 слово'],
    uk: ['1 слово', '2 слова', '5 слів', '21 слово'],
    en: ['1 word', '2 words', '5 words', '21 words'],
  };
  for (const [locale, expected] of Object.entries(cases)) {
    setLocale(locale);
    assert.deepEqual([1, 2, 5, 21].map(count => formatCount(count, 'words')), expected);
  }
  setLocale('ru');
});

test('upgrading a profile reads a local preference without modifying existing records', async () => {
  const manuscripts = { id: 'chapter', title: 'Настройки', body: 'Закрыть', encrypted: { ciphertext: 'keep-exactly' } };
  const records = new Map([['docs:chapter', structuredClone(manuscripts)], ['settings:app', { id: 'app', value: { theme: 'paper', e2e: true } }]]);
  const db = {
    get: async (store, id) => structuredClone(records.get(`${store}:${id}`)),
    put: async (store, record) => records.set(`${store}:${record.id}`, structuredClone(record)),
  };
  const before = structuredClone([...records]);
  assert.deepEqual(await loadLocalePreference(db), { locale: 'ru', confirmed: false });
  assert.deepEqual([...records], before);
  await saveLocalePreference(db, 'uk');
  assert.deepEqual(await loadLocalePreference(db), { locale: 'uk', confirmed: true });
  assert.deepEqual(records.get('docs:chapter'), manuscripts);
  assert.deepEqual(records.get('settings:app'), before[1][1]);
  assert.equal(records.size, 3);
  assert.equal(records.get(`settings:${LOCALE_RECORD_ID}`).locale, 'uk');
});

test('failed preference writes do not change the active language or erase existing data', async () => {
  setLocale('ru');
  const db = { put: async () => { throw new Error('disk full'); } };
  await assert.rejects(saveLocalePreference(db, 'en'), /disk full/);
  assert.equal(getLocale(), 'ru');
  await assert.rejects(saveLocalePreference(db, 'not-a-locale'), /locale/i);
});

test('malformed preferences ask again and never trigger database recreation', async () => {
  for (const value of [undefined, {}, { locale: 'zz', confirmed: true }, { locale: 'uk', confirmed: false }]) {
    const db = { get: async () => value };
    assert.deepEqual(await loadLocalePreference(db), { locale: 'ru', confirmed: false });
  }
});
