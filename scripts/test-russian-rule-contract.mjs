import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { getSmartSpellerMatches } from '../src/core/smart-speller.js';
import { CLASSICAL_LANGUAGE_RULES } from '../src/core/language-data/classical-rules.js';
import { anyCorrectionPlan } from './qa/language-quality-contract.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/russian-rule-contract');
await mkdir(directory, { recursive: true });
const corpus = JSON.parse(await readFile(new URL('./fixtures/russian-rule-contract.json', import.meta.url), 'utf8'));
const provider = JSON.parse(await readFile(new URL('./fixtures/russian-rule-provider.json', import.meta.url), 'utf8'));
const sourceValidation = JSON.parse(await readFile(new URL('./fixtures/russian-rule-source-validation.json', import.meta.url), 'utf8'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
assert.equal(hash(corpus.cases), '48f0305905962efc036ee662302fda59955cbdc185043574240d445b903e100f');
assert.equal(corpus.corpusSha256, hash(corpus.cases));
assert.equal(sourceValidation.originalCorpusSha256, corpus.corpusSha256);
assert.equal(sourceValidation.sourceSha256, corpus.sourceSha256);
assert.equal(sourceValidation.sha256, hash(sourceValidation.cases));
assert.equal(sourceValidation.sha256, 'd41bee778c8077ab5ee8a275459f877983e119f89239ce02eb6fefe11cb8e54b');
assert.equal(provider.corpusSha256, corpus.corpusSha256);
assert.equal(hash(provider.responses), provider.responsesSha256);
assert.equal(provider.responsesSha256, 'a04ff9af59678365b27529c7dad37b3d5d4c4fb462678f79bcb640867a6475ab');
assert.deepEqual(CLASSICAL_LANGUAGE_RULES.ru, Object.keys(corpus.rules).sort());
assert.equal(corpus.parseErrors.length, 0);
assert.equal(provider.responses.length, corpus.cases.length);
const results = [], calibration = { positiveExamples: 0, detected: 0, controls: 0, unexpectedOnControl: 0, gaps: [], categories: {}, rules: {} };
const originalFetch = globalThis.fetch;
const eligible = match => match.rule?.id !== 'MissingYO' && match.rule?.issueType !== 'style' && !['STYLE', 'REPETITIONS_STYLE', 'REDUNDANCY'].includes(match.rule?.category?.id);
let transported = 0, styleExcluded = 0, requests = 0;
let hybridCorrectionsPreserved = 0, hybridDiagnosticsCovered = 0;
try {
  for (let index = 0; index < corpus.cases.length; index++) {
    const item = corpus.cases[index], response = provider.responses[index];
    assert.equal(response.id, item.id);
    assert.equal(response.status, 200, response.error);
    const found = response.data.matches.some(match => match.rule.id === item.ruleId);
    const source = sourceValidation.cases[index];
    assert.equal(source.id, item.id);
    const positive = source.expected !== 'no-target-error';
    if (positive) { calibration.positiveExamples++; calibration.detected += Number(found); }
    else { calibration.controls++; calibration.unexpectedOnControl += Number(found); }
    if (positive !== found) calibration.gaps.push({ id: item.id, ruleId: item.ruleId, category: item.category, text: item.text, expected: source.expected, detected: found });
    for (const group of [calibration.categories, calibration.rules]) {
      const key = group === calibration.categories ? item.category : item.ruleId;
      const stats = group[key] ||= { positives: 0, detected: 0, controls: 0, unexpectedOnControl: 0 };
      if (positive) { stats.positives++; stats.detected += Number(found); }
      else { stats.controls++; stats.unexpectedOnControl += Number(found); }
    }
    globalThis.fetch = async (_url, options) => {
      requests++;
      const parameters = new URLSearchParams(options.body);
      assert.equal(parameters.get('text'), item.text);
      assert.equal(parameters.get('level'), 'picky');
      assert.equal(parameters.get('enabledOnly'), 'true');
      assert.equal(parameters.get('language'), 'ru-RU');
      assert.deepEqual(parameters.get('enabledRules').split(','), CLASSICAL_LANGUAGE_RULES.ru);
      return { ok: true, json: async () => structuredClone(response.data) };
    };
    for (const mode of ['api', 'hybrid']) try {
      const result = await getSmartSpellerMatches(item.text.match(/\p{L}+(?:[’'\-]\p{L}+)*/gu) || [], { mode, lang: 'ru', contextText: item.text, localLookup: {}, endpoint: `http://fixture.invalid/russian-rules/${mode}/${index}` });
      const matches = response.data.matches.filter(eligible);
      if (mode === 'api') styleExcluded += response.data.matches.length - matches.length;
      for (const match of matches) {
        if (mode === 'hybrid') {
          if (match.replacements.length) {
            const variants = match.replacements.map(replacement => item.text.slice(0, match.offset) + replacement.value + item.text.slice(match.offset + match.length));
            assert.ok(anyCorrectionPlan(result.issues, item.text, variants), JSON.stringify({ text: item.text, match, issues: result.issues }));
            hybridCorrectionsPreserved++;
          } else {
            assert.ok(result.issues.some(issue => issue.start === match.offset && issue.end === match.offset + match.length && issue.message || issue.source === 'rules' && issue.category !== 'capitalization' && issue.suggestions.length && issue.start >= match.offset && issue.end <= match.offset + match.length), JSON.stringify({ text: item.text, match, issues: result.issues }));
            hybridDiagnosticsCovered++;
          }
          continue;
        }
        const issue = result.issues.find(issue => issue.start === match.offset && issue.end === match.offset + match.length);
        assert.ok(issue, JSON.stringify({ text: item.text, match, issues: result.issues }));
        assert.equal(issue.rawText, item.text.slice(match.offset, match.offset + match.length));
        for (const replacement of match.replacements) if (replacement.value !== issue.rawText) assert.ok(issue.suggestions.includes(replacement.value), JSON.stringify({ match, issue }));
        if (!match.replacements.length) assert.ok(issue.message, 'A diagnostic without a safe correction must remain visible');
        transported++;
      }
      if (mode === 'api') assert.equal(result.issues.length, new Set(matches.map(match => `${match.offset}:${match.length}`)).size, 'No fabricated diagnostics or discarded style warnings');
      results.push({ name: `${mode}/transport/${item.id}`, passed: true, ruleId: item.ruleId, category: item.category, providerMatches: matches.length, accuracyVerified: false });
    } catch (error) { results.push({ name: `${mode}/transport/${item.id}`, passed: false, error: error.stack }); }
  }
} finally { globalThis.fetch = originalFetch; }
const summary = { passed: results.filter(item => item.passed).length, failed: results.filter(item => !item.passed).length, requests, activeRussianRules: CLASSICAL_LANGUAGE_RULES.ru.length, transported, hybridCorrectionsPreserved, hybridDiagnosticsCovered, styleExcluded, corpusSha256: corpus.corpusSha256, providerCalibration: { status: calibration.gaps.length ? 'KNOWN_GAPS' : 'PASS', positives: calibration.positiveExamples, detected: calibration.detected, controls: calibration.controls, unexpectedOnControl: calibration.unexpectedOnControl }, limitation: 'Source conformance and recorded HTTP transport are not independent proof of universal Russian accuracy. Controls forbid the target rule, not every possible error in the phrase.' };
await writeFile(join(directory, 'results.json'), JSON.stringify(results, null, 2));
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
await writeFile(join(directory, 'provider-calibration.json'), JSON.stringify(calibration, null, 2));
console.log(JSON.stringify(summary));
for (const item of results.filter(item => !item.passed).slice(0, 6)) console.error(item.name, item.error);
if (summary.failed) process.exitCode = 1;
