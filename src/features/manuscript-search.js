import { blockText } from '../core/utils.js';
import { characterMentionForms } from '../core/name-inflections.js';

const wordChar = char => /[\p{L}\p{N}_]/u.test(char || '');
const fold = (text, options) => (options.caseSensitive ? String(text) : String(text).toLocaleLowerCase('ru-RU')).replace(options.foldYo ? /ё/giu : /$^/u, match => match === 'Ё' ? 'Е' : 'е');
const stem = value => value.length < 4 || !/^[а-яё]+$/iu.test(value) ? value : value.replace(/(?:иями|ями|ами|его|ого|ему|ому|ыми|ими|ах|ях|ов|ев|ей|ой|ий|ый|ую|юю|ом|ем|ам|ям|а|я|ы|и|е|у|ю|о|ь)$/iu, '');

export function textChange(before = '', after = '') {
  let start = 0, endBefore = before.length, endAfter = after.length;
  while (start < endBefore && start < endAfter && before[start] === after[start]) start++;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  return { start, beforeEnd: endBefore, afterEnd: endAfter, removed: before.slice(start, endBefore), added: after.slice(start, endAfter) };
}

export function diffText(before = '', after = '', limit = 256) {
  const change = textChange(before, after), left = change.removed, right = change.added;
  const prefix = before.slice(0, change.start), suffix = before.slice(change.beforeEnd);
  if (!left || !right) return { segments: [{ type: 'equal', text: prefix }, { type: 'removed', text: left }, { type: 'added', text: right }, { type: 'equal', text: suffix }].filter(part => part.text), added: right.length, removed: left.length, approximate: false };
  const vector = new Map([[1, 0]]), trace = [];
  const get = (map, key) => map.get(key) ?? -Infinity;
  let distance = -1;
  for (let d = 0; d <= Math.min(limit, left.length + right.length); d++) {
    trace.push(new Map(vector));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && get(vector, k - 1) < get(vector, k + 1)) ? get(vector, k + 1) : get(vector, k - 1) + 1;
      let y = x - k;
      while (x < left.length && y < right.length && left[x] === right[y]) { x++; y++; }
      vector.set(k, x);
      if (x >= left.length && y >= right.length) { distance = d; break; }
    }
    if (distance >= 0) break;
  }
  let edits = [];
  if (distance < 0) edits = [{ type: 'removed', text: left }, { type: 'added', text: right }];
  else {
    let x = left.length, y = right.length;
    for (let d = distance; d >= 0; d--) {
      const previous = trace[d], k = x - y;
      const previousK = k === -d || (k !== d && get(previous, k - 1) < get(previous, k + 1)) ? k + 1 : k - 1;
      const previousX = Math.max(0, get(previous, previousK)), previousY = previousX - previousK;
      while (x > previousX && y > previousY) { edits.push({ type: 'equal', text: left[--x] }); y--; }
      if (!d) break;
      if (x === previousX) edits.push({ type: 'added', text: right[--y] });
      else edits.push({ type: 'removed', text: left[--x] });
    }
    edits.reverse();
  }
  const segments = [];
  for (const part of [{ type: 'equal', text: prefix }, ...edits, { type: 'equal', text: suffix }]) {
    if (!part.text) continue;
    const previous = segments.at(-1);
    if (previous?.type === part.type) previous.text += part.text; else segments.push({ ...part });
  }
  return { segments, added: segments.filter(part => part.type === 'added').reduce((sum, part) => sum + part.text.length, 0), removed: segments.filter(part => part.type === 'removed').reduce((sum, part) => sum + part.text.length, 0), approximate: distance < 0 };
}

export function findManuscriptText(text, query, options = {}) {
  if (!String(query).trim()) return [];
  const source = fold(text, options), needle = fold(query, options), found = [];
  let start = source.indexOf(needle);
  while (start !== -1) {
    const end = start + needle.length;
    if (!options.wholeWords || (!wordChar(text[start - 1]) && !wordChar(text[end]))) found.push({ start, end, text: text.slice(start, end) });
    start = source.indexOf(needle, start + Math.max(1, needle.length));
  }
  if (options.inflections && !/\s/u.test(needle) && needle.length >= 4) {
    const root = stem(needle);
    for (const token of source.matchAll(/[\p{L}\p{N}’'-]+/gu)) {
      if (root.length >= 3 && stem(token[0]) === root) found.push({ start: token.index, end: token.index + token[0].length, text: text.slice(token.index, token.index + token[0].length) });
    }
  }
  return [...new Map(found.map(match => [`${match.start}:${match.end}`, match])).values()].sort((a, b) => a.start - b.start);
}

export function collectManuscriptMatches(doc, query, options = {}, entities = []) {
  if (!doc || doc.locked || !String(query).trim()) return [];
  const mode = query.includes(';') ? 'all' : options.mode || 'phrase';
  const terms = query.includes(';') ? query.split(';').map(value => value.trim()).filter(Boolean) : mode === 'phrase' ? [query.trim()] : query.trim().split(/\s+/u);
  const alternatives = terms.map(term => {
    const names = options.aliases ? entities.flatMap(entity => {
      const variants = entity.firstName || entity.lastName || entity.type === 'character'
        ? characterMentionForms(entity)
        : [entity.name, entity.displayName, ...(entity.aliases || []), ...(entity.mentionForms || [])].filter(Boolean);
      return variants.some(name => fold(name, options) === fold(term, options)) ? variants : [];
    }) : [];
    return [...new Set([term, ...names])];
  });
  const blocks = (doc.ast?.blocks || []).map((block, blockIndex) => ({ text: blockText(block), blockId: block.id, blockIndex }));
  if (doc.docType === 'book-chapter') blocks.unshift({ text: [doc.workTitle, doc.volume, doc.chapterNumber, doc.bookStatus].filter(Boolean).join(' '), blockId: 'meta', blockIndex: -1 });
  return blocks.flatMap(block => {
    const groups = alternatives.map(variants => variants.flatMap(term => findManuscriptText(block.text, term, options)));
    if (mode !== 'any' && groups.some(group => !group.length)) return [];
    const unique = [...new Map(groups.flat().map(match => [`${match.start}:${match.end}`, match])).values()].sort((a, b) => a.start - b.start || b.end - a.end);
    let coveredEnd = -1;
    const matches = unique.filter(match => {
      if (match.end <= coveredEnd) return false;
      coveredEnd = match.end;
      return true;
    });
    return matches.map(match => ({ ...match, docId: doc.id, docTitle: doc.title, blockId: block.blockId, blockIndex: block.blockIndex, query }));
  }).sort((a, b) => a.blockIndex - b.blockIndex || a.start - b.start);
}
