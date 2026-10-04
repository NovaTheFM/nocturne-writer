import { normalizeTypoToken, TYPO_LOOKUP } from './typos.js';

const cache = new Map();
const languageCodes = { uk: 'uk-UA', ru: 'ru-RU', en: 'en-US' };

function localMatches(words, lookup) {
  return new Map(words.filter(word => lookup[word]?.correct).map(word => [word, {
    ...lookup[word], suggestions: [lookup[word].correct], source: 'local',
  }]));
}

function contextualChecks(words, text) {
  if (!text || text.length <= 4000) return [{ words, text: text || words.join(' ') }];
  const remaining = new Set(words), windows = [];
  for (const match of text.matchAll(/\p{L}+(?:[’'\-]\p{L}+)*/gu)) {
    if (!remaining.delete(normalizeTypoToken(match[0]))) continue;
    let start = Math.max(0, match.index - 180), end = Math.min(text.length, match.index + match[0].length + 180);
    while (start > 0 && /[^\s.!?…]/u.test(text[start - 1]) && match.index - start < 400) start--;
    while (end < text.length && /[^\s.!?…]/u.test(text[end]) && end - match.index < 800) end++;
    const previous = windows.at(-1);
    if (previous && start <= previous.end && end - previous.start <= 4000) previous.end = Math.max(previous.end, end);
    else windows.push({ start, end });
    if (!remaining.size) break;
  }
  const chunks = [];
  for (const window of windows) {
    const snippet = text.slice(window.start, window.end);
    if (chunks.length && chunks.at(-1).length + snippet.length + 1 <= 4000) chunks[chunks.length - 1] += `\n${snippet}`;
    else chunks.push(snippet);
  }
  return chunks.map(text => {
    const tokens = new Set((text.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || []).map(normalizeTypoToken));
    return { text, words: words.filter(word => tokens.has(word)) };
  });
}

async function onlineMatches(words, { lang, contextText, signal }) {
  const text = contextText || words.join(' ');
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
    const data = await response.json(), matches = new Map(), requested = new Set(words);
    for (const match of data.matches || []) {
      const word = normalizeTypoToken(text.slice(match.offset, match.offset + match.length).trim());
      if (!requested.has(word) || !match.replacements?.length) continue;
      const suggestions = match.replacements.map(replacement => replacement.value).filter(value => typeof value === 'string' && value.trim() && normalizeTypoToken(value) !== word).slice(0, 5);
      if (!suggestions.length) continue;
      matches.set(word, { correct: suggestions[0], suggestions, label: match.rule?.category?.name || 'Опечатка', source: 'online' });
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
  const results = new Map();
  const contexts = mode === 'local' ? [{ words: checked, text: '' }] : contextualChecks(checked, contextText);
  for (const context of contexts) {
    const keyOf = word => JSON.stringify([mode, lang, context.text, word, mode === 'api' ? null : [lookup[word]?.correct, lookup[word]?.label]]);
    const fresh = context.words.filter(word => !cache.has(keyOf(word)));
    if (fresh.length) {
      const matches = mode === 'api' ? new Map() : localMatches(fresh, lookup);
      if (mode !== 'local') {
        const remaining = fresh.filter(word => !matches.has(word));
        if (remaining.length) for (const [word, match] of await onlineMatches(remaining, { ...options, lang, contextText: context.text })) matches.set(word, match);
      }
      options.signal?.throwIfAborted();
      for (const word of fresh) cache.set(keyOf(word), matches.get(word) || null);
      while (cache.size > 2000) cache.delete(cache.keys().next().value);
    }
    for (const word of context.words) if (cache.get(keyOf(word))) results.set(word, cache.get(keyOf(word)));
  }
  results.checkedWords = new Set(checked);
  return results;
}
