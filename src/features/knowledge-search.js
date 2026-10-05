import { escapeHtml } from '../core/utils.js';

export const KNOWLEDGE_SEARCH_TYPES = [
  ['characters', 'bx-user-pin', 'Персонажи'],
  ['locations', 'bx-map-alt', 'Локации'],
  ['timeline', 'bx-git-commit', 'События'],
  ['subtimeline', 'bx-git-branch', 'Подсобытия'],
  ['notes', 'bx-note', 'Записи'],
  ['rules', 'bx-list-check', 'Правила мира'],
  ['world', 'bx-book-bookmark', 'Произведения'],
];

const FIELD_LABELS = {
  title: 'Название', name: 'Имя', displayName: 'Имя', firstName: 'Имя', lastName: 'Фамилия',
  role: 'Роль', body: 'Описание / текст', text: 'Текст', description: 'Описание',
  aliases: 'Псевдонимы', mentionForms: 'Варианты упоминания', date: 'Дата',
  bookmarks: 'Закладки', tags: 'Метки', notes: 'Заметки', characterRoles: 'Участие в событии',
};
const SKIP_FIELD = /^(?:id|type|order|image|icon|encrypted|protectedStore|locked|createdAt|updatedAt|completed|subEvents)$|(?:Ids?|URL|Url)$/;
const fold = text => String(text).toLocaleLowerCase('ru').replace(/ё/g, 'е');

export function findTextMatches(text, query, { limit = Infinity } = {}) {
  const term = String(query || '').trim();
  if (!term) return [];
  const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/gi, '[её]');
  const matches = [];
  for (const match of String(text).matchAll(new RegExp(pattern, 'giu'))) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (matches.length >= limit) break;
  }
  return matches;
}

export function queryTerms(query) {
  return [...new Set(String(query || '').trim().split(/\s+/).filter(Boolean))];
}

export function highlightSearchText(text, terms) {
  const value = String(text || '');
  const ranges = terms.flatMap(term => findTextMatches(value, term)).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  let cursor = 0, html = '';
  for (const range of merged) {
    html += escapeHtml(value.slice(cursor, range.start)) + `<mark>${escapeHtml(value.slice(range.start, range.end))}</mark>`;
    cursor = range.end;
  }
  return html + escapeHtml(value.slice(cursor));
}

function collectFields(value, label = '', fields = [], seen = new Set()) {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (text && !seen.has(`${label}\0${text}`)) { fields.push({ label, text }); seen.add(`${label}\0${text}`); }
  } else if (Array.isArray(value)) {
    for (const entry of value) collectFields(entry, label, fields, seen);
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (SKIP_FIELD.test(key) || key.startsWith('_') || key === 'characterRoles') continue;
      collectFields(entry, label ? `${label} · ${FIELD_LABELS[key] || key}` : FIELD_LABELS[key] || key, fields, seen);
    }
  }
  return fields;
}

export function searchKnowledge(worlds, query, { docs = [], floatingNotes = [] } = {}) {
  const terms = queryTerms(query), normalized = terms.map(fold);
  if (!terms.length) return [];
  const results = [];
  for (const world of worlds) {
    if (!world || world.locked || world.protectedStore) continue;
    const add = (type, item, parent = null) => {
      if (!item || item.locked || item.protectedStore) return;
      const fields = collectFields(item);
      for (const [key, records, label] of [['characterIds', world.characters, 'Связанные персонажи'], ['locationIds', world.locations, 'Связанные локации'], ['noteIds', world.notes, 'Связанные записи'], ['chapterIds', docs, 'Связанные главы'], ['documentIds', docs, 'Связанные документы']]) {
        const names = (item[key] || []).map(id => (records || []).find(record => record.id === id)).filter(Boolean).map(record => record.displayName || record.name || record.title || '').join(', ');
        if (names) fields.push({ label, text: names });
      }
      for (const note of floatingNotes) {
        if (!note.locked && !note.protectedStore && note.linkedId === item.id && ['character', 'location', 'note'].includes(note.scope)) {
          fields.push(...collectFields({ title: note.title, body: note.body }, 'Плавающая заметка'));
        }
      }
      const haystack = fold(fields.map(field => field.text).join('\n'));
      if (!normalized.every(term => haystack.includes(term))) return;
      const matchingFields = fields.filter(field => normalized.some(term => fold(field.text).includes(term)));
      const title = item.displayName || item.name || item.title || (type === 'rules' ? 'Правило мира' : 'Без названия');
      results.push({ worldId: world.id, worldTitle: world.title || 'Произведение', type, id: item.id, parentId: parent?.id,
        parentTitle: parent?.title, title, fields: matchingFields,
        score: normalized.filter(term => fold(title).includes(term)).length * 10 + matchingFields.length });
    };
    for (const type of ['characters', 'locations', 'timeline', 'notes']) {
      for (const item of world[type] || []) {
        add(type, item);
        if (type === 'timeline') for (const sub of item.subEvents || []) add('subtimeline', sub, item);
      }
    }
    (world.rules || []).forEach((rule, index) => add('rules', typeof rule === 'string' ? { id: String(index), text: rule } : { ...rule, id: rule.id || String(index) }));
    const { characters, locations, timeline, notes, rules, ...metadata } = world;
    add('world', { ...metadata, id: world.id });
  }
  return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'ru'));
}

export function searchSnippet(text, terms, maxLength = 220) {
  const value = String(text);
  const first = terms.flatMap(term => findTextMatches(value, term, { limit: 1 })).sort((a, b) => a.start - b.start)[0];
  const start = Math.max(0, (first?.start || 0) - 60), end = Math.min(value.length, start + maxLength);
  return `${start ? '…' : ''}${value.slice(start, end)}${end < value.length ? '…' : ''}`;
}
