import { messages } from '../locales/messages.js';

export const LOCALE_RECORD_ID = 'interface-language';
export const supportedLocales = Object.freeze(['ru', 'uk', 'en']);
const localeNames = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US' };
let locale = 'ru';
const missing = new Set();
const compiledTemplates = new WeakMap();
const token = index => `\uE000${index}\uE001`;
const tokenPattern = /\uE000(\d+)\uE001/g;
const normalize = text => text.trim().replace(/\s+/gu, ' ');

export function getLocale() { return locale; }
export function getLocaleName() { return localeNames[locale]; }

export function setLocale(value) {
  if (!supportedLocales.includes(value)) throw new RangeError(`Unsupported locale: ${value}`);
  locale = value;
}

export function t(source) {
  if (locale === 'ru' || !source) return source;
  const entry = messages[normalize(source)];
  const translated = entry?.[locale === 'uk' ? 0 : 1];
  if (translated === undefined) { if (/[\u0400-\u04ff]/u.test(source)) missing.add(normalize(source)); return source; }
  const leading = source.match(/^\s*/u)[0], trailing = source.match(/\s*$/u)[0];
  return leading + translated + trailing;
}

function translateSegment(segment) {
  const slots = [];
  const source = segment.replace(tokenPattern, (_, index) => `{${slots.push(index) - 1}}`);
  return t(source).replace(/\{(\d+)\}/g, (match, index) => slots[index] === undefined ? match : token(slots[index]));
}

export function translateMarkup(source) {
  let cursor = 0, result = '';
  const tags = /<!--[\s\S]*?-->|<\/?[a-zA-Z](?:[^>"']|"[^"]*"|'[^']*')*>/g;
  for (const match of source.matchAll(tags)) {
    result += translateSegment(source.slice(cursor, match.index));
    result += match[0].startsWith('<!--') ? match[0] : match[0].replace(/\b(title|aria-label|placeholder|data-placeholder|alt)=("([^"]*)"|'([^']*)')/g, (attribute, name, quoted, double, single) => {
      const quote = quoted[0], value = double ?? single;
      const translated = translateSegment(value);
      return translated === value ? attribute : `${name}=${quote}${translated.replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&#39;')}${quote}`;
    });
    cursor = match.index + match[0].length;
  }
  return result + translateSegment(source.slice(cursor));
}

function template(strings, values, markup) {
  if (typeof strings === 'string') return markup ? translateMarkup(strings) : t(strings);
  let cache = compiledTemplates.get(strings);
  if (!cache) { cache = new Map(); compiledTemplates.set(strings, cache); }
  const key = `${locale}:${markup}`;
  if (!cache.has(key)) {
    const source = strings.reduce((text, part, index) => text + (index ? token(index - 1) : '') + part, '');
    cache.set(key, markup ? translateMarkup(source) : translateSegment(source));
  }
  return cache.get(key).replace(tokenPattern, (_, index) => String(values[index]));
}

// Only literal template segments are translated. Interpolated manuscript text is opaque.
export function ui(strings, ...values) { return template(strings, values, true); }
export function msg(strings, ...values) { return template(strings, values, false); }
export function getMissingTranslations() { return [...missing]; }

const countForms = {
  words: { ru: ['слово', 'слова', 'слов'], uk: ['слово', 'слова', 'слів'], en: ['word', 'words', 'words'] },
  characters: { ru: ['знак', 'знака', 'знаков'], uk: ['знак', 'знаки', 'знаків'], en: ['character', 'characters', 'characters'] },
  pages: { ru: ['страница', 'страницы', 'страниц'], uk: ['сторінка', 'сторінки', 'сторінок'], en: ['page', 'pages', 'pages'] },
};

export function formatCount(value, unit) {
  const number = Number(value) || 0;
  const form = new Intl.PluralRules(localeNames[locale]).select(number);
  const forms = countForms[unit]?.[locale];
  if (!forms) throw new RangeError(`Unknown count unit: ${unit}`);
  return `${number.toLocaleString(localeNames[locale])} ${forms[form === 'one' ? 0 : form === 'few' ? 1 : 2]}`;
}

export function formatDate(value, options = {}) { return new Date(value).toLocaleString(localeNames[locale], options); }

export async function loadLocalePreference(db) {
  const record = await db.get('settings', LOCALE_RECORD_ID);
  return record?.confirmed === true && supportedLocales.includes(record.locale)
    ? { locale: record.locale, confirmed: true }
    : { locale: 'ru', confirmed: false };
}

export async function saveLocalePreference(db, value) {
  if (!supportedLocales.includes(value)) throw new RangeError(`Unsupported locale: ${value}`);
  await db.put('settings', { id: LOCALE_RECORD_ID, locale: value, confirmed: true });
}
