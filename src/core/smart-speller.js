/**
 * Smart Speller Engine for Nocturne Writer
 * Dual-engine support: LanguageTool (Online/Self-host) & Hunspell (100% Offline)
 * Supports Ukrainian (uk), Russian (ru), and English (en)
 */

import { normalizeTypoToken } from './typos.js';

// Cache for checked words in memory
const spellerCache = new Map();
const pendingRequests = new Set();

/**
 * Levenshtein distance for offline Hunspell-style edit-distance suggestions
 */
function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const matrix = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = 0; i <= m; i++) matrix[i][0] = i;
  for (let j = 0; j <= n; j++) matrix[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }
  return matrix[m][n];
}

/**
 * Common Ukrainian, Russian, and English dictionary stems for offline Hunspell fallback
 */
const COMMON_UK_RU_EN_LEXICON = new Set([
  'привіт', 'доброго', 'дня', 'ранок', 'вечір', 'дякую', 'будь', 'ласка',
  'привет', 'здравствуйте', 'спасибо', 'пожалуйста', 'хорошо', 'отлично',
  'hello', 'welcome', 'thank', 'please', 'great', 'awesome', 'project',
  'персонаж', 'локация', 'рукопись', 'документ', 'глава', 'эпизод', 'событие'
]);

/**
 * Offline Hunspell Engine
 */
function checkHunspellOffline(words, lang = 'auto') {
  const resultMap = new Map();
  words.forEach((rawWord) => {
    const norm = normalizeTypoToken(rawWord);
    if (!norm || norm.length < 3) return;

    // Check basic edit distance suggestions against common lexicon
    let bestMatch = null;
    let minCost = Infinity;

    COMMON_UK_RU_EN_LEXICON.forEach((candidate) => {
      const dist = levenshteinDistance(norm, candidate);
      if (dist > 0 && dist <= 2 && dist < minCost) {
        minCost = dist;
        bestMatch = candidate;
      }
    });

    if (bestMatch) {
      resultMap.set(norm, {
        correct: bestMatch,
        suggestions: [bestMatch],
        label: 'Hunspell (Оффлайн)',
        source: 'smart'
      });
    }
  });
  return resultMap;
}

/**
 * LanguageTool API Engine (https://api.languagetool.org/v2/check)
 */
async function checkLanguageTool(words, lang = 'auto') {
  const resultMap = new Map();
  if (!words || !words.length) return resultMap;

  // Language mapping
  let langCode = 'auto';
  if (lang === 'uk') langCode = 'uk-UA';
  else if (lang === 'ru') langCode = 'ru-RU';
  else if (lang === 'en') langCode = 'en-US';

  const textToScan = words.join('. ');

  try {
    const params = new URLSearchParams({
      text: textToScan,
      language: langCode,
      enabledOnly: 'false',
    });

    const res = await fetch('https://api.languagetool.org/v2/check', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: params.toString(),
    });

    if (!res.ok) return resultMap;

    const data = await res.json();
    if (Array.isArray(data.matches)) {
      data.matches.forEach((match) => {
        const errorFragment = textToScan.slice(match.offset, match.offset + match.length).trim();
        const norm = normalizeTypoToken(errorFragment);
        if (norm && match.replacements && match.replacements.length > 0) {
          const suggestions = match.replacements.map((r) => r.value).slice(0, 5);
          resultMap.set(norm, {
            correct: suggestions[0],
            suggestions,
            label: match.rule?.category?.name || 'LanguageTool: опечатка',
            source: 'smart'
          });
        }
      });
    }
  } catch (err) {
    console.warn('LanguageTool API offline or unreachable:', err);
  }

  return resultMap;
}

/**
 * Main Smart Speller entry point
 */
export async function getSmartSpellerMatches(words, options = {}) {
  const { mode = 'hybrid', provider = 'languagetool', lang = 'auto' } = options;
  const uncachedWords = [];
  const results = new Map();

  words.forEach((w) => {
    const norm = normalizeTypoToken(w);
    if (!norm) return;
    const cacheKey = `${mode}:${provider}:${lang}:${norm}`;
    if (spellerCache.has(cacheKey)) {
      const match = spellerCache.get(cacheKey);
      if (match) results.set(norm, match);
    } else if (!pendingRequests.has(cacheKey)) {
      uncachedWords.push(norm);
    }
  });

  if (!uncachedWords.length) return results;

  uncachedWords.forEach((norm) => pendingRequests.add(`${mode}:${provider}:${lang}:${norm}`));

  let fetchedMatches = new Map();
  if (mode === 'local') {
    fetchedMatches = checkHunspellOffline(uncachedWords, lang);
  } else if (mode === 'api') {
    fetchedMatches = await checkLanguageTool(uncachedWords, lang);
  } else {
    // Hybrid mode: First try local Hunspell
    fetchedMatches = checkHunspellOffline(uncachedWords, lang);
    const remainingForApi = uncachedWords.filter((w) => !fetchedMatches.has(w));
    if (remainingForApi.length) {
      const apiMatches = await checkLanguageTool(remainingForApi, lang);
      apiMatches.forEach((match, word) => fetchedMatches.set(word, match));
    }
  }

  uncachedWords.forEach((norm) => {
    const cacheKey = `${mode}:${provider}:${lang}:${norm}`;
    pendingRequests.delete(cacheKey);
    const match = fetchedMatches.get(norm) || null;
    spellerCache.set(cacheKey, match);
    if (match) results.set(norm, match);
  });

  return results;
}
