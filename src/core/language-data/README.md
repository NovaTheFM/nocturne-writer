# Deterministic language data

Prepared for Nocturne Writer on 2026-10-13. The runtime uses dictionary membership, morphological features, edit operations and grammatical rules. It does not load a neural network, a statistical correction model or the Hunspell engine.

## Sources and notices

- LanguageTool **6.6**: https://languagetool.org/download/LanguageTool-6.6.zip. Only its morphology dictionaries, common-word lists and declarative XML rule identifiers are used. `spelling_correction_model.bin` and other correction models are not imported.
- Russian POS dictionary: AOT, converted and extended by Yakov Reztsov, LGPL. Upstream notice: [licenses/russian.txt](licenses/russian.txt); source: https://github.com/sokirko74/aot/.
- Ukrainian POS dictionary: Andriy Rysin, brown-uk/dict_uk, LGPL. Upstream notice: [licenses/ukrainian.txt](licenses/ukrainian.txt); source: https://github.com/brown-uk/dict_uk.
- English POS data: Kevin Atkinson, Moby and WordNet. Preserve [licenses/english.txt](licenses/english.txt), including the Princeton notice.
- Morfologik CFSA2 format and build tools: https://github.com/morfologik/morfologik-stemming; BSD notice: [licenses/morfologik.txt](licenses/morfologik.txt).
- GeoNames cities15000: https://download.geonames.org/export/dump/cities15000.zip, downloaded 2026-10-13, CC BY 4.0. Geographic name variants supply capitalization data. Preserve [licenses/geonames.txt](licenses/geonames.txt) and credit https://www.geonames.org/.

The Russian and Ukrainian derived dictionary assets remain under LGPL; the complete license is [licenses/LGPL-2.1.txt](licenses/LGPL-2.1.txt). The transformations and format are documented here and implemented in the build sources below. Do not distribute the assets without the source links, notices and conversion scripts.

## Format and transformations

`ru.mjs`, `uk.mjs`, `en.mjs` export gzip-compressed JSON as base64. The JSON contains lemmas, tags, word/analysis pairs, common words, proper-name forms and a CFSA2 exact word index. `manifest.json` records counts, source hashes and compressed asset hashes. Dictionary keys fold Russian `ё` to `е`; source spelling and UTF-16 editor ranges retain their original characters.

The exact membership index covers exported dictionary word forms with at least one analysis not marked `bad`. Incorrect source forms are excluded before building the finite-state index; archaic forms remain recognized. Full morphological paradigms are retained for common lemmas; finite verbs are additionally retained across the dictionary. Marked bad/archaic analyses are excluded from the morphology index. Future, present, past, imperative and infinitive forms remain distinct. Shortened and alternative forms remain readable but ordinary forms are suggested first. Runtime lookup folds straight/curly apostrophes while replacements preserve the input's apostrophe style.

Russian morphology also retains gerunds (`DPT`), all adverbs, and every analysis of words with a nominative noun or adjective reading. Retaining accompanying accusative and other homonyms prevents truncated data from inventing a subject. Gerunds remain separate from finite verbs. Russian `adverbialPhrases` are `ADV`/`FR` entries from LanguageTool 6.6 `resource/ru/multiwords.txt`; these supply idiomatic exceptions independently of test fixtures. The Russian compressed JSON is 12,165,612 bytes; exact dictionary membership is unchanged. Rare adjectives participate in contextual punctuation without a test-specific word list.

Proper-name capitalization combines the original dictionary, the case-sensitive common-word list and GeoNames. Inflected forms come from actual paradigms. Ordinary noun readings take priority over a geographic homonym where the language supplies proper-name tags.

`classical-rules.js` contains active rule/rulegroup identifiers declared in LanguageTool 6.6 XML files: 481 RU, 626 UK, 2815 EN. XML comments, translation-only `bitext.xml` and remote filter catalogs are excluded. Online checks explicitly enable these identifiers and `level=picky`, including additional punctuation rules; premium, AI and unrequested rule identifiers are rejected. Style preferences remain excluded from error diagnostics. Auto language selection uses character and function-word rules locally, then sends an explicit language to the provider.

All assets are loaded locally by the language worker when needed. No test fixture or expected correction is read by the data builder or runtime.

## Rebuild

Extract the pinned LanguageTool archive into `release/tools/languagetool/unpacked/LanguageTool-6.6`, and the GeoNames archive into `release/qa-smart-audit/geonames`. Java 21 is used by the build tools only. In PowerShell:

```powershell
$languageClasspath = 'release/tools/languagetool/unpacked/LanguageTool-6.6;release/tools/languagetool/unpacked/LanguageTool-6.6/libs/*'
javac -cp $languageClasspath -d release/qa-smart-audit/java scripts/language-tools/ExportMorphology.java scripts/language-tools/BuildWordFsa.java
java -Xmx2g -cp "release/qa-smart-audit/java;$languageClasspath" ExportMorphology release/tools/languagetool/unpacked/LanguageTool-6.6 release/qa-smart-audit/morphology
java -Xmx768m -cp "release/qa-smart-audit/java;$languageClasspath" BuildWordFsa release/qa-smart-audit/morphology
node scripts/build-language-lexicon.mjs
```

Inputs can be selected with `--source=PATH`, `--provider=PATH`, `--geography=PATH`. `--catalog-only` regenerates rule identifiers without rebuilding morphology. Generated TSV and original downloads stay outside runtime assets. The builder includes copies of its conversion sources in `source/`. Standard application builds copy the prepared assets, conversion sources and notices into `dist/src/core/language-data/`; they do not download data or require Java.

Test corpora are separate, frozen artifacts. `capture-language-spelling-transfer.mjs` captures a new vocabulary benchmark only for an explicitly reviewed contract revision. Normal QA reads the recorded fixture and verifies its hash; it never resamples words from a changed production dictionary.

The original 600-word spelling fixture is preserved unchanged. An independent source audit using `scripts/language-tools/ValidateReferenceWords.java` and the original LanguageTool dictionaries found 599 valid references and one Ukrainian reference whose only analysis is marked `bad`. Its three case variants test rejection of an invalid suggestion; they are explicitly reported as safety checks, not successful spelling corrections. The source audit and its tags are frozen in `scripts/fixtures/language-spelling-source-validation.json`.
