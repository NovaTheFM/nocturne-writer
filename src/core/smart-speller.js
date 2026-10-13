import { normalizeTypoToken, TYPO_LOOKUP } from './typos.js';
import { checkLanguageTextAsync } from './language-checker-client.js';
import { CLASSICAL_LANGUAGE_RULES } from './language-data/classical-rules.js';
import { inferLanguage } from './language-detection.js';

const cache = new Map(), pending = new Map(), cooldowns = new Map();
const languageCodes = { uk: 'uk-UA', ru: 'ru-RU', en: 'en-US' };
const tokens = text => [...text.matchAll(/\p{L}[\p{L}\p{M}]*(?:[’'\-][\p{L}\p{M}]+)*/gu)];
const normalize = word => normalizeTypoToken(word.normalize('NFC'));
const endpoint = 'https://api.languagetool.org/v2/check';

function editDistance(left, right) {
  if (left.length > 40 || right.length > 40) return Math.abs(left.length - right.length);
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const row = [i];
    for (let j = 1; j <= right.length; j++) row[j] = Math.min(row[j - 1] + 1, previous[j] + 1, previous[j - 1] + Number(left[i - 1] !== right[j - 1]));
    previous = row;
  }
  return previous[right.length];
}

function localMatches(words, lookup) {
  return new Map(words.filter(word => lookup[word]?.correct && normalize(lookup[word].correct) !== word).map(word => [word, {
    ...lookup[word], suggestions: [lookup[word].correct], source: 'local', preserveCase: !['user', 'override'].includes(lookup[word].source),
  }]));
}

function localOccurrences(text, matches) {
  return tokens(text).flatMap(match => {
    const entry = matches.get(normalize(match[0]));
    if (!entry) return [];
    let correct = entry.correct;
    if (entry.preserveCase) {
      if (match[0] === match[0].toUpperCase()) correct = correct.toUpperCase();
      else if (match[0][0] === match[0][0].toUpperCase()) correct = correct[0].toUpperCase() + correct.slice(1);
    }
    return [{ start: match.index, end: match.index + match[0].length, rawText: match[0], correct, suggestions: [correct], label: entry.label || 'Словарь ошибок', ruleId: entry.id || 'author-typo-dictionary', category: 'spelling', source: 'local' }];
  });
}

function contextualChecks(words, text) {
  if (!words.length) return [];
  text ||= words.join(' ');
  if (text.length <= 4000) return [{ words, text, segments: [{ start: 0, end: text.length, offset: 0 }] }];
  const requested = new Set(words), windows = [];
  for (const match of tokens(text)) {
    if (!requested.has(normalize(match[0]))) continue;
    let start = Math.max(0, match.index - 180), end = Math.min(text.length, match.index + match[0].length + 180);
    if (end - start > 4000) end = start + 4000;
    while (start > 0 && /[^\s.!?…]/u.test(text[start - 1]) && match.index - start < 400 && end - start < 4000) start--;
    while (end < text.length && /[^\s.!?…]/u.test(text[end]) && end - match.index < 800 && end - start < 4000) end++;
    const previous = windows.at(-1);
    if (previous && start <= previous.end && end - previous.start <= 4000) previous.end = Math.max(previous.end, end);
    else windows.push({ start, end });
  }
  const chunks = [];
  for (const window of windows) {
    const snippet = text.slice(window.start, window.end);
    let chunk = chunks.at(-1);
    if (!chunk || chunk.text.length + snippet.length + 1 > 4000) { chunk = { text: '', segments: [] }; chunks.push(chunk); }
    if (chunk.text) chunk.text += '\n';
    chunk.segments.push({ ...window, offset: chunk.text.length }); chunk.text += snippet;
  }
  return chunks.map(chunk => {
    const present = new Set(tokens(chunk.text).map(match => normalize(match[0])));
    return { ...chunk, words: words.filter(word => present.has(word)) };
  });
}

function validReplacement(value) {
  return typeof value === 'string' && value.length <= 256 && !/[<>\u0000-\u0008\u000b-\u001f\u007f]/u.test(value);
}

async function requestMatches(text, lang, controller, url) {
  const language = languageCodes[lang] ? lang : inferLanguage(text);
  const enabledRules = CLASSICAL_LANGUAGE_RULES[language];
  const permittedRules = new Set(enabledRules);
  const timer = setTimeout(() => controller.abort(new DOMException('Время ожидания проверки словаря истекло.', 'TimeoutError')), 12_000);
  try {
    const response = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ text, language: languageCodes[language], enabledOnly: 'true', enabledRules: enabledRules.join(',') }).toString(), signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 429) {
        const retry = response.headers?.get?.('retry-after'), seconds = Number(retry);
        cooldowns.set(url, Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Math.max(2000, Date.parse(retry) - Date.now() || 30_000)));
      }
      throw new Error(`Онлайн-проверка недоступна (${response.status}). Локальные правила продолжают работать.`);
    }
    const data = await response.json(), issues = [];
    for (const match of (Array.isArray(data.matches) ? data.matches : []).slice(0, 2000)) {
      if (!Number.isInteger(match.offset) || !Number.isInteger(match.length) || match.offset < 0 || match.length < 0 || match.offset + match.length > text.length) continue;
      if (match.rule?.issueType === 'style' || ['STYLE', 'REPETITIONS_STYLE', 'REDUNDANCY'].includes(match.rule?.category?.id)) continue;
      if (match.rule?.isPremium || /(?:^|_)AI(?:_|$)|NEURAL|GPT|LLM/iu.test(match.rule?.id || '')) continue;
      if (match.rule?.id && !permittedRules.has(match.rule.id)) continue;
      if (!Array.isArray(match.replacements)) continue;
      const rawText = text.slice(match.offset, match.offset + match.length), spelling = match.rule?.issueType === 'misspelling' || !match.rule?.issueType;
      const values = match.replacements.slice(0, 64).map(item => item?.value).filter(validReplacement);
      const suggestions = [...new Set(values.filter(value => value !== rawText && (!spelling || !value.includes(' ') || normalize(value.replaceAll(' ', '')) === normalize(rawText))))].slice(0, 20);
      if (values.length && !suggestions.length || match.replacements.length && !values.length) continue;
      if (spelling && !/^\p{L}[\p{L}\p{M}]*(?:[’'\-][\p{L}\p{M}]+)*$/u.test(rawText)) continue;
      issues.push({ start: match.offset, end: match.offset + match.length, rawText, correct: suggestions[0], suggestions, label: typeof match.rule?.category?.name === 'string' ? match.rule.category.name.slice(0, 160) : 'Возможная ошибка', message: typeof match.message === 'string' ? match.message.slice(0, 1000) : undefined, issueType: match.rule?.issueType, ruleId: match.rule?.id, source: 'online' });
    }
    controller.signal.throwIfAborted();
    return { issues, incomplete: !!data.warnings?.incompleteResults };
  } finally { clearTimeout(timer); }
}

function sharedRequest(text, lang, consumerSignal, url) {
  consumerSignal?.throwIfAborted();
  const key = JSON.stringify([url, lang, text]), cached = cache.get(key);
  if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value);
  if ((cooldowns.get(url) || 0) > Date.now()) return Promise.reject(new Error('Онлайн-проверка временно ограничена сервисом. Локальные правила продолжают работать.'));
  let entry = pending.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, users: new Set() };
    // Start transport before loading dictionaries so immediate cancellation also cancels the request.
    entry.promise = requestMatches(text, lang, controller, url).then(value => {
      controller.signal.throwIfAborted(); cache.set(key, { value, expires: Date.now() + 300_000 });
      while (cache.size > 128) cache.delete(cache.keys().next().value);
      return value;
    }).finally(() => { if (pending.get(key) === entry) pending.delete(key); });
    pending.set(key, entry);
  }
  const subscriber = {};
  entry.users.add(subscriber);
  return new Promise((resolve, reject) => {
    const release = () => {
      consumerSignal?.removeEventListener('abort', abort); entry.users.delete(subscriber);
      if (!entry.users.size && pending.get(key) === entry) { pending.delete(key); entry.controller.abort(consumerSignal?.reason); }
    };
    const abort = () => { release(); reject(consumerSignal.reason); };
    consumerSignal?.addEventListener('abort', abort, { once: true });
    entry.promise.then(value => { release(); resolve(value); }, error => { release(); reject(error); });
  });
}

