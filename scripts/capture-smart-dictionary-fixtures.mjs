import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SMART_DICTIONARY_CORPUS, SMART_DICTIONARY_CONTRACT_VERSION } from './fixtures/smart-dictionary-corpus.mjs';

const endpoint = process.argv.find(value => value.startsWith('--provider='))?.slice(11);
if (!endpoint) throw new Error('Specify --provider=http://127.0.0.1:PORT; automated public LanguageTool requests are prohibited.');
const provider = new URL(endpoint);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(provider.hostname)) throw new Error('Fixture capture accepts only a local LanguageTool server.');
const filename = resolve('scripts/fixtures/smart-dictionary-provider.json');
try {
  await readFile(filename);
  if (!process.argv.includes('--refresh')) throw new Error('Recorded responses already exist. Use --refresh only when deliberately creating a new provider baseline.');
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const fixtures = [], codes = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-US', auto: 'auto' };
for (const item of SMART_DICTIONARY_CORPUS) {
  const start = performance.now();
  const response = await fetch(new URL('/v2/check', provider), {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ text: item.text, language: codes[item.lang], enabledOnly: 'false' }), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`${item.id}: LanguageTool returned HTTP ${response.status}`);
  const data = await response.json();
  fixtures.push({ id: item.id, text: item.text, lang: item.lang, durationMs: Math.round(performance.now() - start), response: data });
  if (fixtures.length % 20 === 0) console.log(`CAPTURE ${fixtures.length}/${SMART_DICTIONARY_CORPUS.length}`);
}
const corpusSha256 = createHash('sha256').update(JSON.stringify(SMART_DICTIONARY_CORPUS)).digest('hex');
await mkdir(resolve('scripts/fixtures'), { recursive: true });
await writeFile(filename, JSON.stringify({ contractVersion: SMART_DICTIONARY_CONTRACT_VERSION, capturedAt: new Date().toISOString(), provider: 'LanguageTool 6.6, self-hosted HTTP API', api: '/v2/check', corpusSha256, software: fixtures[0]?.response.software, fixtures }, null, 2));
console.log(`SAVED ${filename}: ${fixtures.length} real provider responses; corpus SHA-256 ${corpusSha256}`);
