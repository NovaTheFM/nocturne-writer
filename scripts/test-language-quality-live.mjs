import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getSmartSpellerMatches } from '../src/core/smart-speller.js';
import { LANGUAGE_QUALITY_CASES } from './fixtures/language-quality-corpus.mjs';
import { anyCorrectionPlan } from './qa/language-quality-contract.mjs';

const endpoint = process.env.NOCTURNE_AUDIT_LANGUAGETOOL_URL;
assert.ok(endpoint, 'NOCTURNE_AUDIT_LANGUAGETOOL_URL must point to a running localhost LanguageTool');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname), 'Automated stress requests may only target localhost');
const probe = new URL('/v2/languages', endpoint);
const available = await fetch(probe, { signal: AbortSignal.timeout(12000) }).catch(error => { throw new Error(`Local provider is unavailable; no language cases were executed: ${error.message}`); });
assert.ok(available.ok, `Local provider is unavailable (${available.status}); no language cases were executed`);
assert.equal(createHash('sha256').update(JSON.stringify(LANGUAGE_QUALITY_CASES)).digest('hex'), '86c5d6aed41561a201ec9e5238581f42ffe02f0e57a7f06c98f0322a0844c2f0');
const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/language-quality-live'), results = [], responses = [];
await mkdir(directory, { recursive: true });
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const response = await originalFetch(url, options), data = await response.clone().json();
  const parameters = new URLSearchParams(options.body);
  responses.push({ text: parameters.get('text'), language: parameters.get('language'), level: parameters.get('level'), status: response.status, data });
  return response;
};
let next = 0;
try {
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < LANGUAGE_QUALITY_CASES.length) {
      const item = LANGUAGE_QUALITY_CASES[next++];
      for (const correct of [false, true]) {
        const text = correct ? item.gold[0] : item.text;
        try {
          const result = await getSmartSpellerMatches(text.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || [], { mode: 'hybrid', lang: item.lang, contextText: text, endpoint });
          assert.ok(!result.degraded, result.degraded);
          if (correct) assert.deepEqual(result.issues, [], JSON.stringify({ text, issues: result.issues }));
          else {
            const plan = anyCorrectionPlan(result.issues, text, item.gold);
            assert.ok(plan, JSON.stringify({ text, gold: item.gold, issues: result.issues }));
            assert.ok(plan.plan.every(issue => issue.suggestions[0] === issue.correct), 'The first suggestions must produce the frozen gold text');
          }
          results.push({ name: `${item.lang}/${item.id}/${correct ? 'control' : 'correction'}`, lang: item.lang, correctControl: correct, passed: true });
        } catch (error) { results.push({ name: `${item.lang}/${item.id}/${correct ? 'control' : 'correction'}`, lang: item.lang, correctControl: correct, passed: false, error: error.stack }); }
      }
      if (results.length % 200 === 0) console.log(`Live language checking: ${results.length}/1200`);
    }
  }));
} finally { globalThis.fetch = originalFetch; }
const summary = { passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, requests: responses.length, providerVersion: [...new Set(responses.map(item => item.data.software?.version))], byLanguage: {} };
for (const lang of ['ru', 'uk', 'en']) summary.byLanguage[lang] = { corrections: results.filter(item => item.lang === lang && !item.correctControl && item.passed).length, cleanControls: results.filter(item => item.lang === lang && item.correctControl && item.passed).length, totalCorrections: 200, totalControls: 200 };
await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(join(directory, 'http-responses.json'), JSON.stringify(responses, null, 2));
console.log(JSON.stringify(summary));
for (const item of results.filter(item => !item.passed).slice(0, 6)) console.error(item.name, item.error);
if (summary.failed) process.exitCode = 1;
