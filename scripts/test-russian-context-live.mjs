import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getSmartSpellerMatches } from '../src/core/smart-speller.js';
import { CONTEXT_PUNCTUATION_CASES, CONTEXT_PUNCTUATION_CONTROLS } from './fixtures/russian-context-punctuation.mjs';
import { CONTEXT_HOLDOUT_CASES, CONTEXT_HOLDOUT_CONTROLS } from './fixtures/russian-context-holdout.mjs';
import { USER_PUNCTUATION_TEXT, USER_REQUIRED_CORRECTIONS } from './fixtures/russian-user-punctuation.mjs';
import { validatedContextCase, validatedContextControl } from './fixtures/russian-context-source-validation.mjs';
import { CONTEXT_EDGE_CASES, CONTEXT_EDGE_CONTROLS } from './fixtures/russian-context-edges.mjs';
import { USER_EXTRA_CORRECTIONS } from './fixtures/russian-user-extra-corrections.mjs';
import { anyCorrectionPlan } from './qa/language-quality-contract.mjs';

const endpoint = process.env.NOCTURNE_AUDIT_LANGUAGETOOL_URL;
assert.ok(endpoint && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname), 'Live stress checking requires a localhost LanguageTool');
const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/russian-context-live'), results = [], responses = [];
await mkdir(directory, { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const response = await originalFetch(url, options), data = await response.clone().json();
  const parameters = new URLSearchParams(options.body);
  responses.push({ parameters: Object.fromEntries(parameters), status: response.status, data });
  return response;
};
const run = async text => {
  const result = await getSmartSpellerMatches(text.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || [], { mode: 'hybrid', lang: 'ru', contextText: text, endpoint });
  assert.ok(!result.degraded, result.degraded);
  return result.issues;
};
async function record(name, work) {
  try { results.push({ name, passed: true, ...await work() }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
}
try {
  let next = 0;
  const cases = [...CONTEXT_PUNCTUATION_CASES.map(validatedContextCase), ...CONTEXT_HOLDOUT_CASES, ...CONTEXT_EDGE_CASES];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < cases.length) {
      const item = cases[next++];
      await record(`${item.id}/correction`, async () => {
        let text = item.text, steps = 0;
        while (text !== item.gold && steps < 5) {
          const issues = await run(text), occupied = [];
          for (const issue of [...issues].sort((a, b) => b.start - a.start || b.end - a.end)) {
            if (issue.correct === undefined || occupied.some(([start, end]) => issue.start < end && issue.end > start)) continue;
            text = text.slice(0, issue.start) + issue.correct + text.slice(issue.end); occupied.push([issue.start, issue.end]);
          }
          steps++;
        }
        assert.equal(text, item.gold); return { steps };
      });
      await record(`${item.id}/control`, async () => assert.deepEqual(await run(item.gold), [], item.gold));
    }
  }));
  for (const [index, text] of [...CONTEXT_PUNCTUATION_CONTROLS, ...CONTEXT_HOLDOUT_CONTROLS, ...CONTEXT_EDGE_CONTROLS].map(validatedContextControl).entries()) await record(`negative-${index}`, async () => assert.deepEqual(await run(text), [], text));
  const user = await run(USER_PUNCTUATION_TEXT);
  await writeFile(join(directory, 'user-hybrid.json'), JSON.stringify(user, null, 2));
    for (const [index, correction] of [...USER_REQUIRED_CORRECTIONS, ...USER_EXTRA_CORRECTIONS].entries()) await record(`user-${index}`, async () => {
    const anchor = USER_PUNCTUATION_TEXT.indexOf(correction.anchor), start = anchor + correction.anchor.indexOf(correction.from), end = start + correction.from.length;
    assert.ok(user.some(issue => issue.start >= start && issue.end <= end && issue.suggestions.some(value => USER_PUNCTUATION_TEXT.slice(start, issue.start) + value + USER_PUNCTUATION_TEXT.slice(issue.end, end) === correction.to)), correction.anchor);
  });
  await record('real-classical-provider', async () => {
    assert.ok(responses.length > 0);
    assert.ok(responses.every(response => response.status === 200 && response.parameters.enabledOnly === 'true' && response.parameters.level === 'picky'));
    assert.deepEqual([...new Set(responses.map(response => response.data.software?.version))], ['6.6']);
  });
} finally { globalThis.fetch = originalFetch; }
const summary = { passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, total: results.length, requests: responses.length };
await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(join(directory, 'http-responses.json'), JSON.stringify(responses, null, 2));
console.log(JSON.stringify(summary));
for (const item of results.filter(item => !item.passed).slice(0, 5)) console.error(item.name, item.error);
if (summary.failed) process.exitCode = 1;
