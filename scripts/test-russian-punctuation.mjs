import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { getSmartSpellerMatches } from '../src/core/smart-speller.js';
import { RUSSIAN_PUNCTUATION_CASES, RUSSIAN_PUNCTUATION_CONTROLS } from './fixtures/russian-punctuation-corpus.mjs';
import { RUSSIAN_GERUND_SINGLE_CASES } from './fixtures/russian-gerund-single-corpus.mjs';
import { RUSSIAN_GERUND_AMBIGUITY_CONTROLS } from './fixtures/russian-gerund-ambiguity-controls.mjs';
import { anyCorrectionPlan } from './qa/language-quality-contract.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/russian-punctuation'), results = [];
assert.equal(createHash('sha256').update(JSON.stringify({ cases: RUSSIAN_PUNCTUATION_CASES, controls: RUSSIAN_PUNCTUATION_CONTROLS })).digest('hex'), 'da82b4e71cf0228e38eb5e43d8e38446b62f4b1c3e68b1e3c511e9b6b52692b3');
assert.equal(createHash('sha256').update(JSON.stringify(RUSSIAN_GERUND_SINGLE_CASES)).digest('hex'), '8948f3f1d980b18780739c265743537e5c460efda6aefc3572881e4123761bf6');
await mkdir(directory, { recursive: true });
async function record(name, run) {
  try { results.push({ name, passed: true, ...await run() }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
}
const words = text => text.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || [];
const engine = (text, mode) => getSmartSpellerMatches(words(text), { mode, lang: 'ru', contextText: text });
const originalFetch = globalThis.fetch;
try {
  for (const mode of ['local', 'hybrid']) {
    globalThis.fetch = mode === 'local' ? () => { throw new Error('Offline punctuation must not use a remote service'); } : async () => ({ ok: true, json: async () => ({ matches: [] }) });
    for (const item of [...RUSSIAN_PUNCTUATION_CASES, ...RUSSIAN_GERUND_SINGLE_CASES]) await record(`${mode}/${item.id}`, async () => {
      const issues = (await engine(item.text, mode)).issues;
      assert.ok(anyCorrectionPlan(issues, item.text, [item.gold]), JSON.stringify({ text: item.text, gold: item.gold, issues }));
      assert.equal((await engine(item.gold, mode)).issues.length, 0, item.gold);
      return { position: item.position, text: item.text, gold: item.gold };
    });
    for (const [index, text] of [...RUSSIAN_PUNCTUATION_CONTROLS, ...RUSSIAN_GERUND_AMBIGUITY_CONTROLS].entries()) await record(`${mode}/negative-${index}`, async () => {
      assert.deepEqual((await engine(text, mode)).issues, [], text); return { text };
    });
  }
  await record('runtime does not read expected punctuation answers', async () => {
    for (const file of ['src/core/language-checker.js', 'src/core/smart-speller.js', 'scripts/build-language-lexicon.mjs']) assert.doesNotMatch(await readFile(file, 'utf8'), /scripts\/fixtures|russian-(?:punctuation|gerund|rule)-(?:corpus|single|provider)|Взяв свой член|Взяв свою книгу/u);
  });
} finally { globalThis.fetch = originalFetch; }
const summary = { passed: results.filter(item => item.passed).length, total: results.length, failed: results.filter(item => !item.passed).length, corpusSha256: createHash('sha256').update(JSON.stringify({ cases: RUSSIAN_PUNCTUATION_CASES, controls: RUSSIAN_PUNCTUATION_CONTROLS })).digest('hex') };
await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
for (const item of results.filter(item => !item.passed).slice(0, 5)) console.error(item.name, item.error);
if (summary.failed) process.exitCode = 1;
