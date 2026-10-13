import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createDictionaryMembership, dictionaryContains } from '../src/core/language-data/membership.js';

const cases = [], provenance = {};
for (const lang of ['ru', 'uk', 'en']) {
  const encoded = (await import(`../src/core/language-data/${lang}.mjs`)).default, compressed = Buffer.from(encoded, 'base64');
  const data = JSON.parse(gunzipSync(compressed)), membership = createDictionaryMembership(Buffer.from(data.membership.encoded, 'base64'));
  const proper = new Set(data.properForms.map(word => word.toLowerCase()));
  const alphabet = lang === 'en' ? /^[a-z]{6,11}$/u : lang === 'ru' ? /^[а-я]{6,11}$/u : /^[а-щьюяєіїґ]{6,11}$/u;
  const candidates = data.common.filter(word => alphabet.test(word) && !proper.has(word));
  const pool = candidates.filter(word => dictionaryContains(membership, word)), seen = new Set();
  let seed = 20261013, checked = 0, attempts = 0, validWords = 0, names = 0, duplicates = 0;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  while (checked < 200 && attempts++ < 5000) {
    const word = pool[random() % pool.length], index = random() % word.length, wrong = word.slice(0, index) + word.slice(index + 1);
    if (dictionaryContains(membership, wrong)) { validWords++; continue; }
    if (proper.has(wrong)) { names++; continue; }
    if (seen.has(`${word}:${wrong}`)) { duplicates++; continue; }
    seen.add(`${word}:${wrong}`);
    cases.push({ id: `${lang}-spelling-transfer-${++checked}`, lang, wrong, correct: word });
  }
  if (checked !== 200) throw new Error(`${lang}: not enough independent spelling mutations`);
  provenance[lang] = { dictionarySha256: createHash('sha256').update(compressed).digest('hex'), seed: 20261013, sourceWords: pool.length, invalidFrequencyEntries: candidates.length - pool.length, skippedValidWords: validWords, skippedNames: names, duplicates };
}
const recording = { contractVersion: 1, source: 'LanguageTool 6.6 morphology and common-word data; GeoNames cities15000', provenance, corpusSha256: createHash('sha256').update(JSON.stringify(cases)).digest('hex'), cases };
await writeFile('scripts/fixtures/language-spelling-transfer.json', JSON.stringify(recording, null, 2) + '\n');
console.log(JSON.stringify({ corpusSha256: recording.corpusSha256, count: cases.length, provenance }, null, 2));
