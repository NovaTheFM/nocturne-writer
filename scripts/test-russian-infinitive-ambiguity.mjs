import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getSmartSpellerMatches } from '../src/core/smart-speller.js';
import { INFINITIVE_AMBIGUITY_CASES as cases, INFINITIVE_AMBIGUITY_CONTROLS as controls, PARAGRAPH_CAPITAL_CONTROLS as paragraphs } from './fixtures/russian-infinitive-ambiguity.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/russian-infinitive-ambiguity'), results = [], responses = [];
await mkdir(directory, { recursive: true });
const corpusSha256 = createHash('sha256').update(JSON.stringify({ cases, controls, paragraphs })).digest('hex');
assert.equal(corpusSha256, 'bf0fd04b4d381ed8176bd361ffb77ec2269f717b592b405f12d7486b124fea2e');
const originalFetch = globalThis.fetch, endpoint = process.env.NOCTURNE_AUDIT_LANGUAGETOOL_URL;
assert.ok(endpoint && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname), 'Live checking requires localhost LanguageTool');
const run = async (text, mode) => {
  const result = await getSmartSpellerMatches(text.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || [], { mode, lang: 'ru', contextText: text, endpoint });
  assert.ok(!result.degraded, result.degraded); return result.issues;
};
async function record(name, work) {
  try { results.push({ name, passed: true, ...await work() }); }
  catch (error) { results.push({ name, passed: false, error: error.stack }); }
}
try {
  for (const mode of ['local', 'hybrid']) {
    globalThis.fetch = mode === 'local' ? () => { throw new Error('Offline checker requested a provider'); } : async (url, options) => {
      const response = await originalFetch(url, options), data = await response.clone().json();
      responses.push({ parameters: Object.fromEntries(new URLSearchParams(options.body)), status: response.status, data });
      return response;
    };
    for (const item of cases) {
      await record(`${mode}/${item.id}/ambiguity`, async () => {
        const issues = await run(item.text, mode), issue = issues.find(value => value.ruleId === 'ambiguous-infinitive-boundary');
        assert.ok(issue, JSON.stringify({ item, issues })); assert.equal(issues.length, 1);
        assert.equal(issue.rawText, item.raw); assert.equal(issue.requiresChoice, true); assert.equal(issue.correct, undefined);
        assert.deepEqual(issue.suggestions, item.alternatives); assert.doesNotMatch(issue.message, /точк/iu);
      });
      for (const [index, text] of item.controls.entries()) await record(`${mode}/${item.id}/choice-${index}`, async () => assert.deepEqual(await run(text, mode), [], text));
    }
    for (const [index, text] of controls.entries()) await record(`${mode}/governor-${index}`, async () => assert.deepEqual(await run(text, mode), [], text));
    if (mode === 'hybrid') {
      for (const [index, text] of paragraphs.entries()) await record(`hybrid/paragraph-${index}`, async () => {
        assert.ok(!(await run(text, mode)).some(issue => issue.ruleId === 'DotOrCase'), text);
      });
      await record('hybrid/retain-internal-case-error', async () => assert.ok((await run('В лесу Родилась ёлочка.', mode)).some(issue => issue.ruleId === 'DotOrCase')));
      await record('hybrid/retain-internal-case-with-ambiguity', async () => {
        const issues = await run('В лесу Родилась ёлочка. Казнить нельзя помиловать.', mode);
        assert.ok(issues.some(issue => issue.ruleId === 'DotOrCase' && issue.rawText === 'Родилась'), JSON.stringify(issues));
        assert.ok(issues.some(issue => issue.requiresChoice));
      });
    }
  }
  await record('actual-provider-and-independent-runtime', async () => {
    assert.ok(responses.length); assert.ok(responses.every(item => item.status === 200 && item.parameters.enabledOnly === 'true' && item.parameters.level === 'picky'));
    assert.deepEqual([...new Set(responses.map(item => item.data.software?.version))], ['6.6']);
    assert.ok(responses.some(item => item.data.matches.some(match => match.rule.id === 'DotOrCase' && item.parameters.text.includes('\n'))));
    for (const path of ['src/core/russian-punctuation.js', 'src/core/language-checker.js', 'src/core/smart-speller.js', 'src/core/language-data/russian-infinitive-frames.js']) {
      assert.doesNotMatch(await readFile(path, 'utf8'), /INFINITIVE_AMBIGUITY_CASES|scripts\/fixtures|казнить|помиловать|уволить|наградить/iu);
    }
  });
} finally { globalThis.fetch = originalFetch; }
const summary = { passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, total: results.length, requests: responses.length, corpusSha256 };
await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(join(directory, 'http-responses.json'), JSON.stringify(responses, null, 2));
console.log(JSON.stringify(summary)); for (const item of results.filter(item => !item.passed).slice(0, 5)) console.error(item.name, item.error);
if (summary.failed) process.exitCode = 1;
