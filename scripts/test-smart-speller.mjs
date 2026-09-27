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
