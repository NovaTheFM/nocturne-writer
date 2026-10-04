import { normalizeTypoToken, TYPO_LOOKUP } from './typos.js';

const cache = new Map();
const languageCodes = { uk: 'uk-UA', ru: 'ru-RU', en: 'en-US' };

function localMatches(words, lookup) {
  return new Map(words.filter(word => lookup[word]?.correct && normalizeTypoToken(lookup[word].correct) !== word).map(word => [word, {
    ...lookup[word], suggestions: [lookup[word].correct], source: 'local', preserveCase: !['user', 'override'].includes(lookup[word].source),
  }]));
}

function contextualChecks(words, text) {
  if (!words.length) return [];
  text ||= words.join(' ');
  if (text.length <= 4000) return [{ words, text, segments: [{ start: 0, end: text.length, offset: 0 }] }];
  const requested = new Set(words), windows = [];
  for (const match of text.matchAll(/\p{L}+(?:[’'\-]\p{L}+)*/gu)) {
    if (!requested.has(normalizeTypoToken(match[0]))) continue;
    let start = Math.max(0, match.index - 180), end = Math.min(text.length, match.index + match[0].length + 180);
    while (start > 0 && /[^\s.!?…]/u.test(text[start - 1]) && match.index - start < 400) start--;
    while (end < text.length && /[^\s.!?…]/u.test(text[end]) && end - match.index < 800) end++;
    const previous = windows.at(-1);
    if (previous && start <= previous.end && end - previous.start <= 4000) { previous.start = Math.min(previous.start, start); previous.end = Math.max(previous.end, end); }
    else windows.push({ start, end });
  }
  const chunks = [];
  for (const window of windows) {
    const snippet = text.slice(window.start, window.end);
    let chunk = chunks.at(-1);
    if (!chunk || chunk.text.length + snippet.length + 1 > 4000) { chunk = { text: '', segments: [] }; chunks.push(chunk); }
    if (chunk.text) chunk.text += '\n';
    chunk.segments.push({ ...window, offset: chunk.text.length });
    chunk.text += snippet;
  }
  return chunks.map(chunk => {
    const tokens = new Set((chunk.text.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || []).map(normalizeTypoToken));
    return { ...chunk, words: words.filter(word => tokens.has(word)) };
  });
}

function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    previous = row;
  }
  return previous[right.length];
}

function spellingSuggestions(rawText, replacements, preferred) {
  const word = normalizeTypoToken(rawText);
  const suggestions = [...new Set(replacements.map(replacement => replacement?.value).filter(value => {
    if (typeof value !== 'string' || !/^\p{L}+(?:[’'\-]\p{L}+)*(?: \p{L}+(?:[’'\-]\p{L}+)*)*$/u.test(value)) return false;
    if (normalizeTypoToken(value) === word) return false;
    return !value.includes(' ') || normalizeTypoToken(value.replaceAll(' ', '')) === word;
  }))];
  return suggestions.sort((left, right) => {
    const preference = Number(right === preferred) - Number(left === preferred);
    return preference || editDistance(word, normalizeTypoToken(left)) - editDistance(word, normalizeTypoToken(right));
  }).slice(0, 5);
}

async function onlineMatches({ lang, contextText: text, signal }) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  const timeout = setTimeout(() => controller.abort(new DOMException('Время ожидания проверки словаря истекло.', 'TimeoutError')), 12_000);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const response = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ text, language: languageCodes[lang] || 'auto', enabledOnly: 'false' }).toString(),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Проверка словаря недоступна (${response.status}). Можно повторить позже.`);
    const data = await response.json(), matches = new Map();
    for (const match of data.matches || []) {
      if (!Number.isInteger(match.offset) || !Number.isInteger(match.length) || match.offset < 0 || match.length <= 0 || match.offset + match.length > text.length) continue;
      const rawText = text.slice(match.offset, match.offset + match.length);
      if (!/^\p{L}+(?:[’'\-]\p{L}+)*$/u.test(rawText) || !Array.isArray(match.replacements)) continue;
      if (match.rule?.issueType === 'style' || ['STYLE', 'REPETITIONS_STYLE', 'REDUNDANCY'].includes(match.rule?.category?.id)) continue;
      const word = normalizeTypoToken(rawText);
      if (!matches.has(word)) matches.set(word, []);
      matches.get(word).push({ rawText, start: match.offset, end: match.offset + match.length, replacements: match.replacements, label: match.rule?.category?.name || 'Опечатка', issueType: match.rule?.issueType });
    }
    controller.signal.throwIfAborted();
    return matches;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function getSmartSpellerMatches(words, options = {}) {
  options.signal?.throwIfAborted();
  const mode = options.mode || 'local', lang = options.lang || 'auto';
  const lookup = options.localLookup ?? TYPO_LOOKUP;
  const ignored = new Set(Array.from(options.ignoredWords || [], normalizeTypoToken));
  const normalized = [...new Set(words.map(normalizeTypoToken).filter(word => word && !ignored.has(word)))];
  const contextText = mode === 'local' ? '' : String(options.contextText || '');
  const contextualWords = new Set((contextText.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || []).map(normalizeTypoToken));
  const checked = normalized.filter(word => mode === 'local' || !contextText || contextualWords.has(word));
  const localWords = mode === 'api' ? checked.filter(word => ['user', 'override'].includes(lookup[word]?.source)) : checked;
  const results = localMatches(localWords, lookup);
  const remaining = checked.filter(word => !results.has(word));
  for (const context of mode === 'local' ? [] : contextualChecks(remaining, contextText)) {
    const key = JSON.stringify([lang, context.text]);
    if (!cache.has(key)) {
      const matches = await onlineMatches({ ...options, lang, contextText: context.text });
      options.signal?.throwIfAborted();
      cache.set(key, matches);
      while (cache.size > 128) cache.delete(cache.keys().next().value);
    }
    for (const word of context.words) {
      for (const occurrence of cache.get(key).get(word) || []) {
        const segment = context.segments.find(segment => occurrence.start >= segment.offset && occurrence.end <= segment.offset + segment.end - segment.start);
        if (!segment) continue;
        const suggestions = spellingSuggestions(occurrence.rawText, occurrence.replacements, lookup[word]?.correct);
        if (!suggestions.length) continue;
        const item = { rawText: occurrence.rawText, start: segment.start + occurrence.start - segment.offset, end: segment.start + occurrence.end - segment.offset, correct: suggestions[0], suggestions, label: occurrence.label, source: 'online' };
        if (!results.has(word)) results.set(word, { ...item, occurrences: [] });
        if (!results.get(word).occurrences.some(existing => existing.start === item.start && existing.end === item.end)) results.get(word).occurrences.push(item);
      }
    }
  }
  results.checkedWords = new Set(checked);
  return results;
}
