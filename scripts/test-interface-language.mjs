import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOCALE_RECORD_ID, getLocale, setLocale, t, ui, formatCount,
  loadLocalePreference, saveLocalePreference, msg, formatDate, getLocaleName,
  localizedLabels, localizedOptions, localizedSettings, getMissingTranslations,
} from '../src/core/i18n.js';
import { messages } from '../src/locales/messages.js';

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

test('preloader copy can use the destination language without changing the current interface', () => {
  setLocale('uk');
  assert.equal(t('Применяем язык интерфейса…', 'ru'), 'Применяем язык интерфейса…');
  assert.equal(getLocale(), 'uk');
  setLocale('ru');
  assert.equal(t('Применяем язык интерфейса…', 'uk'), 'Застосовуємо мову інтерфейсу…');
  assert.equal(getLocale(), 'ru');
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
  assert.deepEqual(await loadLocalePreference(db), { locale: 'en', confirmed: false });
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
    assert.deepEqual(await loadLocalePreference(db), { locale: 'en', confirmed: false });
  }
});

test('module-level registries follow language changes without changing stored option values', () => {
  const labels = localizedLabels({ close: 'Закрыть' });
  const options = localizedOptions([['closed', 'Закрыть']]);
  const settings = localizedSettings([{ key: 'history', label: 'Настройки', note: 'Закрыть', suffix: ' мин', options: [['closed', 'Закрыть']] }]);
  for (const [locale, close, title] of [['uk', 'Закрити', 'Налаштування'], ['en', 'Close', 'Settings'], ['ru', 'Закрыть', 'Настройки']]) {
    setLocale(locale);
    assert.equal(labels.close, close); assert.equal(options[0][1], close);
    assert.equal(settings[0].label, title); assert.equal(settings[0].note, close);
    assert.equal(settings[0].options[0][0], 'closed'); assert.equal(settings[0].options[0][1], close);
    assert.ok(settings[0].suffix.startsWith(' '));
  }
});

test('translations cover both languages and preserve every interpolation slot', () => {
  assert.ok(Object.keys(messages).length > 2300);
  const slots = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [source, variants] of Object.entries(messages)) {
    assert.equal(variants.length, 2, source);
    for (const translated of variants) {
      assert.ok(translated.trim(), source);
      assert.deepEqual(slots(translated), slots(source), source);
    }
  }
});

test('dynamic messages reorder opaque values safely and formatting follows the chosen locale', () => {
  setLocale('en');
  const result = msg`Импортировано в раздел "${'Настройки'}": ${5} записей.`;
  assert.equal(result, 'Imported 5 entries into “Настройки”.');
  assert.equal(getLocaleName(), 'en-US');
  assert.equal(formatDate('2026-10-18T12:00:00Z', { timeZone: 'UTC', year: 'numeric' }), '2026');
  assert.equal(formatCount(1, 'characters'), '1 character');
  assert.equal(formatCount(2, 'pages'), '2 pages');
  assert.throws(() => formatCount(1, 'missing'), /Unknown count unit/);
  assert.ok(Array.isArray(getMissingTranslations()));
  setLocale('ru');
});
