import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SMART_DICTIONARY_CORPUS, SMART_DICTIONARY_CONTRACT_VERSION } from './fixtures/smart-dictionary-corpus.mjs';
import { correctionMatches, providerIssues } from './qa/smart-dictionary-audit-core.mjs';

const directory = resolve(process.env.NOCTURNE_QA_DIR || 'release/qa/smart-dictionary-provider-comparison');
const endpoint = process.env.NOCTURNE_AUDIT_LANGUAGETOOL_URL || '';
const additionalRecording = process.env.NOCTURNE_AUDIT_CHECKER_RECORDING || '';
const corpusSha256 = createHash('sha256').update(JSON.stringify(SMART_DICTIONARY_CORPUS)).digest('hex');
const recordings = [JSON.parse(await readFile(new URL('./fixtures/smart-dictionary-provider.json', import.meta.url), 'utf8'))];
const codes = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US', auto: 'auto' };
await mkdir(directory, { recursive: true });

if (endpoint) {
  const url = new URL(endpoint);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Automated provider comparisons require a local endpoint');
  const fixtures = [];
  for (const item of SMART_DICTIONARY_CORPUS) {
    const started = performance.now();
    const response = await fetch(new URL('/v2/check', url), {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ text: item.text, language: codes[item.lang], enabledOnly: 'false', level: 'picky' }),
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `${item.id}: HTTP ${response.status}`);
    fixtures.push({ ...item, response: await response.json(), durationMs: Math.round(performance.now() - started) });
    if (fixtures.length % 30 === 0) console.log(`PICKY ${fixtures.length}/${SMART_DICTIONARY_CORPUS.length}`);
  }
  const recording = { contractVersion: SMART_DICTIONARY_CONTRACT_VERSION, capturedAt: new Date().toISOString(), provider: `LanguageTool ${fixtures[0].response.software.version}, level=picky`, software: fixtures[0].response.software, corpusSha256, fixtures };
  recordings.push(recording);
  await writeFile(join(directory, 'languagetool-picky.json'), JSON.stringify(recording, null, 2));
}
if (additionalRecording) recordings.push(JSON.parse(await readFile(resolve(additionalRecording), 'utf8')));

const scenarios = [], summary = [];
for (const recording of recordings) {
  assert.equal(recording.corpusSha256, corpusSha256, 'Do not replace the frozen inputs to accommodate a provider');
  assert.equal(recording.contractVersion, SMART_DICTIONARY_CONTRACT_VERSION);
  assert.equal(recording.fixtures.length, SMART_DICTIONARY_CORPUS.length, 'A candidate must cover every input, including correct controls');
  const byId = new Map(recording.fixtures.map(item => [item.id, item]));
  assert.equal(byId.size, SMART_DICTIONARY_CORPUS.length, 'Duplicate recordings cannot replace missing inputs');
  const evaluated = SMART_DICTIONARY_CORPUS.map(item => {
    const fixture = byId.get(item.id);
    assert.ok(fixture && fixture.text === item.text && fixture.lang === item.lang, item.id);
    const correctedText = typeof fixture.correctedText === 'string' ? fixture.correctedText : null;
    const issues = correctedText === null ? providerIssues(fixture.response) : [];
    assert.ok(correctedText !== null || Array.isArray(fixture.response?.matches), `${item.id}: a real result is required`);
    const passed = item.expected === 'no-error'
      ? correctedText === null ? issues.length === 0 : correctedText === item.text
      : correctedText === null ? correctionMatches(issues, item.text, item.gold) : item.gold.includes(correctedText);
    return { ...item, passed, issues, correctedText, durationMs: fixture.durationMs };
  });
  const errors = evaluated.filter(item => item.expected === 'correction');
  const controls = evaluated.filter(item => item.expected === 'no-error');
  const category = key => Object.fromEntries([...new Set(errors.map(item => item[key]))].map(value => {
    const subset = errors.filter(item => item[key] === value);
    return [value, { found: subset.filter(item => item.passed).length, total: subset.length }];
  }));
  const defaultById = new Map(scenarios.filter(item => item.provider === recordings[0].provider).map(item => [item.id, item]));
  summary.push({ provider: recording.provider, capturedAt: recording.capturedAt, software: recording.software, modelRevision: recording.modelRevision, expectedAlternatives: errors.filter(item => item.passed).length, errors: errors.length, correctControls: controls.length, falsePositiveControls: controls.filter(item => !item.passed).length, newGoldComparedToDefault: errors.filter(item => item.passed && defaultById.get(item.id)?.passed === false).map(item => item.id), lostGoldComparedToDefault: errors.filter(item => !item.passed && defaultById.get(item.id)?.passed === true).map(item => item.id), byCategory: category('category'), byLanguage: category('lang') });
  scenarios.push(...evaluated.map(item => ({ ...item, name: `${recording.provider}/${item.id}`, provider: recording.provider, error: item.passed ? undefined : item.expected === 'no-error' ? 'The provider changes or flags a correct control' : 'The provider does not offer the frozen expected correction' })));
}
await writeFile(join(directory, 'results.json'), JSON.stringify(scenarios, null, 2));
const report = { contractVersion: SMART_DICTIONARY_CONTRACT_VERSION, corpusSha256, status: scenarios.every(item => item.passed) ? 'PASS' : 'FAIL', hunspell: 'excluded by user', livePickySelected: Boolean(endpoint), additionalCandidateSelected: Boolean(additionalRecording), providers: summary, notes: ['Metrics are provider-level, before the Nocturne adapter.', 'Correct controls count every diagnostic, including style, to reveal overcorrection.', 'A full-text candidate must return the frozen expected correction and keep correct controls unchanged.', 'Model-card benchmarks are not results from this test.'] };
await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.status === 'FAIL') process.exitCode = 1;
