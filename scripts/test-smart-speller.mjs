import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getSmartSpellerMatches } from '../src/core/smart-speller.js';

test('offline dictionary detects known errors without network requests or invented guesses', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected network access'); };
  try {
    const matches = await getSmartSpellerMatches(['вообщем', 'сдесь', 'НоcturneUnknownName'], { mode: 'local' });
    assert.equal(matches.get('вообщем')?.correct, 'в общем');
    assert.equal(matches.get('сдесь')?.correct, 'здесь');
    assert.equal(matches.has('ноcturneunknownname'), false);
  } finally { globalThis.fetch = fetchBefore; }
});

test('failed online checks remain retryable and receive contextual sentences', async () => {
  const fetchBefore = globalThis.fetch; let requests = 0, received = '';
  globalThis.fetch = async (_url, options) => {
    received = new URLSearchParams(options.body).get('text');
    if (++requests === 1) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ matches: [{ offset: 5, length: 7, replacements: [{ value: 'word' }], rule: { category: { name: 'Spelling' } } }] }) };
  };
  try {
    const options = { mode: 'api', contextText: 'This mistype sentence needs context.' };
    await assert.rejects(getSmartSpellerMatches(['mistype'], options));
    assert.equal((await getSmartSpellerMatches(['mistype'], options)).get('mistype')?.correct, 'word');
    assert.equal(received, options.contextText); assert.equal(requests, 2);
  } finally { globalThis.fetch = fetchBefore; }
});

test('Smart uses the effective dictionary and does not reuse cached builtin replacements', async () => {
  await getSmartSpellerMatches(['вообщем'], { mode: 'local' });
  assert.equal((await getSmartSpellerMatches(['вообщем'], { mode: 'local', localLookup: {} })).has('вообщем'), false);
  const localLookup = { вообщем: { correct: 'в целом', label: 'Авторское правило' } };
  assert.equal((await getSmartSpellerMatches(['вообщем'], { mode: 'local', localLookup })).get('вообщем')?.correct, 'в целом');
  localLookup.вообщем.correct = 'в общем-то';
  assert.equal((await getSmartSpellerMatches(['вообщем'], { mode: 'local', localLookup })).get('вообщем')?.correct, 'в общем-то');
});

test('disabled rules and protected names remain ignored in every Smart mode', async () => {
  const fetchBefore = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Ignored words must not trigger a request'); };
  try {
    for (const mode of ['local', 'hybrid', 'api']) {
      const matches = await getSmartSpellerMatches(['Вообщем', 'NocturneName'], { mode, ignoredWords: new Set(['вообщем', 'nocturnename']), contextText: 'Вообщем NocturneName.' });
      assert.equal(matches.size, 0);
    }
  } finally { globalThis.fetch = fetchBefore; }
});

test('online Smart checks requested words beyond the first 4000 characters', async () => {
  const fetchBefore = globalThis.fetch, requests = [];
  globalThis.fetch = async (_url, options) => {
    const text = new URLSearchParams(options.body).get('text'); requests.push(text);
    const matches = [...text.matchAll(/tailmistype|frontmistype/gu)].map(match => ({ offset: match.index, length: match[0].length, replacements: [{ value: 'correct' }] }));
    return { ok: true, json: async () => ({ matches }) };
  };
  try {
    const matches = await getSmartSpellerMatches(['frontmistype', 'tailmistype'], { mode: 'api', contextText: `A frontmistype sentence. ${'ordinary text. '.repeat(600)}A tailmistype sentence.` });
    assert.equal(matches.get('frontmistype')?.correct, 'correct');
    assert.equal(matches.get('tailmistype')?.correct, 'correct');
    assert.ok(requests.every(text => text.length <= 4000));
    assert.ok(requests.some(text => text.includes('A tailmistype sentence.')));
  } finally { globalThis.fetch = fetchBefore; }
});

test('a cancelled Smart response cannot populate the shared result cache', async () => {
  const fetchBefore = globalThis.fetch, controller = new AbortController();
  let release, requests = 0;
  globalThis.fetch = async () => {
    requests++;
    if (requests === 1) await new Promise(resolve => { release = resolve; });
    return { ok: true, json: async () => ({ matches: [{ offset: 0, length: 12, replacements: [{ value: requests === 1 ? 'obsolete' : 'current' }] }] }) };
  };
  try {
    const options = { mode: 'api', contextText: 'abortmistype sentence.' };
    const pending = getSmartSpellerMatches(['abortmistype'], { ...options, signal: controller.signal });
    controller.abort(); release();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal((await getSmartSpellerMatches(['abortmistype'], options)).get('abortmistype')?.correct, 'current');
    assert.equal(requests, 2);
  } finally { globalThis.fetch = fetchBefore; }
});
