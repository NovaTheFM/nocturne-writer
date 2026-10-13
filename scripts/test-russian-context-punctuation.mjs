import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getSmartSpellerMatches } from '../src/core/smart-speller.js';
import { CONTEXT_PUNCTUATION_CASES, CONTEXT_PUNCTUATION_CONTROLS } from './fixtures/russian-context-punctuation.mjs';
import { USER_PUNCTUATION_TEXT, USER_REQUIRED_CORRECTIONS } from './fixtures/russian-user-punctuation.mjs';
import { CONTEXT_HOLDOUT_CASES, CONTEXT_HOLDOUT_CONTROLS } from './fixtures/russian-context-holdout.mjs';
import { CONTEXT_SOURCE_VALIDATION, CONTEXT_CONTROL_SOURCE_VALIDATION, validatedContextCase, validatedContextControl } from './fixtures/russian-context-source-validation.mjs';
import { CONTEXT_EDGE_CASES, CONTEXT_EDGE_CONTROLS } from './fixtures/russian-context-edges.mjs';
import { USER_EXTRA_CORRECTIONS } from './fixtures/russian-user-extra-corrections.mjs';
import { anyCorrectionPlan } from './qa/language-quality-contract.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/russian-context-punctuation'), results = [];
await mkdir(directory, { recursive: true });
assert.equal(createHash('sha256').update(JSON.stringify({ cases: CONTEXT_PUNCTUATION_CASES, controls: CONTEXT_PUNCTUATION_CONTROLS, user: USER_PUNCTUATION_TEXT, required: USER_REQUIRED_CORRECTIONS })).digest('hex'), 'b8d115a6dfc18cbb2e2b97b262d134e6ec7a0dcad88124a8e6fe16f2cce7e26f');
const supplementalSha256 = createHash('sha256').update(JSON.stringify({ cases: CONTEXT_HOLDOUT_CASES, controls: CONTEXT_HOLDOUT_CONTROLS, edges: CONTEXT_EDGE_CASES, edgeControls: CONTEXT_EDGE_CONTROLS, validation: CONTEXT_SOURCE_VALIDATION, controlValidation: CONTEXT_CONTROL_SOURCE_VALIDATION, extra: USER_EXTRA_CORRECTIONS })).digest('hex');
assert.equal(supplementalSha256, 'e6ec636113c94dd60f2fa1785f78a28c579a084d6b68b2a63fa6c65c449c2d18');
const originalFetch = globalThis.fetch;
const run = async (text, mode) => {
  const result = await getSmartSpellerMatches(text.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || [], { mode, lang: 'ru', contextText: text });
  assert.ok(!result.degraded, result.degraded);
  return result;
};
async function record(name, work) {
  try { results.push({ name, passed: true, ...await work() }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
}
try {
  for (const mode of ['local', 'hybrid']) {
    globalThis.fetch = mode === 'local' ? () => { throw new Error('Offline checker requested a provider'); } : async () => ({ ok: true, json: async () => ({ matches: [] }) });
    for (const item of CONTEXT_PUNCTUATION_CASES.map(validatedContextCase)) await record(`${mode}/${item.id}`, async () => {
      const issues = (await run(item.text, mode)).issues;
      assert.ok(anyCorrectionPlan(issues, item.text, [item.gold]), JSON.stringify({ ...item, issues }));
      assert.deepEqual((await run(item.gold, mode)).issues, [], item.gold);
      return { family: item.family, ...(item.validation ? { validation: item.validation, originalGold: item.originalGold, validatedGold: item.gold } : {}) };
    });
    for (const [index, text] of CONTEXT_PUNCTUATION_CONTROLS.entries()) await record(`${mode}/control-${index}`, async () => assert.deepEqual((await run(text, mode)).issues, [], text));
    for (const item of [...CONTEXT_HOLDOUT_CASES, ...CONTEXT_EDGE_CASES]) await record(`${mode}/${item.id}`, async () => {
      let text = item.text, applied = 0;
      while (text !== item.gold && applied < 5) {
        const issues = (await run(text, mode)).issues;
        const occupied = [];
        for (const issue of [...issues].sort((a, b) => b.start - a.start || b.end - a.end)) {
          if (issue.correct === undefined || occupied.some(([start, end]) => issue.start < end && issue.end > start)) continue;
          text = text.slice(0, issue.start) + issue.correct + text.slice(issue.end);
          occupied.push([issue.start, issue.end]);
        }
        applied++;
      }
      assert.equal(text, item.gold, JSON.stringify({ item, issues: (await run(item.text, mode)).issues }));
      assert.deepEqual((await run(item.gold, mode)).issues, [], item.gold);
      return { family: 'independent-holdout', applied };
    });
    for (const [index, text] of [...CONTEXT_HOLDOUT_CONTROLS, ...CONTEXT_EDGE_CONTROLS].map(validatedContextControl).entries()) await record(`${mode}/holdout-control-${index}`, async () => assert.deepEqual((await run(text, mode)).issues, [], text));
    const issues = (await run(USER_PUNCTUATION_TEXT, mode)).issues;
    await writeFile(join(directory, `user-${mode}.json`), JSON.stringify(issues, null, 2));
    for (const [index, correction] of [...USER_REQUIRED_CORRECTIONS, ...USER_EXTRA_CORRECTIONS].entries()) await record(`${mode}/user-${index}`, async () => {
      const anchor = USER_PUNCTUATION_TEXT.indexOf(correction.anchor);
      assert.ok(anchor >= 0);
      const start = anchor + correction.anchor.indexOf(correction.from), end = start + correction.from.length;
      assert.ok(issues.some(issue => issue.start >= start && issue.end <= end
        && issue.suggestions.some(value => USER_PUNCTUATION_TEXT.slice(start, issue.start) + value + USER_PUNCTUATION_TEXT.slice(issue.end, end) === correction.to)), JSON.stringify({ correction, start, end, issues: issues.filter(issue => issue.start >= start - 5 && issue.end <= end + 5) }));
    });
  }
  await record('runtime-independent-of-test-answers', async () => {
    for (const file of ['src/core/language-checker.js', 'src/core/russian-punctuation.js', 'scripts/build-language-lexicon.mjs']) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, /scripts\/fixtures|USER_PUNCTUATION_TEXT|CONTEXT_PUNCTUATION_CASES|Кодекс уважаемый|Хуй член пизда/u);
    }
  });
} finally { globalThis.fetch = originalFetch; }
const summary = { passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, total: results.length,
  corpusSha256: createHash('sha256').update(JSON.stringify({ cases: CONTEXT_PUNCTUATION_CASES, controls: CONTEXT_PUNCTUATION_CONTROLS, user: USER_PUNCTUATION_TEXT, required: USER_REQUIRED_CORRECTIONS })).digest('hex'), supplementalSha256, families: {} };
for (const family of new Set(CONTEXT_PUNCTUATION_CASES.map(item => item.family))) summary.families[family] = results.filter(item => item.family === family).length;
await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
for (const item of results.filter(item => !item.passed).slice(0, 8)) console.error(item.name, item.error);
if (summary.failed) process.exitCode = 1;
