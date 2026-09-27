import { normalizeTypoToken, TYPO_LOOKUP } from './typos.js';

const cache = new Map();
const languageCodes = { uk: 'uk-UA', ru: 'ru-RU', en: 'en-US' };

function localMatches(words) {
  return new Map(words.filter(word => TYPO_LOOKUP[word]).map(word => [word, {
    ...TYPO_LOOKUP[word], suggestions: [TYPO_LOOKUP[word].correct], source: 'local',
  }]));
}

async function onlineMatches(words, { lang, contextText, signal }) {
  const text = contextText || words.join(' ');
  const response = await fetch('https://api.languagetool.org/v2/check', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ text, language: languageCodes[lang] || 'auto', enabledOnly: 'false' }).toString(),
    signal: signal || AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Проверка словаря недоступна (${response.status}). Можно повторить позже.`);
  const data = await response.json(), matches = new Map(), requested = new Set(words);
  for (const match of data.matches || []) {
    const word = normalizeTypoToken(text.slice(match.offset, match.offset + match.length).trim());
    if (!requested.has(word) || !match.replacements?.length) continue;
    const suggestions = match.replacements.slice(0, 5).map(replacement => replacement.value);
    matches.set(word, { correct: suggestions[0], suggestions, label: match.rule?.category?.name || 'Опечатка', source: 'online' });
  }
  return matches;
}

export async function getSmartSpellerMatches(words, options = {}) {
  const mode = options.mode || 'local', lang = options.lang || 'auto';
  const normalized = [...new Set(words.map(normalizeTypoToken).filter(Boolean))];
  const contextText = String(options.contextText || '').slice(0, 4000);
  const contextualWords = new Set((contextText.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || []).map(normalizeTypoToken));
  const checked = normalized.filter(word => mode === 'local' || !contextText || contextualWords.has(word));
  const keyOf = word => `${mode}:${lang}:${mode === 'local' ? '' : contextText}:${word}`;
  const results = new Map();
  const fresh = checked.filter(word => !cache.has(keyOf(word)));
  if (fresh.length) {
    const matches = mode === 'api' ? new Map() : localMatches(fresh);
    if (mode !== 'local') {
      const remaining = fresh.filter(word => !matches.has(word));
      if (remaining.length) for (const [word, match] of await onlineMatches(remaining, { ...options, lang, contextText })) matches.set(word, match);
    }
    for (const word of fresh) cache.set(keyOf(word), matches.get(word) || null);
    while (cache.size > 2000) cache.delete(cache.keys().next().value);
  }
  for (const word of checked) if (cache.get(keyOf(word))) results.set(word, cache.get(keyOf(word)));
  results.checkedWords = new Set(checked);
  return results;
}
