import { normalizeTypoToken, TYPO_LOOKUP } from './typos.js';
import { dictionaryContains, createDictionaryMembership } from './language-data/membership.js';
import { inferLanguage } from './language-detection.js';

const dictionaries = new Map();
const wordPattern = /\p{L}[\p{L}\p{M}]*(?:[’'\-][\p{L}\p{M}]+)*/gu;
const normalize = value => normalizeTypoToken(String(value).normalize('NFC')).replaceAll('’', "'");
const labels = { spelling: 'Орфография', grammar: 'Грамматика', punctuation: 'Пунктуация', capitalization: 'Регистр', repetition: 'Повтор', usage: 'Словоупотребление' };
const subjectPronouns = {
  ru: { я: ['s', '1'], ты: ['s', '2'], он: ['s', '3', 'm'], она: ['s', '3', 'f'], оно: ['s', '3', 'n'], мы: ['p', '1'], вы: ['p', '2'], они: ['p', '3'] },
  uk: { я: ['s', '1'], ти: ['s', '2'], він: ['s', '3', 'm'], вона: ['s', '3', 'f'], воно: ['s', '3', 'n'], ми: ['p', '1'], ви: ['p', '2'], вони: ['p', '3'] },
  en: { i: ['s', '1'], you: ['p', '2'], he: ['s', '3', 'm'], she: ['s', '3', 'f'], it: ['s', '3', 'n'], we: ['p', '1'], they: ['p', '3'] },
};
const pluralDeterminers = { ru: new Set(['эти', 'те', 'мои', 'твои', 'наши', 'ваши']), uk: new Set(['ці', 'ті', 'мої', 'твої', 'наші', 'ваші']), en: new Set(['these', 'those', 'many', 'several']) };
const nominative = { ru: 'Nom', uk: 'v_naz', en: '' };

function features(tag, language) {
  if (language === 'en') return { pos: /^NN/u.test(tag) ? 'noun' : /^VB/u.test(tag) ? 'verb' : /^JJ/u.test(tag) ? 'adjective' : '', number: ['NNS', 'NNPS'].includes(tag) ? 'p' : /^NN/u.test(tag) || tag === 'VBZ' ? 's' : '', tense: ['VBD', 'VBN'].includes(tag) ? 'past' : 'present', person: tag === 'VBZ' ? '3' : '', case: '', gender: '' };
  const parts = tag.split(':');
  if (language === 'ru') return { pos: parts[0] === 'NN' ? 'noun' : parts[0] === 'VB' ? 'verb' : ['ADJ', 'Ord'].includes(parts[0]) ? 'adjective' : '', number: parts.includes('PL') ? 'p' : parts.includes('Sin') || parts.some(value => ['Masc', 'Fem', 'Neut'].includes(value)) ? 's' : '', gender: parts.includes('Masc') ? 'm' : parts.includes('Fem') ? 'f' : parts.includes('Neut') ? 'n' : '', case: parts.find(value => ['Nom', 'R', 'D', 'V', 'T', 'P'].includes(value)) || '', tense: parts.includes('Past') ? 'past' : parts.includes('Fut') ? 'future' : parts.includes('IMP') ? 'imperative' : parts.includes('INF') ? 'infinitive' : 'present', person: parts.find(value => /^P[123]$/u.test(value))?.slice(1) || '' };
  return { pos: ['noun', 'verb', 'adj'].includes(parts[0]) ? { noun: 'noun', verb: 'verb', adj: 'adjective' }[parts[0]] : '', number: parts.includes('p') ? 'p' : parts.some(value => ['s', 'm', 'f', 'n'].includes(value)) ? 's' : '', gender: parts.find(value => ['m', 'f', 'n'].includes(value)) || '', case: parts.find(value => /^v_/u.test(value)) || '', tense: parts.includes('past') ? 'past' : parts.includes('futr') ? 'future' : parts.includes('impr') ? 'imperative' : parts.includes('inf') ? 'infinitive' : 'present', person: parts.find(value => /^[123]$/u.test(value)) || '' };
}

async function dictionary(language) {
  if (!dictionaries.has(language)) dictionaries.set(language, (async () => {
    const encoded = (await import(`./language-data/${language}.mjs`)).default;
    const bytes = Uint8Array.from(atob(encoded), value => value.charCodeAt(0));
    const data = JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
    const common = new Set(data.common.map(normalize)), formIds = new Map(), lemmaIds = new Map(), lemmaForms = data.lemmas.map(() => []), decoded = new Map();
    data.lemmas.forEach((lemma, index) => lemmaIds.set(normalize(lemma), index));
    data.forms.forEach(([word, pairs], index) => {
      const key = normalize(word);
      if (!formIds.has(key)) formIds.set(key, []);
      formIds.get(key).push(index);
      for (let i = 0; i < pairs.length; i += 2) lemmaForms[pairs[i]].push(index, pairs[i + 1]);
    });
    const analysis = (index, tagId, lemmaId) => {
      const tag = data.tags[tagId];
      return { word: data.forms[index][0], lemma: data.lemmas[lemmaId], tag, ...features(tag, language) };
    };
    const analyses = {
      has: word => formIds.has(word),
      get: word => {
        if (!formIds.has(word)) return undefined;
        if (!decoded.has(word)) decoded.set(word, formIds.get(word).flatMap(index => {
          const pairs = data.forms[index][1], result = [];
          for (let i = 0; i < pairs.length; i += 2) result.push(analysis(index, pairs[i + 1], pairs[i]));
          return result;
        }));
        return decoded.get(word);
      },
    };
    const lemmas = { get: stem => {
      const id = lemmaIds.get(stem);
      if (id === undefined) return undefined;
      const pairs = lemmaForms[id], result = [];
      for (let i = 0; i < pairs.length; i += 2) result.push(analysis(pairs[i], pairs[i + 1], id));
      return result;
    } };
    const membership = createDictionaryMembership(Uint8Array.from(atob(data.membership.encoded), value => value.charCodeAt(0)));
    return { analyses, lemmas, common, membership, properForms: new Map(data.properForms.map(word => [normalize(word), word])) };
  })());
  return dictionaries.get(language);
}

function preserveCase(raw, replacement) {
  if (!replacement) return replacement;
  if (raw.includes('’')) replacement = replacement.replaceAll("'", '’');
  if (raw.length > 1 && raw === raw.toUpperCase()) return replacement.toUpperCase();
  return raw[0] === raw[0]?.toUpperCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

function inflections(data, analysis, target) {
  const marked = candidate => /(?:^|:)(?:subst|alt|coll|rare)(?::|$)/u.test(candidate.tag);
  const forms = (data.lemmas.get(normalize(analysis.lemma)) || []).filter(candidate => candidate.pos === analysis.pos && Object.entries(target).every(([key, value]) => !value || candidate[key] === value));
  forms.sort((a, b) => Number(marked(a)) - Number(marked(b)) || (normalize(a.word) === normalize(b.word) ? Number(b.word.includes('ё')) - Number(a.word.includes('ё')) : 0));
  return [...new Set(forms.map(candidate => candidate.word))];
}

function containsWord(data, word) {
  return data.analyses.has(word) || dictionaryContains(data.membership, word) || word.includes("'") && dictionaryContains(data.membership, word.replaceAll("'", '’'));
}

function englishContraction(word, data) {
  const match = /^(.+)'(s|re|ve|ll|d|m)$/u.exec(word);
  if (match) return containsWord(data, match[1]);
  if (!word.endsWith("n't")) return false;
  const prefix = word.slice(0, -3), base = { ca: 'can', wo: 'will', sha: 'shall' }[prefix] || prefix;
  return data.analyses.get(base)?.some(item => item.tag === 'MD' || ['be', 'do', 'have'].includes(normalize(item.lemma))) || false;
}

function spellingCandidates(word, language, data) {
  if (word.length < 3 || word.length > 40 || !/^\p{L}+(?:['\-]\p{L}+)*$/u.test(word)) return [];
  const alphabet = (language === 'ru' ? 'абвгдежзийклмнопрстуфхцчшщъыьэюя' : language === 'uk' ? 'абвгґдеєжзиіїйклмнопрстуфхцчшщьюя' : 'abcdefghijklmnopqrstuvwxyz') + "'-";
  const found = new Set();
  const consider = candidate => { if (containsWord(data, candidate) || language === 'en' && englishContraction(candidate, data)) found.add(candidate); };
  if (word.length === 3) {
    for (let index = 0; index < 2; index++) consider(word.slice(0, index) + word[index + 1] + word[index] + word.slice(index + 2));
    return [...found].filter(candidate => data.common.has(candidate));
  }
  for (let i = 0; i <= word.length; i++) {
    consider(word.slice(0, i) + word.slice(i + 1));
    if (i < word.length - 1) consider(word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2));
    for (const letter of alphabet) { consider(word.slice(0, i) + letter + word.slice(i)); if (i < word.length) consider(word.slice(0, i) + letter + word.slice(i + 1)); }
  }
  if (!found.size) for (let i = 1; i < word.length; i++) if (word[i] === word[i - 1]) {
    const simplified = word.slice(0, i) + word.slice(i + 1);
    for (let j = 0; j < simplified.length; j++) consider(simplified.slice(0, j) + simplified[j] + simplified.slice(j));
  }
  return [...found];
}

export async function checkLanguageText(text, options = {}) {
  text = String(text || '');
  const language = ['ru', 'uk', 'en'].includes(options.lang) ? options.lang : inferLanguage(text);
  const data = await dictionary(language);
  options.signal?.throwIfAborted();
  const ignored = new Set(Array.from(options.ignoredWords || [], normalize));
  const lookup = options.localLookup ?? TYPO_LOOKUP;
  const authorRule = word => ['user', 'override'].includes(lookup[word]?.source);
  const requested = options.requestedWords && new Set([...options.requestedWords].map(normalize));
  const tokens = [...text.matchAll(wordPattern)].map(match => {
    const lookupKey = normalizeTypoToken(match[0].normalize('NFC'));
    return { raw: match[0], word: normalize(match[0]), lookupKey, start: match.index, end: match.index + match[0].length, analyses: authorRule(lookupKey) ? [] : data.analyses.get(normalize(match[0])) || [] };
  });
  const issues = [], identifiers = new Set();
  const opaque = [...text.matchAll(/https?:\/\/[^\s]+|\b[\w.+-]+@[\w.-]+\.[\p{L}]+|`[^`]*`/gu)].map(match => [match.index, match.index + match[0].length]);
  const blocked = (start, end, allowAuthor) => opaque.some(([a, b]) => start < b && end > a) || tokens.some(token => (ignored.has(token.word) || !allowAuthor && authorRule(token.lookupKey)) && start < token.end && end > token.start);
  const add = (start, end, replacements, category, ruleId) => {
    if (blocked(start, end, ruleId === 'author-typo-dictionary')) return;
    let suggestions = [...new Set(replacements)].filter(value => typeof value === 'string' && value !== text.slice(start, end) && value.length <= 256);
    if (!suggestions.length) return;
    const capitalization = category !== 'capitalization' && issues.find(issue => issue.start === start && issue.end === end && issue.category === 'capitalization');
    if (capitalization) {
      suggestions = suggestions.map(value => preserveCase(capitalization.correct, value));
      issues.splice(issues.indexOf(capitalization), 1);
    }
    const id = `${start}:${end}:${suggestions[0]}`;
    if (identifiers.has(id)) return;
    identifiers.add(id);
    issues.push({ start, end, rawText: text.slice(start, end), correct: suggestions[0], suggestions, label: labels[category], category, issueType: category, ruleId, source: 'rules', language });
  };
  const replaceToken = (token, values, category, ruleId) => add(token.start, token.end, values.map(value => preserveCase(token.raw, value)), category, ruleId);
  const matches = (regex, transform, category, ruleId) => { for (const match of text.matchAll(regex)) add(match.index, match.index + match[0].length, [transform(match)], category, ruleId); };
  const spaceGap = (left, right) => /^\s+$/u.test(text.slice(left.end, right.start));

  matches(/\s+[,;:](?=\s|[\p{L}«“])/gu, match => match[0].trimStart(), 'punctuation', 'punctuation-space-before');
  matches(/[,;:](?=[\p{L}«“])/gu, match => match[0] + ' ', 'punctuation', 'punctuation-space-after');
  matches(/,{2,}/gu, () => ',', 'punctuation', 'punctuation-repeated-comma');
  matches(/(?<!\.)\.{2}(?!\.)/gu, () => '.', 'punctuation', 'punctuation-double-period');

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], previous = tokens[index - 1], next = tokens[index + 1];
    if (ignored.has(token.word) || opaque.some(([a, b]) => token.start >= a && token.end <= b)) continue;
    if (typeof lookup[token.lookupKey]?.correct === 'string' && normalize(lookup[token.lookupKey].correct) !== token.word) {
      const entry = lookup[token.lookupKey];
      add(token.start, token.end, [['user', 'override'].includes(entry.source) ? entry.correct : preserveCase(token.raw, entry.correct)], 'spelling', 'author-typo-dictionary');
    }
    if (authorRule(token.lookupKey)) continue;
    if (previous && previous.word === token.word && spaceGap(previous, token) && !(language === 'en' && ['had', 'that', 'is'].includes(token.word))) add(previous.end, token.end, [''], 'repetition', 'repeated-adjacent-word');
    const before = text.slice(0, token.start);
    const dialogueAttribution = language !== 'en' && /[.!?…][»”]?\s+[—–]\s*$/u.test(before) && token.analyses.some(item => item.pos === 'verb') && subjectPronouns[language][next?.word];
    if (!dialogueAttribution && token.analyses.length && (options.sentenceStart !== false || before.trim()) && token.raw[0] === token.raw[0].toLowerCase() && /(?:^|[.!?…]\s+|\n)\s*(?:[—–«“]\s*)?$/u.test(before)) replaceToken(token, [token.raw[0].toUpperCase() + token.raw.slice(1)], 'capitalization', 'sentence-capitalization');
    const proper = data.properForms.get(token.word);
    const locationContext = previous && ['в', 'во', 'у', 'до', 'из', 'із', 'in', 'to', 'from'].includes(previous.word);
    const ordinaryNoun = language === 'uk' && token.analyses.some(item => item.pos === 'noun' && !item.tag.includes(':prop:')) || language === 'en' && token.analyses.some(item => ['NN', 'NNS'].includes(item.tag));
    if (proper && locationContext && !ordinaryNoun && token.raw[0] === token.raw[0].toLowerCase()) replaceToken(token, [proper], 'capitalization', 'dictionary-proper-name-capitalization');

    const speech = language === 'ru' ? new Set(['знать', 'думать', 'сказать', 'говорить', 'понять', 'увидеть', 'заметить', 'понимать', 'надеяться']) : new Set(['знати', 'думати', 'сказати', 'говорити', 'зрозуміти', 'побачити', 'помітити', 'розуміти', 'сподіватися']);
    if (language !== 'en' && previous && spaceGap(previous, token)) {
      const relative = language === 'ru' ? /^котор(?:ый|ая|ое|ые|ую|ого|ой|ых|ому|ым|ыми|ом)$/u : /^як(?:ий|а|е|і|у|ого|ої|их|ому|им|ими)$/u;
      const complement = token.word === (language === 'ru' ? 'что' : 'що') && previous.analyses.some(item => speech.has(normalize(item.lemma))) && !['угодно', 'попало', 'завгодно'].includes(next?.word);
      if (complement || relative.test(token.word) && previous.analyses.some(item => item.pos === 'noun')) add(previous.end, previous.end, [','], 'punctuation', complement ? 'complement-clause-comma' : 'relative-clause-comma');
      const causal = token.word === (language === 'ru' ? 'потому' : 'тому') && next?.word === (language === 'ru' ? 'что' : 'що');
      if (causal) add(previous.end, previous.end, [','], 'punctuation', 'causal-clause-comma');
    }
    if (language === 'en' && ['however', 'moreover', 'nevertheless', 'therefore'].includes(token.word) && /(?:^|[.!?]\s+)$/u.test(before) && next && spaceGap(token, next) && !(token.word === 'however' && next.analyses.some(item => item.pos === 'adjective'))) add(token.end, token.end, [','], 'punctuation', 'introductory-adverb-comma');

    if (next && spaceGap(token, next)) {
      let nouns = next.analyses.filter(item => item.pos === 'noun' && !item.tag.includes('&pron') && !(next.raw === next.raw.toLowerCase() && /(?:^|:)(?:Fam|Name)(?::|$)|:prop:(?:fname|lname)/u.test(item.tag)));
      if (nouns.some(item => item.case !== 'v_kly')) nouns = nouns.filter(item => item.case !== 'v_kly');
      const possessives = previous && spaceGap(previous, token) ? previous.analyses.filter(item => item.pos === 'adjective' && ['мой', 'твой', 'наш', 'ваш', 'мій', 'твій', 'свій'].includes(normalize(item.lemma))) : [];
      const possessive = possessives.find(item => item.case === nominative[language]) || possessives[0];
      if (possessive) {
        const resolved = nouns.filter(item => item.number === possessive.number && (item.number === 'p' || item.gender === possessive.gender) && item.case === possessive.case);
        if (resolved.length) nouns = resolved;
      }
      if (pluralDeterminers[language].has(token.word) && nouns.length && !nouns.some(item => item.number === 'p')) {
        const values = nouns.flatMap(item => inflections(data, item, { number: 'p', case: nominative[language] }));
        replaceToken(next, values, 'grammar', 'determiner-noun-number');
      }
      const adjectives = token.analyses.filter(item => item.pos === 'adjective' && item.case);
      const alreadyAgrees = adjectives.some(adjective => nouns.some(noun => (!adjective.number || noun.number === adjective.number) && (!noun.gender || noun.gender === adjective.gender || noun.number === 'p') && noun.case === adjective.case));
      if (language !== 'en' && nouns.length && !alreadyAgrees && !['это', 'це'].includes(token.word)) for (const adjective of adjectives) {
        if (pluralDeterminers[language].has(token.word)) continue;
        if (nouns.some(noun => (!adjective.number || noun.number === adjective.number) && (!noun.gender || noun.gender === adjective.gender || noun.number === 'p') && noun.case === adjective.case)) break;
        const noun = nouns.find(item => item.case === nominative[language]) || nouns[0];
        replaceToken(token, inflections(data, adjective, { number: noun.number, gender: noun.number === 'p' ? '' : noun.gender, case: noun.case }), 'grammar', 'adjective-noun-agreement');
        break;
      }
      if (language !== 'en' && token.analyses.some(item => ['мой', 'твой', 'наш', 'ваш', 'мій', 'твій', 'свій'].includes(normalize(item.lemma))) && next.analyses.some(item => item.pos === 'adjective') && tokens[index + 2]?.analyses.some(item => item.pos === 'noun') && spaceGap(next, tokens[index + 2])) {
        const noun = tokens[index + 2].analyses.find(item => item.pos === 'noun' && item.case === nominative[language]);
        const adjective = token.analyses.find(item => item.pos === 'adjective' && item.case === nominative[language]);
        if (noun && adjective && (noun.gender !== adjective.gender || noun.number !== adjective.number)) replaceToken(token, inflections(data, adjective, { gender: noun.number === 'p' ? '' : noun.gender, number: noun.number, case: noun.case }), 'grammar', 'possessive-noun-agreement');
      }

      if (language === 'en' && ['a', 'an'].includes(token.word)) {
        const vowel = /^(?:[aeiou]|hour|honest|heir)/u.test(next.word) && !/^(?:uni[^nmd]|use|user|one|euro)/u.test(next.word);
        if ((token.word === 'an') !== vowel) replaceToken(token, [vowel ? 'an' : 'a'], 'grammar', 'indefinite-article');
      }

      const pronoun = subjectPronouns[language][token.word];
      const startsClause = !previous || /[.!?;,\n]/u.test(text.slice(previous.end, token.start)) || previous.word === 'the' && (!tokens[index - 2] || /[.!?;,\n]/u.test(text.slice(tokens[index - 2].end, previous.start)));
      const adjectiveModifier = language === 'en' && token.analyses.some(item => item.pos === 'adjective') && next.analyses.some(item => item.pos === 'noun');
      const nounSubjects = adjectiveModifier || ['коли', 'якщо', 'щоб', 'когда', 'если', 'чтобы'].includes(token.word) ? [] : token.analyses.filter(item => item.pos === 'noun' && !item.tag.includes('&pron') && (language === 'en' ? startsClause : item.case === nominative[language]));
      const subject = pronoun ? { number: pronoun[0], person: pronoun[1], gender: pronoun[2] || '' } : nounSubjects.length ? { number: nounSubjects[0].number, person: '3', gender: nounSubjects[0].gender } : null;
      const verb = language === 'en' && next.analyses.some(item => item.tag === 'MD') ? null : next.analyses.find(item => item.pos === 'verb' && item.tense !== 'infinitive' && (language !== 'en' || !['VBN', 'VBG'].includes(item.tag)));
      if (subject && verb) {
        if (language === 'en') {
          const fixed = next.word === 'has' && (subject.number === 'p' || subject.person !== '3') ? 'have' : next.word === 'have' && subject.number === 's' && subject.person === '3' ? 'has' : next.word === 'was' && subject.number === 'p' ? 'were' : next.word === 'were' && subject.number === 's' && subject.person !== '2' ? 'was' : null;
          if (fixed) replaceToken(next, [fixed], 'grammar', 'subject-verb-agreement');
          else if ((subject.number === 'p' || subject.person !== '3') && next.analyses.some(item => item.tag === 'VBZ') && !next.analyses.some(item => ['VB', 'VBP', 'VBD'].includes(item.tag))) replaceToken(next, (data.lemmas.get(normalize(verb.lemma)) || []).filter(item => ['VB', 'VBP'].includes(item.tag)).map(item => item.word), 'grammar', 'subject-verb-agreement');
          else if (subject.number === 's' && subject.person === '3' && next.analyses.some(item => ['VB', 'VBP'].includes(item.tag)) && !next.analyses.some(item => item.tag === 'VBZ') && (!next.analyses.some(item => item.tag === 'VBD') || /\b(?:every|daily|usually|always|often)\b/u.test(text.slice(next.end).split(/[.!?\n]/u)[0]))) replaceToken(next, inflections(data, verb, { person: '3', tense: 'present' }), 'grammar', 'subject-verb-agreement');
        } else {
          const verbs = next.analyses.filter(item => item.pos === 'verb' && item.tense === verb.tense);
          const compatible = verbs.some(item => item.number === subject.number && (verb.tense === 'past' ? subject.number === 'p' || !subject.gender || item.gender === subject.gender : !item.person || item.person === subject.person));
          if (!compatible) replaceToken(next, inflections(data, verb, { number: subject.number, tense: verb.tense, ...(verb.tense === 'past' ? { gender: subject.number === 'p' ? '' : subject.gender } : { person: subject.person }) }), 'grammar', 'subject-verb-agreement');
        }
      }
      if (language === 'en' && token.word === 'there' && next.word === 'is' && /^(?:two|three|four|five|six|seven|eight|nine|ten|\d+)\b/u.test(text.slice(next.end).trimStart())) replaceToken(next, ['are'], 'grammar', 'existential-number');
      if (language === 'en' && token.word === 'interested' && next.word === 'on') replaceToken(next, ['in'], 'grammar', 'interested-preposition');
      if (language === 'ru' && ['согласно', 'благодаря', 'вопреки'].includes(token.word)) {
        const noun = nouns.find(item => item.case === 'R');
        if (noun && !nouns.some(item => item.case === 'D')) replaceToken(next, inflections(data, noun, { case: 'D', number: noun.number }), 'grammar', 'dative-preposition');
      }
      if (language === 'uk' && token.word === 'згідно' && !['з', 'із', 'зі'].includes(next.word)) {
        const noun = nouns.find(item => item.case === 'v_rod');
        if (noun) add(token.start, next.end, inflections(data, noun, { case: 'v_oru', number: noun.number }).map(value => preserveCase(token.raw, `згідно з ${value}`)), 'grammar', 'according-to-instrumental');
        else if (/^[\p{L}]{4,}[ау]$/u.test(next.word)) {
          const candidate = next.word.slice(0, -1) + 'ом';
          if (dictionaryContains(data.membership, next.word) && dictionaryContains(data.membership, candidate)) add(token.start, next.end, [preserveCase(token.raw, `згідно з ${candidate}`)], 'grammar', 'according-to-instrumental');
        }
      }
      if (language === 'ru' && token.word === 'более' && next.analyses.some(item => item.tag.startsWith('ADJ:Sup'))) add(token.start, next.start, [''], 'grammar', 'double-comparison');
      if (language === 'ru' && token.analyses.some(item => normalize(item.lemma) === 'оплатить') && next.word === 'за') add(token.end, next.end, [''], 'grammar', 'pay-transitive-preposition');
      if (language === 'ru' && token.analyses.some(item => normalize(item.lemma) === 'скучать') && next.word === 'за' && tokens[index + 2]) {
        const pronouns = { тобой: 'тебе', мною: 'мне', мной: 'мне', ним: 'нему', ней: 'ней', вами: 'вам', ними: 'ним', нами: 'нам' };
        const object = tokens[index + 2];
        if (pronouns[object.word] && spaceGap(next, object)) add(next.start, object.end, [`по ${pronouns[object.word]}`], 'grammar', 'miss-dative-preposition');
      }
      if (language === 'uk' && token.word === 'самий' && /^(?:кращ|гірш|більш|менш|\p{L}+іш)/u.test(next.word)) add(token.start, next.end, [preserveCase(token.raw, 'най' + next.raw)], 'grammar', 'ukrainian-superlative');
      if (language === 'uk' && next.word === 'участь' && token.analyses.some(item => ['приймати', 'прийняти'].includes(normalize(item.lemma)))) {
        const source = token.analyses.find(item => item.pos === 'verb');
        const desired = normalize(source?.lemma) === 'прийняти' ? 'узяти' : 'брати';
        const root = data.lemmas.get(desired)?.find(item => item.pos === 'verb');
        if (source && root) replaceToken(token, inflections(data, root, { number: source.number, gender: source.gender, person: source.person, tense: source.tense }), 'usage', 'take-part-collocation');
      }
      if (language === 'uk' && next.word === 'міри' && token.analyses.some(item => normalize(item.lemma) === 'прийняти')) {
        const source = token.analyses.find(item => item.pos === 'verb'), root = data.lemmas.get('вжити')?.find(item => item.pos === 'verb');
        if (source && root) add(token.start, next.end, inflections(data, root, { number: source.number, gender: source.gender, person: source.person, tense: source.tense }).map(value => preserveCase(token.raw, value + ' заходів')), 'usage', 'take-measures-collocation');
      }
    }
    if (language !== 'en' && (subjectPronouns[language][token.word] || token.analyses.some(item => item.pos === 'noun' && item.case === nominative[language]))) {
      const sentenceStart = Math.max(text.lastIndexOf('.', token.start - 1), text.lastIndexOf('!', token.start - 1), text.lastIndexOf('?', token.start - 1), text.lastIndexOf('\n', token.start - 1)) + 1;
      const earlier = tokens.filter(item => item.start >= sentenceStart && item.end < token.start);
      const starters = language === 'ru' ? new Set(['когда', 'если', 'чтобы']) : new Set(['коли', 'якщо', 'щоб']);
      const hasPredicate = earlier.some(item => item.analyses.some(analysis => analysis.pos === 'verb') || language === 'ru' && /[аеёиу]ло$/u.test(item.word));
      if (earlier.length >= 2 && starters.has(earlier[0].word) && hasPredicate && next?.analyses.some(item => item.pos === 'verb') && !/[,;:]/u.test(text.slice(earlier[0].end, token.start))) {
        const boundary = tokens[index - 1];
        if (boundary && spaceGap(boundary, token)) add(boundary.end, boundary.end, [','], 'punctuation', 'initial-subordinate-clause');
      }
    }
    const letters = token.word.replace(/['\-]/gu, '');
    const alphabetMatches = language === 'en' ? /^[a-z]+$/u.test(letters) : language === 'ru' ? /^[а-яё]+$/u.test(letters) : /^[а-щьюяєіїґ]+$/u.test(letters);
    const ordinaryCase = token.raw === token.raw.toLowerCase();
    const titleCase = token.raw[0] === token.raw[0].toUpperCase() && token.raw.slice(1) === token.raw.slice(1).toLowerCase();
    const allCaps = token.raw.length >= 5 && token.raw === token.raw.toUpperCase();
    if (alphabetMatches && (!requested || requested.has(token.word)) && !token.analyses.length && !containsWord(data, token.word) && !(language === 'en' && englishContraction(token.word, data)) && !lookup[token.lookupKey] && !proper && (ordinaryCase || titleCase || allCaps)) {
      const candidates = spellingCandidates(token.word, language, data).filter(candidate => ordinaryCase || data.common.has(candidate));
      const precedingAdjective = previous?.analyses.find(item => item.pos === 'adjective' && item.case);
      candidates.sort((a, b) => {
        const suitable = value => data.analyses.get(value)?.some(item => precedingAdjective && item.pos === 'noun' && item.case === precedingAdjective.case && item.number === precedingAdjective.number && (item.number === 'p' || item.gender === precedingAdjective.gender)
          || item.pos === 'adjective' && next?.analyses.some(noun => noun.pos === 'noun' && (language === 'en' || noun.case === item.case && noun.number === item.number && (noun.number === 'p' || noun.gender === item.gender))));
        const accidentalRepeat = value => token.word.replace(/(.)\1/u, '$1') === value;
        const prefix = value => { let length = 0; while (length < value.length && value[length] === token.word[length]) length++; return length; };
        return Number(suitable(b)) - Number(suitable(a)) || Number(accidentalRepeat(b)) - Number(accidentalRepeat(a)) || Number(data.analyses.has(b)) - Number(data.analyses.has(a)) || Number(data.common.has(b)) - Number(data.common.has(a)) || prefix(b) - prefix(a) || a.localeCompare(b, language);
      });
      if (candidates.length) replaceToken(token, candidates.slice(0, 12), 'spelling', 'dictionary-edit-distance');
    }
  }
  return issues.sort((a, b) => a.start - b.start || b.end - a.end);
}
