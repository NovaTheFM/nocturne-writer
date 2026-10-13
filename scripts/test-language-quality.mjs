import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { getSmartSpellerMatches } from '../src/core/smart-speller.js';
import { createDictionaryMembership, dictionaryContains } from '../src/core/language-data/membership.js';
import { LANGUAGE_QUALITY_CASES, LANGUAGE_QUALITY_CONTROLS } from './fixtures/language-quality-corpus.mjs';
import { LANGUAGE_QUALITY_HOLDOUT } from './fixtures/language-quality-holdout.mjs';
import { anyCorrectionPlan } from './qa/language-quality-contract.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/language-quality');
const spellingTransfer = JSON.parse(await readFile(new URL('./fixtures/language-spelling-transfer.json', import.meta.url), 'utf8'));
const spellingValidation = JSON.parse(await readFile(new URL('./fixtures/language-spelling-source-validation.json', import.meta.url), 'utf8'));
assert.equal(spellingTransfer.corpusSha256, createHash('sha256').update(JSON.stringify(spellingTransfer.cases)).digest('hex'));
assert.equal(spellingTransfer.corpusSha256, '454fa0bfa6594ae10ec393c409de6f2bf55121648dfe19fb9effaa616a5dd8c5');
assert.equal(spellingValidation.originalCorpusSha256, spellingTransfer.corpusSha256);
assert.equal(createHash('sha256').update(JSON.stringify(spellingValidation.cases)).digest('hex'), '040d10c7b30a3637aa61251bba6fe5aa2c94df6234e46cb0c2b92abe9166d52c');
const referenceWords = new Map(spellingValidation.cases.map(item => [item.id, item]));
assert.equal(referenceWords.size, spellingTransfer.cases.length);
for (const item of spellingTransfer.cases) {
  const reference = referenceWords.get(item.id);
  assert.equal(reference.word, item.correct);
  assert.equal(reference.lang, item.lang);
  assert.ok(reference.tags.length && reference.tags.every(Boolean));
  assert.equal(reference.valid, reference.tags.some(tag => !/(?:^|:)bad(?::|$)/u.test(tag)));
}
assert.equal(createHash('sha256').update(JSON.stringify(LANGUAGE_QUALITY_CASES)).digest('hex'), '86c5d6aed41561a201ec9e5238581f42ffe02f0e57a7f06c98f0322a0844c2f0');
assert.equal(createHash('sha256').update(JSON.stringify(LANGUAGE_QUALITY_HOLDOUT)).digest('hex'), 'c79445cbddc3fe75119fa0592dc886cf8a0717997226742c7bce97738dbbb6af');
await mkdir(directory, { recursive: true });
const results = [], started = performance.now(), originalFetch = globalThis.fetch;
const words = text => [...new Set((text.match(/\p{L}[\p{L}\p{M}]*(?:[’'\-][\p{L}\p{M}]+)*/gu) || []).map(word => word.normalize('NFC').toLowerCase().replaceAll('ё', 'е')))];
const engine = (text, lang, mode = 'local', options = {}) => getSmartSpellerMatches(words(text), { mode, lang, contextText: text, ...options });
async function record(name, gate, run) {
  const start = performance.now();
  try { const evidence = await run() || {}; results.push({ name, gate, passed: true, durationMs: Math.round(performance.now() - start), ...evidence }); }
  catch (error) { results.push({ name, gate, passed: false, durationMs: Math.round(performance.now() - start), error: error.stack }); }
}
async function quality(item, mode, gate) {
  await record(`${mode}/${item.id}`, gate, async () => {
    const result = await engine(item.text, item.lang, mode), issues = result.issues || [];
    if (item.expected === 'no-error') assert.equal(issues.length, 0, JSON.stringify({ text: item.text, issues }));
    else assert.ok(anyCorrectionPlan(issues, item.text, item.gold), JSON.stringify({ text: item.text, gold: item.gold, issues }));
    const plan = item.expected === 'correction' && anyCorrectionPlan(issues, item.text, item.gold);
    return { lang: item.lang, category: item.category, expected: item.expected, issueCount: issues.length, firstSuggestionMatchesGold: plan ? plan.plan.every(issue => issue.suggestions[0] === issue.correct) : undefined };
  });
}
try {
  globalThis.fetch = () => { throw new Error('Offline language checking must not use a remote service'); };
  for (const item of [...LANGUAGE_QUALITY_CASES, ...LANGUAGE_QUALITY_CONTROLS]) await quality(item, 'local', 'frozen-600');
  console.log(`Frozen offline: ${results.filter(item => item.passed).length}/${results.length}`);
  for (const item of LANGUAGE_QUALITY_HOLDOUT) await quality(item, 'local', 'unseen-vocabulary');
  for (const lang of ['ru', 'uk', 'en']) {
    let membership;
    const items = LANGUAGE_QUALITY_CASES.filter(item => item.lang === lang);
    for (let index = 0; index < items.length; index += 10) await record(`compound/${lang}/${index}`, 'multiple-errors', async () => {
      const batch = items.slice(index, index + 10), text = batch.map(item => item.text).join('\n'), result = await engine(text, lang);
      let offset = 0, edits = 0;
      for (const item of batch) {
        const issues = result.issues.filter(issue => issue.start >= offset && issue.end <= offset + item.text.length).map(issue => ({ ...issue, start: issue.start - offset, end: issue.end - offset }));
        const plan = anyCorrectionPlan(issues, item.text, item.gold);
        assert.ok(plan, JSON.stringify({ text: item.text, issues })); edits += plan.plan.length;
        offset += item.text.length + 1;
      }
      return { lang, errors: batch.length, edits };
    });
    await record(`membership/${lang}/100000 exact forms`, 'dictionary-integrity', async () => {
      const packed = (await import(`../src/core/language-data/${lang}.mjs`)).default;
      const data = JSON.parse(gunzipSync(Buffer.from(packed, 'base64')));
      membership = createDictionaryMembership(Buffer.from(data.membership.encoded, 'base64'));
      const stride = Math.max(1, Math.floor(data.forms.length / 100000)); let checked = 0;
      for (let index = 0; index < data.forms.length; index += stride) { const word = data.forms[index][0].toLowerCase().replaceAll('ё', 'е'); assert.equal(dictionaryContains(membership, word), true, word); checked++; }
      for (let index = 0; index < 1000; index++) assert.equal(dictionaryContains(membership, `\u0001not-a-word-${index}`), false);
      return { lang, positiveForms: checked, negativeForms: 1000 };
    });
    for (const item of spellingTransfer.cases.filter(item => item.lang === lang)) for (const casing of ['lower', 'title', 'upper']) {
      const convert = value => casing === 'upper' ? value.toUpperCase() : casing === 'title' ? value[0].toUpperCase() + value.slice(1) : value;
      const prefix = lang === 'en' ? 'Word: ' : 'Слово: ', text = prefix + convert(item.wrong) + '.', gold = prefix + convert(item.correct) + '.';
      if (!referenceWords.get(item.id).valid) {
        await record(`invalid-reference/${item.id}/${casing}`, 'invalid-reference-safety', async () => {
          assert.equal(dictionaryContains(membership, item.correct), false);
          const result = await engine(text, lang);
          for (const issue of result.issues) for (const suggestion of issue.suggestions) assert.notEqual(suggestion.toLowerCase(), item.correct);
          return { lang, casing, originalText: text, invalidGold: gold, sourceTags: referenceWords.get(item.id).tags, correctionVerified: false };
        });
        continue;
      }
      await record(`unseen-spelling/${item.id}/${casing}`, 'seeded-spelling-transfer', async () => {
        assert.ok(anyCorrectionPlan((await engine(text, lang)).issues, text, [gold]), `${text} -> ${gold}`);
        assert.equal((await engine(gold, lang)).issues.length, 0, gold);
        return { lang, casing };
      });
    }
  }
  await record('runtime never imports a test oracle', 'isolation', async () => {
    for (const file of ['src/core/language-checker.js', 'src/core/smart-speller.js', 'scripts/build-language-lexicon.mjs', 'scripts/language-tools/ExportMorphology.java']) assert.doesNotMatch(await readFile(file, 'utf8'), /language-quality-corpus|language-quality-holdout|smart-dictionary-corpus|smart-dictionary-provider|language-spelling-transfer/u);
    return { corpusSha256: createHash('sha256').update(JSON.stringify(LANGUAGE_QUALITY_CASES)).digest('hex'), holdoutSha256: createHash('sha256').update(JSON.stringify(LANGUAGE_QUALITY_HOLDOUT)).digest('hex') };
  });
  await record('long manuscript preserves ranges and responds to cancellation', 'stress', async () => {
    const paragraph = 'Она увидела белый дом. Мы вернулись домой.\n', text = paragraph.repeat(6000) + 'Она купил хлеб.\nЯ знаю что он придёт.';
    const before = performance.now(), result = await engine(text, 'ru'), expected = 'Она купила хлеб.\nЯ знаю, что он придёт.';
    const offset = text.length - 'Она купил хлеб.\nЯ знаю что он придёт.'.length;
    const issues = result.issues.map(issue => ({ ...issue, start: issue.start - offset, end: issue.end - offset }));
    assert.ok(anyCorrectionPlan(issues, text.slice(offset), [expected]));
    assert.equal(result.issues.filter(issue => issue.start < offset).length, 0);
    const elapsed = performance.now() - before; assert.ok(elapsed < 15000, `250k text took ${elapsed}ms`);
    const controller = new AbortController();
    const checking = engine(text, 'ru', 'local', { signal: controller.signal }); controller.abort();
    await assert.rejects(checking, { name: 'AbortError' });
    return { characters: text.length, durationMs: Math.round(elapsed) };
  });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ matches: [] }) });
  for (const item of [...LANGUAGE_QUALITY_CASES, ...LANGUAGE_QUALITY_CONTROLS]) await quality(item, 'hybrid', 'empty-online-layer');
} finally { globalThis.fetch = originalFetch; }
await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
const summary = { passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, durationMs: Math.round(performance.now() - started), spellingReferences: { valid: spellingValidation.cases.filter(item => item.valid).length, invalid: spellingValidation.cases.filter(item => !item.valid) }, referenceNote: 'Invalid references are safety checks, not successful spelling corrections', groups: {} };
for (const gate of new Set(results.map(item => item.gate))) summary.groups[gate] = { passed: results.filter(item => item.gate === gate && item.passed).length, failed: results.filter(item => item.gate === gate && !item.passed).length };
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
for (const item of results.filter(item => !item.passed).slice(0, 18)) console.error(item.name, item.error);
if (summary.failed) process.exitCode = 1;
