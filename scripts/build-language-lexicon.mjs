import { readFile, readdir, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const source = resolve(process.argv.find(value => value.startsWith('--source='))?.slice(9) || 'release/qa-smart-audit/morphology');
const target = resolve('src/core/language-data');
const provider = resolve(process.argv.find(value => value.startsWith('--provider='))?.slice(11) || 'release/tools/languagetool/unpacked/LanguageTool-6.6');
const geography = await readFile(resolve(process.argv.find(value => value.startsWith('--geography='))?.slice(12) || 'release/qa-smart-audit/geonames/cities15000.txt'), 'utf8');
const cities = geography.trim().split(/\r?\n/u).flatMap(line => { const fields = line.split('\t'); return [fields[1], ...fields[3].split(',')]; });
await mkdir(target, { recursive: true });
const manifest = { provider: 'LanguageTool 6.6 morphology dictionaries', geography: { source: 'https://download.geonames.org/export/dump/cities15000.zip', license: 'CC BY 4.0', sha256: createHash('sha256').update(geography).digest('hex') }, runtime: 'Dictionary lookup and grammatical rules; no neural/statistical model', languages: {} };
const classicalRules = {};
for (const language of ['ru', 'uk', 'en']) {
  const ruleDirectory = resolve(provider, `org/languagetool/rules/${language}`), ruleIds = new Set();
  for (const file of (await readdir(ruleDirectory)).filter(file => file.endsWith('.xml'))) {
    for (const match of (await readFile(resolve(ruleDirectory, file), 'utf8')).matchAll(/<rule(?:group)?\s[^>]*\bid="([^"]+)"/gu)) ruleIds.add(match[1]);
  }
  classicalRules[language] = [...ruleIds].sort();
  const raw = await readFile(resolve(source, `${language}.tsv`), 'utf8');
  const common = (await readFile(resolve(source, `${language}-common.txt`), 'utf8')).trim().split(/\r?\n/u);
  const allWords = (await readFile(resolve(source, `${language}-all.txt`), 'utf8')).trim().split(/\r?\n/u);
  const wordFsa = await readFile(resolve(source, `${language}-words.fsa`));
  const properForms = new Set((await readFile(resolve(source, `${language}-proper.txt`), 'utf8')).trim().split(/\r?\n/u));
  const commonCase = (await readFile(resolve(provider, `org/languagetool/resource/${language}/common_words.txt`), 'utf8')).trim().split(/\r?\n/u);
  const ordinary = new Set(commonCase.filter(word => word[0] === word[0].toLowerCase()).map(word => word.toLowerCase()));
  const properStems = new Set(commonCase.filter(word => /^\p{Lu}[\p{L}’'\-]+$/u.test(word) && !ordinary.has(word.toLowerCase())).map(word => word.toLowerCase()));
  const script = language === 'en' ? /^[A-Z][a-z]+(?:-[A-Z][a-z]+)*$/u : language === 'ru' ? /^[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)*$/u : /^[А-ЩЬЮЯЄІЇҐ][а-щьюяєіїґ]+(?:-[А-ЩЬЮЯЄІЇҐ][а-щьюяєіїґ]+)*$/u;
  for (const city of cities) if (script.test(city) && !ordinary.has(city.toLowerCase())) { properForms.add(city); properStems.add(city.toLowerCase()); }
  const lemmas = [], tags = [], lemmaIds = new Map(), tagIds = new Map(), forms = new Map();
  const rows = raw.trim().split(/\r?\n/u).map(line => line.split('\t'));
  const frequent = new Set(common.map(word => word.toLowerCase()));
  const frequentLemmas = new Set(rows.filter(([word]) => frequent.has(word.toLowerCase())).map(([, lemma]) => lemma.toLowerCase()));
  const identify = (values, ids, value) => { if (!ids.has(value)) { ids.set(value, values.length); values.push(value); } return ids.get(value); };
  for (const [word, lemma, tag = ''] of rows) {
    if (properStems.has(lemma.toLowerCase())) properForms.add(word[0].toUpperCase() + word.slice(1));
    if (!frequentLemmas.has(lemma.toLowerCase()) && !tag.startsWith('VB') && !tag.startsWith('verb:')) continue;
    if (/(?:^|:)(?:bad|arch)(?::|$)/u.test(tag)) continue;
    if (!forms.has(word)) forms.set(word, []);
    forms.get(word).push(identify(lemmas, lemmaIds, lemma), identify(tags, tagIds, tag));
  }
  const packed = JSON.stringify({ lemmas, tags, common, properForms: [...properForms].filter(Boolean).sort(), forms: [...forms], membership: { format: 'CFSA2', encoded: wordFsa.toString('base64') } });
  const compressed = gzipSync(packed, { level: 9 });
  await writeFile(resolve(target, `${language}.mjs`), `export default '${compressed.toString('base64')}';\n`);
  manifest.languages[language] = { forms: forms.size, validatedForms: allWords.length, membership: 'exact UTF-8 finite-state dictionary', wordIndexBytes: wordFsa.length, analyses: [...forms.values()].reduce((sum, pairs) => sum + pairs.length / 2, 0), lemmas: lemmas.length, tags: tags.length, uncompressedBytes: Buffer.byteLength(packed), gzipBytes: compressed.length, sourceSha256: createHash('sha256').update(raw).digest('hex'), assetSha256: createHash('sha256').update(compressed).digest('hex') };
}
await writeFile(resolve(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(resolve(target, 'classical-rules.js'), 'export const CLASSICAL_LANGUAGE_RULES = ' + JSON.stringify(classicalRules, null, 2) + ';\n');
await mkdir(resolve(target, 'source'), { recursive: true });
for (const file of ['scripts/build-language-lexicon.mjs', 'scripts/language-tools/ExportMorphology.java', 'scripts/language-tools/BuildWordFsa.java']) await copyFile(file, resolve(target, 'source', file.split('/').at(-1)));
console.log(JSON.stringify(manifest, null, 2));