async function localContext(text, options) {
  const issues = [];
  let offset = 0;
  for (const paragraph of text.split('\n')) {
    let start = 0;
    while (start < paragraph.length) {
      options.signal?.throwIfAborted();
      let end = Math.min(paragraph.length, start + 4000);
      if (end < paragraph.length) {
        const boundary = paragraph.slice(start, end).search(/[.!?…]\s+[^.!?…]*$/u);
        if (boundary > 0) end = start + boundary + 1;
        else { const space = paragraph.lastIndexOf(' ', end); if (space > start) end = space; }
      }
      const fragment = paragraph.slice(start, end);
      for (const issue of await checkLanguageTextAsync(fragment, { ...options, sentenceStart: start === 0 || /[.!?…]\s*$/u.test(paragraph.slice(0, start)) })) issues.push({ ...issue, start: offset + start + issue.start, end: offset + start + issue.end });
      start = end;
      if (paragraph.length > 4000) await new Promise(resolve => setTimeout(resolve, 0));
    }
    offset += paragraph.length + 1;
  }
  return issues;
}

export async function getSmartSpellerMatches(words, options = {}) {
  options.signal?.throwIfAborted();
  const mode = options.mode || 'local', lang = options.lang || 'auto', lookup = options.localLookup ?? TYPO_LOOKUP;
  const ignored = new Set(Array.from(options.ignoredWords || [], normalize));
  const normalized = [...new Set(words.map(normalize).filter(word => word && !ignored.has(word)))];
  const text = String(options.contextText || ''), present = new Set(tokens(text).map(match => normalize(match[0])));
  const checked = normalized.filter(word => !text || present.has(word));
  const localWords = mode === 'api' ? checked.filter(word => ['user', 'override'].includes(lookup[word]?.source)) : checked;
  const result = localMatches(localWords, lookup), remaining = checked.filter(word => !result.has(word));
  const contexts = mode === 'local' ? [] : contextualChecks(remaining, text);
  const requests = contexts.map(context => sharedRequest(context.text, lang, options.signal, options.endpoint || endpoint).then(value => ({ context, value }), error => ({ context, error })));
  let issues = localOccurrences(text, result), localFailed = false;
  if (text && mode !== 'api' && (checked.length || !normalized.length && !ignored.size)) {
    try { issues = await localContext(text, { ...options, lang, requestedWords: new Set(checked) }); }
    catch (error) {
      options.signal?.throwIfAborted(); localFailed = true;
      result.degraded = 'Не удалось загрузить языковой словарь. Авторские и встроенные исправления остаются доступны.';
    }
  }
  const responses = await Promise.all(requests);
  options.signal?.throwIfAborted();
  let incomplete = localFailed;
  for (const { context, value, error } of responses) {
    if (error) { if (mode === 'api') throw error; result.degraded = error.message; incomplete = true; continue; }
    incomplete ||= value.incomplete;
    for (const occurrence of value.issues) {
      const segment = context.segments.find(segment => occurrence.start >= segment.offset && occurrence.end <= segment.offset + segment.end - segment.start);
      if (!segment) continue;
      const start = segment.start + occurrence.start - segment.offset, end = segment.start + occurrence.end - segment.offset;
      if (tokens(text.slice(start, end)).some(match => ignored.has(normalize(match[0])) || ['user', 'override'].includes(lookup[normalize(match[0])]?.source))) continue;
      const word = normalize(occurrence.rawText);
      if ((occurrence.issueType === 'misspelling' || !occurrence.issueType) && !checked.includes(word)) continue;
      const suggestions = [...occurrence.suggestions], preferred = lookup[word]?.correct;
      if (occurrence.issueType === 'misspelling' || !occurrence.issueType) suggestions.sort((a, b) => Number(b === preferred) - Number(a === preferred) || editDistance(word, normalize(a)) - editDistance(word, normalize(b)));
      const existing = issues.find(issue => issue.start === start && issue.end === end);
      if (existing) { existing.suggestions = [...new Set([...existing.suggestions, ...suggestions])]; continue; }
      if (issues.some(issue => issue.source === 'rules' && start < issue.end && end > issue.start)) continue;
      issues.push({ ...occurrence, start, end, suggestions, correct: suggestions[0] });
    }
  }
  result.issues = issues.sort((a, b) => a.start - b.start || b.end - a.end);
  for (const issue of result.issues) {
    const word = normalize(issue.rawText);
    if (!checked.includes(word) || !/^\p{L}[\p{L}\p{M}]*(?:[’'\-][\p{L}\p{M}]+)*$/u.test(issue.rawText)) continue;
    if (!result.has(word)) result.set(word, { ...issue, occurrences: [] });
    const entry = result.get(word); entry.occurrences ||= []; entry.occurrences.push(issue);
  }
  result.checkedWords = new Set(incomplete ? checked.filter(word => result.has(word)) : checked);
  return result;
}
