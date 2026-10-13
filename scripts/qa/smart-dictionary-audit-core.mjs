import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { SMART_DICTIONARY_CORPUS, SMART_DICTIONARY_AUDIT_SEED } from '../fixtures/smart-dictionary-corpus.mjs';

const normalize = value => String(value).toLowerCase().replaceAll('ё', 'е');
const words = text => [...new Set((text.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || []).map(normalize))];
const caseOf = (source, value) => source === source.toUpperCase() ? value.toUpperCase() : source[0] === source[0]?.toUpperCase() ? value[0]?.toUpperCase() + value.slice(1) : value;

export function flattenSpellerIssues(result, text) {
  const issues = [...(Array.isArray(result?.issues) ? result.issues : [])];
  if (result instanceof Map) for (const [key, value] of result) {
    if (Array.isArray(value?.occurrences)) { issues.push(...value.occurrences); continue; }
    if (Number.isInteger(value?.start) && Number.isInteger(value?.end)) { issues.push(value); continue; }
    if (!value) continue;
    for (const token of text.matchAll(/\p{L}+(?:[’'\-]\p{L}+)*/gu)) if (normalize(token[0]) === key) {
      const suggestions = (value.suggestions || (typeof value.correct === 'string' ? [value.correct] : [])).map(candidate => value.preserveCase ? caseOf(token[0], candidate) : candidate);
      issues.push({ ...value, start: token.index, end: token.index + token[0].length, rawText: token[0], suggestions, correct: suggestions[0] });
    }
  }
  return issues.filter(issue => Number.isInteger(issue.start) && Number.isInteger(issue.end) && issue.start >= 0 && issue.end >= issue.start && issue.end <= text.length);
}

export function correctionMatches(issues, text, gold) {
  return issues.some(issue => (issue.suggestions || (typeof issue.correct === 'string' ? [issue.correct] : [])).some(replacement => gold.includes(text.slice(0, issue.start) + replacement + text.slice(issue.end))));
}

export function providerIssues(response) {
  return (response?.matches || []).map(match => ({ start: match.offset, end: match.offset + match.length, suggestions: (match.replacements || []).map(value => value.value), category: match.rule?.category?.id, issueType: match.rule?.issueType }));
}

let moduleId = 0;
async function freshEngine() { return (await import(`../../src/core/smart-speller.js?audit=${++moduleId}`)).getSmartSpellerMatches; }
export async function runCoreAudit(fixtures, record) {
  const originalFetch = globalThis.fetch;
  const byText = new Map(fixtures.map(item => [`${item.lang}:${item.text}`, item.response]));
  const language = code => code === 'auto' ? 'auto' : code.startsWith('ru') ? 'ru' : code.startsWith('uk') ? 'uk' : 'en';
  let requestCount = 0;
  globalThis.fetch = async (_url, options) => {
    requestCount++;
    const params = new URLSearchParams(options.body), text = params.get('text'), lang = language(params.get('language'));
    const data = byText.get(`${lang}:${text}`);
    assert.ok(data, `A recorded real provider response must exist for ${lang}: ${text}`);
    return { ok: true, json: async () => structuredClone(data) };
  };
  try {
    const engine = await freshEngine();
    for (const item of SMART_DICTIONARY_CORPUS) await record(`corpus/${item.id}`, 'core-quality', async () => {
      const response = byText.get(`${item.lang}:${item.text}`), result = await engine(words(item.text), { mode: 'hybrid', lang: item.lang, contextText: item.text });
      const issues = flattenSpellerIssues(result, item.text), provider = providerIssues(response);
      const found = item.expected === 'no-error' ? issues.length === 0 : correctionMatches(issues, item.text, item.gold);
      const providerFound = item.expected === 'no-error' ? provider.filter(issue => issue.issueType !== 'style').length === 0 : correctionMatches(provider, item.text, item.gold);
      return { passed: found, lang: item.lang, category: item.category, expected: item.expected, text: item.text, gold: item.gold, issues, providerFound, providerIssues: provider, error: found ? undefined : item.expected === 'no-error' ? 'False positive on a correct control sentence' : 'Expected correction is unavailable after the Nocturne adapter' };
    });

    await record('seeded/1000 exact Unicode occurrence mappings', 'core-safety', async () => {
      const engine = await freshEngine(), failures = [];
      let state = SMART_DICTIONARY_AUDIT_SEED;
      const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
      const suffix = value => { let text = ''; do { text = String.fromCharCode(97 + value % 26) + text; value = Math.floor(value / 26); } while (value); return text; };
      const prefixes = ['🙂 ', '👩‍👩‍👧‍👦 ', 'е\u0301 ', '«', '前文 ', 'العربية ', '\u2066prefix\u2069 ', 'First line.\n'];
      for (let index = 0; index < 1000; index++) {
        const token = `audittypo${suffix(index)}`, correct = `auditfixed${suffix(index)}`;
        const text = `${prefixes[random() % prefixes.length]}${token} — ${token.toUpperCase()}! ${'Обычный текст. '.repeat(random() % 8)}${token}.`;
        const expected = [...text.matchAll(new RegExp(token, 'giu'))].map(match => ({ start: match.index, end: match.index + match[0].length, rawText: match[0], correct: match[0] === match[0].toUpperCase() ? correct.toUpperCase() : correct }));
        globalThis.fetch = async (_url, options) => {
          const chunk = new URLSearchParams(options.body).get('text');
          return { ok: true, json: async () => ({ matches: [...chunk.matchAll(new RegExp(token, 'giu'))].map(match => ({ offset: match.index, length: match[0].length, replacements: [{ value: match[0] === match[0].toUpperCase() ? correct.toUpperCase() : correct }], rule: { issueType: 'misspelling', category: { id: 'TYPOS', name: 'Spelling' } } })) }) };
        };
        try {
          const found = flattenSpellerIssues(await engine([token], { mode: 'hybrid', contextText: text, lang: 'ru', localLookup: {} }), text);
          assert.deepEqual(found.map(({ start, end, rawText, correct }) => ({ start, end, rawText, correct })), expected);
        } catch (error) { if (failures.length < 25) failures.push({ index, text, expected, error: error.message }); }
      }
      return { passed: failures.length === 0, seed: SMART_DICTIONARY_AUDIT_SEED, generatedCases: 1000, mappedOccurrences: 3000, failures, error: failures.length ? 'Seeded occurrence mapping failed' : undefined };
    });

    for (const status of [429, 500, 503]) await record(`fault/HTTP ${status} retains local results`, 'core-reliability', async () => {
      const engine = await freshEngine();
      globalThis.fetch = async () => ({ ok: false, status, headers: new Headers({ 'Retry-After': '2' }) });
      const result = await engine(['вообщем', 'remoteunknown'], { mode: 'hybrid', contextText: 'Вообщем remoteunknown.', lang: 'ru' });
      assert.equal(result.get('вообщем')?.correct, 'в общем', 'An unavailable remote layer must not discard a valid local correction');
    });
    await record('fault/network rejection retains local results', 'core-reliability', async () => {
      const engine = await freshEngine(); globalThis.fetch = async () => { throw new TypeError('Network disconnected'); };
      const result = await engine(['вообщем', 'remoteunknown'], { mode: 'hybrid', contextText: 'Вообщем remoteunknown.', lang: 'ru' });
      assert.equal(result.get('вообщем')?.correct, 'в общем');
    });
    await record('fault/incomplete results never declare unchecked words clean', 'core-reliability', async () => {
      const engine = await freshEngine();
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ warnings: { incompleteResults: true }, matches: [] }) });
      const result = await engine(['uncheckedword'], { mode: 'hybrid', contextText: 'uncheckedword.', lang: 'en' });
      assert.equal(result.checkedWords?.has('uncheckedword'), false, 'A partial response is not proof that a word has been checked');
    });
    await record('fault/no suggestions still reports a known spelling error', 'core-quality', async () => {
      const engine = await freshEngine(); const text = 'Uncorrectableword.';
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ matches: [{ offset: 0, length: 17, replacements: [], rule: { issueType: 'misspelling', category: { id: 'TYPOS' } } }] }) });
      const issues = flattenSpellerIssues(await engine(['uncorrectableword'], { mode: 'hybrid', contextText: text, lang: 'en' }), text);
      assert.ok(issues.some(issue => issue.start === 0 && issue.end === 17), 'Absence of a replacement must not erase a confirmed diagnostic');
    });
    await record('fault/excessively long alternatives are rejected', 'core-safety', async () => {
      const engine = await freshEngine();
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ matches: [{ offset: 0, length: 9, replacements: [{ value: 'x'.repeat(8192) }], rule: { issueType: 'misspelling', category: { id: 'TYPOS' } } }] }) });
      const issues = flattenSpellerIssues(await engine(['typpotext'], { mode: 'hybrid', contextText: 'typpotext.', lang: 'en' }), 'typpotext.');
      assert.ok(issues.every(issue => (issue.suggestions || []).every(value => value.length <= 256)), 'A corrupted provider must not populate the menu with an 8192-character replacement');
    });
    await record('fault/invalid ranges and HTML replacements never become corrections', 'core-safety', async () => {
      const engine = await freshEngine(), text = 'safetytoken.';
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ matches: [
        { offset: -1, length: 3, replacements: [{ value: 'wrong' }] }, { offset: .5, length: 3, replacements: [{ value: 'wrong' }] },
        { offset: 0, length: 999, replacements: [{ value: 'wrong' }] }, { offset: 0, length: 11, replacements: [{ value: '<script>alert(1)</script>' }] },
      ] }) });
      assert.equal(flattenSpellerIssues(await engine(['safetytoken'], { mode: 'hybrid', contextText: text, lang: 'en' }), text).length, 0);
    });
    await record('fault/timeout cancels a hung provider within the documented 12-second bound', 'core-reliability', async () => {
      const engine = await freshEngine(), started = performance.now(); let reason;
      globalThis.fetch = async (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { reason = options.signal.reason; reject(reason); }, { once: true }));
      await engine(['timeoutword'], { mode: 'hybrid', contextText: 'timeoutword.', lang: 'en' }).catch(() => {});
      assert.equal(reason?.name, 'TimeoutError');
      const durationMs = Math.round(performance.now() - started); assert.ok(durationMs >= 11500 && durationMs < 15000); return { durationMs };
    });
    await record('cache/abort prevents obsolete data entering a later request', 'core-safety', async () => {
      const engine = await freshEngine(), controller = new AbortController(); let release, requests = 0;
      globalThis.fetch = async () => { const count = ++requests; if (count === 1) await new Promise(resolve => { release = resolve; }); return { ok: true, json: async () => ({ matches: [{ offset: 0, length: 9, replacements: [{ value: count === 1 ? 'obsolete' : 'current' }] }] }) }; };
      const pending = engine(['abortword'], { mode: 'hybrid', contextText: 'abortword.', signal: controller.signal }); controller.abort(); release();
      await assert.rejects(pending, { name: 'AbortError' });
      assert.equal((await engine(['abortword'], { mode: 'hybrid', contextText: 'abortword.' })).get('abortword')?.correct, 'current'); assert.equal(requests, 2);
    });
    await record('cache/concurrent identical checks share one provider request', 'core-efficiency', async () => {
      const engine = await freshEngine(); let requests = 0;
      globalThis.fetch = async () => { requests++; await new Promise(resolve => setTimeout(resolve, 25)); return { ok: true, json: async () => ({ matches: [] }) }; };
      await Promise.all(Array.from({ length: 8 }, () => engine(['concurrentword'], { mode: 'hybrid', contextText: 'concurrentword.', lang: 'en' })));
      assert.equal(requests, 1, 'Identical in-flight checks must be coalesced');
    });
    await record('cache/repeated negative result performs no second network request', 'core-efficiency', async () => {
      const engine = await freshEngine(); let requests = 0;
      globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({ matches: [] }) }; };
      for (let i = 0; i < 20; i++) await engine(['cachedword'], { mode: 'hybrid', contextText: 'cachedword.', lang: 'en' });
      assert.equal(requests, 1);
    });
    await record('priority/user overrides and protected words beat remote alternatives', 'core-safety', async () => {
      const engine = await freshEngine(); let requests = 0;
      globalThis.fetch = async () => { requests++; return { ok: true, json: async () => ({ matches: [] }) }; };
      const result = await engine(['authorword', 'protectedword'], { mode: 'hybrid', contextText: 'Authorword protectedword.', lang: 'en', ignoredWords: new Set(['protectedword']), localLookup: { authorword: { correct: 'МОЙ ВАРИАНТ', source: 'user' } } });
      assert.equal(result.get('authorword')?.correct, 'МОЙ ВАРИАНТ'); assert.equal(result.has('protectedword'), false); assert.equal(requests, 0);
    });
    await record('window/20k text keeps distant repeated occurrences and request boundaries', 'core-safety', async () => {
      const engine = await freshEngine(), text = `windowtypo. ${'Обычный текст. '.repeat(650)}WINDOWTYPO. ${'Обычный текст. '.repeat(650)}windowtypo.`, chunks = [];
      globalThis.fetch = async (_url, options) => { const chunk = new URLSearchParams(options.body).get('text'); chunks.push(chunk); return { ok: true, json: async () => ({ matches: [...chunk.matchAll(/windowtypo/giu)].map(match => ({ offset: match.index, length: 10, replacements: [{ value: match[0] === match[0].toUpperCase() ? 'CORRECTION' : 'correction' }] })) }) }; };
      const issues = flattenSpellerIssues(await engine(['windowtypo'], { mode: 'hybrid', contextText: text, lang: 'en' }), text);
      assert.deepEqual(issues.map(issue => issue.start), [0, text.indexOf('WINDOWTYPO'), text.lastIndexOf('windowtypo')]); assert.ok(chunks.every(chunk => chunk.length <= 4000)); return { textLength: text.length, chunks: chunks.map(value => value.length) };
    });
    await record('window/oversized token never bypasses the 4000-character request limit', 'core-safety', async () => {
      const engine = await freshEngine(), token = 'x'.repeat(10000), chunks = [];
      globalThis.fetch = async (_url, options) => { const text = new URLSearchParams(options.body).get('text'); chunks.push(text.length); return { ok: true, json: async () => ({ matches: [] }) }; };
      await engine([token, 'adress'], { mode: 'hybrid', contextText: `${token} adress.`, lang: 'en' });
      assert.ok(chunks.every(length => length <= 4000), `Requests exceed the configured window: ${chunks.join(', ')}`); return { chunks };
    });
    return { corpusRequests: requestCount };
  } finally { globalThis.fetch = originalFetch; }
}
